/**
 * `spf loop` — run a whole chain repeatedly, toward one goal, until a
 * TESTABLE STOP passes or a breaker trips. A different verb from `spf run`:
 * an inner `fixLoop`/`reviseLoop` (`chains/steps.ts`) retries WITHIN one
 * chain run at one known check; this retries WHOLE CHAIN RUNS at a goal the
 * chain itself has no opinion about (an a11y score, an external rating, a
 * suite passing on iteration N instead of iteration 1).
 *
 * SCRIPT STOPS ONLY, V1. A stop condition NAMES a `quality.suites` suite —
 * it is resolved and run through `quality.runSuite`'s exact machinery
 * (argv, no shell, per-check timeout, tail-captured evidence), never a raw
 * command string. `gates.testsPass` was considered and rejected: it is a
 * synchronous, unbounded `spawnSync` deliberately kept off `GATE_ALLOWLIST`
 * (see `chains/steps.ts`'s GATE_ALLOWLIST comment) for exactly the reason
 * it would be wrong here too — a hung check with no timeout, and (for any
 * future tracker-sourced stop) a shell string is a command-injection
 * surface. Naming a suite is data, not code, the same discipline that
 * makes `.spf/chains/*.yaml` safe.
 *
 * FRESH adw_id EVERY ITERATION, NEVER NULL. `runChain`'s `finally` block
 * (`otel.releaseOtelExporter`, `session.finalize`) is a documented no-op
 * when `adw_id` is null, because a one-shot CLI process exits right after —
 * an assumption this long-lived driver would violate by leaking a Tracer
 * sqlite handle and growing `session.ts`'s `ACTIVE` map every iteration.
 * Naming follows `core/fanout.ts`'s own scheme (`attemptAdwId`,
 * `${base}-${i}`) so `spf estimate`'s existing fanout-sibling collapse
 * (`cli/commands/estimate.ts`'s `fanoutBaseOf`) recognizes loop iterations
 * as siblings for free — which is also why the base id must look like
 * `newId(8)`'s actual output (8 lowercase hex), never a human label
 * directly; see `resolveGoalId` below.
 *
 * EVERY ITERATION IS TRY/CAUGHT. `runSteps` (`chains/steps.ts`) has no
 * try/catch of its own — a budget overrun (`agents.assertRunBudget`), a
 * converged no-op iteration (`changes()` throwing "nothing changed"), a
 * gate failure, or a permission breach all throw UNCAUGHT out of
 * `runChain`. Those are exactly the outcomes a multi-attempt loop hits
 * routinely, so the driver must not die on the first one — it records a
 * distinct `"errored"` outcome and keeps going, same as `fixLoop` treats
 * "still not accepted" as ordinary state rather than a thrown error.
 *
 * THE LEDGER IS GOAL-SCOPED, NEVER SESSION-SCOPED. `Run.context_handoff_dir`
 * (`core/runner.ts`) is `<data_dir>/sessions/<adw_id>/context_handoff` — with
 * a fresh adw_id every iteration, that directory is a brand-new empty
 * folder every single pass. The ledger this module owns lives at
 * `<data_dir>/loop/<goal_id>/ledger.json` instead: outside every session
 * dir, so it is the one thing that actually persists across iterations
 * (breakers 2 and 3 below have nothing to read back otherwise) AND across
 * process restarts — which is what makes `cron + spf loop --max 1` a real
 * scheduled loop with working breakers, not just a bare retry.
 *
 * FOUR BREAKERS, NONE OF THEM THE STOP CHECK ITSELF. The tested goal is
 * exactly the signal a loop can spin forever chasing marginal gains against,
 * so every breaker below is driver-owned, external to the check:
 *   1. --max (required, no default) — an outer iteration is a whole chain
 *      run; a silent default is a cost surprise `fixLoop`'s own `max?:
 *      number` (defaulted to 3) doesn't have to worry about because ITS
 *      cost is one suite run, not one chain.
 *   2. --max-cost / --max-tokens — a cumulative ceiling across every
 *      iteration, read back from the ledger and checked BEFORE dispatching
 *      the next one. Same honest caveat `core/fanout.ts`'s own budget note
 *      states for its N-multiplier: checked between iterations, never
 *      inside one, so a single expensive iteration can still overshoot by
 *      up to its own spend — say so in `--help`, don't imply a hard cap.
 *   3. --stuck-after N (default 3) — N consecutive iterations with an
 *      unchanged commit sha. A score-based stuck check was considered and
 *      rejected for v1: nothing here judges a numeric score (that is the
 *      deferred prompt-stop path), and a diff/commit-sha check is always
 *      available regardless of what the suite measures.
 *   4. --min-interval-ms — mandatory whenever a suite's checks hit an
 *      external service with no documented quota (isitagentready.com
 *      throttled after roughly one rapid request in testing). Applied
 *      between iterations, not inside `quality.runSuite`'s own per-check
 *      timeout, which is a different ceiling (one check hanging) from this
 *      one (calling the external service too often).
 *
 * BEST-ATTEMPT RETENTION. Each iteration commits onto whatever branch the
 * operator is on (`chains/steps.ts`'s `commit()` — this module never
 * touches branches or worktrees, unlike `core/fanout.ts`'s isolated-attempt
 * model). Without recording a commit sha per attempt, an exhausted or
 * stuck loop leaves whichever tree the LAST iteration happened to produce
 * checked out — possibly worse than an earlier one. The ledger's
 * `best_attempt` field and the printed "best: attempt N (sha ...)" line are
 * what let the operator recover deliberately instead of by accident.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { formatUsd } from "./agents.ts";
import { attemptAdwId } from "./fanout.ts";
import { newId } from "./utils.ts";

// ── stop condition ───────────────────────────────────────────────────────

/** Script-only in v1 — see this module's doc comment for why a prompt/judge stop is deferred. */
export interface StopCondition {
  kind: "script";
  /** A `quality.suites` name, resolved through `quality.resolveSuite`/`runSuite` — never a raw shell string. */
  suite: string;
}

