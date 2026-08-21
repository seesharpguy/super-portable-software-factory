/**
 * Route-parity regression test for the Bun.serve -> Hono port. Builds a real
 * spf.db (via the tracer, not a fixture file) and drives runUi() with real
 * HTTP requests — the same shape as the manual verification this port was
 * checked against, kept as a regression guard rather than a one-off.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Tracer } from "../core/tracer.js";
import { makeEventRecord } from "../core/data_types.js";
import { runUi, type UiHandle } from "../ui/server/serve.js";

let dir: string;
let handle: UiHandle;
const ADW_ID = "t1";

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "spf-ui-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  // -c user.*, not a global git config: this must pass in a fresh CI runner
  // with no git identity configured at all, not just on a dev machine that
  // already has one.
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=spf tests", "commit", "-q", "--allow-empty", "-m", "init"],
    { cwd: dir },
  );

  const dbPath = join(dir, "spf.db");
  const tracer = new Tracer(dbPath, join(dir, "sessions", ADW_ID, "events.jsonl"));
  tracer.sessionStart(ADW_ID, "tester", "quality");
  const phase = {
    phase_id: `${ADW_ID}_01_request`,
    adw_id: ADW_ID,
    seq: 1,
    params: { name: "request", kind: "engineer" as const, owner: "tester", description: "seed phase", retries: 0 },
    status: "success" as const,
    attempt: 0,
    error: null,
    started_at: null,
    ended_at: null,
  };
  tracer.phaseUpsert(phase);
  tracer.event(makeEventRecord({ adw_id: ADW_ID, phase_id: phase.phase_id, type: "log", name: "request", payload: { input: "seed" } }));
  tracer.sessionFinish(ADW_ID, true);

  // dist/test/ui_server.test.js -> dist -> package root -> web
  const webDir = join(import.meta.dirname, "..", "..", "web");
  handle = await runUi({ dbPath, webDir, port: 0, open: false });
});

after(async () => {
  await handle.close();
  rmSync(dir, { recursive: true, force: true });
});

async function get(path: string, init?: RequestInit): Promise<{ status: number; body: any; contentType: string }> {
  const res = await fetch(handle.url + path, init);
  const contentType = res.headers.get("content-type") ?? "";
  const body: any = contentType.includes("json") ? await res.json() : await res.text();
  return { status: res.status, body, contentType };
}

test("GET /api/health reports the real db path and session count", async () => {
  const { status, body } = await get("/api/health");
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.journal_mode, "wal");
  assert.equal(body.sessions, 1);
});

test("GET /api/sessions lists the seeded session", async () => {
  const { status, body } = await get("/api/sessions");
  assert.equal(status, 200);
  assert.equal(body.length, 1);
  assert.equal(body[0].adw_id, ADW_ID);
});

test("GET /api/sessions/:adw_id returns detail; unknown id 404s as JSON", async () => {
  const ok = await get(`/api/sessions/${ADW_ID}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.session.adw_id, ADW_ID);

  const missing = await get("/api/sessions/does-not-exist");
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /no session/);
});

test("POST /api/sessions/:adw_id/archive persists; GET on the same route 404s instead of falling through to the SPA", async () => {
  const post = await get(`/api/sessions/${ADW_ID}/archive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ archived: true }),
  });
  assert.equal(post.status, 200);
  assert.equal(post.body.archived, true);

  const afterArchive = await get("/api/sessions");
  assert.equal(afterArchive.body.length, 0, "archived sessions are excluded from the default list");

  const getOnArchive = await get(`/api/sessions/${ADW_ID}/archive`);
  assert.equal(getOnArchive.status, 404, "the deliberate behavior change from the Bun version: no silent SPA fallback here");
  assert.match(getOnArchive.contentType, /json/);
});

test("unsafe path segments (dot-segments, encoded percent) are rejected, never resolved onto disk", async () => {
  const encodedDotDot = await get(`/api/sessions/${ADW_ID}/agents/%2e%2e/prompts`);
  assert.equal(encodedDotDot.status, 404); // Hono's router normalizes this away before it reaches the handler

  const encodedPercent = await get(`/api/sessions/%2520/agents/x/prompts`);
  assert.equal(encodedPercent.status, 400);
  assert.match(encodedPercent.body.error, /invalid/);
});

test("unknown /api/* route 404s as JSON, not the SPA", async () => {
  const { status, contentType } = await get("/api/nope");
  assert.equal(status, 404);
  assert.match(contentType, /json/);
});

test("a non-API route serves the SPA's index.html (client-side routing fallback)", async () => {
  const { status, contentType, body } = await get("/some/client/route");
  assert.equal(status, 200);
  assert.match(contentType, /html/);
  assert.match(body, /<div id="app">/);
});

test("static assets are served with immutable caching; index.html is not", async () => {
  const index = await fetch(handle.url + "/");
  assert.equal(index.headers.get("cache-control"), "no-store");

  const html = await index.text();
  const assetMatch = html.match(/src="([^"]+\.js)"/);
  assert.ok(assetMatch, "index.html must reference a built JS asset");
  const asset = await fetch(handle.url + "/" + assetMatch[1].replace(/^\.\//, ""));
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
});
