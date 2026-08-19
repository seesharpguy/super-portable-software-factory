/**
 * ADW Plan Build Test — the full starter chain.
 *
 * Usage:
 *   bun run adws/adw_plan_build_test.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sf_config/sf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> planner -> builder -> code(test) [-> builder(fix) -> code(test) ... bounded] -> git(commit)
 *
 * Testing is CODE: the suite's command lives in core/quality.ts, so no
 * agent spends a context window rediscovering it. Failures flow back to the
 * builder as an envelope, and only an exhausted fix loop fails the run.
 */

import * as agents from "../core/agents.ts";
import * as gates from "../core/gates.ts";
import * as gitHelper from "../core/git_helper.ts";
import * as quality from "../core/quality.ts";
import * as session from "../core/session.ts";
import { BuildOutput, PlanOutput, makeAgentCall, makePhaseParams, type BuildOutputT, type QualityResult } from "../core/data_types.ts";
import type { PhaseHandle } from "../core/runner.ts";

const REQUIRED_AGENTS = ["planner", "builder"];
const MAX_FIX_LOOPS = 3;

function record(ph: PhaseHandle, result: QualityResult): void {
  const passed = result.checks.filter((c) => c.passed).length;
  ph.log({ passed: result.passed, checks: `${passed}/${result.checks.length}`, artifacts: result.artifacts.join(", ") });
}

export async function main(prompt: string, config: string = "adws/adw_sf_config/sf.config.yaml", adwId: string | null = null): Promise<number> {
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
    (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt, previous: plan, gates: [gates.artifactsExist] })),
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

    previous = await run.phase(
      makePhaseParams({
        name: `fix_${i}`,
        kind: "agent",
        owner: "builder",
        retries: 1,
        description: "Repair what the suite reported, from its verbatim output",
      }),
      (ph) =>
        ph.call(
          makeAgentCall({ output_type: BuildOutput, prompt, previous: quality.asEnvelope(test!, "tests"), gates: [gates.artifactsExist] }),
        ),
    );
  }

  // Only tested work gets committed — a red suite leaves the tree uncommitted.
  if (test !== null && test.passed) {
    await run.phase(
      makePhaseParams({ name: "commit", kind: "code", owner: "git", description: "Land the code only after the suite came back green" }),
      async (ph) => {
        const message = previous.commit_message || `sf(${run.adw_id}): ${previous.summary}`;
        ph.log({ sha: gitHelper.commitAll(message), message });
      },
    );
  }

  return run.finish(test !== null && test.passed, `the suite still failed after ${MAX_FIX_LOOPS} fix attempt(s)`);
}
