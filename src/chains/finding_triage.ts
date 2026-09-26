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
 *     the structured ask (`findings`, `blocking`) is handed over UNCHANGED —
 *     whatever `drop` says — and the demotions only add the "Deprioritized
 *     by jev" note. A rejected review always hands the fixer a non-empty
 *     to-do list, so the handoff still satisfies `gates.verdictConsistent`
 *     ("a rejection names a problem") exactly as the reviewer's own did;
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
 * HTTP call whose state + questions share a ~32k-token budget (see
 * `TRIAGE_REQUEST_CHAR_BUDGET`), and a review with more findings than this
 * is not one a classifier should be pruning.
 */
export const MAX_TRIAGED_FINDINGS = 50;

/**
 * The whole SystemOne request (state + every question) is kept under this
 * many JSON characters: ~32k tokens at a deliberately pessimistic ~3
 * characters per token. An oversize request comes back as an HTTP error,
 * which is safe (every finding falls back to `real`) but would silently
 * disable triage on exactly the large reviews it exists for.
 *
 * The split: each question is a short constant instruction that names its
 * finding by fingerprint (never restating it) plus the three option
 * descriptions — under 1k characters each, so under ~50k characters for
 * `MAX_TRIAGED_FINDINGS` questions — and `TRIAGE_STATE_CHAR_BUDGET` for the
 * state.
 * finding_triage.test.ts pins the worst case (50 maximal findings) under
 * this total.
 */
export const TRIAGE_REQUEST_CHAR_BUDGET = 96_000;
export const TRIAGE_STATE_CHAR_BUDGET = 44_000;

/** `blocking` entries carried into the state (context only — never asked about); the rest are summarized as a count. */
const MAX_BLOCKING_IN_STATE = 25;

/**
 * Clip limits tried in order until the state fits `TRIAGE_STATE_CHAR_BUDGET`.
 * The LAST level fits by construction even at the caps (request 4k +
 * summary 800 + 25 blockers x ~170 + 50 findings x ~420 = ~30k chars), so
 * the budget is a guarantee, not a hope.
 */
const STATE_CLIP_LEVELS: readonly { request: number; summary: number; blocking: number; requirement: number; evidence: number }[] = [
  { request: 12_000, summary: 2_000, blocking: 500, requirement: 500, evidence: 1_000 },
  { request: 8_000, summary: 1_500, blocking: 300, requirement: 400, evidence: 500 },
  { request: 6_000, summary: 1_000, blocking: 200, requirement: 300, evidence: 250 },
  { request: 4_000, summary: 800, blocking: 150, requirement: 200, evidence: 120 },
];

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
 * top of the step. `startRun` has already parsed every registered kind's
 * extras before the run's first phase (so a bad `drop` fails before any
 * agent spend); the parse here is the backstop for a `Run` built some other
 * way, and it throws the same config-shaped
 * `jev.decisions.finding_triage: ...` error rather than failing mid-loop.
 * While off, nothing is parsed at all.
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
  /**
   * True when every unmet finding was demoted: the structured ask
   * (`findings`, `blocking`) was then handed over unchanged, and the
   * demotions only appear in the notes — a rejected review never reaches
   * the fixer as an empty to-do list.
   */
  all_demoted: boolean;
  /** `all_demoted` AND `drop` asked to withhold some of them — so nothing was withheld this round. */
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
  if (demoted.length === 0) return { handoff: review, kept, deprioritized: [], dropped: [], all_demoted: false, drop_suspended: false };

  // Never empty the ask: with no real finding left, reshaping would send the
  // fixer an empty structured to-do list (`findings`/`blocking`) for a review
  // that REJECTED — an envelope `gates.verdictConsistent` itself would refuse
  // ("approved=false but no blocking item or unmet requirement"). So the
  // structured ask stays the reviewer's, `drop` is not applied, and the
  // demotions are advisory notes only.
  const all_demoted = kept.length === 0;
  if (all_demoted) {
    const notes = appendDeprioritized(
      review.notes_for_next_agent,
      "Jev's finding triage classified EVERY unmet finding as noise or style. They all stay in `findings` and `blocking` — a rejected review always hands you its full ask — and none is waived: the reviewer rules on every requirement again next round. Treat these labels as a hint about where the real gap is least likely to be.",
      demoted,
    );
    return {
      handoff: { ...review, notes_for_next_agent: notes },
      kept,
      deprioritized: demoted,
      dropped: [],
      all_demoted,
      drop_suspended: demoted.some((t) => shouldDrop(t.triage, drop)),
    };
  }

  const dropped = demoted.filter((t) => shouldDrop(t.triage, drop));
  const deprioritized = demoted.filter((t) => !shouldDrop(t.triage, drop));
  const demotedFps = new Set(demoted.map((t) => findingFingerprint(t.finding)));
  const demotedRequirements = new Set(demoted.map((t) => normalizeText(t.finding.requirement)));
  const findings = review.findings.filter((f) => f.met || !demotedFps.has(findingFingerprint(f)));
  const blocking = review.blocking.filter((b) => !demotedRequirements.has(normalizeText(b)));
  const notes =
    deprioritized.length === 0
      ? review.notes_for_next_agent
      : appendDeprioritized(
          review.notes_for_next_agent,
          "Jev's finding triage classified these unmet findings as noise or style. They are NOT waived: the reviewer rules on every requirement again next round. Close everything in `findings` and `blocking` first; address these only where it is cheap and safe.",
          deprioritized,
        );
  // Spread first, so `approved`/`status`/everything else is the reviewer's own — only the to-do list is reshaped.
  // `kept` is non-empty here, so `findings` still holds an unmet finding: the rejection still names a problem.
  const handoff: ReviewOutputT = { ...review, findings, blocking, notes_for_next_agent: notes };
  return { handoff, kept, deprioritized, dropped, all_demoted, drop_suspended: false };
}

