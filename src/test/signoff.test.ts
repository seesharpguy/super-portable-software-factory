import "./hermetic_git.ts";

/**
 * Review-accountability thread: an AI reviewer's `approved` flag is a
 * PROPOSAL; `decideSignoff` (chains/simple_sdlc.ts) is where a human DISPOSES
 * of it. These tests drive that function directly — running the whole
 * imperative `simple-sdlc` chain (real agents, a real config, a real
 * session) is far too heavy just to exercise one decision — plus the
 * lighter-weight pieces it depends on: `commitEnvelope`'s trailer handling
 * (chains/steps.ts) and `committerIdentity` (core/git_helper.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AI_ONLY_SIGNOFF_WARNING, decideSignoff, trailerFor } from "../chains/simple_sdlc.ts";
import { commitEnvelope } from "../chains/steps.ts";
import { committerIdentity } from "../core/git_helper.ts";
import type { Asker, SelectChoice } from "../cli/ask.ts";
import type { ReviewOutputT } from "../core/data_types.ts";
import type { PhaseHandle, Run } from "../core/runner.ts";

/** A minimal, schema-shaped ReviewOutputT — only the fields decideSignoff reads. */
function reviewOutput(overrides: Partial<ReviewOutputT> = {}): ReviewOutputT {
  return {
    status: "success",
    summary: "",
    artifacts: [],
    notes_for_next_agent: "",
    approved: false,
    findings: [],
    blocking: [],
    ...overrides,
  };
}

/** Records every `confirm()` call — label, the default it was offered, and any timeout — then answers `answer` every time. */
function scriptedAsker(answer: boolean): {
  asker: Asker;
  calls: Array<{ label: string; dflt: boolean; timeoutMs?: number }>;
} {
  const calls: Array<{ label: string; dflt: boolean; timeoutMs?: number }> = [];
  const asker: Asker = {
    async text(_label, opts) {
      return opts?.default ?? "";
    },
    async select<T extends string>(_label: string, _choices: SelectChoice<T>[], dflt: T): Promise<T> {
      return dflt;
    },
    async confirm(label, dflt, opts) {
      calls.push({ label, dflt, timeoutMs: opts?.timeoutMs });
      return answer;
    },
    async secret() {
      return "";
    },
    note() {},
    heading() {},
    close() {},
  };
  return { asker, calls };
}

// ── decideSignoff ────────────────────────────────────────────────────────

test("decideSignoff: human yes -> accepted, recordedYes true, decision logged against the findings", async () => {
  const { asker, calls } = scriptedAsker(true);
  const logs: Record<string, unknown>[] = [];
  const outcome = await decideSignoff({
    review: reviewOutput({ approved: true, blocking: [], findings: [{ requirement: "does X", met: true, evidence: "src/x.ts" }] }),
    canPrompt: true,
    requireHumanSignoff: false,
    signoffTimeoutSeconds: 300,
    asker,
    identity: { name: "Ada Lovelace", email: "ada@example.com" },
    log: (p) => logs.push(p),
    warn: () => {},
  });
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.recordedYes, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dflt, false, "the prompt's own default must be false, never review.approved (no auto-approval bias)");
  assert.equal(calls[0].timeoutMs, 300_000, "signoffTimeoutSeconds must reach confirm() as milliseconds");
  assert.ok(logs.some((l) => l.decision === "approved" && l.human === true && Array.isArray(l.findings)), "the decision, engineer identity, and findings basis must land in the trace via ph.log");
});

test("decideSignoff: human no -> not accepted, never a recorded yes", async () => {
  const { asker } = scriptedAsker(false);
  const logs: Record<string, unknown>[] = [];
  const outcome = await decideSignoff({
    review: reviewOutput({ approved: true, blocking: ["still missing a test"] }),
    canPrompt: true,
    requireHumanSignoff: false,
    signoffTimeoutSeconds: 300,
    asker,
    identity: { name: "Ada Lovelace", email: "ada@example.com" },
    log: (p) => logs.push(p),
    warn: () => {},
  });
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.recordedYes, false);
  assert.ok(logs.some((l) => l.decision === "declined"));
});

test("decideSignoff: an expired prompt resolves to confirm()'s own default (false) -> not accepted, not a recorded yes", async () => {
  // cli/ask.ts's real confirm() collapses an expired timer into `dflt` — a
  // fake whose confirm mimics that exact collapse is the faithful stand-in
  // for "the timeout fired" without actually waiting out a real clock here.
  const asker: Asker = {
    async text(_l, opts) {
      return opts?.default ?? "";
    },
    async select<T extends string>(_l: string, _c: SelectChoice<T>[], dflt: T): Promise<T> {
      return dflt;
    },
    async confirm(_label, dflt) {
      return dflt;
    },
    async secret() {
      return "";
    },
    note() {},
    heading() {},
    close() {},
  };
  const outcome = await decideSignoff({
    review: reviewOutput({ approved: true }),
    canPrompt: true,
    requireHumanSignoff: false,
    signoffTimeoutSeconds: 1,
    asker,
    identity: undefined,
    log: () => {},
    warn: () => {},
  });
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.recordedYes, false);
});

