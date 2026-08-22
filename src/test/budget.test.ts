/**
 * The run budget: `defaults.max_run_cost` / `defaults.max_run_tokens`.
 *
 * Three things are worth pinning, and they are the three ways this feature can
 * silently stop existing:
 *
 *  1. ABSENT BY DEFAULT IS A TOTAL NO-OP. Every repo that upgrades into this
 *     must behave byte-identically, so "no ceilings, enormous spend, no throw"
 *     is a real test and not a tautology.
 *  2. THE CHECK IS BEFORE, AND IT IS `>=`. The cost of the call about to
 *     happen is unknowable, so the ceiling can only be enforced as "no further
 *     calls" — which makes reaching it exactly, not passing it, the trip point.
 *     A `>` here would make every ceiling soft by one unbounded call.
 *  3. THE MERGE SURVIVES. `agents.ts`'s `mergeRawConfig` is a FIXED-SHAPE
 *     object literal (see its own doc comment): a `defaults` key that isn't
 *     named on both sides of it is dropped before `SFConfigSchema` ever sees
 *     it, and parsing then succeeds anyway on the schema default. `defaults`
 *     is already spread, so these keys ride along — this proves it rather than
 *     assuming it, exactly as the `review`/`observability.otel` tests do.
 *
 * `assertRunBudget` is tested directly against a fake-usage run rather than
 * through `agents.execute()`: `execute()` spawns a real coding agent, and the
 * function under test IS the one `execute()`'s `send()` calls before every
 * dispatch, so there is no gap between what is proven here and what runs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { ConfigDefaultsSchema, SFConfigSchema, type SFConfig } from "../core/data_types.js";
import { BudgetExceeded, assertRunBudget, formatUsd, loadConfig } from "../core/agents.js";

/** A `Run`-shaped budget subject with dictated usage — see `RunBudgetState`. */
function fakeRun(defaults: Record<string, unknown>, usage: { tokens: number; cost: number }) {
  const cfg = v.parse(SFConfigSchema, { defaults }) as SFConfig;
  return { cfg, tokens: usage.tokens, cost: usage.cost };
}

test("both ceilings are absent by default — the config shape is unchanged for every repo that upgrades", () => {
  const defaults = v.parse(ConfigDefaultsSchema, {});
  assert.equal(defaults.max_run_cost, undefined);
  assert.equal(defaults.max_run_tokens, undefined);
});

test("absent ceilings never throw, no matter what the run has spent", () => {
  assert.doesNotThrow(() => assertRunBudget(fakeRun({}, { tokens: 999_999_999, cost: 12_345.67 })));
});

test("max_run_cost trips before the next call, naming the ceiling and the spend", () => {
  const run = fakeRun({ max_run_cost: 0.4 }, { tokens: 0, cost: 0.412 });
  assert.throws(
    () => assertRunBudget(run),
    (error: unknown) => {
      assert.ok(error instanceof BudgetExceeded, "must be its own error class, so a caller can tell a budget stop from a broken agent");
      assert.equal(
        (error as Error).message,
        "run budget exceeded: $0.412 of max_run_cost $0.40 — raise defaults.max_run_cost or split the work",
        "the message must name both numbers and the way out — it is the only thing a stopped operator sees",
      );
      return true;
    },
  );
});

test("max_run_tokens trips independently of cost, with thousands separators", () => {
  const run = fakeRun({ max_run_tokens: 1_000_000 }, { tokens: 1_048_576, cost: 0 });
  assert.throws(
    () => assertRunBudget(run),
    (error: unknown) => {
      // A bare RegExp handed to `assert.throws` is matched against
      // `String(error)` ("Error: <message>" for an unnamed Error subclass),
      // not `.message` — see the sibling max_run_cost test just above, which
      // checks `.message` directly for exactly this reason. Anchoring a
      // `^...$` regex there would silently require an "Error: " prefix that
      // has nothing to do with the budget message itself, so this checks the
      // real message the same way.
      assert.ok(error instanceof BudgetExceeded, "must be its own error class, so a caller can tell a budget stop from a broken agent");
      assert.match(
        (error as Error).message,
        /^run budget exceeded: 1,048,576 tokens of max_run_tokens 1,000,000 — raise defaults\.max_run_tokens or split the work$/,
      );
      return true;
    },
  );
});

test("cost is checked before tokens when both are blown — one message, the money one", () => {
  const run = fakeRun({ max_run_cost: 0.4, max_run_tokens: 100 }, { tokens: 5_000, cost: 1.0 });
  assert.throws(() => assertRunBudget(run), /max_run_cost/);
});

