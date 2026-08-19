#!/usr/bin/env bun
/**
 * ADW Simple SDLC — plan, build, test, review, document, committing as it goes.
 *
 * Usage:
 *   bun run adws/adw_simple_sdlc.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sf_config/sf.config.yaml] [--adw-id a1b2c3d4]
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
 */

import * as agents from "./adw_modules/agents.ts";
import * as changes from "./adw_modules/changes.ts";
import * as gates from "./adw_modules/gates.ts";
import * as gitHelper from "./adw_modules/git_helper.ts";
import * as quality from "./adw_modules/quality.ts";
import * as session from "./adw_modules/session.ts";
import {
  BuildOutput,
  DocumentOutput,
  PlanOutput,
  ReviewOutput,
  makeAgentCall,
  makeChangeCapture,
  makePhaseParams,
  type BuildOutputT,
  type EnvelopeBase,
  type QualityResult,
  type ReviewOutputT,
} from "./adw_modules/data_types.ts";
import { parseCli, resolvePrompt, runMain } from "./adw_modules/utils.ts";
import type { PhaseHandle } from "./adw_modules/runner.ts";
import type { Run } from "./adw_modules/runner.ts";

const REQUIRED_AGENTS = ["planner", "builder", "reviewer", "documenter"];
const MAX_FIX_LOOPS = 3;
const MAX_REVISION_LOOPS = 2;

const DOCUMENT_NOTES =
  "Read diff_path in full before writing. Document only what the diff shows, then copy the write-up into app_docs/ as your task describes.";

/** Commit what the preceding phase produced, in that agent's own words. */
function commit(run: Run, ph: PhaseHandle, envelope: EnvelopeBase & { commit_message?: string }): void {
  const message = envelope.commit_message || `sf(${run.adw_id}): ${envelope.summary}`;
  ph.log({ sha: gitHelper.commitAll(message), message });
}

/** Log a deterministic block's verdict — the same shape every ADW uses. */
function record(ph: PhaseHandle, result: QualityResult): void {
  const passed = result.checks.filter((c) => c.passed).length;
  ph.log({ passed: result.passed, checks: `${passed}/${result.checks.length}`, artifacts: result.artifacts.join(", ") });
}

async function main(prompt: string, config: string = "adws/adw_sf_config/sf.config.yaml", adwId: string | null = null): Promise<number> {
  const cfg = agents.loadConfig(config);
  agents.validate(cfg, REQUIRED_AGENTS);
  const run = session.ensure(cfg, adwId);
  const baseline = gitHelper.rev("HEAD"); // pinned before this run commits anything

  await run.phase(makePhaseParams({ name: "request", kind: "engineer", owner: run.engineer, description: "Capture the incoming ask" }), async (ph) => {
    ph.log({ input: prompt, baseline: gitHelper.shortSha(baseline) });
  });

  const plan = await run.phase(
    makePhaseParams({ name: "plan", kind: "agent", owner: "planner", description: "Turn the request into an implementable plan" }),
    (ph) => ph.call(makeAgentCall({ output_type: PlanOutput, prompt, gates: [gates.artifactsExist, gates.filesNonEmpty] })),
  );

  await run.phase(
    makePhaseParams({ name: "commit_plan", kind: "code", owner: "git", description: "Put the spec on record before any code exists to blur it" }),
    async (ph) => commit(run, ph, plan),
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
        record(ph, result);
        return result;
      },
    );

    if (test.passed) break;

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
        record(ph, result);
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
      async (ph) => commit(run, ph, build),
    );

    const changeset = await run.phase(
      makePhaseParams({ name: "changes", kind: "code", owner: "git", description: "Diff the whole run against its pinned baseline, for the documenter" }),
      async (ph) => {
        const result = changes.capture(run, makeChangeCapture({ base: baseline }));
        ph.log({
          base: `${result.base.label} @ ${result.base.commit.slice(0, 7)}`,
          reason: result.base.reason,
          files: result.files.length + result.untracked.length,
          lines: `+${result.insertions} -${result.deletions}`,
          diff: result.diff_path,
        });
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
      async (ph) => commit(run, ph, document),
    );
  }

  return run.finish(verified, "the suite or the review never came back clean");
}

if (import.meta.main) {
  const { positionals, options } = parseCli(process.argv.slice(2), ["config", "adw-id"]);
  if (positionals.length < 1) {
    console.error("usage: adw_simple_sdlc.ts <prompt or path/to/prompt.md> [--config <path>] [--adw-id <id>]");
    process.exit(1);
  }
  runMain(() => main(resolvePrompt(positionals[0]), options["config"] ?? "adws/adw_sf_config/sf.config.yaml", options["adw-id"] ?? null));
}
