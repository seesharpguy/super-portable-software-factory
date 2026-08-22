import "./hermetic_git.ts";

/**
 * Best-of-N, at unit scope: naming, the deterministic selection, and the
 * lifecycle around it. NO REAL AGENTS AND NO REAL CHAINS — `FanoutDeps` exists
 * precisely so the mechanism can be driven by stubs, the same seam
 * `WatchDeps` gives `watch.test.ts`.
 *
 * The git handle is a fake too, so nothing here creates a real worktree. The
 * one real filesystem effect left is `createRunWorktree`'s `mkdirSync` of the
 * worktrees dir, which is why every test that runs `runBestOf` points it at a
 * tmpdir and removes it afterwards.
 *
 * `pickBest` is tested as the pure function it is — including across every
 * permutation of its input, because "deterministic" is a claim about the
 * comparator being a TOTAL order, not about the happy path returning something
 * plausible. A comparator that ties on two distinct attempts would pass a
 * single-order test and quietly hand a different branch to a human depending
 * on which attempt finished first.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ABORTED_EXIT,
  attemptAdwId,
  attemptBranch,
  attemptWorktreeName,
  attemptWorktreePath,
  compareAttempts,
  pickBest,
  runBestOf,
  type AttemptDispatch,
  type AttemptMetrics,
  type FanoutAttempt,
  type FanoutDeps,
} from "../core/fanout.js";
import type { GitHandle } from "../core/git_helper.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/** A ranked attempt with only the fields the comparator reads set meaningfully. */
function attempt(overrides: Partial<FanoutAttempt> & { adw_id: string }): FanoutAttempt {
  return {
    index: 1,
    branch: `spf/fanout/${overrides.adw_id}`,
    worktree: `/tmp/fanout-${overrides.adw_id}`,
    status: "success",
    exit_code: 0,
    error: null,
    gate_passes: 0,
    gate_failures: 0,
    cost: 0,
    tokens: 0,
    wall_ms: 0,
    kept: false,
    ...overrides,
  };
}

interface GitCalls {
  fetches: Array<[string, string]>;
  adds: Array<{ path: string; branch: string; startPoint: string }>;
  removes: string[];
  deletedBranches: string[];
}

function fakeGit(calls: GitCalls, overrides: Partial<GitHandle> = {}): GitHandle {
  return {
    currentBranch: () => "main",
    createBranch: (n) => n,
    isRepo: () => true,
    commitAll: () => "abc123",
    changedFiles: () => [],
    // Two unrelated callers share this one method, on purpose (see
    // `git_helper.ts`): `resolveStartPoint` asks about a REMOTE ref
    // (`origin/<base>`) to prefer the fetched base, and `createRunWorktree`
    // asks about the ATTEMPT'S OWN branch (`spf/fanout/...`) to refuse a
    // collision before ever calling `worktree add -b`. The default below
    // answers both honestly for a fresh fanout: the remote base exists,
    // no fan-out branch does yet.
    refExists: (ref) => ref.startsWith("origin/"),
    rev: () => "abc123",
    shortSha: () => "abc123",
    mergeBase: () => "abc123",
    isDirty: () => false,
    untrackedFiles: () => [],
    diffFiles: () => [],
    diffStat: () => "",
    diffCounts: () => [0, 0],
    diffText: () => "",
    fetch: (remote, ref) => void calls.fetches.push([remote, ref]),
    worktreeAdd: (worktreePath, branch, startPoint) => void calls.adds.push({ path: worktreePath, branch, startPoint }),
    worktreeRemove: (worktreePath) => void calls.removes.push(worktreePath),
    deleteLocalBranch: (name) => void calls.deletedBranches.push(name),
    push: () => {},
    ...overrides,
  };
}

const NO_METRICS: AttemptMetrics = { gate_passes: 0, gate_failures: 0, cost: 0, tokens: 0 };

interface Harness {
  deps: FanoutDeps;
  calls: GitCalls;
  dispatched: AttemptDispatch[];
  logs: string[];
  cleanup: () => void;
}

/**
 * A `runBestOf` harness over a tmp worktrees dir and a fake git handle.
 * `runAttempt` is given the exit code (or a thrower) per 1-based index.
 */
