/**
 * ADW Scout — read-only recon workflow. Just looking for stuff.
 *
 * Usage:
 *   bun run adws/adw_scout.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sf_config/sf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> scout
 */

import * as agents from "../core/agents.ts";
import * as gates from "../core/gates.ts";
import * as session from "../core/session.ts";
import { makeAgentCall, makePhaseParams, ScoutOutput } from "../core/data_types.ts";

const REQUIRED_AGENTS = ["scout"];

export async function main(prompt: string, config: string = "adws/adw_sf_config/sf.config.yaml", adwId: string | null = null): Promise<number> {
  const cfg = agents.loadConfig(config);
  agents.validate(cfg, REQUIRED_AGENTS);
  const run = session.ensure(cfg, adwId);

  await run.phase(makePhaseParams({ name: "request", kind: "engineer", owner: run.engineer, description: "Capture the incoming ask" }), async (ph) => {
    ph.log({ input: prompt });
  });

  await run.phase(
    makePhaseParams({ name: "scout", kind: "agent", owner: "scout", description: "Find and report where things live — change nothing" }),
    async (ph) => {
      await ph.call(makeAgentCall({ output_type: ScoutOutput, prompt, gates: [gates.artifactsExist] }));
    },
  );

  return run.finish();
}
