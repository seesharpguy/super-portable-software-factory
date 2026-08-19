/**
 * ADW Quality — lint, typecheck, and build the project.
 *
 * Usage:
 *   bun run adws/adw_quality.ts "<reason for the quality run>" [--config adws/adw_sf_config/sf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> code(quality)
 */

import * as agents from "../core/agents.ts";
import * as quality from "../core/quality.ts";
import * as session from "../core/session.ts";
import { makePhaseParams } from "../core/data_types.ts";
import type { ChainContext } from "./context.ts";

export const REQUIRED_AGENTS: string[] = [];
export const REQUIRED_SUITES: string[] = ["all"];

export async function main(ctx: ChainContext): Promise<number> {
  const { prompt, config_paths, adw_id, cwd } = ctx;
  const cfg = agents.loadConfig(config_paths);
  agents.validate(cfg, REQUIRED_AGENTS, REQUIRED_SUITES, cwd);
  const run = session.ensure(cfg, adw_id, cwd);

  await run.phase(
    makePhaseParams({ name: "request", kind: "engineer", owner: run.engineer, description: "Capture why quality verification was requested" }),
    async (ph) => {
      ph.log({ input: prompt });
    },
  );

  await run.phase(
    makePhaseParams({ name: "quality", kind: "code", owner: "quality", description: "Run the deterministic quality blocks" }),
    async (ph) => {
      const result = quality.runQuality(run);
      const passed = result.checks.filter((c) => c.passed).length;
      ph.log({ passed: result.passed, checks: `${passed}/${result.checks.length}`, artifacts: result.artifacts.join(", ") });
      if (!result.passed) {
        throw new Error("quality failed: " + result.failures.join("; "));
      }
    },
  );

  return run.finish();
}
