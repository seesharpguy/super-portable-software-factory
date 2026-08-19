/**
 * ADW Build Test — implement, then verify; failures flow back into the builder.
 *
 * Usage:
 *   bun run adws/adw_build_test.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sf_config/sf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> builder -> code(test) [-> builder(fix) -> code(test) ... bounded]
 *
 * Testing is CODE. The suite's command is written down in core/quality.ts,
 * so running it needs no judgement — only repairing it does. Failures reach the
 * builder as an envelope through `quality.asEnvelope`, which is the same door an
 * agent's report came through, so the repair loop is unchanged.
 *
 * A failing suite does NOT fail its phase: the runner did its job, the code is
 * what failed. It fails the run, checked at the end, after the bounded fix loop
 * has had its chances.
 */

import * as agents from "../core/agents.ts";
import * as gates from "../core/gates.ts";
import * as quality from "../core/quality.ts";
import * as session from "../core/session.ts";
import { BuildOutput, makeAgentCall, makePhaseParams, type QualityResult } from "../core/data_types.ts";
import type { PhaseHandle } from "../core/runner.ts";
import type { ChainContext } from "./context.ts";

export const REQUIRED_AGENTS = ["builder"];
export const REQUIRED_SUITES: string[] = ["test"];
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

  await run.phase(
    makePhaseParams({ name: "build", kind: "agent", owner: "builder", description: "Implement the request" }),
    (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt, gates: [gates.diffMatchesClaims] })),
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

    await run.phase(
      makePhaseParams({
        name: `fix_${i}`,
        kind: "agent",
        owner: "builder",
        retries: 1,
        description: "Repair what the suite reported, from its verbatim output",
      }),
      (ph) =>
        ph.call(
          makeAgentCall({
            output_type: BuildOutput,
            prompt,
            previous: quality.asEnvelope(test!, "tests"),
            gates: [gates.diffMatchesClaims],
          }),
        ),
    );
  }

  return run.finish(test !== null && test.passed, `the suite still failed after ${MAX_FIX_LOOPS} fix attempt(s)`);
}
