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
