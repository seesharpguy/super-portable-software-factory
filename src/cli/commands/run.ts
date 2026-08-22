/** Shared by both `spf <chain> "..."` and `spf run <chain> "..."` — same dispatch. */
import * as paths from "../../core/paths.ts";
import { parseCli, resolvePrompt } from "../../core/utils.ts";
import { runChain, type ChainDefinition } from "../../chains/index.ts";
import type { ChainContext } from "../../chains/context.ts";

const KNOWN_OPTIONS = ["config", "adw-id", "cwd", "agent", "base", "issue", "suite"];

export function usageFor(chain: ChainDefinition): string {
  return `usage: spf ${chain.name} "<prompt or path/to/prompt.md>" [--config <path>] [--adw-id <id>] [--cwd <dir>] [--suite <name>]`;
}

export async function dispatchChain(chain: ChainDefinition, argv: string[]): Promise<number> {
  const { positionals, options } = parseCli(argv, KNOWN_OPTIONS);
  if (positionals.length < 1) {
    console.error(usageFor(chain));
    return 1;
  }
  // Only a step-derived chain's requiredSuites can actually read --suite
  // (see deriveRequiredSuites/qualityCheck/fixLoop) — an imperative chain
  // like simple-sdlc has a compiled-in static array and never consults
  // options["suite"] at all, so accepting the flag there would silently do
  // nothing. Reject loudly instead of letting it lie.
  if (options["suite"] !== undefined && typeof chain.requiredSuites !== "function") {
    console.error(`--suite has no effect on chain "${chain.name}" — its quality suite is fixed at ${JSON.stringify(chain.requiredSuites)}`);
    return 2;
  }

  const anchor = paths.resolveAnchor(options["cwd"]);
  const ctx: ChainContext = {
    prompt: resolvePrompt(positionals[0]),
    config_paths: paths.resolveConfigPaths(anchor, options["config"]).paths,
    adw_id: options["adw-id"] ?? null,
    cwd: anchor.cwd,
    chain_name: chain.name,
    // Only `refine` reads this (a "## Parent: #<id>" back-reference on
    // every issue it creates — see ChainContext's doc comment); every
    // other chain ignores it, so it's harmless to always pass through.
    issue_id: options["issue"] ?? null,
  };

  const chainOptions: Record<string, string> = {};
  if (options["agent"] !== undefined) chainOptions["agent"] = options["agent"];
  if (options["base"] !== undefined) chainOptions["base"] = options["base"];
  if (options["suite"] !== undefined) chainOptions["suite"] = options["suite"];

  return runChain(chain, ctx, chainOptions);
}
