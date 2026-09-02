/**
 * Risk-tiered per-role model routing — SPF #14. See the design doc's §7.1
 * for the full plan this file implements; test numbers in comments below
 * refer to that section.
 *
 * `hermetic_git.js` is imported first because `validate()`/`startRun` are
 * NOT pure here: every `validate(cfg, ..., dir)` call (tests 7/7b/7c and
 * others) and `startRun` (tests 8/8b/9) go through `paths.resolveAnchor` ->
 * `findRepoRoot` -> `isRepoAt`, which spawns a real (read-only)
 * `git rev-parse --git-dir` (`src/core/git_helper.ts:27`) against `cwd`. Run
 * from lefthook's `pre-push` hook — the scenario `hermetic_git.ts` exists
 * for — git exports `GIT_DIR`, so that spawn would resolve against the real
 * checkout instead of the scratch tmpdir, and `startRun` -> `session.ensure`
 * -> `resolveDataPaths` would then anchor `data_dir`/`db_path` to the real
 * repo root (`src/core/paths.ts:151-153`), silently writing `sessions`/
 * `phases`/`events` rows into this developer's working repo. Mirrors
 * `estimate.test.ts:1` and its comment at `:14-18`.
 */
import "./hermetic_git.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { EVENT_RECORD_TYPES, SFConfigSchema, type SFConfig } from "../core/data_types.js";
import { validate } from "../core/agents.js";
import {
  CHAIN_WEIGHTS,
  chainWeight,
  changedModels,
  classifyRisk,
  effectiveAgent,
  probeServedOllamaTags,
  promptWeight,
  resetProbeCacheForTest,
  resolveTiering,
  type TierResolution,
} from "../core/tiering.js";
import { CHAINS, resolveRequiredAgents } from "../chains/index.js";
import { startRun } from "../chains/steps.js";
import type { ChainContext } from "../chains/context.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
}

/** A minimally valid agent — real prompt refs (content is irrelevant to every test here) so `validate()`'s prompt-ref check never fires spuriously. */
function agent(name: string, overrides: Partial<{ model: string; coding_agent: "flue" | "claude_code" }> = {}) {
  return {
    name,
    coding_agent: overrides.coding_agent ?? "flue",
    model: overrides.model ?? "google/gemini-3.6-flash",
    prompt_engineering: { system: "builder/system.md", user: "builder/user.md" },
  };
}

const SIX_ROLE_AGENTS = ["scout", "builder", "planner", "documenter", "refiner", "reviewer"].map((n) => agent(n));
const SIX_ROLE_MAP = { scout: "scout", documenter: "scout", planner: "builder", builder: "builder", refiner: "builder", reviewer: "builder" };

function makeCfg(opts: { agents?: ReturnType<typeof agent>[]; tiering?: Record<string, unknown> } = {}): SFConfig {
  return v.parse(SFConfigSchema, {
    agents: opts.agents ?? SIX_ROLE_AGENTS,
    tiering: opts.tiering ?? {},
  }) as SFConfig;
}

function tmpRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ── test 1: enabled=false is a total no-op ──────────────────────────────────

test("enabled=false is a total no-op across every built-in chain and every prompt-length bucket", () => {
  const cfg = makeCfg({
    tiering: {
      enabled: false,
      tiers: [
        { name: "scout", coding_agent: "flue", model: "ollama/granite4.1:8b" },
        { name: "builder", coding_agent: "flue", model: "ollama/qwen3.8:27b-mlx" },
      ],
      roles: SIX_ROLE_MAP,
    },
  });
  for (const chain of CHAINS) {
    const required = resolveRequiredAgents(chain, {});
    for (const n of [0, 60, 61, 399, 400, 5000]) {
      const res = resolveTiering({ cfg, chainName: chain.name, prompt: words(n), servedOllamaTags: null, required });
      assert.deepEqual(res.routing, {}, `${chain.name} @ ${n} words: routing must be {} when tiering is disabled`);
      assert.deepEqual(changedModels(res), {}, `${chain.name} @ ${n} words: changedModels must be {} too`);
      for (const name of required) {
        const base = cfg.agents.find((a) => a.name === name)!;
        const eff = effectiveAgent({ tiering: res }, base);
        assert.equal(eff.model, base.model, `${chain.name}/${name}: model must be byte-identical when disabled`);
        assert.equal(eff.coding_agent, base.coding_agent, `${chain.name}/${name}: coding_agent must be untouched`);
      }
    }
  }
});

