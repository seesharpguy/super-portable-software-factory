/**
 * Jev loop control (#105) — `fixLoop`/`reviseLoop` asking Jev
 * `continue | escalate_tier | stop_blocked` after a failed, non-final round.
 *
 * Everything below drives the REAL call site: a real `Run` from `startRun`
 * (real tracer + trace db, real `run.jev`, real `run.phase`, a real
 * always-failing suite command), with only the coding-agent dispatch inside
 * agent phases swapped for a stub — no agent CLI, no network. Jev itself is
 * `FakeJevClient`, injected process-wide with `setJevClientFactory` (always
 * reset in `finally`).
 *
 * What is pinned:
 *  - R8 / invariant 1: no `jev:` block => the loops' phases, verdict, and
 *    reason are today's, with zero Jev calls and zero `jev_decision` rows.
 *  - shadow: Jev is asked and recorded, the loop still continues.
 *  - act: `stop_blocked` ends the loop early (never accepted); `continue`
 *    is today's loop; `escalate_tier` moves the repairing role ONE rung.
 *  - the bounds (invariant 6): `max` is a hard ceiling (never asked on the
 *    final round), escalation needs `max_tier`, never exceeds it, happens at
 *    most once per loop, never touches the reviewer, and is undone when the
 *    loop exits.
 *  - every failure path (timeout, error, low confidence, out-of-set) is
 *    `continue`, i.e. today's loop.
 */

import "./hermetic_git.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SFConfigSchema } from "../core/data_types.js";
import * as v from "valibot";
import { JEV_DECISION_EVENT, parseRecordedDecision, setJevClientFactory, type Decision, type SystemOneRequest } from "../core/jev.js";
import { JEV_DECISION_KINDS, LOOP_CONTROL_CHOICES, LOOP_CONTROL_KIND } from "../core/jev_kinds.js";
import * as tiering from "../core/tiering.js";
import { FakeJevClient } from "./fake_jev.js";
import * as steps from "../chains/steps.js";
import { LOOP_CONTROL_OPTIONS, nextRung } from "../chains/loop_control.js";

type StartedRun = Awaited<ReturnType<typeof steps.startRun>>;

// ── config fragments ────────────────────────────────────────────────────────

const QUALITY =
  "quality:\n" +
  "  checks:\n" +
  '    - {name: test, area: backend, operation: typecheck, argv: [node, -e, "process.exit(1)"], timeout_seconds: 30}\n' +
  "  suites: {test: [test]}\n";

const AGENTS =
  "agents:\n" +
  "  - {name: builder, coding_agent: flue, model: openai/configured, prompt_engineering: {system: s.md, user: u.md}}\n" +
  "  - {name: reviewer, coding_agent: flue, model: openai/reviewer, prompt_engineering: {system: s.md, user: u.md}}\n";

const TIERING =
  "tiering:\n" +
  "  enabled: true\n" +
  "  tiers:\n" +
  "    - {name: t0, coding_agent: flue, model: openai/m0}\n" +
  "    - {name: t1, coding_agent: flue, model: openai/m1}\n" +
  "    - {name: t2, coding_agent: flue, model: openai/m2}\n" +
  "  roles: {builder: t0}\n";

function jevBlock(mode: "shadow" | "act", loopControl = "", extra = ""): string {
  return `jev:\n  enabled: true\n  mode: ${mode}\n${extra}${loopControl ? `  decisions:\n    loop_control: ${loopControl}\n` : ""}`;
}

// ── harness ────────────────────────────────────────────────────────────────

function stateStub(): steps.ChainState {
  return { prompt: "make the tests pass", options: {}, previous: null, quality: null, review: null, changeset: null, baseline: "", issue_id: null, accepted: true, reason: "" };
}

interface Dispatch {
  phase: string;
  owner: string;
  model: string;
}

/**
 * A real `startRun` run over `yaml`, with every AGENT phase's coding-agent
 * dispatch replaced by a stub that records the model tiering would dispatch
 * on (`effectiveAgent`, the real dispatch seam) and returns a canned
 * envelope. Code phases (the suite) run for real.
 */
