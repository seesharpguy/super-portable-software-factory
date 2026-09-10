/**
 * `otel_metrics.ts`: the process-scoped metrics sibling to `otel.ts`'s
 * per-run span exporter. Pins:
 *  1. The activation gate — `null` unconfigured, `null` when `metrics:
 *     false`, a real instance otherwise. Same `endpoint` gate as traces.
 *  2. The process-scoped singleton contract: `resolveOtelMetrics` returns
 *     the SAME instance across calls until `resetOtelMetricsForTest()`.
 *  3. A real round trip against an in-process OTLP/HTTP receiver: every
 *     named instrument (`spf.tokens`, `spf.cost_usd`, `spf.phase.duration`,
 *     `spf.gate.result`, `spf.agent.calls`) reaches the wire with its
 *     attributes, via the real `@opentelemetry/sdk-metrics` +
 *     `exporter-metrics-otlp-http` — not asserted from documentation.
 *  4. `resolveMetricsUrl`'s path-rewriting rule.
 *
 * Hermetic: every metrics handle here talks only to a loopback server on an
 * ephemeral port, and every case resets the module singleton first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as v from "valibot";
import { OtelMetrics, resetOtelMetricsForTest, resolveMetricsUrl, resolveOtelMetrics, shutdownOtelMetrics } from "../core/otel_metrics.js";
import { SFConfigSchema, type SFConfig } from "../core/data_types.js";

function cfgWithOtel(endpoint: string, overrides: Record<string, unknown> = {}): SFConfig {
  return v.parse(SFConfigSchema, { observability: { otel: { endpoint, service_name: "spf", ...overrides } } }) as SFConfig;
}

/** A one-request receiver — resolves with the parsed JSON body of the first POST. */
async function receiver(): Promise<{ url: string; body: Promise<{ raw: string; contentType: string | undefined }>; close: () => Promise<void> }> {
  let resolveBody: (value: { raw: string; contentType: string | undefined }) => void;
  const body = new Promise<{ raw: string; contentType: string | undefined }>((resolve) => {
    resolveBody = resolve;
  });
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      resolveBody({ raw: Buffer.concat(chunks).toString("utf-8"), contentType: req.headers["content-type"] });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/metrics`,
    body,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("resolveMetricsUrl: a bare origin gets /v1/metrics; a /v1/traces endpoint has it swapped; anything else is left alone", () => {
  assert.equal(resolveMetricsUrl("http://localhost:4318"), "http://localhost:4318/v1/metrics");
  assert.equal(resolveMetricsUrl("http://localhost:4318/"), "http://localhost:4318/v1/metrics");
  assert.equal(resolveMetricsUrl("https://collector.example.com/v1/traces"), "https://collector.example.com/v1/metrics");
  assert.equal(resolveMetricsUrl("https://collector.example.com/otlp/v1/traces"), "https://collector.example.com/otlp/v1/metrics");
  assert.equal(resolveMetricsUrl("https://collector.example.com/custom-router-path"), "https://collector.example.com/custom-router-path");
});

test("resolveOtelMetrics: null when observability.otel is absent — same gate as traces", () => {
  resetOtelMetricsForTest();
  const cfg = v.parse(SFConfigSchema, {}) as SFConfig;
  assert.equal(resolveOtelMetrics(cfg), null);
});

test("resolveOtelMetrics: null when metrics: false, even with a real endpoint", () => {
  resetOtelMetricsForTest();
  const cfg = cfgWithOtel("http://127.0.0.1:1/v1/traces", { metrics: false });
  assert.equal(resolveOtelMetrics(cfg), null);
});

test("resolveOtelMetrics: a process-scoped singleton — the SAME instance every call, until reset", () => {
  resetOtelMetricsForTest();
  const cfg = cfgWithOtel("http://127.0.0.1:1/v1/traces");
  const first = resolveOtelMetrics(cfg);
  const second = resolveOtelMetrics(cfgWithOtel("http://127.0.0.1:2/v1/traces")); // a DIFFERENT cfg — still the same handle
  assert.ok(first, "otel is configured — a real handle must come back");
  assert.equal(first, second, "process-scoped: created exactly once, never per-call");
  resetOtelMetricsForTest();
  const third = resolveOtelMetrics(cfg);
  assert.notEqual(first, third, "reset actually forgets the shared instance");
});

test("shutdownOtelMetrics(): a silent no-op when metrics were never configured", async () => {
  resetOtelMetricsForTest();
  await shutdownOtelMetrics();
});

test("round trip: every named instrument reaches a real in-process OTLP/HTTP receiver, with its attributes", async () => {
  const sink = await receiver();
  try {
    const metrics = new OtelMetrics({ endpoint: sink.url.replace("/v1/metrics", "/v1/traces"), serviceName: "spf-test", exportIntervalMillis: 100_000 });
    metrics.recordTokens("input", 100, { agent: "builder", model: "google/gemini-3.6-flash" });
    metrics.recordTokens("cache_read", 40, { agent: "builder", model: "google/gemini-3.6-flash" });
    metrics.recordCost(0.42, { agent: "builder", model: "google/gemini-3.6-flash" });
    metrics.recordPhaseDuration(12.5, { kind: "agent", owner: "builder", status: "success" });
    metrics.recordGateResult("no_placeholders", false);
    metrics.recordAgentCall({ agent: "builder", model: "google/gemini-3.6-flash", codingAgent: "flue" });
    await metrics.forceFlush();

    const request = await sink.body;
    assert.equal(request.contentType, "application/json");
    const json = request.raw;

    // Instrument names — the wire-verified proof every named metric this
    // feature promised actually reaches an OTLP/HTTP receiver.
    for (const name of ["spf.tokens", "spf.cost_usd", "spf.phase.duration", "spf.gate.result", "spf.agent.calls"]) {
      assert.ok(json.includes(`"name":"${name}"`), `${name} must reach the wire`);
    }
    // Attributes survive — kind/agent/model on the token counter, pass/fail
    // spelled out on the gate counter (never a bare boolean the backend has
    // to know SPF's own convention to interpret).
    assert.ok(json.includes('"key":"kind"') && json.includes('"stringValue":"cache_read"'), "token kind attribute survives");
    assert.ok(json.includes('"stringValue":"builder"'), "agent attribute survives");
    assert.ok(json.includes('"stringValue":"fail"'), "gate result is spelled out as pass/fail, not a bare bool");
    await metrics.shutdown();
  } finally {
    await sink.close();
  }
});

test("recordTokens/recordCost/etc never throw, even against a dead endpoint", async () => {
  const metrics = new OtelMetrics({ endpoint: "http://127.0.0.1:1/v1/traces", serviceName: "spf-test" });
  metrics.recordTokens("output", 10, { agent: "a", model: "m" });
  metrics.recordCost(1, { agent: "a", model: "m" });
  metrics.recordPhaseDuration(1, { kind: "agent", owner: "a", status: "success" });
  metrics.recordGateResult("g", true);
  metrics.recordAgentCall({ agent: "a", model: "m", codingAgent: "flue" });
  metrics.recordDroppedSpans(3);
  metrics.recordDroppedSpanEvents(1);
  await metrics.forceFlush(); // must resolve, not reject, even though nothing is listening
  await metrics.shutdown(200);
});
