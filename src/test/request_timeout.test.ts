/**
 * `defaults.request_timeout_ms` — maps onto Flue's `AgentStatics.durability.
 * timeoutMs`, so a connection that dies mid-call (silently, with no error and
 * no data) settles as a failure Flue itself can name, instead of hanging
 * until spf watch's own coarse orphan-reconciliation eventually notices.
 *
 * Two things are worth pinning, mirroring budget.test.ts's own reasoning for
 * `max_run_cost`/`max_run_tokens`:
 *
 *  1. ABSENT BY DEFAULT IS A TOTAL NO-OP — every repo that upgrades into this
 *     must behave byte-identically (Flue's own default, 1 hour / 10 attempts,
 *     applies unchanged).
 *  2. IT IS NOT BACK-FILLED ONTO AGENTS — like the run-budget ceilings, this
 *     is process-scoped (one shared Flue agent function, one `spf` process
 *     per repo), not a per-agent setting; a stray copy onto an agent would be
 *     silently stripped by `AgentConfigSchema`'s non-strict parse rather than
 *     rejected, so the mistake would look like it worked.
 *
 * The actual `AgentStatics.durability` wiring (`agent_flue.ts`'s
 * `ensureRuntime()`) is not exercised here — `SfAgent`/`ensureRuntime` aren't
 * exported, matching this file's sibling `agent_flue.test.ts`, which only
 * tests exported pure functions. Verified by hand instead: a real repo with
 * `request_timeout_ms: 3000` against a TCP listener that accepts the
 * connection and then sends nothing (a true silent hang, not a refused
 * connection) failed with `flue submission failed: Submission exceeded the
 * configured timeout.` — bounded, not indefinite — though it took ~15s
 * wall-clock, not 3s: Flue's own timeout check appears to run on a coarser
 * periodic sweep, not instantaneously at the deadline. Still a firm
 * improvement over Flue's UNCONFIGURED default (1 hour), and still bounded
 * rather than truly indefinite, but don't expect the configured value to be
 * a precise deadline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { ConfigDefaultsSchema } from "../core/data_types.js";
import { loadConfig } from "../core/agents.js";

test("request_timeout_ms is absent by default — the config shape is unchanged for every repo that upgrades", () => {
  const defaults = v.parse(ConfigDefaultsSchema, {});
  assert.equal(defaults.request_timeout_ms, undefined);
});

test("request_timeout_ms rejects zero, negative, and fractional values; accepts a positive integer", () => {
  for (const bad of [0, -1, -1000]) {
    assert.throws(() => v.parse(ConfigDefaultsSchema, { request_timeout_ms: bad }), `request_timeout_ms ${bad} must be rejected`);
  }
  assert.throws(
    () => v.parse(ConfigDefaultsSchema, { request_timeout_ms: 1.5 }),
    "request_timeout_ms is a millisecond COUNT — a fraction is a mistake, not a rounding hint",
  );
  assert.doesNotThrow(() => v.parse(ConfigDefaultsSchema, { request_timeout_ms: 300_000 }), "five minutes is a legitimate ceiling");
});

test("request_timeout_ms is NOT back-filled onto agents — it is process-scoped, not per-agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-request-timeout-backfill-test-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(
      configPath,
      "defaults:\n" +
        "  model: shared/model\n" +
        "  request_timeout_ms: 300000\n" +
        "agents:\n" +
        "  - name: builder\n" +
        "    prompt_engineering:\n" +
        "      system: s.md\n" +
        "      user: u.md\n",
    );
    const cfg = loadConfig([configPath]);
    const builder = cfg.agents.find((a) => a.name === "builder")!;
    assert.equal(builder.model, "shared/model", "the per-agent keys ARE still back-filled — this test must fail loudly if that broke");
    assert.equal((builder as Record<string, unknown>)["request_timeout_ms"], undefined);
    assert.equal(cfg.defaults.request_timeout_ms, 300_000, "the ceiling lives on defaults, where agents.ts's send() reads it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
