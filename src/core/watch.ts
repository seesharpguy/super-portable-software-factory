/**
 * The `spf watch` state machine — two lanes over the same poll loop.
 *
 * The build lane: poll -> claim -> run a chain -> PR -> done/blocked.
 * The refine lane (`watch.refine.enabled`, off by default): poll a
 * `spec-ready` product spec -> claim -> decompose it into a feature/story
 * tree -> publish those as real issues -> done/blocked. A spec is not
 * individually workable, so this lane never opens a PR — it hands the build
 * lane its next batch of `ready`-able work instead (see `core/refine.ts`).
 *
 * Provider-agnostic (drives whatever `IssueProvider` it's given) and
 * chain-agnostic (drives whatever `runChain`/`runRefine` callback it's
 * given) — deliberately kept out of `src/chains/`'s dependency direction,
 * so this stays testable against a fake provider and fake callbacks with no
 * chain registry involved.
 *
 * Design lifted from the user's own GitHub-poller reference implementation
 * (a label-as-state-machine daemon), leaned down for a v1: no per-issue
 * telemetry, no dashboard, no Projects v2 mirroring, no CI-fix retry loop,
 * no auto-merge. What's kept, because it's cheap and load-bearing:
 *
 *  - `transition()` is the ONE state mutator (see `provider.ts`) — every
 *    state change traces to one call site.
 *  - A marker (a hidden HTML comment on the issue) is the durable scratch
 *    state — zero infrastructure, survives a daemon crash.
 *  - `listInState("review", {includeAll: true})` — a tracker that
 *    auto-closes an issue the instant its linked PR merges (GitHub's
 *    `Closes #n`) can make it vanish from an open-only query before the
 *    next tick runs.
 *  - Orphan reconciliation: any `working` issue this process isn't
 *    tracking gets one of three outcomes (resume via its marker's PR,
 *    retry up to a cap, or give up and block) every tick — a hung daemon
 *    restart never leaves an issue silently stuck.
 *  - Worktree-per-issue, isolated outside the repo, made cheap by SPF's
 *    own `--cwd` support: no new chain-dispatch plumbing needed, just
 *    pointing an existing chain at a different working tree.
 */
import path from "node:path";
import type { GitHandle } from "./git_helper.ts";
import type { CodeHostProvider, Issue, IssueProvider, WatchMarker } from "./issues/provider.ts";
import type { NotifyEvent } from "./notify/channel.ts";

const MAX_ORPHAN_ATTEMPTS = 2;

export interface ChainRunResult {
  accepted: boolean;
  adwId: string;
  /** Shown to the engineer via a `blocked` comment on a failed/no-op run. */
  detail: string;
  /**
   * A short, already-sanitized/truncated digest of the reviewer's verdict
   * (approved/blocking/findings), read back best-effort from the sessions DB
   * — see `cli/commands/watch.ts`'s `runChain`. `undefined` when the chain
   * that ran has no reviewer step, or the DB read/parse failed; `runIssue`
   * below falls back to `reviewRequired` to tell those two apart in the PR
   * body and `pr_opened` notification.
   */
  reviewSummary?: string;
  /** Whether the chain that ran declares a "reviewer" in its `requiredAgents` — distinguishes "reviewer approved" from "nothing reviewed this change" when `reviewSummary` is absent. */
  reviewRequired?: boolean;
}

/** One issue the refine lane created — enough for `finishSpec`'s summary comment and the marker's idempotency record. */
export interface RefinedIssueRef {
  id: string;
  title: string;
  kind: string;
  isLeaf: boolean;
}

export interface RefineRunResult {
  accepted: boolean;
  adwId: string;
  /** Shown to the engineer via a `blocked` comment on a failed/no-op run. */
  detail: string;
  /** What `steps.publishIssues()` created, read back from its side-channel file — see `cli/commands/watch.ts`'s `runRefine`. Empty when `!accepted`. */
  created: RefinedIssueRef[];
}

