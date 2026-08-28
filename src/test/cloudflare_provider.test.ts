/**
 * Hermetic — never touches a live Cloudflare endpoint. These exercise Flue's
 * own in-process provider registry (via `@flue/runtime/internal`) plus this
 * module's accumulation/idempotence logic, the same surface
 * ollama_provider.test.ts covers for the sibling provider. The two
 * cloudflare-specific invariants a regression would silently break:
 *   1. SLASHED model ids — `@cf/zai-org/glm-5.3-flash` contains slashes, the
 *      one shape Ollama's tag ids never have. Flue's resolveModel must still
 *      split only on the FIRST slash and look the rest up verbatim, or every
 *      `cloudflare/@cf/...` dispatch throws "Unknown model ID".
 *   2. A REAL Bearer token (not a dummy key) — Cloudflare's API 401s on an
 *      empty Authorization header, so the resolver must surface a clear
 *      "CLOUDFLARE_API_TOKEN is not set" instead of ollama's placeholder.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { hasProvider, resetModelsForTests, resolveModel as flueResolveModel } from "@flue/runtime/internal";
import {
  providerForTest,
  registerCloudflareModel,
  resetCloudflareRegistrationForTest,
  cloudflareAiBaseUrl,
} from "../core/cloudflare_provider.js";

const ORIGINAL_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const ORIGINAL_BASE_URL = process.env.CLOUDFLARE_AI_BASE_URL;
const ORIGINAL_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT_ID = "abcd1234";
const TOKEN = "cf-test-token";

beforeEach(() => {
  resetCloudflareRegistrationForTest();
  resetModelsForTests();
  delete process.env.CLOUDFLARE_AI_BASE_URL;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_API_TOKEN;
  // A base URL + token are required before any registration can run — set
  // both so the happy-path tests don't each repeat the boilerplate. Tests
  // that exercise the missing-config error paths delete them again below.
  process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = TOKEN;
});

afterEach(() => {
  if (ORIGINAL_ACCOUNT_ID === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
  else process.env.CLOUDFLARE_ACCOUNT_ID = ORIGINAL_ACCOUNT_ID;
  if (ORIGINAL_BASE_URL === undefined) delete process.env.CLOUDFLARE_AI_BASE_URL;
  else process.env.CLOUDFLARE_AI_BASE_URL = ORIGINAL_BASE_URL;
  if (ORIGINAL_TOKEN === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
  else process.env.CLOUDFLARE_API_TOKEN = ORIGINAL_TOKEN;
});

test("cloudflareAiBaseUrl: built from CLOUDFLARE_ACCOUNT_ID when no explicit URL is set", () => {
  delete process.env.CLOUDFLARE_AI_BASE_URL;
  process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;
  assert.equal(cloudflareAiBaseUrl(), `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1`);
});

test("cloudflareAiBaseUrl: CLOUDFLARE_AI_BASE_URL overrides the account id and strips a trailing slash", () => {
  process.env.CLOUDFLARE_AI_BASE_URL = "https://example.com/ai/v1/";
  assert.equal(cloudflareAiBaseUrl(), "https://example.com/ai/v1");
});

test("cloudflareAiBaseUrl: undefined when neither account id nor base URL is set", () => {
  delete process.env.CLOUDFLARE_AI_BASE_URL;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  assert.equal(cloudflareAiBaseUrl(), undefined);
});

test("registerCloudflareModel: a slashed @cf/... id resolves through Flue's registry — pins the first-slash split invariant", async () => {
  await registerCloudflareModel("@cf/zai-org/glm-5.3-flash");

  assert.equal(hasProvider("cloudflare"), true);

  // Flue's resolveModel splits on the FIRST slash only: provider "cloudflare",
  // model id "@cf/zai-org/glm-5.3-flash". If it ever split on the LAST slash
  // (or rejected embedded slashes), this throws "Unknown model ID" — the
  // exact regression this test exists to catch.
  const resolved = flueResolveModel("cloudflare/@cf/zai-org/glm-5.3-flash");
  assert.equal(resolved.id, "@cf/zai-org/glm-5.3-flash");
  assert.equal(resolved.provider, "cloudflare");
  assert.equal(resolved.api, "openai-completions");
  // The model id sent in the request body is the FULL @cf/... string —
  // Workers AI keys off exactly that. A regression that trimmed the first
  // "@cf/" segment would dispatch the wrong model silently.
  assert.equal(resolved.baseUrl, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1`);
});

test("registerCloudflareModel: union accumulation — a second slashed id doesn't orphan the first", async () => {
  await registerCloudflareModel("@cf/zai-org/glm-5.3-flash");
  await registerCloudflareModel("@cf/meta/llama-3.1-8b-instruct");

  assert.equal(hasProvider("cloudflare"), true);
  // setProvider() REPLACES the whole provider (models list included) on every
  // call — the registeredIds union re-registration is what keeps the first id
  // resolvable after the second registers. Mirrors the ollama test's invariant.
  assert.equal(flueResolveModel("cloudflare/@cf/zai-org/glm-5.3-flash").id, "@cf/zai-org/glm-5.3-flash");
  assert.equal(flueResolveModel("cloudflare/@cf/meta/llama-3.1-8b-instruct").id, "@cf/meta/llama-3.1-8b-instruct");

  const idsOnProvider = providerForTest()!
    .getModels()
    .map((m) => m.id)
    .sort();
  assert.deepEqual(
    idsOnProvider,
    ["@cf/meta/llama-3.1-8b-instruct", "@cf/zai-org/glm-5.3-flash"],
    "the provider's own model list carries both ids, not just the latest",
  );
});

test("registerCloudflareModel: idempotent — re-registering a seen id is a no-op", async () => {
  await registerCloudflareModel("@cf/zai-org/glm-5.3-flash");
  await registerCloudflareModel("@cf/zai-org/glm-5.3-flash"); // must not throw / not re-register
  const idsOnProvider = providerForTest()!.getModels().map((m) => m.id);
  assert.equal(idsOnProvider.length, 1, "a repeat of an already-seen id adds nothing");
});

test("registerCloudflareModel: throws BEFORE registering when the base URL is unconfigured", async () => {
  delete process.env.CLOUDFLARE_AI_BASE_URL;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  await assert.rejects(
    () => registerCloudflareModel("@cf/zai-org/glm-5.3-flash"),
    /CLOUDFLARE_ACCOUNT_ID/,
    "the error names the env var, not pi-ai's generic 'No API key' message",
  );
  // And it must NOT have left a half-registered provider behind.
  assert.equal(hasProvider("cloudflare"), false);
});

test("registerCloudflareModel: throws BEFORE registering when CLOUDFLARE_API_TOKEN is unset", async () => {
  delete process.env.CLOUDFLARE_API_TOKEN;
  await assert.rejects(
    () => registerCloudflareModel("@cf/zai-org/glm-5.3-flash"),
    /CLOUDFLARE_API_TOKEN is not set/,
  );
  assert.equal(hasProvider("cloudflare"), false, "a missing token fails fast, leaving no provider registered");
});

test("registerCloudflareModel: the provider's auth resolver surfaces a clear error when the token is unset at resolve time", async () => {
  // Registered successfully WITH a token...
  await registerCloudflareModel("@cf/zai-org/glm-5.3-flash");
  const provider = providerForTest()!;
  // ...then the token is removed before a later dispatch would resolve it.
  delete process.env.CLOUDFLARE_API_TOKEN;
  const apiKeyEntry = provider.auth.apiKey;
  assert.ok(apiKeyEntry, "provider declares an apiKey auth entry");
  // pi-ai calls resolve() at dispatch time with an AuthContext; a missing
  // token there must name the env var, not 401 at the network — the whole
  // point of reading it fresh per request. The resolver ignores ctx (it has
  // no ambient lookups beyond process.env), so a minimal stand-in suffices.
  const fakeCtx = { env: async () => undefined, fileExists: async () => false } as never;
  await assert.rejects(() => apiKeyEntry.resolve({ ctx: fakeCtx }), /CLOUDFLARE_API_TOKEN is not set/);
});