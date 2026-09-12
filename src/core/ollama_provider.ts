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
import { isFluePropagationInstalled, X_CORRELATION_ID_HEADER, X_SPF_AGENT_HEADER } from "./otel_propagation.ts";
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
 * THIS function's own return value — the resolved `Authorization` bearer —
 * is byte-identical to pre-gateway behavior for a bare local Ollama server
 * (the common case this module was built for). MINOR-H: that is narrower
 * than "the whole request is unchanged" — it is not, even with
 * `OLLAMA_API_KEY` unset: a `traceparent` (and, once `agent_flue.ts` has an
 * adw_id/agent_name to give it, `x-correlation-id`/`x-spf-agent`) is ALWAYS
 * sent now, gateway or no gateway (see the "Gateway headers" section below).
 * A bare local Ollama server ignores headers it doesn't recognize, so this
 * is harmless — just not byte-identical. Read fresh inside `resolve()` (see
 * its call site below) — never cached — so a key exported mid-process (or
 * changed) takes effect on the very next dispatch with no re-registration.
 *
 * MINOR 3: exported so `doctor.ts`'s `OLLAMA_BASE_URL reachability` probe
 * calls this SAME function rather than reading `process.env.OLLAMA_API_KEY`
 * raw — a prior version of that probe sent NO `Authorization` header at all
 * when the env var was unset, which diverges from what a real dispatch
 * sends (the dummy bearer below, always). Against a gateway that rejects a
 * request with no `Authorization` header at all differently than one with a
 * wrong/dummy bearer, that divergence could make doctor report reachable
 * when a real dispatch would 401, or vice versa. Calling `ollamaApiKey()` in
 * both places means doctor's probe and a real dispatch send byte-identical
 * bearers for the same env state.
 */
