/**
 * `spf watch` — poll a `watch.repo` for issues labeled `<prefix>:ready`,
 * run `watch.chain` against each in its own git worktree, open a PR, and
 * track it through to merged/blocked. See `src/core/watch.ts` for the
 * actual state machine; this file is just the wiring: config, the GitHub
 * provider, the chain-dispatch callback, the lockfile, and the CLI loop.
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import * as agents from "../../core/agents.ts";
import * as paths from "../../core/paths.ts";
import { resolveNotifier } from "../../core/notify/notifier.ts";
import { isRepoAt, makeGit } from "../../core/git_helper.ts";
import { GitHubProvider } from "../../core/issues/github_provider.ts";
import { JiraProvider } from "../../core/issues/jira_provider.ts";
import { BitbucketProvider } from "../../core/issues/bitbucket_provider.ts";
import { isAuthoringProvider } from "../../core/issues/provider.ts";
import type { CodeHostProvider, IssueProvider } from "../../core/issues/provider.ts";
import * as refineLib from "../../core/refine.ts";
import { createWatchState, tick, type ChainRunResult, type RefineRunResult, type WatchDeps, type WatchFanoutDeps } from "../../core/watch.ts";
import { findChain, hasCommitStep, resolveRequiredAgents, runChain as runChainDef, type ChainDefinition } from "../../chains/index.ts";
import type { ChainContext } from "../../chains/context.ts";
import { withRunScope } from "../../core/sandbox.ts";
import { excludeSpfDataFromGit } from "../../core/worktree_data.ts";
import type { AttemptDispatch, AttemptMetrics } from "../../core/fanout.ts";
import { ReviewOutput, type ReviewOutputT, type SFConfig } from "../../core/data_types.ts";
import type { DataPaths } from "../../core/paths.ts";
import { SfDb } from "../../ui/server/db.ts";
import { acquirePidLock, parseCli, releasePidLock } from "../../core/utils.ts";
import { isInteractive } from "../ask.ts";
import type { WatchDashboard } from "../ui/watch_dashboard.tsx";

/** Kept well under Slack's own 2900-char slice on `detail` (see `slack_channel.ts`) — a reviewer can emit a lot of findings, but the PR body/notification only needs enough to tell a human whether to look closer. */
const MAX_REVIEW_DIGEST_CHARS = 1200;

/**
 * `&`/`<`/`>` are active markup in every destination a digest lands in —
 * `<url|text>`/`*bold*` in Slack mrkdwn, raw HTML in GitHub's markdown
 * pipeline, and (cosmetically only — Adaptive Cards don't decode entities)
 * Teams' TextBlock and the generic webhook payload — and a reviewer's
 * findings/blocking text is LLM-authored, so it is untrusted content, not a
 * template. Escaped before it ever reaches any renderer, never trusted as
 * pre-formatted. Note this runs BEFORE truncateDigest, so a cut can in
 * principle land mid-entity (e.g. `&am…`) — cosmetic only, since the `<`
 * escape (the one that actually prevents Slack link forgery) is always
 * complete by the time truncation could touch it.
 */
export function escapeForMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Codepoint-safe truncation — a plain `.slice(0, n)` can land mid surrogate pair on a multi-byte finding. */
export function truncateDigest(text: string): string {
  const codepoints = Array.from(text);
  if (codepoints.length <= MAX_REVIEW_DIGEST_CHARS) return text;
  return `${codepoints.slice(0, MAX_REVIEW_DIGEST_CHARS).join("")}…`;
}

/** A `ReviewOutput` envelope, reduced to the short digest threaded into the PR body and the `pr_opened` notification — see `core/watch.ts`'s `ChainRunResult.reviewSummary`. */
export function formatReviewDigest(review: ReviewOutputT): string {
  const lines = [`Reviewer verdict: ${review.approved ? "approved" : "changes requested"}.`];
  if (review.blocking.length > 0) {
    lines.push("Blocking:", ...review.blocking.map((b) => `- ${escapeForMarkup(b)}`));
  }
  const unmet = review.findings.filter((f) => !f.met);
  if (unmet.length > 0) {
    lines.push("Unmet requirements:", ...unmet.map((f) => `- ${escapeForMarkup(f.requirement)}${f.evidence ? ` — ${escapeForMarkup(f.evidence)}` : ""}`));
  }
  // The common case on the success path (see the module comment on
  // `reviewSummaryFor`): every reachable ReviewOutput has approved:true,
  // blocking:[], unmet:[] — gates.verdictConsistent throws otherwise, and a
  // gate failure exits the run non-zero before a digest is ever built. So
  // without this, an approved run's digest would be the vacuous constant
  // "Reviewer verdict: approved." with zero information in it. The met
  // findings ARE the reviewer's signal on an approved run — what it actually
  // verified — so surface them.
  const met = review.findings.filter((f) => f.met);
  if (met.length > 0) {
    lines.push(`Verified ${met.length} requirement(s):`, ...met.map((f) => `- ${escapeForMarkup(f.requirement)}${f.evidence ? ` — ${escapeForMarkup(f.evidence)}` : ""}`));
  }
  return truncateDigest(lines.join("\n"));
}

/**
 * Shared by `watch`, `watch init`, and `loop`'s `--issue` flag: resolve
 * config into an `IssueProvider` — checking only what every caller needs.
 * `watch`'s own extra checks (a real git repo, a registered chain) don't
 * apply to seeding labels or to a one-shot issue fetch. Prints its own
 * error and returns `null` on failure — the caller just needs to `return 1`.
 */
