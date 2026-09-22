/**
 * Capability probe for vLLM cache-details availability — origin issue #82.
 *
 * vLLM's OpenAI-compatible /chat/completions endpoint optionally returns
 * usage.prompt_tokens_details (when the server is started with
 * --enable-prompt-tokens-details). This module detects whether that
 * capability is present per baseUrl, so callers can later flag a missing
 * capability (not a genuine cache miss) when it is absent.
 *
 * All public functions fail OPEN (return null/"unknown" on any network
 * error, timeout, or parse failure) — better to treat a missing detail as a
 * cache miss than to escalate a transient probe failure into a runtime error.
 *
 * Memoized once per process per normalized baseUrl (trailing slashes
 * stripped), following the same pattern as tiering.ts's probeServedOllamaTags.
 */

const PROBE_TIMEOUT_MS = 3_000;

/**
 * Settled probe results per normalized baseUrl. Separate map (vs. storing
 * both in one) keeps in-flight promises from conflating with false boolean
 * results: a key in this map always holds a real boolean | null, never a
 * Promise. The other map tracks in-flight promises to prevent concurrent
 * requests for the same baseUrl.
 */
let results = new Map<string, boolean | null>();

/**
 * In-flight promises per normalized baseUrl, keyed the same way. Ensures
 * two concurrent calls for the same baseUrl return the SAME promise and
 * fire only ONE network request. Once settled, the promise is removed and
 * the result lives only in `results`.
 */
let inFlight = new Map<string, Promise<void>>();

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * One-shot probe for prompt_tokens_details availability. Never throws; every
 * failure (network, timeout, non-200, unparseable body, missing usage key) →
 * null ("unknown, fail open").
 *
 * Makes a minimal completion request:
 *   POST /chat/completions
 *   body: { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }
 *
 * Returns:
 *   - true if the response includes usage.prompt_tokens_details (key present)
 *   - false if usage exists but prompt_tokens_details is absent (CONFIRMED missing)
 *   - null on any error (network, status !== 200, unparseable, missing usage)
 */
export async function probeCacheDetailsAvailable(baseUrl: string, apiKey: string, model: string): Promise<boolean | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const url = normalizeBaseUrl(baseUrl) + "/chat/completions";
    const res = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
    });
    if (res.status !== 200) return null;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null; // unparseable JSON
    }
    if (!body || typeof body !== "object") return null;
    const usage = (body as Record<string, unknown>).usage;
    if (!usage || typeof usage !== "object") return null;
    // Return true iff the key is present in usage, even if its value is
    // undefined or null — Object.prototype.hasOwnProperty is the canonical
    // check for "key exists", used everywhere the repo detects optional fields.
    return Object.prototype.hasOwnProperty.call(usage, "prompt_tokens_details");
  } catch {
    // timeout (AbortError) | ECONNREFUSED | any other fetch throw -> fail OPEN
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Idempotent probe, memoized per normalized baseUrl for the process lifetime.
 * If a probe for this baseUrl is already settled or in flight, returns a
 * Promise that resolves when that existing work finishes (and stores the
 * result in the results map). Otherwise fires probeCacheDetailsAvailable,
 * stores the settled result, and resolves.
 *
 * Callers in production code will call this WITHOUT awaiting (true
 * fire-and-forget), but a test must be able to `await
 * ensureCacheDetailsProbed(...)` and then synchronously call
 * getCacheDetailsAvailability(baseUrl) and see the settled value immediately.
 */
export function ensureCacheDetailsProbed(baseUrl: string, apiKey: string, model: string): Promise<void> {
  const normalized = normalizeBaseUrl(baseUrl);

  // If already settled, return a resolved promise.
  if (results.has(normalized)) {
    return Promise.resolve();
  }

  // If already in flight, return the same promise (reuse the in-flight work).
  if (inFlight.has(normalized)) {
    return inFlight.get(normalized)!;
  }

  // Otherwise, fire the probe and store the promise and result.
  const promise = (async () => {
    const result = await probeCacheDetailsAvailable(baseUrl, apiKey, model);
    results.set(normalized, result);
    inFlight.delete(normalized);
  })();

  inFlight.set(normalized, promise);
  return promise;
}

/**
 * Synchronous getter. Returns:
 *   - undefined if this baseUrl has never been probed (ensureCacheDetailsProbed
 *     was never called, or the probe is still in flight and hasn't settled yet)
 *   - the settled boolean | null result otherwise
 */
export function getCacheDetailsAvailability(baseUrl: string): boolean | null | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  return results.get(normalized);
}

/**
 * Test-only: clears all internal state (both maps). The probe memoizes once
 * per process, so a test that stubs `fetch` differently across cases must
 * reset the cache between them.
 */
export function resetCacheDetailsProbeForTest(): void {
  results.clear();
  inFlight.clear();
}
