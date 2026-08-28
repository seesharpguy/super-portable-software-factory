/**
 * Cloudflare Workers AI registration for the Flue backend (agent_flue.ts).
 *
 * A sibling of ollama_provider.ts — read that file first; only the deltas are
 * documented here. Neither pi-ai nor Flue ships a built-in "cloudflare"
 * provider on Node (the `cloudflare` provider id exists ONLY inside a
 * Cloudflare Worker's own runtime, where a generated Workers AI binding
 * registers it — see `@flue/runtime`'s providers module: "On Cloudflare,
 * registering a `cloudflare` provider in `app.ts` takes precedence over the
 * generated Workers AI binding default"). In a plain Node process (spf is a
 * Node CLI), there is no such binding, so we register our own against the
 * same OpenAI-compatible surface Ollama uses.
 *
 * Workers AI's OpenAI-compatible endpoint is served under
 *   https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1
 * (the `/v1/chat/completions` the OpenAI SDK appends to `baseURL` is exactly
 * what Workers AI speaks — verified against developers.cloudflare.com/ai).
 * Auth is a real Bearer token (`CLOUDFLARE_API_TOKEN`), NOT a dummy: unlike
 * a local keyless Ollama server, Cloudflare's API rejects an empty/wrong
 * Authorization header with HTTP 401, so the placeholder-key trick
 * ollama_provider.ts uses would surface as a 401 at the first dispatch
 * instead of a clear "set CLOUDFLARE_API_TOKEN" message.
 *
 * pi-ai's `openai-completions` api constructs the HTTP client with the
 * official `OpenAI` SDK (`new OpenAI({ apiKey, baseURL })`), which sends
 * `Authorization: Bearer <apiKey>` and `params.model = model.id` in the
 * body — both exactly what Workers AI expects. Its `detectCompat` ALSO has
 * first-class Workers AI handling keyed off the base URL
 * (`isCloudflareWorkersAI = ... || baseUrl.includes("api.cloudflare.com")`),
 * so registering under provider id `"cloudflare"` (not pi-ai's internal
 * `"cloudflare-workers-ai"`) still activates the right transport compat
 * (no `store`, `max_completion_tokens`, no long cache retention) via the
 * URL match. Using `"cloudflare"` matches the provider id Flue's own docs
 * reserve for the Workers AI override, and keeps the model string short
 * (`cloudflare/@cf/...`).
 *
 * SLASHED MODEL IDS — Workers AI model ids contain slashes
 * (`@cf/zai-org/glm-5.3-flash`), which is unusual for Flue's
 * `provider/model-id` format. Verified against `@flue/runtime`'s own
 * `resolveModel`: it splits on the FIRST slash only (`providerId =
 * slice(0, slash)`, `modelId = slice(slash+1)`), then does an exact
 * `models.getModel(providerId, modelId)` lookup — so
 * `cloudflare/@cf/zai-org/glm-5.3-flash` resolves provider `cloudflare`,
 * model id `@cf/zai-org/glm-5.3-flash`, and matches a model registered
 * with exactly that `id`. No special-casing needed; the hermetic test in
 * cloudflare_provider.test.ts pins this so a future Flue rewrite that
 * changed the split would fail loudly here, not at a user's first run.
 *
 * REASONING / CONTEXT WINDOW — `reasoning: false` and `contextWindow: 0`
 * mirror ollama_provider.ts's stance for a self-served, arbitrary-model
 * endpoint: Workers AI's catalog has no single reliable per-model context
 * window, and the zai/glm thinking-format params pi-ai would emit for a
 * `reasoning: true` model (`thinking: {type: ...}`, `reasoning_effort`)
 * are the zai *direct* API's params, not guaranteed to be honored through
 * Workers AI's OpenAI-compatible surface. Disabled keeps spf's behavior
 * identical to the ollama case (the agent's `thinking:` level is moot) and
 * avoids fabricating metadata Workers AI's API doesn't actually provide.
 */

