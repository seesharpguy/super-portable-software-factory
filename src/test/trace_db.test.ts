/**
 * `core/trace_db.ts` — the async `TraceDb` interface both `Tracer` and
 * `SfDb` are built against (SPF #66, PR 2 of 3).
 *
 *  - `LocalTraceDb`: a transparent async wrapper over the existing
 *    synchronous `Database` (`core/sqlite.ts`) — every assertion here mirrors
 *    a `Database` behavior, just awaited.
 *  - `D1TraceDb`: exercised against a MOCKED `fetch` — never a real network
 *    call. Covers the request shape (URL, Authorization header, SQL+params
 *    body), successful row parsing, a D1-level API error (`success:false`),
 *    and an HTTP-level failure (401/500).
 *  - `Tracer`/`SfDb` end-to-end against d1: a real network call is still
 *    never made, but `fetchImpl` is backed by a real in-memory `node:sqlite`
 *    `DatabaseSync` instead of a hand-rolled response table — so these
 *    exercise the ACTUAL SQL `Tracer.open`/`SfDb` produce (schema DDL,
 *    migrations, `PRAGMA table_info` probes) against a real SQL engine, not
 *    just a mock that echoes back whatever the caller asserts. This is what
 *    catches a `splitStatements` bug that only manifests against `tracer.
 *    ts`'s own hand-written `SCHEMA` (see the `;`-inside-a-comment issue
 *    below) — a toy two-statement string with no comments cannot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createTraceDb, D1TraceDb, LocalTraceDb } from "../core/trace_db.js";
import { makeEventRecord, type NormalizedObservabilityDb } from "../core/data_types.js";
import { Tracer } from "../core/tracer.js";
import { SfDb } from "../ui/server/db.js";

// ── LocalTraceDb: transparent async wrapper over Database ──────────────────

function tmpDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "spf-localtracedb-test-"));
  return { dir, path: join(dir, "nested", "spf.db") };
}

test("LocalTraceDb: exec/query/run/get/all/close all work exactly like the underlying Database, just async", async () => {
  const { dir, path } = tmpDbPath();
  try {
    const db = new LocalTraceDb(path);
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    const insert = await db.query("INSERT INTO t (id, name) VALUES (?, ?)").run(1, "a");
    assert.equal(insert.changes, 1);

    const row = await db.query<{ id: number; name: string }, [number]>("SELECT id, name FROM t WHERE id = ?").get(1);
    assert.deepEqual(row, { id: 1, name: "a" });

    await db.query("INSERT INTO t (id, name) VALUES (?, ?)").run(2, "b");
    const rows = await db.query<{ id: number }, []>("SELECT id FROM t ORDER BY id").all();
    assert.deepEqual(rows.map((r) => r.id), [1, 2]);

    const missing = await db.query("SELECT id FROM t WHERE id = ?").get(999);
    assert.equal(missing, null, "no-row get() resolves to null, mirroring Database's own normalization");

    await db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LocalTraceDb: creates the parent directory for a nested db path, same as Tracer used to do itself", async () => {
  const { dir, path } = tmpDbPath();
  try {
    const db = new LocalTraceDb(path);
    await db.exec("CREATE TABLE t (id INTEGER)");
    await db.close();
    // If the directory hadn't been created, the constructor itself would
    // have thrown before this line was ever reached.
    assert.ok(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("LocalTraceDb: readonly:true opens without creating the parent dir, and rejects a write", async () => {
  const { dir, path } = tmpDbPath();
  try {
    const writer = new LocalTraceDb(path);
    await writer.exec("CREATE TABLE t (id INTEGER)");
    await writer.close();

    const reader = new LocalTraceDb(path, { readonly: true });
    const rows = await reader.query<{ id: number }, []>("SELECT id FROM t").all();
    assert.deepEqual(rows, []);
    await assert.rejects(() => reader.query("INSERT INTO t (id) VALUES (1)").run(), /readonly|read-only/i);
    await reader.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createTraceDb: a {kind:sqlite} descriptor produces a LocalTraceDb", () => {
  const resolved: NormalizedObservabilityDb = { kind: "sqlite", path: "/tmp/whatever/spf.db" };
  const db = createTraceDb(resolved);
  assert.ok(db instanceof LocalTraceDb);
});

test("createTraceDb: a {kind:d1} descriptor produces a D1TraceDb", () => {
  const originalAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const originalToken = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct123";
  process.env.CLOUDFLARE_API_TOKEN = "tok123";
  try {
    const resolved: NormalizedObservabilityDb = {
      kind: "d1",
      database_id: "db123",
      account_id_env: "CLOUDFLARE_ACCOUNT_ID",
      api_token_env: "CLOUDFLARE_API_TOKEN",
    };
    const db = createTraceDb(resolved);
    assert.ok(db instanceof D1TraceDb);
  } finally {
    if (originalAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = originalAccount;
    if (originalToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
    else process.env.CLOUDFLARE_API_TOKEN = originalToken;
  }
});

// ── D1TraceDb: mocked fetch only, never the real network ───────────────────

const D1_CONFIG = {
  kind: "d1" as const,
  database_id: "test-database-id",
  account_id_env: "TEST_D1_ACCOUNT_ID",
  api_token_env: "TEST_D1_API_TOKEN",
};

/**
 * `fn` is async — this MUST `await` it before the `finally` restores the env
 * vars, or the restore runs the moment `fn()` returns its (still-pending)
 * promise, at `fn`'s first `await`, not once its body has actually finished.
 */
