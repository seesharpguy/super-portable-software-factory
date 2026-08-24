import { test } from "node:test";
import assert from "node:assert/strict";
import { JiraProvider } from "../core/issues/jira_provider.js";
import type { JiraIssueTypeMap } from "../core/data_types.js";

const DEFAULT_ISSUE_TYPES: JiraIssueTypeMap = { epic: "Epic", feature: "Epic", story: "Story", bug: "Bug", task: "Task" };

function makeProvider(issueTypes: JiraIssueTypeMap = DEFAULT_ISSUE_TYPES): JiraProvider {
  return new JiraProvider("https://acme.atlassian.net", "PROJ", "spf", "you@example.com", "jira-token", issueTypes);
}

interface FetchCall {
  url: string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/**
 * Same fetch-mocking approach `refine.test.ts` already uses for
 * `GitHubProvider`, extended two ways: captures every SEQUENTIAL call
 * (some real flows would make more than one), and serves both `jira()`'s
 * `.text()`-then-`JSON.parse` path and `getIssue()`'s direct `.json()`
 * path from the same canned response — `JiraProvider` itself uses both
 * across its methods.
 */
function mockFetch(responses: Array<{ status?: number; body?: unknown }>): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  let i = 0;
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const resp = responses[Math.min(i, responses.length - 1)]!;
    i++;
    const status = resp.status ?? (resp.body === undefined ? 204 : 200);
    const text = resp.body === undefined ? "" : JSON.stringify(resp.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => resp.body,
    } as unknown as Response;
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ── createIssue ──────────────────────────────────────────────────────────

test("createIssue: posts project/summary/description(ADF)/issuetype(mapped)/labels, returns the response's key as id", async () => {
  const { calls, restore } = mockFetch([{ body: { id: "10001", key: "PROJ-42" } }]);
  try {
    const provider = makeProvider();
    const issue = await provider.createIssue({ title: "A story", body: "line one", labels: ["spf:type:story"], kind: "story" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "POST");
    assert.match(calls[0]!.url, /\/rest\/api\/3\/issue$/);
    assert.equal(calls[0]!.body.fields.project.key, "PROJ");
    assert.equal(calls[0]!.body.fields.summary, "A story");
    assert.equal(calls[0]!.body.fields.issuetype.name, "Story");
    assert.deepEqual(calls[0]!.body.fields.labels, ["spf:type:story"]);
    assert.deepEqual(calls[0]!.body.fields.description, {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "line one" }] }],
    });

    assert.equal(issue.id, "PROJ-42", "Issue.id is the human-facing key, not Jira's internal numeric id");
    assert.equal(issue.title, "A story");
  } finally {
    restore();
  }
});

test("createIssue: a container kind (epic/feature) also maps through issue_types — both default to Epic", async () => {
  const { calls, restore } = mockFetch([{ body: { id: "10003", key: "PROJ-44" } }, { body: { id: "10004", key: "PROJ-45" } }]);
  try {
    const provider = makeProvider();
    await provider.createIssue({ title: "An epic", body: "", labels: [], kind: "epic" });
    await provider.createIssue({ title: "A feature", body: "", labels: [], kind: "feature" });
    assert.equal(calls[0]!.body.fields.issuetype.name, "Epic");
    assert.equal(calls[1]!.body.fields.issuetype.name, "Epic");
  } finally {
    restore();
  }
});

test("createIssue: a custom issue_types override reaches issuetype.name instead of the default", async () => {
  const { calls, restore } = mockFetch([{ body: { id: "10002", key: "PROJ-43" } }]);
  try {
    const provider = makeProvider({ ...DEFAULT_ISSUE_TYPES, bug: "Defect" });
    await provider.createIssue({ title: "A bug", body: "", labels: [], kind: "bug" });
    assert.equal(calls[0]!.body.fields.issuetype.name, "Defect");
  } finally {
    restore();
  }
});

// ── linkChild ────────────────────────────────────────────────────────────

