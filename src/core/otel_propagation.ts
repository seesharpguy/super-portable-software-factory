/**
 * Outbound trace-context propagation for `coding_agent: flue` — the
 * "best-effort" half of the two propagation paths this repo's OTel spike
 * documented (`claude_code` gets `agent_cc.ts`'s single `spawn()` choke
 * point instead; see that module).
 *
 * `@flue/opentelemetry`'s own docs (fetched at
 * https://flueframework.com/docs/ecosystem/tooling/opentelemetry/, cited in
 * this repo's phase0 spike) are explicit that `dispatch()` "does not
 * propagate trace context currently" and that "custom header propagation to
 * model providers is not documented" — so the literal ask ("propagate via
 * @flue/opentelemetry") is not fully satisfiable by that package alone. What
 * IS real and verifiable: `@opentelemetry/instrumentation-http` and
 * `-undici` create a real client span (with a real, non-noop SpanContext)
 * around every outbound `http`/`https`/`fetch`(undici) call made from this
 * process, and the OTel API's global propagator is what those
 * instrumentations use to inject `traceparent` (and, here, `x-request-id`)
 * into that call's headers — REGARDLESS of which provider SDK issued it.
 * This reaches every provider whose Node SDK issues requests through
 * Node's own `http`/`https` modules or `undici` (verified: `fetch()`,
 * `https.request()`). It does NOT reach a provider transport that bypasses
 * both (unverified in this repo for the Anthropic/Google/Mistral SDKs'
 * internal transports specifically — flagged, not assumed, per the spike).
 *
 * WHY A REAL GLOBAL TracerProvider IS REQUIRED, NOT OPTIONAL: the
 * W3CTraceContextPropagator's `inject()` silently skips writing a
 * `traceparent` header when the active SpanContext is INVALID
 * (`isSpanContextValid()` false) — which is exactly what every span is when
 * no global TracerProvider has ever been registered (the API's default is a
 * no-op tracer). So this module registers a real (if minimal)
 * `BasicTracerProvider` — with its own `BatchSpanProcessor` ->
 * `OTLPTraceExporter` aimed at the SAME collector `observability.otel.
 * endpoint` names — alongside the propagator and the two instrumentations.
 * This also happens to be exactly what `@flue/opentelemetry`'s own docs ask
 * for ("Configure the SDK first, then register one instrumentation
 * instance") — Flue's own spans (`invoke_agent`, `chat <model>`,
 * `execute_tool`) now have somewhere real to go, which they did not before.
 *
 * FLUE SPANS JOIN SPF's DETERMINISTIC TRACE (v3; issue #80). The naive
 * approach — extracting SPF's agent-call traceparent into the active
 * context around `dispatch()` — was tried and REJECTED by design review:
 * flue's node runtime executes submissions in ONE process-lifetime claim
 * loop (`builtin-providers ... claimLoop()`, started by the first
 * dispatch's `finally`), whose async context is captured once at loop
 * creation. A dispatch-time context wrap therefore joins only the FIRST
 * flue agent in a process and silently MIS-ATTRIBUTES every later agent's
 * spans into the first agent's trace — worse than a separate trace.
 *
 * The mechanism below instead uses the instrumentation's own
 * `resolveRootContext(event, ctx)` option (typed in
 * `@flue/opentelemetry`'s public d.mts; verified in its dist: consulted
 * per span exactly when a span has neither an explicit parent nor an
 * active-context SpanContext — i.e. per span, per submission, no matter
 * what context the claim loop was captured in). SPF keeps a small
 * instance-id -> traceparent map (`registerFlueSessionTrace`, populated by
 * `agent_flue.ts`'s `run()` around each agent call), and the resolver
 * matches on `ctx.id` — flue's documented "stable agent instance id during
 * agent processing", which is the id SPF mints and hands to
 * `init(SfAgent, { id })`. Extraction goes through the globally
 * registered propagator against ROOT_CONTEXT, so no leaked loop context
 * can stick. Consequences, all intended:
 *   - Flue's spans inherit SPF's sha256 trace id, parented under the
 *     right agent-call span PER SESSION — correct under multiple agents
 *     per process, concurrent agents, and claim-loop restarts alike. Span
 *     ids are SDK-random; only the trace id is shared.
 *   - The http/undici client spans' injected `traceparent` carries the
 *     deterministic id too, so Switchyard/vLLM hops land as descendants of
 *     SPF's trace — parity with `claude_code`'s `ANTHROPIC_CUSTOM_HEADERS`
 *     path. `x-request-id` stays the this-span id for request-keyed
 *     correlation, unchanged.
 *   - Unmapped sessions (never registered, restarted process with a
 *     durable backlog, post-`unregister` straggler bookkeeping spans)
 *     resolve to an unparented root — flue's spans root a separate SDK
 *     trace exactly as v1 did, correlatable by `x-request-id`/`spf.adw_id`/
 *     time window. Degraded join, never an error and never MIS-attributed.
 *   - flue's internal `executionContext.traceCarrier` (typed but not on
 *     the public `AgentDispatchRequest` surface) stays unused — noted here
 *     as flue's own escape hatch, not something SPF reaches into.
 *
 * REGISTRATION TIMING. `installFluePropagation()` is called from
 * `agent_flue.ts`'s `run()`, before `ensureRuntime()`/dispatch — i.e. before
 * the actual outbound call, which is the only ordering that matters for
 * `instrumentation-undici` (subscribes to `undici`'s own `diagnostics_channel`
 * events; any registration before the request fires is picked up regardless
 * of when `undici`/`fetch` was first imported) and, in practice, for
 * `instrumentation-http` too (Node's `http`/`https` modules are shared,
 * monkey-patchable singletons; a later `require("http")` elsewhere in the
 * process still resolves to the SAME, already-patched module object). This
 * is a real, load-bearing difference from a truly cold, "before ANY other
 * import" registration (which would require moving this into `cli/bin.ts`,
 * ahead of that file's own deliberately-static-import-free module graph) —
 * documented as the honest scope of what's verified, not claimed as more.
 *
 * NO-OP WHEN UNCONFIGURED. Gated on the exact same `observability.otel.
 * endpoint` presence check as `otel.ts` and `otel_metrics.ts` — no ambient
 * `OTEL_*` env var activates any of this on its own. Idempotent: registers
 * exactly once per process, on whichever call (across however many `flue`
 * agent dispatches this process makes) happens to arrive first.
 */

