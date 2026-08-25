/**
 * `spf init`'s interactive interview (`cli/interview.ts`) — driven through
 * the `Asker` seam with a scripted fake (`./fake_asker.ts`), never a real
 * TTY. Covers the three things a wrong answer would actually break:
 *   1. the pinned-roster trap (planner/reviewer/documenter overridden
 *      whenever the backend switches to claude_code — see agent_cc.ts/
 *      agents.ts's back-fill comment),
 *   2. the generated config is a genuine override — validating it requires
 *      merging with the packaged built-in roster first, exactly like
 *      `spf doctor` does, never the raw document alone,
 *   3. each `spf watch` combination collects exactly the credentials
 *      `cli/commands/watch.ts`'s resolveIssueProvider/resolveCodeHostProvider
 *      actually read — no more, no less.
 */
import "./hermetic_git.js";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runInterview, gatherContext } from "../cli/interview.js";
import { loadConfig, validate } from "../core/agents.js";
import { BUILTIN_CONFIG_PATH } from "../core/paths.js";
import { createFakeAsker } from "./fake_asker.js";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "spf-interview-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/widgets.git"], { cwd: dir });
  // -c user.*, not a global git config: this must pass in a fresh CI runner
  // with no git identity configured at all (same reasoning as ui_server.test.ts).
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=spf tests", "commit", "-q", "--allow-empty", "-m", "init"],
    { cwd: dir },
  );
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Merge with the real packaged roster and validate — the same pipeline `spf doctor` runs, and the only honest way to check a partial override document. */
function mergedConfigPath(): string {
  const configPath = join(dir, `spf.config.${Math.random().toString(36).slice(2)}.yaml`);
  return configPath;
}

test("claude_code + watch(github/github): overrides the three pinned agents and merges cleanly", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Issue tracker": "github",
      "Code host": "github",
      "Chain to run": "plan-build-test",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable spf watch": true,
      "Configure advanced": false,
      "Write .spf": true,
    },
    secret: { GITHUB_TOKEN: "ghp_abcdefghijklmnop" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.defaults.coding_agent, "claude_code");
  assert.equal(config.defaults.model, "sonnet");

  const overrides = config.agents;
  assert.deepEqual(
    overrides.map((a: any) => a.name).sort(),
    ["documenter", "planner", "reviewer"],
  );
  for (const a of overrides) assert.equal(a.model, "sonnet");

  assert.equal(config.watch.repo, "acme/widgets"); // detected from origin
  assert.equal(result!.env.GITHUB_TOKEN, "ghp_abcdefghijklmnop");
  assert.ok(result!.envExampleKeys.includes("GITHUB_TOKEN"));

  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  assert.equal(cfg.defaults.coding_agent, "claude_code");
  assert.equal(cfg.agents.find((a) => a.name === "planner")!.model, "sonnet");
  assert.equal(cfg.agents.find((a) => a.name === "builder")!.model, "sonnet"); // inherits defaults.model, needed no override
  validate(cfg, cfg.agents.map((a) => a.name), Object.keys(cfg.quality.suites), dir); // throws on any problem
});

// Regression for a real production bug: SPF_CLAUDE_CMD="ollama launch
// claude --model <fixed-tag>" baked one model into the whole process, so
// every claude_code agent's own model: field was inert regardless of what
// it said. Picking "ollama" here must write the {model}-templated wrapper
// (agent_cc.ts substitutes it per call) and ask for a real Ollama tag —
// never Claude Code's own sonnet/opus/haiku vocabulary, which `ollama
// launch`'s own --model flag (the one that actually selects the served
// model) would not understand.
test("claude_code + ollama launcher: writes the {model}-templated SPF_CLAUDE_CMD and asks for an Ollama tag, not Claude Code's alias vocabulary", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Launch command for the `claude` CLI": "ollama",
    },
    text: { "Ollama model tag": "kimi-k2.7-code:cloud" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable spf watch": false,
      "Configure advanced": false,
      "Write .spf": true,
    },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.env.SPF_CLAUDE_CMD, "ollama launch claude --model {model}");
  assert.equal(config.defaults.model, "kimi-k2.7-code:cloud");
  for (const a of config.agents) assert.equal(a.model, "kimi-k2.7-code:cloud");
  assert.equal(result!.env.SPF_CLAUDE_CMD, undefined, "declarative, not a secret — belongs in config.env, not .env");

  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  assert.equal(cfg.env.SPF_CLAUDE_CMD, "ollama launch claude --model {model}");
  validate(cfg, cfg.agents.map((a) => a.name), Object.keys(cfg.quality.suites), dir);
});

