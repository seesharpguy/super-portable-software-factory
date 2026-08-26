import "./hermetic_git.ts";

/**
 * `watch.fanout` — best-of-N per claimed issue, at the `core/watch.ts`
 * composition level. NO REAL AGENTS, NO REAL CHAINS, NO REAL GIT: `WatchDeps`
 * and `WatchFanoutDeps` exist precisely so this composition can be driven by
 * fakes, the same seam `watch.test.ts` uses for the single-dispatch lane.
 *
 * A NEW FILE rather than growing `watch.test.ts`, for two reasons: that file
 * currently spawns no git and should keep that property (it never constructs
 * `deps.fanout`, so it never reaches `runBestOf` — see `watch.test.ts`'s own
 * 81 unmodified passing tests, which is the regression evidence that
 * `watch.fanout.n: 1` really is a no-op for the running daemon), and keeping
 * it untouched is itself part of that evidence.
 *
 * `sharedGit` below models the ONE real git rule the pre-sweep is ordered
 * around: `deleteLocalBranch(name)` is a no-op that SILENTLY FAILS while any
 * still-registered worktree has that branch checked out, and
 * `worktreeRemove(path)` is what de-registers a worktree. `createBranch`
 * throws when the name already exists — real git's `checkout -b` behavior —
 * which is what makes the pre-sweep tests below an honest regression guard
 * rather than a fake that happens to call both methods and call it proven.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  branchNameFor,
  claimNewWork,
  createWatchState,
  type ChainRunResult,
  type RefineRunResult,
  type WatchDeps,
  type WatchFanoutDeps,
} from "../core/watch.js";
import { attemptAdwId, attemptBranch, attemptWorktreePath, type AttemptDispatch, type AttemptMetrics } from "../core/fanout.js";
import type { GitHandle } from "../core/git_helper.js";
import type {
  CodeHostProvider,
  EnsureLabelsResult,
  Issue,
  IssueComment,
  IssueProvider,
  PrRef,
  PrStatus,
  WatchMarker,
  WatchState,
} from "../core/issues/provider.js";
// ── fixtures (trimmed copies of watch.test.ts's own — see that file for the
// full versions; this file only needs the build lane, never refine) ────────

const FAKE_STATE_LABELS = new Set(
  (["ready", "working", "review", "done", "blocked"] as const).map((s) => `spf:${s}`),
);

interface FakeEntry {
  issue: Issue;
  state: WatchState;
  marker: WatchMarker | null;
}

class FakeProvider implements IssueProvider {
  entries = new Map<string, FakeEntry>();
  transitions: Array<{ id: string; to: WatchState; detail?: string }> = [];
  claimCalls: string[] = [];
  markerWrites: WatchMarker[] = [];

  addIssue(id: string, title: string, state: WatchState = "ready", marker: WatchMarker | null = null): void {
    this.entries.set(id, { issue: { id, title, body: "", labels: [`spf:${state}`] }, state, marker });
  }
  async ensureLabels(): Promise<EnsureLabelsResult> {
    return { created: [], updated: [], unchanged: [] };
  }
  async listEligible(): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => e.state === "ready").map((e) => e.issue);
  }
  async listInState(state: WatchState): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => e.state === state).map((e) => e.issue);
  }
  private relabel(entry: FakeEntry, to: WatchState): void {
    entry.issue = { ...entry.issue, labels: [...entry.issue.labels.filter((l) => !FAKE_STATE_LABELS.has(l)), `spf:${to}`] };
  }
  async claim(issue: Issue, opts?: { from?: WatchState; to?: WatchState }): Promise<boolean> {
    this.claimCalls.push(issue.id);
    const entry = this.entries.get(issue.id)!;
    const from = opts?.from ?? "ready";
    const to = opts?.to ?? "working";
    if (entry.state !== from) return false;
    entry.state = to;
    this.relabel(entry, to);
    return true;
  }
  async transition(issue: Issue, to: WatchState, detail?: string): Promise<void> {
    const entry = this.entries.get(issue.id)!;
    entry.state = to;
    this.relabel(entry, to);
    this.transitions.push({ id: issue.id, to, detail });
  }
  async comment(): Promise<void> {}
  async readMarker(issue: Issue): Promise<WatchMarker | null> {
    return this.entries.get(issue.id)?.marker ?? null;
  }
  async writeMarker(issue: Issue, marker: WatchMarker): Promise<void> {
    this.markerWrites.push(marker);
    this.entries.get(issue.id)!.marker = marker;
  }
  async listComments(): Promise<IssueComment[]> {
    return [];
  }
  async getIssue(id: string): Promise<Issue | null> {
    return this.entries.get(id)?.issue ?? null;
  }
}

class FakeCodeHost implements CodeHostProvider {
  prs = new Map<number, PrStatus>();
  openedPrs: Array<{ title: string; branch: string; body: string }> = [];
  nextPrNumber = 1000;
  async openPr(opts: { branch: string; title: string; body: string }): Promise<PrRef> {
    const number = this.nextPrNumber++;
    this.openedPrs.push({ title: opts.title, branch: opts.branch, body: opts.body });
    this.prs.set(number, { merged: false, state: "open", ciStatus: "pending" });
    return { number, branch: opts.branch, url: `https://example.invalid/pr/${number}` };
  }
  async prStatus(pr: PrRef): Promise<PrStatus> {
    return this.prs.get(pr.number) ?? { merged: false, state: "open", ciStatus: "pending" };
  }
}

/** One shared "repo" every fakeGit call in a test operates against — see the module doc comment for the ONE rule this models. */
interface GitState {
  /** worktree path -> the branch currently checked out there. */
  worktrees: Map<string, string>;
  branches: Set<string>;
  calls: string[];
  worktreeAddCalls: Array<{ path: string; branch: string; startPoint: string }>;
}

