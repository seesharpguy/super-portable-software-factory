/**
 * Jev-backed run risk classification for tiering — the `risk_tier` decision
 * kind (#104, epic #102).
 *
 * `core/tiering.ts`'s `classifyRisk` answers "how risky is this run?" from
 * two cheap signals: the chain's weight and the prompt's word count. It
 * cannot read the prompt — "rename a variable" and "rotate every auth
 * secret" are both short. This module asks Jev the same question over the
 * SAME closed set (`low | standard | high`), with the heuristic as the
 * fallback, and hands the resulting `Decision` to `resolveTiering` as data.
 *
 * WHERE IT IS DECIDED: exactly once per `startRun` call (`chains/steps.ts`,
 * via `decideRunRiskTier`), before any phase opens, run-scoped
 * (`phase_id: ""`), `key` = the chain name. A run that re-enters `startRun`
 * under the SAME `adw_id` + chain (the watch lane's continue-refinement
 * resume, the build lane's `spf:feedback` loop) REPLAYS its own first
 * recording instead of asking Jev again (invariant 5), so both halves of one
 * run route from the same answer. `resolveTiering` itself never calls Jev
 * (it stays pure — invariant 7); `spf estimate` never calls Jev either: it
 * reports the heuristic, or — with `--replay-risk <adw_id>` — replays that
 * run's recorded decision under today's policy, with no call and no row
 * written.
 *
 * WHEN IT IS DECIDED AT ALL (`riskTierLive`): `jev.enabled`, the kind's mode
 * is not `off`, AND `tiering.enabled`. Risk changes nothing but tiering's
 * routing; with tiering off, a Jev call would spend a network round trip
 * (up to `timeout_ms` of run start-up) on an answer nothing reads. Any of
 * the three false -> no call, no trace row, no extras parse, and a
 * `TierResolution` byte-identical to the pre-Jev one (invariant 1).
 *
 * WHAT ACTING ON IT CAN AND CANNOT DO: the effective choice only picks
 * which rung of the operator's own `tiering.tiers` ladder each routed role
 * starts from — the same shift the heuristic already makes. It cannot name
 * a model, add a rung, route a role not in `tiering.roles`, or walk UP past
 * an unusable rung (`resolveTiering`'s walk only goes down). Budget
 * ceilings (`max_run_tokens`/`max_run_cost`) are enforced exactly as before.
 * Escalation is further capped by `jev.decisions.risk_tier.max_risk`
 * (invariant 6): Jev's answer may only ACT at or below it; the heuristic's
 * own answer is always permitted, so the cap never lowers what the run
 * would have got without Jev.
 */
import type { SFConfig } from "./data_types.ts";
import { findRecordedDecision, parseDecisionExtras, resolveDecisionPolicy, type Decision, type Jev, type JevOption } from "./jev.ts";
import { RISK_TIER_KIND, RISK_TIER_VALUES } from "./jev_kinds.ts";
import { classifyRisk, type Risk } from "./tiering.ts";
import type { TraceDb } from "./trace_db.ts";

/**
 * Compile-time drift guard between the kind's declared values
 * (`jev_kinds.ts`'s `RISK_TIER_VALUES`, what doctor shows and what
 * `max_risk` accepts) and `tiering.ts`'s `Risk` (what `RISK_STEP` indexes).
 * Checked in BOTH directions: a value added to either side alone makes one
 * of the conditional types below `false`, and `true` no longer assigns to
 * it. (A one-way `as readonly Risk[]` cast would still compile when the
 * tuple grew, and ship Jev an option with an `undefined` description.)
 */
type KindRisk = (typeof RISK_TIER_VALUES)[number];
export const RISK_SETS_MATCH: [KindRisk] extends [Risk] ? ([Risk] extends [KindRisk] ? true : false) : false = true;

/** What each risk means to Jev. Keyed by `Risk` — and `Risk` is pinned to `RISK_TIER_VALUES` above — so a new risk fails to compile here until it is described. */
const RISK_DESCRIPTIONS: Record<Risk, string> = {
  low:
    "Trivial, mechanical, or read-only work — a typo, a rename, a docs-only edit, a question about the code, a small scouting pass — " +
    "where a weaker, cheaper model is very unlikely to get it wrong.",
  standard: "Ordinary feature or bug-fix work of modest scope, touching a handful of files, where tests are likely to catch a mistake.",
  high:
    "Broad, subtle, or hard-to-reverse work — cross-cutting refactors, security/auth/permissions, data migrations, concurrency, " +
    "public API or schema changes, or a long/ambiguous spec — where a weak model's wrong answer costs a whole re-run.",
};

