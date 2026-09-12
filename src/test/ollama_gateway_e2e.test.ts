/**
 * BLOCKER A / MAJOR-D / BLOCKER 1, end to end: this file (unlike
 * ollama_provider.test.ts — see its own header) DELIBERATELY installs
 * `otel_propagation.ts`'s real flue propagation pipeline, so it needs its
 * OWN process — Node's test runner isolates by FILE (see
 * otel_propagation.test.ts's own header), and `isFluePropagationInstalled()`
 * has no supported "uninstall" (only `resetFluePropagationForTest()`, which
 * forgets the flag but not the actually-registered global
 * TracerProvider/instrumentations — see that function's own doc). Every
 * test below therefore runs with propagation INSTALLED;
 * `ollama_provider.test.ts` covers the NOT INSTALLED path.
 *
 * The e2e test hits a REAL in-process http server (127.0.0.1, ephemeral
 * port) through the REAL pi-ai dispatch path this module builds
 * (`createProvider` + `auth.apiKey.resolve` + the OpenAI SDK's own client),
 * with `UndiciInstrumentation` actually registered — proving BLOCKER A's fix
 * holds for the whole real path, not just the two halves in isolation: ONE
 * `traceparent`, the right `x-correlation-id`/`x-spf-agent` (via
 * `registerFlueSessionTrace` + `GatewayHeadersPropagator`'s trace-id lookup,
 * run the way `agent_flue.ts` actually runs them), and NEVER `x-request-id`.
 *
 * BLOCKER 1 HONESTY FIX: a prior version of the e2e test below drove the
 * dispatch as `contextApi.with(resolvedRootCtx, async () => { ... })` —
 * i.e. it made the context `resolveFlueRootContext` returned the ACTIVE
 * one. Production never does that (verified against `@flue/opentelemetry`'s
 * own dist, index.mjs:361 + :329 — see otel_propagation.ts's module header):
 * that resolved context is used ONLY as `tracer.startSpan`'s parent
 * argument; the context actually activated around the real dispatch is a
 * NEW one built from `context.active()` (not `resolvedRootCtx`) plus the
 * freshly started span. The old test's `contextApi.with(resolvedRootCtx,
 * ...)` therefore exercised a code path production never takes, and passed
 * even while the real BLOCKER 1 bug (`x-correlation-id`/`x-spf-agent`
 * ABSENT on a real dispatch) was live — confirmed with
 * `scratchpad/probe_installed_real.mjs`, which reproduces flue's exact
 * two-line sequence and printed ABSENT for both before the fix. The
 * rewritten test below reproduces that exact two-line sequence instead.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { context as contextApi, trace as traceApi } from "@opentelemetry/api";
import { createModels } from "@earendil-works/pi-ai";
import type { Context as PiContext } from "@earendil-works/pi-ai";
import { resetModelsForTests } from "@flue/runtime/internal";
import { providerForTest, registerOllamaModel, resetOllamaRegistrationForTest } from "../core/ollama_provider.js";
import { installFluePropagation, registerFlueSessionTrace, resolveFlueRootContext, resetGatewayFallbackForTest, unregisterFlueSessionTrace } from "../core/otel_propagation.js";

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const fakeAuthContext = { env: async () => undefined, fileExists: async () => false };

before(() => {
  // Real endpoint doesn't matter — nothing in these tests waits on a span
  // actually being exported, and the OTLP exporter fails silently (this
  // module's own contract: export can never affect or block a dispatch).
  installFluePropagation({ endpoint: "http://127.0.0.1:1/v1/traces", service_name: "spf-gateway-e2e-test" });
});

/**
 * A minimal in-process HTTP server that records every request's headers —
 * both Node's own merged `req.headers` (which COMMA-JOINS a header sent
 * twice, e.g. `"a, b"`, hiding the duplication) and the raw `req.rawHeaders`
 * line-pair array (which does not — see `scratchpad/probe_duplicate_header.mjs`,
 * confirmed live against this exact server) — and answers with a valid-enough
 * OpenAI chat-completion body. No real network, no real Ollama.
 */
function startHeaderCaptureServer(): Promise<{
  server: Server;
  url: string;
  requests: () => IncomingHttpHeaders[];
  rawRequests: () => string[][];
}> {
  const captured: IncomingHttpHeaders[] = [];
  const rawCaptured: string[][] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      captured.push(req.headers);
      rawCaptured.push(req.rawHeaders);
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            created: 0,
            model: "test",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, requests: () => captured, rawRequests: () => rawCaptured });
    });
  });
}