function newGitState(): GitState {
  return { worktrees: new Map(), branches: new Set(), calls: [], worktreeAddCalls: [] };
}

/**
 * `boundPath`, when set, models `deps.worktreeGit(path)`: a `createBranch`
 * through THIS handle registers `path` as checked out on the new branch —
 * exactly what `git checkout -b` run from inside a worktree does. Every
 * handle shares the same `GitState`, the same way every git command against
 * one real repo shares its refs regardless of which worktree ran it.
 */
function sharedGit(state: GitState, boundPath: string | undefined, overrides: Partial<GitHandle> = {}): GitHandle {
  return {
    currentBranch: () => "main",
    createBranch: (name) => {
      if (state.branches.has(name)) throw new Error(`fatal: a branch named '${name}' already exists`);
      state.branches.add(name);
      if (boundPath) state.worktrees.set(boundPath, name);
      return name;
    },
    isRepo: () => true,
    commitAll: () => "abc123",
    changedFiles: () => [],
    refExists: (ref) => (ref.startsWith("origin/") ? !ref.includes("basesha") : state.branches.has(ref)),
    rev: () => "basesha0123456789",
    shortSha: () => "abc123",
    mergeBase: () => "abc123",
    isDirty: () => false,
    untrackedFiles: () => [],
    diffFiles: () => ["src/index.ts"],
    diffStat: () => "",
    diffCounts: () => [0, 0],
    diffText: () => "",
    fetch: (remote, ref) => void state.calls.push(`fetch:${remote}/${ref}`),
    worktreeAdd: (worktreePath, branch, startPoint) => {
      state.calls.push(`worktreeAdd:${worktreePath}`);
      state.worktreeAddCalls.push({ path: worktreePath, branch, startPoint });
      state.worktrees.set(worktreePath, branch);
      state.branches.add(branch);
    },
    worktreeRemove: (worktreePath) => {
      state.calls.push(`worktreeRemove:${worktreePath}`);
      state.worktrees.delete(worktreePath);
    },
    deleteLocalBranch: (name) => {
      const stillCheckedOut = [...state.worktrees.values()].includes(name);
      if (stillCheckedOut) {
        state.calls.push(`deleteLocalBranch:${name}:REFUSED`);
        return; // silent failure — see git_helper.ts's deleteLocalBranch
      }
      state.calls.push(`deleteLocalBranch:${name}`);
      state.branches.delete(name);
    },
    push: () => {},
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface FanoutHarness {
  deps: WatchDeps;
  state: GitState;
  dispatched: AttemptDispatch[];
  cleanup: () => void;
}

/**
 * `exitFor`/`metricsFor` key on the attempt INDEX (1-based) so a test can say
 * "attempt 2 wins" without hardcoding a base adw_id the salt probe may have
 * moved. `adwIdsFree` defaults to always-true (salt stays 0, base is
 * `issue-<id>` — the common case); override it to drive the salt probe.
 */
function fanoutHarness(opts: {
  provider: FakeProvider;
  codeHost: FakeCodeHost;
  n: number;
  concurrency?: number;
  exitFor?: (index: number) => number;
  metricsFor?: (index: number) => AttemptMetrics;
  adwIdsFree?: (adwIds: string[]) => boolean;
  reviewFor?: WatchFanoutDeps["reviewFor"];
  watchDepsOverrides?: Partial<WatchDeps>;
}): FanoutHarness {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-watch-fanout-test-"));
  const worktreesDir = path.join(dir, "worktrees");
  const state = newGitState();
  const dispatched: AttemptDispatch[] = [];

  const runAttempt = async (dispatch: AttemptDispatch): Promise<number> => {
    dispatched.push(dispatch);
    return (opts.exitFor ?? (() => 0))(dispatch.index);
  };
  const readMetrics = (adwId: string): AttemptMetrics => {
    const index = Number(adwId.split("-").pop());
    return (opts.metricsFor ?? (() => ({ gate_passes: 0, gate_failures: 0, cost: 0, tokens: 0 })))(index);
  };

  const fanout: WatchFanoutDeps = {
    n: opts.n,
    concurrency: opts.concurrency ?? opts.n,
    repoRoot: "/repo",
    runAttempt,
    readMetrics,
    adwIdsFree: opts.adwIdsFree ?? (() => true),
    reviewFor: opts.reviewFor ?? (() => ({ reviewRequired: false, reviewSummary: undefined })),
  };

  const deps: WatchDeps = {
    provider: opts.provider,
    codeHost: opts.codeHost,
    git: sharedGit(state, undefined),
    worktreeGit: (p) => sharedGit(state, p),
    labelPrefix: "spf",
    chain: "plan-build-test",
    baseBranch: "main",
    concurrency: 2,
    chainOptions: {},
    refineEnabled: false,
    refineConcurrency: 1,
    refineChain: "refine",
    runRefine: async (o): Promise<RefineRunResult> => ({ accepted: true, adwId: o.adwId, detail: "", created: [], questions: [] }),
    worktreesDir,
    linkDataDir: () => {},
    dryRun: false,
    runChain: async (): Promise<ChainRunResult> => ({ accepted: true, adwId: "issue-1", detail: "" }),
    log: () => {},
    notify: () => {},
    fanout,
    ...opts.watchDepsOverrides,
  };

  return { deps, state, dispatched, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── a: n=1 leaves the daemon path untouched ─────────────────────────────────

test("watch.fanout: deps.fanout undefined never touches the fan-out lane — single-dispatch path, byte-identical", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a widget");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const h = fanoutHarness({ provider, codeHost, n: 1 });
  h.deps.fanout = undefined; // n:1's default at the CLI surface
  try {
    await claimNewWork(h.deps, state);
    await waitUntil(() => state.inflight.size === 0);

    assert.equal(h.dispatched.length, 0, "fanout.runAttempt must never be called");
    assert.ok(h.state.worktreeAddCalls.some((c) => c.path === path.join(h.deps.worktreesDir, "issue-1")), "the single-dispatch worktree must be created");
    assert.equal(codeHost.openedPrs.length, 1);
    assert.match(codeHost.openedPrs[0]!.body, /adw_id `issue-1`/);
    assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
  } finally {
    h.cleanup();
  }
});

test("watch.fanout: {n: 1, ...} (an explicit but disabled object) also takes the single-dispatch path", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a widget");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const h = fanoutHarness({ provider, codeHost, n: 1 });
  try {
    await claimNewWork(h.deps, state);
    await waitUntil(() => state.inflight.size === 0);
    assert.equal(h.dispatched.length, 0, "fanout.runAttempt must never be called at n:1, even with deps.fanout set");
    assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
  } finally {
    h.cleanup();
  }
});

// ── b/c: winner flow, and reviewFor sees the winner's coordinates ──────────

test("watch.fanout: n=3, the winner (fewest gate failures) is renamed, pushed, and opens a PR naming its own adw_id", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a widget");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let reviewForCall: { cwd: string; adwId: string } | null = null;
  const h = fanoutHarness({
    provider,
    codeHost,
    n: 3,
    metricsFor: (index) => ({ gate_passes: 1, gate_failures: index === 2 ? 0 : 1, cost: 0, tokens: 0 }),
    reviewFor: (o) => {
      reviewForCall = { cwd: o.cwd, adwId: o.adwId };
      return { reviewRequired: true, reviewSummary: "Reviewer verdict: approved." };
    },
  });
  try {
    await claimNewWork(h.deps, state);
    await waitUntil(() => state.inflight.size === 0);

    const winnerAdwId = attemptAdwId("issue-1", 2);
    // reviewFor was called with the WINNER's own coordinates, not a base id
    // and not another attempt's tree.
    assert.equal((reviewForCall as any)?.adwId, winnerAdwId);
    assert.equal((reviewForCall as any)?.cwd, attemptWorktreePath(h.deps.worktreesDir, "issue-1", 2));

    // Renamed onto the canonical branch, deleting the fan-out ref.
    const canonicalBranch = provider.entries.get("1")!.marker!.branch!;
    assert.match(canonicalBranch, /^spf-watch\/1-/);
    assert.ok(h.state.calls.includes(`deleteLocalBranch:${attemptBranch("issue-1", 2)}`), "the fan-out branch must be deleted after the rename");
    assert.ok(!h.state.branches.has(attemptBranch("issue-1", 2)), "the fan-out branch no longer exists");
    assert.ok(h.state.branches.has(canonicalBranch), "the canonical branch exists");

    assert.equal(codeHost.openedPrs.length, 1);
    assert.match(codeHost.openedPrs[0]!.branch, /^spf-watch\/1-/);
    assert.match(codeHost.openedPrs[0]!.body, new RegExp(`adw_id \`${winnerAdwId}\``));
    assert.match(codeHost.openedPrs[0]!.body, /Reviewer verdict: approved\./);
    assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
    assert.equal(provider.entries.get("1")!.marker?.pr, 1000);
    assert.equal(provider.entries.get("1")!.marker?.attempt, 0);
  } finally {
    h.cleanup();
  }
});

// ── d: no winner -> blocked ──────────────────────────────────────────────

test("watch.fanout: every attempt fails -> blocked, naming N attempts, with no PR and no extra cleanup call from watch itself", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a widget");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const h = fanoutHarness({ provider, codeHost, n: 3, exitFor: () => 1 });
  try {
    await claimNewWork(h.deps, state);
    await waitUntil(() => state.inflight.size === 0);

    assert.deepEqual(provider.transitions.map((t) => t.to), ["blocked"]);
    assert.match(provider.transitions[0]!.detail ?? "", /3 attempt\(s\)/);
    assert.equal(codeHost.openedPrs.length, 0);
    // No worktreeRemove for a name that was never created — the failed
    // attempts' own trees died inside runBestOf's own scope.
  } finally {
    h.cleanup();
  }
});