async function withD1Env<T>(fn: () => Promise<T>): Promise<T> {
  const originalAccount = process.env.TEST_D1_ACCOUNT_ID;
  const originalToken = process.env.TEST_D1_API_TOKEN;
  process.env.TEST_D1_ACCOUNT_ID = "acct-abc";
  process.env.TEST_D1_API_TOKEN = "token-xyz";
  try {
    return await fn();
  } finally {
    if (originalAccount === undefined) delete process.env.TEST_D1_ACCOUNT_ID;
    else process.env.TEST_D1_ACCOUNT_ID = originalAccount;
    if (originalToken === undefined) delete process.env.TEST_D1_API_TOKEN;
    else process.env.TEST_D1_API_TOKEN = originalToken;
  }
}

interface CapturedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(
  respond: (req: CapturedRequest) => { status: number; body: unknown },
): { fetchImpl: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const req: CapturedRequest = { url, method: init?.method, headers, body };
    calls.push(req);
    const { status, body: respBody } = respond(req);
    return new Response(JSON.stringify(respBody), { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("D1TraceDb: request shape — URL names the account_id/database_id, Authorization is a real Bearer token, SQL+params ride the body", async () => {
  await withD1Env(async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 200,
      body: { success: true, errors: [], messages: [], result: [{ success: true, results: [{ n: 1 }], meta: {} }] },
    }));
    const db = new D1TraceDb(D1_CONFIG, fetchImpl);
    await db.query("SELECT ? AS n").get(1);

    assert.equal(calls.length, 1);
    const req = calls[0]!;
    assert.equal(req.method, "POST");
    assert.match(req.url, /\/accounts\/acct-abc\/d1\/database\/test-database-id\/query$/);
    assert.equal(req.headers["authorization"], "Bearer token-xyz");
    assert.deepEqual(req.body, { sql: "SELECT ? AS n", params: [1] });
  });
});

test("D1TraceDb: query().get() returns the first row, or null when the result set is empty", async () => {
  await withD1Env(async () => {
    const withRow = new D1TraceDb(
      D1_CONFIG,
      mockFetch(() => ({
        status: 200,
        body: { success: true, errors: [], messages: [], result: [{ success: true, results: [{ id: 7 }], meta: {} }] },
      })).fetchImpl,
    );
    assert.deepEqual(await withRow.query("SELECT id").get(), { id: 7 });

    const empty = new D1TraceDb(
      D1_CONFIG,
      mockFetch(() => ({
        status: 200,
        body: { success: true, errors: [], messages: [], result: [{ success: true, results: [], meta: {} }] },
      })).fetchImpl,
    );
    assert.equal(await empty.query("SELECT id").get(), null);
  });
});

test("D1TraceDb: query().all() returns every row", async () => {
  await withD1Env(async () => {
    const db = new D1TraceDb(
      D1_CONFIG,
      mockFetch(() => ({
        status: 200,
        body: { success: true, errors: [], messages: [], result: [{ success: true, results: [{ id: 1 }, { id: 2 }], meta: {} }] },
      })).fetchImpl,
    );
    assert.deepEqual(await db.query("SELECT id").all(), [{ id: 1 }, { id: 2 }]);
  });
});

