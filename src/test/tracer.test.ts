/**
 * Regression tests for `Tracer.sessionFinish`'s two ordering invariants a
 * prior review round introduced a bug in (see `tracer.ts`'s own doc comment
 * on the method for the full trace of why each matters):
 *
 *  1. The otel `recordSessionFinish` fan-out MUST fire synchronously, before
 *     ANY `await` in `sessionFinish` — `session.ts`'s SIGINT/SIGTERM handler
 *     fires `sessionFinish` un-awaited and calls `otel.flushAll()` in that
 *     SAME synchronous turn. `OtelExporter.drain()` emits a placeholder
 *     "incomplete" root span the instant `rootEmitted` is still false, and
 *     `emitRootSpan` latches on that flag — so a fan-out placed after even
 *     one `await` loses the race, and the real verdict is silently dropped.
 *  2. `processesEndAll`'s eventual rejection must never be an unhandled
 *     promise rejection (fatal on Node 22), even when the sessions-row
 *     UPDATE that runs after it also rejects and the code path that used to
 *     be the only place awaiting it is never reached.
 */
import "./hermetic_git.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Tracer } from "../core/tracer.js";
import { OtelExporter } from "../core/otel.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "spf-tracer-test-"));
}

/** A one-request receiver — resolves with the parsed JSON body of the first POST. */
async function receiver(): Promise<{ url: string; body: Promise<any>; close: () => Promise<void> }> {
  let resolveBody: (value: any) => void;
  const body = new Promise<any>((resolve) => {
    resolveBody = resolve;
  });
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    body,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("sessionFinish fires the otel verdict synchronously — a SIGINT-timed drain() must never win the race with its 'incomplete' placeholder", async () => {
  const dir = tmpRepo();
  const recv = await receiver();
  try {
    const otel = new OtelExporter({
      cfg: { endpoint: recv.url, service_name: "spf", headers: undefined },
      adwId: "adw_otel_sync",
      chainName: "plan",
      env: {}, // hermetic: never inherit the developer's own TRACEPARENT
    });
    const tracer = await Tracer.open(join(dir, "spf.db"), join(dir, "events.jsonl"), otel);
    await tracer.sessionStart("adw_otel_sync", "eng", null);

    // Reproduce `session.ts`'s `handleSignal`: fire `sessionFinish`
    // un-awaited, then — in that SAME synchronous turn, with no `await`
    // between the two calls — start the drain the SIGINT path runs via
    // `otel.flushAll()`.
    const finishPromise = tracer.sessionFinish("adw_otel_sync", true);
    const drainPromise = otel.drain(2000);

    await Promise.all([finishPromise, drainPromise]);
    const body = await recv.body;
    const spans = body.resourceSpans[0].scopeSpans[0].spans;
    assert.equal(spans.length, 1, "only the real verdict's root span should have been emitted — no separate 'incomplete' placeholder");
    const statusAttr = spans[0].attributes.find((a: any) => a.key === "spf.run.status");
    assert.equal(statusAttr.value.stringValue, "success", "the real verdict must win the race against drain()'s 'incomplete' placeholder");
  } finally {
    await recv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessionFinish never leaves processesEndAll's rejection unhandled, even when the sessions-row write also rejects", async () => {
  const dir = tmpRepo();
  try {
    const tracer = await Tracer.open(join(dir, "spf.db"), join(dir, "events.jsonl"));
    await tracer.sessionStart("adw_boom", "eng", null);

    // Monkeypatch the trace db's `query` to fail both writes `sessionFinish`
    // makes, exactly the scenario issue 2 describes: if the sessions-row
    // write throws, the code path that used to be the only place awaiting
    // `processesDone` is never reached.
    const realDb = tracer.db as any;
    const originalQuery = realDb.query.bind(realDb);
    const failing = (message: string) => ({
      get: async () => {
        throw new Error(message);
      },
      all: async () => {
        throw new Error(message);
      },
      run: async () => {
        throw new Error(message);
      },
    });
    realDb.query = (sql: string, ...rest: unknown[]) => {
      if (sql.includes("UPDATE processes")) return failing("boom-processes");
      if (sql.startsWith("UPDATE sessions SET status")) return failing("boom-sessions");
      return originalQuery(sql, ...rest);
    };

    let unhandled: unknown = null;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await assert.rejects(() => tracer.sessionFinish("adw_boom", true), /boom-sessions/);
      // Let the event loop fully drain — a would-be unhandled rejection from
      // `processesDone` (boom-processes) needs a real turn to surface.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    assert.equal(unhandled, null, "processesEndAll's own rejection must always be handled, regardless of the sessions-row write's outcome");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
