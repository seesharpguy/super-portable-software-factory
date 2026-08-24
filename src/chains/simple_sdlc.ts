/**
 * Simple SDLC — plan, build, test, review, document, committing as it goes.
 *
 * Usage:
 *   spf simple-sdlc "<prompt or path/to/prompt.md>" [--config <path>] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> planner -> git(commit_plan)
 *         -> builder -> code(test) [-> builder(fix) -> code(test) ... bounded]
 *         -> reviewer [-> builder(revise) -> reviewer ... bounded]
 *         -> code(retest, only if a revision changed code)
 *         -> engineer(signoff) -> git(commit_build) -> code(changes) -> documenter -> git(commit_docs)
 *
 * The signoff phase is where "agent proposes, code disposes" gets literal:
 * `review.approved` is the AI reviewer's PROPOSAL, and this chain's
 * `commit_build` predicate is the only place in this codebase where such a
 * proposal gates a commit at all (`build-review` has no commit step). A
 * human at the keyboard DISPOSES of it — `decideSignoff` below — and their
 * answer, not `review.approved`, becomes the final predicate. Unattended
 * (`spf watch`, CI) has nobody to ask, so it either proceeds on the AI
 * verdict alone with a loud warning, or fails the phase closed, depending on
 * `review.require_human_signoff` — see that function's own comment.
 *
 * Three commits, three work products, three authors. The plan, the code, and the
 * write-up each land in their own commit, and each commit message is the words of
 * the agent that produced it — `commit_message` on PlanOutput describes the spec,
 * on BuildOutput the code, on DocumentOutput the write-up. No agent's sentence is
 * ever reused for another agent's diff.
 *
 * Testing is CODE, not an agent. `bun test` is a command, not a judgement call:
 * an agent rediscovering it every run costs a million tokens to learn what a
 * subprocess already knows. Failures travel back to the builder as an envelope,
 * so the repair loop is unchanged — only the runner became free and repeatable.
 *
 * Two different questions still get asked, in order. The suite asks "does it
 * run"; the reviewer asks "is this what was asked for", against `plan.md` — and
 * neither can answer the other's. A revision that closes a review finding
 * re-enters the suite, so the tree that gets committed is the tree that was both
 * tested and approved.
 *
 * The code commit lands after verification, not straight after the build: fixes
 * and revisions are part of the same work product, and red code has no business
 * on the branch. A run that fails verification therefore leaves the plan
 * committed and the working tree dirty — the spec is a real artifact either way,
 * and the unfinished code stays where the engineer can see it.
 *
 * The documenter measures against the commit this run STARTED from, not against
 * `main`, because by then the run has moved `main` itself. That baseline is
 * pinned before the first commit phase and printed in the request phase.
 *
 * This is the one chain still shaped by hand rather than by a `steps` list —
 * three commits, a pinned baseline, and a conditional retest don't collapse
 * cleanly into the flat, loop-free vocabulary `./steps.ts` provides for every
 * other chain. It still reuses that module's shared helpers (`startRun`,
 * `commitEnvelope`, `logChangeset`) rather than keeping its own copies.
 */

import * as changes from "../core/changes.ts";
import * as gates from "../core/gates.ts";
import * as quality from "../core/quality.ts";
import { DOCUMENT_NOTES } from "../core/prompts.ts";
import { createAsker, isInteractive, type Asker } from "../cli/ask.ts";
import { paint } from "../core/console.ts";
import { committerIdentity, type CommitterIdentity } from "../core/git_helper.ts";
import type { ChainContext } from "./context.ts";
import { commitEnvelope, logChangeset, startRun } from "./steps.ts";
import {
  BuildOutput,
  DocumentOutput,
  PlanOutput,
  ReviewOutput,
  makeAgentCall,
  makeChangeCapture,
  makePhaseParams,
  type BuildOutputT,
  type QualityResult,
  type ReviewOutputT,
} from "../core/data_types.ts";

export const REQUIRED_AGENTS = ["planner", "builder", "reviewer", "documenter"];
export const REQUIRED_SUITES: string[] = ["test"];
const MAX_FIX_LOOPS = 3;
const MAX_REVISION_LOOPS = 2;

// ── sign-off: agent proposes, code disposes, literally ──────────────────────

