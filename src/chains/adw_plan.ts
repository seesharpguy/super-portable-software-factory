/**
 * ADW Plan — one-shot planning workflow.
 *
 * Usage:
 *   bun run adws/adw_plan.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sf_config/sf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> planner
 */

import * as agents from "../core/agents.ts";
import * as gates from "../core/gates.ts";
import * as session from "../core/session.ts";
import { PlanOutput, makeAgentCall, makePhaseParams } from "../core/data_types.ts";

const REQUIRED_AGENTS = ["planner"];

export async function main(prompt: string, config: string = "adws/adw_sf_config/sf.config.yaml", adwId: string | null = null): Promise<number> {
  const cfg = agents.loadConfig(config);
  agents.validate(cfg, REQUIRED_AGENTS);
  const run = session.ensure(cfg, adwId);

  await run.phase(makePhaseParams({ name: "request", kind: "engineer", owner: run.engineer, description: "Capture the incoming ask" }), async (ph) => {
    ph.log({ input: prompt });
  });

  await run.phase(
    makePhaseParams({ name: "plan", kind: "agent", owner: "planner", description: "Turn the request into an implementable plan" }),
    async (ph) => {
      await ph.call(makeAgentCall({ output_type: PlanOutput, prompt, gates: [gates.artifactsExist, gates.filesNonEmpty] }));
    },
  );

  return run.finish();
}
