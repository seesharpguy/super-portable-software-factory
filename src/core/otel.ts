/**
 * OpenTelemetry span export (v1): a config-gated, lossy, fire-and-forget
 * PROJECTION of the trace SQLite already holds. Read this header before
 * changing anything here — every paragraph is a constraint that survived an
 * adversarial review, not a preference.
 *
 * WHAT THIS IS NOT. It is not a second source of truth and it is not in any
 * control path. `tracer.ts` (files + SQLite, synchronous) remains THE record;
 * this module is a tail-call fan-out off its write methods. Export can never
 * affect a phase, a gate, or a run outcome — "agent proposes, code disposes"
 * is untouched because export cannot dispose of anything. Nothing in here may
 * ever throw into a caller, block a caller, or be awaited by a caller other
 * than the two shutdown paths named under LIFECYCLE below.
 *
 * SPANS ONLY. No `resourceMetrics`, no `resourceLogs`. The OTLP metrics data
 * model (temporality, monotonicity, cumulative-vs-delta) is exactly where a
 * hand-rolled encoder produces numbers a backend silently misreads, and a
 * wrong cost number is worse than no cost number. Token counts and dollars
 * ride as span ATTRIBUTES instead. Do not "just add metrics" here.
 *
 * EXPLICIT CONFIG ONLY. Activation requires `observability.otel.endpoint` in
 * the config file. This module NEVER reads `OTEL_EXPORTER_OTLP_ENDPOINT` or
 * any other ambient exporter variable: an unrelated shell variable inherited
 * from a CI image or a coworker's dotfiles must not be able to turn a repo's
 * telemetry egress on. (`SPF_CLAUDE_CMD` is not a precedent for the opposite:
 * that variable is SPF-namespaced and only redirects a LOCAL subprocess — it
 * moves no data off the machine.)
 *
 * ATTRIBUTE ALLOWLIST — exfiltration is the top risk here, because
 * `EventRecord.payload` carries the repository's own source code (tool args,
 * result snippets, diffs, prompts, envelope contents, the operator's request
 * text). The allowlist, in full: phase name/kind/owner/status/seq/attempt,
 * chain name, adw_id, agent name/model/coding_agent, gate name + passed +
 * violation COUNT, token counts (UsageBreakdown fields) + costs, durations
 * (implied by span start/end), and event TYPE. Everything else is excluded by
 * construction, not by filtering:
 *   - This module reads `EventRecord.payload` for FINITE NUMBERS ONLY (see
 *     `numOrNull`) and only under known UsageBreakdown/cost keys. A string can
 *     never reach an attribute through the payload path. Do not add a
 *     `stringValue` read from `payload` — that single line is the whole
 *     exfiltration bug.
 *   - Agent model/coding_agent come from the typed `AgentConfig` handed to
 *     `recordAgentSession` (config data), NOT from the `agent_start` payload.
 *   - Tool spans are named from `record.name`'s prefix up to the first ":"
 *     (see `toolSpanName`). The full `record.name` is a HUMAN LABEL built from
 *     real tool arguments (`agent_flue.ts`'s `labelFor` -> "bash: cat
 *     src/secret.ts") and must never be exported verbatim.
 *   - `Phase.error` is NOT exported. It is an agent- and repo-derived string.
 *     A failed phase span carries status ERROR with no message.
 *   - `tracer.sessionRequest`, `tracer.envelopeRow`, `tracer.processStart/End`
 *     have deliberately NO fan-out: the operator's request text, envelope
 *     contents, and pids are all outside the allowlist. Do not add one.
 *
 * SPAN MODEL. One run (adw_id) = one trace. Root span = the run. Each phase =
 * a child span of the root, using `runner.ts`'s real `started_at`/`ended_at`.
 * Each agent call (`agent_start`..`agent_end`, with its UsageBreakdown) = a
 * CHILD span of its phase: a phase-only tree cannot answer "which agent call
 * burned the tokens", which is the question this feature exists for.
 * `tool_call` events (they carry real timing) = child spans of the open agent
 * call where attributable, else of the phase. `handoff`/`error` become a span
 * EVENT on the phase span, with allowlisted attributes only. `gate_pass`/
 * `gate_fail` do NOT (see `recordGate` below, which carries the structured
 * verdict instead). `log` is dropped outright — a console line is redundant
 * with the phase span itself and would only crowd out `handoff`/`error` in
 * the per-phase event cap (see BACKPRESSURE and `MAX_EVENTS_PER_SPAN`). Any
 * event type not named above is dropped, fail-closed, by `recordEvent`.
 *
 * IDS ARE A BESPOKE CONVENTION, documented so nobody mistakes it for the OTel
 * SDK's random-id behavior: trace-id = first 32 hex of sha256(adw_id),
 * span-id = first 16 hex of sha256(a stable key — `phase_id` for a phase,
 * `agent:<phase_id>:<agent>:<n>` for an agent call, `tool:<phase_id>:<event_id>`
 * for a tool call). Determinism means a re-export of the same run lands on the
 * same ids instead of duplicating the trace, and a child span can name its
 * parent's id without waiting for the parent to be emitted.
 * `EventRecord.parent_id` is structurally ALWAYS EMPTY today (SPF's phases are
 * flat siblings; nothing writes nesting), so there is no recorded hierarchy to
 * mine — the parenting above is reconstructed from phase_id + agent-call
 * bracketing, and that is the only reason it needs reconstructing at all.
 *
 * PHASE SPANS ARE EMITTED AT PHASE END ONLY. A hung or killed phase is
 * therefore INVISIBLE to the backend (its buffered span events die with it),
 * while SQLite still shows it as `running`. Deliberate v1 trade: streaming a
 * span at phase start would require mutating an already-sent span, which OTLP
 * has no notion of. Recorded here so it is a known gap, not a surprise.
 *
 * INBOUND TRACEPARENT. When a valid W3C `traceparent` is present in the
 * environment, its trace-id becomes this run's trace-id and the run's root
 * span is parented under its span-id, so an SPF run joins the CI trace that
 * launched it instead of hanging as an orphan root. Reading `traceparent` is
 * NOT ambient activation: with no `observability.otel` config, nothing is
 * constructed and nothing is sent, traceparent or not. Garbage is rejected
 * silently (see `parseTraceparent`) — a malformed variable must degrade to
 * "own root", never to an error.
 *
 * LIFECYCLE (copied from `notify/notifier.ts`'s discipline, with one
 * addition `notify` doesn't need — see RUN-SCOPED CLEANUP below). A
 * module-level LIVE registry holds every exporter this process created;
 * `flushAll()` is awaited in `src/cli/index.ts`'s existing `finally` block
 * next to `notify.flushAll()`, AND `session.ts`'s signal handler runs a
 * bounded, timeout-capped drain before its `process.exit(128+n)` (notify
 * drains there too, via `drainAll()`, both racing the same budget
 * concurrently — see #25). Send failures log ONE line for the life of the exporter,
 * with the endpoint and every header VALUE redacted, and are then swallowed.
 *
 * RUN-SCOPED CLEANUP (#26). `notify`'s `LIVE` array has the same
 * unbounded-growth problem under a long-lived daemon (tracked as #31, not
 * fixed here). `spf watch` breaks the one-session-per-process assumption
 * both registries were written under: its daemon loop runs many sessions
 * in-process, one per claimed issue, and every one of them calls
 * `resolveOtelExporter` — with no removal path, that was one exporter (plus
 * its bounded span queue, its buffered-event maps, its open-agent-call
 * tracking) held forever per issue processed, for the life of the daemon.
 * `LIVE` is therefore keyed by adw_id (not a plain array) so a finished run
 * can be found and dropped by id, and `releaseOtelExporter(adwId)` — called
 * from `chains/index.ts`'s `runChain()`, the one call site every dispatch
 * (one-shot CLI and `spf watch` alike) passes through on its way out,
 * success or thrown error alike — drains that one exporter and removes it.
 * Draining BEFORE removing matters: the removal itself must never be the
 * reason a run's final root span goes unsent (that guarantee is what
 * `flushAll()` already gave the one-shot CLI path, and this must not weaken
 * it). And it must not run any EARLIER than "this run's own dispatch has
 * fully settled" — a signal can still land while the run is in flight, and
 * `session.ts`'s handler drains the GLOBAL registry, so an exporter removed
 * before its run is actually done would silently stop being reachable from
 * that drain. A one-shot invocation with no explicit `--adw-id` is a
 * harmless no-op here (the registry key is the RESOLVED id `session.ensure`
 * mints, which `runChain()`'s caller never sees) — that process exits right
 * after anyway, so the existing end-of-process `flushAll()` still covers it
 * exactly as it always did.
 *
 * BACKPRESSURE. `tracer.event()` fires per tool call on a hot path, so raw
 * promise-per-span fire-and-forget is a memory bug, not a style choice.
 * Spans go into a BOUNDED queue (`MAX_QUEUED_SPANS`, drop-OLDEST) and leave in
 * batches (`BATCH_SPANS`, or `FLUSH_INTERVAL_MS`, whichever comes first) via an
 * UNREF'D timer that can never hold the process open. Dropped spans are
 * counted, reported once as a warn line, and exported as a resource attribute
 * on the final flush so the gap is visible in the backend too. The size
 * trigger schedules a timer rather than flushing inline, which also means a
 * synchronous burst of thousands of events exercises the bound (see the queue
 * test) instead of interleaving sends.
 *
 * WIRE FORMAT is hand-rolled OTLP/HTTP with a JSON body — no new npm
 * dependency for an optional, lossy projection. The shape that matters:
 * `{resourceSpans:[{resource:{attributes:[KeyValue]},scopeSpans:[{scope,spans:[Span]}]}]}`,
 * every attribute value wrapped in an AnyValue (`{stringValue}`/`{intValue}`/
 * `{doubleValue}`/`{boolValue}`), trace/span ids as lowercase hex strings, and
 * every uint64 nanosecond timestamp AS A STRING (a JSON number would lose
 * precision past 2^53 and backends reject it). `src/test/otel.test.ts` pins
 * this shape against an in-process receiver.
 */

