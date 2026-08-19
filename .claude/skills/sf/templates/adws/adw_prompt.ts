#!/usr/bin/env bun
/**
 * ADW Prompt — the smallest ADW: one agent, one prompt, traced end-to-end.
 *
 * Usage:
 *   bun run adws/adw_prompt.ts "<prompt or path/to/prompt.md>" [--agent builder] [--config adws/adw_sf_config/sf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> <agent>
 */

import * as agents from "./adw_modules/agents.ts";
import * as session from "./adw_modules/session.ts";
import { GenericOutput, makeAgentCall, makePhaseParams } from "./adw_modules/data_types.ts";
import { parseCli, resolvePrompt, runMain } from "./adw_modules/utils.ts";

async function main(
  prompt: string,
  agent: string = "builder",
  config: string = "adws/adw_sf_config/sf.config.yaml",
  adwId: string | null = null,
): Promise<number> {
  const cfg = agents.loadConfig(config);
  agents.validate(cfg, [agent]);
  const run = session.ensure(cfg, adwId);

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

if (import.meta.main) {
  const { positionals, options } = parseCli(process.argv.slice(2), ["agent", "config", "adw-id"]);
  if (positionals.length < 1) {
    console.error("usage: adw_prompt.ts <prompt or path/to/prompt.md> [--agent <name>] [--config <path>] [--adw-id <id>]");
    process.exit(1);
  }
  runMain(() =>
    main(
      resolvePrompt(positionals[0]),
      options["agent"] ?? "builder",
      options["config"] ?? "adws/adw_sf_config/sf.config.yaml",
      options["adw-id"] ?? null,
    ),
  );
}