/**
 * The closed option set, built from the SAME constant `RISK_TIER_KIND`
 * declares for doctor (`RISK_TIER_VALUES`, R4), in ladder order (weakest
 * first). Code-built, never operator- or Jev-supplied (invariant 2). No
 * cast: `RISK_SETS_MATCH` makes `KindRisk` and `Risk` the same set.
 */
export const RISK_TIER_OPTIONS: readonly JevOption<Risk>[] = RISK_TIER_VALUES.map((value) => ({
  value,
  description: RISK_DESCRIPTIONS[value],
}));

const RISK_TIER_INSTRUCTIONS =
  "Classify the risk of the coding-agent run described in `state`: `chain` is the workflow it runs, `prompt` is the operator's task " +
  "(possibly truncated — see `prompt_truncated`), and `signals` are the chain-weight and prompt-length signals spf's own heuristic " +
  "uses. The risk decides how strong a model each role is dispatched on. An unnecessarily weak model produces a wrong answer that " +
  "costs a whole re-run; an unnecessarily strong one only costs some tokens — when unsure between two tiers, choose the higher one.";

/** `jev.decisions.risk_tier`'s own settings — see `RISK_TIER_KIND` in `core/jev_kinds.ts`. */
export interface RiskTierExtras {
  max_risk: Risk;
  max_prompt_chars: number;
}

/**
 * True when a `risk_tier` decision would actually be made for a run of
 * this config + `Jev` — see the module header's "WHEN". `spf estimate` uses it
 * to decide whether to say where its risk came from.
 */
export function riskTierLive(cfg: Pick<SFConfig, "tiering">, jev: Pick<Jev, "enabled" | "policy">): boolean {
  return cfg.tiering.enabled && jev.enabled && jev.policy(RISK_TIER_KIND.kind).mode !== "off";
}

/**
 * Fail fast on invalid `jev.decisions.risk_tier` extras — but only when the
 * kind is live for this config (a disabled Jev is a total no-op, bad extras
 * included). `startRun` calls this BEFORE `session.ensure`, beside
 * `agents.validate`, so a config error never leaves a half-opened session
 * row behind; `decideRiskTier` parses the same extras again (cheap) for
 * callers that skip this.
 *
 * DELIBERATELY gated on `tiering.enabled` too, exactly like `riskTierLive`:
 * with tiering off the extras are never read, so a bad `max_risk` does not
 * fail a run (invariant 1 — a feature that is off is a no-op). `spf doctor`
 * validates extras unconditionally, so it is the place a latent typo shows
 * up before the day tiering is turned on. Pinned by a test.
 */
export function checkRiskTierConfig(cfg: Pick<SFConfig, "tiering" | "jev">): void {
  if (cfg.tiering.enabled && resolveDecisionPolicy(cfg.jev, RISK_TIER_KIND.kind).mode !== "off") {
    parseDecisionExtras(cfg.jev, RISK_TIER_KIND);
  }
}

/**
 * The permitted subset: every risk at or below `max_risk`, plus the
 * heuristic's own answer (which must always be permitted — it is the
 * fallback). In ladder order.
 */
export function permittedRisks(maxRisk: Risk, fallback: Risk): Risk[] {
  const values = RISK_TIER_OPTIONS.map((o) => o.value);
  const ceiling = values.indexOf(maxRisk);
  return values.filter((value, i) => i <= ceiling || value === fallback);
}

/** Jev's `state`: the chain, the head of the prompt, and the heuristic's signals. PURE. */
export function riskTierState(chainName: string, prompt: string, maxPromptChars: number): Record<string, unknown> {
  const { signals } = classifyRisk(chainName, prompt);
  return {
    chain: chainName,
    prompt: prompt.slice(0, maxPromptChars),
    prompt_truncated: prompt.length > maxPromptChars,
    signals: { chain_weight: signals.chain_weight, prompt_words: signals.prompt_words, prompt_weight: signals.prompt_weight },
  };
}

