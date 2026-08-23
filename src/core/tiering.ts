/**
 * Risk-tiered per-role model routing — SPF #14.
 *
 * PURE except for `probeServedOllamaTags`, the one async/impure export (a
 * network probe — see its own doc comment below). Everything else here is a
 * function of its own arguments: no `Run`, no `ChainContext`, no git handle,
 * no filesystem. That purity is deliberate — it is what lets `startRun`
 * (`src/chains/steps.ts`) and `spf estimate` call the IDENTICAL
 * `resolveTiering` and get identical answers with no drift between "what
 * will dispatch" and "what would dispatch".
 *
 * No imports from `src/chains/` and none from `src/cli/` — `spf doctor` and
 * `startRun` both import FROM this module, never the reverse.
 *
 * ── The mechanism, in one paragraph ─────────────────────────────────────
 * A run's `risk` (`low`/`standard`/`high`) is a single run-global scalar,
 * classified once from the chain's name and the prompt's word count
 * (`classifyRisk`). Separately, `tiering.roles` names a baseline tier per
 * ROLE (an agent name) on `tiering.tiers`, a ladder ordered weakest first.
 * `resolveTiering` shifts every routed role's baseline by the SAME step in
 * the SAME direction (down for `low`, up for `high`), walking down to the
 * nearest rung that is both available (§ probe) and backend-compatible
 * (rule T) — never up, because a degradation must never silently escalate
 * spend. An agent not named in `roles` is never touched: its own `model:`
 * stands. `effectiveAgent` is the one place that turns a resolution into an
 * actual `AgentConfig` — overriding `model` and NOTHING else.
 */

import type { AgentConfig, SFConfig, Tier } from "./data_types.ts";
import { ollamaBaseUrl } from "./ollama_provider.ts";

// ── the classifier (design doc §2) ──────────────────────────────────────────

/**
 * One explicit `name -> weight` table entry per BUILT-IN chain
 * (`src/chains/index.ts`'s `CHAINS`), including every chain that weighs
 * `0` — an entry, not a fallthrough. A name absent from this table (any
 * repo-local `.spf/chains/*.yaml` chain, or a built-in nobody has wired in
 * yet) falls to `0` through `chainWeight`'s own default — a DIFFERENT code
 * path from being explicitly listed as `0`, which is what lets a test
 * assert "every built-in chain has a real entry here" rather than merely
 * "this returned 0", so a new built-in nobody wired in cannot land in the
 * `0` bucket unnoticed.
 */
export const CHAIN_WEIGHTS: Record<string, -1 | 0 | 1> = {
  scout: -1,
  prompt: -1,
  document: -1,
  quality: -1,
  "simple-sdlc": 1,
  "plan-build-test-quality": 1,
  refine: 1,
  plan: 0,
  build: 0,
  "plan-build": 0,
  "build-test": 0,
  "plan-build-test": 0,
  "build-review": 0,
};

/** `name in CHAIN_WEIGHTS` distinguishes "explicitly 0" from "fell through" — see `CHAIN_WEIGHTS`'s own comment. */
export function chainWeight(name: string): number {
  return name in CHAIN_WEIGHTS ? CHAIN_WEIGHTS[name]! : 0;
}

/** Whitespace-delimited word count, deliberately not tokens — no tokenizer exists for an arbitrary ollama/<tag>, and a word count is free, stable, and reproducible from the trace. */
export function promptWords(prompt: string): number {
  return prompt.split(/\s+/).filter(Boolean).length;
}

/** `-1` for a terse ask, `+1` for a long one, `0` otherwise. */
export function promptWeight(words: number): number {
  if (words <= 60) return -1;
  if (words >= 400) return 1;
  return 0;
}

export type Risk = "low" | "standard" | "high";

export interface TierSignals {
  chain: string;
  chain_weight: number;
  prompt_words: number;
  prompt_weight: number;
  sum: number;
}

