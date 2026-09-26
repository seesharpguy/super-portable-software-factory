/**
 * The registry of Jev decision KINDS — one entry per feature that asks Jev
 * something. Pure data + valibot types, no other imports, so every feature
 * module, `core/jev.ts`, and `spf doctor` can import it without a cycle.
 *
 * WHY A REGISTRY AT ALL: a `jev.decisions.<kind>` entry in spf.config.yaml
 * is operator-typed text. Without a list of real kinds, a typo
 * (`risk_teir:`) is a silent no-op — the feature it meant to tune runs on
 * the global policy and nobody notices. `spf doctor` warns on any
 * configured kind not registered here, and validates each known kind's
 * feature-specific settings (`extras`) against the schema declared here.
 *
 * HOW A FEATURE ADDS ITS KIND (this file + its own module; nothing else in
 * core changes):
 *
 *   1. Declare the spec below with `defineJevKind` and add it to
 *      `REGISTERED`:
 *
 *        export const RISK_TIER_KIND = defineJevKind({
 *          kind: "risk_tier",
 *          summary: "classify a run's risk (low|standard|high) for tiering",
 *          question: "choice",
 *          options: ["low", "standard", "high"],
 *          extras: v.object({ include_diffstat: v.optional(v.boolean(), false) }),
 *        });
 *        const REGISTERED = [
 *          RISK_TIER_KIND,
 *        ];
 *
 *      Parallel feature branches all touch this file, so it is laid out to
 *      keep merges mechanical: `valibot` is already a VALUE import (use
 *      `v.object(...)` freely — do not touch the import line), spec blocks
 *      go in the "kind specs" section ALPHABETICALLY by `kind`, and
 *      `REGISTERED` holds ONE entry per line, alphabetical, trailing comma.
 *      A textual conflict here is expected; resolve it by keeping both
 *      sides in alphabetical order.
 *
 *   2. In the feature, pass `RISK_TIER_KIND.kind` as `DecisionRequest.kind`,
 *      and read its own settings with
 *      `parseDecisionExtras(cfg.jev, RISK_TIER_KIND)` (core/jev.ts). The
 *      operator writes them beside the common knobs:
 *
 *        jev:
 *          decisions:
 *            risk_tier: { mode: act, threshold: 0.8, include_diffstat: true }
 *
 *   3. Append a subsection for the kind under "Decisions" in docs/jev.md
 *      (alphabetical by kind) and one bullet under the CHANGELOG's
 *      "Added — Jev decision kinds" heading (alphabetical by kind).
 *
 * `options` is documentation + doctor display for a kind whose option set
 * is static. A kind whose options are built at run time from operator
 * config (e.g. a chain menu from `watch.chains`) omits it — the closed set
 * is still built by CODE at the call site, never by Jev.
 *
 * `extras` must be a valibot schema over a plain object whose keys do NOT
 * collide with the common override keys (`mode`, `threshold`,
 * `timeout_ms`) — those are stripped before `extras` ever sees the entry.
 * Every field in it should be `v.optional(...)` with a default: an operator
 * who never writes `jev.decisions.<kind>` must still get a valid parse.
 */
import * as v from "valibot";

export interface JevDecisionKindSpec<Extras = unknown> {
  /** The exact string passed as `DecisionRequest.kind` and written into every `jev_decision` trace event. snake_case. */
  kind: string;
  /** One line, shown by `spf doctor` beside the kind's resolved policy. */
  summary: string;
  question: "choice" | "score";
  /** The static closed option set, when there is one — see the header. */
  options?: readonly string[];
  /** The feature's own settings under `jev.decisions.<kind>` — see the header. */
  extras?: v.GenericSchema<unknown, Extras>;
}

/** Identity + freeze — exists so a spec's `Extras` type is inferred from its schema at the declaration site. */
export function defineJevKind<Extras = unknown>(spec: JevDecisionKindSpec<Extras>): Readonly<JevDecisionKindSpec<Extras>> {
  if (!/^[a-z][a-z0-9_]*$/.test(spec.kind)) throw new Error(`jev kind ${JSON.stringify(spec.kind)} must be snake_case`);
  return Object.freeze({ ...spec });
}

// ── kind specs — one `defineJevKind` block per kind, ALPHABETICAL by kind ──

/**
 * `finding_triage` (#106): before an unmet `ReviewOutput` finding is handed
 * to the fixing agent (`reviseLoop`'s review -> revise handoff), classify it
 * as a genuine defect (`real`) or something the fixer should not spend its
 * round on (`noise`, `style`). The classes are exported so the call site
 * (`chains/finding_triage.ts`) builds its option set from this SAME tuple —
 * the doctor-displayed `options` and the wire options cannot drift.
 * Acting on it only reorders/filters what the fixer is ASKED to fix; it
 * never touches the review's verdict (see docs/jev.md).
 */