/**
 * Decide the run's risk. Returns `null` — and makes no call, writes no
 * row, parses no extras — unless `riskTierLive`. Otherwise one `jev.decide`
 * whose `fallback` is `classifyRisk`'s answer (computed on every call, act
 * mode included — R2). `decide()` never throws for a runtime failure
 * (timeout, HTTP error, bad answer: the heuristic acts and the reason is
 * recorded); it throws only for invalid `jev.decisions.risk_tier` extras,
 * which is an operator config error surfaced at run start.
 *
 * `replay`: `undefined` = live (startRun). A recorded `Decision` or `null`
 * = replay only, never a call (`spf estimate --replay-risk`).
 */
export async function decideRiskTier(
  jev: Jev,
  cfg: Pick<SFConfig, "tiering">,
  input: { chainName: string; prompt: string; replay?: Decision | null },
): Promise<Decision<Risk> | null> {
  if (!riskTierLive(cfg, jev)) return null;
  const extras = parseDecisionExtras(jev.config, RISK_TIER_KIND) as RiskTierExtras;
  const fallback = classifyRisk(input.chainName, input.prompt).risk;
  return jev.decide<Risk>({
    kind: RISK_TIER_KIND.kind,
    // The chain name: stable across runs (R1), and it tells a joined
    // session's second startRun (a different chain, same adw_id) apart.
    key: input.chainName,
    options: RISK_TIER_OPTIONS,
    instructions: RISK_TIER_INSTRUCTIONS,
    state: riskTierState(input.chainName, input.prompt, extras.max_prompt_chars),
    fallback,
    permitted: permittedRisks(extras.max_risk, fallback),
    ...(input.replay !== undefined ? { replay: input.replay } : {}),
    phase_id: "",
  });
}

/**
 * `startRun`'s entry point: `decideRiskTier` for a run, replaying the run's
 * OWN earlier `risk_tier` decision for this chain when one is recorded.
 *
 * `session.ensure` supports re-entry under the same `adw_id` (the watch
 * lane's continue-refinement resume, the build lane's `spf:feedback` loop,
 * a joined session that keeps its chain). Without this, each re-entry would
 * ask Jev again, could get a different answer, and would route the second
 * half of one run on a different tier than the first. With it, the first
 * answer is reused, re-judged under today's policy and `permitted` (a
 * `max_risk` lowered in between still wins — invariant 6).
 *
 * Only a recording that asked the SAME question is replayed: same options
 * (in order) and same fallback — the same match `decide()`'s replay makes.
 * A resumed prompt that lands in a different word-count bucket (the watch
 * resume folds the whole comment thread in) is a genuinely new question,
 * so it goes LIVE and records a new row, which later resumes then replay.
 * (Handing `decide()` a non-matching recording would instead give
 * `replay_missing` with no call, pinning that resume to the heuristic.)
 *
 * Nothing recorded (`null`) likewise goes live, so a run's FIRST
 * `startRun` asks Jev as before. A failed lookup
 * (a D1 hiccup) likewise goes live rather than failing the run — the
 * lookup is a consistency nicety, never a gate. No lookup at all unless
 * the kind is live (invariant 1: a jev-less config never touches the db
 * for this).
 */
export async function decideRunRiskTier(
  jev: Jev,
  cfg: Pick<SFConfig, "tiering">,
  input: { db: TraceDb; adwId: string; chainName: string; prompt: string },
): Promise<Decision<Risk> | null> {
  if (!riskTierLive(cfg, jev)) return null;
  let recorded: Decision | null = null;
  try {
    recorded = await findRecordedDecision(input.db, input.adwId, RISK_TIER_KIND.kind, input.chainName);
  } catch {
    recorded = null;
  }
  const fallback = classifyRisk(input.chainName, input.prompt).risk;
  const sameQuestion =
    recorded !== null &&
    recorded.question === "choice" &&
    recorded.fallback === fallback &&
    recorded.options.length === RISK_TIER_VALUES.length &&
    recorded.options.every((o, i) => o === RISK_TIER_VALUES[i]);
  return decideRiskTier(jev, cfg, {
    chainName: input.chainName,
    prompt: input.prompt,
    ...(sameQuestion ? { replay: recorded } : {}),
  });
}
