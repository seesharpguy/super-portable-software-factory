/**
 * Best-of-N: run ONE prompt N times in parallel, then let CODE pick the winner.
 *
 * THE SHAPE IS NOT NEW, and that is the whole argument for it. `spf watch`
 * already runs N chains CONCURRENTLY IN ONE PROCESS — each with its own git
 * worktree, its own adw_id, its own `Run`, all sharing the main repo's WAL
 * SQLite through a data-dir symlink (see `core/watch.ts`'s `runIssue`,
 * `cli/commands/watch.ts`'s `runChain` closure and its `linkDataDir`). Fan-out
 * is that proven mechanism pointed at one prompt instead of N issues: N
 * sibling Runs with derived adw_ids over N worktrees, followed by a
 * DETERMINISTIC `pickBest`. "Agent proposes, code disposes" — extended to
 * SELECTION, which is the only new idea here.
 *
 * THE UNIT OF ISOLATION IS THE RUN, NEVER AN AGENT CALL. Every attempt gets a
 * fresh worktree and a fresh Run whose `repo_root` is bound once, in the Run
 * constructor. That is what keeps `gates.resolveClaim`,
 * `permissions.snapshot/enforce`, the quality checks and `changes.capture`
 * judging the tree their agents actually wrote in. A per-call cwd swap would
 * point them at the wrong tree and hand out green gates on unverified work; a
 * `SandboxHandle`/cwd-threading design was evaluated for exactly this and
 * REJECTED. Do not reintroduce it.
 *
 * SELECTION READS SQLITE, NOT RETURN VALUES. Gate reports (`tracer.gateRow`)
 * and per-run usage (`sessions.total_tokens`/`total_cost`) already land in the
 * shared db keyed by adw_id, so the basis below is a SELECT away. Widening
 * `steps.runSteps`' return contract to carry metrics back was evaluated and
 * REJECTED as needless blast radius: every chain, every step, and the watch
 * dispatch would change to serve one new caller. `runAttempt` still returns
 * just an exit code, exactly like `runChainDef` does.
 *
 * WHY THE BUDGET SHIPS WITH THIS. An n-multiplier on spend without a ceiling
 * is a footgun — the only budget-like constant before this changeset was
 * `JSON_FIX_ATTEMPTS = 2`. `defaults.max_run_cost`/`max_run_tokens`
 * (`core/agents.ts`'s `assertRunBudget`) are checked before each attempt's
 * NEXT agent call, never after — so one attempt can still overshoot the
 * ceiling by a whole call, and a chain with only ONE agent dispatch
 * (`scout`, `prompt`, `build`) can never trip it at all. With that caveat, N
 * attempts are bounded by roughly N × ceiling, and each one that DOES trip
 * it fails its phase closed with a message naming the ceiling and the spend.
 *
 * WINNER HANDLING KEEPS THE HUMAN ACCOUNTABLE. Each attempt commits on its own
 * branch in its own worktree. The winner's branch AND worktree are KEPT and
 * reported (branch + adw_id + the selection basis); the losers' worktrees and
 * branches are deleted. SPF DOES NOT MERGE THE WINNER — the operator does.
 * Keeping the winner's worktree is deliberate, not laziness: a chain that
 * doesn't commit (or that failed after writing) leaves work in the tree only,
 * and `git worktree remove --force` would destroy it. `git merge`/
 * `git cherry-pick` from the main repo work fine against a branch that is
 * checked out elsewhere, so nothing is blocked by keeping it.
 *
 * ABORT GRANULARITY, stated plainly because it is a real limit — and, as of
 * `deps.firstSuccess`, OPT-IN rather than the default. Best-of-N exists to
 * COMPARE N candidates; the DEFAULT (`firstSuccess` unset/false) therefore
 * dispatches every attempt regardless of how early one succeeds, so the
 * gates/cost/tokens comparison in `pickBest` is over the whole field the
 * operator actually asked for, not "whatever happened to still be queued."
 * Passing `firstSuccess: true` restores first-past-the-post: once an attempt
 * exits 0 the race is decided and no further attempt is STARTED —
 * `deps.runAttempt` is never called for a queued attempt, which is where the
 * saving actually is (with `concurrency` 2 and `--n 4`, half the attempts are
 * typically never dispatched). Either way, attempts ALREADY IN FLIGHT run to
 * completion: `steps.runSteps` has no cancellation seam, and adding one would
 * mean changing the driver every chain shares for the benefit of this one
 * caller. `AttemptDispatch.isAborted()` is threaded to the runner so a
 * dispatch that CAN check between phases does when `firstSuccess` is on, and
 * so a test can prove the flag is honored — cooperative by design, not by
 * accident.
 */

