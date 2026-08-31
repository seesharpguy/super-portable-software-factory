import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRefineMarker, publish, publishSpecs, resolveAuthoringProvider } from "../core/refine.js";
import { refinementWellFormed } from "../core/gates.js";
import { JiraProvider } from "../core/issues/jira_provider.js";
import type { Issue, IssueAuthoringKind, IssueAuthoringProvider } from "../core/issues/provider.js";
import type { RefinedIssue, RefineQuestion, RunContext, SFConfig, SpecSplit } from "../core/data_types.js";

/** Only the `watch:` fields resolveAuthoringProvider actually reads — the rest of SFConfig is irrelevant to it. */
function makeCfg(watch: Partial<SFConfig["watch"]>): SFConfig {
  return {
    watch: {
      issue_provider: "github",
      code_host: "github",
      repo: "",
      issue_repo: "",
      label_prefix: "spf",
      chain: "plan-build-test",
      base_branch: "main",
      poll_ms: 60_000,
      concurrency: 2,
      jira: { base_url: "", project_key: "", issue_types: { epic: "Epic", feature: "Epic", story: "Story", bug: "Bug", task: "Task", spec: "Story" } },
      github: { project_number: 0, status_map: {} },
      refine: { enabled: false, chain: "refine", concurrency: 1, max_leaves: 4, max_nodes: 6, max_depth: 2 },
      ...watch,
    },
  } as unknown as SFConfig;
}

/** In-memory fake — exactly the seam `IssueAuthoringProvider` exists for. */
class FakeTracker implements IssueAuthoringProvider {
  created: Array<{ title: string; body: string; labels: string[]; kind: IssueAuthoringKind }> = [];
  links: Array<{ parent: string; child: string }> = [];
  private byId = new Map<string, Issue>();
  nextId = 1;

  async createIssue(input: { title: string; body: string; labels: string[]; kind: IssueAuthoringKind }): Promise<Issue> {
    this.created.push(input);
    const id = String(this.nextId++);
    const issue: Issue = { id, internal_id: `db-${id}`, title: input.title, body: input.body, labels: input.labels };
    this.byId.set(id, issue);
    return issue;
  }

  async linkChild(parent: Issue, child: Issue): Promise<void> {
    this.links.push({ parent: parent.id, child: child.id });
  }

  /** Not exercised by this file's own tests (those live in watch.test.ts's roll-up coverage) — kept correct anyway since a fake that half-implements its interface is worse than one that doesn't compile. */
  async listChildren(parent: Issue): Promise<Issue[]> {
    return this.links.filter((l) => l.parent === parent.id).map((l) => this.byId.get(l.child)!);
  }
}

// ── resolveAuthoringProvider ─────────────────────────────────────────────

test("resolveAuthoringProvider: constructs a JiraProvider when issue_provider is jira and config/env are complete", () => {
  const before = { email: process.env["JIRA_EMAIL"], token: process.env["JIRA_API_TOKEN"] };
  process.env["JIRA_EMAIL"] = "you@example.com";
  process.env["JIRA_API_TOKEN"] = "jira-token";
  try {
    const provider = resolveAuthoringProvider(
      makeCfg({ issue_provider: "jira", jira: { base_url: "https://acme.atlassian.net", project_key: "PROJ", issue_types: { epic: "Epic", feature: "Epic", story: "Story", bug: "Bug", task: "Task", spec: "Story" } } }),
    );
    assert.ok(provider instanceof JiraProvider);
  } finally {
    if (before.email !== undefined) process.env["JIRA_EMAIL"] = before.email;
    else delete process.env["JIRA_EMAIL"];
    if (before.token !== undefined) process.env["JIRA_API_TOKEN"] = before.token;
    else delete process.env["JIRA_API_TOKEN"];
  }
});

test("resolveAuthoringProvider: rejects a jira config missing base_url or project_key", () => {
  assert.throws(
    () => resolveAuthoringProvider(makeCfg({ issue_provider: "jira", jira: { base_url: "", project_key: "", issue_types: { epic: "Epic", feature: "Epic", story: "Story", bug: "Bug", task: "Task", spec: "Story" } } })),
    /watch\.jira\.base_url and watch\.jira\.project_key/,
  );
});