import { createHash } from "node:crypto";
import type { AgentConfig, EventRecord, GateReport, OTelConfig, Phase, SFConfig } from "./data_types.ts";

// ── tunables (see BACKPRESSURE above) ───────────────────────────────────────
const MAX_QUEUED_SPANS = 2048;
const BATCH_SPANS = 64;
const FLUSH_INTERVAL_MS = 2_000;
/** Per-request cap, and the default drain budget for `flushAll()`. */
const SEND_TIMEOUT_MS = 2_000;
/** Span events buffered per phase while it runs; a runaway phase cannot grow unbounded. */
const MAX_EVENTS_PER_SPAN = 64;

const SPAN_KIND_INTERNAL = 1;
const STATUS_UNSET = 0;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

// ── OTLP/HTTP-JSON wire types (hand-rolled; see WIRE FORMAT above) ──────────
type AnyValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
interface KeyValue {
  key: string;
  value: AnyValue;
}
interface SpanEvent {
  timeUnixNano: string;
  name: string;
  attributes: KeyValue[];
}
interface Span {
  traceId: string;
  spanId: string;
  /** "" means "no parent" — OTLP/JSON's spelling for a root span. */
  parentSpanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  events: SpanEvent[];
  status: { code: number };
}
interface OtlpTracesPayload {
  resourceSpans: Array<{
    resource: { attributes: KeyValue[] };
    scopeSpans: Array<{ scope: { name: string; version: string }; spans: Span[] }>;
  }>;
}

