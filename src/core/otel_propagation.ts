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
 * instrumentations use to inject `traceparent` (and, here, the gateway's own
 * `x-correlation-id`/`x-spf-agent` — see GatewayHeadersPropagator below;
 * NEVER `x-request-id`, which Envoy/Switchyard own end-to-end and which a
 * client-sent value would corrupt) into that call's headers — REGARDLESS of
 * which provider SDK issued it.
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
 * can stick.
 *
 * BLOCKER 1 (fixed) — `resolveRootContext`'s return value NEVER becomes the
 * active context. Verified against `@flue/opentelemetry`'s own dist
 * (index.mjs:361 for the `chat <model>` span, :329 for the interceptor that
 * activates it): the resolved `Context` is passed to `tracer.startSpan(...)`
 * ONLY as `parentContext` — it supplies the new span's trace id/parent span
 * id and is then discarded. What actually gets activated around the real
 * dispatch is `context.with(trace.setSpan(context.active(), span), next)` —
 * a context built from `context.active()` (whatever was active before,
 * almost always ROOT) plus the freshly minted `span`, NOT the resolved
 * context itself. A prior version of this module stashed the session's
 * `adw_id`/`agent_name` as a plain context VALUE on the context
 * `resolveFlueRootContext` returned (keyed under a private context key) and
 * had `GatewayHeadersPropagator` read that value back at inject time — which
 * can never work, because that exact context object is never the one made
 * active; only its SpanContext (traceId/spanId/flags) survives, carried by
 * the new span. Confirmed live: `scratchpad/probe_installed_real.mjs`,
 * reproducing flue's exact two-line sequence against a real pi-ai dispatch,
 * printed `x-correlation-id: ABSENT` / `x-spf-agent: ABSENT` before this fix.
 *
 * THE FIX: key the registration by TRACE ID instead of by context identity.
 * `registerFlueSessionTrace` now ALSO records, in `traceIdRegistrations`,
 * the trace id parsed out of the very `traceparent` it's given — the same
 * deterministic trace id `resolveFlueRootContext` extracts and hands to
 * `tracer.startSpan` as that span's parent, so the span it creates carries
 * that exact trace id forward into whatever context DOES get activated.
 * `GatewayHeadersPropagator.inject()` below reads `trace.getSpanContext(ctx)
 * ?.traceId` — the thing that provably survives into the active context at
 * request time — and looks IT UP in `traceIdRegistrations`, rather than
 * trying to read a value off a context object that was never activated.
 * One deterministic trace id per adw_id (`otel.ts:556`'s `traceIdFor(adwId)`,
 * reused for EVERY agent call in that run — `otel.ts:737`'s
 * `agentCallTraceContext` varies only the span id, never the trace id), and
 * `traceIdRegistrations` is keyed on that trace id alone, not on session id
 * or span id. So "latest registration for this trace id wins" is exact
 * within a run when its agents run one at a time — which is how a `fanout`
 * attempt's own agents run: `fanout.ts:448` derives each attempt its OWN
 * adw_id, so distinct fanout attempts get distinct trace ids and cannot
 * collide here, regardless of `fanout`'s concurrency. The one real collision
 * this map can still see is narrower and does not happen in SPF today: TWO
 * AGENTS OVERLAPPING INSIDE ONE adw_id — a single run dispatching a second
 * flue agent call before the first one's `unregisterFlueSessionTrace` has
 * run — since both share that run's one trace id, the second
 * `registerFlueSessionTrace` call overwrites the first agent's entry in
 * `traceIdRegistrations` while its dispatch may still be in flight, and that
 * agent's outbound request would then carry the OTHER agent's
 * `x-correlation-id`/`x-spf-agent` (never a wrong `adw_id`, since both
 * belong to the same run — only the wrong `agentName`). No chain SPF ships
 * dispatches two agents concurrently within one adw_id; this is flagged as
 * the mechanism's honest limit, not a bug being carried forward. The SAME
 * registration carries this session's `adw_id`/agent name (see
 * `FlueSessionRegistration`) so a
 * session's `x-correlation-id`/`x-spf-agent` ride the exact same "resolved
 * once per submission, read per real HTTP call" path as `traceparent` does,
 * via `GatewayHeadersPropagator` below, instead of the static-per-model-id
 * fallback `ollama_provider.ts` needs when this pipeline isn't installed at
 * all (otel unconfigured). Consequences, all intended:
 *   - Flue's spans inherit SPF's sha256 trace id, parented under the
 *     right agent-call span PER SESSION — correct under multiple agents
 *     per process, concurrent agents, and claim-loop restarts alike. Span
 *     ids are SDK-random; only the trace id is shared.
 *   - The http/undici client spans' injected `traceparent` carries the
 *     deterministic id too, so Switchyard/vLLM hops land as descendants of
 *     SPF's trace — parity with `claude_code`'s `ANTHROPIC_CUSTOM_HEADERS`
 *     path. The same per-request injection point also carries THIS
 *     session's `x-correlation-id`/`x-spf-agent`, correctly attributed even
 *     when multiple sessions are concurrent in one process, AS LONG AS their
 *     deterministic trace ids differ (their `ctx.id`s, and therefore their
 *     registrations, are distinct) — see BLOCKER 1 above for the precise
 *     lookup key.
 *   - Unmapped sessions (never registered, restarted process with a
 *     durable backlog, post-`unregister` straggler bookkeeping spans)
 *     resolve to an unparented root — flue's spans root a separate SDK
 *     trace exactly as v1 did, correlatable by `spf.adw_id`/time window.
 *     Degraded join, never an error and never MIS-attributed; the gateway
 *     headers for exactly this case are simply ABSENT (no fallback identity
 *     — see `GatewayHeadersPropagator.inject()` below) rather than guessing
 *     at whichever session happened to register most recently.
 *   - flue's internal `executionContext.traceCarrier` (typed but not on
 *     the public `AgentDispatchRequest` surface) stays unused — noted here
 *     as flue's own escape hatch, not something SPF reaches into.
 *
 * STATIC HEADERS STAY SUPPRESSED WHEN INSTALLED (BLOCKER 1's other half,
 * decided AGAINST enabling): `ollama_provider.ts`'s `modelFor()` keeps
 * omitting `Model.headers`' `x-correlation-id`/`x-spf-agent` whenever
 * `isFluePropagationInstalled()` is true — it is NOT also stamped as a
 * baseline alongside this propagator. Measured live
 * (`scratchpad/probe_duplicate_header.mjs`, against the REAL
 * `@opentelemetry/instrumentation-undici` used here): `request.addHeader(k,
 * v)` — what that instrumentation calls for every header
 * `propagation.inject()` returns — APPENDS a second raw header line rather
 * than replacing one already present (undici's own `Request.addHeader` has
 * no dedupe-by-name step); the receiving `http.IncomingMessage.headers`
 * then comma-joins the two into one corrupted value
 * (`"FROM_STATIC, FROM_PROPAGATOR"`), and `req.rawHeaders` shows the literal
 * duplicate line. So when propagation is installed, THIS propagator is the
 * sole source of `x-correlation-id`/`x-spf-agent` — never doubled up with a
 * static value from `Model.headers` — proven on the wire by
 * `src/test/ollama_gateway_e2e.test.ts`'s "no duplicate headers" test.
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