test("claude_code + plain claude: no SPF_CLAUDE_CMD written, Model stays Claude Code's own alias vocabulary", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Launch command for the `claude` CLI": "claude",
      "Model (Claude": "opus",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable spf watch": false,
      "Configure advanced": false,
      "Write .spf": true,
    },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.env, undefined, "no launcher chosen -> nothing to write into env:");
  assert.equal(config.defaults.model, "opus");
});

test("flue + openrouter: no pinned-agent overrides needed, provider key collected", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "flue", Provider: "openrouter" },
    text: { "Model id": "moonshotai/kimi-k2.7" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable spf watch": false,
      "Configure advanced": false,
      "Write .spf": true,
    },
    secret: { OPENROUTER_API_KEY: "sk-or-v1-test" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.defaults.coding_agent, "flue");
  assert.equal(config.defaults.model, "openrouter/moonshotai/kimi-k2.7");
  assert.equal(config.agents, undefined, "flue never needs the pinned-roster fix — agents' own models are already valid Flue ids");
  assert.equal(result!.env.OPENROUTER_API_KEY, "sk-or-v1-test");
  assert.ok(!("watch" in config));
});

test("flue + ollama: keyless provider skips the API-key prompt, but still asks for OLLAMA_BASE_URL", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "flue", Provider: "ollama" },
    text: { "Model id": "llama3" }, // deliberately no "OLLAMA_BASE_URL" entry — the fake asker falls back to its default
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable spf watch": false,
      "Configure advanced": false,
      "Write .spf": true,
    },
    // Deliberately no `secret` entries: a keyless provider must never call
    // asker.secret() at all — PROVIDER_ENV_KEYS.ollama is `[]`, so indexing
    // [0] for a prompt label would be `undefined`, not skip the prompt.
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.defaults.coding_agent, "flue");
  assert.equal(config.defaults.model, "ollama/llama3");
  assert.deepEqual(result!.env, { OLLAMA_BASE_URL: "http://localhost:11434/v1" }, "no API key, but the base URL prompt's default is written");
  assert.deepEqual(result!.envExampleKeys, ["OLLAMA_BASE_URL"], "OLLAMA_BASE_URL is the only key name to record for a keyless provider");
  // Unlike the openrouter case above, ollama DOES need the pinned-roster
  // fix: planner/reviewer/documenter pin their own fireworks/gemini/openai
  // model strings in the packaged roster, which would otherwise always win
  // over defaults.model and leave three agents needing keys this interview
  // never asked for.
  assert.deepEqual(
    config.agents,
    [
      { name: "planner", model: "ollama/llama3" },
      { name: "reviewer", model: "ollama/llama3" },
      { name: "documenter", model: "ollama/llama3" },
    ],
    "planner/reviewer/documenter are pinned to the chosen ollama model, same fix as the claude_code branch",
  );
});

test("flue + ollama: a custom OLLAMA_BASE_URL answer is written verbatim", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "flue", Provider: "ollama" },
    text: { "Model id": "llama3", OLLAMA_BASE_URL: "http://gpu-box.local:11434/v1" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable spf watch": false,
      "Configure advanced": false,
      "Write .spf": true,
    },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  assert.equal(result!.env.OLLAMA_BASE_URL, "http://gpu-box.local:11434/v1");
});

