/**
 * OpenTelemetry span export (v2): a config-gated, lossy, fire-and-forget
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
 * v2 CHANGE (SDK ENCODER SWAP). v1 hand-rolled the entire OTLP/HTTP-JSON wire
 * format with its own `fetch()` call. v2 keeps every invariant below —
 * public API, the deterministic sha256 id scheme, the attribute allowlist,
 * the bounded queue, the per-run lifecycle — byte-for-byte, and replaces
 * ONLY the encoder: spans are now plain objects that structurally satisfy
 * `@opentelemetry/sdk-trace`'s `ReadableSpan` interface (that package's own
 * concrete `Span`/`SpanImpl` class is NOT part of its public API surface —
 * only the type is exported — so a duck-typed object is not a workaround,
 * it is the intended integration point), handed to a real
 * `@opentelemetry/exporter-trace-otlp-http` `OTLPTraceExporter` instance.
 * `IdGenerator.generateSpanId()` takes no arguments and cannot be handed our
 * sha256 ids any other way — this is why the SDK is used AROUND our own ids
 * rather than asked to generate them.
 *
 * VERIFIED WIRE-SHAPE DIFFERENCES from the old hand-rolled encoder (proven
 * against a real in-process OTLP/HTTP receiver in `src/test/otel.test.ts`,
 * not assumed from docs — this was v1's #1 documented open risk):
 *   - `intValue` is a JSON NUMBER (`{"intValue":1234}`), not a numeric
 *     STRING. The real JSON serializer's `toAnyValue()` (`@opentelemetry/
 *     otlp-transformer`) picks `intValue` whenever `Number.isInteger(value)`
 *     and never stringifies it — proto3 JSON's "int64 as string" rule is a
 *     PROTOBUF-JSON convention this exporter's plain-JSON path does not
 *     follow. A whole-number COST (e.g. exactly `$2`) is therefore
 *     indistinguishable on the wire from an integer attribute — a real,
 *     accepted limitation of `number`-typed OTel attributes, not a bug
 *     introduced here.
 *   - `startTimeUnixNano`/`endTimeUnixNano`/event `timeUnixNano` ARE
 *     STRINGS (`encodeAsString` — nanoseconds via `BigInt`, so no
 *     precision loss past 2^53), matching v1's own precision-driven choice.
 *   - trace/span ids are lowercase hex STRINGS (the JSON encoder's
 *     `encodeSpanContext` is `identity` — our own hex ids pass straight
 *     through), matching v1 exactly.
 *   - a ROOT span's `parentSpanId` is OMITTED from the wire object entirely
 *     (no key at all) rather than v1's explicit `""` — both spellings mean
 *     "no parent" per the OTLP proto3-JSON mapping (proto3 JSON drops
 *     zero-value/unset fields by default); `src/test/otel.test.ts` asserts
 *     `undefined`, not `""`, for a root span now.
 *   - extra fields the real exporter adds that v1 never had (`flags`,
 *     `traceState`, `droppedAttributesCount`, `droppedEventsCount`,
 *     `droppedLinksCount`, `links: []`) are additive and harmless — nothing
 *     downstream reads a fixed field LIST, only named fields.
 *
 * SPANS ONLY (from THIS module's own per-run exporter). No `resourceLogs`.
 * Metrics are now real (see `otel_metrics.ts`) but live on their own
 * PROCESS-scoped pipeline with their own real `@opentelemetry/sdk-metrics`
 * temporality/aggregation handling — never hand-rolled, and never mixed into
 * this module's `resourceSpans` payload.
 *
 * EXPLICIT CONFIG ONLY. Activation requires `observability.otel.endpoint` in
 * the config file. This module NEVER reads `OTEL_EXPORTER_OTLP_ENDPOINT` or
 * any other ambient exporter variable AS AN ACTIVATION SWITCH: an unrelated
 * shell variable inherited from a CI image or a coworker's dotfiles must not
 * be able to turn a repo's telemetry egress on. `observability.otel.
 * allow_env` (see `data_types.ts`'s `OTelConfigSchema`) is the one narrow,
 * opt-in exception: when `true` AND the block is ALREADY active (`endpoint`
 * set), `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_HEADERS` may
 * SUPPLEMENT it (an env-injected token in CI, say) — never activate it from
 * nothing, and config-declared values always win over the env on conflict.
 * (`SPF_CLAUDE_CMD` is not a precedent for the opposite: that variable is
 * SPF-namespaced and only redirects a LOCAL subprocess — it moves no data
 * off the machine.)
 *
 * ATTRIBUTE ALLOWLIST — exfiltration is the top risk here, because
 * `EventRecord.payload` carries the repository's own source code (tool args,
 * result snippets, diffs, prompts, envelope contents, the operator's request
 * text). The allowlist, in full: phase name/kind/owner/status/seq/attempt,
 * chain name, adw_id, agent name/model/coding_agent/lora_adapter, gate name +
 * passed + violation COUNT, token counts (UsageBreakdown fields) + costs,
 * durations (implied by span start/end), and event TYPE. Everything else is
 * excluded by construction, not by filtering:
 *   - This module reads `EventRecord.payload` for FINITE NUMBERS ONLY (see
 *     `numOrNull`) and only under known UsageBreakdown/cost keys. A string can
 *     never reach an attribute through the payload path. Do not add a
 *     string read from `payload` — that single line is the whole
 *     exfiltration bug.
 *   - Agent model/coding_agent/lora_adapter come from the typed `AgentConfig`
 *     handed to `recordAgentSession` (config data), NOT from the
 *     `agent_start` payload.
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
 * parent's id without waiting for the parent to be emitted. UNCHANGED in v2:
 * the SDK is used to ENCODE spans we already fully control, never to
 * generate their ids.
 * `EventRecord.parent_id` is structurally ALWAYS EMPTY today (SPF's phases are
 * flat siblings; nothing writes nesting), so there is no recorded hierarchy to
 * mine — the parenting above is reconstructed from phase_id + agent-call
 * bracketing, and that is the only reason it needs reconstructing at all.
 *
 * PHASE SPANS ARE EMITTED AT PHASE END ONLY. A hung or killed phase is
 * therefore INVISIBLE to the backend (its buffered span events die with it),
 * while SQLite still shows it as `running`. Deliberate v1 trade, unchanged:
 * streaming a span at phase start would require mutating an already-sent
 * span, which OTLP has no notion of.
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
 * OUTBOUND PROPAGATION (new in v2). `agentCallTraceContext()` hands back the
 * CURRENTLY OPEN agent call's own trace context (same traceId, same sha256
 * span id already computed by `openAgentCall`) so a caller can propagate it
 * onward — `agents.ts`'s `send()` reads it into `AgentRequest.otel`, which
 * `agent_cc.ts`'s single `spawn()` choke point turns into `TRACEPARENT` +
 * `ANTHROPIC_CUSTOM_HEADERS` env vars for the `claude` CLI subprocess (see
 * that module's own header for the verified env var format). This is a
 * READ of state this exporter already tracks for its own id scheme — it
 * does not change what gets exported, and it is `null` (a silent no-op)
 * whenever no agent call is currently open.
 *
 * LORA ADAPTER ATTRIBUTE. `loraAdapterFor()` resolves `spf.lora_adapter` —
 * see its own doc comment for the two zero-config conventions plus the
 * explicit `AgentConfig.lora_adapter` override, checked in that order. The
 * attribute is omitted entirely when nothing resolves — never a blind copy
 * of a non-LoRA model id.
 *
 * METRICS FAN-OUT (new in v2). `recordPhase`/`recordGate`/`closeAgentCall`
 * additionally fan out to an OPTIONAL, PROCESS-scoped `OtelMetrics` handle
 * (see `otel_metrics.ts`) — `spf.phase.duration`, `spf.gate.result`,
 * `spf.tokens`, `spf.cost_usd`, `spf.agent.calls`. `resolveOtelExporter`
 * resolves it once via `otel_metrics.resolveOtelMetrics(cfg)` and holds the
 * reference; every OTHER call site (`tracer.ts`, `agents.ts`) is BYTE-
 * IDENTICAL to before metrics existed. The v1 "dropped spans" resource
 * attribute hack is GONE (a `Resource` is immutable per-exporter-instance in
 * the real SDK — there is no home for a value that changes after
 * construction) — dropped-span/dropped-event counts now ride as real
 * Counters on the metrics pipeline instead, recorded once (same "once, on
 * the final flush" cadence the warn log already used), with the warn log
 * itself UNCHANGED as the fallback when metrics are off.
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
 * counted and reported once as a warn line (and once as a metric, when one is
 * configured — see METRICS FAN-OUT above). The size trigger schedules a timer
 * rather than flushing inline, which also means a synchronous burst of
 * thousands of events exercises the bound (see the queue test) instead of
 * interleaving sends.
 *
 * WIRE TRANSPORT is `@opentelemetry/exporter-trace-otlp-http`'s real
 * `OTLPTraceExporter`, JSON-encoded (its default) against the resolved
 * `/v1/traces` URL — see the VERIFIED WIRE-SHAPE DIFFERENCES note above for
 * exactly how its bytes differ from v1's hand-rolled ones.
 * `keepAlive: false` is passed explicitly: the real Node HTTP agent defaults
 * `keepAlive: true`, which would hold an open socket past this exporter's own
 * bounded `drain()` — the same "must never be the reason a `spf` process
 * lingers" requirement the unref'd flush timer already exists for.
 * `timeoutMillis: SEND_TIMEOUT_MS` bounds the exporter's own internal
 * retrying transport (up to 5 attempts, capped by this same deadline across
 * all of them — verified against `@opentelemetry/otlp-exporter-base`'s
 * `RetryingTransport` source) to the same budget the old hand-rolled
 * `AbortController` enforced.
 */