function appendDeprioritized(notes: string, preamble: string, demoted: readonly TriagedFinding[]): string {
  const lines = [
    "## Deprioritized by jev",
    preamble,
    ...demoted.map((t) => `- [${t.triage}] ${t.finding.requirement}${t.finding.evidence ? ` — ${t.finding.evidence}` : ""}`),
  ];
  return [notes, lines.join("\n")].filter((part) => part.length > 0).join("\n\n");
}

/**
 * The batch's shared state: the request plus the review, with the unmet
 * findings each carrying the `id` (fingerprint) its question refers to.
 * Clipped by the first `STATE_CLIP_LEVELS` entry that fits
 * `TRIAGE_STATE_CHAR_BUDGET`. Exported for its budget test.
 */
export function buildTriageState(prompt: string, review: ReviewOutputT, unique: ReadonlyMap<string, ReviewFinding>): Record<string, unknown> {
  let state: Record<string, unknown> = {};
  for (const level of STATE_CLIP_LEVELS) {
    const blocking = review.blocking.slice(0, MAX_BLOCKING_IN_STATE).map((b) => clip(b, level.blocking));
    const more = review.blocking.length - blocking.length;
    state = {
      task: "A code reviewer rejected a change. Before a fixing agent is asked to close them, each unmet finding is classified on its own.",
      request: clip(prompt, level.request),
      review: {
        summary: clip(review.summary, level.summary),
        blocking: more > 0 ? [...blocking, `(${more} more blocking item(s) not shown)`] : blocking,
        unmet_findings: [...unique].map(([id, f]) => ({
          id,
          requirement: clip(f.requirement, level.requirement),
          evidence: clip(f.evidence, level.evidence),
        })),
      },
    };
    if (JSON.stringify(state).length <= TRIAGE_STATE_CHAR_BUDGET) break;
  }
  return state;
}

/** Runs whose `jev_triage` outcome write already failed once — warn once per run, like `Jev.record`. */
const outcomeWriteWarned = new WeakSet<object>();

/**
 * Classify a rejected review's unmet findings with ONE Jev batch and reshape
 * the handoff. Call it from INSIDE the revise phase, passing that phase's
 * `ph.phase_id` (so every decision and the outcome row land on it), only
 * when `resolveFindingTriage` returned settings.
 */
export async function triageReviewFindings(
  run: Run,
  review: ReviewOutputT,
  opts: { settings: FindingTriageSettings; round: number; prompt: string; phase_id: string },
): Promise<FindingTriageOutcome> {
  const unique = new Map<string, ReviewFinding>();
  for (const finding of review.findings) {
    if (finding.met) continue;
    const fp = findingFingerprint(finding);
    if (!unique.has(fp) && unique.size < MAX_TRIAGED_FINDINGS) unique.set(fp, finding);
  }
  if (unique.size === 0) return applyFindingTriage(review, new Map(), opts.settings.drop, opts.round);

  const { phase_id } = opts;
  const state = buildTriageState(opts.prompt, review, unique);
  const fingerprints = [...unique.keys()];
  // Each question names its finding by fingerprint rather than restating it:
  // the finding's text is already in `state`, once.
  const items: DecisionBatchItem<FindingTriageClass>[] = [...unique].map(([fp, finding]) => ({
    kind: FINDING_TRIAGE_KIND.kind,
    key: findingTriageKey(opts.round, finding),
    options: FINDING_TRIAGE_OPTIONS,
    fallback: FINDING_TRIAGE_FALLBACK,
    phase_id,
    instructions:
      `Classify ONLY the finding in \`state.review.unmet_findings\` whose id is "${fp}", against \`state.request\`. ` +
      "Answer `real` unless you are confident it is noise or purely style.",
  }));
  const decisions: Decision<FindingTriageClass>[] = await run.jev.decideBatch(state, items);
  const classes = new Map(fingerprints.map((fp, i) => [fp, decisions[i]!.choice]));
  const outcome = applyFindingTriage(review, classes, opts.settings.drop, opts.round);

  if (outcome.handoff !== review) {
    // Advisory, like the decisions themselves: a trace or console failure
    // here must never fail the revise phase (mirrors `Jev.record`).
    try {
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
            all_demoted: outcome.all_demoted,
            drop_suspended: outcome.drop_suspended,
            kept: outcome.kept.map(row),
            deprioritized: outcome.deprioritized.map(row),
            dropped: outcome.dropped.map(row),
          },
        }),
      );
      await run.console.note(
        `jev triage: ${outcome.kept.length} real, ${outcome.deprioritized.length} deprioritized, ${outcome.dropped.length} dropped` +
          (outcome.all_demoted ? " (every finding demoted: the full ask is kept)" : ""),
      );
    } catch (error) {
      if (!outcomeWriteWarned.has(run)) {
        outcomeWriteWarned.add(run);
        process.stderr.write(`[spf] jev: could not record the finding triage outcome (${(error as Error).message}) — continuing\n`);
      }
    }
  }
  return outcome;
}
