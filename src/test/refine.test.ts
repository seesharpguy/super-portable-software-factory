import { test } from "node:test";
import assert from "node:assert/strict";
import { publish, resolveAuthoringProvider } from "../core/refine.js";
import { refinementWellFormed } from "../core/gates.js";
import type { Issue, IssueAuthoringProvider } from "../core/issues/provider.js";
import type { RefinedIssue, RefineQuestion, SFConfig } from "../core/data_types.js";

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
      jira: { base_url: "", project_key: "" },
      refine: { enabled: false, chain: "refine", concurrency: 1 },
      ...watch,
    },
  } as unknown as SFConfig;
}

/** In-memory fake — exactly the seam `IssueAuthoringProvider` exists for. */
class FakeTracker implements IssueAuthoringProvider {
  created: Array<{ title: string; body: string; labels: string[] }> = [];
  links: Array<{ parent: string; child: string }> = [];
  nextId = 1;

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<Issue> {
    this.created.push(input);
    const id = String(this.nextId++);
    return { id, internal_id: `db-${id}`, title: input.title, body: input.body, labels: input.labels };
  }

  async linkChild(parent: Issue, child: Issue): Promise<void> {
    this.links.push({ parent: parent.id, child: child.id });
  }
}

// ── resolveAuthoringProvider ─────────────────────────────────────────────

test("resolveAuthoringProvider: rejects a non-github issue_provider", () => {
  assert.throws(() => resolveAuthoringProvider(makeCfg({ issue_provider: "jira" })), /does not support issue authoring/);
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
    await provider.createIssue({ title: "x", body: "", labels: [] });
  } finally {
    globalThis.fetch = originalFetch;
    if (before !== undefined) process.env["GITHUB_TOKEN"] = before;
    else delete process.env["GITHUB_TOKEN"];
  }
  assert.match(capturedUrl, /acme\/widgets-issues/);
  assert.doesNotMatch(capturedUrl, /widgets-code/);
});

function node(overrides: Partial<RefinedIssue> & Pick<RefinedIssue, "key" | "kind" | "title">): RefinedIssue {
  return { body: "", parent: "", blocked_by: [], ...overrides };
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

test("publish: labels a leaf with its type AND spf:refined; a container gets only its type label", async () => {
  const tracker = new FakeTracker();
  const issues = [node({ key: "F1", kind: "feature", title: "A feature" }), node({ key: "S1", kind: "story", title: "A leaf", parent: "F1" })];

  await publish(tracker, issues, { labelPrefix: "spf" });

  const feature = tracker.created.find((c) => c.title === "A feature")!;
  const leaf = tracker.created.find((c) => c.title === "A leaf")!;
  assert.deepEqual(feature.labels, ["spf:type:feature"]);
  assert.deepEqual(leaf.labels, ["spf:type:story", "spf:refined"]);
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

test("refinementWellFormed: an empty issues list fails", () => {
  const report = refinementWellFormed(envelope([]), { repo_root: "/repo" });
  assert.equal(report.passed, false);
});

test("refinementWellFormed: a well-formed feature/story tree with no blockers passes clean", () => {
  const report = refinementWellFormed(
    envelope([node({ key: "F1", kind: "feature", title: "A feature" }), node({ key: "S1", kind: "story", title: "A leaf", parent: "F1" })]),
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
