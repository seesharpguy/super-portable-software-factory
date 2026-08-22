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
import { ollamaBaseUrl } from "../../core/ollama_provider.ts";
import { binaryOnPath, parseCli } from "../../core/utils.ts";
import { PROVIDER_ENV_KEYS } from "../../core/providers.ts";
import { isRepoAt } from "../../core/git_helper.ts";
import { allChains, findChain, repoChainProblems, resolveRequiredAgents, resolveRequiredSuites } from "../../chains/index.ts";
import type { SFConfig } from "../../core/data_types.ts";

interface Report {
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string; severity?: "info" | "warn" }[];
}

/**
 * `severity` is a display-only axis, orthogonal to `ok`/`report.ok`: an
 * "info"/"warn" check still reports `ok: true` (it never fails `spf doctor`
 * on its own — see each call site for why), but prints as `ℹ`/`⚠` instead of
 * a plain `✓` so a real negative finding (e.g. "unreachable", a `/v1`
 * double-path warning) can't be mistaken for a pass at a glance.
 */
function check(report: Report, name: string, ok: boolean, detail: string, severity?: "info" | "warn"): void {
  report.checks.push({ name, ok, detail, severity });
  if (!ok) report.ok = false;
}

/** Same helper as `list.ts`'s — trims a repo chain's absolute `source` path down to the `.spf/chains/...` fragment worth printing. Small enough, and file-local enough, that sharing it isn't worth a new module. */
function repoChainLabel(source: string): string {
  const marker = path.join(".spf", "chains");
  const idx = source.lastIndexOf(marker);
  return idx === -1 ? source : source.slice(idx);
}

type ProbeResult = { ok: true; status: number } | { ok: false; error: string };

const PROBE_TIMEOUT_MS = 3_000;