test("resolveAuthoringProvider: rejects when JIRA_EMAIL or JIRA_API_TOKEN is unset", () => {
  const before = { email: process.env["JIRA_EMAIL"], token: process.env["JIRA_API_TOKEN"] };
  delete process.env["JIRA_EMAIL"];
  delete process.env["JIRA_API_TOKEN"];
  try {
    assert.throws(
      () =>
        resolveAuthoringProvider(
          makeCfg({ issue_provider: "jira", jira: { base_url: "https://acme.atlassian.net", project_key: "PROJ", issue_types: { epic: "Epic", feature: "Epic", story: "Story", bug: "Bug", task: "Task", spec: "Story" } } }),
        ),
      /JIRA_EMAIL and JIRA_API_TOKEN/,
    );
  } finally {
    if (before.email !== undefined) process.env["JIRA_EMAIL"] = before.email;
    if (before.token !== undefined) process.env["JIRA_API_TOKEN"] = before.token;
  }
});

test("resolveAuthoringProvider: rejects when neither issue_repo nor repo is set", () => {
  assert.throws(() => resolveAuthoringProvider(makeCfg({ issue_provider: "github", repo: "", issue_repo: "" })), /watch\.repo/);
});

test("resolveAuthoringProvider: rejects when GITHUB_TOKEN is unset", () => {
  const before = process.env["GITHUB_TOKEN"];
  delete process.env["GITHUB_TOKEN"];
  try {
    assert.throws(() => resolveAuthoringProvider(makeCfg({ issue_provider: "github", repo: "acme/widgets" })), /GITHUB_TOKEN/);
  } finally {
    if (before !== undefined) process.env["GITHUB_TOKEN"] = before;
  }
});

test("resolveAuthoringProvider: issue_repo overrides repo — the github-issues-against-bitbucket-code case", async () => {
  const before = process.env["GITHUB_TOKEN"];
  process.env["GITHUB_TOKEN"] = "test-token";
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  (globalThis as any).fetch = async (url: string) => {
    capturedUrl = String(url);
    return { ok: true, status: 201, json: async () => ({ id: 1, number: 1, title: "x", body: "", labels: [] }) };
  };
  try {
    // repo is the BITBUCKET code repo here — issue authoring must use
    // issue_repo (the GitHub repo), never fall back to repo, or it would
    // try to create a GitHub issue against a Bitbucket-shaped identifier.
    const provider = resolveAuthoringProvider(makeCfg({ issue_provider: "github", repo: "acme-workspace/widgets-code", issue_repo: "acme/widgets-issues" }));
    await provider.createIssue({ title: "x", body: "", labels: [], kind: "story" });
  } finally {
    globalThis.fetch = originalFetch;
    if (before !== undefined) process.env["GITHUB_TOKEN"] = before;
    else delete process.env["GITHUB_TOKEN"];
  }
  assert.match(capturedUrl, /acme\/widgets-issues/);
  assert.doesNotMatch(capturedUrl, /widgets-code/);
});

function node(overrides: Partial<RefinedIssue> & Pick<RefinedIssue, "key" | "kind" | "title">): RefinedIssue {
  return { body: "", user_outcome: "", parent: "", blocked_by: [], priority: "p2", ...overrides };
}

/** A `user_outcome` that passes `refinementWellFormed`'s shape check (non-blank, >=20 chars, not a verbatim echo of the title) — the value every LEAF in a "passes clean" gate test needs, since `publish()`-only tests never reach that check and can keep `node()`'s blank default. */
function outcome(text = "After this lands, a user can do the specific thing being tested here."): string {
  return text;
}

// ── publish() ────────────────────────────────────────────────────────────

test("publish: creates a container before its children, and links them via linkChild", async () => {
  const tracker = new FakeTracker();
  const issues = [
    node({ key: "S1", kind: "story", title: "Owner invites by email", parent: "F1" }),
    node({ key: "F1", kind: "feature", title: "Team invitations" }),
  ];

  const created = await publish(tracker, issues, { labelPrefix: "spf" });

  assert.deepEqual(tracker.created.map((c) => c.title), ["Team invitations", "Owner invites by email"], "the parent must be created before its child");
  assert.deepEqual(tracker.links, [{ parent: "1", child: "2" }]);
  assert.deepEqual(created.map((c) => ({ key: c.key, isLeaf: c.isLeaf })), [
    { key: "F1", isLeaf: false },
    { key: "S1", isLeaf: true },
  ]);
});

test("publish: labels a leaf with its type, priority, AND spf:refined; a container gets its type and priority labels only", async () => {
  const tracker = new FakeTracker();
  const issues = [node({ key: "F1", kind: "feature", title: "A feature" }), node({ key: "S1", kind: "story", title: "A leaf", parent: "F1" })];

  await publish(tracker, issues, { labelPrefix: "spf" });

  const feature = tracker.created.find((c) => c.title === "A feature")!;
  const leaf = tracker.created.find((c) => c.title === "A leaf")!;
  assert.deepEqual(feature.labels, ["spf:type:feature", "spf:priority:p2"]);
  assert.deepEqual(leaf.labels, ["spf:type:story", "spf:priority:p2", "spf:refined"]);
});