export function resolveIssueProvider(cfg: SFConfig): IssueProvider | null {
  if (cfg.watch.issue_provider === "github") {
    // `issue_repo` (falling back to `repo`) — NOT `repo` alone — because
    // `repo` always names `code_host`'s own repo (see WatchConfigSchema's
    // doc comment). Those coincide for issue_provider: github + code_host:
    // github (the common case, and why the fallback exists at all), but
    // for issue_provider: github + code_host: bitbucket they are two
    // different repos in two different systems — reading `repo` here would
    // silently poll the BITBUCKET repo's identifier for GitHub issues.
    const repo = cfg.watch.issue_repo.trim() || cfg.watch.repo.trim();
    if (!repo) {
      console.error(`watch.repo (or watch.issue_repo, if code_host names a different repo) is not configured — add it to spf.config.yaml's watch: section, e.g. "owner/name"`);
      return null;
    }
    const token = process.env["GITHUB_TOKEN"];
    if (!token) {
      console.error('GITHUB_TOKEN is not set — spf watch needs a classic PAT with "repo" scope (or "public_repo" for a public-only repo). See README.md\'s "GITHUB_TOKEN scope" section.');
      return null;
    }
    return new GitHubProvider(repo, cfg.watch.label_prefix, token);
  }
  if (cfg.watch.issue_provider === "jira") {
    if (!cfg.watch.jira.base_url.trim() || !cfg.watch.jira.project_key.trim()) {
      console.error(`watch.jira.base_url and watch.jira.project_key must both be set when watch.issue_provider is "jira"`);
      return null;
    }
    const email = process.env["JIRA_EMAIL"];
    const token = process.env["JIRA_API_TOKEN"];
    if (!email || !token) {
      console.error('JIRA_EMAIL and JIRA_API_TOKEN must both be set — spf watch needs an Atlassian account email plus an API token (id.atlassian.com -> Security -> API tokens). See README.md\'s "spf watch" section.');
      return null;
    }
    return new JiraProvider(cfg.watch.jira.base_url, cfg.watch.jira.project_key, cfg.watch.label_prefix, email, token, cfg.watch.jira.issue_types, cfg.watch.jira.status_map);
  }
  console.error(`watch.issue_provider ${JSON.stringify(cfg.watch.issue_provider)} is not supported`);
  return null;
}

/**
 * Same shape as `resolveIssueProvider`, for `watch.code_host` — always
 * reads plain `watch.repo`, never `watch.issue_repo`. `repo` is defined as
 * the CODE HOST's own repo (see `WatchConfigSchema`'s doc comment); `issue_repo`
 * exists only to give the issue-tracker side an override when it names a
 * different repo, which is `resolveIssueProvider`'s concern, not this one's.
 */
function resolveCodeHostProvider(cfg: SFConfig): CodeHostProvider | null {
  if (!cfg.watch.repo.trim()) {
    console.error(`watch.repo is not configured — add it to spf.config.yaml's watch: section`);
    return null;
  }
  if (cfg.watch.code_host === "github") {
    const token = process.env["GITHUB_TOKEN"];
    if (!token) {
      console.error('GITHUB_TOKEN is not set — spf watch needs a classic PAT with "repo" scope (or "public_repo" for a public-only repo). See README.md\'s "GITHUB_TOKEN scope" section.');
      return null;
    }
    return new GitHubProvider(cfg.watch.repo, cfg.watch.label_prefix, token);
  }
  if (cfg.watch.code_host === "bitbucket") {
    const email = process.env["BITBUCKET_EMAIL"];
    const token = process.env["BITBUCKET_API_TOKEN"];
    if (!email || !token) {
      console.error('BITBUCKET_EMAIL and BITBUCKET_API_TOKEN must both be set — spf watch needs an Atlassian account email plus an API token (Bitbucket app passwords are being removed; API tokens are the replacement). See README.md\'s "spf watch" section.');
      return null;
    }
    return new BitbucketProvider(cfg.watch.repo, email, token);
  }
  console.error(`watch.code_host ${JSON.stringify(cfg.watch.code_host)} is not supported`);
  return null;
}

/** Stale-steal, like the reference implementation's daemon lock: a dead pid never blocks a restart. Atomic — see `utils.acquirePidLock`. */
function acquireLock(lockPath: string): void {
  const result = acquirePidLock(lockPath);
  if (!result.ok) {
    throw new Error(`another \`spf watch\` is already running (pid ${result.holderPid}) — lock at ${lockPath}`);
  }
}

const releaseLock = releasePidLock;

/**
 * `spf watch init` — idempotently seed the `<prefix>:*` labels the state
 * machine needs, with sensible colors/descriptions. Doesn't touch git or
 * run anything, so it skips watchCommand's repo/chain checks entirely —
 * you can seed labels before ever wiring up a worktree-capable checkout.
 *
 * On Jira, with `watch.refine.enabled`, this also runs a READ-ONLY check of
 * `watch.jira.issue_types` against the real project — the same check
 * `watchCommand`'s own startup gate runs, exposed here too so a bad mapping
 * can be caught (and fixed) before ever starting the daemon, not just at
 * startup time. Labels themselves stay a pure report on Jira either way
 * (Jira labels are freeform strings with no color/description registry to
 * seed — see `jira_provider.ts`'s module comment).
 */
