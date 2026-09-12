/**
 * `cli/commands/loop.ts`'s `billableTokensFor` — the readback rule that
 * decides what `--max-tokens` (`overCumulativeBudget`, `core/loop.ts`)
 * actually compares against for one ledger row: BILLABLE tokens, the same
 * metric `defaults.max_run_tokens` checks per-call inside one chain run —
 * never the display total (`total_tokens`, cache reads included).
 *
 * Unit-tested directly against the exact function the readback calls,
 * rather than through a real chain run — same "no gap between what is
 * proven here and what runs" reasoning `budget.test.ts` uses for
 * `assertRunBudget`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { billableTokensFor } from "../cli/commands/loop.js";

test("billableTokensFor: a real run reads billable_tokens, not the display total", () => {
  assert.equal(billableTokensFor({ billable_tokens: 150, total_tokens: 1_000 }), 150);
});

test("billableTokensFor: a row that predates billable tracking (billable_tokens backfilled to 0) falls back to total_tokens", () => {
  assert.equal(billableTokensFor({ billable_tokens: 0, total_tokens: 1_000 }), 1_000);
});

test("billableTokensFor: a db that has never run the billable_tokens migration at all (billable_tokens is null) falls back to total_tokens too", () => {
  assert.equal(billableTokensFor({ billable_tokens: null, total_tokens: 1_000 }), 1_000);
});

test("billableTokensFor: no session row (readback failed, or the iteration never wrote one) is 0", () => {
  assert.equal(billableTokensFor(null), 0);
  assert.equal(billableTokensFor(undefined), 0);
});

test("billableTokensFor: a genuinely free iteration (both 0) is 0, not a crash", () => {
  assert.equal(billableTokensFor({ billable_tokens: 0, total_tokens: 0 }), 0);
});