function harness(opts: {
  n: number;
  concurrency?: number;
  firstSuccess?: boolean;
  exitFor: (dispatch: AttemptDispatch) => Promise<number>;
  metricsFor?: (adwId: string) => AttemptMetrics;
}): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-fanout-test-"));
  const calls: GitCalls = { fetches: [], adds: [], removes: [], deletedBranches: [] };
  const dispatched: AttemptDispatch[] = [];
  const logs: string[] = [];
  const deps: FanoutDeps = {
    chainName: "plan-build-test",
    prompt: "add a widget",
    n: opts.n,
    concurrency: opts.concurrency ?? opts.n,
    baseAdwId: "base1234",
    baseBranch: "main",
    repoRoot: "/repo",
    worktreesDir: path.join(dir, "worktrees"),
    git: fakeGit(calls),
    linkDataDir: () => {},
    firstSuccess: opts.firstSuccess,
    runAttempt: async (dispatch) => {
      dispatched.push(dispatch);
      return opts.exitFor(dispatch);
    },
    readMetrics: opts.metricsFor ?? (() => NO_METRICS),
    log: (message) => void logs.push(message),
  };
  return { deps, calls, dispatched, logs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── naming ──────────────────────────────────────────────────────────────────

test("attempt names are derived from the base adw_id and are all deterministic", () => {
  assert.equal(attemptAdwId("base1234", 2), "base1234-2");
  assert.equal(attemptBranch("base1234", 2), "spf/fanout/base1234-2");
  assert.equal(attemptWorktreeName("base1234", 2), "fanout-base1234-2");
  assert.equal(attemptWorktreePath("/wt", "base1234", 2), path.join("/wt", "fanout-base1234-2"));
});

test("the fanout branch namespace is distinct from watch's, because these branches are never pushed", () => {
  assert.match(attemptBranch("x", 1), /^spf\/fanout\//);
  assert.ok(!attemptBranch("x", 1).startsWith("spf-watch/"));
  assert.ok(!attemptBranch("x", 1).startsWith("spf-refine/"));
});

// ── pickBest: the deterministic disposer ────────────────────────────────────

test("pickBest: no successful attempt means no winner — a failed run is never a candidate", () => {
  const { winner, basis } = pickBest([
    attempt({ adw_id: "a-1", status: "fail", exit_code: 1 }),
    attempt({ adw_id: "a-2", status: "error", exit_code: null, error: "boom" }),
    attempt({ adw_id: "a-3", status: "skipped", exit_code: ABORTED_EXIT }),
  ]);
  assert.equal(winner, null);
  assert.match(basis, /no attempt succeeded/);
});

test("pickBest: success beats failure even when the failure looks better on every other axis", () => {
  const { winner } = pickBest([
    attempt({ adw_id: "a-1", status: "fail", exit_code: 1, gate_passes: 99, cost: 0, wall_ms: 1 }),
    attempt({ adw_id: "a-2", gate_passes: 1, cost: 9.99, wall_ms: 999_999 }),
  ]);
  assert.equal(winner?.adw_id, "a-2");
});

test("pickBest: fewest gate FAILURES outranks most gate passes — zero is the bar", () => {
  const { winner, basis } = pickBest([
    attempt({ adw_id: "a-1", gate_failures: 2, gate_passes: 20 }),
    attempt({ adw_id: "a-2", gate_failures: 0, gate_passes: 3 }),
  ]);
  assert.equal(winner?.adw_id, "a-2");
  assert.match(basis, /fewer gate failures \(0 vs 2\)/);
});

test("pickBest: with gate failures level, more gate passes wins — the attempt that verified more", () => {
  const { winner, basis } = pickBest([
    attempt({ adw_id: "a-1", gate_passes: 4 }),
    attempt({ adw_id: "a-2", gate_passes: 7 }),
  ]);
  assert.equal(winner?.adw_id, "a-2");
  assert.match(basis, /more gate passes \(7 vs 4\)/);
});

test("pickBest: with gates level, the cheaper run wins", () => {
  const { winner, basis } = pickBest([
    attempt({ adw_id: "a-1", gate_passes: 5, cost: 0.42 }),
    attempt({ adw_id: "a-2", gate_passes: 5, cost: 0.11 }),
  ]);
  assert.equal(winner?.adw_id, "a-2");
  assert.match(basis, /lower cost/);
});

test("pickBest: with cost level, fewer tokens wins", () => {
  const { winner, basis } = pickBest([
    attempt({ adw_id: "a-1", cost: 0.5, tokens: 50_000 }),
    attempt({ adw_id: "a-2", cost: 0.5, tokens: 20_000 }),
  ]);
  assert.equal(winner?.adw_id, "a-2");
  assert.match(basis, /fewer tokens/);
});

// wall_ms is a LAST resort, deliberately below cost and tokens: every code
// phase spawns synchronously and blocks the shared event loop, so it is not
// a clean property of the candidate the way cost/tokens (read from the
// trace) are. Proven here on tokens level, not cost level.
test("pickBest: with cost and tokens level, the faster run wins (wall time is the last resort)", () => {
  const { winner, basis } = pickBest([
    attempt({ adw_id: "a-1", cost: 0.5, tokens: 1000, wall_ms: 90_000 }),
    attempt({ adw_id: "a-2", cost: 0.5, tokens: 1000, wall_ms: 30_000 }),
  ]);
  assert.equal(winner?.adw_id, "a-2");
  assert.match(basis, /lower wall time/);
});

test("pickBest: two runs identical on every measured axis break on lexicographic adw_id", () => {
  const { winner, basis } = pickBest([attempt({ adw_id: "b-2" }), attempt({ adw_id: "a-1" })]);
  assert.equal(winner?.adw_id, "a-1");
  assert.match(basis, /lexicographic adw_id tiebreak/);
});

test("pickBest: a lone survivor is reported as such, not as having beaten anyone", () => {
  const { winner, basis } = pickBest([
    attempt({ adw_id: "a-1", status: "fail", exit_code: 1 }),
    attempt({ adw_id: "a-2" }),
  ]);
  assert.equal(winner?.adw_id, "a-2");
  assert.match(basis, /the only attempt that succeeded of 2/);
});

// The claim being tested is that the comparator is a TOTAL order: no two
// distinct attempts can tie, so input order cannot influence the winner. A
// permutation sweep is the only honest way to test that.
test("pickBest is order-independent across every permutation of its input", () => {
  const pool = [
    attempt({ adw_id: "a-1", gate_failures: 1, gate_passes: 9, cost: 0.1, wall_ms: 10 }),
    attempt({ adw_id: "a-2", gate_failures: 0, gate_passes: 3, cost: 0.9, wall_ms: 900 }),
    attempt({ adw_id: "a-3", gate_failures: 0, gate_passes: 3, cost: 0.9, wall_ms: 900 }),
    attempt({ adw_id: "a-4", status: "fail", exit_code: 1, gate_failures: 0, gate_passes: 99 }),
  ];
  const permutations = (items: FanoutAttempt[]): FanoutAttempt[][] =>
    items.length <= 1
      ? [items]
      : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));

  const all = permutations(pool);
  assert.equal(all.length, 24, "sanity: 4! orderings");
  for (const ordering of all) {
    const { winner, basis } = pickBest(ordering);
    // a-2 and a-3 are identical on every measured axis; the adw_id tiebreak
    // has to settle it the same way every time or the winner is a coin flip.
    assert.equal(winner?.adw_id, "a-2", `permutation ${ordering.map((a) => a.adw_id).join(",")} picked a different winner`);
    assert.match(basis, /fewer gate failures \(0 vs 1\)|lexicographic adw_id tiebreak/);
  }
});

