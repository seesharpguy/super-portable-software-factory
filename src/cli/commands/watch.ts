/**
 * `spf watch` — poll a `watch.repo` for issues labeled `<prefix>:ready`,
 * run `watch.chain` against each in its own git worktree, open a PR, and
 * track it through to merged/blocked. See `src/core/watch.ts` for the
 * actual state machine; this file is just the wiring: config, the GitHub
 * provider, the chain-dispatch callback, the lockfile, and the CLI loop.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as agents from "../../core/agents.ts";
import * as paths from "../../core/paths.ts";
import { isRepoAt, makeGit } from "../../core/git_helper.ts";
import { GitHubProvider } from "../../core/issues/github_provider.ts";
import type { IssueProvider } from "../../core/issues/provider.ts";
import { createWatchState, tick, type ChainRunResult, type WatchDeps } from "../../core/watch.ts";
import { findChain } from "../../chains/index.ts";
import type { ChainContext } from "../../chains/context.ts";
import type { SFConfig } from "../../core/data_types.ts";
import { SfDb } from "../../ui/server/db.ts";
import { parseCli } from "../../core/utils.ts";

/**
 * Shared by `watch` and `watch init`: resolve config and build the
 * provider, checking only what BOTH need — a supported provider, a
 * non-empty `watch.repo`, and `GITHUB_TOKEN`. `watch`'s own extra checks
 * (a real git repo, a registered chain) don't apply to seeding labels.
 * Prints its own error and returns `null` on failure — the caller just
 * needs to `return 1`.
 */
function resolveWatchProvider(cfg: SFConfig): IssueProvider | null {
  if (cfg.watch.provider !== "github") {
    console.error(`watch.provider ${JSON.stringify(cfg.watch.provider)} is not supported`);
    return null;
  }
  if (!cfg.watch.repo.trim()) {
    console.error(`watch.repo is not configured — add it to spf.config.yaml's watch: section, e.g. "owner/name"`);
    return null;
  }
  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    console.error("GITHUB_TOKEN is not set — spf watch needs a classic PAT with repo scope");
    return null;
  }
  return new GitHubProvider(cfg.watch.repo, cfg.watch.label_prefix, token);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stale-steal, like the reference implementation's daemon lock: a dead pid never blocks a restart. */
function acquireLock(lockPath: string): void {
  if (existsSync(lockPath)) {
    const pid = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    if (Number.isInteger(pid) && isPidAlive(pid)) {
      throw new Error(`another \`spf watch\` is already running (pid ${pid}) — lock at ${lockPath}`);
    }
  }
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, String(process.pid));
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone — fine
  }
}

/**
 * `spf watch init` — idempotently seed the `<prefix>:*` labels the state
 * machine needs, with sensible colors/descriptions. Doesn't touch git or
 * run anything, so it skips watchCommand's repo/chain checks entirely —
 * you can seed labels before ever wiring up a worktree-capable checkout.
 */
export async function watchInitCommand(argv: string[]): Promise<number> {
  const { options } = parseCli(argv, ["cwd", "config"], []);
  const anchor = paths.resolveAnchor(options["cwd"]);
  const cfg = agents.loadConfig(paths.resolveConfigPaths(anchor, options["config"]).paths);

  const provider = resolveWatchProvider(cfg);
  if (!provider) return 1;

  const result = await provider.ensureLabels();
  console.log(`spf watch init: ${cfg.watch.repo} (label prefix "${cfg.watch.label_prefix}")`);
  for (const name of result.created) console.log(`  + ${name} (created)`);
  for (const name of result.updated) console.log(`  ~ ${name} (updated color/description)`);
  for (const name of result.unchanged) console.log(`  = ${name} (already correct)`);
  return 0;
}

export async function watchCommand(argv: string[]): Promise<number> {
  const { options, flags } = parseCli(argv, ["cwd", "config"], ["dry-run", "once"]);
  const anchor = paths.resolveAnchor(options["cwd"]);
  const configPaths = paths.resolveConfigPaths(anchor, options["config"]).paths;
  const cfg = agents.loadConfig(configPaths);

  const provider = resolveWatchProvider(cfg);
  if (!provider) return 1;
  if (!isRepoAt(anchor.repo_root)) {
    console.error(`${anchor.repo_root} is not a git repository`);
    return 1;
  }
  if (!findChain(cfg.watch.chain)) {
    console.error(`watch.chain ${JSON.stringify(cfg.watch.chain)} is not a registered chain — run \`spf list\` to see every chain`);
    return 1;
  }

  const dataPaths = paths.resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db);
  const lockPath = path.join(dataPaths.data_dir, "watch.lock");
  try {
    acquireLock(lockPath);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }

  const git = makeGit(anchor.repo_root);
  const worktreesDir = path.join(homedir(), ".spf", "watch", path.basename(anchor.repo_root), "worktrees");
  mkdirSync(worktreesDir, { recursive: true });

  const runChain = async (opts: { prompt: string; cwd: string; adwId: string }): Promise<ChainRunResult> => {
    const chainDef = findChain(cfg.watch.chain)!; // checked above
    const ctx: ChainContext = { prompt: opts.prompt, config_paths: configPaths, adw_id: opts.adwId, cwd: opts.cwd };
    const code = await chainDef.run(ctx);
    if (code === 0) return { accepted: true, adwId: opts.adwId, detail: "" };

    let detail = `Chain "${cfg.watch.chain}" (adw_id ${opts.adwId}) did not complete successfully. Run \`spf phases ${opts.adwId} --cwd ${opts.cwd}\` for detail.`;
    try {
      const wtAnchor = paths.resolveAnchor(opts.cwd);
      const wtDataPaths = paths.resolveDataPaths(wtAnchor, cfg.defaults.data_dir, cfg.observability.db);
      const db = new SfDb(wtDataPaths.db_path);
      const failed = db.phases(opts.adwId).find((p) => p.status === "fail");
      if (failed) detail += ` Phase "${failed.name}" failed: ${failed.error ?? "(no detail)"}`;
    } catch {
      // best-effort — the generic message above still points at where to look
    }
    return { accepted: false, adwId: opts.adwId, detail };
  };

  const deps: WatchDeps = {
    provider,
    git,
    worktreeGit: makeGit,
    labelPrefix: cfg.watch.label_prefix,
    chain: cfg.watch.chain,
    baseBranch: cfg.watch.base_branch,
    concurrency: cfg.watch.concurrency,
    worktreesDir,
    dryRun: Boolean(flags["dry-run"]),
    runChain,
    log: (message) => console.log(message),
  };

  const state = createWatchState();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(
    `[spf] watch     ${cfg.watch.repo}  label "${cfg.watch.label_prefix}:*"  chain "${cfg.watch.chain}"  concurrency ${cfg.watch.concurrency}${flags["dry-run"] ? "  (dry run)" : ""}`,
  );

  try {
    for (;;) {
      await tick(deps, state);
      if (flags["once"] || stopping) break;
      await sleep(cfg.watch.poll_ms);
    }
    while (state.inflight.size > 0) {
      console.log(`[spf] watch     draining ${state.inflight.size} in-flight issue(s)...`);
      await sleep(1000);
    }
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    releaseLock(lockPath);
  }
}
