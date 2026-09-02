/**
 * `session.ts`'s signal wiring — one process-wide SIGTERM/SIGINT listener,
 * not one per `ensure()` call (`spf watch` calls `ensure()` once per claimed
 * issue, in-process, for the life of the daemon).
 *
 * Two things are pinned here, both regressions a prior version of this file
 * shipped:
 *
 *  1. A fresh listener per `ensure()` call means every listener EVER
 *     registered stays registered and fires on the NEXT signal — so a
 *     signal arriving during issue 72 would also re-run issue 70 and 71's
 *     long-finished handlers, flipping their already-`success` sessions
 *     back to `fail`. `finalize()` (called from `chains/index.ts`'s
 *     `runChain()` finally, same seam as `otel.releaseOtelExporter()`)
 *     removes a run from the set the signal handler acts on the moment its
 *     own dispatch settles — proven here via `activeRunIdsForTest()`.
 *  2. The same per-`ensure()` listener kept every finished run's `Run` (and
 *     its Tracer, and its open sqlite handle) strongly reachable from
 *     `process`'s own listener array for the rest of the daemon's life —
 *     both the listener-count growth and the leak. `finalize()` closes the
 *     Tracer's sqlite handle; a query against it afterward throws, which is
 *     the only externally observable proof a handle was actually released.
 *
 * No real SIGTERM/SIGINT is ever sent in this file — the handler's own
 * `process.exit()` would end the test run. Only the bookkeeping around it
 * (registration count, the active-run set, the closed handle) is asserted.
 */
import "./hermetic_git.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { SFConfigSchema, type SFConfig } from "../core/data_types.js";
import { activeRunIdsForTest, ensure, finalize } from "../core/session.js";

// Captured before this file's tests run any `ensure()` call, so "the shared
// listener installs at most once" can be asserted as a fixed delta rather
// than an absolute count (other test files, and node:test itself, run in
// their own process, but nothing here should assume a pristine listener
// count if that ever stops being true).
const baselineSigterm = process.listenerCount("SIGTERM");
const baselineSigint = process.listenerCount("SIGINT");

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "spf-session-test-"));
}

function cfg(): SFConfig {
  return v.parse(SFConfigSchema, {}) as SFConfig;
}

test("ensure() registers a run as active, and finalize() removes it", async () => {
  const dir = tmpRepo();
  try {
    const run = await ensure(cfg(), "adw_session_finalize_a", dir, "plan");
    assert.ok(activeRunIdsForTest().includes("adw_session_finalize_a"), "a just-started run is tracked as active");

    await finalize("adw_session_finalize_a");
    assert.ok(!activeRunIdsForTest().includes("adw_session_finalize_a"), "a finalized run is no longer tracked — a later signal must not touch it");

    // The Tracer's sqlite handle is actually closed, not merely forgotten —
    // this is the memory-leak half of the fix, not just the correctness half.
    assert.throws(() => run.tracer.db.query("SELECT 1").get(), /not open/, "finalize() closes the Tracer's sqlite handle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("finalize(id) on an id that was never registered, or already finalized, is a silent no-op", async () => {
  const dir = tmpRepo();
  try {
    await assert.doesNotReject(() => finalize("adw_never_registered"));
    await assert.doesNotReject(() => finalize(null));
    await assert.doesNotReject(() => finalize(undefined));

    const run = await ensure(cfg(), "adw_session_double_finalize", dir, "plan");
    await finalize("adw_session_double_finalize");
    // A second finalize() must not try to close an already-closed handle.
    await assert.doesNotReject(() => finalize("adw_session_double_finalize"));
    void run;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two ensure() calls in one process install the shared signal listener only once", async () => {
  const dirA = tmpRepo();
  const dirB = tmpRepo();
  try {
    await ensure(cfg(), "adw_session_listener_a", dirA, "plan");
    await ensure(cfg(), "adw_session_listener_b", dirB, "plan");

    assert.equal(process.listenerCount("SIGTERM"), baselineSigterm + 1, "a second ensure() must not add a second SIGTERM listener");
    assert.equal(process.listenerCount("SIGINT"), baselineSigint + 1, "a second ensure() must not add a second SIGINT listener");
  } finally {
    await finalize("adw_session_listener_a");
    await finalize("adw_session_listener_b");
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test("a run still active (never finalized) stays in the active set — a signal must still be able to reach it", async () => {
  const dir = tmpRepo();
  try {
    await ensure(cfg(), "adw_session_still_running", dir, "plan");
    assert.ok(activeRunIdsForTest().includes("adw_session_still_running"), "an in-flight run is exactly what the signal handler must still finalize");
  } finally {
    await finalize("adw_session_still_running");
    rmSync(dir, { recursive: true, force: true });
  }
});
