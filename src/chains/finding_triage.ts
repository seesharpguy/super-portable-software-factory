/**
 * Jev `finding_triage` (#106): shape what the fixing agent is ASKED to fix
 * in a review -> revise handoff — never what the reviewer DECIDED.
 *
 * `reviseLoop` (and `simple_sdlc`'s own review loop) hands the reviewer's
 * `ReviewOutput` envelope, verbatim, to the builder as `previous`. Every
 * unmet finding in it reads as equally urgent, so a round is routinely spent
 * on a naming nit or a false positive while the one real gap survives to the
 * next review. This module asks Jev, per UNMET finding, one closed question:
 * `real | noise | style` (the set is `FINDING_TRIAGE_CLASSES` in
 * `core/jev_kinds.ts`). The deterministic fallback is `real` for every
 * finding — i.e. today's behavior, where the fixer is asked to close all of
 * them.
 *
 * WHAT ACTING ON A DEMOTION DOES (act mode, confident answer):
 *   - the finding leaves the handoff's `findings`, and any `blocking` entry
 *     whose text is the SAME requirement (whitespace/case-normalized) leaves
 *     `blocking` with it. A `blocking` entry worded differently stays — this
 *     module never guesses which free-text blocker a finding "means";
 *   - by default (`drop: none`) it is re-listed under a "## Deprioritized by
 *     jev" section appended to `notes_for_next_agent`, so the fixer still
 *     sees it, ranked after everything real;
 *   - with `jev.decisions.finding_triage.drop: noise` (or
 *     `noise_and_style`) the matching demotions are withheld from the fixer
 *     entirely. Withheld is not silent: every finding's classification is a
 *     `jev_decision` row, and the triage outcome (kept / deprioritized /
 *     dropped) is one `jev_triage` log row on the revise phase.
 *
 * WHAT IT CAN NEVER DO — the reason this is safe to put in front of a gate:
 *   - it never touches `approved`, and the loop's verdict, `state.review`,
 *     and `state.accepted` are all computed from the ORIGINAL review. The
 *     next review round re-rules on every requirement, demoted or not; a
 *     triage can shrink a fixer's to-do list, never turn a rejection into an
 *     approval (invariant 6);
 *   - it never empties the ask: if EVERY unmet finding came back demoted,
 *     dropping is suspended for that round and they are all passed as
 *     deprioritized — a rejected review always hands the fixer something;
 *   - `met: true` findings are never triaged and always pass through.
 *
 * Off (the default) is a total no-op: `resolveFindingTriage` returns `null`,
 * no state is built, and the handoff is the reviewer's envelope object
 * itself. Shadow mode calls Jev and records every decision, but each
 * decision's effective `choice` is the fallback (`real`), so the handoff is
 * again the untouched envelope.
 *
 * `fixLoop`'s suite output is deliberately NOT triaged: a `QualityResult`'s
 * failures are one verbatim blob per CHECK (whatever the linter/test runner
 * printed), not a list of findings, and splitting arbitrary tool output
 * per finding would mean parsing formats spf does not own. Use a reviewer
 * agent + `reviseLoop` when you want triage.
 */
import { createHash } from "node:crypto";
import { makeEventRecord, type ReviewFinding, type ReviewOutputT } from "../core/data_types.ts";
import { parseDecisionExtras, type Decision, type DecisionBatchItem, type Jev, type JevOption } from "../core/jev.ts";
import { FINDING_TRIAGE_CLASSES, FINDING_TRIAGE_KIND, type FINDING_TRIAGE_DROP } from "../core/jev_kinds.ts";
import type { Run } from "../core/runner.ts";

export type FindingTriageClass = (typeof FINDING_TRIAGE_CLASSES)[number];
export type FindingTriageDrop = (typeof FINDING_TRIAGE_DROP)[number];

/** The `log` event name for one triage outcome — a `log` row, not a new `EventRecordType` (tiering.test.ts pins those). */
export const FINDING_TRIAGE_EVENT = "jev_triage";

/**
 * At most this many distinct unmet findings are asked about per round; any
 * beyond it keep the fallback (`real`) without a question. One batch is one
 * HTTP call whose state + questions share a ~32k-token budget, and a review
 * with more findings than this is not one a classifier should be pruning.
 */
export const MAX_TRIAGED_FINDINGS = 50;

/** The heuristic answer for every finding: today's behavior, where the fixer is asked to close all of them. */
export const FINDING_TRIAGE_FALLBACK: FindingTriageClass = "real";

const DESCRIPTIONS: Record<FindingTriageClass, string> = {
  real: "A genuine unmet requirement or defect in the change: the fixing agent must close it for the request to be done.",
  noise:
    "Not actually a problem with this change: a false positive, already satisfied on disk, outside the scope of the request, or too vague to act on.",
  style: "A cosmetic or stylistic preference (naming, formatting, wording, comment tone) that does not affect whether the request is met.",
};