test("decideSignoff: unattended, require_human_signoff false -> proceeds on the AI verdict alone, with a loud warning printed and logged", async () => {
  const warns: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const outcome = await decideSignoff({
    review: reviewOutput({ approved: true }),
    canPrompt: false,
    requireHumanSignoff: false,
    signoffTimeoutSeconds: 300,
    asker: null,
    identity: undefined,
    log: (p) => logs.push(p),
    warn: (l) => warns.push(l),
  });
  assert.equal(outcome.accepted, true, "review.approved alone gates the commit on this default-false, unattended path");
  assert.equal(outcome.recordedYes, false, "never a recorded human yes when nobody was asked");
  assert.ok(warns.some((w) => w.includes(AI_ONLY_SIGNOFF_WARNING)), "the warning must be loud (printed), not just traced");
  assert.ok(
    logs.some((l) => l.decision === "ai_only" && l.warning === AI_ONLY_SIGNOFF_WARNING),
    "the warning text itself must also land in the traced payload, not just stdout",
  );
});

test("decideSignoff: unattended, require_human_signoff true -> fails the phase closed instead of auto-approving", async () => {
  await assert.rejects(
    () =>
      decideSignoff({
        review: reviewOutput({ approved: true }),
        canPrompt: false,
        requireHumanSignoff: true,
        signoffTimeoutSeconds: 300,
        asker: null,
        identity: undefined,
        log: () => {},
        warn: () => {},
      }),
    /unattended/,
  );
});

test("decideSignoff: no TTY behaves the same as unattended, even if ctx.unattended alone said otherwise — canPrompt is the conjunction", async () => {
  // This is `isInteractive() && !ctx.unattended` already folded down to a
  // single boolean by the caller (simple_sdlc.ts) — decideSignoff itself
  // just trusts `canPrompt`, so this pins that "false" here means the
  // AI-only/fail-closed branch regardless of which half made it false.
  await assert.rejects(
    () =>
      decideSignoff({
        review: reviewOutput({ approved: true }),
        canPrompt: false,
        requireHumanSignoff: true,
        signoffTimeoutSeconds: 300,
        asker: null,
        identity: undefined,
        log: () => {},
        warn: () => {},
      }),
    /unattended/,
  );
});

test("decideSignoff: no git committer identity -> the decision is still logged; the trailer is the caller's problem to skip", async () => {
  const { asker } = scriptedAsker(true);
  const logs: Record<string, unknown>[] = [];
  const warns: string[] = [];
  const outcome = await decideSignoff({
    review: reviewOutput({ approved: true }),
    canPrompt: true,
    requireHumanSignoff: false,
    signoffTimeoutSeconds: 300,
    asker,
    identity: undefined,
    log: (p) => logs.push(p),
    warn: (l) => warns.push(l),
  });
  assert.equal(outcome.recordedYes, true, "the human said yes — a missing identity affects the trailer, never the decision itself");
  assert.ok(logs.some((l) => typeof l.note === "string" && l.note.includes("without a git committer identity")));
});

// ── trailerFor: the join between decideSignoff and commitEnvelope ────────

test("trailerFor: the AI-only path's recordedYes:false reaches commitEnvelope as null, even when accepted is true and an identity exists", () => {
  // The exact join this test guards: a refactor that swapped `recordedYes`
  // for `accepted` (or `verified`) at the commit_build call site would keep
  // every other test in this suite green while minting trailers for
  // AI-only commits.
  const identity = { name: "Ada Lovelace", email: "ada@example.com" };
  assert.equal(trailerFor({ accepted: true, recordedYes: false }, identity), null);
});

test("trailerFor: a recorded human yes with an identity reaches commitEnvelope as that identity", () => {
  const identity = { name: "Ada Lovelace", email: "ada@example.com" };
  assert.deepEqual(trailerFor({ accepted: true, recordedYes: true }, identity), identity);
});

test("trailerFor: a recorded human yes with no git identity configured still yields null, not a fabricated one", () => {
  assert.equal(trailerFor({ accepted: true, recordedYes: true }, undefined), null);
});

// ── commitEnvelope's trailer ─────────────────────────────────────────────

function fakeCommitRun(): { run: Run; committed: string[] } {
  const committed: string[] = [];
  const run = {
    adw_id: "abcd1234",
    git: {
      commitAll: (message: string) => {
        committed.push(message);
        return "abc1234";
      },
    },
  } as unknown as Run;
  return { run, committed };
}

function fakePh(): PhaseHandle {
  return {
    log: () => {},
    call: async () => {
      throw new Error("not used by these tests");
    },
  } as unknown as PhaseHandle;
}