test("D1TraceDb: query().run() maps meta.changes/last_row_id onto {changes, lastInsertRowid}", async () => {
  await withD1Env(async () => {
    const db = new D1TraceDb(
      D1_CONFIG,
      mockFetch(() => ({
        status: 200,
        body: {
          success: true,
          errors: [],
          messages: [],
          result: [{ success: true, results: [], meta: { changes: 3, last_row_id: 42 } }],
        },
      })).fetchImpl,
    );
    const result = await db.query("UPDATE t SET x = 1").run();
    assert.deepEqual(result, { changes: 3, lastInsertRowid: 42 });
  });
});

test("D1TraceDb: a D1-level API error (success:false, errors[]) throws with the error message", async () => {
  await withD1Env(async () => {
    const db = new D1TraceDb(
      D1_CONFIG,
      mockFetch(() => ({
        status: 200,
        body: { success: false, errors: [{ code: 7500, message: "SQLITE_ERROR: no such table: bogus" }], messages: [], result: [] },
      })).fetchImpl,
    );
    await assert.rejects(() => db.query("SELECT * FROM bogus").all(), /no such table: bogus/);
  });
});

test("D1TraceDb: a per-statement failure inside a successful envelope (result[].success:false) also throws", async () => {
  await withD1Env(async () => {
    const db = new D1TraceDb(
      D1_CONFIG,
      mockFetch(() => ({
        status: 200,
        body: {
          success: true,
          errors: [{ code: 7500, message: "constraint failed" }],
          messages: [],
          result: [{ success: false, results: [], meta: {} }],
        },
      })).fetchImpl,
    );
    await assert.rejects(() => db.query("INSERT INTO t VALUES (1)").run(), /constraint failed/);
  });
});

test("D1TraceDb: an HTTP-level failure (401) throws naming the status and the error body", async () => {
  await withD1Env(async () => {
    const db = new D1TraceDb(
      D1_CONFIG,
      mockFetch(() => ({
        status: 401,
        body: { success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: [] },
      })).fetchImpl,
    );
    await assert.rejects(() => db.query("SELECT 1").all(), /401/);
    await assert.rejects(() => db.query("SELECT 1").all(), /Authentication error/);
  });
});

test("D1TraceDb: an HTTP-level failure (500) throws naming the status", async () => {
  await withD1Env(async () => {
    const db = new D1TraceDb(
      D1_CONFIG,
      mockFetch(() => ({ status: 500, body: { success: false, errors: [{ code: 1101, message: "internal error" }], messages: [], result: [] } }))
        .fetchImpl,
    );
    await assert.rejects(() => db.query("SELECT 1").all(), /500/);
  });
});

test("D1TraceDb: a network-level fetch rejection surfaces as a clear error, never an unhandled rejection", async () => {
  await withD1Env(async () => {
    const failingFetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.cloudflare.com");
    }) as typeof fetch;
    const db = new D1TraceDb(D1_CONFIG, failingFetch);
    await assert.rejects(() => db.query("SELECT 1").all(), /ENOTFOUND/);
  });
});

test("D1TraceDb: exec() with multiple statements sends them as one batch request, not one request per statement", async () => {
  await withD1Env(async () => {
    const { fetchImpl, calls } = mockFetch(() => ({
      status: 200,
      body: { success: true, errors: [], messages: [], result: [{ success: true, results: [], meta: {} }, { success: true, results: [], meta: {} }] },
    }));
    const db = new D1TraceDb(D1_CONFIG, fetchImpl);
    await db.exec("CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER);");
    assert.equal(calls.length, 1, "one HTTP request for the whole multi-statement exec");
    assert.deepEqual(calls[0]!.body, { batch: [{ sql: "CREATE TABLE a (id INTEGER)" }, { sql: "CREATE TABLE b (id INTEGER)" }] });
  });
});

test("D1TraceDb: close() is a no-op that resolves immediately — no connection to release", async () => {
  await withD1Env(async () => {
    const db = new D1TraceDb(D1_CONFIG, mockFetch(() => ({ status: 200, body: {} })).fetchImpl);
    await assert.doesNotReject(() => db.close());
  });
});

