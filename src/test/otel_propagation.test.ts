/**
 * Outbound trace-context propagation tests — the two paths `otel.ts`'s
 * spike-derived design split by confidence level (see `otel_propagation.ts`
 * and `agent_cc.ts`'s own headers):
 *
 *  1. `claude_code` (agent_cc.ts's `injectOtelEnv`) and `opencode`
 *     (agent_opencode.ts's `injectOtelEnv`/`otelProviderHeaders`/
 *     `tempConfigContents`): a real, verifiable guarantee — pure, no
 *     subprocess needed to prove the env/config they build. Both now also
 *     carry `x-correlation-id`/`x-spf-agent` whenever the caller supplies an
 *     adw_id/agent name, REGARDLESS of whether otel is configured (BLOCKER
 *     B: neither ever sends `x-request-id` again).
 *  2. `flue` (otel_propagation.ts's `installFluePropagation` +
 *     `GatewayHeadersPropagator`): best-effort, proven here by actually
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
import {
  injectOtelEnv as injectOtelEnvOc,
  mergeOperatorConfig,
  otelProviderHeaders,
  readOperatorConfig,
  tempConfigContents,
} from "../core/agent_opencode.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GatewayHeadersPropagator,
  installFluePropagation,
  isFluePropagationInstalled,
  registerFlueSessionTrace,
  resetFluePropagationForTest,
  resolveFlueRootContext,
  unregisterFlueSessionTrace,
  X_CORRELATION_ID_HEADER,
  X_SPF_AGENT_HEADER,
} from "../core/otel_propagation.js";

// ── 1a. claude_code: injectOtelEnv (agent_cc.ts) ────────────────────────────

test("injectOtelEnv: byte-identical env when otel is unconfigured and there is no adw_id/agent_name", () => {
  const base = { PATH: "/usr/bin", HOME: "/home/x" };
  assert.deepEqual(injectOtelEnv(base, undefined), base);
  assert.deepEqual(injectOtelEnv(base, undefined, {}), base);
});

test("injectOtelEnv: sets TRACEPARENT and ANTHROPIC_CUSTOM_HEADERS (verified format: newline-separated 'Name: Value' pairs — https://code.claude.com/docs/en/env-vars); no gateway identity -> no x-correlation-id/x-spf-agent", () => {
  const base = { PATH: "/usr/bin" };
  const env = injectOtelEnv(base, {
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    x_request_id: "bbbbbbbbbbbbbbbb",
    endpoint: "http://collector:4318/v1/traces",
    service_name: "spf",
  });
  assert.equal(env.PATH, "/usr/bin", "the rest of the env passes through untouched");
  assert.equal(env.TRACEPARENT, "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
});

test("injectOtelEnv: adw_id/agent_name alone (otel NOT configured) still set x-correlation-id/x-spf-agent — NOT gated on otel; no TRACEPARENT env var without otel", () => {
  const base = { PATH: "/usr/bin" };
  const env = injectOtelEnv(base, undefined, { adwId: "adw_123", agentName: "spec_writer" });
  assert.equal(env.TRACEPARENT, undefined, "no otel context -> no TRACEPARENT env var");
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "x-correlation-id: adw_123\nx-spf-agent: spec_writer");
});

test("injectOtelEnv: otel + gateway identity together -> traceparent, then x-correlation-id, then x-spf-agent; never x-request-id", () => {
  const base = { PATH: "/usr/bin" };
  const env = injectOtelEnv(
    base,
    {
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      x_request_id: "bbbbbbbbbbbbbbbb",
      endpoint: "http://collector:4318/v1/traces",
      service_name: "spf",
    },
    { adwId: "adw_123", agentName: "spec_writer" },
  );
  assert.equal(
    env.ANTHROPIC_CUSTOM_HEADERS,
    "traceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01\nx-correlation-id: adw_123\nx-spf-agent: spec_writer",
  );
  assert.equal("x-request-id" in env, false);
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS.includes("x-request-id"), false, "BLOCKER B: never sent again");
});

test("injectOtelEnv: an operator-supplied ANTHROPIC_CUSTOM_HEADERS in the base env is preserved, not clobbered", () => {
  const base = { ANTHROPIC_CUSTOM_HEADERS: "x-tenant: acme" };
  const env = injectOtelEnv(
    base,
    {
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      x_request_id: "bbbbbbbbbbbbbbbb",
      endpoint: "http://collector:4318/v1/traces",
      service_name: "spf",
    },
    { adwId: "adw_123" },
  );
  assert.equal(
    env.ANTHROPIC_CUSTOM_HEADERS,
    "x-tenant: acme\ntraceparent: 00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01\nx-correlation-id: adw_123",
    "the operator's own header line survives, with SPF's appended after it",
  );
});

// ── 2. flue: installFluePropagation + GatewayHeadersPropagator ─────────────

test("GatewayHeadersPropagator: fields() names exactly the two headers it sets", () => {
  const p = new GatewayHeadersPropagator();
  assert.deepEqual(p.fields(), [X_CORRELATION_ID_HEADER, X_SPF_AGENT_HEADER]);
});

test("GatewayHeadersPropagator: inject() is a no-op when there is no gateway-call context value (a plain, un-instrumented context)", () => {
  const p = new GatewayHeadersPropagator();
  const carrier: Record<string, string> = {};
  p.inject(context.active(), carrier, { set: (c, k, v) => ((c as Record<string, string>)[k] = v) });
  assert.deepEqual(carrier, {}, "nothing registered for this context -> nothing to correlate by -> no header");
});

test("isFluePropagationInstalled: false before installFluePropagation is ever called (or called with nothing configured)", () => {
  resetFluePropagationForTest();
  assert.equal(isFluePropagationInstalled(), false);
  installFluePropagation(undefined);
  assert.equal(isFluePropagationInstalled(), false);
  installFluePropagation({ endpoint: "", service_name: "spf" });
  assert.equal(isFluePropagationInstalled(), false, "an empty endpoint is 'unconfigured', same as undefined");
});

test("installFluePropagation: a no-op when otel is unconfigured (undefined, or no endpoint) — never throws", () => {
  // Continues from the PRECEDING test's reset state on purpose (see this
  // file's header) — proves this call is what changes it.
  const span = trace.getTracer("otel-propagation-test-before").startSpan("op");
  assert.equal(isSpanContextValid(span.spanContext()), false, "still the default no-op tracer — nothing was installed");
  span.end();
});

test("installFluePropagation: registers a REAL global TracerProvider + propagator — traceparent lands on an injected carrier; isFluePropagationInstalled() flips true", () => {
  installFluePropagation({ endpoint: "http://127.0.0.1:1/v1/traces", service_name: "spf-test" });
  assert.equal(isFluePropagationInstalled(), true);

  const tracer = trace.getTracer("otel-propagation-test-after");
  const span = tracer.startSpan("chat some-model");
  assert.equal(isSpanContextValid(span.spanContext()), true, "a real TracerProvider is now registered globally");

  const ctx = trace.setSpan(context.active(), span);
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  const { traceId, spanId } = span.spanContext();
  assert.equal(carrier["traceparent"], `00-${traceId}-${spanId}-01`, "W3CTraceContextPropagator injected a real traceparent");
  assert.equal(X_CORRELATION_ID_HEADER in carrier, false, "no gateway-call context was registered for this span -> no x-correlation-id");
  assert.equal(X_SPF_AGENT_HEADER in carrier, false);
  assert.equal("x-request-id" in carrier, false, "BLOCKER B: never injected, by anything, ever again");
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
// (agent_opencode.ts — see its module doc comment's OUTBOUND OTEL +
// GATEWAY-HEADER PROPAGATION section: env var is parity-only, the
// temp-config provider headers are the path that actually reaches the wire.)

const OC_OTEL = {
  traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
  x_request_id: "bbbbbbbbbbbbbbbb",
  endpoint: "http://collector:4318/v1/traces",
  service_name: "spf",
};
const OC_GATEWAY = { adwId: "adw_1", agentName: "researcher" };

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

test("otelProviderHeaders: null when neither otel nor gateway identity apply, or when the model id has no provider/ prefix", () => {
  assert.equal(otelProviderHeaders("anthropic/claude-sonnet-4", undefined), null);
  assert.equal(otelProviderHeaders("bare-model-name", OC_OTEL), null, "no provider id to key headers under — never guess one");
  assert.equal(otelProviderHeaders("/no-provider", OC_OTEL), null);
  assert.equal(otelProviderHeaders("bare-model-name", undefined, OC_GATEWAY), null, "no provider id, even with a gateway identity to carry");
});

test("otelProviderHeaders: provider id from the model's first segment; traceparent as the only static header when only otel applies", () => {
  const h = otelProviderHeaders("ollama/qwen3-coder:30b", OC_OTEL);
  assert.deepEqual(h, {
    provider: "ollama",
    headers: { traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" },
  });
});

test("otelProviderHeaders: x-correlation-id/x-spf-agent alone (otel NOT configured) — NOT gated on otel", () => {
  const h = otelProviderHeaders("ollama/qwen3-coder:30b", undefined, OC_GATEWAY);
  assert.deepEqual(h, {
    provider: "ollama",
    headers: { "x-correlation-id": "adw_1", "x-spf-agent": "researcher" },
  });
  assert.equal("traceparent" in h!.headers, false, "no otel context -> no traceparent");
});

test("otelProviderHeaders: otel + gateway together -> all three headers, and NEVER x-request-id", () => {
  const h = otelProviderHeaders("anthropic/claude-sonnet-4", OC_OTEL, OC_GATEWAY);
  assert.deepEqual(h, {
    provider: "anthropic",
    headers: {
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      "x-correlation-id": "adw_1",
      "x-spf-agent": "researcher",
    },
  });
  assert.equal("x-request-id" in h!.headers, false, "BLOCKER B: never sent again");
});

test("tempConfigContents: null when neither tool restriction nor otel/gateway headers apply (no config file written at all)", () => {
  assert.equal(tempConfigContents(undefined, null), null);
  assert.equal(tempConfigContents(null, null), null);
});

test("tempConfigContents: provider block only when only otel applies — no permission map", () => {
  const contents = tempConfigContents(undefined, otelProviderHeaders("anthropic/claude-sonnet-4", OC_OTEL));
  assert.deepEqual(contents, {
    provider: {
      anthropic: {
        options: {
          headers: { traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01" },
        },
      },
    },
  });
});

test("tempConfigContents: both blocks when tools are restricted AND otel+gateway are configured", () => {
  const contents = tempConfigContents(["bash", "read"], otelProviderHeaders("anthropic/claude-sonnet-4", OC_OTEL, OC_GATEWAY));
  assert.ok(contents && typeof contents === "object");
  assert.equal((contents as any).provider.anthropic.options.headers["x-correlation-id"], "adw_1");
  assert.equal((contents as any).provider.anthropic.options.headers["x-spf-agent"], "researcher");
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
    tempConfigContents(["bash"], otelProviderHeaders("anthropic/claude-sonnet-4", OC_OTEL, OC_GATEWAY))!,
  ) as any;
  assert.equal(merged.provider.anthropic.options.baseURL, "https://gw.internal/v1", "operator provider routing survives");
  assert.equal(merged.provider.anthropic.options.apiKey, "{env:KEY}", "operator credential reference survives");
  assert.equal(merged.provider.anthropic.options.headers["x-tenant"], "acme", "operator's own headers survive");
  assert.equal(merged.provider.anthropic.options.headers.traceparent, OC_OTEL.traceparent, "SPF's traceparent wins on conflict");
  assert.equal(merged.provider.anthropic.options.headers["x-correlation-id"], OC_GATEWAY.adwId, "SPF's x-correlation-id is added");
  assert.equal(merged.provider.anthropic.options.headers["x-spf-agent"], OC_GATEWAY.agentName);
  assert.equal("x-request-id" in merged.provider.anthropic.options.headers, false, "BLOCKER B: never sent again");
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

// ── 4. flue trace unification (#80) + gateway-header extension (MAJOR-D) ──
// The claim-loop-safe mechanism: flue's runtime executes submissions in one
// process-lifetime claim loop, so a dispatch-time context wrap would
// mis-attribute every agent after the first (documented in
// otel_propagation.ts's header). Instead the instrumentation's own
// resolveRootContext option is consulted PER root span; these tests
// exercise SPF's resolver against the really-registered global propagator
// (installed by section 2 above — same one-process ordering discipline).
// `GatewayHeadersPropagator` rides the SAME per-session registration, so
// these tests also cover it end to end (register -> resolve -> inject).

const FLUE_TP = "00-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-ffffffffffffffff-01";

test("resolveFlueRootContext: an unmapped session id resolves to undefined (flue roots its own separate trace — never MIS-attributed)", () => {
  assert.equal(resolveFlueRootContext({}, { id: "ses_unknown_session" }), undefined);
  assert.equal(resolveFlueRootContext({}, undefined), undefined, "absent ctx is a clean miss, not a throw");
  assert.equal(resolveFlueRootContext({}, {}), undefined, "ctx without an id is a clean miss");
});

test("register/resolve: a registered session's root spans extract SPF's deterministic agent-call span as the remote parent", () => {
  registerFlueSessionTrace("ses_agent_a", { traceparent: FLUE_TP });
  const resolved = resolveFlueRootContext({}, { id: "ses_agent_a" });
  assert.ok(resolved, "resolver returned a context");
  const sc = trace.getSpanContext(resolved);
  assert.ok(sc);
  assert.equal(sc.traceId, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "SPF's deterministic trace id");
  assert.equal(sc.spanId, "ffffffffffffffff", "the agent-call span id is the parent");
  assert.equal(sc.isRemote, true, "arrived as a remote parent, as a real cross-process extraction would");
  // A span started under the resolved context (flue's startSpan does exactly
  // this when its parentContext comes from resolveRootContext) lands in
  // SPF's trace, through the really-registered global provider.
  const span = context.with(resolved, () => trace.getTracer("otel-propagation-test-root").startSpan("chat some-model"));
  assert.equal(span.spanContext().traceId, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
  span.end();
  unregisterFlueSessionTrace("ses_agent_a");
});

test("resolveFlueRootContext: extraction is ROOT-based — an ambient active span (a leaked loop context) cannot poison the resolution", () => {
  registerFlueSessionTrace("ses_agent_b", { traceparent: FLUE_TP });
  const ambientTracer = trace.getTracer("otel-propagation-test-ambient");
  const ambientSpan = ambientTracer.startSpan("someone-else's-span");
  context.with(trace.setSpan(context.active(), ambientSpan), () => {
    const resolved = resolveFlueRootContext({}, { id: "ses_agent_b" });
    assert.ok(resolved);
    assert.equal(trace.getSpanContext(resolved)?.traceId, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "the REGISTERED traceparent wins, not the ambient span");
    assert.equal(trace.getSpanContext(resolved)?.spanId, "ffffffffffffffff");
  });
  ambientSpan.end();
  unregisterFlueSessionTrace("ses_agent_b");
});

test("resolveFlueRootContext: two concurrent sessions resolve to their OWN traceparents (per-session attribution, the fix the claim loop breaks for context-with)", () => {
  registerFlueSessionTrace("ses_agent_c1", { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" });
  registerFlueSessionTrace("ses_agent_c2", { traceparent: "00-33333333333333333333333333333333-4444444444444444-01" });
  assert.equal(trace.getSpanContext(resolveFlueRootContext({}, { id: "ses_agent_c1" })!)?.traceId, "11111111111111111111111111111111");
  assert.equal(trace.getSpanContext(resolveFlueRootContext({}, { id: "ses_agent_c2" })!)?.traceId, "33333333333333333333333333333333");
  unregisterFlueSessionTrace("ses_agent_c1");
  unregisterFlueSessionTrace("ses_agent_c2");
});

test("resolveFlueRootContext: malformed traceparent → undefined (degraded join, never an error); unregister stops resolution", () => {
  registerFlueSessionTrace("ses_agent_d", { traceparent: "00-junk-junk-01" });
  assert.equal(resolveFlueRootContext({}, { id: "ses_agent_d" }), undefined);
  unregisterFlueSessionTrace("ses_agent_d");

  registerFlueSessionTrace("ses_agent_e", { traceparent: FLUE_TP });
  unregisterFlueSessionTrace("ses_agent_e");
  assert.equal(resolveFlueRootContext({}, { id: "ses_agent_e" }), undefined, "finally-side unregister takes effect immediately");
});

// ── MAJOR-D: x-correlation-id/x-spf-agent ride the SAME per-session
// registration, injected at the SAME per-real-request point traceparent is.

test("register/resolve/inject: a session registered with adw_id/agent_name gets BOTH injected onto the SAME outbound carrier as traceparent — no x-request-id, ever", () => {
  registerFlueSessionTrace("ses_gateway_full", { traceparent: FLUE_TP, adwId: "adw_from_registration", agentName: "spec_writer" });
  const resolved = resolveFlueRootContext({}, { id: "ses_gateway_full" });
  assert.ok(resolved);

  const carrier: Record<string, string> = {};
  propagation.inject(resolved!, carrier);
  assert.equal(carrier["traceparent"], FLUE_TP, "the same real W3CTraceContextPropagator as every other test above");
  assert.equal(carrier[X_CORRELATION_ID_HEADER], "adw_from_registration");
  assert.equal(carrier[X_SPF_AGENT_HEADER], "spec_writer");
  assert.equal("x-request-id" in carrier, false, "BLOCKER B: never injected, by anything, ever again");
  unregisterFlueSessionTrace("ses_gateway_full");
});

test("register/resolve/inject: a registration with NO adw_id/agent_name injects traceparent only — nothing to correlate by, so nothing extra is invented", () => {
  registerFlueSessionTrace("ses_gateway_bare", { traceparent: FLUE_TP });
  const resolved = resolveFlueRootContext({}, { id: "ses_gateway_bare" });
  assert.ok(resolved);

  const carrier: Record<string, string> = {};
  propagation.inject(resolved!, carrier);
  assert.equal(carrier["traceparent"], FLUE_TP);
  assert.equal(X_CORRELATION_ID_HEADER in carrier, false);
  assert.equal(X_SPF_AGENT_HEADER in carrier, false);
  unregisterFlueSessionTrace("ses_gateway_bare");
});

test("register/resolve/inject: two concurrent sessions inject their OWN adw_id/agent_name — the MAJOR-D fix (was: whichever model id registered FIRST won forever)", () => {
  registerFlueSessionTrace("ses_gateway_x", { traceparent: "00-11111111111111111111111111111111-2222222222222222-01", adwId: "adw_x", agentName: "agent_x" });
  registerFlueSessionTrace("ses_gateway_y", { traceparent: "00-33333333333333333333333333333333-4444444444444444-01", adwId: "adw_y", agentName: "agent_y" });

  const carrierX: Record<string, string> = {};
  propagation.inject(resolveFlueRootContext({}, { id: "ses_gateway_x" })!, carrierX);
  const carrierY: Record<string, string> = {};
  propagation.inject(resolveFlueRootContext({}, { id: "ses_gateway_y" })!, carrierY);

  assert.equal(carrierX[X_CORRELATION_ID_HEADER], "adw_x");
  assert.equal(carrierX[X_SPF_AGENT_HEADER], "agent_x");
  assert.equal(carrierY[X_CORRELATION_ID_HEADER], "adw_y");
  assert.equal(carrierY[X_SPF_AGENT_HEADER], "agent_y");
  unregisterFlueSessionTrace("ses_gateway_x");
  unregisterFlueSessionTrace("ses_gateway_y");
});