test("publish: passes each node's own kind through to createIssue — what a Jira tracker maps to a real issue type", async () => {
  const tracker = new FakeTracker();
  const issues = [node({ key: "F1", kind: "feature", title: "A feature" }), node({ key: "S1", kind: "bug", title: "A leaf", parent: "F1" })];

  await publish(tracker, issues, { labelPrefix: "spf" });

  assert.equal(tracker.created.find((c) => c.title === "A feature")!.kind, "feature");
  assert.equal(tracker.created.find((c) => c.title === "A leaf")!.kind, "bug");
});

// ── priority: labeling, the hidden marker, and the spec ceiling ─────────

test("publish: a non-default priority is labeled and carried into the hidden marker", async () => {
  const tracker = new FakeTracker();
  const created = await publish(tracker, [node({ key: "S1", kind: "story", title: "A leaf", priority: "p0" })], { labelPrefix: "spf" });

  const leaf = tracker.created.find((c) => c.title === "A leaf")!;
  assert.ok(leaf.labels.includes("spf:priority:p0"));
  assert.deepEqual(parseRefineMarker(created[0]!.issue.body), { parent: null, blocked_by: [], priority: "p0" });
});

test("publish: the hidden spf-refine marker round-trips parent and blocked_by as real issue ids", async () => {
  const tracker = new FakeTracker();
  const issues = [
    node({ key: "F1", kind: "feature", title: "A feature" }),
    node({ key: "S1", kind: "story", title: "First", parent: "F1" }),
    node({ key: "S2", kind: "story", title: "Second", parent: "F1", blocked_by: ["S1"] }),
  ];

  const created = await publish(tracker, issues, { labelPrefix: "spf" });
  const f1Id = created.find((c) => c.key === "F1")!.issue.id;
  const s1Id = created.find((c) => c.key === "S1")!.issue.id;
  const s2 = created.find((c) => c.key === "S2")!;

  assert.deepEqual(parseRefineMarker(s2.issue.body), { parent: f1Id, blocked_by: [s1Id], priority: "p2" });
});

test("publish: with no marker at all, parseRefineMarker degrades to no parent, no blockers, p2", () => {
  assert.deepEqual(parseRefineMarker("just a plain issue body, never created by the refine lane"), { parent: null, blocked_by: [], priority: "p2" });
});

test("publish: a malformed marker degrades the same way, rather than throwing", () => {
  assert.deepEqual(parseRefineMarker("<!-- spf-refine: {not valid json -->"), { parent: null, blocked_by: [], priority: "p2" });
});

test("publish: clamps a node that outranks the spec's priority ceiling", async () => {
  const tracker = new FakeTracker();
  const created = await publish(tracker, [node({ key: "S1", kind: "story", title: "A leaf", priority: "p0" })], {
    labelPrefix: "spf",
    priorityCeiling: "p2",
  });

  const leaf = tracker.created.find((c) => c.title === "A leaf")!;
  assert.ok(leaf.labels.includes("spf:priority:p2"), "clamped down to the ceiling");
  assert.deepEqual(parseRefineMarker(created[0]!.issue.body).priority, "p2");
});

test("publish: a node already at or below the ceiling is left alone", async () => {
  const tracker = new FakeTracker();
  const created = await publish(tracker, [node({ key: "S1", kind: "story", title: "A leaf", priority: "p3" })], {
    labelPrefix: "spf",
    priorityCeiling: "p2",
  });

  const leaf = tracker.created.find((c) => c.title === "A leaf")!;
  assert.ok(leaf.labels.includes("spf:priority:p3"), "p3 does not outrank a p2 ceiling, so it is not raised");
  assert.deepEqual(parseRefineMarker(created[0]!.issue.body).priority, "p3");
});

test("publish: no ceiling given is a no-op — every node keeps its own priority", async () => {
  const tracker = new FakeTracker();
  const created = await publish(tracker, [node({ key: "S1", kind: "story", title: "A leaf", priority: "p0" })], { labelPrefix: "spf" });
  assert.deepEqual(parseRefineMarker(created[0]!.issue.body).priority, "p0");
});

test("publish: creates a blocker before what it blocks, and renders a real #n reference in the body", async () => {
  const tracker = new FakeTracker();
  const issues = [
    node({ key: "S2", kind: "bug", title: "Fix the expiry check", blocked_by: ["S1"] }),
    node({ key: "S1", kind: "story", title: "Owner invites by email" }),
  ];

  const created = await publish(tracker, issues, { labelPrefix: "spf" });
  const s1Id = created.find((c) => c.key === "S1")!.issue.id;
  const s2 = tracker.created.find((c) => c.title === "Fix the expiry check")!;

  assert.equal(created[0]!.key, "S1", "the blocker publishes first");
  assert.match(s2.body, new RegExp(`## Blocked by\\n\\n- #${s1Id}`));
});