// ── e: winner with an empty diff -> blocked, same as the single lane ───────

test("watch.fanout: winner with an empty diff blocks the issue and cleans the renamed pair exactly once", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a widget");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const h = fanoutHarness({ provider, codeHost, n: 2 });
  h.deps.worktreeGit = (p) => sharedGit(h.state, p, { diffFiles: () => [] });
  try {
    await claimNewWork(h.deps, state);
    await waitUntil(() => state.inflight.size === 0);

    assert.deepEqual(provider.transitions.map((t) => t.to), ["blocked"]);
    assert.equal(codeHost.openedPrs.length, 0);
  } finally {
    h.cleanup();
  }
});

// ── g: the pre-sweep clears the CANONICAL branch even with a PR recorded,
//      and removes worktrees before deleting branches ─────────────────────

/**
 * The exact cross-pair hazard §8.5/§8.3 describe: the CANONICAL pair (entry
 * 2 in the sweep list: `{worktree: <dir>/issue-1, branch: <canonical>}`) does
 * NOT itself hold the canonical branch — a DIFFERENT entry (an attempt-name
 * pair, `fanout-issue-1-2` / `spf/fanout/issue-1-2`) has, at the git level,
 * the canonical branch checked out there instead (a prior run renamed the
 * winner onto it and crashed before the marker/PR caught up). A PAIRWISE
 * sweep processes the canonical pair's `deleteLocalBranch` before ever
 * reaching the attempt-name pair that would free it — REFUSED, silently. A
 * two-pass sweep (every worktree, THEN every branch) removes the fan-out
 * worktree in pass 1 regardless of which pair named it, so pass 2's
 * `deleteLocalBranch` on the canonical name always succeeds.
 */