/** Printed (never thrown) whenever this chain commits on `review.approved` alone — nobody answered. */
export const AI_ONLY_SIGNOFF_WARNING =
  "committing on an AI-only verdict — set review.require_human_signoff or run attended";

export interface SignoffParams {
  review: ReviewOutputT;
  /** Both a real TTY (`isInteractive()`) AND an attended run (`!ctx.unattended`) — see the module comment on `ChainContext.unattended` for why neither alone is trusted. */
  canPrompt: boolean;
  requireHumanSignoff: boolean;
  signoffTimeoutSeconds: number;
  /** `null` whenever `canPrompt` is false — the caller never spins up a real prompt it won't use. */
  asker: Asker | null;
  /** `undefined` when `git config user.name`/`user.email` is unset at this repo — see `git_helper.committerIdentity`. */
  identity: CommitterIdentity | undefined;
  /** Routes into the phase's own trace record — `ph.log`, unchanged (no tracer changes on this thread). */
  log: (payload: Record<string, unknown>) => void;
  /** Console-only, never traced — the prompt itself and its framing, kept out of the event stream on purpose (the DECISION is what `log` records). */
  warn: (line: string) => void;
}

export interface SignoffOutcome {
  /** The chain's actual commit predicate — the human's answer where there is one, `review.approved` otherwise. */
  accepted: boolean;
  /**
   * True ONLY when a human explicitly typed "yes" through `asker.confirm`.
   * `confirm`'s own default is `false`, so this can only be true by way of
   * an explicit answer — never a TTY inference, never a timeout, never the
   * unattended AI-only path. This is the one flag `commit_build` may use to
   * decide whether a `Signed-off-by:` trailer is even considered.
   */
  recordedYes: boolean;
}

/**
 * Turn the reviewer's `approved` PROPOSAL into a human DISPOSAL wherever a
 * human is reachable; otherwise apply this release's documented default.
 *
 * Attended (`canPrompt`): shows the reviewer's findings and blocking list,
 * then asks — default `false` (never `review.approved`: an AI's own verdict
 * must never be its own auto-approval), bounded by
 * `review.signoff_timeout_seconds` (expiry resolves to that same `false` —
 * see `cli/ask.ts`'s `confirm`). The human's answer is the return value;
 * `review.approved` never overrides it either way.
 *
 * Unattended or no TTY: nobody to ask, so `require_human_signoff` decides.
 * `true` fails the phase CLOSED (throws) — this release will not let an
 * unattended run manufacture a "yes" nobody gave it. `false` (this release's
 * default) proceeds on `review.approved` alone, but never quietly: a loud
 * warning prints AND is logged every time, because the day this default
 * flips is the day silence here would have been the bug.
 */
export async function decideSignoff(params: SignoffParams): Promise<SignoffOutcome> {
  const { review, canPrompt, requireHumanSignoff, signoffTimeoutSeconds, asker, identity, log, warn } = params;

  if (!canPrompt) {
    if (requireHumanSignoff) {
      throw new Error(
        "review.require_human_signoff is true but this run is unattended — rerun attended, " +
          "or run via `spf watch`, where a human merges the PR instead of this phase.",
      );
    }
    warn(paint("bold yellow", `⚠ ${AI_ONLY_SIGNOFF_WARNING}`));
    log({
      decision: "ai_only",
      warning: AI_ONLY_SIGNOFF_WARNING,
      human: false,
      review_approved: review.approved,
      blocking: review.blocking,
      findings: review.findings,
    });
    return { accepted: review.approved, recordedYes: false };
  }

  if (!asker) throw new Error("decideSignoff: canPrompt is true but no asker was supplied");

  warn("");
  warn(paint("bold", "── sign-off required before commit ──"));
  for (const finding of review.findings) {
    const mark = finding.met ? paint("green", "met") : paint("red", "MISSING");
    warn(`  ${mark}  ${finding.requirement}${finding.evidence ? paint("dim", ` — ${finding.evidence}`) : ""}`);
  }
  if (review.blocking.length > 0) {
    warn(paint("red", `  blocking: ${review.blocking.join("; ")}`));
  }
  warn("");

  const accepted = await asker.confirm(
    identity ? `${identity.name}, approve and commit?` : "Approve and commit?",
    false,
    { timeoutMs: signoffTimeoutSeconds * 1000 },
  );
  log({
    decision: accepted ? "approved" : "declined",
    human: true,
    engineer: identity?.name ?? null,
    review_approved: review.approved,
    blocking: review.blocking,
    findings: review.findings,
  });
  if (accepted && !identity) {
    warn(paint("dim", "  no git committer identity (user.name/user.email) is set — sign-off recorded, no Signed-off-by trailer"));
    log({ note: "signoff recorded without a git committer identity — trailer skipped" });
  }
  return { accepted, recordedYes: accepted };
}

