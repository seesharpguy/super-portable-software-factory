/**
 * Trace-db reader over a target repo's observability.db (local sqlite, or a
 * remote Cloudflare D1 database — see `core/trace_db.ts`).
 *
 * The read connection is opened readonly (local backend) and every query on
 * it is a SELECT — the writers are the tracers of running ADW processes,
 * and (for the LOCAL backend) WAL lets us read straight through their
 * inserts. See `core/trace_db.ts`'s `D1TraceDb` header for why that same
 * live-read guarantee does NOT hold for a D1-backed repo — a deliberate,
 * documented trade-off (SPF #66), not something this class works around.
 *
 * Every method here is now async — even for the local backend, which pays
 * nothing for it (`LocalTraceDb` resolves immediately) — because the D1
 * backend's only way to reach a database from this plain Node CLI is a real
 * HTTP call. See `core/tracer.ts`'s header for the fuller version of this
 * same rationale on the write side.
 *
 * ONE exception, opened lazily on its own connection: `setArchived`. Archiving
 * is review triage — "I have looked at this run" — which has to outlive a
 * browser, so it lives on the session row rather than in localStorage. It is
 * the only write this process can make, it touches exactly one column, and it
 * never runs unless a human clicks the button.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { NormalizedObservabilityDb } from "../../core/data_types.ts";
import type { DataPaths } from "../../core/paths.ts";
import { createTraceDb, type TraceDb } from "../../core/trace_db.ts";
import type {
  AgentSession,
  AgentStartPayload,
  Envelope,
  Event,
  EventsPage,
  GateResult,
  Phase,
  Session,
  SessionDetail,
  SessionSummary,
  SessionUsage,
} from "../shared/types.ts";

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 500;

export class SfDb {
  /** Absolute local sqlite path — `null` for a `kind:"d1"` config. */
  readonly path: string | null;
  /** Human label for API/console display: the sqlite path, or `d1:<database_id>`. */
  readonly label: string;
  /**
   * Where the ADW session dirs live: `{data_dir}/sessions/{adw_id}/{agent}/`.
   * Passed in explicitly (from `paths.resolveDataPaths(...).sessions_dir`)
   * rather than derived from the db path — session JSONL/envelope artifact
   * files always live on the local filesystem regardless of where the
   * queryable trace mirror (`db` below) lives; see `paths.ts`'s `DataPaths`.
   */
  readonly sessionsDir: string;
  /** `"n/a (d1)"` for a remote backend — journal mode is a local-file concept. */
  readonly journalMode: string;
  private readonly db: TraceDb;
  private readonly dbConfig: NormalizedObservabilityDb;
  /** D1-only; carried from `open()`'s `options.fetchImpl` so a lazily-opened writer (`setArchived`) uses the same injected fetch a test gave the reader. */
  private readonly fetchImpl: typeof fetch | undefined;
  /** Opened on first archive and kept; `null` until then. */
  private writer: TraceDb | null = null;
  /** Cache for optionalColumn(), keyed "table.column". Only ever false → true. */
  private readonly columnCache = new Map<string, boolean>();

  private constructor(db: TraceDb, dbConfig: NormalizedObservabilityDb, sessionsDir: string, journalMode: string, fetchImpl?: typeof fetch) {
    this.db = db;
    this.dbConfig = dbConfig;
    this.path = dbConfig.kind === "sqlite" ? dbConfig.path : null;
    this.label = dbConfig.kind === "sqlite" ? dbConfig.path : `d1:${dbConfig.database_id}`;
    this.sessionsDir = sessionsDir;
    this.journalMode = journalMode;
    this.fetchImpl = fetchImpl;
  }

  /**
   * Open a trace db for reading. `dbConfig` accepts either a bare local
   * sqlite path (sugar for `{kind:"sqlite",path}` — `--db <path>`/`SF_DB`
   * CLI overrides, and every test's shorthand) or a normalized
   * `observability.db` descriptor (`paths.resolveDataPaths(...).db`).
   *
   * `sessionsDir` should be `paths.resolveDataPaths(...).sessions_dir`
   * whenever the caller has a `DataPaths` in hand; omitted, it falls back to
   * the historical "sibling of the sqlite file" derivation — only valid for
   * the LOCAL backend (a bare-path caller has no other sessions dir to
   * offer), so it is required when `dbConfig` names a `kind:"d1"` config.
   *
   * `options.fetchImpl` is D1-only and exists purely so tests can drive this
   * end-to-end against a mocked D1 HTTP response shape — every real caller
   * omits it and gets the global `fetch`, same as `createTraceDb` itself.
   */
  static async open(
    dbConfig: NormalizedObservabilityDb | string,
    sessionsDir?: string,
    options?: { fetchImpl?: typeof fetch },
  ): Promise<SfDb> {
    const normalized: NormalizedObservabilityDb = typeof dbConfig === "string" ? { kind: "sqlite", path: dbConfig } : dbConfig;
    if (normalized.kind === "sqlite" && !existsSync(normalized.path)) {
      throw new Error(
        `spf.db not found at ${normalized.path}\n` +
          `Point spf ui at a target repo: --db <path>, SF_DB=<path>, --cwd <repo>, or run it from inside one.`,
      );
    }
    const resolvedSessionsDir =
      sessionsDir ??
      (normalized.kind === "sqlite"
        ? resolve(dirname(normalized.path), "sessions")
        : (() => {
            throw new Error("SfDb.open: sessionsDir is required for a d1-backed repo — pass paths.resolveDataPaths(...).sessions_dir");
          })());

    const db = createTraceDb(normalized, { readonly: true, fetchImpl: options?.fetchImpl });

    // WAL is set by the tracer when it creates the db; a readonly connection
    // cannot change it, so we assert rather than set, and always take the
    // busy_timeout so a concurrent writer never turns into a failed request.
    // None of this has a D1 equivalent — journal_mode/busy_timeout are local
    // sqlite-file concepts (see the class header for what D1 offers instead).
    let journalMode = "n/a (d1)";
    if (normalized.kind === "sqlite") {
      await db.exec("PRAGMA busy_timeout = 5000");
      await db.exec("PRAGMA synchronous = NORMAL");
      const mode = await db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
      journalMode = mode?.journal_mode ?? "unknown";
      if (journalMode.toLowerCase() !== "wal") {
        console.warn(
          `[db] journal_mode is "${journalMode}", expected "wal" — ` +
            `live reads during agent writes may block`,
        );
      }
    } else {
      // The sqlite branch above gets a friendly "spf.db not found" check
      // before ever issuing a query; a D1 database has no file to check for
      // existence, so an empty/never-written one instead surfaces as a raw
      // "no such table: sessions" the first time any API route queries it.
      // A cheap sqlite_master probe here gets the same friendly failure the
      // local backend already has, at open time, in one place.
      const table = await db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name='sessions'")
        .get();
      if (!table) {
        throw new Error(
          `D1 database ${JSON.stringify(normalized.database_id)} has no "sessions" table — ` +
            `point spf ui at a target repo whose D1 database has been written to at least once ` +
            `(run any ADW against it first), or check observability.db in spf.config.yaml.`,
        );
      }
    }
    return new SfDb(db, normalized, resolvedSessionsDir, journalMode, options?.fetchImpl);
  }

  /**
   * Cheap "is there anything to read yet" check — the async equivalent of
   * the `existsSync(dataPaths.db_path)` fast path every sqlite-only caller
   * used before D1 existed, extended to cover the d1 case those callers
   * never accounted for.
   *
   * `open()` deliberately THROWS a friendly, actionable error on a
   * never-written db (see above) — the right behavior for `spf ui`, where
   * "nothing here yet" is a misconfiguration to surface loudly. Callers that
   * instead want to treat a never-written db as "empty, skip this check" —
   * `spf fanout`'s collision preflight and lazy metrics reader, `spf loop`'s
   * per-iteration readback, `spf estimate`'s cold-start path, `spf watch`'s
   * salt-collision short-circuit — use this instead, so they behave
   * identically whether the backend is local sqlite or a fresh D1 database
   * that has never been written to.
   *
   * For a `kind:"sqlite"` db: `existsSync(dataPaths.db_path)`, unchanged.
   * For a `kind:"d1"` db: the same `sqlite_master` probe `open()`'s
   * friendly-error path already runs, but returning `false` instead of
   * throwing when the `sessions` table isn't there yet. Any OTHER failure
   * (network, auth, a malformed database_id) still throws — only "nothing
   * written yet" collapses to `false`.
   */
  static async exists(dataPaths: Pick<DataPaths, "db" | "db_path">, options?: { fetchImpl?: typeof fetch }): Promise<boolean> {
    if (dataPaths.db.kind === "sqlite") {
      return dataPaths.db_path !== null && existsSync(dataPaths.db_path);
    }
    const db = createTraceDb(dataPaths.db, { readonly: true, fetchImpl: options?.fetchImpl });
    try {
      const table = await db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name='sessions'")
        .get();
      return table !== undefined && table !== null;
    } finally {
      await db.close();
    }
  }

  /**
   * A SELECT fragment for a column the tracer adds by migration.
   *
   * We open readonly and cannot run those ALTERs ourselves, so selecting one
   * blindly would throw "no such column" on every request against a db an older
   * tracer wrote. Instead we probe and substitute NULL, which reads downstream
   * as "this db predates the column" — the same thing the UI shows for a row
   * the migration didn't backfill.
   *
   * The probe re-runs while the column is missing, because the tracer's ALTER
   * can land while we're serving: a startup-only check would keep returning
   * NULL for the rest of the process even after the data arrived. Once seen,
   * a column never goes away, so it latches.
   */
  private async hasColumn(table: string, column: string): Promise<boolean> {
    const key = `${table}.${column}`;
    if (!this.columnCache.get(key)) {
      const cols = await this.db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all();
      this.columnCache.set(key, cols.some((c) => c.name === column));
    }
    return this.columnCache.get(key) ?? false;
  }

  private async optionalColumn(table: string, column: string): Promise<string> {
    return (await this.hasColumn(table, column)) ? column : `NULL AS ${column}`;
  }

  /**
   * D1 caps bound parameters at 100 per statement; local sqlite allows tens
   * of thousands. Any query that binds a whole id list into an `IN (...)`
   * clause must go through this instead of a single unbounded bind, or it
   * throws past ~100 ids on the D1 backend. Chunking is harmless on the
   * local backend too (just slightly less efficient), so this is used
   * unconditionally rather than special-cased per backend.
   *
   * Each id belongs to exactly one chunk, so per-id ordering from `fn`'s own
   * ORDER BY is preserved — only the relative order of rows belonging to
   * *different* chunks can interleave, which none of this class's callers
   * depend on (they always regroup by id afterward).
   */
  private async chunked<T>(ids: string[], fn: (chunk: string[]) => Promise<T[]>, size = 90): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += size) {
      out.push(...(await fn(ids.slice(i, i + size))));
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.writer) await this.writer.close();
    await this.db.close();
  }

  /**
   * Archive or restore a session — the only write in this process.
   *
   * busy_timeout matters: a run may be mid-insert on the same WAL db, and a
   * click should wait its turn rather than fail. Returns false when the id
   * does not exist, so the route can 404 instead of silently succeeding.
   */
  async setArchived(adwId: string, archived: boolean): Promise<boolean> {
    if (!(await this.hasColumn("sessions", "archived"))) {
      throw new Error("this db predates the archived column — run any ADW once to migrate it");
    }
    if (!this.writer) {
      this.writer = createTraceDb(this.dbConfig, { fetchImpl: this.fetchImpl });
      if (this.dbConfig.kind === "sqlite") await this.writer.exec("PRAGMA busy_timeout=5000;");
    }
    await this.writer
      .query("UPDATE sessions SET archived = ? WHERE adw_id = ?")
      .run(archived ? 1 : 0, adwId);
    return (await this.session(adwId)) !== null;
  }

  /** Sessions, most recent first, each with its phase statuses for the progress dots. */
  async sessions(limit = 200): Promise<SessionSummary[]> {
    const rows = await this.db
      .query<Session, [number]>(
        `SELECT adw_id, ${await this.optionalColumn("sessions", "adw_name")}, request,
                status, engineer, started_at, ended_at,
                total_tokens, total_cost,
                ${await this.optionalColumn("sessions", "archived")}
           FROM sessions
          WHERE COALESCE(${(await this.hasColumn("sessions", "archived")) ? "archived" : "0"}, 0) = 0
          ORDER BY started_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(clamp(limit, 1, MAX_LIMIT));

    if (rows.length === 0) return [];

    // Embed each session's phases so the L1 progress dots cost no extra request.
    const ids = rows.map((row) => row.adw_id);
    const phaseRows = await this.chunked(ids, (chunk) => {
      const placeholders = chunk.map(() => "?").join(", ");
      return this.db
        .query<Phase, string[]>(
          `SELECT phase_id, adw_id, seq, name, kind, owner, description, status,
                  attempt, retries, error, started_at, ended_at
             FROM phases WHERE adw_id IN (${placeholders}) ORDER BY seq, rowid`,
        )
        .all(...chunk);
    });

    const byAdw = new Map<string, Phase[]>();
    for (const phase of phaseRows) {
      const list = byAdw.get(phase.adw_id);
      if (list) list.push(phase);
      else byAdw.set(phase.adw_id, [phase]);
    }

    // Agents come along too: an L1 card draws a per-agent dot timeline, and its
    // dots are colored per agent — without this it would be one request per card.
    const agentsByAdw = await this.agentsFor(ids);

    const summaries: SessionSummary[] = [];
    for (const session of rows) {
      const phases = byAdw.get(session.adw_id) ?? [];
      summaries.push(
        Object.assign(session, {
          phases,
          phase_count: phases.length,
          agents: agentsByAdw.get(session.adw_id) ?? [],
        }),
      );
    }
    return summaries;
  }

  async session(adwId: string): Promise<Session | null> {
    return (
      (await this.db
        .query<Session, [string]>(
          `SELECT adw_id, ${await this.optionalColumn("sessions", "adw_name")}, request,
                  status, engineer, started_at, ended_at,
                  total_tokens, total_cost
             FROM sessions WHERE adw_id = ?`,
        )
        .get(adwId)) ?? null
    );
  }

  async phases(adwId: string): Promise<Phase[]> {
    return this.db
      .query<Phase, [string]>(
        `SELECT phase_id, adw_id, seq, name, kind, owner, description, status,
                attempt, retries, error, started_at, ended_at
           FROM phases WHERE adw_id = ? ORDER BY seq, rowid`,
      )
      .all(adwId);
  }

  async agentSessions(adwId: string): Promise<AgentSession[]> {
    return (await this.agentsFor([adwId])).get(adwId) ?? [];
  }

  /**
   * Agents per session, for a set of ids at once: the agent_sessions rows plus
   * anything that has started but not finished.
   *
   * agents.ts writes the agent_sessions row only after the envelope persists, so
   * a running agent has no row there — precisely the case the live view exists
   * for. Its model, color and session_id are already on the agent_start event,
   * so a lane is labelled and colored from the moment the agent spawns.
   */
  private async agentsFor(adwIds: string[]): Promise<Map<string, AgentSession[]>> {
    const byAdw = new Map<string, AgentSession[]>();
    if (adwIds.length === 0) return byAdw;

    const append = (adwId: string, agent: AgentSession) => {
      const list = byAdw.get(adwId);
      if (list) list.push(agent);
      else byAdw.set(adwId, [agent]);
    };

    const color = await this.optionalColumn("agent_sessions", "color");
    const ctxUsed = await this.optionalColumn("agent_sessions", "context_tokens");
    const ctxWindow = await this.optionalColumn("agent_sessions", "context_window");

    const completed = await this.chunked(adwIds, (chunk) => {
      const placeholders = chunk.map(() => "?").join(", ");
      return this.db
        .query<AgentSession, string[]>(
          `SELECT adw_id, agent, coding_agent, model, session_id, ${color},
                  ${ctxUsed}, ${ctxWindow}, created_at, last_used_at
             FROM agent_sessions WHERE adw_id IN (${placeholders})
            ORDER BY created_at, agent`,
        )
        .all(...chunk);
    });
    for (const row of completed) append(row.adw_id, row);

    const started = await this.chunked(adwIds, (chunk) => {
      const placeholders = chunk.map(() => "?").join(", ");
      return this.db
        .query<
          {
            adw_id: string;
            agent: string | null;
            payload_json: string | null;
            started_at: string | null;
          },
          string[]
        >(
          `SELECT e.adw_id, p.owner AS agent, e.payload_json, e.started_at
             FROM events e JOIN phases p ON p.phase_id = e.phase_id
            WHERE e.adw_id IN (${placeholders}) AND e.type = 'agent_start'
            ORDER BY e.rowid`,
        )
        .all(...chunk);
    });

    for (const row of started) {
      if (!row.agent) continue;
      // A finished row is authoritative; only fill genuine gaps.
      if (byAdw.get(row.adw_id)?.some((a) => a.agent === row.agent)) continue;
      let payload: AgentStartPayload = {};
      try {
        payload = JSON.parse(row.payload_json ?? "{}") as AgentStartPayload;
      } catch {
        // A malformed payload just means no label — never a failed request.
      }
      append(row.adw_id, {
        adw_id: row.adw_id,
        agent: row.agent,
        coding_agent: null,
        model: payload.model ?? null,
        session_id: payload.session_id ?? null,
        color: payload.color ?? null,
        // Occupancy is only known once the agent's turn closes.
        context_tokens: null,
        context_window: null,
        created_at: row.started_at,
        last_used_at: row.started_at,
      });
    }
    return byAdw;
  }

  /** Session + phases + agents in one shot — L2 needs all three to draw lanes. */
  async sessionDetail(adwId: string): Promise<SessionDetail | null> {
    const session = await this.session(adwId);
    if (!session) return null;

    return {
      session,
      usage: await this.usage(adwId),
      phases: await this.phases(adwId),
      agents: await this.agentSessions(adwId),
    };
  }

  /**
   * Raw tokens read and written, beside the billed headline.
   *
   * Derived from the `agent_end` payloads rather than stored, so every run
   * already in the db gets the split without a migration or a re-run.
   *
   * `total_tokens` is a SPEND number: every turn re-sends the whole
   * conversation, so an 86k conversation over 49 turns bills millions. These
   * two say what actually moved — material read for the first time, and
   * material generated. The gap between them and the headline is cached
   * re-reads, which is usually most of it.
   */
  async usage(adwId: string): Promise<SessionUsage> {
    const rows = await this.db
      .query<{ payload_json: string | null }, [string]>(
        "SELECT payload_json FROM events WHERE adw_id = ? AND type = 'agent_end'",
      )
      .all(adwId);

    let read = 0;
    let written = 0;
    for (const row of rows) {
      if (!row.payload_json) continue;
      try {
        const u = (JSON.parse(row.payload_json) as { usage?: Record<string, number> }).usage;
        if (!u) continue;
        // RAW reads only: material entering the context for the first time,
        // billed either as uncached input or as a cache write. Cache reads are
        // the same tokens served again on later turns — counting them here
        // would rebuild the very inflation this split exists to expose.
        read += (u.input_tokens ?? 0) + (u.cache_write_tokens ?? 0);
        written += u.output_tokens ?? 0;
      } catch {
        /* a payload written by an older tracer simply contributes nothing */
      }
    }
    return { read, written };
  }

  /**
   * The polling query. Rowid cursor, insertion order, bounded page — the same
   * mechanism serves the live tail and lazy-paged history.
   */
  async events(adwId: string, after = 0, limit = DEFAULT_LIMIT): Promise<EventsPage> {
    const cappedLimit = clamp(limit, 1, MAX_LIMIT);
    const events = await this.db
      .query<Event, [string, number, number]>(
        `SELECT rowid, event_id, adw_id, phase_id, parent_id, type, name,
                payload_json, tokens, started_at, ended_at
           FROM events
          WHERE adw_id = ? AND rowid > ?
          ORDER BY rowid
          LIMIT ?`,
      )
      .all(adwId, Math.max(0, after), cappedLimit);

    return {
      events,
      cursor: events.length > 0 ? events[events.length - 1]!.rowid : Math.max(0, after),
      has_more: events.length === cappedLimit,
    };
  }

  async envelopes(adwId: string): Promise<Envelope[]> {
    return this.db
      .query<Envelope, [string]>(
        `SELECT envelope_id, adw_id, phase_id, agent, output_type, payload_json,
                valid, attempt, created_at
           FROM envelopes WHERE adw_id = ? ORDER BY created_at, rowid`,
      )
      .all(adwId);
  }

  async gates(adwId: string): Promise<GateResult[]> {
    const checks = await this.optionalColumn("gate_results", "checks_json");
    return this.db
      .query<GateResult, [string]>(
        `SELECT id, adw_id, phase_id, attempt, gate, passed, violations_json,
                ${checks}, created_at
           FROM gate_results WHERE adw_id = ? ORDER BY id`,
      )
      .all(adwId);
  }

  async sessionCount(): Promise<number> {
    const row = await this.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions")
      .get();
    return row?.n ?? 0;
  }

  /**
   * `spf estimate`'s one read: every session that ran EXACTLY `chainName`
   * (never a joined one — see below), each with its per-phase token totals,
   * most recent first. Also reports how many joined sessions (`adw_name`
   * like `"a + b"`, `core/tracer.ts:215`) named `chainName` as one of their
   * components — real history that cannot be attributed to this one chain
   * alone (both chains' phases share one continuing `seq`), so it is
   * counted for the "excluded" message rather than silently absent.
   *
   * Guarded by `hasColumn("sessions", "adw_name")` — a MIGRATED column
   * (`core/tracer.ts:109-116`) — rather than `optionalColumn`: this method
   * FILTERS on `adw_name`, and a `WHERE` clause naming a column an older db's
   * `sessions` table does not have is a SQLite error, not a no-match.
   * Short-circuiting to the empty shape here is what lets an old db read as
   * cold start (estimate's case 3) instead of crashing.
   *
   * No `LIMIT` at the SQL level: capping at 20 and collapsing fanout
   * siblings both depend on which of `success`-only vs any-status qualifies
   * first (`spf estimate`'s own sample-selection order), which is a decision
   * `estimate.ts` makes, not this method.
   */
  async chainPhaseHistory(chainName: string): Promise<{ sessions: ChainHistorySession[]; joinedExcluded: number }> {
    if (!(await this.hasColumn("sessions", "adw_name"))) return { sessions: [], joinedExcluded: 0 };

    const joinedRow = await this.db
      .query<{ n: number }, [string, string, string, string]>(
        `SELECT COUNT(*) AS n FROM sessions
          WHERE adw_name != ? AND (adw_name LIKE ? OR adw_name LIKE ? OR adw_name LIKE ?)`,
      )
      .get(chainName, `${chainName} + %`, `% + ${chainName}`, `% + ${chainName} + %`);

    const sessionRows = await this.db
      .query<{ adw_id: string; status: string | null; started_at: string | null; total_tokens: number | null; total_cost: number | null }, [string]>(
        `SELECT adw_id, status, started_at, total_tokens, total_cost
           FROM sessions WHERE adw_name = ? ORDER BY started_at DESC, rowid DESC`,
      )
      .all(chainName);

    if (sessionRows.length === 0) return { sessions: [], joinedExcluded: joinedRow?.n ?? 0 };

    const ids = sessionRows.map((r) => r.adw_id);
    const phaseRows = await this.chunked(ids, (chunk) => {
      const placeholders = chunk.map(() => "?").join(", ");
      return this.db
        .query<{ adw_id: string; name: string; seq: number; tokens: number | null }, string[]>(
          `SELECT p.adw_id, p.name, p.seq, e.tokens
             FROM phases p LEFT JOIN events e ON e.phase_id = p.phase_id AND e.type = 'agent_end'
            WHERE p.adw_id IN (${placeholders})
            ORDER BY p.seq ASC`,
        )
        .all(...chunk);
    });

    const phasesByAdw = new Map<string, { name: string; seq: number; tokens: number }[]>();
    for (const row of phaseRows) {
      const list = phasesByAdw.get(row.adw_id);
      const entry = { name: row.name, seq: row.seq, tokens: row.tokens ?? 0 };
      if (list) list.push(entry);
      else phasesByAdw.set(row.adw_id, [entry]);
    }

    const sessions: ChainHistorySession[] = sessionRows.map((row) => ({
      adw_id: row.adw_id,
      status: row.status ?? "fail",
      started_at: row.started_at,
      total_tokens: row.total_tokens ?? 0,
      total_cost: row.total_cost ?? 0,
      phases: phasesByAdw.get(row.adw_id) ?? [],
    }));

    return { sessions, joinedExcluded: joinedRow?.n ?? 0 };
  }
}

/** One EXACT-match session's history, as `chainPhaseHistory` returns it — `spf estimate`'s raw material. */
export interface ChainHistorySession {
  adw_id: string;
  status: string;
  started_at: string | null;
  total_tokens: number;
  total_cost: number;
  /** In `phases.seq` order; one entry per phase iteration (e.g. `fix_1`, `fix_2`), not yet loop-normalized. */
  phases: { name: string; seq: number; tokens: number }[];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
