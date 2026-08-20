/**
 * ADW Build — one-shot implementation workflow.
 *
 * Usage:
 *   spf build "<prompt or path/to/prompt.md>" [--config <path>] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> builder
 */

import * as agents from "../core/agents.ts";
import * as gates from "../core/gates.ts";
import * as session from "../core/session.ts";
import { BuildOutput, makeAgentCall, makePhaseParams } from "../core/data_types.ts";
import type { ChainContext } from "./context.ts";

export const REQUIRED_AGENTS = ["builder"];
export const REQUIRED_SUITES: string[] = [];

export async function main(ctx: ChainContext): Promise<number> {
  const { prompt, config_paths, adw_id, cwd } = ctx;
  const cfg = agents.loadConfig(config_paths);
  agents.validate(cfg, REQUIRED_AGENTS, REQUIRED_SUITES, cwd);
  const run = session.ensure(cfg, adw_id, cwd);

  await run.phase(makePhaseParams({ name: "request", kind: "engineer", owner: run.engineer, description: "Capture the incoming ask" }), async (ph) => {
    ph.log({ input: prompt });
  });

  await run.phase(
    makePhaseParams({ name: "build", kind: "agent", owner: "builder", retries: 1, description: "Implement the request" }),
    async (ph) => {
      await ph.call(makeAgentCall({ output_type: BuildOutput, prompt, gates: [gates.diffMatchesClaims] }));
    },
  );

  return run.finish();
}