function riggedCrossPairScenario(h: FanoutHarness, issue: Issue): { canonicalBranch: string; attemptWorktree: string } {
  const canonicalBranch = branchNameFor(issue);
  const attemptWorktree = attemptWorktreePath(h.deps.worktreesDir, "issue-1", 2);
  h.state.worktrees.set(attemptWorktree, canonicalBranch);
  h.state.branches.add(canonicalBranch);
  return { canonicalBranch, attemptWorktree };
}

test("watch.fanout: pre-sweep clears a canonical branch checked out in a DIFFERENT (attempt-name) worktree — the rev-2/rev-3 cross-pair wedge regression", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a widget", "ready", { pr: 7 } as WatchMarker); // marker0 has no worktree/branch of its own — the crash left only the git-level state
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const h = fanoutHarness({ provider, codeHost, n: 2 });
  const { canonicalBranch, attemptWorktree } = riggedCrossPairScenario(h, provider.entries.get("1")!.issue);
  try {
    await claimNewWork(h.deps, state);
    await waitUntil(() => state.inflight.size === 0);

    const removeIdx = h.state.calls.indexOf(`worktreeRemove:${attemptWorktree}`);
    const deleteIdx = h.state.calls.indexOf(`deleteLocalBranch:${canonicalBranch}`);
    assert.ok(removeIdx !== -1, `expected the attempt worktree holding the canonical branch to be removed; calls: ${h.state.calls.join(", ")}`);
    assert.ok(deleteIdx !== -1, `expected the canonical branch to be deleted (not left REFUSED); calls: ${h.state.calls.join(", ")}`);
    assert.ok(removeIdx < deleteIdx, "the worktree must be removed BEFORE the branch is deleted — a pairwise sweep would leave the branch REFUSED");
    assert.ok(!h.state.calls.includes(`deleteLocalBranch:${canonicalBranch}:REFUSED`), "the branch delete must not have been silently refused");

    // The rename then succeeds (createBranch does not throw on the now-free
    // canonical name) and the run reaches review, not blocked.
    assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
  } finally {
    h.cleanup();
  }
});

