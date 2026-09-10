/**
 * Outbound trace-context propagation tests — the two paths `otel.ts`'s
 * spike-derived design split by confidence level (see `otel_propagation.ts`
 * and `agent_cc.ts`'s own headers):
 *
 *  1. `claude_code` (agent_cc.ts's `injectOtelEnv`): a real, verifiable
 *     guarantee — pure, no subprocess needed to prove the env it builds.
 *  2. `flue` (otel_propagation.ts's `installFluePropagation` +
 *     `XRequestIdPropagator`): best-effort, proven here by actually
 *     registering the real global TracerProvider/propagator this module
 *     installs and running a real `propagation.inject()` through it — the
 *     same call `@opentelemetry/instrumentation-http`/`-undici` make on
 *     every outbound request once installed.
 *
 * This file's `test()` blocks share ONE process (Node's test runner isolates
 * by FILE, not by block) and therefore share the module-level globals
 * `installFluePropagation` sets — the ordering below is deliberate: the
 * "before install" assertion runs first, then "after install", proving the
 * install actually changed global state rather than asserting two facts
 * that happen to both be true independently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { context, isSpanContextValid, propagation, trace } from "@opentelemetry/api";
import { injectOtelEnv } from "../core/agent_cc.js";
import { installFluePropagation, resetFluePropagationForTest, X_REQUEST_ID_HEADER, XRequestIdPropagator } from "../core/otel_propagation.js";

// ── 1. claude_code: injectOtelEnv (agent_cc.ts) ─────────────────────────────

test("injectOtelEnv: byte-identical env when otel is unconfigured", () => {
  const base = { PATH: "/usr/bin", HOME: "/home/x" };
  assert.deepEqual(injectOtelEnv(base, undefined), base);
});

test("injectOtelEnv: sets TRACEPARENT and ANTHROPIC_CUSTOM_HEADERS (verified format: newline-separated 'Name: Value' pairs — https://code.claude.com/docs/en/env-vars)", () => {
  const base = { PATH: "/usr/bin" };
  const env = injectOtelEnv(base, {
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    x_request_id: "bbbbbbbbbbbbbbbb",
    endpoint: "http://collector:4318/v1/traces",
    service_name: "spf",
  });
  assert.equal(env.PATH, "/usr/bin", "the rest of the env passes through untouched");
  assert.equal(env.TRACEPARENT, "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
  assert.equal(
    env.ANTHROPIC_CUSTOM_HEADERS,
    "traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01\nx-request-id: bbbbbbbbbbbbbbbb",
  );
});

test("injectOtelEnv: an operator-supplied ANTHROPIC_CUSTOM_HEADERS in the base env is preserved, not clobbered", () => {
  const base = { ANTHROPIC_CUSTOM_HEADERS: "x-tenant: acme" };
  const env = injectOtelEnv(base, {
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    x_request_id: "bbbbbbbbbbbbbbbb",
    endpoint: "http://collector:4318/v1/traces",
    service_name: "spf",
  });
  assert.equal(
    env.ANTHROPIC_CUSTOM_HEADERS,
    "x-tenant: acme\ntraceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01\nx-request-id: bbbbbbbbbbbbbbbb",
    "the operator's own header line survives, with SPF's appended after it",
  );
});

// ── 2. flue: installFluePropagation + XRequestIdPropagator ─────────────────

test("XRequestIdPropagator: fields() names exactly the one header it sets", () => {
  const p = new XRequestIdPropagator();
  assert.deepEqual(p.fields(), [X_REQUEST_ID_HEADER]);
});

test("XRequestIdPropagator: inject() is a no-op when there is no valid active span (an un-instrumented context)", () => {
  const p = new XRequestIdPropagator();
  const carrier: Record<string, string> = {};
  p.inject(context.active(), carrier, { set: (c, k, v) => (c as Record<string, string>)[k] = v });
  assert.deepEqual(carrier, {}, "no active span -> nothing to correlate by -> no header");
});

test("installFluePropagation: a no-op when otel is unconfigured (undefined, or no endpoint) — never throws", () => {
  resetFluePropagationForTest();
  installFluePropagation(undefined);
  installFluePropagation({ endpoint: "", service_name: "spf" });
  // No global TracerProvider was registered by either call: a span from the
  // (still default, no-op) global tracer has an INVALID SpanContext.
  const span = trace.getTracer("otel-propagation-test-before").startSpan("op");
  assert.equal(isSpanContextValid(span.spanContext()), false, "still the default no-op tracer — nothing was installed");
  span.end();
});

test("installFluePropagation: registers a REAL global TracerProvider + propagator — traceparent and x-request-id both land on an injected carrier", () => {
  // Continues from the PRECEDING test's un-configured state on purpose (see
  // this file's header) — proves this call is what changes it.
  installFluePropagation({ endpoint: "http://127.0.0.1:1/v1/traces", service_name: "spf-test" });

  const tracer = trace.getTracer("otel-propagation-test-after");
  const span = tracer.startSpan("chat some-model");
  assert.equal(isSpanContextValid(span.spanContext()), true, "a real TracerProvider is now registered globally");

  const ctx = trace.setSpan(context.active(), span);
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  const { traceId, spanId } = span.spanContext();
  assert.equal(carrier["traceparent"], `00-${traceId}-${spanId}-01`, "W3CTraceContextPropagator injected a real traceparent");
  assert.equal(carrier[X_REQUEST_ID_HEADER], spanId, "the custom propagator injected x-request-id = this span's own id");
  span.end();

  // Idempotent: a second call (a later `flue` agent dispatch in this same
  // process, possibly with a different cfg) must not throw and must not
  // disturb the already-registered pipeline.
  installFluePropagation({ endpoint: "http://127.0.0.1:1/v1/traces", service_name: "a-different-service-name" });
  const span2 = trace.getTracer("otel-propagation-test-idempotent").startSpan("op2");
  assert.equal(isSpanContextValid(span2.spanContext()), true, "still a real provider after a second call");
  span2.end();
});
