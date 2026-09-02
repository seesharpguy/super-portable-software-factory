# Observability Reference

The event schema, the tables, and the polling contract — one data path,
always: **agents → sqlite → CLI / web UI.**

## Two stores, one truth

**Files are the raw record** (`envelope.json`, `agent_map.json`, Flue's own
`.spf/data/flue.db` conversation store); **the trace db is the queryable
mirror** the CLI and UI read. `tracer.ts` writes both. Losing the trace db
loses nothing that can't be rebuilt from files.

`observability.db` in `spf.config.yaml` names WHICH trace db backend and
where — a bare string (a local sqlite path, default `.spf/data/spf.db`,
inside the target repo, always gitignored), `{kind: sqlite, path?}` spelled
out the same way, or `{kind: d1, database_id, account_id_env?,
api_token_env?}` for a remote Cloudflare D1 database instead of a local
file. `core/trace_db.ts`'s `TraceDb` interface is the one seam both `Tracer`
(writes) and `SfDb` (reads) go through — `createTraceDb()` picks
`LocalTraceDb` or `D1TraceDb` from the resolved kind. See `config.md`'s
`observability.db` rows for the full field reference.

**The WAL live-read guarantee is LOCAL-ONLY.** The rest of this doc's "WAL
pragmas" section describes a guarantee specific to the local sqlite
backend — `spf ui` reading while a chain writes, through one shared file.
A D1-backed repo has no such file to share: `spf ui` and a running chain
each speak to D1 over independent HTTP calls, and D1's own consistency
model (sequential consistency, with a Sessions-API "bookmark" for
read-your-own-writes that this adapter does not use — see
`D1TraceDb`'s own doc comment in `core/trace_db.ts`) does not promise the
same instant. This is a deliberate, documented trade-off (SPF #66), not a
gap: no phase/gate/run OUTCOME depends on it — only how quickly `spf ui`
can catch up to a chain still writing.

## Event schema

`tracer.ts` emits these types, every one logged against its `adw_id` **and**
`phase_id`:

| Type | Emitted when |
|---|---|
| `phase_start` | a `run.phase(...)` block is entered |
| `agent_start` | an agent's Flue conversation is created or continued for `ph.call(...)` |
| `tool_call` | a tool call completes — **one event per real call**, named `bash: ls -la src`, payload `{tool, tool_call_id, args, result_snippet, ok, duration_ms}` |
| `handoff` | an envelope crosses from one agent to the next |
| `gate_pass` | a gate found no failed checks — payload carries `attempt`, `checks` (the evidence), and an empty `violations` |
| `gate_fail` | a gate found at least one failed check — payload carries `attempt`, `checks`, and `violations` |
| `log` | an explicit `ph.log(...)` from the chain script |
| `agent_end` | the agent's turn completes; envelope parsed or not — payload carries `cost`, `usage` (the per-component breakdown), `context_tokens`, `context_window` |
| `phase_end` | the block exits; carries the resolved status |
| `error` | a throw inside a phase block |

`parent_id` is reserved and structurally empty today — SPF's phases are flat
siblings, and nothing writes nesting into it. The UI reconstructs phase/
tool-call nesting from `phase_id` plus agent-call bracketing instead of
reading `parent_id`.

**Optional OTel export.** When `observability.otel.endpoint` is set in
`spf.config.yaml`, a lossy, allowlisted projection of phase/agent/tool spans
(status, model, token/cost counts, gate results — never prompts, envelopes,
tool arguments, or source code) is also pushed to an OTLP/HTTP collector,
fire-and-forget. SQLite remains the source of truth regardless; see
`config.md`'s `observability.otel.*` rows for the field reference.

**Spend is itemized per phase.** `agent_end.usage` carries tokens *and*
dollars for each component Flue reports (matching pi-ai's field names
one-for-one) — `input`, `output`, `cache_read`, `cache_write` — summed
across every send the phase made, so a phase that retried on a bad envelope
or a failed gate shows what all its attempts cost, not just the last one.

`reasoning_tokens` is the thinking share and is **inside** `output_tokens`,
not a fifth component. It bills at the output rate, so the panel nests it
under output rather than adding it. Runs predating the breakdown have no
`usage` key at all; the lump `cost` and the event's own `tokens` still
stand.

**Context is occupancy, not spend.** `events.tokens` and
`sessions.total_tokens` bill every turn, so they only grow. `context_tokens`
is how full the window actually was when the agent's last turn settled —
computed the same way as pi's own auto-compaction trigger: the last *valid*
turn's `usage.totalTokens`, falling back to `input + output + cacheRead +
cacheWrite`, skipping aborted/errored turns. `context_window` — the model's
ceiling — is backend-dependent: a Flue-backed agent always reports **0**
(Flue exposes no model-registry lookup the way pi's
`~/.pi/agent/models.json` did), while a `claude_code`-backed agent reports
a real ceiling straight from the CLI's own result message. Either way, `0`
means "unknown," not "no context used" — the lane draws no ceiling bar
rather than a wrong one.

**Gates record evidence, not just a verdict.** A gate returns one
`{item, ok, note}` check per thing it looked at; `violations` are derived
from the failed ones. Both land in `gate_results` (`checks_json` +
`violations_json`) and in the `gate_pass`/`gate_fail` payload.

**A `tool_call` is the one event that spans time**, so it fills both
`started_at` and `ended_at` on the row. Every other type is a point in
time. Lay tool calls out on a time axis from those columns, never by
parsing `payload_json`.

**Streaming is solved by construction.** `agent_flue.ts`'s `run()` forwards
Flue's `ConversationStreamChunk`s to the tracer as they arrive — never
batched at phase end. This is why the whole call chain from `agent_flue.run()`
up through `agents.execute`, `run.phase`, and every chain's `main()` is
`async`.

## Tables

No `REFERENCES` / foreign keys on `adw_id` or `phase_id` anywhere below — a
deliberate change for the D1 backend (SPF #66), not an oversight: Cloudflare
D1 enforces FKs unconditionally with no way to disable them, and a session's
very first write (e.g. its first `events` row) can otherwise land before its
own `sessions` row has committed, throwing `FOREIGN KEY constraint failed` on
a perfectly ordinary run. The relationships still hold logically (every
`adw_id` should resolve to a `sessions` row eventually) — they are just no
longer enforced by the schema on either backend, so local sqlite and D1
behave identically.

```sql
sessions (
  adw_id TEXT PRIMARY KEY, adw_name TEXT, request TEXT, status TEXT, engineer TEXT,
  started_at TEXT, ended_at TEXT, total_tokens INTEGER DEFAULT 0, total_cost REAL DEFAULT 0,
  archived INTEGER DEFAULT 0            -- review triage, set by the UI; never by a run
);
phases (
  phase_id TEXT PRIMARY KEY, adw_id TEXT, seq INTEGER,
  name TEXT, kind TEXT, owner TEXT, description TEXT,
  status TEXT DEFAULT 'fail',           -- success must be earned
  attempt INTEGER DEFAULT 0, retries INTEGER DEFAULT 0, error TEXT,
  started_at TEXT, ended_at TEXT
);
events (
  event_id TEXT PRIMARY KEY, adw_id TEXT, phase_id TEXT,
  parent_id TEXT, type TEXT, name TEXT, payload_json TEXT, tokens INTEGER,
  started_at TEXT, ended_at TEXT        -- ended_at set only on events that span time
);
envelopes (
  envelope_id TEXT PRIMARY KEY, adw_id TEXT, phase_id TEXT,
  agent TEXT, output_type TEXT, payload_json TEXT, valid INTEGER, attempt INTEGER, created_at TEXT
);
gate_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT, adw_id TEXT, phase_id TEXT,
  attempt INTEGER, gate TEXT, passed INTEGER,
  violations_json TEXT,                 -- derived: the failed checks, as "item: note"
  checks_json TEXT,                     -- [{item, ok, note}] — everything the gate looked at
  created_at TEXT
);
processes (                             -- adw_id -> pid, so a stuck run can be stopped
  id INTEGER PRIMARY KEY AUTOINCREMENT, adw_id TEXT,
  kind TEXT,                            -- 'adw' (the chain process) | 'agent' (a real child pid for claude_code; same as the chain's own pid for Flue, which is in-process)
  name TEXT, pid INTEGER,
  command TEXT,                         -- what the pid WAS; pids get recycled, verify before killing
  started_at TEXT, ended_at TEXT        -- ended_at NULL = believed alive
);
agent_sessions (                        -- the queryable mirror of agent_map.json
  adw_id TEXT, agent TEXT,
  coding_agent TEXT, model TEXT, color TEXT, session_id TEXT,
  context_tokens INTEGER,               -- window occupancy after the agent's last turn
  context_window INTEGER,               -- backend-dependent; 0 = unknown — see "Context is occupancy" above
  created_at TEXT, last_used_at TEXT,
  PRIMARY KEY (adw_id, agent)
);
```

`processes.kind = 'agent'` rows carry the actual `claude` subprocess pid for
a `claude_code`-backed agent — genuinely killable independently of the
chain that spawned it. For a Flue-backed agent (in-process, no child) the
same row carries the chain's own pid, since there's no separate process to
record. `spf abort <adw_id>` signals every live row it finds either way.

**Derived, never stored:** phase durations (`ended_at − started_at`),
session phase-progress (query `phases` by `adw_id`), lane layout (`kind` +
`owner`).

Phase status invariants: `queued` only for manifest-declared phases not yet
entered; `running` on enter; only a clean exit writes `success` — agent
phases additionally need the envelope validated and gates green; everything
else resolves to `fail`.

## WAL pragmas

Every connection — writer and reader — opens with:

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
```

WAL allows readers during writes. `src/core/sqlite.ts`'s `node:sqlite` shim
sets these explicitly and also disables `enableForeignKeyConstraints`
(`node:sqlite` defaults it **on**, unlike `bun:sqlite`/plain SQLite — left
on, a session's first `events` row inserting before its `sessions` row
commits throws). `spf ui` opens its connection with `{readOnly: true}` —
verified the shim translates that correctly; `readonly` (lowercase) is a
silent no-op in `node:sqlite` itself, which is exactly the footgun the shim
exists to close.

## Polling contract

**Nothing pushes.** No ingest endpoint, no WebSocket. Live view polls a
rowid cursor:

```sql
SELECT ... FROM events WHERE adw_id = ? AND rowid > ? ORDER BY rowid LIMIT 500;
```

`spf events <adw_id> --follow` and `spf ui` both do this at
`observability.poll_ms` (default 500). History is the same queries with
filters, lazy-paged — one mechanism serves both live and past runs.

## Finding and stopping a stuck run

```bash
spf phases <adw_id>     # which phase is still "running"
spf abort <adw_id>      # SIGTERM the chain's process
```

A hung agent produces no events at all — the trace goes quiet rather than
red, which is exactly when `processes` (not `events`) is the table that
answers "is this run doing anything." A killed run finalizes its own trace:
SIGTERM/SIGINT are handled to close out the session as `fail` with its
process rows closed, rather than leaving it reading `running` forever.
