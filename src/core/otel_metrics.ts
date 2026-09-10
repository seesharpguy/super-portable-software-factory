/**
 * OpenTelemetry metrics export — a PROCESS-scoped sibling to `otel.ts`'s
 * per-run span exporter, built on the real `@opentelemetry/sdk-metrics` +
 * `@opentelemetry/exporter-metrics-otlp-http` (v1's header explained why
 * metrics were deliberately cut from the hand-rolled encoder: "the OTLP
 * metrics data model — temporality, monotonicity, cumulative-vs-delta — is
 * exactly where a hand-rolled encoder produces numbers a backend silently
 * misreads". That risk is why this module exists only now that a REAL SDK
 * owns the encoding, never before).
 *
 * PROCESS-scoped, not per-run — the one significant lifecycle difference from
 * `otel.ts`. `spf watch`'s daemon loop runs many sessions in one process, one
 * per claimed issue; a MeterProvider created per-run would repeat the same
 * unbounded-growth mistake `otel.ts`'s RUN-SCOPED CLEANUP note (#26) already
 * fixed once for spans. There is exactly one `MeterProvider` for the life of
 * the `spf` process, created lazily on first use and torn down once, from
 * `src/cli/index.ts`'s existing `finally` block, alongside `otel.flushAll()`.
 *
 * SAME ACTIVATION GATE AS TRACES: `observability.otel.endpoint` must be set —
 * no ambient `OTEL_EXPORTER_OTLP_*` env var can turn this on (see `otel.ts`'s
 * EXPLICIT CONFIG ONLY). `observability.otel.metrics: false` additionally
 * opts OUT of metrics while leaving trace export on; there is no way to have
 * metrics without traces, since the gate is the trace endpoint's presence.
 *
 * NEVER THROWS. Every public method here follows the same discipline
 * `otel.ts` documents at its own top: a metrics failure must never surface as
 * a caller's exception, so every instrument call is wrapped and any error is
 * logged at most once and then swallowed.
 *
 * INSTRUMENTS:
 *   spf.tokens        (Counter, unit "token")  attrs: kind (input|output|
 *                      cache_read|cache_write), agent, model
 *   spf.cost_usd      (Counter, unit "USD")    attrs: agent, model
 *   spf.phase.duration(Histogram, unit "s")    attrs: kind, owner, status
 *   spf.gate.result   (Counter)                attrs: gate, result (pass|fail)
 *   spf.agent.calls   (Counter)                attrs: agent, model, coding_agent
 *   spf.otel.dropped_spans / spf.otel.dropped_span_events (Counter) — the
 *   v1 "stamp it on the final flush's resource attribute" hack has no home in
 *   the real SDK (a `Resource` is immutable per exporter instance); these
 *   replace it, recorded once per exporter's lifetime, same as the warn log.
 *
 * WIRE TRANSPORT mirrors `otel.ts`'s trace exporter: JSON-encoded OTLP/HTTP
 * (`OTLPMetricExporter`'s default), `keepAlive: false` so a lingering
 * keep-alive socket can never be the reason `spf` fails to exit, aimed at
 * `resolveMetricsUrl(otel.endpoint)` — the same collector host, `/v1/metrics`
 * instead of `/v1/traces` (or the given path verbatim, for a collector
 * fronted by a router that doesn't use the standard suffixes at all).
 */

import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import type { Counter, Histogram } from "@opentelemetry/api";
import { applyOtelEnvSupplement, type SFConfig } from "./data_types.ts";

/** Never emits on its own — `forceFlush()`/tests drive collection explicitly, so a process never waits `exportIntervalMillis` for its final data to go out. */
const EXPORT_INTERVAL_MS = 60_000;
const EXPORT_TIMEOUT_MS = 2_000;

/**
 * A bare origin gets `/v1/metrics` appended; an endpoint that already ends in
 * `/v1/traces` (the documented shape for `observability.otel.endpoint`) has
 * that suffix swapped for `/v1/metrics` — same collector host, the metrics
 * signal's own path. Anything else (a router/proxy path that doesn't use the
 * standard suffixes) is left exactly as given, matching `otel.ts`'s
 * `resolveTracesUrl`'s "the operator's URL is not ours to rewrite" rule.
 */
export function resolveMetricsUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return endpoint;
  }
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/v1/metrics";
    return url.toString();
  }
  if (url.pathname.endsWith("/v1/traces")) {
    url.pathname = url.pathname.slice(0, -"/v1/traces".length) + "/v1/metrics";
    return url.toString();
  }
  return url.toString();
}

export interface OtelMetricsInit {
  endpoint: string;
  headers?: Record<string, string>;
  serviceName: string;
  /** Injectable for tests; defaults to stderr. */
  log?: (message: string) => void;
  /** Injectable for tests — swap in an `InMemoryMetricExporter`/a short interval without touching the network. */
  exporter?: PushMetricExporter;
  exportIntervalMillis?: number;
}

export class OtelMetrics {
  private readonly provider: MeterProvider;
  private readonly log: (message: string) => void;
  private loggedFailure = false;

  private readonly tokens: Counter;
  private readonly cost: Counter;
  private readonly phaseDuration: Histogram;
  private readonly gateResult: Counter;
  private readonly agentCalls: Counter;
  private readonly droppedSpans: Counter;
  private readonly droppedSpanEvents: Counter;