// ── pure helpers (exported so `src/test/otel.test.ts` can pin them) ─────────

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * An all-zero id is invalid in W3C/OTLP ("no trace"/"no span"), so a hash that
 * somehow lands there is nudged off it. Practically unreachable; cheaper than
 * reasoning about whether it is.
 */
function nonZero(hex: string): string {
  return /^0+$/.test(hex) ? hex.slice(0, -1) + "1" : hex;
}

/** trace-id = first 32 hex of sha256(adw_id). Bespoke convention — see the header. */
export function traceIdFor(adwId: string): string {
  return nonZero(sha256Hex(adwId).slice(0, 32));
}

/** span-id = first 16 hex of sha256(key), where key is a phase_id or a synthetic child key. */
export function spanIdFor(key: string): string {
  return nonZero(sha256Hex(key).slice(0, 16));
}

export interface TraceParent {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

/**
 * Strict W3C `traceparent` parse: `00-<32 hex>-<16 hex>-<2 hex>`, lowercase,
 * exact lengths, neither id all-zero. Anything else — a wrong version, an
 * uppercase digest, a truncated id, an empty string, unset — returns null and
 * the run keeps its own root. Never throws, never logs: a malformed CI
 * variable is not this module's problem to report.
 */
export function parseTraceparent(value: string | undefined | null): TraceParent | null {
  if (!value) return null;
  const parts = value.trim().split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, spanId, flags] = parts;
  // Only version 00 is defined. A future version MAY be parseable field-wise,
  // but guessing at an unknown format is how you propagate a wrong parent.
  if (version !== "00") return null;
  if (!HEX32.test(traceId) || !HEX16.test(spanId)) return null;
  if (!/^[0-9a-f]{2}$/.test(flags)) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 0x01) === 0x01 };
}

/**
 * The two env vars CI systems actually set. Reading them is not activation —
 * see INBOUND TRACEPARENT in the header.
 */
export function inboundTraceparent(env: NodeJS.ProcessEnv = process.env): TraceParent | null {
  return parseTraceparent(env["TRACEPARENT"]) ?? parseTraceparent(env["OTEL_TRACEPARENT"]);
}

/**
 * The configured endpoint is used AS GIVEN when it already names a path — the
 * operator's URL is not ours to rewrite. A bare origin (`http://host:4318`,
 * or a trailing "/") gets the standard OTLP/HTTP traces path appended, because
 * that is the one guess with a single right answer. Returns the input
 * unchanged if it does not parse as a URL; the config schema rejects those
 * first, so this is only belt-and-braces for direct callers.
 */
export function resolveTracesUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return endpoint;
  }
  if (url.pathname === "" || url.pathname === "/") url.pathname = "/v1/traces";
  return url.toString();
}

/**
 * A printable form of the endpoint for `spf doctor`: origin + path only.
 * Userinfo (`https://user:token@host/...`) and the query string are dropped —
 * both are places a credential is routinely smuggled into a URL.
 */
export function endpointLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "(unparseable endpoint)";
  }
}

/**
 * ISO-8601 -> uint64 nanoseconds AS A STRING (see WIRE FORMAT). Unparseable,
 * missing, or pre-epoch input falls back to `fallbackMs`, because a span with
 * a nonsense timestamp is rejected wholesale by most backends while a span
 * with an approximate one is still useful.
 */
export function nanosFromIso(iso: string | null | undefined, fallbackMs: number = Date.now()): string {
  const parsed = iso ? Date.parse(iso) : NaN;
  const ms = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackMs;
  // String concat, not BigInt math: ms is an integer, and appending six zeros
  // is exact where `ms * 1e6` would drift into float territory.
  return `${Math.floor(ms)}000000`;
}