import type { CreateProviderOptions, Model, Provider } from "@earendil-works/pi-ai";

/**
 * The Workers AI OpenAI-compatible base URL. Resolution order, matching
 * ollama_provider.ts's `ollamaBaseUrl()` "fresh per registration" read:
 *
 *   1. `CLOUDFLARE_AI_BASE_URL` — an explicit full URL (gateway, a custom
 *      domain, an AI Gateway endpoint). Takes precedence so a power user
 *      can redirect without touching the account id.
 *   2. `https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1`
 *      — the standard shape, constructed from the account id.
 *
 * Returns `undefined` when NEITHER is set: unlike Ollama, a hosted
 * Cloudflare endpoint has no sensible localhost default to fall back to —
 * silently synthesizing one would misroute real dispatches. Callers
 * (registerCloudflareModel, doctor's probe) treat `undefined` as
 * "unconfigured, report it" rather than guessing.
 */
export function cloudflareAiBaseUrl(): string | undefined {
  const explicit = (process.env.CLOUDFLARE_AI_BASE_URL ?? "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  if (accountId) return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
  return undefined;
}

/**
 * The Bearer token Workers AI expects. `CLOUDFLARE_API_TOKEN` is the env
 * var name spf already uses for its Cloudflare *sandbox* backend
 * (data_types.ts's SandboxCloudflareSchema.api_token_env) — reusing it here
 * means one token serves both a Workers AI model provider AND a Cloudflare
 * sandbox in the same repo, and a user who already set it for the sandbox
 * gets the model provider for free. Read fresh per request (the resolver
 * runs at dispatch time), matching ollama_provider.ts's per-call base URL
 * read.
 */
function cloudflareApiToken(): string {
  const token = (process.env.CLOUDFLARE_API_TOKEN ?? "").trim();
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN is not set — required to authenticate Cloudflare Workers AI (get one at https://dash.cloudflare.com/profile/api-tokens, with the Workers AI > Read permission)");
  return token;
}

// Advisory only — same role as ollama_provider.ts's DEFAULT_MAX_TOKENS:
// feeds Flue's compaction-reserve sizing, moot since `contextWindow: 0`
// below disables threshold compaction. Workers AI's OpenAI-compatible
// surface accepts `max_completion_tokens` (the field pi-ai picks for this
// provider — detectCompat's `useMaxTokens` does NOT include Workers AI, so
// `max_completion_tokens`, not `max_tokens`), and the per-model hard cap
// varies; kept generous.
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Every `cloudflare/<id>` model id a `registerCloudflareModel` call has
 * ever SUCCEEDED in registering, in call order. `setProvider()` REPLACES
 * the named provider's entire model list on every call (not additive), so
 * this Set is what lets each call re-register the FULL union instead of
 * just the newest id — the same invariant ollama_provider.ts's
 * `registeredIds` exists to preserve. Without it: register
 * `@cf/zai-org/glm-5.3-flash`, then `@cf/meta/llama-3.1-8b-instruct`, and
 * the first becomes an "Unknown model ID" at its next dispatch.
 */
const registeredIds = new Set<string>();

// Registrations currently in flight, keyed by model id — same join semantics
// as ollama_provider.ts's `inflight`: a second caller for the SAME id that
// arrives before the first `await` resolves joins that in-progress
// registration instead of returning with nothing registered yet.
const inflight = new Map<string, Promise<void>>();

// The most recently constructed provider object — test-only, same reason
// as ollama_provider.ts's `lastProvider` (Flue exports no `getProvider`).
let lastProvider: Provider<"openai-completions"> | undefined;

function modelFor(id: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "cloudflare",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Disables Flue's threshold-based compaction — same convention as
    // ollama_provider.ts: no reliable per-model context window across
    // Workers AI's catalog, and agent_flue.ts already treats 0 as
    // "unknown, don't compact".
    contextWindow: 0,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

/**
 * Registers `modelId` (the part after `cloudflare/` in an agent's `model`
 * config — e.g. `@cf/zai-org/glm-5.3-flash`) with Flue's provider registry,
 * alongside every other `cloudflare/*` id ever registered this process.
 * Idempotent and concurrency-safe in exactly the ways
 * ollama_provider.ts's `registerOllamaModel` is — see that function's doc;
 * the `registeredIds`-after-`setProvider` ordering, the `inflight` join,
 * and the dynamic-import boundary are all identical and kept identical on
 * purpose (one OpenAI-compatible self-registration pattern across both).
 *
 * Throws BEFORE touching Flue's registry if the base URL or API token is
 * unconfigured — a clearer failure than letting `setProvider()` succeed
 * and surfacing a 401 / "No API key for provider: cloudflare" at the first
 * real dispatch.
 */
export async function registerCloudflareModel(modelId: string): Promise<void> {
  if (registeredIds.has(modelId)) return;
  const existing = inflight.get(modelId);
  if (existing) return existing;

  const baseUrl = cloudflareAiBaseUrl();
  if (!baseUrl) {
    throw new Error(
      "Cloudflare Workers AI base URL is not configured — set CLOUDFLARE_ACCOUNT_ID (for the standard https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1 endpoint) or CLOUDFLARE_AI_BASE_URL (for a custom/AI Gateway endpoint)",
    );
  }
  // Eagerly resolve the token too: a missing token throws here, before
  // setProvider(), so the error names the env var rather than arriving as
  // pi-ai's generic "No API key for provider: cloudflare" at dispatch.
  cloudflareApiToken();

  const promise = (async () => {
    // Same lazy-import rationale as ollama_provider.ts: keeps this module's
    // cloudflare-only symbols (especially the deep `openai-completions.lazy`
    // subpath) off the module graph of anything that imports agent_flue.ts
    // for `resolveModel()` alone (doctor.ts, interview.ts) without ever
    // dispatching a cloudflare call.
    const [{ createProvider }, { openAICompletionsApi }, { setProvider }] = await Promise.all([
      import("@earendil-works/pi-ai"),
      import("@earendil-works/pi-ai/api/openai-completions.lazy"),
      import("@flue/runtime/internal"),
    ]);

    const ids = new Set(registeredIds);
    ids.add(modelId);
    const models = [...ids].map((id) => modelFor(id, baseUrl));

    const options: CreateProviderOptions<"openai-completions"> = {
      id: "cloudflare",
      name: "Cloudflare Workers AI",
      baseUrl,
      auth: {
        apiKey: {
          name: "CLOUDFLARE_API_TOKEN",
          // Read fresh per dispatch (per pi-ai's resolve() contract), so a
          // token set AFTER the first registration still works for the next
          // dispatch without re-registering. Throws a clear message if
          // unset — see cloudflareApiToken()'s doc.
          resolve: async () => ({ auth: { apiKey: cloudflareApiToken() } }),
        },
      },
      models,
      api: openAICompletionsApi(),
    };

    // setProvider() upserts this one provider id and leaves every other
    // registered provider untouched — same additive primitive
    // ollama_provider.ts uses (NOT `start({ providers: [...] })`, which
    // would REPLACE the whole default set and drop anthropic/openai/etc.).
    const provider = createProvider(options);
    setProvider(provider);
    lastProvider = provider;
    for (const id of ids) registeredIds.add(id);
  })();

  inflight.set(modelId, promise);
  try {
    await promise;
  } finally {
    inflight.delete(modelId);
  }
}

/** Test-only: the most recently constructed provider object (see `lastProvider`'s doc). */
export function providerForTest(): Provider<"openai-completions"> | undefined {
  return lastProvider;
}

/** Test-only: forgets accumulated ids so test files don't leak into each other. Does not touch Flue's own registry — pair with `resetModelsForTests()` from `@flue/runtime/internal`. */
export function resetCloudflareRegistrationForTest(): void {
  registeredIds.clear();
  inflight.clear();
  lastProvider = undefined;
}