  constructor(init: OtelMetricsInit) {
    this.log = init.log ?? ((m: string) => console.error(m));
    const exporter =
      init.exporter ??
      new OTLPMetricExporter({
        url: resolveMetricsUrl(init.endpoint),
        headers: init.headers,
        timeoutMillis: EXPORT_TIMEOUT_MS,
        keepAlive: false,
      });
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: init.exportIntervalMillis ?? EXPORT_INTERVAL_MS,
      exportTimeoutMillis: EXPORT_TIMEOUT_MS,
    });
    this.provider = new MeterProvider({
      resource: resourceFromAttributes({ "service.name": init.serviceName }),
      readers: [reader],
    });
    const meter = this.provider.getMeter("spf", "1");
    this.tokens = meter.createCounter("spf.tokens", { unit: "token", description: "Tokens spent per agent call, by kind" });
    this.cost = meter.createCounter("spf.cost_usd", { unit: "USD", description: "Dollar cost spent per agent call" });
    this.phaseDuration = meter.createHistogram("spf.phase.duration", { unit: "s", description: "Phase wall-clock duration" });
    this.gateResult = meter.createCounter("spf.gate.result", { description: "Gate verdicts, pass or fail" });
    this.agentCalls = meter.createCounter("spf.agent.calls", { description: "Agent calls completed" });
    this.droppedSpans = meter.createCounter("spf.otel.dropped_spans", { description: "Spans dropped by the bounded queue (see otel.ts)" });
    this.droppedSpanEvents = meter.createCounter("spf.otel.dropped_span_events", { description: "Span events dropped by the per-phase cap" });
  }

  recordTokens(kind: "input" | "output" | "cache_read" | "cache_write", value: number, attrs: { agent: string; model: string }): void {
    this.guard(() => this.tokens.add(value, { kind, agent: attrs.agent, model: attrs.model }));
  }

  recordCost(value: number, attrs: { agent: string; model: string }): void {
    this.guard(() => this.cost.add(value, { agent: attrs.agent, model: attrs.model }));
  }

  recordPhaseDuration(seconds: number, attrs: { kind: string; owner: string; status: string }): void {
    this.guard(() => this.phaseDuration.record(seconds, { kind: attrs.kind, owner: attrs.owner, status: attrs.status }));
  }

  recordGateResult(gate: string, passed: boolean): void {
    this.guard(() => this.gateResult.add(1, { gate, result: passed ? "pass" : "fail" }));
  }

  recordAgentCall(attrs: { agent: string; model: string; codingAgent: string }): void {
    this.guard(() => this.agentCalls.add(1, { agent: attrs.agent, model: attrs.model, coding_agent: attrs.codingAgent }));
  }

  recordDroppedSpans(n: number): void {
    this.guard(() => this.droppedSpans.add(n));
  }

  recordDroppedSpanEvents(n: number): void {
    this.guard(() => this.droppedSpanEvents.add(n));
  }

  /** Force an out-of-band export. Tests use this instead of waiting on `exportIntervalMillis`. Never throws. */
  async forceFlush(): Promise<void> {
    try {
      await this.provider.forceFlush();
    } catch (error) {
      this.logFailureOnce(error);
    }
  }

  /** Never throws. */
  async shutdown(budgetMs: number = EXPORT_TIMEOUT_MS): Promise<void> {
    let deadline: NodeJS.Timeout | null = null;
    const budget = new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, budgetMs);
      deadline.unref?.();
    });
    try {
      await Promise.race([this.provider.shutdown(), budget]);
    } catch (error) {
      this.logFailureOnce(error);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.logFailureOnce(error);
    }
  }

  private logFailureOnce(error: unknown): void {
    if (this.loggedFailure) return;
    this.loggedFailure = true;
    const message = error instanceof Error ? error.message : String(error);
    this.log(`spf: otel metrics failed (${message}) — metrics for this process are incomplete; runs are unaffected`);
  }
}

// ── module-level lifecycle: ONE MeterProvider for the life of the process ──

let SHARED: OtelMetrics | null | undefined; // undefined = not yet resolved; null = resolved-and-off

/**
 * Resolve (once per process) the shared metrics handle from
 * `cfg.observability.otel`, or `null` when metrics are off — absent
 * `endpoint` (same gate as traces) or `metrics: false`. Every call after the
 * first, for the life of the process, returns the SAME instance regardless
 * of what `cfg` says (this is the "exactly once, never per-issue" contract
 * `spf watch`'s daemon loop needs — see the module header) — call
 * `resetOtelMetricsForTest()` between test cases that need a fresh one.
 */
export function resolveOtelMetrics(cfg: SFConfig, log?: (message: string) => void): OtelMetrics | null {
  if (SHARED !== undefined) return SHARED;
  const rawOtel = cfg.observability.otel;
  if (!rawOtel || !rawOtel.endpoint || rawOtel.metrics === false) {
    SHARED = null;
    return null;
  }
  const otel = applyOtelEnvSupplement(rawOtel);
  SHARED = new OtelMetrics({ endpoint: otel.endpoint, headers: otel.headers, serviceName: otel.service_name || "spf", log });
  return SHARED;
}

/**
 * Shut down the shared MeterProvider, if one was ever created. A no-op when
 * metrics were never configured. Called once, from `src/cli/index.ts`'s
 * `finally`, alongside `otel.flushAll()`. Never throws.
 */
export async function shutdownOtelMetrics(budgetMs?: number): Promise<void> {
  const shared = SHARED;
  SHARED = undefined;
  if (shared) await shared.shutdown(budgetMs);
}

/** Tests only: forget the shared instance so cases cannot leak into each other. */
export function resetOtelMetricsForTest(): void {
  SHARED = undefined;
}
