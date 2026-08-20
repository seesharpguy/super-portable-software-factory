import { test } from "node:test";
import assert from "node:assert/strict";
import { branchNameFor, claimNewWork, createWatchState, finishReviews, reconcileOrphans } from "../core/watch.js";
import type { GitHandle } from "../core/git_helper.js";
import type { ChainRunResult, WatchDeps } from "../core/watch.js";
import type { Issue, IssueProvider, PrRef, PrStatus, WatchMarker, WatchState } from "../core/issues/provider.js";

interface FakeEntry {
  issue: Issue;
  state: WatchState;
  marker: WatchMarker | null;
}

/** In-memory fake — exactly the seam `provider.ts` exists for. */
class FakeProvider implements IssueProvider {
  entries = new Map<number, FakeEntry>();
  prs = new Map<number, PrStatus>();
  transitions: Array<{ number: number; to: WatchState; detail?: string }> = [];
  openedPrs: Array<{ issueNumber: number; branch: string }> = [];
  claimCalls: number[] = [];
  nextPrNumber = 1000;

  addIssue(number: number, title: string, state: WatchState = "ready", marker: WatchMarker | null = null): void {
    this.entries.set(number, { issue: { number, title, body: "", labels: [`spf:${state}`] }, state, marker });
  }

  async listEligible(): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => e.state === "ready").map((e) => e.issue);
  }
  async listInState(state: WatchState): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => e.state === state).map((e) => e.issue);
  }
  async claim(issue: Issue): Promise<boolean> {
    this.claimCalls.push(issue.number);
    const entry = this.entries.get(issue.number)!;
    if (entry.state !== "ready") return false;
    entry.state = "working";
    return true;
  }
  async transition(issue: Issue, to: WatchState, detail?: string): Promise<void> {
    this.entries.get(issue.number)!.state = to;
    this.transitions.push({ number: issue.number, to, detail });
  }
  async comment(): Promise<void> {}
  async openPr(issue: Issue, opts: { branch: string }): Promise<PrRef> {
    const number = this.nextPrNumber++;
    this.openedPrs.push({ issueNumber: issue.number, branch: opts.branch });
    this.prs.set(number, { merged: false, state: "open", ciStatus: "pending" });
    return { number, branch: opts.branch, url: `https://example.invalid/pr/${number}` };
  }
  async prStatus(pr: PrRef): Promise<PrStatus> {
    return this.prs.get(pr.number) ?? { merged: false, state: "open", ciStatus: "pending" };
  }
  async readMarker(issue: Issue): Promise<WatchMarker | null> {
    return this.entries.get(issue.number)?.marker ?? null;
  }
  async writeMarker(issue: Issue, marker: WatchMarker): Promise<void> {
    this.entries.get(issue.number)!.marker = marker;
  }
}

function fakeGit(overrides: Partial<GitHandle> = {}): GitHandle {
  return {
    currentBranch: () => "main",
    createBranch: (n) => n,
    isRepo: () => true,
    commitAll: () => "abc123",
    changedFiles: () => [],
    refExists: () => true,
    rev: () => "abc123",
    shortSha: () => "abc123",
    mergeBase: () => "abc123",
    isDirty: () => false,
    untrackedFiles: () => [],
    diffFiles: () => [],
    diffStat: () => "",
    diffCounts: () => [0, 0],
    diffText: () => "",
    fetch: () => {},
    worktreeAdd: () => {},
    worktreeRemove: () => {},
    deleteLocalBranch: () => {},
    push: () => {},
    ...overrides,
  };
}