export interface StopVerdict {
  passed: boolean;
  /** Verbatim from `QualityResult.failures` — enough for the next iteration's prompt without opening an artifact. */
  failures: string[];
  artifacts: string[];
}

// ── outcomes and the ledger ──────────────────────────────────────────────

export type AttemptOutcome = "passed" | "not-accepted" | "errored";
export type TerminalReason = "passed" | "exhausted" | "stuck";

export interface LedgerAttempt {
  index: number;
  adw_id: string;
  outcome: AttemptOutcome;
  /** `null` for an "errored" attempt whose exit code never got a chance to matter. */
  exit_code: number | null;
  /** The thrown error's message, only set when outcome === "errored". */
  error: string | null;
  /** HEAD's short sha after a successful (exit 0) iteration — unchanged from the previous attempt's if this iteration committed nothing new, which is exactly what `isStuck` below looks for. `null` only for an errored or non-accepted (nonzero exit) attempt, where nothing was checked out to read. */
  commit_sha: string | null;
  tokens: number;
  cost: number;
  failures: string[];
  started_at: string;
  ended_at: string;
}

export interface Ledger {
  goal_id: string;
  /** Minted ONCE, on the ledger's first write, and reused on every resume — never regenerated per process — so a killed-and-resumed or cron-repeated loop keeps deriving iteration adw_ids from the same base and `estimate.ts`'s sibling collapse still sees one family instead of a new one per process invocation. */
  base_adw_id: string;
  chain: string;
  goal: string;
  stop: StopCondition;
  max: number;
  attempts: LedgerAttempt[];
  /** Set once the loop reaches a terminal state — absent while still in progress (a crash mid-loop leaves it absent, which is the honest state). */
  reason?: TerminalReason;
  /** The index of the best attempt seen so far — see `pickBestAttempt` below. `null` until at least one attempt commits something. */
  best_attempt_index: number | null;
}