/**
 * The safe half of a `tool_call` event's name. `record.name` for a tool call is
 * a human label built FROM THE TOOL'S ARGUMENTS ("bash: cat src/secret.ts",
 * "read: /etc/hosts"); only the part before the first ":" is the tool's own
 * identity. Also clipped and character-restricted so a hand-rolled event name
 * can't smuggle a payload through as a span name.
 */
export function toolSpanName(eventName: string | undefined | null): string {
  const head = String(eventName ?? "").split(":")[0]!.trim();
  const safe = head.replace(/[^A-Za-z0-9_.\-/]/g, "").slice(0, 40);
  return safe || "tool_call";
}

/**
 * Redact every secret from a log line. The endpoint and each header VALUE are
 * passed in; `fetch` failures routinely embed the URL they attempted, and a
 * proxy error can echo a header. One-line rule: nothing configured under
 * `observability.otel` ever reaches a log.
 */
export function redact(message: string, secrets: Array<string | undefined>): string {
  let out = message;
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  // Belt and braces for a URL this exporter never saw (a redirect target, a
  // proxy's own address) appearing in someone else's error text.
  return out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, "[redacted-url]");
}

/**
 * The ONLY door from `EventRecord.payload` into an attribute: finite numbers,
 * nothing else. A string — which is what every exfiltration risk in a payload
 * actually is — returns null and is dropped. Do not relax this.
 */
function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const str = (key: string, value: string): KeyValue => ({ key, value: { stringValue: value } });
const int = (key: string, value: number): KeyValue => ({ key, value: { intValue: String(Math.trunc(value)) } });
const dbl = (key: string, value: number): KeyValue => ({ key, value: { doubleValue: value } });
const bool = (key: string, value: boolean): KeyValue => ({ key, value: { boolValue: value } });

/** UsageBreakdown's token fields -> attribute suffixes. Numbers only, by construction. */
const TOKEN_FIELDS: Array<[string, string]> = [
  ["input_tokens", "spf.tokens.input"],
  ["output_tokens", "spf.tokens.output"],
  ["cache_read_tokens", "spf.tokens.cache_read"],
  ["cache_write_tokens", "spf.tokens.cache_write"],
  ["reasoning_tokens", "spf.tokens.reasoning"],
  ["total_tokens", "spf.tokens.total"],
];
const COST_FIELDS: Array<[string, string]> = [
  ["input_cost", "spf.cost.input"],
  ["output_cost", "spf.cost.output"],
  ["cache_read_cost", "spf.cost.cache_read"],
  ["cache_write_cost", "spf.cost.cache_write"],
  ["total_cost", "spf.cost.total"],
];

// ── the exporter ────────────────────────────────────────────────────────────

export interface OtelExporterInit {
  /** The validated `observability.otel` block. Its presence IS the activation switch. */
  cfg: OTelConfig;
  adwId: string;
  /** The CLI chain name, from `session.ts` — allowlisted, config-declared. */
  chainName: string;
  /** Injectable for tests; defaults to stderr, exactly like `Notifier`'s. */
  log?: (message: string) => void;
  /** Injectable for tests; defaults to `process.env`. Only ever read for `traceparent`. */
  env?: NodeJS.ProcessEnv;
}

interface OpenAgentCall {
  spanId: string;
  startNano: string;
}

export class OtelExporter {
  private readonly cfg: OTelConfig;
  private readonly adwId: string;
  private readonly chainName: string;
  private readonly serviceName: string;
  private readonly url: string;
  private readonly log: (message: string) => void;

  private readonly traceId: string;
  /** "" unless an inbound traceparent parented this run — see INBOUND TRACEPARENT. */
  private readonly rootParentSpanId: string;
  private readonly rootSpanId: string;

  private queue: Span[] = [];
  private dropped = 0;
  private droppedEvents = 0;
  private warnedDrops = false;
  private loggedFailure = false;

  private timer: NodeJS.Timeout | null = null;
  private timerDelay = Number.POSITIVE_INFINITY;
  private pending = new Set<Promise<void>>();

  /** Span events buffered until their phase span exists. Key "" = the root run span. */
  private bufferedEvents = new Map<string, SpanEvent[]>();
  /**
   * Phases whose span has already gone out. Events DO arrive after a phase
   * span is emitted — `run.finish()`'s `not_accepted` error names the last
   * phase — and a span already on the wire cannot grow an event, so those are
   * re-homed onto the root run span instead of accumulating in a buffer that
   * nothing will ever drain.
   */
  private emittedPhases = new Set<string>();
  /** `<phase_id> <agent>` -> the open agent call, for closing it and parenting tool spans. */
  private openAgents = new Map<string, OpenAgentCall>();
  /** How many times an agent has been called in a phase, so a retry gets its own span id. */
  private agentCalls = new Map<string, number>();
  /** agent name -> config metadata, from `recordAgentSession` (typed config, never a payload). */
  private agentMeta = new Map<string, { model: string; codingAgent: string }>();

  private runStartedAtMs = Date.now();
  private rootEmitted = false;