test("watch.fanout: the pre-sweep runs identically whether or not marker0.pr is set — no PR-aware guard", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a widget"); // no marker at all
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const h = fanoutHarness({ provider, codeHost, n: 2 });
  const { canonicalBranch, attemptWorktree } = riggedCrossPairScenario(h, provider.entries.get("1")!.issue);
  try {
    await claimNewWork(h.deps, state);
    await waitUntil(() => state.inflight.size === 0);
    assert.ok(h.state.calls.includes(`worktreeRemove:${attemptWorktree}`));
    assert.ok(h.state.calls.includes(`deleteLocalBranch:${canonicalBranch}`));
    assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
  } finally {
    h.cleanup();
  }
});

// ── h: the pre-sweep's range follows the probed salt ────────────────────────

test("watch.fanout: the pre-sweep range follows the probed salt — bases 0..salt swept, nothing past it", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a widget");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const h = fanoutHarness({
    provider,
    codeHost,
    n: 2,
    adwIdsFree: (ids) => {
      const base = ids[0]!.replace(/-\d+$/, "");
      return base === "issue-1-r2"; // r0 and r1 are "taken", r2 is free
    },
  });
  try {
    await claimNewWork(h.deps, state);
    await waitUntil(() => state.inflight.size === 0);

    for (const r of [0, 1, 2]) {
      const base = r === 0 ? "issue-1" : `issue-1-r${r}`;
      for (const i of [1, 2, 3, 8]) {
        assert.ok(
          h.state.calls.includes(`worktreeRemove:${attemptWorktreePath(h.deps.worktreesDir, base, i)}`),
          `expected a sweep of ${base} attempt ${i}`,
        );
      }
    }
    for (const i of [1, 2, 8]) {
      assert.ok(
        !h.state.calls.includes(`worktreeRemove:${attemptWorktreePath(h.deps.worktreesDir, "issue-1-r3", i)}`),
        "base r3 was never reached by the probe and must never be swept",
      );
    }
    // The winner still used the free base.
    assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
  } finally {
    h.cleanup();
  }
});

