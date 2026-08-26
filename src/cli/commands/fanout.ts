/**
 * `spf fanout <chain> "<prompt>" --n 3` — best-of-N, disposed by code.
 *
 * The wiring half of `core/fanout.ts` (which holds the mechanism and the
 * selection basis): config, the chain-dispatch callback, the data-dir symlink,
 * the SQLite metrics read, and the result table. Same split as
 * `core/watch.ts` / `cli/commands/watch.ts`, for the same reason — `core/`
 * stays out of `src/chains/`'s dependency direction, so the fan-out mechanism
 * is testable with no chains, no agents and no real git.
 *
 * A REAL SUBCOMMAND, NOT A `--best-of` FLAG ON `run`. Fan-out is a different
 * verb: it creates N branches and N worktrees, keeps one, and deletes the
 * rest. Hiding that behind a flag on `spf run` would make an ordinary run
 * silently capable of deleting branches, and would have to answer what
 * `--adw-id` even means when there are N of them. `run.ts` is untouched.
 *
 * SPF DOES NOT MERGE THE WINNER. It hands back a branch name, an adw_id and
 * the basis on which that branch was chosen; a human merges or cherry-picks
 * it. That is the accountability line this command must not cross — every
 * other route (auto-merge, auto-push) removes the one human decision that
 * makes N machine-written candidates safe to have produced at all.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as agents from "../../core/agents.ts";
import * as paths from "../../core/paths.ts";
import { isRepoAt, makeGit } from "../../core/git_helper.ts";
import {
  ABORTED_EXIT,
  attemptAdwId,
  runBestOf,
  ZERO_METRICS,
  type AttemptDispatch,
  type AttemptMetrics,
  type FanoutAttempt,
} from "../../core/fanout.ts";
import { findChain, hasCommitStep, runChain as runChainDef } from "../../chains/index.ts";
import type { ChainContext } from "../../chains/context.ts";
import { withRunScope } from "../../core/sandbox.ts";
import { excludeSpfDataFromGit } from "../../core/worktree_data.ts";
import { SfDb } from "../../ui/server/db.ts";
import { newId, parseCli, resolvePrompt } from "../../core/utils.ts";
import { isInteractive } from "../ask.ts";
import type { FanoutDashboard } from "../ui/fanout_dashboard.tsx";

/**
 * A ceiling on `--n`, not a recommendation. Each attempt is a full chain run
 * with its own agents, so `--n` multiplies spend directly — and the machine
 * also pays in worktrees, concurrent SQLite writers and disk. Anyone who
 * genuinely wants more than this should be running a script that says so out
 * loud, not typing a bigger number into an interactive command.
 */
const MAX_N = 8;

const USAGE =
  `usage: spf fanout <chain> "<prompt or path/to/prompt.md>" [--n 3] [--concurrency N] ` +
  `[--base <branch>] [--adw-id <id>] [--first-success] [--config <path>] [--cwd <dir>]\n` +
  `       spf fanout --clean <base-adw-id> [--cwd <dir>]   # remove leftover worktrees/branches from a killed or discarded run`;

