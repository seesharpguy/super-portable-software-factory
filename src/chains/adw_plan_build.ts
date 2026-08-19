/**
 * ADW Plan Build — two-agent chain: planner -> envelope -> builder.
 *
 * Usage:
 *   bun run adws/adw_plan_build.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sf_config/sf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> planner -> builder -> git(commit)
 */

import * as agents from "../core/agents.ts";
import * as gates from "../core/gates.ts";
import * as session from "../core/session.ts";
import { BuildOutput, PlanOutput, makeAgentCall, makePhaseParams } from "../core/data_types.ts";
import type { ChainContext } from "./context.ts";

export const REQUIRED_AGENTS = ["planner", "builder"];
export const REQUIRED_SUITES: string[] = [];

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

  const build = await run.phase(
    makePhaseParams({ name: "build", kind: "agent", owner: "builder", description: "Implement the plan exactly" }),
    (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt, previous: plan, gates: [gates.diffMatchesClaims] })),
  );

  await run.phase(
    makePhaseParams({ name: "commit", kind: "code", owner: "git", description: "Land the builder's changes, using the message it wrote" }),
    async (ph) => {
      const message = build.commit_message || `sf(${run.adw_id}): ${build.summary}`;
      ph.log({ sha: run.git.commitAll(message), message });
    },
  );

  return run.finish();
}