/**
 * The classifier. Asymmetric on purpose: demotion (`low`) requires TWO
 * agreeing signals (`sum <= -2` — both `chain_weight` and `prompt_weight`
 * at `-1`); promotion (`high`) requires only ONE. Concretely that means a
 * long prompt (`prompt_weight === 1`, ≥400 words) forces `high`
 * UNCONDITIONALLY, even riding on top of a `-1` chain (`spf scout "<≥400
 * words>"` → `high`, not the `sum === 0` "standard" a naive `sum >= 1`
 * threshold would give) — the design doc's own §2 3×3 table and its §3.1
 * reachability table both pin this cell as `high`, so the table (not the
 * simpler-looking `sum` arithmetic sketched alongside it) is what
 * `src/test/tiering.test.ts`'s full-grid test treats as the specification.
 * An unnecessarily weak model produces a wrong answer that costs a whole
 * re-run — the expensive failure; an unnecessarily strong one just costs
 * some tokens — the cheap failure. Skewed toward the cheap one.
 */
export function classifyRisk(chainName: string, prompt: string): { risk: Risk; signals: TierSignals } {
  const chain_weight = chainWeight(chainName);
  const prompt_words = promptWords(prompt);
  const prompt_weight = promptWeight(prompt_words);
  const sum = chain_weight + prompt_weight;
  const risk: Risk = prompt_weight === 1 || sum >= 1 ? "high" : sum <= -2 ? "low" : "standard";
  return { risk, signals: { chain: chainName, chain_weight, prompt_words, prompt_weight, sum } };
}

// ── resolution (design doc §4) ───────────────────────────────────────────────

/** PURE input — no `Run`, no `ChainContext`. `required` scopes everything: an agent no phase in this run will dispatch is neither routed nor reported. */
export interface TierInput {
  cfg: SFConfig;
  chainName: string;
  prompt: string;
  /** `null` == "not probed / probe failed" == fail open, drop nothing. */
  servedOllamaTags: Set<string> | null;
  required: string[];
}

export interface TierRoute {
  /** the tier NAME finally selected, after the shift and any walk-down */
  tier: string;
  /** agent.model as CONFIGURED (post-back-fill) */
  configured: string;
  /** the model that will actually dispatch */
  effective: string;
}

export interface TierResolution {
  risk: Risk;
  signals: TierSignals;
  /**
   * FULL routing: one entry for every agent in `required` that tiering
   * routes — including entries where `effective === configured`. NOT a
   * diff; `changedModels()` below is the derived diff view. An agent not in
   * `required`, or not named in `roles`, has no entry.
   */
  routing: Record<string, TierRoute>;
  /** One line per degradation or non-routable role. Empty when tiering is disabled or has nothing to say. */
  notes: string[];
}

const RISK_STEP: Record<Risk, number> = { low: -1, standard: 0, high: 1 };

function stripOllamaPrefix(model: string): string {
  return model.startsWith("ollama/") ? model.slice("ollama/".length) : model;
}

/** Usable == not dropped by the availability probe, AND backend-compatible (rule T). */
function usable(tier: Tier, agent: AgentConfig, servedOllamaTags: Set<string> | null): boolean {
  if (tier.coding_agent !== agent.coding_agent) return false; // rule T
  if (servedOllamaTags !== null && tier.model.startsWith("ollama/")) {
    // The comparison strips the "ollama/" prefix before lookup — getting
    // this backwards fails CLOSED in the wrong direction: every ollama/*
    // rung would look unserved and every ladder would walk to the bottom.
    return servedOllamaTags.has(stripOllamaPrefix(tier.model));
  }
  return true;
}

/**
 * The ladder walk (design doc §4.3). Never throws and never reports a
 * severity — a backend mismatch (rule T) or an unknown tier name is a
 * `notes` line plus a role left unrouted; `agents.validate()` owns
 * severity, this owns detection.
 */
export function resolveTiering(input: TierInput): TierResolution {
  const { cfg, chainName, prompt, servedOllamaTags, required } = input;
  const { risk, signals } = classifyRisk(chainName, prompt);
  const routing: Record<string, TierRoute> = {};
  const notes: string[] = [];

  if (!cfg.tiering.enabled) return { risk, signals, routing, notes };

  const step = RISK_STEP[risk];
  for (const agentName of required) {
    const baseline = cfg.tiering.roles[agentName];
    if (baseline === undefined) continue; // precedence: not named in roles -> untouched

    const agent = cfg.agents.find((a) => a.name === agentName);
    if (!agent) {
      notes.push(`tiering.roles.${agentName} names an agent not defined in this roster — left unrouted, no change`);
      continue;
    }

    const i = cfg.tiering.tiers.findIndex((t) => t.name === baseline);
    if (i === -1) {
      notes.push(`tiering.roles.${agentName} names tier ${JSON.stringify(baseline)}, which is not declared in tiering.tiers — left unrouted`);
      continue;
    }

    const target = Math.min(Math.max(i + step, 0), cfg.tiering.tiers.length - 1);
    let j = target;
    while (j >= 0 && !usable(cfg.tiering.tiers[j]!, agent, servedOllamaTags)) j--;
    if (j < 0) {
      notes.push(
        `${agentName}: no rung at or below ${cfg.tiering.tiers[target]!.name} is usable for this run (unserved tag or backend mismatch) — ` +
          `left unrouted, dispatching on ${agent.model}`,
      );
      continue;
    }

    const tier = cfg.tiering.tiers[j]!;
    routing[agentName] = { tier: tier.name, configured: agent.model, effective: tier.model };
  }

  return { risk, signals, routing, notes };
}