export async function watchInitCommand(argv: string[]): Promise<number> {
  const { options } = parseCli(argv, ["cwd", "config"], []);
  const anchor = paths.resolveAnchor(options["cwd"]);
  const cfg = agents.loadConfig(paths.resolveConfigPaths(anchor, options["config"]).paths);

  const provider = resolveIssueProvider(cfg);
  if (!provider) return 1;

  const result = await provider.ensureLabels();
  console.log(`spf watch init: ${cfg.watch.issue_provider} (label prefix "${cfg.watch.label_prefix}")`);
  for (const name of result.created) console.log(`  + ${name} (created)`);
  for (const name of result.updated) console.log(`  ~ ${name} (updated color/description)`);
  for (const name of result.unchanged) console.log(`  = ${name} (already correct)`);

  if (cfg.watch.refine.enabled && cfg.watch.issue_provider === "jira" && provider instanceof JiraProvider) {
    const checks = await provider.validateIssueTypes();
    console.log(`\nvalidating watch.jira.issue_types against ${cfg.watch.jira.project_key}:`);
    for (const c of checks) {
      console.log(`  ${c.exists ? "✓" : "✗"} ${c.kind} → ${c.jiraType}${c.exists ? "" : ` — no issue type named "${c.jiraType}" in ${cfg.watch.jira.project_key}`}`);
    }
    if (checks.some((c) => !c.exists)) return 1;
  }

  if (cfg.watch.issue_provider === "jira" && provider instanceof JiraProvider && Object.values(cfg.watch.jira.status_map).some(Boolean)) {
    const checks = await provider.validateStatusMap();
    console.log(`\nvalidating watch.jira.status_map against ${cfg.watch.jira.project_key}:`);
    for (const c of checks) {
      console.log(`  ${c.exists ? "✓" : "✗"} ${c.state} → ${c.jiraStatus}${c.exists ? "" : ` — no status named "${c.jiraStatus}" in ${cfg.watch.jira.project_key}`}`);
    }
    if (checks.some((c) => !c.exists)) return 1;
  }
  return 0;
}

/** Shared by `runChain`/`runRefine`/the fan-out lane's dispatch: best-effort enrichment of a generic "didn't succeed" message with the first phase that actually failed, read back from the worktree's own (symlinked) trace db. Top-level (not a `watchCommand` local) so `makeWatchFanoutDispatch` below can share it — see that factory's own doc comment for why. */
function detailFromFailedPhase(cfg: SFConfig, cwd: string, adwId: string, prefix: string): string {
  let detail = prefix;
  let db: SfDb | undefined;
  try {
    const wtAnchor = paths.resolveAnchor(cwd);
    const wtDataPaths = paths.resolveDataPaths(wtAnchor, cfg.defaults.data_dir, cfg.observability.db);
    db = new SfDb(wtDataPaths.db_path);
    const failed = db.phases(adwId).find((p) => p.status === "fail");
    if (failed) detail += ` Phase "${failed.name}" failed: ${failed.error ?? "(no detail)"}`;
  } catch {
    // best-effort — the generic message above still points at where to look
  } finally {
    db?.close();
  }
  return detail;
}

/**
 * Best-effort: the reviewer's latest verdict for this run, read back from
 * the worktree's own (symlinked) trace db and reduced to a digest — same
 * DB, same try/catch shape as `detailFromFailedPhase` above, but on the
 * SUCCESS path. `undefined` on any DB/parse hiccup, or when the chain
 * never produced a `ReviewOutput` envelope at all — never thrown: a digest
 * is a nice-to-have, not something that gets to block the PR-open flow
 * it's decorating. Top-level for the same reason as `detailFromFailedPhase`.
 */
function reviewSummaryFor(cfg: SFConfig, cwd: string, adwId: string): string | undefined {
  let db: SfDb | undefined;
  try {
    const wtAnchor = paths.resolveAnchor(cwd);
    const wtDataPaths = paths.resolveDataPaths(wtAnchor, cfg.defaults.data_dir, cfg.observability.db);
    db = new SfDb(wtDataPaths.db_path);
    const envelope = db
      .envelopes(adwId)
      .filter((e) => e.output_type === ReviewOutput.name)
      .at(-1); // the LATEST verdict — a revise loop can produce several
    if (!envelope?.payload_json) return undefined;
    const review = v.parse(ReviewOutput.schema, JSON.parse(envelope.payload_json)) as ReviewOutputT;
    return formatReviewDigest(review);
  } catch {
    return undefined; // best-effort — see the doc comment above
  } finally {
    db?.close();
  }
}

/**
 * The fan-out lane's dispatch trio, as a plain function of config + the
 * resolved chain — mirrors `cli/commands/fanout.ts`'s own `runAttempt`
 * (`:375-404`) and `readMetrics` (`:355-373`) closures, plus `adwIdsFree`
 * (the sessions-db half of that command's reuse preflight) and `reviewFor`
 * (§6.5 — the two expressions `runChain` above already computes, pointed at
 * a WINNER instead of the sole attempt). Exported as a plain function of its
 * inputs — not a `watchCommand`-local closure — the same reason
 * `linkFanoutDataDir` is exported from `cli/commands/fanout.ts`: it can then
 * be exercised directly against a real repo, real worktrees and a fake
 * chain, with no tracker, no agent and no control plane
 * (`src/test/watch_fanout_sandbox_wiring.test.ts`). `watchCommand` itself
 * calls this SAME factory and spreads the result into `deps.fanout`, so the
 * tested object and the shipped object are the same object.
 */