/**
 * Whether `commit_build` may attach a `Signed-off-by:` trailer: only when
 * the outcome recorded an explicit human "yes" (`recordedYes`) AND there is
 * an identity to attest it with. Deliberately NOT `outcome.accepted` alone —
 * the AI-only unattended path can also produce `accepted: true` (see
 * `decideSignoff`'s unattended branch), and that path must never mint a
 * trailer. Pulled out as its own named function, rather than inlined at the
 * `commitEnvelope` call site, specifically so a refactor that swaps
 * `recordedYes` for `verified`/`accepted` there breaks a test here instead
 * of silently minting trailers for AI-only commits.
 */
export function trailerFor(outcome: SignoffOutcome, identity: CommitterIdentity | undefined): CommitterIdentity | null {
  return outcome.recordedYes && identity ? identity : null;
}

export async function main(ctx: ChainContext): Promise<number> {
  const { prompt } = ctx;
  const run = await startRun(ctx, REQUIRED_AGENTS, REQUIRED_SUITES);
  const baseline = run.git.rev("HEAD"); // pinned before this run commits anything

  await run.phase(makePhaseParams({ name: "request", kind: "engineer", owner: run.engineer, description: "Capture the incoming ask" }), async (ph) => {
    ph.log({ input: prompt, baseline: run.git.shortSha(baseline) });
  });

  const plan = await run.phase(
    makePhaseParams({ name: "plan", kind: "agent", owner: "planner", description: "Turn the request into an implementable plan" }),
    (ph) => ph.call(makeAgentCall({ output_type: PlanOutput, prompt, gates: [gates.artifactsExist, gates.filesNonEmpty] })),
  );

  await run.phase(
    makePhaseParams({ name: "commit_plan", kind: "code", owner: "git", description: "Put the spec on record before any code exists to blur it" }),
    async (ph) => commitEnvelope(run, ph, plan),
  );

  let build: BuildOutputT = await run.phase(
    makePhaseParams({ name: "build", kind: "agent", owner: "builder", description: "Implement the plan exactly" }),
    (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt, previous: plan, gates: [gates.diffMatchesClaims] })),
  );

  let test: QualityResult | null = null;
  for (let i = 1; i <= MAX_FIX_LOOPS; i++) {
    test = await run.phase(
      makePhaseParams({
        name: `test_${i}`,
        kind: "code",
        owner: "quality",
        description: "Run the suite — a known command, so code runs it and no agent has to rediscover it",
      }),
      async (ph) => {
        const result = quality.runTests(run);
        quality.record(ph, result);
        return result;
      },
    );

    if (test.passed) break;
    if (i === MAX_FIX_LOOPS) break; // never leave an unverified fix on the table

    build = await run.phase(
      makePhaseParams({
        name: `fix_${i}`,
        kind: "agent",
        owner: "builder",
        retries: 1,
        description: "Repair what the suite reported, from its verbatim output",
      }),
      (ph) =>
        ph.call(makeAgentCall({ output_type: BuildOutput, prompt, previous: quality.asEnvelope(test!, "tests"), gates: [gates.diffMatchesClaims] })),
    );
  }

  let review: ReviewOutputT | null = null;
  let revised = false;
  for (let i = 1; i <= MAX_REVISION_LOOPS; i++) {
    review = await run.phase(
      makePhaseParams({ name: `review_${i}`, kind: "agent", owner: "reviewer", description: "Confirm the build matches the plan" }),
      (ph) =>
        ph.call(makeAgentCall({ output_type: ReviewOutput, prompt, previous: build, gates: [gates.artifactsExist, gates.verdictConsistent] })),
    );

    if (review.approved || i === MAX_REVISION_LOOPS) break;

    build = await run.phase(
      makePhaseParams({ name: `revise_${i}`, kind: "agent", owner: "builder", retries: 1, description: "Close the reviewer's blocking findings" }),
      (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt, previous: review!, gates: [gates.diffMatchesClaims] })),
    );
    revised = true;
  }

  // A revision edited code after the suite last ran, so the green light is
  // stale. Re-run it rather than commit on a result that predates the change.
  if (revised && review !== null && review.approved) {
    test = await run.phase(
      makePhaseParams({
        name: "retest",
        kind: "code",
        owner: "quality",
        description: "Re-run the suite — the revision changed code after the last green result",
      }),
      async (ph) => {
        const result = quality.runTests(run);
        quality.record(ph, result);
        return result;
      },
    );
  }

  // Red tests or a rejected review stop the chain here: the code stays
  // uncommitted and nothing is documented, because there is nothing worth
  // describing yet. The plan commit stands — it is a record of what was asked.
  const aiApproved = test !== null && test.passed && review !== null && review.approved;

  // The sign-off phase — see decideSignoff's comment and the module header —
  // only runs once the AI's own two gates (green suite, approved review) are
  // both already met; it never runs to rescue a run that failed either one.
  let verified = false;
  let recordedYes = false;
  let identity: CommitterIdentity | undefined; // hoisted: commit_build reads this too, gated by recordedYes
  if (aiApproved) {
    const canPrompt = isInteractive() && !ctx.unattended; // amendment: never infer this from TTY state alone
    identity = committerIdentity(run.repo_root);
    const asker = canPrompt ? createAsker() : null;
    // A live run dashboard (cli/ui/run_dashboard.tsx) keeps writing to the
    // same stdout/stdin on its own timer even though it never reads input
    // itself — that alone is enough to corrupt this prompt's rendering if
    // both are live at once. `pause()`/`resume()` are no-ops when no
    // dashboard is mounted (every non-interactive dispatch, and any test).
    if (canPrompt) await ctx.render_hooks?.pause?.();
    try {
      const outcome = await run.phase(
        makePhaseParams({
          name: "signoff",
          kind: "engineer",
          owner: identity?.name || run.engineer,
          description: "A human disposes of the AI reviewer's approval before anything commits",
        }),
        (ph) =>
          decideSignoff({
            review: review!,
            canPrompt,
            requireHumanSignoff: run.cfg.review.require_human_signoff,
            signoffTimeoutSeconds: run.cfg.review.signoff_timeout_seconds,
            asker,
            identity,
            log: (payload) => ph.log(payload),
            warn: (line) => console.log(line),
          }),
      );
      verified = outcome.accepted;
      recordedYes = outcome.recordedYes;
    } finally {
      asker?.close();
      if (canPrompt) ctx.render_hooks?.resume?.();
    }
  }

  if (verified) {
    await run.phase(
      makePhaseParams({ name: "commit_build", kind: "code", owner: "git", description: "Land the code only now: green suite, approved review, human sign-off" }),
      // trailerFor gates the trailer on recordedYes, not just `verified` — see
      // its own comment: a Signed-off-by line must trace back to an explicit
      // "yes", never to the AI-only path (where `verified` can also be true).
      async (ph) => commitEnvelope(run, ph, build, trailerFor({ accepted: verified, recordedYes }, identity)),
    );

    const changeset = await run.phase(
      makePhaseParams({ name: "changes", kind: "code", owner: "git", description: "Diff the whole run against its pinned baseline, for the documenter" }),
      async (ph) => {
        const result = changes.capture(run, makeChangeCapture({ base: baseline }));
        logChangeset(ph, result);
        if (result.empty) {
          throw new Error(`nothing changed since ${result.base.label} (${result.base.reason}) — there is nothing to document.`);
        }
        return result;
      },
    );

    const document = await run.phase(
      makePhaseParams({ name: "document", kind: "agent", owner: "documenter", retries: 1, description: "Write up the completed change" }),
      (ph) =>
        ph.call(
          makeAgentCall({
            output_type: DocumentOutput,
            prompt,
            previous: changes.asEnvelope(changeset, DOCUMENT_NOTES),
            gates: [gates.artifactsExist, gates.filesNonEmpty],
          }),
        ),
    );

    await run.phase(
      makePhaseParams({ name: "commit_docs", kind: "code", owner: "git", description: "Ship the write-up in its own commit, beside the code it describes" }),
      async (ph) => commitEnvelope(run, ph, document),
    );
  }

  return run.finish(verified, "the suite or the review never came back clean, or sign-off never came");
}