/** Built from the SAME tuple the kind spec displays (R4) — a class added there without a description here is a type error. */
export const FINDING_TRIAGE_OPTIONS: readonly JevOption<FindingTriageClass>[] = FINDING_TRIAGE_CLASSES.map((value) => ({
  value,
  description: DESCRIPTIONS[value],
}));

export interface FindingTriageSettings {
  drop: FindingTriageDrop;
}

/**
 * This kind's settings, or `null` when it is off (`jev.enabled: false` — the
 * default — or `jev.decisions.finding_triage.mode: off`). Call once, at the
 * top of the step, before any phase opens: an invalid `drop` throws the
 * config-shaped `jev.decisions.finding_triage: ...` error there rather than
 * mid-loop. While off, nothing is parsed at all.
 *
 * `run.jev` is read defensively: a stub `Run` in a unit test may not carry
 * one, and the answer for "no Jev" is the same as for "Jev off".
 */
export function resolveFindingTriage(run: Pick<Run, "jev">): FindingTriageSettings | null {
  const jev = run.jev as Jev | undefined;
  if (!jev || jev.policy(FINDING_TRIAGE_KIND.kind).mode === "off") return null;
  return parseDecisionExtras(jev.config, FINDING_TRIAGE_KIND);
}

function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A finding's stable identity: sha256 of its normalized REQUIREMENT text
 * (not its evidence — a reviewer re-words evidence every round while the
 * ask stays the same). Used in the decision `key`, never an array index (R1).
 */
export function findingFingerprint(finding: Pick<ReviewFinding, "requirement">): string {
  return createHash("sha256").update(normalizeText(finding.requirement)).digest("hex").slice(0, 16);
}