/**
 * The Briefs gateway's own correlation headers — see `ollama_provider.ts`'s
 * "Gateway headers" section for the full three-header contract (the third,
 * `traceparent`, is the W3C standard one `W3CTraceContextPropagator` already
 * injects). Defined here (not in `ollama_provider.ts`) because
 * `GatewayHeadersPropagator` below is the thing that actually injects them
 * onto the wire when this pipeline is installed; `ollama_provider.ts`
 * imports these two constants rather than redeclaring them, so there is
 * exactly one spelling of each header name in the codebase.
 */
export const X_CORRELATION_ID_HEADER = "x-correlation-id";
export const X_SPF_AGENT_HEADER = "x-spf-agent";

/**
 * One flue session's (`ctx.id`'s) registration: the W3C `traceparent` string
 * for SPF's deterministic agent-call span (see `registerFlueSessionTrace`),
 * plus this session's `adw_id`/agent name — carried the SAME way, see the
 * module header's FLUE SPANS JOIN... section for why both ride one
 * registration rather than two separate maps.
 */
export interface FlueSessionRegistration {
  traceparent: string;
  adwId?: string;
  agentName?: string;
}

/**
 * Instance-id -> registration backing `resolveFlueRootContext` — see the
 * module header for the full mechanism and WHY this is a map consulted per
 * span rather than a dispatch-time context wrap (flue's single claim loop
 * makes the latter mis-attribute every agent after the first). One entry per
 * in-flight `agent_flue.run()` call.
 */
