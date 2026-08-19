/**
 * ADW Prompt — the smallest ADW: one agent, one prompt, traced end-to-end.
 *
 * Usage:
 *   bun run adws/adw_prompt.ts "<prompt or path/to/prompt.md>" [--agent builder] [--config adws/adw_sf_config/sf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> <agent>
 */

import * as agents from "../core/agents.ts";
import * as session from "../core/session.ts";
import { GenericOutput, makeAgentCall, makePhaseParams } from "../core/data_types.ts";
import type { ChainContext } from "./context.ts";

export async function main(ctx: ChainContext, options: { agent?: string } = {}): Promise<number> {
  const { prompt, config_paths, adw_id, cwd } = ctx;
  const agent = options.agent ?? "builder";
  const cfg = agents.loadConfig(config_paths);
  agents.validate(cfg, [agent], [], cwd);
  const run = session.ensure(cfg, adw_id, cwd);

  await run.phase(makePhaseParams({ name: "request", kind: "engineer", owner: run.engineer, description: "Capture the incoming ask" }), async (ph) => {
    ph.log({ input: prompt });
  });

  await run.phase(
    makePhaseParams({ name: "prompt", kind: "agent", owner: agent, description: `Send the request straight to ${agent} and parse its envelope` }),
    async (ph) => {
      await ph.call(makeAgentCall({ output_type: GenericOutput, prompt }));
    },
  );

  return run.finish();
}