/**
 * The diff view, derived — `{agent: effective}` for entries where
 * `configured !== effective`. Empty means tiering changed nothing this run.
 * Deriving it (rather than storing it) is what keeps this view and the
 * full `routing` map from disagreeing: one source, one filter.
 */
export function changedModels(res: TierResolution): Record<string, string> {
  const changed: Record<string, string> = {};
  for (const [agentName, route] of Object.entries(res.routing)) {
    if (route.configured !== route.effective) changed[agentName] = route.effective;
  }
  return changed;
}

/**
 * The single dispatch-site change (design doc §4.6): `model` and ONLY
 * `model`. `run` is a minimal structural shape — deliberately not
 * `agents.ts`'s `RunForAgents`, which would import this module and create a
 * cycle — so any run-shaped object with an (optional) `tiering` field
 * satisfies it.
 */
export function effectiveAgent(run: { tiering?: TierResolution | null }, base: AgentConfig): AgentConfig {
  const effective = run.tiering?.routing[base.name]?.effective;
  return effective === undefined ? base : { ...base, model: effective };
}

// ── availability probe (design doc §4.4B) ───────────────────────────────────

const PROBE_TIMEOUT_MS = 3_000; // same budget spf doctor's own probeGet uses

let cachedProbe: Promise<Set<string> | null> | undefined;

async function fetchServedOllamaTags(): Promise<Set<string> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // ollamaBaseUrl() is the SAME default-substitution a real dispatch
    // uses, including treating a set-but-EMPTY OLLAMA_BASE_URL as unset —
    // never re-derive that default here.
    const url = ollamaBaseUrl().replace(/\/+$/, "") + "/models";
    const res = await fetch(url, { signal: controller.signal });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { data?: unknown } | null;
    if (!body || !Array.isArray(body.data)) return null;
    const tags = new Set<string>();
    for (const entry of body.data) {
      if (entry && typeof entry === "object" && "id" in (entry as Record<string, unknown>)) {
        tags.add(String((entry as { id: unknown }).id));
      }
    }
    return tags; // bare tags — no "ollama/" prefix in the response
  } catch {
    return null; // timeout | connection refused | unparseable body all fail OPEN
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `Promise<Set<string> | null>` of bare (unprefixed) served Ollama tags, or
 * `null` on any failure — non-200, timeout, connection refused, an
 * unparseable/`data`-less body. `null` means "fail open, drop nothing",
 * never "everything is unserved": an unreachable probe silently degrading
 * every agent to the bottom rung is a worse outcome than the honest
 * "Unknown model ID" error Ollama itself raises at first dispatch.
 *
 * Only actually probes when tiering is enabled AND at least one declared
 * tier's model starts with `ollama/` — never on a run whose tiers are all
 * hosted, and never when tiering is off. Memoized once per process.
 *
 * A NEW helper, not a reuse of `spf doctor`'s `probeGet`: that helper
 * discards the response body, which is the only part that matters here.
 */
export async function probeServedOllamaTags(cfg: SFConfig): Promise<Set<string> | null> {
  if (!cfg.tiering.enabled || !cfg.tiering.tiers.some((t) => t.model.startsWith("ollama/"))) return null;
  if (cachedProbe === undefined) cachedProbe = fetchServedOllamaTags();
  return cachedProbe;
}

/** Test-only: `probeServedOllamaTags` memoizes once per process, so a test that stubs `fetch` differently across cases must reset the cache between them. */
export function resetProbeCacheForTest(): void {
  cachedProbe = undefined;
}