test("1b: enabled=true with nothing to change still reports FULL routing, not a diff", () => {
  const cfg = makeCfg({
    agents: [agent("scout", { model: "ollama/granite4.1:8b" })],
    tiering: { enabled: true, tiers: [{ name: "scout", coding_agent: "flue", model: "ollama/granite4.1:8b" }], roles: { scout: "scout" } },
  });
  // chainWeight("plan-build")=0, a moderate prompt -> promptWeight 0 -> standard -> no shift.
  const res = resolveTiering({ cfg, chainName: "plan-build", prompt: words(100), servedOllamaTags: null, required: ["scout"] });
  assert.equal(res.risk, "standard");
  assert.deepEqual(res.routing, { scout: { tier: "scout", configured: "ollama/granite4.1:8b", effective: "ollama/granite4.1:8b" } });
  assert.deepEqual(changedModels(res), {}, "configured === effective -> not a diff, but still a routing entry");
});

// ── test 2: the full 3x3 classifier table, pinned ───────────────────────────

test("2: the full 3x3 (chainWeight x promptWeight) -> risk table from the design doc's §2", () => {
  // one representative chain name per weight bucket
  const CHAIN_BY_WEIGHT: Record<-1 | 0 | 1, string> = { [-1]: "scout", [0]: "plan-build", [1]: "refine" };
  const WORDS_BY_WEIGHT: Record<-1 | 0 | 1, number> = { [-1]: 10, [0]: 100, [1]: 500 };
  // [chainWeight][promptWeight] -> risk
  const EXPECTED: Record<-1 | 0 | 1, Record<-1 | 0 | 1, "low" | "standard" | "high">> = {
    [-1]: { [-1]: "low", [0]: "standard", [1]: "high" },
    [0]: { [-1]: "standard", [0]: "standard", [1]: "high" },
    [1]: { [-1]: "standard", [0]: "high", [1]: "high" },
  };
  for (const cw of [-1, 0, 1] as const) {
    for (const pw of [-1, 0, 1] as const) {
      const { risk } = classifyRisk(CHAIN_BY_WEIGHT[cw], words(WORDS_BY_WEIGHT[pw]));
      assert.equal(risk, EXPECTED[cw][pw], `chainWeight ${cw} x promptWeight ${pw}`);
    }
  }
  // boundaries: 60/61 and 399/400
  assert.equal(promptWeight(60), -1);
  assert.equal(promptWeight(61), 0);
  assert.equal(promptWeight(399), 0);
  assert.equal(promptWeight(400), 1);
  // Named regressions from revision 2's symmetric clamp bug:
  assert.equal(classifyRisk("plan-build-test", words(18)).risk, "standard", "(0,-1) -> standard: a one-liner must NOT demote the builder");
  assert.equal(classifyRisk("scout", words(10)).risk, "low", "(-1,-1) -> low: reachable, and requires TWO agreeing signals");
});

// ── test 3: chainWeight is an explicit table, not a fallthrough default ────

test("3: every built-in chain has an EXPLICIT chainWeight table entry — a repo-local/unknown name falls through separately", () => {
  for (const chain of CHAINS) {
    assert.ok(chain.name in CHAIN_WEIGHTS, `built-in chain ${JSON.stringify(chain.name)} has no explicit chainWeight entry`);
  }
  assert.equal(Object.keys(CHAIN_WEIGHTS).length, CHAINS.length, "no stray/extra entries beyond the built-in set");
  assert.ok(!("my-repo-local-chain" in CHAIN_WEIGHTS));
  assert.equal(chainWeight("my-repo-local-chain"), 0, "an unknown (repo-local) name falls to 0 through the table's OWN default");
});

// ── test 4: the ladder walk, clamped at both ends, same step for every role ─

