/**
 * Ollama registration for the Flue backend (agent_flue.ts).
 *
 * Neither pi-ai nor Flue ship a built-in "ollama" provider — Ollama is
 * reached through the OpenAI-compatible `/v1/chat/completions` surface it
 * serves locally, registered the same way any self-hosted OpenAI-compatible
 * endpoint would be: `createProvider()` + Flue's `setProvider()`. Three
 * constraints below came out of a live spike (raw logs under
 * scratchpad/ollama-spike) and would look like accidental complexity to a
 * future maintainer without this note, so each is called out where it bites.
 *
 * EXACT VERSION PIN — see package.json's `@earendil-works/pi-ai: "0.83.0"`
 * (no caret). `@flue/runtime@2.0.3` itself depends on `^0.83.0`; pinning our
 * own dependency to the exact same version lets npm dedupe both into ONE
 * physical copy of pi-ai in node_modules. A newer 0.83.x/0.84.x would still
 * satisfy flue's range, but npm would then keep two-or-three separate copies
 * side by side — and the `Provider`/`Model` values this file hands to
 * `setProvider()` must be instances `@flue/runtime`'s OWN copy of pi-ai
 * recognizes, or registration silently never reaches the registry flue's
 * `resolveModel()` actually reads from. Verified live: with the exact pin,
 * dedupe holds and registration is visible to flue's registry immediately.
 *
 * LAZY IMPORT — every symbol used here is loaded via dynamic `import()`
 * inside `registerOllamaModel`, never at this module's top level. This is
 * NOT a load-time saving, and the reasoning below is the measured truth, not
 * the "avoid eagerly loading pi-ai's runtime for non-ollama runs" story that
 * comment used to tell: `agent_flue.ts` already imports `@flue/runtime/node`
 * unconditionally, and that import ALONE already pulls in pi-ai's full
 * runtime (auth flows, every provider's model-catalog JSON, OAuth machinery)
 * for every SPF run, ollama or not. Measured live: `await
 * import("@flue/runtime/node")` costs 183ms / 38 pi-ai module-cache entries
 * by itself; the subsequent `await import("@earendil-works/pi-ai")` costs
 * 0ms / 0 additional entries, and `await
 * import("@earendil-works/pi-ai/api/openai-completions.lazy")` costs 1ms / 0
 * additional entries — pi-ai is already resident by the time either dynamic
 * import here runs. The real reason to keep the dynamic form is narrower:
 * it keeps this module's ollama-only symbols — especially the deep
 * `api/openai-completions.lazy` subpath — off the module graph of anything
 * that merely imports `agent_flue.ts` for `resolveModel()` (as `doctor.ts`
 * and `interview.ts` both do) without ever dispatching an ollama call.
 * `type` imports below are erased at compile time (verbatimModuleSyntax) and
 * cost nothing at runtime either way.
 */

import type { CreateProviderOptions, Model, Provider } from "@earendil-works/pi-ai";

// Ollama has no auth of its own — `pi-ai`'s auth resolution always calls
// `getClientApiKey()` before a dispatch, and that call throws "No API key
// for provider: ollama" if the resolved key is falsy (verified live: the
// upstream-documented `auth: { apiKey: {} }` recipe, with no `resolve()` or a
// resolver returning no key, throws exactly that at the FIRST dispatch, not
// at registration). There is no supported way to mark a provider as needing
// no key at all — the value below is a placeholder pi-ai never actually
// sends anywhere Ollama would look at it: Ollama's OpenAI-compatible server
// does not check the Authorization header's contents.
const DUMMY_API_KEY = "ollama-local-unused";

// Advisory only: pi-ai's `openai-completions` api reads this per REQUEST via
// its own `options.maxTokens`, not from `Model.maxTokens` directly — the
// field here only feeds Flue's compaction-reserve sizing (moot in practice
// since `contextWindow: 0` below disables threshold compaction, matching
// agent_flue.ts's own `context_window: 0`). Kept generous since Ollama
// enforces nothing against it.
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Every `ollama/<id>` model id a `registerOllamaModel` call has ever
 * SUCCEEDED in registering, in call order. `setProvider()` REPLACES the
 * named provider's entire model list on every call — it is not additive —
 * so this Set is what lets each call re-register the FULL union instead of
 * just the newest id. Without it: register "a", then "b", and "a" becomes an
 * unknown model id at its next dispatch (verified live: "Unknown model ID …
 * for provider \"ollama\""), because the second `setProvider()` call
 * replaced the first provider object — the one whose `models` list still
 * had "a" — outright.
 *
 * `OLLAMA_BASE_URL` is read fresh (via `ollamaBaseUrl()`) at each
 * registration call, and the whole union is re-registered at whatever URL
 * is current AT THAT MOMENT — so a mid-process env change applies unevenly:
 * ids already registered keep the base URL they were registered under until
 * the NEXT new id triggers a fresh union re-registration, which then
 * re-points every id at once. Deliberate: a single local server for the
 * whole process is the supported case, and this asymmetry only bites a
 * per-agent override, which isn't.
 */
