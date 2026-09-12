/**
 * Hermetic — never touches a live Ollama server. These exercise Flue's own
 * in-process provider registry (via `@flue/runtime/internal`) plus this
 * module's accumulation/idempotence logic, using synthetic model ids.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { hasProvider, resetModelsForTests, resolveModel as flueResolveModel } from "@flue/runtime/internal";
import {
  providerForTest,
  registerOllamaModel,
  resetOllamaRegistrationForTest,
  freshTraceparent,
  X_REQUEST_ID_HEADER,
} from "../core/ollama_provider.js";

// This file never calls `installFluePropagation` — `isFluePropagationInstalled()`
// stays false for its whole (isolated, per-file) process, so every test here
// exercises the NOT INSTALLED path: `resolve()` mints its own traceparent,
// and `registerOllamaModel`'s ctx is stamped onto `Model.headers` as static
// `x-correlation-id`/`x-spf-agent`. The INSTALLED-path tests (BLOCKER A) and
// the real end-to-end header capture live in `ollama_gateway_e2e.test.ts`,
// which DOES install propagation and so needs its own process.

// A minimal stand-in for pi-ai's `AuthContext` — our resolver ignores it
// entirely (it has no ambient env/file lookups to do), but the `resolve()`
// call site still needs something shaped right to pass.
const fakeAuthContext = { env: async () => undefined, fileExists: async () => false };

const ORIGINAL_BASE_URL = process.env.OLLAMA_BASE_URL;
const ORIGINAL_API_KEY = process.env.OLLAMA_API_KEY;

beforeEach(() => {
  resetOllamaRegistrationForTest();
  resetModelsForTests();
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_API_KEY;
});

afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = ORIGINAL_BASE_URL;
  if (ORIGINAL_API_KEY === undefined) delete process.env.OLLAMA_API_KEY;
  else process.env.OLLAMA_API_KEY = ORIGINAL_API_KEY;
});

// A well-formed W3C traceparent: `00-<32 hex>-<16 hex>-<2 hex>`.
const TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

test("registerOllamaModel: union accumulation — registering a second id doesn't orphan the first", async () => {
  await registerOllamaModel("model-a");
  await registerOllamaModel("model-b");

  assert.equal(hasProvider("ollama"), true);

  // `setProvider()` REPLACES the whole provider (models list included) on
  // every call. If this module regressed from "re-register the full union"
  // to "register just the newest id", model-a would throw "Unknown model
  // ID … for provider \"ollama\"" here — exactly the failure the spike hit
  // and the `registeredIds` Set exists to prevent.
  const a = flueResolveModel("ollama/model-a");
  const b = flueResolveModel("ollama/model-b");
  assert.equal(a.id, "model-a");
  assert.equal(b.id, "model-b");

  const idsOnProvider = providerForTest()!
    .getModels()
    .map((m) => m.id)
    .sort();
  assert.deepEqual(idsOnProvider, ["model-a", "model-b"], "the provider's own model list carries both ids, not just the latest");
});

test("registerOllamaModel: flue's registry resolves the SAME model object our provider registered — pins the pi-ai single-copy dedupe invariant", async () => {
  // package.json pins @earendil-works/pi-ai to the exact version
  // @flue/runtime depends on so npm dedupes to one physical copy — see that
  // pin's own comment for why. If a future dependency bump ever re-splits
  // that into two copies, `setProvider()`'s `Model`/`Provider` values would
  // stop being instances flue's OWN copy of pi-ai recognizes, and
  // `resolveModel()` would resolve to a DIFFERENT object than the one on
  // our provider — same string id, wrong identity. Reference equality here
  // is the one assertion that would actually catch that regression; a
  // structural `deepEqual` would keep passing right through it.
  await registerOllamaModel("model-a");

  const resolved = flueResolveModel("ollama/model-a");
  const onProvider = providerForTest()!.getModels().find((m) => m.id === "model-a");
  assert.equal(resolved, onProvider, "flue's registry and our provider must hand back the identical object, not merely an equal one");
});

test("registerOllamaModel: a repeat registration for an already-known id re-runs (MAJOR-D) — new Provider object, but the model list is unchanged", async () => {
  // Pre-fix behavior was "a repeat registration never calls setProvider
  // again" (verified via object identity); MAJOR-D's fix is exactly the
  // opposite of that for a good reason (see registerOllamaModel's own doc):
  // otherwise a model id's `x-correlation-id`/`x-spf-agent` would freeze at
  // whatever the FIRST caller supplied, forever, for every later agent/adw_id
  // that happens to share the same model id in one process.
  await registerOllamaModel("model-a");
  const providerAfterFirst = providerForTest();

  await registerOllamaModel("model-a");

  assert.notEqual(providerForTest(), providerAfterFirst, "a repeat registration DOES re-run setProvider now — a fresh Provider object");
  const idsOnProvider = providerForTest()!
    .getModels()
    .map((m) => m.id)
    .sort();
  assert.deepEqual(idsOnProvider, ["model-a"], "the model union itself is unaffected by a repeat of an id already in it");
});

test("registerOllamaModel(ctx): a repeat registration of the SAME id with a DIFFERENT ctx re-stamps its Model.headers — the MAJOR-D fix", async () => {
  await registerOllamaModel("model-a", { adwId: "adw_first", agentName: "agent_one" });
  let model = flueResolveModel("ollama/model-a");
  assert.deepEqual(model.headers, { "x-correlation-id": "adw_first", "x-spf-agent": "agent_one" });

  await registerOllamaModel("model-a", { adwId: "adw_second", agentName: "agent_two" });
  model = flueResolveModel("ollama/model-a");
  assert.deepEqual(
    model.headers,
    { "x-correlation-id": "adw_second", "x-spf-agent": "agent_two" },
    "the SECOND registration's ctx wins — a prior version silently kept the FIRST caller's headers forever",
  );
});

test("registerOllamaModel: concurrent calls for the same new id both resolve to one registration, not a second no-op", async () => {
  // Regression guard for committing to `registeredIds` before `setProvider`
  // finishes: if the second call saw the id "already registered" before
  // the first call's registration actually completed, it would resolve
  // immediately with nothing registered yet, and a caller awaiting it could
  // start dispatching before `setProvider()` ran.
  const [a, b] = await Promise.all([registerOllamaModel("model-c"), registerOllamaModel("model-c")]);
  assert.equal(a, undefined);
  assert.equal(b, undefined);

  const model = flueResolveModel("ollama/model-c");
  assert.equal(model.id, "model-c");
});

test("registerOllamaModel: defaults to http://localhost:11434/v1 when OLLAMA_BASE_URL is unset", async () => {
  await registerOllamaModel("model-a");

  const model = flueResolveModel("ollama/model-a");
  assert.equal(model.baseUrl, "http://localhost:11434/v1");
  assert.equal(providerForTest()!.baseUrl, "http://localhost:11434/v1");
});

test("registerOllamaModel: OLLAMA_BASE_URL override is respected", async () => {
  process.env.OLLAMA_BASE_URL = "http://example-ollama-host:9999/v1";

  await registerOllamaModel("model-a");

  const model = flueResolveModel("ollama/model-a");
  assert.equal(model.baseUrl, "http://example-ollama-host:9999/v1");
  assert.equal(providerForTest()!.baseUrl, "http://example-ollama-host:9999/v1");
});

test("registerOllamaModel: registered models carry contextWindow 0 (disables threshold compaction)", async () => {
  await registerOllamaModel("model-a");
  const model = flueResolveModel("ollama/model-a");
  assert.equal(model.contextWindow, 0);
});

test("registerOllamaModel: auth.apiKey resolves a truthy dummy key, never the upstream 'No API key' failure", async () => {
  await registerOllamaModel("model-a");

  const apiKeyAuth = providerForTest()!.auth.apiKey;
  assert.ok(apiKeyAuth, "auth.apiKey must be present — pi-ai requires at least one of apiKey/oauth even for a keyless provider");

  const resolved = await apiKeyAuth!.resolve({ ctx: fakeAuthContext, credential: undefined });
  assert.ok(resolved, "resolve() must report the provider as configured, not 'unconfigured'");
  assert.ok(
    typeof resolved!.auth.apiKey === "string" && resolved!.auth.apiKey.length > 0,
    "the resolved apiKey must be a non-empty string — a falsy one is exactly what pi-ai's getClientApiKey() throws on at dispatch",
  );
});

// ── (0) OLLAMA_API_KEY honored, dummy retained as fallback ─────────────────

test("auth.apiKey.resolve: OLLAMA_API_KEY unset -> the dummy placeholder, unchanged from before this feature existed", async () => {
  await registerOllamaModel("model-a");
  const resolved = await providerForTest()!.auth.apiKey!.resolve({ ctx: fakeAuthContext, credential: undefined });
  assert.equal(resolved!.auth.apiKey, "ollama-local-unused");
});

test("auth.apiKey.resolve: OLLAMA_API_KEY set -> the bearer equals it, not the dummy", async () => {
  process.env.OLLAMA_API_KEY = "briefs-gateway-client-key-123";
  await registerOllamaModel("model-a");
  const resolved = await providerForTest()!.auth.apiKey!.resolve({ ctx: fakeAuthContext, credential: undefined });
  assert.equal(resolved!.auth.apiKey, "briefs-gateway-client-key-123");
});

test("auth.apiKey.resolve: OLLAMA_API_KEY is trimmed, and blank/whitespace-only still falls back to the dummy", async () => {
  process.env.OLLAMA_API_KEY = "  padded-key  ";
  await registerOllamaModel("model-a");
  let resolved = await providerForTest()!.auth.apiKey!.resolve({ ctx: fakeAuthContext, credential: undefined });
  assert.equal(resolved!.auth.apiKey, "padded-key");

  resetOllamaRegistrationForTest();
  resetModelsForTests();
  process.env.OLLAMA_API_KEY = "   ";
  await registerOllamaModel("model-b");
  resolved = await providerForTest()!.auth.apiKey!.resolve({ ctx: fakeAuthContext, credential: undefined });
  assert.equal(resolved!.auth.apiKey, "ollama-local-unused", "whitespace-only is treated as unset");
});

test("auth.apiKey.resolve: reads OLLAMA_API_KEY fresh — set AFTER registration still takes effect on the next dispatch, no re-registration needed", async () => {
  await registerOllamaModel("model-a"); // registers with the var still unset
  process.env.OLLAMA_API_KEY = "set-after-registration";
  const resolved = await providerForTest()!.auth.apiKey!.resolve({ ctx: fakeAuthContext, credential: undefined });
  assert.equal(resolved!.auth.apiKey, "set-after-registration");
});

// ── (3a) freshTraceparent: per-call, well-formed, no x-request-id ──────────

test("freshTraceparent: well-formed W3C traceparent (00-<32 hex>-<16 hex>-<2 hex>), no active OTel span installed", () => {
  const tp = freshTraceparent();
  assert.match(tp, TRACEPARENT_RE);
});

test("freshTraceparent: two consecutive calls produce two DIFFERENT, both well-formed traceparents", () => {
  const first = freshTraceparent();
  const second = freshTraceparent();
  assert.match(first, TRACEPARENT_RE);
  assert.match(second, TRACEPARENT_RE);
  assert.notEqual(first, second, "each call must mint a fresh id pair, not reuse a cached one");
});

test("auth.apiKey.resolve: NOT INSTALLED — two consecutive resolves (one per simulated dispatch) carry two different, well-formed traceparents", async () => {
  await registerOllamaModel("model-a");
  const apiKeyAuth = providerForTest()!.auth.apiKey!;
  const first = await apiKeyAuth.resolve({ ctx: fakeAuthContext, credential: undefined });
  const second = await apiKeyAuth.resolve({ ctx: fakeAuthContext, credential: undefined });
  const tp1 = first!.auth.headers!["traceparent"]!;
  const tp2 = second!.auth.headers!["traceparent"]!;
  assert.match(tp1, TRACEPARENT_RE);
  assert.match(tp2, TRACEPARENT_RE);
  assert.notEqual(tp1, tp2, "resolve() must mint a fresh traceparent on every dispatch, not cache one at registration time");
  assert.equal(X_REQUEST_ID_HEADER in first!.auth.headers!, false, "resolve() must never set x-request-id");
  assert.equal("x-correlation-id" in first!.auth.headers!, false, "resolve() never sets these either — they ride Model.headers instead");
  assert.equal("x-spf-agent" in first!.auth.headers!, false);
});

// ── registerOllamaModel(modelId, ctx): static x-correlation-id/x-spf-agent per Model ──
// (NOT INSTALLED path only — see this file's header. The INSTALLED path,
// where these two come from GatewayHeadersPropagator instead and Model.headers
// must stay empty to avoid a duplicate, lives in ollama_gateway_e2e.test.ts.)

test("registerOllamaModel(ctx): stamps x-correlation-id/x-spf-agent onto the model's static headers", async () => {
  await registerOllamaModel("model-a", { adwId: "adw_abc", agentName: "researcher" });
  const model = flueResolveModel("ollama/model-a");
  assert.deepEqual(model.headers, { "x-correlation-id": "adw_abc", "x-spf-agent": "researcher" });
  assert.equal("traceparent" in (model.headers ?? {}), false, "traceparent is per-call, not baked into the static Model");
});

test("registerOllamaModel: no ctx (or an empty one) -> no `headers` field at all, byte-identical to before this feature existed", async () => {
  await registerOllamaModel("model-a");
  const model = flueResolveModel("ollama/model-a");
  assert.equal(model.headers, undefined);
});

test("registerOllamaModel(ctx): a union re-registration (a second, new model id) keeps the FIRST id's original static headers", async () => {
  await registerOllamaModel("model-a", { adwId: "adw_first", agentName: "agent_one" });
  await registerOllamaModel("model-b", { adwId: "adw_second", agentName: "agent_two" });

  const a = flueResolveModel("ollama/model-a");
  const b = flueResolveModel("ollama/model-b");
  assert.deepEqual(a.headers, { "x-correlation-id": "adw_first", "x-spf-agent": "agent_one" }, "model-a keeps what it was FIRST registered with");
  assert.deepEqual(b.headers, { "x-correlation-id": "adw_second", "x-spf-agent": "agent_two" });
});

// `withGatewayHeaders`/`gatewayHeaders` are DELETED (MAJOR-E, YAGNI): unused
// in the live dispatch path — Flue's `useModel()` exposes no per-call
// fetch/headers hook (`@flue/runtime`'s public `UseModelOptions` is just
// `{thinkingLevel?, compaction?}`), so there was never a real call site for
// a fetch-wrapper primitive, only tests of the primitive itself. Deleted
// along with their tests rather than fixed, per that finding.