test("D1TraceDb: throws a clear error at construction when account_id_env/api_token_env are unset — never silently dispatches unauthenticated", () => {
  const originalAccount = process.env.TEST_D1_ACCOUNT_ID;
  const originalToken = process.env.TEST_D1_API_TOKEN;
  delete process.env.TEST_D1_ACCOUNT_ID;
  delete process.env.TEST_D1_API_TOKEN;
  try {
    assert.throws(() => new D1TraceDb(D1_CONFIG), /TEST_D1_ACCOUNT_ID/);
  } finally {
    if (originalAccount === undefined) delete process.env.TEST_D1_ACCOUNT_ID;
    else process.env.TEST_D1_ACCOUNT_ID = originalAccount;
    if (originalToken === undefined) delete process.env.TEST_D1_API_TOKEN;
    else process.env.TEST_D1_API_TOKEN = originalToken;
  }
});

// ── Tracer / SfDb end-to-end against d1, backed by a real sqlite engine ────
//
// Every test above exercises `D1TraceDb` in isolation against hand-written
// toy SQL that this code path never actually receives in production. These
// instead point a mocked `fetch` at a real in-memory `node:sqlite`
// `DatabaseSync`, so `Tracer.open`'s SCHEMA/MIGRATIONS and `SfDb`'s
// `PRAGMA table_info`-driven `optionalColumn` probes run against a real SQL
// engine end-to-end — exactly what would catch a `splitStatements` bug that
// only manifests against `tracer.ts`'s own hand-written SCHEMA (its two
// `--`-comments that contain a `;`), which a toy two-statement string with
// no comments cannot.

const D1_TEST_DB = {
  kind: "d1" as const,
  database_id: "test-database-id",
  account_id_env: "TEST_D1_ACCOUNT_ID",
  api_token_env: "TEST_D1_API_TOKEN",
};

/**
 * D1's real HTTP `/query` endpoint rejects any single statement bound with
 * more than 100 parameters. `chunked()` (`ui/server/db.ts`) exists solely to
 * keep every `IN (...)` lookup under that cap — a test that never enforces
 * the cap can't tell a correctly-chunked query from one that just shoved all
 * N ids into a single unbounded bind, so `sqliteBackedFetch` below enforces
 * it too, the same way the real API would.
 */
const D1_MAX_BOUND_PARAMS = 100;

/**
 * A `fetch` stand-in that answers D1's HTTP `/query` contract (single
 * `{sql,params}` or `{batch:[{sql},...]}`, each answered with `results`/
 * `meta`) by actually running the SQL against `memDb` — never a real network
 * call, but a real SQLite engine underneath, so an invalid statement (a
 * shredded `CREATE TABLE`, a bad `ALTER`) throws exactly like it would
 * against the real D1 HTTP API instead of silently "succeeding" against a
 * mock that never parses SQL at all. Also enforces D1's real >100-bound-
 * param cap per statement (see `D1_MAX_BOUND_PARAMS`), which a mock that
 * merely echoes back whatever the caller sends would never catch.
 */
function sqliteBackedFetch(memDb: DatabaseSync): typeof fetch {
  const runOne = (sql: string, params: unknown[] = []): { success: true; results: unknown[]; meta: { changes: number; last_row_id: number } } => {
    if (params.length > D1_MAX_BOUND_PARAMS) {
      throw new D1ParamLimitError(
        `too many SQL variables: ${params.length} bound parameters exceeds D1's limit of ${D1_MAX_BOUND_PARAMS}`,
      );
    }
    const stmt = memDb.prepare(sql);
    const boundParams = params as SQLInputValue[];
    if (/^\s*(select|pragma)/i.test(sql)) {
      const results = stmt.all(...boundParams) as unknown[];
      return { success: true, results, meta: { changes: 0, last_row_id: 0 } };
    }
    const info = stmt.run(...boundParams);
    return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  };

  return (async (_input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    try {
      const result = Array.isArray(body.batch)
        ? body.batch.map((s: { sql: string }) => runOne(s.sql))
        : [runOne(body.sql, body.params ?? [])];
      return new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200 });
    } catch (error) {
      if (error instanceof D1ParamLimitError) {
        // Mirrors the real D1 HTTP API's shape for a rejected statement: a
        // 400 with `success:false` and an `errors[]` entry — not a thrown
        // network error — so `D1TraceDb.post`'s ordinary "D1 HTTP 400: ..."
        // error path is what a caller actually sees, same as production.
        return new Response(
          JSON.stringify({ success: false, errors: [{ code: 7500, message: error.message }], messages: [], result: [] }),
          { status: 400 },
        );
      }
      throw error;
    }
  }) as typeof fetch;
}

