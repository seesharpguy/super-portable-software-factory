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
import { injectOtelEnv as injectOtelEnvOc, mergeOperatorConfig, otelProviderHeaders, readOperatorConfig, tempConfigContents } from "../core/agent_opencode.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

// ── 3. opencode: injectOtelEnv / otelProviderHeaders / tempConfigContents ───
// (agent_opencode.ts — see its module doc comment's OUTBOUND OTEL
// PROPAGATION section: env var is parity-only, the temp-config provider
// headers are the path that actually reaches the wire.)

const OC_OTEL = {
  traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  x_request_id: "bbbbbbbbbbbbbbbb",
  endpoint: "http://collector:4318/v1/traces",
  service_name: "spf",
};

test("opencode injectOtelEnv: byte-identical env when otel is unconfigured", () => {
  const base = { PATH: "/usr/bin", OPENCODE_CONFIG: "/tmp/x/opencode.json" };
  assert.deepEqual(injectOtelEnvOc(base, undefined), base);
});

test("opencode injectOtelEnv: sets TRACEPARENT, everything else passes through untouched", () => {
  const base = { PATH: "/usr/bin", OPENCODE_CONFIG: "/tmp/x/opencode.json" };
  const env = injectOtelEnvOc(base, OC_OTEL);
  assert.equal(env.TRACEPARENT, "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.OPENCODE_CONFIG, "/tmp/x/opencode.json");
});

test("otelProviderHeaders: null when otel is absent, or when the model id has no provider/ prefix", () => {
  assert.equal(otelProviderHeaders("anthropic/claude-sonnet-4", undefined), null);
  assert.equal(otelProviderHeaders("bare-model-name", OC_OTEL), null, "no provider id to key headers under — never guess one");
  assert.equal(otelProviderHeaders("/no-provider", OC_OTEL), null);
});

test("otelProviderHeaders: provider id from the model's first segment; traceparent + x-request-id as static headers", () => {
  const h = otelProviderHeaders("ollama/qwen3-coder:30b", OC_OTEL);
  assert.deepEqual(h, {
    provider: "ollama",
    headers: {
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      "x-request-id": "bbbbbbbbbbbbbbbb",
    },
  });
});

test("tempConfigContents: null when neither tool restriction nor otel applies (no config file written at all)", () => {
  assert.equal(tempConfigContents(undefined, null), null);
  assert.equal(tempConfigContents(null, null), null);
});

test("tempConfigContents: provider block only when only otel applies — no permission map", () => {
  const contents = tempConfigContents(undefined, otelProviderHeaders("anthropic/claude-sonnet-4", OC_OTEL));
  assert.deepEqual(contents, {
    provider: {
      anthropic: {
        options: {
          headers: {
            traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
            "x-request-id": "bbbbbbbbbbbbbbbb",
          },
        },
      },
    },
  });
});

test("tempConfigContents: both blocks when tools are restricted AND otel is configured", () => {
  const contents = tempConfigContents(["bash", "read"], otelProviderHeaders("anthropic/claude-sonnet-4", OC_OTEL));
  assert.ok(contents && typeof contents === "object");
  assert.deepEqual((contents as any).provider.anthropic.options.headers["x-request-id"], "bbbbbbbbbbbbbbbb");
  assert.equal((contents as any).permission.bash, "allow");
  assert.equal((contents as any).permission.edit, "deny", "restriction map still built exactly as before");
});

test("opencode injectOtelEnv: a pre-existing (stale ambient) TRACEPARENT is overwritten by this call's own", () => {
  const base = { TRACEPARENT: "00-stale-stale-stale-stale-stal-0000000000000000-00" };
  const env = injectOtelEnvOc(base, OC_OTEL);
  assert.equal(env.TRACEPARENT, "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01", "SPF's per-call value wins over ambient state");
});

test("otelProviderHeaders: provider extracted from an adapter-shaped id (provider/base:adapter)", () => {
  const h = otelProviderHeaders("vllm/qwen3-coder:coder-lora", OC_OTEL);
  assert.equal(h?.provider, "vllm");
});

test("tempConfigContents: tools=[] + otel -> restriction map with everything denied AND the provider block", () => {
  const contents = tempConfigContents([], otelProviderHeaders("anthropic/claude-sonnet-4", OC_OTEL)) as any;
  assert.equal(contents.permission.bash, "deny", "[] means NO tools, mirroring CC's --tools \"\"");
  assert.equal(contents.permission.edit, "deny");
  assert.ok(contents.provider.anthropic.options.headers.traceparent, "provider block present alongside the restriction");
});

test("mergeOperatorConfig: operator keys pass through untouched; SPF blocks win on conflicting leaves, recursively", () => {
  const operatorCfg = {
    provider: {
      anthropic: {
        options: { baseURL: "https://gw.internal/v1", apiKey: "{env:KEY}", headers: { "x-tenant": "acme", traceparent: "00-stale-stale-stale-stale-stal-0000000000000000-00" } },
      },
    },
    mcp: { local: { type: "local", command: ["mcp-server"] } },
  };
  const merged = mergeOperatorConfig(
    operatorCfg,
    tempConfigContents(["bash"], otelProviderHeaders("anthropic/claude-sonnet-4", OC_OTEL))!,
  ) as any;
  assert.equal(merged.provider.anthropic.options.baseURL, "https://gw.internal/v1", "operator provider routing survives");
  assert.equal(merged.provider.anthropic.options.apiKey, "{env:KEY}", "operator credential reference survives");
  assert.equal(merged.provider.anthropic.options.headers["x-tenant"], "acme", "operator's own headers survive");
  assert.equal(merged.provider.anthropic.options.headers.traceparent, OC_OTEL.traceparent, "SPF's traceparent wins on conflict");
  assert.equal(merged.provider.anthropic.options.headers["x-request-id"], OC_OTEL.x_request_id, "SPF's x-request-id is added");
  assert.deepEqual(merged.mcp, operatorCfg.mcp, "unrelated top-level operator keys untouched");
  assert.equal(merged.permission.bash, "allow");
  assert.equal(merged.permission.edit, "deny");
});

test("readOperatorConfig: null for a missing file, a non-object root, or unparseable (e.g. JSONC) content — never throws", () => {
  assert.equal(readOperatorConfig("/nonexistent/definitely-not-here/opencode.json"), null);
  const dir = mkdtempSync(path.join(os.tmpdir(), "spf-oc-cfg-test-"));
  try {
    const arrPath = path.join(dir, "array.json");
    writeFileSync(arrPath, "[]");
    assert.equal(readOperatorConfig(arrPath), null, "array root is not mergeable");
    const jsoncPath = path.join(dir, "jsonc.json");
    writeFileSync(jsoncPath, '{\n  // a comment\n  "provider": {}\n}');
    assert.equal(readOperatorConfig(jsoncPath), null, "JSONC falls back to replace behavior rather than failing the run");
    const goodPath = path.join(dir, "good.json");
    writeFileSync(goodPath, '{"provider":{"x":{"options":{"apiKey":"k"}}}}');
    assert.deepEqual(readOperatorConfig(goodPath), { provider: { x: { options: { apiKey: "k" } } } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
