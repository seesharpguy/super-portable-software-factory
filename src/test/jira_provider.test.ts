import { test } from "node:test";
import assert from "node:assert/strict";
import { JiraProvider } from "../core/issues/jira_provider.js";
import type { JiraIssueTypeMap, JiraStatusMap } from "../core/data_types.js";

const DEFAULT_ISSUE_TYPES: JiraIssueTypeMap = { epic: "Epic", feature: "Epic", story: "Story", bug: "Bug", task: "Task", spec: "Story" };

function makeProvider(issueTypes: JiraIssueTypeMap = DEFAULT_ISSUE_TYPES, statusMap: JiraStatusMap = {}): JiraProvider {
  return new JiraProvider("https://acme.atlassian.net", "PROJ", "spf", "you@example.com", "jira-token", issueTypes, statusMap);
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
      ["bug", "epic", "feature", "spec", "story", "task"],
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

// ── transition/claim: status_map sync ───────────────────────────────────

const ISSUE = { id: "PROJ-1", title: "x", body: "", labels: ["spf:working"] };
const STATUS_MAP: JiraStatusMap = { working: "In Progress", review: "In Review" };

test("transition: no status_map entry for the target state — labels PUT only, no transitions lookup", async () => {
  const { calls, restore } = mockFetch([{}]); // the label PUT, 204
  try {
    const provider = makeProvider(DEFAULT_ISSUE_TYPES, STATUS_MAP);
    await provider.transition(ISSUE, "done"); // "done" has no entry in STATUS_MAP
    assert.equal(calls.length, 1, "syncStatus should short-circuit before any fetch when the state isn't configured");
    assert.equal(calls[0]!.method, "PUT");
  } finally {
    restore();
  }
});

test("transition: a configured state with a matching available transition — labels PUT, then transitions GET, then transition POST", async () => {
  const { calls, restore } = mockFetch([
    {}, // label PUT, 204
    { body: { transitions: [{ id: "21", to: { name: "In Progress" } }, { id: "31", to: { name: "In Review" } }] } }, // GET transitions
    {}, // POST transition, 204
  ]);
  try {
    const provider = makeProvider(DEFAULT_ISSUE_TYPES, STATUS_MAP);
    await provider.transition(ISSUE, "review");

    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.method, "PUT");
    assert.equal(calls[1]!.method, "GET");
    assert.match(calls[1]!.url, /\/rest\/api\/3\/issue\/PROJ-1\/transitions$/);
    assert.equal(calls[2]!.method, "POST");
    assert.match(calls[2]!.url, /\/rest\/api\/3\/issue\/PROJ-1\/transitions$/);
    assert.deepEqual(calls[2]!.body, { transition: { id: "31" } });
  } finally {
    restore();
  }
});

test("transition: a configured state with no reachable transition from the current status — logs and resolves, never throws", async () => {
  const { calls, restore } = mockFetch([
    {}, // label PUT
    { body: { transitions: [{ id: "41", to: { name: "Done" } }] } }, // "In Review" isn't reachable from here
  ]);
  try {
    const provider = makeProvider(DEFAULT_ISSUE_TYPES, STATUS_MAP);
    await assert.doesNotReject(() => provider.transition(ISSUE, "review"));
    assert.equal(calls.length, 2, "no POST attempted when nothing matches");
  } finally {
    restore();
  }
});

