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
import { createWatchState, tick, type ChainRunResult, type WatchDeps } from "../../core/watch.ts";
import { findChain } from "../../chains/index.ts";
import type { ChainContext } from "../../chains/context.ts";
import { SfDb } from "../../ui/server/db.ts";
import { parseCli } from "../../core/utils.ts";

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

export async function watchCommand(argv: string[]): Promise<number> {
  const { options, flags } = parseCli(argv, ["cwd", "config"], ["dry-run", "once"]);
  const anchor = paths.resolveAnchor(options["cwd"]);
  const configPaths = paths.resolveConfigPaths(anchor, options["config"]).paths;
  const cfg = agents.loadConfig(configPaths);

  if (cfg.watch.provider !== "github") {
    console.error(`watch.provider ${JSON.stringify(cfg.watch.provider)} is not supported`);
    return 1;
  }
  if (!cfg.watch.repo.trim()) {
    console.error(`watch.repo is not configured — add it to spf.config.yaml's watch: section, e.g. "owner/name"`);
    return 1;
  }
  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    console.error("GITHUB_TOKEN is not set — spf watch needs a classic PAT with repo scope");
    return 1;
  }
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

  const provider = new GitHubProvider(cfg.watch.repo, cfg.watch.label_prefix, token);
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
