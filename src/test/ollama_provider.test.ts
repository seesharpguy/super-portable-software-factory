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
} from "../core/ollama_provider.js";

// A minimal stand-in for pi-ai's `AuthContext` — our resolver ignores it
// entirely (it has no ambient env/file lookups to do), but the `resolve()`
// call site still needs something shaped right to pass.
const fakeAuthContext = { env: async () => undefined, fileExists: async () => false };

const ORIGINAL_BASE_URL = process.env.OLLAMA_BASE_URL;

beforeEach(() => {
  resetOllamaRegistrationForTest();
  resetModelsForTests();
  delete process.env.OLLAMA_BASE_URL;
});

afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = ORIGINAL_BASE_URL;
});

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

test("registerOllamaModel: idempotent for an already-registered id", async () => {
  await registerOllamaModel("model-a");
  const providerAfterFirst = providerForTest();

  await registerOllamaModel("model-a");

  assert.equal(providerForTest(), providerAfterFirst, "a repeat registration never calls setProvider again — same object identity");
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
