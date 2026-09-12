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
import { context as contextApi, isSpanContextValid, trace as traceApi } from "@opentelemetry/api";
import { newId } from "./utils.ts";

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

/**
 * `OLLAMA_API_KEY`, trimmed, when the operator has set one — e.g. the
 * Briefs gateway (Envoy AI Gateway) enforces a per-client bearer and 401s
 * the dummy key `DUMMY_API_KEY` was designed for a bare local server that
 * checks nothing. Falls back to the dummy exactly as before when unset, so
 * a bare local Ollama server (the common case this module was built for)
 * is byte-identical to pre-gateway behavior. Read fresh inside `resolve()`
 * (see its call site below) — never cached — so a key exported mid-process
 * (or changed) takes effect on the very next dispatch with no re-registration.
 */
function ollamaApiKey(): string {
  const key = (process.env.OLLAMA_API_KEY ?? "").trim();
  return key || DUMMY_API_KEY;
}

// ── Gateway headers (traceparent / x-correlation-id / x-spf-agent) ─────────
//
// The Briefs gateway (Envoy AI Gateway) joins every hop of one run into a
// single trace ONLY when each LLM call carries its own fresh W3C
// `traceparent`, and groups a run's calls by `x-correlation-id`. It must
// NEVER see `x-request-id` (Envoy/Switchyard own that header end-to-end;
// a client-supplied or client-preserved one breaks their own sampling).
//
// Two different mechanisms carry these three headers to the wire, because
// they need two different lifetimes:
//
//  - `traceparent` must be FRESH per actual HTTP call. `auth.apiKey.resolve()`
//    (below) is genuinely reinvoked by pi-ai on every real dispatch — see
//    `resolveProviderAuth`/`Models.applyAuth()` in
//    `@earendil-works/pi-ai/dist/models.js` — and its returned `auth.headers`
//    is merged into the request's headers ahead of the OpenAI SDK call
//    (`getAuth()` merges it with the model's own static `headers` first,
//    `applyAuth()` merges the per-call `options.headers` on top, and
//    `createClient()` folds both into `defaultHeaders`). So a fresh
//    traceparent minted inside `resolve()` reaches every real call.
//  - `x-correlation-id`/`x-spf-agent` identify WHICH run/agent is calling,
//    which `resolve()` cannot know: its only argument is `{ctx, credential}`
//    (`@earendil-works/pi-ai/dist/auth/types.d.ts`'s `ApiKeyAuth.resolve`),
//    an `AuthContext`/`Credential` pair with no session/request correlator at
//    all — not flue's own per-submission `ctx.id`, not anything SPF mints.
//    Stashing that in a module-level mutable var set around each dispatch
//    was tried for the SEPARATE trace-parenting problem this repo already
//    solved (see `otel_propagation.ts`'s header) and REJECTED: flue runs
//    every submission through one process-lifetime claim loop, so a value
//    set immediately before one `dispatch()` call can still be overwritten
//    by a second, concurrent flue agent's dispatch before the first one's
//    `resolve()` actually fires — silently mis-attributing one run's calls
//    to another's `x-correlation-id`/`x-spf-agent`. Unsafe here for the same
//    reason it was unsafe there.
//
//    So these two ride on `Model.headers` instead — STATIC, stamped once at
//    registration time from whatever `GatewayCallContext` the FIRST
//    registration of a given model id received (see `registerOllamaModel`).
//    This is exactly the fallback the task that produced this module
//    authorized when "Flue's dispatch() truly cannot expose per-call
//    context" — see `open_questions` in this change's handoff for the
//    documented limitation: two DIFFERENT agents sharing the same
//    `ollama/<id>` model within one process/run will both carry the FIRST
//    agent's name on `x-spf-agent` (the id is already registered, so a
//    later registerOllamaModel() call for it is a no-op — see
//    `registeredIds`'s doc). `x-correlation-id` (the run's adw_id) does not
//    have this problem in the common case: one `spf` process runs one adw_id
//    for its whole lifetime.

/** SPF-side identity for one LLM call, as far as `registerOllamaModel`'s caller can supply it. Both fields optional — an absent one simply omits its header. */
export interface GatewayCallContext {
  /** The run's adw_id — sent as `x-correlation-id` so the gateway groups this run's calls. */
  adwId?: string;
  /** The SPF agent name — sent as `x-spf-agent`. */
  agentName?: string;
}

const X_CORRELATION_ID_HEADER = "x-correlation-id";
const X_SPF_AGENT_HEADER = "x-spf-agent";
/** Must NEVER be sent — Envoy/Switchyard own it end-to-end; a client-supplied value breaks their sampling. Exported only so tests can assert its absence by name, not a literal string. */
export const X_REQUEST_ID_HEADER = "x-request-id";

/**
 * A fresh W3C `traceparent` for one outbound call. Reuses the active OTel
 * span context when `otel_propagation.ts`'s instrumentation (or anything
 * else) has one installed and current — the same trace this call's other
 * telemetry already belongs to — falling back to a brand-new random
 * trace/span id pair when there is none (otel unconfigured, or no span
 * active at this point), so the gateway still gets a well-formed,
 * per-call-unique traceparent either way. Never throws; `isSpanContextValid`
 * is the same guard `otel_propagation.ts`'s own propagators use.
 */
export function freshTraceparent(): string {
  const active = traceApi.getSpanContext(contextApi.active());
  if (active && isSpanContextValid(active)) {
    return `00-${active.traceId}-${active.spanId}-01`;
  }
  return `00-${newId(32)}-${newId(16)}-01`;
}

