/**
 * `.env` upsert (`cli/env_file.ts`) — the write-side counterpart of
 * `process.loadEnvFile()` in `cli/index.ts`, which every command already
 * uses to load `<repo_root>/.env`. Mirrors `ensureGitignore`'s idempotent
 * shape: preserve everything unrelated, touch only the keys asked for.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskSecret, readEnvFile, upsertEnvFile, writeEnvExample } from "../cli/env_file.js";

let dir: string;

// Each test gets its own scratch directory with no .env yet — cheap, and
// avoids one test's leftover .env leaking into the next.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spf-env-file-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("upsertEnvFile creates a fresh .env with the given keys", () => {
  const result = upsertEnvFile(dir, { GITHUB_TOKEN: "ghp_abc" });
  assert.deepEqual(result, { added: ["GITHUB_TOKEN"], updated: [], unchanged: [] });
  assert.equal(readEnvFile(join(dir, ".env")).get("GITHUB_TOKEN"), "ghp_abc");
});

test("upsertEnvFile preserves unrelated lines and comments verbatim, appends new keys under its own header", () => {
  writeFileSync(join(dir, ".env"), "# a hand-written comment\nFOO=bar\n\nBAZ=qux\n");
  upsertEnvFile(dir, { GITHUB_TOKEN: "ghp_abc" });
  const raw = readFileSync(join(dir, ".env"), "utf-8");
  assert.match(raw, /# a hand-written comment/);
  assert.match(raw, /FOO=bar/);
  assert.match(raw, /BAZ=qux/);
  assert.match(raw, /GITHUB_TOKEN=ghp_abc/);
});

test("upsertEnvFile rewrites an existing key in place — never a duplicate line", () => {
  writeFileSync(join(dir, ".env"), "GITHUB_TOKEN=ghp_old\nOTHER=1\n");
  const result = upsertEnvFile(dir, { GITHUB_TOKEN: "ghp_new" });
  assert.deepEqual(result, { added: [], updated: ["GITHUB_TOKEN"], unchanged: [] });
  const raw = readFileSync(join(dir, ".env"), "utf-8");
  assert.equal((raw.match(/GITHUB_TOKEN=/g) || []).length, 1);
  assert.match(raw, /GITHUB_TOKEN=ghp_new/);
  assert.match(raw, /OTHER=1/);
});

test("upsertEnvFile is a no-op the second time with the same values", () => {
  upsertEnvFile(dir, { GITHUB_TOKEN: "ghp_abc" });
  const before = readFileSync(join(dir, ".env"), "utf-8");
  const result = upsertEnvFile(dir, { GITHUB_TOKEN: "ghp_abc" });
  assert.deepEqual(result, { added: [], updated: [], unchanged: ["GITHUB_TOKEN"] });
  assert.equal(readFileSync(join(dir, ".env"), "utf-8"), before);
});

test("readEnvFile ignores blank lines and comments, and returns an empty map for a missing file", () => {
  writeFileSync(join(dir, ".env"), "# comment\n\nA=1\n  # indented comment\nB=2\n");
  const values = readEnvFile(join(dir, ".env"));
  assert.deepEqual([...values.entries()], [["A", "1"], ["B", "2"]]);
  assert.equal(readEnvFile(join(dir, "nope.env")).size, 0);
});

test("maskSecret keeps only the last 4 characters; short values are fully masked", () => {
  const value = "ghp_1234567890abcdef"; // 20 chars, last 4 = "cdef"
  const masked = maskSecret(value);
  assert.equal(masked.length, value.length);
  assert.match(masked, /^•+cdef$/);
  assert.equal(maskSecret("abcd"), "••••");
  assert.equal(maskSecret("ab"), "••");
});

test("writeEnvExample writes key names with empty values, sorted and de-duplicated", () => {
  writeEnvExample(dir, ["GITHUB_TOKEN", "JIRA_EMAIL", "GITHUB_TOKEN"]);
  const raw = readFileSync(join(dir, ".env.example"), "utf-8");
  assert.equal(raw, "# spf — keys required by this repo's spf.config.yaml; fill in real values in .env (gitignored)\nGITHUB_TOKEN=\nJIRA_EMAIL=\n");
});

test("writeEnvExample writes nothing when there are no keys", () => {
  writeEnvExample(dir, []);
  assert.equal(existsSync(join(dir, ".env.example")), false);
});
