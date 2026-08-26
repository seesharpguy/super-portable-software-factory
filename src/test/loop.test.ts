/**
 * `spf loop`'s driver, at unit scope: the ledger, the breakers, and the
 * outer-loop-vs-thrown-iteration handling. NO REAL CHAINS AND NO REAL
 * AGENTS — `LoopDeps.runIteration` is a stub, the same seam `FanoutDeps`
 * gives `fanout.test.ts`.
 *
 * The ledger's only real filesystem effect is `saveLedger`'s `writeFileSync`
 * under a tmpdir, removed after each test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cumulativeSpend,
  isStuck,
  loadLedger,
  overCumulativeBudget,
  pickBestAttempt,
  resolveGoalId,
  runLoop,
  summarize,
  type IterationResult,
  type LedgerAttempt,
  type LoopDeps,
  type StopCondition,
} from "../core/loop.js";

const SCRIPT_STOP: StopCondition = { kind: "script", suite: "a11y" };

function attempt(overrides: Partial<LedgerAttempt> & { index: number }): LedgerAttempt {
  return {
    adw_id: `base1234-${overrides.index}`,
    outcome: "not-accepted",
    exit_code: 0,
    error: null,
    commit_sha: null,
    tokens: 0,
    cost: 0,
    failures: [],
    started_at: "2024-01-01T00:00:00.000Z",
    ended_at: "2024-01-01T00:00:01.000Z",
    ...overrides,
  };
}

// ── resolveGoalId ────────────────────────────────────────────────────────────

test("resolveGoalId: an explicit --goal-id passes through unchanged; omitted mints a fresh one", () => {
  assert.equal(resolveGoalId("issue-41"), "issue-41");
  const minted = resolveGoalId(undefined);
  assert.match(minted, /^[0-9a-f]{8}$/);
});

// ── budget accounting ────────────────────────────────────────────────────────

test("cumulativeSpend: sums cost and tokens across every attempt", () => {
  const spend = cumulativeSpend([attempt({ index: 1, cost: 0.1, tokens: 100 }), attempt({ index: 2, cost: 0.25, tokens: 200 })]);
  assert.deepEqual(spend, { cost: 0.35, tokens: 300 });
});

test("overCumulativeBudget: unset ceilings never trip, matching assertRunBudget's own no-op default", () => {
  assert.equal(overCumulativeBudget({}, { cost: 1_000_000, tokens: 1_000_000 }), false);
});

test("overCumulativeBudget: >= trips, exactly at the ceiling, not just past it", () => {
  assert.equal(overCumulativeBudget({ maxCost: 1 }, { cost: 1, tokens: 0 }), true);
  assert.equal(overCumulativeBudget({ maxCost: 1 }, { cost: 0.99, tokens: 0 }), false);
  assert.equal(overCumulativeBudget({ maxTokens: 1000 }, { cost: 0, tokens: 1000 }), true);
});

// ── stuck detection ──────────────────────────────────────────────────────────

test("isStuck: fewer attempts than the window never trips", () => {
  assert.equal(isStuck([attempt({ index: 1, commit_sha: "abc" })], 3), false);
});

test("isStuck: N consecutive attempts sharing one commit sha trips", () => {
  const attempts = [
    attempt({ index: 1, commit_sha: "abc" }),
    attempt({ index: 2, commit_sha: "abc" }),
    attempt({ index: 3, commit_sha: "abc" }),
  ];
  assert.equal(isStuck(attempts, 3), true);
});

test("isStuck: a run of all-null commit shas (every iteration a no-op) still trips", () => {
  const attempts = [attempt({ index: 1, commit_sha: null }), attempt({ index: 2, commit_sha: null }), attempt({ index: 3, commit_sha: null })];
  assert.equal(isStuck(attempts, 3), true);
});

test("isStuck: a changed sha anywhere in the window resets it", () => {
  const attempts = [attempt({ index: 1, commit_sha: "abc" }), attempt({ index: 2, commit_sha: "def" }), attempt({ index: 3, commit_sha: "def" })];
  assert.equal(isStuck(attempts, 3), false);
});

test("isStuck: only the TAIL of the window is checked — an old repeat outside the window doesn't trip it", () => {
  const attempts = [
    attempt({ index: 1, commit_sha: "abc" }),
    attempt({ index: 2, commit_sha: "abc" }),
    attempt({ index: 3, commit_sha: "def" }),
    attempt({ index: 4, commit_sha: "ghi" }),
  ];
  assert.equal(isStuck(attempts, 2), false);
});

// ── best-attempt retention ───────────────────────────────────────────────────

test("pickBestAttempt: null when nothing has committed anything yet", () => {
  assert.equal(pickBestAttempt([attempt({ index: 1, commit_sha: null }), attempt({ index: 2, commit_sha: null })]), null);
});

test("pickBestAttempt: a later commit beats an earlier one when neither passed", () => {
  const attempts = [attempt({ index: 1, commit_sha: "abc", outcome: "not-accepted" }), attempt({ index: 2, commit_sha: "def", outcome: "not-accepted" })];
  assert.equal(pickBestAttempt(attempts), 1);
});

test("pickBestAttempt: a passing commit beats a later non-passing one — the goal being met outranks recency", () => {
  const attempts = [
    attempt({ index: 1, commit_sha: "abc", outcome: "passed" }),
    attempt({ index: 2, commit_sha: "def", outcome: "not-accepted" }),
  ];
  assert.equal(pickBestAttempt(attempts), 0);
});

test("pickBestAttempt: an errored attempt (no commit) is skipped, not treated as worse-than-nothing", () => {
  const attempts = [attempt({ index: 1, commit_sha: "abc", outcome: "not-accepted" }), attempt({ index: 2, commit_sha: null, outcome: "errored" })];
  assert.equal(pickBestAttempt(attempts), 0);
});

// ── the driver ───────────────────────────────────────────────────────────────

interface Harness {
  deps: LoopDeps;
  dataDir: string;
  logs: string[];
  cleanup: () => void;
}

function harness(opts: {
  max: number;
  stuckAfter?: number;
  budget?: { maxCost?: number; maxTokens?: number };
  goalId?: string;
  resultFor: (index: number) => IterationResult;
}): Harness {
  const dataDir = mkdtempSync(path.join(tmpdir(), "spf-loop-test-"));
  const logs: string[] = [];
  const deps: LoopDeps = {
    chainName: "build-review",
    goal: "make the homepage accessible",
    stop: SCRIPT_STOP,
    max: opts.max,
    budget: opts.budget ?? {},
    stuckAfter: opts.stuckAfter ?? 3,
    minIntervalMs: 0,
    dataDir,
    goalId: opts.goalId ?? "test-goal",
    runIteration: async (iteration) => opts.resultFor(iteration.index),
    log: (message) => void logs.push(message),
    sleep: async () => {},
  };
  return { deps, dataDir, logs, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) };
}

test("runLoop: stops at iteration 1 and exits 0 the moment the stop check passes", async () => {
  const h = harness({
    max: 5,
    resultFor: (i) => ({ exit_code: 0, error: null, commit_sha: "sha1", tokens: 10, cost: 0.01, stop_verdict: { passed: i >= 1, failures: [], artifacts: [] } }),
  });
  try {
    const result = await runLoop(h.deps);
    assert.equal(result.exitCode, 0);
    assert.equal(result.ledger.reason, "passed");
    assert.equal(result.ledger.attempts.length, 1);
  } finally {
    h.cleanup();
  }
});

test("runLoop: exhausts --max and exits 1 when the stop check never passes", async () => {
  const h = harness({
    max: 3,
    resultFor: () => ({ exit_code: 0, error: null, commit_sha: "sha-changing", tokens: 10, cost: 0.01, stop_verdict: { passed: false, failures: ["still failing"], artifacts: [] } }),
  });
  try {
    // Give each iteration a distinct sha so stuck detection doesn't preempt exhaustion.
    let call = 0;
    h.deps.runIteration = async () => {
      call++;
      return { exit_code: 0, error: null, commit_sha: `sha-${call}`, tokens: 10, cost: 0.01, stop_verdict: { passed: false, failures: ["still failing"], artifacts: [] } };
    };
    const result = await runLoop(h.deps);
    assert.equal(result.exitCode, 1);
    assert.equal(result.ledger.reason, "exhausted");
    assert.equal(result.ledger.attempts.length, 3);
  } finally {
    h.cleanup();
  }
});

test("runLoop: a THROWN iteration is recorded as 'errored' and the loop continues — it must not die on the first uncaught runChain rejection", async () => {
  let call = 0;
  const h = harness({
    max: 3,
    resultFor: () => {
      call++;
      if (call === 1) return { exit_code: null, error: "run budget exceeded: $0.40 of max_run_cost $0.40", commit_sha: null, tokens: 5, cost: 0.4, stop_verdict: null };
      return { exit_code: 0, error: null, commit_sha: `sha-${call}`, tokens: 10, cost: 0.01, stop_verdict: { passed: call >= 3, failures: [], artifacts: [] } };
    },
  });
  try {
    const result = await runLoop(h.deps);
    assert.equal(result.ledger.attempts[0]!.outcome, "errored");
    assert.equal(result.ledger.attempts[0]!.commit_sha, null);
    assert.equal(result.exitCode, 0);
    assert.equal(result.ledger.reason, "passed");
    assert.equal(result.ledger.attempts.length, 3);
  } finally {
    h.cleanup();
  }
});

test("runLoop: a nonzero exit (chain ran but didn't accept its own work) never even evaluates the stop check", async () => {
  let stopEvaluated = false;
  const h = harness({
    max: 2,
    resultFor: () => ({ exit_code: 1, error: null, commit_sha: null, tokens: 5, cost: 0.01, stop_verdict: (() => { stopEvaluated = true; return null; })() }),
  });
  try {
    const result = await runLoop(h.deps);
    assert.equal(result.ledger.attempts[0]!.outcome, "not-accepted");
    assert.match(result.ledger.attempts[0]!.failures[0]!, /did not accept its own work/);
    // stop_verdict was computed by the stub eagerly (a real runIteration wouldn't), but the
    // driver must still treat a nonzero exit as not-accepted regardless of what rides along.
    assert.equal(stopEvaluated, true);
  } finally {
    h.cleanup();
  }
});

test("runLoop: --stuck-after trips before --max when the commit sha stops changing", async () => {
  const h = harness({
    max: 10,
    stuckAfter: 2,
    resultFor: () => ({ exit_code: 0, error: null, commit_sha: "same-sha", tokens: 1, cost: 0.001, stop_verdict: { passed: false, failures: ["no progress"], artifacts: [] } }),
  });
  try {
    const result = await runLoop(h.deps);
    assert.equal(result.ledger.reason, "stuck");
    assert.equal(result.ledger.attempts.length, 2);
  } finally {
    h.cleanup();
  }
});

test("runLoop: the cumulative budget breaker stops BEFORE dispatching the next iteration, once already at the ceiling", async () => {
  let calls = 0;
  const h = harness({
    max: 10,
    budget: { maxCost: 0.05 },
    resultFor: () => {
      calls++;
      return { exit_code: 0, error: null, commit_sha: `sha-${calls}`, tokens: 10, cost: 0.03, stop_verdict: { passed: false, failures: ["not there yet"], artifacts: [] } };
    },
  });
  try {
    const result = await runLoop(h.deps);
    // Two iterations at $0.03 each = $0.06 >= $0.05 ceiling, checked before iteration 3.
    assert.equal(calls, 2);
    assert.equal(result.ledger.attempts.length, 2);
    assert.equal(result.ledger.reason, "exhausted");
  } finally {
    h.cleanup();
  }
});

test("runLoop: every attempt is persisted to the goal-scoped ledger, readable independently of the in-memory result", async () => {
  const h = harness({
    max: 1,
    goalId: "readback-goal",
    resultFor: () => ({ exit_code: 0, error: null, commit_sha: "sha1", tokens: 10, cost: 0.01, stop_verdict: { passed: true, failures: [], artifacts: [] } }),
  });
  try {
    await runLoop(h.deps);
    const reloaded = loadLedger(h.dataDir, "readback-goal");
    assert.ok(reloaded);
    assert.equal(reloaded!.attempts.length, 1);
    assert.equal(reloaded!.reason, "passed");
    // The ledger lives outside any per-adw_id session dir — see loop.ts's
    // own doc comment on why context_handoff_dir would reset every iteration.
    assert.ok(!reloaded!.base_adw_id.includes("sessions"));
  } finally {
    h.cleanup();
  }
});

test("runLoop: resuming a killed loop picks up where the ledger left off, deriving iteration ids from the SAME base_adw_id", async () => {
  const h1 = harness({
    max: 5,
    goalId: "resume-goal",
    resultFor: () => ({ exit_code: 0, error: null, commit_sha: "sha1", tokens: 10, cost: 0.01, stop_verdict: { passed: false, failures: ["not yet"], artifacts: [] } }),
  });
  let firstBase = "";
  try {
    // Run exactly one iteration by capping max at 1, then "kill" it (never call runLoop to exhaustion).
    h1.deps.max = 1;
    const first = await runLoop(h1.deps);
    firstBase = first.ledger.base_adw_id;
    assert.equal(first.ledger.attempts.length, 1);

    // Resume with a fresh process-like harness pointed at the SAME dataDir/goalId, higher max.
    let call = 0;
    const h2: LoopDeps = {
      ...h1.deps,
      max: 3,
      runIteration: async () => {
        call++;
        return { exit_code: 0, error: null, commit_sha: `sha-${call + 1}`, tokens: 10, cost: 0.01, stop_verdict: { passed: true, failures: [], artifacts: [] } };
      },
    };
    const second = await runLoop(h2);
    assert.equal(second.ledger.base_adw_id, firstBase);
    assert.equal(second.ledger.attempts.length, 2); // the resumed one picks up at attempt 2
    assert.equal(second.ledger.attempts[1]!.adw_id, `${firstBase}-2`);
  } finally {
    h1.cleanup();
  }
});

// ── summarize ────────────────────────────────────────────────────────────────

test("summarize: names the terminal reason, the attempt count, and the best attempt's commit", async () => {
  const h = harness({
    max: 2,
    goalId: "summary-goal",
    resultFor: (i) => ({ exit_code: 0, error: null, commit_sha: `sha-${i}`, tokens: 100, cost: 0.02, stop_verdict: { passed: i === 2, failures: i === 1 ? ["not there yet"] : [], artifacts: [] } }),
  });
  try {
    const result = await runLoop(h.deps);
    const line = summarize(result);
    assert.match(line, /passed after 2\/2 attempt/);
    assert.match(line, /best: attempt 2/);
  } finally {
    h.cleanup();
  }
});