test("compareAttempts never returns 0 for two distinct attempts (the total-order guarantee)", () => {
  const a = attempt({ adw_id: "a-1" });
  const b = attempt({ adw_id: "a-2" });
  assert.notEqual(compareAttempts(a, b), 0);
  assert.equal(compareAttempts(a, b), -compareAttempts(b, a), "and it is antisymmetric");
  assert.equal(compareAttempts(a, a), 0, "reflexive on the same attempt");
});

test("pickBest does not reorder the caller's array — the printed table stays in index order", () => {
  const attempts = [attempt({ adw_id: "a-3", index: 3 }), attempt({ adw_id: "a-1", index: 1 })];
  pickBest(attempts);
  assert.deepEqual(attempts.map((a) => a.adw_id), ["a-3", "a-1"]);
});

// ── runBestOf: lifecycle ────────────────────────────────────────────────────

test("runBestOf: one worktree and branch per attempt, named from the base adw_id, branched off the fetched base", async () => {
  const h = harness({ n: 3, exitFor: async () => 1 }); // all fail: nothing is kept, so every attempt is observable
  try {
    const result = await runBestOf(h.deps);
    assert.deepEqual(
      h.calls.adds.map((a) => a.branch),
      ["spf/fanout/base1234-1", "spf/fanout/base1234-2", "spf/fanout/base1234-3"],
    );
    assert.deepEqual(
      h.calls.adds.map((a) => path.basename(a.path)),
      ["fanout-base1234-1", "fanout-base1234-2", "fanout-base1234-3"],
    );
    for (const add of h.calls.adds) {
      assert.equal(add.startPoint, "origin/main", "a fetched remote base is preferred over the local branch");
    }
    assert.deepEqual(h.calls.fetches, [["origin", "main"], ["origin", "main"], ["origin", "main"]]);
    assert.equal(result.winner, null);
    assert.deepEqual(result.attempts.map((a) => a.status), ["fail", "fail", "fail"]);
  } finally {
    h.cleanup();
  }
});

