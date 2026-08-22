/**
 * `spf doctor` — the answer to every "why did nothing happen". Resolves and
 * prints every anchor, validates the whole roster (not just what one chain
 * needs), and checks the things that fail silently otherwise: a missing
 * provider key, a quality check whose binary isn't on PATH, a
 * protected_files pattern that matches nothing (how a stale path convention
 * announces itself), an env-file that didn't load.
 */
import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import * as agents from "../../core/agents.ts";
import * as paths from "../../core/paths.ts";
import * as permissions from "../../core/permissions.ts";
import * as agentCc from "../../core/agent_cc.ts";
import { DEFAULT_NOTIFY_ENV_KEY } from "../../core/notify/notifier.ts";
import { isKnownToolName as isKnownFlueToolName, resolveModel } from "../../core/agent_flue.ts";
import { binaryOnPath, parseCli } from "../../core/utils.ts";
import { PROVIDER_ENV_KEYS } from "../../core/providers.ts";
import { isRepoAt } from "../../core/git_helper.ts";
import { findChain, resolveRequiredAgents } from "../../chains/index.ts";
import type { SFConfig } from "../../core/data_types.ts";

interface Report {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

function check(report: Report, name: string, ok: boolean, detail: string): void {
  report.checks.push({ name, ok, detail });
  if (!ok) report.ok = false;
}

export function doctorCommand(argv: string[]): number {
  const { options, flags } = parseCli(argv, ["cwd", "config"], ["json"]);
  const report: Report = { ok: true, checks: [] };

  check(report, "node version", true, process.version);

  const anchor = paths.resolveAnchor(options["cwd"]);
  check(report, "cwd", true, anchor.cwd);
  check(report, "repo_root", true, anchor.repo_root);
  // Informational only — no .spf/ is a fully valid, supported state (pure
  // built-ins), never a failure on its own.
  check(report, ".spf directory", true, anchor.spf_dir ?? "(none — running off packaged built-ins; run `spf init` to override)");

  const isRepo = isRepoAt(anchor.repo_root);
  check(report, "git repository", isRepo, isRepo ? "yes" : "no — commit phases and change capture will fail");

  // Informational only: gitignoring .spf/ itself (as opposed to the usual
  // .spf/data/, which SHOULD be ignored) silently defeats protected_files
  // for everything under it, including chain files not written yet — git
  // never sees them, so permissions.ts's tracked/dirty scan can't either.
  if (isRepo && anchor.spf_dir) {
    const ignored = spawnSync("git", ["check-ignore", "-q", ".spf"], { cwd: anchor.repo_root }).status === 0;
    check(
      report,
      ".spf/ not gitignored",
      true,
      ignored
        ? "WARNING: .spf/ itself is gitignored — this silently defeats protected_files for everything under it; ignore .spf/data/ instead, not .spf/"
        : "good",
    );
  }

  const resolution = paths.resolveConfigPaths(anchor, options["config"]);
  check(report, "config resolution", true, `${resolution.source}: ${resolution.paths.join(" -> ")}`);

  let cfg: SFConfig;
  try {
    cfg = agents.loadConfig(resolution.paths);
    check(report, "config parses", true, `${cfg.agents.length} agent(s), ${Object.keys(cfg.quality.suites).length} quality suite(s)`);
  } catch (error) {
    check(report, "config parses", false, (error as Error).message);
    return finish(report, flags["json"]);
  }

  const dataPaths = paths.resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db);
  check(report, "data_dir", true, dataPaths.data_dir);
  check(report, "db_path", true, `${dataPaths.db_path}${existsSync(dataPaths.db_path) ? "" : " (not created yet — fine before the first run)"}`);
  check(report, "flue_db_path", true, path.join(dataPaths.data_dir, "flue.db"));

  // Validate the WHOLE roster and EVERY declared suite — doctor's job is "is
  // everything defined here healthy", not "can one specific chain run".
  try {
    agents.validate(cfg, cfg.agents.map((a) => a.name), Object.keys(cfg.quality.suites), anchor.cwd);
    check(report, "roster + suites validate", true, "clean");
  } catch (error) {
    check(report, "roster + suites validate", false, (error as Error).message);
  }