/** Counts how many raw header LINES (not merged/comma-joined values) name `headerName`, case-insensitively — `req.rawHeaders` is `[name, value, name, value, ...]`. */
function rawHeaderOccurrences(rawHeaders: string[], headerName: string): number {
  let count = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]!.toLowerCase() === headerName) count++;
  }
  return count;
}

/**
 * Mirrors `@flue/opentelemetry`'s EXACT root-span sequence (dist/index.mjs:361
 * for the parent resolution, :329 for the interceptor that activates the
 * span) — see this file's module doc for why the resolved context itself
 * must NEVER be the one made active. `resolveFlueRootContext`'s return value
 * is consulted ONLY as `startSpan`'s parent argument.
 */
function startFlueStyleSpan(sessionId: string, spanName: string): { span: ReturnType<ReturnType<typeof traceApi.getTracer>["startSpan"]>; parentContext: ReturnType<typeof contextApi.active> | undefined } {
  const activeContext = contextApi.active();
  const parentContext = traceApi.getSpanContext(activeContext) ? activeContext : resolveFlueRootContext({}, { id: sessionId });
  const span = traceApi.getTracer("ollama-gateway-e2e-test").startSpan(spanName, { root: parentContext === undefined }, parentContext);
  return { span, parentContext };
}

test("auth.apiKey.resolve: INSTALLED — resolve() sets no headers at all (traceparent comes from the instrumentation instead, at the real dispatch)", async () => {
  resetOllamaRegistrationForTest();
  resetModelsForTests();
  await registerOllamaModel("model-installed");
  const resolved = await providerForTest()!.auth.apiKey!.resolve({ ctx: fakeAuthContext, credential: undefined });
  assert.ok(resolved, "still reports the provider as configured");
  assert.equal(resolved!.auth.headers, undefined, "BLOCKER A: no traceparent minted here when propagation is installed — would double up with the instrumentation's own injection");
});

test("registerOllamaModel(ctx): INSTALLED — Model.headers carries NO static x-correlation-id/x-spf-agent (would double up with GatewayHeadersPropagator's per-request injection)", async () => {
  resetOllamaRegistrationForTest();
  resetModelsForTests();
  await registerOllamaModel("model-installed-ctx", { adwId: "adw_should_not_appear_statically", agentName: "should_not_appear_statically" });
  const model = providerForTest()!.getModels().find((m) => m.id === "model-installed-ctx");
  assert.equal(model?.headers, undefined);
});

