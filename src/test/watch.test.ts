import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  branchNameFor,
  buildSpecPrompt,
  claimNewWork,
  claimSpecs,
  createWatchState,
  finishReviews,
  finishTrackedSpecs,
  issueLockPath,
  orderEligible,
  reconcileOrphans,
  reconcileRefining,
  refineBranchNameFor,
  tick,
} from "../core/watch.js";
import { parseRefineMarker } from "../core/refine.js";
import { acquirePidLock, releasePidLock } from "../core/utils.js";
import type { GitHandle } from "../core/git_helper.js";
import type { ChainRunResult, RefineRunResult, WatchDeps } from "../core/watch.js";
import type { NotifyEvent } from "../core/notify/channel.js";
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
import { escapeForMarkup, formatReviewDigest, truncateDigest } from "../cli/commands/watch.js";
import type { ReviewOutputT } from "../core/data_types.js";

/** A minimal, schema-shaped ReviewOutputT — only the fields formatReviewDigest reads. */
function reviewOutput(overrides: Partial<ReviewOutputT> = {}): ReviewOutputT {
  return {
    status: "success",
    summary: "",
    artifacts: [],
    notes_for_next_agent: "",
    approved: false,
    findings: [],
    blocking: [],
    ...overrides,
  };
}

interface FakeEntry {
  issue: Issue;
  state: WatchState;
  marker: WatchMarker | null;
  comments: IssueComment[];
}

/** Every `<prefix>:<state>` label `transition()`/`claim()` strip before adding one — mirrors `github_provider.ts`'s own `STATES` (not exported, so duplicated here; a self-contained test fixture already hardcodes the "spf" prefix throughout this file). */
const FAKE_STATE_LABELS = new Set(
  (["ready", "working", "review", "done", "blocked", "spec-ready", "refining", "refined", "needs-feedback", "continue-refinement"] as const).map(
    (s) => `spf:${s}`,
  ),
);

/** In-memory fake — exactly the seam `provider.ts` exists for. */
class FakeProvider implements IssueProvider {
  entries = new Map<string, FakeEntry>();
  ensureLabelsCalls = 0;
  transitions: Array<{ id: string; to: WatchState; detail?: string }> = [];
  claimCalls: string[] = [];
  closedIssues: string[] = [];
  /** Set to make `closeIssue` reject — for asserting a failed close never blocks `finishSpec`/`finishReviews`/`rollUp`. */
  closeIssueError: Error | null = null;
  private nextCommentSeq = 1;

  /**
   * `opts.body` lets a test embed a hidden `spf-refine:` marker (parent,
   * blocked_by, priority) the same way `core/refine.ts`'s `renderBody()`
   * would — see this file's `markerBody()` helper. `opts.extraLabels` lets a
   * test add a `spf:priority:pN` (or any other) label alongside the state
   * label `addIssue` always sets.
   */
  addIssue(id: string, title: string, state: WatchState = "ready", marker: WatchMarker | null = null, opts: { body?: string; extraLabels?: string[] } = {}): void {
    this.entries.set(id, {
      issue: { id, title, body: opts.body ?? "", labels: [`spf:${state}`, ...(opts.extraLabels ?? [])] },
      state,
      marker,
      comments: [],
    });
  }

  /**
   * Seed a comment directly onto an issue's thread — the fake's equivalent of
   * a human (or a prior `spf watch` run) posting on the tracker, for tests
   * that need a resumed run's `listComments` to see it. `createdAt` defaults
   * to a synthetic, strictly-increasing timestamp (not the real clock) so
   * ordering across several `addComment` calls in one test is deterministic.
   */
  addComment(issueId: string, author: string, body: string, createdAt?: string): void {
    const entry = this.entries.get(issueId)!;
    const created_at = createdAt ?? new Date(this.nextCommentSeq * 1000).toISOString();
    entry.comments.push({ id: String(this.nextCommentSeq++), author, created_at, body });
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
  /** Relabels on a successful claim, like the real providers do — the frontier check (`getIssue`) and `orderEligible` both read labels, not `entry.state`, so a fake that only moved `entry.state` would silently pass a blocker check it shouldn't. */
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
  async comment(issue: Issue, body: string): Promise<void> {
    this.addComment(issue.id, "spf", body);
  }
  async readMarker(issue: Issue): Promise<WatchMarker | null> {
    return this.entries.get(issue.id)?.marker ?? null;
  }
  async writeMarker(issue: Issue, marker: WatchMarker): Promise<void> {
    this.entries.get(issue.id)!.marker = marker;
  }
  async listComments(issue: Issue): Promise<IssueComment[]> {
    return this.entries.get(issue.id)?.comments ?? [];
  }
  async closeIssue(issue: Issue): Promise<void> {
    if (this.closeIssueError) throw this.closeIssueError;
    this.closedIssues.push(issue.id);
  }
  async getIssue(id: string): Promise<Issue | null> {
    return this.entries.get(id)?.issue ?? null;
  }
  /**
   * Not part of `IssueProvider` — `listChildren` lives on
   * `IssueAuthoringProvider` instead (GitHub and Jira both implement it in
   * production; see `provider.ts`'s doc comment), so this is a plain
   * convenience a roll-up test wires directly into `WatchDeps.listChildren`
   * (`{ listChildren: (parent) => provider.listChildren(parent) }`), mirroring
   * how `cli/commands/watch.ts` wires whichever real provider is
   * authoring-capable. Reads the same hidden `spf-refine:` marker
   * `getIssue`/`orderEligible` do.
   */
  async listChildren(parent: Issue): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => parseRefineMarker(e.issue.body).parent === parent.id).map((e) => e.issue);
  }
}

/** In-memory fake `CodeHostProvider` — separate from `FakeProvider`, mirroring the real split. */
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
    // `{}` by default, like WatchConfigSchema's own default — a test that
    // doesn't override this never sees a chainOptions field at all in what
    // runChain/runRefine receive.
    chainOptions: {},
    // Off by default, like WatchRefineConfigSchema itself — a test that
    // doesn't override these never touches the refine lane at all.
    refineEnabled: false,
    refineConcurrency: 1,
    refineChain: "refine",
    runRefine: async (opts): Promise<RefineRunResult> => ({ accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [] }),
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