test("publish: a leaf with no blockers gets the 'None (can start immediately)' text", async () => {
  const tracker = new FakeTracker();
  const created = await publish(tracker, [node({ key: "S1", kind: "story", title: "A leaf" })], { labelPrefix: "spf" });
  assert.match(created[0]!.issue.body, /## Blocked by\n\nNone \(can start immediately\)\./);
});

test("publish: renders '## Parent: #<id>' when a spec issue id is given, and omits it otherwise", async () => {
  const tracker = new FakeTracker();
  const withSpec = await publish(tracker, [node({ key: "S1", kind: "story", title: "A leaf" })], { labelPrefix: "spf", specIssueId: "42" });
  assert.match(withSpec[0]!.issue.body, /## Parent\n\nDecomposed from #42\./);

  const tracker2 = new FakeTracker();
  const withoutSpec = await publish(tracker2, [node({ key: "S1", kind: "story", title: "A leaf" })], { labelPrefix: "spf" });
  assert.doesNotMatch(withoutSpec[0]!.issue.body, /## Parent/);
});

// ── gates.refinementWellFormed ───────────────────────────────────────────

function envelope(issues: RefinedIssue[]) {
  return { status: "success" as const, summary: "", artifacts: [], notes_for_next_agent: "", issues };
}

function question(overrides: Partial<RefineQuestion> & Pick<RefineQuestion, "id" | "question">): RefineQuestion {
  return { why_it_matters: "", options: [], recommendation: "", evidence: [], ...overrides };
}

function envelopeWithQuestions(questions: RefineQuestion[], issues: RefinedIssue[] = []) {
  return { status: "success" as const, summary: "", artifacts: [], notes_for_next_agent: "", issues, questions };
}

function specSplit(overrides: Partial<SpecSplit> & Pick<SpecSplit, "title">): SpecSplit {
  return { body: "A complete standalone spec.", rationale: "Coherent on its own; expect ~3 leaves.", ...overrides };
}

function envelopeWithSplit(split: SpecSplit[], issues: RefinedIssue[] = [], questions: RefineQuestion[] = []) {
  return { status: "success" as const, summary: "", artifacts: [], notes_for_next_agent: "", issues, questions, split };
}

/** A gate `RunContext`. Omitted `budget` falls back to the packaged `DEFAULT_REFINE_*` numbers — what every test above this helper (written before the budget existed) implicitly exercises via a bare `{ repo_root: "/repo" }`. */
function runCtx(budget?: Partial<SFConfig["watch"]["refine"]>): RunContext {
  if (!budget) return { repo_root: "/repo" };
  return { repo_root: "/repo", cfg: makeCfg({ refine: { enabled: false, chain: "refine", concurrency: 1, max_leaves: 4, max_nodes: 6, max_depth: 2, ...budget } }) };
}

test("refinementWellFormed: an empty issues list fails", () => {
  const report = refinementWellFormed(envelope([]), { repo_root: "/repo" });
  assert.equal(report.passed, false);
});

test("refinementWellFormed: a well-formed feature/story tree with no blockers passes clean", () => {
  const report = refinementWellFormed(
    envelope([
      node({ key: "F1", kind: "feature", title: "A feature" }),
      node({ key: "S1", kind: "story", title: "First leaf", parent: "F1", user_outcome: outcome("After this lands, a user can do the first thing.") }),
      node({ key: "S2", kind: "story", title: "Second leaf", parent: "F1", user_outcome: outcome("After this lands, a user can do the second thing.") }),
    ]),
    { repo_root: "/repo" },
  );
  assert.equal(report.passed, true);
});

test("refinementWellFormed: a container mislabeled as a leaf kind fails", () => {
  const report = refinementWellFormed(
    envelope([node({ key: "F1", kind: "story", title: "Should be a feature" }), node({ key: "S1", kind: "story", title: "A leaf", parent: "F1" })]),
    { repo_root: "/repo" },
  );
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("F1.kind")));
});

test("refinementWellFormed: a two-node parent cycle has no leaves AND fails the dependency-graph check", () => {
  // A finite, ACYCLIC parent forest always has at least one leaf by
  // construction (some node's children set is empty) — the only way to
  // drive leafCount to zero is a cycle, which the dependency-graph check
  // already independently rejects. This test exercises that overlap
  // directly rather than asserting an "all containers, no leaves" shape
  // that isn't otherwise reachable.
  const report = refinementWellFormed(
    envelope([node({ key: "F1", kind: "feature", title: "A", parent: "F2" }), node({ key: "F2", kind: "feature", title: "B", parent: "F1" })]),
    { repo_root: "/repo" },
  );
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.toLowerCase().includes("cycle")));
  assert.ok(report.violations.some((v) => v.toLowerCase().includes("leaves")));
});