test("end-to-end (BLOCKER 1, honest flue mechanics): a real dispatch through the registered ollama provider, with propagation installed, carries EXACTLY ONE traceparent whose trace id is SPF's registered one, the registered session's x-correlation-id/x-spf-agent, and NEVER x-request-id", async () => {
  resetOllamaRegistrationForTest();
  resetModelsForTests();
  resetGatewayFallbackForTest();
  const { server, url, requests, rawRequests } = await startHeaderCaptureServer();
  const originalBaseUrl = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = url;
  try {
    await registerOllamaModel("e2e-model");
    const model = providerForTest()!.getModels().find((m) => m.id === "e2e-model")!;
    assert.ok(model, "the model this test dispatches to must actually be registered");

    // Mirrors agent_flue.ts's run(): register this session's traceparent +
    // adw_id/agent_name, then dispatch. Deliberately DOES NOT wrap the
    // dispatch in `contextApi.with(resolvedRootCtx, ...)` — that is the
    // dishonest shape a prior version of this test used (see this file's
    // module doc). `resolveFlueRootContext`'s return value is consulted
    // ONLY as `startSpan`'s parent, via `startFlueStyleSpan` below —
    // reproducing @flue/opentelemetry's dist/index.mjs:361 + :329 verbatim.
    const sessionTraceparent = "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01";
    registerFlueSessionTrace("ses_e2e", { traceparent: sessionTraceparent, adwId: "adw_e2e_run", agentName: "e2e_agent" });
    try {
      const { span, parentContext } = startFlueStyleSpan("ses_e2e", "chat e2e-model");
      assert.ok(parentContext, "the session must resolve to a real root context for this test to prove anything");

      const models = createModels();
      models.setProvider(providerForTest()!);
      const piContext: PiContext = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

      // dist/index.mjs:329's interceptor, verbatim: activate a context built
      // from `context.active()` + the new span — NEVER `parentContext`
      // itself. This is the only context active at the moment the real HTTP
      // call fires below.
      await contextApi.with(traceApi.setSpan(contextApi.active(), span), async () => {
        await models.complete(model, piContext, {});
      });
      span.end();
    } finally {
      unregisterFlueSessionTrace("ses_e2e");
    }

    const captured = requests();
    assert.equal(captured.length, 1, "exactly one real HTTP request reached the stub server");
    const headers = captured[0]!;
    const rawHeaders = rawRequests()[0]!;

    const traceparentValues = ([] as string[]).concat(headers["traceparent"] ?? []);
    assert.equal(traceparentValues.length, 1, `expected exactly ONE traceparent header on the wire, got ${traceparentValues.length}: ${JSON.stringify(traceparentValues)}`);
    assert.match(traceparentValues[0]!, TRACEPARENT_RE);
    assert.equal(traceparentValues[0]!.split("-")[1], "cccccccccccccccccccccccccccccccc", "the span's trace id is SPF's registered deterministic one, not a fresh random root");

    assert.equal(headers["x-correlation-id"], "adw_e2e_run");
    assert.equal(headers["x-spf-agent"], "e2e_agent");
    assert.equal("x-request-id" in headers, false, "BLOCKER B: must never reach the wire, end to end");

    // MAJOR/duplicate-header check: exactly one raw header LINE for each —
    // proves GatewayHeadersPropagator is the SOLE source (Model.headers
    // carried nothing here since `registerOllamaModel("e2e-model")` above
    // was called with no ctx at all).
    assert.equal(rawHeaderOccurrences(rawHeaders, "x-correlation-id"), 1);
    assert.equal(rawHeaderOccurrences(rawHeaders, "x-spf-agent"), 1);
    assert.equal(rawHeaderOccurrences(rawHeaders, "traceparent"), 1);
  } finally {
    if (originalBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalBaseUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("end-to-end (no duplicate headers): registerOllamaModel(ctx) is ALSO called with adw_id/agent_name (as agent_flue.ts always passes them — see data_types.ts's AgentRequest.adw_id doc) while propagation is installed; the wire still carries exactly ONE x-correlation-id/x-spf-agent, from the propagator, never doubled with a static Model.headers value", async () => {
  resetOllamaRegistrationForTest();
  resetModelsForTests();
  resetGatewayFallbackForTest();
  const { server, url, rawRequests } = await startHeaderCaptureServer();
  const originalBaseUrl = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = url;
  try {
    // Exactly what agent_flue.ts's run() does: register with a ctx that
    // carries adw_id/agent_name EVEN THOUGH propagation is installed (it
    // always passes both — see ollama_provider.ts's registerOllamaModel
    // call site in agent_flue.ts). This is the case that would double up
    // the headers if modelFor() ALSO stamped them statically.
    await registerOllamaModel("e2e-model-dup-check", { adwId: "adw_should_not_be_static", agentName: "should_not_be_static" });
    const model = providerForTest()!.getModels().find((m) => m.id === "e2e-model-dup-check")!;
    assert.equal(model.headers, undefined, "static headers must stay suppressed while propagation is installed — the propagator is the sole source");

    const sessionTraceparent = "00-cccccccccccccccccccccccccccccccc-1111111111111111-01";
    registerFlueSessionTrace("ses_dup", { traceparent: sessionTraceparent, adwId: "adw_from_propagator", agentName: "agent_from_propagator" });
    try {
      const { span, parentContext } = startFlueStyleSpan("ses_dup", "chat e2e-model-dup-check");
      assert.ok(parentContext);
      const models = createModels();
      models.setProvider(providerForTest()!);
      const piContext: PiContext = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };
      await contextApi.with(traceApi.setSpan(contextApi.active(), span), async () => {
        await models.complete(model, piContext, {});
      });
      span.end();
    } finally {
      unregisterFlueSessionTrace("ses_dup");
    }

    const rawHeaders = rawRequests()[0]!;
    assert.equal(rawHeaderOccurrences(rawHeaders, "x-correlation-id"), 1, "exactly one raw header line — never two");
    assert.equal(rawHeaderOccurrences(rawHeaders, "x-spf-agent"), 1);
    // And it's the propagator's identity (from the session registration),
    // not the registerOllamaModel ctx — proving the propagator really is
    // the sole source, not a lucky coincidence of both agreeing.
    const merged = rawRequests()[0]!;
    const idx = merged.findIndex((v) => v.toLowerCase() === "x-correlation-id");
    assert.equal(merged[idx + 1], "adw_from_propagator");
  } finally {
    if (originalBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalBaseUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
