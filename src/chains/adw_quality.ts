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

const REQUIRED_AGENTS: string[] = [];

export async function main(prompt: string, config: string = "adws/adw_sf_config/sf.config.yaml", adwId: string | null = null): Promise<number> {
  const cfg = agents.loadConfig(config);
  agents.validate(cfg, REQUIRED_AGENTS);
  const run = session.ensure(cfg, adwId);

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