import path from "node:path";
import { removeRunWorktree, withRunWorktree, type GitHandle } from "./git_helper.ts";

/** Sentinel exit code meaning "never dispatched — the race was already decided". Distinct from any real chain exit code. */
export const ABORTED_EXIT = -1;

/** What one attempt's metrics look like, read back from the shared SQLite by adw_id. */
export interface AttemptMetrics {
  /** `gate_results` rows with passed=1 for this adw_id. */
  gate_passes: number;
  /** `gate_results` rows with passed=0. Zero is the bar; a nonzero count is a retried/corrected run. */
  gate_failures: number;
  /** `sessions.total_cost` — USD. */
  cost: number;
  /** `sessions.total_tokens` — the SPEND number (cached re-reads included). */
  tokens: number;
}

export const ZERO_METRICS: AttemptMetrics = { gate_passes: 0, gate_failures: 0, cost: 0, tokens: 0 };

/**
 * `"success"` means, and only means, EXIT CODE 0 — the same bar
 * `cli/commands/watch.ts` applies before it opens a PR. Not the session row's
 * status (which a killed run can leave stale), not the agent's own opinion of
 * itself. Only a `"success"` attempt is eligible to win.
 */
export type AttemptStatus = "success" | "fail" | "error" | "skipped";

export interface FanoutAttempt {
  /** 1-based, matching the branch/adw_id suffix a human reads. */
  index: number;
  adw_id: string;
  branch: string;
  worktree: string;
  status: AttemptStatus;
  /** `null` when the dispatch threw before producing one; `ABORTED_EXIT` for a skipped attempt. */
  exit_code: number | null;
  error: string | null;
  gate_passes: number;
  gate_failures: number;
  cost: number;
  tokens: number;
  wall_ms: number;
  /** True only for the winner: its worktree and branch survived cleanup. */
  kept: boolean;
}

export interface FanoutResult {
  /** `null` when no attempt exited 0 — nothing is kept, and the CLI exits non-zero. */
  winner: FanoutAttempt | null;
  /** The printed, human-readable justification. Derived from the same comparator that chose the winner. */
  basis: string;
  /** Every attempt, in index order — including the ones never dispatched. */
  attempts: FanoutAttempt[];
}

// ── naming (deterministic, so a killed run leaves cleanable debris) ──────────

/** `<baseAdw>-<i>` — a derived, greppable sibling of the base id. */
export function attemptAdwId(baseAdwId: string, index: number): string {
  return `${baseAdwId}-${index}`;
}

/**
 * `spf/fanout/<baseAdw>-<i>` — namespaced so the winner is obvious in
 * `git branch` and the losers are obviously disposable. Separate from
 * `spf-watch/*`/`spf-refine/*` (see `core/watch.ts`) because these branches
 * are never pushed by SPF: a human merges the winner from the local ref.
 */
export function attemptBranch(baseAdwId: string, index: number): string {
  return `spf/fanout/${attemptAdwId(baseAdwId, index)}`;
}

/** The worktree leaf name. Deterministic from the adw_id, like watch's `issue-<id>`. */
export function attemptWorktreeName(baseAdwId: string, index: number): string {
  return `fanout-${attemptAdwId(baseAdwId, index)}`;
}

export function attemptWorktreePath(worktreesDir: string, baseAdwId: string, index: number): string {
  return path.join(worktreesDir, attemptWorktreeName(baseAdwId, index));
}

// ── selection: the deterministic disposer ───────────────────────────────────

