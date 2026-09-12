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

// `agents[].writes`'s own root-matching is pinned just above — this is the
// intentional, repo-wide OTHER half: `defaults.protected_files` uses the
// exact same `matches()`/`globToRegex`, so a leading "**/" pattern there
// must widen identically, blocking a root-level file it names just as
// completely as a nested one. Documented as an intentional, arguably
// correct fix in 8737ee5's commit message; this pins both directions of it
// (blocked at the root, blocked nested) so the widening cannot regress
// silently on either config surface.
test("permitted: defaults.protected_files also matches a root-level file via a leading '**/' pattern, not only a nested one", () => {
  const cfg = makeCfg({ protected_files: ["**/secrets.yaml"] });
  const agent = makeAgent(); // unrestricted (writes undefined) — the only thing standing between it and any path is protected_files
  assert.equal(permitted("secrets.yaml", agent, cfg), false, "blocked at the repo root");
  assert.equal(permitted("a/b/secrets.yaml", agent, cfg), false, "blocked nested too, unchanged from before this fix");
  assert.equal(permitted("other.yaml", agent, cfg), true, "an unrelated path is still unaffected — unrestricted agent, no protected match");
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

// ── BLOCKER fix: ignoring requires the path was CLEAN before the phase ──
//
// Before this fix, `enforce()` ignored (and reported "rolled back and
// ignored") ANY read_only_ignore match regardless of whether the path was
// already dirty going in — even when `rollBack` could not actually restore
// anything ("left as-is" or "REVERTED-BY-AGENT"). These pin the honest
// behavior: only a path that was clean beforehand can be "restored and
// ignored"; a dirty-before path is always a real breach.

test("enforce: a lockfile that was ALREADY dirty before the phase, and the agent modifies it further, is a real breach — never silently ignored", () => {
  const dir = makeRepo();
  try {
    const cfg = makeCfg();
    const agent = makeAgent({ writes: [] }); // true read-only
    // Dirty BEFORE the phase starts — an operator's own uncommitted change.
    writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion": 2, "operatorDirty": true}\n');
    const before = snapshot({ repo_root: dir, cfg });
    // The agent modifies it further during the phase. `snapshot()` fingerprints
    // by numstat (added/removed line counts vs HEAD), not content — so this
    // edit deliberately changes the LINE COUNT too (one line -> four), not
    // just the content, to actually produce a different fingerprint from the
    // dirty-before state and register as a further change.
    writeFileSync(path.join(dir, "package-lock.json"), '{\n  "lockfileVersion": 3,\n  "agentTouched": true\n}\n');

    let thrown: PermissionBreach | undefined;
    const ignoredCalls: string[][] = [];
    try {
      enforce({ repo_root: dir, cfg }, null, agent, before, (paths) => ignoredCalls.push(paths));
    } catch (error) {
      thrown = error as PermissionBreach;
    }
    assert.ok(thrown instanceof PermissionBreach, "a dirty-before lockfile must fail the phase, matching read_only_ignore or not");
    assert.match(thrown!.message, /package-lock\.json — left as-is \(was already modified\)/);
    assert.deepEqual(ignoredCalls, [], "onIgnored must not fire — nothing here was safely ignored");
    assert.equal(
      readFileSync(path.join(dir, "package-lock.json"), "utf-8"),
      '{\n  "lockfileVersion": 3,\n  "agentTouched": true\n}\n',
      "left exactly as the agent left it — 'left as-is' is not a restore",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforce: a read-only agent that REVERTS a dirty-before lockfile back to HEAD is a real breach (REVERTED-BY-AGENT) — never 'restored and ignored'", () => {
  const dir = makeRepo();
  try {
    const cfg = makeCfg();
    const agent = makeAgent({ writes: [] });
    writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion": 2, "operatorDirty": true}\n');
    const before = snapshot({ repo_root: dir, cfg });
    // The agent "cleans up" by checking the file back out to HEAD — the
    // tree shows no diff afterward, so `after` has no entry for this path:
    // an operator's uncommitted work is gone and unrecoverable.
    execFileSync("git", ["checkout", "--", "package-lock.json"], { cwd: dir, stdio: "ignore" });

    let thrown: PermissionBreach | undefined;
    try {
      enforce({ repo_root: dir, cfg }, null, agent, before);
    } catch (error) {
      thrown = error as PermissionBreach;
    }
    assert.ok(thrown instanceof PermissionBreach, "reverting an operator's uncommitted work must fail the phase, never pass silently");
    assert.match(thrown!.message, /package-lock\.json — REVERTED-BY-AGENT \(uncommitted work lost, cannot restore\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforce: a lockfile that was CLEAN before the phase is restored and ignored (the one case the exemption actually covers)", () => {
  const dir = makeRepo();
  try {
    const cfg = makeCfg();
    const agent = makeAgent({ writes: [] });
    const before = snapshot({ repo_root: dir, cfg }); // clean
    writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion": 2, "agentTouched": true}\n');

    const ignoredCalls: string[][] = [];
    const touched = enforce({ repo_root: dir, cfg }, null, agent, before, (paths) => ignoredCalls.push(paths));

    assert.deepEqual(touched, ["package-lock.json"]);
    assert.deepEqual(ignoredCalls, [["package-lock.json"]]);
    assert.equal(
      readFileSync(path.join(dir, "package-lock.json"), "utf-8"),
      '{"lockfileVersion": 1}\n',
      "actually restored to the committed content — this is the case where 'restored and ignored' is true",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── MAJOR fix: read_only_ignore applies ONLY to true read-only agents ────

test("enforce: a write-restricted (non-empty writes) agent that changes package.json and the lockfile together still fails — read_only_ignore is not for write-restricted roles", () => {
  const dir = makeRepo();
  try {
    const cfg = makeCfg();
    const agent = makeAgent({ writes: ["package.json"] }); // write-restricted, NOT read-only
    const before = snapshot({ repo_root: dir, cfg });
    writeFileSync(path.join(dir, "package.json"), '{"name": "x", "version": "2.0.0"}\n'); // permitted — named in writes
    writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion": 2, "followedPackageJson": true}\n'); // would be ignorable for a read-only agent — not this one

    let thrown: PermissionBreach | undefined;
    try {
      enforce({ repo_root: dir, cfg }, null, agent, before);
    } catch (error) {
      thrown = error as PermissionBreach;
    }
    assert.ok(thrown instanceof PermissionBreach, "must fail — an inconsistent tree (package.json changed, lockfile followed) from a write-restricted agent is a real breach");
    assert.match(thrown!.message, /package-lock\.json/);
    assert.equal(
      readFileSync(path.join(dir, "package.json"), "utf-8"),
      '{"name": "x", "version": "2.0.0"}\n',
      "the permitted file is untouched — only the lockfile is the breach",
    );
    assert.equal(readFileSync(path.join(dir, "package-lock.json"), "utf-8"), '{"lockfileVersion": 1}\n', "still rolled back despite failing the phase");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