/** The exact hidden-block shape `core/refine.ts`'s `renderBody()` writes and `parseRefineMarker` reads back — see `refine.test.ts`'s own round-trip coverage of that encoding. A test-only shortcut for embedding one directly in a fake issue's `body`, without going through `publish()`. */
function markerBody(marker: { parent?: string | null; blocked_by?: string[]; priority?: string } = {}): string {
  return `<!-- spf-refine: ${JSON.stringify({ parent: marker.parent ?? null, blocked_by: marker.blocked_by ?? [], priority: marker.priority ?? "p2" })} -->`;
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

test("claimNewWork: an issue already locked by a live process is skipped before ever calling provider.claim()", async () => {
  const provider = new FakeProvider();
  provider.addIssue("21", "already being worked elsewhere");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost);
  const lockPath = issueLockPath(deps, "issue-21");
  // Simulates a second `spf watch` process racing this one: something else
  // (this same test process's own pid always reads as alive) already holds
  // the per-issue lock claimNewWork must check before ever touching the
  // tracker — see core/watch.ts's issueLockPath doc comment.
  assert.equal(acquirePidLock(lockPath).ok, true);
  try {
    await claimNewWork(deps, state);
    assert.equal(provider.claimCalls.length, 0, "provider.claim() must never be reached while the lock is held");
    assert.equal(provider.entries.get("21")!.state, "ready");
  } finally {
    releasePidLock(lockPath);
  }

  // Once released, an ordinary tick claims it exactly like any other issue.
  await claimNewWork(deps, state);
  assert.deepEqual(provider.claimCalls, ["21"]);
});

// ── orderEligible: priority, sibling affinity, created-asc ──────────────

function issue(id: string, opts: { labels?: string[]; body?: string } = {}): Issue {
  return { id, title: `issue ${id}`, body: opts.body ?? "", labels: opts.labels ?? [] };
}

test("orderEligible: p0 sorts ahead of p2 regardless of creation order", () => {
  const older = issue("1", { labels: ["spf:priority:p2"] });
  const newer = issue("2", { labels: ["spf:priority:p0"] });
  const ordered = orderEligible([older, newer], new Map(), "spf");
  assert.deepEqual(ordered.map((i) => i.id), ["2", "1"]);
});

test("orderEligible: sibling affinity breaks a tie within the same priority band, but never crosses bands", () => {
  const inflightParents = new Map([["100", "parent-A"]]); // issue 100 is in flight, its parent is parent-A
  const siblingOfInflight = issue("2", { labels: ["spf:priority:p2"], body: markerBody({ parent: "parent-A" }) });
  const unrelated = issue("1", { labels: ["spf:priority:p2"], body: markerBody({ parent: "parent-B" }) });
  const urgentUnrelated = issue("3", { labels: ["spf:priority:p0"], body: markerBody({ parent: "parent-B" }) });

  const ordered = orderEligible([unrelated, siblingOfInflight, urgentUnrelated], inflightParents, "spf");

  // p0 still wins outright, even though it has no affinity...
  assert.equal(ordered[0]!.id, "3");
  // ...but among the two p2 issues, the sibling of in-flight work goes first.
  assert.deepEqual(ordered.slice(1).map((i) => i.id), ["2", "1"]);
});

test("orderEligible: falls back to created (array) order as the final, stable tiebreaker", () => {
  const a = issue("1", { labels: ["spf:priority:p2"] });
  const b = issue("2", { labels: ["spf:priority:p2"] });
  const c = issue("3", { labels: ["spf:priority:p2"] });
  const ordered = orderEligible([a, b, c], new Map(), "spf");
  assert.deepEqual(ordered.map((i) => i.id), ["1", "2", "3"]);
});

test("orderEligible: a missing or corrupt marker sorts as p2 with no affinity, same as before this feature existed", () => {
  const noMarker = issue("1"); // no labels, no body at all
  const corrupt = issue("2", { body: "<!-- spf-refine: {not json -->" });
  const explicitP2 = issue("3", { labels: ["spf:priority:p2"] });
  const ordered = orderEligible([noMarker, corrupt, explicitP2], new Map(), "spf");
  assert.deepEqual(ordered.map((i) => i.id), ["1", "2", "3"], "all p2, so creation order alone decides");
});

test("orderEligible: the label wins over the marker when they disagree — a human relabel is the override mechanism", () => {
  // Published as p0 (what the marker still says), but a human relabeled it down to p3.
  const relabeled = issue("1", { labels: ["spf:priority:p3"], body: markerBody({ priority: "p0" }) });
  const stillP0 = issue("2", { labels: ["spf:priority:p0"], body: markerBody({ priority: "p0" }) });
  const ordered = orderEligible([relabeled, stillP0], new Map(), "spf");
  assert.deepEqual(ordered.map((i) => i.id), ["2", "1"], "the label, not the stale marker, decides");
});

// ── claimNewWork: the frontier — a blocker not yet spf:done is skipped ───

test("claimNewWork: an issue with an unfinished blocker is not claimed", async () => {
  const provider = new FakeProvider();
  provider.addIssue("11", "the blocker", "working"); // not done yet
  provider.addIssue("10", "blocked leaf", "ready", null, { body: markerBody({ blocked_by: ["11"] }) });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();

  await claimNewWork(makeDeps(provider, codeHost), state);

  assert.equal(provider.claimCalls.length, 0, "the blocker is not spf:done yet, so nothing is claimed at all");
  assert.equal(provider.entries.get("10")!.state, "ready");
});