export function makeWatchFanoutDispatch(
  cfg: SFConfig,
  configPaths: string[],
  dataPaths: DataPaths,
  chainDef: ChainDefinition,
): Pick<WatchFanoutDeps, "runAttempt" | "readMetrics" | "adwIdsFree" | "reviewFor"> {
  const runAttempt = async (dispatch: AttemptDispatch): Promise<number> => {
    // NO `dispatch.isAborted()` early return, unlike `spf fanout`'s own
    // runAttempt: that check only ever fires under `firstSuccess`, which
    // `spf watch` never sets (`decided` is never flipped — see
    // `core/fanout.ts`). Including a check that can never observe true would
    // be a lie about the abort model this dispatch actually honors.
    const ctx: ChainContext = {
      prompt: dispatch.prompt,
      config_paths: configPaths,
      adw_id: dispatch.adwId, // "issue-<id>-<i>" (or the salted/random base's own) — fanout.ts's attemptAdwId
      cwd: dispatch.cwd, // THIS attempt's own worktree — the Run's repo_root anchor
      chain_name: chainDef.name,
      unattended: true, // same as runChain's and spf fanout's own dispatch — nobody is at a TTY for attempt 2 of 3
      chain_source: chainDef.source,
    };
    // `cfg.watch.chain_options` reaches every attempt exactly as it reaches
    // the single dispatch above — one shared map for all N attempts.
    return withRunScope(dispatch.adwId, () => runChainDef(chainDef, ctx, cfg.watch.chain_options));
  };

  /**
   * Opened and closed PER CALL, unlike `spf fanout`'s lazily-held single
   * handle: `spf watch` is a long-lived daemon with several issues (and
   * fan-outs) potentially in flight at once and no single `finally` to close
   * a shared handle in — the same per-call shape `detailFromFailedPhase`/
   * `reviewSummaryFor` above already use against the same WAL db.
   */
  const readMetrics = (adwId: string): AttemptMetrics => {
    if (!existsSync(dataPaths.db_path)) return { gate_passes: 0, gate_failures: 0, cost: 0, tokens: 0 };
    let db: SfDb | undefined;
    try {
      db = new SfDb(dataPaths.db_path);
      const gates = db.gates(adwId);
      const session = db.session(adwId);
      // `passed` is a SQLite integer boolean that CAN be NULL on a row an
      // older tracer wrote. Counted explicitly in both directions, never as
      // `!g.passed`: a NULL is unknown, and letting it read as a failure
      // would let a garbled row decide which candidate wins.
      return {
        gate_passes: gates.filter((g) => g.passed === 1).length,
        gate_failures: gates.filter((g) => g.passed === 0).length,
        cost: session?.total_cost ?? 0,
        tokens: session?.total_tokens ?? 0,
      };
    } catch {
      return { gate_passes: 0, gate_failures: 0, cost: 0, tokens: 0 };
    } finally {
      db?.close();
    }
  };

  /**
   * The other half of `spf fanout`'s reuse preflight — "does this adw_id
   * have a session row yet" — one `SfDb.session(id)` point lookup per
   * candidate id. Safe direction is FALSE (see `WatchFanoutDeps.adwIdsFree`'s
   * own doc comment): an unreadable db reports "taken" rather than "free".
   */
  const adwIdsFree = (adwIds: string[]): boolean => {
    if (!existsSync(dataPaths.db_path)) return true; // no db yet — nothing to collide with
    let db: SfDb | undefined;
    try {
      db = new SfDb(dataPaths.db_path);
      return adwIds.every((id) => db!.session(id) === null);
    } catch {
      return false;
    } finally {
      db?.close();
    }
  };

  const reviewFor = (opts: { cwd: string; adwId: string; chainOptions: Record<string, string> }) => ({
    reviewRequired: resolveRequiredAgents(chainDef, opts.chainOptions).includes("reviewer"),
    reviewSummary: reviewSummaryFor(cfg, opts.cwd, opts.adwId),
  });

  return { runAttempt, readMetrics, adwIdsFree, reviewFor };
}

