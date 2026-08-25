/**
 * The question flow behind `spf init`'s interactive interview. No filesystem
 * writes happen here — `commands/init.ts` owns those, so this module stays
 * unit-testable against a scripted `Asker` (see `src/test/interview.test.ts`)
 * without touching disk beyond the read-only `DetectedContext` gather.
 *
 * Every section below mirrors an existing, already-shipped code path rather
 * than inventing new vocabulary:
 *   - coding agent          -> src/core/agent_cc.ts / agent_flue.ts, src/core/providers.ts
 *   - quality checks        -> src/core/data_types.ts's QualityCheckSpecSchema
 *   - watch ticket loop     -> src/cli/commands/watch.ts's resolveIssueProvider/resolveCodeHostProvider
 *   - the pinned-roster fix -> assets/templates/ts-cc.spf.config.yaml, done by hand today
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { binaryOnPath } from "../core/utils.ts";
import { PROVIDER_ENV_KEYS } from "../core/providers.ts";
import { resolveModel } from "../core/agent_flue.ts";
import { ThinkingLevelSchema } from "../core/data_types.ts";
import { loadConfig } from "../core/agents.ts";
import { BUILTIN_CONFIG_PATH } from "../core/paths.ts";
import { DEFAULT_NOTIFY_ENV_KEY } from "../core/notify/notifier.ts";
import { allChains } from "../chains/index.ts";
import type { Asker } from "./ask.ts";

// ── detected context ────────────────────────────────────────────────────────

export interface DetectedContext {
  repoSlug?: string; // "owner/name" from origin's remote URL, if it parses
  currentBranch: string;
  gitEmail?: string;
  gitName?: string;
  scripts: Record<string, string>; // package.json's own scripts block
  claudeOnPath: boolean;
  /** Whatever's already in `.env` — shown masked so a re-run can offer "keep current" instead of asking blind. */
  existingEnv: Map<string, string>;
  /** The packaged roster's agent names (planner, builder, scout, reviewer, documenter today) — read from the built-in config so a 6th agent added there needs no interview change. */
  rosterNames: string[];
}

function gitConfigValue(repoRoot: string, key: string): string | undefined {
  const result = spawnSync("git", ["config", key], { cwd: repoRoot, encoding: "utf-8" });
  const value = result.status === 0 ? result.stdout.trim() : "";
  return value || undefined;
}

/** Parses the common GitHub/Bitbucket remote URL shapes (https and ssh) into "owner/name". Best-effort — an unparseable or missing remote just means no default to offer. */
function parseRemoteSlug(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /(?:[/:])([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url.trim());
  return match ? match[1] : undefined;
}

function readScripts(repoRoot: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf-8"));
    return pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  } catch {
    return {};
  }
}

/** Best-effort — a corrupt/missing built-in config falls back to the three names the auto-override already knows about, rather than failing the whole interview. */
function readRosterNames(): string[] {
  try {
    return loadConfig([BUILTIN_CONFIG_PATH]).agents.map((a) => a.name);
  } catch {
    return ["planner", "builder", "scout", "reviewer", "documenter"];
  }
}

export function gatherContext(repoRoot: string, existingEnv: Map<string, string> = new Map()): DetectedContext {
  const remote = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: repoRoot, encoding: "utf-8" });
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot, encoding: "utf-8" });
  return {
    repoSlug: parseRemoteSlug(remote.status === 0 ? remote.stdout.trim() : undefined),
    currentBranch: branch.status === 0 && branch.stdout.trim() !== "HEAD" ? branch.stdout.trim() : "main",
    gitEmail: gitConfigValue(repoRoot, "user.email"),
    gitName: gitConfigValue(repoRoot, "user.name"),
    scripts: readScripts(repoRoot),
    claudeOnPath: binaryOnPath("claude"),
    existingEnv,
    rosterNames: readRosterNames(),
  };
}

// ── result shape ─────────────────────────────────────────────────────────────

export interface InterviewResult {
  config: Record<string, unknown>;
  env: Record<string, string>;
  /** Key names only (no values) — written to a committable `.env.example`. */
  envExampleKeys: string[];
}

