/**
 * ADW Build — one-shot implementation workflow.
 *
 * Usage:
 *   bun run adws/adw_build.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sf_config/sf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> builder
 */

import * as agents from "../core/agents.ts";
import * as gates from "../core/gates.ts";
import * as session from "../core/session.ts";
import { BuildOutput, makeAgentCall, makePhaseParams } from "../core/data_types.ts";

const REQUIRED_AGENTS = ["builder"];

export async function main(prompt: string, config: string = "adws/adw_sf_config/sf.config.yaml", adwId: string | null = null): Promise<number> {
  const cfg = agents.loadConfig(config);
  agents.validate(cfg, REQUIRED_AGENTS);
  const run = session.ensure(cfg, adwId);

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