export interface WatchDeps {
  provider: IssueProvider;
  codeHost: CodeHostProvider;
  git: GitHandle; // bound to the main repo root
  /** Bound to a specific worktree path (diffFiles/push run there) — inject `git_helper.makeGit` for real use, a fake for tests. */
  worktreeGit: (worktreePath: string) => GitHandle;
  labelPrefix: string;
  chain: string;
  baseBranch: string;
  concurrency: number;
  /**
   * The second lane — decomposing a `<prefix>:spec-ready` product spec
   * instead of building a `<prefix>:ready` issue. `false` (the default) is
   * a complete no-op: `claimSpecs`/`reconcileRefining` return immediately,
   * so an existing `spf watch` config sees no new poll traffic at all until
   * this is turned on. See `WatchConfigSchema`'s `refine` field.
   */
  refineEnabled: boolean;
  refineConcurrency: number;
  refineChain: string;
  /** Same shape as `runChain`, for the refine lane — see its own doc comment for why the two aren't unified into one callback. */
  runRefine: (opts: { prompt: string; cwd: string; adwId: string; issueId: string }) => Promise<RefineRunResult>;
  worktreesDir: string; // OUTSIDE the repo — see module doc comment
  /**
   * Symlink (or otherwise wire up) `<worktreePath>/.spf/data` to the MAIN
   * repo's own persistent data_dir, called once per worktree right after
   * it's created. Without this, a chain run's session/trace data resolves
   * relative to `cwd` (the worktree — see ChainContext's doc comment) and
   * lands in a fresh, throwaway `.spf/data` that `cleanupWorktree` deletes
   * along with the rest of the worktree once the issue finishes: no trace
   * in `spf ui`, and no trace anywhere at all after cleanup. Injected (not
   * called directly) so watch.ts's own tests never touch the real
   * filesystem for it.
   */
  linkDataDir: (worktreePath: string) => void;
  dryRun: boolean;
  runChain: (opts: { prompt: string; cwd: string; adwId: string }) => Promise<ChainRunResult>;
  log: (message: string) => void;
  /**
   * Structured push, alongside `log`'s plain string — a required field, like
   * `log`, so a test must consciously supply one (a no-op fake is fine).
   * Fired only at meaningful state transitions (claim, PR, done, blocked,
   * error) — NOT at routine self-healing (an orphan resume/retry, a lost
   * claim race, a cleanup warning), which recovers on its own and would
   * just be noise in a channel.
   */
  notify: (event: NotifyEvent) => void;
}

export interface WatchRunState {
  inflight: Set<string>;
  /**
   * Separate from `inflight` — not a defensive copy of the same set, a
   * genuinely different budget. The refine lane's `claimSpecs` caps against
   * `refineConcurrency`, independent of the build lane's `concurrency`; a
   * shared set would conflate "how many specs are being refined" with "how
   * many issues are being built" and make either budget impossible to
   * enforce on its own. The two never collide on an id in practice (a
   * `spec-ready` issue and a `ready` issue are never the same issue), but
   * that isn't why this is separate — the budgets are what require it.
   */
  refining: Set<string>;
}

export function createWatchState(): WatchRunState {
  return { inflight: new Set(), refining: new Set() };
}

function slugifyTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5)
      .join("-")
      .replace(/[^a-z0-9-]/g, "") || "issue"
  );
}

export function branchNameFor(issue: Issue): string {
  // The issue's own id in the branch name isn't just labeling: Jira's
  // Bitbucket integration auto-links a PR to the issue when its key
  // appears anywhere in the branch name, no explicit API call needed.
  return `spf-watch/${issue.id}-${slugifyTitle(issue.title)}`.slice(0, 200);
}

/** Same idea as `branchNameFor`, for the refine lane's throwaway worktree — a spec never gets a PR, so this branch is only ever fetched-from-and-thrown-away, never pushed. */
export function refineBranchNameFor(issue: Issue): string {
  return `spf-refine/${issue.id}-${slugifyTitle(issue.title)}`.slice(0, 200);
}

function worktreePathFor(deps: WatchDeps, issue: Issue): string {
  return path.join(deps.worktreesDir, `issue-${issue.id}`);
}

function specWorktreePathFor(deps: WatchDeps, issue: Issue): string {
  return path.join(deps.worktreesDir, `spec-${issue.id}`);
}

