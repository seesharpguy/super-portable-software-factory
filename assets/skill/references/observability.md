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

**D1 ships the complete trace off-box.** The "Two stores, one truth"
guarantee above ("local sqlite, always gitignored") is specific to
`kind: sqlite`. Point `observability.db` at `kind: d1` and every write
`tracer.ts` makes — `sessions.request` (the operator's raw request text),
`events.payload_json` (including each `tool_call` event's `args` and
`result_snippet`), `envelopes.payload_json`, and
`gate_results.violations_json` — is POSTed over HTTPS to
`https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query`
(`trace_db.ts`'s `D1TraceDb`). This is the full trace, not the OTEL
spans-only attribute allowlist described elsewhere in this doc: prompts,
tool arguments, and tool results leave the machine on every run once
`kind: d1` is configured. There is no partial mode — a repo is either
fully local (`kind: sqlite`, the default) or fully remote for trace data
(`kind: d1`). Choose D1 only when shipping that data to Cloudflare is
acceptable for the repo in question.

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
fire-and-forget, via the real `@opentelemetry/sdk-trace-base` +
`exporter-trace-otlp-http` packages (SPF's own bespoke sha256 trace/span-id
scheme and attribute allowlist ride on top of the real SDK's encoder, not a
hand-rolled one — see `core/otel.ts`'s header for exactly what that means for
the wire bytes). SQLite remains the source of truth regardless; see
`config.md`'s `observability.otel.*` rows for the field reference.

**Optional OTel metrics.** The same `observability.otel.endpoint` also gates
a second, PROCESS-scoped pipeline (`core/otel_metrics.ts`, built on
`@opentelemetry/sdk-metrics` + `exporter-metrics-otlp-http`) — set
`observability.otel.metrics: false` to keep trace export on while opting out
of metrics specifically. Five instruments: `spf.tokens` (counter; attrs
`kind` — input/output/cache_read/cache_write — `agent`, `model`),
`spf.cost_usd` (counter; `agent`, `model`), `spf.phase.duration` (histogram,
seconds; `kind`, `owner`, `status`), `spf.gate.result` (counter; `gate`,
`result` — pass/fail), and `spf.agent.calls` (counter; `agent`, `model`,
`coding_agent`). Unlike the span exporter (one per run), there is exactly
one `MeterProvider` for the life of the `spf` process — see `otel_metrics.
ts`'s own header for why that matters under `spf watch`'s daemon loop.

**Outbound trace-context propagation.** When otel is configured, SPF also
tries to carry `traceparent` onto the OUTBOUND model calls each agent makes,
so this run's spans join whatever trace the model-serving stack itself
produces (see "Tracing across the inference stack" below). The three coding
agent backends get different-confidence treatment:
  - `coding_agent: claude_code` — a real, verified guarantee.
    `agent_cc.ts`'s single `spawn()` choke point sets `TRACEPARENT` and
    `ANTHROPIC_CUSTOM_HEADERS` (`traceparent`/`x-request-id`, newline-
    separated `Name: Value` pairs — the CLI's own documented format,
    requires `claude` CLI >= 2.1.227) on the `claude` subprocess's
    environment for every call.
  - `coding_agent: opencode` — config-verified, behavior best-effort.
    `agent_opencode.ts` injects `TRACEPARENT` onto the subprocess env
    (parity with `claude_code`; unverified whether the opencode CLI itself
    reads it) AND writes `traceparent`/`x-request-id` as static
    `provider.<id>.options.headers` into the temp `opencode.json` —
    opencode's documented per-provider options surface, honored by the AI
    SDK on that provider's requests. Static is correct because one
    `opencode run` subprocess is exactly one agent call. Two caveats,
    documented in the module's own doc comment: a bare model id with no
    `provider/` prefix skips the headers (SPF never guesses a provider id),
    and a target repo's own `opencode.json` merges at higher precedence and
    can override them.
  - `coding_agent: flue` — best-effort. `@flue/opentelemetry`'s own docs say
    plainly that `dispatch()` "does not propagate trace context" on its own,
    so SPF additionally registers `@opentelemetry/instrumentation-http` +
    `-undici` globally, with a propagator that carries both the standard W3C
    `traceparent` and a custom `x-request-id`. This reaches any provider
    whose Node SDK issues requests through `http`/`https`/`undici` (verified)
    — it does NOT reach a provider transport that bypasses both (unverified
    for the Anthropic/Google/Mistral SDKs' internal transports specifically;
    flagged, not assumed). See `core/otel_propagation.ts`'s header for the
    full mechanism. Since #80, flue's spans additionally JOIN SPF's
    deterministic trace: `agent_flue.ts` registers each run's session id
    (== flue's instance id) against that call's traceparent, and the
    installed instrumentation's `resolveRootContext` option — consulted per
    root span, keyed on the event context's instance id — roots each
    session's spans under the right agent-call span. This is done per-span
    rather than by wrapping `dispatch()` in a context because flue's node
    runtime executes all submissions in one process-lifetime claim loop
    whose async context is captured once — a dispatch-time wrap would
    mis-attribute every agent after the first into the first agent's trace
    (verified against `@flue/runtime`'s dist; see `core/otel_propagation
    .ts`'s header). Unmapped sessions (backlog restarts, post-settlement
    stragglers) degrade to the old separate-trace behavior — never
    mis-attributed, never an error; correlate those by `x-request-id`/
    `spf.adw_id`/time window.

## Tracing across the inference stack

A run's SPF spans are not the only spans in play once a `claude_code` agent
is pointed at a self-hosted model through Switchyard/vLLM (this repo's own
inference-platform-aws stack): the `claude` CLI's own request, Switchyard's
routing hop, and vLLM's own serving span can ALL be emitted to the same Tempo
(or any OTLP-compatible) backend. What joins them:

  - **The `traceparent` SPF injects** (see above) is a real W3C header on the
    actual HTTP request `claude` makes to `ANTHROPIC_BASE_URL` — whatever
    receives that request (Switchyard, vLLM directly, an Envoy AI Gateway
    hop) that is ALSO instrumented with OTel and honors an inbound
    `traceparent` will parent its own span under SPF's agent-call span,
    landing in the SAME trace.
  - **SPF's OWN span export is a separate, deterministic trace** — one
    `adw_id` = one trace id (`sha256(adw_id)`), independent of whatever trace
    id the model-serving hop's own OTel SDK would otherwise mint. Since SPF
    controls the OUTBOUND `traceparent` it sends (not merely observes one),
    a `claude_code` call's downstream spans (Switchyard, vLLM) land as
    CHILDREN of SPF's own deterministic trace id, not the other way around —
    a Tempo query for `sha256(adw_id)` finds the whole cross-service picture
    for that run, agent call down through the model server.
  - **The `flue` backend joins the same trace** (since #80): Flue's own
    spans (`flue.coordinator`, `invoke_agent`, `chat <model>`,
    `execute_tool`) inherit SPF's deterministic trace id (SDK-random span
    ids underneath) via the instrumentation's per-span `resolveRootContext`
    rooted on the run's registered session-id -> traceparent map, and the
    `traceparent` the http/undici instrumentations inject onto Flue's
    provider requests carries it too — downstream Switchyard/vLLM spans
    land in the same trace, exactly as the `claude_code` path described
    above. Unmapped submissions (a restarted process draining a durable
    backlog, post-settlement bookkeeping) fall back to a separate trace —
    never MIS-attributed into another agent's trace — correlatable by
    `x-request-id`/`spf.adw_id`/time window; see the "Outbound
    trace-context propagation" section above.
  - **`x-request-id`** rides alongside `traceparent` specifically so a
    collector/log pipeline that correlates by individual REQUEST (rather
    than by trace) has a stable id to key on — it is this call's own
    (SPF-side) span id for `claude_code`, and the currently-active span's id
    for `flue`.
  - **vLLM's own cache-read pass-through**
    (`usage.prompt_tokens_details.cached_tokens`, surfaced here as both
    `spf.tokens.cache_read` and `gen_ai.usage.cache_read.input_tokens`)
    requires the upstream vLLM server to be started with
    `--enable-prompt-tokens-details` (off by default). SPF #82 added a
    one-shot capability probe per base URL (`src/core/cache_details_probe.ts`)
    — fired from `otel.ts`'s `recordAgentSession` (only reachable once
    `observability.otel` is configured, which is that class's own activation
    gate — deliberately NOT wired into `ollama_provider.ts`'s
    `registerOllamaModel`, Flue's hot dispatch-registration path, where an
    earlier version raced the probe's own request against the real dispatch's
    request to the same base URL) — that sends a real minimal completion
    and inspects the response for the `prompt_tokens_details` key. When
    confirmed absent, every subsequent agent-call span for that base URL on
    a model prefixed `ollama/` carries `spf.cache_details_available: false`
    (never set otherwise — true/unknown are not alertable states), the exact
    actionable dashboard-alert signal this note used to say was impossible.
    `spf doctor` surfaces the same probe result as an informational
    "vLLM cache-details support" check. The deployment-side fix — actually
    setting the flag on the vLLM server — lives in https://github.com/iamfiscus/inference-platform-aws,
    not this repo.

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
