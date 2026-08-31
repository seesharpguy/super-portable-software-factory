/**
 * `fetchRetryTransient`: retries transport-level blips (including undici's
 * `UND_ERR_SOCKET`) once, never retries an HTTP error status, and never
 * retries a second time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchRetryTransient } from "../core/utils.js";

function socketError(code: string): Error & { cause: { code: string } } {
  const err = new Error("fetch failed") as Error & { cause: { code: string } };
  err.cause = { code };
  return err;
}

test("fetchRetryTransient retries once on UND_ERR_SOCKET and returns the second attempt's response", async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) throw socketError("UND_ERR_SOCKET");
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  try {
    const response = await fetchRetryTransient("http://example.invalid");
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchRetryTransient does not retry a second transport failure", async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    throw socketError("UND_ERR_SOCKET");
  }) as typeof fetch;
  try {
    await assert.rejects(() => fetchRetryTransient("http://example.invalid"));
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchRetryTransient does not retry a non-transient error code", async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    throw socketError("ENOTFOUND");
  }) as typeof fetch;
  try {
    await assert.rejects(() => fetchRetryTransient("http://example.invalid"));
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchRetryTransient never retries an HTTP error status — it isn't a thrown error", async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("server error", { status: 503 });
  }) as typeof fetch;
  try {
    const response = await fetchRetryTransient("http://example.invalid");
    assert.equal(response.status, 503);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