function cleanupWorktree(deps: WatchDeps, marker: WatchMarker | null): void {
  if (!marker) return;
  try {
    if (marker.worktree) deps.git.worktreeRemove(marker.worktree);
    if (marker.branch) deps.git.deleteLocalBranch(marker.branch);
  } catch (error) {
    deps.log(`watch: cleanup warning: ${(error as Error).message}`);
  }
}

/**
 * Any issue labeled `working` that THIS process isn't tracking is an
 * orphan — a daemon restart, or another instance's claim this process
 * never saw. Resume if its marker points at a still-open (or already
 * merged) PR; otherwise retry up to `MAX_ORPHAN_ATTEMPTS`, then give up.
 */
export async function reconcileOrphans(deps: WatchDeps, state: WatchRunState): Promise<void> {
  const working = await deps.provider.listInState("working");
  for (const issue of working) {
    if (state.inflight.has(issue.id)) continue;
    const marker = await deps.provider.readMarker(issue);
    if (marker?.pr) {
      const status = await deps.codeHost.prStatus({ number: marker.pr, branch: marker.branch ?? "", url: "" });
      if (status.state === "open" || status.merged) {
        deps.log(`watch: ${issue.id} orphaned with an open/merged PR #${marker.pr} — resuming as review`);
        if (!deps.dryRun) await deps.provider.transition(issue, "review");
        continue;
      }
    }
    const attempt = (marker?.attempt ?? 0) + 1;
    if (attempt <= MAX_ORPHAN_ATTEMPTS) {
      deps.log(`watch: ${issue.id} orphaned, retry ${attempt}/${MAX_ORPHAN_ATTEMPTS} — back to ready`);
      if (!deps.dryRun) {
        await deps.provider.writeMarker(issue, { ...marker, attempt });
        await deps.provider.transition(issue, "ready");
      }
    } else {
      deps.log(`watch: ${issue.id} orphaned past ${MAX_ORPHAN_ATTEMPTS} attempts — blocked`);
      deps.notify({
        kind: "issue_blocked",
        level: "error",
        title: `issue ${issue.id} blocked`,
        detail: `Gave up after ${MAX_ORPHAN_ATTEMPTS} orphaned attempts.`,
        fields: [["issue", issue.id], ["title", issue.title]],
      });
      if (!deps.dryRun) {
        await deps.provider.transition(issue, "blocked", `Gave up after ${MAX_ORPHAN_ATTEMPTS} orphaned attempts.`);
        cleanupWorktree(deps, marker);
      }
    }
  }
}

/**
 * Post the summary comment on a decomposed spec and transition it to `done`
 * — the refine lane's one shared finishing move, reached from both the
 * normal path (`runSpec`, right after a successful publish) and the
 * orphan-resume path (`reconcileRefining`, when a completed publish's
 * marker survived a crash the `transition` itself didn't). `created` only
 * has titles/kinds in the normal path — an orphan resume has nothing but
 * the ids `WatchMarker.refined` recorded, and the comment degrades to a
 * bare list of `#id`s rather than blocking on a re-fetch.
 */
async function finishSpec(deps: WatchDeps, issue: Issue, created: Array<{ id: string; title?: string; kind?: string }>): Promise<void> {
  const body =
    created.length > 0
      ? `spf watch refined this spec into ${created.length} issue(s):\n\n` +
        created.map((c) => (c.title ? `- #${c.id} (${c.kind}): ${c.title}` : `- #${c.id}`)).join("\n") +
        `\n\nPromote any of them to \`${deps.labelPrefix}:ready\` when it's worth building.`
      : `spf watch refined this spec but the refiner produced no issues.`;
  deps.notify({
    kind: "spec_refined",
    level: "info",
    title: `spec ${issue.id} refined`,
    detail: `${created.length} issue(s) created.`,
    fields: [["issue", issue.id], ["title", issue.title], ["created", String(created.length)]],
  });
  if (!deps.dryRun) {
    await deps.provider.comment(issue, body);
    await deps.provider.transition(issue, "done");
  }
}

