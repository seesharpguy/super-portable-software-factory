/**
 * Phase-2 stub dispatcher: still just enough to run one chain end-to-end for
 * verification — now building a real ChainContext through the resolved
 * workspace anchor instead of threading raw strings. Gets replaced (not
 * extended) once the real command surface — list, sessions, phases, events,
 * ui, init, doctor, etc. — lands.
 *
 * Usage: sf <chain-name> "<prompt or path/to/prompt.md>"
 *          [--config <path>] [--adw-id <id>] [--cwd <dir>] [--agent <name>] [--base <ref>]
 *   <chain-name> is an adw_*.ts file's basename minus the "adw_" prefix,
 *   e.g. "scout" -> chains/adw_scout.ts, "plan_build_test" -> chains/adw_plan_build_test.ts.
 */

import * as agentFlue from "../core/agent_flue.ts";
import * as paths from "../core/paths.ts";
import { parseCli, resolvePrompt } from "../core/utils.ts";
import type { ChainContext } from "../chains/context.ts";

export async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env in cwd — fine, nothing to load
  }

  const [chainArg, ...rest] = process.argv.slice(2);
  if (!chainArg) {
    console.error('usage: sf <chain-name> "<prompt>" [--config <path>] [--adw-id <id>] [--cwd <dir>]');
    process.exitCode = 1;
    return;
  }

  const { positionals, options } = parseCli(rest, ["config", "adw-id", "cwd", "agent", "base"]);
  if (positionals.length < 1) {
    console.error('usage: sf <chain-name> "<prompt>" [--config <path>] [--adw-id <id>] [--cwd <dir>]');
    process.exitCode = 1;
    return;
  }

  const moduleName = `adw_${chainArg}.js`;
  let chain: { main: (ctx: ChainContext, options?: Record<string, string>) => Promise<number> };
  try {
    chain = await import(`../chains/${moduleName}`);
  } catch {
    console.error(`unknown chain: ${chainArg} (looked for chains/${moduleName})`);
    process.exitCode = 1;
    return;
  }

  const anchor = paths.resolveAnchor(options["cwd"]);
  const ctx: ChainContext = {
    prompt: resolvePrompt(positionals[0]),
    config_path: paths.resolveConfigPath(anchor, options["config"]),
    adw_id: options["adw-id"] ?? null,
    cwd: anchor.cwd,
  };

  const chainOptions: Record<string, string> = {};
  if (options["agent"] !== undefined) chainOptions["agent"] = options["agent"];
  if (options["base"] !== undefined) chainOptions["base"] = options["base"];

  try {
    process.exitCode = await chain.main(ctx, chainOptions);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    // A no-op if this chain never touched an agent (e.g. adw_quality) — the
    // Flue runtime is only ever started lazily, on the first real call.
    await agentFlue.shutdown();
  }
}
