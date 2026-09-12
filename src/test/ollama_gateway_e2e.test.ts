/**
 * BLOCKER A / MAJOR-D, end to end: this file (unlike ollama_provider.test.ts
 * — see its own header) DELIBERATELY installs `otel_propagation.ts`'s real
 * flue propagation pipeline, so it needs its OWN process — Node's test
 * runner isolates by FILE (see otel_propagation.test.ts's own header), and
 * `isFluePropagationInstalled()` has no supported "uninstall" (only
 * `resetFluePropagationForTest()`, which forgets the flag but not the
 * actually-registered global TracerProvider/instrumentations — see that
 * function's own doc). Every test below therefore runs with propagation
 * INSTALLED; `ollama_provider.test.ts` covers the NOT INSTALLED path.
 *
 * The e2e test hits a REAL in-process http server (127.0.0.1, ephemeral
 * port) through the REAL pi-ai dispatch path this module builds
 * (`createProvider` + `auth.apiKey.resolve` + the OpenAI SDK's own client),
 * with `UndiciInstrumentation` actually registered — proving BLOCKER A's fix
 * holds for the whole real path, not just the two halves in isolation: ONE
 * `traceparent`, the right `x-correlation-id`/`x-spf-agent` (via
 * `registerFlueSessionTrace`+`resolveFlueRootContext`, run the way
 * `agent_flue.ts` actually runs them), and NEVER `x-request-id`.
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
import { installFluePropagation, registerFlueSessionTrace, resolveFlueRootContext, unregisterFlueSessionTrace } from "../core/otel_propagation.js";

const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const fakeAuthContext = { env: async () => undefined, fileExists: async () => false };

before(() => {
  // Real endpoint doesn't matter — nothing in these tests waits on a span
  // actually being exported, and the OTLP exporter fails silently (this
  // module's own contract: export can never affect or block a dispatch).
  installFluePropagation({ endpoint: "http://127.0.0.1:1/v1/traces", service_name: "spf-gateway-e2e-test" });
});

/** A minimal in-process HTTP server that records every request's headers and answers with a valid-enough OpenAI chat-completion body — no real network, no real Ollama. */
function startHeaderCaptureServer(): Promise<{ server: Server; url: string; requests: () => IncomingHttpHeaders[] }> {
  const captured: IncomingHttpHeaders[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      captured.push(req.headers);
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
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, requests: () => captured });
    });
  });
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

test("end-to-end: a real dispatch through the registered ollama provider, with propagation installed, carries EXACTLY ONE traceparent, the registered session's x-correlation-id/x-spf-agent, and NEVER x-request-id", async () => {
  resetOllamaRegistrationForTest();
  resetModelsForTests();
  const { server, url, requests } = await startHeaderCaptureServer();
  const originalBaseUrl = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = url;
  try {
    await registerOllamaModel("e2e-model");
    const model = providerForTest()!.getModels().find((m) => m.id === "e2e-model")!;
    assert.ok(model, "the model this test dispatches to must actually be registered");

    // Mirrors agent_flue.ts's run(): register this session's traceparent +
    // adw_id/agent_name, then dispatch WITHIN the resolved root context —
    // exactly the sequence GatewayHeadersPropagator/resolveFlueRootContext
    // are built to be driven by (see otel_propagation.ts's header).
    const sessionTraceparent = "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01";
    registerFlueSessionTrace("ses_e2e", { traceparent: sessionTraceparent, adwId: "adw_e2e_run", agentName: "e2e_agent" });
    try {
      const resolvedRootCtx = resolveFlueRootContext({}, { id: "ses_e2e" });
      assert.ok(resolvedRootCtx, "the session must resolve to a real root context for this test to prove anything");

      const models = createModels();
      models.setProvider(providerForTest()!);
      const piContext: PiContext = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

      await contextApi.with(resolvedRootCtx!, async () => {
        // A real span, as flue's own OpenTelemetry instrumentation would
        // create one for this session (parented under the resolved root) —
        // this is what makes the active context, at the moment the actual
        // HTTP call fires below, carry both the trace context AND the
        // gateway-call context `resolveFlueRootContext` attached.
        const span = traceApi.getTracer("ollama-gateway-e2e-test").startSpan("chat e2e-model");
        await contextApi.with(traceApi.setSpan(contextApi.active(), span), async () => {
          await models.complete(model, piContext, {});
        });
        span.end();
      });
    } finally {
      unregisterFlueSessionTrace("ses_e2e");
    }

    const captured = requests();
    assert.equal(captured.length, 1, "exactly one real HTTP request reached the stub server");
    const headers = captured[0]!;

    const traceparentValues = ([] as string[]).concat(headers["traceparent"] ?? []);
    assert.equal(traceparentValues.length, 1, `expected exactly ONE traceparent header on the wire, got ${traceparentValues.length}: ${JSON.stringify(traceparentValues)}`);
    assert.match(traceparentValues[0]!, TRACEPARENT_RE);

    assert.equal(headers["x-correlation-id"], "adw_e2e_run");
    assert.equal(headers["x-spf-agent"], "e2e_agent");
    assert.equal("x-request-id" in headers, false, "BLOCKER B: must never reach the wire, end to end");
  } finally {
    if (originalBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalBaseUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