const flueSessionTraces = new Map<string, FlueSessionRegistration>();

/** Just the gateway-identity half of a `FlueSessionRegistration` — what `GatewayHeadersPropagator` actually needs once it's looking things up by trace id instead of by session id. */
interface GatewayIdentity {
  adwId?: string;
  agentName?: string;
}

/**
 * Trace id -> gateway identity, keyed on the deterministic trace id parsed
 * out of a registration's OWN `traceparent` (see `traceIdFromTraceparent`) —
 * see the module header's BLOCKER 1 section for why this, and not a context
 * VALUE, is the lookup `GatewayHeadersPropagator` uses. Populated by
 * `registerFlueSessionTrace`, pruned by `unregisterFlueSessionTrace`. A
 * trace id collision here (two DIFFERENT registrations sharing one trace id)
 * is not expected in practice — trace ids are SPF's deterministic per-adw_id
 * ids — but if it ever happened, the later `registerFlueSessionTrace` call
 * would simply win, matching this map's own "current call wins" rule.
 */
const traceIdRegistrations = new Map<string, GatewayIdentity>();

/**
 * Parses the W3C `traceId` segment out of a `traceparent` string via a real
 * `propagation.extract`/`getSpanContext` round trip — the SAME extraction
 * `resolveFlueRootContext` performs, so "the trace id we index
 * `traceIdRegistrations` under" and "the trace id a span parented via this
 * `traceparent` actually carries" are provably the same value, not two
 * independent parses that could drift. Returns `undefined` for a malformed
 * `traceparent` (mirrors `resolveFlueRootContext`'s own malformed-input
 * handling) rather than throwing.
 */
function traceIdFromTraceparent(traceparent: string): string | undefined {
  const extracted = propagation.extract(ROOT_CONTEXT, { traceparent }, defaultTextMapGetter);
  const spanContext = traceApi.getSpanContext(extracted);
  return spanContext && isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
}

/**
 * Registers `registration` (SPF's deterministic agent-call traceparent, plus
 * this session's adw_id/agent name — see `FlueSessionRegistration`) as the
 * trace root for flue spans belonging to `sessionId` — flue's instance id,
 * minted by SPF and handed to `init(SfAgent, { id })`. Overwrites a prior
 * registration for the same id (a same-phase retry is the same logical call;
 * the current call wins). Also indexes the SAME identity under this
 * registration's parsed trace id (`traceIdRegistrations`) — see the module
 * header's BLOCKER 1 section and that map's own doc for why.
 */
export function registerFlueSessionTrace(sessionId: string, registration: FlueSessionRegistration): void {
  flueSessionTraces.set(sessionId, registration);
  const identity: GatewayIdentity = { adwId: registration.adwId, agentName: registration.agentName };
  const traceId = traceIdFromTraceparent(registration.traceparent);
  if (traceId) traceIdRegistrations.set(traceId, identity);
}

