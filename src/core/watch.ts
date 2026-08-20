/**
 * The `spf watch` state machine: poll -> claim -> run a chain -> PR ->
 * done/blocked. Provider-agnostic (drives whatever `IssueProvider` it's
 * given) and chain-agnostic (drives whatever `runChain` callback it's
 * given) — deliberately kept out of `src/chains/`'s dependency direction,
 * so this stays testable against a fake provider and a fake `runChain`
 * with no chain registry involved.
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

const MAX_ORPHAN_ATTEMPTS = 2;

export interface ChainRunResult {
  accepted: boolean;
  adwId: string;
  /** Shown to the engineer via a `blocked` comment on a failed/no-op run. */
  detail: string;
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
  worktreesDir: string; // OUTSIDE the repo — see module doc comment
  dryRun: boolean;
  runChain: (opts: { prompt: string; cwd: string; adwId: string }) => Promise<ChainRunResult>;
  log: (message: string) => void;
}

export interface WatchRunState {
  inflight: Set<string>;
}

export function createWatchState(): WatchRunState {
  return { inflight: new Set() };
}

export function branchNameFor(issue: Issue): string {
  const slug = issue.title
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .replace(/[^a-z0-9-]/g, "");
  // The issue's own id in the branch name isn't just labeling: Jira's
  // Bitbucket integration auto-links a PR to the issue when its key
  // appears anywhere in the branch name, no explicit API call needed.
  return `spf-watch/${issue.id}-${slug || "issue"}`.slice(0, 200);
}

function worktreePathFor(deps: WatchDeps, issue: Issue): string {
  return path.join(deps.worktreesDir, `issue-${issue.id}`);
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
      if (!deps.dryRun) {
        await deps.provider.transition(issue, "blocked", `Gave up after ${MAX_ORPHAN_ATTEMPTS} orphaned attempts.`);
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
      if (!deps.dryRun) {
        await deps.provider.transition(issue, "done");
        cleanupWorktree(deps, marker);
      }
    } else if (status.state === "closed") {
      deps.log(`watch: ${issue.id}'s PR #${marker.pr} closed without merging — blocked`);
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
    deps.git.fetch("origin", deps.baseBranch);
    deps.git.worktreeAdd(worktreePath, branch, `origin/${deps.baseBranch}`);
    await deps.provider.writeMarker(issue, { worktree: worktreePath, branch, attempt: 0 });

    const prompt = `${issue.title}\n\n${issue.body}`.trim();
    const result = await deps.runChain({ prompt, cwd: worktreePath, adwId });

    if (!result.accepted) {
      deps.log(`watch: ${issue.id}: chain "${deps.chain}" did not succeed — blocked`);
      await deps.provider.transition(
        issue,
        "blocked",
        result.detail || `Chain "${deps.chain}" (adw_id ${adwId}) did not complete successfully. Run \`spf phases ${adwId}\` for detail.`,
      );
      cleanupWorktree(deps, { worktree: worktreePath, branch });
      return;
    }

    const wtGit = deps.worktreeGit(worktreePath);
    if (wtGit.diffFiles(`origin/${deps.baseBranch}`).length === 0) {
      deps.log(`watch: ${issue.id}: chain succeeded but committed nothing — blocked`);
      await deps.provider.transition(issue, "blocked", `Chain "${deps.chain}" (adw_id ${adwId}) completed but left no committed changes.`);
      cleanupWorktree(deps, { worktree: worktreePath, branch });
      return;
    }

    wtGit.push("origin", branch);
    // No cross-linking magic keyword here on purpose (a code host paired
    // with a different tracker has no "Closes #n" convention to hook into
    // — see provider.ts) — the issue id in the title/body is plain text
    // for humans, and, on a Jira+Bitbucket pairing, exactly what Jira's own
    // Bitbucket integration scans for to link the PR automatically.
    const pr = await deps.codeHost.openPr({
      branch,
      title: `${issue.title} (${issue.id})`,
      body: `Automated by \`spf watch\` — chain \`${deps.chain}\`, adw_id \`${adwId}\`, issue ${issue.id}.`,
      base: deps.baseBranch,
    });
    await deps.provider.writeMarker(issue, { worktree: worktreePath, branch, pr: pr.number, attempt: 0 });
    await deps.provider.transition(issue, "review");
    deps.log(`watch: ${issue.id}: opened PR #${pr.number} — review`);
  } catch (error) {
    const message = (error as Error).message;
    deps.log(`watch: ${issue.id}: error: ${message}`);
    await deps.provider.transition(issue, "blocked", `spf watch error: ${message}`).catch(() => undefined);
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
    state.inflight.add(issue.id);
    runIssue(deps, issue).finally(() => state.inflight.delete(issue.id));
  }
}

/** One poll tick: reconcile, finish, claim — each independently caught, so one phase's error never blocks the rest. */
export async function tick(deps: WatchDeps, state: WatchRunState): Promise<void> {
  await reconcileOrphans(deps, state).catch((error) => deps.log(`watch: reconcileOrphans error: ${(error as Error).message}`));
  await finishReviews(deps).catch((error) => deps.log(`watch: finishReviews error: ${(error as Error).message}`));
  await claimNewWork(deps, state).catch((error) => deps.log(`watch: claimNewWork error: ${(error as Error).message}`));
}