// ── claim-time marker write (rev4): drops a stale pr/worktree/branch from a
//    previous cycle before the sweep's results can be undone by a crash, and
//    lands before any attempt is dispatched ──────────────────────────────────

test("watch.fanout: claim-time marker write drops marker0's stale pr/worktree/branch and preserves attempt, before any attempt dispatches (rev4 regression)", async () => {
  const provider = new FakeProvider();
  // Simulates a human hand-returning a `review` issue with a live worktree
  // and an open PR back to `ready`: marker0 carries `pr`, `worktree`, and
  // `branch` from that PREVIOUS cycle, plus a nonzero `attempt` from an
  // earlier orphan retry.
  provider.addIssue("1", "Add a widget", "ready", { worktree: "/x", branch: "spf-watch/1-old", pr: 7, attempt: 1 } as WatchMarker);
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const h = fanoutHarness({ provider, codeHost, n: 3 });
  const markerWriteCountAtDispatch: number[] = [];
  const originalRunAttempt = h.deps.fanout!.runAttempt;
  h.deps.fanout = {
    ...h.deps.fanout!,
    runAttempt: async (dispatch) => {
      markerWriteCountAtDispatch.push(provider.markerWrites.length);
      return originalRunAttempt(dispatch);
    },
  };
  try {
    await claimNewWork(h.deps, state);
    await waitUntil(() => state.inflight.size === 0);

    assert.ok(provider.markerWrites.length > 0, "expected at least one marker write");
    assert.deepEqual(
      provider.markerWrites[0],
      { attempt: 1 },
      "the claim-time write must be exactly {attempt: marker0.attempt} — pr/worktree/branch dropped, attempt PRESERVED (not reset to 0)",
    );
    assert.ok(markerWriteCountAtDispatch.length > 0, "expected at least one attempt to have been dispatched");
    assert.ok(
      markerWriteCountAtDispatch.every((count) => count >= 1),
      "the claim-time marker write must land before ANY attempt is dispatched, so a crash mid-fan-out never resumes off the stale pr",
    );
  } finally {
    h.cleanup();
  }
});

// ── i: crash windows — window 5 (push) cleans, does not leak, and matches
//      the single lane's own behaviour ─────────────────────────────────────

test("watch.fanout: a throw from push after the rename cleans the winner's tree + canonical branch (not leaked) — parity with the single lane", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a widget");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const h = fanoutHarness({ provider, codeHost, n: 2 });
  const originalWorktreeGit = h.deps.worktreeGit;
  h.deps.worktreeGit = (p) => sharedGit(h.state, p, { push: () => { throw new Error("push rejected (non-fast-forward)"); } });
  try {
    await claimNewWork(h.deps, state);
    await waitUntil(() => state.inflight.size === 0);

    assert.deepEqual(provider.transitions.map((t) => t.to), ["blocked"]);
    const canonicalBranch = /spf-watch\/1-[a-z-]+/.exec(h.state.calls.join(" "))?.[0];
    assert.ok(canonicalBranch, "expected the canonical branch to have been created before the throw");
    assert.ok(h.state.calls.includes(`deleteLocalBranch:${canonicalBranch}`), "window 5: the canonical branch must be cleaned, not leaked");
  } finally {
    void originalWorktreeGit;
    h.cleanup();
  }
});

test("watch.fanout: a throw inside runBestOf itself (before any winner exists) cleans nothing of watch's own", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a widget");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const h = fanoutHarness({
    provider,
    codeHost,
    n: 2,
    watchDepsOverrides: {},
  });
  h.deps.fanout = {
    ...h.deps.fanout!,
    runAttempt: async () => {
      throw new Error("agent dispatch exploded");
    },
  };
  try {
    await claimNewWork(h.deps, state);
    await waitUntil(() => state.inflight.size === 0);
    // runBestOf catches the per-attempt throw itself (status: "error"), so
    // this still resolves to a clean "no winner" blocked, not a watch_error.
    assert.deepEqual(provider.transitions.map((t) => t.to), ["blocked"]);
  } finally {
    h.cleanup();
  }
});

