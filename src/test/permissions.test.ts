import "./hermetic_git.ts";

/**
 * `core/permissions.ts` — the after-the-fact write guard, and specifically
 * `defaults.read_only_ignore` (lockfile churn tolerance): a read-only (or
 * write-restricted) agent that ran a dependency-manager command (`npm
 * install`, to read a package's real shape) rewrites its lockfile as a side
 * effect of a READ, not an edit — the config knob and `enforce()`'s handling
 * of it exist so that side effect is rolled back (never left standing)
 * without failing the whole phase over it, while any OTHER unauthorized
 * change still fails exactly as before.
 *
 * Real `git` against a real temp repo, same approach `sandbox.test.ts` and
 * `git_helper.test.ts` use for this module's own git-spawning code — a fake
 * filesystem/git layer would not actually exercise `snapshot()`/`rollBack()`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { AgentConfigSchema, SFConfigSchema, type AgentConfig, type SFConfig } from "../core/data_types.js";
import { PermissionBreach, enforce, permitted, snapshot } from "../core/permissions.js";

function makeCfg(defaultsOverrides: Record<string, unknown> = {}): SFConfig {
  return v.parse(SFConfigSchema, { defaults: defaultsOverrides }) as SFConfig;
}

function makeAgent(overrides: Record<string, unknown> = {}): AgentConfig {
  return v.parse(AgentConfigSchema, {
    name: "scout",
    prompt_engineering: { system: "s.md", user: "u.md" },
    ...overrides,
  }) as AgentConfig;
}

/** A committed repo with a lockfile and a source file already tracked, so both can be "modified" (not just created) by the fixture below. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-perm-repo-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir, stdio: "ignore" });
  writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion": 1}\n');
  writeFileSync(path.join(dir, "index.ts"), "export const x = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

// ── globToRegex / matches (via permitted), the "**/x matches root x too" fix ──

test("permitted: a leading '**/' pattern matches a file at the repo root, not only nested under a directory", () => {
  const cfg = makeCfg();
  const agent = makeAgent({ writes: ["**/package-lock.json"] });
  assert.equal(permitted("package-lock.json", agent, cfg), true, "root-level file");
  assert.equal(permitted("a/b/package-lock.json", agent, cfg), true, "nested file, still matches");
  assert.equal(permitted("package-lock.jsonx", agent, cfg), false, "not a suffix match");
});

// ── defaults.read_only_ignore: the default value ─────────────────────────

test("ConfigDefaultsSchema: read_only_ignore defaults to the four common lockfiles", () => {
  const cfg = makeCfg();
  assert.deepEqual(cfg.defaults.read_only_ignore, ["**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/bun.lockb"]);
});

// ── enforce(): lockfile churn is rolled back but does not fail the phase ─

test("enforce: a read-only agent that only churned package-lock.json passes — the file is rolled back, the phase does not fail", () => {
  const dir = makeRepo();
  try {
    const cfg = makeCfg();
    const agent = makeAgent({ writes: [] }); // read-only
    const before = snapshot({ repo_root: dir, cfg });
    writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion": 2, "churned": true}\n');

    const touched = enforce({ repo_root: dir, cfg }, null, agent, before);

    assert.deepEqual(touched, ["package-lock.json"], "still reported as touched, for the trace");
    assert.equal(readFileSync(path.join(dir, "package-lock.json"), "utf-8"), '{"lockfileVersion": 1}\n', "rolled back to the committed content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforce: a read-only agent that modified a real source file still fails, exactly as before this knob existed", () => {
  const dir = makeRepo();
  try {
    const cfg = makeCfg();
    const agent = makeAgent({ writes: [] });
    const before = snapshot({ repo_root: dir, cfg });
    writeFileSync(path.join(dir, "index.ts"), "export const x = 2;\n");

    assert.throws(
      () => enforce({ repo_root: dir, cfg }, null, agent, before),
      (error: unknown) => {
        assert.ok(error instanceof PermissionBreach);
        assert.match((error as Error).message, /index\.ts/);
        return true;
      },
    );
    assert.equal(readFileSync(path.join(dir, "index.ts"), "utf-8"), "export const x = 1;\n", "still rolled back even though it fails the phase");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforce: lockfile churn AND a real source-file edit together still fail — only the lockfile is exempt, not the whole breach set", () => {
  const dir = makeRepo();
  try {
    const cfg = makeCfg();
    const agent = makeAgent({ writes: [] });
    const before = snapshot({ repo_root: dir, cfg });
    writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion": 2}\n');
    writeFileSync(path.join(dir, "index.ts"), "export const x = 2;\n");

    let thrown: PermissionBreach | undefined;
    try {
      enforce({ repo_root: dir, cfg }, null, agent, before);
    } catch (error) {
      thrown = error as PermissionBreach;
    }
    assert.ok(thrown instanceof PermissionBreach);
    assert.match(thrown!.message, /index\.ts/, "the real breach is named");
    assert.doesNotMatch(thrown!.message, /package-lock\.json/, "the ignored lockfile is not counted toward the failure");
    assert.equal(readFileSync(path.join(dir, "package-lock.json"), "utf-8"), '{"lockfileVersion": 1}\n', "still rolled back despite not failing the phase");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforce: onIgnored is called once, naming exactly the ignored path(s), when nothing else breaches", () => {
  const dir = makeRepo();
  try {
    const cfg = makeCfg();
    const agent = makeAgent({ writes: [] });
    const before = snapshot({ repo_root: dir, cfg });
    writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion": 2}\n');

    const calls: string[][] = [];
    enforce({ repo_root: dir, cfg }, null, agent, before, (paths) => calls.push(paths));

    assert.deepEqual(calls, [["package-lock.json"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforce: emptying read_only_ignore restores strict behavior — a lockfile change fails the phase like any other breach", () => {
  const dir = makeRepo();
  try {
    const cfg = makeCfg({ read_only_ignore: [] });
    const agent = makeAgent({ writes: [] });
    const before = snapshot({ repo_root: dir, cfg });
    writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion": 2}\n');

    assert.throws(
      () => enforce({ repo_root: dir, cfg }, null, agent, before),
      (error: unknown) => {
        assert.ok(error instanceof PermissionBreach);
        assert.match((error as Error).message, /package-lock\.json/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforce: an agent explicitly allowed to write the lockfile is unaffected either way — it was never a breach", () => {
  const dir = makeRepo();
  try {
    const cfg = makeCfg();
    const agent = makeAgent({ writes: ["package-lock.json"] });
    const before = snapshot({ repo_root: dir, cfg });
    writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion": 2, "intentional": true}\n');

    const touched = enforce({ repo_root: dir, cfg }, null, agent, before);
    assert.deepEqual(touched, ["package-lock.json"]);
    assert.equal(readFileSync(path.join(dir, "package-lock.json"), "utf-8"), '{"lockfileVersion": 2, "intentional": true}\n', "left as the agent wrote it — this was a permitted write, not a rollback");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