/**
 * Injects `x-correlation-id`/`x-spf-agent` by looking up the ACTIVE
 * `Context`'s SpanContext trace id (`trace.getSpanContext(ctx)?.traceId`) in
 * `traceIdRegistrations` — the same per-real-HTTP-call injection point
 * `W3CTraceContextPropagator` uses for `traceparent`, and, critically, keyed
 * on the one piece of `resolveFlueRootContext`'s return value that provably
 * survives into that active context (see the module header's BLOCKER 1
 * section for why a context VALUE does not). Injects NOTHING — no fallback,
 * no last-known identity — when this exact trace id is not in the map: an
 * unregistered/unmapped span (flue's own bookkeeping spans, or ANY span
 * after every session has been unregistered) must not stamp a stale or
 * unrelated session's `x-correlation-id`/`x-spf-agent` onto unrelated
 * outbound traffic (a third-party call, a post-session straggler). A true
 * no-op (nothing set) in that case — never throws, never invents a value.
 * Replaces the old `XRequestIdPropagator`:
 * `x-request-id` must NEVER reach the gateway (Envoy/Switchyard own it
 * end-to-end; a client-sent value corrupts their own sampling) and this repo
 * no longer has anything that wants it emitted.
 */
export class GatewayHeadersPropagator implements TextMapPropagator {
  inject(ctx: Context, carrier: unknown, setter: TextMapSetter): void {
    const spanContext = traceApi.getSpanContext(ctx);
    const registration = spanContext && traceIdRegistrations.get(spanContext.traceId);
    if (!registration) return;
    if (registration.adwId) setter.set(carrier, X_CORRELATION_ID_HEADER, registration.adwId);
    if (registration.agentName) setter.set(carrier, X_SPF_AGENT_HEADER, registration.agentName);
  }
  extract(ctx: Context): Context {
    return ctx;
  }
  fields(): string[] {
    return [X_CORRELATION_ID_HEADER, X_SPF_AGENT_HEADER];
  }
}

/**
 * Idempotent — called from `run()`'s `finally`. Post-settlement bookkeeping
 * spans flue mints after this point simply resolve to an unparented root
 * (separate trace), which is preferable to leaking a registration whose id
 * a REUSED session id could collide with on a later phase. Also prunes this
 * session's entry out of `traceIdRegistrations` (parsed fresh from the
 * departing registration's own `traceparent`, so it removes exactly the
 * entry this session added.
 */
export function unregisterFlueSessionTrace(sessionId: string): void {
  const registration = flueSessionTraces.get(sessionId);
  flueSessionTraces.delete(sessionId);
  if (!registration) return;
  const traceId = traceIdFromTraceparent(registration.traceparent);
  if (traceId) traceIdRegistrations.delete(traceId);
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
 *
 * Used by `@flue/opentelemetry` ONLY as `tracer.startSpan`'s parent
 * argument (see the module header's BLOCKER 1 section) — the value handed
 * back here is never itself activated, so it carries no context VALUES for
 * `GatewayHeadersPropagator` to read; `x-correlation-id`/`x-spf-agent` are
 * instead looked up by trace id, via `traceIdRegistrations`, which
 * `registerFlueSessionTrace` populates independently of this function.
 */
export function resolveFlueRootContext(
  _event: unknown,
  ctx: { id?: string } | undefined,
): Context | undefined {
  const registration = ctx?.id ? flueSessionTraces.get(ctx.id) : undefined;
  if (!registration) return undefined;
  const extracted = propagation.extract(ROOT_CONTEXT, { traceparent: registration.traceparent }, defaultTextMapGetter);
  const spanContext = traceApi.getSpanContext(extracted);
  if (!spanContext || !isSpanContextValid(spanContext)) return undefined;
  return extracted;
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
      propagation.setGlobalPropagator(new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new GatewayHeadersPropagator()] }));
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

/**
 * Whether `installFluePropagation` has actually installed the global
 * TracerProvider/propagator/instrumentations in THIS process. Consulted by
 * `ollama_provider.ts` (see its "Gateway headers" section) so `resolve()`/
 * `modelFor()` know whether the instrumentation above already covers
 * `traceparent`/`x-correlation-id`/`x-spf-agent` per real outbound call —
 * supplying any of the three a second way when this is `true` would double
 * it up on the wire (`UndiciInstrumentation` appends via `addHeader`, it
 * does not replace). `false` — the common case, otel unconfigured — means
 * `ollama_provider.ts` must supply all three itself.
 */
export function isFluePropagationInstalled(): boolean {
  return installed;
}
