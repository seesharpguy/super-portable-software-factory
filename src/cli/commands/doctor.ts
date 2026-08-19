/**
 * `sf doctor` — the answer to every "why did nothing happen". Resolves and
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
import { isKnownToolName, resolveModel } from "../../core/agent_flue.ts";
import { parseCli } from "../../core/utils.ts";
import { isRepoAt } from "../../core/git_helper.ts";
import type { SFConfig } from "../../core/data_types.ts";

// Common providers' env var conventions — public knowledge (pi-ai's own
// resolution table is internal, unexported, and not something to reach into
// for this). Missing from this table just means "unknown provider, skipped
// the key check" — never a false failure.
const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  xai: ["XAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
};

interface Report {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}

function check(report: Report, name: string, ok: boolean, detail: string): void {
  report.checks.push({ name, ok, detail });
  if (!ok) report.ok = false;
}

function binaryOnPath(bin: string): boolean {
  if (path.isAbsolute(bin) || bin.includes("/")) return existsSync(bin);
  const result = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf-8" });
  return result.status === 0;
}

export function doctorCommand(argv: string[]): number {
  const { options, flags } = parseCli(argv, ["cwd", "config"], ["json"]);
  const report: Report = { ok: true, checks: [] };

  check(report, "node version", true, process.version);

  const anchor = paths.resolveAnchor(options["cwd"]);
  check(report, "cwd", true, anchor.cwd);
  check(report, "repo_root", true, anchor.repo_root);
  // Informational only — no .sf/ is a fully valid, supported state (pure
  // built-ins), never a failure on its own.
  check(report, ".sf directory", true, anchor.sf_dir ?? "(none — running off packaged built-ins; run `sf init` to override)");

  const isRepo = isRepoAt(anchor.repo_root);
  check(report, "git repository", isRepo, isRepo ? "yes" : "no — commit phases and change capture will fail");

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

  for (const agent of cfg.agents) {
    const label = `agent "${agent.name}"`;
    try {
      const [provider] = resolveModel(agent.model);
      const envKeys = PROVIDER_ENV_KEYS[provider];
      if (!envKeys) {
        check(report, `${label} provider key`, true, `provider "${provider}" not in doctor's known list — skipped, not a failure`);
      } else {
        const set = envKeys.find((k) => process.env[k]);
        check(report, `${label} provider key`, Boolean(set), set ? `${set} is set` : `none of ${envKeys.join(", ")} is set`);
      }
    } catch (error) {
      check(report, `${label} model`, false, (error as Error).message);
    }
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

  return finish(report, flags["json"]);
}

function finish(report: Report, json: boolean): number {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const c of report.checks) {
      console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
    }
    console.log(report.ok ? "\nsf doctor: clean" : "\nsf doctor: problems found above");
  }
  return report.ok ? 0 : 1;
}