import { createHash } from "node:crypto";
import type { Attributes, HrTime, SpanContext } from "@opentelemetry/api";
import { SpanKind, TraceFlags } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import type { ReadableSpan, TimedEvent } from "@opentelemetry/sdk-trace";
import { applyOtelEnvSupplement, type AgentConfig, type EventRecord, type GateReport, type OTelConfig, type Phase, type SFConfig } from "./data_types.ts";
import { resolveOtelMetrics, type OtelMetrics } from "./otel_metrics.ts";

// ── tunables (see BACKPRESSURE above) ───────────────────────────────────────
const MAX_QUEUED_SPANS = 2048;
const BATCH_SPANS = 64;
const FLUSH_INTERVAL_MS = 2_000;
/** Per-request cap, and the default drain budget for `flushAll()`. */
const SEND_TIMEOUT_MS = 2_000;
/** Span events buffered per phase while it runs; a runaway phase cannot grow unbounded. */
const MAX_EVENTS_PER_SPAN = 64;

const STATUS_UNSET = 0;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

/** Only what this module ever produces — string/number/boolean, never an array or bytes. */
type Attrs = Record<string, string | number | boolean>;

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

/** ISO -> epoch milliseconds, with a fallback for unparseable/missing/pre-epoch input. Shared by `nanosFromIso` and the internal `HrTime` builder below. */
function resolveMs(iso: string | null | undefined, fallbackMs: number): number {
  const parsed = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackMs;
}