test("linkChild: PUTs the child's parent field to the parent's key", async () => {
  const { calls, restore } = mockFetch([{}]); // 204 No Content, like a Jira field-update PUT
  try {
    const provider = makeProvider();
    await provider.linkChild({ id: "PROJ-1", title: "epic", body: "", labels: [] }, { id: "PROJ-2", title: "story", body: "", labels: [] });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "PUT");
    assert.match(calls[0]!.url, /\/rest\/api\/3\/issue\/PROJ-2$/);
    assert.deepEqual(calls[0]!.body.fields.parent, { key: "PROJ-1" });
  } finally {
    restore();
  }
});

// ── listChildren ─────────────────────────────────────────────────────────

test('listChildren: POSTs a parent = "<id>" JQL search, maps results the same way state-label queries do', async () => {
  const { calls, restore } = mockFetch([
    { body: { issues: [{ id: "1", key: "PROJ-2", fields: { summary: "story one", description: null, labels: ["spf:refined"] } }] } },
  ]);
  try {
    const provider = makeProvider();
    const children = await provider.listChildren({ id: "PROJ-1", title: "epic", body: "", labels: [] });

    assert.equal(calls[0]!.method, "POST");
    assert.match(calls[0]!.url, /\/rest\/api\/3\/search\/jql$/);
    assert.equal(calls[0]!.body.jql, 'parent = "PROJ-1"');
    assert.deepEqual(children, [{ id: "PROJ-2", title: "story one", body: "", labels: ["spf:refined"] }]);
  } finally {
    restore();
  }
});

test("listChildren: no children is an empty array, not an error", async () => {
  const { restore } = mockFetch([{ body: { issues: [] } }]);
  try {
    const provider = makeProvider();
    const children = await provider.listChildren({ id: "PROJ-1", title: "epic", body: "", labels: [] });
    assert.deepEqual(children, []);
  } finally {
    restore();
  }
});

// ── validateIssueTypes ───────────────────────────────────────────────────

test("validateIssueTypes: every configured kind matches the project's real issue types", async () => {
  const { calls, restore } = mockFetch([{ body: { issueTypes: [{ name: "Epic" }, { name: "Story" }, { name: "Bug" }, { name: "Task" }], isLast: true } }]);
  try {
    const provider = makeProvider();
    const checks = await provider.validateIssueTypes();

    assert.match(calls[0]!.url, /\/rest\/api\/3\/issue\/createmeta\/PROJ\/issuetypes$/);
    assert.equal(calls[0]!.method, "GET");
    assert.ok(checks.every((c) => c.exists));
    assert.deepEqual(
      checks.map((c) => c.kind).sort(),
      ["bug", "epic", "feature", "story", "task"],
    );
  } finally {
    restore();
  }
});

test("validateIssueTypes: a project missing one configured type reports that one, and only that one, as missing", async () => {
  const { restore } = mockFetch([{ body: { issueTypes: [{ name: "Epic" }, { name: "Story" }, { name: "Defect" }, { name: "Task" }], isLast: true } }]); // no "Bug"
  try {
    const provider = makeProvider();
    const checks = await provider.validateIssueTypes();

    const bug = checks.find((c) => c.kind === "bug")!;
    assert.equal(bug.exists, false);
    assert.equal(bug.jiraType, "Bug");
    assert.ok(checks.filter((c) => c.kind !== "bug").every((c) => c.exists));
  } finally {
    restore();
  }
});

test("validateIssueTypes: a custom mapping is checked against its own configured name, not the default", async () => {
  const { restore } = mockFetch([{ body: { issueTypes: [{ name: "Epic" }, { name: "Story" }, { name: "Defect" }, { name: "Task" }], isLast: true } }]);
  try {
    const provider = makeProvider({ ...DEFAULT_ISSUE_TYPES, bug: "Defect" });
    const checks = await provider.validateIssueTypes();
    assert.equal(checks.find((c) => c.kind === "bug")!.exists, true);
  } finally {
    restore();
  }
});