/**
 * The selection basis, in order. Every criterion is read from the shared
 * SQLite or measured by this module — never asked of an agent.
 *
 *  1. the run SUCCEEDED (exit 0). A failed attempt is not a candidate at all.
 *  2. fewest gate FAILURES, then most gate PASSES. Failures first because zero
 *     is the bar: an attempt that needed a correction round is worse than one
 *     that never tripped a gate, regardless of how many gates each ran. Passes
 *     break that tie in favour of the attempt that VERIFIED more.
 *  3. lowest total cost.
 *  4. fewest tokens.
 *  5. lowest wall time — a LAST RESORT, deliberately below cost and tokens:
 *     every code phase runs through `spawnSync` (`core/quality.ts`), which
 *     blocks the shared event loop, so "concurrent" attempts partly serialize
 *     on exactly the phases fan-out means to compare, and `wall_ms` ends up
 *     favouring whichever attempt happened to run last by a scheduling
 *     accident rather than anything about the candidate. Cost and tokens are
 *     read from the trace and are not subject to that; wall time still
 *     breaks a genuine tie between two runs identical on both.
 *  6. lexicographic adw_id.
 *
 * (6) exists to make this a TOTAL order: adw_ids are unique per attempt, so
 * the comparator can never return 0 for two different attempts, so the winner
 * cannot depend on which attempt happened to finish first. That is what
 * "deterministic" has to mean here — pinned by a permutation test in
 * `src/test/fanout.test.ts`.
 */
export function compareAttempts(a: FanoutAttempt, b: FanoutAttempt): number {
  const rank = (attempt: FanoutAttempt) => (attempt.status === "success" ? 0 : 1);
  return (
    rank(a) - rank(b) ||
    a.gate_failures - b.gate_failures ||
    b.gate_passes - a.gate_passes ||
    a.cost - b.cost ||
    a.tokens - b.tokens ||
    a.wall_ms - b.wall_ms ||
    (a.adw_id < b.adw_id ? -1 : a.adw_id > b.adw_id ? 1 : 0)
  );
}

/** Which criterion actually separated the winner from its closest rival — the honest half of a printed basis. */
function decidingCriterion(winner: FanoutAttempt, runnerUp: FanoutAttempt): string {
  if (winner.gate_failures !== runnerUp.gate_failures) {
    return `fewer gate failures (${winner.gate_failures} vs ${runnerUp.gate_failures})`;
  }
  if (winner.gate_passes !== runnerUp.gate_passes) {
    return `more gate passes (${winner.gate_passes} vs ${runnerUp.gate_passes})`;
  }
  if (winner.cost !== runnerUp.cost) {
    return `lower cost ($${winner.cost.toFixed(4)} vs $${runnerUp.cost.toFixed(4)})`;
  }
  if (winner.tokens !== runnerUp.tokens) {
    return `fewer tokens (${winner.tokens.toLocaleString("en-US")} vs ${runnerUp.tokens.toLocaleString("en-US")})`;
  }
  if (winner.wall_ms !== runnerUp.wall_ms) {
    // Named as contended, not a clean property of the candidate — see the
    // criteria list above.
    return `lower wall time (${(winner.wall_ms / 1000).toFixed(1)}s vs ${(runnerUp.wall_ms / 1000).toFixed(1)}s — contended under concurrency, a last resort)`;
  }
  return `lexicographic adw_id tiebreak (${winner.adw_id} before ${runnerUp.adw_id})`;
}

/**
 * Pick the winner. PURE: no I/O, no clock, no filesystem — everything it
 * needs is already on the attempts, which is what makes the selection
 * testable and reproducible from a trace.
 *
 * Sorts a COPY: the caller's array keeps its index order for printing.
 */
export function pickBest(attempts: FanoutAttempt[]): { winner: FanoutAttempt | null; basis: string } {
  const succeeded = attempts.filter((a) => a.status === "success");
  if (succeeded.length === 0) {
    return { winner: null, basis: `no attempt succeeded (${attempts.length} tried) — nothing to select` };
  }
  const ranked = [...succeeded].sort(compareAttempts);
  const winner = ranked[0]!;
  const summary =
    `${winner.gate_failures} gate failure(s), ${winner.gate_passes} gate pass(es), ` +
    `$${winner.cost.toFixed(4)}, ${(winner.wall_ms / 1000).toFixed(1)}s`;
  if (ranked.length === 1) {
    return {
      winner,
      basis: `the only attempt that succeeded of ${attempts.length} — ${summary}`,
    };
  }
  return {
    winner,
    basis: `${decidingCriterion(winner, ranked[1]!)} over ${ranked[1]!.adw_id}; ${succeeded.length} of ${attempts.length} attempt(s) succeeded — ${summary}`,
  };
}