/** ISO-8601 -> uint64 nanoseconds AS A STRING. Unparseable, missing, or pre-epoch input falls back to `fallbackMs`. Kept as its own public, string-returning helper — pinned by tests since before the SDK swap. */
export function nanosFromIso(iso: string | null | undefined, fallbackMs: number = Date.now()): string {
  const ms = resolveMs(iso, fallbackMs);
  // String concat, not BigInt math: ms is an integer, and appending six zeros
  // is exact where `ms * 1e6` would drift into float territory.
  return `${Math.floor(ms)}000000`;
}

/** Same fallback logic as `nanosFromIso`, as the `[seconds, nanoseconds]` tuple `ReadableSpan.startTime`/`endTime` actually want. */
function hrTimeFromIso(iso: string | null | undefined, fallbackMs: number = Date.now()): HrTime {
  const ms = resolveMs(iso, fallbackMs);
  return [Math.floor(ms / 1000), Math.floor(ms % 1000) * 1_000_000];
}

/** Best-effort, informational only — never serialized to the wire (OTLP has no "duration" field; start/end carry it). */
function hrDuration(start: HrTime, end: HrTime): HrTime {
  let sec = end[0] - start[0];
  let nano = end[1] - start[1];
  if (nano < 0) {
    sec -= 1;
    nano += 1_000_000_000;
  }
  return sec < 0 ? [0, 0] : [sec, nano];
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

/**
 * UsageBreakdown's token fields -> attribute suffixes. Numbers only, by
 * construction. `billable_tokens` rides alongside `total_tokens` — the SAME
 * split `run_dashboard.tsx`'s live spend line and `estimate.ts`'s cutoff
 * projection now both carry (see `UsageBreakdown.billable_tokens`'s doc
 * comment in `data_types.ts`) — so a Langfuse/OTEL consumer graphing spend
 * against `defaults.max_run_tokens` has the metric the real ceiling check
 * actually uses, not just the display total (cache reads included).
 */
const TOKEN_FIELDS: Array<[string, string]> = [
  ["input_tokens", "spf.tokens.input"],
  ["output_tokens", "spf.tokens.output"],
  ["cache_read_tokens", "spf.tokens.cache_read"],
  ["cache_write_tokens", "spf.tokens.cache_write"],
  ["reasoning_tokens", "spf.tokens.reasoning"],
  ["total_tokens", "spf.tokens.total"],
  ["billable_tokens", "spf.tokens.billable"],
];
const COST_FIELDS: Array<[string, string]> = [
  ["input_cost", "spf.cost.input"],
  ["output_cost", "spf.cost.output"],
  ["cache_read_cost", "spf.cost.cache_read"],
  ["cache_write_cost", "spf.cost.cache_write"],
  ["total_cost", "spf.cost.total"],
];

/**
 * `spf.lora_adapter` — the served LoRA adapter name for this agent's model,
 * when one can be determined. Checked in order, first match wins:
 *   1. `agent.lora_adapter` (explicit config) — set once per agent, the
 *      unambiguous source of truth an operator can always fall back to.
 *   2. `provider/base:adapter` — an explicit adapter suffix after the LAST
 *      ":" in the model id (e.g. `vllm/nemotron-base:my-lora` -> `my-lora`).
 *   3. `provider/adapter-name` — no ":" in the model id, but the id itself
 *      contains "-lora-" (case-insensitive) — this org's own vLLM/Switchyard
 *      served-model naming convention (`k8s/manifests/switchyard/
 *      configmap-routes.yaml`: "id MUST equal the name= half of the matching
 *      --lora-modules entry", e.g. `nemotron-lora-placeholder`) — the WHOLE
 *      model id (minus the `provider/` prefix) IS the adapter name in this
 *      convention, since vLLM resolves LoRA adapters by served-model name,
 *      not by a base-model-plus-suffix split.
 * No match on any of the three -> `null`, and the attribute is omitted
 * entirely — never a blind copy of a non-LoRA model id.
 */
export function loraAdapterFor(agent: { model: string; lora_adapter?: string | null }): string | null {
  if (agent.lora_adapter) return clip(agent.lora_adapter);
  const model = agent.model ?? "";
  const slash = model.indexOf("/");
  const modelId = slash === -1 ? model : model.slice(slash + 1);
  const colon = modelId.lastIndexOf(":");
  if (colon !== -1 && colon < modelId.length - 1) return clip(modelId.slice(colon + 1));
  return /-lora-/i.test(modelId) ? clip(modelId) : null;
}

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
  /** The process-scoped metrics handle (see `otel_metrics.ts`), or `null` when metrics are off/unconfigured. Injectable for tests. */
  metrics?: OtelMetrics | null;
}

