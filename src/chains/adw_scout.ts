#!/usr/bin/env bun
/**
 * ADW Scout — read-only recon workflow. Just looking for stuff.
 *
 * Usage:
 *   bun run adws/adw_scout.ts "<prompt or path/to/prompt.md>" [--config adws/adw_sf_config/sf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> scout
 */

import * as agents from "./adw_modules/agents.ts";
import * as gates from "./adw_modules/gates.ts";
import * as session from "./adw_modules/session.ts";
import { makeAgentCall, makePhaseParams, ScoutOutput } from "./adw_modules/data_types.ts";
import { parseCli, resolvePrompt, runMain } from "./adw_modules/utils.ts";

const REQUIRED_AGENTS = ["scout"];

async function main(prompt: string, config: string = "adws/adw_sf_config/sf.config.yaml", adwId: string | null = null): Promise<number> {
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

if (import.meta.main) {
  const { positionals, options } = parseCli(process.argv.slice(2), ["config", "adw-id"]);
  if (positionals.length < 1) {
    console.error("usage: adw_scout.ts <prompt or path/to/prompt.md> [--config <path>] [--adw-id <id>]");
    process.exit(1);
  }
  runMain(() => main(resolvePrompt(positionals[0]), options["config"] ?? "adws/adw_sf_config/sf.config.yaml", options["adw-id"] ?? null));
}