class D1ParamLimitError extends Error {}

test("Tracer.open({kind:d1}): creates all 7 SCHEMA tables against a real sqlite engine — `;` inside a `--` comment must not shred a CREATE TABLE", async () => {
  await withD1Env(async () => {
    const memDb = new DatabaseSync(":memory:");
    const eventsDir = mkdtempSync(join(tmpdir(), "spf-tracer-d1-test-"));
    try {
      const tracer = await Tracer.open(D1_TEST_DB, join(eventsDir, "events.jsonl"), null, { fetchImpl: sqliteBackedFetch(memDb) });
      // `sqlite_sequence` is SQLite's own implicit bookkeeping table for the
      // schema's AUTOINCREMENT columns (gate_results, processes) — excluded
      // here since it names no table of tracer.ts's own SCHEMA.
      const tableRows = memDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'sqlite_sequence' ORDER BY name")
        .all() as Array<{ name: string }>;
      assert.deepEqual(
        tableRows.map((r) => r.name),
        ["agent_sessions", "envelopes", "events", "gate_results", "phases", "processes", "sessions"],
        "every table in tracer.ts's SCHEMA must exist — a shredded CREATE TABLE would leave one missing (or throw before ever getting here)",
      );
      await tracer.close();
    } finally {
      memDb.close();
      rmSync(eventsDir, { recursive: true, force: true });
    }
  });
});

test("Tracer + SfDb ({kind:d1}): a full session lifecycle round-trips through a real sqlite engine behind mocked D1", async () => {
  await withD1Env(async () => {
    const memDb = new DatabaseSync(":memory:");
    const fetchImpl = sqliteBackedFetch(memDb);
    const eventsDir = mkdtempSync(join(tmpdir(), "spf-tracer-d1-test-"));
    try {
      const tracer = await Tracer.open(D1_TEST_DB, join(eventsDir, "events.jsonl"), null, { fetchImpl });
      const adwId = "adw-d1-e2e";
      await tracer.sessionStart(adwId, "jd", "build");
      await tracer.sessionRequest(adwId, "do the thing");
      await tracer.processStart(adwId, "adw", "", 4242, "spf run build");
      const phaseId = "phase-1";
      await tracer.db.query("INSERT INTO phases (phase_id, adw_id, seq, name, kind, status, started_at) VALUES (?,?,?,?,?,?,?)").run(
        phaseId,
        adwId,
        1,
        "build",
        "coding_agent",
        "success",
        new Date().toISOString(),
      );
      await tracer.event(
        makeEventRecord({ adw_id: adwId, phase_id: phaseId, type: "tool_call", name: "Read", payload: { agent: "worker" } }),
      );
      await tracer.sessionFinish(adwId, true); // also closes the "adw" process row started above

      const sfdb = await SfDb.open(D1_TEST_DB, eventsDir, { fetchImpl });
      const session = await sfdb.session(adwId);
      assert.equal(session?.status, "success");
      assert.equal(session?.request, "do the thing");
      assert.equal(session?.adw_name, "build", "optionalColumn(sessions, adw_name) resolved the real column, not the NULL fallback");

      const summaries = await sfdb.sessions();
      const summary = summaries.find((s) => s.adw_id === adwId);
      assert.ok(summary, "sessions() lists the session");
      assert.equal(summary?.phase_count, 1);

      const page = await sfdb.events(adwId);
      assert.equal(page.events.length, 1);
      assert.equal(page.events[0]?.name, "Read");

      const processRow = memDb.prepare("SELECT ended_at FROM processes WHERE adw_id = ? AND pid = ?").get(adwId, 4242) as
        | { ended_at: string | null }
        | undefined;
      assert.ok(processRow?.ended_at, "sessionFinish's processesEndAll closed the process row even on the d1 backend");

      await sfdb.close();
      await tracer.close();
    } finally {
      memDb.close();
      rmSync(eventsDir, { recursive: true, force: true });
    }
  });
});