/** A GET that never throws — a down/unreachable server is a finding to report, never a crash of `spf doctor` itself. */
async function probeGet(url: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { ok: true, status: res.status };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A minimal `POST {base}/v1/messages` — the same request shape `agent_cc.ts`
 * ultimately drives, just with `max_tokens: 1` and no tools/schema, so a
 * genuinely-reachable-but-model-not-found endpoint still answers fast. Never
 * throws: a network failure or timeout is a finding (`unreachable`), not a
 * doctor crash. Anthropic's Messages API forced adoption is what Ollama
 * 0.32.14 natively speaks at this path (spike-verified) — HTTP 200 with a
 * `type: "message"` body is the positive signal; any other status or body
 * shape still gets reported, just labeled accordingly, since this check is
 * informational either way (see its call site).
 */
async function probeAnthropicMessages(base: string, model: string): Promise<ProbeResult & { note?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    // Send whatever auth the operator already has configured for this
    // endpoint, if any: with no header at all, a real hosted endpoint (a
    // proxy, api.anthropic.com) answers 401, which reads as "broken" even
    // though the probe itself never authenticated. Harmless for Ollama,
    // which ignores the header entirely (see the module doc above).
    const apiKey = process.env["ANTHROPIC_AUTH_TOKEN"] || process.env["ANTHROPIC_API_KEY"];
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: controller.signal,
    });
    let note: string | undefined;
    if (res.status === 200) {
      try {
        const body = (await res.json()) as { type?: string };
        note = body?.type === "message" ? "type: message" : `unexpected body shape (type: ${JSON.stringify(body?.type)})`;
      } catch {
        note = "non-JSON body";
      }
    }
    return { ok: true, status: res.status, note };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export async function doctorCommand(argv: string[]): Promise<number> {
  const { options, flags } = parseCli(argv, ["cwd", "config"], ["json", "no-probe"]);
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
    // A custom SPF_CLAUDE_CMD points the real work at something other than
    // the literal `claude` binary (a wrapper, a launcher) — checking `claude`
    // itself in that case both misses the wrapper being missing and can
    // falsely pass on a machine where `claude` happens to be on PATH but
    // unused. Check whatever agent_cc.ts will actually `spawn()`: cmdSpec's
    // first token.
    const cmdSpec = process.env["SPF_CLAUDE_CMD"] || "claude";
    const cmdTokens = cmdSpec.split(/\s+/).filter(Boolean);
    const cmdBin = cmdTokens[0] || "claude";
    const claudeOnPath = binaryOnPath(cmdBin);
    let version = "";
    if (claudeOnPath && cmdBin === "claude") {
      const result = spawnSync("claude", ["--version"], { encoding: "utf-8" });
      version = result.status === 0 ? result.stdout.trim() : "";
    }
    check(
      report,
      "claude CLI",
      claudeOnPath,
      claudeOnPath
        ? version || (cmdBin === "claude" ? "on PATH, but --version failed" : `"${cmdBin}" on PATH (via SPF_CLAUDE_CMD) — --version not checked for a wrapper/launcher`)
        : `"${cmdBin}" not found on PATH — required by any coding_agent: claude_code agent${cmdBin !== "claude" ? " (checked SPF_CLAUDE_CMD's first token, not the literal \"claude\")" : ""}`,
    );

    // `ollama launch <cmd>` needs an explicit `--` before claude's own flags
    // (cobra flag parsing otherwise consumes them as ITS OWN — see
    // agent_cc.ts's module comment for the spike-verified failure and fix),
    // and agent_cc.ts now inserts that separator automatically for exactly
    // this token shape. But `--` alone is NOT sufficient: `ollama launch`
    // also requires its OWN `--model <tag>` flag, typed BEFORE the `--`,
    // whenever it's run headless — SPF always spawns with piped stdio, so
    // without `--model` there, `ollama launch` falls back to an interactive
    // model picker that can never run and fails with "model selection
    // requires an interactive terminal" (spike-verified; see agent_cc.ts's
    // module comment). Unlike the reachability probes below, this is a
    // static, deterministic misconfiguration knowable from the string alone
    // — a real hard failure, not an informational note.
    if (cmdTokens[0] === "ollama" && cmdTokens[1] === "launch") {
      const dashIdx = cmdTokens.indexOf("--");
      const beforeSeparator = dashIdx === -1 ? cmdTokens : cmdTokens.slice(0, dashIdx);
      const hasModelFlag = beforeSeparator.includes("--model");
      check(
        report,
        "SPF_CLAUDE_CMD ollama launch wrapper",
        hasModelFlag,
        hasModelFlag
          ? cmdTokens.includes("--")
            ? 'explicit "--" and "--model" (before it) already present in SPF_CLAUDE_CMD — left as-is'
            : 'auto-handled: agent_cc.ts inserts "--" before claude\'s flags for this wrapper shape (see its module comment); "--model" is present before that point, as `ollama launch` requires in headless mode'
          : 'missing "--model <tag>" before any "--" — `ollama launch` runs headless (SPF pipes stdio) and will fail with "model selection requires an interactive terminal" even though agent_cc.ts inserts the "--" separator for you. Set SPF_CLAUDE_CMD="ollama launch claude --model <tag>" (tag from `ollama list`).',
      );
    }

    const anthropicBaseUrl = process.env["ANTHROPIC_BASE_URL"];
    if (anthropicBaseUrl && !flags["no-probe"]) {
      const trimmed = anthropicBaseUrl.replace(/\/+$/, "");
      // The claude CLI appends "/v1/messages" itself — a base URL that
      // already ends in "/v1" produces a double "/v1/v1/messages" 404, a
      // real mistake seen in practice, not a hypothetical.
      const doubledPath = /\/v1$/.test(trimmed);
      if (doubledPath) {
        check(
          report,
          "ANTHROPIC_BASE_URL shape",
          true,
          `${anthropicBaseUrl} ends in "/v1" — the claude CLI appends "/v1/messages" itself; this looks like a double-path mistake (try dropping the trailing "/v1")`,
          "warn",
        );
      }
      // Informational/warning only (ok always true): reachability here says
      // nothing about auth or model correctness, and a down server between
      // doctor runs shouldn't fail the whole command — it's a fact to
      // surface, the same pattern as the other checks in this file that are
      // never allowed to fail `spf doctor` on their own. When the shape
      // check above just flagged a double "/v1", probe the CORRECTED base
      // instead of the known-bad one — probing the bad path would just
      // confirm the mistake we already diagnosed, spending the probe on
      // nothing new.
      const probeBase = doubledPath ? trimmed.replace(/\/v1$/, "") : trimmed;
      const claudeCodeAgent = cfg.agents.find((a) => a.coding_agent === "claude_code");
      const probeModel = claudeCodeAgent?.model || "claude-sonnet-5";
      const result = await probeAnthropicMessages(probeBase, probeModel);
      check(
        report,
        "ANTHROPIC_BASE_URL reachability",
        true,
        (result.ok
          ? `${doubledPath ? `dropping the trailing "/v1" makes it ` : ""}reachable: POST ${probeBase}/v1/messages -> HTTP ${result.status}${result.note ? ` (${result.note})` : ""}`
          : `unreachable: POST ${probeBase}/v1/messages -> ${result.error}`) +
          " (this is a real, billable inference request — pass --no-probe to skip both network probes)",
        result.ok ? "info" : "warn",
      );
    }
  }

  // Flue agents pointed at a local Ollama server (`model: ollama/...`) have
  // no API key to check (providers.ts's PROVIDER_ENV_KEYS.ollama is `[]`,
  // handled in the per-agent loop below) but DO have a server that might
  // simply not be running — worth a reachability probe the same way
  // ANTHROPIC_BASE_URL gets one above.
  const usesOllamaFlue = cfg.agents.some((a) => a.coding_agent !== "claude_code" && a.model.startsWith("ollama/"));
  if (usesOllamaFlue && !flags["no-probe"]) {
    // `ollamaBaseUrl()` (ollama_provider.ts) is the SAME default-substitution
    // logic `registerOllamaModel` uses for a real dispatch, including
    // treating a set-but-EMPTY OLLAMA_BASE_URL as unset — re-deriving the
    // default here with `||` would agree on the common cases but diverge on
    // that one, which is exactly the failure mode doctor exists to catch,
    // not mask.
    const ollamaBase = ollamaBaseUrl().replace(/\/+$/, "");
    // `/models` (the OpenAI-compat list, matching the base URL's own `/v1`
    // shape) over `/api/tags` (Ollama's native catalog endpoint): measured
    // live against a real local server, `/models` returned 886 bytes vs.
    // `/api/tags`'s 4461 bytes for the identical model catalog, same ~20ms
    // latency either way — strictly cheaper for a pure reachability check,
    // and there's no live-server dependency in this choice: doctor's probe
    // itself tolerates either endpoint being down (see `probeGet`).
    const result = await probeGet(`${ollamaBase}/models`);
    check(
      report,
      "OLLAMA_BASE_URL reachability",
      true, // informational/warning only — see the ANTHROPIC_BASE_URL check above for why
      result.ok ? `reachable: GET ${ollamaBase}/models -> HTTP ${result.status}` : `unreachable: GET ${ollamaBase}/models -> ${result.error}`,
      result.ok ? "info" : "warn",
    );
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

  // Repo-local chains (`.spf/chains/*.yaml`, registered as DATA — see
  // `chains/repo_chains.ts` — never as imported repo code): already merged
  // into the registry by `cli/index.ts`'s `main()` before any command runs,
  // so `allChains()`/`repoChainProblems()` here reflect exactly what `spf
  // list` and `spf run`/`spf <chain>` would resolve, not a re-parse of our
  // own. A malformed chain file is a real ✗, not informational — an operator
  // wrote a chain they cannot run, and that is exactly the "fails silently
  // otherwise" class of problem this command exists to surface.
  for (const problem of repoChainProblems()) {
    check(report, `repo chain ${problem.file}`, false, problem.message);
  }
  for (const chain of allChains().filter((c) => c.source !== undefined)) {
    const owners = resolveRequiredAgents(chain, {});
    const missingOwners = owners.filter((o) => !cfg.agents.some((a) => a.name === o));
    check(
      report,
      `repo chain "${chain.name}" owners`,
      missingOwners.length === 0,
      missingOwners.length === 0 ? owners.join(", ") || "(none)" : `unknown agent(s): ${missingOwners.join(", ")} — not in cfg.agents`,
    );

    const suiteNames = resolveRequiredSuites(chain, {});
    const missingSuites = suiteNames.filter((s) => !(s in cfg.quality.suites));
    const missingChecks = missingSuites.length === 0 ? suiteNames.flatMap((s) => cfg.quality.suites[s].filter((n) => !cfg.quality.checks.some((c) => c.name === n))) : [];
    check(
      report,
      `repo chain "${chain.name}" suites`,
      missingSuites.length === 0 && missingChecks.length === 0,
      missingSuites.length > 0
        ? `unknown suite(s): ${missingSuites.join(", ")} — not in cfg.quality.suites`
        : missingChecks.length > 0
          ? `suite(s) name unknown check(s): ${missingChecks.join(", ")}`
          : suiteNames.join(", ") || "(none)",
    );

    // Informational: the derived sequence itself, same string `spf list`
    // shows — printed here so the chain's author can eyeball what they
    // actually wrote without a second command.
    check(report, `repo chain "${chain.name}" phases`, true, chain.phases, "info");
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
    check(report, "watch.repo", true, `${cfg.watch.repo} (code_host's repo)`);

    // The one combination where a single `repo` field is ambiguous: GitHub
    // issues against a Bitbucket repo are two different repos in two
    // different systems, not one repo worn two ways. Every other
    // combination is unambiguous even with issue_repo unset — flag this
    // one specifically rather than silently polling GitHub with the
    // Bitbucket workspace/repo_slug string as if it were "owner/name".
    if (cfg.watch.issue_provider === "github" && cfg.watch.code_host === "bitbucket") {
      check(
        report,
        "watch.issue_repo",
        Boolean(cfg.watch.issue_repo.trim()),
        cfg.watch.issue_repo.trim()
          ? cfg.watch.issue_repo
          : `not set — issue_provider is github and code_host is bitbucket, two different repos in two different systems; without watch.issue_repo, GitHub issues will be polled using watch.repo (${JSON.stringify(cfg.watch.repo)}), which is the BITBUCKET repo`,
      );
    }

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
    // findChain() consults built-ins first, then the repo-chain registry
    // (registered by cli/index.ts's main() before doctorCommand ever runs)
    // — a watch.chain naming a `.spf/chains/*.yaml` chain resolves here the
    // same way it would for `spf watch` itself, no special-casing needed.
    const watchChain = findChain(cfg.watch.chain);
    check(
      report,
      "watch.chain",
      Boolean(watchChain),
      watchChain ? `${cfg.watch.chain}${watchChain.source ? ` (repo: ${repoChainLabel(watchChain.source)})` : ""}` : `"${cfg.watch.chain}" is not a registered chain`,
    );

    // Informational only, never a failure: a chain that skips review and/or
    // never commits is a legitimate choice (e.g. `scout`, `plan`) — this is
    // here so an unattended `spf watch` posture is a visible fact, not a
    // silent assumption.
    if (watchChain) {
      // Structural, not name-coupled: `reviseLoop`'s derived label is always
      // `${reviewer} [-> ${builder}(revise) -> ${reviewer} ...] bounded` (see
      // steps.ts), so this holds for a built-in chain and for a repo chain
      // that overrides `reviewer`/`builder` to something other than the
      // literal agent named "reviewer" — the same owner-override feature
      // this changeset added everywhere else. Matching on the literal name
      // "reviewer" would report "does not include a reviewer" for a chain
      // that is entirely built around a review loop, the moment its reviewer
      // is renamed.
      const hasReviewer = watchChain.phases.includes("(revise)");
      const hasCommitPhase = watchChain.phases.includes("commit");
      check(
        report,
        "watch.chain review posture",
        true,
        `${hasReviewer ? "includes" : "does not include"} a reviewer; ${hasCommitPhase ? "includes" : "does not include"} a commit phase`,
      );
    }

    if (cfg.watch.refine.enabled) {
      const refineChain = findChain(cfg.watch.refine.chain);
      check(
        report,
        "watch.refine.chain",
        Boolean(refineChain),
        refineChain ? `${cfg.watch.refine.chain}${refineChain.source ? ` (repo: ${repoChainLabel(refineChain.source)})` : ""}` : `"${cfg.watch.refine.chain}" is not a registered chain`,
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
      const icon = c.severity === "warn" ? "⚠" : c.severity === "info" ? "ℹ" : c.ok ? "✓" : "✗";
      console.log(`${icon} ${c.name}: ${c.detail}`);
    }
    console.log(report.ok ? "\nspf doctor: clean" : "\nspf doctor: problems found above");
  }
  return report.ok ? 0 : 1;
}
