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
 *         -> git(commit_build) -> code(changes) -> documenter -> git(commit_docs)
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

export async function main(ctx: ChainContext): Promise<number> {
  const { prompt } = ctx;
  const run = startRun(ctx, REQUIRED_AGENTS, REQUIRED_SUITES);
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
  const verified = test !== null && test.passed && review !== null && review.approved;
  if (verified) {
    await run.phase(
      makePhaseParams({ name: "commit_build", kind: "code", owner: "git", description: "Land the code only now: green suite, approved review" }),
      async (ph) => commitEnvelope(run, ph, build),
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

  return run.finish(verified, "the suite or the review never came back clean");
}
