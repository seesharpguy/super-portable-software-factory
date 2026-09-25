/**
 * Regression test for `clearStaleRefineOutputFiles` — extracted specifically
 * so this is testable without constructing a full `Run`/chain harness (no
 * existing test does; `Run` needs a Tracer, Console, Notifier, GitHandle,
 * ...). See `publishIssues()`'s own call site and this function's doc
 * comment in `chains/steps.ts` for the real-world bug this closes: a resumed
 * spec reruns the whole `refine` chain into the SAME deterministic
 * `context_handoff_dir` a prior escalation round already wrote into, and
 * without this, a stale `refine_questions.json` from that earlier round
 * survived a LATER round's successful publish — `cli/commands/watch.ts`'s
 * `runRefine()` read it back and reported those old questions as raised
 * again, so the spec got re-escalated over issues that had already been
 * created on the tracker seconds earlier.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStaleRefineOutputFiles } from "../chains/steps.js";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "spf-steps-test-"));
}

test("clearStaleRefineOutputFiles: removes a stale refine_questions.json left over from an earlier escalation round", () => {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, "refine_questions.json"), "[]");
    clearStaleRefineOutputFiles(dir);
    assert.equal(existsSync(join(dir, "refine_questions.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearStaleRefineOutputFiles: removes a stale refine_publish.json too", () => {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, "refine_publish.json"), "[]");
    clearStaleRefineOutputFiles(dir);
    assert.equal(existsSync(join(dir, "refine_publish.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearStaleRefineOutputFiles: clears both at once — the actual failure mode was one stale file surviving alongside a fresh other one", () => {
  const dir = makeDir();
  try {
    writeFileSync(join(dir, "refine_questions.json"), "[]");
    writeFileSync(join(dir, "refine_publish.json"), "[]");
    clearStaleRefineOutputFiles(dir);
    assert.equal(existsSync(join(dir, "refine_questions.json")), false);
    assert.equal(existsSync(join(dir, "refine_publish.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearStaleRefineOutputFiles: a first-ever run with neither file present is a no-op, not an error", () => {
  const dir = makeDir();
  try {
    assert.doesNotThrow(() => clearStaleRefineOutputFiles(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Step.gate: every writer of state.accepted declares itself (#109) ──────

test("Step.gate: every step factory that writes state.accepted carries gate: true, and the ones that don't, don't", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const steps = await import("../chains/steps.js");
  // Read the SOURCE (tests run from dist/test/, the source sits at src/chains/)
  // so a future factory that starts assigning state.accepted is caught here
  // even if nobody remembers the graph loader derives commit gating from it.
  const source = readFileSync(fileURLToPath(new URL("../../src/chains/steps.ts", import.meta.url)), "utf8");
  const starts = [...source.matchAll(/^export function (\w+)\(/gm)];
  const writers: string[] = [];
  for (const [i, m] of starts.entries()) {
    const block = source.slice(m.index, starts[i + 1]?.index ?? source.length);
    if (!/state\.accepted\s*=(?!=)/.test(block)) continue;
    writers.push(m[1]!);
    assert.match(block, /gate: true/, `${m[1]} writes state.accepted but does not declare gate: true`);
  }
  assert.deepEqual(writers.sort(), ["fixLoop", "qualityCheck", "reviseLoop"]);

  assert.equal(steps.qualityCheck({ suite: "test" }).gate, true);
  assert.equal(steps.fixLoop({ suite: "test" }).gate, true);
  assert.equal(steps.reviseLoop().gate, true);
  for (const s of [steps.request(), steps.plan(), steps.build(), steps.commit(), steps.commit({ onlyIfAccepted: true }), steps.document()]) {
    assert.equal(s.gate, undefined);
  }
});
