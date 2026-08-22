/**
 * Low-level git operations for code phases. All low-level logic lives in core/.
 *
 * Two discovery functions (`isRepoAt`, `findRepoRoot`) take an explicit `cwd`
 * because they are how a repo root gets established in the first place —
 * nothing has one yet to bind to. Everything else is repo-root-bound: call
 * `makeGit(repoRoot)` once you have that root, and every operation it returns
 * runs there, never against `process.cwd()`. This is deliberate — the ADW
 * process's cwd and the repo it is operating on are two different things,
 * and conflating them is exactly the anchor bug this factory exists to close.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  return result.stdout.trim();
}

/** True when `cwd` is inside a git working tree. Never throws — this is a question. */
export function isRepoAt(cwd: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf-8" });
  return result.status === 0;
}

/**
 * Absolute root of the git repo containing `cwd`, or `cwd` itself if it is
 * not inside one — ADWs run fine in a non-git dir; only a commit phase
 * requires a repo. Always absolute, so it is safe to hand to a subprocess
 * regardless of where the ADW was launched from.
 *
 * `isRepoAt` only proves `git rev-parse --git-dir` succeeds, which is also
 * true inside a bare repo and inside a `.git/` directory itself — neither
 * has a work tree, so `--show-toplevel` fails there even though `isRepoAt`
 * said yes. That failure is not a bug to propagate: there is still an
 * honest answer (`cwd` itself), so it falls back rather than throwing —
 * this function's whole contract is "never throws, always returns some root."
 */
export function findRepoRoot(cwd: string): string {
  if (isRepoAt(cwd)) {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8" });
    if (result.status === 0) return path.resolve(result.stdout.trim());
  }
  return path.resolve(cwd);
}

export interface CommitterIdentity {
  name: string;
  email: string;
}

/**
 * `git config user.name`/`user.email` at `repoRoot` — `undefined` (never a
 * fallback literal) when either is unset, so a caller can tell "no identity
 * configured" from "identity is the empty string."
 *
 * Deliberately NOT `utils.engineerName()`: that helper tries the
 * `ENGINEER_NAME` env var (spoofable by an operator), then `git config
 * user.name`, then `$USER`/`$USERNAME`, and finally falls back to the
 * literal string `"engineer"` when nothing is set — fine for a phase's
 * display `owner`, but a `Signed-off-by:` trailer is a git attestation, and
 * this is the one thing on this branch that ends up in one (see
 * `chains/simple_sdlc.ts`'s `decideSignoff` and `chains/steps.ts`'s
 * `commitEnvelope`). A trailer needs the identity git itself would use for
 * the commit — `undefined` here means the caller records the sign-off
 * decision in the trace anyway and skips the trailer with a logged note,
 * rather than inventing a name for it.
 */
export function committerIdentity(repoRoot: string): CommitterIdentity | undefined {
  const name = gitConfigValue(repoRoot, "user.name");
  const email = gitConfigValue(repoRoot, "user.email");
  if (!name || !email) return undefined;
  return { name, email };
}