/** `42.1s` / `3m 07s` — a wall time a human reads, not a millisecond count. */
function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds - minutes * 60)).padStart(2, "0")}s`;
}

function formatGates(attempt: FanoutAttempt): string {
  if (attempt.status === "skipped") return "-";
  return `${attempt.gate_passes}p/${attempt.gate_failures}f`;
}

/**
 * The result table. Fixed column widths over a `console.table`: every other
 * `spf` listing (`sessions`, `phases`) prints plain padded columns, and this
 * output is read in a terminal beside them. On a TTY, routes through the
 * same `renderTable()` (`cli/ui/reports.tsx`) those two now use instead —
 * `fanout_cli.test.ts` runs with no TTY, so it keeps exercising this exact
 * plain-text path unchanged.
 */
async function printTable(attempts: FanoutAttempt[]): Promise<void> {
  const rows = attempts.map((a) => [
    String(a.index),
    a.adw_id,
    a.branch,
    a.status,
    formatGates(a),
    agents.formatUsd(a.cost),
    a.status === "skipped" ? "-" : formatDuration(a.wall_ms),
  ]);
  if (isInteractive()) {
    const { renderTable } = await import("../ui/reports.tsx");
    await renderTable(
      [["#", "adw_id", "branch", "status", "gates", "cost", "time"], ...rows],
      { rowColor: (i) => (i > 0 && attempts[i - 1]!.status === "fail" ? "red" : undefined) },
    );
    for (const a of attempts) {
      if (a.error) console.log(`      error: ${a.error}`);
    }
    return;
  }
  const widths = {
    adw: Math.max(6, ...attempts.map((a) => a.adw_id.length)),
    branch: Math.max(6, ...attempts.map((a) => a.branch.length)),
  };
  console.log(
    `  ${"#".padEnd(3)}${"adw_id".padEnd(widths.adw + 2)}${"branch".padEnd(widths.branch + 2)}` +
      `${"status".padEnd(9)}${"gates".padEnd(9)}${"cost".padEnd(10)}time`,
  );
  for (const a of attempts) {
    console.log(
      `  ${String(a.index).padEnd(3)}${a.adw_id.padEnd(widths.adw + 2)}${a.branch.padEnd(widths.branch + 2)}` +
        `${a.status.padEnd(9)}${formatGates(a).padEnd(9)}${agents.formatUsd(a.cost).padEnd(10)}` +
        `${a.status === "skipped" ? "-" : formatDuration(a.wall_ms)}` +
        `${a.error ? `\n      error: ${a.error}` : ""}`,
    );
  }
}

/**
 * Wire `<worktreePath>/.spf/data` to the main repo's `dataDir` — same
 * purpose as `cli/commands/watch.ts`'s own `linkDataDir`: without it an
 * attempt's chain resolves its session/trace data relative to `cwd` (its
 * worktree) and writes into a fresh `.spf/data` that dies with the
 * worktree — invisible in `spf ui`, and gone before `readMetrics` could even
 * read the gate rows that DECIDE the winner. Symlinking it to the main
 * repo's data dir is what makes the shared WAL SQLite the one place all N
 * attempts report to (`tracer.ts`'s WAL + `busy_timeout=5000` is exactly
 * what concurrent writers through this symlink already rely on under `spf
 * watch`). Idempotent. A plain function of its two inputs (not a closure
 * over `dataPaths`) so it can be exercised directly in a test, against a
 * real filesystem and a real git worktree, without a real chain or agent.
 *
 * `mkdirSync(dataDir, ...)` BEFORE the symlink is not optional: a fresh
 * clone with `.spf/` committed (`.spf/data` gitignored), or a repo straight
 * out of `spf init` (which seeds `.spf/` and `.spf/chains/` but never
 * `.spf/data` — nothing has traced a run there yet) has no `.spf/data` to
 * point at. Without this, the symlink is dangling and every attempt's `Run`
 * constructor fails its own `ensureDir` on first use — `spf fanout` would be
 * broken on a repo's first ever run.
 */
export function linkFanoutDataDir(worktreePath: string, dataDir: string): void {
  const target = path.join(worktreePath, ".spf", "data");
  if (!existsSync(target)) {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(dataDir, target, "dir");
  }
  excludeSpfDataFromGit(worktreePath);
}

/**
 * Re-exported so existing callers (`src/test/fanout_cli.test.ts`,
 * `src/test/sandbox_fanout.test.ts`) keep compiling with no edit — the
 * function itself moved to `core/worktree_data.ts` (§6.6) so
 * `cli/commands/watch.ts`'s own `linkDataDir` can call it too without
 * importing this command module.
 */
export { excludeSpfDataFromGit };

/**
 * `spf fanout --clean <base-adw-id>` — the cleanup half of the deterministic
 * naming, for the two cases nothing else reaches: a run killed before its
 * own `finally`s ran (SIGINT swallowed by a synchronous `spawnSync` phase, or
 * `process.exit()` racing worktree cleanup — see `core/fanout.ts`'s lack of
 * a cancellation seam), and a winner an operator has since merged/rejected
 * and now wants gone. Matches by PREFIX rather than an index range: `--n`
 * varies run to run, and a killed run may have left an arbitrary subset.
 * `--force` on the worktree removal is deliberate and irreversible — this is
 * explicitly a "the trees are trash now" command, unlike a normal run's own
 * cleanup, which never force-removes a dirty tree it didn't already decide
 * to discard (see `git_helper.ts`'s `createRunWorktree`).
 *
 * Scans BOTH `~/.spf/fanout/<basename>/worktrees` (this command's own attempt
 * trees) AND `~/.spf/watch/<basename>/worktrees` (`spf watch`'s fan-out lane,
 * `watch.fanout.n > 1` — see `core/watch.ts`'s design doc): the attempt naming
 * scheme (`fanout-<base>-<i>` / `spf/fanout/<base>-<i>`) is identical either
 * way, watch's automatic pre-sweep only ever reaches an issue it re-claims,
 * and an issue `reconcileOrphans` gave up on permanently is never claimed
 * again — so its attempt trees, and a §8.7 salt cap-fallback base's debris
 * (whose random suffix the pre-sweep cannot enumerate by construction), have
 * no other operator-facing cleanup tool.
 */
function cleanFanoutAttempts(baseAdwId: string, cwdOpt: string | undefined): number {
  const anchor = paths.resolveAnchor(cwdOpt);
  if (!isRepoAt(anchor.repo_root)) {
    console.error(`${anchor.repo_root} is not a git repository`);
    return 1;
  }
  const worktreesDirs = [
    path.join(homedir(), ".spf", "fanout", path.basename(anchor.repo_root), "worktrees"),
    path.join(homedir(), ".spf", "watch", path.basename(anchor.repo_root), "worktrees"),
  ];
  const git = makeGit(anchor.repo_root);
  let removed = 0;

  for (const worktreesDir of worktreesDirs) {
    if (!existsSync(worktreesDir)) continue;
    for (const entry of readdirSync(worktreesDir)) {
      if (!entry.startsWith(`fanout-${baseAdwId}-`)) continue;
      const worktreePath = path.join(worktreesDir, entry);
      spawnSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: anchor.repo_root, encoding: "utf-8" });
      console.log(`[spf] fanout    removed worktree ${worktreePath}`);
      removed++;
    }
  }

  const branchList = spawnSync("git", ["branch", "--list", `spf/fanout/${baseAdwId}-*`], {
    cwd: anchor.repo_root,
    encoding: "utf-8",
  });
  for (const line of (branchList.stdout || "").split("\n")) {
    const branch = line.replace(/^\*?\s+/, "").trim();
    if (!branch) continue;
    git.deleteLocalBranch(branch);
    console.log(`[spf] fanout    deleted branch ${branch}`);
    removed++;
  }

  if (removed === 0) {
    console.log(`[spf] fanout    nothing to clean for ${baseAdwId} — no worktree or branch under that base id`);
  }
  return 0;
}

export async function fanoutCommand(argv: string[]): Promise<number> {
  const { positionals, options, flags } = parseCli(
    argv,
    ["cwd", "config", "n", "concurrency", "base", "adw-id", "clean"],
    ["first-success"],
  );

  if (options["clean"]) {
    return cleanFanoutAttempts(options["clean"], options["cwd"]);
  }

  if (positionals.length < 2) {
    console.error(USAGE);
    return 1;
  }
  const [chainName, promptArg] = positionals;

  const chain = findChain(chainName);
  if (!chain) {
    console.error(`unknown chain: ${chainName} — run \`spf list\` to see every chain`);
    return 1;
  }
  if (!hasCommitStep(chain.phases)) {
    // A winner with no commit step leaves its payload ONLY as uncommitted
    // edits in the kept worktree — the branch this command hands back would
    // carry zero commits, so `git merge`/`git cherry-pick` would be a no-op,
    // and the printed `git worktree remove` cleanup line would DESTROY the
    // only copy of the work. Refuse up front rather than print a lie.
    console.error(
      `spf fanout: "${chain.name}" has no commit phase (${chain.phases}) — its winner's branch would carry zero ` +
        `commits, and the work would exist only as uncommitted edits in a worktree that "git worktree remove" ` +
        `would then destroy. Use a chain that commits (e.g. plan-build, plan-build-test, ` +
        `plan-build-test-quality, simple-sdlc), or a repo-local chain (.spf/chains/*.yaml) with a commit step.`,
    );
    return 1;
  }

  const n = options["n"] ? Number.parseInt(options["n"], 10) : 3;
  if (!Number.isInteger(n) || n < 2 || n > MAX_N) {
    console.error(`--n must be an integer between 2 and ${MAX_N} (got ${JSON.stringify(options["n"] ?? "3")}) — for a single run use \`spf run ${chainName}\``);
    return 1;
  }

  const anchor = paths.resolveAnchor(options["cwd"]);
  if (!isRepoAt(anchor.repo_root)) {
    // Not a nicety: every attempt IS a git worktree off a base branch. Without
    // a repo there is nothing to isolate runs from each other with, and the
    // "winner is a branch a human merges" contract has nothing to hand back.
    console.error(`${anchor.repo_root} is not a git repository — spf fanout runs each attempt in its own git worktree`);
    return 1;
  }

  const configPaths = paths.resolveConfigPaths(anchor, options["config"]).paths;
  const cfg = agents.loadConfig(configPaths);
  const dataPaths = paths.resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db);
  const git = makeGit(anchor.repo_root);

  // Reused rather than given a knob of its own: `watch.fanout.concurrency`
  // (default 2) is already this repo's answer to "how many ATTEMPTS of one
  // prompt may run at once" — the exact thing `--concurrency` controls here —
  // and it is the same machine, the same SQLite and the same agent quota
  // either way. NOT `watch.concurrency`, which counts ISSUES in flight under
  // `spf watch` and means something different (see `WatchFanoutConfigSchema`'s
  // doc comment). `--concurrency` overrides it for one invocation.
  const concurrency = options["concurrency"] ? Number.parseInt(options["concurrency"], 10) : cfg.watch.fanout.concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    console.error(`--concurrency must be a positive integer (got ${JSON.stringify(options["concurrency"])})`);
    return 1;
  }

  const baseBranch = options["base"] ?? cfg.watch.base_branch;
  const baseAdwId = options["adw-id"] ?? newId(8);
  const worktreesDir = path.join(homedir(), ".spf", "fanout", path.basename(anchor.repo_root), "worktrees");

  // Fail fast on a `--adw-id` reused from a previous fanout invocation.
  // `readMetrics` (below) keys purely on adw_id, and `tracer.sessionStart`
  // upserts an EXISTING session row (`status='running'`) while
  // `sessionAddUsage` ACCUMULATES onto it — so a collision would silently mix
  // the previous run's cost/tokens/gate rows into this run's selection
  // basis, and the human reading `basis:` would be told a wrong reason.
  if (existsSync(dataPaths.db_path)) {
    const preflight = new SfDb(dataPaths.db_path);
    try {
      const collisions = Array.from({ length: n }, (_, i) => attemptAdwId(baseAdwId, i + 1)).filter(
        (id) => preflight.session(id) !== null,
      );
      if (collisions.length > 0) {
        console.error(
          `--adw-id ${baseAdwId} already has session rows for ${collisions.join(", ")} from a previous fanout ` +
            `run — reusing it would mix that run's cost/tokens/gates into this one's selection basis. Use a ` +
            `fresh --adw-id (or omit the flag to get one generated), or \`spf fanout --clean ${baseAdwId}\` first ` +
            `if that previous run is done with.`,
        );
        return 1;
      }
    } finally {
      preflight.close();
    }
  }

  if (cfg.defaults.max_run_cost === undefined && cfg.defaults.max_run_tokens === undefined) {
    // Not an error — an unbounded run is the documented default. But `--n` is
    // a spend multiplier, and this is the one moment the operator is asking
    // for N times the bill, so it is the honest moment to mention the ceiling
    // exists. See ConfigDefaultsSchema's budget block.
    console.log(
      `[spf] fanout    no defaults.max_run_cost / defaults.max_run_tokens configured — ` +
        `${n} attempts will run to completion unbounded`,
    );
  }

  const linkDataDir = (worktreePath: string) => linkFanoutDataDir(worktreePath, dataPaths.data_dir);

  /**
   * The shared db, opened lazily and once: it does not exist until the first
   * attempt's tracer creates it, and `SfDb`'s constructor throws on a missing
   * file. Readonly + WAL, so reading one finished attempt's rows while its
   * siblings are still writing is exactly the access pattern the tracer's
   * PRAGMAs are set up for.
   */
  // A holder rather than a bare `let`: assigned only inside the closure below,
  // a plain local narrows to `null` everywhere else and the `finally`'s
  // `close()` stops typechecking.
  const held: { db: SfDb | null } = { db: null };
  function readMetrics(adwId: string): AttemptMetrics {
    if (!held.db) {
      if (!existsSync(dataPaths.db_path)) return ZERO_METRICS;
      held.db = new SfDb(dataPaths.db_path);
    }
    const gates = held.db.gates(adwId);
    const session = held.db.session(adwId);
    // `passed` is a SQLite integer boolean that CAN be NULL on a row an older
    // tracer wrote. Counted explicitly in both directions, never as
    // `!g.passed`: a NULL is unknown, and letting it read as a failure would
    // let a garbled row decide which candidate a human is told to merge.
    return {
      gate_passes: gates.filter((g) => g.passed === 1).length,
      gate_failures: gates.filter((g) => g.passed === 0).length,
      cost: session?.total_cost ?? 0,
      tokens: session?.total_tokens ?? 0,
    };
  }

  const runAttempt = async (dispatch: AttemptDispatch): Promise<number> => {
    // Cooperative abort, checked at the last possible moment before spend
    // begins — a sibling can win between this attempt being pulled off the
    // queue and its first agent call. See core/fanout.ts's ABORT GRANULARITY
    // note for what this does and does not cover.
    if (dispatch.isAborted()) return ABORTED_EXIT;
    const ctx: ChainContext = {
      prompt: dispatch.prompt,
      config_paths: configPaths,
      adw_id: dispatch.adwId,
      // The attempt's OWN worktree. This is the anchor `session.ensure` binds
      // the Run's repo_root to, once — which is what puts the gates,
      // permissions snapshot, quality checks and changes capture on the tree
      // these agents actually wrote in.
      cwd: dispatch.cwd,
      // Kept resolvable on purpose: this is the name `findChain` answers to,
      // and `session.ensure` records it as the session's `adw_name`. The
      // fan-out provenance rides the derived adw_id (`<base>-<i>`) and the
      // branch instead — `chain_source` is contractually the absolute path of
      // a `.spf/chains/*.yaml` file (see ChainContext), and a marker string
      // stuffed in there would lie to `spf ui` about where the chain came from.
      chain_name: chain.name,
      // Nobody is at a TTY for attempt 2 of 3 — a chain that would prompt
      // (simple-sdlc's sign-off) must take its unattended path, or N-1
      // attempts would block forever on a prompt only one of them can show.
      unattended: true,
      chain_source: chain.source,
    };
    return withRunScope(dispatch.adwId, () => runChainDef(chain, ctx));
  };

  // Best-effort operator guidance on an abnormal exit — NOT a real
  // cancellation. Every code phase runs through a synchronous `spawnSync`
  // (`core/quality.ts`), which blocks the event loop while it runs, so a
  // SIGINT delivered during one is not even observed until it returns; an
  // attempt whose chain HAS reached an async agent phase may still finalize
  // its own session via `process.exit()` (`core/session.ts`'s
  // `finalizeWhenKilled`) before this handler's log line ever flushes. What
  // this reliably buys, in the case it can't prevent, is telling the
  // operator the one thing the trace can't: which base adw_id to hand to
  // `--clean` afterwards.
  // Mounted only on a real TTY — a live results table that updates row by
  // row as each attempt settles, instead of the plain-text path's one-shot
  // table at the very end. `dashboard` (not just its presence) is read by
  // `onSignal` below, best-effort-unmounted before `process.exit()`: Ink's
  // usual cleanup (restoring cursor visibility) never gets a chance to run
  // on an abrupt exit otherwise, and this command's own SIGINT handler —
  // unlike `spf watch`'s two-stage drain — already exits immediately by
  // design (see its comment), so there's no "wait for it to finish" point
  // to hook a graceful teardown into instead.
  let dashboard: FanoutDashboard | undefined;
  if (isInteractive()) {
    const { mountFanoutDashboard } = await import("../ui/fanout_dashboard.tsx");
    dashboard = mountFanoutDashboard({ n, chainName: chain.name, baseBranch, baseAdwId });
  }

  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interrupted) return;
    interrupted = true;
    dashboard?.unmountNow(); // best-effort cursor-visibility restore — see FanoutDashboard.unmountNow's own comment for why this isn't the awaited close()
    console.error(
      `\n[spf] fanout: ${signal} received — attempts already past their last checkpoint run to completion. ` +
        `Once everything has settled, clean up anything left under this base id with:\n` +
        `  spf fanout --clean ${baseAdwId}\n`,
    );
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const result = await runBestOf({
      chainName: chain.name,
      prompt: resolvePrompt(promptArg),
      n,
      concurrency,
      baseAdwId,
      baseBranch,
      repoRoot: anchor.repo_root,
      worktreesDir,
      git,
      linkDataDir,
      runAttempt,
      readMetrics,
      firstSuccess: flags["first-success"],
      log: (message) => (dashboard ? dashboard.log(message) : console.log(`[spf] ${message}`)),
      onAttempt: dashboard?.onAttempt,
    });
    await dashboard?.close();

    // A dashboard already printed the header and kept the table live and
    // in scrollback throughout the run — printing it again here would just
    // duplicate what's already there. Only the non-TTY path needs both.
    if (!dashboard) {
      console.log(`\nfanout ${chain.name} — ${n} attempt(s), base ${baseBranch}`);
      await printTable(result.attempts);
    }

    if (!result.winner) {
      console.error(`\nno winner: ${result.basis}`);
      console.error(
        `Any attempt whose chain got far enough to open a session has its trace in the shared db — ` +
          `\`spf phases <adw_id>\` to check (an attempt that failed before then, e.g. a worktree collision, has none).`,
      );
      return 1;
    }

    console.log(`\nwinner:  ${result.winner.adw_id}  branch ${result.winner.branch}`);
    console.log(`basis:   ${result.basis}`);
    console.log(
      `         (selection basis: succeeded > fewest gate failures > most gate passes > lowest cost > ` +
        `fewest tokens > lowest wall time (contended under concurrency, last resort) > adw_id)`,
    );
    // SPF #15 PR B, design §5.5 — the one line of printed posture sandboxing
    // adds to this contract. `sandbox.fanout: "sandbox"` rides the ordinary
    // per-attempt SandboxSpec (each attempt's own worktree/adw_id — see
    // core/agents.ts's sandboxSpecFor); this line just says so, honestly:
    // the winner's WORKTREE and BRANCH are still local, no matter where the
    // attempts' agent calls ran.
    if (cfg.sandbox.fanout === "sandbox" && cfg.sandbox.backend !== "local") {
      console.log(`attempts ran in ${cfg.sandbox.backend} sandboxes; branch is local`);
    }
    console.log(`kept:    ${result.winner.worktree}`);
    console.log(`\nSPF does not merge the winner — you do:`);
    console.log(`  git merge ${result.winner.branch}          # or: git cherry-pick <sha> / git diff ${baseBranch}..${result.winner.branch}`);
    console.log(
      `  git worktree remove --force ${result.winner.worktree} && git branch -d ${result.winner.branch}   ` +
        `# when you're done with it — --force is required (the .spf/data symlink always makes the tree` +
        ` "dirty" to git) and will discard anything you haven't committed or merged out of it first`,
    );
    console.log(`The other attempts' worktrees and branches were deleted; their traces remain in the db (\`spf phases <adw_id>\`).`);
    return 0;
  } finally {
    held.db?.close();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