export function ollamaApiKey(): string {
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
// Two DIFFERENT mechanisms carry these three headers to the wire, depending
// on whether `otel_propagation.ts`'s `installFluePropagation()` has been
// installed in THIS process (`isFluePropagationInstalled()` — set only when
// `observability.otel` is configured for the run):
//
//  - INSTALLED: `@opentelemetry/instrumentation-undici`/`-http` inject
//    `traceparent` (`W3CTraceContextPropagator`) and `x-correlation-id`/
//    `x-spf-agent` (`GatewayHeadersPropagator`, keyed off the per-session
//    registration `agent_flue.ts` makes via `registerFlueSessionTrace` —
//    see `otel_propagation.ts`'s header) directly onto every real outbound
//    request, REGARDLESS of which provider SDK issued it. This is the more
//    precise mechanism (correct even under concurrent flue sessions in one
//    process) and it uses `request.addHeader` (append, not replace) — so
//    THIS module must not ALSO set any of the three, or the gateway sees
//    two of each header on the wire (this was BLOCKER A: `resolve()` used
//    to mint its own `traceparent` unconditionally, on top of the
//    instrumentation's).
//  - NOT INSTALLED (the common case: otel unconfigured): nothing else is
//    injecting these headers, so this module must supply all three itself,
//    via two different sub-mechanisms because they need two different
//    lifetimes:
//     - `traceparent` must be FRESH per actual HTTP call. `auth.apiKey.
//       resolve()` (below) is genuinely reinvoked by pi-ai on every real
//       dispatch — see `resolveProviderAuth`/`Models.applyAuth()` in
//       `@earendil-works/pi-ai/dist/models.js` — and its returned
//       `auth.headers` is merged into the request's headers ahead of the
//       OpenAI SDK call. So a fresh traceparent minted inside `resolve()`
//       reaches every real call.
//     - `x-correlation-id`/`x-spf-agent` identify WHICH run/agent is
//       calling, which `resolve()` cannot know: its only argument is
//       `{ctx, credential}` (`@earendil-works/pi-ai/dist/auth/types.d.ts`'s
//       `ApiKeyAuth.resolve`), an `AuthContext`/`Credential` pair with no
//       session/request correlator at all. Stashing that in a module-level
//       mutable var set around each dispatch was tried for the SEPARATE
//       trace-parenting problem this repo already solved (see
//       `otel_propagation.ts`'s header) and REJECTED: flue runs every
//       submission through one process-lifetime claim loop, so a value set
//       immediately before one `dispatch()` call can still be overwritten by
//       a second, concurrent flue agent's dispatch before the first one's
//       `resolve()` actually fires. Unsafe here for the same reason.
//
//       So, when not installed, these two ride on `Model.headers` instead —
//       STATIC, re-stamped on every `registerOllamaModel()` call for this
//       model id (see its own doc for the mutate-not-no-op fix and the one
//       race that remains: two flue agents dispatching CONCURRENTLY to the
//       SAME `ollama/<id>` model, i.e. fanout concurrency > 1 racing on one
//       shared model id, can still have the loser's ctx silently lose to
//       whichever registration's `setProvider()` call lands last).

/** SPF-side identity for one LLM call, as far as `registerOllamaModel`'s caller can supply it. Both fields optional — an absent one simply omits its header. */
export interface GatewayCallContext {
  /** The run's adw_id — sent as `x-correlation-id` so the gateway groups this run's calls. */
  adwId?: string;
  /** The SPF agent name — sent as `x-spf-agent`. */
  agentName?: string;
}

/** Must NEVER be sent — Envoy/Switchyard own it end-to-end; a client-supplied value breaks their sampling. Exported only so tests can assert its absence by name, not a literal string. The sole surviving export of this name in the codebase — see MINOR-G in this change's review; `otel_propagation.ts` no longer has one now that `XRequestIdPropagator` is gone (BLOCKER B). */
export const X_REQUEST_ID_HEADER = "x-request-id";

/**
 * A fresh W3C `traceparent` for one outbound call — used only on the NOT
 * INSTALLED path (see the section above); when propagation IS installed,
 * `resolve()` does not call this at all, relying entirely on the
 * instrumentation's own per-request injection instead (this is what fixed
 * BLOCKER A/MAJOR-C: this function used to be called unconditionally, and
 * on the installed path it silently reused the one still-open span's
 * traceparent for every call inside that span, which is both a duplicate
 * header AND not actually fresh per call).
 *
 * Reuses the active OTel span context when one is installed and current —
 * the same trace this call's other telemetry already belongs to — falling
 * back to a brand-new random trace/span id pair when there is none (no span
 * active at this exact point, e.g. a stray call before any span opened), so
 * the gateway still gets a well-formed, per-call-unique traceparent either
 * way. Never throws; `isSpanContextValid` is the same guard
 * `otel_propagation.ts`'s own propagators use.
 */
export function freshTraceparent(): string {
  const active = traceApi.getSpanContext(contextApi.active());
  if (active && isSpanContextValid(active)) {
    return `00-${active.traceId}-${active.spanId}-01`;
  }
  return `00-${newId(32)}-${newId(16)}-01`;
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
 * is current AT THAT MOMENT. `registerOllamaModel` re-runs this rebuild on
 * EVERY call now (see its own doc for why: MAJOR-D's gateway-header
 * re-stamping needs it), so in practice a mid-process `OLLAMA_BASE_URL`
 * change is picked up by the very next dispatch to ANY already-registered
 * id, not just the next brand-new one.
 */
const registeredIds = new Set<string>();

/**
 * The `GatewayCallContext` each model id was MOST RECENTLY registered with
 * — see the "Gateway headers" section above for why `x-correlation-id`/
 * `x-spf-agent` are static per-model (when otel propagation isn't
 * installed) rather than resolved per-call. Keyed by model id so a union
 * re-registration (triggered by ANY registration call, new id or repeat —
 * see `registerOllamaModel`'s MAJOR-D doc) can rebuild every
 * already-registered id's `Model.headers` from the context it MOST
 * RECENTLY got, rather than dropping it or freezing it at first
 * registration.
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
  // `resolve()`, and ONLY on the NOT INSTALLED path: when
  // `isFluePropagationInstalled()` is true, `GatewayHeadersPropagator`
  // already injects both per real request, correctly attributed per
  // session — stamping them here too would double them up on the wire
  // (BLOCKER A's bug, for these two headers instead of `traceparent`).
  // Omitted entirely (no `headers` key at all) when there is nothing to
  // stamp — propagation installed, or `ctx` absent/empty — so a caller that
  // never passes one, or a run with otel configured, gets a `Model` with no
  // static headers.
  const staticHeaders: Record<string, string> = {};
  if (!isFluePropagationInstalled()) {
    if (ctx?.adwId) staticHeaders[X_CORRELATION_ID_HEADER] = ctx.adwId;
    if (ctx?.agentName) staticHeaders[X_SPF_AGENT_HEADER] = ctx.agentName;
  }
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
 * id ever registered this process. NOT idempotent w.r.t. `ctx` (see MAJOR-D
 * below) — every call re-runs the union re-registration (dynamic imports
 * are cheap after the first, and `setProvider()` is a cheap in-memory
 * upsert), so this id's `Model.headers` always reflect the MOST RECENT
 * `ctx` this function was called with, not just the first. A concurrent
 * call for the SAME id joins the in-flight registration rather than running
 * a second one in parallel (see `inflight`'s doc); `registeredIds` itself
 * is only ever updated AFTER `setProvider()` succeeds, so a failed attempt
 * (a bad install, a bundler that can't resolve the deep `.lazy` subpath, a
 * future validation error) leaves the id unregistered and eligible for a
 * real retry — not permanently and misleadingly marked "done" while
 * nothing is actually registered.
 *
 * Must complete before the FIRST Flue dispatch that names this model
 * (agent_flue.ts's `run()` awaits this before `ensureRuntime()`/`start()`),
 * but is equally safe to call again later with a new id, or the SAME id
 * again, mid-process — a new id's union re-registration is how a second
 * model gets added without orphaning the first (see the `registeredIds` doc
 * above); a repeat of the SAME id is how MAJOR-D below is fixed.
 *
 * MAJOR-D (fixed): `ctx`, when given AND `isFluePropagationInstalled()` is
 * false (see the "Gateway headers" section above — when it's true, these
 * two headers come from the per-request `GatewayHeadersPropagator`
 * instead), is stamped onto this id's `Model.headers` as
 * `x-correlation-id`/`x-spf-agent`. A PRIOR version of this function
 * returned immediately for an already-registered id (a false comment
 * claimed "one spf process runs one adw_id for its whole lifetime" to
 * justify this) — which meant every later agent/adw_id sharing a model id
 * within one process (spf `loop`/`fanout`/`watch`, which run many adw_ids
 * in ONE process, `fanout` concurrently) silently kept the FIRST
 * registration's headers forever. Re-running the full registration on every
 * call, unconditionally, fixes that for every case except one, which
 * remains and is not silently swallowed: two flue agents dispatching
 * CONCURRENTLY (not sequentially) to the SAME `ollama/<id>` model id race on
 * `registrationContext`/`setProvider()` — whichever registration's
 * `setProvider()` call lands last wins the headers BOTH calls' subsequent
 * dispatches see, until the next registration for that id. This is a
 * `fanout` concurrency > 1 scenario specifically (two DIFFERENT agents,
 * same process, same model id, truly overlapping registrations) — a
 * sequential loop/watch never hits it, since each call's `await` completes
 * before the next one starts.
 */
export async function registerOllamaModel(modelId: string, ctx?: GatewayCallContext): Promise<void> {
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
          // can't just be "no key needed" instead).
          //
          // `headers.traceparent` is minted here ONLY when
          // `isFluePropagationInstalled()` is false — checked fresh on every
          // call, since propagation can be installed partway through this
          // process's lifetime (the first ollama dispatch in a run with
          // otel configured registers the model BEFORE
          // `installFluePropagation()` runs — see `agent_flue.ts`'s `run()`
          // — so a later dispatch on the SAME already-registered model must
          // still re-check, not trust a value baked in at registration
          // time). When installed, `@opentelemetry/instrumentation-undici`
          // already injects a real, fresh `traceparent` for this exact
          // outbound request (see `otel_propagation.ts`); minting a second
          // one here would put TWO `traceparent` headers on the wire
          // (`UndiciInstrumentation` appends, it does not replace) — this
          // was BLOCKER A. `x-correlation-id`/`x-spf-agent` are NEVER set
          // here either way — see `Model.headers` above (not installed) and
          // `GatewayHeadersPropagator` (installed) for where those two
          // actually come from.
          resolve: async () => ({
            auth: {
              apiKey: ollamaApiKey(),
              ...(isFluePropagationInstalled() ? {} : { headers: { traceparent: freshTraceparent() } }),
            },
          }),
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