test("runBestOf: each attempt's Run is anchored to its OWN worktree, never the main repo", async () => {
  const h = harness({ n: 2, exitFor: async () => 1 });
  try {
    await runBestOf(h.deps);
    const cwds = h.dispatched.map((d) => d.cwd);
    assert.equal(new Set(cwds).size, 2, "two attempts, two distinct working trees");
    for (const cwd of cwds) {
      assert.notEqual(cwd, h.deps.repoRoot, "an attempt must never be pointed at the main repo root");
      assert.ok(cwd.startsWith(h.deps.worktreesDir), `${cwd} is not under the worktrees dir`);
    }
  } finally {
    h.cleanup();
  }
});

test("runBestOf: a failed attempt's worktree and branch are cleaned up immediately, not left for later", async () => {
  const h = harness({ n: 2, concurrency: 1, exitFor: async (d) => (d.index === 1 ? 1 : 0) });
  try {
    const result = await runBestOf(h.deps);
    const loser = attemptWorktreePath(h.deps.worktreesDir, "base1234", 1);
    // Two removals for the failure: the unconditional cleanup-first before
    // `worktree add` (a killed prior run may have left debris), plus the
    // scoped helper's own cleanup once the attempt failed.
    assert.equal(h.calls.removes.filter((p) => p === loser).length, 2);
    assert.ok(h.calls.deletedBranches.includes("spf/fanout/base1234-1"));
    assert.equal(result.attempts[0]!.kept, false);
  } finally {
    h.cleanup();
  }
});

test("runBestOf: the winner's branch AND worktree survive; the losing successes are deleted", async () => {
  const h = harness({
    n: 3,
    exitFor: async () => 0,
    // Attempt 2 is the only clean one, so the basis is gate failures — not a
    // tiebreak — which is what makes the kept/deleted split unambiguous here.
    metricsFor: (adwId) =>
      adwId === "base1234-2"
        ? { gate_passes: 5, gate_failures: 0, cost: 0.2, tokens: 100 }
        : { gate_passes: 5, gate_failures: 1, cost: 0.1, tokens: 100 },
  });
  try {
    const result = await runBestOf(h.deps);
    assert.equal(result.winner?.adw_id, "base1234-2");
    assert.equal(result.winner?.branch, "spf/fanout/base1234-2");
    assert.match(result.basis, /fewer gate failures/);

    const winnerPath = attemptWorktreePath(h.deps.worktreesDir, "base1234", 2);
    assert.equal(
      h.calls.removes.filter((p) => p === winnerPath).length,
      1,
      "the winner is removed exactly once — the cleanup-first before its own `worktree add`, and never again",
    );
    assert.ok(!h.calls.deletedBranches.includes("spf/fanout/base1234-2"), "SPF must not delete the branch it is asking a human to merge");

    for (const index of [1, 3]) {
      const loserPath = attemptWorktreePath(h.deps.worktreesDir, "base1234", index);
      assert.equal(h.calls.removes.filter((p) => p === loserPath).length, 2, `loser ${index}: cleanup-first + post-selection removal`);
      assert.ok(h.calls.deletedBranches.includes(`spf/fanout/base1234-${index}`));
    }
    assert.deepEqual(result.attempts.map((a) => a.kept), [false, true, false]);
  } finally {
    h.cleanup();
  }
});