  constructor(init: OtelExporterInit) {
    this.cfg = init.cfg;
    this.adwId = init.adwId;
    this.chainName = init.chainName;
    this.serviceName = init.cfg.service_name || "spf";
    this.url = resolveTracesUrl(init.cfg.endpoint);
    this.log = init.log ?? ((m: string) => console.error(m));

    const inbound = inboundTraceparent(init.env ?? process.env);
    this.traceId = inbound ? inbound.traceId : traceIdFor(init.adwId);
    this.rootParentSpanId = inbound ? inbound.spanId : "";
    this.rootSpanId = spanIdFor(`run:${init.adwId}`);
  }

  // ── fan-out seams (called from tracer.ts's write methods) ────────────────

  /** `tracer.sessionStart` — only the run's clock; the engineer name is not allowlisted. */
  recordSessionStart(startedAtIso?: string | null): void {
    const parsed = startedAtIso ? Date.parse(startedAtIso) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0) this.runStartedAtMs = parsed;
  }

  /**
   * `tracer.event` — the one hot seam. Dispatch, in full:
   *   phase_start/phase_end -> ignored (the phase span's own boundaries say it)
   *   agent_start           -> open an agent call
   *   agent_end             -> emit the agent-call child span, with usage
   *   tool_call             -> emit a tool child span (real timing, safe name)
   *   gate_pass/gate_fail   -> ignored HERE; `recordGate` carries the structured
   *                            GateReport for the same gate, and doubling it
   *                            would put two span events on every gate
   *   handoff/error         -> a span event buffered onto the phase span
   *   log                   -> dropped: a console line adds nothing beyond
   *                            `spf.event.type`/`name`, and buffering it would
   *                            crowd `handoff`/`error` out of the per-phase cap
   *                            (see MAX_EVENTS_PER_SPAN)
   *   anything else          -> dropped. The dispatch is fail-closed on purpose:
   *                            a future EventRecord.type whose `name` is
   *                            derived from agent output must not fall through
   *                            to export by default.
   */
  recordEvent(record: EventRecord, eventId: string, tsIso: string): void {
    switch (record.type) {
      case "phase_start":
      case "phase_end":
      case "gate_pass":
      case "gate_fail":
        return;
      case "agent_start":
        this.openAgentCall(record.phase_id, record.name, tsIso);
        return;
      case "agent_end":
        this.closeAgentCall(record, tsIso);
        return;
      case "tool_call":
        this.emitToolSpan(record, eventId, tsIso);
        return;
      case "log":
        return;
      case "handoff":
      case "error":
        this.bufferSpanEvent(record.phase_id, {
          timeUnixNano: nanosFromIso(record.started_at ?? tsIso),
          name: record.type,
          // `record.name` is code- or config-declared (a phase name, a gate
          // name, "paths_touched"), never agent output — unlike payload.
          attributes: [str("spf.event.type", record.type), str("spf.event.name", clip(record.name))],
        });
        return;
      default:
        return;
    }
  }

  /**
   * `tracer.phaseUpsert` — the phase's END is the emit point (see PHASE SPANS
   * ARE EMITTED AT PHASE END ONLY). The start-of-phase upsert has no
   * `ended_at` and is skipped, which also makes this idempotent-ish: a
   * re-upsert of the same finished phase re-emits a span with the SAME id, so
   * a backend overwrites rather than duplicates.
   */
  recordPhase(phase: Phase): void {
    if (!phase.ended_at) return;
    const spanId = spanIdFor(phase.phase_id);
    this.emittedPhases.add(phase.phase_id);
    const attributes: KeyValue[] = [
      str("spf.adw_id", this.adwId),
      str("spf.chain", this.chainName),
      str("spf.phase.name", clip(phase.params.name)),
      str("spf.phase.kind", clip(phase.params.kind)),
      str("spf.phase.owner", clip(phase.params.owner)),
      str("spf.phase.status", clip(phase.status)),
      int("spf.phase.seq", phase.seq),
      int("spf.phase.attempt", phase.attempt),
    ];
    this.enqueue({
      traceId: this.traceId,
      spanId,
      parentSpanId: this.rootSpanId,
      name: `phase ${phase.params.name}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: nanosFromIso(phase.started_at, this.runStartedAtMs),
      endTimeUnixNano: nanosFromIso(phase.ended_at),
      attributes,
      // `phase.error` is deliberately absent: agent- and repo-derived text.
      // The ERROR status is the whole signal a backend gets.
      status: { code: phase.status === "success" ? STATUS_OK : STATUS_ERROR },
      events: this.takeBufferedEvents(phase.phase_id),
    });
  }

  /**
   * `tracer.gateRow` — the verdict and its SIZE, never its content. A
   * violation string quotes the agent's own claim and the repo's files; only
   * the count crosses the wire.
   */
  recordGate(phase: Phase, gate: string, report: GateReport, attempt: number): void {
    this.bufferSpanEvent(phase.phase_id, {
      timeUnixNano: nanosFromIso(null),
      name: report.passed ? "gate_pass" : "gate_fail",
      attributes: [
        str("spf.gate.name", clip(gate)),
        bool("spf.gate.passed", report.passed),
        int("spf.gate.violation_count", report.violations.length),
        int("spf.gate.attempt", attempt),
      ],
    });
  }

  /**
   * `tracer.agentSessionRow` — the typed source for an agent's model and
   * backend. Load-bearing, not decoration: it is written BEFORE the
   * `agent_end` event (see `agents.ts`), which is what lets the agent-call
   * span carry model/coding_agent without ever reading the `agent_start`
   * payload. `session_id` is NOT exported (it is a coding-agent handle, not a
   * measure).
   */
  recordAgentSession(agent: AgentConfig): void {
    this.agentMeta.set(agent.name, { model: agent.model, codingAgent: agent.coding_agent });
  }

  /**
   * `tracer.sessionFinish` — emits the root run span exactly once. Called
   * twice on some paths (a failing phase finalizes, then `finish()` does), and
   * the guard is why that is harmless.
   */
  recordSessionFinish(ok: boolean): void {
    this.emitRootSpan(ok ? "success" : "fail", ok ? STATUS_OK : STATUS_ERROR);
  }

  // ── queue + batching ────────────────────────────────────────────────────

  /** Queued spans and spans/events dropped so far. For tests and diagnostics. */
  stats(): { queued: number; dropped: number; droppedEvents: number } {
    return { queued: this.queue.length, dropped: this.dropped, droppedEvents: this.droppedEvents };
  }

  /**
   * The exact JSON body the next flush would POST, without sending or
   * draining. This is the seam `src/test/otel.test.ts` uses to prove the
   * allowlist holds — the assertion is on the literal bytes, so any future
   * attribute that leaks a payload fails a test rather than a review.
   */
  pendingJson(): string {
    return JSON.stringify(this.payloadFor(this.queue, false));
  }

  private enqueue(span: Span): void {
    if (this.queue.length >= MAX_QUEUED_SPANS) {
      this.queue.shift(); // drop OLDEST: the newest spans are the ones still explaining the run
      this.dropped += 1;
    }
    this.queue.push(span);
    // Size trigger SCHEDULES; it never sends inline. A synchronous burst of
    // events therefore fills the queue (exercising the bound) instead of
    // interleaving thousands of sends into the middle of a phase.
    this.schedule(this.queue.length >= BATCH_SPANS ? 0 : FLUSH_INTERVAL_MS);
  }

  private schedule(delayMs: number): void {
    if (this.timer && this.timerDelay <= delayMs) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerDelay = delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerDelay = Number.POSITIVE_INFINITY;
      this.track(this.flush());
    }, delayMs);
    // UNREF'D: the exporter must never be the reason a `spf` process lingers.
    this.timer.unref?.();
  }

  private track(promise: Promise<void>): void {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }

  /**
   * Send whatever is queued. Never throws, never rejects: a failed export is a
   * single redacted log line and a swallowed error, because the alternative is
   * an observability feature that can fail a run.
   */
  async flush(isFinal: boolean = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.timerDelay = Number.POSITIVE_INFINITY;
    }
    if (this.queue.length === 0) return;
    const spans = this.queue;
    this.queue = [];
    const body = JSON.stringify(this.payloadFor(spans, isFinal));

    if (isFinal && this.dropped > 0 && !this.warnedDrops) {
      this.warnedDrops = true;
      this.log(`spf: otel export dropped ${this.dropped} span(s) — the queue bound (${MAX_QUEUED_SPANS}) was hit`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.cfg.headers ?? {}) },
        body,
        signal: controller.signal,
      });
      if (!response.ok) this.logFailureOnce(`HTTP ${response.status}`);
    } catch (error) {
      this.logFailureOnce((error as Error)?.message ?? String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Drain: flush, then await anything already in flight, all under one hard
   * budget. Never throws. Called from the CLI's `finally` and from
   * `session.ts`'s signal handler (with a tighter budget there).
   */
  async drain(budgetMs: number = SEND_TIMEOUT_MS): Promise<void> {
    // A hard crash never reached sessionFinish — emit the root span anyway so
    // its children are not orphans, marked so the gap is legible.
    if (!this.rootEmitted) this.emitRootSpan("incomplete", STATUS_UNSET);
    const work = (async () => {
      this.track(this.flush(true));
      await Promise.all([...this.pending]);
    })();
    // Give `work` a terminal handler before racing it against `budget`: if
    // `budget` wins first and `work` rejects afterward, an unattached
    // rejection here would be unhandled (Node >=15 terminates the process)
    // on exactly the shutdown path this function exists to protect.
    void work.catch(() => {});
    let deadline: NodeJS.Timeout | null = null;
    const budget = new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, budgetMs);
      deadline.unref?.();
    });
    try {
      await Promise.race([work, budget]);
    } catch {
      // unreachable in practice — flush() already swallows — but a drain that
      // can throw would break the shutdown path it exists to protect.
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  private emitRootSpan(status: string, code: number): void {
    if (this.rootEmitted) return;
    this.rootEmitted = true;
    this.enqueue({
      traceId: this.traceId,
      spanId: this.rootSpanId,
      parentSpanId: this.rootParentSpanId,
      name: `spf run ${this.chainName}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: nanosFromIso(null, this.runStartedAtMs),
      endTimeUnixNano: nanosFromIso(null),
      attributes: [
        str("spf.adw_id", this.adwId),
        str("spf.chain", this.chainName),
        str("spf.run.status", status),
      ],
      status: { code },
      events: this.takeBufferedEvents(""),
    });
  }

  private agentKey(phaseId: string, agentName: string): string {
    return `${phaseId} ${agentName}`;
  }

  private openAgentCall(phaseId: string, agentName: string, tsIso: string): void {
    const key = this.agentKey(phaseId, agentName);
    const n = (this.agentCalls.get(key) ?? 0) + 1;
    this.agentCalls.set(key, n);
    this.openAgents.set(key, {
      spanId: spanIdFor(`agent:${phaseId}:${agentName}:${n}`),
      startNano: nanosFromIso(tsIso),
    });
  }

  private closeAgentCall(record: EventRecord, tsIso: string): void {
    const key = this.agentKey(record.phase_id, record.name);
    const open = this.openAgents.get(key);
    this.openAgents.delete(key);
    const meta = this.agentMeta.get(record.name);
    const attributes: KeyValue[] = [
      str("spf.adw_id", this.adwId),
      str("spf.agent.name", clip(record.name)),
    ];
    if (meta) {
      attributes.push(str("spf.agent.model", clip(meta.model)), str("spf.agent.coding_agent", clip(meta.codingAgent)));
      // gen_ai.* is the OTel semantic convention a GenAI-aware backend groups
      // by; the spf.* twins stay because they are what SPF's own queries use.
      attributes.push(str("gen_ai.request.model", clip(meta.model)));
    }

    // NUMBERS ONLY out of payload — see the ATTRIBUTE ALLOWLIST note on
    // `numOrNull`. A string under any of these keys is dropped, not exported.
    const usage = record.payload?.["usage"];
    const usageObj = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
    for (const [field, key2] of TOKEN_FIELDS) {
      const value = numOrNull(usageObj[field]);
      if (value !== null) attributes.push(int(key2, value));
    }
    for (const [field, key2] of COST_FIELDS) {
      const value = numOrNull(usageObj[field]);
      if (value !== null) attributes.push(dbl(key2, value));
    }
    const totalTokens = numOrNull(record.tokens);
    if (totalTokens !== null) attributes.push(int("spf.tokens.total", totalTokens));
    const inputTokens = numOrNull(usageObj["input_tokens"]);
    if (inputTokens !== null) attributes.push(int("gen_ai.usage.input_tokens", inputTokens));
    const outputTokens = numOrNull(usageObj["output_tokens"]);
    if (outputTokens !== null) attributes.push(int("gen_ai.usage.output_tokens", outputTokens));
    const cost = numOrNull(record.payload?.["cost"]);
    if (cost !== null) attributes.push(dbl("spf.cost.total", cost));

    this.enqueue({
      traceId: this.traceId,
      spanId: open?.spanId ?? spanIdFor(`agent:${record.phase_id}:${record.name}:orphan`),
      parentSpanId: record.phase_id ? spanIdFor(record.phase_id) : this.rootSpanId,
      name: `agent ${record.name}`,
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: open?.startNano ?? nanosFromIso(tsIso),
      endTimeUnixNano: nanosFromIso(tsIso),
      attributes,
      status: { code: STATUS_UNSET }, // the phase span carries the verdict
      events: [],
    });
  }

  /**
   * Tool spans carry REAL elapsed time (the tracker records started_at/ended_at
   * per call), which is the whole reason they are spans and not span events.
   * Parented under the open agent call when one is attributable — the agent
   * name comes from `payload.agent`, and it is used ONLY as a map lookup key,
   * never written to an attribute, so an unexpected value yields "no parent
   * found" rather than an exported string.
   */
  private emitToolSpan(record: EventRecord, eventId: string, tsIso: string): void {
    const agentName = record.payload?.["agent"];
    const open = typeof agentName === "string" ? this.openAgents.get(this.agentKey(record.phase_id, agentName)) : undefined;
    const parent = open?.spanId ?? (record.phase_id ? spanIdFor(record.phase_id) : this.rootSpanId);
    this.enqueue({
      traceId: this.traceId,
      spanId: spanIdFor(`tool:${record.phase_id}:${eventId}`),
      parentSpanId: parent,
      name: toolSpanName(record.name),
      kind: SPAN_KIND_INTERNAL,
      startTimeUnixNano: nanosFromIso(record.started_at ?? tsIso),
      endTimeUnixNano: nanosFromIso(record.ended_at ?? tsIso),
      attributes: [str("spf.adw_id", this.adwId), str("spf.event.type", record.type)],
      status: { code: STATUS_UNSET },
      events: [],
    });
  }

  private bufferSpanEvent(phaseId: string, event: SpanEvent): void {
    const key = phaseId && !this.emittedPhases.has(phaseId) ? phaseId : "";
    const list = this.bufferedEvents.get(key) ?? [];
    if (list.length >= MAX_EVENTS_PER_SPAN) {
      this.droppedEvents += 1;
      return;
    }
    list.push(event);
    this.bufferedEvents.set(key, list);
  }

  private takeBufferedEvents(phaseId: string): SpanEvent[] {
    const events = this.bufferedEvents.get(phaseId) ?? [];
    this.bufferedEvents.delete(phaseId);
    return events;
  }

  private payloadFor(spans: Span[], isFinal: boolean): OtlpTracesPayload {
    const attributes: KeyValue[] = [
      str("service.name", this.serviceName),
      str("spf.adw_id", this.adwId),
      str("spf.chain", this.chainName),
    ];
    // The drop counter rides the FINAL flush's resource, so the gap is visible
    // in the backend and not only in a log line nobody kept.
    if (isFinal && this.dropped > 0) attributes.push(int("spf.otel.dropped_spans", this.dropped));
    if (isFinal && this.droppedEvents > 0) attributes.push(int("spf.otel.dropped_span_events", this.droppedEvents));
    return {
      resourceSpans: [
        {
          resource: { attributes },
          scopeSpans: [{ scope: { name: "spf", version: "1" }, spans }],
        },
      ],
    };
  }

  private logFailureOnce(reason: string): void {
    if (this.loggedFailure) return;
    this.loggedFailure = true;
    const secrets = [this.cfg.endpoint, this.url, ...Object.values(this.cfg.headers ?? {})];
    this.log(`spf: otel export failed (${redact(reason, secrets)}) — spans for this run are lost; the run is unaffected`);
  }
}