interface OpenAgentCall {
  spanId: string;
  startTime: HrTime;
}

export class OtelExporter {
  private readonly cfg: OTelConfig;
  private readonly adwId: string;
  private readonly chainName: string;
  private readonly serviceName: string;
  private readonly url: string;
  private readonly log: (message: string) => void;
  private readonly metrics: OtelMetrics | null;

  private readonly traceId: string;
  /** "" unless an inbound traceparent parented this run — see INBOUND TRACEPARENT. */
  private readonly rootParentSpanId: string;
  private readonly rootSpanId: string;

  private readonly resource: Resource;
  private readonly scope = { name: "spf", version: "1" };
  private readonly spanExporter: OTLPTraceExporter;

  private queue: ReadableSpan[] = [];
  private dropped = 0;
  private droppedEvents = 0;
  private warnedDrops = false;
  private loggedFailure = false;

  private timer: NodeJS.Timeout | null = null;
  private timerDelay = Number.POSITIVE_INFINITY;
  private pending = new Set<Promise<void>>();

  /** Span events buffered until their phase span exists. Key "" = the root run span. */
  private bufferedEvents = new Map<string, TimedEvent[]>();
  /**
   * Phases whose span has already gone out. Events DO arrive after a phase
   * span is emitted — `run.finish()`'s `not_accepted` error names the last
   * phase — and a span already on the wire cannot grow an event, so those are
   * re-homed onto the root run span instead of accumulating in a buffer that
   * nothing will ever drain.
   */
  private emittedPhases = new Set<string>();
  /** `<phase_id> <agent>` -> the open agent call, for closing it and parenting tool spans. */
  private openAgents = new Map<string, OpenAgentCall>();
  /** How many times an agent has been called in a phase, so a retry gets its own span id. */
  private agentCalls = new Map<string, number>();
  /** agent name -> config metadata, from `recordAgentSession` (typed config, never a payload). */
  private agentMeta = new Map<string, { model: string; codingAgent: string; loraAdapter: string | null }>();