// The DEFAULT contract, as of `firstSuccess` becoming opt-in: best-of-N
// really means every attempt that was going to run, runs — an early success
// must not silently shrink the comparison to whatever was still queued.
test("runBestOf: by default, an early success does not stop a queued attempt from being dispatched", async () => {
  const h = harness({ n: 3, concurrency: 1, exitFor: async () => 0 });
  try {
    const result = await runBestOf(h.deps);
    assert.deepEqual(h.dispatched.map((d) => d.index), [1, 2, 3], "every attempt ran — no early abort by default");
    assert.deepEqual(result.attempts.map((a) => a.status), ["success", "success", "success"]);
    assert.equal(h.calls.adds.length, 3);
    assert.ok(!h.logs.some((l) => /skipped/.test(l)), "nothing was skipped, so nothing should claim to be");
  } finally {
    h.cleanup();
  }
});

// The opt-in first-past-the-post contract: once one attempt exits 0 with
// `firstSuccess: true`, no FURTHER attempt is dispatched at all. With
// concurrency 1 that is provable exactly — attempts 2 and 3 never reach
// `runAttempt`, so they cost nothing.
test("runBestOf: firstSuccess:true — a decided race dispatches nothing further", async () => {
  const h = harness({ n: 3, concurrency: 1, firstSuccess: true, exitFor: async () => 0 });
  try {
    const result = await runBestOf(h.deps);
    assert.deepEqual(h.dispatched.map((d) => d.index), [1], "only the first attempt ever ran");
    assert.deepEqual(result.attempts.map((a) => a.status), ["success", "skipped", "skipped"]);
    assert.deepEqual(result.attempts.map((a) => a.exit_code), [0, ABORTED_EXIT, ABORTED_EXIT]);
    assert.equal(h.calls.adds.length, 1, "a skipped attempt never gets a worktree either");
    assert.equal(result.winner?.adw_id, "base1234-1");
    assert.ok(h.logs.some((l) => /attempt 2 skipped/.test(l)), "the skip is reported, not silent");
  } finally {
    h.cleanup();
  }
});

test("runBestOf: with firstSuccess:true, the abort flag is visible to an in-flight runner, and its ABORTED_EXIT reads as skipped, not failed", async () => {
  const seen: Array<{ index: number; aborted: boolean }> = [];
  // Attempt 1 succeeds and returns first; attempt 2 is already in flight
  // (concurrency 2) and cooperatively declines to spend once it sees the flag.
  const h = harness({
    n: 2,
    concurrency: 2,
    firstSuccess: true,
    exitFor: async (d) => {
      if (d.index === 1) return 0;
      await new Promise((resolve) => setTimeout(resolve, 10));
      seen.push({ index: d.index, aborted: d.isAborted() });
      return d.isAborted() ? ABORTED_EXIT : 0;
    },
  });
  try {
    const result = await runBestOf(h.deps);
    assert.deepEqual(seen, [{ index: 2, aborted: true }], "an in-flight attempt can observe that the race is over");
    assert.equal(result.attempts[1]!.status, "skipped");
    assert.equal(result.winner?.adw_id, "base1234-1");
  } finally {
    h.cleanup();
  }
});

