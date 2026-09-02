/**
 * TraceDb: the async storage interface the trace database (`Tracer`'s writes,
 * `SfDb`'s reads) is built against — one interface, two backends.
 *
 * WHY ASYNC, WHEN `core/sqlite.ts`'s `Database` IS SYNCHRONOUS: Cloudflare
 * D1's only way to reach a database from a plain Node process (this CLI —
 * not a Cloudflare Worker, which would get a real binding) is its HTTP REST
 * API — a network call, inescapably async. Rather than fake synchrony over
 * that (shelling out to curl, a busy-wait/sync-XHR trick), every caller
 * upstream of storage (`Tracer`'s write methods, `SfDb`'s read methods) is
 * async too — see those modules' own headers for how far that propagates.
 * `LocalTraceDb` below pays that cost for nothing (every call still runs
 * synchronously, immediately; only the return value is wrapped as a settled
 * `Promise`) so the local path stays byte-for-byte the same behavior it
 * always had, just awaited.
 *
 * `query(sql)` mirrors `core/sqlite.ts`'s `Statement` shape exactly, only
 * every method returns a `Promise` — so a caller migrating from `Database`
 * changes `.get(...)` to `await .get(...)` and nothing else.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { Database, type DatabaseOptions } from "./sqlite.ts";
import type { NormalizedObservabilityDb } from "./data_types.ts";

/**
 * Bound on one D1 HTTP request, same `AbortController` + unref'd `setTimeout`
 * pattern `core/otel.ts`'s `flush()` uses for its own fetch calls — mirrored
 * rather than reinvented (see `D1TraceDb.post` below). Set well above otel's
 * own `SEND_TIMEOUT_MS` (2s): telemetry there is lossy and fire-and-forget,
 * so a short timeout just means "drop this batch." A D1 query here is a
 * REAL trace write/read a caller is awaiting — too short a timeout would
 * turn ordinary network jitter into spurious failures — but it must still be
 * BOUNDED, or a hung Cloudflare connection hangs the ADW run indefinitely.
 */
const D1_REQUEST_TIMEOUT_MS = 15_000;

export interface AsyncStatement<Row, Params extends unknown[]> {
  get(...params: Params): Promise<Row | null>;
  all(...params: Params): Promise<Row[]>;
  run(...params: Params): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
}

export interface TraceDb {
  query<Row = unknown, Params extends unknown[] = unknown[]>(sql: string): AsyncStatement<Row, Params>;
  /** One or more `;`-separated statements — schema DDL and additive migrations. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

// ── local (sqlite, via core/sqlite.ts's synchronous Database) ──────────────

/**
 * A thin async wrapper over the existing synchronous `Database` — every call
 * is dispatched immediately, synchronously, and its result (or thrown error)
 * is handed back as an already-settled `Promise` (via an `async` wrapper, so
 * a synchronous throw becomes a rejection rather than escaping the `Promise`
 * contract). Zero behavior change from `Database` itself; only the signature
 * is async, so this backend and `D1TraceDb` satisfy the exact same `TraceDb`
 * interface.
 *
 * `core/sqlite.ts` is deliberately left untouched — `cli/commands/abort.ts`
 * and `cli/commands/migrate.ts` still open a plain `Database` directly for
 * local-file-specific operations (marking a session aborted, physically
 * relocating the db file) that have no D1 equivalent. See those files' own
 * D1 guards.
 */
export class LocalTraceDb implements TraceDb {
  private readonly db: Database;

  constructor(dbPath: string, options?: DatabaseOptions) {
    if (!options?.readonly) mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, options);
  }