test("refinementWellFormed: an unresolved parent key fails", () => {
  const report = refinementWellFormed(envelope([node({ key: "S1", kind: "story", title: "Orphaned", parent: "nonexistent" })]), {
    repo_root: "/repo",
  });
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("parent")));
});

test("refinementWellFormed: an unresolved blocked_by key fails", () => {
  const report = refinementWellFormed(envelope([node({ key: "S1", kind: "story", title: "A leaf", blocked_by: ["nonexistent"] })]), {
    repo_root: "/repo",
  });
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("blocked_by")));
});

test("refinementWellFormed: a blocked_by cycle fails", () => {
  const report = refinementWellFormed(
    envelope([
      node({ key: "S1", kind: "story", title: "A", blocked_by: ["S2"] }),
      node({ key: "S2", kind: "story", title: "B", blocked_by: ["S1"] }),
    ]),
    { repo_root: "/repo" },
  );
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.toLowerCase().includes("cycle")));
});

test("refinementWellFormed: duplicate keys fail", () => {
  const report = refinementWellFormed(
    envelope([node({ key: "S1", kind: "story", title: "A" }), node({ key: "S1", kind: "bug", title: "B" })]),
    { repo_root: "/repo" },
  );
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("duplicate")));
});

test("refinementWellFormed: an empty issues list that also raised no questions fails, naming both options", () => {
  const report = refinementWellFormed(envelopeWithQuestions([]), { repo_root: "/repo" });
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.toLowerCase().includes("escalate")));
});

test("refinementWellFormed: questions alone (no issues) passes", () => {
  const report = refinementWellFormed(
    envelopeWithQuestions([question({ id: "Q1", question: "Should invitations expire?" })]),
    { repo_root: "/repo" },
  );
  assert.equal(report.passed, true);
});

test("refinementWellFormed: questions alongside issues fails — escalating must publish nothing this round", () => {
  const report = refinementWellFormed(
    envelopeWithQuestions([question({ id: "Q1", question: "Should invitations expire?" })], [node({ key: "S1", kind: "story", title: "A leaf" })]),
    { repo_root: "/repo" },
  );
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.toLowerCase().includes("escalating means publishing nothing")));
});

test("refinementWellFormed: a blank question id fails", () => {
  const report = refinementWellFormed(envelopeWithQuestions([question({ id: "", question: "Something?" })]), { repo_root: "/repo" });
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("blank")));
});

test("refinementWellFormed: duplicate question ids fail", () => {
  const report = refinementWellFormed(
    envelopeWithQuestions([question({ id: "Q1", question: "First?" }), question({ id: "Q1", question: "Second?" })]),
    { repo_root: "/repo" },
  );
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("duplicate question id")));
});

test("refinementWellFormed: blank question text fails", () => {
  const report = refinementWellFormed(envelopeWithQuestions([question({ id: "Q1", question: "   " })]), { repo_root: "/repo" });
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("question text is blank")));
});

// ── refinementWellFormed: priority monotonicity ──────────────────────────

test("refinementWellFormed: a p0 child under a p3 parent fails — a child may never outrank its parent", () => {
  const report = refinementWellFormed(
    envelope([
      node({ key: "F1", kind: "feature", title: "Someday", priority: "p3" }),
      node({ key: "S1", kind: "story", title: "Urgent leaf", parent: "F1", priority: "p0" }),
    ]),
    { repo_root: "/repo" },
  );
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("S1.priority")));
});

test("refinementWellFormed: a child at the same priority as its parent passes", () => {
  const report = refinementWellFormed(
    envelope([
      node({ key: "F1", kind: "feature", title: "A feature", priority: "p1" }),
      node({ key: "S1", kind: "story", title: "A leaf", parent: "F1", priority: "p1", user_outcome: outcome() }),
      node({ key: "S2", kind: "story", title: "Another leaf", parent: "F1", priority: "p1", user_outcome: outcome("After this lands, a user can do a different thing.") }),
    ]),
    { repo_root: "/repo" },
  );
  assert.equal(report.passed, true);
});

test("refinementWellFormed: a child LESS urgent than its parent passes — only outranking is a violation", () => {
  const report = refinementWellFormed(
    envelope([
      node({ key: "F1", kind: "feature", title: "A feature", priority: "p0" }),
      node({ key: "S1", kind: "story", title: "A leaf", parent: "F1", priority: "p3", user_outcome: outcome() }),
      node({ key: "S2", kind: "story", title: "Another leaf", parent: "F1", priority: "p3", user_outcome: outcome("After this lands, a user can do a different thing.") }),
    ]),
    { repo_root: "/repo" },
  );
  assert.equal(report.passed, true);
});