// ── execution ───────────────────────────────────────────────────────────────

/** What `deps.runAttempt` is handed for one attempt. */
export interface AttemptDispatch {
  index: number;
  adwId: string;
  /** The attempt's OWN worktree — the anchor its Run binds `repo_root` to. Never the main repo. */
  cwd: string;
  branch: string;
  prompt: string;
  /** Cooperative early-abort — see the module header's ABORT GRANULARITY note. */
  isAborted: () => boolean;
}

/**
 * Everything `runBestOf` needs, injected — the same seam `WatchDeps` is, and
 * for the same reason: `core/` stays out of `src/chains/`'s dependency
 * direction, so the chain dispatch (and the SQLite read) live in
 * `cli/commands/fanout.ts` and this module is testable against stubs with no
 * agents, no chains and no real git.
 */
export interface FanoutDeps {
  chainName: string;
  prompt: string;
  /** How many attempts. Bounded by the CLI, not here. */
  n: number;
  /** How many run at once. `cfg.watch.concurrency` (default 2) is the reused default. */
  concurrency: number;
  /** The parent id every attempt's adw_id and branch derives from. */
  baseAdwId: string;
  baseBranch: string;
  /** The MAIN repo root — every worktree is created from here, and every Run is anchored to its own worktree. */
  repoRoot: string;
  /** Absolute, OUTSIDE the repo. */
  worktreesDir: string;
  /** Bound to `repoRoot`. */
  git: GitHandle;
  /** Wire `<worktree>/.spf/data` to the main repo's data dir — the non-obvious part that keeps traces where `spf ui` can see them. */
  linkDataDir: (worktreePath: string) => void;
  /** Run one attempt's chain in `cwd`, returning its exit code. */
  runAttempt: (dispatch: AttemptDispatch) => Promise<number>;
  /** Read this adw_id's gate/usage rows from the SHARED db. Must not throw — return `ZERO_METRICS` on any hiccup. */
  readMetrics: (adwId: string) => AttemptMetrics;
  log: (message: string) => void;
  /**
   * Opt-in first-past-the-post. Default (unset/false): every attempt that
   * was going to run, runs — true best-of-N. `true`: stop dispatching
   * further attempts once one exits 0, and let an in-flight one observe the
   * decided race via `AttemptDispatch.isAborted()`. See the module header's
   * ABORT GRANULARITY note.
   */
  firstSuccess?: boolean;
  /**
   * Fires once per attempt the moment it settles (success, fail, error, or
   * skipped) — the same record that lands in the final `attempts` array, just
   * as it happens instead of only once every worker has finished. Purely
   * observational: nothing here changes selection or cleanup. `cli/commands/
   * fanout.ts` uses it to update a live results table row by row on a TTY;
   * omitted (the default) everywhere else, including every test.
   */
  onAttempt?: (attempt: FanoutAttempt) => void;
}

/**
 * Run `n` attempts of one prompt, select deterministically, clean up the
 * losers, keep the winner.
 *
 * Concurrency is the same inflight-budget idea as `watch.claimNewWork`,
 * expressed as a fixed worker pool over a shared queue: at most
 * `concurrency` attempts are ever in flight, and a worker that finds the race
 * already decided records the remaining attempts as `skipped` WITHOUT
 * dispatching them. Attempts are returned in index order regardless of the
 * order they finished — the printed table must not shuffle between runs.
 */