function makeDeps(provider: FakeProvider, overrides: Partial<WatchDeps> = {}): WatchDeps {
  return {
    provider,
    git: fakeGit(),
    worktreeGit: () => fakeGit({ diffFiles: () => ["src/index.ts"] }), // a real commit landed, by default
    labelPrefix: "spf",
    chain: "plan-build-test",
    baseBranch: "main",
    concurrency: 2,
    worktreesDir: "/tmp/spf-watch-test-worktrees",
    dryRun: false,
    runChain: async (): Promise<ChainRunResult> => ({ accepted: true, adwId: "issue-1", detail: "" }),
    log: () => {},
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

test("branchNameFor: sanitizes a title into a safe branch name", () => {
  assert.equal(branchNameFor({ number: 42, title: "Add a /health endpoint!!", body: "", labels: [] }), "spf-watch/42-add-a-health-endpoint");
  assert.equal(branchNameFor({ number: 7, title: "", body: "", labels: [] }), "spf-watch/7-issue");
});

test("claimNewWork: claims a ready issue, runs the chain, opens a PR, and moves to review", async () => {
  const provider = new FakeProvider();
  provider.addIssue(1, "Add a /health endpoint");
  const state = createWatchState();
  const deps = makeDeps(provider);

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(provider.claimCalls, [1]);
  assert.equal(provider.openedPrs.length, 1);
  assert.equal(provider.openedPrs[0]!.issueNumber, 1);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
  assert.equal(provider.entries.get(1)!.marker?.pr, 1000);
});

test("claimNewWork: a rejected chain run blocks the issue with the failure detail", async () => {
  const provider = new FakeProvider();
  provider.addIssue(2, "Flaky feature");
  const state = createWatchState();
  const deps = makeDeps(provider, {
    runChain: async () => ({ accepted: false, adwId: "issue-2", detail: "build-test failed at phase build" }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(provider.transitions, [{ number: 2, to: "blocked", detail: "build-test failed at phase build" }]);
  assert.equal(provider.openedPrs.length, 0);
});

test("claimNewWork: an accepted run with nothing committed also blocks, without opening a PR", async () => {
  const provider = new FakeProvider();
  provider.addIssue(3, "No-op request");
  const state = createWatchState();
  const deps = makeDeps(provider, { worktreeGit: () => fakeGit({ diffFiles: () => [] }) });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.equal(provider.transitions[0]?.to, "blocked");
  assert.match(provider.transitions[0]?.detail ?? "", /no committed changes/);
  assert.equal(provider.openedPrs.length, 0);
});

test("claimNewWork: never claims more than the concurrency budget in one tick", async () => {
  const provider = new FakeProvider();
  provider.addIssue(10, "one");
  provider.addIssue(11, "two");
  provider.addIssue(12, "three");
  const state = createWatchState();
  // A runChain that never resolves keeps every claimed issue "inflight" for this assertion.
  const deps = makeDeps(provider, { concurrency: 2, runChain: () => new Promise(() => {}) });

  await claimNewWork(deps, state);
  assert.equal(state.inflight.size, 2);
  assert.equal(provider.claimCalls.length, 2);
});

test("claimNewWork: dry-run claims nothing and calls neither claim() nor runChain", async () => {
  const provider = new FakeProvider();
  provider.addIssue(20, "dry run me");
  const state = createWatchState();
  let runChainCalled = false;
  const deps = makeDeps(provider, {
    dryRun: true,
    runChain: async () => {
      runChainCalled = true;
      return { accepted: true, adwId: "x", detail: "" };
    },
  });

  await claimNewWork(deps, state);
  assert.equal(provider.claimCalls.length, 0);
  assert.equal(runChainCalled, false);
  assert.equal(provider.entries.get(20)!.state, "ready");
});

test("reconcileOrphans: a working issue with an open PR in its marker resumes as review", async () => {
  const provider = new FakeProvider();
  provider.addIssue(30, "orphaned mid-review", "working", { pr: 500, branch: "spf-watch/30-x" });
  provider.prs.set(500, { merged: false, state: "open", ciStatus: "pending" });
  const state = createWatchState();

  await reconcileOrphans(makeDeps(provider), state);

  assert.deepEqual(provider.transitions, [{ number: 30, to: "review", detail: undefined }]);
});

test("reconcileOrphans: a working issue with no marker retries up to the cap, then blocks", async () => {
  const provider = new FakeProvider();
  provider.addIssue(31, "orphaned, no marker", "working", null);
  const state = createWatchState();
  const deps = makeDeps(provider);

  await reconcileOrphans(deps, state); // attempt 1 -> ready
  assert.equal(provider.entries.get(31)!.state, "ready");
  assert.equal(provider.entries.get(31)!.marker?.attempt, 1);

  provider.entries.get(31)!.state = "working"; // simulate it getting re-claimed and orphaned again
  await reconcileOrphans(deps, state); // attempt 2 -> ready
  assert.equal(provider.entries.get(31)!.state, "ready");

  provider.entries.get(31)!.state = "working";
  await reconcileOrphans(deps, state); // attempt 3 exceeds MAX_ORPHAN_ATTEMPTS (2) -> blocked
  assert.equal(provider.entries.get(31)!.state, "blocked");
  assert.match(provider.transitions.at(-1)?.detail ?? "", /Gave up after 2 orphaned attempts/);
});

test("reconcileOrphans: skips issues this process is already tracking as in-flight", async () => {
  const provider = new FakeProvider();
  provider.addIssue(32, "actually still running", "working", null);
  const state = createWatchState();
  state.inflight.add(32);

  await reconcileOrphans(makeDeps(provider), state);

  assert.equal(provider.transitions.length, 0, "an in-flight issue must not be treated as orphaned");
});

test("finishReviews: a merged PR moves the issue to done", async () => {
  const provider = new FakeProvider();
  provider.addIssue(40, "shipped", "review", { pr: 600, branch: "spf-watch/40-x" });
  provider.prs.set(600, { merged: true, state: "closed", ciStatus: "success" });

  await finishReviews(makeDeps(provider));

  assert.deepEqual(provider.transitions, [{ number: 40, to: "done", detail: undefined }]);
});

test("finishReviews: a closed-without-merging PR blocks the issue", async () => {
  const provider = new FakeProvider();
  provider.addIssue(41, "rejected", "review", { pr: 601, branch: "spf-watch/41-x" });
  provider.prs.set(601, { merged: false, state: "closed", ciStatus: "failure" });

  await finishReviews(makeDeps(provider));

  assert.equal(provider.transitions[0]?.to, "blocked");
  assert.match(provider.transitions[0]?.detail ?? "", /closed without merging/);
});

test("finishReviews: a still-open PR leaves the issue in review", async () => {
  const provider = new FakeProvider();
  provider.addIssue(42, "still cooking", "review", { pr: 602, branch: "spf-watch/42-x" });
  provider.prs.set(602, { merged: false, state: "open", ciStatus: "pending" });

  await finishReviews(makeDeps(provider));

  assert.equal(provider.transitions.length, 0);
  assert.equal(provider.entries.get(42)!.state, "review");
});
