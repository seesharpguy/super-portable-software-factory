/** Shared by both `spf <chain> "..."` and `spf run <chain> "..."` — same dispatch. */
import * as paths from "../../core/paths.ts";
import { parseCli, resolvePrompt } from "../../core/utils.ts";
import { runChain, type ChainDefinition } from "../../chains/index.ts";
import type { ChainContext } from "../../chains/context.ts";

const KNOWN_OPTIONS = ["config", "adw-id", "cwd", "agent", "base"];

export function usageFor(chain: ChainDefinition): string {
  return `usage: spf ${chain.name} "<prompt or path/to/prompt.md>" [--config <path>] [--adw-id <id>] [--cwd <dir>]`;
}

export async function dispatchChain(chain: ChainDefinition, argv: string[]): Promise<number> {
  const { positionals, options } = parseCli(argv, KNOWN_OPTIONS);
  if (positionals.length < 1) {
    console.error(usageFor(chain));
    return 1;
  }

  const anchor = paths.resolveAnchor(options["cwd"]);
  const ctx: ChainContext = {
    prompt: resolvePrompt(positionals[0]),
    config_paths: paths.resolveConfigPaths(anchor, options["config"]).paths,
    adw_id: options["adw-id"] ?? null,
    cwd: anchor.cwd,
    chain_name: chain.name,
  };

  const chainOptions: Record<string, string> = {};
  if (options["agent"] !== undefined) chainOptions["agent"] = options["agent"];
  if (options["base"] !== undefined) chainOptions["base"] = options["base"];

  return runChain(chain, ctx, chainOptions);
}