  query<Row = unknown, Params extends unknown[] = unknown[]>(sql: string): AsyncStatement<Row, Params> {
    const stmt = this.db.query<Row, Params>(sql);
    // `async` (not a bare `Promise.resolve(...)` wrapper) so a synchronous
    // throw from the underlying `Database` call — a readonly-connection
    // write, a constraint violation — becomes a REJECTED promise like every
    // other `TraceDb` method, rather than an exception thrown synchronously
    // out of a function whose declared return type is `Promise<...>`. A
    // caller that does `const p = db.query(sql).run(); await p` (not
    // `await db.query(sql).run()` inline) would otherwise never get the
    // chance to catch it.
    return {
      get: async (...params: Params) => stmt.get(...params),
      all: async (...params: Params) => stmt.all(...params),
      run: async (...params: Params) => stmt.run(...params),
    };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// ── remote (Cloudflare D1, via its HTTP REST API) ──────────────────────────

/**
 * D1 IS NOT LOCAL WAL SQLITE — DO NOT ASSUME THE SAME LIVE-READ GUARANTEE.
 *
 * `core/tracer.ts`'s header describes the local backend's contract: WAL mode
 * lets `spf ui` read the trace db WHILE an ADW process is still writing to
 * it, in the same instant, because both sides share one file on one
 * filesystem. A D1-backed repo has no such single file to share — `spf ui`
 * and a running chain each speak to D1 over independent HTTP calls, and (per
 * Cloudflare's own docs, https://developers.cloudflare.com/d1/best-practices/read-replication/)
 * a D1 database with read replication enabled offers SEQUENTIAL consistency,
 * not read-your-own-writes by default: a read immediately after a write can
 * land on a replica that has not caught up yet. D1's Sessions API closes that
 * gap with a "bookmark" a caller can pin subsequent reads to, but this
 * adapter does not use it (a bookmark is a client-scoped promise across ONE
 * lightweight connection; a Tracer that mints a fresh request per write and
 * an SfDb serving unrelated browser requests have no session to share it
 * through). This is a deliberate, documented trade-off (SPF #66) — not a bug
 * to fix here: a D1-backed repo's UI may briefly show a slightly-stale trace
 * while a chain is actively writing. Nothing about phase/gate/run OUTCOMES
 * depends on that live read — see tracer.ts's header, "SQLite is the source
 * of truth; nothing downstream of it can affect a phase, a gate, or a run
 * outcome" holds exactly the same way against D1.
 */
export class D1TraceDb implements TraceDb {
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly databaseId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(
    config: Extract<NormalizedObservabilityDb, { kind: "d1" }>,
    /** Injectable so tests never touch the real network — defaults to the global `fetch`. */
    fetchImpl: typeof fetch = fetch,
  ) {
    this.databaseId = config.database_id;
    this.accountId = readEnv(config.account_id_env, "D1 account id");
    this.apiToken = readEnv(config.api_token_env, "D1 API token");
    this.fetchImpl = fetchImpl;
    this.baseUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
  }

  query<Row = unknown, Params extends unknown[] = unknown[]>(sql: string): AsyncStatement<Row, Params> {
    return {
      get: async (...params: Params) => {
        const rows = await this.runOne<Row>(sql, params);
        return rows.results[0] ?? null;
      },
      all: async (...params: Params) => {
        const rows = await this.runOne<Row>(sql, params);
        return rows.results;
      },
      run: async (...params: Params) => {
        const rows = await this.runOne<Row>(sql, params);
        return { changes: rows.meta.changes ?? 0, lastInsertRowid: rows.meta.last_row_id ?? 0 };
      },
    };
  }

  /**
   * D1's HTTP `/query` endpoint accepts exactly one statement per `sql`
   * field (see the Workers binding's `prepare()`/`batch()` split — the HTTP
   * endpoint's single-request shape mirrors `prepare()`, not `exec()`);
   * `exec()` here — schema DDL and additive `ALTER TABLE` migrations, always
   * multiple statements — splits the text into individual statements and
   * sends them as one `batch` request instead, which D1 documents as
   * running sequentially and atomically. The split is naive (`;` at
   * statement end, one statement per line-ish chunk) because this only ever
   * runs against `tracer.ts`'s own hand-written `SCHEMA`/`MIGRATIONS`
   * constants — never arbitrary or user-supplied SQL.
   */
  async exec(sql: string): Promise<void> {
    const statements = splitStatements(sql);
    if (statements.length === 0) return;
    const body = { batch: statements.map((s) => ({ sql: s })) };
    await this.post(body);
  }

  close(): Promise<void> {
    // Stateless HTTP — no connection held open to release.
    return Promise.resolve();
  }

  private async runOne<Row>(sql: string, params: unknown[]): Promise<{ results: Row[]; meta: D1Meta }> {
    const body = { sql, params: params.length > 0 ? params : undefined };
    const results = await this.post(body);
    const first = results[0];
    if (!first) throw new Error(`D1 query returned no result set: ${sql}`);
    return { results: (first.results ?? []) as Row[], meta: first.meta ?? {} };
  }

  private async post(body: unknown): Promise<D1QueryResult[]> {
    // Same shape as `otel.ts`'s `flush()`: an `AbortController` whose timer
    // is unref'd (never the reason this process lingers) and always cleared,
    // win or lose. Unlike otel, a timeout here IS a thrown error — this
    // request is a real trace read/write a caller is awaiting, not a
    // best-effort fire-and-forget send.
    //
    // The timer is NOT cleared the moment `fetch` resolves with a `Response`
    // — resolving only means headers have arrived; the body can still be
    // in flight. `response.text()` is read inside this SAME try, under the
    // SAME `controller.signal`, so a server that sends headers and then
    // stalls the body still gets aborted at `D1_REQUEST_TIMEOUT_MS` (per the
    // fetch spec, aborting a request's signal also aborts an in-progress
    // body read) instead of hanging forever — exactly what this timeout
    // exists to prevent.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), D1_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      const timedOut = (error as { name?: string }).name === "AbortError";
      throw new Error(
        timedOut
          ? `D1 request timed out after ${D1_REQUEST_TIMEOUT_MS}ms`
          : `D1 request failed: ${(error as Error).message ?? error}`,
      );
    } finally {
      clearTimeout(timer);
    }

    let parsed: D1Envelope | undefined;
    try {
      parsed = text ? (JSON.parse(text) as D1Envelope) : undefined;
    } catch {
      // A non-JSON body (e.g. a Cloudflare edge error page) falls through to
      // the HTTP-status branch below with the raw text as context.
    }

    if (!response.ok) {
      const message = parsed?.errors?.map((e) => e.message).join("; ") || text.slice(0, 500) || response.statusText;
      throw new Error(`D1 HTTP ${response.status}: ${message}`);
    }
    if (!parsed || parsed.success !== true) {
      const message = parsed?.errors?.map((e) => e.message).join("; ") || "D1 reported failure with no error message";
      throw new Error(`D1 query failed: ${message}`);
    }
    // A `success:true` envelope that omits `result` entirely (seen from some
    // D1 edge responses) is still success — treat it as zero statements
    // rather than throwing `TypeError: parsed.result is not iterable`.
    const result = parsed.result ?? [];
    for (const item of result) {
      if (item.success === false) {
        throw new Error(`D1 statement failed: ${parsed.errors?.map((e) => e.message).join("; ") || "unknown error"}`);
      }
    }
    return result;
  }
}

/**
 * Split a `;`-terminated multi-statement string into individual statements,
 * dropping blanks and comment-only lines.
 *
 * `tracer.ts`'s `SCHEMA` carries `--`-style trailing comments on several
 * column definitions (e.g. `archived INTEGER DEFAULT 0 -- ...; never by a
 * run`), and those comments themselves contain `;` — a naive `sql.split(";")`
 * shreds the enclosing `CREATE TABLE` into fragments right in the middle of
 * a comment, producing statements no SQL engine accepts (an unterminated
 * `CREATE TABLE ... (`, an orphaned comment tail). This strips every `--` to
 * end-of-line FIRST, so a `;` inside a comment can no longer be mistaken for
 * a statement terminator, then splits what's left. Still only sound for
 * `tracer.ts`'s own hand-written SCHEMA/MIGRATIONS constants — not general
 * SQL (a `;` or `--` inside a quoted string literal is not accounted for,
 * and neither constant ever uses one).
 */
function splitStatements(sql: string): string[] {
  const withoutLineComments = sql
    .split("\n")
    .map((line) => {
      const commentAt = line.indexOf("--");
      return commentAt === -1 ? line : line.slice(0, commentAt);
    })
    .join("\n");
  return withoutLineComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function readEnv(name: string, what: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(`${what} is not set — the observability.db config names env var ${JSON.stringify(name)}, but it is empty or unset`);
  }
  return value;
}

interface D1Meta {
  changes?: number;
  last_row_id?: number;
  rows_read?: number;
  rows_written?: number;
}

interface D1QueryResult {
  success: boolean;
  results?: unknown[];
  meta?: D1Meta;
}

interface D1Envelope {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  messages?: Array<{ code: number; message: string }>;
  result: D1QueryResult[];
}

// ── factory ──────────────────────────────────────────────────────────────

export interface CreateTraceDbOptions {
  /** Local (`sqlite`) only — opens the connection read-only, matching `SfDb`'s reader. */
  readonly?: boolean;
  /** D1 only — injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** The one place `Tracer` and `SfDb` both go to get the right backend for `observability.db`'s resolved kind. */
export function createTraceDb(resolved: NormalizedObservabilityDb, options?: CreateTraceDbOptions): TraceDb {
  if (resolved.kind === "sqlite") {
    return new LocalTraceDb(resolved.path, options?.readonly ? { readonly: true } : undefined);
  }
  return new D1TraceDb(resolved, options?.fetchImpl);
}
