/**
 * ADW Plan Build Test Quality — full agent chain plus deterministic quality.
 *
 * Usage:
 *   bun run adws/adw_plan_build_test_quality.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sf_config/sf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> planner -> builder -> [code(verify) -> code(test) -> builder(fix)] bounded -> git(commit)
 *
 * Verify and test are CODE, not agents. Their commands are known, so running them
 * needs no judgement — only repairing them does. A failing block does not fail its
 * phase: the runner did its job, the code is what failed. The failure becomes an
 * envelope and flows back into the builder, and only an exhausted repair loop
 * fails the run.
 */

import * as agents from "../core/agents.ts";
import * as gates from "../core/gates.ts";
import * as quality from "../core/quality.ts";
import * as session from "../core/session.ts";
import { BuildOutput, PlanOutput, makeAgentCall, makePhaseParams, type BuildOutputT, type QualityResult } from "../core/data_types.ts";
import type { PhaseHandle } from "../core/runner.ts";
import type { ChainContext } from "./context.ts";

export const REQUIRED_AGENTS = ["planner", "builder"];
export const REQUIRED_SUITES: string[] = ["all"];
const MAX_FIX_LOOPS = 3;

function record(ph: PhaseHandle, result: QualityResult): void {
  const passed = result.checks.filter((c) => c.passed).length;
  ph.log({ passed: result.passed, checks: `${passed}/${result.checks.length}`, artifacts: result.artifacts.join(", ") });
}

export async function main(ctx: ChainContext): Promise<number> {
  const { prompt, config_paths, adw_id, cwd } = ctx;
  const cfg = agents.loadConfig(config_paths);
  agents.validate(cfg, REQUIRED_AGENTS, REQUIRED_SUITES, cwd);
  const run = session.ensure(cfg, adw_id, cwd);

  await run.phase(makePhaseParams({ name: "request", kind: "engineer", owner: run.engineer, description: "Capture the incoming ask" }), async (ph) => {
    ph.log({ input: prompt });
  });

  const plan = await run.phase(
    makePhaseParams({ name: "plan", kind: "agent", owner: "planner", description: "Turn the request into an implementable plan" }),
    (ph) => ph.call(makeAgentCall({ output_type: PlanOutput, prompt, gates: [gates.artifactsExist, gates.filesNonEmpty] })),
  );

  let previous: BuildOutputT = await run.phase(
    makePhaseParams({ name: "build", kind: "agent", owner: "builder", description: "Implement the plan exactly" }),
    (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt, previous: plan, gates: [gates.diffMatchesClaims] })),
  );

  let testResult: QualityResult | null = null;
  let qualityResult: QualityResult | null = null;
  for (let i = 1; i <= MAX_FIX_LOOPS; i++) {
    qualityResult = await run.phase(
      makePhaseParams({ name: `verify_${i}`, kind: "code", owner: "quality", description: "Lint, typecheck, and build before testing" }),
      async (ph) => {
        const result = quality.runQuality(run);
        record(ph, result);
        return result;
      },
    );

    // runQuality() already includes the test block; a repo that wants tests
    // in their own phase can split them out the way this comment does.
    testResult = qualityResult;

    if (qualityResult.passed && testResult.passed) break;
    if (i === MAX_FIX_LOOPS) break;

    // Whichever block failed becomes the builder's spec — verbatim command
    // output, no parser standing between the failure and the fix.
    const broken = !qualityResult.passed ? qualityResult : testResult;
    const what = !qualityResult.passed ? "verification" : "tests";
    previous = await run.phase(
      makePhaseParams({ name: `fix_${i}`, kind: "agent", owner: "builder", retries: 1, description: `Resolve the reported ${what} failures` }),
      (ph) =>
        ph.call(makeAgentCall({ output_type: BuildOutput, prompt, previous: quality.asEnvelope(broken, what), gates: [gates.diffMatchesClaims] })),
    );
  }

  const verified = qualityResult !== null && qualityResult.passed && testResult !== null && testResult.passed;
  if (verified) {
    await run.phase(
      makePhaseParams({ name: "commit", kind: "code", owner: "git", description: "Commit the tested and quality-verified working tree" }),
      async (ph) => {
        const message = previous.commit_message || `sf(${run.adw_id}): ${previous.summary}`;
        ph.log({ sha: run.git.commitAll(message), message });
      },
    );
  }

  return run.finish(verified, `verify/test never came back clean after ${MAX_FIX_LOOPS} fix attempt(s)`);
}