/**
 * The refine lane's own `reconcileOrphans` — a `refining`-labeled spec this
 * process isn't tracking is either a completed publish that crashed before
 * its own `transition(issue, "done")` ran (resume: finish it, no re-run),
 * or a genuine orphan (retry up to `MAX_ORPHAN_ATTEMPTS`, then give up).
 * A no-op entirely when `watch.refine` is off — see `WatchDeps.refineEnabled`.
 */
export async function reconcileRefining(deps: WatchDeps, state: WatchRunState): Promise<void> {
  if (!deps.refineEnabled) return;
  const refining = await deps.provider.listInState("refining");
  for (const issue of refining) {
    if (state.refining.has(issue.id)) continue;
    const marker = await deps.provider.readMarker(issue);
    if (marker?.refined && marker.refined.length > 0) {
      deps.log(`watch: spec ${issue.id} orphaned after publish already completed — finishing`);
      await finishSpec(deps, issue, marker.refined.map((id) => ({ id })));
      continue;
    }
    const attempt = (marker?.attempt ?? 0) + 1;
    if (attempt <= MAX_ORPHAN_ATTEMPTS) {
      deps.log(`watch: spec ${issue.id} orphaned mid-refine, retry ${attempt}/${MAX_ORPHAN_ATTEMPTS} — back to spec-ready`);
      if (!deps.dryRun) {
        await deps.provider.writeMarker(issue, { ...marker, attempt });
        await deps.provider.transition(issue, "spec-ready");
      }
    } else {
      deps.log(`watch: spec ${issue.id} orphaned past ${MAX_ORPHAN_ATTEMPTS} attempts — blocked`);
      deps.notify({
        kind: "issue_blocked",
        level: "error",
        title: `spec ${issue.id} blocked`,
        detail: `Gave up after ${MAX_ORPHAN_ATTEMPTS} orphaned refine attempts.`,
        fields: [["issue", issue.id], ["title", issue.title]],
      });
      if (!deps.dryRun) {
        await deps.provider.transition(issue, "blocked", `Gave up after ${MAX_ORPHAN_ATTEMPTS} orphaned refine attempts.`);
        cleanupWorktree(deps, marker);
      }
    }
  }
}

/** Poll every `review`-labeled issue's PR for merged (-> done) or closed-without-merging (-> blocked). */
export async function finishReviews(deps: WatchDeps): Promise<void> {
  const reviewing = await deps.provider.listInState("review", { includeAll: true });
  for (const issue of reviewing) {
    const marker = await deps.provider.readMarker(issue);
    if (!marker?.pr) continue;
    const status = await deps.codeHost.prStatus({ number: marker.pr, branch: marker.branch ?? "", url: "" });
    if (status.merged) {
      deps.log(`watch: ${issue.id}'s PR #${marker.pr} merged — done`);
      deps.notify({
        kind: "issue_done",
        level: "info",
        title: `issue ${issue.id} done`,
        detail: `PR #${marker.pr} merged.`,
        fields: [["issue", issue.id], ["title", issue.title], ["pr", `#${marker.pr}`]],
      });
      if (!deps.dryRun) {
        await deps.provider.transition(issue, "done");
        cleanupWorktree(deps, marker);
      }
    } else if (status.state === "closed") {
      deps.log(`watch: ${issue.id}'s PR #${marker.pr} closed without merging — blocked`);
      deps.notify({
        kind: "issue_blocked",
        level: "error",
        title: `issue ${issue.id} blocked`,
        detail: `PR #${marker.pr} was closed without merging.`,
        fields: [["issue", issue.id], ["title", issue.title], ["pr", `#${marker.pr}`]],
      });
      if (!deps.dryRun) {
        await deps.provider.transition(issue, "blocked", `PR #${marker.pr} was closed without merging.`);
        cleanupWorktree(deps, marker);
      }
    }
  }
}