/** `""` on anything short of a clean, non-empty value — unset, unreadable, or blank all read the same to a caller that only wants "do we have one?" */
function gitConfigValue(repoRoot: string, key: string): string {
  const result = spawnSync("git", ["config", "--get", key], { cwd: repoRoot, encoding: "utf-8" });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

export interface GitHandle {
  currentBranch(): string;
  createBranch(name: string): string;
  isRepo(): boolean;
  /** Stage the working tree and commit it. Returns the new short sha. */
  commitAll(message: string): string;
  changedFiles(): string[];
  /** True when `ref` resolves to a commit. Never throws — this is a question. */
  refExists(ref: string): boolean;
  rev(ref?: string): string;
  shortSha(ref?: string): string;
  /**
   * The commit where `ref` and `other` diverged — the honest base of a branch.
   *
   * On the base branch itself this returns HEAD, which makes the diff exactly
   * "what is not committed yet". Off it, the diff is the whole branch plus the
   * working tree. One command covers both cases, so no caller has to branch on it.
   */
  mergeBase(ref: string, other?: string): string;
  isDirty(): boolean;
  untrackedFiles(): string[];
  /** Tracked files that differ between `base` and the working tree. */
  diffFiles(base: string): string[];
  diffStat(base: string): string;
  /** [insertions, deletions] across the diff. Binary files count as neither. */
  diffCounts(base: string): [number, number];
  diffText(base: string): string;
  /** `git fetch <remote> <ref>` — needed before branching off a remote base that may have moved. */
  fetch(remote: string, ref: string): void;
  /** `git worktree add <path> -b <branch> <startPoint>` — used by `spf watch` to isolate one issue's work outside the repo. */
  worktreeAdd(worktreePath: string, branch: string, startPoint: string): void;
  /** `git worktree remove <path> --force`. Never throws if the path is already gone. */
  worktreeRemove(worktreePath: string): void;
  /** `git branch -D <name>`. Never throws if the branch is already gone. */
  deleteLocalBranch(name: string): void;
  push(remote: string, branch: string): void;
}

/** Every operation this returns is bound to `repoRoot` — never `process.cwd()`. */
export function makeGit(repoRoot: string): GitHandle {
  const run = (args: string[]) => git(args, repoRoot);

  return {
    currentBranch: () => run(["rev-parse", "--abbrev-ref", "HEAD"]),

    createBranch: (name) => {
      run(["checkout", "-b", name]);
      return name;
    },

    isRepo: () => isRepoAt(repoRoot),

    commitAll: (message) => {
      if (!isRepoAt(repoRoot)) {
        throw new Error(
          "not a git repository — a commit phase needs one. Run `git init` in the " +
            "repo root (and make a first commit) before running an ADW that commits.",
        );
      }
      run(["add", "-A"]);
      if (!run(["status", "--porcelain"])) {
        throw new Error("nothing to commit — the preceding phases changed no files");
      }
      run(["commit", "-m", message]);
      return run(["rev-parse", "--short", "HEAD"]);
    },

    changedFiles: () => {
      const out = run(["status", "--porcelain"]);
      return out.split("\n").filter(Boolean).map((line) => line.slice(3));
    },

    refExists: (ref) => {
      const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd: repoRoot,
        encoding: "utf-8",
      });
      return result.status === 0;
    },

    rev: (ref = "HEAD") => run(["rev-parse", ref]),

    shortSha: (ref = "HEAD") => run(["rev-parse", "--short", ref]),

    mergeBase: (ref, other = "HEAD") => run(["merge-base", ref, other]),

    isDirty: () => Boolean(run(["status", "--porcelain"])),

    untrackedFiles: () => {
      const out = run(["ls-files", "--others", "--exclude-standard"]);
      return out.split("\n").filter(Boolean);
    },

    diffFiles: (base) => {
      const out = run(["diff", "--name-only", base]);
      return out.split("\n").filter(Boolean);
    },

    diffStat: (base) => run(["diff", "--stat", base]),

    diffCounts: (base) => {
      let insertions = 0;
      let deletions = 0;
      for (const line of run(["diff", "--numstat", base]).split("\n")) {
        if (!line) continue;
        const [added, removed] = line.split("\t");
        if (/^\d+$/.test(added)) insertions += parseInt(added, 10);
        if (/^\d+$/.test(removed)) deletions += parseInt(removed, 10);
      }
      return [insertions, deletions];
    },

    diffText: (base) => run(["diff", base]),

    fetch: (remote, ref) => {
      run(["fetch", remote, ref]);
    },

    worktreeAdd: (worktreePath, branch, startPoint) => {
      run(["worktree", "add", worktreePath, "-b", branch, startPoint]);
    },

    worktreeRemove: (worktreePath) => {
      spawnSync("git", ["worktree", "remove", worktreePath, "--force"], { cwd: repoRoot, encoding: "utf-8" });
    },

    deleteLocalBranch: (name) => {
      spawnSync("git", ["branch", "-D", name], { cwd: repoRoot, encoding: "utf-8" });
    },

    push: (remote, branch) => {
      run(["push", "-u", remote, branch]);
    },
  };
}

// ── run worktrees ────────────────────────────────────────────────────────────
//
// One RUN, one working tree. This is the mechanism `spf watch` proved: N
// chains running CONCURRENTLY IN ONE PROCESS, each with its own git worktree,
// its own adw_id, its own Run, all sharing the main repo's data dir (and
// therefore one WAL SQLite) through a symlink. Lifted here so the next
// caller that wants isolated sibling runs — `core/fanout.ts`'s best-of-N —
// gets the same shape instead of a second, subtly-different copy.
//
// THE UNIT OF ISOLATION IS THE RUN, NEVER AN AGENT CALL. Each worktree is
// handed to a NEW Run whose `repo_root` is bound to it once, in the Run
// constructor, so `gates.resolveClaim`, `permissions.snapshot/enforce`, the
// quality checks and `changes.capture` all judge the tree the agents actually
// wrote in. A per-call cwd swap would leave those anchored to the main repo
// and hand out green gates on unverified work; a `SandboxHandle`/cwd-threading
// design was evaluated for exactly this and REJECTED. Do not reintroduce it.
//
// WHAT THIS IS NOT: it is not a refactor target for `core/watch.ts`. Watch's
// build lane creates a worktree in `runIssue` and removes it much later, from
// a completely different call site (`finishReviews`, once the PR merges or
// closes) — its worktree deliberately OUTLIVES the chain run so a human can
// look at the tree behind an open PR. A scoped create/run/cleanup helper
// cannot express that, so watch keeps its own inlined calls (`worktreeAdd` +
// `linkDataDir` + `cleanupWorktree`) and this is the same shape, not a shared
// implementation. `createRunWorktree`/`removeRunWorktree` below are the
// granular pair for that split lifetime; `withRunWorktree` is the scoped form
// for a caller whose worktree really does die with the callback.
//
// POLICY STAYS WITH THE CALLER, deliberately: this module knows nothing about
// `homedir()`, `.spf/data`, or symlinks. The caller passes an absolute
// `worktreesDir` and an injected `linkDataDir` callback (see
// `cli/commands/watch.ts`'s own for why that symlink is load-bearing: without
// it a run's traces land in a throwaway `.spf/data` inside the worktree and
// vanish with it).

