/**
 * Tracer: every event lands in JSONL and SQLite AS IT HAPPENS.
 *
 * Files are the raw record; spf.db is the queryable mirror the UI polls.
 * WAL mode so the UI can read while ADW processes write.
 *
 * No push transport in the CONTROL flow — that is always, still, and only:
 * agents -> sqlite -> web ui. SQLite is the source of truth; nothing
 * downstream of it can affect a phase, a gate, or a run outcome.
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

import { Database } from "./sqlite.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AgentConfig, EventRecord, GateReport, Phase } from "./data_types.ts";
import type { OtelExporter } from "./otel.ts";
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
  adw_id        TEXT REFERENCES sessions,
  seq           INTEGER,
  name TEXT, kind TEXT, owner TEXT, description TEXT,
  status        TEXT DEFAULT 'fail',
  attempt       INTEGER DEFAULT 0, retries INTEGER DEFAULT 0,
  error         TEXT,
  started_at    TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  event_id      TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  parent_id     TEXT,
  type          TEXT,
  name          TEXT,
  payload_json  TEXT,
  tokens        INTEGER,
  started_at    TEXT, ended_at TEXT
);
CREATE TABLE IF NOT EXISTS envelopes (
  envelope_id   TEXT PRIMARY KEY,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  agent         TEXT,
  output_type   TEXT,
  payload_json  TEXT,
  valid         INTEGER,
  attempt       INTEGER,
  created_at    TEXT
);
CREATE TABLE IF NOT EXISTS gate_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT REFERENCES sessions,
  phase_id      TEXT REFERENCES phases,
  attempt       INTEGER,
  gate          TEXT,
  passed        INTEGER,
  violations_json TEXT,
  checks_json   TEXT,               -- [{item, ok, note}] — WHAT the gate verified
  created_at    TEXT
);
CREATE TABLE IF NOT EXISTS processes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  adw_id        TEXT REFERENCES sessions,
  kind          TEXT,                -- 'adw' (the workflow process) | 'agent' (a coding-agent child)
  name          TEXT,                -- '' for the adw, the agent name for a child
  pid           INTEGER,
  command       TEXT,                -- what the pid was, so a recycled pid is not killed by mistake
  started_at    TEXT, ended_at TEXT  -- ended_at NULL = believed alive
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  adw_id        TEXT REFERENCES sessions,
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
  db: Database;
  dbPath: string;
  eventsJsonl: string;
  /** `null` unless `observability.otel` is configured — see the header. */
  otel: OtelExporter | null;

  constructor(dbPath: string, eventsJsonl: string, otel?: OtelExporter | null) {
    this.otel = otel ?? null;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.eventsJsonl = eventsJsonl;
    mkdirSync(path.dirname(eventsJsonl), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive column migrations, so a db from an older SPF still opens. */
  private migrate(): void {
    for (const [table, column, decl] of MIGRATIONS) {
      const columns = new Set(
        (this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
      );
      if (!columns.has(column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    }
  }

  /**
   * The ONE door to the optional otel projection, and the only reason a fan-out
   * line is safe to put at the end of a synchronous write method: it is a
   * no-op when unconfigured, and it swallows everything. An exporter bug, a
   * malformed span, an exhausted queue — none of it may ever surface as a
   * failed phase, because export is not allowed to dispose of anything. The
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
  event(record: EventRecord): string {
    const eventId = `evt_${newId(12)}`;
    const ts = nowIso();
    const line = { event_id: eventId, ts, ...record };
    appendFileSync(this.eventsJsonl, JSON.stringify(line) + "\n");
    this.db
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
  sessionStart(adwId: string, engineer: string, adwName?: string | null): void {
    const startedAt = nowIso();
    this.db
      .query(
        `INSERT INTO sessions (adw_id, status, engineer, started_at) VALUES (?,?,?,?)
         ON CONFLICT(adw_id) DO UPDATE SET status='running'`,
      )
      .run(adwId, "running", engineer, startedAt);
    if (adwName) {
      // A joined session chains ADWs — record each distinct one, in run order.
      const row = this.db.query("SELECT adw_name FROM sessions WHERE adw_id=?").get(adwId) as
        | { adw_name: string | null }
        | undefined;
      const names = row?.adw_name ? row.adw_name.split(" + ") : [];
      if (!names.includes(adwName)) {
        names.push(adwName);
        this.db.query("UPDATE sessions SET adw_name=? WHERE adw_id=?").run(names.join(" + "), adwId);
      }
    }
    // otel projection: the run's clock only. `engineer` is a person's name —
    // outside the allowlist, and not a measure of anything.
    this.fanOut((otel) => otel.recordSessionStart(startedAt));
  }

  sessionRequest(adwId: string, request: string): void {
    this.db.query("UPDATE sessions SET request=? WHERE adw_id=?").run(request.slice(0, 500), adwId);
  }

  sessionFinish(adwId: string, ok: boolean): void {
    this.db
      .query("UPDATE sessions SET status=?, ended_at=? WHERE adw_id=?")
      .run(ok ? "success" : "fail", nowIso(), adwId);
    this.processesEndAll(adwId); // nothing of this run is alive any more
    this.fanOut((otel) => otel.recordSessionFinish(ok)); // otel projection: emits the root run span, once
  }

  sessionAddUsage(adwId: string, tokens: number, cost: number): void {
    this.db
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
  processStart(adwId: string, kind: string, name: string, pid: number, command: string): void {
    this.db
      .query(
        `INSERT INTO processes (adw_id, kind, name, pid, command, started_at) VALUES (?,?,?,?,?,?)`,
      )
      .run(adwId, kind, name, pid, command.slice(0, 500), nowIso());
  }

  /** Mark the newest live row for this pid as finished. */
  processEnd(adwId: string, pid: number): void {
    this.db
      .query(
        `UPDATE processes SET ended_at=? WHERE id = (
           SELECT id FROM processes WHERE adw_id=? AND pid=? AND ended_at IS NULL
           ORDER BY id DESC LIMIT 1)`,
      )
      .run(nowIso(), adwId, pid);
  }

  /** Close out every live row for a run — called when the session ends. */
  processesEndAll(adwId: string): void {
    this.db.query("UPDATE processes SET ended_at=? WHERE adw_id=? AND ended_at IS NULL").run(nowIso(), adwId);
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
  maxPhaseSeq(adwId: string): number {
    const row = this.db.query("SELECT MAX(seq) as m FROM phases WHERE adw_id = ?").get(adwId) as
      | { m: number | null }
      | undefined;
    return row?.m ?? 0;
  }

  phaseUpsert(phase: Phase): void {
    const p = phase.params;
    this.db
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
  envelopeRow(phase: Phase, agent: string, outputType: string, payloadJson: string, valid: boolean, attempt: number): void {
    this.db
      .query(
        `INSERT INTO envelopes (envelope_id, adw_id, phase_id, agent, output_type,
         payload_json, valid, attempt, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(`env_${newId(12)}`, phase.adw_id, phase.phase_id, agent, outputType, payloadJson, valid ? 1 : 0, attempt, nowIso());
  }

  /** The report carries both the verdict and the evidence behind it. */
  gateRow(phase: Phase, gate: string, report: GateReport, attempt: number): void {
    this.db
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
  agentSessionRow(
    adwId: string,
    agent: AgentConfig,
    sessionId: string,
    contextTokens: number = 0,
    contextWindow: number = 0,
  ): void {
    const ts = nowIso();
    this.db
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
