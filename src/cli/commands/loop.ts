/**
 * `spf loop <chain> "<goal>" --until-suite <name> --max N` — the wiring half
 * of `core/loop.ts` (which owns the driver, the ledger, and the breakers):
 * config, the issue fetch for `--issue`, the per-iteration `runChain`
 * dispatch, the sqlite readback, and the final table. Same split as
 * `core/fanout.ts` / `cli/commands/fanout.ts` for the same reason — `core/`
 * stays out of `src/chains/`'s dependency direction, so the driver is
 * testable with no chains, no agents, no real git.
 *
 * `--issue <id>` resolves the SAME `IssueProvider` `spf watch` does
 * (`resolveIssueProvider`, exported from `watch.ts` for exactly this reuse)
 * and builds the goal prompt the same way `core/watch.ts`'s `runIssue` does
 * — `${issue.title}\n\n${issue.body}`.trim() — so a ticket-pointed loop and
 * a hand-typed one share one prompt convention. This is deliberately the
 * ONLY thing `--issue` does: it does not claim, label, or comment on the
 * issue, and no daemon watches it. Filing the goal AS a ticket the daemon
 * picks up on its own is a different, larger feature (a `goal-ready` watch
 * lane) that needs its own crash-safe marker schema and is not this.
 */
import { existsSync } from "node:fs";
import type { SFConfig } from "../../core/data_types.ts";
import * as agents from "../../core/agents.ts";
import * as paths from "../../core/paths.ts";
import * as quality from "../../core/quality.ts";
import { makeGit } from "../../core/git_helper.ts";
import {
  cumulativeSpend,
  resolveGoalId,
  runLoop,
  summarize,
  type IterationResult,
  type StopCondition,
} from "../../core/loop.ts";
import { findChain, runChain as runChainDef } from "../../chains/index.ts";
import type { ChainContext } from "../../chains/context.ts";
import { SfDb } from "../../ui/server/db.ts";
import { parseCli, resolvePrompt } from "../../core/utils.ts";
import { isInteractive } from "../ask.ts";
import { resolveIssueProvider } from "./watch.ts";

/**
 * Just enough of `Run` for `quality.resolveSuite`/`runSuite` (`RunLike` in
 * `core/quality.ts`) to work against a real filesystem/console without a
 * full agent-capable `Run` — this driver never opens an agent phase itself
 * (`runChainDef` already did, inside the chain), it only needs to run one
 * more deterministic check afterward. `phases: [{seq: 0, ...}]` gives
 * `checkDir`'s `run.phases[run.phases.length - 1].seq` something real to
 * read, mirroring a genuine single-phase run rather than faking the type.
 */
function qualityRunLike(input: { cfg: SFConfig; repoRoot: string; contextHandoffDir: string; adwId: string }): quality.RunLike {
  return {
    cfg: { quality: input.cfg.quality },
    phases: [{ phase_id: `${input.adwId}_00_loop_stop`, adw_id: input.adwId, seq: 0, params: { name: "loop_stop", kind: "code", owner: "quality", description: "loop stop check", retries: 0 }, status: "running", attempt: 0 }],
    context_handoff_dir: input.contextHandoffDir,
    repo_root: input.repoRoot,
    console: { note: (message: string) => console.log(`[spf] loop    ${message}`) },
    tracer: { event: () => "" },
    adw_id: input.adwId,
  };
}

const KNOWN_OPTIONS = ["config", "cwd", "issue", "until-suite", "max", "max-cost", "max-tokens", "stuck-after", "min-interval-ms", "goal-id", "base"];

export const USAGE =
  `usage: spf loop <chain> "<goal or path/to/goal.md>" --until-suite <name> --max <N> [--issue <id>] ` +
  `[--max-cost <usd>] [--max-tokens <n>] [--stuck-after <n>=3] [--min-interval-ms <n>=0] [--goal-id <id>] ` +
  `[--config <path>] [--cwd <dir>] [--base <ref>]\n` +
  `A goal cannot be judged by pixels in v1 — --until-suite names a quality.suites check (exit code = met), never a raw shell string.`;

/** `<title>\n\n<body>` — the exact prompt convention `core/watch.ts`'s `runIssue` uses, so a ticket-pointed loop and the build lane read a ticket identically. */
function promptFromIssue(issue: { title: string; body: string }): string {
  return `${issue.title}\n\n${issue.body}`.trim();
}

