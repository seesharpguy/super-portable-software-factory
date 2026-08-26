/** Shared by both `spf <chain> "..."` and `spf run <chain> "..."` — same dispatch. */
import * as paths from "../../core/paths.ts";
import * as agents from "../../core/agents.ts";
import { newId, parseCli, resolvePrompt } from "../../core/utils.ts";
import { withRunScope } from "../../core/sandbox.ts";
import { runChain, type ChainDefinition } from "../../chains/index.ts";
import type { ChainContext } from "../../chains/context.ts";
import { isInteractive } from "../ask.ts";

const KNOWN_OPTIONS = ["config", "adw-id", "cwd", "agent", "base", "issue", "suite", "priority"];

export function usageFor(chain: ChainDefinition): string {
  return `usage: spf ${chain.name} "<prompt or path/to/prompt.md>" [--config <path>] [--adw-id <id>] [--cwd <dir>] [--suite <name>] [--priority p0|p1|p2|p3]`;
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
  // Minted here, not left null-and-minted-later inside session.ensure — a
  // sandbox lease is keyed on `<adw_id>/<agent>` (design §4.3) and
  // `withRunScope` below needs the SAME id up front to know which leases
  // this run's `finally` must tear down.
  const adwId = options["adw-id"] ?? newId(8);
  const ctx: ChainContext = {
    prompt: resolvePrompt(positionals[0]),
    config_paths: paths.resolveConfigPaths(anchor, options["config"]).paths,
    adw_id: adwId,
    cwd: anchor.cwd,
    chain_name: chain.name,
    // Only `refine` reads this (a "## Parent: #<id>" back-reference on
    // every issue it creates — see ChainContext's doc comment); every
    // other chain ignores it, so it's harmless to always pass through.
    issue_id: options["issue"] ?? null,
    // A real TTY (isInteractive(), from cli/ask.ts) is the one case an
    // agent step could plausibly block on a human — everything else (a CI
    // run, a piped `spf <chain>`, spf watch's own dispatch) is unattended.
    // Read by `simple_sdlc.ts`'s sign-off phase (`isInteractive() &&
    // !ctx.unattended`, folded into `canPrompt`) — see `decideSignoff`.
    unattended: !isInteractive(),
    // `undefined` for every built-in chain (ChainDefinition.source is only
    // ever set for a chain loaded from `.spf/chains/*.yaml` — see
    // chains/repo_chains.ts) — passed through unconditionally since a
    // `string | undefined` field is exactly what ChainContext declares.
    chain_source: chain.source,
  };

  const chainOptions: Record<string, string> = {};
  if (options["agent"] !== undefined) chainOptions["agent"] = options["agent"];
  if (options["base"] !== undefined) chainOptions["base"] = options["base"];
  if (options["suite"] !== undefined) chainOptions["suite"] = options["suite"];
  // Only `refine`'s `publishIssues()` step reads this (a ceiling clamped
  // onto every node it creates — see `core/refine.ts`'s `publish()`); every
  // other chain ignores it, so it's harmless to always pass through, same
  // as `issue` above. `publishIssues()` itself validates the value —
  // rejecting anything but p0|p1|p2|p3 — so this stays a plain passthrough.
  if (options["priority"] !== undefined) chainOptions["priority"] = options["priority"];

  // A live dashboard only ever makes sense for the one dispatch a human is
  // actually watching — `spf watch`'s per-issue runs and `spf fanout`'s
  // per-attempt runs go through `runChain`/`startRun` directly, never this
  // function, so they're untouched. Loaded here (not left to `startRun`'s
  // own `loadConfig` call moments later) purely to read the ceilings the
  // dashboard displays — a second, cheap parse of the same small YAML, not
  // a second source of truth: `startRun` still owns the real, validated
  // config the run actually executes against.
  if (isInteractive()) {
    const { mountRunDashboard } = await import("../ui/run_dashboard.tsx");
    const cfg = agents.loadConfig(ctx.config_paths);
    const dashboard = mountRunDashboard({ maxCost: cfg.defaults.max_run_cost, maxTokens: cfg.defaults.max_run_tokens });
    ctx.render_hooks = { sink: dashboard.sink, observer: dashboard.observer, pause: dashboard.pause, resume: dashboard.resume };
    try {
      // Same withRunScope as the unattended path below — an interactive
      // dispatch is just as capable of opening a sandbox lease (design
      // §4.3), and skipping this here would leak it silently since nothing
      // else in this branch calls teardownRun.
      return await withRunScope(adwId, () => runChain(chain, ctx, chainOptions));
    } finally {
      await dashboard.close();
    }
  }

  return withRunScope(adwId, () => runChain(chain, ctx, chainOptions));
}