/** `<data_dir>/loop/<goal_id>/` — goal-scoped, outside every session dir. See this module's doc comment for why. */
export function ledgerDir(dataDir: string, goalId: string): string {
  return path.join(dataDir, "loop", goalId);
}

function ledgerPath(dataDir: string, goalId: string): string {
  return path.join(ledgerDir(dataDir, goalId), "ledger.json");
}

export function loadLedger(dataDir: string, goalId: string): Ledger | null {
  const p = ledgerPath(dataDir, goalId);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Ledger;
}

function saveLedger(dataDir: string, ledger: Ledger): void {
  const dir = ledgerDir(dataDir, ledger.goal_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(ledgerPath(dataDir, ledger.goal_id), JSON.stringify(ledger, null, 2));
}

/**
 * `baseAdwId` is ALWAYS a fresh `newId(8)` — 8 lowercase hex, matching what
 * `estimate.ts`'s `fanoutBaseOf` regex (`/^([0-9a-f]{8})-\d+$/`) expects, so
 * this loop's iterations collapse as fanout-shaped siblings in `spf
 * estimate`'s sample exactly the way `spf fanout`'s do. `goalId` is the
 * human-facing label (`--goal-id`, or the same fresh id if none was given)
 * used for the ledger's own directory name and printed to the operator —
 * deliberately NOT required to look like `newId(8)`'s output, since
 * `issue-41` or `a11y-loop` are exactly what a human wants to type and read
 * back, and nothing downstream derives an adw_id from `goalId` itself.
 */
export function newLedger(input: { goalId: string; chain: string; goal: string; stop: StopCondition; max: number }): Ledger {
  return {
    goal_id: input.goalId,
    base_adw_id: newId(8),
    chain: input.chain,
    goal: input.goal,
    stop: input.stop,
    max: input.max,
    attempts: [],
    best_attempt_index: null,
  };
}

/** `--goal-id`, or a freshly minted one — human-facing only, see `newLedger`'s doc comment for why it need not be shaped like `newId(8)`'s output. */
export function resolveGoalId(explicit: string | undefined): string {
  return explicit ?? newId(8);
}

// ── budget accounting ─────────────────────────────────────────────────────

export interface CumulativeBudget {
  maxCost?: number;
  maxTokens?: number;
}

export function cumulativeSpend(attempts: LedgerAttempt[]): { cost: number; tokens: number } {
  return attempts.reduce((acc, a) => ({ cost: acc.cost + a.cost, tokens: acc.tokens + a.tokens }), { cost: 0, tokens: 0 });
}

/** Whether the goal-scoped ceiling is already exhausted going into the NEXT iteration — a stronger, ledger-wide check than any single iteration's own budget. */
export function overCumulativeBudget(budget: CumulativeBudget, spend: { cost: number; tokens: number }): boolean {
  if (budget.maxCost !== undefined && spend.cost >= budget.maxCost) return true;
  if (budget.maxTokens !== undefined && spend.tokens >= budget.maxTokens) return true;
  return false;
}

// ── stuck detection ────────────────────────────────────────────────────────

/**
 * N consecutive attempts with the SAME commit sha (including all-null, an
 * unbroken run of no-op iterations) — a diff-based check, not a score-based
 * one, because nothing in v1 judges a numeric score and a commit sha is
 * always available regardless of what the suite measures. `stuckAfter`
 * attempts of history are enough to trip; fewer never can.
 */
export function isStuck(attempts: LedgerAttempt[], stuckAfter: number): boolean {
  if (attempts.length < stuckAfter) return false;
  const tail = attempts.slice(-stuckAfter);
  const first = tail[0]!.commit_sha;
  return tail.every((a) => a.commit_sha === first);
}

/** The best attempt so far: the latest one that both committed something and passed the most recent stop check it ran — falling back to "committed something" when none has passed yet. Pure, so it is testable with no ledger I/O. */
export function pickBestAttempt(attempts: LedgerAttempt[]): number | null {
  let best: number | null = null;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i]!;
    if (a.commit_sha === null) continue;
    if (best === null) { best = i; continue; }
    const current = attempts[best]!;
    // A later commit that passed beats an earlier one that didn't; among
    // two passing (or two non-passing) commits, the later one wins — it is
    // the more-refined attempt, all else equal.
    const currentPassed = current.outcome === "passed";
    const aPassed = a.outcome === "passed";
    if (aPassed && !currentPassed) best = i;
    else if (aPassed === currentPassed) best = i;
  }
  return best;
}