  private runStartedAtMs = Date.now();
  private rootEmitted = false;

  constructor(init: OtelExporterInit) {
    this.cfg = init.cfg;
    this.adwId = init.adwId;
    this.chainName = init.chainName;
    this.serviceName = init.cfg.service_name || "spf";
    this.url = resolveTracesUrl(init.cfg.endpoint);
    this.log = init.log ?? ((m: string) => console.error(m));
    this.metrics = init.metrics ?? null;

    const inbound = inboundTraceparent(init.env ?? process.env);
    this.traceId = inbound ? inbound.traceId : traceIdFor(init.adwId);
    this.rootParentSpanId = inbound ? inbound.spanId : "";
    this.rootSpanId = spanIdFor(`run:${init.adwId}`);

    this.resource = resourceFromAttributes({
      "service.name": this.serviceName,
      "spf.adw_id": this.adwId,
      "spf.chain": this.chainName,
    });
    this.spanExporter = new OTLPTraceExporter({
      url: this.url,
      headers: init.cfg.headers,
      timeoutMillis: SEND_TIMEOUT_MS,
      // The Node HTTP agent defaults `keepAlive: true`, which would hold a
      // socket open past this exporter's own bounded drain() — see the
      // module header's WIRE TRANSPORT note.
      keepAlive: false,
    });
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
          time: hrTimeFromIso(record.started_at ?? tsIso),
          name: record.type,
          // `record.name` is code- or config-declared (a phase name, a gate
          // name, "paths_touched"), never agent output — unlike payload.
          attributes: { "spf.event.type": record.type, "spf.event.name": clip(record.name) },
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
    const attributes: Attrs = {
      "spf.adw_id": this.adwId,
      "spf.chain": this.chainName,
      "spf.phase.name": clip(phase.params.name),
      "spf.phase.kind": clip(phase.params.kind),
      "spf.phase.owner": clip(phase.params.owner),
      "spf.phase.status": clip(phase.status),
      "spf.phase.seq": Math.trunc(phase.seq),
      "spf.phase.attempt": Math.trunc(phase.attempt),
    };
    const start = hrTimeFromIso(phase.started_at, this.runStartedAtMs);
    const end = hrTimeFromIso(phase.ended_at);
    this.enqueue(
      this.makeSpan({
        spanId,
        parentSpanId: this.rootSpanId,
        name: `phase ${phase.params.name}`,
        start,
        end,
        attributes,
        // `phase.error` is deliberately absent: agent- and repo-derived text.
        // The ERROR status is the whole signal a backend gets.
        statusCode: phase.status === "success" ? STATUS_OK : STATUS_ERROR,
        events: this.takeBufferedEvents(phase.phase_id),
      }),
    );
    const durationSeconds = (end[0] + end[1] / 1e9) - (start[0] + start[1] / 1e9);
    this.metrics?.recordPhaseDuration(Math.max(0, durationSeconds), {
      kind: phase.params.kind,
      owner: phase.params.owner,
      status: phase.status,
    });
  }

