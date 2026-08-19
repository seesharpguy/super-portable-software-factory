#!/usr/bin/env bun
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

import * as agents from "./adw_modules/agents.ts";
import * as gates from "./adw_modules/gates.ts";
import * as gitHelper from "./adw_modules/git_helper.ts";
import * as quality from "./adw_modules/quality.ts";
import * as session from "./adw_modules/session.ts";
import { BuildOutput, PlanOutput, makeAgentCall, makePhaseParams, type BuildOutputT, type QualityResult } from "./adw_modules/data_types.ts";
import { parseCli, resolvePrompt, runMain } from "./adw_modules/utils.ts";
import type { PhaseHandle } from "./adw_modules/runner.ts";

const REQUIRED_AGENTS = ["planner", "builder"];
const MAX_FIX_LOOPS = 3;

function record(ph: PhaseHandle, result: QualityResult): void {
  const passed = result.checks.filter((c) => c.passed).length;
  ph.log({ passed: result.passed, checks: `${passed}/${result.checks.length}`, artifacts: result.artifacts.join(", ") });
}

async function main(prompt: string, config: string = "adws/adw_sf_config/sf.config.yaml", adwId: string | null = null): Promise<number> {
  const cfg = agents.loadConfig(config);
  agents.validate(cfg, REQUIRED_AGENTS);
  const run = session.ensure(cfg, adwId);

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
        ph.log({ sha: gitHelper.commitAll(message), message });
      },
    );
  }

  return run.finish(verified, `verify/test never came back clean after ${MAX_FIX_LOOPS} fix attempt(s)`);
}

if (import.meta.main) {
  const { positionals, options } = parseCli(process.argv.slice(2), ["config", "adw-id"]);
  if (positionals.length < 1) {
    console.error("usage: adw_plan_build_test_quality.ts <prompt or path/to/prompt.md> [--config <path>] [--adw-id <id>]");
    process.exit(1);
  }
  runMain(() => main(resolvePrompt(positionals[0]), options["config"] ?? "adws/adw_sf_config/sf.config.yaml", options["adw-id"] ?? null));
}