test("claimNewWork: the same issue claims once its blocker carries spf:done", async () => {
  const provider = new FakeProvider();
  provider.addIssue("21", "the blocker", "done");
  provider.addIssue("20", "unblocked leaf", "ready", null, { body: markerBody({ blocked_by: ["21"] }) });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();

  await claimNewWork(makeDeps(provider, codeHost), state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(provider.claimCalls, ["20"]);
});

test("claimNewWork: a blocker that no longer exists (404) is treated as satisfied, not a permanent wedge", async () => {
  const provider = new FakeProvider();
  provider.addIssue("30", "leaf with a deleted blocker", "ready", null, { body: markerBody({ blocked_by: ["nonexistent"] }) });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();

  await claimNewWork(makeDeps(provider, codeHost), state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(provider.claimCalls, ["30"]);
});

test("claimNewWork: a blocker shared by two leaves is fetched at most once per tick", async () => {
  const provider = new FakeProvider();
  provider.addIssue("41", "the shared blocker", "done");
  provider.addIssue("40", "leaf one", "ready", null, { body: markerBody({ blocked_by: ["41"] }) });
  provider.addIssue("42", "leaf two", "ready", null, { body: markerBody({ blocked_by: ["41"] }) });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let getIssueCalls = 0;
  const realGetIssue = provider.getIssue.bind(provider);
  provider.getIssue = async (id) => {
    if (id === "41") getIssueCalls++;
    return realGetIssue(id);
  };

  await claimNewWork(makeDeps(provider, codeHost, { concurrency: 2 }), state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(provider.claimCalls.sort(), ["40", "42"]);
  assert.equal(getIssueCalls, 1, "the shared blocker is looked up once, not once per dependent");
});

// ── finishReviews: closes the leaf, and rolls a container up once every child is done ──

test("finishReviews: closes the issue when its PR merges", async () => {
  const provider = new FakeProvider();
  provider.addIssue("60", "shipped", "review", { pr: 610, branch: "spf-watch/60-x" });
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(610, { merged: true, state: "closed", ciStatus: "success" });

  await finishReviews(makeDeps(provider, codeHost));

  assert.deepEqual(provider.closedIssues, ["60"]);
});

test("finishReviews: a closeIssue rejection leaves the issue done and open, without blocking the tick", async () => {
  const provider = new FakeProvider();
  provider.addIssue("61", "shipped but close fails", "review", { pr: 611, branch: "spf-watch/61-x" });
  provider.closeIssueError = new Error("tracker unavailable");
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(611, { merged: true, state: "closed", ciStatus: "success" });

  await finishReviews(makeDeps(provider, codeHost));

  assert.equal(provider.entries.get("61")!.state, "done");
  assert.deepEqual(provider.closedIssues, [], "the failed close never reverted the transition");
});

test("finishReviews: rolls a container up to done + closed once every child is done", async () => {
  const provider = new FakeProvider();
  provider.addIssue("71", "child one", "done", null, { body: markerBody({ parent: "70" }) });
  provider.addIssue("72", "child two", "review", { pr: 620, branch: "spf-watch/72-x" }, { body: markerBody({ parent: "70" }) });
  provider.addIssue("70", "the feature", "working"); // containers never carry a build-lane state in production, but rollUp only reads its own labels
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(620, { merged: true, state: "closed", ciStatus: "success" });
  const { events, notify } = collectNotifications();

  await finishReviews(makeDeps(provider, codeHost, { notify, listChildren: (parent) => provider.listChildren(parent) }));

  assert.equal(provider.entries.get("72")!.state, "done", "the child that just landed");
  assert.equal(provider.entries.get("70")!.state, "done", "the container rolls up once its last child lands");
  assert.deepEqual(provider.closedIssues.sort(), ["70", "72"]);
  assert.ok(events.some((e) => e.kind === "feature_done" && e.title.includes("70")));
});

test("finishReviews: a container with one unfinished child does not roll up", async () => {
  const provider = new FakeProvider();
  provider.addIssue("81", "child one — still working", "working", null, { body: markerBody({ parent: "80" }) });
  provider.addIssue("82", "child two", "review", { pr: 621, branch: "spf-watch/82-x" }, { body: markerBody({ parent: "80" }) });
  provider.addIssue("80", "the feature");
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(621, { merged: true, state: "closed", ciStatus: "success" });

  await finishReviews(makeDeps(provider, codeHost, { listChildren: (parent) => provider.listChildren(parent) }));

  assert.equal(provider.entries.get("82")!.state, "done");
  assert.notEqual(provider.entries.get("80")!.state, "done", "child one is still working, so the container must not roll up yet");
  assert.deepEqual(provider.closedIssues, ["82"]);
});

test("finishReviews: a nested epic rolls up once its feature rolls up", async () => {
  const provider = new FakeProvider();
  provider.addIssue("91", "the only story", "review", { pr: 622, branch: "spf-watch/91-x" }, { body: markerBody({ parent: "90" }) });
  provider.addIssue("90", "the feature", "working", null, { body: markerBody({ parent: "9" }) });
  provider.addIssue("9", "the epic");
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(622, { merged: true, state: "closed", ciStatus: "success" });

  await finishReviews(makeDeps(provider, codeHost, { listChildren: (parent) => provider.listChildren(parent) }));

  assert.equal(provider.entries.get("90")!.state, "done", "the feature rolls up once its one story lands");
  assert.equal(provider.entries.get("9")!.state, "done", "the epic then rolls up too, once its feature is done");
  assert.deepEqual(provider.closedIssues.sort(), ["9", "90", "91"]);
});

test("finishReviews: a container already done is never re-processed", async () => {
  const provider = new FakeProvider();
  provider.addIssue("101", "child", "review", { pr: 623, branch: "spf-watch/101-x" }, { body: markerBody({ parent: "100" }) });
  provider.addIssue("100", "already-done feature", "done");
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(623, { merged: true, state: "closed", ciStatus: "success" });
  let listChildrenCalls = 0;
  const deps = makeDeps(provider, codeHost, {
    listChildren: (parent) => {
      listChildrenCalls++;
      return provider.listChildren(parent);
    },
  });

  await finishReviews(deps);

  assert.equal(listChildrenCalls, 0, "getIssue already saw spf:done on the container and returned before ever listing its children");
});

test("finishReviews: with no listChildren wired, roll-up is a logged no-op, not a failure", async () => {
  const provider = new FakeProvider();
  provider.addIssue("111", "child", "review", { pr: 624, branch: "spf-watch/111-x" }, { body: markerBody({ parent: "110" }) });
  provider.addIssue("110", "the feature");
  const codeHost = new FakeCodeHost();
  codeHost.prs.set(624, { merged: true, state: "closed", ciStatus: "success" });

  // makeDeps's default has no listChildren wired — any tracker without
  // authoring support (or a caller that simply didn't wire it) behaves
  // this way; GitHub and Jira both DO implement it in production.
  await finishReviews(makeDeps(provider, codeHost));

  assert.equal(provider.entries.get("111")!.state, "done", "the leaf itself still finishes normally");
  assert.notEqual(provider.entries.get("110")!.state, "done", "no listChildren means no roll-up is even attempted");
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

test("claim -> PR opened -> merged fires issue_claimed (info), pr_opened (notice), then issue_done (notice)", async () => {
  const provider = new FakeProvider();
  provider.addIssue("50", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, { notify });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);
  assert.deepEqual(events.map((e) => e.kind), ["issue_claimed", "pr_opened"]);
  // pr_opened is a standing ask for a human reviewer — same "needs a human"
  // bucket as issue_blocked's "notice", not a routine "info" milestone.
  assert.deepEqual(
    events.map((e) => e.level),
    ["info", "notice"],
  );

  codeHost.prs.set(1000, { merged: true, state: "closed", ciStatus: "success" });
  await finishReviews(deps);
  assert.deepEqual(events.map((e) => e.kind), ["issue_claimed", "pr_opened", "issue_done"]);
  assert.equal(events.at(-1)!.level, "notice");
});

test("a rejected chain run fires issue_blocked at notice level", async () => {
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
  assert.equal(blocked[0]!.level, "notice");
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
  assert.equal(events[0]!.level, "notice");
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

// ── the review digest threaded into the PR + pr_opened notification ────────

test("claimNewWork: a reviewSummary from runChain lands in the PR body and the pr_opened event's detail/fields", async () => {
  const provider = new FakeProvider();
  provider.addIssue("60", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, {
    notify,
    runChain: async (opts) => ({
      accepted: true,
      adwId: opts.adwId,
      detail: "",
      reviewRequired: true,
      reviewSummary: "Reviewer verdict: changes requested.\nBlocking:\n- add a test",
    }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.match(codeHost.openedPrs[0]!.body, /Automated by `spf watch`/);
  assert.match(codeHost.openedPrs[0]!.body, /Reviewer verdict: changes requested\.\nBlocking:\n- add a test/);
  const prOpened = events.find((e) => e.kind === "pr_opened")!;
  assert.equal(prOpened.detail, "Reviewer verdict: changes requested.\nBlocking:\n- add a test");
  assert.deepEqual(prOpened.fields.find(([k]) => k === "review"), ["review", "reviewed"]);
});

test("claimNewWork: a reviewer-required chain with no readable verdict says so, distinctly from no reviewer at all", async () => {
  const provider = new FakeProvider();
  provider.addIssue("61", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, {
    notify,
    runChain: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", reviewRequired: true }),
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.match(codeHost.openedPrs[0]!.body, /no verdict could be read back/);
  const prOpened = events.find((e) => e.kind === "pr_opened")!;
  assert.deepEqual(prOpened.fields.find(([k]) => k === "review"), ["review", "reviewer ran, no verdict"]);
});

test("claimNewWork: a chain with no reviewer step says nothing reviewed this change", async () => {
  const provider = new FakeProvider();
  provider.addIssue("62", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  // makeDeps' default runChain returns neither reviewRequired nor reviewSummary.
  const deps = makeDeps(provider, codeHost, { notify });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.match(codeHost.openedPrs[0]!.body, /Nothing reviewed this change — chain `plan-build-test` has no reviewer step\./);
  const prOpened = events.find((e) => e.kind === "pr_opened")!;
  assert.deepEqual(prOpened.fields.find(([k]) => k === "review"), ["review", "not reviewed"]);
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

test("claimSpecs: claims a spec-ready spec, publishes, and moves it to spec-in-progress with a summary comment — NOT done yet", async () => {
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
      questions: [],
    }),
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.deepEqual(provider.claimCalls, ["101"]);
  assert.deepEqual(provider.transitions.map((t) => t.to), ["spec-in-progress"], "published, but not done — nothing it produced has landed yet");
  assert.equal(comments.length, 1);
  assert.match(comments[0]!.body, /#200 \(story\): Owner invites by email/);
  assert.match(comments[0]!.body, /moves to `spf:done` once every one of them does/);
  assert.deepEqual(provider.closedIssues, [], "not closed — a PM watching this spec must not see it as finished yet");
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
      return { accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [] };
    },
  });

  await claimSpecs(deps, state);
  assert.equal(provider.claimCalls.length, 0);
  assert.equal(called, false);
  assert.equal(provider.entries.get("120")!.state, "spec-ready");
});

test("claimSpecs: a spec already locked by a live process is skipped before ever calling provider.claim() — the restart-overlap race", async () => {
  const provider = new FakeProvider();
  provider.addIssue("121", "a prior attempt is still running", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, { refineEnabled: true });
  const lockPath = issueLockPath(deps, "spec-121");
  // Simulates exactly what caused BT-1789's "declared artifact does not
  // exist" failure: `spf watch` restarted while an OLD process's runSpec for
  // this SAME spec (same deterministic worktree/context_handoff_dir — see
  // chains/steps.ts's clearStaleRefineOutputFiles doc comment) was still in
  // flight. Without this lock, both processes' claim() calls would succeed
  // and both would write into the same directory.
  assert.equal(acquirePidLock(lockPath).ok, true);
  try {
    await claimSpecs(deps, state);
    assert.equal(provider.claimCalls.length, 0, "provider.claim() must never be reached while the lock is held");
    assert.equal(provider.entries.get("121")!.state, "spec-ready");
  } finally {
    releasePidLock(lockPath);
  }

  await claimSpecs(deps, state);
  assert.deepEqual(provider.claimCalls, ["121"]);
});

test("claimSpecs: a rejected refine chain blocks the spec with the failure detail, without publishing anything", async () => {
  const provider = new FakeProvider();
  provider.addIssue("130", "unrefinable spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => ({ accepted: false, adwId: opts.adwId, detail: "refiner failed gates", created: [], questions: [] }),
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
      return { accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [] };
    },
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.equal(called, false, "to-tickets itself has no idempotency guard — this is the one this lane adds");
  assert.deepEqual(provider.transitions.map((t) => t.to), ["spec-in-progress"]);
});

test("reconcileRefining: a refining spec whose marker already lists published issues moves to spec-in-progress without re-running the refiner", async () => {
  const provider = new FakeProvider();
  provider.addIssue("150", "orphaned after publish", "refining", { refined: ["400"] });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();

  await reconcileRefining(makeDeps(provider, codeHost, { refineEnabled: true }), state);

  assert.deepEqual(provider.transitions, [{ id: "150", to: "spec-in-progress", detail: undefined }]);
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

test("reconcileRefining: a refining spec whose marker already has feedback finishes the transition to needs-feedback, without re-asking", async () => {
  const provider = new FakeProvider();
  // Simulates a crash between escalateSpec's writeMarker and its own
  // transition() call: the marker's feedback was written (and the question
  // comment posted) but the spec is still labeled "refining".
  provider.addIssue("153", "crashed mid-escalation", "refining", { feedback: { rounds: 1, asked_at: new Date(1000).toISOString() } });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();

  await reconcileRefining(makeDeps(provider, codeHost, { refineEnabled: true, notify }), state);

  assert.deepEqual(provider.transitions, [{ id: "153", to: "needs-feedback", detail: undefined }]);
  assert.deepEqual(events.map((e) => e.kind), ["spec_needs_feedback"]);
  assert.equal(events[0]!.level, "notice");
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
    runRefine: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", created: [{ id: "500", title: "A story", kind: "story", isLeaf: true }], questions: [] }),
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.deepEqual(events.map((e) => e.kind), ["issue_claimed", "spec_refined"]);
  assert.ok(events.every((e) => e.level === "info"));
});

// ── human-in-the-loop escalation ─────────────────────────────────────────

function sampleQuestion(overrides: Partial<{ id: string; question: string }> = {}) {
  return {
    id: "Q1",
    question: "Should invitations expire?",
    why_it_matters: "Changes the schema and the cleanup job.",
    options: ["7-day expiry", "never expire"],
    recommendation: "7-day expiry, matching the existing session TTL",
    evidence: ["src/core/session.ts"],
    ...overrides,
  };
}

test("claimSpecs: a refiner that raises questions escalates instead of publishing — needs-feedback, one notify, marker.feedback set, nothing created", async () => {
  const provider = new FakeProvider();
  provider.addIssue("200", "Ambiguous spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const { events, notify } = collectNotifications();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    notify,
    runRefine: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [sampleQuestion()] }),
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.equal(provider.entries.get("200")!.state, "needs-feedback");
  assert.deepEqual(provider.transitions.map((t) => t.to), ["needs-feedback"]);
  assert.deepEqual(events.map((e) => e.kind), ["issue_claimed", "spec_needs_feedback"]);
  assert.equal(events[1]!.level, "notice", "spec_needs_feedback is the same class of event as issue_blocked — must reach an attention-scope channel");
  const marker = provider.entries.get("200")!.marker;
  assert.equal(marker?.feedback?.rounds, 1);
  assert.ok(marker?.feedback?.asked_at);
  assert.equal(marker?.refined, undefined, "an escalating round must not also record a publish");
  const comment = provider.entries.get("200")!.comments.at(-1)!;
  assert.match(comment.body, /Should invitations expire\?/);
  assert.match(comment.body, /Why it matters.*Changes the schema/s);
  assert.match(comment.body, /7-day expiry, matching the existing session TTL/);
  assert.match(comment.body, /spf:continue-refinement/, "must tell the human which label resumes refinement");
});

test("claimSpecs: continue-refinement resumes the SAME adw_id as the original run, and leaves spec-ready specs untouched", async () => {
  const provider = new FakeProvider();
  provider.addIssue("201", "Escalated spec", "continue-refinement", { feedback: { rounds: 1, asked_at: new Date(1000).toISOString() } });
  provider.addIssue("202", "Untouched fresh spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const seenAdwIds: string[] = [];
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => {
      seenAdwIds.push(opts.adwId);
      return { accepted: true, adwId: opts.adwId, detail: "", created: [{ id: "600", title: "Resolved story", kind: "story", isLeaf: true }], questions: [] };
    },
  });

  await claimSpecs(deps, state, "continue-refinement");
  await waitUntil(() => state.refining.size === 0);

  assert.deepEqual(provider.claimCalls, ["201"], "must not touch the spec-ready spec when claiming continue-refinement");
  assert.deepEqual(seenAdwIds, ["spec-201"], "the adw_id is deterministic from the issue id — a resume is the SAME id, not a new one");
  assert.equal(provider.entries.get("202")!.state, "spec-ready", "untouched");
});

test("claimSpecs: a second escalation round increments marker.feedback.rounds, re-enters needs-feedback, and threads the human's answer into the resumed prompt", async () => {
  const provider = new FakeProvider();
  provider.addIssue("203", "Still ambiguous after round 1", "continue-refinement", { feedback: { rounds: 1, asked_at: new Date(1000).toISOString() } });
  provider.addComment("203", "alice", "Let's go with 7-day expiry.");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const seenPrompts: string[] = [];
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => {
      seenPrompts.push(opts.prompt);
      return { accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [sampleQuestion({ id: "Q2", question: "And what about invitations already sent?" })] };
    },
  });

  await claimSpecs(deps, state, "continue-refinement");
  await waitUntil(() => state.refining.size === 0);

  assert.equal(provider.entries.get("203")!.state, "needs-feedback");
  assert.equal(provider.entries.get("203")!.marker?.feedback?.rounds, 2);
  assert.match(seenPrompts[0]!, /Let's go with 7-day expiry\./, "the human's answer must reach the resumed prompt");
});

test("tick: continue-refinement and spec-ready specs share the same refine.concurrency budget, resumed spec claimed first", async () => {
  const provider = new FakeProvider();
  provider.addIssue("210", "waiting for an answer", "continue-refinement", { feedback: { rounds: 1, asked_at: new Date(1000).toISOString() } });
  provider.addIssue("211", "brand new spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    refineConcurrency: 1,
    runRefine: () => new Promise(() => {}), // never resolves — keeps the claim "in flight" for this assertion
  });

  await tick(deps, state);

  assert.equal(state.refining.size, 1);
  assert.deepEqual(provider.claimCalls, ["210"], "the resumed spec must be claimed first, using up the shared budget");
  assert.equal(provider.entries.get("211")!.state, "spec-ready", "no budget left for the fresh spec this tick");
});

test("claimSpecs: dry-run never claims or runs an escalating spec either", async () => {
  const provider = new FakeProvider();
  provider.addIssue("212", "dry run escalation", "continue-refinement", { feedback: { rounds: 1, asked_at: new Date(1000).toISOString() } });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let called = false;
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    dryRun: true,
    runRefine: async (opts) => {
      called = true;
      return { accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [sampleQuestion()] };
    },
  });

  await claimSpecs(deps, state, "continue-refinement");

  assert.equal(called, false);
  assert.equal(provider.entries.get("212")!.state, "continue-refinement");
});

test("announceRefined: a decomposition that produced zero issues has nothing to wait on, so it goes straight to done and closes", async () => {
  const provider = new FakeProvider();
  provider.addIssue("220", "Nothing came out of this", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => ({ accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [] }),
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.equal(provider.entries.get("220")!.state, "done");
  assert.deepEqual(provider.closedIssues, ["220"]);
});

// ── finishTrackedSpecs: the spec itself isn't done until every issue it produced is ──

test("finishTrackedSpecs: a spec-in-progress spec with an unfinished refined issue is left alone — not done, not closed", async () => {
  const provider = new FakeProvider();
  provider.addIssue("230", "the work is still open", "spec-in-progress", { refined: ["700"] });
  provider.addIssue("700", "the only story", "ready"); // not spf:done yet
  const codeHost = new FakeCodeHost();

  await finishTrackedSpecs(makeDeps(provider, codeHost));

  assert.equal(provider.entries.get("230")!.state, "spec-in-progress", "a PM must still see this as in progress, not done");
  assert.deepEqual(provider.closedIssues, []);
});

test("finishTrackedSpecs: closes the spec once every refined issue reaches spf:done", async () => {
  const provider = new FakeProvider();
  provider.addIssue("231", "Ready to close", "spec-in-progress", { refined: ["701"] });
  provider.addIssue("701", "A story", "done");
  const codeHost = new FakeCodeHost();
  const { events, notify } = collectNotifications();

  await finishTrackedSpecs(makeDeps(provider, codeHost, { notify }));

  assert.equal(provider.entries.get("231")!.state, "done");
  assert.deepEqual(provider.closedIssues, ["231"]);
  assert.deepEqual(events.map((e) => e.kind), ["spec_done"]);
  assert.equal(events[0]!.level, "info");
});

test("finishTrackedSpecs: with several refined issues, ALL must be done — one still open holds the spec back", async () => {
  const provider = new FakeProvider();
  provider.addIssue("232", "partially done", "spec-in-progress", { refined: ["710", "711"] });
  provider.addIssue("710", "finished story", "done");
  provider.addIssue("711", "still working", "working");
  const codeHost = new FakeCodeHost();

  await finishTrackedSpecs(makeDeps(provider, codeHost));

  assert.equal(provider.entries.get("232")!.state, "spec-in-progress");
  assert.deepEqual(provider.closedIssues, []);
});

test("finishTrackedSpecs: a closeIssue that rejects still leaves the spec transitioned to done — a failed close never un-does completed work", async () => {
  const provider = new FakeProvider();
  provider.addIssue("233", "Close fails", "spec-in-progress", { refined: ["712"] });
  provider.addIssue("712", "A story", "done");
  provider.closeIssueError = new Error("tracker rejected the close");
  const codeHost = new FakeCodeHost();

  await finishTrackedSpecs(makeDeps(provider, codeHost));

  assert.equal(provider.entries.get("233")!.state, "done");
  assert.deepEqual(provider.closedIssues, []);
});

test("finishTrackedSpecs: a refined issue that no longer exists (404) is treated as done, not a permanent wedge", async () => {
  const provider = new FakeProvider();
  provider.addIssue("234", "one story was deleted", "spec-in-progress", { refined: ["deleted-id", "713"] });
  provider.addIssue("713", "the surviving story", "done");
  const codeHost = new FakeCodeHost();

  await finishTrackedSpecs(makeDeps(provider, codeHost));

  assert.equal(provider.entries.get("234")!.state, "done");
  assert.deepEqual(provider.closedIssues, ["234"]);
});

test("finishTrackedSpecs: a spec with no refined ids recorded is left alone, never assumed done", async () => {
  const provider = new FakeProvider();
  provider.addIssue("235", "no marker at all", "spec-in-progress", null);
  const codeHost = new FakeCodeHost();

  await finishTrackedSpecs(makeDeps(provider, codeHost));

  assert.equal(provider.entries.get("235")!.state, "spec-in-progress");
  assert.deepEqual(provider.closedIssues, []);
});

test("finishTrackedSpecs: a container among the refined ids counts as done only once rollUp already marked it so", async () => {
  // Mirrors a real tree: publish() created a feature (F1) and one story
  // under it (S1) — both ids land in WatchMarker.refined. The feature is
  // only spf:done once finishReviews' rollUp already rolled it up (tested
  // separately); finishTrackedSpecs itself just reads the label, same as
  // for a leaf.
  const provider = new FakeProvider();
  provider.addIssue("236", "tree with a container", "spec-in-progress", { refined: ["240", "241"] });
  provider.addIssue("240", "the feature", "working"); // not yet rolled up
  provider.addIssue("241", "the story", "done");
  const codeHost = new FakeCodeHost();

  await finishTrackedSpecs(makeDeps(provider, codeHost));
  assert.equal(provider.entries.get("236")!.state, "spec-in-progress", "the feature container hasn't rolled up to done yet");

  await provider.transition(provider.entries.get("240")!.issue, "done"); // simulates rollUp() finishing the container
  await finishTrackedSpecs(makeDeps(provider, codeHost));
  assert.equal(provider.entries.get("236")!.state, "done", "now that the container is done too, the spec can close");
});

// ── buildSpecPrompt ──────────────────────────────────────────────────────

function specIssue(overrides: Partial<Issue> = {}): Issue {
  return { id: "1", title: "A spec", body: "Some body text.", labels: [], ...overrides };
}

function specComment(author: string, created_at: string, body: string): IssueComment {
  return { id: `${author}-${created_at}`, author, created_at, body };
}

test("buildSpecPrompt: no comments falls back to the plain title/body", () => {
  assert.equal(buildSpecPrompt(specIssue(), []), "A spec\n\nSome body text.");
});

test("buildSpecPrompt: omits the Priority section entirely when no priority is given — byte-identical to before this feature existed", () => {
  assert.equal(buildSpecPrompt(specIssue(), [], undefined, null), "A spec\n\nSome body text.");
  assert.equal(buildSpecPrompt(specIssue(), []), "A spec\n\nSome body text.", "and the same when the 4th arg is omitted entirely");
});

test("buildSpecPrompt: renders a ## Priority section, ahead of the discussion, when given one", () => {
  const prompt = buildSpecPrompt(specIssue(), [specComment("bob", "2020-01-01T00:00:00.000Z", "Some context.")], undefined, "p1");
  assert.match(prompt, /## Priority\n\nThis spec is labeled p1\./);
  assert.ok(prompt.indexOf("## Priority") < prompt.indexOf("## Discussion on the spec issue"));
});

test("buildSpecPrompt: with no prior escalation, every comment is 'earlier discussion'", () => {
  const prompt = buildSpecPrompt(specIssue(), [specComment("bob", "2020-01-01T00:00:00.000Z", "Some early context.")]);
  assert.match(prompt, /## Discussion on the spec issue/);
  assert.match(prompt, /### Earlier discussion\n\n\*\*@bob\*\* \(2020-01-01T00:00:00\.000Z\):\nSome early context\./);
  assert.ok(!prompt.includes("Answers to your open questions"));
});

test("buildSpecPrompt: comments at/after feedback.asked_at are the answers section; earlier ones stay 'earlier discussion', answers rendered first", () => {
  const comments = [
    specComment("bob", "2020-01-01T00:00:00.000Z", "Pre-escalation context."),
    specComment("alice", "2020-01-02T00:00:00.000Z", "Go with 7-day expiry."),
  ];
  const prompt = buildSpecPrompt(specIssue(), comments, { rounds: 1, asked_at: "2020-01-01T12:00:00.000Z" });

  assert.match(prompt, /### Answers to your open questions \(round 1\)\n\n\*\*@alice\*\*/);
  assert.match(prompt, /### Earlier discussion\n\n\*\*@bob\*\*/);
  assert.ok(prompt.indexOf("Answers to your open questions") < prompt.indexOf("Earlier discussion"), "answers must be surfaced before earlier discussion");
});

test("buildSpecPrompt: an oversized thread drops the oldest comments first and says so explicitly, never silently", () => {
  const comments = Array.from({ length: 5 }, (_, i) => specComment(`user${i}`, `2020-01-0${i + 1}T00:00:00.000Z`, "x".repeat(6000)));
  const prompt = buildSpecPrompt(specIssue(), comments);

  assert.match(prompt, /_\.\.\. \d+ earlier comment\(s\) omitted for length\._/);
  assert.ok(!prompt.includes("user0"), "the oldest comment must be the one dropped");
  assert.ok(prompt.includes("user4"), "the newest comment must survive");
});

// ── escapeForMarkup / truncateDigest / formatReviewDigest ───────────────────
// These three are what actually assembles the digest — the tests above only
// exercise core/watch.ts's three-way reviewLine selection via a stubbed
// runChain, so none of them ever call into these. Slack/GitHub markup
// escaping is the one security-relevant behavior spec item B calls out by
// name (a reviewer's findings are LLM-authored, hence untrusted), so it needs
// direct coverage.

test("escapeForMarkup: a Slack link-forgery attempt is neutralized, and & is escaped without double-escaping", () => {
  const escaped = escapeForMarkup("<https://evil.example/|click here> & enjoy");
  assert.equal(escaped, "&lt;https://evil.example/|click here&gt; &amp; enjoy");
  assert.ok(!escaped.includes("<") && !escaped.includes(">"), "no raw angle bracket must survive — that's what prevents a forged Slack mrkdwn link");
});

test("formatReviewDigest: an approved review's met findings are the actual signal, and are surfaced (not silently dropped)", () => {
  const review = reviewOutput({
    approved: true,
    findings: [
      { requirement: "endpoint returns 200", met: true, evidence: "curl output attached" },
      { requirement: "handles missing auth header", met: true, evidence: "" },
      { requirement: "logs the request id", met: true, evidence: "trace shows request_id field" },
    ],
    blocking: [],
  });
  const digest = formatReviewDigest(review);
  assert.match(digest, /^Reviewer verdict: approved\./);
  assert.match(digest, /Verified 3 requirement\(s\):/);
  assert.match(digest, /- endpoint returns 200 — curl output attached/);
  assert.match(digest, /- handles missing auth header/);
  assert.match(digest, /- logs the request id — trace shows request_id field/);
});

test("formatReviewDigest: blocking items and unmet findings are escaped before being joined in", () => {
  const review = reviewOutput({
    approved: false,
    blocking: ["contains a <https://evil.example/|forged link> & needs fixing"],
    findings: [{ requirement: "auth check <script>", met: false, evidence: "not implemented & untested" }],
  });
  const digest = formatReviewDigest(review);
  assert.match(digest, /^Reviewer verdict: changes requested\./);
  assert.match(digest, /- contains a &lt;https:\/\/evil\.example\/\|forged link&gt; &amp; needs fixing/);
  assert.match(digest, /- auth check &lt;script&gt; — not implemented &amp; untested/);
  assert.ok(!digest.includes("<script>") && !digest.includes("<https"), "raw markup from an unmet finding must not survive into the digest");
});

test("truncateDigest: a digest over the cap is cut at exactly the codepoint boundary, without splitting a surrogate pair", () => {
  // An astral-plane emoji (2 UTF-16 code units, 1 codepoint) placed exactly
  // at the 1200th codepoint — a naive `.slice(0, 1200)` on UTF-16 units would
  // land mid-pair and emit a lone, invalid surrogate instead of the emoji.
  const emoji = "\u{1F600}"; // grinning face, codepoint #1200
  const filler = "a".repeat(1199); // codepoints #1-1199
  const text = filler + emoji + "more text that must be cut off entirely";

  const result = truncateDigest(text);
  assert.equal(result, filler + emoji + "…", "must keep exactly 1200 whole codepoints (the emoji intact) then the ellipsis");
  assert.ok(result.endsWith("…"), "a truncated digest must end with the ellipsis marker");

  const short = "short digest, well under the cap";
  assert.equal(truncateDigest(short), short, "text under the cap must pass through unchanged, with no ellipsis appended");
});

// ── watch.chain_options threading (fix for PR #20's stated KNOWN LIMITATION:
// chain options like --suite never reached an unattended `spf watch` run) ──

test("claimNewWork: threads deps.chainOptions through to runChain's opts", async () => {
  const provider = new FakeProvider();
  provider.addIssue("70", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let seenOptions: Record<string, string> | undefined;
  const deps = makeDeps(provider, codeHost, {
    chainOptions: { suite: "strict" },
    runChain: async (opts) => {
      seenOptions = opts.chainOptions;
      return { accepted: true, adwId: opts.adwId, detail: "" };
    },
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(seenOptions, { suite: "strict" }, "watch.chain_options must reach the chain dispatch, not be silently dropped");
});

test("claimNewWork: an empty (default) chainOptions still reaches runChain as {}, not undefined", async () => {
  const provider = new FakeProvider();
  provider.addIssue("71", "Add a /health endpoint");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let seenOptions: Record<string, string> | undefined;
  const deps = makeDeps(provider, codeHost, {
    runChain: async (opts) => {
      seenOptions = opts.chainOptions;
      return { accepted: true, adwId: opts.adwId, detail: "" };
    },
  });

  await claimNewWork(deps, state);
  await waitUntil(() => state.inflight.size === 0);

  assert.deepEqual(seenOptions, {});
});

test("claimSpecs: threads deps.chainOptions through to runRefine's opts, same as the build lane", async () => {
  const provider = new FakeProvider();
  provider.addIssue("170", "A spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let seenOptions: Record<string, string> | undefined;
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    chainOptions: { agent: "flue" },
    runRefine: async (opts) => {
      seenOptions = opts.chainOptions;
      return { accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [] };
    },
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.deepEqual(seenOptions, { agent: "flue" }, "watch.chain_options must reach the refine chain dispatch too");
});

// ── claimSpecs/runSpec: a spec's own priority label reaches the refiner ──

test("claimSpecs: a spec's spf:priority label reaches both the prompt and runRefine's chainOptions", async () => {
  const provider = new FakeProvider();
  provider.addIssue("180", "An urgent spec", "spec-ready", null, { extraLabels: ["spf:priority:p1"] });
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let seenPrompt = "";
  let seenOptions: Record<string, string> | undefined;
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => {
      seenPrompt = opts.prompt;
      seenOptions = opts.chainOptions;
      return { accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [] };
    },
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.match(seenPrompt, /## Priority\n\nThis spec is labeled p1\./);
  assert.equal(seenOptions?.["priority"], "p1");
});

test("claimSpecs: a spec with no priority label reaches the refiner exactly as before this feature existed", async () => {
  const provider = new FakeProvider();
  provider.addIssue("181", "An unlabeled spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  let seenPrompt = "";
  let seenOptions: Record<string, string> | undefined;
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => {
      seenPrompt = opts.prompt;
      seenOptions = opts.chainOptions;
      return { accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [] };
    },
  });

  await claimSpecs(deps, state);
  await waitUntil(() => state.refining.size === 0);

  assert.ok(!seenPrompt.includes("## Priority"));
  assert.equal(seenOptions?.["priority"], undefined, "no ceiling — publishIssues() sees no priority key at all, same as before");
});

test("tick: a spec only reaches done once every issue it produced does — the refine lane, then finishTrackedSpecs, wired through tick() itself", async () => {
  const provider = new FakeProvider();
  provider.addIssue("300", "A spec", "spec-ready");
  const codeHost = new FakeCodeHost();
  const state = createWatchState();
  const deps = makeDeps(provider, codeHost, {
    refineEnabled: true,
    runRefine: async (opts) => ({
      accepted: true,
      adwId: opts.adwId,
      detail: "",
      created: [{ id: "800", title: "The only leaf", kind: "story", isLeaf: true }],
      questions: [],
    }),
  });

  await tick(deps, state);
  await waitUntil(() => state.refining.size === 0);
  assert.equal(provider.entries.get("300")!.state, "spec-in-progress", "published, but the leaf hasn't landed yet — must not read as done");
  assert.deepEqual(provider.closedIssues, []);

  // The leaf doesn't exist on the fake tracker yet — this simulates it
  // having actually been created (publish() would, via createIssue) and its
  // own PR merging sometime later.
  provider.addIssue("800", "The only leaf", "done");

  await tick(deps, state);

  assert.equal(provider.entries.get("300")!.state, "done", "the spec's last dependent finished — only now can it close");
  assert.deepEqual(provider.closedIssues, ["300"]);
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
