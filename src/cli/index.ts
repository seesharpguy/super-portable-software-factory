/**
 * Phase-1 stub dispatcher: just enough to run one chain end-to-end so the
 * de-Bun port can be verified against the old Bun+pi golden master. This
 * gets replaced (not extended) once the real command surface — list,
 * sessions, phases, events, ui, init, doctor, etc. — lands.
 *
 * Usage: sf <chain-name> "<prompt or path/to/prompt.md>" [--config <path>] [--adw-id <id>]
 *   <chain-name> is an adw_*.ts file's basename minus the "adw_" prefix,
 *   e.g. "scout" -> chains/adw_scout.ts, "plan_build_test" -> chains/adw_plan_build_test.ts.
 */

import { parseCli, resolvePrompt } from "../core/utils.ts";

export async function main(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // no .env in cwd — fine, nothing to load
  }

  const [chainArg, ...rest] = process.argv.slice(2);
  if (!chainArg) {
    console.error("usage: sf <chain-name> \"<prompt>\" [--config <path>] [--adw-id <id>]");
    process.exitCode = 1;
    return;
  }

  const { positionals, options } = parseCli(rest, ["config", "adw-id"]);
  if (positionals.length < 1) {
    console.error("usage: sf <chain-name> \"<prompt>\" [--config <path>] [--adw-id <id>]");
    process.exitCode = 1;
    return;
  }

  const moduleName = `adw_${chainArg}.js`;
  let chain: { main: (prompt: string, config?: string, adwId?: string | null) => Promise<number> };
  try {
    chain = await import(`../chains/${moduleName}`);
  } catch {
    console.error(`unknown chain: ${chainArg} (looked for chains/${moduleName})`);
    process.exitCode = 1;
    return;
  }

  const prompt = resolvePrompt(positionals[0]);
  const adwId = options["adw-id"] ?? null;

  try {
    // passing `undefined` for a defaulted parameter correctly triggers its default
    process.exitCode = await chain.main(prompt, options["config"], adwId);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