test("runBestOf: a runner that throws is recorded as an error attempt, cleaned up, and never wins", async () => {
  const h = harness({
    n: 2,
    concurrency: 1,
    exitFor: async (d) => {
      if (d.index === 1) throw new Error("chain blew up");
      return 0;
    },
  });
  try {
    const result = await runBestOf(h.deps);
    assert.equal(result.attempts[0]!.status, "error");
    assert.equal(result.attempts[0]!.error, "chain blew up");
    assert.equal(result.attempts[0]!.exit_code, null);
    assert.ok(h.calls.deletedBranches.includes("spf/fanout/base1234-1"), "a thrown attempt's branch is still cleaned up");
    assert.equal(result.winner?.adw_id, "base1234-2");
  } finally {
    h.cleanup();
  }
});

test("runBestOf: attempts come back in index order regardless of which finished first", async () => {
  const h = harness({
    n: 3,
    concurrency: 3,
    // Reverse completion order: 3 finishes first, 1 last.
    exitFor: async (d) => {
      await new Promise((resolve) => setTimeout(resolve, (4 - d.index) * 10));
      return 1;
    },
  });
  try {
    const result = await runBestOf(h.deps);
    assert.deepEqual(result.attempts.map((a) => a.index), [1, 2, 3]);
    assert.deepEqual(result.attempts.map((a) => a.adw_id), ["base1234-1", "base1234-2", "base1234-3"]);
  } finally {
    h.cleanup();
  }
});

test("runBestOf: metrics come from the shared db per adw_id, and a failing read ranks as zeros instead of killing the fanout", async () => {
  const asked: string[] = [];
  const h = harness({
    n: 2,
    exitFor: async () => 0,
    metricsFor: (adwId) => {
      asked.push(adwId);
      if (adwId === "base1234-1") throw new Error("db locked");
      return { gate_passes: 2, gate_failures: 0, cost: 0.3, tokens: 42 };
    },
  });
  try {
    const result = await runBestOf(h.deps);
    assert.deepEqual(asked.sort(), ["base1234-1", "base1234-2"]);
    assert.deepEqual(result.attempts[0]!.gate_passes, 0, "an unreadable attempt ranks as zeros");
    assert.equal(result.attempts[0]!.status, "success", "and is still a candidate — the exit code decides success, not the metrics");
    assert.equal(result.attempts[1]!.gate_passes, 2);
    assert.equal(result.winner?.adw_id, "base1234-2", "the readable, better-verified attempt wins");
    assert.ok(h.logs.some((l) => /could not read metrics for base1234-1/.test(l)));
  } finally {
    h.cleanup();
  }
});

test("runBestOf: concurrency caps how many attempts are in flight at once", async () => {
  let inflight = 0;
  let peak = 0;
  const h = harness({
    n: 4,
    concurrency: 2,
    exitFor: async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inflight--;
      return 1; // all fail, so the early-abort never short-circuits the sweep
    },
  });
  try {
    await runBestOf(h.deps);
    assert.equal(peak, 2, "never more than `concurrency` chains running against the same machine and the same sqlite");
    assert.equal(h.dispatched.length, 4);
  } finally {
    h.cleanup();
  }
});

test("runBestOf: a local-only repo (no remote base ref) branches off the local base instead of failing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-fanout-local-"));
  const calls: GitCalls = { fetches: [], adds: [], removes: [], deletedBranches: [] };
  try {
    const deps: FanoutDeps = {
      chainName: "plan",
      prompt: "p",
      n: 1,
      concurrency: 1,
      baseAdwId: "local1",
      baseBranch: "main",
      repoRoot: "/repo",
      worktreesDir: path.join(dir, "worktrees"),
      git: fakeGit(calls, {
        // No remote: the fetch throws and origin/main does not resolve.
        fetch: () => {
          throw new Error("'origin' does not appear to be a git repository");
        },
        refExists: () => false,
      }),
      linkDataDir: () => {},
      runAttempt: async () => 0,
      readMetrics: () => NO_METRICS,
      log: () => {},
    };
    const result = await runBestOf(deps);
    assert.equal(calls.adds[0]!.startPoint, "main", "a failed fetch falls back to the local base rather than aborting the run");
    assert.equal(result.winner?.adw_id, "local1-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
