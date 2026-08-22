/**
 * Regression guard for `resolveDataPaths`'s self-heal: a `data_dir` that
 * exists as a broken symlink (self-referential or dangling) must be removed
 * before anything tries to `mkdirSync` through it — see `paths.ts`'s
 * `healBrokenDataDir` for why this lives here and not at each `mkdirSync`
 * call site individually. This is a live bug that shipped once already: a
 * self-referential `.spf/data -> .spf/data` symlink was observed on a real
 * checkout, and every subsequent command failed with `ELOOP` at its very
 * first filesystem touch.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAnchor, resolveDataPaths } from "../core/paths.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spf-paths-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("resolveDataPaths: a self-referential data_dir symlink is removed, not left to ELOOP later", () => {
  const dataDir = join(dir, ".spf", "data");
  mkdirSync(join(dir, ".spf"), { recursive: true });
  symlinkSync(dataDir, dataDir, "dir"); // exactly the observed bug: points at itself

  const anchor = resolveAnchor(dir);
  const paths = resolveDataPaths(anchor, ".spf/data", ".spf/data/spf.db");

  assert.equal(paths.data_dir, dataDir);
  assert.equal(existsSync(dataDir), false, "the broken symlink must be gone, not just tolerated");
  // Confirms the actual failure mode is fixed: this would throw ELOOP before the fix.
  mkdirSync(dataDir, { recursive: true });
  assert.ok(existsSync(dataDir));
});

test("resolveDataPaths: a dangling data_dir symlink (target removed) is also cleaned up", () => {
  const realTarget = join(dir, "somewhere-else");
  const dataDir = join(dir, ".spf", "data");
  mkdirSync(realTarget, { recursive: true });
  mkdirSync(join(dir, ".spf"), { recursive: true });
  symlinkSync(realTarget, dataDir, "dir");
  rmSync(realTarget, { recursive: true, force: true }); // now dataDir points at nothing

  const anchor = resolveAnchor(dir);
  resolveDataPaths(anchor, ".spf/data", ".spf/data/spf.db");

  assert.equal(existsSync(dataDir), false);
});

test("resolveDataPaths: an ordinary real directory is left completely alone", () => {
  const dataDir = join(dir, ".spf", "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "spf.db"), "not actually sqlite, just a marker");

  const anchor = resolveAnchor(dir);
  resolveDataPaths(anchor, ".spf/data", ".spf/data/spf.db");

  assert.ok(existsSync(join(dataDir, "spf.db")), "a real, already-populated data_dir must never be touched");
});

test("resolveDataPaths: data_dir not existing yet (the ordinary first-run case) is a silent no-op", () => {
  const anchor = resolveAnchor(dir);
  assert.doesNotThrow(() => resolveDataPaths(anchor, ".spf/data", ".spf/data/spf.db"));
  assert.equal(existsSync(join(dir, ".spf", "data")), false, "resolveDataPaths itself never creates the directory — only heals a broken one");
});

test("resolveDataPaths: a real FILE at data_dir's path (not a symlink) is left alone — not this bug", () => {
  mkdirSync(join(dir, ".spf"), { recursive: true });
  const dataDir = join(dir, ".spf", "data");
  writeFileSync(dataDir, "oops, a file where a directory should be");

  const anchor = resolveAnchor(dir);
  resolveDataPaths(anchor, ".spf/data", ".spf/data/spf.db");

  assert.ok(existsSync(dataDir), "only a broken SYMLINK is this function's concern, not any other kind of misconfiguration");
  assert.equal(lstatSync(dataDir).isSymbolicLink(), false);
});