test("4: ladder walk — clamped at both ends, and the SAME step shifts every routed role", () => {
  const cfg = makeCfg({
    agents: [agent("atTop", { model: "orig-top" }), agent("middle", { model: "orig-mid" }), agent("atBottom", { model: "orig-bottom" })],
    tiering: {
      enabled: true,
      tiers: [
        { name: "t0", coding_agent: "flue", model: "prov/m0" },
        { name: "t1", coding_agent: "flue", model: "prov/m1" },
        { name: "t2", coding_agent: "flue", model: "prov/m2" },
      ],
      roles: { atTop: "t2", middle: "t1", atBottom: "t0" },
    },
  });
  const required = ["atTop", "middle", "atBottom"];

  // risk=high (chainWeight("refine")=+1, promptWeight(100 words)=0 -> sum=1 -> high)
  const high = resolveTiering({ cfg, chainName: "refine", prompt: words(100), servedOllamaTags: null, required });
  assert.equal(high.risk, "high");
  assert.equal(high.routing.atTop!.tier, "t2", "already at the top rung -> clamped, stays");
  assert.equal(high.routing.middle!.tier, "t2", "t1 -> t2: +1 step");
  assert.equal(high.routing.atBottom!.tier, "t1", "t0 -> t1: +1 step");

  // risk=low (chainWeight("scout")=-1, promptWeight(<=60)=-1 -> sum=-2 -> low)
  const low = resolveTiering({ cfg, chainName: "scout", prompt: words(10), servedOllamaTags: null, required });
  assert.equal(low.risk, "low");
  assert.equal(low.routing.atBottom!.tier, "t0", "already at the bottom rung -> clamped, stays");
  assert.equal(low.routing.middle!.tier, "t0", "t1 -> t0: -1 step");
  assert.equal(low.routing.atTop!.tier, "t1", "t2 -> t1: -1 step — the SAME -1 step as middle's shift above");
});

// ── test 5: precedence — roles wins, absence leaves model untouched ─────────

test("5: precedence — an agent named in roles is retiered; one absent from roles keeps its own model", () => {
  const cfg = makeCfg({
    agents: [agent("inRoles", { model: "orig1" }), agent("notInRoles", { model: "orig2" })],
    tiering: { enabled: true, tiers: [{ name: "t0", coding_agent: "flue", model: "new0" }], roles: { inRoles: "t0" } },
  });
  const res = resolveTiering({ cfg, chainName: "plan-build", prompt: words(10), servedOllamaTags: null, required: ["inRoles", "notInRoles"] });
  assert.deepEqual(res.routing.inRoles, { tier: "t0", configured: "orig1", effective: "new0" });
  assert.ok(!("notInRoles" in res.routing), "not named in roles -> no routing entry at all");
  const untouched = effectiveAgent({ tiering: res }, cfg.agents.find((a) => a.name === "notInRoles")!);
  assert.equal(untouched.model, "orig2");
});

// ── test 6: degradation ──────────────────────────────────────────────────────

test("6a: target rung unusable -> walks DOWN to the nearest usable one, never up", () => {
  const cfg = makeCfg({
    agents: [agent("role", { model: "orig" })],
    tiering: {
      enabled: true,
      tiers: [
        { name: "t0", coding_agent: "flue", model: "ollama/a" },
        { name: "t1", coding_agent: "flue", model: "ollama/b" },
      ],
      roles: { role: "t1" },
    },
  });
  const served = new Set(["a"]); // t1's tag ("b") is NOT served
  const res = resolveTiering({ cfg, chainName: "plan-build", prompt: words(10), servedOllamaTags: served, required: ["role"] });
  assert.deepEqual(res.routing.role, { tier: "t0", configured: "orig", effective: "ollama/a" });
});

test("6b: every rung at/below the target unusable -> agent.model + a note, and NO routing entry", () => {
  const cfg = makeCfg({
    agents: [agent("role", { model: "orig" })],
    tiering: { enabled: true, tiers: [{ name: "t0", coding_agent: "flue", model: "ollama/x" }], roles: { role: "t0" } },
  });
  const served = new Set<string>(); // nothing served
  const res = resolveTiering({ cfg, chainName: "plan-build", prompt: words(10), servedOllamaTags: served, required: ["role"] });
  assert.ok(!("role" in res.routing));
  assert.ok(res.notes.some((n) => n.includes("role")));
  const eff = effectiveAgent({ tiering: res }, cfg.agents[0]!);
  assert.equal(eff.model, "orig", "unrouted -> effectiveAgent falls back to the configured model, same as an agent tiering never touched");
});