  /**
   * `tracer.gateRow` — the verdict and its SIZE, never its content. A
   * violation string quotes the agent's own claim and the repo's files; only
   * the count crosses the wire.
   */
  recordGate(phase: Phase, gate: string, report: GateReport, attempt: number): void {
    this.bufferSpanEvent(phase.phase_id, {
      time: hrTimeFromIso(null),
      name: report.passed ? "gate_pass" : "gate_fail",
      attributes: {
        "spf.gate.name": clip(gate),
        "spf.gate.passed": report.passed,
        "spf.gate.violation_count": Math.trunc(report.violations.length),
        "spf.gate.attempt": Math.trunc(attempt),
      },
    });
    this.metrics?.recordGateResult(clip(gate), report.passed);
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
    this.agentMeta.set(agent.name, {
      model: agent.model,
      codingAgent: agent.coding_agent,
      loraAdapter: loraAdapterFor(agent),
    });
  }

  /**
   * `tracer.sessionFinish` — emits the root run span exactly once. Called
   * twice on some paths (a failing phase finalizes, then `finish()` does), and
   * the guard is why that is harmless.
   */
  recordSessionFinish(ok: boolean): void {
    this.emitRootSpan(ok ? "success" : "fail", ok ? STATUS_OK : STATUS_ERROR);
  }

  // ── outbound propagation seam (new in v2 — see the header) ───────────────

  /**
   * The currently-open agent call's trace context — `null` when otel has no
   * agent call open for this phase+agent pair right now (agent_start hasn't
   * fired, or already closed). `agents.ts`'s `send()` reads this into
   * `AgentRequest.otel`; a `null` here just means that field stays unset, a
   * plain no-op for every backend that doesn't propagate it.
   */
  agentCallTraceContext(phaseId: string, agentName: string): { traceparent: string; spanId: string } | null {
    const open = this.openAgents.get(this.agentKey(phaseId, agentName));
    if (!open) return null;
    return { traceparent: `00-${this.traceId}-${open.spanId}-01`, spanId: open.spanId };
  }

  // ── queue + batching ────────────────────────────────────────────────────

  /** Queued spans and spans/events dropped so far. For tests and diagnostics. */
  stats(): { queued: number; dropped: number; droppedEvents: number } {
    return { queued: this.queue.length, dropped: this.dropped, droppedEvents: this.droppedEvents };
  }

  /**
   * The exact JSON body the next flush would POST, without sending or
   * draining — via the SAME `JsonTraceSerializer` the real exporter uses
   * internally, so this is not a second, possibly-diverging encoding path.
   * This is the seam `src/test/otel.test.ts` uses to prove the allowlist
   * holds — the assertion is on the literal bytes, so any future attribute
   * that leaks a payload fails a test rather than a review.
   */
  pendingJson(): string {
    const bytes = JsonTraceSerializer.serializeRequest(this.queue);
    return bytes ? Buffer.from(bytes).toString("utf-8") : "{}";
  }

