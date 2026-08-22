/**
 * `spf watch` — poll a `watch.repo` for issues labeled `<prefix>:ready`,
 * run `watch.chain` against each in its own git worktree, open a PR, and
 * track it through to merged/blocked. See `src/core/watch.ts` for the
 * actual state machine; this file is just the wiring: config, the GitHub
 * provider, the chain-dispatch callback, the lockfile, and the CLI loop.
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as agents from "../../core/agents.ts";
import * as paths from "../../core/paths.ts";
import { resolveNotifier } from "../../core/notify/notifier.ts";
import { isRepoAt, makeGit } from "../../core/git_helper.ts";
import { GitHubProvider } from "../../core/issues/github_provider.ts";
import { JiraProvider } from "../../core/issues/jira_provider.ts";
import { BitbucketProvider } from "../../core/issues/bitbucket_provider.ts";
import type { CodeHostProvider, IssueProvider } from "../../core/issues/provider.ts";
import { createWatchState, tick, type ChainRunResult, type RefineRunResult, type WatchDeps } from "../../core/watch.ts";
import { findChain, runChain as runChainDef } from "../../chains/index.ts";
import type { ChainContext } from "../../chains/context.ts";
import type { SFConfig } from "../../core/data_types.ts";
import { SfDb } from "../../ui/server/db.ts";
import { parseCli } from "../../core/utils.ts";

/**
 * Shared by `watch` and `watch init`: resolve config into an `IssueProvider`
 * — checking only what BOTH need. `watch`'s own extra checks (a real git
 * repo, a registered chain) don't apply to seeding labels. Prints its own
 * error and returns `null` on failure — the caller just needs to `return 1`.
 */
function resolveIssueProvider(cfg: SFConfig): IssueProvider | null {
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
    return new JiraProvider(cfg.watch.jira.base_url, cfg.watch.jira.project_key, cfg.watch.label_prefix, email, token);
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stale-steal, like the reference implementation's daemon lock: a dead pid never blocks a restart. */
function acquireLock(lockPath: string): void {
  if (existsSync(lockPath)) {
    const pid = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    if (Number.isInteger(pid) && isPidAlive(pid)) {
      throw new Error(`another \`spf watch\` is already running (pid ${pid}) — lock at ${lockPath}`);
    }
  }
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, String(process.pid));
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone — fine
  }
}