async function withRun(yaml: string, adwId: string, body: (run: StartedRun, dispatches: Dispatch[]) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "spf-jev-loop-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, yaml);
    const run = await steps.startRun(
      { prompt: "a short prompt", config_paths: [configPath], adw_id: adwId, cwd: dir, chain_name: "plan-build", unattended: true },
      [],
      ["test"],
    );
    // startRun routes only `required` agents; route the builder the same
    // way a real chain requiring it would (same pure function, same inputs).
    run.tiering = tiering.resolveTiering({ cfg: run.cfg, chainName: "plan-build", prompt: "a short prompt", servedOllamaTags: null, required: ["builder", "reviewer"] });
    const dispatches: Dispatch[] = [];
    const realPhase = run.phase.bind(run);
    run.phase = (async (params: Parameters<StartedRun["phase"]>[0], fn: Parameters<StartedRun["phase"]>[1]) =>
      realPhase(params, (ph) =>
        fn(
          params.kind !== "agent"
            ? ph
            : {
                log: (payload) => ph.log(payload),
                call: async () => {
                  const base = run.cfg.agents.find((a) => a.name === params.owner)!;
                  dispatches.push({ phase: params.name, owner: params.owner, model: tiering.effectiveAgent(run, base).model });
                  return (
                    params.owner === "reviewer"
                      ? { status: "success", summary: "not yet", artifacts: [], approved: false, blocking: ["README is missing"], findings: [{ requirement: "README", met: false, evidence: "" }] }
                      : { status: "success", summary: "tried a fix", artifacts: [], changed_files: [] }
                  ) as never;
                },
              },
        ),
      )) as StartedRun["phase"];
    try {
      await body(run, dispatches);
    } finally {
      await run.tracer.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withFake(fake: FakeJevClient, body: () => Promise<void>): Promise<void> {
  setJevClientFactory(() => fake);
  try {
    await body();
  } finally {
    setJevClientFactory(null);
  }
}

async function logRows(run: StartedRun, name: string): Promise<Array<{ phase_id: string; payload_json: string }>> {
  return (await run.tracer.db.query("SELECT phase_id, payload_json FROM events WHERE adw_id=? AND type='log' AND name=? ORDER BY rowid").all(run.adw_id, name)) as Array<{
    phase_id: string;
    payload_json: string;
  }>;
}

async function decisions(run: StartedRun): Promise<Decision[]> {
  return (await logRows(run, JEV_DECISION_EVENT)).map((r) => parseRecordedDecision(JSON.parse(r.payload_json))!);
}

const phaseNames = (run: StartedRun) => run.phases.map((p) => p.params.name);

/** A fake that answers each successive call with the next choice in `script` (then repeats the last). */
function scripted(script: string[], confidence = 0.95): FakeJevClient {
  let n = 0;
  return new FakeJevClient((req: SystemOneRequest) => {
    const choice = script[Math.min(n++, script.length - 1)]!;
    return { model: req.model, answers: Object.fromEntries(Object.keys(req.questions).map((q) => [q, { type: "choice", choice, confidence }])) };
  });
}

// ── R8 / invariant 1 — through the real call sites ─────────────────────────

test("loop_control R8: no jev: block — fixLoop is today's loop, zero Jev calls, zero jev_decision rows", async () => {
  const fake = FakeJevClient.choosing("stop_blocked", 0.99);
  await withFake(fake, () =>
    withRun(QUALITY + AGENTS, "adw_lc_r8_fix", async (run, dispatches) => {
      const state = stateStub();
      await steps.fixLoop({ suite: "test" })(run, state);
      assert.deepEqual(phaseNames(run), ["test_1", "fix_1", "test_2", "fix_2", "test_3"]);
      assert.equal(state.accepted, false);
      assert.equal(state.reason, "the suite still failed after 3 fix attempt(s)");
      assert.deepEqual(dispatches.map((d) => d.model), ["openai/configured", "openai/configured"]);
      assert.equal(fake.calls.length, 0);
      assert.equal((await logRows(run, JEV_DECISION_EVENT)).length, 0);
      assert.equal((await logRows(run, "loop_control")).length, 0);
    }),
  );
});

test("loop_control R8: no jev: block — reviseLoop is today's loop, zero Jev calls, zero jev_decision rows", async () => {
  const fake = FakeJevClient.choosing("stop_blocked", 0.99);
  await withFake(fake, () =>
    withRun(QUALITY + AGENTS, "adw_lc_r8_revise", async (run) => {
      const state = stateStub();
      await steps.reviseLoop()(run, state);
      assert.deepEqual(phaseNames(run), ["review_1", "revise_1", "review_2", "revise_2", "review_3"]);
      assert.equal(state.accepted, false);
      assert.equal(state.reason, "the reviewer never approved after 3 revision(s)");
      assert.equal(fake.calls.length, 0);
      assert.equal((await logRows(run, JEV_DECISION_EVENT)).length, 0);
    }),
  );
});

test("loop_control: jev enabled but the kind set to off — no call, no row, today's loop", async () => {
  const fake = FakeJevClient.choosing("stop_blocked", 0.99);
  await withFake(fake, () =>
    withRun(QUALITY + AGENTS + jevBlock("act", "{mode: off}"), "adw_lc_kind_off", async (run) => {
      const state = stateStub();
      await steps.fixLoop({ suite: "test" })(run, state);
      assert.deepEqual(phaseNames(run), ["test_1", "fix_1", "test_2", "fix_2", "test_3"]);
      assert.equal(fake.calls.length, 0);
      assert.equal((await logRows(run, JEV_DECISION_EVENT)).length, 0);
    }),
  );
});

// ── shadow ─────────────────────────────────────────────────────────────────

test("loop_control shadow: Jev says stop_blocked, it is recorded per round, but the loop continues", async () => {
  const fake = FakeJevClient.choosing("stop_blocked", 0.99);
  await withFake(fake, () =>
    withRun(QUALITY + AGENTS + jevBlock("shadow"), "adw_lc_shadow", async (run, dispatches) => {
      const state = stateStub();
      await steps.fixLoop({ suite: "test" })(run, state);
      assert.deepEqual(phaseNames(run), ["test_1", "fix_1", "test_2", "fix_2", "test_3"]);
      assert.equal(state.reason, "the suite still failed after 3 fix attempt(s)");
      assert.equal(dispatches.length, 2);
      const rows = await logRows(run, JEV_DECISION_EVENT);
      const ds = await decisions(run);
      assert.deepEqual(ds.map((d) => d.key), ["fix:test_1", "fix:test_2"]);
      assert.deepEqual(ds.map((d) => [d.choice, d.jev_choice, d.reason]), [
        ["continue", "stop_blocked", "shadow"],
        ["continue", "stop_blocked", "shadow"],
      ]);
      // Each decision is tied to the failed suite round it judged.
      const byName = Object.fromEntries(run.phases.map((p) => [p.params.name, p.phase_id]));
      assert.deepEqual(rows.map((r) => r.phase_id), [byName["test_1"], byName["test_2"]]);
      assert.equal((await logRows(run, "loop_control")).length, 0, "nothing acted, so no loop_control action row");
    }),
  );
});

// ── act ────────────────────────────────────────────────────────────────────

test("loop_control act: stop_blocked ends fixLoop after the failed round — no repair phase, never accepted", async () => {
  const fake = FakeJevClient.choosing("stop_blocked", 0.99);
  await withFake(fake, () =>
    withRun(QUALITY + AGENTS + jevBlock("act"), "adw_lc_act_stop", async (run, dispatches) => {
      const state = stateStub();
      await steps.fixLoop({ suite: "test" })(run, state);
      assert.deepEqual(phaseNames(run), ["test_1"]);
      assert.equal(dispatches.length, 0);
      assert.equal(state.accepted, false);
      assert.match(state.reason, /stopped after round 1 of 3: .*loop_control/);
      assert.equal(state.quality?.passed, false, "the failed verdict stands");
      const ds = await decisions(run);
      assert.equal(ds.length, 1);
      assert.equal(ds[0]!.choice, "stop_blocked");
      assert.equal(ds[0]!.reason, null);
      assert.equal((await logRows(run, "loop_control")).length, 1);
      // The closed set Jev saw is exactly the registered one; stop/continue are always permitted.
      assert.deepEqual(Object.keys((fake.calls[0]!.questions.q0 as { criteria: Record<string, string> }).criteria), [...LOOP_CONTROL_CHOICES]);
    }),
  );
});

test("loop_control act: stop_blocked ends reviseLoop after the rejected review — no revise phase, never approved", async () => {
  const fake = FakeJevClient.choosing("stop_blocked", 0.99);
  await withFake(fake, () =>
    withRun(QUALITY + AGENTS + jevBlock("act"), "adw_lc_act_stop_revise", async (run) => {
      const state = stateStub();
      await steps.reviseLoop()(run, state);
      assert.deepEqual(phaseNames(run), ["review_1"]);
      assert.equal(state.accepted, false);
      assert.match(state.reason, /stopped after review 1 of 3/);
      assert.equal((await decisions(run))[0]!.key, "revise:review_1");
      const sent = fake.calls[0]!.state as { loop: string; latest: { blocking: string[] } };
      assert.equal(sent.loop, "reviseLoop");
      assert.deepEqual(sent.latest.blocking, ["README is missing"]);
    }),
  );
});

test("loop_control act: continue is today's loop — and max is a hard ceiling (never asked on the final round)", async () => {
  const fake = FakeJevClient.choosing("continue", 0.99);
  await withFake(fake, () =>
    withRun(QUALITY + AGENTS + jevBlock("act"), "adw_lc_act_continue", async (run) => {
      const state = stateStub();
      await steps.fixLoop({ suite: "test", max: 4 })(run, state);
      assert.deepEqual(phaseNames(run), ["test_1", "fix_1", "test_2", "fix_2", "test_3", "fix_3", "test_4"]);
      assert.equal(state.reason, "the suite still failed after 4 fix attempt(s)");
      assert.equal(fake.calls.length, 3, "one decision per non-final failed round, none after the last");
      const sent = fake.calls.map((c) => c.state as { round: number; repair_rounds_left: number; history: unknown[] });
      assert.deepEqual(sent.map((s) => [s.round, s.repair_rounds_left, s.history.length]), [
        [1, 3, 0],
        [2, 2, 1],
        [3, 1, 2],
      ]);
    }),
  );
});

test("loop_control act: escalate_tier moves the fixer ONE rung, at most once per loop, and is undone when the loop exits", async () => {
  const fake = FakeJevClient.choosing("escalate_tier", 0.99);
  await withFake(fake, () =>
    withRun(QUALITY + AGENTS + TIERING + jevBlock("act", "{max_tier: t2}"), "adw_lc_act_escalate", async (run, dispatches) => {
      assert.equal(run.tiering?.routing["builder"]?.effective, "openai/m0");
      const before = run.tiering;
      const state = stateStub();
      await steps.fixLoop({ suite: "test" })(run, state);
      // t0 -> t1 once; the second escalate_tier is not permitted (already
      // escalated), so it degrades to continue ON the escalated rung.
      assert.deepEqual(dispatches.map((d) => [d.phase, d.model]), [
        ["fix_1", "openai/m1"],
        ["fix_2", "openai/m1"],
      ]);
      const ds = await decisions(run);
      assert.deepEqual(ds.map((d) => [d.choice, d.reason]), [
        ["escalate_tier", null],
        ["continue", "not_permitted"],
      ]);
      const second = fake.calls[1]!.state as { escalation: { available: boolean; why: string } };
      assert.equal(second.escalation.available, false);
      assert.match(second.escalation.why, /at most one rung/);
      const actions = (await logRows(run, "loop_control")).map((r) => JSON.parse(r.payload_json));
      assert.equal(actions.length, 1);
      assert.equal(actions[0].from_tier, "t0");
      assert.equal(actions[0].to_tier, "t1");
      // Restored: nothing after the loop inherits the escalation.
      assert.equal(run.tiering, before);
      assert.equal(run.tiering?.routing["builder"]?.effective, "openai/m0");
      assert.equal(state.reason, "the suite still failed after 3 fix attempt(s)", "escalating never adds a round");
    }),
  );
});

test("loop_control act: escalate_tier without max_tier is not permitted — continue, on the original model", async () => {
  const fake = FakeJevClient.choosing("escalate_tier", 0.99);
  await withFake(fake, () =>
    withRun(QUALITY + AGENTS + TIERING + jevBlock("act"), "adw_lc_no_max", async (run, dispatches) => {
      await steps.fixLoop({ suite: "test", max: 2 })(run, stateStub());
      assert.deepEqual(dispatches.map((d) => d.model), ["openai/m0"]);
      const [d] = await decisions(run);
      assert.equal(d!.choice, "continue");
      assert.equal(d!.reason, "not_permitted");
      assert.match((fake.calls[0]!.state as { escalation: { why: string } }).escalation.why, /max_tier is not set/);
    }),
  );
});

test("loop_control act: escalate_tier never goes above max_tier (role already at max_tier)", async () => {
  const fake = FakeJevClient.choosing("escalate_tier", 0.99);
  await withFake(fake, () =>
    withRun(QUALITY + AGENTS + TIERING + jevBlock("act", "{max_tier: t0}"), "adw_lc_at_max", async (run, dispatches) => {
      await steps.fixLoop({ suite: "test", max: 2 })(run, stateStub());
      assert.deepEqual(dispatches.map((d) => d.model), ["openai/m0"]);
      assert.equal((await decisions(run))[0]!.reason, "not_permitted");
    }),
  );
});

test("loop_control act: reviseLoop escalates the reviser only — the reviewer's model never moves", async () => {
  const fake = scripted(["escalate_tier", "continue"]);
  const tieringBoth = TIERING.replace("roles: {builder: t0}", "roles: {builder: t0, reviewer: t0}");
  await withFake(fake, () =>
    withRun(QUALITY + AGENTS + tieringBoth + jevBlock("act", "{max_tier: t1}"), "adw_lc_revise_escalate", async (run, dispatches) => {
      await steps.reviseLoop()(run, stateStub());
      assert.deepEqual(dispatches.map((d) => [d.phase, d.model]), [
        ["review_1", "openai/m0"],
        ["revise_1", "openai/m1"],
        ["review_2", "openai/m0"],
        ["revise_2", "openai/m1"],
        ["review_3", "openai/m0"],
      ]);
      assert.equal(run.tiering?.routing["builder"]?.effective, "openai/m0");
    }),
  );
});

// ── fallbacks through the call site ────────────────────────────────────────

test("loop_control act: every failure path falls back to continue — today's loop", async () => {
  const cases: Array<{ name: string; fake: FakeJevClient; extra?: string; reason: string }> = [
    { name: "timeout", fake: FakeJevClient.hanging(), extra: "  timeout_ms: 20\n", reason: "timeout" },
    { name: "error", fake: FakeJevClient.failing(new Error("boom")), reason: "error" },
    { name: "low_confidence", fake: FakeJevClient.choosing("stop_blocked", 0.3), reason: "low_confidence" },
    { name: "invalid_choice", fake: FakeJevClient.choosing("retry_forever", 0.99), reason: "invalid_choice" },
  ];
  for (const c of cases) {
    await withFake(c.fake, () =>
      withRun(QUALITY + AGENTS + jevBlock("act", "", c.extra ?? ""), `adw_lc_fb_${c.name}`, async (run) => {
        const state = stateStub();
        await steps.fixLoop({ suite: "test", max: 2 })(run, state);
        assert.deepEqual(phaseNames(run), ["test_1", "fix_1", "test_2"], c.name);
        assert.equal(state.reason, "the suite still failed after 2 fix attempt(s)", c.name);
        const [d] = await decisions(run);
        assert.equal(d!.choice, "continue", c.name);
        assert.equal(d!.reason, c.reason, c.name);
      }),
    );
  }
});

// ── config ─────────────────────────────────────────────────────────────────

test("loop_control: a malformed jev.decisions.loop_control fails startRun when the kind is live, and is ignored when Jev is off", async () => {
  await assert.rejects(
    withRun(QUALITY + AGENTS + jevBlock("shadow", "{max_tier: 5}"), "adw_lc_bad_extras", async () => {}),
    /jev\.decisions\.loop_control: max_tier/,
  );
  await withRun(QUALITY + AGENTS + "jev:\n  enabled: false\n  decisions:\n    loop_control: {max_tier: 5}\n", "adw_lc_bad_extras_off", async (run) => {
    assert.equal(run.jev.enabled, false);
  });
});

test("loop_control: registered kind — the call site's options are built from the spec's constant", () => {
  const spec = JEV_DECISION_KINDS["loop_control"];
  assert.equal(spec, LOOP_CONTROL_KIND);
  assert.deepEqual(spec!.options, LOOP_CONTROL_OPTIONS.map((o) => o.value));
  assert.ok(LOOP_CONTROL_OPTIONS.every((o) => o.description.length > 0));
});

// ── nextRung: the escalation bound, pure ───────────────────────────────────

function cfgWith(overrides: { tieringEnabled?: boolean; builderAgent?: "flue" | "claude_code" } = {}) {
  return v.parse(SFConfigSchema, {
    agents: [{ name: "builder", coding_agent: overrides.builderAgent ?? "flue", model: "openai/configured", prompt_engineering: { system: "s", user: "u" } }],
    tiering: {
      enabled: overrides.tieringEnabled ?? true,
      tiers: [
        { name: "t0", coding_agent: "flue", model: "openai/m0" },
        { name: "t1", coding_agent: "flue", model: "openai/m1" },
        { name: "t2", coding_agent: "claude_code", model: "opus" },
      ],
      roles: { builder: "t0" },
    },
  });
}

function resolutionAt(tier: string, model: string): tiering.TierResolution {
  return { risk: "standard", signals: { chain: "x", chain_weight: 0, prompt_words: 1, prompt_weight: -1, sum: -1 }, routing: { builder: { tier, configured: "openai/configured", effective: model } }, notes: [] };
}

test("nextRung: one rung up, bounded by max_tier, once, routed roles only, usable rungs only", () => {
  const base = { cfg: cfgWith(), resolution: resolutionAt("t0", "openai/m0"), role: "builder", servedOllamaTags: null, alreadyEscalated: false };
  const ok = nextRung({ ...base, maxTier: "t1" });
  assert.deepEqual(ok, { ok: true, from_tier: "t0", to_tier: "t1", route: { tier: "t1", configured: "openai/configured", effective: "openai/m1" } });

  const why = (r: ReturnType<typeof nextRung>) => (r.ok ? "" : r.why);
  assert.match(why(nextRung({ ...base, maxTier: undefined })), /max_tier is not set/);
  assert.match(why(nextRung({ ...base, maxTier: "t1", alreadyEscalated: true })), /at most one rung/);
  assert.match(why(nextRung({ ...base, cfg: cfgWith({ tieringEnabled: false }), maxTier: "t1" })), /tiering is disabled/);
  assert.match(why(nextRung({ ...base, role: "reviewer", maxTier: "t1" })), /not routed/);
  assert.match(why(nextRung({ ...base, maxTier: "nope" })), /not declared/);
  assert.match(why(nextRung({ ...base, maxTier: "t0" })), /already at or above max_tier/);
  // t1 -> t2 is permitted by max_tier but t2 is a claude_code rung: rule T
  // says unusable for a flue agent, and escalation never skips a rung.
  assert.match(why(nextRung({ ...base, resolution: resolutionAt("t1", "openai/m1"), maxTier: "t2" })), /not usable/);
  // No rung above the top of the ladder, whatever max_tier says.
  assert.match(why(nextRung({ ...base, resolution: resolutionAt("t2", "opus"), maxTier: "t2" })), /already at or above/);
});
