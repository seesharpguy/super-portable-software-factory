import "./hermetic_git.js";

/**
 * Jev `risk_tier` (#104) — the run's tiering risk decided by Jev, once, in
 * `startRun`, with `classifyRisk` as the fallback, handed to the pure
 * `resolveTiering` as data; and `spf estimate` saying where its risk came
 * from (heuristic, or a replayed recorded decision — never a live call).
 *
 * Every Jev answer comes from `FakeJevClient` (invariant 8), injected
 * process-wide with `setJevClientFactory` — which is always reset in a
 * `finally` — so the REAL call site (`startRun` -> `run.jev`) is what runs.
 *
 * `hermetic_git.js` first: `startRun` -> `session.ensure` and `spf
 * estimate`'s anchor resolution both spawn git; every temp dir here must
 * resolve to itself, not the spf checkout the test runs inside.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { SFConfigSchema, type SFConfig } from "../core/data_types.js";
import { loadConfig } from "../core/agents.js";
import { Tracer } from "../core/tracer.js";
import {
  createJev,
  JEV_DECISION_EVENT,
  JevApiError,
  findRecordedDecision,
  isValidOptionSet,
  setJevClientFactory,
  traceDecisionRecorder,
  type Decision,
} from "../core/jev.js";
import { JEV_DECISION_KINDS, RISK_TIER_KIND, RISK_TIER_VALUES } from "../core/jev_kinds.js";
import { decideRiskTier, permittedRisks, RISK_SETS_MATCH, RISK_TIER_OPTIONS, riskTierLive, riskTierState } from "../core/risk_tier.js";
import { classifyRisk, resolveTiering, type Risk, type RiskDecision } from "../core/tiering.js";
import { startRun } from "../chains/steps.js";
import { estimateCommand, type EstimateReport } from "../cli/commands/estimate.js";
import { FakeJevClient } from "./fake_jev.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
}

/**
 * One routed role on a three-rung ladder, baseline in the MIDDLE, so every
 * risk lands on a distinct model: low -> openai/small, standard ->
 * openai/mid, high -> openai/big. `plan-build` + a 100-word prompt is
 * `standard` by the heuristic (chain weight 0, prompt weight 0).
 */
const TIERING_YAML =
  "agents:\n" +
  "  - name: builder\n    model: openai/configured\n    prompt_engineering: {system: builder/system.md, user: builder/user.md}\n" +
  "tiering:\n" +
  "  enabled: true\n" +
  "  tiers:\n" +
  "    - {name: cheap, coding_agent: flue, model: openai/small}\n" +
  "    - {name: mid, coding_agent: flue, model: openai/mid}\n" +
  "    - {name: strong, coding_agent: flue, model: openai/big}\n" +
  "  roles: {builder: mid}\n";

const MODEL_FOR: Record<Risk, string> = { low: "openai/small", standard: "openai/mid", high: "openai/big" };
const PROMPT = words(100);

type StartedRun = Awaited<ReturnType<typeof startRun>>;