export async function runBestOf(deps: FanoutDeps): Promise<FanoutResult> {
  deps.log(
    `fanout: chain "${deps.chainName}" x${deps.n} off ${deps.baseBranch}, concurrency ${deps.concurrency}, ` +
      `adw_id ${attemptAdwId(deps.baseAdwId, 1)}..${attemptAdwId(deps.baseAdwId, deps.n)}` +
      (deps.firstSuccess ? ", first-success (stops dispatching once one attempt succeeds)" : ""),
  );
  const queue: number[] = Array.from({ length: deps.n }, (_, i) => i + 1);
  const attempts: FanoutAttempt[] = [];
  /** Flipped exactly once, by the first attempt to exit 0. Never flipped back. */
  let decided = false;

  const runOne = async (index: number): Promise<FanoutAttempt> => {
    const adwId = attemptAdwId(deps.baseAdwId, index);
    const branch = attemptBranch(deps.baseAdwId, index);
    const worktree = attemptWorktreePath(deps.worktreesDir, deps.baseAdwId, index);
    const started = performance.now();
    let exitCode: number | null = null;
    let error: string | null = null;

    try {
      exitCode = await withRunWorktree(
        deps.repoRoot,
        attemptWorktreeName(deps.baseAdwId, index),
        {
          worktreesDir: deps.worktreesDir,
          branch,
          baseBranch: deps.baseBranch,
          linkDataDir: deps.linkDataDir,
          git: deps.git,
          log: deps.log,
        },
        async (wt) => {
          const code = await deps.runAttempt({
            index,
            adwId,
            cwd: wt.path,
            branch,
            prompt: deps.prompt,
            isAborted: () => decided,
          });
          // Only a successful attempt can be selected, so only a successful
          // attempt's tree and branch are worth carrying past this scope.
          // A failed one is cleaned up NOW rather than lingering while its
          // siblings finish — its trace survives in the shared SQLite
          // regardless, which is where a post-mortem looks anyway.
          if (code === 0) wt.keep();
          return code;
        },
      );
    } catch (caught) {
      error = (caught as Error).message;
      deps.log(`fanout: attempt ${index} (${adwId}) errored: ${error}`);
    }

    if (exitCode === 0 && deps.firstSuccess) decided = true;

    let metrics = ZERO_METRICS;
    try {
      metrics = deps.readMetrics(adwId);
    } catch (caught) {
      // Metrics are for RANKING, never for correctness — an attempt whose
      // rows can't be read ranks as a zero-gate, zero-cost run rather than
      // failing the whole fan-out.
      deps.log(`fanout: could not read metrics for ${adwId}: ${(caught as Error).message}`);
    }

    // `ABORTED_EXIT` is a runner saying "I declined to spend" — a sibling won
    // between this attempt leaving the queue and its first agent call. That is
    // a skip, not a failure: reporting it as `fail` would make a clean
    // early-abort look like N-1 broken runs in the result table.
    const status: AttemptStatus =
      exitCode === 0 ? "success" : exitCode === ABORTED_EXIT ? "skipped" : error !== null ? "error" : "fail";
    return {
      index,
      adw_id: adwId,
      branch,
      worktree,
      status,
      exit_code: exitCode,
      error,
      wall_ms: performance.now() - started,
      kept: false,
      ...metrics,
    };
  };

  const skipped = (index: number): FanoutAttempt => ({
    index,
    adw_id: attemptAdwId(deps.baseAdwId, index),
    branch: attemptBranch(deps.baseAdwId, index),
    worktree: attemptWorktreePath(deps.worktreesDir, deps.baseAdwId, index),
    status: "skipped",
    exit_code: ABORTED_EXIT,
    error: null,
    wall_ms: 0,
    kept: false,
    ...ZERO_METRICS,
  });

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;
      if (decided) {
        deps.log(`fanout: attempt ${index} skipped — an earlier attempt already succeeded`);
        const attempt = skipped(index);
        attempts.push(attempt);
        deps.onAttempt?.(attempt);
        continue;
      }
      const attempt = await runOne(index);
      attempts.push(attempt);
      deps.onAttempt?.(attempt);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(deps.concurrency, deps.n)) }, () => worker());
  await Promise.all(workers);
  attempts.sort((a, b) => a.index - b.index);

  const { winner, basis } = pickBest(attempts);

  // Cleanup is the disposer's last act, and it runs AFTER selection because a
  // loser is only knowable once every attempt has been ranked. Failed and
  // skipped attempts own nothing by now (the scoped worktree helper already
  // removed a failed one; a skipped one never had a tree), so this only ever
  // touches attempts that SUCCEEDED and lost.
  for (const attempt of attempts) {
    if (attempt.status !== "success") continue;
    if (winner && attempt.adw_id === winner.adw_id) {
      attempt.kept = true;
      continue;
    }
    deps.log(`fanout: discarding attempt ${attempt.index} (${attempt.adw_id}) — branch ${attempt.branch}`);
    removeRunWorktree(deps.repoRoot, { path: attempt.worktree, branch: attempt.branch }, { git: deps.git, log: deps.log });
  }

  return { winner, basis, attempts };
}