test("Tracer.event({kind:d1}): a session's very first event write does not throw FOREIGN KEY constraint failed, even though D1 enforces FKs unconditionally", async () => {
  await withD1Env(async () => {
    // Deliberately a PLAIN `node:sqlite` `DatabaseSync` — NOT `core/sqlite.ts`'s
    // `Database` wrapper, which explicitly opens with
    // `enableForeignKeyConstraints: false` for the local backend (see its
    // header). `node:sqlite` defaults that option to `true`, so this memDb
    // enforces FKs exactly the way Cloudflare D1 does unconditionally (D1
    // offers no way to disable it) — the one setup that can actually catch
    // this bug. A mock that never enforces FKs (or reuses core/sqlite.ts's
    // Database) would hide the original bug just as easily as it would hide
    // a regression of the fix.
    const memDb = new DatabaseSync(":memory:");
    const fkPragma = memDb.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number } | undefined;
    assert.equal(
      fkPragma?.foreign_keys,
      1,
      "sanity check: this memDb really does enforce FKs, unlike core/sqlite.ts's Database",
    );
    const fetchImpl = sqliteBackedFetch(memDb);
    const eventsDir = mkdtempSync(join(tmpdir(), "spf-tracer-d1-fk-test-"));
    try {
      const tracer = await Tracer.open(D1_TEST_DB, join(eventsDir, "events.jsonl"), null, { fetchImpl });
      const adwId = "adw-d1-fk";
      // No `sessionStart` call before this — reproducing exactly what
      // `core/sqlite.ts`'s header describes: "the very first `events` row
      // for a session lands before that session's own `sessions` row
      // commits." Under the OLD schema (`events.adw_id TEXT REFERENCES
      // sessions`, `events.phase_id TEXT REFERENCES phases`) this insert
      // would violate BOTH foreign keys at once — there is no `sessions` row
      // for `adwId` yet, and `makeEventRecord`'s default `phase_id: ""` (an
      // event recorded outside any phase, never NULL) matches no `phases`
      // row either.
      await assert.doesNotReject(
        () => tracer.event(makeEventRecord({ adw_id: adwId, type: "log", name: "hello" })),
        "an event written before its session row exists, with phase_id='' (outside a phase), must not throw a FK error under D1's unconditional FK enforcement",
      );
      const row = memDb.prepare("SELECT adw_id, phase_id FROM events WHERE adw_id = ?").get(adwId) as
        | { adw_id: string; phase_id: string }
        | undefined;
      assert.equal(row?.adw_id, adwId);
      assert.equal(row?.phase_id, "");
      await tracer.close();
    } finally {
      memDb.close();
      rmSync(eventsDir, { recursive: true, force: true });
    }
  });
});

test("SfDb.open({kind:d1}): optionalColumn falls back to NULL AS <col> for a table missing a migrated column, driven by a real PRAGMA table_info", async () => {
  await withD1Env(async () => {
    const memDb = new DatabaseSync(":memory:");
    // A deliberately OLD schema — predates the `adw_name`/`archived` columns
    // tracer.ts's MIGRATIONS array adds — so optionalColumn's PRAGMA table_
    // info probe must report them absent and interpolate `NULL AS <col>`
    // rather than emit a SELECT that throws "no such column".
    memDb.exec(`
      CREATE TABLE sessions (
        adw_id TEXT PRIMARY KEY, request TEXT, status TEXT, engineer TEXT,
        started_at TEXT, ended_at TEXT, total_tokens INTEGER DEFAULT 0, total_cost REAL DEFAULT 0
      );
      CREATE TABLE phases (
        phase_id TEXT PRIMARY KEY, adw_id TEXT, seq INTEGER, name TEXT, kind TEXT, owner TEXT,
        description TEXT, status TEXT, attempt INTEGER, retries INTEGER, error TEXT, started_at TEXT, ended_at TEXT
      );
      CREATE TABLE events (
        event_id TEXT PRIMARY KEY, adw_id TEXT, phase_id TEXT, parent_id TEXT, type TEXT,
        name TEXT, payload_json TEXT, tokens INTEGER, started_at TEXT, ended_at TEXT
      );
      -- Deliberately missing color/context_tokens/context_window, same as sessions
      -- is missing adw_name/archived — agentsFor() (sessions()'s per-card agent
      -- lookup) must degrade the same way, not throw "no such column".
      CREATE TABLE agent_sessions (
        adw_id TEXT, agent TEXT, coding_agent TEXT, model TEXT, session_id TEXT,
        created_at TEXT, last_used_at TEXT, PRIMARY KEY (adw_id, agent)
      );
      INSERT INTO sessions (adw_id, request, status, engineer, started_at) VALUES ('adw-old', 'r', 'success', 'jd', '2024-01-01T00:00:00Z');
    `);
    const eventsDir = mkdtempSync(join(tmpdir(), "spf-sfdb-d1-test-"));
    try {
      const sfdb = await SfDb.open(D1_TEST_DB, eventsDir, { fetchImpl: sqliteBackedFetch(memDb) });
      const session = await sfdb.session("adw-old");
      assert.equal(session?.adw_name, null, "missing adw_name column resolves to NULL via optionalColumn, not a thrown error");
      const summaries = await sfdb.sessions();
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0]?.archived, null, "missing archived column also resolves to NULL");
      await sfdb.close();
    } finally {
      memDb.close();
      rmSync(eventsDir, { recursive: true, force: true });
    }
  });
});