/** The gateway header set for one call: always a fresh `traceparent`; `x-correlation-id`/`x-spf-agent` only when `ctx` supplies them. Never includes `x-request-id`. Pure — no I/O, safe to call from a test. */
export function gatewayHeaders(ctx: GatewayCallContext = {}): Record<string, string> {
  const headers: Record<string, string> = { traceparent: freshTraceparent() };
  if (ctx.adwId) headers[X_CORRELATION_ID_HEADER] = ctx.adwId;
  if (ctx.agentName) headers[X_SPF_AGENT_HEADER] = ctx.agentName;
  return headers;
}

/** The minimal shape `withGatewayHeaders` needs from a `fetch`-like function — matches `globalThis.fetch`'s call signature without depending on DOM lib types. */
export type FetchLike = (input: unknown, init?: Record<string, unknown> & { headers?: Record<string, string> }) => Promise<unknown>;

/**
 * Wraps a `fetch` implementation so every call it makes carries this call's
 * gateway headers, and NEVER carries `x-request-id` (stripped from whatever
 * the caller passed in, in addition to never being one of the headers this
 * adds) — a small, pure, unit-testable primitive for the per-call fetch hook
 * the task background asked for.
 *
 * NOT currently wired into a real ollama dispatch: pi-ai's `stream()` only
 * accepts a custom `fetch` via a per-call `StreamOptions.fetch`
 * (`@earendil-works/pi-ai/dist/types.d.ts`), and `@flue/runtime`'s own
 * `useModel(model, options)` — the only call site `agent_flue.ts` has —
 * accepts just `{thinkingLevel?, compaction?}`
 * (`@flue/runtime/dist/index.d.mts`'s `UseModelOptions`), with no
 * `headers`/`fetch` passthrough at all. So there is no clean way today to
 * hand Flue a per-call fetch override; see `resolve()`/`Model.headers` below
 * for how the same three headers actually reach the wire in this version.
 * Kept exported and tested so it's ready to wire in the moment Flue (or a
 * future pi-ai option) exposes a per-call hook — see `open_questions`.
 */
export function withGatewayHeaders(fetchImpl: FetchLike, ctx: GatewayCallContext = {}): FetchLike {
  return (input, init) => {
    const incoming: Record<string, string> = { ...(init?.headers ?? {}) };
    for (const name of Object.keys(incoming)) {
      if (name.toLowerCase() === X_REQUEST_ID_HEADER) delete incoming[name];
    }
    const headers = { ...incoming, ...gatewayHeaders(ctx) };
    return fetchImpl(input, { ...init, headers });
  };
}

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

/**
 * The `GatewayCallContext` each model id was FIRST registered with — see the
 * "Gateway headers" section above for why `x-correlation-id`/`x-spf-agent`
 * are static per-model rather than resolved per-call. Keyed by model id so a
 * union re-registration (triggered by a NEW id) can rebuild every
 * already-registered id's `Model.headers` from the context it originally
 * got, instead of silently dropping it — the same "already-registered ids
 * keep what they were registered with" invariant `registeredIds` documents
 * for the base URL.
 */
const registrationContext = new Map<string, GatewayCallContext>();

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

function modelFor(id: string, baseUrl: string, ctx?: GatewayCallContext): Model<"openai-completions"> {
  // Static per-model headers — see the "Gateway headers" section above for
  // why `x-correlation-id`/`x-spf-agent` live here rather than in
  // `resolve()`. Omitted entirely (no `headers` key at all) when `ctx` is
  // absent/empty, so a caller that never passes one — every call site
  // before this change, and any future one that doesn't care — gets a
  // byte-identical `Model` to before this field existed.
  const staticHeaders: Record<string, string> = {};
  if (ctx?.adwId) staticHeaders[X_CORRELATION_ID_HEADER] = ctx.adwId;
  if (ctx?.agentName) staticHeaders[X_SPF_AGENT_HEADER] = ctx.agentName;
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
    ...(Object.keys(staticHeaders).length > 0 ? { headers: staticHeaders } : {}),
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
 *
 * `ctx`, when given, is stamped onto this id's `Model.headers` as
 * `x-correlation-id`/`x-spf-agent` — see the "Gateway headers" section
 * above for why this is static-per-id rather than resolved per call, and
 * `registrationContext`'s doc for what a repeat/union re-registration does
 * with it. Ignored (as if omitted) for an already-registered id, exactly
 * like every other per-id registration detail this function documents as
 * fixed at first registration.
 */
export async function registerOllamaModel(modelId: string, ctx?: GatewayCallContext): Promise<void> {
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
    registrationContext.set(modelId, ctx ?? {});
    const baseUrl = ollamaBaseUrl();
    const models = [...ids].map((id) => modelFor(id, baseUrl, registrationContext.get(id)));

    const options: CreateProviderOptions<"openai-completions"> = {
      id: "ollama",
      name: "Ollama (local)",
      baseUrl,
      auth: {
        apiKey: {
          name: "Ollama (keyless)",
          // Fresh per real dispatch (pi-ai reinvokes `resolve()` on every
          // `Models.stream()`/`applyAuth()` call, never caching it — see the
          // "Gateway headers" section above) — `apiKey` honors a real
          // `OLLAMA_API_KEY` when the operator set one (e.g. the Briefs
          // gateway's per-client bearer), falling back to the DUMMY_API_KEY
          // a bare keyless local server needs (see its own doc for why that
          // can't just be "no key needed" instead). `headers.traceparent` is
          // this call's fresh W3C trace context; `x-correlation-id`/
          // `x-spf-agent` are NOT set here — see `Model.headers` above for
          // why those two are static-per-model instead.
          resolve: async () => ({ auth: { apiKey: ollamaApiKey(), headers: { traceparent: freshTraceparent() } } }),
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
  registrationContext.clear();
}
