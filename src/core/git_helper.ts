/** Low-level git operations for code phases. All low-level logic lives in adw_modules. */

import { spawnSync } from "node:child_process";
import path from "node:path";

function git(args: string[], cwd?: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  return result.stdout.trim();
}

export function currentBranch(): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function createBranch(name: string): string {
  git(["checkout", "-b", name]);
  return name;
}

export function isRepo(): boolean {
  const result = spawnSync("git", ["rev-parse", "--git-dir"], { encoding: "utf-8" });
  return result.status === 0;
}

/**
 * Absolute root of the codebase — where agents are spawned to work.
 *
 * The git toplevel when there is one, else the process cwd (ADWs run fine in a
 * non-git dir; only a commit phase requires a repo). Always absolute, so it is
 * safe to hand to a subprocess regardless of where the ADW was launched from.
 */
export function repoRoot(): string {
  if (isRepo()) {
    return path.resolve(git(["rev-parse", "--show-toplevel"]));
  }
  return path.resolve(process.cwd());
}

/** Stage the working tree and commit it. Returns the new short sha. */
export function commitAll(message: string): string {
  if (!isRepo()) {
    throw new Error(
      "not a git repository — a commit phase needs one. Run `git init` in the " +
        "repo root (and make a first commit) before running an ADW that commits.",
    );
  }
  git(["add", "-A"]);
  if (!git(["status", "--porcelain"])) {
    throw new Error("nothing to commit — the preceding phases changed no files");
  }
  git(["commit", "-m", message]);
  return git(["rev-parse", "--short", "HEAD"]);
}

export function changedFiles(): string[] {
  const out = git(["status", "--porcelain"]);
  return out.split("\n").filter(Boolean).map((line) => line.slice(3));
}

// ── diff plumbing (composed into a ChangeSet by changes.ts) ──────────────────

/** True when `ref` resolves to a commit. Never raises — this is a question. */
export function refExists(ref: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    encoding: "utf-8",
  });
  return result.status === 0;
}

export function rev(ref: string = "HEAD"): string {
  return git(["rev-parse", ref]);
}

export function shortSha(ref: string = "HEAD"): string {
  return git(["rev-parse", "--short", ref]);
}

/**
 * The commit where `ref` and `other` diverged — the honest base of a branch.
 *
 * On the base branch itself this returns HEAD, which makes the diff exactly
 * "what is not committed yet". Off it, the diff is the whole branch plus the
 * working tree. One command covers both cases, so no ADW has to branch on it.
 */
export function mergeBase(ref: string, other: string = "HEAD"): string {
  return git(["merge-base", ref, other]);
}

export function isDirty(): boolean {
  return Boolean(git(["status", "--porcelain"]));
}

export function untrackedFiles(): string[] {
  const out = git(["ls-files", "--others", "--exclude-standard"]);
  return out.split("\n").filter(Boolean);
}

/** Tracked files that differ between `base` and the working tree. */
export function diffFiles(base: string): string[] {
  const out = git(["diff", "--name-only", base]);
  return out.split("\n").filter(Boolean);
}

export function diffStat(base: string): string {
  return git(["diff", "--stat", base]);
}

/** [insertions, deletions] across the diff. Binary files count as neither. */
export function diffCounts(base: string): [number, number] {
  let insertions = 0;
  let deletions = 0;
  for (const line of git(["diff", "--numstat", base]).split("\n")) {
    if (!line) continue;
    const [added, removed] = line.split("\t");
    if (/^\d+$/.test(added)) insertions += parseInt(added, 10);
    if (/^\d+$/.test(removed)) deletions += parseInt(removed, 10);
  }
  return [insertions, deletions];
}

export function diffText(base: string): string {
  return git(["diff", base]);
}