const QUALITY_TIMEOUTS: Record<string, number> = { typecheck: 60, lint: 60, build: 120, test: 180 };

function splitArgv(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * Runs the interview and returns the config/env to write, or `null` if the
 * user declines the final confirmation. Throws `InterviewAborted` (from
 * `./ask.ts`) on Ctrl-C/EOF — the caller decides the exit code for that.
 */
export async function runInterview(asker: Asker, ctx: DetectedContext): Promise<InterviewResult | null> {
  const defaults: Record<string, unknown> = {};
  const agentOverrides: Record<string, unknown>[] = [];
  const env: Record<string, string> = {};
  // Declarative, non-secret env vars — written to spf.config.yaml's `env:`
  // (committable) rather than `.env` (gitignored, and read once from the
  // shell rather than declared). `SPF_CLAUDE_CMD` is the one case so far:
  // it names a launcher/wrapper command, not a credential.
  const configEnv: Record<string, string> = {};
  const envExampleKeys: string[] = [];
  const notes: string[] = [];

  // ── 1. coding agent ────────────────────────────────────────────────────────
  asker.heading("Coding agent");
  const codingAgent = await asker.select(
    "Which backend runs each agent?",
    [
      { value: "claude_code", label: "claude_code — shells out to the `claude` CLI you already use", hint: "cc" },
      { value: "flue", label: "flue — in-process, provider/model-id (openai, anthropic, openrouter, ...)" },
    ],
    "claude_code",
  );
  defaults.coding_agent = codingAgent;

  if (codingAgent === "claude_code") {
    if (!ctx.claudeOnPath) {
      asker.note("warning: `claude` was not found on PATH — install it (or set a launch command below) before running spf.");
    }
    const launchCommand = await asker.text(
      'Launch command for the `claude` CLI — e.g. "ollama launch claude --model {model}" to route through a wrapper, with {model} substituted per-agent (writes env.SPF_CLAUDE_CMD to spf.config.yaml)',
      { default: "claude" },
    );
    if (launchCommand !== "claude") configEnv["SPF_CLAUDE_CMD"] = launchCommand;

    const model = await asker.select(
      "Model (Claude Code's own vocabulary — not provider/model-id)",
      [
        { value: "sonnet", label: "sonnet" },
        { value: "opus", label: "opus" },
        { value: "haiku", label: "haiku" },
        { value: "custom", label: "custom — type an exact model name" },
      ],
      "sonnet",
    );
    defaults.model = model === "custom" ? await asker.text("Exact model name") : model;

    const auth = await asker.select(
      "Authentication",
      [
        { value: "login", label: "already logged in via `claude login`", hint: "writes nothing" },
        { value: "key", label: "ANTHROPIC_API_KEY" },
        { value: "endpoint", label: "custom endpoint (Ollama / Ollama Cloud / a proxy)" },
      ],
      "login",
    );
    if (auth === "key") {
      const current = ctx.existingEnv.get("ANTHROPIC_API_KEY");
      const key = await asker.secret("ANTHROPIC_API_KEY", { current });
      if (key) env["ANTHROPIC_API_KEY"] = key;
      envExampleKeys.push("ANTHROPIC_API_KEY");
    } else if (auth === "endpoint") {
      const baseUrl = await asker.text("ANTHROPIC_BASE_URL", { default: "http://localhost:11434" });
      env["ANTHROPIC_BASE_URL"] = baseUrl;
      const token = await asker.secret("ANTHROPIC_AUTH_TOKEN", { current: ctx.existingEnv.get("ANTHROPIC_AUTH_TOKEN") });
      env["ANTHROPIC_AUTH_TOKEN"] = token || "ollama";
      envExampleKeys.push("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN");
      asker.note(
        "spf doctor now probes ANTHROPIC_BASE_URL with a minimal POST /v1/messages (informational only, never a hard failure) and flags a base URL that already ends in \"/v1\" as a likely double-path mistake — the default above (without a trailing /v1) is exactly what that check is guarding against. It still cannot validate ANTHROPIC_AUTH_TOKEN itself.",
      );
    }

    // The packaged roster pins planner/reviewer/documenter to their own
    // Flue-style provider/model-id strings, which always win over
    // defaults.model (agents.ts's back-fill only applies when an agent
    // doesn't already set its own `model`). Left alone, switching the
    // backend to claude_code sends those three straight to the `claude`
    // CLI's `--model` flag as e.g. "fireworks/accounts/.../kimi-k3", which
    // it cannot resolve. Override all three to the same model chosen above
    // — exactly what assets/templates/ts-cc.spf.config.yaml does by hand.
    for (const name of ["planner", "reviewer", "documenter"]) {
      agentOverrides.push({ name, model: defaults.model });
    }
    notes.push("planner/reviewer/documenter pin their own model in the packaged roster and always win over defaults.model — overriding all three to match, since claude_code can't resolve their packaged Flue-style ids.");
  } else {
    const provider = await asker.select(
      "Provider",
      Object.keys(PROVIDER_ENV_KEYS).map((p) => ({ value: p, label: p })),
      "anthropic",
    );
    const modelId = await asker.text(`Model id (after "${provider}/")`, {
      default: provider === "anthropic" ? "claude-sonnet-4-6" : "",
      validate: (val) => (val.trim() ? null : "required"),
    });
    const model = `${provider}/${modelId}`;
    try {
      resolveModel(model);
    } catch (error) {
      asker.note(`warning: ${(error as Error).message}`);
    }
    defaults.model = model;

    const envKeys = PROVIDER_ENV_KEYS[provider];
    if (envKeys.length > 0) {
      const envKey = envKeys[0];
      const key = await asker.secret(envKey, { current: ctx.existingEnv.get(envKey) });
      if (key) env[envKey] = key;
      envExampleKeys.push(envKey);
    } else {
      asker.note(`${provider} is keyless — no API key to collect.`);
      if (provider === "ollama") {
        // Same shape as the claude_code branch's ANTHROPIC_BASE_URL prompt
        // above: a local/cloud Ollama server has no key, just an address.
        // The `/v1` suffix matches agent_flue.ts's own registration default
        // (spike-verified: Ollama serves its OpenAI-compatible surface —
        // the one Flue's pi-ai backend actually speaks — under `/v1`, not
        // at the bare root `/api/...` Ollama also exposes).
        const baseUrl = await asker.text("OLLAMA_BASE_URL", {
          default: "http://localhost:11434/v1",
          validate: (v) => (v.trim() ? null : "required"),
        });
        env["OLLAMA_BASE_URL"] = baseUrl;
        envExampleKeys.push("OLLAMA_BASE_URL");
        asker.note("spf doctor checks this one — a probe against OLLAMA_BASE_URL/models runs on every `spf doctor`.");

        // Same problem the claude_code branch already solves above: the
        // packaged roster pins planner/reviewer/documenter to their own
        // fireworks/gemini/openai model strings, which always win over
        // defaults.model. Left alone, this flow would produce a config
        // where three of six agents are still routed at hosted providers
        // whose keys this ollama flow never collects — `spf doctor` would
        // immediately report missing FIREWORKS_API_KEY/GEMINI_API_KEY/
        // OPENAI_API_KEY right after an interview that asked for neither.
        for (const name of ["planner", "reviewer", "documenter"]) {
          agentOverrides.push({ name, model: defaults.model });
        }
        notes.push(
          "planner/reviewer/documenter pin their own model in the packaged roster and always win over defaults.model — overriding all three to the ollama model chosen above, or spf doctor would report missing FIREWORKS_API_KEY/GEMINI_API_KEY/OPENAI_API_KEY for providers this flow never asked about.",
        );
      }
    }
  }

  // Declined (the default): today's behavior exactly — on claude_code, the
  // three-agent auto-pin above stands unchanged; on flue, no agents: block
  // at all. Accepted: ask every roster agent's model, defaulting to the one
  // chosen above, and patch/append its override — `mergeAgentLists`
  // (agents.ts:63-71) shallow-patches by name, so re-setting `model` on an
  // already-pinned entry (claude_code's planner/reviewer/documenter) is
  // exactly the right shape, no `prompt_engineering` needed (interview.ts's
  // review-section comment explains why that's fine).
  const customizeModels = await asker.confirm("Customize models per agent?", false);
  if (customizeModels) {
    asker.heading("Per-agent models");
    for (const name of ctx.rosterNames) {
      const answer = await asker.text(`  ${name}`, { default: String(defaults.model) });
      if (codingAgent === "flue") {
        try {
          resolveModel(answer);
        } catch (error) {
          asker.note(`warning: ${(error as Error).message}`);
        }
      }
      const existing = agentOverrides.find((a) => a.name === name);
      if (existing) existing.model = answer;
      else agentOverrides.push({ name, model: answer });
    }
  }

  // ── 2. quality checks ──────────────────────────────────────────────────────
  asker.heading("Quality checks");
  asker.note("a chain that gates on a suite (e.g. plan-build-test's `test`) fails loudly before anything runs if the suite is unconfigured.");
  const checks: Record<string, unknown>[] = [];
  const configuredNames: string[] = [];
  for (const [checkName, operation, scriptGuess] of [
    ["typecheck", "typecheck", "typecheck"],
    ["lint", "lint", "lint"],
    ["build", "build", "build"],
    ["test", "build", "test"],
  ] as const) {
    const detectedScript = ctx.scripts[scriptGuess] ? `npm run ${scriptGuess}` : "";
    const wantIt = await asker.confirm(`Add a "${checkName}" check?`, Boolean(detectedScript));
    if (!wantIt) continue;
    const command = await asker.text(`  ${checkName} command`, { default: detectedScript || `npm run ${scriptGuess}` });
    checks.push({ name: checkName, operation, argv: splitArgv(command), timeout_seconds: QUALITY_TIMEOUTS[checkName] });
    configuredNames.push(checkName);
  }
  if (checks.length > 0) {
    const suites: Record<string, string[]> = { all: configuredNames };
    if (configuredNames.includes("test")) suites.test = ["test"];
    defaults["__quality__"] = { checks, suites };
  }

  // ── 3. watch ticket loop ────────────────────────────────────────────────────
  asker.heading("Watch ticket loop (spf watch)");
  const enableWatch = await asker.confirm("Enable spf watch (poll a tracker, run a chain per issue, open a PR)?", false);
  let watch: Record<string, unknown> | null = null;
  if (enableWatch) {
    const issueProvider = await asker.select(
      "Issue tracker",
      [
        { value: "github", label: "GitHub Issues" },
        { value: "jira", label: "Jira" },
      ],
      "github",
    );
    const codeHost = await asker.select(
      "Code host (where PRs open)",
      [
        { value: "github", label: "GitHub" },
        { value: "bitbucket", label: "Bitbucket" },
      ],
      "github",
    );
    const repoHint = codeHost === "bitbucket" ? "workspace/repo_slug" : "owner/name";
    // github issues + bitbucket code is the one combination where a single
    // repo field is ambiguous — they're two different repos in two
    // different systems, not one repo worn two ways (github+github is one
    // repo by construction; jira never reads `repo` at all). Ask a second,
    // explicitly-labeled question only in that one case.
    const splitRepo = issueProvider === "github" && codeHost === "bitbucket";
    const repo = await asker.text(splitRepo ? `Code repo, where PRs open (${repoHint})` : `Repo (${repoHint})`, {
      default: codeHost === "github" ? ctx.repoSlug ?? "" : "",
      validate: (val) => (val.includes("/") && val.split("/").filter(Boolean).length === 2 ? null : `must be "${repoHint}"`),
    });
    let issueRepo = "";
    if (splitRepo) {
      asker.note("GitHub issues and the Bitbucket code repo are different repos here — spf watch needs both.");
      issueRepo = await asker.text("Issue repo, where spf:ready issues live (owner/name)", {
        default: ctx.repoSlug ?? "",
        validate: (val) => (val.includes("/") && val.split("/").filter(Boolean).length === 2 ? null : `must be "owner/name"`),
      });
    }
    const labelPrefix = await asker.text("Label prefix", { default: "spf" });
    const baseBranch = await asker.text("Base branch", { default: ctx.currentBranch });
    // allChains(), not the built-in-only CHAINS: `registerRepoChains` already
    // ran in main() before initCommand, so a pre-existing `.spf/chains/`
    // repo chain is a legal watch.chain everywhere else (watch.ts resolves
    // it via findChain, doctor.ts validates and labels it) — this picker is
    // the one place a user chooses watch.chain, so it must offer the same
    // set. The "(repo)" hint marker distinguishes it in the list.
    const chainChoices = allChains().map((c) => ({ value: c.name, label: c.name, hint: c.source ? `${c.describe} (repo)` : c.describe }));
    const chain = await asker.select("Chain to run per issue", chainChoices, "plan-build-test");

    watch = { issue_provider: issueProvider, code_host: codeHost, repo, label_prefix: labelPrefix, chain, base_branch: baseBranch };
    if (issueRepo) watch.issue_repo = issueRepo;

    // Issue authoring (create + link a hierarchy) is implemented on both
    // GitHubProvider and JiraProvider — see jira_provider.ts's module
    // comment for how Jira's version works (native issue types + the
    // `parent` field).
    if (issueProvider === "github" || issueProvider === "jira") {
      const enableRefine = await asker.confirm(
        `Also enable the refine lane (decompose a "${labelPrefix}:spec-ready" product spec into a feature/story-or-bug tree)?`,
        false,
      );
      if (enableRefine) {
        const refineChainChoices = allChains().map((c) => ({ value: c.name, label: c.name, hint: c.source ? `${c.describe} (repo)` : c.describe }));
        const refineChain = await asker.select("Chain to run per spec", refineChainChoices, "refine");
        watch.refine = { enabled: true, chain: refineChain };
        if (issueProvider === "jira") {
          asker.note(
            'Jira issue types default to epic/feature -> "Epic", story -> "Story", bug -> "Bug", task -> "Task" — ' +
              "customize per-kind in watch.jira.issue_types if your project renames any of them, then run `spf watch init` to validate.",
          );
        }
      }
    }

    if (issueProvider === "jira") {
      const baseUrl = await asker.text("Jira base URL", {
        default: "https://your-domain.atlassian.net",
        validate: (val) => (/^https:\/\/.+/.test(val) ? null : "must start with https://"),
      });
      const projectKey = await asker.text("Jira project key", { validate: (val) => (val.trim() ? null : "required") });
      watch.jira = { base_url: baseUrl.replace(/\/+$/, ""), project_key: projectKey.toUpperCase() };
    }

    const needsGithub = issueProvider === "github" || codeHost === "github";
    if (needsGithub) {
      asker.note('classic PAT, "repo" scope (private) or "public_repo" (public-only) — never "project".');
      const token = await asker.secret("GITHUB_TOKEN", { current: ctx.existingEnv.get("GITHUB_TOKEN") });
      if (token) env["GITHUB_TOKEN"] = token;
      envExampleKeys.push("GITHUB_TOKEN");
    }
    if (issueProvider === "jira") {
      const email = await asker.text("JIRA_EMAIL", { default: ctx.gitEmail ?? "" });
      if (email) env["JIRA_EMAIL"] = email;
      const token = await asker.secret("JIRA_API_TOKEN", { current: ctx.existingEnv.get("JIRA_API_TOKEN") });
      if (token) env["JIRA_API_TOKEN"] = token;
      envExampleKeys.push("JIRA_EMAIL", "JIRA_API_TOKEN");
      asker.note("id.atlassian.com -> Security -> API tokens");
    }
    if (codeHost === "bitbucket") {
      const email = await asker.text("BITBUCKET_EMAIL", { default: ctx.gitEmail ?? "" });
      if (email) env["BITBUCKET_EMAIL"] = email;
      const token = await asker.secret("BITBUCKET_API_TOKEN", { current: ctx.existingEnv.get("BITBUCKET_API_TOKEN") });
      if (token) env["BITBUCKET_API_TOKEN"] = token;
      envExampleKeys.push("BITBUCKET_EMAIL", "BITBUCKET_API_TOKEN");
      asker.note("Bitbucket app passwords are being removed — this needs an Atlassian API token instead.");
    }
  }

  // ── 4. notifications ─────────────────────────────────────────────────────────
  asker.heading("Notifications");
  const enableNotify = await asker.confirm("Send notifications to Slack, Teams, or a webhook?", false);
  let notifications: Record<string, unknown> | null = null;
  if (enableNotify) {
    const events = await asker.select(
      "Notify on",
      [
        { value: "errors", label: "errors — failed runs and watch errors only" },
        { value: "attention", label: "attention — errors, plus blocked issues and feedback requests" },
        { value: "all", label: "all — every milestone (claimed, PR opened, done, ...) plus attention and errors" },
      ],
      "attention",
    );
    const channels: Record<string, unknown>[] = [];
    for (;;) {
      const kind = await asker.select(
        "Channel",
        [
          { value: "slack", label: "Slack — Incoming Webhook" },
          { value: "teams", label: "Microsoft Teams — Workflows webhook" },
          { value: "webhook", label: "generic webhook — POSTs the raw event as JSON" },
        ],
        "slack",
      );
      const envKey = DEFAULT_NOTIFY_ENV_KEY[kind];
      if (kind === "slack") {
        asker.note("Slack app -> Incoming Webhooks -> Add New Webhook to Workspace.");
        asker.note("Docs: https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks");
      } else if (kind === "teams") {
        asker.note("In the target channel, add a Workflows webhook template (search for one like \"Post to a channel when a webhook request is received\"). The old Office 365 connector webhooks are retired — this is the only path now.");
        asker.note("Docs: https://support.microsoft.com/en-us/office/post-a-workflow-when-a-webhook-request-is-received-in-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498");
      } else {
        asker.note("Any endpoint that accepts a JSON POST — Discord, n8n, Zapier, your own.");
      }
      const url = await asker.secret(envKey, { current: ctx.existingEnv.get(envKey) });
      if (url) env[envKey] = url;
      envExampleKeys.push(envKey);
      channels.push({ kind, webhook_url_env: envKey });
      const another = await asker.confirm("Add another channel?", false);
      if (!another) break;
    }
    notifications = { events, channels };
  }

  // ── 5. advanced (gated) ─────────────────────────────────────────────────────
  const wantAdvanced = await asker.confirm("\nConfigure advanced settings (thinking level, tools, protected files, data dir, poll intervals, ...)?", false);
  if (wantAdvanced) {
    asker.heading("Advanced");
    const thinkingChoices = ThinkingLevelSchema.options.map((o) => ({ value: o, label: o }));
    const thinking = await asker.select("defaults.thinking", thinkingChoices, "medium");
    if (thinking !== "medium") defaults.thinking = thinking;

    const dataDir = await asker.text("defaults.data_dir", { default: ".spf/data" });
    if (dataDir !== ".spf/data") defaults.data_dir = dataDir;

    const protectedFiles = await asker.text("defaults.protected_files (comma-separated)", { default: ".spf/, spf.config.yaml" });
    const protectedList = protectedFiles.split(",").map((s) => s.trim()).filter(Boolean);
    if (protectedList.join(",") !== ".spf/,spf.config.yaml") defaults.protected_files = protectedList;

    const dbPath = await asker.text("observability.db", { default: ".spf/data/spf.db" });
    const pollMs = await asker.text("observability.poll_ms", { default: "500" });
    if (dbPath !== ".spf/data/spf.db" || pollMs !== "500") {
      defaults["__observability__"] = { ...(dbPath !== ".spf/data/spf.db" ? { db: dbPath } : {}), ...(pollMs !== "500" ? { poll_ms: Number(pollMs) } : {}) };
    }

    if (watch) {
      const watchPollMs = await asker.text("watch.poll_ms", { default: "60000" });
      if (watchPollMs !== "60000") watch.poll_ms = Number(watchPollMs);
      const concurrency = await asker.text("watch.concurrency", { default: "2" });
      if (concurrency !== "2") watch.concurrency = Number(concurrency);
      if ((watch.refine as Record<string, unknown> | undefined)?.enabled) {
        const refineConcurrency = await asker.text("watch.refine.concurrency", { default: "1" });
        if (refineConcurrency !== "1") (watch.refine as Record<string, unknown>).concurrency = Number(refineConcurrency);
      }
    }

    const engineerName = await asker.text("ENGINEER_NAME (falls back to `git config user.name`)", { default: ctx.gitName ?? "" });
    if (engineerName && engineerName !== ctx.gitName) env["ENGINEER_NAME"] = engineerName;

    if (watch?.issue_provider === "jira") {
      const debug = await asker.confirm("Enable SPF_JIRA_DEBUG (request/response logging)?", false);
      if (debug) env["SPF_JIRA_DEBUG"] = "1";
    }

    if (notifications) {
      const timeoutMs = await asker.text("notifications.timeout_ms", { default: "5000" });
      if (timeoutMs !== "5000") notifications.timeout_ms = Number(timeoutMs);
    }
  }

  // ── 6. review + confirm ─────────────────────────────────────────────────────
  const observability = defaults["__observability__"] as Record<string, unknown> | undefined;
  delete defaults["__observability__"];
  const quality = defaults["__quality__"] as { checks: unknown[]; suites: Record<string, string[]> } | undefined;
  delete defaults["__quality__"];

  const config: Record<string, unknown> = { defaults };
  if (Object.keys(configEnv).length > 0) config.env = configEnv;
  if (agentOverrides.length > 0) config.agents = agentOverrides;
  if (quality) config.quality = quality;
  if (watch) config.watch = watch;
  if (observability) config.observability = observability;
  if (notifications) config.notifications = notifications;

  // No schema validation here on purpose: `config.agents` overrides are
  // intentionally PARTIAL (name + model only, no prompt_engineering) — valid
  // only once merged by name into the packaged roster (agents.ts's
  // mergeAgentLists), same as any hand-written override file. Validating
  // this raw document against the full SFConfigSchema would flag every
  // claude_code interview as broken. `commands/init.ts` runs the real
  // merge-then-validate pipeline (agents.loadConfig + agents.validate,
  // the same one `spf doctor` uses) after writing, and reports there.
  asker.heading("Review");
  console.log(renderPreview(config));
  if (notes.length > 0) {
    for (const n of notes) asker.note(n);
  }
  if (Object.keys(env).length > 0) {
    console.log("");
    console.log(".env keys to write: " + Object.keys(env).join(", "));
  }
  const proceed = await asker.confirm("\nWrite .spf/spf.config.yaml and .env?", true);
  if (!proceed) return null;

  return { config, env, envExampleKeys };
}

/** An array is worth recursing into only if it holds further objects (e.g. `agents:`, `quality.checks`) — an array of primitives (e.g. `argv: ["npm","run","test"]`) reads better printed inline than one bare, contentless line per entry. */
function isArrayOfObjects(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.some((item) => item && typeof item === "object");
}

function renderPreview(config: Record<string, unknown>): string {
  const lines: string[] = [];
  const walk = (obj: Record<string, unknown>, indent: string) => {
    for (const [key, value] of Object.entries(obj)) {
      if (isArrayOfObjects(value)) {
        lines.push(`${indent}${key}:`);
        for (const item of value) {
          lines.push(`${indent}  -`);
          walk(item as Record<string, unknown>, indent + "    ");
        }
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        lines.push(`${indent}${key}:`);
        walk(value as Record<string, unknown>, indent + "  ");
      } else {
        lines.push(`${indent}${key}: ${JSON.stringify(value)}`);
      }
    }
  };
  walk(config, "");
  return lines.join("\n");
}