// ── refinementWellFormed: the decomposition budget ───────────────────────

/** N distinct top-level leaves, each with a valid, distinct user_outcome — the shape every budget test starts from. */
function leaves(n: number): RefinedIssue[] {
  return Array.from({ length: n }, (_, i) =>
    node({ key: `S${i + 1}`, kind: "story", title: `Leaf ${i + 1}`, user_outcome: outcome(`After this lands, a user can do thing number ${i + 1}.`) }),
  );
}

test("refinementWellFormed: a tree at exactly max_leaves passes", () => {
  const report = refinementWellFormed(envelope(leaves(4)), runCtx());
  assert.equal(report.passed, true);
});

test("refinementWellFormed: one leaf over max_leaves fails, and the message offers the split escalation without licensing a merge", () => {
  const report = refinementWellFormed(envelope(leaves(5)), runCtx());
  assert.equal(report.passed, false);
  const budgetViolation = report.violations.find((v) => v.toLowerCase().includes("leaves exceeds the budget"));
  assert.ok(budgetViolation, "expected a leaf-budget violation");
  assert.match(budgetViolation!, /split/i);
  assert.match(budgetViolation!, /do not merge unrelated/i);
});

test("refinementWellFormed: a configured max_leaves overrides the packaged default — tighter", () => {
  const report = refinementWellFormed(envelope(leaves(3)), runCtx({ max_leaves: 2 }));
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("leaf budget")));
});

test("refinementWellFormed: a configured max_leaves overrides the packaged default — looser", () => {
  const report = refinementWellFormed(envelope(leaves(6)), runCtx({ max_leaves: 20 }));
  assert.equal(report.passed, true);
});

test("refinementWellFormed: a RunContext with no cfg falls back to the packaged budget", () => {
  const report = refinementWellFormed(envelope(leaves(6)), { repo_root: "/repo" });
  assert.equal(report.passed, false);
});

test("refinementWellFormed: max_nodes fails a tree that is within the leaf budget", () => {
  // 3 containers x 2 leaves each = 3 leaves under the (raised) leaf budget,
  // but 9 nodes total — the case max_nodes exists for: raising max_depth to
  // fit a wider tree must not silently uncap total node count too.
  const report = refinementWellFormed(
    envelope([
      node({ key: "F1", kind: "feature", title: "Feature 1" }),
      node({ key: "S1", kind: "story", title: "S1", parent: "F1", user_outcome: outcome() }),
      node({ key: "S2", kind: "story", title: "S2", parent: "F1", user_outcome: outcome("After this lands, a user can do thing 2.") }),
      node({ key: "F2", kind: "feature", title: "Feature 2" }),
      node({ key: "S3", kind: "story", title: "S3", parent: "F2", user_outcome: outcome("After this lands, a user can do thing 3.") }),
      node({ key: "S4", kind: "story", title: "S4", parent: "F2", user_outcome: outcome("After this lands, a user can do thing 4.") }),
      node({ key: "F3", kind: "feature", title: "Feature 3" }),
      node({ key: "S5", kind: "story", title: "S5", parent: "F3", user_outcome: outcome("After this lands, a user can do thing 5.") }),
      node({ key: "S6", kind: "story", title: "S6", parent: "F3", user_outcome: outcome("After this lands, a user can do thing 6.") }),
    ]),
    runCtx({ max_leaves: 10, max_nodes: 8 }),
  );
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("node budget")));
});

// ── refinementWellFormed: no singleton container ─────────────────────────

test("refinementWellFormed: a container with exactly one child fails", () => {
  const report = refinementWellFormed(
    envelope([node({ key: "F1", kind: "feature", title: "A feature" }), node({ key: "S1", kind: "story", title: "A leaf", parent: "F1", user_outcome: outcome() })]),
    runCtx(),
  );
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("F1.children")));
  assert.ok(report.violations.some((v) => v.toLowerCase().includes("nothing to group")));
});

test("refinementWellFormed: a container with two children passes", () => {
  const report = refinementWellFormed(
    envelope([
      node({ key: "F1", kind: "feature", title: "A feature" }),
      node({ key: "S1", kind: "story", title: "A leaf", parent: "F1", user_outcome: outcome() }),
      node({ key: "S2", kind: "story", title: "Another leaf", parent: "F1", user_outcome: outcome("After this lands, a user can do a different thing.") }),
    ]),
    runCtx(),
  );
  assert.equal(report.passed, true);
});