test("watch(jira/bitbucket): collects exactly JIRA_* + BITBUCKET_*, never GITHUB_TOKEN", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Issue tracker": "jira",
      "Code host": "bitbucket",
      "Chain to run": "plan-build-test",
    },
    text: {
      "Repo (workspace/repo_slug)": "acme/widgets-repo",
      "Jira base URL": "https://acme.atlassian.net/",
      "Jira project key": "proj",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable spf watch": true,
      "Configure advanced": false,
      "Write .spf": true,
    },
    secret: { JIRA_API_TOKEN: "jira-token", BITBUCKET_API_TOKEN: "bb-token" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.watch.issue_provider, "jira");
  assert.equal(config.watch.code_host, "bitbucket");
  assert.equal(config.watch.jira.base_url, "https://acme.atlassian.net"); // trailing slash stripped
  assert.equal(config.watch.jira.project_key, "PROJ"); // upper-cased

  assert.equal(result!.env.JIRA_API_TOKEN, "jira-token");
  assert.equal(result!.env.BITBUCKET_API_TOKEN, "bb-token");
  assert.equal(result!.env.GITHUB_TOKEN, undefined, "neither provider needs GitHub — must not ask for or write GITHUB_TOKEN");
});

test("watch(jira): the refine-lane question is now reachable on Jira too, not just GitHub", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Issue tracker": "jira",
      "Code host": "bitbucket",
      // "Chain to run per spec" must be checked before the shorter "Chain to
      // run" — both are substrings of the "per spec" question's own label,
      // and fake_asker.ts's firstMatch() returns whichever key it finds
      // first in this object's own key order, not the most specific one.
      "Chain to run per spec": "refine",
      "Chain to run": "plan-build-test",
    },
    text: {
      "Repo (workspace/repo_slug)": "acme/widgets-repo",
      "Jira base URL": "https://acme.atlassian.net/",
      "Jira project key": "proj",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable spf watch": true,
      "Also enable the refine lane": true,
      "Configure advanced": false,
      "Write .spf": true,
    },
    secret: { JIRA_API_TOKEN: "jira-token", BITBUCKET_API_TOKEN: "bb-token" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.watch.refine.enabled, true);
  assert.equal(config.watch.refine.chain, "refine");
});

test("watch(github issues + bitbucket code): asks two repo questions and writes issue_repo separately from repo", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Issue tracker": "github",
      "Code host": "bitbucket",
      "Chain to run": "plan-build-test",
    },
    text: {
      "Code repo, where PRs open (workspace/repo_slug)": "acme-workspace/widgets-code",
      "Issue repo, where spf:ready issues live (owner/name)": "acme/widgets-issues",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable spf watch": true,
      "Also enable the refine lane": false,
      "Configure advanced": false,
      "Write .spf": true,
    },
    secret: { GITHUB_TOKEN: "ghp_x", BITBUCKET_API_TOKEN: "bb-token" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.watch.issue_provider, "github");
  assert.equal(config.watch.code_host, "bitbucket");
  assert.equal(config.watch.repo, "acme-workspace/widgets-code", "repo is the CODE HOST's repo");
  assert.equal(config.watch.issue_repo, "acme/widgets-issues", "issue_repo overrides repo for the issue tracker side");

  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  assert.equal(cfg.watch.repo, "acme-workspace/widgets-code");
  assert.equal(cfg.watch.issue_repo, "acme/widgets-issues");
});

test("watch(github issues + github code): a single repo answers both, issue_repo stays unset", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Issue tracker": "github",
      "Code host": "github",
      "Chain to run": "plan-build-test",
    },
    text: { "Repo (owner/name)": "acme/widgets" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable spf watch": true,
      "Also enable the refine lane": false,
      "Configure advanced": false,
      "Write .spf": true,
    },
    secret: { GITHUB_TOKEN: "ghp_x" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.watch.repo, "acme/widgets");
  assert.equal(config.watch.issue_repo, undefined, "the single-repo case never writes issue_repo at all");
});

test("declining the final confirm returns null — nothing to write", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({ defaultConfirm: false }); // every confirm, including the final one, says no
  const result = await runInterview(asker, ctx);
  assert.equal(result, null);
});

test("notifications: declining the gate leaves config.notifications undefined", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "claude_code", "Model (Claude": "sonnet", Authentication: "login" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable spf watch": false,
      "Send notifications": false,
      "Configure advanced": false,
      "Write .spf": true,
    },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.notifications, undefined);
});