export const FINDING_TRIAGE_CLASSES = ["real", "noise", "style"] as const;
export const FINDING_TRIAGE_DROP = ["none", "noise", "noise_and_style"] as const;
export const FINDING_TRIAGE_KIND = defineJevKind({
  kind: "finding_triage",
  summary: "classify each unmet review finding (real|noise|style) before the revise agent sees it",
  question: "choice",
  options: FINDING_TRIAGE_CLASSES,
  extras: v.object({
    /** Which demoted findings are withheld from the fixer entirely (still traced). `none` = every finding still reaches it. */
    drop: v.optional(v.picklist(FINDING_TRIAGE_DROP), "none"),
  }),
});

/**
 * `loop_control` (ticket #105): after a FAILED round of `fixLoop`/
 * `reviseLoop` (`chains/steps.ts`), and only when another repair round would
 * otherwise run, what should the loop do next? The fallback is `continue`
 * — exactly today's behavior. The configured `max` stays a HARD ceiling:
 * no option adds a round. `escalate_tier` moves the repairing role up at
 * most ONE rung of `tiering.tiers` per loop and never above `max_tier`
 * (unset => escalation is never permitted, so it degrades to `continue`).
 * Call site and the escalation rules: `chains/loop_control.ts`.
 *
 * `LOOP_CONTROL_CHOICES` is the ONE constant both this spec's (display-only)
 * `options` and the call site's option list are built from.
 */
export const LOOP_CONTROL_CHOICES = ["continue", "escalate_tier", "stop_blocked"] as const;
export const LOOP_CONTROL_KIND = defineJevKind({
  kind: "loop_control",
  summary: "after a failed fix/revise round: continue, escalate the repairing role one tier (<= max_tier), or stop blocked",
  question: "choice",
  options: LOOP_CONTROL_CHOICES,
  extras: v.object({
    /** The highest `tiering.tiers` rung `escalate_tier` may reach. Unset (the default) disables escalation. */
    max_tier: v.optional(v.pipe(v.string(), v.minLength(1))),
  }),
});

/**
 * `risk_tier` (#104) — the run's tiering risk (`core/tiering.ts`'s `Risk`),
 * decided once in `startRun` (`core/risk_tier.ts`) over this closed set, in
 * `tiering.ts`'s own ladder order (weakest first). Fallback: the
 * `classifyRisk` heuristic (chain weight + prompt word count).
 *
 * `extras`:
 *  - `max_risk` — the highest risk Jev's answer may ACT on (the
 *    `permitted` ceiling). The heuristic's own answer is always permitted,
 *    so this caps Jev-driven escalation only, never the heuristic's.
 *  - `max_prompt_chars` — how much of the prompt goes into Jev's `state`
 *    (the head of it; the rest is dropped and flagged). `0` sends none.
 */
/**
 * The risk VALUES (strings) — not to be confused with `core/risk_tier.ts`'s
 * `RISK_TIER_OPTIONS` (the `JevOption[]` built from these). `risk_tier.ts`
 * asserts at compile time that this tuple and `tiering.ts`'s `Risk` name
 * exactly the same set, in both directions.
 */
export const RISK_TIER_VALUES = ["low", "standard", "high"] as const;
export const RISK_TIER_KIND = defineJevKind({
  kind: "risk_tier",
  summary: "classify a run's risk (low|standard|high) for tiering; fallback = chain-weight + prompt-length heuristic",
  question: "choice",
  options: RISK_TIER_VALUES,
  extras: v.object({
    max_risk: v.optional(v.picklist(RISK_TIER_VALUES), "high"),
    max_prompt_chars: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(200_000)), 4_000),
  }),
});

/**
 * EMPTY in the core commit on purpose. Each feature PR inserts exactly ONE
 * line — its spec constant plus a trailing comma — keeping the list
 * alphabetical by kind.
 */
const REGISTERED: readonly JevDecisionKindSpec<any>[] = [
  // keep alphabetical by kind, one per line: MY_KIND,
  FINDING_TRIAGE_KIND,
  LOOP_CONTROL_KIND,
  RISK_TIER_KIND,
];

/** Index specs by kind; a kind registered twice throws (at module load, for `REGISTERED`). Exported for its test. */
export function indexKinds(specs: readonly JevDecisionKindSpec<any>[]): Readonly<Record<string, JevDecisionKindSpec<unknown>>> {
  const out: Record<string, JevDecisionKindSpec<unknown>> = {};
  for (const spec of specs) {
    if (spec.kind in out) throw new Error(`jev kind ${JSON.stringify(spec.kind)} is registered twice`);
    out[spec.kind] = spec;
  }
  return Object.freeze(out);
}

/** Every registered kind, by name — what `spf doctor` checks `jev.decisions` keys against. */
export const JEV_DECISION_KINDS: Readonly<Record<string, JevDecisionKindSpec<unknown>>> = indexKinds(REGISTERED);