async function withRun(yaml: string, adwId: string, body: (run: StartedRun, cfg: SFConfig) => Promise<void>, prompt = PROMPT): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "spf-risk-tier-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, yaml);
    const run = await startRun(
      { prompt, config_paths: [configPath], adw_id: adwId, cwd: dir, chain_name: "plan-build", unattended: true },
      ["builder"],
      [],
    );
    try {
      await body(run, loadConfig([configPath]));
    } finally {
      await run.tracer.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The heuristic-only resolution for the same inputs — what every "fallback acts" case must equal (minus the `jev` summary). */
function heuristicResolution(cfg: SFConfig, prompt = PROMPT) {
  return resolveTiering({ cfg, chainName: "plan-build", prompt, servedOllamaTags: null, required: ["builder"] });
}

async function rows(run: StartedRun, adwId: string, name: string): Promise<Array<{ phase_id: string; payload: Record<string, unknown> }>> {
  const raw = (await run.tracer.db.query("SELECT phase_id, payload_json FROM events WHERE adw_id=? AND type='log' AND name=?").all(adwId, name)) as Array<{
    phase_id: string;
    payload_json: string;
  }>;
  return raw.map((r) => ({ phase_id: r.phase_id, payload: JSON.parse(r.payload_json) as Record<string, unknown> }));
}

async function consoleMessages(run: StartedRun, adwId: string): Promise<string[]> {
  return (await rows(run, adwId, "console")).map((r) => String(r.payload.message));
}

/** Run `body` with `fake` as the process-wide Jev client, always resetting it. */
async function withFake(fake: FakeJevClient, body: () => Promise<void>): Promise<void> {
  setJevClientFactory(() => fake);
  try {
    await body();
  } finally {
    setJevClientFactory(null);
  }
}

// ── R8: the real call site with no jev: block ───────────────────────────────

test("risk_tier R8: startRun with NO jev: block — risk/routing equal the heuristic, tiering payload has no jev key, zero calls, zero jev_decision rows", async () => {
  const fake = FakeJevClient.choosing("high", 0.99);
  await withFake(fake, async () => {
    const adwId = "adw_risk_r8";
    await withRun(TIERING_YAML, adwId, async (run, cfg) => {
      const heuristic = heuristicResolution(cfg);
      assert.equal(heuristic.risk, "standard");
      assert.deepEqual(run.tiering, heuristic, "the resolution is byte-identical to the pre-Jev one — no `jev` key at all");
      assert.ok(!("jev" in run.tiering!));
      assert.equal(run.tiering!.routing.builder!.effective, MODEL_FOR.standard);
      assert.equal(fake.calls.length, 0);
      assert.equal((await rows(run, adwId, JEV_DECISION_EVENT)).length, 0);
      const tieringRows = await rows(run, adwId, "tiering");
      assert.equal(tieringRows.length, 1);
      assert.deepEqual(Object.keys(tieringRows[0]!.payload), ["risk", "signals", "routing", "notes"], "the tiering payload keeps its exact pre-Jev shape");
      assert.ok(!(await consoleMessages(run, adwId)).some((m) => m.includes("jev")));
    });
  });
});

test("risk_tier: jev enabled but tiering OFF — no call, no row (risk would change nothing)", async () => {
  const fake = FakeJevClient.choosing("high", 0.99);
  await withFake(fake, async () => {
    const adwId = "adw_risk_tiering_off";
    const yaml = TIERING_YAML.replace("enabled: true", "enabled: false") + "jev:\n  enabled: true\n  mode: act\n";
    await withRun(yaml, adwId, async (run) => {
      assert.equal(run.jev.enabled, true);
      assert.equal(fake.calls.length, 0);
      assert.equal((await rows(run, adwId, JEV_DECISION_EVENT)).length, 0);
      assert.ok(!("jev" in run.tiering!));
    });
  });
});

test("risk_tier: jev enabled, kind mode off — no call, no row, heuristic", async () => {
  const fake = FakeJevClient.choosing("high", 0.99);
  await withFake(fake, async () => {
    const adwId = "adw_risk_kind_off";
    await withRun(TIERING_YAML + "jev:\n  enabled: true\n  mode: act\n  decisions:\n    risk_tier: {mode: off}\n", adwId, async (run, cfg) => {
      assert.equal(fake.calls.length, 0);
      assert.equal((await rows(run, adwId, JEV_DECISION_EVENT)).length, 0);
      assert.deepEqual(run.tiering, heuristicResolution(cfg));
    });
  });
});

test("risk_tier: enabled:false is a total no-op even with invalid risk_tier extras — no throw, no call", async () => {
  const fake = FakeJevClient.choosing("high", 0.99);
  await withFake(fake, async () => {
    const adwId = "adw_risk_disabled_bad_extras";
    await withRun(TIERING_YAML + "jev:\n  enabled: false\n  decisions:\n    risk_tier: {max_risk: extreme}\n", adwId, async (run, cfg) => {
      assert.equal(fake.calls.length, 0);
      assert.deepEqual(run.tiering, heuristicResolution(cfg));
    });
  });
});

// ── shadow ──────────────────────────────────────────────────────────────────

test("risk_tier shadow: Jev is called and its answer recorded, but the heuristic's risk routes the run", async () => {
  const fake = FakeJevClient.choosing("high", 0.95);
  await withFake(fake, async () => {
    const adwId = "adw_risk_shadow";
    await withRun(TIERING_YAML + "jev:\n  enabled: true\n  mode: shadow\n", adwId, async (run, cfg) => {
      assert.equal(fake.calls.length, 1);
      assert.equal(run.tiering!.risk, "standard");
      assert.equal(run.tiering!.routing.builder!.effective, MODEL_FOR.standard);
      const { jev, ...rest } = run.tiering!;
      assert.deepEqual(rest, heuristicResolution(cfg), "apart from the jev summary, the resolution is the heuristic's");
      assert.equal(jev!.reason, "shadow");
      assert.equal(jev!.jev_choice, "high");
      assert.equal(jev!.would_act, true);
      assert.equal(jev!.used_fallback, true);

      const decisions = await rows(run, adwId, JEV_DECISION_EVENT);
      assert.equal(decisions.length, 1);
      assert.equal(decisions[0]!.phase_id, "", "run-scoped");
      assert.equal(decisions[0]!.payload.kind, "risk_tier");
      assert.equal(decisions[0]!.payload.key, "plan-build", "key = chain name");
      assert.deepEqual(decisions[0]!.payload.options, ["low", "standard", "high"]);
      assert.equal(decisions[0]!.payload.fallback, "standard");

      const tiering = (await rows(run, adwId, "tiering"))[0]!.payload;
      assert.equal(tiering.risk, "standard");
      assert.deepEqual(tiering.jev, jev, "the tiering event carries the same jev summary run.tiering does");
      assert.ok(!(await consoleMessages(run, adwId)).some((m) => m.includes("jev risk_tier")), "shadow is not console news");
    });
  });
});

// ── act ─────────────────────────────────────────────────────────────────────

test("risk_tier act: a confident answer sets the risk and moves routing; one console note", async () => {
  const fake = FakeJevClient.choosing("high", 0.92);
  await withFake(fake, async () => {
    const adwId = "adw_risk_act_high";
    await withRun(TIERING_YAML + "jev:\n  enabled: true\n  mode: act\n", adwId, async (run) => {
      assert.equal(run.tiering!.risk, "high");
      assert.equal(run.tiering!.routing.builder!.tier, "strong");
      assert.equal(run.tiering!.routing.builder!.effective, MODEL_FOR.high);
      assert.equal(run.tiering!.signals.sum, 0, "signals stay the heuristic's");
      assert.equal(run.tiering!.jev!.used_fallback, false);
      assert.equal(run.tiering!.jev!.reason, null);
      assert.equal(run.tiering!.jev!.fallback, "standard");
      const tiering = (await rows(run, adwId, "tiering"))[0]!.payload;
      assert.equal(tiering.risk, "high");
      const messages = await consoleMessages(run, adwId);
      assert.ok(messages.some((m) => /\[spf\] jev risk_tier high \(heuristic standard, confidence 0\.92\)/.test(m)), messages.join("\n"));
      assert.equal((await findRecordedDecision(run.tracer.db, adwId, "risk_tier", "plan-build"))?.choice, "high");
    });
  });
});

test("risk_tier act: Jev may also LOWER the risk", async () => {
  await withFake(FakeJevClient.choosing("low", 0.9), async () => {
    await withRun(TIERING_YAML + "jev:\n  enabled: true\n  mode: act\n", "adw_risk_act_low", async (run) => {
      assert.equal(run.tiering!.risk, "low");
      assert.equal(run.tiering!.routing.builder!.effective, MODEL_FOR.low);
    });
  });
});

test("risk_tier act: an agreeing answer acts but prints no console note", async () => {
  await withFake(FakeJevClient.choosing("standard", 0.9), async () => {
    const adwId = "adw_risk_act_agree";
    await withRun(TIERING_YAML + "jev:\n  enabled: true\n  mode: act\n", adwId, async (run) => {
      assert.equal(run.tiering!.risk, "standard");
      assert.equal(run.tiering!.jev!.used_fallback, false);
      assert.ok(!(await consoleMessages(run, adwId)).some((m) => m.includes("jev risk_tier")));
    });
  });
});

// ── fallback cases (act mode) ───────────────────────────────────────────────

const FALLBACK_CASES: Array<{ name: string; fake: () => FakeJevClient; extraYaml?: string; reason: string }> = [
  { name: "low confidence", fake: () => FakeJevClient.choosing("high", 0.4), reason: "low_confidence" },
  { name: "timeout", fake: () => FakeJevClient.hanging(), extraYaml: "  decisions:\n    risk_tier: {timeout_ms: 20}\n", reason: "timeout" },
  { name: "API error", fake: () => FakeJevClient.failing(new JevApiError(529, "overloaded")), reason: "error" },
  { name: "answer outside the closed set", fake: () => FakeJevClient.choosing("extreme", 0.99), reason: "invalid_choice" },
  { name: "malformed answer", fake: () => FakeJevClient.answering({ q0: { nope: true } }), reason: "invalid_response" },
];

for (const c of FALLBACK_CASES) {
  test(`risk_tier act fallback: ${c.name} -> the heuristic acts, reason ${c.reason}, decision still recorded`, async () => {
    await withFake(c.fake(), async () => {
      const adwId = `adw_risk_fallback_${c.reason}`;
      await withRun(TIERING_YAML + "jev:\n  enabled: true\n  mode: act\n" + (c.extraYaml ?? ""), adwId, async (run, cfg) => {
        const { jev, ...rest } = run.tiering!;
        assert.deepEqual(rest, heuristicResolution(cfg));
        assert.equal(jev!.used_fallback, true);
        assert.equal(jev!.reason, c.reason);
        assert.equal((await rows(run, adwId, JEV_DECISION_EVENT)).length, 1);
      });
    });
  });
}

test("risk_tier act fallback: no API key -> heuristic, reason no_api_key, never a call", async () => {
  // No factory: client resolution falls to HttpJevClient only when the key env var is set — this one never is.
  const adwId = "adw_risk_no_key";
  await withRun(TIERING_YAML + "jev:\n  enabled: true\n  mode: act\n  api_key_env: SPF_RISK_TIER_TEST_UNSET_KEY\n", adwId, async (run, cfg) => {
    const { jev, ...rest } = run.tiering!;
    assert.deepEqual(rest, heuristicResolution(cfg));
    assert.equal(jev!.reason, "no_api_key");
  });
});

// ── safety bound: max_risk caps escalation (invariant 6) ────────────────────

test("risk_tier max_risk: Jev cannot ACT above the ceiling — not_permitted, heuristic acts", async () => {
  await withFake(FakeJevClient.choosing("high", 0.99), async () => {
    const yaml = TIERING_YAML + "jev:\n  enabled: true\n  mode: act\n  decisions:\n    risk_tier: {max_risk: standard}\n";
    await withRun(yaml, "adw_risk_max_risk", async (run, cfg) => {
      const { jev, ...rest } = run.tiering!;
      assert.deepEqual(rest, heuristicResolution(cfg));
      assert.equal(jev!.reason, "not_permitted");
      assert.equal(jev!.jev_choice, "high");
    });
  });
});

test("risk_tier max_risk: a lower answer under the ceiling still acts", async () => {
  await withFake(FakeJevClient.choosing("low", 0.99), async () => {
    const yaml = TIERING_YAML + "jev:\n  enabled: true\n  mode: act\n  decisions:\n    risk_tier: {max_risk: low}\n";
    await withRun(yaml, "adw_risk_max_risk_low", async (run) => {
      assert.equal(run.tiering!.risk, "low");
    });
  });
});

test("risk_tier permittedRisks: at or below the ceiling, plus the heuristic's own answer, always a valid set", () => {
  assert.deepEqual(permittedRisks("high", "standard"), ["low", "standard", "high"]);
  assert.deepEqual(permittedRisks("standard", "standard"), ["low", "standard"]);
  assert.deepEqual(permittedRisks("low", "standard"), ["low", "standard"], "the fallback is always permitted");
  assert.deepEqual(permittedRisks("low", "high"), ["low", "high"], "a ceiling never lowers the heuristic's own answer");
  for (const max of ["low", "standard", "high"] as const) {
    for (const fallback of ["low", "standard", "high"] as const) {
      assert.ok(isValidOptionSet(RISK_TIER_OPTIONS, fallback, { permitted: permittedRisks(max, fallback) }), `${max}/${fallback}`);
    }
  }
});

test("risk_tier: invalid extras with the kind live fail startRun loudly, naming the setting", async () => {
  await withFake(FakeJevClient.choosing("high", 0.99), async () => {
    await assert.rejects(
      withRun(TIERING_YAML + "jev:\n  enabled: true\n  decisions:\n    risk_tier: {max_risk: extreme}\n", "adw_risk_bad_extras", async () => {}),
      /jev\.decisions\.risk_tier: max_risk/,
    );
  });
});

// ── state + registry ─────────────────────────────────────────────────────────

test("risk_tier state: max_prompt_chars caps the prompt sent, and flags truncation", async () => {
  const fake = FakeJevClient.choosing("standard", 0.9);
  await withFake(fake, async () => {
    const yaml = TIERING_YAML + "jev:\n  enabled: true\n  mode: act\n  decisions:\n    risk_tier: {max_prompt_chars: 10}\n";
    await withRun(yaml, "adw_risk_state", async () => {
      const state = fake.calls[0]!.state as Record<string, unknown>;
      assert.equal(state.chain, "plan-build");
      assert.equal(state.prompt, PROMPT.slice(0, 10));
      assert.equal(state.prompt_truncated, true);
      assert.deepEqual(state.signals, { chain_weight: 0, prompt_words: 100, prompt_weight: 0 });
      const question = Object.values(fake.calls[0]!.questions)[0]!;
      assert.equal(question.type, "choice");
      assert.deepEqual(Object.keys((question as { criteria: Record<string, string> }).criteria), ["low", "standard", "high"]);
    });
  });
  assert.deepEqual(riskTierState("scout", "hi", 0).prompt, "", "0 sends no prompt text");
});

test("risk_tier registry: registered once, options built from the spec's own constant, extras default cleanly", () => {
  assert.equal(JEV_DECISION_KINDS["risk_tier"], RISK_TIER_KIND);
  assert.deepEqual(
    RISK_TIER_OPTIONS.map((o) => o.value),
    [...RISK_TIER_KIND.options!],
  );
  assert.deepEqual([...RISK_TIER_KIND.options!], ["low", "standard", "high"], "ladder order, weakest first — the order RISK_STEP shifts in");
  assert.deepEqual(v.parse(RISK_TIER_KIND.extras!, {}), { max_risk: "high", max_prompt_chars: 4000 });
});

test("risk_tier riskTierLive: needs jev.enabled, a non-off mode, and tiering.enabled", () => {
  const cfg = (tiering: boolean) => ({ tiering: { enabled: tiering, tiers: [], roles: {} } });
  assert.equal(riskTierLive(cfg(true), createJev({ config: { enabled: true } })), true);
  assert.equal(riskTierLive(cfg(false), createJev({ config: { enabled: true } })), false);
  assert.equal(riskTierLive(cfg(true), createJev({ config: { enabled: false } })), false);
  assert.equal(riskTierLive(cfg(true), createJev({ config: { enabled: true, decisions: { risk_tier: { mode: "off" } } } })), false);
});

// ── resolveTiering stays pure: decision in as data ─────────────────────────

function makeCfg(): SFConfig {
  return v.parse(SFConfigSchema, {
    agents: [{ name: "builder", model: "openai/configured", prompt_engineering: { system: "builder/system.md", user: "builder/user.md" } }],
    tiering: {
      enabled: true,
      tiers: [
        { name: "cheap", coding_agent: "flue", model: "openai/small" },
        { name: "mid", coding_agent: "flue", model: "openai/mid" },
        { name: "strong", coding_agent: "flue", model: "openai/big" },
      ],
      roles: { builder: "mid" },
    },
  }) as SFConfig;
}

function riskDecision(choice: string, over: Partial<RiskDecision> = {}): RiskDecision {
  return {
    kind: "risk_tier",
    key: "plan-build",
    choice: choice as Risk,
    jev_choice: choice as Risk,
    confidence: 0.9,
    fallback: "standard",
    used_fallback: false,
    reason: null,
    mode: "act",
    would_act: true,
    replayed: false,
    ...over,
  };
}

test("resolveTiering + riskDecision: the effective choice sets risk; null/absent is byte-identical to no decision; a bogus choice is ignored", () => {
  const cfg = makeCfg();
  const input = { cfg, chainName: "plan-build", prompt: PROMPT, servedOllamaTags: null, required: ["builder"] };
  const plain = resolveTiering(input);
  assert.deepEqual(resolveTiering({ ...input, riskDecision: null }), plain);
  assert.ok(!("jev" in resolveTiering({ ...input, riskDecision: null })));

  const high = resolveTiering({ ...input, riskDecision: riskDecision("high") });
  assert.equal(high.risk, "high");
  assert.equal(high.routing.builder!.effective, "openai/big");
  assert.deepEqual(high.signals, plain.signals);
  assert.equal(high.jev!.choice, "high");

  // Extra Decision fields (probabilities, usage, digest) are NOT copied into the summary.
  const full = { ...riskDecision("low"), probabilities: { low: 1 }, usage: { input_tokens: 1, output_tokens: 0 }, input_sha256: "x" } as unknown as RiskDecision;
  const low = resolveTiering({ ...input, riskDecision: full });
  assert.equal(low.risk, "low");
  assert.ok(!("probabilities" in low.jev!) && !("input_sha256" in low.jev!));

  const bogus = resolveTiering({ ...input, riskDecision: riskDecision("toString") });
  assert.deepEqual(bogus, plain, "a choice outside the three risks never indexes RISK_STEP");

  // pure: same input, same output
  assert.deepEqual(resolveTiering({ ...input, riskDecision: riskDecision("high") }), high);
});

test("resolveTiering + riskDecision with tiering disabled: risk reported, routing still empty", () => {
  const cfg = makeCfg();
  cfg.tiering.enabled = false;
  const res = resolveTiering({ cfg, chainName: "plan-build", prompt: PROMPT, servedOllamaTags: null, required: ["builder"], riskDecision: riskDecision("high") });
  assert.equal(res.risk, "high");
  assert.deepEqual(res.routing, {});
});

// ── spf estimate: says where its risk came from; replay, never a live call ──

function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const { log, error, warn } = console;
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  console.error = () => {};
  console.warn = () => {};
  return fn()
    .then((result) => ({ result, logs }))
    .finally(() => {
      console.log = log;
      console.error = error;
      console.warn = warn;
    });
}