test("6d: servedOllamaTags === null -> fail OPEN, nothing drops", () => {
  const cfg = makeCfg({
    agents: [agent("role", { model: "orig" })],
    tiering: { enabled: true, tiers: [{ name: "t0", coding_agent: "flue", model: "ollama/never-checked" }], roles: { role: "t0" } },
  });
  const res = resolveTiering({ cfg, chainName: "plan-build", prompt: words(10), servedOllamaTags: null, required: ["role"] });
  assert.deepEqual(res.routing.role, { tier: "t0", configured: "orig", effective: "ollama/never-checked" });
});

test("6e: a roles key naming an agent absent from the roster — scoped to `required`", () => {
  const cfg = makeCfg({
    agents: [],
    tiering: { enabled: true, tiers: [{ name: "t0", coding_agent: "flue", model: "prov/m0" }], roles: { ghost: "t0" } },
  });
  const inRequired = resolveTiering({ cfg, chainName: "plan-build", prompt: words(10), servedOllamaTags: null, required: ["ghost"] });
  assert.ok(!("ghost" in inRequired.routing));
  assert.equal(inRequired.notes.length, 1, "in required -> one note, no throw");

  const notRequired = resolveTiering({ cfg, chainName: "plan-build", prompt: words(10), servedOllamaTags: null, required: [] });
  assert.ok(!("ghost" in notRequired.routing));
  assert.deepEqual(notRequired.notes, [], "not required -> untouched entirely, not even a note");
});

test("6f: probeServedOllamaTags — strips the ollama/ prefix before lookup, and fails OPEN on every error shape", async () => {
  const savedFetch = globalThis.fetch;
  const cfg = makeCfg({
    tiering: { enabled: true, tiers: [{ name: "t0", coding_agent: "flue", model: "ollama/granite4.1:8b" }], roles: { x: "t0" } },
  });
  try {
    resetProbeCacheForTest();
    globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [{ id: "granite4.1:8b" }] }), { status: 200 })) as typeof fetch;
    const tags = await probeServedOllamaTags(cfg);
    assert.ok(tags !== null);
    assert.ok(tags!.has("granite4.1:8b"), "the SET stores the BARE tag, no ollama/ prefix");
    assert.ok(!tags!.has("ollama/granite4.1:8b"));
    assert.ok(!tags!.has("not-pulled"));

    resetProbeCacheForTest();
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    assert.equal(await probeServedOllamaTags(cfg), null, "non-200 -> null");

    resetProbeCacheForTest();
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    assert.equal(await probeServedOllamaTags(cfg), null, "a thrown fetch -> null");

    resetProbeCacheForTest();
    globalThis.fetch = (async () => new Response("not json{{{", { status: 200 })) as typeof fetch;
    assert.equal(await probeServedOllamaTags(cfg), null, "unparseable body -> null");

    resetProbeCacheForTest();
    globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list" }), { status: 200 })) as typeof fetch;
    assert.equal(await probeServedOllamaTags(cfg), null, "missing/non-array data -> null");
  } finally {
    globalThis.fetch = savedFetch;
    resetProbeCacheForTest();
  }
});

test("6f-gating: probeServedOllamaTags never fetches when disabled or when no tier is ollama/", async () => {
  const savedFetch = globalThis.fetch;
  let called = false;
  try {
    resetProbeCacheForTest();
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("must not be called");
    }) as typeof fetch;

    const hostedOnly = makeCfg({ tiering: { enabled: true, tiers: [{ name: "t0", model: "openai/gpt-5.6-terra" }], roles: { x: "t0" } } });
    assert.equal(await probeServedOllamaTags(hostedOnly), null);
    assert.equal(called, false, "no ollama/ tier -> never fetches");

    resetProbeCacheForTest();
    const disabled = makeCfg({ tiering: { enabled: false, tiers: [{ name: "t0", model: "ollama/x" }], roles: { x: "t0" } } });
    assert.equal(await probeServedOllamaTags(disabled), null);
    assert.equal(called, false, "tiering disabled -> never fetches, even with an ollama/ tier present");
  } finally {
    globalThis.fetch = savedFetch;
    resetProbeCacheForTest();
  }
});