import { defaultTextMapGetter, propagation, ROOT_CONTEXT, trace as traceApi, context as contextApi, isSpanContextValid, type Context, type TextMapPropagator, type TextMapSetter } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { CompositePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createOpenTelemetryInstrumentation } from "@flue/opentelemetry";
import { instrument } from "@flue/runtime";
import { resolveTracesUrl } from "./otel.ts";

/** The one custom propagation field this repo adds beyond the standard W3C `traceparent`: the current span's own id, for a collector/log pipeline that correlates by request rather than by trace. */
export const X_REQUEST_ID_HEADER = "x-request-id";

/**
 * Injects `x-request-id` from whatever span is active at the point of the
 * outbound call — the same id that would appear as that span's `spanId` on
 * the (separate — see the module header) Flue-side trace. One-directional:
 * `extract()` is a pass-through, since nothing on the INBOUND side of an
 * outbound provider call needs to read this back.
 */
export class XRequestIdPropagator implements TextMapPropagator {
  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    const spanContext = traceApi.getSpanContext(ctx);
    if (!spanContext || !isSpanContextValid(spanContext)) return;
    setter.set(carrier, X_REQUEST_ID_HEADER, spanContext.spanId);
  }
  extract(ctx: Context): Context {
    return ctx;
  }
  fields(): string[] {
    return [X_REQUEST_ID_HEADER];
  }
}

/**
 * Instance-id -> agent-call traceparent registrations backing
 * `resolveFlueRootContext` — see the module header for the full mechanism
 * and WHY this is a map consulted per span rather than a dispatch-time
 * context wrap (flue's single claim loop makes the latter mis-attribute
 * every agent after the first). One entry per in-flight `agent_flue.run()`
 * call.
 */
const flueSessionTraces = new Map<string, string>();