export async function loopCommand(argv: string[]): Promise<number> {
  const { positionals, options } = parseCli(argv, KNOWN_OPTIONS);
  if (positionals.length < 1) {
    console.error(USAGE);
    return 1;
  }
  const [chainName, promptArg] = positionals;
  if (!options["until-suite"]) {
    console.error(`--until-suite is required — name a quality.suites check whose exit code decides when the goal is met.\n${USAGE}`);
    return 1;
  }
  if (!options["max"]) {
    console.error(`--max is required — an outer iteration is a whole chain run, so there is no safe default.\n${USAGE}`);
    return 1;
  }
  const max = Number.parseInt(options["max"], 10);
  if (!Number.isInteger(max) || max < 1) {
    console.error(`--max must be a positive integer (got ${JSON.stringify(options["max"])})`);
    return 1;
  }
  if (promptArg === undefined && !options["issue"]) {
    console.error(`a goal is required — either a prompt/path positional, or --issue <id>.\n${USAGE}`);
    return 1;
  }
  if (promptArg !== undefined && options["issue"]) {
    console.error(`pass a goal OR --issue <id>, not both`);
    return 1;
  }

  const chain = findChain(chainName);
  if (!chain) {
    console.error(`unknown chain: ${chainName} — run \`spf list\` to see every chain`);
    return 1;
  }

  const anchor = paths.resolveAnchor(options["cwd"]);
  const configPaths = paths.resolveConfigPaths(anchor, options["config"]).paths;
  const cfg = agents.loadConfig(configPaths);
  const dataPaths = paths.resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db);

  let goal: string;
  if (options["issue"]) {
    const provider = resolveIssueProvider(cfg);
    if (!provider) return 1;
    const issue = await provider.getIssue(options["issue"]);
    if (!issue) {
      console.error(`issue ${options["issue"]} not found`);
      return 1;
    }
    goal = promptFromIssue(issue);
  } else {
    goal = resolvePrompt(promptArg!);
  }

  const stop: StopCondition = { kind: "script", suite: options["until-suite"] };
  // Fail fast on an unconfigured suite BEFORE minting a ledger or spending
  // anything — the same "before any check runs, let alone any agent spawns"
  // discipline `quality.resolveSuite` documents for itself.
  try {
    quality.resolveSuite(qualityRunLike({ cfg, repoRoot: anchor.repo_root, contextHandoffDir: dataPaths.sessions_dir, adwId: "preflight" }), stop.suite);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const maxCost = options["max-cost"] ? Number.parseFloat(options["max-cost"]) : undefined;
  const maxTokens = options["max-tokens"] ? Number.parseInt(options["max-tokens"], 10) : undefined;
  const stuckAfter = options["stuck-after"] ? Number.parseInt(options["stuck-after"], 10) : 3;
  const minIntervalMs = options["min-interval-ms"] ? Number.parseInt(options["min-interval-ms"], 10) : 0;
  const goalId = resolveGoalId(options["goal-id"]);

  const runIteration = async (iteration: { index: number; adw_id: string; prompt: string }): Promise<IterationResult> => {
    const ctx: ChainContext = {
      prompt: iteration.prompt,
      config_paths: configPaths,
      adw_id: iteration.adw_id,
      cwd: anchor.cwd,
      chain_name: chain.name,
      // Nobody is at a TTY for iteration 2 of N — same reasoning `fanout.ts`
      // gives for its own per-attempt runs.
      unattended: true,
      chain_source: chain.source,
    };
    const chainOptions: Record<string, string> = {};
    if (options["base"] !== undefined) chainOptions["base"] = options["base"];

    let exitCode: number | null = null;
    let error: string | null = null;
    try {
      exitCode = await runChainDef(chain, ctx, chainOptions);
    } catch (caught) {
      error = (caught as Error).message;
    }

    // Read back tokens/cost/gates by adw_id regardless of outcome — the
    // same "never throw, rank as zero" discipline `fanout.ts`'s own
    // `readMetrics` uses, since these numbers are for the ledger's spend
    // total, not for deciding correctness.
    let tokens = 0;
    let cost = 0;
    if (existsSync(dataPaths.db_path)) {
      const db = new SfDb(dataPaths.db_path);
      try {
        const session = db.session(iteration.adw_id);
        tokens = session?.total_tokens ?? 0;
        cost = session?.total_cost ?? 0;
      } finally {
        db.close();
      }
    }

    let commitSha: string | null = null;
    let stopVerdict = null as IterationResult["stop_verdict"];
    if (exitCode === 0 && error === null) {
      const git = makeGit(anchor.repo_root);
      commitSha = git.shortSha();
      const result = quality.runSuite(
        qualityRunLike({ cfg, repoRoot: anchor.repo_root, contextHandoffDir: dataPaths.sessions_dir, adwId: iteration.adw_id }),
        stop.suite,
      );
      stopVerdict = { passed: result.passed, failures: result.failures, artifacts: result.artifacts };
    }

    return { exit_code: exitCode, error, commit_sha: commitSha, tokens, cost, stop_verdict: stopVerdict };
  };

  const result = await runLoop({
    chainName: chain.name,
    goal,
    stop,
    max,
    budget: { maxCost, maxTokens },
    stuckAfter,
    minIntervalMs,
    dataDir: dataPaths.data_dir,
    goalId,
    runIteration,
    log: (message) => console.log(`[spf] ${message}`),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });

  console.log(`\n${summarize(result)}`);
  const spend = cumulativeSpend(result.ledger.attempts);
  if (isInteractive() && result.ledger.attempts.length > 0) {
    console.log(`  ${result.ledger.attempts.length} attempt(s), $${spend.cost.toFixed(4)}`);
  }
  return result.exitCode;
}