test("6g: rule T inside resolveTiering — a backend mismatch is a note, never a throw", () => {
  const cfg = makeCfg({
    agents: [agent("role", { model: "sonnet", coding_agent: "claude_code" })],
    tiering: { enabled: true, tiers: [{ name: "t0", coding_agent: "flue", model: "prov/m0" }], roles: { role: "t0" } },
  });
  let res!: TierResolution;
  assert.doesNotThrow(() => {
    res = resolveTiering({ cfg, chainName: "plan-build", prompt: words(10), servedOllamaTags: null, required: ["role"] });
  });
  assert.ok(!("role" in res.routing));
  assert.equal(res.notes.length, 1);
});

// ── test 7: validate() failures — message + scope ───────────────────────────

test("7: tiers[].model shape check is cfg-global — fails even when required=[] (e.g. `quality`)", () => {
  const dir = tmpRepo("spf-tiering-validate-shape-");
  try {
    const cfg = makeCfg({
      agents: [],
      tiering: { enabled: true, tiers: [{ name: "bad", model: "not-a-valid-model" }], roles: { foo: "bad" } },
    });
    assert.throws(
      () => validate(cfg, [], [], dir),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /tiering\.tiers\["bad"\]/);
        assert.match(message, /provider\/model-id/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("7: enabled=true with empty tiers or empty roles is a cfg-global error", () => {
  const dir = tmpRepo("spf-tiering-validate-empty-");
  try {
    const emptyTiers = makeCfg({ agents: [], tiering: { enabled: true, tiers: [], roles: { x: "y" } } });
    assert.throws(() => validate(emptyTiers, [], [], dir), /tiering\.tiers is empty/);

    const emptyRoles = makeCfg({ agents: [], tiering: { enabled: true, tiers: [{ name: "t0", model: "prov/m0" }], roles: {} } });
    assert.throws(() => validate(emptyRoles, [], [], dir), /tiering\.roles is empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("7: an unknown tier name in roles errors when the role is required, and is silent otherwise", () => {
  const dir = tmpRepo("spf-tiering-validate-unknown-tier-");
  try {
    const cfg = makeCfg({
      agents: [agent("scout")],
      tiering: { enabled: true, tiers: [{ name: "cheap", model: "openai/small" }], roles: { scout: "missing-tier" } },
    });
    assert.throws(() => validate(cfg, ["scout"], [], dir), /tiering\.roles\.scout names tier .*not declared/);
    assert.doesNotThrow(() => validate(cfg, [], [], dir), "scout is not required by this chain -> inert");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("7: a roles key naming an agent absent from the roster errors when required, is silent otherwise", () => {
  const dir = tmpRepo("spf-tiering-validate-absent-agent-");
  try {
    const cfg = makeCfg({
      agents: [],
      tiering: { enabled: true, tiers: [{ name: "cheap", model: "openai/small" }], roles: { ghost: "cheap" } },
    });
    assert.throws(() => validate(cfg, ["ghost"], [], dir), /agent "ghost" is not defined/);
    assert.doesNotThrow(() => validate(cfg, [], [], dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("7b: rule T — a claude_code agent routed to a flue tier is a named validate() error, scoped to required", () => {
  const dir = tmpRepo("spf-tiering-validate-rule-t-");
  try {
    const cfg = makeCfg({
      agents: [agent("builder", { coding_agent: "claude_code", model: "sonnet" })],
      tiering: {
        enabled: true,
        tiers: [{ name: "builder", coding_agent: "flue", model: "fireworks/accounts/fireworks/models/kimi-k3" }],
        roles: { builder: "builder" },
      },
    });
    assert.throws(
      () => validate(cfg, ["builder"], [], dir),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /"builder"/);
        assert.match(message, /claude_code/);
        assert.match(message, /flue/);
        return true;
      },
    );
    assert.doesNotThrow(() => validate(cfg, [], [], dir), "builder is not required here -> rule T is inert");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("7c: every check above is silent when enabled=false — pruned roster, and the packaged ladder never opted into", () => {
  const dir = tmpRepo("spf-tiering-validate-disabled-");
  try {
    const packagedTiering = {
      enabled: false,
      tiers: [
        { name: "scout", model: "google/gemini-3.6-flash" },
        { name: "builder", model: "fireworks/accounts/fireworks/models/kimi-k3" },
        { name: "deep", model: "openai/gpt-5.6-terra" },
      ],
      roles: SIX_ROLE_MAP,
    };

    // a pruned roster (no agents at all) + the packaged roles map inherited via merge -> `spf quality` (required=[]) is green
    const pruned = makeCfg({ agents: [], tiering: packagedTiering });
    assert.doesNotThrow(() => validate(pruned, [], [], dir));

    // the full packaged roster, ladder never opted into -> every built-in chain validates green
    const full = makeCfg({ agents: SIX_ROLE_AGENTS, tiering: packagedTiering });
    for (const chain of CHAINS) {
      const required = resolveRequiredAgents(chain, {});
      assert.doesNotThrow(() => validate(full, required, [], dir), `${chain.name} must validate green with tiering disabled`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── test 8 / 8b / 9: startRun wiring — trace shape, console line, ordering ──

function baseCtx(dir: string, over: Partial<ChainContext> = {}): ChainContext {
  return {
    prompt: "a short prompt",
    config_paths: [],
    adw_id: null,
    cwd: dir,
    chain_name: "plan-build",
    unattended: true,
    ...over,
  };
}

test("8 / 8b: startRun traces exactly one `tiering` log event per call and one console note per RETIERED agent", async () => {
  const dir = tmpRepo("spf-tiering-startrun-trace-");
  try {
    const configPath = join(dir, "spf.config.yaml");
    // startRun calls agentsCfg.loadConfig(ctx.config_paths) itself, so this
    // fixture has to exist as a real file, written by hand (no YAML
    // serializer dependency needed for a fixture this small).
    const yaml =
      "agents:\n" +
      "  - name: scout\n    model: openai/small\n    prompt_engineering: {system: builder/system.md, user: builder/user.md}\n" +
      "  - name: builder\n    model: openai/big\n    prompt_engineering: {system: builder/system.md, user: builder/user.md}\n" +
      "tiering:\n" +
      "  enabled: true\n" +
      "  tiers:\n" +
      "    - {name: cheap, coding_agent: flue, model: openai/small}\n" +
      "    - {name: strong, coding_agent: flue, model: openai/big}\n" +
      "  roles: {scout: cheap, builder: cheap}\n";
    writeFileSync(configPath, yaml);

    const adwId = "adw_tiering_trace_test_1";
    const ctx = baseCtx(dir, { config_paths: [configPath], adw_id: adwId, chain_name: "plan-build", prompt: words(100) });
    const run = await startRun(ctx, ["scout", "builder"], []);
    try {
      assert.equal(run.tiering!.risk, "standard");
      assert.deepEqual(run.tiering!.routing.scout, { tier: "cheap", configured: "openai/small", effective: "openai/small" });
      assert.deepEqual(run.tiering!.routing.builder, { tier: "cheap", configured: "openai/big", effective: "openai/small" });

      const tieringEvents = (await run.tracer.db.query("SELECT payload_json FROM events WHERE adw_id=? AND type='log' AND name='tiering'").all(adwId)) as Array<{
        payload_json: string;
      }>;
      assert.equal(tieringEvents.length, 1, "exactly one `tiering` log event for this startRun call");
      const payload = JSON.parse(tieringEvents[0]!.payload_json);
      assert.equal(payload.risk, "standard");
      assert.ok(payload.signals);
      assert.deepEqual(payload.routing, run.tiering!.routing, "the traced payload carries the FULL routing map");
      assert.deepEqual(payload.notes, []);

      // EVENT_RECORD_TYPES stays a closed picklist — "tiering" is a `log` name, not a new event kind.
      assert.deepEqual(EVENT_RECORD_TYPES, [
        "phase_start",
        "agent_start",
        "tool_call",
        "handoff",
        "gate_pass",
        "gate_fail",
        "log",
        "agent_end",
        "phase_end",
        "error",
      ]);

      // console note: one line for `builder` (retiered), none for `scout` (unchanged)
      const consoleLines = (await run.tracer.db
        .query("SELECT payload_json FROM events WHERE adw_id=? AND type='log' AND name='console'")
        .all(adwId)) as Array<{ payload_json: string }>;
      const messages = consoleLines.map((r) => (JSON.parse(r.payload_json) as { message: string }).message);
      const builderLine = messages.find((m) => m.includes("builder"));
      assert.ok(builderLine, "a console note names the retiered agent");
      assert.match(builderLine!, /\[spf\] tiering builder cheap \(openai\/big -> openai\/small\) risk=standard/);
      assert.ok(!messages.some((m) => m.includes("tiering scout")), "scout's tier resolved to its already-configured model -> not news, no line");

      // A second startRun call under the SAME adw_id (a joined session) must add a SECOND
      // `tiering` event, not dedupe to one — the event is per-startRun-call, not per-adw_id.
      const ctx2 = baseCtx(dir, { config_paths: [configPath], adw_id: adwId, chain_name: "scout", prompt: words(100) });
      const run2 = await startRun(ctx2, ["scout"], []);
      try {
        const tieringEventsAfter = await run.tracer.db.query("SELECT payload_json FROM events WHERE adw_id=? AND type='log' AND name='tiering'").all(adwId);
        assert.equal(tieringEventsAfter.length, 2, "a joined session's second startRun call adds a second tiering event");
      } finally {
        await run2.tracer.db.close();
      }
    } finally {
      await run.tracer.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("9: startRun awaits the availability probe before returning — run.tiering is never read before it settles", async () => {
  const dir = tmpRepo("spf-tiering-startrun-ordering-");
  const savedFetch = globalThis.fetch;
  try {
    resetProbeCacheForTest();
    let resolveFetch!: (body: string) => void;
    const gate = new Promise<string>((resolve) => {
      resolveFetch = resolve;
    });
    globalThis.fetch = (async () => {
      const body = await gate;
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(
      configPath,
      "agents:\n  - name: scout\n    model: ollama/granite4.1:8b\n    prompt_engineering: {system: builder/system.md, user: builder/user.md}\n" +
        "tiering:\n  enabled: true\n  tiers:\n    - {name: scout, coding_agent: flue, model: ollama/granite4.1:8b}\n  roles: {scout: scout}\n",
    );
    const ctx = baseCtx(dir, { config_paths: [configPath], adw_id: "adw_tiering_ordering_test", chain_name: "scout", prompt: words(10) });

    let settled = false;
    const runPromise = startRun(ctx, ["scout"], []).then((run) => {
      settled = true;
      return run;
    });

    // Give the microtask queue every chance to run WITHOUT ever resolving the
    // fetch — if the probe were fired-and-forgotten, startRun would settle here anyway.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(settled, false, "startRun must not resolve while the availability probe is still pending");

    resolveFetch(JSON.stringify({ object: "list", data: [{ id: "granite4.1:8b" }] }));
    const run = await runPromise;
    try {
      assert.equal(settled, true);
      assert.ok(run.tiering, "run.tiering is populated only after the probe resolved");
      assert.deepEqual(run.tiering!.routing.scout, { tier: "scout", configured: "ollama/granite4.1:8b", effective: "ollama/granite4.1:8b" });
    } finally {
      run.tracer.db.close();
    }
  } finally {
    globalThis.fetch = savedFetch;
    resetProbeCacheForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── test 10: resolveTiering is pure ─────────────────────────────────────────

test("10: resolveTiering is pure — identical input, identical output, no Run/ChainContext/git/fs involved", () => {
  const cfg = makeCfg({
    agents: [agent("scout", { model: "orig" })],
    tiering: { enabled: true, tiers: [{ name: "t0", coding_agent: "flue", model: "new" }], roles: { scout: "t0" } },
  });
  const input = { cfg, chainName: "plan-build", prompt: "same prompt every time", servedOllamaTags: null, required: ["scout"] };
  const a = resolveTiering(input);
  const b = resolveTiering({ ...input });
  assert.deepEqual(a, b);
});
