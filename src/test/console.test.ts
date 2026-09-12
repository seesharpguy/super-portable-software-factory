/**
 * `Console.sessionFinished`'s printed "cost" line — plain vs. labeled
 * estimate.
 *
 * The label exists because `claude_code`'s own `total_cost_usd` (folded into
 * `UsageBreakdown.total_cost` by `agent_cc.ts`) is Anthropic's price table
 * applied client-side, honest only when Anthropic itself served the
 * request. Pointed at a gateway (a custom `ANTHROPIC_BASE_URL`), the same
 * number is a plausible-looking GUESS, not a fact about what was actually
 * billed — `runner.ts`'s `Run` computes that once (`agents.ts`'s
 * `isGatewayEstimatedCost`) and hands it to `sessionFinished` as
 * `costIsEstimate`, tested directly here without needing a real `Run`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Console } from "../core/console.js";

function makeConsole(): { console: Console; lines: string[] } {
  const lines: string[] = [];
  const fakeTracer = { event: async () => "evt" };
  const console_ = new Console(fakeTracer, "adw1", null, "test-chain", (line: string) => lines.push(line), null);
  return { console: console_, lines };
}

test("sessionFinished: a plain dollar figure by default — costIsEstimate omitted", async () => {
  const { console: c, lines } = makeConsole();
  await c.sessionFinished(true, 1000, 0.25, "db.sqlite");
  const rendered = lines.join("\n");
  assert.match(rendered, /\$0\.2500/);
  assert.doesNotMatch(rendered, /estimate/);
});

test("sessionFinished: a plain dollar figure when costIsEstimate is explicitly false", async () => {
  const { console: c, lines } = makeConsole();
  await c.sessionFinished(true, 1000, 0.25, "db.sqlite", false);
  const rendered = lines.join("\n");
  assert.match(rendered, /\$0\.2500/);
  assert.doesNotMatch(rendered, /estimate/);
});

test("sessionFinished: labels the cost line as an estimate when costIsEstimate is true, without changing the number", async () => {
  const { console: c, lines } = makeConsole();
  await c.sessionFinished(true, 1000, 0.25, "db.sqlite", true);
  const rendered = lines.join("\n");
  assert.match(rendered, /≈ \$0\.2500 \(claude_code estimate; gateway-billed\)/);
});