async function estimateJson(argv: string[]): Promise<EstimateReport> {
  const { logs } = await captureLogs(() => estimateCommand([...argv, "--json"]));
  return JSON.parse(logs.join("\n")) as EstimateReport;
}

const ESTIMATE_PROMPT = "look around"; // scout chain (-1) + 2 words (-1) -> heuristic "low"

function estimateYaml(jevYaml: string): string {
  return (
    "agents:\n" +
    "  - name: scout\n    coding_agent: flue\n    model: openai/configured\n    prompt_engineering: {system: scout/system.md, user: scout/user.md}\n" +
    "tiering:\n  enabled: true\n  tiers:\n" +
    "    - {name: cheap, coding_agent: flue, model: openai/small}\n" +
    "    - {name: mid, coding_agent: flue, model: openai/mid}\n" +
    "    - {name: strong, coding_agent: flue, model: openai/big}\n" +
    "  roles: {scout: mid}\n" +
    jevYaml
  );
}

/** A temp repo whose trace holds run `r1`'s REAL risk_tier decision for the scout chain (made through `decideRiskTier` + the real trace recorder). */
async function withEstimateRepo(jevYaml: string, recordedChoice: Risk | null, body: (dir: string, configPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "spf-risk-estimate-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, estimateYaml(jevYaml));
    const tracer = await Tracer.open(join(dir, ".spf", "data", "spf.db"), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    await tracer.sessionStart("r1", "tester", "scout");
    if (recordedChoice !== null) {
      const recordCfg = loadConfig([configPath]);
      const jev = createJev({
        config: { enabled: true, mode: "act" },
        client: FakeJevClient.choosing(recordedChoice, 0.9),
        recorder: traceDecisionRecorder(tracer, "r1"),
      });
      const d = await decideRiskTier(jev, recordCfg, { chainName: "scout", prompt: ESTIMATE_PROMPT });
      assert.equal(d?.choice, recordedChoice, "fixture: the recorded decision acted");
    }
    await tracer.sessionFinish("r1", true);
    await tracer.close();
    await body(dir, configPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("estimate R8: no jev: block — no risk_source key, risk is the heuristic, zero calls (even with --replay-risk the heuristic acts)", async () => {
  const fake = FakeJevClient.choosing("high", 0.99);
  await withFake(fake, async () => {
    await withEstimateRepo("", "high", async (dir, configPath) => {
      const report = await estimateJson(["scout", ESTIMATE_PROMPT, "--config", configPath, "--cwd", dir, "--no-probe"]);
      assert.ok(!("risk_source" in report), "no jev block -> the pre-Jev report shape");
      assert.equal(report.risk, classifyRisk("scout", ESTIMATE_PROMPT).risk);
      assert.equal(report.risk, "low");

      const replayed = await estimateJson(["scout", ESTIMATE_PROMPT, "--config", configPath, "--cwd", dir, "--no-probe", "--replay-risk", "r1"]);
      assert.equal(replayed.risk, "low", "jev off beats a recorded decision");
      assert.equal(replayed.risk_source?.source, "heuristic");
      assert.match(replayed.risk_source!.detail, /--replay-risk ignored/);
      assert.equal(fake.calls.length, 0);
    });
  });
});

test("estimate: risk_tier live, no replay — reports the heuristic and SAYS so; never calls Jev", async () => {
  const fake = FakeJevClient.choosing("high", 0.99);
  await withFake(fake, async () => {
    await withEstimateRepo("jev:\n  enabled: true\n  mode: act\n", null, async (dir, configPath) => {
      const report = await estimateJson(["scout", ESTIMATE_PROMPT, "--config", configPath, "--cwd", dir, "--no-probe"]);
      assert.equal(report.risk, "low");
      assert.equal(report.risk_source?.source, "heuristic");
      assert.equal(report.risk_source?.replay_adw_id, null);
      assert.equal(fake.calls.length, 0);

      const { logs } = await captureLogs(() => estimateCommand(["scout", ESTIMATE_PROMPT, "--config", configPath, "--cwd", dir, "--no-probe"]));
      assert.ok(logs.join("\n").includes("risk from  heuristic"), logs.join("\n"));
    });
  });
});

test("estimate --replay-risk: reuses the run's recorded decision (no call, no new row) and says so", async () => {
  const fake = FakeJevClient.failing(new Error("estimate must never call Jev"));
  await withFake(fake, async () => {
    await withEstimateRepo("jev:\n  enabled: true\n  mode: act\n", "standard", async (dir, configPath) => {
      const report = await estimateJson(["scout", ESTIMATE_PROMPT, "--config", configPath, "--cwd", dir, "--no-probe", "--replay-risk", "r1"]);
      assert.equal(report.risk, "standard", "the recorded Jev answer, not the heuristic's low");
      assert.equal(report.routing["scout"]?.effective, "openai/mid");
      assert.equal(report.risk_source?.source, "recorded_decision");
      assert.equal(report.risk_source?.replay_adw_id, "r1");
      assert.equal(report.risk_source?.jev?.replayed, true);
      assert.equal(fake.calls.length, 0);

      const { logs } = await captureLogs(() =>
        estimateCommand(["scout", ESTIMATE_PROMPT, "--config", configPath, "--cwd", dir, "--no-probe", "--replay-risk", "r1"]),
      );
      assert.ok(logs.join("\n").includes("risk from  recorded jev decision"), logs.join("\n"));

      // read-only: still exactly one risk_tier row for r1
      const tracer = await Tracer.open(join(dir, ".spf", "data", "spf.db"), join(dir, ".spf", "data", "sessions", "events.jsonl"));
      try {
        const n = (await tracer.db.query("SELECT COUNT(*) AS n FROM events WHERE adw_id='r1' AND name=?").get(JEV_DECISION_EVENT)) as { n: number };
        assert.equal(n.n, 1);
      } finally {
        await tracer.close();
      }
    });
  });
});

test("estimate --replay-risk: today's shadow policy re-judges the recording -> heuristic acts, and the report says why", async () => {
  await withEstimateRepo("jev:\n  enabled: true\n  mode: shadow\n", "standard", async (dir, configPath) => {
    const report = await estimateJson(["scout", ESTIMATE_PROMPT, "--config", configPath, "--cwd", dir, "--no-probe", "--replay-risk", "r1"]);
    assert.equal(report.risk, "low");
    assert.equal(report.risk_source?.source, "heuristic");
    assert.equal(report.risk_source?.jev?.reason, "shadow");
  });
});

test("estimate --replay-risk: nothing recorded for that run -> replay_missing, heuristic, no call", async () => {
  const fake = FakeJevClient.choosing("high", 0.99);
  await withFake(fake, async () => {
    await withEstimateRepo("jev:\n  enabled: true\n  mode: act\n", null, async (dir, configPath) => {
      const report = await estimateJson(["scout", ESTIMATE_PROMPT, "--config", configPath, "--cwd", dir, "--no-probe", "--replay-risk", "nope"]);
      assert.equal(report.risk, "low");
      assert.equal(report.risk_source?.jev?.reason, "replay_missing");
      assert.match(report.risk_source!.detail, /no matching risk_tier decision/);
      assert.equal(fake.calls.length, 0);
    });
  });
});

// ── review follow-ups (#104) ────────────────────────────────────────────────

test("risk_tier resume: a second startRun under the same adw_id + chain REPLAYS the run's own decision — no second call, same routing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-risk-resume-"));
  const adwId = "adw_risk_resume";
  const opened: StartedRun[] = [];
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, TIERING_YAML + "jev:\n  enabled: true\n  mode: act\n");
    const start = async (fake: FakeJevClient, prompt: string): Promise<StartedRun> => {
      let run: StartedRun | undefined;
      await withFake(fake, async () => {
        run = await startRun({ prompt, config_paths: [configPath], adw_id: adwId, cwd: dir, chain_name: "plan-build", unattended: true }, ["builder"], []);
      });
      opened.push(run!);
      return run!;
    };

    const first = FakeJevClient.choosing("high", 0.95);
    const run1 = await start(first, PROMPT);
    assert.equal(first.calls.length, 1);
    assert.equal(run1.tiering!.risk, "high");

    // Same chain, same prompt bucket: Jev would now say "low" — it must not be asked.
    const second = FakeJevClient.choosing("low", 0.99);
    const run2 = await start(second, PROMPT);
    assert.equal(second.calls.length, 0, "a resume never re-asks Jev the same question");
    assert.equal(run2.tiering!.risk, "high", "both halves of the run route from the same answer");
    assert.equal(run2.tiering!.routing.builder!.effective, MODEL_FOR.high);
    assert.equal(run2.tiering!.jev!.replayed, true);
    let decisions = await rows(run2, adwId, JEV_DECISION_EVENT);
    assert.equal(decisions.length, 2, "the original + the replay (decide() records replays too, replayed: true)");
    assert.deepEqual(
      decisions.map((d) => d.payload.replayed),
      [false, true],
    );
    assert.equal(decisions.filter((d) => d.payload.replayed === false).length, 1, "exactly one LIVE decision");

    // A resumed prompt in a different word-count bucket (>=400 words -> heuristic high)
    // is a new question: it goes live rather than pinning the resume to replay_missing.
    const third = FakeJevClient.choosing("standard", 0.99);
    const run3 = await start(third, words(400));
    assert.equal(third.calls.length, 1, "a changed fallback is a new question — asked live");
    assert.equal(run3.tiering!.jev!.replayed, false);
    assert.equal(run3.tiering!.jev!.fallback, "high");
    assert.equal(run3.tiering!.risk, "standard");
    decisions = await rows(run3, adwId, JEV_DECISION_EVENT);
    assert.equal(decisions.length, 3);
  } finally {
    for (const run of opened) await run.tracer.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("risk_tier: tiering OFF + jev live + invalid risk_tier extras — startRun does NOT throw (extras are unread); doctor is what flags them", async () => {
  const fake = FakeJevClient.choosing("high", 0.99);
  await withFake(fake, async () => {
    const adwId = "adw_risk_tiering_off_bad_extras";
    const yaml = TIERING_YAML.replace("enabled: true", "enabled: false") + "jev:\n  enabled: true\n  mode: act\n  decisions:\n    risk_tier: {max_risk: extreme}\n";
    await withRun(yaml, adwId, async (run, cfg) => {
      assert.equal(fake.calls.length, 0);
      assert.equal((await rows(run, adwId, JEV_DECISION_EVENT)).length, 0);
      assert.deepEqual(run.tiering, heuristicResolution(cfg));
    });
  });
});

test("risk_tier registry: every option carries a real description (the kind's values and tiering's Risk cannot drift)", () => {
  for (const option of RISK_TIER_OPTIONS) {
    assert.equal(typeof option.description, "string", option.value);
    assert.ok(option.description.length > 0, option.value);
  }
  assert.deepEqual(RISK_TIER_OPTIONS.map((o) => o.value), [...RISK_TIER_VALUES]);
  assert.equal(RISK_SETS_MATCH, true);
});

test("estimate --replay-risk: a recording made under a different prompt word-count bucket -> replay_missing, heuristic, no call", async () => {
  const fake = FakeJevClient.failing(new Error("estimate must never call Jev"));
  await withFake(fake, async () => {
    await withEstimateRepo("jev:\n  enabled: true\n  mode: act\n", "high", async (dir, configPath) => {
      const longer = words(100); // scout (-1) + 100 words (0) -> heuristic "standard", vs the recording's "low" fallback
      const report = await estimateJson(["scout", longer, "--config", configPath, "--cwd", dir, "--no-probe", "--replay-risk", "r1"]);
      assert.equal(report.risk, classifyRisk("scout", longer).risk);
      assert.equal(report.risk, "standard");
      assert.equal(report.risk_source?.source, "heuristic");
      assert.equal(report.risk_source?.jev?.reason, "replay_missing");
      assert.match(report.risk_source!.detail, /no matching risk_tier decision/);
      assert.equal(fake.calls.length, 0);
    });
  });
});

test("estimate --replay-risk: a recording above today's max_risk is not_permitted on replay (invariant 6) — heuristic acts", async () => {
  const fake = FakeJevClient.failing(new Error("estimate must never call Jev"));
  await withFake(fake, async () => {
    // Recorded "high" under the default max_risk (high); replayed today under max_risk: standard.
    await withEstimateRepo("jev:\n  enabled: true\n  mode: act\n  decisions:\n    risk_tier: {max_risk: standard}\n", "high", async (dir, configPath) => {
      const report = await estimateJson(["scout", ESTIMATE_PROMPT, "--config", configPath, "--cwd", dir, "--no-probe", "--replay-risk", "r1"]);
      assert.equal(report.risk, classifyRisk("scout", ESTIMATE_PROMPT).risk);
      assert.equal(report.risk_source?.source, "heuristic");
      assert.equal(report.risk_source?.jev?.reason, "not_permitted");
      assert.equal(report.risk_source?.jev?.jev_choice, "high");
      assert.equal(fake.calls.length, 0);
    });
  });
});

async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; stderr: string[] }> {
  const stderr: string[] = [];
  const { log, error, warn } = console;
  console.log = () => {};
  console.error = (...args: unknown[]) => void stderr.push(args.join(" "));
  console.warn = () => {};
  try {
    return { code: await fn(), stderr };
  } finally {
    console.log = log;
    console.error = error;
    console.warn = warn;
  }
}

test("estimate --replay-risk with invalid risk_tier extras: exit 1 with the jev.decisions.risk_tier config error", async () => {
  await withEstimateRepo("jev:\n  enabled: true\n  mode: act\n  decisions:\n    risk_tier: {max_risk: extreme}\n", null, async (dir, configPath) => {
    const { code, stderr } = await captureStderr(() =>
      estimateCommand(["scout", ESTIMATE_PROMPT, "--config", configPath, "--cwd", dir, "--no-probe", "--replay-risk", "r1"]),
    );
    assert.equal(code, 1);
    assert.match(stderr.join("\n"), /jev\.decisions\.risk_tier: max_risk/);
  });
});

test("estimate --replay-risk with no trace db at all: says there is nothing to replay (not a chain/prompt mismatch)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-risk-estimate-notrace-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, estimateYaml("jev:\n  enabled: true\n  mode: act\n"));
    const report = await estimateJson(["scout", ESTIMATE_PROMPT, "--config", configPath, "--cwd", dir, "--no-probe", "--replay-risk", "r1"]);
    assert.equal(report.risk, "low");
    assert.equal(report.risk_source?.jev?.reason, "replay_missing");
    assert.match(report.risk_source!.detail, /no trace db found under --cwd/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Type-level: a full Decision<Risk> is assignable to the riskDecision input.
const _typecheck: (d: Decision<Risk>) => RiskDecision = (d) => d;
void _typecheck;
