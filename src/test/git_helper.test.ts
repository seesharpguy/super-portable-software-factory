import "./hermetic_git.ts";

/**
 * `findRepoRoot()`'s contract is "never throws, always returns some root."
 * `isRepoAt()` only proves `git rev-parse --git-dir` succeeds, which is also
 * true inside a bare repo and inside a `.git/` directory itself — neither
 * has a work tree, so the follow-up `--show-toplevel` call fails there even
 * though `isRepoAt()` said yes. Regression coverage for that gap: before the
 * fix, `findRepoRoot()` let that failure propagate as an uncaught throw,
 * which — because `cli/index.ts` calls `paths.resolveAnchor()` outside its
 * top-level try/catch — crashed every command (including `spf --version`)
 * when run from a bare repo or from inside `.git/`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findRepoRoot } from "../core/git_helper.ts";

test("findRepoRoot falls back to cwd inside a bare repo (no work tree)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-bare-"));
  try {
    execFileSync("git", ["init", "--bare", dir], { stdio: "ignore" });
    const root = findRepoRoot(dir);
    assert.equal(root, path.resolve(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findRepoRoot falls back to cwd inside a repo's .git directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-dotgit-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    const gitDir = path.join(dir, ".git");
    const root = findRepoRoot(gitDir);
    assert.equal(root, path.resolve(gitDir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findRepoRoot resolves the toplevel of an ordinary work tree", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-worktree-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    const sub = path.join(dir, "nested");
    execFileSync("node", ["-e", `require("fs").mkdirSync(${JSON.stringify(sub)})`]);
    const root = findRepoRoot(sub);
    // git may resolve symlinked tmpdirs (e.g. macOS /tmp -> /private/tmp) —
    // compare against what git itself reports as the raw toplevel is what
    // resolveAnchor ultimately does too, so lean on findRepoRoot from the
    // repo root itself for a stable assertion.
    assert.equal(root, findRepoRoot(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
