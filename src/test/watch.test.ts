import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  branchNameFor,
  claimNewWork,
  claimSpecs,
  createWatchState,
  finishReviews,
  reconcileOrphans,
  reconcileRefining,
  refineBranchNameFor,
  tick,
} from "../core/watch.js";
import type { GitHandle } from "../core/git_helper.js";
import type { ChainRunResult, RefineRunResult, WatchDeps } from "../core/watch.js";
import type { NotifyEvent } from "../core/notify/channel.js";
import type {
  CodeHostProvider,
  EnsureLabelsResult,
  Issue,
  IssueProvider,
  PrRef,
  PrStatus,
  WatchMarker,
  WatchState,
} from "../core/issues/provider.js";

interface FakeEntry {
  issue: Issue;
  state: WatchState;
  marker: WatchMarker | null;
}

/** In-memory fake — exactly the seam `provider.ts` exists for. */
class FakeProvider implements IssueProvider {
  entries = new Map<string, FakeEntry>();
  ensureLabelsCalls = 0;
  transitions: Array<{ id: string; to: WatchState; detail?: string }> = [];
  claimCalls: string[] = [];

  addIssue(id: string, title: string, state: WatchState = "ready", marker: WatchMarker | null = null): void {
    this.entries.set(id, { issue: { id, title, body: "", labels: [`spf:${state}`] }, state, marker });
  }

  async ensureLabels(): Promise<EnsureLabelsResult> {
    this.ensureLabelsCalls++;
    return { created: [], updated: [], unchanged: [] };
  }
  async listEligible(): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => e.state === "ready").map((e) => e.issue);
  }
  async listInState(state: WatchState): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => e.state === state).map((e) => e.issue);
  }
  async claim(issue: Issue, opts?: { from?: WatchState; to?: WatchState }): Promise<boolean> {
    this.claimCalls.push(issue.id);
    const entry = this.entries.get(issue.id)!;
    const from = opts?.from ?? "ready";
    const to = opts?.to ?? "working";
    if (entry.state !== from) return false;
    entry.state = to;
    return true;
  }
  async transition(issue: Issue, to: WatchState, detail?: string): Promise<void> {
    this.entries.get(issue.id)!.state = to;
    this.transitions.push({ id: issue.id, to, detail });
  }
  async comment(_issue: Issue, _body: string): Promise<void> {}
  async readMarker(issue: Issue): Promise<WatchMarker | null> {
    return this.entries.get(issue.id)?.marker ?? null;
  }
  async writeMarker(issue: Issue, marker: WatchMarker): Promise<void> {
    this.entries.get(issue.id)!.marker = marker;
  }
}

/** In-memory fake `CodeHostProvider` — separate from `FakeProvider`, mirroring the real split. */
class FakeCodeHost implements CodeHostProvider {
  prs = new Map<number, PrStatus>();
  openedPrs: Array<{ title: string; branch: string }> = [];
  nextPrNumber = 1000;