/** One issue's full claim -> chain -> PR path, run in the background — `claimNewWork` doesn't await this. */
async function runIssue(deps: WatchDeps, issue: Issue): Promise<void> {
  const branch = branchNameFor(issue);
  const worktreePath = worktreePathFor(deps, issue);
  const adwId = `issue-${issue.id}`;
  try {
    // Both worktreePath and branch are fully deterministic from issue.id —
    // the only way either could already exist is a previous spf watch
    // attempt for THIS issue that never reached its own cleanup (killed
    // mid-run, crashed, machine restart). `git worktree add -b` refuses
    // outright if the branch already exists ("fatal: a branch named '...'
    // already exists"), which without this would permanently block the
    // issue from ever being claimed again — it'd fail this same way on
    // every single retry. Safe to clear unconditionally: worktreeRemove/
    // deleteLocalBranch are both no-ops if there's nothing to remove.
    cleanupWorktree(deps, { worktree: worktreePath, branch });
    deps.git.fetch("origin", deps.baseBranch);
    deps.git.worktreeAdd(worktreePath, branch, `origin/${deps.baseBranch}`);
    deps.linkDataDir(worktreePath);
    await deps.provider.writeMarker(issue, { worktree: worktreePath, branch, attempt: 0 });

    const prompt = `${issue.title}\n\n${issue.body}`.trim();
    const result = await deps.runChain({ prompt, cwd: worktreePath, adwId });

    if (!result.accepted) {
      deps.log(`watch: ${issue.id}: chain "${deps.chain}" did not succeed — blocked`);
      const detail = result.detail || `Chain "${deps.chain}" (adw_id ${adwId}) did not complete successfully. Run \`spf phases ${adwId}\` for detail.`;
      deps.notify({
        kind: "issue_blocked",
        level: "error",
        title: `issue ${issue.id} blocked`,
        detail,
        fields: [["issue", issue.id], ["title", issue.title], ["chain", deps.chain], ["adw_id", adwId]],
      });
      await deps.provider.transition(issue, "blocked", detail);
      cleanupWorktree(deps, { worktree: worktreePath, branch });
      return;
    }

    const wtGit = deps.worktreeGit(worktreePath);
    if (wtGit.diffFiles(`origin/${deps.baseBranch}`).length === 0) {
      deps.log(`watch: ${issue.id}: chain succeeded but committed nothing — blocked`);
      deps.notify({
        kind: "issue_blocked",
        level: "error",
        title: `issue ${issue.id} blocked`,
        detail: `Chain "${deps.chain}" (adw_id ${adwId}) completed but left no committed changes.`,
        fields: [["issue", issue.id], ["title", issue.title], ["chain", deps.chain], ["adw_id", adwId]],
      });
      await deps.provider.transition(issue, "blocked", `Chain "${deps.chain}" (adw_id ${adwId}) completed but left no committed changes.`);
      cleanupWorktree(deps, { worktree: worktreePath, branch });
      return;
    }

    wtGit.push("origin", branch);
    // The human merging this PR sees whatever the reviewer found — or, if
    // nothing reviewed this change at all, is told that plainly rather than
    // left to assume a silent approval. `reviewSummary` is already
    // sanitized/truncated by the caller (see runChain's own doc comment).
    const reviewLine = result.reviewSummary
      ? result.reviewSummary
      : result.reviewRequired
        ? "Reviewer ran, but no verdict could be read back from the session data."
        : `Nothing reviewed this change — chain \`${deps.chain}\` has no reviewer step.`;
    // No cross-linking magic keyword here on purpose (a code host paired
    // with a different tracker has no "Closes #n" convention to hook into
    // — see provider.ts) — the issue id in the title/body is plain text
    // for humans, and, on a Jira+Bitbucket pairing, exactly what Jira's own
    // Bitbucket integration scans for to link the PR automatically.
    const pr = await deps.codeHost.openPr({
      branch,
      title: `${issue.title} (${issue.id})`,
      body: `Automated by \`spf watch\` — chain \`${deps.chain}\`, adw_id \`${adwId}\`, issue ${issue.id}.\n\n${reviewLine}`,
      base: deps.baseBranch,
    });
    await deps.provider.writeMarker(issue, { worktree: worktreePath, branch, pr: pr.number, attempt: 0 });
    await deps.provider.transition(issue, "review");
    deps.log(`watch: ${issue.id}: opened PR #${pr.number} — review`);
    deps.notify({
      kind: "pr_opened",
      level: "info",
      title: `PR #${pr.number} opened`,
      detail: reviewLine,
      fields: [
        ["issue", issue.id],
        ["title", issue.title],
        ["chain", deps.chain],
        ["review", result.reviewSummary ? "reviewed" : result.reviewRequired ? "reviewer ran, no verdict" : "not reviewed"],
      ],
      url: pr.url || undefined,
    });
  } catch (error) {
    const message = (error as Error).message;
    deps.log(`watch: ${issue.id}: error: ${message}`);
    deps.notify({
      kind: "watch_error",
      level: "error",
      title: `issue ${issue.id} errored`,
      detail: message,
      fields: [["issue", issue.id], ["title", issue.title]],
    });
    await deps.provider.transition(issue, "blocked", `spf watch error: ${message}`).catch(() => undefined);
    cleanupWorktree(deps, { worktree: worktreePath, branch });
  }
}

