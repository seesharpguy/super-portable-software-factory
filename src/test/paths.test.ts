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
import "./hermetic_git.js";
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

// ── observability.db discriminated forms (BT-issue #66, PR 1 of 3) ─────────
//
// Every existing caller (`resolveDataPaths(anchor, cfg.defaults.data_dir,
// cfg.observability.db)`) passes cfg.observability.db straight through, so
// this exercises the same three accepted forms `data_types.test.ts` covers
// at the schema level, but through the actual path-resolution consumer.

test("resolveDataPaths: legacy bare-string db resolves db_path byte-for-byte identically to before this PR", () => {
  const anchor = resolveAnchor(dir);
  const viaString = resolveDataPaths(anchor, ".spf/data", ".spf/data/spf.db");
  const viaSqliteObject = resolveDataPaths(anchor, ".spf/data", { kind: "sqlite", path: ".spf/data/spf.db" });
  assert.equal(viaString.db_path, join(dir, ".spf", "data", "spf.db"));
  assert.deepEqual(viaSqliteObject, viaString, "the equivalent {kind:sqlite} object form must resolve to the exact same DataPaths");
});

test("resolveDataPaths: {kind:sqlite} object form with a custom path resolves relative to repo_root, same as a bare string would", () => {
  const anchor = resolveAnchor(dir);
  const paths = resolveDataPaths(anchor, ".spf/data", { kind: "sqlite", path: "elsewhere/custom.db" });
  assert.equal(paths.db_path, join(dir, "elsewhere", "custom.db"));
  // sessions_dir is ALWAYS a sibling of db_path for a sqlite-kind db — NOT
  // anchored off data_dir — so a custom sqlite path elsewhere than data_dir
  // does not orphan a repo's historical session JSONL/envelope artifacts.
  assert.equal(paths.sessions_dir, join(dir, "elsewhere", "sessions"), "sessions_dir is a sibling of db_path, unaffected by data_dir");
});

test("resolveDataPaths: {kind:sqlite} object form with path omitted defaults to .spf/data/spf.db, same as the bare-string default", () => {
  const anchor = resolveAnchor(dir);
  const paths = resolveDataPaths(anchor, ".spf/data", { kind: "sqlite" });
  assert.equal(paths.db_path, join(dir, ".spf", "data", "spf.db"));
});

// ── {kind:d1} resolves to a usable descriptor (SPF #66, PR 2) ──────────────
//
// PR 1 left resolveDataPaths throwing for a d1 config ("no D1 adapter yet").
// PR 2 builds that adapter (core/trace_db.ts's D1TraceDb) — resolveDataPaths
// must stop throwing and instead hand back enough for createTraceDb() to
// open a real D1 connection, while sessions_dir still resolves to a real
// LOCAL directory (session JSONL/envelope artifacts always live on disk).

test("resolveDataPaths: {kind:d1} no longer throws — db_path is null, db carries the normalized d1 descriptor", () => {
  const anchor = resolveAnchor(dir);
  const paths = resolveDataPaths(anchor, ".spf/data", { kind: "d1", database_id: "abc123" });
  assert.equal(paths.db_path, null, "there is no local sqlite file for a d1-backed repo");
  assert.deepEqual(paths.db, {
    kind: "d1",
    database_id: "abc123",
    account_id_env: "CLOUDFLARE_ACCOUNT_ID",
    api_token_env: "CLOUDFLARE_API_TOKEN",
  });
});

test("resolveDataPaths: {kind:d1} still resolves a real local sessions_dir, anchored off data_dir — session artifacts stay local regardless of the trace db backend", () => {
  const anchor = resolveAnchor(dir);
  const paths = resolveDataPaths(anchor, ".spf/data", { kind: "d1", database_id: "abc123" });
  assert.equal(paths.sessions_dir, join(dir, ".spf", "data", "sessions"));
  assert.equal(paths.data_dir, join(dir, ".spf", "data"));
});

test("resolveDataPaths: {kind:d1} with custom account_id_env/api_token_env passes them through unchanged", () => {
  const anchor = resolveAnchor(dir);
  const paths = resolveDataPaths(anchor, ".spf/data", {
    kind: "d1",
    database_id: "abc123",
    account_id_env: "MY_ACCOUNT_ID",
    api_token_env: "MY_API_TOKEN",
  });
  assert.deepEqual(paths.db, {
    kind: "d1",
    database_id: "abc123",
    account_id_env: "MY_ACCOUNT_ID",
    api_token_env: "MY_API_TOKEN",
  });
});
