import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubProvider } from "../core/issues/github_provider.js";
import type { GithubStatusMap } from "../core/data_types.js";

function makeProvider(projectNumber = 0, statusMap: GithubStatusMap = {}): GitHubProvider {
  return new GitHubProvider("acme/widgets", "spf", "ghp_test-token", projectNumber, statusMap);
}

interface FetchCall {
  url: string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** Same approach as `jira_provider.test.ts`'s own mock — captures every sequential fetch call and serves `.json()`, which is what this provider's `gh<T>()` wrapper reads. */
function mockFetch(responses: Array<{ status?: number; body?: unknown }>): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  let i = 0;
  (globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const resp = responses[Math.min(i, responses.length - 1)]!;
    i++;
    const status = resp.status ?? (resp.body === undefined ? 204 : 200);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (resp.body === undefined ? "" : JSON.stringify(resp.body)),
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

// ── readMarker/writeMarker: regression for MARKER_RE's non-greedy capture ──
//
// Same bug and same fix as `jira_provider.ts`'s own `MARKER_RE`:
// `WatchMarker.feedback` nests its own object ({rounds, asked_at}), so a
// lazy `\{.*?\}` used to stop at feedback's OWN closing brace instead of the
// marker's outer one, capturing unbalanced JSON the instant a spec
// escalates even once.

test("readMarker: correctly parses a marker whose JSON contains a nested feedback object", async () => {
  const marker = { worktree: "/x", branch: "spf-watch/1", pr: 5, attempt: 0, feedback: { rounds: 2, asked_at: "2026-01-01T00:00:00.000Z" } };
  const { restore } = mockFetch([{ body: [{ id: 1, body: `<!-- spf-watch: ${JSON.stringify(marker)} -->`, user: { login: "spf" }, created_at: "2026-01-01T00:00:00.000Z" }] }]);
  try {
    const provider = makeProvider();
    const read = await provider.readMarker({ id: "42", title: "issue", body: "", labels: [] });
    assert.deepEqual(read, marker);
  } finally {
    restore();
  }
});

test("writeMarker: finds and edits the existing marker in place (PATCH), even when its current content already has a nested feedback object", async () => {
  const existingMarker = { worktree: "/x", branch: "spf-watch/1", attempt: 0, feedback: { rounds: 1, asked_at: "2026-01-01T00:00:00.000Z" } };
  const { calls, restore } = mockFetch([
    { body: [{ id: 999, body: `<!-- spf-watch: ${JSON.stringify(existingMarker)} -->`, user: { login: "spf" }, created_at: "2026-01-01T00:00:00.000Z" }] },
    {}, // the PATCH itself
  ]);
  try {
    const provider = makeProvider();
    await provider.writeMarker(
      { id: "42", title: "issue", body: "", labels: [] },
      { ...existingMarker, feedback: { rounds: 2, asked_at: "2026-01-02T00:00:00.000Z" } },
    );

    assert.equal(calls.length, 2, "found the existing marker (GET), then edited it — never fell through to POSTing a new one");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[1]!.method, "PATCH");
    assert.match(calls[1]!.url, /\/comments\/999$/);
  } finally {
    restore();
  }
});

// ── transition/claim: status_map sync (Projects v2) ─────────────────────

const ISSUE = { id: "42", title: "x", body: "", labels: ["spf:working"] };
const STATUS_MAP: GithubStatusMap = { working: "In Progress", review: "In Review" };

/** A project resolve query response with a "Status" field carrying exactly the two options `STATUS_MAP` needs. */
function projectResolveBody(options: Array<{ id: string; name: string }> = [{ id: "opt_progress", name: "In Progress" }, { id: "opt_review", name: "In Review" }]) {
  return {
    data: {
      organization: { projectV2: { id: "PVT_1", fields: { nodes: [{ id: "PVTSSF_1", name: "Status", options }] } } },
      user: null,
    },
  };
}

test("transition: no status_map entry for the target state — labels only, no GraphQL", async () => {
  const { calls, restore } = mockFetch([{}, {}]); // label DELETE, label POST
  try {
    const provider = makeProvider(3, STATUS_MAP);
    await provider.transition(ISSUE, "done"); // "done" has no entry in STATUS_MAP
    assert.equal(calls.length, 2, "syncStatus should short-circuit before any GraphQL call when the state isn't configured");
  } finally {
    restore();
  }
});

test("transition: project_number: 0 (the default) disables sync outright, even with status_map configured — labels only", async () => {
  const { calls, restore } = mockFetch([{}, {}]);
  try {
    const provider = makeProvider(0, STATUS_MAP);
    await provider.transition(ISSUE, "review");
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

test("transition: with no status_map configured at all (the default), behaves exactly as before — labels only", async () => {
  const { calls, restore } = mockFetch([{}, {}]);
  try {
    const provider = makeProvider(3); // statusMap defaults to {}
    await provider.transition(ISSUE, "review");
    assert.equal(calls.length, 2);
  } finally {
    restore();
  }
});

test("transition: a configured state, a matching Status option, issue already on the project — labels, then project resolve, then item lookup, then field update", async () => {
  const { calls, restore } = mockFetch([
    {}, // label DELETE
    {}, // label POST
    { body: projectResolveBody() },
    { body: { data: { repository: { issue: { id: "I_1", projectItems: { nodes: [{ id: "PVTI_1", project: { id: "PVT_1" } }] } } } } } },
    {}, // updateProjectV2ItemFieldValue mutation
  ]);
  try {
    const provider = makeProvider(3, STATUS_MAP);
    await provider.transition(ISSUE, "review");

    assert.equal(calls.length, 5, "no addProjectV2ItemById — the issue was already on the project");
    assert.match(calls[2]!.url, /\/graphql$/);
    assert.match(calls[3]!.url, /\/graphql$/);
    assert.match(calls[4]!.url, /\/graphql$/);
    assert.match(calls[4]!.body.query, /updateProjectV2ItemFieldValue/);
    assert.deepEqual(calls[4]!.body.variables, { projectId: "PVT_1", itemId: "PVTI_1", fieldId: "PVTSSF_1", optionId: "opt_review" });
  } finally {
    restore();
  }
});

test("transition: the issue isn't on the project yet — adds it (addProjectV2ItemById), then sets the field", async () => {
  const { calls, restore } = mockFetch([
    {}, // label DELETE
    {}, // label POST
    { body: projectResolveBody() },
    { body: { data: { repository: { issue: { id: "I_1", projectItems: { nodes: [] } } } } } }, // not on this (or any) project yet
    { body: { data: { addProjectV2ItemById: { item: { id: "PVTI_new" } } } } },
    {}, // updateProjectV2ItemFieldValue mutation
  ]);
  try {
    const provider = makeProvider(3, STATUS_MAP);
    await provider.transition(ISSUE, "review");

    assert.equal(calls.length, 6);
    assert.match(calls[4]!.body.query, /addProjectV2ItemById/);
    assert.deepEqual(calls[4]!.body.variables, { projectId: "PVT_1", contentId: "I_1" });
    assert.deepEqual(calls[5]!.body.variables, { projectId: "PVT_1", itemId: "PVTI_new", fieldId: "PVTSSF_1", optionId: "opt_review" });
  } finally {
    restore();
  }
});

test("transition: a configured state with no matching Status option on the project — logs and resolves, never throws, no item lookup attempted", async () => {
  const { calls, restore } = mockFetch([
    {}, // label DELETE
    {}, // label POST
    { body: projectResolveBody([{ id: "opt_todo", name: "Todo" }, { id: "opt_done", name: "Done" }]) }, // no "In Review"
  ]);
  try {
    const provider = makeProvider(3, STATUS_MAP);
    await assert.doesNotReject(() => provider.transition(ISSUE, "review"));
    assert.equal(calls.length, 3, "no item lookup or mutation attempted once the option is known missing");
  } finally {
    restore();
  }
});

test("transition: project resolution GraphQL fails — logs and resolves, the label update already succeeded", async () => {
  const { calls, restore } = mockFetch([{}, {}, { status: 500, body: { message: "boom" } }]);
  try {
    const provider = makeProvider(3, STATUS_MAP);
    await assert.doesNotReject(() => provider.transition(ISSUE, "review"));
    assert.equal(calls.length, 3);
  } finally {
    restore();
  }
});

test("transition: the issue/projectItems lookup fails — logs and resolves, never throws", async () => {
  const { calls, restore } = mockFetch([{}, {}, { body: projectResolveBody() }, { status: 500, body: { message: "boom" } }]);
  try {
    const provider = makeProvider(3, STATUS_MAP);
    await assert.doesNotReject(() => provider.transition(ISSUE, "review"));
    assert.equal(calls.length, 4, "no field-update mutation attempted once the item lookup itself failed");
  } finally {
    restore();
  }
});

test("transition: addProjectV2ItemById fails — logs and resolves, never throws, no field-update attempted", async () => {
  const { calls, restore } = mockFetch([
    {},
    {},
    { body: projectResolveBody() },
    { body: { data: { repository: { issue: { id: "I_1", projectItems: { nodes: [] } } } } } },
    { status: 500, body: { message: "boom" } },
  ]);
  try {
    const provider = makeProvider(3, STATUS_MAP);
    await assert.doesNotReject(() => provider.transition(ISSUE, "review"));
    assert.equal(calls.length, 5);
  } finally {
    restore();
  }
});

test("claim: a successful claim also syncs status when status_map configures the target state", async () => {
  const readyIssue = { id: "43", title: "x", body: "", labels: ["spf:ready"] };
  const { calls, restore } = mockFetch([
    {}, // label DELETE (spf:ready)
    {}, // label POST (spf:working)
    { body: { number: 43, title: "x", body: "", labels: [{ name: "spf:working" }] } }, // re-fetch to confirm the claim
    { body: projectResolveBody() },
    { body: { data: { repository: { issue: { id: "I_1", projectItems: { nodes: [{ id: "PVTI_1", project: { id: "PVT_1" } }] } } } } } },
    {}, // updateProjectV2ItemFieldValue mutation
  ]);
  try {
    const provider = makeProvider(3, STATUS_MAP);
    const claimed = await provider.claim(readyIssue);
    assert.equal(claimed, true);
    assert.equal(calls.length, 6, "claim's own 3 calls, then syncStatus's 3");
    assert.match(calls[5]!.body.query, /updateProjectV2ItemFieldValue/);
  } finally {
    restore();
  }
});

test("claim: a LOST race (revert path) never attempts a status sync", async () => {
  const readyIssue = { id: "44", title: "x", body: "", labels: ["spf:ready"] };
  const { calls, restore } = mockFetch([
    {}, // label DELETE (spf:ready)
    {}, // label POST (spf:working)
    { body: { number: 44, title: "x", body: "", labels: [{ name: "spf:ready" }] } }, // someone else already claimed it
    {}, // revert POST
  ]);
  try {
    const provider = makeProvider(3, STATUS_MAP);
    const claimed = await provider.claim(readyIssue);
    assert.equal(claimed, false);
    assert.equal(calls.length, 4, "no 5th call — a lost claim must never touch Projects v2");
  } finally {
    restore();
  }
});

// ── validateStatusMap ─────────────────────────────────────────────────────

test("validateStatusMap: every configured state matches a real Status option on the project", async () => {
  const { calls, restore } = mockFetch([{ body: projectResolveBody() }]);
  try {
    const provider = makeProvider(3, STATUS_MAP);
    const checks = await provider.validateStatusMap();

    assert.match(calls[0]!.url, /\/graphql$/);
    assert.ok(checks.every((c) => c.exists));
    assert.deepEqual(
      checks.map((c) => c.state).sort(),
      ["review", "working"],
    );
  } finally {
    restore();
  }
});

test("validateStatusMap: a project missing one configured option reports that one, and only that one, as missing", async () => {
  const { restore } = mockFetch([{ body: projectResolveBody([{ id: "opt_progress", name: "In Progress" }, { id: "opt_done", name: "Done" }]) }]); // no "In Review"
  try {
    const provider = makeProvider(3, STATUS_MAP);
    const checks = await provider.validateStatusMap();

    const review = checks.find((c) => c.state === "review")!;
    assert.equal(review.exists, false);
    assert.equal(review.githubStatus, "In Review");
    assert.ok(checks.filter((c) => c.state !== "review").every((c) => c.exists));
  } finally {
    restore();
  }
});

test("validateStatusMap: unconfigured states are omitted entirely, not reported as missing", async () => {
  const { restore } = mockFetch([{ body: projectResolveBody([{ id: "opt_progress", name: "In Progress" }]) }]);
  try {
    const provider = makeProvider(3, { working: "In Progress" }); // only one of the six states set
    const checks = await provider.validateStatusMap();
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.state, "working");
  } finally {
    restore();
  }
});

test("validateStatusMap: an empty status_map (the default) reports nothing at all, without ever calling GraphQL", async () => {
  const { calls, restore } = mockFetch([{ body: projectResolveBody() }]);
  try {
    const provider = makeProvider(3); // statusMap defaults to {}
    const checks = await provider.validateStatusMap();
    assert.deepEqual(checks, []);
    assert.equal(calls.length, 0, "nothing configured — no reason to even resolve the project");
  } finally {
    restore();
  }
});

test("validateStatusMap: project_number: 0 (unconfigured) with status_map entries — every entry reports missing, never throws", async () => {
  const { calls, restore } = mockFetch([]);
  try {
    const provider = makeProvider(0, STATUS_MAP);
    const checks = await provider.validateStatusMap();
    assert.ok(checks.every((c) => !c.exists));
    assert.equal(calls.length, 0, "project_number: 0 short-circuits before any GraphQL call");
  } finally {
    restore();
  }
});