test("refinementWellFormed: a single top-level leaf with no container at all passes", () => {
  const report = refinementWellFormed(envelope([node({ key: "S1", kind: "story", title: "A leaf", user_outcome: outcome() })]), runCtx());
  assert.equal(report.passed, true);
});

// ── refinementWellFormed: depth cap ───────────────────────────────────────

test("refinementWellFormed: an epic over a feature over a story fails the depth cap", () => {
  const report = refinementWellFormed(
    envelope([
      node({ key: "E1", kind: "epic", title: "An epic" }),
      node({ key: "F1", kind: "feature", title: "A feature", parent: "E1" }),
      node({ key: "S1", kind: "story", title: "A leaf", parent: "F1", user_outcome: outcome() }),
      node({ key: "S2", kind: "story", title: "Another leaf", parent: "F1", user_outcome: outcome("After this lands, a user can do a different thing.") }),
    ]),
    runCtx(),
  );
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("S1.depth") || v.includes("S2.depth")));
});

test("refinementWellFormed: two levels pass at the default cap", () => {
  const report = refinementWellFormed(
    envelope([
      node({ key: "F1", kind: "feature", title: "A feature" }),
      node({ key: "S1", kind: "story", title: "A leaf", parent: "F1", user_outcome: outcome() }),
      node({ key: "S2", kind: "story", title: "Another leaf", parent: "F1", user_outcome: outcome("After this lands, a user can do a different thing.") }),
    ]),
    runCtx(),
  );
  assert.equal(report.passed, true);
});

test("refinementWellFormed: a raised max_depth admits three levels", () => {
  // E1 needs TWO children (F1, F2) to also clear the no-singleton-container
  // rule — an epic wrapping exactly one feature would fail on that alone,
  // independent of depth, and this test isolates the depth check.
  const report = refinementWellFormed(
    envelope([
      node({ key: "E1", kind: "epic", title: "An epic" }),
      node({ key: "F1", kind: "feature", title: "Feature 1", parent: "E1" }),
      node({ key: "S1", kind: "story", title: "A leaf", parent: "F1", user_outcome: outcome() }),
      node({ key: "S2", kind: "story", title: "Another leaf", parent: "F1", user_outcome: outcome("After this lands, a user can do a different thing.") }),
      node({ key: "F2", kind: "feature", title: "Feature 2", parent: "E1" }),
      node({ key: "S3", kind: "story", title: "A third leaf", parent: "F2", user_outcome: outcome("After this lands, a user can do a third thing.") }),
      node({ key: "S4", kind: "story", title: "A fourth leaf", parent: "F2", user_outcome: outcome("After this lands, a user can do a fourth thing.") }),
    ]),
    runCtx({ max_depth: 3, max_leaves: 8, max_nodes: 8 }),
  );
  assert.equal(report.passed, true);
});

test("refinementWellFormed: the depth walk terminates on a parent cycle rather than hanging", () => {
  const report = refinementWellFormed(
    envelope([node({ key: "F1", kind: "feature", title: "A", parent: "F2" }), node({ key: "F2", kind: "feature", title: "B", parent: "F1" })]),
    runCtx(),
  );
  // Termination is the assertion here: reaching this line at all (under
  // node --test's default timeout) means containmentDepth's `seen` guard
  // worked. The existing cycle test above already covers the dependency-graph
  // violation this same fixture produces.
  assert.equal(report.passed, false);
});

// ── refinementWellFormed: user_outcome ────────────────────────────────────

test("refinementWellFormed: a leaf with a blank user_outcome fails", () => {
  const report = refinementWellFormed(envelope([node({ key: "S1", kind: "story", title: "A leaf" })]), runCtx());
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("S1.user_outcome")));
  assert.ok(report.violations.some((v) => v.toLowerCase().includes("process, not product")));
});

test("refinementWellFormed: a leaf whose user_outcome repeats its title fails", () => {
  const report = refinementWellFormed(envelope([node({ key: "S1", kind: "story", title: "Rollback plan documentation", user_outcome: "Rollback plan documentation" })]), runCtx());
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("S1.user_outcome")));
});

test("refinementWellFormed: a leaf whose user_outcome is too short fails", () => {
  const report = refinementWellFormed(envelope([node({ key: "S1", kind: "story", title: "A leaf", user_outcome: "Faster." })]), runCtx());
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("S1.user_outcome")));
});

test("refinementWellFormed: a container with a blank user_outcome passes — only leaves must state one", () => {
  const report = refinementWellFormed(
    envelope([
      node({ key: "F1", kind: "feature", title: "A feature" }), // no user_outcome — fine, it's a container
      node({ key: "S1", kind: "story", title: "A leaf", parent: "F1", user_outcome: outcome() }),
      node({ key: "S2", kind: "story", title: "Another leaf", parent: "F1", user_outcome: outcome("After this lands, a user can do a different thing.") }),
    ]),
    runCtx(),
  );
  assert.equal(report.passed, true);
});

