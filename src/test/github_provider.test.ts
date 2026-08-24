import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubProvider } from "../core/issues/github_provider.js";

function makeProvider(): GitHubProvider {
  return new GitHubProvider("acme/widgets", "spf", "ghp_test-token");
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