test("transition: the transitions GET itself fails — logs and resolves, the label update already succeeded", async () => {
  const { calls, restore } = mockFetch([{}, { status: 500, body: { errorMessages: ["boom"] } }]);
  try {
    const provider = makeProvider(DEFAULT_ISSUE_TYPES, STATUS_MAP);
    await assert.doesNotReject(() => provider.transition(ISSUE, "review"));
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

test("transition: with no status_map configured at all (the default), behaves exactly as before — labels PUT only", async () => {
  const { calls, restore } = mockFetch([{}]);
  try {
    const provider = makeProvider(); // default statusMap = {}
    await provider.transition(ISSUE, "review");
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test("claim: a successful claim also syncs status when status_map configures the target state", async () => {
  const readyIssue = { id: "PROJ-2", title: "x", body: "", labels: ["spf:ready"] };
  const { calls, restore } = mockFetch([
    {}, // label PUT (ready -> working)
    { body: { fields: { summary: "x", description: null, labels: ["spf:working"] } } }, // re-fetch to confirm the claim
    { body: { transitions: [{ id: "21", to: { name: "In Progress" } }] } }, // status sync's transitions GET
    {}, // status sync's transition POST
  ]);
  try {
    const provider = makeProvider(DEFAULT_ISSUE_TYPES, STATUS_MAP);
    const claimed = await provider.claim(readyIssue);
    assert.equal(claimed, true);
    assert.equal(calls.length, 4, "claim's own 2 calls, then syncStatus's 2");
    assert.equal(calls[3]!.method, "POST");
    assert.deepEqual(calls[3]!.body, { transition: { id: "21" } });
  } finally {
    restore();
  }
});

test("claim: a LOST race (revert path) never attempts a status sync", async () => {
  const readyIssue = { id: "PROJ-3", title: "x", body: "", labels: ["spf:ready"] };
  const { calls, restore } = mockFetch([
    {}, // label PUT (ready -> working)
    { body: { fields: { summary: "x", description: null, labels: ["spf:ready"] } } }, // someone else already claimed it
    {}, // revert PUT
  ]);
  try {
    const provider = makeProvider(DEFAULT_ISSUE_TYPES, STATUS_MAP);
    const claimed = await provider.claim(readyIssue);
    assert.equal(claimed, false);
    assert.equal(calls.length, 3, "no 4th call — a lost claim must never touch Jira status");
  } finally {
    restore();
  }
});

// ── validateStatusMap ────────────────────────────────────────────────────

test("validateStatusMap: every configured state matches a real status somewhere in the project", async () => {
  const { calls, restore } = mockFetch([
    { body: [{ statuses: [{ name: "To Do" }, { name: "In Progress" }, { name: "In Review" }, { name: "Done" }] }] },
  ]);
  try {
    const provider = makeProvider(DEFAULT_ISSUE_TYPES, STATUS_MAP);
    const checks = await provider.validateStatusMap();

    assert.match(calls[0]!.url, /\/rest\/api\/3\/project\/PROJ\/statuses$/);
    assert.equal(calls[0]!.method, "GET");
    assert.ok(checks.every((c) => c.exists));
    assert.deepEqual(
      checks.map((c) => c.state).sort(),
      ["review", "working"],
    );
  } finally {
    restore();
  }
});

test("validateStatusMap: a project missing one configured status reports that one, and only that one, as missing", async () => {
  const { restore } = mockFetch([{ body: [{ statuses: [{ name: "To Do" }, { name: "In Progress" }, { name: "Done" }] }] }]); // no "In Review"
  try {
    const provider = makeProvider(DEFAULT_ISSUE_TYPES, STATUS_MAP);
    const checks = await provider.validateStatusMap();

    const review = checks.find((c) => c.state === "review")!;
    assert.equal(review.exists, false);
    assert.equal(review.jiraStatus, "In Review");
    assert.ok(checks.filter((c) => c.state !== "review").every((c) => c.exists));
  } finally {
    restore();
  }
});

test("validateStatusMap: unconfigured states are omitted entirely, not reported as missing", async () => {
  const { restore } = mockFetch([{ body: [{ statuses: [{ name: "To Do" }] }] }]);
  try {
    const provider = makeProvider(DEFAULT_ISSUE_TYPES, { working: "In Progress" }); // only one of the six states set
    const checks = await provider.validateStatusMap();
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.state, "working");
  } finally {
    restore();
  }
});

test("validateStatusMap: an empty status_map (the default) reports nothing at all", async () => {
  const { restore } = mockFetch([{ body: [{ statuses: [{ name: "To Do" }] }] }]);
  try {
    const provider = makeProvider(); // default statusMap = {}
    const checks = await provider.validateStatusMap();
    assert.deepEqual(checks, []);
  } finally {
    restore();
  }
});

// ── readMarker/writeMarker: regression for MARKER_RE's non-greedy capture ──
//
// `WatchMarker.feedback` nests its own object ({rounds, asked_at}). A lazy
// `\{.*?\}` stops at feedback's OWN closing brace instead of the marker's
// outer one, capturing unbalanced JSON the instant a spec escalates even
// once — JSON.parse then throws, is silently caught, and readMarker returns
// null forever after that point. This is exactly the bug that produced a
// real production loop: the round counter frozen at 1, a fresh marker
// comment posted every tick instead of the existing one edited in place,
// and a human's answer never recognized as an answer at all.

function adfMarker(text: string) {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

test("readMarker: correctly parses a marker whose JSON contains a nested feedback object", async () => {
  const marker = { worktree: "/x", branch: "spf-refine/BT-1", attempt: 0, feedback: { rounds: 2, asked_at: "2026-01-01T00:00:00.000Z" } };
  const { restore } = mockFetch([
    {
      body: {
        comments: [{ id: "1", body: adfMarker(`[spf-watch-marker] ${JSON.stringify(marker)}`), author: { displayName: "spf" }, created: "2026-01-01T00:00:00.000Z" }],
      },
    },
  ]);
  try {
    const provider = makeProvider();
    const read = await provider.readMarker({ id: "BT-1", title: "spec", body: "", labels: [] });
    assert.deepEqual(read, marker);
  } finally {
    restore();
  }
});

test("writeMarker: finds and edits the existing marker in place (PUT), even when its current content already has a nested feedback object", async () => {
  const existingMarker = { worktree: "/x", branch: "b", attempt: 0, feedback: { rounds: 1, asked_at: "2026-01-01T00:00:00.000Z" } };
  const { calls, restore } = mockFetch([
    {
      body: {
        comments: [
          { id: "999", body: adfMarker(`[spf-watch-marker] ${JSON.stringify(existingMarker)}`), author: { displayName: "spf" }, created: "2026-01-01T00:00:00.000Z" },
        ],
      },
    },
    {}, // the PUT itself — 204 No Content
  ]);
  try {
    const provider = makeProvider();
    await provider.writeMarker(
      { id: "BT-1", title: "spec", body: "", labels: [] },
      { ...existingMarker, feedback: { rounds: 2, asked_at: "2026-01-02T00:00:00.000Z" } },
    );

    assert.equal(calls.length, 2, "found the existing marker (GET), then edited it — never fell through to POSTing a new one");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[1]!.method, "PUT");
    assert.match(calls[1]!.url, /\/comment\/999$/);
  } finally {
    restore();
  }
});