export async function watchCommand(argv: string[]): Promise<number> {
  const { options, flags } = parseCli(argv, ["cwd", "config"], ["dry-run", "once"]);
  const anchor = paths.resolveAnchor(options["cwd"]);
  const configPaths = paths.resolveConfigPaths(anchor, options["config"]).paths;
  const cfg = agents.loadConfig(configPaths);

  const provider = resolveIssueProvider(cfg);
  if (!provider) return 1;
  const codeHost = resolveCodeHostProvider(cfg);
  if (!codeHost) return 1;
  if (!isRepoAt(anchor.repo_root)) {
    console.error(`${anchor.repo_root} is not a git repository`);
    return 1;
  }
  if (!findChain(cfg.watch.chain)) {
    console.error(`watch.chain ${JSON.stringify(cfg.watch.chain)} is not a registered chain — run \`spf list\` to see every chain`);
    return 1;
  }
  if (cfg.watch.refine.enabled) {
    if (cfg.watch.issue_provider !== "github" && cfg.watch.issue_provider !== "jira") {
      // Fail loudly at startup, not silently every tick: neither provider
      // implements IssueAuthoringProvider besides these two — a refine lane
      // that can never publish would otherwise just claim every spec-ready
      // spec and block it, forever.
      console.error(
        `watch.refine.enabled is true but watch.issue_provider is ${JSON.stringify(cfg.watch.issue_provider)} — ` +
          `the refine lane needs "github" or "jira"`,
      );
      return 1;
    }
    if (!findChain(cfg.watch.refine.chain)) {
      console.error(`watch.refine.chain ${JSON.stringify(cfg.watch.refine.chain)} is not a registered chain — run \`spf list\` to see every chain`);
      return 1;
    }
    // Jira's issue-type mapping is user-configured (watch.jira.issue_types)
    // and project-specific — validated here, at startup, for the same
    // reason findChain() is: a bad mapping should stop the daemon before
    // it starts, not fail silently every tick once the first spec-ready
    // spec tries to publish. Silent on success, matching this function's
    // other startup checks; loud (and the full per-kind report) on failure.
    if (cfg.watch.issue_provider === "jira" && provider instanceof JiraProvider) {
      const checks = await provider.validateIssueTypes();
      const mismatches = checks.filter((c) => !c.exists);
      if (mismatches.length > 0) {
        console.error(`watch.jira.issue_types has ${mismatches.length} mismatch(es) against ${cfg.watch.jira.project_key}:`);
        for (const c of checks) {
          console.error(`  ${c.exists ? "✓" : "✗"} ${c.kind} → ${c.jiraType}${c.exists ? "" : ` — no issue type named "${c.jiraType}" in ${cfg.watch.jira.project_key}`}`);
        }
        console.error(`Fix watch.jira.issue_types, or the project's issue types, before running spf watch unattended. Run \`spf watch init\` any time to re-check.`);
        return 1;
      }
    }
  }

  // watch.jira.status_map applies to every build-lane transition, independent
  // of watch.refine.enabled — validated at startup for the same reason
  // issue_types is: a bad status name should stop the daemon before it
  // starts, not fail silently (well, log-and-skip — see jira_provider.ts's
  // syncStatus()) on every single transition once it's running. Silent when
  // status_map is empty (the default, opt-in feature) or has no mismatches.
  if (cfg.watch.issue_provider === "jira" && provider instanceof JiraProvider) {
    const configured = Object.values(cfg.watch.jira.status_map).some(Boolean);
    if (configured) {
      const checks = await provider.validateStatusMap();
      const mismatches = checks.filter((c) => !c.exists);
      if (mismatches.length > 0) {
        console.error(`watch.jira.status_map has ${mismatches.length} mismatch(es) against ${cfg.watch.jira.project_key}:`);
        for (const c of checks) {
          console.error(`  ${c.exists ? "✓" : "✗"} ${c.state} → ${c.jiraStatus}${c.exists ? "" : ` — no status named "${c.jiraStatus}" in ${cfg.watch.jira.project_key}`}`);
        }
        console.error(`Fix watch.jira.status_map, or the project's statuses, before running spf watch unattended. Run \`spf watch init\` any time to re-check.`);
        return 1;
      }
    }
  }

  // watch.fanout.n > 1 startup gates — all guarded so watch.fanout.n: 1 (the
  // default) reaches none of them, and a bad configuration stops the daemon
  // before it starts rather than failing silently every tick.
  if (cfg.watch.fanout.n > 1) {
    // §5.1 — `spf fanout` refuses a chain with no commit step
    // (`cli/commands/fanout.ts`); `spf watch`'s single-dispatch lane has no
    // such requirement (a chain that commits nothing is handled honestly by
    // `openPrForWinner`'s own `diffFiles` -> blocked path). For `n > 1` the
    // same gate MUST apply, for a worse reason: `runBestOf` force-removes
    // every SUCCESSFUL LOSER's worktree after selection
    // (`git worktree remove --force`, which deletes uncommitted/untracked
    // files with no confirmation). A chain with no commit step leaves its
    // entire payload as uncommitted edits, so fan-out would destroy N-1
    // candidates outright and then block the issue anyway once the winner's
    // own empty diff is discovered.
    const watchChain = findChain(cfg.watch.chain)!; // already checked above
    if (!hasCommitStep(watchChain.phases)) {
      console.error(
        `watch.fanout.n is ${cfg.watch.fanout.n} but watch.chain ${JSON.stringify(cfg.watch.chain)} has no commit phase ` +
          `(${watchChain.phases}) — best-of-N discards every losing attempt's worktree (uncommitted work included), ` +
          `so a chain that leaves its payload uncommitted would destroy N-1 candidates and then block the issue for ` +
          `an empty diff. Use a chain that commits (plan-build, plan-build-test, plan-build-test-quality, simple-sdlc, ` +
          `or a repo-local chain with a commit step), or set watch.fanout.n: 1.`,
      );
      return 1;
    }
    // §5.2 — `spf fanout` prints this once, interactively, when it's about
    // to spend --n times over an unbounded ceiling; a daemon would otherwise
    // repeat that bill every tick with nobody watching, so it's said once,
    // loudly, at startup instead.
    if (cfg.defaults.max_run_cost === undefined && cfg.defaults.max_run_tokens === undefined) {
      console.log(
        `[spf] watch     no defaults.max_run_cost / defaults.max_run_tokens configured — watch.fanout.n=${cfg.watch.fanout.n} ` +
          `means every claimed issue runs ${cfg.watch.fanout.n} attempts to completion, unbounded`,
      );
    }
  }

  const dataPaths = paths.resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db);
  const lockPath = path.join(dataPaths.data_dir, "watch.lock");
  try {
    acquireLock(lockPath);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  const git = makeGit(anchor.repo_root);
  const worktreesDir = path.join(homedir(), ".spf", "watch", path.basename(anchor.repo_root), "worktrees");
  mkdirSync(worktreesDir, { recursive: true });

  // `null` when notifications are off/unconfigured — every call below is a
  // no-op fallback to `console.error` in that case (see notify()`s default).
  const notifier = resolveNotifier(cfg, { dryRun: Boolean(flags["dry-run"]) });

  /**
   * Without this, a claimed issue's chain resolves its session/trace data
   * relative to `cwd` (the worktree, not the main repo — see
   * ChainContext's doc comment), so it lands in a fresh `.spf/data` that
   * `cleanupWorktree` deletes along with the rest of the worktree once the
   * issue finishes: invisible in `spf ui` while running, and gone entirely
   * afterward. Symlinking `.spf/data` in the worktree to the main repo's
   * own `dataPaths.data_dir` makes every claimed issue show up in the same
   * `spf ui` you already have open, and survive worktree cleanup. Multiple
   * concurrent worktrees writing through the same symlink to one sqlite
   * file is exactly what tracer.ts's WAL + busy_timeout=5000 already exist
   * for. Idempotent: a no-op if the worktree already has a `.spf/data`
   * (e.g. resuming an orphaned worktree).
   */
  function linkDataDir(worktreePath: string): void {
    const target = path.join(worktreePath, ".spf", "data");
    // Hard guard, independent of however `worktreePath` got resolved: a real
    // self-referential .spf/data symlink was observed live once already
    // (points at itself — every later `mkdirSync` through it throws ELOOP;
    // see `paths.healBrokenDataDir` for the recovery side of this same bug).
    // The exact trigger was never pinned down, but `worktreePath` resolving
    // to the main repo's own `data_dir` can never be correct regardless of
    // how it got there, so refuse outright rather than create it again.
    if (path.resolve(target) === path.resolve(dataPaths.data_dir)) {
      console.error(`watch: refusing to link ${target} to itself — worktree path resolved to the main repo's own data_dir`);
      return;
    }
    if (!existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      symlinkSync(dataPaths.data_dir, target, "dir");
    }
    // Keeps the symlink invisible to `git status`/`git add -A` in THIS
    // worktree — see `core/worktree_data.ts`'s doc comment for the ELOOP
    // disaster this closes. Called every time, guarded by nothing of its
    // own: it's idempotent and best-effort (a `git rev-parse` failure is
    // swallowed), so there's no wrong time to call it, including when
    // resuming an orphaned worktree whose `.spf/data` symlink already
    // exists. Previously only `spf fanout`'s own worktrees got this; `spf
    // watch`'s single-dispatch worktrees carried the same exposure and now
    // get the identical fix.
    excludeSpfDataFromGit(worktreePath);
  }

  const runChain = async (opts: { prompt: string; cwd: string; adwId: string; chainOptions: Record<string, string> }): Promise<ChainRunResult> => {
    // WATCH DIVERGENCE: `findChain` here resolves against the registry
    // `cli/index.ts`'s `main()` built ONCE, at daemon start, from the MAIN
    // repo anchor (the `registerRepoChains(...)` call before the command
    // switch). `opts.cwd` below is a per-issue WORKTREE, which may carry a
    // different (or edited) `.spf/chains/`, but that file is never
    // re-read here — this is deliberate, not a gap: the disposer stays the
    // OPERATOR's, never the branch's, so an agent can't rewrite its own
    // quality gate mid-run by editing a chain file as part of the change
    // it's making. (Also documented in the `spf init` scaffold, since that's
    // the one place an author is invited to edit a chain file at all.)
    const chainDef = findChain(cfg.watch.chain)!; // checked above
    const ctx: ChainContext = {
      prompt: opts.prompt,
      config_paths: configPaths,
      adw_id: opts.adwId,
      cwd: opts.cwd,
      chain_name: chainDef.name,
      // Every `spf watch` dispatch is unattended by definition — there is
      // no human at a TTY to prompt, ever, for an issue claimed off a
      // tracker poll. `chain_source` is undefined for a built-in chain,
      // the resolved chain's `.spf/chains/*.yaml` path for a repo one.
      unattended: true,
      chain_source: chainDef.source,
    };
    // `opts.chainOptions` is `watch.chain_options` (see WatchConfigSchema's
    // doc comment), threaded down from `deps.chainOptions` by
    // `core/watch.ts`'s `runIssue` — the same options-map shape an
    // interactive `spf <chain> --suite <name>` builds in
    // `cli/commands/run.ts`'s `dispatchChain`. This closes the KNOWN
    // LIMITATION from PR #20: an unattended watch dispatch used to call
    // `runChainDef` with no options at all, so nothing --suite-shaped could
    // ever reach it.
    const code = await withRunScope(opts.adwId, () => runChainDef(chainDef, ctx, opts.chainOptions));
    // Resolved with the SAME options `runChainDef` just ran the chain with,
    // so a `chain_options` override that swaps a "reviewer" step in or out
    // is reflected here too, not just each chain's static/YAML default.
    const reviewRequired = resolveRequiredAgents(chainDef, opts.chainOptions).includes("reviewer");
    if (code === 0) {
      return { accepted: true, adwId: opts.adwId, detail: "", reviewRequired, reviewSummary: reviewSummaryFor(cfg, opts.cwd, opts.adwId) };
    }
    const detail = detailFromFailedPhase(
      cfg,
      opts.cwd,
      opts.adwId,
      `Chain "${cfg.watch.chain}" (adw_id ${opts.adwId}) did not complete successfully. Run \`spf phases ${opts.adwId} --cwd ${opts.cwd}\` for detail.`,
    );
    return { accepted: false, adwId: opts.adwId, detail, reviewRequired };
  };

  /**
   * Same shape as `runChain`, for the refine lane — with one extra step on
   * success: a chain's return value is just an exit code, so what
   * `steps.publishIssues()` actually did — published a tree, OR escalated a
   * question set instead — has to come back through the side channel it
   * wrote (`refine_publish.json` or `refine_questions.json`, under the SAME
   * symlinked session dir `linkDataDir` already wires up), not through
   * `runChainDef`'s return value. The two are read independently and both
   * default to `[]`: `gates.refinementWellFormed` guarantees a chain never
   * writes both files in the same run, so exactly one of `created`/
   * `questions` is ever non-empty on an accepted run.
   */
  const runRefine = async (opts: { prompt: string; cwd: string; adwId: string; issueId: string; chainOptions: Record<string, string> }): Promise<RefineRunResult> => {
    const chainDef = findChain(cfg.watch.refine.chain)!; // checked above
    const ctx: ChainContext = {
      prompt: opts.prompt,
      config_paths: configPaths,
      adw_id: opts.adwId,
      cwd: opts.cwd,
      chain_name: chainDef.name,
      issue_id: opts.issueId,
      // Same reasoning as runChain's ctx above — an unattended dispatch.
      unattended: true,
      chain_source: chainDef.source,
    };
    // Same `watch.chain_options` threading as runChain above — see its
    // comment for the KNOWN LIMITATION this fixes.
    const code = await withRunScope(opts.adwId, () => runChainDef(chainDef, ctx, opts.chainOptions));
    if (code !== 0) {
      const detail = detailFromFailedPhase(
        cfg,
        opts.cwd,
        opts.adwId,
        `Refine chain "${cfg.watch.refine.chain}" (adw_id ${opts.adwId}) did not complete successfully. Run \`spf phases ${opts.adwId} --cwd ${opts.cwd}\` for detail.`,
      );
      return { accepted: false, adwId: opts.adwId, detail, created: [], questions: [], split: [] };
    }
    const wtAnchor = paths.resolveAnchor(opts.cwd);
    const wtDataPaths = paths.resolveDataPaths(wtAnchor, cfg.defaults.data_dir, cfg.observability.db);
    const handoffDir = path.join(wtDataPaths.data_dir, "sessions", opts.adwId, "context_handoff");
    let created: RefineRunResult["created"] = [];
    try {
      created = JSON.parse(readFileSync(path.join(handoffDir, "refine_publish.json"), "utf-8"));
    } catch {
      // best-effort — an empty list still lets runSpec finish cleanly, just with no per-issue summary
    }
    let questions: RefineRunResult["questions"] = [];
    try {
      questions = JSON.parse(readFileSync(path.join(handoffDir, "refine_questions.json"), "utf-8"));
    } catch {
      // best-effort, same as above — no questions file means this run wasn't an escalation
    }
    let split: RefineRunResult["split"] = [];
    try {
      split = JSON.parse(readFileSync(path.join(handoffDir, "refine_split.json"), "utf-8"));
    } catch {
      // best-effort, same as above — no split file means this run didn't propose one
    }
    // Defense in depth: `steps.publishIssues()` now clears whichever of
    // these three files it's NOT about to write, so at most one should ever
    // be non-empty here — but if some future change (or an older worktree's
    // leftover files, before that fix existed) ever produces more than one, a
    // real completed publish must never be silently overridden by a stale
    // question or split proposal. `runSpec` checks `questions` before
    // `split` before the publish path, so without this it would re-escalate
    // (or re-propose a split) over issues that already landed on the tracker
    // seconds earlier.
    if (created.length > 0 && (questions.length > 0 || split.length > 0)) {
      console.error(
        `watch: ${opts.adwId}: refine_publish.json had content alongside a stale refine_questions.json/refine_split.json — treating the ${created.length} published issue(s) as authoritative and discarding the stale escalation`,
      );
      questions = [];
      split = [];
    } else if (questions.length > 0 && split.length > 0) {
      console.error(`watch: ${opts.adwId}: refine_questions.json AND refine_split.json both had content — treating the questions as authoritative and discarding the stale split proposal`);
      split = [];
    }
    return { accepted: true, adwId: opts.adwId, detail: "", created, questions, split };
  };

  // `IssueAuthoringProvider`'s read-back half — `isAuthoringProvider()` is a
  // structural check (see `provider.ts`), so both GitHub and Jira are
  // recognized here without an `instanceof` chain that would need editing
  // for every future authoring-capable provider. `null` on any tracker that
  // ISN'T authoring-capable makes `rollUp` a logged no-op there rather than
  // a startup failure the way `watch.refine.enabled` without authoring
  // support is above: the build lane functions fine without container
  // roll-up, unlike refine, which cannot function without authoring at all.
  // Not a second `resolveAuthoringProvider()` call: that helper's own config
  // validation already ran to produce `provider` itself.
  const authoringProvider = isAuthoringProvider(provider) ? provider : null;

  // Only for the one dispatch a human is actually watching a terminal for —
  // `core/watch.ts` itself is untouched; this only ever swaps `deps.log`
  // below and reads `state.inflight`/`state.refining` sizes after each
  // `tick()`, exactly the seam the plan called for.
  let dashboard: WatchDashboard | undefined;
  if (isInteractive()) {
    const { mountWatchDashboard } = await import("../ui/watch_dashboard.tsx");
    dashboard = mountWatchDashboard({
      repo: `${cfg.watch.issue_provider}+${cfg.watch.code_host}  ${cfg.watch.repo}`,
      labelPrefix: cfg.watch.label_prefix,
      chain: cfg.watch.chain,
      concurrency: cfg.watch.concurrency,
      refineChain: cfg.watch.refine.enabled ? cfg.watch.refine.chain : undefined,
      refineConcurrency: cfg.watch.refine.enabled ? cfg.watch.refine.concurrency : undefined,
      dryRun: Boolean(flags["dry-run"]),
    });
  }

  const deps: WatchDeps = {
    provider,
    codeHost,
    git,
    worktreeGit: makeGit,
    labelPrefix: cfg.watch.label_prefix,
    chain: cfg.watch.chain,
    baseBranch: cfg.watch.base_branch,
    concurrency: cfg.watch.concurrency,
    chainOptions: cfg.watch.chain_options,
    refineEnabled: cfg.watch.refine.enabled,
    refineConcurrency: cfg.watch.refine.concurrency,
    refineChain: cfg.watch.refine.chain,
    runRefine,
    worktreesDir,
    linkDataDir,
    dryRun: Boolean(flags["dry-run"]),
    runChain,
    listChildren: authoringProvider ? (parent) => authoringProvider.listChildren(parent) : undefined,
    // See `WatchDeps.publishSpecs`'s own doc comment: `authoringProvider` is
    // guaranteed non-null whenever `refine.enabled` is true (the startup
    // check above already refuses any `issue_provider` besides github/jira
    // in that case), so this is never `undefined` in the one state
    // `executeApprovedSplits` actually reads it in.
    publishSpecs: authoringProvider
      ? (specs, opts) => refineLib.publishSpecs(authoringProvider, specs, { labelPrefix: cfg.watch.label_prefix, originalSpecId: opts.originalSpecId, priority: opts.priority })
      : undefined,
    log: (message) => (dashboard ? dashboard.log(message) : console.log(message)),
    notify: (event) => {
      notifier?.send(event); // unaffected either way — see mountWatchDashboard's own doc comment
      dashboard?.mirrorNotify(event);
    },
    // `undefined` at the default `watch.fanout.n: 1` — `core/watch.ts`'s
    // `runIssue` never even looks at `deps.fanout` in that case, so the
    // object below doesn't exist at runtime at all unless best-of-N is
    // actually on. `makeWatchFanoutDispatch` is the SAME factory
    // `src/test/watch_fanout_sandbox_wiring.test.ts` exercises directly —
    // the tested object and this shipped object are the same object.
    fanout:
      cfg.watch.fanout.n > 1
        ? {
            n: cfg.watch.fanout.n,
            concurrency: cfg.watch.fanout.concurrency,
            repoRoot: anchor.repo_root, // GitHandle has no repo-root accessor — this is the same value `git` above is bound to
            ...makeWatchFanoutDispatch(cfg, configPaths, dataPaths, findChain(cfg.watch.chain)!), // checked at startup
          }
        : undefined,
  };

  const state = createWatchState();
  let stopping = false;
  // `sleep()`'s pending setTimeout keeps running regardless of `stopping` —
  // setting the flag alone doesn't wake it, which is exactly why Ctrl-C
  // used to appear to do nothing for up to poll_ms (default 60s): the
  // signal landed, but nothing was listening for it to cancel the wait.
  let interrupt: (() => void) | null = null;
  function interruptibleSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      interrupt = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
  let sigints = 0;
  const stop = () => {
    stopping = true;
    interrupt?.();
    sigints++;
    if (sigints >= 2) {
      dashboard?.unmountNow(); // best-effort cursor-visibility restore before the abrupt exit — see WatchDashboard.unmountNow's own comment
      console.error("\n[spf] watch     second interrupt — exiting immediately, without draining");
      releaseLock(lockPath);
      process.exit(130);
    } else {
      console.error("\n[spf] watch     stopping after the current tick (press again to force-quit without draining)");
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // The dashboard already renders this exact information as its own live
  // header (repo/label/chain/concurrency/dry-run) — printing it again here
  // would both duplicate it and interleave a raw console.log with an
  // active Ink region.
  if (!dashboard) {
    console.log(
      `[spf] watch     ${cfg.watch.issue_provider}+${cfg.watch.code_host}  ${cfg.watch.repo}  label "${cfg.watch.label_prefix}:*"  chain "${cfg.watch.chain}"  concurrency ${cfg.watch.concurrency}` +
        (cfg.watch.refine.enabled ? `  refine "${cfg.watch.refine.chain}" concurrency ${cfg.watch.refine.concurrency}` : "") +
        (flags["dry-run"] ? "  (dry run)" : ""),
    );
  }
  deps.notify({
    kind: "watch_started",
    level: "info",
    title: "watch started",
    fields: [
      ["repo", cfg.watch.repo],
      ["label_prefix", cfg.watch.label_prefix],
      ["chain", cfg.watch.chain],
    ],
  });

  try {
    for (;;) {
      dashboard?.setNextPollAt(null); // clears any stale countdown while a tick is actually running
      await tick(deps, state);
      dashboard?.setCounts(state.inflight.size, state.refining.size);
      if (flags["once"] || stopping) break;
      dashboard?.setNextPollAt(Date.now() + cfg.watch.poll_ms);
      await interruptibleSleep(cfg.watch.poll_ms);
      if (stopping) break;
    }
    // BOTH lanes, not just `inflight` — `state.refining`'s specs are exactly
    // as in-flight (a fire-and-forget `runSpec(...).finally(...)`, same
    // shape as `runIssue`'s), and a graceful stop that only waits on
    // `inflight` would print "stopping after the current tick" and then
    // exit while a refine chain is still writing into its worktree — the
    // next `spf watch` start-up would find `claimSpecs`'s per-issue lock
    // still held by this (still-alive, still-running) process's own pid and
    // correctly back off, but ONLY because that lock exists; before it did,
    // this exact gap is what let a resumed spec race a still-running prior
    // attempt for the same issue.
    while (state.inflight.size > 0 || state.refining.size > 0) {
      deps.log(`[spf] watch     draining ${state.inflight.size} in-flight issue(s), ${state.refining.size} refining spec(s)...`); // deps.log already routes to the dashboard when one is mounted, console.log otherwise
      await interruptibleSleep(1000);
      if (stopping && sigints >= 2) break; // stop() itself already exits on the 2nd signal; this is belt-and-suspenders
    }
    return 0;
  } finally {
    deps.notify({ kind: "watch_stopped", level: "info", title: "watch stopped", fields: [["repo", cfg.watch.repo]] });
    await notifier?.flush();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    releaseLock(lockPath);
    await dashboard?.close();
  }
}