/** Attribute strings are clipped: an attribute is a label, not a document. */
function clip(value: string | null | undefined, limit = 200): string {
  const text = String(value ?? "");
  return text.length <= limit ? text : text.slice(0, limit);
}

// ── module-level lifecycle (mirrors notify/notifier.ts's LIVE + flushAll,
//    keyed by adw_id — see RUN-SCOPED CLEANUP above) ─────────────────────────

const LIVE = new Map<string, OtelExporter>();

/**
 * Build an exporter from `cfg.observability.otel`, or `null` when it is
 * absent — the same optional-dependency shape as `resolveNotifier`, so every
 * call site is `otel?.record...()` and never a conditional branch. `null` is
 * the default for every repo that has not configured an endpoint, and no
 * environment variable can change that (see EXPLICIT CONFIG ONLY).
 *
 * Registered under `opts.adwId` — the RESOLVED id (`session.ensure`'s own
 * `id`, never a caller's possibly-null `ctx.adw_id`) — which is exactly the
 * key `releaseOtelExporter` below looks it up by. A second registration
 * under an id that's still live (in practice: a bug elsewhere, since adw_id
 * is meant to be unique per in-flight run) replaces the map entry; the
 * orphaned exporter's own queue still drains itself on its own unref'd
 * timer, just unreachable from `flushAll()` from that point on.
 */
