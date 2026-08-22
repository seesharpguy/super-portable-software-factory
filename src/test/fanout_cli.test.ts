import "./hermetic_git.ts";

/**
 * Regression coverage for the two `.spf/data` symlink blockers in
 * `cli/commands/fanout.ts` — see `linkFanoutDataDir`/`excludeSpfDataFromGit`
 * there for the full explanation of each. Exercised against a REAL
 * filesystem and a REAL git binary, with no chain, no agent and no
 * `core/fanout.ts` mechanism involved: these two functions are pure I/O
 * plumbing, and the bug in each was exactly that — `mkdir`/`git status`
 * behavior nobody had pointed a real filesystem or a real git at yet.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { excludeSpfDataFromGit, fanoutCommand, linkFanoutDataDir } from "../cli/commands/fanout.ts";

/** Capture console output for the duration of `fn`, restoring it after — even if `fn` throws. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    const result = await fn();
    return { result, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("linkFanoutDataDir creates the data dir before symlinking to it — the fresh-repo / spf-init-but-no-run case", () => {
  const worktree = mkdtempSync(path.join(tmpdir(), "spf-linkdata-wt-"));
  const dataParent = mkdtempSync(path.join(tmpdir(), "spf-linkdata-data-"));
  // The exact shape of a repo that has run `spf init` (or a fresh clone with
  // `.spf/` committed) but never a chain: `.spf/` may exist, `.spf/data`
  // never does yet.
  const dataDir = path.join(dataParent, ".spf", "data");
  try {
    assert.equal(existsSync(dataDir), false, "sanity: the data dir does not exist yet, like a fresh repo");
    linkFanoutDataDir(worktree, dataDir);
    assert.equal(existsSync(dataDir), true, "the symlink target now exists");
    const target = path.join(worktree, ".spf", "data");
    // existsSync follows symlinks — true here means the link RESOLVES, i.e.
    // it is not dangling. Before the fix, this was false, and the first
    // attempt's `Run` constructor failed its own `ensureDir` on this path.
    assert.equal(existsSync(target), true, "the symlink resolves — not dangling");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(dataParent, { recursive: true, force: true });
  }
});

test("linkFanoutDataDir leaves a fresh attempt worktree's git status clean — the symlink never gets staged", () => {
  const worktree = mkdtempSync(path.join(tmpdir(), "spf-linkdata-clean-"));
  const dataParent = mkdtempSync(path.join(tmpdir(), "spf-linkdata-clean-data-"));
  const dataDir = path.join(dataParent, ".spf", "data");
  try {
    execFileSync("git", ["init"], { cwd: worktree, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: worktree, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: worktree, stdio: "ignore" });

    linkFanoutDataDir(worktree, dataDir);

    const status = execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf-8" });
    assert.equal(status.trim(), "", `git status must be empty right after linking the data dir — got:\n${status}`);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(dataParent, { recursive: true, force: true });
  }
});

// ── the no-commit-step refusal ───────────────────────────────────────────

test("fanoutCommand refuses a chain with no commit step, before touching git at all", async () => {
  // "build" is a real built-in chain with no commit step. No --cwd is
  // passed and no repo is set up — proof this refusal happens before any
  // git/anchor resolution, which is what makes it safe to run from anywhere.
  const { result, errors } = await captureConsole(() => fanoutCommand(["build", "do a thing"]));
  assert.equal(result, 1);
  assert.ok(errors.some((l) => /no commit phase/.test(l)), `expected a no-commit-phase refusal, got:\n${errors.join("\n")}`);
});

// ── `spf fanout --clean` ─────────────────────────────────────────────────

test("fanoutCommand --clean reports nothing to clean when no worktree or branch matches", async () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), "spf-clean-empty-"));
  try {
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    const { result, logs } = await captureConsole(() => fanoutCommand(["--clean", "nope00", "--cwd", repoDir]));
    assert.equal(result, 0);
    assert.ok(logs.some((l) => /nothing to clean/.test(l)));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("fanoutCommand --clean removes a leftover branch left behind by a killed prior run", async () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), "spf-clean-branch-"));
  try {
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "t"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["branch", "spf/fanout/killed01-1"], { cwd: repoDir, stdio: "ignore" });

    const { result, logs } = await captureConsole(() => fanoutCommand(["--clean", "killed01", "--cwd", repoDir]));
    assert.equal(result, 0);
    assert.ok(logs.some((l) => /deleted branch spf\/fanout\/killed01-1/.test(l)));

    const remaining = execFileSync("git", ["branch", "--list", "spf/fanout/killed01-*"], { cwd: repoDir, encoding: "utf-8" });
    assert.equal(remaining.trim(), "", "the branch must actually be gone, not just reported as gone");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("excludeSpfDataFromGit is idempotent — calling it twice appends the exclude line only once", () => {
  const worktree = mkdtempSync(path.join(tmpdir(), "spf-exclude-idempotent-"));
  try {
    execFileSync("git", ["init"], { cwd: worktree, stdio: "ignore" });
    excludeSpfDataFromGit(worktree);
    excludeSpfDataFromGit(worktree);
    const rawExcludePath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: worktree,
      encoding: "utf-8",
    }).trim();
    const excludePath = path.isAbsolute(rawExcludePath) ? rawExcludePath : path.join(worktree, rawExcludePath);
    const contents = readFileSync(excludePath, "utf-8");
    const occurrences = contents.split("\n").filter((l) => l.trim() === ".spf/data").length;
    assert.equal(occurrences, 1, `expected exactly one ".spf/data" line, got:\n${contents}`);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});
