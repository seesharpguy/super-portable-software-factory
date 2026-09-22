import { test } from "node:test";
import assert from "node:assert/strict";
import { probeCacheDetailsAvailable, ensureCacheDetailsProbed, getCacheDetailsAvailability, resetCacheDetailsProbeForTest } from "../core/cache_details_probe.js";

// ── test 1: prompt_tokens_details present → true ──────────────────────────────

test("1: usage.prompt_tokens_details present → probeCacheDetailsAvailable resolves true", async () => {
  const savedFetch = globalThis.fetch;
  try {
    resetCacheDetailsProbeForTest();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          object: "chat.completion",
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 2 },
          },
        }),
        { status: 200 },
      )
    ) as typeof fetch;
    const result = await probeCacheDetailsAvailable("http://localhost:8000", "fake-key", "mistral");
    assert.equal(result, true, "key present in usage → true");
  } finally {
    globalThis.fetch = savedFetch;
    resetCacheDetailsProbeForTest();
  }
});

// ── test 2: usage present but prompt_tokens_details absent → false ────────────

test("2: usage present but prompt_tokens_details absent → resolves false", async () => {
  const savedFetch = globalThis.fetch;
  try {
    resetCacheDetailsProbeForTest();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          object: "chat.completion",
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
          },
        }),
        { status: 200 },
      )
    ) as typeof fetch;
    const result = await probeCacheDetailsAvailable("http://localhost:8000", "fake-key", "mistral");
    assert.equal(result, false, "key absent but usage present → false (CONFIRMED missing)");
  } finally {
    globalThis.fetch = savedFetch;
    resetCacheDetailsProbeForTest();
  }
});

// ── test 3: no usage key in body → null ──────────────────────────────────────

test("3: no usage key in body → resolves null", async () => {
  const savedFetch = globalThis.fetch;
  try {
    resetCacheDetailsProbeForTest();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "hi" } }],
        }),
        { status: 200 },
      )
    ) as typeof fetch;
    const result = await probeCacheDetailsAvailable("http://localhost:8000", "fake-key", "mistral");
    assert.equal(result, null, "no usage key → null");
  } finally {
    globalThis.fetch = savedFetch;
    resetCacheDetailsProbeForTest();
  }
});

// ── test 4: non-200 status → null ───────────────────────────────────────────

test("4: non-200 status → resolves null", async () => {
  const savedFetch = globalThis.fetch;
  try {
    resetCacheDetailsProbeForTest();
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "model not found" }), { status: 404 })
    ) as typeof fetch;
    const result = await probeCacheDetailsAvailable("http://localhost:8000", "fake-key", "mistral");
    assert.equal(result, null, "non-200 status → null");
  } finally {
    globalThis.fetch = savedFetch;
    resetCacheDetailsProbeForTest();
  }
});

// ── test 5: network error (fetch throws) → null ──────────────────────────────

test("5: thrown fetch (network error) → resolves null", async () => {
  const savedFetch = globalThis.fetch;
  try {
    resetCacheDetailsProbeForTest();
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const result = await probeCacheDetailsAvailable("http://localhost:8000", "fake-key", "mistral");
    assert.equal(result, null, "thrown fetch → null (fail OPEN)");
  } finally {
    globalThis.fetch = savedFetch;
    resetCacheDetailsProbeForTest();
  }
});

// ── test 6: unparseable JSON body → null ────────────────────────────────────

test("6: unparseable JSON body → resolves null", async () => {
  const savedFetch = globalThis.fetch;
  try {
    resetCacheDetailsProbeForTest();
    globalThis.fetch = (async () =>
      new Response("not valid json {{{", { status: 200 })
    ) as typeof fetch;
    const result = await probeCacheDetailsAvailable("http://localhost:8000", "fake-key", "mistral");
    assert.equal(result, null, "unparseable JSON → null");
  } finally {
    globalThis.fetch = savedFetch;
    resetCacheDetailsProbeForTest();
  }
});

// ── test 7: ensureCacheDetailsProbed + getCacheDetailsAvailability round-trip ─

test("7: ensureCacheDetailsProbed + getCacheDetailsAvailability round-trip", async () => {
  const savedFetch = globalThis.fetch;
  try {
    resetCacheDetailsProbeForTest();
    const baseUrl = "http://localhost:8000";

    // Before probing, getCacheDetailsAvailability returns undefined.
    assert.equal(getCacheDetailsAvailability(baseUrl), undefined, "before probe: undefined");

    // Stub fetch and probe.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          usage: {
            prompt_tokens: 10,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
        { status: 200 },
      )
    ) as typeof fetch;

    // Call ensureCacheDetailsProbed and await it.
    await ensureCacheDetailsProbed(baseUrl, "key", "model");

    // Now getCacheDetailsAvailability returns the settled value.
    const avail = getCacheDetailsAvailability(baseUrl);
    assert.equal(avail, true, "after probe: settled boolean value");
  } finally {
    globalThis.fetch = savedFetch;
    resetCacheDetailsProbeForTest();
  }
});

// ── test 8: two concurrent ensureCacheDetailsProbed calls for same baseUrl ────

test("8: two concurrent ensureCacheDetailsProbed calls for SAME baseUrl trigger ONE fetch call", async () => {
  const savedFetch = globalThis.fetch;
  let fetchCallCount = 0;
  try {
    resetCacheDetailsProbeForTest();
    const baseUrl = "http://localhost:8000";

    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({
          usage: {
            prompt_tokens: 10,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    // Fire two concurrent calls for the same baseUrl (no await yet).
    const promise1 = ensureCacheDetailsProbed(baseUrl, "key", "model");
    const promise2 = ensureCacheDetailsProbed(baseUrl, "key", "model");

    // Both should resolve to the same promise or both resolve when that work finishes.
    await Promise.all([promise1, promise2]);

    assert.equal(fetchCallCount, 1, "only ONE fetch call despite two concurrent requests");
    assert.equal(getCacheDetailsAvailability(baseUrl), true, "result is settled");
  } finally {
    globalThis.fetch = savedFetch;
    resetCacheDetailsProbeForTest();
  }
});

// ── test 9: resetCacheDetailsProbeForTest() actually clears state ──────────────

test("9: resetCacheDetailsProbeForTest() clears state — probe after reset calls fetch again", async () => {
  const savedFetch = globalThis.fetch;
  let fetchCallCount = 0;
  try {
    resetCacheDetailsProbeForTest();
    const baseUrl = "http://localhost:8000";

    globalThis.fetch = (async () => {
      fetchCallCount++;
      return new Response(
        JSON.stringify({
          usage: {
            prompt_tokens: 10,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    // First probe.
    await ensureCacheDetailsProbed(baseUrl, "key", "model");
    assert.equal(fetchCallCount, 1, "first probe triggers fetch");

    // Reset.
    resetCacheDetailsProbeForTest();
    assert.equal(getCacheDetailsAvailability(baseUrl), undefined, "after reset: undefined");

    // Probe again — should call fetch again, not serve from stale cache.
    await ensureCacheDetailsProbed(baseUrl, "key", "model");
    assert.equal(fetchCallCount, 2, "after reset, second probe triggers fetch again");
  } finally {
    globalThis.fetch = savedFetch;
    resetCacheDetailsProbeForTest();
  }
});