/**
 * Registers `traceparent` (SPF's deterministic agent-call span, as a W3C
 * carrier string) as the trace root for flue spans belonging to `sessionId`
 * — flue's instance id, minted by SPF and handed to `init(SfAgent, { id })`.
 * Overwrites a prior registration for the same id (a same-phase retry is
 * the same logical call; the current call wins).
 */
export function registerFlueSessionTrace(sessionId: string, traceparent: string): void {
  flueSessionTraces.set(sessionId, traceparent);
}

/**
 * Idempotent — called from `run()`'s `finally`. Post-settlement bookkeeping
 * spans flue mints after this point simply resolve to an unparented root
 * (separate trace), which is preferable to leaking a registration whose id
 * a REUSED session id could collide with on a later phase.
 */
export function unregisterFlueSessionTrace(sessionId: string): void {
  flueSessionTraces.delete(sessionId);
}

/**
 * The `resolveRootContext` implementation handed to
 * `createOpenTelemetryInstrumentation` — consulted per root-span creation
 * (see the module header). Matches on `ctx.id` (flue's documented stable
 * agent instance id during processing) and returns SPF's agent-call span
 * as an extracted REMOTE parent, pulled from ROOT_CONTEXT so no ambient
 * claim-loop context can leak in. Returns `undefined` (flue mints an
 * unparented root span of its own) for an unmapped session id, a malformed
 * traceparent, an absent ctx — and, with no global propagator installed,
 * for everything. Exported for tests.
 */
export function resolveFlueRootContext(
  _event: unknown,
  ctx: { id?: string } | undefined,
): Context | undefined {
  const traceparent = ctx?.id ? flueSessionTraces.get(ctx.id) : undefined;
  if (!traceparent) return undefined;
  const extracted = propagation.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter);
  const spanContext = traceApi.getSpanContext(extracted);
  return spanContext && isSpanContextValid(spanContext) ? extracted : undefined;
}

export interface FluePropagationConfig {
  endpoint: string;
  headers?: Record<string, string>;
  service_name: string;
}

let installed = false;
let flueInstrumented = false;

/**
 * Idempotent: the first call in this process wins; every later call
 * (another `flue` agent dispatch, possibly with a different `cfg`) is a
 * silent no-op, matching the "process-scoped, created exactly once" rule
 * `otel_metrics.ts` documents for the same reason (`spf watch`'s daemon
 * loop). Never throws — a failure to install best-effort propagation must
 * never fail an agent dispatch.
 */
export function installFluePropagation(cfg: FluePropagationConfig | undefined | null, log: (message: string) => void = (m) => console.error(m)): void {
  if (!cfg || !cfg.endpoint) return;
  try {
    if (!installed) {
      const provider = new BasicTracerProvider({
        spanProcessors: [
          new BatchSpanProcessor(
            new OTLPTraceExporter({ url: resolveTracesUrl(cfg.endpoint), headers: cfg.headers, keepAlive: false }),
          ),
        ],
      });
      traceApi.setGlobalTracerProvider(provider);
      contextApi.setGlobalContextManager(new AsyncHooksContextManager().enable());
      propagation.setGlobalPropagator(new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new XRequestIdPropagator()] }));
      registerInstrumentations({ instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()] });
      // Set AFTER the fallible registrations above: on a construction-time
      // throw, the next call must be free to retry — latching `installed`
      // first would permanently disable the process with one stderr line,
      // and flue's instrumentation (created at most once below) would
      // capture the no-op tracer as its provider.
      installed = true;
    }
    if (!flueInstrumented) {
      flueInstrumented = true;
      instrument(createOpenTelemetryInstrumentation({ content: false, resolveRootContext: resolveFlueRootContext }));
    }
  } catch (error) {
    log(`spf: otel flue propagation setup failed (${(error as Error)?.message ?? String(error)}) — provider calls will not carry a traceparent; runs are unaffected`);
  }
}

/** Tests only: forget global installation state. Does NOT undo `setGlobalTracerProvider`/`registerInstrumentations` (the OTel API has no supported "un-register" — tests that need isolation run in a fresh process). */
export function resetFluePropagationForTest(): void {
  installed = false;
  flueInstrumented = false;
}