const registeredIds = new Set<string>();

// Registrations currently in flight, keyed by model id — lets a second
// caller for the SAME id that arrives before the first `await` resolves
// join that in-progress registration instead of returning immediately with
// nothing registered yet (which would let it dispatch before `setProvider()`
// has actually run).
const inflight = new Map<string, Promise<void>>();

// The most recently constructed provider object, kept only so tests can
// inspect its auth/model shape directly — this Flue version's public
// surface (`@flue/runtime/internal`) exports `setProvider`/`hasProvider`/
// `resolveModel` but no `getProvider`, so there is no other way to read a
// registered provider's `auth` back out of Flue's own registry.
let lastProvider: Provider<"openai-completions"> | undefined;

/** Exported so `doctor.ts`'s reachability probe agrees with what a real dispatch resolves to — see its call site for why a `??`/`||` mismatch here matters. */
export function ollamaBaseUrl(): string {
  const raw = (process.env.OLLAMA_BASE_URL ?? "").trim();
  return raw || "http://localhost:11434/v1";
}

function modelFor(id: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "ollama",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Disables Flue's threshold-based compaction outright — there's no
    // reliable catalog of context windows for arbitrary local Ollama models,
    // and agent_flue.ts already treats 0 as "unknown, don't compact" for its
    // own reported `context_window`. Verified live to be a safe no-op, not
    // silently truncating requests.
    contextWindow: 0,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

/**
 * Registers `modelId` (the part after `ollama/` in an agent's `model`
 * config) with Flue's provider registry, alongside every other `ollama/*`
 * id ever registered this process. Idempotent: a repeat of an already-seen
 * id is a no-op — no re-registration, no re-import. A concurrent call for
 * the SAME id joins the in-flight registration rather than returning early
 * (see `inflight`'s doc); `registeredIds` itself is only ever updated AFTER
 * `setProvider()` succeeds, so a failed attempt (a bad install, a bundler
 * that can't resolve the deep `.lazy` subpath, a future validation error)
 * leaves the id unregistered and eligible for a real retry — not
 * permanently and misleadingly marked "done" while nothing is actually
 * registered.
 *
 * Must complete before the FIRST Flue dispatch that names this model
 * (agent_flue.ts's `run()` awaits this before `ensureRuntime()`/`start()`),
 * but is equally safe to call again later with a new id mid-process — that
 * later call's union re-registration is exactly how a second model gets
 * added without orphaning the first (see the `registeredIds` doc above).
 */
export async function registerOllamaModel(modelId: string): Promise<void> {
  if (registeredIds.has(modelId)) return;
  const existing = inflight.get(modelId);
  if (existing) return existing;

  const promise = (async () => {
    // Deliberately dynamic, not top-level, imports — see the module doc's
    // "LAZY IMPORT" note. `@flue/runtime/internal` is cheap either way
    // (it's already reachable from `@flue/runtime`/`@flue/runtime/node`,
    // which agent_flue.ts imports unconditionally); pi-ai's own package is
    // the one this module keeps off other modules' graphs.
    const [{ createProvider }, { openAICompletionsApi }, { setProvider }] = await Promise.all([
      import("@earendil-works/pi-ai"),
      import("@earendil-works/pi-ai/api/openai-completions.lazy"),
      import("@flue/runtime/internal"),
    ]);

    // Built from a local candidate set, not `registeredIds` itself — the id
    // being registered right now isn't committed to `registeredIds` until
    // AFTER `setProvider()` below succeeds (see this function's doc).
    const ids = new Set(registeredIds);
    ids.add(modelId);
    const baseUrl = ollamaBaseUrl();
    const models = [...ids].map((id) => modelFor(id, baseUrl));

    const options: CreateProviderOptions<"openai-completions"> = {
      id: "ollama",
      name: "Ollama (local)",
      baseUrl,
      auth: {
        apiKey: {
          name: "Ollama (keyless)",
          // See DUMMY_API_KEY above for why this can't just report "no key
          // needed" — pi-ai's dispatch path requires a truthy resolved key.
          resolve: async () => ({ auth: { apiKey: DUMMY_API_KEY } }),
        },
      },
      models,
      api: openAICompletionsApi(),
    };

    // NOT `start({ providers: [...] })` — per @flue/runtime's own node/index
    // typings, that option REPLACES the runtime's entire default provider
    // set (every pi-ai built-in), which would silently drop
    // anthropic/openai/etc. for every agent, not just ollama ones.
    // `setProvider()` is the additive (per-id) primitive; it upserts this
    // one id and leaves every other already-registered provider untouched.
    const provider = createProvider(options);
    setProvider(provider);
    lastProvider = provider;
    // Only commit to the Set once `setProvider()` has actually run —
    // see this function's doc for why ordering this after, not before,
    // matters.
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
export function resetOllamaRegistrationForTest(): void {
  registeredIds.clear();
  inflight.clear();
  lastProvider = undefined;
}