// ── the driver ─────────────────────────────────────────────────────────────

export interface RunIteration {
  index: number;
  adw_id: string;
  /** The prompt for this iteration — the goal, plus (from iteration 2 on) a correction block built from the previous verdict, in the SAME shape `gates.ts`'s violation-correction text already uses (see `agents.ts:587-591` and `gates.ts`'s own doc comment) — the format builders already respond well to, one level up. */
  prompt: string;
}

export interface IterationResult {
  /** `null` when the iteration threw before `runChain` returned anything. */
  exit_code: number | null;
  /** Set only when the iteration threw. */
  error: string | null;
  /** `null` when nothing was committed this iteration (a no-op, or a throw before any commit). */
  commit_sha: string | null;
  tokens: number;
  cost: number;
  /** `null` when the iteration errored or exited non-zero — the stop check only ever runs against a chain that accepted its own work, same as `fixLoop` only re-verifies after a phase that didn't already throw. */
  stop_verdict: StopVerdict | null;
}

export interface LoopDeps {
  chainName: string;
  goal: string;
  stop: StopCondition;
  max: number;
  budget: CumulativeBudget;
  stuckAfter: number;
  minIntervalMs: number;
  dataDir: string;
  goalId: string;
  /**
   * Run one iteration end-to-end: build ctx, call `runChain`, and — only if
   * it exited 0 — evaluate `deps.stop` (through `quality.runSuite`) against
   * the same `Run`, then read back tokens/cost by `adw_id` and the HEAD
   * commit sha if one changed. Never throws by contract: a thrown
   * `runChain` call must be caught by the implementation and folded into
   * `IterationResult.error`, the same way `fanout.ts`'s `runAttempt` catches
   * around its own `runChainDef` call.
   */
  runIteration: (iteration: RunIteration) => Promise<IterationResult>;
  log: (message: string) => void;
  /** Real `Promise`-based sleep, injected so a test can fake it — `--min-interval-ms` between iterations. */
  sleep: (ms: number) => Promise<void>;
}

export interface LoopResult {
  ledger: Ledger;
  /** 0 (passed), 1 (exhausted/stuck) — printed exit code semantics live in the CLI layer, this is just pass/fail. */
  exitCode: number;
}

function buildPrompt(goal: string, previous: StopVerdict | null): string {
  if (!previous || previous.passed) return goal;
  const lines = [
    goal,
    "",
    "Your previous attempt did not meet the goal. The stop check reported:",
    ...previous.failures.map((f) => `- ${f}`),
    "",
    "Fix these problems, then commit your changes.",
  ];
  return lines.join("\n");
}

/**
 * Run iterations until the stop passes, `max` is exhausted, or the loop is
 * stuck. Never throws — every iteration is caught by `deps.runIteration`'s
 * own contract, and the ledger is written after every iteration so a killed
 * process leaves a readable partial history.
 */