// ── SfDb: IN (...) chunking (D1 caps bound params at 100; local sqlite does
// not, but the chunking is unconditional — same code path serves both) ─────

/** A single seeded session with one phase, via the real `Tracer`. */
async function seedSession(tracer: Tracer, adwId: string, adwName?: string): Promise<void> {
  await tracer.sessionStart(adwId, "tester", adwName);
  await tracer.phaseUpsert({
    phase_id: `${adwId}_01`,
    adw_id: adwId,
    seq: 1,
    params: { name: "build", kind: "engineer", owner: "tester", description: "seed", retries: 0 },
    status: "success",
    attempt: 0,
    error: null,
    started_at: null,
    ended_at: null,
  });
  await tracer.sessionFinish(adwId, true);
}

test("SfDb.sessions(): a phases IN(...) lookup over >100 session ids does not throw and returns every session's phase, not just the first chunk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-chunk-sessions-test-"));
  try {
    const dbPath = join(dir, "spf.db");
    const tracer = await Tracer.open(dbPath, join(dir, "events.jsonl"));
    // 130: bigger than both D1's 100-bound-param cap and SfDb's own 90-per-
    // chunk batch size, so this must span at least two chunks either way.
    const N = 130;
    for (let i = 0; i < N; i++) {
      await seedSession(tracer, `adw-${String(i).padStart(4, "0")}`);
    }
    await tracer.close();

    const sfdb = await SfDb.open(dbPath);
    const summaries = await sfdb.sessions(200);
    assert.equal(summaries.length, N, "every seeded session must come back, not just the first chunk's worth");
    for (const s of summaries) {
      assert.equal(s.phase_count, 1, `session ${s.adw_id} lost its phase — chunking must not silently drop rows`);
    }
    await sfdb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SfDb.sessions() ({kind:d1}): a phases IN(...) lookup over >100 session ids does not throw on the D1 backend's real 100-bound-param cap", async () => {
  // Unlike the local-sqlite version of this test above (which has no
  // parameter cap at all and would pass identically with `chunked()`
  // deleted), this one runs against the D1 backend via `sqliteBackedFetch`'s
  // enforced `D1_MAX_BOUND_PARAMS` — so it actually fails without
  // `chunked()`: a single unchunked `IN (...)` over 130 ids would trip the
  // mock's cap and `sessions()` would reject.
  await withD1Env(async () => {
    const memDb = new DatabaseSync(":memory:");
    const fetchImpl = sqliteBackedFetch(memDb);
    const eventsDir = mkdtempSync(join(tmpdir(), "spf-chunk-sessions-d1-test-"));
    try {
      const tracer = await Tracer.open(D1_TEST_DB, join(eventsDir, "events.jsonl"), null, { fetchImpl });
      const N = 130;
      for (let i = 0; i < N; i++) {
        await seedSession(tracer, `adw-d1-${String(i).padStart(4, "0")}`);
      }
      await tracer.close();

      const sfdb = await SfDb.open(D1_TEST_DB, eventsDir, { fetchImpl });
      const summaries = await sfdb.sessions(200);
      assert.equal(summaries.length, N, "every seeded session must come back, not just the first chunk's worth");
      for (const s of summaries) {
        assert.equal(s.phase_count, 1, `session ${s.adw_id} lost its phase — chunking must not silently drop rows`);
      }
      await sfdb.close();
    } finally {
      memDb.close();
      rmSync(eventsDir, { recursive: true, force: true });
    }
  });
});