// ── refinementWellFormed: split — the third escalation shape ─────────────

test("refinementWellFormed: split alone (no issues, no questions) passes", () => {
  const report = refinementWellFormed(envelopeWithSplit([specSplit({ title: "Spec A" }), specSplit({ title: "Spec B" })]), runCtx());
  assert.equal(report.passed, true);
});

test("refinementWellFormed: a one-entry split fails — that's not a split", () => {
  const report = refinementWellFormed(envelopeWithSplit([specSplit({ title: "Spec A" })]), runCtx());
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.toLowerCase().includes("not a split")));
});

test("refinementWellFormed: split alongside issues fails — escalating means publishing nothing this round", () => {
  const report = refinementWellFormed(
    envelopeWithSplit([specSplit({ title: "Spec A" }), specSplit({ title: "Spec B" })], [node({ key: "S1", kind: "story", title: "A leaf" })]),
    runCtx(),
  );
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.toLowerCase().includes("escalating means publishing nothing")));
});

test("refinementWellFormed: split alongside questions fails — ambiguity and size are different problems", () => {
  const report = refinementWellFormed(
    envelopeWithSplit([specSplit({ title: "Spec A" }), specSplit({ title: "Spec B" })], [], [question({ id: "Q1", question: "Which vendor?" })]),
    runCtx(),
  );
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.toLowerCase().includes("different problems")));
});

test("refinementWellFormed: a split entry with a blank title, body, or rationale fails", () => {
  const report = refinementWellFormed(envelopeWithSplit([specSplit({ title: "" }), specSplit({ title: "Spec B", body: "" })]), runCtx());
  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.includes("split[0].title")));
  assert.ok(report.violations.some((v) => v.includes("split[1].body")));
});

// ── core/refine.ts: renderBody's '## Outcome' section ─────────────────────

test("publish: renders a leading '## Outcome' section from user_outcome", async () => {
  const tracker = new FakeTracker();
  const created = await publish(tracker, [node({ key: "S1", kind: "story", title: "A leaf", user_outcome: "A workspace owner can invite a teammate by email." })], { labelPrefix: "spf" });
  assert.match(created[0]!.issue.body, /^## Outcome\n\nA workspace owner can invite a teammate by email\./);
});

test("publish: omits the Outcome section entirely when user_outcome is blank", async () => {
  const tracker = new FakeTracker();
  const created = await publish(tracker, [node({ key: "S1", kind: "story", title: "A leaf" })], { labelPrefix: "spf" });
  assert.doesNotMatch(created[0]!.issue.body, /## Outcome/);
});

// ── core/refine.ts: publishSpecs ──────────────────────────────────────────

test("publishSpecs: creates each proposed spec with kind spec, type:spec + spec-ready labels, the inherited priority, and no spf:refined", async () => {
  const tracker = new FakeTracker();
  const created = await publishSpecs(tracker, [specSplit({ title: "Spec A" }), specSplit({ title: "Spec B" })], {
    labelPrefix: "spf",
    originalSpecId: "42",
    priority: "p1",
  });

  assert.equal(created.length, 2);
  for (const entry of tracker.created) {
    assert.equal(entry.kind, "spec");
    assert.deepEqual(entry.labels, ["spf:type:spec", "spf:spec-ready", "spf:priority:p1"]);
    assert.doesNotMatch(entry.labels.join(","), /spf:refined/);
  }
});

test("publishSpecs: renders a Parent back-reference to the original spec and the rationale, and calls no linkChild", async () => {
  const tracker = new FakeTracker();
  await publishSpecs(tracker, [specSplit({ title: "Spec A", rationale: "Ships independently of Spec B." })], {
    labelPrefix: "spf",
    originalSpecId: "42",
  });

  const created = tracker.created[0]!;
  assert.match(created.body, /## Parent\n\nSplit from #42/);
  assert.match(created.body, /Ships independently of Spec B\./);
  assert.deepEqual(tracker.links, [], "a spec can never parent another spec on Jira — no linkChild call");
});

test("publishSpecs: omits the priority label entirely when no priority is inherited", async () => {
  const tracker = new FakeTracker();
  await publishSpecs(tracker, [specSplit({ title: "Spec A" }), specSplit({ title: "Spec B" })], { labelPrefix: "spf", originalSpecId: "42" });
  for (const entry of tracker.created) {
    assert.deepEqual(entry.labels, ["spf:type:spec", "spf:spec-ready"]);
  }
});