  async openPr(opts: { branch: string; title: string }): Promise<PrRef> {
    const number = this.nextPrNumber++;
    this.openedPrs.push({ title: opts.title, branch: opts.branch });
    this.prs.set(number, { merged: false, state: "open", ciStatus: "pending" });
    return { number, branch: opts.branch, url: `https://example.invalid/pr/${number}` };
  }
  async prStatus(pr: PrRef): Promise<PrStatus> {
    return this.prs.get(pr.number) ?? { merged: false, state: "open", ciStatus: "pending" };
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

function makeDeps(provider: FakeProvider, codeHost: FakeCodeHost, overrides: Partial<WatchDeps> = {}): WatchDeps {
  return {
    provider,
    codeHost,
    git: fakeGit(),
    worktreeGit: () => fakeGit({ diffFiles: () => ["src/index.ts"] }), // a real commit landed, by default
    labelPrefix: "spf",
    chain: "plan-build-test",
    baseBranch: "main",
    concurrency: 2,
    // Off by default, like WatchRefineConfigSchema itself — a test that
    // doesn't override these never touches the refine lane at all.
    refineEnabled: false,
    refineConcurrency: 1,
    refineChain: "refine",
    runRefine: async (opts): Promise<RefineRunResult> => ({ accepted: true, adwId: opts.adwId, detail: "", created: [] }),
    worktreesDir: "/tmp/spf-watch-test-worktrees",
    linkDataDir: () => {},
    dryRun: false,
    runChain: async (): Promise<ChainRunResult> => ({ accepted: true, adwId: "issue-1", detail: "" }),
    log: () => {},
    notify: () => {},
    ...overrides,
  };
}

/** Collects every `deps.notify(...)` call, for asserting kinds/levels without a real channel. */
function collectNotifications(): { events: NotifyEvent[]; notify: (event: NotifyEvent) => void } {
  const events: NotifyEvent[] = [];
  return { events, notify: (event) => events.push(event) };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("branchNameFor: sanitizes a title into a safe branch name", () => {
  assert.equal(branchNameFor({ id: "42", title: "Add a /health endpoint!!", body: "", labels: [] }), "spf-watch/42-add-a-health-endpoint");
  assert.equal(branchNameFor({ id: "7", title: "", body: "", labels: [] }), "spf-watch/7-issue");
  assert.equal(branchNameFor({ id: "PROJ-123", title: "Fix the thing", body: "", labels: [] }), "spf-watch/PROJ-123-fix-the-thing");
});

test("claimNewWork: clears a stale worktree/branch from a killed prior attempt before creating a fresh one", async () => {
  const provider = new FakeProvider();
  provider.addIssue("2", "Retry me");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const calls: string[] = [];
  // Simulates a `spf watch` process killed mid-run for this exact issue: a
  // real `git.worktreeAdd` would refuse outright with "fatal: a branch
  // named '...' already exists" until the leftover branch is cleared.
  let branchExists = true;
  const deps = makeDeps(provider, codeHost, {
    git: fakeGit({
      worktreeRemove: (p) => calls.push(`remove:${p}`),
      deleteLocalBranch: (n) => {
        calls.push(`delete-branch:${n}`);
        branchExists = false;
      },
      worktreeAdd: (p, b) => {
        if (branchExists) throw new Error(`fatal: a branch named '${b}' already exists`);
        calls.push(`add:${p}`);
      },
    }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  const branchIdx = calls.findIndex((c) => c.startsWith("delete-branch:"));
  const addIdx = calls.findIndex((c) => c.startsWith("add:"));
  assert.ok(branchIdx !== -1 && addIdx !== -1 && branchIdx < addIdx, `expected the stale branch cleared before worktreeAdd, got: ${calls.join(", ")}`);
  // The retry then succeeds normally, same as any other claim.
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
});

test("claimNewWork: claims a ready issue, runs the chain, opens a PR, and moves to review", async () => {
  const provider = new FakeProvider();
  provider.addIssue("1", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const linkedWorktrees: string[] = [];
  const deps = makeDeps(provider, codeHost, { linkDataDir: (worktreePath) => linkedWorktrees.push(worktreePath) });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(provider.claimCalls, ["1"]);
  assert.equal(codeHost.openedPrs.length, 1);
  assert.match(codeHost.openedPrs[0]!.title, /^Add a \/health endpoint \(1\)/);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
  assert.equal(provider.entries.get("1")!.marker?.pr, 1000);
  // linkDataDir must run before the chain does — otherwise the run's own
  // session/trace data resolves into the worktree's throwaway .spf/data
  // instead of the main repo's persistent one (invisible in spf ui, and
  // deleted along with the worktree on cleanup).
  assert.deepEqual(linkedWorktrees, [path.join(deps.worktreesDir, "issue-1")]);
});

test("claimNewWork: a rejected chain run blocks the issue with the failure detail", async () => {
  const provider = new FakeProvider();
  provider.addIssue("2", "Flaky feature");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    runChain: async () => ({ accepted: false, adwId: "issue-2", detail: "build-test failed at phase build" }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(provider.transitions, [{ id: "2", to: "blocked", detail: "build-test failed at phase build" }]);
  assert.equal(codeHost.openedPrs.length, 0);
});

test("claimNewWork: an accepted run with nothing committed also blocks, without opening a PR", async () => {
  const provider = new FakeProvider();
  provider.addIssue("3", "No-op request");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, { worktreeGit: () => fakeGit({ diffFiles: () => [] }) });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.equal(provider.transitions[0]?.to, "blocked");
  assert.match(provider.transitions[0]?.detail ?? "", /no committed changes/);
  assert.equal(codeHost.openedPrs.length, 0);
});

test("claimNewWork: never claims more than the concurrency budget in one tick", async () => {
  const provider = new FakeProvider();
  provider.addIssue("10", "one");
  provider.addIssue("11", "two");
  provider.addIssue("12", "three");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  // A runChain that never resolves keeps every claimed issue "inflight" for this assertion.
  const deps = makeDeps(provider, codeHost, { concurrency: 2, runChain: () => new Promise(() => {}) });

  await claimNewWork(deps, state);
  assert.equal(state.inflight.size, 2);
  assert.equal(provider.claimCalls.length, 2);
});

test("claimNewWork: dry-run claims nothing and calls neither claim() nor runChain", async () => {
  const provider = new FakeProvider();
  provider.addIssue("20", "dry run me");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let runChainCalled = false;
  const deps = makeDeps(provider, codeHost, {
    dryRun: true,
    runChain: async () => {
      runChainCalled = true;
      return { accepted: true, adwId: "x", detail: "" };
    },
  });

  await claimNewWork(deps, state);
  assert.equal(provider.claimCalls.length, 0);
  assert.equal(runChainCalled, false);
  assert.equal(provider.entries.get("20")!.state, "ready");
});

test("reconcileOrphans: a working issue with an open PR in its marker resumes as review", async () => {
  const provider = new FakeProvider();
  provider.addIssue("30", "orphaned mid-review", "working", { pr: 500, branch: "spf-watch/30-x" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(500, { merged: false, state: "open", ciStatus: "pending" });
  const state = createWatchState();

  await reconcileOrphans(makeDeps(provider, codeHost), state);

  assert.deepEqual(provider.transitions, [{ id: "30", to: "review", detail: undefined }]);
});

test("reconcileOrphans: a working issue with no marker retries up to the cap, then blocks", async () => {
  const provider = new FakeProvider();
  provider.addIssue("31", "orphaned, no marker", "working", null);
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost);

  await reconcileOrphans(deps, state); // attempt 1 -> ready
  assert.equal(provider.entries.get("31")!.state, "ready");
  assert.equal(provider.entries.get("31")!.marker?.attempt, 1);

  provider.entries.get("31")!.state = "working"; // simulate it getting re-claimed and orphaned again
  await reconcileOrphans(deps, state); // attempt 2 -> ready
  assert.equal(provider.entries.get("31")!.state, "ready");

  provider.entries.get("31")!.state = "working";
  await reconcileOrphans(deps, state); // attempt 3 exceeds MAX_ORPHAN_ATTEMPTS (2) -> blocked
  assert.equal(provider.entries.get("31")!.state, "blocked");
  assert.match(provider.transitions.at(-1)?.detail ?? "", /Gave up after 2 orphaned attempts/);
});

test("reconcileOrphans: skips issues this process is already tracking as in-flight", async () => {
  const provider = new FakeProvider();
  provider.addIssue("32", "actually still running", "working", null);
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  state.inflight.add("32");

  await reconcileOrphans(makeDeps(provider, codeHost), state);

  assert.equal(provider.transitions.length, 0, "an in-flight issue must not be treated as orphaned");
});

test("finishReviews: a merged PR moves the issue to done", async () => {
  const provider = new FakeProvider();
  provider.addIssue("40", "shipped", "review", { pr: 600, branch: "spf-watch/40-x" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(600, { merged: true, state: "closed", ciStatus: "success" });

  await finishReviews(makeDeps(provider, codeHost));

  assert.deepEqual(provider.transitions, [{ id: "40", to: "done", detail: undefined }]);
});

test("finishReviews: a closed-without-merging PR blocks the issue", async () => {
  const provider = new FakeProvider();
  provider.addIssue("41", "rejected", "review", { pr: 601, branch: "spf-watch/41-x" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(601, { merged: false, state: "closed", ciStatus: "failure" });

  await finishReviews(makeDeps(provider, codeHost));

  assert.equal(provider.transitions[0]?.to, "blocked");
  assert.match(provider.transitions[0]?.detail ?? "", /closed without merging/);
});

test("finishReviews: a still-open PR leaves the issue in review", async () => {
  const provider = new FakeProvider();
  provider.addIssue("42", "still cooking", "review", { pr: 602, branch: "spf-watch/42-x" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(602, { merged: false, state: "open", ciStatus: "pending" });

  await finishReviews(makeDeps(provider, codeHost));

  assert.equal(provider.transitions.length, 0);
  assert.equal(provider.entries.get("42")!.state, "review");
});

// ── notifications ────────────────────────────────────────────────────────────

test("claim -> PR opened -> merged fires issue_claimed, pr_opened, then issue_done (all info-level)", async () => {
  const provider = new FakeProvider();
  provider.addIssue("50", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, { notify });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);
  assert.deepEqual(events.map((e) => e.kind), ["issue_claimed", "pr_opened"]);
  assert.ok(events.every((e) => e.level === "info"));

  codeHost.prs.set(1000, { merged: true, state: "closed", ciStatus: "success" });
  await finishReviews(deps);
  assert.deepEqual(events.map((e) => e.kind), ["issue_claimed", "pr_opened", "issue_done"]);
  assert.equal(events.at(-1)!.level, "info");
});

test("a rejected chain run fires issue_blocked at error level", async () => {
  const provider = new FakeProvider();
  provider.addIssue("51", "Flaky feature");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, {
    notify,
    runChain: async () => ({ accepted: false, adwId: "issue-51", detail: "build-test failed" }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  const blocked = events.filter((e) => e.kind === "issue_blocked");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]!.level, "error");
  assert.equal(blocked[0]!.detail, "build-test failed");
});

test("an accepted run with nothing committed fires issue_blocked", async () => {
  const provider = new FakeProvider();
  provider.addIssue("52", "No-op request");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, { notify, worktreeGit: () => fakeGit({ diffFiles: () => [] }) });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(events.map((e) => e.kind), ["issue_claimed", "issue_blocked"]);
  assert.match(events[1]!.detail ?? "", /no committed changes/);
});

test("an exception mid-runIssue fires watch_error at error level", async () => {
  const provider = new FakeProvider();
  provider.addIssue("53", "Explodes");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, {
    notify,
    runChain: async () => {
      throw new Error("kaboom");
    },
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  const errors = events.filter((e) => e.kind === "watch_error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.level, "error");
  assert.match(errors[0]!.detail ?? "", /kaboom/);
});

test("finishReviews: a closed-without-merging PR fires issue_blocked", async () => {
  const provider = new FakeProvider();
  provider.addIssue("54", "rejected", "review", { pr: 700, branch: "spf-watch/54-x" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(700, { merged: false, state: "closed", ciStatus: "failure" });
  const { events, notify } = collectNotifications();

  await finishReviews(makeDeps(provider, codeHost, { notify }));

  assert.deepEqual(events.map((e) => e.kind), ["issue_blocked"]);
  assert.equal(events[0]!.level, "error");
});

test("reconcileOrphans: giving up past the retry cap fires issue_blocked", async () => {
  const provider = new FakeProvider();
  provider.addIssue("55", "orphaned, no marker", "working", { attempt: 2 }); // one more push exceeds MAX_ORPHAN_ATTEMPTS (2)
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();

  await reconcileOrphans(makeDeps(provider, codeHost, { notify }), state);

  assert.deepEqual(events.map((e) => e.kind), ["issue_blocked"]);
  assert.match(events[0]!.detail ?? "", /Gave up after 2 orphaned attempts/);
});

test("reconcileOrphans: a routine orphan resume/retry notifies nothing — only the terminal give-up does", async () => {
  const provider = new FakeProvider();
  provider.addIssue("56", "orphaned, resumable", "working", { pr: 800, branch: "spf-watch/56-x" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(800, { merged: false, state: "open", ciStatus: "pending" });
  const state = createWatchState();
  const { events, notify } = collectNotifications();

  await reconcileOrphans(makeDeps(provider, codeHost, { notify }), state);

  assert.deepEqual(events, []);
});

// ── the refine lane ──────────────────────────────────────────────────────

test("refineBranchNameFor: same sanitizer as branchNameFor, different prefix", () => {
  assert.equal(refineBranchNameFor({ id: "9", title: "Team invitations spec", body: "", labels: [] }), "spf-refine/9-team-invitations-spec");
});

test("claimSpecs: a disabled refine lane never lists spec-ready issues or claims anything", async () => {
  const provider = new FakeProvider();
  provider.addIssue("100", "A spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  provider.listInState = async () => {
    throw new Error("listInState should never be called when refineEnabled is false");
  };

  await claimSpecs(makeDeps(provider, codeHost, { refineEnabled: false }), state);

  assert.equal(provider.claimCalls.length, 0);
});

test("claimSpecs: claims a spec-ready spec, publishes, and finishes it to done with a summary comment", async () => {
  const provider = new FakeProvider();
  provider.addIssue("101", "Team invitations", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const comments: Array<{ id: string; body: string }> = [];
  provider.comment = async (issue, body) => {
    comments.push({ id: issue.id, body });
  };
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => ({
      accepted: true,
      adwId: opts.adwId,
      detail: "",
      created: [
        { id: "200", title: "Owner invites by email", kind: "story", isLeaf: true },
        { id: "199", title: "Invitations feature", kind: "feature", isLeaf: false },
      ],
    }),
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.deepEqual(provider.claimCalls, ["101"]);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["done"]);
  assert.equal(comments.length, 1);
  assert.match(comments[0]!.body, /#200 \(story\): Owner invites by email/);
  assert.deepEqual(provider.entries.get("101")!.marker?.refined, ["200", "199"]);
});

test("claimSpecs: never claims more than refineConcurrency in one tick, independent of the build lane's own budget", async () => {
  const provider = new FakeProvider();
  provider.addIssue("110", "one spec", "spec-ready");
  provider.addIssue("111", "two spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    refineConcurrency: 1,
    runRefine: () => new Promise(() => {}), // never resolves — keeps the claim "in flight" for this assertion
  });

  await claimSpecs(deps, state);
  assert.equal(state.refining.size, 1);
  assert.equal(provider.claimCalls.length, 1);
});

test("claimSpecs: dry-run claims no spec and never calls runRefine", async () => {
  const provider = new FakeProvider();
  provider.addIssue("120", "dry run spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let called = false;
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    dryRun: true,
    runRefine: async (opts) => {
      called = true;
      return { accepted: true, adwId: opts.adwId, detail: "", created: [] };
    },
  });

  await claimSpecs(deps, state);
  assert.equal(provider.claimCalls.length, 0);
  assert.equal(called, false);
  assert.equal(provider.entries.get("120")!.state, "spec-ready");
});

test("claimSpecs: a rejected refine chain blocks the spec with the failure detail, without publishing anything", async () => {
  const provider = new FakeProvider();
  provider.addIssue("130", "unrefinable spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => ({ accepted: false, adwId: opts.adwId, detail: "refiner failed gates", created: [] }),
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.deepEqual(provider.transitions, [{ id: "130", to: "blocked", detail: "refiner failed gates" }]);
});

test("claimSpecs: a re-claimed spec whose marker already lists published issues skips runRefine entirely", async () => {
  const provider = new FakeProvider();
  provider.addIssue("140", "already published", "spec-ready", { refined: ["300", "301"] });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let called = false;
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => {
      called = true;
      return { accepted: true, adwId: opts.adwId, detail: "", created: [] };
    },
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.equal(called, false, "to-tickets itself has no idempotency guard — this is the one this lane adds");
  assert.deepEqual(provider.transitions.map((t) => t.to), ["done"]);
});

test("reconcileRefining: a refining spec whose marker already lists published issues finishes it without re-running the refiner", async () => {
  const provider = new FakeProvider();
  provider.addIssue("150", "orphaned after publish", "refining", { refined: ["400"] });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();

  await reconcileRefining(makeDeps(provider, codeHost, { refineEnabled: true }), state);

  assert.deepEqual(provider.transitions, [{ id: "150", to: "done", detail: undefined }]);
});

test("reconcileRefining: a refining spec with no marker retries up to the cap, then blocks", async () => {
  const provider = new FakeProvider();
  provider.addIssue("151", "orphaned, no marker", "refining", null);
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, { refineEnabled: true });

  await reconcileRefining(deps, state); // attempt 1 -> spec-ready
  assert.equal(provider.entries.get("151")!.state, "spec-ready");

  provider.entries.get("151")!.state = "refining";
  await reconcileRefining(deps, state); // attempt 2 -> spec-ready
  assert.equal(provider.entries.get("151")!.state, "spec-ready");

  provider.entries.get("151")!.state = "refining";
  await reconcileRefining(deps, state); // attempt 3 exceeds MAX_ORPHAN_ATTEMPTS (2) -> blocked
  assert.equal(provider.entries.get("151")!.state, "blocked");
  assert.match(provider.transitions.at(-1)?.detail ?? "", /Gave up after 2 orphaned refine attempts/);
});

test("reconcileRefining: a disabled refine lane is a complete no-op", async () => {
  const provider = new FakeProvider();
  provider.addIssue("152", "should be ignored", "refining", null);
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  provider.listInState = async () => {
    throw new Error("listInState should never be called when refineEnabled is false");
  };

  await reconcileRefining(makeDeps(provider, codeHost, { refineEnabled: false }), state);

  assert.equal(provider.transitions.length, 0);
});

test("claim -> refine -> published fires issue_claimed then spec_refined, both info-level", async () => {
  const provider = new FakeProvider();
  provider.addIssue("160", "A spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    notify,
    runRefine: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", created: [{ id: "500", title: "A story", kind: "story", isLeaf: true }] }),
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.deepEqual(events.map((e) => e.kind), ["issue_claimed", "spec_refined"]);
  assert.ok(events.every((e) => e.level === "info"));
});

test("tick: a per-stage error is caught and fires exactly one watch_error", async () => {
  const provider = new FakeProvider();
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  provider.listEligible = async () => {
    throw new Error("listEligible exploded");
  };

  await tick(makeDeps(provider, codeHost, { notify }), state);

  assert.deepEqual(events.map((e) => e.kind), ["watch_error"]);
  assert.match(events[0]!.detail ?? "", /listEligible exploded/);
});