test("notifications: accepting collects the scope, a channel, and its webhook env key", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Notify on": "all",
      Channel: "slack",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable spf watch": false,
      "Send notifications": true,
      "Add another channel": false,
      "Configure advanced": false,
      "Write .spf": true,
    },
    secret: { SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/XXXX" },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.equal(config.notifications.events, "all");
  assert.deepEqual(config.notifications.channels, [{ kind: "slack", webhook_url_env: "SLACK_WEBHOOK_URL" }]);
  assert.equal(result!.env.SLACK_WEBHOOK_URL, "https://hooks.slack.com/services/T000/B000/XXXX");
  assert.ok(result!.envExampleKeys.includes("SLACK_WEBHOOK_URL"));

  // The written document must still merge and validate cleanly, same
  // pipeline `spf doctor` runs.
  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  assert.equal(cfg.notifications.events, "all");
  assert.equal(cfg.notifications.channels[0]!.kind, "slack");
});

test("customize models per agent: declining keeps today's behavior — only the three pinned agents, all matching defaults.model", async () => {
  const ctx = gatherContext(dir, new Map());
  const asker = createFakeAsker({
    select: { "backend runs": "claude_code", "Model (Claude": "opus", Authentication: "login" },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable spf watch": false,
      "Customize models per agent": false,
      "Send notifications": false,
      "Configure advanced": false,
      "Write .spf": true,
    },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  assert.deepEqual(
    config.agents.map((a: any) => a.name).sort(),
    ["documenter", "planner", "reviewer"],
  );
  for (const a of config.agents) assert.equal(a.model, "opus");
});

test("customize models per agent: accepting patches the pinned three and appends builder/scout/refiner", async () => {
  const ctx = gatherContext(dir, new Map());
  assert.deepEqual(ctx.rosterNames.slice().sort(), ["builder", "documenter", "planner", "refiner", "reviewer", "scout"]);
  const asker = createFakeAsker({
    select: { "backend runs": "claude_code", "Model (Claude": "sonnet", Authentication: "login" },
    text: {
      "  planner": "opus",
      "  builder": "sonnet",
      "  scout": "haiku",
      "  refiner": "opus",
      "  reviewer": "opus",
      "  documenter": "sonnet",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable spf watch": false,
      "Customize models per agent": true,
      "Send notifications": false,
      "Configure advanced": false,
      "Write .spf": true,
    },
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  const config = result!.config as any;
  const byName = Object.fromEntries(config.agents.map((a: any) => [a.name, a.model]));
  assert.deepEqual(byName, { planner: "opus", reviewer: "opus", documenter: "sonnet", builder: "sonnet", scout: "haiku", refiner: "opus" });

  const configPath = mergedConfigPath();
  const { stringify } = await import("yaml");
  writeFileSync(configPath, stringify(config));
  const cfg = loadConfig([BUILTIN_CONFIG_PATH, configPath]);
  validate(cfg, cfg.agents.map((a) => a.name), Object.keys(cfg.quality.suites), dir); // throws on any problem
  assert.equal(cfg.agents.find((a) => a.name === "scout")!.model, "haiku");
});

test("an existing .env value is offered back as the default when a secret is left blank", async () => {
  const ctx = gatherContext(dir, new Map([["GITHUB_TOKEN", "ghp_existingvalue"]]));
  const asker = createFakeAsker({
    select: {
      "backend runs": "claude_code",
      "Model (Claude": "sonnet",
      Authentication: "login",
      "Issue tracker": "github",
      "Code host": "github",
      "Chain to run": "plan-build-test",
    },
    confirm: {
      'Add a "typecheck"': false,
      'Add a "lint"': false,
      'Add a "build"': false,
      'Add a "test"': false,
      "Enable spf watch": true,
      "Configure advanced": false,
      "Write .spf": true,
    },
    // no GITHUB_TOKEN entry in `secret` — the fake leaves it blank, same as a real user hitting Enter to keep the current value
  });

  const result = await runInterview(asker, ctx);
  assert.ok(result);
  assert.equal(result!.env.GITHUB_TOKEN, undefined, "a blank secret answer must not overwrite the existing value with empty");
});