export function resolveOtelExporter(
  cfg: SFConfig,
  opts: { adwId: string; chainName: string; log?: (message: string) => void; env?: NodeJS.ProcessEnv },
): OtelExporter | null {
  const otel = cfg.observability.otel;
  if (!otel || !otel.endpoint) return null;
  const exporter = new OtelExporter({
    cfg: otel,
    adwId: opts.adwId,
    chainName: opts.chainName,
    log: opts.log,
    env: opts.env,
  });
  LIVE.set(opts.adwId, exporter);
  return exporter;
}

/**
 * Drain every exporter this process created, under one budget. A no-op when
 * otel is unconfigured. Called from `src/cli/index.ts`'s `finally` (next to
 * `notify.flushAll()`) and, with a tighter budget, from `session.ts`'s signal
 * handler. Never throws.
 */
export async function flushAll(budgetMs?: number): Promise<void> {
  await Promise.all([...LIVE.values()].map((exporter) => exporter.drain(budgetMs)));
}

/**
 * The counterpart to `resolveOtelExporter`: drain and forget the one
 * exporter registered for `adwId`, so a long-lived process (`spf watch`'s
 * daemon loop) doesn't hold one exporter per run forever (see #26 / the
 * RUN-SCOPED CLEANUP note above). Called from `chains/index.ts`'s
 * `runChain()` once a run's own dispatch has fully settled — success or
 * thrown error alike.
 *
 * A no-op, not an error, when `adwId` is falsy (a one-shot invocation with
 * no explicit `--adw-id` — its caller never learns the id `session.ensure`
 * actually minted, so it cannot ask for this by id; that process exits
 * right after anyway and `flushAll()` still covers it) or when nothing is
 * registered under it (otel unconfigured, or already released). Draining
 * BEFORE deleting the map entry, never after: this run's exporter must stay
 * reachable from a concurrent `flushAll()` (a signal landing on some OTHER
 * still-in-flight run, under `spf watch`'s concurrency) for the full
 * duration of ITS OWN drain, and removing the entry first would let that
 * concurrent drain skip an exporter that has not actually finished sending
 * yet.
 */
export async function releaseOtelExporter(adwId: string | null | undefined, budgetMs?: number): Promise<void> {
  if (!adwId) return;
  const exporter = LIVE.get(adwId);
  if (!exporter) return;
  await exporter.drain(budgetMs);
  LIVE.delete(adwId);
}

/** Tests only: forget every registered exporter so cases cannot leak into each other. */
export function resetLiveForTest(): void {
  LIVE.clear();
}
