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
import { initCommand, EXAMPLE_CHAIN_YAML } from "../cli/commands/init.js";
import { loadRepoChains } from "../chains/repo_chains.js";
import { resolveAnchor } from "../core/paths.js";

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

test("scaffolds .spf/chains/example.yaml, fully commented out (registers nothing)", async () => {
  const code = await initCommand(["--cwd", dir, "--yes"]);
  assert.equal(code, 0);
  const examplePath = join(dir, ".spf", "chains", "example.yaml");
  assert.ok(existsSync(examplePath), "spf init should scaffold .spf/chains/example.yaml");
  const content = readFileSync(examplePath, "utf-8");
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    assert.ok(line.startsWith("#"), `every non-blank line in the scaffolded example must be commented out: ${JSON.stringify(line)}`);
  }
});

test("never adds .spf/chains to .gitignore — chain files must stay tracked for protected_files to cover them", async () => {
  await initCommand(["--cwd", dir, "--yes"]);
  const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
  assert.doesNotMatch(gitignore, /\.spf\/chains/);
});

test("the scaffolded example.yaml loads clean — zero chains, zero problems (it must not report a problem against spf's own scaffold)", async () => {
  const code = await initCommand(["--cwd", dir, "--yes"]);
  assert.equal(code, 0);
  const anchor = resolveAnchor(dir);
  const { chains, problems } = loadRepoChains(anchor);
  assert.deepEqual(chains, []);
  assert.deepEqual(problems, []);
});

test("EXAMPLE_CHAIN_YAML's commented-out template, uncommented verbatim, is a chain the loader accepts", async () => {
  const lines = EXAMPLE_CHAIN_YAML.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("# name: example"));
  assert.ok(startIdx !== -1, "expected a `# name: example` line to anchor the template block");
  const uncommented = lines
    .slice(startIdx)
    .map((l) => l.replace(/^#\s?/, ""))
    .join("\n");

  const chainsDir = join(dir, ".spf", "chains");
  execFileSync("mkdir", ["-p", chainsDir]);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(chainsDir, "uncommented.yaml"), uncommented);

  const anchor = resolveAnchor(dir);
  const { chains, problems } = loadRepoChains(anchor);
  assert.deepEqual(problems, [], `expected zero problems, got: ${JSON.stringify(problems)}`);
  assert.equal(chains.length, 1);
  assert.equal(chains[0]?.name, "example");
});

test("re-running spf init doesn't overwrite an already-scaffolded example.yaml", async () => {
  await initCommand(["--cwd", dir, "--yes"]);
  const examplePath = join(dir, ".spf", "chains", "example.yaml");
  const before = readFileSync(examplePath, "utf-8");
  await initCommand(["--cwd", dir, "--template", "ts-cc"]); // no --force
  assert.equal(readFileSync(examplePath, "utf-8"), before);
});

test("re-running spf init doesn't re-copy an unchanged skill install (install-skill's own idempotency)", async () => {
  await initCommand(["--cwd", dir, "--yes"]);
  const manifestPath = join(dir, ".claude", "skills", "spf", ".spf-skill-version");
  const before = readFileSync(manifestPath, "utf-8");
  await initCommand(["--cwd", dir, "--template", "ts-cc"]); // no --force: config write is a no-op, skill install still runs
  assert.equal(readFileSync(manifestPath, "utf-8"), before);
});