/** The replay key for one finding in one round: `revise_<round>:<fingerprint>`. */
export function findingTriageKey(round: number, finding: Pick<ReviewFinding, "requirement">): string {
  return `revise_${round}:${findingFingerprint(finding)}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;
}

export interface TriagedFinding {
  finding: ReviewFinding;
  key: string;
  triage: FindingTriageClass;
}

export interface FindingTriageOutcome {
  /** What the fixer receives as `previous`. The reviewer's envelope OBJECT itself whenever nothing was demoted. */
  handoff: ReviewOutputT;
  /** Unmet findings still asked for, in review order. */
  kept: TriagedFinding[];
  /** Demoted findings still shown to the fixer, under "## Deprioritized by jev". */
  deprioritized: TriagedFinding[];
  /** Demoted findings withheld from the fixer (recorded in the trace only). */
  dropped: TriagedFinding[];
  /** True when `drop` asked to withhold findings but every unmet finding was demoted, so nothing was withheld this round. */
  drop_suspended: boolean;
}

function shouldDrop(triage: FindingTriageClass, drop: FindingTriageDrop): boolean {
  if (triage === "real") return false;
  return drop === "noise_and_style" || (drop === "noise" && triage === "noise");
}

/**
 * PURE: apply per-fingerprint classes (effective `Decision.choice`s) to a
 * review. A fingerprint with no class is `real`. Exported for its unit test;
 * `triageReviewFindings` is the only production caller.
 */
export function applyFindingTriage(
  review: ReviewOutputT,
  classes: ReadonlyMap<string, FindingTriageClass>,
  drop: FindingTriageDrop,
  round: number,
): FindingTriageOutcome {
  const unmet: TriagedFinding[] = review.findings
    .filter((f) => !f.met)
    .map((finding) => ({ finding, key: findingTriageKey(round, finding), triage: classes.get(findingFingerprint(finding)) ?? "real" }));
  const kept = unmet.filter((t) => t.triage === "real");
  const demoted = unmet.filter((t) => t.triage !== "real");
  if (demoted.length === 0) return { handoff: review, kept, deprioritized: [], dropped: [], drop_suspended: false };

  // Never empty the ask: with no real finding left, withholding the rest
  // would send the fixer an empty to-do list for a review that REJECTED.
  const dropWanted = demoted.some((t) => shouldDrop(t.triage, drop));
  const drop_suspended = kept.length === 0 && dropWanted;
  const dropped = drop_suspended ? [] : demoted.filter((t) => shouldDrop(t.triage, drop));
  const deprioritized = drop_suspended ? demoted : demoted.filter((t) => !shouldDrop(t.triage, drop));

  const demotedFps = new Set(demoted.map((t) => findingFingerprint(t.finding)));
  const demotedRequirements = new Set(demoted.map((t) => normalizeText(t.finding.requirement)));
  const findings = review.findings.filter((f) => f.met || !demotedFps.has(findingFingerprint(f)));
  const blocking = review.blocking.filter((b) => !demotedRequirements.has(normalizeText(b)));

  let notes = review.notes_for_next_agent;
  if (deprioritized.length > 0) {
    const lines = [
      "## Deprioritized by jev",
      "Jev's finding triage classified these unmet findings as noise or style. They are NOT waived: the reviewer rules on every requirement again next round. Close everything in `findings` and `blocking` first; address these only where it is cheap and safe.",
      ...deprioritized.map((t) => `- [${t.triage}] ${t.finding.requirement}${t.finding.evidence ? ` — ${t.finding.evidence}` : ""}`),
    ];
    notes = [notes, lines.join("\n")].filter((part) => part.length > 0).join("\n\n");
  }
  // Spread first, so `approved`/`status`/everything else is the reviewer's own — only the to-do list is reshaped.
  const handoff: ReviewOutputT = { ...review, findings, blocking, notes_for_next_agent: notes };
  return { handoff, kept, deprioritized, dropped, drop_suspended };
}

function currentPhaseId(run: Run): string {
  // Called from inside `run.phase(...)`'s callback, where the open phase is
  // always the last one pushed (phases never nest in a chain).
  const phases = (run as { phases?: { phase_id: string }[] }).phases ?? [];
  return phases.length > 0 ? phases[phases.length - 1]!.phase_id : "";
}

/**
 * Classify a rejected review's unmet findings with ONE Jev batch and reshape
 * the handoff. Call it from INSIDE the revise phase (so decisions carry that
 * phase's id), only when `resolveFindingTriage` returned settings.
 */
export async function triageReviewFindings(
  run: Run,
  review: ReviewOutputT,
  opts: { settings: FindingTriageSettings; round: number; prompt: string },
): Promise<FindingTriageOutcome> {
  const unique = new Map<string, ReviewFinding>();
  for (const finding of review.findings) {
    if (finding.met) continue;
    const fp = findingFingerprint(finding);
    if (!unique.has(fp) && unique.size < MAX_TRIAGED_FINDINGS) unique.set(fp, finding);
  }
  if (unique.size === 0) return applyFindingTriage(review, new Map(), opts.settings.drop, opts.round);

  const phase_id = currentPhaseId(run);
  const state = {
    request: clip(opts.prompt, 12_000),
    review: {
      summary: clip(review.summary, 2_000),
      blocking: review.blocking.map((b) => clip(b, 500)),
      unmet_findings: [...unique.values()].map((f) => ({ requirement: clip(f.requirement, 500), evidence: clip(f.evidence, 1_000) })),
    },
  };
  const fingerprints = [...unique.keys()];
  const items: DecisionBatchItem<FindingTriageClass>[] = [...unique.values()].map((finding) => ({
    kind: FINDING_TRIAGE_KIND.kind,
    key: findingTriageKey(opts.round, finding),
    options: FINDING_TRIAGE_OPTIONS,
    fallback: FINDING_TRIAGE_FALLBACK,
    phase_id,
    instructions: [
      "A code reviewer rejected a change. `state.request` is what was asked for; `state.review` is the reviewer's verdict.",
      "Before a fixing agent is asked to close it, classify ONLY this one unmet finding:",
      `Requirement: ${clip(finding.requirement, 500)}`,
      `Evidence: ${clip(finding.evidence, 1_000) || "(none given)"}`,
      "Answer `real` unless you are confident the finding is noise or purely style.",
    ].join("\n"),
  }));
  const decisions: Decision<FindingTriageClass>[] = await run.jev.decideBatch(state, items);
  const classes = new Map(fingerprints.map((fp, i) => [fp, decisions[i]!.choice]));
  const outcome = applyFindingTriage(review, classes, opts.settings.drop, opts.round);

  if (outcome.handoff !== review) {
    const row = (t: TriagedFinding) => ({ key: t.key, triage: t.triage, requirement: t.finding.requirement });
    await run.tracer.event(
      makeEventRecord({
        adw_id: run.adw_id,
        phase_id,
        type: "log",
        name: FINDING_TRIAGE_EVENT,
        payload: {
          round: opts.round,
          drop: opts.settings.drop,
          drop_suspended: outcome.drop_suspended,
          kept: outcome.kept.map(row),
          deprioritized: outcome.deprioritized.map(row),
          dropped: outcome.dropped.map(row),
        },
      }),
    );
    await run.console.note(
      `jev triage: ${outcome.kept.length} real, ${outcome.deprioritized.length} deprioritized, ${outcome.dropped.length} dropped` +
        (outcome.drop_suspended ? " (drop suspended: nothing real left)" : ""),
    );
  }
  return outcome;
}
