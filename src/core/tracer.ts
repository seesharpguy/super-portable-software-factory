/**
 * Tracer: every event lands in JSONL and the trace db AS IT HAPPENS.
 *
 * Files are the raw record; the trace db (local sqlite, or remote D1 — see
 * `core/trace_db.ts`) is the queryable mirror the UI polls. For the LOCAL
 * backend, WAL mode lets the UI read while ADW processes write, in the same
 * instant, because both sides share one file on one filesystem.
 *
 * THE D1 BACKEND DOES NOT MAKE THAT SAME PROMISE — see `core/trace_db.ts`'s
 * `D1TraceDb` doc comment for the consistency model it actually has and why
 * this is a deliberate, documented trade-off (SPF #66) rather than a gap to
 * close here.
 *
 * No push transport in the CONTROL flow — that is always, still, and only:
 * agents -> trace db -> web ui. The trace db is the source of truth; nothing
 * downstream of it can affect a phase, a gate, or a run outcome.
 *
 * WHY EVERY WRITE METHOD BELOW IS ASYNC: the D1 backend's only way to reach
 * a database from this plain Node CLI is its HTTP REST API — a network call.
 * `core/trace_db.ts`'s `TraceDb` interface is async for that reason, and
 * every write method here is a thin `await this.db...` over it — see that
 * module's header. For the LOCAL backend this costs nothing but the syntax:
 * `LocalTraceDb` wraps the exact same synchronous `Database` calls this file
 * always made, immediately resolved.
 *
 * The one amendment: when (and only when) `observability.otel` is configured,
 * each write method below ends with a single fan-out line to an optional
 * OtelExporter — a lossy, allowlisted PROJECTION of what was just written,
 * pushed to an OTLP endpoint fire-and-forget. It is deliberately NOT a second
 * record: it never blocks, never throws into a caller (see `fanOut`), drops
 * spans under backpressure, and carries only the allowlisted subset of fields
 * (never `EventRecord.payload`, never the request text, never envelope
 * contents — `core/otel.ts`'s header has the full list and the reasons).
 * Methods whose data is entirely outside that allowlist —
 * `sessionRequest` (the operator's prompt), `envelopeRow` (agent output),
 * `processStart`/`processEnd` (pids) — have NO fan-out line on purpose. Do not
 * add one.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AgentConfig, EventRecord, GateReport, NormalizedObservabilityDb, Phase } from "./data_types.ts";
import type { OtelExporter } from "./otel.ts";
import { createTraceDb, type TraceDb } from "./trace_db.ts";
import { newId, nowIso } from "./utils.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  adw_id        TEXT PRIMARY KEY,
  adw_name      TEXT,                -- chain(s) run, e.g. "plan + build-test"
  request       TEXT,
  status        TEXT,
  engineer      TEXT,
  started_at    TEXT, ended_at TEXT,
  total_tokens  INTEGER DEFAULT 0, total_cost REAL DEFAULT 0,
  archived      INTEGER DEFAULT 0   -- review triage, set by the UI; never by a run
);
CREATE TABLE IF NOT EXISTS phases (
  phase_id      TEXT PRIMARY KEY,
  adw_id        TEXT,
  seq           INTEGER,
  name TEXT, kind TEXT, owner TEXT, description TEXT,
  status        TEXT DEFAULT 'fail',
  attempt       INTEGER DEFAULT 0, retries INTEGER DEFAULT 0,
  error         TEXT,
  started_at    TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id      TEXT PRIMARY KEY,
  adw_id        TEXT,
  phase_id      TEXT,
  parent_id     TEXT,
  type          TEXT,
  name          TEXT,
  payload_json  TEXT,
  tokens        INTEGER,
  started_at    TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS envelopes (
  envelope_id   TEXT PRIMARY KEY,
  adw_id        TEXT,
  phase_id      TEXT,
  agent         TEXT,
  output_type   TEXT,
  payload_json  TEXT,
  valid         INTEGER,
  attempt       INTEGER,
  created_at    TEXT
);
CREATE TABLE IF NOT EXISTS gate_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT,
  phase_id      TEXT,
  attempt       INTEGER,
  gate          TEXT,
  passed        INTEGER,
  violations_json TEXT,
  checks_json   TEXT,               -- [{item, ok, note}] — WHAT the gate verified
  created_at    TEXT
);
CREATE TABLE IF NOT EXISTS processes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT,
  kind          TEXT,                -- 'adw' (the workflow process) | 'agent' (a coding-agent child)
  name          TEXT,                -- '' for the adw, the agent name for a child
  pid           INTEGER,
  command       TEXT,                -- what the pid was, so a recycled pid is not killed by mistake
  started_at    TEXT, ended_at TEXT  -- ended_at NULL = believed alive
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  adw_id        TEXT,
  agent         TEXT,
  coding_agent  TEXT, model TEXT, color TEXT,
  session_id    TEXT,
  context_tokens INTEGER,           -- window occupancy after the agent's last turn
  context_window INTEGER,           -- the model's ceiling; 0/NULL = unknown
  created_at    TEXT, last_used_at TEXT,
  PRIMARY KEY (adw_id, agent)
);
`;

// Columns added after a schema shipped. CREATE TABLE IF NOT EXISTS never
// revisits an existing table, so additive changes need an explicit ALTER.
const MIGRATIONS: Array<[string, string, string]> = [
  ["agent_sessions", "color", "TEXT"],
  ["gate_results", "checks_json", "TEXT"],
  ["sessions", "adw_name", "TEXT"],
  ["agent_sessions", "context_tokens", "INTEGER"],
  ["agent_sessions", "context_window", "INTEGER"],
  ["sessions", "archived", "INTEGER DEFAULT 0"],
];

export class Tracer {
  db: TraceDb;
  /** Absolute local sqlite path — `null` for a `kind:"d1"` config (`Console.sessionFinished`'s "db" line falls back to `runner.ts`'s `describeObservabilityDb` for a human label in that case). */
  dbPath: string | null;
  eventsJsonl: string;
  /** `null` unless `observability.otel` is configured — see the header. */
  otel: OtelExporter | null;

  private constructor(db: TraceDb, dbPath: string | null, eventsJsonl: string, otel: OtelExporter | null) {
    this.db = db;
    this.dbPath = dbPath;
    this.eventsJsonl = eventsJsonl;
    this.otel = otel;
    mkdirSync(path.dirname(eventsJsonl), { recursive: true });
  }

  /**
   * Open (or create) the trace db, run schema + migrations, and return a
   * ready-to-use Tracer. The one constructor path — a plain `new Tracer(...)`
   * cannot do this work itself because opening a D1-backed db means awaited
   * HTTP calls before the schema exists, and a constructor cannot be async.
   *
   * `dbConfig` accepts either a bare local sqlite path (sugar for
   * `{kind:"sqlite",path}` — every test's shorthand, and what every caller
   * before SPF #66 passed) or a normalized `observability.db` descriptor
   * (`paths.resolveDataPaths(...).db` — sqlite or d1).
   */
  static async open(
    dbConfig: NormalizedObservabilityDb | string,
    eventsJsonl: string,
    otel?: OtelExporter | null,
    traceDbOptions?: { fetchImpl?: typeof fetch },
  ): Promise<Tracer> {
    const normalized: NormalizedObservabilityDb = typeof dbConfig === "string" ? { kind: "sqlite", path: dbConfig } : dbConfig;
    const db = createTraceDb(normalized, { fetchImpl: traceDbOptions?.fetchImpl });
    if (normalized.kind === "sqlite") {
      // WAL + the busy/synchronous pragmas below are meaningless over D1's
      // HTTP API (there is no local journal file to configure), so this
      // block only ever runs for the local backend.
      await db.exec("PRAGMA journal_mode=WAL;");
      await db.exec("PRAGMA synchronous=NORMAL;");
      await db.exec("PRAGMA busy_timeout=5000;");
    }
    await db.exec(SCHEMA);
    const tracer = new Tracer(db, normalized.kind === "sqlite" ? normalized.path : null, eventsJsonl, otel ?? null);
    await tracer.migrate();
    return tracer;
  }

  /**
   * Close the trace db handle. A one-shot CLI process never needs this — it
   * exits right after its one Tracer anyway — but `spf watch`'s daemon loop
   * builds a fresh Tracer (and a fresh local db connection, or a fresh
   * stateless D1 client) per claimed issue, in-process, for the life of the
   * daemon; without this, every issue's local handle stayed open forever.
   * Called from `session.ts`'s `finalize()`, once a run's own dispatch has
   * fully settled — see its comment for why that timing is safe. A no-op for
   * `D1TraceDb` (stateless HTTP — nothing to release).
   */
  async close(): Promise<void> {
    await this.db.close();
  }

  /** Additive column migrations, so a db from an older SPF still opens. */
  private async migrate(): Promise<void> {
    for (const [table, column, decl] of MIGRATIONS) {
      const columns = new Set(
        (await this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
      );
      if (!columns.has(column)) {
        await this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    }
  }

  /**
   * The ONE door to the optional otel projection. It is a no-op when
   * unconfigured, and it swallows everything: an exporter bug, a malformed
   * span, an exhausted queue — none of it may ever surface as a failed
   * phase, because export is not allowed to dispose of anything. The
   * exporter's own methods are synchronous enqueues; the network happens later,
   * on an unref'd timer.
   */
  private fanOut(action: (otel: OtelExporter) => void): void {
    if (!this.otel) return;
    try {
      action(this.otel);
    } catch {
      // Deliberately silent: a logged line per event on a hot path would be
      // its own failure mode, and otel.ts already logs its own send failures
      // exactly once.
    }
  }

  // ── events ──────────────────────────────────────────────────────────────
  async event(record: EventRecord): Promise<string> {
    const eventId = `evt_${newId(12)}`;
    const ts = nowIso();
    const line = { event_id: eventId, ts, ...record };
    appendFileSync(this.eventsJsonl, JSON.stringify(line) + "\n");
    await this.db
      .query(
        `INSERT INTO events (event_id, adw_id, phase_id, parent_id, type, name,
         payload_json, tokens, started_at, ended_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        eventId,
        record.adw_id,
        record.phase_id,
        record.parent_id,
        record.type,
        record.name,
        JSON.stringify(record.payload),
        record.tokens ?? null,
        record.started_at || ts,
        record.ended_at ?? null,
      );
    this.fanOut((otel) => otel.recordEvent(record, eventId, ts)); // otel projection — see fanOut
    return eventId;
  }

  // ── sessions ────────────────────────────────────────────────────────────
  async sessionStart(adwId: string, engineer: string, adwName?: string | null): Promise<void> {
    const startedAt = nowIso();
    await this.db
      .query(
        `INSERT INTO sessions (adw_id, status, engineer, started_at) VALUES (?,?,?,?)
         ON CONFLICT(adw_id) DO UPDATE SET status='running'`,
      )
      .run(adwId, "running", engineer, startedAt);
    if (adwName) {
      // A joined session chains ADWs — record each distinct one, in run order.
      const row = (await this.db.query("SELECT adw_name FROM sessions WHERE adw_id=?").get(adwId)) as
        | { adw_name: string | null }
        | undefined;
      const names = row?.adw_name ? row.adw_name.split(" + ") : [];
      if (!names.includes(adwName)) {
        names.push(adwName);
        await this.db.query("UPDATE sessions SET adw_name=? WHERE adw_id=?").run(names.join(" + "), adwId);
      }
    }
    // otel projection: the run's clock only. `engineer` is a person's name —
    // outside the allowlist, and not a measure of anything.
    this.fanOut((otel) => otel.recordSessionStart(startedAt));
  }

  async sessionRequest(adwId: string, request: string): Promise<void> {
    await this.db.query("UPDATE sessions SET request=? WHERE adw_id=?").run(request.slice(0, 500), adwId);
  }

  async sessionFinish(adwId: string, ok: boolean): Promise<void> {
    // otel projection FIRST — synchronously, before ANY `await` in this
    // method, including the ones below. `session.ts`'s `handleSignal` fires
    // this method un-awaited and then calls `otel.flushAll()` -> `drain()`
    // in that SAME synchronous turn (no microtask has run yet). `drain()`
    // emits a placeholder "incomplete" root span the instant `rootEmitted`
    // is still false, and `OtelExporter.emitRootSpan` latches on that flag —
    // so once the placeholder fires, the real verdict below is silently
    // dropped forever. `recordSessionFinish` -> `emitRootSpan` is a pure,
    // synchronous, in-memory queue push (see otel.ts): safe to fire before
    // either write below has actually landed, and it must fire here, not
    // after them, to win that race unconditionally on both backends.
    this.fanOut((otel) => otel.recordSessionFinish(ok)); // otel projection — see fanOut

    // `processesEndAll` is CALLED (not awaited) before the sessions-row
    // update below, on purpose: `session.ts`'s SIGINT/SIGTERM handler fires
    // this method un-awaited and, on the local backend with no otel/notify
    // configured, calls `process.exit()` in the very same synchronous turn —
    // which never drains the microtask queue. `LocalTraceDb`'s writes happen
    // synchronously the moment `.run(...)` is CALLED (only the `await` after
    // it is deferred), so calling this first guarantees its write has
    // already landed by the time this function reaches its own first
    // `await`, exactly like the sessions-row write below. Awaiting it only
    // after starting the sessions-row update would put it entirely after
    // that update's `await`, i.e. in a microtask `process.exit()` never
    // reaches — see session.ts's `handleSignal` for the full trace of why.
    const processesDone = this.processesEndAll(adwId); // nothing of this run is alive any more
    // Attach a handler to `processesDone` IMMEDIATELY — not after the
    // sessions-row write below — so it can never become an unhandled
    // rejection (fatal on Node 22). If the sessions-row write throws first,
    // execution never reaches the `await processesDone` further down; without
    // this line, `processesDone`'s own eventual rejection would then have no
    // attached handler at all. `processesResult` resolves to the error
    // (never rethrows here) so both writes stay independently handled; it is
    // re-thrown below only once the sessions-row write has itself succeeded.
    const processesResult = processesDone.then(
      () => null,
      (err: unknown) => err,
    );
    await this.db
      .query("UPDATE sessions SET status=?, ended_at=? WHERE adw_id=?")
      .run(ok ? "success" : "fail", nowIso(), adwId);
    const processesError = await processesResult;
    if (processesError) throw processesError;
  }

  async sessionAddUsage(adwId: string, tokens: number, cost: number): Promise<void> {
    await this.db
      .query("UPDATE sessions SET total_tokens=total_tokens+?, total_cost=total_cost+? WHERE adw_id=?")
      .run(tokens, cost, adwId);
  }

  // ── processes (adw_id → pid, so a hung run can be found and killed) ─────
  /**
   * Record a live process for this run.
   *
   * A coding agent that hangs produces no events at all, which is exactly
   * when you need its pid — and `ps` cannot tell you which adw_id it
   * belongs to. Writing it here makes the trace the answer to "what is this
   * run running, and how do I stop it".
   */
  async processStart(adwId: string, kind: string, name: string, pid: number, command: string): Promise<void> {
    await this.db
      .query(
        `INSERT INTO processes (adw_id, kind, name, pid, command, started_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(adwId, kind, name, pid, command.slice(0, 500), nowIso());
  }

  /** Mark the newest live row for this pid as finished. */
  async processEnd(adwId: string, pid: number): Promise<void> {
    await this.db
      .query(
        `UPDATE processes SET ended_at=? WHERE id = (
           SELECT id FROM processes WHERE adw_id=? AND pid=? AND ended_at IS NULL
           ORDER BY id DESC LIMIT 1)`,
      )
      .run(nowIso(), adwId, pid);
  }

  /** Close out every live row for a run — called when the session ends. */
  async processesEndAll(adwId: string): Promise<void> {
    await this.db.query("UPDATE processes SET ended_at=? WHERE adw_id=? AND ended_at IS NULL").run(nowIso(), adwId);
  }

  // ── phases ──────────────────────────────────────────────────────────────
  /**
   * Highest seq already recorded for this session; 0 when it is new.
   *
   * A joined run continues the sequence instead of restarting at 1 — which
   * would collide with the first run's phases on both `seq` (breaking
   * ordering) and `phase_id` (silently overwriting a row through the
   * phase_upsert conflict clause).
   */
  async maxPhaseSeq(adwId: string): Promise<number> {
    const row = (await this.db.query("SELECT MAX(seq) as m FROM phases WHERE adw_id = ?").get(adwId)) as
      | { m: number | null }
      | undefined;
    return row?.m ?? 0;
  }

  async phaseUpsert(phase: Phase): Promise<void> {
    const p = phase.params;
    await this.db
      .query(
        `INSERT INTO phases (phase_id, adw_id, seq, name, kind, owner, description,
         status, attempt, retries, error, started_at, ended_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(phase_id) DO UPDATE SET status=excluded.status,
         attempt=excluded.attempt, error=excluded.error, ended_at=excluded.ended_at`,
      )
      .run(
        phase.phase_id,
        phase.adw_id,
        phase.seq,
        p.name,
        p.kind,
        p.owner,
        p.description,
        phase.status,
        phase.attempt,
        p.retries,
        phase.error ?? null,
        phase.started_at ?? null,
        phase.ended_at ?? null,
      );
    // otel projection: a no-op on the start-of-phase upsert (no ended_at yet) —
    // phase spans are emitted at phase END only. `phase.error` never crosses.
    this.fanOut((otel) => otel.recordPhase(phase));
  }

  // ── envelopes / gates / agent sessions ──────────────────────────────────
  async envelopeRow(phase: Phase, agent: string, outputType: string, payloadJson: string, valid: boolean, attempt: number): Promise<void> {
    await this.db
      .query(
        `INSERT INTO envelopes (envelope_id, adw_id, phase_id, agent, output_type,
         payload_json, valid, attempt, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(`env_${newId(12)}`, phase.adw_id, phase.phase_id, agent, outputType, payloadJson, valid ? 1 : 0, attempt, nowIso());
  }

  /** The report carries both the verdict and the evidence behind it. */
  async gateRow(phase: Phase, gate: string, report: GateReport, attempt: number): Promise<void> {
    await this.db
      .query(
        `INSERT INTO gate_results (adw_id, phase_id, attempt, gate, passed,
         violations_json, checks_json, created_at) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        phase.adw_id,
        phase.phase_id,
        attempt,
        gate,
        report.passed ? 1 : 0,
        JSON.stringify(report.violations),
        JSON.stringify(report.checks),
        nowIso(),
      );
    // otel projection: gate name + verdict + violation COUNT as a span event on
    // the phase span. The violation and check TEXT stays here in SQLite — it
    // quotes the agent's claim and the repo's files.
    this.fanOut((otel) => otel.recordGate(phase, gate, report, attempt));
  }

  /**
   * The agent's config row is the source of truth for its label and color.
   *
   * Context is carried here rather than derived from events because the lane
   * wants one number per agent — the latest — and a session that runs the
   * same agent twice overwrites it, exactly like model and session_id.
   */
  async agentSessionRow(
    adwId: string,
    agent: AgentConfig,
    sessionId: string,
    contextTokens: number = 0,
    contextWindow: number = 0,
  ): Promise<void> {
    const ts = nowIso();
    await this.db
      .query(
        `INSERT INTO agent_sessions (adw_id, agent, coding_agent, model, color,
         session_id, context_tokens, context_window, created_at, last_used_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(adw_id, agent) DO UPDATE SET model=excluded.model,
         color=excluded.color, session_id=excluded.session_id,
         context_tokens=excluded.context_tokens,
         context_window=excluded.context_window,
         last_used_at=excluded.last_used_at`,
      )
      .run(adwId, agent.name, agent.coding_agent, agent.model, agent.color, sessionId, contextTokens, contextWindow, ts, ts);
    // otel projection: the TYPED source of an agent's model + backend for its
    // span (agents.ts writes this row before the agent_end event, which is what
    // lets otel.ts avoid reading the agent_start payload at all). `sessionId`
    // is not exported — it is a coding-agent handle, not a measure.
    this.fanOut((otel) => otel.recordAgentSession(agent));
  }
}