/**
 * One spec's full claim -> decompose -> publish path, run in the background
 * — `claimSpecs` doesn't await this. The build lane's `runIssue`, minus the
 * PR half: no `diffFiles` check (the refiner has `writes: []`, so an empty
 * diff is the CORRECT outcome, not a failure), no push, no `openPr`. Its
 * mirror image is "publish, then finish" instead of "commit, then review".
 */
async function runSpec(deps: WatchDeps, issue: Issue): Promise<void> {
  const branch = refineBranchNameFor(issue);
  const worktreePath = specWorktreePathFor(deps, issue);
  const adwId = `spec-${issue.id}`;
  try {
    // A spec re-claimed after a completed publish (the transition/comment
    // that should have followed never ran — a crash, a kill) already has
    // its answer on disk: skip straight to finishing rather than asking the
    // refiner to redo work that already exists on the tracker. `to-tickets`
    // (the skill this lane's prompt is ported from) has no such guard and
    // would duplicate every issue on a re-run.
    const existingMarker = await deps.provider.readMarker(issue);
    if (existingMarker?.refined && existingMarker.refined.length > 0) {
      deps.log(`watch: spec ${issue.id}: a previous attempt already published ${existingMarker.refined.length} issue(s) — finishing without re-running the refiner`);
      await finishSpec(deps, issue, existingMarker.refined.map((id) => ({ id })));
      return;
    }

    // See runIssue's identical comment: worktreePath/branch are deterministic
    // from issue.id, so a leftover from a killed prior attempt is the only
    // way either could already exist — clear it unconditionally.
    cleanupWorktree(deps, { worktree: worktreePath, branch });
    deps.git.fetch("origin", deps.baseBranch);
    deps.git.worktreeAdd(worktreePath, branch, `origin/${deps.baseBranch}`);
    deps.linkDataDir(worktreePath);
    await deps.provider.writeMarker(issue, { worktree: worktreePath, branch, attempt: 0 });

    const prompt = `${issue.title}\n\n${issue.body}`.trim();
    const result = await deps.runRefine({ prompt, cwd: worktreePath, adwId, issueId: issue.id });

    if (!result.accepted) {
      deps.log(`watch: spec ${issue.id}: refine chain "${deps.refineChain}" did not succeed — blocked`);
      const detail = result.detail || `Refine chain "${deps.refineChain}" (adw_id ${adwId}) did not complete successfully. Run \`spf phases ${adwId}\` for detail.`;
      deps.notify({
        kind: "issue_blocked",
        level: "error",
        title: `spec ${issue.id} blocked`,
        detail,
        fields: [["issue", issue.id], ["title", issue.title], ["chain", deps.refineChain], ["adw_id", adwId]],
      });
      await deps.provider.transition(issue, "blocked", detail);
      cleanupWorktree(deps, { worktree: worktreePath, branch });
      return;
    }

    await deps.provider.writeMarker(issue, { worktree: worktreePath, branch, attempt: 0, refined: result.created.map((c) => c.id) });
    await finishSpec(deps, issue, result.created);
    cleanupWorktree(deps, { worktree: worktreePath, branch });
  } catch (error) {
    const message = (error as Error).message;
    deps.log(`watch: spec ${issue.id}: refine error: ${message}`);
    deps.notify({
      kind: "watch_error",
      level: "error",
      title: `spec ${issue.id} errored`,
      detail: message,
      fields: [["issue", issue.id], ["title", issue.title]],
    });
    await deps.provider.transition(issue, "blocked", `spf watch refine error: ${message}`).catch(() => undefined);
    cleanupWorktree(deps, { worktree: worktreePath, branch });
  }
}