test("SfDb.chainPhaseHistory(): a phases IN(...) lookup over >100 matching sessions does not throw and returns every session's phases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-chunk-history-test-"));
  try {
    const dbPath = join(dir, "spf.db");
    const tracer = await Tracer.open(dbPath, join(dir, "events.jsonl"));
    const N = 130;
    const chainName = "plan-build";
    for (let i = 0; i < N; i++) {
      await seedSession(tracer, `hist-${String(i).padStart(4, "0")}`, chainName);
    }
    await tracer.close();

    const sfdb = await SfDb.open(dbPath);
    const { sessions, joinedExcluded } = await sfdb.chainPhaseHistory(chainName);
    assert.equal(sessions.length, N, "every seeded session must come back, not just the first chunk's worth");
    assert.equal(joinedExcluded, 0);
    for (const s of sessions) {
      assert.equal(s.phases.length, 1, `session ${s.adw_id} lost its phase — chunking must not silently drop rows`);
    }
    await sfdb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── SfDb.exists() — the "is there anything to read yet" check every caller
// in `fanout.ts`/`loop.ts`/`watch.ts`/`estimate.ts` uses to decide whether to
// even attempt a read, and (as of round 3's fix) whether it's safe to skip
// wrapping that attempt in its own try/catch. Its whole contract is: return
// `false` for "nothing written yet", but let any OTHER failure (auth,
// network) THROW rather than also collapsing to `false` — a caller relying
// on that distinction to decide "skip, nothing to read" vs. "something's
// actually wrong" needs it to hold, and had zero direct test coverage before
// this file. ──────────────────────────────────────────────────────────────

test("SfDb.exists() ({kind:sqlite}): false before the db file exists, true once a Tracer has created it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-exists-sqlite-test-"));
  try {
    const dbPath = join(dir, "spf.db");
    const dataPaths = { db: { kind: "sqlite" as const, path: dbPath }, db_path: dbPath };
    assert.equal(await SfDb.exists(dataPaths), false, "no file on disk yet");

    const tracer = await Tracer.open(dbPath, join(dir, "events.jsonl"));
    await tracer.close();
    assert.equal(await SfDb.exists(dataPaths), true, "Tracer.open created the file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SfDb.exists() ({kind:d1}): false for a database that has never been written to (no sessions table), without throwing", async () => {
  await withD1Env(async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      // The real `sqlite_master` probe against a never-written D1 database:
      // a successful envelope whose result set is simply empty — no row for
      // "sessions", not an error of any kind.
      body: { success: true, errors: [], messages: [], result: [{ success: true, results: [], meta: {} }] },
    }));
    const dataPaths = { db: D1_CONFIG, db_path: null };
    assert.equal(await SfDb.exists(dataPaths, { fetchImpl }), false);
  });
});

test("SfDb.exists() ({kind:d1}): true once the sessions table is there", async () => {
  await withD1Env(async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: { success: true, errors: [], messages: [], result: [{ success: true, results: [{ name: "sessions" }], meta: {} }] },
    }));
    const dataPaths = { db: D1_CONFIG, db_path: null };
    assert.equal(await SfDb.exists(dataPaths, { fetchImpl }), true);
  });
});

test("SfDb.exists() ({kind:d1}): an auth failure (401) THROWS — must not collapse to false like a merely-empty database would", async () => {
  await withD1Env(async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 401,
      body: { success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: [] },
    }));
    const dataPaths = { db: D1_CONFIG, db_path: null };
    await assert.rejects(() => SfDb.exists(dataPaths, { fetchImpl }), /401/);
  });
});

test("SfDb.exists() ({kind:d1}): a network failure THROWS — the whole round-3 fix (skip the try/catch-free callers used to crash on) rests on this never silently reporting false", async () => {
  await withD1Env(async () => {
    const failingFetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.cloudflare.com");
    }) as typeof fetch;
    const dataPaths = { db: D1_CONFIG, db_path: null };
    await assert.rejects(() => SfDb.exists(dataPaths, { fetchImpl: failingFetch }), /ENOTFOUND/);
  });
});