export async function runLoop(deps: LoopDeps): Promise<LoopResult> {
  const existing = loadLedger(deps.dataDir, deps.goalId);
  const ledger =
    existing ?? newLedger({ goalId: deps.goalId, chain: deps.chainName, goal: deps.goal, stop: deps.stop, max: deps.max });
  if (existing) {
    deps.log(`loop: resuming goal ${deps.goalId} — ${existing.attempts.length} attempt(s) already recorded`);
  }

  let lastVerdict: StopVerdict | null =
    ledger.attempts.length > 0 ? { passed: false, failures: ledger.attempts[ledger.attempts.length - 1]!.failures, artifacts: [] } : null;

  for (let i = ledger.attempts.length + 1; i <= deps.max; i++) {
    if (overCumulativeBudget(deps.budget, cumulativeSpend(ledger.attempts))) {
      deps.log(`loop: goal ${deps.goalId} — cumulative budget exhausted before iteration ${i}`);
      break;
    }

    const adwId = attemptAdwId(ledger.base_adw_id, i);
    const startedAt = new Date().toISOString();
    deps.log(`loop: goal ${deps.goalId} — iteration ${i}/${deps.max} (${adwId})`);

    const result = await deps.runIteration({
      index: i,
      adw_id: adwId,
      prompt: buildPrompt(deps.goal, lastVerdict),
    });

    let outcome: AttemptOutcome;
    let failures: string[] = [];
    if (result.error) {
      outcome = "errored";
      deps.log(`loop: iteration ${i} (${adwId}) errored: ${result.error}`);
    } else if (result.exit_code !== 0) {
      outcome = "not-accepted";
      failures = [`chain did not accept its own work (exit ${result.exit_code})`];
    } else {
      const verdict = result.stop_verdict ?? { passed: false, failures: ["stop check produced no verdict"], artifacts: [] };
      lastVerdict = verdict;
      outcome = verdict.passed ? "passed" : "not-accepted";
      failures = verdict.failures;
    }

    const attempt: LedgerAttempt = {
      index: i,
      adw_id: adwId,
      outcome,
      exit_code: result.exit_code,
      error: result.error,
      commit_sha: result.commit_sha,
      tokens: result.tokens,
      cost: result.cost,
      failures,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
    };
    ledger.attempts.push(attempt);
    ledger.best_attempt_index = pickBestAttempt(ledger.attempts);
    saveLedger(deps.dataDir, ledger);

    if (outcome === "passed") {
      ledger.reason = "passed";
      saveLedger(deps.dataDir, ledger);
      return { ledger, exitCode: 0 };
    }

    if (isStuck(ledger.attempts, deps.stuckAfter)) {
      deps.log(`loop: goal ${deps.goalId} — no progress in ${deps.stuckAfter} consecutive attempt(s), stopping`);
      ledger.reason = "stuck";
      saveLedger(deps.dataDir, ledger);
      return { ledger, exitCode: 1 };
    }

    if (i < deps.max && deps.minIntervalMs > 0) await deps.sleep(deps.minIntervalMs);
  }

  ledger.reason = ledger.reason ?? "exhausted";
  saveLedger(deps.dataDir, ledger);
  return { ledger, exitCode: 1 };
}

/** A human-readable summary line for the CLI's final print — shared so a test can pin its exact wording. */
export function summarize(result: LoopResult): string {
  const { ledger } = result;
  const last = ledger.attempts[ledger.attempts.length - 1];
  const spend = cumulativeSpend(ledger.attempts);
  const lines = [
    `loop ${ledger.goal_id}: ${ledger.reason} after ${ledger.attempts.length}/${ledger.max} attempt(s) — ${formatUsd(spend.cost)}, ${spend.tokens.toLocaleString("en-US")} tokens`,
  ];
  if (ledger.best_attempt_index !== null) {
    const best = ledger.attempts[ledger.best_attempt_index]!;
    lines.push(`best: attempt ${best.index} (${best.adw_id}${best.commit_sha ? `, sha ${best.commit_sha}` : ""})`);
  }
  if (last && last.outcome !== "passed" && last.failures.length > 0) {
    lines.push("last failure(s):", ...last.failures.map((f) => `  ${f}`));
  }
  return lines.join("\n");
}
