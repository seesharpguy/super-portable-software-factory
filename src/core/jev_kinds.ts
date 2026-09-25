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
//
// (none yet: the rails ship before any feature depends on them)

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
export const RISK_TIER_OPTIONS = ["low", "standard", "high"] as const;
export const RISK_TIER_KIND = defineJevKind({
  kind: "risk_tier",
  summary: "classify a run's risk (low|standard|high) for tiering; fallback = chain-weight + prompt-length heuristic",
  question: "choice",
  options: RISK_TIER_OPTIONS,
  extras: v.object({
    max_risk: v.optional(v.picklist(RISK_TIER_OPTIONS), "high"),
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