// ── j: the base is pinned once ──────────────────────────────────────────────

test("watch.fanout: the base is fetched and resolved exactly once, and every attempt (plus the final diff) uses the identical pinned SHA", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a widget");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let diffBaseSeen: string | null = null;
  const h = fanoutHarness({ provider, codeHost, n: 3 });
  h.deps.worktreeGit = (p) =>
    sharedGit(h.state, p, {
      diffFiles: (base) => {
        diffBaseSeen = base;
        return ["src/index.ts"];
      },
    });
  try {
    await claimNewWork(h.deps, state);
    await waitUntil(() => state.inflight.size === 0);

    assert.equal(h.state.calls.filter((c) => c.startsWith("fetch:")).length, 1, "fetch must run exactly once, never once per attempt");
    const startPoints = new Set(h.state.worktreeAddCalls.map((c) => c.startPoint));
    assert.equal(startPoints.size, 1, `every attempt must branch off the identical resolved base; got: ${[...startPoints].join(", ")}`);
    assert.equal(diffBaseSeen, [...startPoints][0], "the winner's diff must be checked against the SAME base every attempt branched from");
  } finally {
    h.cleanup();
  }
});

// ── l: the salt advances on EVERY re-claim, not just orphan repair ─────────

test("watch.fanout: the salt is probed from session rows, not from marker.attempt — an ordinary blocked->ready->re-claim (attempt never incremented) still gets a fresh base", async () => {
  const provider = new FakeProvider();
  // Simulates: a first fan-out already consumed issue-1-1..3 (a human
  // re-labeled the issue back to ready without reconcileOrphans ever
  // touching `attempt`).
  provider.addIssue("1", "Add a widget", "ready", { attempt: 0 });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const takenBases = new Set(["issue-1"]);
  const h = fanoutHarness({
    provider,
    codeHost,
    n: 3,
    adwIdsFree: (ids) => !takenBases.has(ids[0]!.replace(/-\d+$/, "")),
  });
  try {
    await claimNewWork(h.deps, state);
    await waitUntil(() => state.inflight.size === 0);
    assert.ok(h.dispatched.some((d) => d.adwId.startsWith("issue-1-r1-")), `expected the salted base issue-1-r1, got: ${h.dispatched.map((d) => d.adwId).join(", ")}`);
    assert.ok(!h.dispatched.some((d) => d.adwId.startsWith("issue-1-1") || d.adwId === "issue-1-2" || d.adwId === "issue-1-3"), "must not reuse the taken issue-1-* ids");
  } finally {
    h.cleanup();
  }
});

test("watch.fanout: marker.attempt=1 (the orphan-retry path) picks the SAME salted base as an ordinary re-claim over the same session rows — attempt is not an input to the probe", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a widget", "ready", { attempt: 1 });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const takenBases = new Set(["issue-1"]);
  const h = fanoutHarness({
    provider,
    codeHost,
    n: 3,
    adwIdsFree: (ids) => !takenBases.has(ids[0]!.replace(/-\d+$/, "")),
  });
  try {
    await claimNewWork(h.deps, state);
    await waitUntil(() => state.inflight.size === 0);
    assert.ok(h.dispatched.some((d) => d.adwId.startsWith("issue-1-r1-")), `expected issue-1-r1 regardless of marker.attempt, got: ${h.dispatched.map((d) => d.adwId).join(", ")}`);
  } finally {
    h.cleanup();
  }
});

// ── l2: the salt cap falls back rather than wedging ─────────────────────────

test("watch.fanout: the salt cap (8) falls back to a random base id rather than wedging the issue", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a widget");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const h = fanoutHarness({ provider, codeHost, n: 2, adwIdsFree: () => false });
  try {
    await claimNewWork(h.deps, state);
    await waitUntil(() => state.inflight.size === 0);
    assert.ok(h.dispatched.length > 0, "runBestOf must still run against the fallback base");
    assert.ok(
      h.dispatched.every((d) => /^issue-1-x[0-9a-z]{4}-\d$/.test(d.adwId)),
      `expected every dispatched adw_id to match the cap-fallback shape; got: ${h.dispatched.map((d) => d.adwId).join(", ")}`,
    );
    assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
  } finally {
    h.cleanup();
  }
});
