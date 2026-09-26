/**
 * Jev `finding_triage` (#106) — through its REAL call site: a `startRun`
 * Run (real config parse, real `run.jev`, real trace db) driving
 * `steps.reviseLoop`, with only the coding agents scripted. `run.phase` is
 * wrapped, not replaced, so phases, phase ids and trace rows are the real
 * ones; the wrapper swaps `ph.call` for a responder that records the
 * `previous` envelope each phase was handed — the exact thing triage shapes.
 *
 * Jev itself is always a `FakeJevClient` via `setJevClientFactory` (reset in
 * `finally`): nothing here touches the network.
 */
import "./hermetic_git.js";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type EnvelopeBase, type ReviewOutputT } from "../core/data_types.js";
import * as gates from "../core/gates.js";
import { JEV_DECISION_EVENT, createJev, parseRecordedDecision, setJevClientFactory, type SystemOneRequest } from "../core/jev.js";
import { Run, type PhaseHandle } from "../core/runner.js";
import * as simpleSdlc from "../chains/simple_sdlc.js";
import { FINDING_TRIAGE_CLASSES, FINDING_TRIAGE_KIND, JEV_DECISION_KINDS } from "../core/jev_kinds.js";
import * as steps from "../chains/steps.js";
import {
  FINDING_TRIAGE_EVENT,
  FINDING_TRIAGE_OPTIONS,
  MAX_TRIAGED_FINDINGS,
  TRIAGE_REQUEST_CHAR_BUDGET,
  TRIAGE_STATE_CHAR_BUDGET,
  applyFindingTriage,
  findingFingerprint,
  findingTriageKey,
  resolveFindingTriage,
} from "../chains/finding_triage.js";
import { FakeJevClient } from "./fake_jev.js";

type StartedRun = Awaited<ReturnType<typeof steps.startRun>>;

const REAL = { requirement: "POST /items returns 201 with the created item", met: false, evidence: "handler returns 200 and an empty body" };
const NOISE = { requirement: "Add retries to the database driver", met: false, evidence: "not part of this request" };
const STYLE = { requirement: "Rename `tmp` to something descriptive", met: false, evidence: "src/items.ts:14" };
const MET = { requirement: "GET /items lists items", met: true, evidence: "src/items.ts:3" };

function rejectingReview(overrides: Partial<ReviewOutputT> = {}): ReviewOutputT {
  return {
    status: "success",
    summary: "two gaps and a nit",
    artifacts: [],
    notes_for_next_agent: "Focus on the handler.",
    approved: false,
    findings: [MET, REAL, NOISE, STYLE],
    blocking: [REAL.requirement, "  add retries to the DATABASE driver ", "Make it faster"],
    ...overrides,
  };
}

const BUILD: EnvelopeBase & { changed_files: string[]; commit_message: string } = {
  status: "success",
  summary: "revised",
  artifacts: [],
  notes_for_next_agent: "",
  changed_files: [],
  commit_message: "",
};

interface Handoff {
  phase: string;
  previous: EnvelopeBase | null | undefined;
}

/** A real phase handle whose `call` answers from `respond` and records what it was handed. */
function scriptedHandle(ph: PhaseHandle, phase: string, respond: (phase: string) => EnvelopeBase, handoffs: Handoff[]): PhaseHandle {
  return {
    phase_id: ph.phase_id,
    log: (payload: Record<string, unknown>) => ph.log(payload),
    call: (async (call: { previous?: EnvelopeBase | null }) => {
      handoffs.push({ phase, previous: call.previous });
      return respond(phase);
    }) as PhaseHandle["call"],
  };
}

/** Wrap the real `run.phase` so each `ph.call` answers from `respond` and records what it was handed. */
function scriptAgents(run: StartedRun, respond: (phase: string) => EnvelopeBase): Handoff[] {
  const handoffs: Handoff[] = [];
  const realPhase = run.phase.bind(run);
  (run as unknown as { phase: unknown }).phase = <T>(params: { name: string }, fn: (ph: PhaseHandle) => Promise<T>) =>
    realPhase(params as Parameters<typeof realPhase>[0], (ph) => fn(scriptedHandle(ph, params.name, respond, handoffs)));
  return handoffs;
}