export interface RunWorktreeSpec {
  /** Absolute path of the worktree's working directory. */
  path: string;
  /** The branch created at `path`. Deleting it requires removing the worktree first. */
  branch: string;
}

export interface RunWorktreeOptions {
  /** Absolute. OUTSIDE the repo — a worktree inside it would be walked by the repo's own tooling. */
  worktreesDir: string;
  /** Created by `git worktree add -b`, so it must NOT already exist (see the cleanup-first note below). */
  branch: string;
  /** Branch name only (`"main"`), not a remote ref — the remote prefix is applied by `resolveStartPoint`. */
  baseBranch: string;
  /** Default "origin". */
  remote?: string;
  /**
   * Default true: fetch `remote/baseBranch` before branching, so a long-lived
   * process doesn't fork every run off a stale base. Unlike watch's inlined
   * `git.fetch(...)`, a FAILED fetch here is not fatal — see `resolveStartPoint`.
   */
  fetchBase?: boolean;
  /** Overrides the whole base resolution — an explicit ref (sha, tag, local branch) to branch from. */
  startPoint?: string;
  /** Wire `<worktree>/.spf/data` to the MAIN repo's data dir. Injected, never done here — see the section comment. */
  linkDataDir?: (worktreePath: string) => void;
  /** Bound to the MAIN repo root. Injected so a unit test needs no real repo; defaults to `makeGit(repoRoot)`. */
  git?: GitHandle;
  log?: (message: string) => void;
}

/**
 * Where the base of a new run worktree comes from.
 *
 * A fetch failure is logged, not thrown: `spf fanout` is a local, interactive
 * command that must still work on a repo with no remote, offline, or behind a
 * proxy — and `refExists` below then falls back to the LOCAL base branch,
 * which is the honest answer in all three cases. (Watch differs on purpose:
 * a daemon that silently starts branching off a stale local base for hours is
 * worse than a loud failure, so it keeps its unguarded `git.fetch`.)
 */
function resolveStartPoint(git: GitHandle, opts: RunWorktreeOptions): string {
  if (opts.startPoint) return opts.startPoint;
  const remote = opts.remote ?? "origin";
  if (opts.fetchBase !== false) {
    try {
      git.fetch(remote, opts.baseBranch);
    } catch (error) {
      // First line only: `git fetch`'s own error is the underlying command's
      // full multiline stderr, and an offline/local-only repo hits this on
      // EVERY attempt — five lines of "'origin' does not appear to be a git
      // repository" repeated N times drowns out everything else fan-out prints.
      const firstLine = (error as Error).message.split("\n")[0];
      opts.log?.(`worktree: fetch ${remote} ${opts.baseBranch} failed (${firstLine}) — using the local base`);
    }
  }
  const remoteRef = `${remote}/${opts.baseBranch}`;
  return git.refExists(remoteRef) ? remoteRef : opts.baseBranch;
}

/**
 * Create `<worktreesDir>/<name>` on a fresh `branch` off the resolved base,
 * and wire its data dir. Returns the spec its caller must eventually hand to
 * `removeRunWorktree`.
 *
 * CLEARS A STALE WORKTREE DIRECTORY FIRST, but only when it's safe to: the
 * path is deterministic from `name`, so the only way it can already exist is
 * a previous attempt that never reached its own cleanup (killed mid-run,
 * crashed, machine restart) — OR a previous attempt whose kept payload lives
 * only in that tree's uncommitted edits (see `cli/commands/fanout.ts`'s
 * winner-handling note: a chain with no commit step leaves its work in the
 * worktree, not on the branch). `git worktree remove --force` deletes
 * modified/untracked files with no confirmation and exit 0, so blindly
 * force-removing here would silently destroy a kept winner the moment a
 * `--adw-id` retry reuses its deterministic name. Refuse instead, loudly,
 * before touching anything. `worktreeRemove` is a no-op when there is
 * nothing to remove, so a genuinely stale (clean) leftover is still cleared
 * exactly as before. (Same reasoning as `core/watch.ts`'s `runIssue`, which
 * clears its own worktree the same way — modulo this same guard.)
 *
 * ALSO REFUSES A PRE-EXISTING BRANCH up front, for the same reason and the
 * same actionable-error idea: the fan-out winner's branch is handed to a
 * human to merge and can share this exact deterministic name across separate
 * invocations (an explicit `--adw-id` retry), so it is never deleted here —
 * see `removeRunWorktree` for the only place that happens, once an attempt
 * is known to be discarded. Checking first turns `git worktree add -b`'s raw
 * `fatal: a branch named '...' already exists` (which every attempt would
 * otherwise hit identically, for the least helpful reason) into one message
 * naming the collision and the way out.
 */