/**
 * `spf watch init` — idempotently seed the `<prefix>:*` labels the state
 * machine needs, with sensible colors/descriptions. Doesn't touch git or
 * run anything, so it skips watchCommand's repo/chain checks entirely —
 * you can seed labels before ever wiring up a worktree-capable checkout.
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
  return 0;
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
    if (cfg.watch.issue_provider !== "github") {
      // Fail loudly at startup, not silently every tick: JiraProvider
      // doesn't implement IssueAuthoringProvider yet (see its module
      // comment) — a refine lane that can never publish would otherwise
      // just claim every spec-ready spec and block it, forever.
      console.error(
        `watch.refine.enabled is true but watch.issue_provider is ${JSON.stringify(cfg.watch.issue_provider)} — ` +
          `the refine lane needs "github" (issue authoring isn't implemented for Jira yet)`,
      );
      return 1;
    }
    if (!findChain(cfg.watch.refine.chain)) {
      console.error(`watch.refine.chain ${JSON.stringify(cfg.watch.refine.chain)} is not a registered chain — run \`spf list\` to see every chain`);
      return 1;
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
    if (existsSync(target)) return;
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(dataPaths.data_dir, target, "dir");
  }

  /** Shared by `runChain`/`runRefine`: best-effort enrichment of a generic "didn't succeed" message with the first phase that actually failed, read back from the worktree's own (symlinked) trace db. */
  function detailFromFailedPhase(cwd: string, adwId: string, prefix: string): string {
    let detail = prefix;
    try {
      const wtAnchor = paths.resolveAnchor(cwd);
      const wtDataPaths = paths.resolveDataPaths(wtAnchor, cfg.defaults.data_dir, cfg.observability.db);
      const db = new SfDb(wtDataPaths.db_path);
      const failed = db.phases(adwId).find((p) => p.status === "fail");
      if (failed) detail += ` Phase "${failed.name}" failed: ${failed.error ?? "(no detail)"}`;
    } catch {
      // best-effort — the generic message above still points at where to look
    }
    return detail;
  }

  const runChain = async (opts: { prompt: string; cwd: string; adwId: string }): Promise<ChainRunResult> => {
    const chainDef = findChain(cfg.watch.chain)!; // checked above
    const ctx: ChainContext = { prompt: opts.prompt, config_paths: configPaths, adw_id: opts.adwId, cwd: opts.cwd, chain_name: chainDef.name };
    const code = await runChainDef(chainDef, ctx);
    if (code === 0) return { accepted: true, adwId: opts.adwId, detail: "" };
    const detail = detailFromFailedPhase(
      opts.cwd,
      opts.adwId,
      `Chain "${cfg.watch.chain}" (adw_id ${opts.adwId}) did not complete successfully. Run \`spf phases ${opts.adwId} --cwd ${opts.cwd}\` for detail.`,
    );
    return { accepted: false, adwId: opts.adwId, detail };
  };

  /**
   * Same shape as `runChain`, for the refine lane — with one extra step on
   * success: a chain's return value is just an exit code, so the created-
   * issues list `steps.publishIssues()` actually produced has to come back
   * through the side channel it wrote (`refine_publish.json`, under the
   * SAME symlinked session dir `linkDataDir` already wires up), not through
   * `runChainDef`'s return value.
   */
  const runRefine = async (opts: { prompt: string; cwd: string; adwId: string; issueId: string }): Promise<RefineRunResult> => {
    const chainDef = findChain(cfg.watch.refine.chain)!; // checked above
    const ctx: ChainContext = {
      prompt: opts.prompt,
      config_paths: configPaths,
      adw_id: opts.adwId,
      cwd: opts.cwd,
      chain_name: chainDef.name,
      issue_id: opts.issueId,
    };
    const code = await runChainDef(chainDef, ctx);
    if (code !== 0) {
      const detail = detailFromFailedPhase(
        opts.cwd,
        opts.adwId,
        `Refine chain "${cfg.watch.refine.chain}" (adw_id ${opts.adwId}) did not complete successfully. Run \`spf phases ${opts.adwId} --cwd ${opts.cwd}\` for detail.`,
      );
      return { accepted: false, adwId: opts.adwId, detail, created: [] };
    }
    let created: RefineRunResult["created"] = [];
    try {
      const wtAnchor = paths.resolveAnchor(opts.cwd);
      const wtDataPaths = paths.resolveDataPaths(wtAnchor, cfg.defaults.data_dir, cfg.observability.db);
      const summaryPath = path.join(wtDataPaths.data_dir, "sessions", opts.adwId, "context_handoff", "refine_publish.json");
      created = JSON.parse(readFileSync(summaryPath, "utf-8"));
    } catch {
      // best-effort — an empty list still lets runSpec finish cleanly, just with no per-issue summary
    }
    return { accepted: true, adwId: opts.adwId, detail: "", created };
  };

  const deps: WatchDeps = {
    provider,
    codeHost,
    git,
    worktreeGit: makeGit,
    labelPrefix: cfg.watch.label_prefix,
    chain: cfg.watch.chain,
    baseBranch: cfg.watch.base_branch,
    concurrency: cfg.watch.concurrency,
    refineEnabled: cfg.watch.refine.enabled,
    refineConcurrency: cfg.watch.refine.concurrency,
    refineChain: cfg.watch.refine.chain,
    runRefine,
    worktreesDir,
    linkDataDir,
    dryRun: Boolean(flags["dry-run"]),
    runChain,
    log: (message) => console.log(message),
    notify: (event) => notifier?.send(event),
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
      console.error("\n[spf] watch     second interrupt — exiting immediately, without draining");
      releaseLock(lockPath);
      process.exit(130);
    } else {
      console.error("\n[spf] watch     stopping after the current tick (press again to force-quit without draining)");
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(
    `[spf] watch     ${cfg.watch.issue_provider}+${cfg.watch.code_host}  ${cfg.watch.repo}  label "${cfg.watch.label_prefix}:*"  chain "${cfg.watch.chain}"  concurrency ${cfg.watch.concurrency}` +
      (cfg.watch.refine.enabled ? `  refine "${cfg.watch.refine.chain}" concurrency ${cfg.watch.refine.concurrency}` : "") +
      (flags["dry-run"] ? "  (dry run)" : ""),
  );
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
      await tick(deps, state);
      if (flags["once"] || stopping) break;
      await interruptibleSleep(cfg.watch.poll_ms);
      if (stopping) break;
    }
    while (state.inflight.size > 0) {
      console.log(`[spf] watch     draining ${state.inflight.size} in-flight issue(s)...`);
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
  }
}