  private enqueue(span: ReadableSpan): void {
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
   * an observability feature that can fail a run. `OTLPTraceExporter.export()`
   * itself already never throws and always calls its callback exactly once
   * (verified against `@opentelemetry/otlp-exporter-base`'s
   * `OTLPExportDelegate.export()` source) — the try/catch here is belt-and-
   * braces for that contract, not a load-bearing guard.
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

    if (isFinal && this.dropped > 0 && !this.warnedDrops) {
      this.warnedDrops = true;
      this.log(`spf: otel export dropped ${this.dropped} span(s) — the queue bound (${MAX_QUEUED_SPANS}) was hit`);
      this.metrics?.recordDroppedSpans(this.dropped);
      if (this.droppedEvents > 0) this.metrics?.recordDroppedSpanEvents(this.droppedEvents);
    }

    try {
      await new Promise<void>((resolve) => {
        this.spanExporter.export(spans, (result) => {
          if (result.code !== ExportResultCode.SUCCESS) {
            this.logFailureOnce(result.error?.message ?? String(result.error ?? "export failed"));
          }
          resolve();
        });
      });
    } catch (error) {
      this.logFailureOnce((error as Error)?.message ?? String(error));
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

  private makeSpan(opts: {
    spanId: string;
    parentSpanId: string;
    parentIsRemote?: boolean;
    name: string;
    start: HrTime;
    end: HrTime;
    attributes: Attrs;
    statusCode: number;
    events: TimedEvent[];
  }): ReadableSpan {
    const spanContext: SpanContext = { traceId: this.traceId, spanId: opts.spanId, traceFlags: TraceFlags.SAMPLED };
    const parentSpanContext: SpanContext | undefined = opts.parentSpanId
      ? { traceId: this.traceId, spanId: opts.parentSpanId, traceFlags: TraceFlags.SAMPLED, isRemote: opts.parentIsRemote ?? false }
      : undefined;
    return {
      name: opts.name,
      kind: SpanKind.INTERNAL,
      spanContext: () => spanContext,
      parentSpanContext,
      startTime: opts.start,
      endTime: opts.end,
      status: { code: opts.statusCode },
      attributes: opts.attributes as Attributes,
      links: [],
      events: opts.events,
      duration: hrDuration(opts.start, opts.end),
      ended: true,
      resource: this.resource,
      instrumentationScope: this.scope,
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };
  }

  private emitRootSpan(status: string, code: number): void {
    if (this.rootEmitted) return;
    this.rootEmitted = true;
    const now = hrTimeFromIso(null);
    this.enqueue(
      this.makeSpan({
        spanId: this.rootSpanId,
        parentSpanId: this.rootParentSpanId,
        parentIsRemote: true, // the only possible parent here is an INBOUND traceparent — always a remote context
        name: `spf run ${this.chainName}`,
        start: hrTimeFromIso(null, this.runStartedAtMs),
        end: now,
        attributes: { "spf.adw_id": this.adwId, "spf.chain": this.chainName, "spf.run.status": status },
        statusCode: code,
        events: this.takeBufferedEvents(""),
      }),
    );
  }

  private agentKey(phaseId: string, agentName: string): string {
    return `${phaseId} ${agentName}`;
  }

  private openAgentCall(phaseId: string, agentName: string, tsIso: string): void {
    const key = this.agentKey(phaseId, agentName);
    const n = (this.agentCalls.get(key) ?? 0) + 1;
    this.agentCalls.set(key, n);
    this.openAgents.set(key, {
      spanId: spanIdFor(`agent:${phaseId}:${agentName}:${n}`),
      startTime: hrTimeFromIso(tsIso),
    });
  }

  private closeAgentCall(record: EventRecord, tsIso: string): void {
    const key = this.agentKey(record.phase_id, record.name);
    const open = this.openAgents.get(key);
    this.openAgents.delete(key);
    const meta = this.agentMeta.get(record.name);
    const attributes: Attrs = {
      "spf.adw_id": this.adwId,
      "spf.agent.name": clip(record.name),
    };
    if (meta) {
      attributes["spf.agent.model"] = clip(meta.model);
      attributes["spf.agent.coding_agent"] = clip(meta.codingAgent);
      // gen_ai.* is the OTel semantic convention a GenAI-aware backend groups
      // by; the spf.* twins stay because they are what SPF's own queries use.
      attributes["gen_ai.request.model"] = clip(meta.model);
      if (meta.loraAdapter) attributes["spf.lora_adapter"] = meta.loraAdapter;
    }

    // NUMBERS ONLY out of payload — see the ATTRIBUTE ALLOWLIST note on
    // `numOrNull`. A string under any of these keys is dropped, not exported.
    const usage = record.payload?.["usage"];
    const usageObj = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : {};
    for (const [field, key2] of TOKEN_FIELDS) {
      const value = numOrNull(usageObj[field]);
      if (value !== null) attributes[key2] = Math.trunc(value);
    }
    for (const [field, key2] of COST_FIELDS) {
      const value = numOrNull(usageObj[field]);
      if (value !== null) attributes[key2] = value;
    }
    const totalTokens = numOrNull(record.tokens);
    if (totalTokens !== null) attributes["spf.tokens.total"] = Math.trunc(totalTokens);
    const inputTokens = numOrNull(usageObj["input_tokens"]);
    if (inputTokens !== null) attributes["gen_ai.usage.input_tokens"] = Math.trunc(inputTokens);
    const outputTokens = numOrNull(usageObj["output_tokens"]);
    if (outputTokens !== null) attributes["gen_ai.usage.output_tokens"] = Math.trunc(outputTokens);
    // Semantic-convention twin of spf.tokens.cache_read — the vLLM/OpenAI-
    // compatible `usage.prompt_tokens_details.cached_tokens` shape, already
    // normalized into `cache_read_tokens` upstream (pi-ai's openai-completions
    // adapter -> UsageBreakdown.add_turn -> this event's payload.usage) by
    // the time it reaches this module; nothing new to read here beyond one
    // more attribute name for the same already-present number.
    const cacheReadTokens = numOrNull(usageObj["cache_read_tokens"]);
    if (cacheReadTokens !== null) attributes["gen_ai.usage.cache_read.input_tokens"] = Math.trunc(cacheReadTokens);
    const cost = numOrNull(record.payload?.["cost"]);
    if (cost !== null) attributes["spf.cost.total"] = cost;

    const start = open?.startTime ?? hrTimeFromIso(tsIso);
    const end = hrTimeFromIso(tsIso);
    this.enqueue(
      this.makeSpan({
        spanId: open?.spanId ?? spanIdFor(`agent:${record.phase_id}:${record.name}:orphan`),
        parentSpanId: record.phase_id ? spanIdFor(record.phase_id) : this.rootSpanId,
        name: `agent ${record.name}`,
        start,
        end,
        attributes,
        statusCode: STATUS_UNSET, // the phase span carries the verdict
        events: [],
      }),
    );

    if (meta) {
      this.metrics?.recordAgentCall({ agent: record.name, model: meta.model, codingAgent: meta.codingAgent });
      for (const [field, kind] of [
        ["input_tokens", "input"],
        ["output_tokens", "output"],
        ["cache_read_tokens", "cache_read"],
        ["cache_write_tokens", "cache_write"],
      ] as const) {
        const value = numOrNull(usageObj[field]);
        if (value !== null && value !== 0) this.metrics?.recordTokens(kind, value, { agent: record.name, model: meta.model });
      }
      if (cost !== null && cost !== 0) this.metrics?.recordCost(cost, { agent: record.name, model: meta.model });
    }
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
    this.enqueue(
      this.makeSpan({
        spanId: spanIdFor(`tool:${record.phase_id}:${eventId}`),
        parentSpanId: parent,
        name: toolSpanName(record.name),
        start: hrTimeFromIso(record.started_at ?? tsIso),
        end: hrTimeFromIso(record.ended_at ?? tsIso),
        attributes: { "spf.adw_id": this.adwId, "spf.event.type": record.type },
        statusCode: STATUS_UNSET,
        events: [],
      }),
    );
  }

  private bufferSpanEvent(phaseId: string, event: TimedEvent): void {
    const key = phaseId && !this.emittedPhases.has(phaseId) ? phaseId : "";
    const list = this.bufferedEvents.get(key) ?? [];
    if (list.length >= MAX_EVENTS_PER_SPAN) {
      this.droppedEvents += 1;
      return;
    }
    list.push(event);
    this.bufferedEvents.set(key, list);
  }

  private takeBufferedEvents(phaseId: string): TimedEvent[] {
    const events = this.bufferedEvents.get(phaseId) ?? [];
    this.bufferedEvents.delete(phaseId);
    return events;
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
 * Also resolves (once per process — see `otel_metrics.ts`'s own singleton
 * guard) the shared, PROCESS-scoped `OtelMetrics` handle and holds a
 * reference on the exporter, so `recordPhase`/`recordGate`/`closeAgentCall`
 * can fan out to it without any OTHER call site (`tracer.ts`, `agents.ts`)
 * needing to know metrics exist at all.
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
  const rawOtel = cfg.observability.otel;
  if (!rawOtel || !rawOtel.endpoint) return null;
  // `allow_env`'s narrow supplement — see `data_types.ts`'s
  // `applyOtelEnvSupplement`: a no-op unless the block above is ALREADY
  // active (it is, we just checked `endpoint`) AND `allow_env: true`.
  const otel = applyOtelEnvSupplement(rawOtel, opts.env ?? process.env);
  const exporter = new OtelExporter({
    cfg: otel,
    adwId: opts.adwId,
    chainName: opts.chainName,
    log: opts.log,
    env: opts.env,
    metrics: resolveOtelMetrics(cfg),
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