  const usesClaudeCode = cfg.agents.some((a) => a.coding_agent === "claude_code");
  if (usesClaudeCode) {
    const claudeOnPath = binaryOnPath("claude");
    let version = "";
    if (claudeOnPath) {
      const result = spawnSync("claude", ["--version"], { encoding: "utf-8" });
      version = result.status === 0 ? result.stdout.trim() : "";
    }
    check(report, "claude CLI", claudeOnPath, claudeOnPath ? version || "on PATH, but --version failed" : "not found on PATH — required by any coding_agent: claude_code agent");
  }

  for (const agent of cfg.agents) {
    const label = `agent "${agent.name}"`;
    if (agent.coding_agent === "claude_code") {
      // No provider-key hard-fail here, unlike Flue: Claude Code also
      // supports its own `claude login`/OAuth flow, so a missing
      // ANTHROPIC_API_KEY doesn't necessarily mean broken.
      check(
        report,
        `${label} provider key`,
        true,
        process.env["ANTHROPIC_API_KEY"] ? "ANTHROPIC_API_KEY is set" : "ANTHROPIC_API_KEY not set — fine if authenticated via `claude login` instead",
      );
    } else {
      try {
        const [provider] = resolveModel(agent.model);
        const envKeys = PROVIDER_ENV_KEYS[provider];
        if (!envKeys) {
          check(report, `${label} provider key`, true, `provider "${provider}" not in doctor's known list — skipped, not a failure`);
        } else if (envKeys.length === 0) {
          check(report, `${label} provider key`, true, `provider "${provider}" is keyless — no key required`);
        } else {
          const set = envKeys.find((k) => process.env[k]);
          check(report, `${label} provider key`, Boolean(set), set ? `${set} is set` : `none of ${envKeys.join(", ")} is set`);
        }
      } catch (error) {
        check(report, `${label} model`, false, (error as Error).message);
      }
    }
    const isKnownToolName = agent.coding_agent === "claude_code" ? agentCc.isKnownToolName : isKnownFlueToolName;
    for (const toolName of agent.tools ?? []) {
      if (!isKnownToolName(toolName)) check(report, `${label} tool "${toolName}"`, false, "not a known tool name");
    }
  }

  for (const spec of cfg.quality.checks) {
    check(report, `quality check "${spec.name}"`, binaryOnPath(spec.argv[0]), `${spec.argv[0]} ${binaryOnPath(spec.argv[0]) ? "found on PATH" : "NOT found on PATH"}`);
  }
  for (const [suiteName, names] of Object.entries(cfg.quality.suites)) {
    const missing = names.filter((n) => !cfg.quality.checks.some((c) => c.name === n));
    check(report, `quality suite "${suiteName}"`, missing.length === 0, missing.length === 0 ? names.join(", ") : `names unknown check(s): ${missing.join(", ")}`);
  }

  // A protected_files pattern matching nothing anywhere in the trace is
  // usually a stale convention (e.g. an old adws/... pattern) that silently
  // stopped protecting anything.
  if (isRepo) {
    const tree = permissions.snapshot({ repo_root: anchor.repo_root, cfg });
    for (const pattern of cfg.defaults.protected_files) {
      const matchesSomething = Object.keys(tree).some((p) => p.startsWith(pattern.replace(/\/+$/, "") + "/") || p === pattern);
      check(report, `protected_files pattern ${JSON.stringify(pattern)}`, true, matchesSomething ? "matches tracked/dirty paths" : "matches nothing in the current diff (fine if the tree is clean; suspicious if this is a stale convention)");
    }
  }

  for (const envFile of [".env"]) {
    const p = path.join(anchor.repo_root, envFile);
    check(report, `${envFile}`, true, existsSync(p) ? `present (${statSync(p).size} bytes)` : "absent — fine if no provider needs a key from it");
  }