/** Every handoff triage produces must still pass the review gate the reviewer's own envelope passed. */
function assertVerdictConsistent(run: StartedRun, handoff: ReviewOutputT): void {
  const report = gates.verdictConsistent(handoff, run);
  assert.ok(report.passed, `the triaged handoff must still satisfy verdictConsistent: ${report.violations.join("; ")}`);
}

/**
 * Sibling Jev kinds that fire in the same run (`loop_control` after each
 * failed review round of `reviseLoop`/`simple_sdlc`) are pinned `off` in
 * every jev-enabled config below, so every Jev call and `jev_decision` row
 * these tests count belongs to `finding_triage`. An explicit
 * `finding_triage` entry in the test's own yaml is kept as written.
 */
function siblingKindsOff(yaml: string): string {
  const OFF = "    loop_control: { mode: off }\n";
  if (!yaml.startsWith("jev:\n")) return yaml;
  if (yaml.includes("\n  decisions:\n")) return yaml.replace("\n  decisions:\n", `\n  decisions:\n${OFF}`);
  return yaml.replace("jev:\n", `jev:\n  decisions:\n${OFF}`);
}

async function withStartedRun(yaml: string, adwId: string, body: (run: StartedRun) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "spf-jev-triage-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, siblingKindsOff(yaml));
    const run = await steps.startRun(
      { prompt: "Add POST /items", config_paths: [configPath], adw_id: adwId, cwd: dir, chain_name: "build-review", unattended: true },
      [],
      [],
    );
    try {
      await body(run);
    } finally {
      await run.tracer.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function rows(run: StartedRun, adwId: string, name: string): Promise<Array<{ phase_id: string; payload_json: string }>> {
  return (await run.tracer.db.query("SELECT phase_id, payload_json FROM events WHERE adw_id=? AND type='log' AND name=?").all(adwId, name)) as Array<{
    phase_id: string;
    payload_json: string;
  }>;
}

function stateFor(prompt: string): steps.ChainState {
  return { prompt, options: {}, previous: null, quality: null, review: null, changeset: null, baseline: "", issue_id: null, accepted: true, reason: "" };
}

/**
 * Run `reviseLoop({max: 2})` against a reviewer that rejects every round
 * with `review`: review_1 -> revise_1 -> review_2, then stop (never approved).
 */
async function runReviseLoop(
  run: StartedRun,
  review: ReviewOutputT = rejectingReview(),
  prompt = "Add POST /items",
): Promise<{ state: steps.ChainState; handoffs: Handoff[]; review: ReviewOutputT }> {
  const handoffs = scriptAgents(run, (phase) => (phase.startsWith("review_") ? review : BUILD));
  const state = stateFor(prompt);
  await steps.reviseLoop({ max: 2 })(run, state);
  return { state, handoffs, review };
}

function reviseHandoff(handoffs: Handoff[]): ReviewOutputT {
  const h = handoffs.find((x) => x.phase === "revise_1");
  assert.ok(h, "revise_1 must have run");
  return h.previous as ReviewOutputT;
}

async function withFake(fake: FakeJevClient, body: () => Promise<void>): Promise<void> {
  setJevClientFactory(() => fake);
  try {
    await body();
  } finally {
    setJevClientFactory(null);
  }
}

const choice = (c: string, confidence = 0.95) => ({ type: "choice", choice: c, confidence });
// Unmet findings in review order are REAL, NOISE, STYLE -> questions q0, q1, q2.
const HONEST = FakeJevClient.answering({ q0: choice("real"), q1: choice("noise"), q2: choice("style") });

// ── registry ───────────────────────────────────────────────────────────────

test("finding_triage: registered kind, call-site options built from the kind's own tuple", () => {
  assert.equal(JEV_DECISION_KINDS["finding_triage"], FINDING_TRIAGE_KIND);
  assert.deepEqual(FINDING_TRIAGE_KIND.options, FINDING_TRIAGE_CLASSES);
  assert.deepEqual(
    FINDING_TRIAGE_OPTIONS.map((o) => o.value),
    [...FINDING_TRIAGE_CLASSES],
  );
});

test("finding_triage: key is a requirement fingerprint + round — stable across evidence/whitespace/case, never an index (R1)", () => {
  assert.equal(findingFingerprint({ requirement: "Rename  `tmp`\n" }), findingFingerprint({ requirement: "rename `TMP`" }));
  assert.notEqual(findingFingerprint(REAL), findingFingerprint(NOISE));
  assert.equal(findingTriageKey(2, REAL), `revise_2:${findingFingerprint(REAL)}`);
});

// ── R8: no jev: block ──────────────────────────────────────────────────────

test("finding_triage R8: with NO jev: block, reviseLoop hands the fixer the reviewer's envelope itself — zero calls, zero jev rows", async () => {
  const fake = FakeJevClient.choosing("noise", 0.99);
  await withFake(fake, async () => {
    const adwId = "adw_triage_r8";
    await withStartedRun("watch:\n  repo: acme/widgets\n", adwId, async (run) => {
      const { state, handoffs, review } = await runReviseLoop(run);
      assert.equal(reviseHandoff(handoffs), review, "the handoff is the reviewer's own object — byte-for-byte today's behavior");
      assert.deepEqual(
        handoffs.map((h) => h.phase),
        ["review_1", "revise_1", "review_2"],
      );
      assert.equal(fake.calls.length, 0);
      assert.equal((await rows(run, adwId, JEV_DECISION_EVENT)).length, 0);
      assert.equal((await rows(run, adwId, FINDING_TRIAGE_EVENT)).length, 0);
      assert.equal(state.accepted, false);
      assert.equal(state.review, review);
    });
  });
});

test("finding_triage: jev enabled but finding_triage mode: off — no call, no row, untouched handoff; extras not even parsed", async () => {
  const fake = FakeJevClient.choosing("noise", 0.99);
  await withFake(fake, async () => {
    const adwId = "adw_triage_kind_off";
    const yaml = "jev:\n  enabled: true\n  mode: act\n  decisions:\n    finding_triage: { mode: off, drop: bogus }\n";
    await withStartedRun(yaml, adwId, async (run) => {
      const { handoffs, review } = await runReviseLoop(run);
      assert.equal(reviseHandoff(handoffs), review);
      assert.equal(fake.calls.length, 0);
      assert.equal((await rows(run, adwId, JEV_DECISION_EVENT)).length, 0);
    });
  });
});

// ── shadow ─────────────────────────────────────────────────────────────────

test("finding_triage shadow: one batch call, one jev_decision per unmet finding on the revise phase — but the fallback (real) acts", async () => {
  await withFake(HONEST, async () => {
    const adwId = "adw_triage_shadow";
    await withStartedRun("jev:\n  enabled: true\n", adwId, async (run) => {
      const before = HONEST.calls.length;
      const { handoffs, review } = await runReviseLoop(run);
      assert.equal(reviseHandoff(handoffs), review, "shadow never reshapes the handoff");
      assert.equal(HONEST.calls.length - before, 1, "one HTTP call for the whole review");
      assert.deepEqual(Object.keys(HONEST.calls[HONEST.calls.length - 1]!.questions), ["q0", "q1", "q2"], "MET findings are never asked about");
      const decisionRows = await rows(run, adwId, JEV_DECISION_EVENT);
      assert.equal(decisionRows.length, 3);
      const revisePhase = run.phases.find((p) => p.params.name === "revise_1")!;
      for (const r of decisionRows) assert.equal(r.phase_id, revisePhase.phase_id);
      const decisions = decisionRows.map((r) => parseRecordedDecision(JSON.parse(r.payload_json))!);
      assert.deepEqual(
        decisions.map((d) => [d.key, d.jev_choice, d.choice, d.reason]),
        [
          [findingTriageKey(1, REAL), "real", "real", "shadow"],
          [findingTriageKey(1, NOISE), "noise", "real", "shadow"],
          [findingTriageKey(1, STYLE), "style", "real", "shadow"],
        ],
      );
      assert.equal((await rows(run, adwId, FINDING_TRIAGE_EVENT)).length, 0, "nothing acted, so no triage outcome row");
    });
  });
});

// ── act ────────────────────────────────────────────────────────────────────

test("finding_triage act (drop: none): noise/style leave findings + exact-match blocking and are listed under 'Deprioritized by jev'", async () => {
  await withFake(HONEST, async () => {
    const adwId = "adw_triage_act";
    await withStartedRun("jev:\n  enabled: true\n  decisions:\n    finding_triage: { mode: act }\n", adwId, async (run) => {
      const { state, handoffs, review } = await runReviseLoop(run);
      const handoff = reviseHandoff(handoffs);
      assert.notEqual(handoff, review);
      assert.deepEqual(handoff.findings, [MET, REAL], "met findings pass through; only the real unmet one is still asked for");
      assert.deepEqual(handoff.blocking, [REAL.requirement, "Make it faster"], "normalized exact match moves with its finding; free text stays");
      assert.equal(handoff.approved, false, "the verdict is the reviewer's own");
      assertVerdictConsistent(run, handoff);
      assert.equal(
        handoffs.find((h) => h.phase === "review_2")?.previous,
        BUILD,
        "the next review is handed the builder's envelope, never the triaged handoff",
      );
      assert.match(handoff.notes_for_next_agent, /^Focus on the handler\.\n\n## Deprioritized by jev\n/);
      assert.match(handoff.notes_for_next_agent, /- \[noise\] Add retries to the database driver — not part of this request/);
      assert.match(handoff.notes_for_next_agent, /- \[style\] Rename `tmp` to something descriptive — src\/items\.ts:14/);
      // The loop's own state is untouched by triage.
      assert.equal(state.review, review);
      assert.equal(state.accepted, false);
      assert.deepEqual(review.findings, [MET, REAL, NOISE, STYLE], "the reviewer's envelope is never mutated");

      const outcome = await rows(run, adwId, FINDING_TRIAGE_EVENT);
      assert.equal(outcome.length, 1);
      const payload = JSON.parse(outcome[0]!.payload_json);
      assert.equal(payload.drop, "none");
      assert.deepEqual(
        payload.deprioritized.map((d: { triage: string }) => d.triage),
        ["noise", "style"],
      );
      assert.deepEqual(payload.dropped, []);
      const decisions = (await rows(run, adwId, JEV_DECISION_EVENT)).map((r) => parseRecordedDecision(JSON.parse(r.payload_json))!);
      assert.deepEqual(
        decisions.map((d) => [d.choice, d.reason]),
        [
          ["real", null],
          ["noise", null],
          ["style", null],
        ],
      );
    });
  });
});

test("finding_triage act (drop: noise): noise is withheld from the fixer but recorded; style is still deprioritized", async () => {
  await withFake(HONEST, async () => {
    const adwId = "adw_triage_drop_noise";
    await withStartedRun("jev:\n  enabled: true\n  mode: act\n  decisions:\n    finding_triage: { drop: noise }\n", adwId, async (run) => {
      const { handoffs } = await runReviseLoop(run);
      const handoff = reviseHandoff(handoffs);
      assert.deepEqual(handoff.findings, [MET, REAL]);
      assertVerdictConsistent(run, handoff);
      assert.doesNotMatch(handoff.notes_for_next_agent, /retries/, "a dropped finding never reaches the fixer");
      assert.match(handoff.notes_for_next_agent, /- \[style\] Rename/);
      const payload = JSON.parse((await rows(run, adwId, FINDING_TRIAGE_EVENT))[0]!.payload_json);
      assert.deepEqual(
        payload.dropped.map((d: { requirement: string }) => d.requirement),
        [NOISE.requirement],
      );
      assert.equal(payload.drop_suspended, false);
      assert.equal(payload.all_demoted, false);
    });
  });
});

test("finding_triage act (drop: noise_and_style): both withheld; no 'Deprioritized' section at all", async () => {
  await withFake(HONEST, async () => {
    const adwId = "adw_triage_drop_both";
    await withStartedRun("jev:\n  enabled: true\n  mode: act\n  decisions:\n    finding_triage: { drop: noise_and_style }\n", adwId, async (run) => {
      const handoff = reviseHandoff((await runReviseLoop(run)).handoffs);
      assert.deepEqual(handoff.findings, [MET, REAL]);
      assert.deepEqual(handoff.blocking, [REAL.requirement, "Make it faster"]);
      assertVerdictConsistent(run, handoff);
      assert.equal(handoff.notes_for_next_agent, "Focus on the handler.");
    });
  });
});

// ── safety bounds ──────────────────────────────────────────────────────────

for (const drop of ["noise_and_style", "none"] as const) {
test(`finding_triage safety (drop: ${drop}): Jev calling EVERY finding noise never empties the structured ask, and never flips the rejected verdict`, async () => {
  const fake = FakeJevClient.choosing("noise", 0.99);
  await withFake(fake, async () => {
    const adwId = `adw_triage_all_noise_${drop}`;
    await withStartedRun(`jev:\n  enabled: true\n  mode: act\n  decisions:\n    finding_triage: { drop: ${drop} }\n`, adwId, async (run) => {
      const { state, handoffs, review } = await runReviseLoop(run);
      const handoff = reviseHandoff(handoffs);
      assert.deepEqual(handoff.findings, review.findings, "with nothing real left, every unmet finding stays in `findings`");
      assert.deepEqual(handoff.blocking, review.blocking, "...and `blocking` is the reviewer's own");
      assertVerdictConsistent(run, handoff);
      assert.match(handoff.notes_for_next_agent, /## Deprioritized by jev\n.*EVERY unmet finding/);
      for (const f of [REAL, NOISE, STYLE]) assert.ok(handoff.notes_for_next_agent.includes(`- [noise] ${f.requirement}`), `${f.requirement} is labeled in the notes`);
      assert.equal(handoff.approved, false);
      assert.deepEqual(
        handoffs.map((h) => h.phase),
        ["review_1", "revise_1", "review_2"],
        "the reviewer still rules again",
      );
      assert.equal(state.accepted, false, "triage never turns a rejection into acceptance");
      assert.match(state.reason, /never approved/);
      const payload = JSON.parse((await rows(run, adwId, FINDING_TRIAGE_EVENT))[0]!.payload_json);
      assert.equal(payload.all_demoted, true);
      assert.equal(payload.drop_suspended, drop !== "none", "drop_suspended only when drop asked to withhold something");
      assert.deepEqual(payload.dropped, []);
    });
  });
});
}

test("finding_triage safety: an approving review is never triaged (no revise, no call)", async () => {
  const fake = FakeJevClient.choosing("noise", 0.99);
  await withFake(fake, async () => {
    const adwId = "adw_triage_approved";
    await withStartedRun("jev:\n  enabled: true\n  mode: act\n", adwId, async (run) => {
      const { state } = await runReviseLoop(run, rejectingReview({ approved: true, findings: [MET], blocking: [] }));
      assert.equal(state.accepted, true);
      assert.equal(fake.calls.length, 0);
    });
  });
});

test("finding_triage: a rejected review with no unmet findings asks nothing and hands the envelope through", async () => {
  const fake = FakeJevClient.choosing("noise", 0.99);
  await withFake(fake, async () => {
    const adwId = "adw_triage_no_unmet";
    await withStartedRun("jev:\n  enabled: true\n  mode: act\n", adwId, async (run) => {
      const review = rejectingReview({ findings: [MET] });
      const { handoffs } = await runReviseLoop(run, review);
      assert.equal(reviseHandoff(handoffs), review);
      assert.equal(fake.calls.length, 0);
    });
  });
});

// ── fallback cases (act mode, the fallback — `real` — acts) ─────────────────

for (const [name, fake, yamlExtra, reason] of [
  ["low confidence", FakeJevClient.choosing("noise", 0.5), "", "low_confidence"],
  ["error", FakeJevClient.failing(new Error("boom")), "", "error"],
  ["timeout", FakeJevClient.hanging(), "  timeout_ms: 20\n", "timeout"],
  ["invalid choice", FakeJevClient.choosing("wontfix", 0.99), "", "invalid_choice"],
] as const) {
  test(`finding_triage fallback (${name}): the handoff is untouched and every decision records reason ${reason}`, async () => {
    await withFake(fake, async () => {
      const adwId = `adw_triage_fb_${reason}`;
      await withStartedRun(`jev:\n  enabled: true\n  mode: act\n${yamlExtra}`, adwId, async (run) => {
        const { handoffs, review } = await runReviseLoop(run);
        assert.equal(reviseHandoff(handoffs), review);
        const decisions = (await rows(run, adwId, JEV_DECISION_EVENT)).map((r) => parseRecordedDecision(JSON.parse(r.payload_json))!);
        assert.equal(decisions.length, 3);
        for (const d of decisions) {
          assert.equal(d.choice, "real");
          assert.equal(d.reason, reason);
        }
      });
    });
  });
}

test("finding_triage: an invalid drop setting fails startRun itself with a config-shaped error — before any phase, so before any agent spend", async () => {
  const fake = FakeJevClient.choosing("real", 0.9);
  await withFake(fake, async () => {
    await assert.rejects(
      withStartedRun("jev:\n  enabled: true\n  decisions:\n    finding_triage: { drop: everything }\n", "adw_triage_bad_extras", async () => {
        assert.fail("startRun must not return a Run for an invalid jev.decisions.finding_triage");
      }),
      /jev\.decisions\.finding_triage: drop/,
    );
    assert.equal(fake.calls.length, 0);
  });
});

test("finding_triage: resolveFindingTriage is the backstop for a Run not built by startRun — same config-shaped error", () => {
  const jev = createJev({ config: { enabled: true, decisions: { finding_triage: { drop: "everything" } } }, env: {} });
  assert.throws(() => resolveFindingTriage({ jev }), /jev\.decisions\.finding_triage: drop/);
  assert.equal(resolveFindingTriage({ jev: createJev({ config: { enabled: false, decisions: { finding_triage: { drop: "everything" } } } }) }), null);
});

// ── the batch's size: cap and budget ───────────────────────────────────────

/** Answers `noise` to every question it is asked, however many. */
function allNoise(): FakeJevClient {
  return new FakeJevClient((req: SystemOneRequest) => ({
    answers: Object.fromEntries(Object.keys(req.questions).map((q) => [q, choice("noise")])),
  }));
}

test(`finding_triage: more than ${MAX_TRIAGED_FINDINGS} unmet findings — exactly ${MAX_TRIAGED_FINDINGS} are asked about; the rest keep the fallback (real)`, async () => {
  const fake = allNoise();
  await withFake(fake, async () => {
    const adwId = "adw_triage_cap";
    const many = Array.from({ length: MAX_TRIAGED_FINDINGS + 10 }, (_, i) => ({ requirement: `Requirement number ${i}`, met: false, evidence: `site ${i}` }));
    await withStartedRun("jev:\n  enabled: true\n  mode: act\n", adwId, async (run) => {
      const { handoffs } = await runReviseLoop(run, rejectingReview({ findings: [MET, ...many], blocking: [] }));
      assert.equal(fake.calls.length, 1);
      assert.equal(Object.keys(fake.calls[0]!.questions).length, MAX_TRIAGED_FINDINGS);
      assert.equal((await rows(run, adwId, JEV_DECISION_EVENT)).length, MAX_TRIAGED_FINDINGS);
      const handoff = reviseHandoff(handoffs);
      assert.deepEqual(handoff.findings, [MET, ...many.slice(MAX_TRIAGED_FINDINGS)], "the un-asked findings are kept as real");
      assertVerdictConsistent(run, handoff);
      const payload = JSON.parse((await rows(run, adwId, FINDING_TRIAGE_EVENT))[0]!.payload_json);
      assert.equal(payload.kept.length, 10);
      assert.equal(payload.deprioritized.length, MAX_TRIAGED_FINDINGS);
    });
  });
});

test("finding_triage: a worst-case review (huge prompt, 50 maximal findings, 100 long blockers) still fits the request budget; questions never restate their finding", async () => {
  const fake = allNoise();
  await withFake(fake, async () => {
    const adwId = "adw_triage_budget";
    const long = (tag: string) => `${tag} ${"x".repeat(5_000)}`;
    const many = Array.from({ length: MAX_TRIAGED_FINDINGS }, (_, i) => ({ requirement: long(`req ${i}`), met: false, evidence: long(`ev ${i}`) }));
    const review = rejectingReview({
      summary: long("summary"),
      findings: many,
      blocking: Array.from({ length: 100 }, (_, i) => long(`blocker ${i}`)),
    });
    await withStartedRun("jev:\n  enabled: true\n  mode: act\n", adwId, async (run) => {
      await runReviseLoop(run, review, long("prompt").repeat(10));
      assert.equal(fake.calls.length, 1);
      const req = fake.calls[0]!;
      assert.equal(Object.keys(req.questions).length, MAX_TRIAGED_FINDINGS);
      assert.ok(JSON.stringify(req.state).length <= TRIAGE_STATE_CHAR_BUDGET, `state is ${JSON.stringify(req.state).length} chars`);
      assert.ok(JSON.stringify(req).length <= TRIAGE_REQUEST_CHAR_BUDGET, `request is ${JSON.stringify(req).length} chars`);
      for (const q of Object.values(req.questions)) {
        const instructions = (q as { instructions: string }).instructions;
        assert.ok(instructions.length < 400, "a question is a short pointer, not a restatement");
        assert.doesNotMatch(instructions, /xxxx/);
      }
      // Each question points at a finding id that is actually in the state.
      const ids = ((req.state as { review: { unmet_findings: { id: string }[] } }).review.unmet_findings).map((f) => f.id);
      assert.deepEqual(ids, many.map((f) => findingFingerprint(f)));
      assert.ok((req.questions["q7"] as { instructions: string }).instructions.includes(ids[7]!));
    });
  });
});

// ── simple_sdlc: the built-in chain's own review loop ──────────────────────

/** Read a finished run's `log` rows by name straight from its trace db file. */
function traceRows(dir: string, adwId: string, name: string): Array<{ phase_id: string; payload_json: string }> {
  const db = new DatabaseSync(join(dir, ".spf", "data", "spf.db"));
  try {
    return db.prepare("SELECT phase_id, payload_json FROM events WHERE adw_id=? AND type='log' AND name=?").all(adwId, name) as Array<{
      phase_id: string;
      payload_json: string;
    }>;
  } finally {
    db.close();
  }
}

/** A throwaway git repo on `main` with one commit, an spf config, and a trivially green `test` suite. */
function sdlcRepo(jevYaml: string): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "spf-jev-triage-sdlc-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(dir, "README.md"), "hi\n");
  writeFileSync(join(dir, "s.md"), "system\n");
  writeFileSync(join(dir, "u.md"), "user\n");
  const configPath = join(dir, "spf.config.yaml");
  const agents = simpleSdlc.REQUIRED_AGENTS.map((name) => `  - {name: ${name}, prompt_engineering: {system: s.md, user: u.md}}\n`).join("");
  writeFileSync(
    configPath,
    `agents:\n${agents}quality:\n  checks:\n    - {name: test, operation: build, argv: ["true"]}\n  suites:\n    test: [test]\n${jevYaml}`,
  );
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { dir, configPath };
}

/**
 * Drive the REAL `simple_sdlc.main` (real startRun, real phases, real git,
 * real suite) with only the agents scripted: `Run.prototype.phase` is
 * wrapped for the duration so every run it builds answers `ph.call` from
 * `respond`. The reviewer rejects every round.
 */
async function runSimpleSdlc(jevYaml: string, adwId: string): Promise<{ code: number; handoffs: Handoff[]; phases: string[]; review: ReviewOutputT; dir: string }> {
  const { dir, configPath } = sdlcRepo(siblingKindsOff(jevYaml));
  const review = rejectingReview();
  const handoffs: Handoff[] = [];
  const phases: string[] = [];
  const respond = (phase: string): EnvelopeBase => {
    if (phase === "plan") {
      writeFileSync(join(dir, "plan.md"), "the plan\n"); // commit_plan needs something to commit
      return { status: "success", summary: "planned", artifacts: [], notes_for_next_agent: "" };
    }
    return phase.startsWith("review_") ? review : BUILD;
  };
  const realPhase = Run.prototype.phase;
  const wrapped = mock.method(Run.prototype, "phase", function (this: Run, params: { name: string }, fn: (ph: PhaseHandle) => Promise<unknown>) {
    phases.push(params.name);
    return realPhase.call(this, params as Parameters<typeof realPhase>[0], (ph) => fn(scriptedHandle(ph, params.name, respond, handoffs)));
  });
  try {
    const code = await simpleSdlc.main({ prompt: "Add POST /items", config_paths: [configPath], adw_id: adwId, cwd: dir, chain_name: "simple-sdlc", unattended: true });
    return { code, handoffs, phases, review, dir };
  } finally {
    wrapped.mock.restore();
  }
}

test("finding_triage simple_sdlc R8: with NO jev: block, the revise phase is handed the reviewer's envelope itself — zero calls", async () => {
  const fake = FakeJevClient.choosing("noise", 0.99);
  await withFake(fake, async () => {
    const adwId = "adw_triage_sdlc_r8";
    const { handoffs, review, dir } = await runSimpleSdlc("", adwId);
    try {
      assert.equal(reviseHandoff(handoffs), review);
      assert.equal(fake.calls.length, 0);
      assert.equal(traceRows(dir, adwId, JEV_DECISION_EVENT).length, 0);
      assert.equal(traceRows(dir, adwId, FINDING_TRIAGE_EVENT).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("finding_triage simple_sdlc act: the revise handoff is reshaped, the verdict is not — no retest, no signoff, no commit_build on a rejected review", async () => {
  await withFake(HONEST, async () => {
    const before = HONEST.calls.length;
    const adwId = "adw_triage_sdlc_act";
    const { code, handoffs, phases, review, dir } = await runSimpleSdlc("jev:\n  enabled: true\n  mode: act\n", adwId);
    try {
      const decisionRows = traceRows(dir, adwId, JEV_DECISION_EVENT);
      assert.equal(decisionRows.length, 3);
      const triageRows = traceRows(dir, adwId, FINDING_TRIAGE_EVENT);
      assert.equal(triageRows.length, 1);
      assert.ok(triageRows[0]!.phase_id.length > 0);
      for (const r of decisionRows) assert.equal(r.phase_id, triageRows[0]!.phase_id, "every decision lands on the revise phase (ph.phase_id)");
      assert.equal(HONEST.calls.length - before, 1, "one batch for the one revise round");
      const handoff = reviseHandoff(handoffs);
      assert.notEqual(handoff, review);
      assert.deepEqual(handoff.findings, [MET, REAL]);
      assert.equal(handoff.approved, false);
      assert.match(handoff.notes_for_next_agent, /## Deprioritized by jev/);
      assert.deepEqual(review.findings, [MET, REAL, NOISE, STYLE], "the reviewer's envelope is never mutated");
      assert.equal(handoffs.find((h) => h.phase === "review_2")?.previous, BUILD, "review_2 rules on the revised BUILD, not on the triaged handoff");
      assert.deepEqual(phases, ["request", "plan", "commit_plan", "build", "test_1", "review_1", "revise_1", "review_2"]);
      assert.notEqual(code, 0, "a review that never approved still fails the run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── pure applier ───────────────────────────────────────────────────────────

test("applyFindingTriage: no classes -> the same object; duplicates share one class; met findings untouched", () => {
  const review = rejectingReview();
  assert.equal(applyFindingTriage(review, new Map(), "noise_and_style", 1).handoff, review);
  const dup = { ...STYLE, evidence: "a second site" };
  const withDup = rejectingReview({ findings: [MET, REAL, STYLE, dup], blocking: [] });
  const out = applyFindingTriage(withDup, new Map([[findingFingerprint(STYLE), "style"]]), "none", 1);
  assert.deepEqual(out.handoff.findings, [MET, REAL]);
  assert.equal(out.deprioritized.length, 2);
  assert.match(out.handoff.notes_for_next_agent, /a second site/);
});

test("applyFindingTriage: every unmet finding demoted -> findings/blocking untouched whatever `drop` says; only the notes change", () => {
  const review = rejectingReview();
  const classes = new Map([
    [findingFingerprint(REAL), "noise" as const],
    [findingFingerprint(NOISE), "noise" as const],
    [findingFingerprint(STYLE), "style" as const],
  ]);
  for (const drop of ["none", "noise", "noise_and_style"] as const) {
    const out = applyFindingTriage(review, classes, drop, 1);
    assert.equal(out.all_demoted, true);
    assert.equal(out.drop_suspended, drop !== "none");
    assert.deepEqual(out.dropped, []);
    assert.equal(out.deprioritized.length, 3);
    assert.equal(out.handoff.findings, review.findings);
    assert.equal(out.handoff.blocking, review.blocking);
    assert.ok(gates.verdictConsistent(out.handoff, { repo_root: "/", cfg: {} } as never).passed);
  }
});