/** Claim as many `ready` issues as the concurrency budget allows, and kick off `runIssue` for each in the background. */
export async function claimNewWork(deps: WatchDeps, state: WatchRunState): Promise<void> {
  if (state.inflight.size >= deps.concurrency) return;
  const eligible = await deps.provider.listEligible();
  for (const issue of eligible) {
    if (state.inflight.size >= deps.concurrency) break;
    if (state.inflight.has(issue.id)) continue;
    if (deps.dryRun) {
      deps.log(`watch: [dry-run] would claim ${issue.id} (${issue.title}) and run chain "${deps.chain}"`);
      continue;
    }
    const claimed = await deps.provider.claim(issue);
    if (!claimed) {
      deps.log(`watch: ${issue.id} lost the claim race this tick — skipping`);
      continue;
    }
    deps.log(`watch: claimed ${issue.id}: ${issue.title}`);
    deps.notify({
      kind: "issue_claimed",
      level: "info",
      title: `issue ${issue.id} claimed`,
      fields: [["issue", issue.id], ["title", issue.title], ["chain", deps.chain]],
    });
    state.inflight.add(issue.id);
    runIssue(deps, issue).finally(() => state.inflight.delete(issue.id));
  }
}

/** Claim as many `spec-ready` specs as `refineConcurrency` allows, and kick off `runSpec` for each in the background. A no-op when `watch.refine` is off. */
export async function claimSpecs(deps: WatchDeps, state: WatchRunState): Promise<void> {
  if (!deps.refineEnabled) return;
  if (state.refining.size >= deps.refineConcurrency) return;
  const eligible = await deps.provider.listInState("spec-ready");
  for (const issue of eligible) {
    if (state.refining.size >= deps.refineConcurrency) break;
    if (state.refining.has(issue.id)) continue;
    if (deps.dryRun) {
      deps.log(`watch: [dry-run] would claim spec ${issue.id} (${issue.title}) and run refine chain "${deps.refineChain}"`);
      continue;
    }
    const claimed = await deps.provider.claim(issue, { from: "spec-ready", to: "refining" });
    if (!claimed) {
      deps.log(`watch: spec ${issue.id} lost the claim race this tick — skipping`);
      continue;
    }
    deps.log(`watch: claimed spec ${issue.id}: ${issue.title}`);
    deps.notify({
      kind: "issue_claimed",
      level: "info",
      title: `spec ${issue.id} claimed`,
      fields: [["issue", issue.id], ["title", issue.title], ["chain", deps.refineChain]],
    });
    state.refining.add(issue.id);
    runSpec(deps, issue).finally(() => state.refining.delete(issue.id));
  }
}

function tickErrorHandler(deps: WatchDeps, stage: string): (error: unknown) => void {
  return (error: unknown) => {
    const message = (error as Error).message;
    deps.log(`watch: ${stage} error: ${message}`);
    deps.notify({ kind: "watch_error", level: "error", title: `watch: ${stage} error`, detail: message, fields: [] });
  };
}

/** One poll tick: reconcile both lanes, finish reviews, then claim both lanes — each stage independently caught, so one stage's error never blocks the rest. */
export async function tick(deps: WatchDeps, state: WatchRunState): Promise<void> {
  await reconcileOrphans(deps, state).catch(tickErrorHandler(deps, "reconcileOrphans"));
  await reconcileRefining(deps, state).catch(tickErrorHandler(deps, "reconcileRefining"));
  await finishReviews(deps).catch(tickErrorHandler(deps, "finishReviews"));
  await claimSpecs(deps, state).catch(tickErrorHandler(deps, "claimSpecs"));
  await claimNewWork(deps, state).catch(tickErrorHandler(deps, "claimNewWork"));
}