  if (cfg.watch.repo.trim()) {
    check(report, "watch.issue_provider", true, cfg.watch.issue_provider);
    check(report, "watch.code_host", true, cfg.watch.code_host);

    if (cfg.watch.issue_provider === "github" || cfg.watch.code_host === "github") {
      check(
        report,
        "GITHUB_TOKEN",
        Boolean(process.env["GITHUB_TOKEN"]),
        process.env["GITHUB_TOKEN"]
          ? "set"
          : 'not set — spf watch needs a classic PAT with "repo" scope (or "public_repo" for a public-only repo); see README.md\'s "GITHUB_TOKEN scope" section',
      );
    }
    if (cfg.watch.issue_provider === "jira") {
      check(
        report,
        "watch.jira",
        Boolean(cfg.watch.jira.base_url.trim() && cfg.watch.jira.project_key.trim()),
        cfg.watch.jira.base_url.trim() && cfg.watch.jira.project_key.trim()
          ? `${cfg.watch.jira.base_url} (${cfg.watch.jira.project_key})`
          : "watch.jira.base_url and watch.jira.project_key must both be set",
      );
      check(
        report,
        "JIRA_EMAIL / JIRA_API_TOKEN",
        Boolean(process.env["JIRA_EMAIL"] && process.env["JIRA_API_TOKEN"]),
        process.env["JIRA_EMAIL"] && process.env["JIRA_API_TOKEN"]
          ? "set"
          : 'not set — spf watch needs an Atlassian account email plus an API token (id.atlassian.com -> Security -> API tokens); see README.md\'s "spf watch" section',
      );
    }
    if (cfg.watch.code_host === "bitbucket") {
      check(
        report,
        "BITBUCKET_EMAIL / BITBUCKET_API_TOKEN",
        Boolean(process.env["BITBUCKET_EMAIL"] && process.env["BITBUCKET_API_TOKEN"]),
        process.env["BITBUCKET_EMAIL"] && process.env["BITBUCKET_API_TOKEN"]
          ? "set"
          : 'not set — Bitbucket app passwords are being removed; spf watch needs an Atlassian account email plus an API token instead; see README.md\'s "spf watch" section',
      );
    }
    const watchChain = findChain(cfg.watch.chain);
    check(report, "watch.chain", Boolean(watchChain), watchChain ? cfg.watch.chain : `"${cfg.watch.chain}" is not a registered chain`);

    // Informational only, never a failure: a chain that skips review and/or
    // never commits is a legitimate choice (e.g. `scout`, `plan`) — this is
    // here so an unattended `spf watch` posture is a visible fact, not a
    // silent assumption.
    if (watchChain) {
      const hasReviewer = resolveRequiredAgents(watchChain, {}).includes("reviewer");
      const hasCommitPhase = watchChain.phases.includes("commit");
      check(
        report,
        "watch.chain review posture",
        true,
        `${hasReviewer ? "includes" : "does not include"} a reviewer; ${hasCommitPhase ? "includes" : "does not include"} a commit phase`,
      );
    }

    if (cfg.watch.refine.enabled) {
      check(
        report,
        "watch.refine.chain",
        Boolean(findChain(cfg.watch.refine.chain)),
        findChain(cfg.watch.refine.chain) ? cfg.watch.refine.chain : `"${cfg.watch.refine.chain}" is not a registered chain`,
      );
      check(
        report,
        "watch.refine issue authoring",
        cfg.watch.issue_provider === "github",
        cfg.watch.issue_provider === "github"
          ? "github supports issue authoring (createIssue/sub-issues)"
          : `watch.issue_provider is ${JSON.stringify(cfg.watch.issue_provider)} — the refine lane needs "github" (Jira issue authoring isn't implemented yet)`,
      );
    }
  }

  if (cfg.notifications.events !== "off") {
    check(report, "notifications.events", true, cfg.notifications.events);
    if (cfg.notifications.channels.length === 0) {
      check(report, "notifications.channels", false, `notifications.events is ${JSON.stringify(cfg.notifications.events)} but no channels are configured`);
    }
    for (const ch of cfg.notifications.channels) {
      const envKey = ch.webhook_url_env || DEFAULT_NOTIFY_ENV_KEY[ch.kind];
      const label = ch.name ? `${ch.kind} (${ch.name})` : ch.kind;
      check(report, `notifications: ${label}`, Boolean(process.env[envKey]), process.env[envKey] ? `${envKey} set` : `${envKey} is not set`);
    }
  }

  return finish(report, flags["json"]);
}

function finish(report: Report, json: boolean): number {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const c of report.checks) {
      console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
    }
    console.log(report.ok ? "\nspf doctor: clean" : "\nspf doctor: problems found above");
  }
  return report.ok ? 0 : 1;
}
