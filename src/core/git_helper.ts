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