export function createRunWorktree(repoRoot: string, name: string, opts: RunWorktreeOptions): RunWorktreeSpec {
  const git = opts.git ?? makeGit(repoRoot);
  const worktreePath = path.join(opts.worktreesDir, name);

  if (existsSync(worktreePath)) {
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: worktreePath, encoding: "utf-8" });
    if (status.status === 0 && status.stdout.trim() !== "") {
      throw new Error(
        `${worktreePath} already exists and has uncommitted changes — refusing to remove it (it may be a ` +
          `previous run's kept winner). Inspect or move it by hand, then retry, or use a fresh --adw-id.`,
      );
    }
  }
  try {
    git.worktreeRemove(worktreePath);
  } catch (error) {
    opts.log?.(`worktree: cleanup warning for ${worktreePath}: ${(error as Error).message}`);
  }

  if (git.refExists(opts.branch)) {
    throw new Error(
      `branch ${opts.branch} already exists — delete it (\`git branch -D ${opts.branch}\`) once you no longer ` +
        `need it, or use a fresh --adw-id`,
    );
  }

  mkdirSync(opts.worktreesDir, { recursive: true });
  git.worktreeAdd(worktreePath, opts.branch, resolveStartPoint(git, opts));
  opts.linkDataDir?.(worktreePath);
  return { path: worktreePath, branch: opts.branch };
}

/**
 * Remove a run worktree and delete its branch. NEVER throws — cleanup runs on
 * the failure path too, and a cleanup error must not replace the real error
 * that got us here.
 *
 * Order matters and is not cosmetic: git refuses to delete a branch that is
 * checked out in a worktree, so the worktree goes first. A caller that wants
 * to KEEP the branch (the fan-out winner) must simply not call this.
 */
export function removeRunWorktree(
  repoRoot: string,
  worktree: RunWorktreeSpec,
  opts: { git?: GitHandle; log?: (message: string) => void } = {},
): void {
  const git = opts.git ?? makeGit(repoRoot);
  try {
    git.worktreeRemove(worktree.path);
    git.deleteLocalBranch(worktree.branch);
  } catch (error) {
    opts.log?.(`worktree: cleanup warning for ${worktree.path}: ${(error as Error).message}`);
  }
}

/** What the callback of `withRunWorktree` is handed. */
export interface RunWorktreeHandle extends RunWorktreeSpec {
  /**
   * Make this worktree and its branch SURVIVE the scope.
   *
   * The whole point of the scoped form: a caller that cannot decide the fate
   * of a tree until it sees the result (fan-out keeps a successful attempt's
   * branch so it can still be selected and, if it wins, handed to a human;
   * a failed attempt's tree is worthless the moment it fails) says so from
   * inside, once it knows. Not calling it is the default, and the default is
   * cleanup.
   */
  keep(): void;
}

/**
 * Run `fn` against a fresh run worktree, cleaning it up afterwards unless
 * `wt.keep()` was called — including when `fn` throws, which is the case a
 * hand-rolled create/remove pair reliably gets wrong.
 *
 * `opts` sits BEFORE the callback (a small departure from the usual
 * `(a, b, fn)` shape) so the required options can't be forgotten behind an
 * optional trailing argument, and so the callback stays the last thing you
 * read — the JS convention that matters here.
 */
export async function withRunWorktree<T>(
  repoRoot: string,
  name: string,
  opts: RunWorktreeOptions,
  fn: (worktree: RunWorktreeHandle) => Promise<T>,
): Promise<T> {
  const spec = createRunWorktree(repoRoot, name, opts);
  let kept = false;
  const handle: RunWorktreeHandle = { ...spec, keep: () => void (kept = true) };
  try {
    return await fn(handle);
  } finally {
    if (!kept) removeRunWorktree(repoRoot, spec, { git: opts.git, log: opts.log });
  }
}
