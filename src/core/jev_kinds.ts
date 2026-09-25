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
 *        const REGISTERED = [RISK_TIER_KIND];
 *
 *      (`import * as v from "valibot"` — value import — once a kind with
 *      `extras` lands; the core commit only needs the types.)
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
 *   3. Append a subsection for the kind under "Decisions" in docs/jev.md.
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
import type * as v from "valibot";

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

/**
 * EMPTY in the core commit on purpose — the rails ship before any feature
 * depends on them. Each feature PR appends exactly its own spec.
 */
const REGISTERED: readonly JevDecisionKindSpec<any>[] = [];

function indexKinds(specs: readonly JevDecisionKindSpec<any>[]): Readonly<Record<string, JevDecisionKindSpec<unknown>>> {
  const out: Record<string, JevDecisionKindSpec<unknown>> = {};
  for (const spec of specs) {
    if (spec.kind in out) throw new Error(`jev kind ${JSON.stringify(spec.kind)} is registered twice`);
    out[spec.kind] = spec;
  }
  return Object.freeze(out);
}

/** Every registered kind, by name — what `spf doctor` checks `jev.decisions` keys against. */
export const JEV_DECISION_KINDS: Readonly<Record<string, JevDecisionKindSpec<unknown>>> = indexKinds(REGISTERED);
