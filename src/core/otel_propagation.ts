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
 * A SEPARATE TRACE FROM SPF's OWN SPANS, ON PURPOSE. This global provider's
 * spans use the SDK's own random `IdGenerator` — they are NOT stitched into
 * `otel.ts`'s deterministic-sha256-id trace. Unifying the two would mean
 * either handing `otel.ts`'s bespoke ids to a real `IdGenerator` (which
 * takes no arguments — see `otel.ts`'s own header for why that already
 * doesn't work for its own per-run exporter) or making `otel.ts` route
 * through the global provider instead of its own direct-to-`ReadableSpan`
 * construction, which would reopen the exact hand-rolled-adjacent risk v2
 * of `otel.ts` exists to close. Two separate, correctly-formed traces that a
 * backend can still correlate by time window and `spf.adw_id`/`gen_ai.*`
 * attributes is the honest v1 of this feature, not a bug to fix later
 * without saying so.
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

import { propagation, trace as traceApi, context as contextApi, isSpanContextValid, type Context, type TextMapPropagator, type TextMapSetter } from "@opentelemetry/api";
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
      installed = true;
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
    }
    if (!flueInstrumented) {
      flueInstrumented = true;
      instrument(createOpenTelemetryInstrumentation({ content: false }));
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
