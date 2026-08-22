/**
 * Regression guard for `spf init`'s non-interactive paths — `--yes`,
 * `--template <name>`, and (implicitly, since the test runner's stdin/stdout
 * are never a TTY) plain `spf init` with no flags. All three must keep
 * writing the exact same content they always have, byte for byte, and must
 * never touch stdin — a scripted `spf init` in CI must not hang.
 *
 * The interactive interview itself is covered directly against `Asker`
 * in `interview.test.ts`; `initCommand`'s interactive branch always calls
 * the real `createAsker()` (backed by `node:readline` on `process.stdin`),
 * which has nothing to read in a test process — exercising it here would
 * just hang, so it isn't.
 */
import "./hermetic_git.js";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { initCommand } from "../cli/commands/init.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "spf-init-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("--yes writes the plain starter config, all commented out, with no interview", async () => {
  const code = await initCommand(["--cwd", dir, "--yes"]);
  assert.equal(code, 0);
  const content = readFileSync(join(dir, ".spf", "spf.config.yaml"), "utf-8");
  assert.match(content, /merged ON TOP of spf's packaged built-in defaults/);
  assert.match(content, /^# quality:/m); // every real section stays commented out
  assert.doesNotMatch(content, /^defaults:/m);
});

test("plain `spf init` (no TTY in a test process) falls through to the same starter config as --yes", async () => {
  const code = await initCommand(["--cwd", dir]);
  assert.equal(code, 0);
  const content = readFileSync(join(dir, ".spf", "spf.config.yaml"), "utf-8");
  assert.match(content, /merged ON TOP of spf's packaged built-in defaults/);
});

test("--template writes the named template as-is, skipping the interview even without --yes", async () => {
  const code = await initCommand(["--cwd", dir, "--template", "ts-cc"]);
  assert.equal(code, 0);
  const content = readFileSync(join(dir, ".spf", "spf.config.yaml"), "utf-8");
  assert.match(content, /Claude Code backend, pointed at Ollama/);
});

test("an existing config is left alone without --force, even for --yes", async () => {
  await initCommand(["--cwd", dir, "--yes"]);
  const before = readFileSync(join(dir, ".spf", "spf.config.yaml"), "utf-8");
  const code = await initCommand(["--cwd", dir, "--template", "ts-cc"]); // no --force
  assert.equal(code, 0);
  assert.equal(readFileSync(join(dir, ".spf", "spf.config.yaml"), "utf-8"), before);
});

test("--force overwrites an existing config non-interactively", async () => {
  await initCommand(["--cwd", dir, "--yes"]);
  await initCommand(["--cwd", dir, "--template", "ts-cc", "--force"]);
  const content = readFileSync(join(dir, ".spf", "spf.config.yaml"), "utf-8");
  assert.match(content, /Claude Code backend, pointed at Ollama/);
});

test("never writes .env or .env.example on the non-interactive paths", async () => {
  await initCommand(["--cwd", dir, "--yes"]);
  assert.equal(existsSync(join(dir, ".env")), false);
  assert.equal(existsSync(join(dir, ".env.example")), false);
});

test("also installs the repo-local Claude Code skill by default, on every non-interactive path", async () => {
  const code = await initCommand(["--cwd", dir, "--yes"]);
  assert.equal(code, 0);
  assert.ok(existsSync(join(dir, ".claude", "skills", "spf", "SKILL.md")), "spf init should install the skill unless --no-skills is passed");
});

test("--no-skills skips the skill install", async () => {
  const code = await initCommand(["--cwd", dir, "--yes", "--no-skills"]);
  assert.equal(code, 0);
  assert.equal(existsSync(join(dir, ".claude", "skills", "spf")), false);
});

test("re-running spf init doesn't re-copy an unchanged skill install (install-skill's own idempotency)", async () => {
  await initCommand(["--cwd", dir, "--yes"]);
  const manifestPath = join(dir, ".claude", "skills", "spf", ".spf-skill-version");
  const before = readFileSync(manifestPath, "utf-8");
  await initCommand(["--cwd", dir, "--template", "ts-cc"]); // no --force: config write is a no-op, skill install still runs
  assert.equal(readFileSync(manifestPath, "utf-8"), before);
});
