#!/usr/bin/env bun
/**
 * ADW Build Test — implement, then verify; failures flow back into the builder.
 *
 * Usage:
 *   bun run adws/adw_build_test.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sf_config/sf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> builder -> code(test) [-> builder(fix) -> code(test) ... bounded]
 *
 * Testing is CODE. The suite's command is written down in adw_modules/quality.ts,
 * so running it needs no judgement — only repairing it does. Failures reach the
 * builder as an envelope through `quality.asEnvelope`, which is the same door an
 * agent's report came through, so the repair loop is unchanged.
 *
 * A failing suite does NOT fail its phase: the runner did its job, the code is
 * what failed. It fails the run, checked at the end, after the bounded fix loop
 * has had its chances.
 */

import * as agents from "./adw_modules/agents.ts";
import * as gates from "./adw_modules/gates.ts";
import * as quality from "./adw_modules/quality.ts";
import * as session from "./adw_modules/session.ts";
import { BuildOutput, makeAgentCall, makePhaseParams, type BuildOutputT, type QualityResult } from "./adw_modules/data_types.ts";
import { parseCli, resolvePrompt, runMain } from "./adw_modules/utils.ts";
import type { PhaseHandle } from "./adw_modules/runner.ts";

const REQUIRED_AGENTS = ["builder"];
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

  let previous: BuildOutputT = await run.phase(
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

if (import.meta.main) {
  const { positionals, options } = parseCli(process.argv.slice(2), ["config", "adw-id"]);
  if (positionals.length < 1) {
    console.error("usage: adw_build_test.ts <prompt or path/to/prompt.md> [--config <path>] [--adw-id <id>]");
    process.exit(1);
  }
  runMain(() => main(resolvePrompt(positionals[0]), options["config"] ?? "adws/adw_sf_config/sf.config.yaml", options["adw-id"] ?? null));
}