test("commitEnvelope: a recorded human sign-off appends a real Signed-off-by trailer", () => {
  const { run, committed } = fakeCommitRun();
  commitEnvelope(
    run,
    fakePh(),
    { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "", commit_message: "Implement the thing" },
    { name: "Ada Lovelace", email: "ada@example.com" },
  );
  assert.equal(committed.length, 1);
  assert.equal(committed[0], "Implement the thing\n\nSigned-off-by: Ada Lovelace <ada@example.com>");
});

test("commitEnvelope: no signoff argument -> no trailer, ever", () => {
  const { run, committed } = fakeCommitRun();
  commitEnvelope(run, fakePh(), {
    status: "success",
    summary: "did it",
    artifacts: [],
    notes_for_next_agent: "",
    commit_message: "Implement the thing",
  });
  assert.equal(committed[0], "Implement the thing");
  assert.doesNotMatch(committed[0], /Signed-off-by/);
});

test("commitEnvelope: an explicit null signoff (identity was unset) -> no trailer, same as omitted", () => {
  const { run, committed } = fakeCommitRun();
  commitEnvelope(
    run,
    fakePh(),
    { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "", commit_message: "Fixed it" },
    null,
  );
  assert.doesNotMatch(committed[0], /Signed-off-by/);
});

test("commitEnvelope: a lone conventional-commit subject is never mistaken for a trailer block", () => {
  // Regression: `feat: add X` matches TRAILER_LINE's `Key: value` shape, but
  // a single paragraph is the SUBJECT, never an existing trailer block — the
  // trailer must land after a blank line, not glued onto the subject with no
  // separator (which git would not recognize as a trailer at all).
  const { run, committed } = fakeCommitRun();
  commitEnvelope(
    run,
    fakePh(),
    { status: "success", summary: "did it", artifacts: [], notes_for_next_agent: "", commit_message: "feat: add the signoff gate" },
    { name: "Ada Lovelace", email: "ada@example.com" },
  );
  assert.equal(committed[0], "feat: add the signoff gate\n\nSigned-off-by: Ada Lovelace <ada@example.com>");
});

test("commitEnvelope: a real body ending in a Key: value block still joins rather than growing a blank-line-separated second block", () => {
  const { run, committed } = fakeCommitRun();
  commitEnvelope(
    run,
    fakePh(),
    { status: "success", summary: "", artifacts: [], notes_for_next_agent: "", commit_message: "wip\n\nNote: I did stuff" },
    { name: "Ada Lovelace", email: "ada@example.com" },
  );
  assert.equal(committed[0], "wip\n\nNote: I did stuff\nSigned-off-by: Ada Lovelace <ada@example.com>");
});

test("commitEnvelope: an agent-authored message that already carries this exact Signed-off-by line is not duplicated", () => {
  const { run, committed } = fakeCommitRun();
  commitEnvelope(
    run,
    fakePh(),
    {
      status: "success",
      summary: "",
      artifacts: [],
      notes_for_next_agent: "",
      commit_message: "feat: add the signoff gate\n\nSigned-off-by: Ada Lovelace <ada@example.com>",
    },
    { name: "Ada Lovelace", email: "ada@example.com" },
  );
  assert.equal(committed[0], "feat: add the signoff gate\n\nSigned-off-by: Ada Lovelace <ada@example.com>");
  assert.equal(committed[0].match(/Signed-off-by/g)?.length, 1);
});

test("commitEnvelope: joins an already-trailered message's block instead of starting a second one", () => {
  const { run, committed } = fakeCommitRun();
  commitEnvelope(
    run,
    fakePh(),
    {
      status: "success",
      summary: "",
      artifacts: [],
      notes_for_next_agent: "",
      commit_message: "Implement the thing\n\nCo-authored-by: Bot <bot@example.com>",
    },
    { name: "Ada Lovelace", email: "ada@example.com" },
  );
  assert.equal(committed[0], "Implement the thing\n\nCo-authored-by: Bot <bot@example.com>\nSigned-off-by: Ada Lovelace <ada@example.com>");
});

// ── committerIdentity ────────────────────────────────────────────────────

test("committerIdentity: reads the repo-local user.name/user.email", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-signoff-identity-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Ada Lovelace"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "ada@example.com"], { cwd: dir, stdio: "ignore" });
    assert.deepEqual(committerIdentity(dir), { name: "Ada Lovelace", email: "ada@example.com" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("committerIdentity: undefined (never a fallback literal) when no config carries a name/email", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-signoff-identity-unset-"));
  const fakeHome = mkdtempSync(path.join(tmpdir(), "spf-signoff-fakehome-"));
  const saved = {
    HOME: process.env.HOME,
    GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
    GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
  };
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    // Isolate from whatever global/system gitconfig the host running this
    // suite happens to have — otherwise "unset" is only true by accident.
    process.env.HOME = fakeHome;
    process.env.GIT_CONFIG_GLOBAL = path.join(fakeHome, "does-not-exist");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    assert.equal(committerIdentity(dir), undefined);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