test("a run still under both ceilings passes", () => {
  assert.doesNotThrow(() => assertRunBudget(fakeRun({ max_run_cost: 0.4, max_run_tokens: 1_000 }, { tokens: 999, cost: 0.399 })));
});

// This is the whole "hard cap on FURTHER spend, not a post-hoc report"
// semantic, reduced to one assertion. At exactly the ceiling there is nothing
// left to spend, so the next call must not happen.
test("reaching the ceiling exactly stops the next call (>=, not >)", () => {
  assert.throws(() => assertRunBudget(fakeRun({ max_run_cost: 0.4 }, { tokens: 0, cost: 0.4 })), BudgetExceeded);
  assert.throws(() => assertRunBudget(fakeRun({ max_run_tokens: 1_000 }, { tokens: 1_000, cost: 0 })), BudgetExceeded);
});

test("a zero or negative ceiling is refused at parse time, not treated as a budget of nothing", () => {
  for (const bad of [0, -1, -0.01]) {
    assert.throws(() => v.parse(ConfigDefaultsSchema, { max_run_cost: bad }), `max_run_cost ${bad} must be rejected`);
    assert.throws(() => v.parse(ConfigDefaultsSchema, { max_run_tokens: bad }), `max_run_tokens ${bad} must be rejected`);
  }
  assert.throws(() => v.parse(ConfigDefaultsSchema, { max_run_tokens: 1.5 }), "max_run_tokens is a token COUNT — a fraction is a mistake, not a rounding hint");
  assert.doesNotThrow(() => v.parse(ConfigDefaultsSchema, { max_run_cost: 0.0001 }), "a tiny but positive cost ceiling is legitimate");
});

test("formatUsd keeps sub-cent precision but prints a round ceiling the way it was written", () => {
  assert.equal(formatUsd(0.412), "$0.412");
  assert.equal(formatUsd(0.4), "$0.40");
  assert.equal(formatUsd(1.5), "$1.50");
  assert.equal(formatUsd(0.001), "$0.001");
});

test("both keys survive loadConfig's merge — the silent-drop trap mergeRawConfig's fixed-shape literal sets", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-budget-merge-test-"));
  try {
    const single = join(dir, "spf.config.yaml");
    writeFileSync(single, "defaults:\n  max_run_cost: 0.75\n  max_run_tokens: 250000\n");
    const cfg = loadConfig([single]);
    assert.equal(cfg.defaults.max_run_cost, 0.75, "a defaults value from a real config file must reach SFConfig, not be dropped before parse");
    assert.equal(cfg.defaults.max_run_tokens, 250_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ceilings merge key-by-key across layered config files, like the rest of defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-budget-layered-test-"));
  try {
    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(base, "defaults:\n  model: base/model\n  max_run_cost: 1.0\n  max_run_tokens: 100000\n");
    writeFileSync(override, "defaults:\n  max_run_cost: 0.25\n");
    const cfg = loadConfig([base, override]);
    assert.equal(cfg.defaults.max_run_cost, 0.25, "the override wins for the key it names");
    assert.equal(cfg.defaults.max_run_tokens, 100_000, "unset in the override -> the base's value survives (key-by-key, not a whole-block replace)");
    assert.equal(cfg.defaults.model, "base/model", "and defaults' other keys are unaffected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The documented back-fill trap: loadConfig copies a handful of `defaults`
// keys DOWN onto each agent. These two are RUN-scoped and must never join that
// list — and because AgentConfigSchema is a non-strict v.object, a stray copy
// would be silently STRIPPED rather than rejected, so the mistake would look
// like it worked. This asserts the absence directly.
test("the ceilings are NOT back-filled onto agents — they are run-scoped, not per-agent", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-budget-backfill-test-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(
      configPath,
      "defaults:\n" +
        "  model: shared/model\n" +
        "  max_run_cost: 0.5\n" +
        "  max_run_tokens: 1000\n" +
        "agents:\n" +
        "  - name: builder\n" +
        "    prompt_engineering:\n" +
        "      system: s.md\n" +
        "      user: u.md\n",
    );
    const cfg = loadConfig([configPath]);
    const builder = cfg.agents.find((a) => a.name === "builder")!;
    assert.equal(builder.model, "shared/model", "the per-agent keys ARE still back-filled — this test must fail loudly if that broke");
    assert.equal((builder as Record<string, unknown>)["max_run_cost"], undefined);
    assert.equal((builder as Record<string, unknown>)["max_run_tokens"], undefined);
    assert.equal(cfg.defaults.max_run_cost, 0.5, "the ceilings live on defaults, where assertRunBudget reads them");
    assert.equal(cfg.defaults.max_run_tokens, 1_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
