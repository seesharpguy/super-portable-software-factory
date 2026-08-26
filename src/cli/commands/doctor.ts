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
import { endpointLabel, redact, resolveTracesUrl } from "../../core/otel.ts";
import { isKnownToolName as isKnownFlueToolName, resolveModel } from "../../core/agent_flue.ts";
import { ollamaBaseUrl } from "../../core/ollama_provider.ts";
import { binaryOnPath, parseCli } from "../../core/utils.ts";
import { PROVIDER_ENV_KEYS } from "../../core/providers.ts";
import { probeServedOllamaTags, resolveTiering } from "../../core/tiering.ts";
import { isRepoAt } from "../../core/git_helper.ts";
import { allChains, findChain, hasCommitStep, repoChainProblems, resolveRequiredAgents, resolveRequiredSuites, type ChainDefinition } from "../../chains/index.ts";
import * as sandbox from "../../core/sandbox.ts";
import { loadOpenSandboxSdk } from "../../core/sandbox_opensandbox.ts";
import type { AgentConfig, SFConfig } from "../../core/data_types.ts";
import { isInteractive } from "../ask.ts";
import { paint as paintPlain } from "../../core/console.ts";

/**
 * A transient "checking X..." status line around a network probe — real
 * work only starts inside `run()`; this doesn't touch the promise's timing.
 * TTY-only: `\r` + erase-to-end-of-line only makes sense against a real
 * terminal, and a non-TTY/CI log should show nothing extra, matching
 * doctor's output exactly as it always has when piped. Not Ink-based on
 * purpose — this is a plain transient ANSI line, not a component tree, and
 * doctor's checks accumulate into one report printed at the very end
 * regardless, so there's no persistent live region for a probe status to
 * join.
 */
async function withProbeStatus<T>(label: string, run: () => Promise<T>): Promise<T> {
  if (!isInteractive()) return run();
  process.stdout.write(paintPlain("dim", `  checking ${label}...`));
  try {
    return await run();
  } finally {
    process.stdout.write("\r\x1b[2K");
  }
}

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
/**
 * Cross-check ONE chain's own `requiredAgents`/`requiredSuites` (derived
 * from what it actually does — `resolveRequiredAgents`/`resolveRequiredSuites`,
 * same as `spf list`/a real dispatch would resolve) against what `cfg`
 * actually has. Shared by the repo-chain loop below (every `.spf/chains/
 * *.yaml` chain) and `watch.chain`/`watch.refine.chain` — the two chains
 * `spf watch` will ACTUALLY dispatch, built-in or not. Extracted specifically
 * because the repo-chain loop used to be the ONLY place this ran, and it
 * skips every built-in chain by construction (`.filter((c) => c.source !==
 * undefined)`) — so a `watch.chain` naming a built-in like `plan-build-test`
 * never went through it at all: `spf doctor` could report clean while `spf
 * watch`'s very first claimed issue failed at runtime on a missing
 * `quality.suites` entry doctor never actually looked for.
 */
function checkChainRequirements(report: Report, label: string, chain: ChainDefinition, cfg: SFConfig): void {
  const owners = resolveRequiredAgents(chain, {});
  const missingOwners = owners.filter((o) => !cfg.agents.some((a) => a.name === o));
  check(
    report,
    `${label} owners`,
    missingOwners.length === 0,
    missingOwners.length === 0 ? owners.join(", ") || "(none)" : `unknown agent(s): ${missingOwners.join(", ")} — not in cfg.agents`,
  );

  const suiteNames = resolveRequiredSuites(chain, {});
  const missingSuites = suiteNames.filter((s) => !(s in cfg.quality.suites));
  const missingChecks = missingSuites.length === 0 ? suiteNames.flatMap((s) => cfg.quality.suites[s].filter((n) => !cfg.quality.checks.some((c) => c.name === n))) : [];
  check(
    report,
    `${label} suites`,
    missingSuites.length === 0 && missingChecks.length === 0,
    missingSuites.length > 0
      ? `unknown suite(s): ${missingSuites.join(", ")} — not in cfg.quality.suites`
      : missingChecks.length > 0
        ? `suite(s) name unknown check(s): ${missingChecks.join(", ")}`
        : suiteNames.join(", ") || "(none)",
  );
}

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
 * An EMPTY OTLP trace batch, POSTed exactly the way `core/otel.ts` posts a
 * real one (same URL, same configured headers) — `{"resourceSpans":[]}` is
 * valid OTLP that records nothing, so this probe cannot create a phantom trace
 * in the operator's backend. Never throws: an unreachable collector is a
 * finding to print, not a doctor crash. A 4xx is still a useful answer (the
 * host is up; the path or the auth header is wrong), so the status is reported
 * rather than collapsed into ok/not-ok.
 */
async function probeOtel(url: string, headers: Record<string, string> | undefined): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify({ resourceSpans: [] }),
      signal: controller.signal,
    });
    return { ok: true, status: res.status };
  } catch (error) {
    // undici collapses every connection-level failure to "fetch failed" and
    // puts the actual reason (DNS, ECONNREFUSED, a TLS error — each with a
    // different fix) on `error.cause`. Fold it in before redacting so `spf
    // doctor`, whose whole job is telling the operator what's wrong, can.
    const err = error as Error & { cause?: { message?: string; code?: string } };
    const cause = err.cause;
    const detail = cause ? ` (${cause.code ?? cause.message ?? String(cause)})` : "";
    // redact(): a fetch failure routinely embeds the URL it attempted, and the
    // endpoint may carry userinfo — the same rule the exporter's own log obeys.
    return { ok: false, error: redact(`${err.message}${detail}`, [url, ...Object.values(headers ?? {})]) };
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

/**
 * `GET {base}/health`, parsed for the OpenSandbox control plane's own
 * positive signal (`{"status":"healthy"}`) — checked in ADDITION to the
 * HTTP status, because a 200 from something else entirely (the spike's own
 * "unrelated process on 8090" trap — see check #3/#5 below) is not the same
 * finding as a genuinely healthy control plane; a 404 specifically is that
 * trap's own signature. Never throws.
 */
async function probeOpenSandboxHealth(
  baseUrl: string,
): Promise<{ ok: true; status: number; healthy: boolean } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    let healthy = false;
    if (res.status === 200) {
      try {
        const body = (await res.json()) as { status?: string };
        healthy = body?.status === "healthy";
      } catch {
        healthy = false;
      }
    }
    return { ok: true, status: res.status, healthy };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Loopback host check for #4/#5's "is this control plane reachable from off-box" gate — same shape as the OTel `insecure` check above. */
function isLoopbackUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
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
    return await finish(report, flags["json"]);
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
      const result = await withProbeStatus("ANTHROPIC_BASE_URL reachability", () => probeAnthropicMessages(probeBase, probeModel));
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
  // Tiering (SPF #14): an ollama/* ladder rung reaches for the same server
  // whether or not any cfg.agents[] entry itself names one — gated on
  // tiering.enabled so a disabled (or never-opted-into) ladder can't turn on
  // a probe nobody asked for. Without this, an all-hosted roster paired with
  // an ollama ladder got NO reachability probe at all (integration point 18a).
  const usesOllamaFlue =
    cfg.agents.some((a) => a.coding_agent !== "claude_code" && a.model.startsWith("ollama/")) ||
    (cfg.tiering.enabled && cfg.tiering.tiers.some((t) => t.coding_agent !== "claude_code" && t.model.startsWith("ollama/")));
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
    const result = await withProbeStatus("OLLAMA_BASE_URL reachability", () => probeGet(`${ollamaBase}/models`));
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

  // Tiering (SPF #14) — three checks, ALL gated on tiering.enabled: a
  // disabled (or never-opted-into) ladder must be invisible to `spf doctor`,
  // the same gate agents.validate() uses (see the "roster + suites
  // validate" check above, which already fails loudly on a rule-T backend
  // mismatch for the whole roster — nothing here duplicates that failure,
  // this section only adds VISIBILITY on top of it). Without this gate,
  // `spf init --template ts && spf doctor` would fail on three unset
  // provider keys for a ladder that is off and will never dispatch
  // (integration point 18's own regression note).
  if (cfg.tiering.enabled) {
    // 18(b): the SAME provider-key check the per-agent loop above just ran,
    // over cfg.tiering.tiers[].model instead of cfg.agents[].model,
    // branching on the TIER's OWN declared coding_agent (never an agent's —
    // a tier changes `model` and nothing else, see core/tiering.ts's rule
    // T). Without this, a hosted rung naming a provider whose key is unset
    // is a green doctor and a first-dispatch failure.
    for (const tier of cfg.tiering.tiers) {
      const tierLabel = `tiering tier "${tier.name}"`;
      if (tier.coding_agent === "claude_code") {
        check(
          report,
          `${tierLabel} provider key`,
          true,
          process.env["ANTHROPIC_API_KEY"] ? "ANTHROPIC_API_KEY is set" : "ANTHROPIC_API_KEY not set — fine if authenticated via `claude login` instead",
        );
      } else {
        try {
          const [provider] = resolveModel(tier.model);
          const envKeys = PROVIDER_ENV_KEYS[provider];
          if (!envKeys) {
            check(report, `${tierLabel} provider key`, true, `provider "${provider}" not in doctor's known list — skipped, not a failure`);
          } else if (envKeys.length === 0) {
            check(report, `${tierLabel} provider key`, true, `provider "${provider}" is keyless — no key required`);
          } else {
            const set = envKeys.find((k) => process.env[k]);
            check(report, `${tierLabel} provider key`, Boolean(set), set ? `${set} is set` : `none of ${envKeys.join(", ")} is set`);
          }
        } catch (error) {
          check(report, `${tierLabel} model`, false, (error as Error).message);
        }
      }
    }

    // 18(c): the resolved ladder, each routed role's effective model, and
    // the served-tag report — imports probeServedOllamaTags FROM
    // core/tiering.ts (not doctor's own probeGet, which discards the
    // response body that's the only part that matters here).
    //
    // chainName/prompt are deliberately "" — an unlisted chain name weighs
    // 0 and a zero-word prompt weighs -1, summing to -1, which classifies
    // as "standard" (short of the -2 "low" needs). That reports the
    // LADDER'S OWN baseline resolution (step 0 — no risk shift), not any
    // one chain's risk-shifted view; a risk-shifted projection for a real
    // chain+prompt is `spf estimate`'s job, not doctor's. `required` is the
    // WHOLE roster, matching the "roster + suites validate" call above —
    // every routed role doctor's job covers, not just what one chain needs.
    const servedOllamaTags = flags["no-probe"] ? null : await withProbeStatus("served Ollama tags", () => probeServedOllamaTags(cfg));
    const resolution = resolveTiering({
      cfg,
      chainName: "",
      prompt: "",
      servedOllamaTags,
      required: cfg.agents.map((a) => a.name),
    });
    check(
      report,
      "tiering ladder",
      true,
      cfg.tiering.tiers.length > 0 ? cfg.tiering.tiers.map((t) => `${t.name}(${t.coding_agent}:${t.model})`).join(" -> ") : "(no tiers declared)",
      "info",
    );
    // FULL routing map — an entry for every routed role including the ones
    // whose effective model equals their configured one (integration point
    // 18c: "roles whose effective equals their configured model" still
    // print), never a diff.
    for (const [agentName, route] of Object.entries(resolution.routing)) {
      check(
        report,
        `tiering role "${agentName}"`,
        true,
        `-> tier "${route.tier}" (${route.effective})${route.configured === route.effective ? " [unchanged from configured]" : ` (was ${route.configured})`}`,
        "info",
      );
    }
    // One line per note resolveTiering produced (an unserved tag, a rule-T
    // backend mismatch, an unknown tier name, ...) — resolveTiering never
    // assigns severity (agents.validate() owns that; this call only owns
    // detection), so every note here is informational: the hard failure for
    // a rule-T mismatch or a malformed rung already came from the "roster +
    // suites validate" check above, on the SAME resolveTiering-adjacent
    // detection agents.validate() runs. This just names it again, in context.
    for (const note of resolution.notes) {
      check(report, "tiering note", true, note, "warn");
    }

    // Served-tag report, fail-open in the SAME direction the probe itself
    // does: a stopped/unreachable server reports "could not check" once,
    // never per-rung "not served" — flagging every rung as unserved on a
    // probe failure would look identical to the prefix-strip bug
    // core/tiering.ts's usable() guards against, and is exactly the outcome
    // fail-open exists to prevent.
    const ollamaTiers = cfg.tiering.tiers.filter((t) => t.coding_agent !== "claude_code" && t.model.startsWith("ollama/"));
    if (ollamaTiers.length > 0) {
      if (servedOllamaTags === null) {
        check(
          report,
          "tiering served-tag probe",
          true,
          flags["no-probe"] ? "skipped (--no-probe)" : "could not check — Ollama server unreachable (fail-open: nothing is dropped this run)",
          "warn",
        );
      } else {
        for (const tier of ollamaTiers) {
          const tag = tier.model.slice("ollama/".length);
          const served = servedOllamaTags.has(tag);
          check(
            report,
            `tiering tier "${tier.name}" served`,
            true,
            served ? `"${tag}" is in \`ollama list\`` : `"${tag}" is NOT in \`ollama list\` — a run will walk down to a lower usable rung`,
            served ? "info" : "warn",
          );
        }
      }
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
    checkChainRequirements(report, `repo chain "${chain.name}"`, chain, cfg);

    // Informational: the derived sequence itself, same string `spf list`
    // shows — printed here so the chain's author can eyeball what they
    // actually wrote without a second command.
    check(report, `repo chain "${chain.name}" phases`, true, chain.phases, "info");
  }

  // ── Sandbox backends (SPF #15) ──────────────────────────────────────────
  // Gated on the RESOLVED backend, per check — not on "not local" — the same
  // usesOllamaFlue precedent above (:318-320): a repo running only
  // backend: cloudflare imports no OpenSandbox SDK at all, so a coarse gate
  // would fail #2 on a package that backend never loads. #2-6 fire only when
  // some agent resolves to "opensandbox"; #7-8 only "cloudflare". #1/#9-17
  // are backend-agnostic and roster-wide (agents.validate() above is
  // chain-scoped to the roster only because doctor passed the WHOLE roster
  // as `required` — see the "roster + suites validate" check — but #12-15/
  // #17 are reported here too, on purpose, so the specific rule that failed
  // has its own name rather than one line buried in a combined error).
  {
    const resolvedBackend = (agent: AgentConfig): string => agent.sandbox ?? cfg.sandbox.backend;
    const nonLocalAgents = cfg.agents.filter((a) => resolvedBackend(a) !== "local");
    const openSandboxAgents = nonLocalAgents.filter((a) => resolvedBackend(a) === "opensandbox");
    const cloudflareAgents = nonLocalAgents.filter((a) => resolvedBackend(a) === "cloudflare");

    // #1 — backend/scope/dirs/image/fanout, plus the resulting sandbox count
    // PER CHAIN this repo can run: distinct agents the chain DISPATCHES
    // (kind: "agent" phases only) that resolve non-local, deduplicated by
    // name, via resolveRequiredAgents — never chain.phases or the whole
    // roster, both of which over-count (engineer/code phases like
    // request/quality/commit dispatch no agent, and a fix loop's revise step
    // reuses its builder's own lease rather than opening a second one).
    check(
      report,
      "sandbox.backend",
      true,
      `backend=${cfg.sandbox.backend}, scope=${cfg.sandbox.scope} (default: agent), workspace_dir=${cfg.sandbox.workspace_dir}, ` +
        `scratch_dir=${cfg.sandbox.scratch_dir}, handoff_dir=${cfg.sandbox.handoff_dir}, image=${cfg.sandbox.image || "(none)"}, ` +
        `fanout=${cfg.sandbox.fanout}` +
        (nonLocalAgents.length > 0
          ? `; per-agent overrides to a non-local backend: ${nonLocalAgents.map((a) => `${a.name}(${resolvedBackend(a)})`).join(", ")}`
          : "; no agent resolves to a non-local backend"),
      "info",
    );
    if (nonLocalAgents.length > 0) {
      for (const chain of allChains()) {
        const required = resolveRequiredAgents(chain, {});
        const sandboxed = required.filter((name) => {
          const agent = cfg.agents.find((a) => a.name === name);
          return agent !== undefined && resolvedBackend(agent) !== "local";
        });
        if (sandboxed.length === 0) continue;
        const perAttempt = cfg.sandbox.scope === "run" ? 1 : sandboxed.length;
        check(
          report,
          `sandbox cost: chain "${chain.name}"`,
          true,
          `${perAttempt} sandbox(es) per attempt under scope: ${cfg.sandbox.scope} (dispatched agents: ${sandboxed.join(", ")}) — multiply by --n for a fan-out estimate`,
          "info",
        );
      }
    }

    // #2 — provider SDK present, opensandbox only, hard ✗. MUST go through
    // the adapter's own indirected loader (never doctor's own `import()`
    // with a literal specifier — that fails `tsc` with TS2307 on every
    // machine, same class of bug as a literal specifier in the adapter
    // itself). Same static, network-free misconfiguration class as the
    // "claude CLI" check above (SPF_CLAUDE_CMD on PATH).
    if (openSandboxAgents.length > 0) {
      try {
        await loadOpenSandboxSdk();
        check(report, "opensandbox SDK present", true, "@alibaba-group/opensandbox loaded");
      } catch (error) {
        check(report, "opensandbox SDK present", false, (error as Error).message);
      }
    }

    // #3 — opensandbox control plane reachability, info/warn (never a hard
    // failure — the rule every reachability probe in this file follows). A
    // 404 specifically is the spike's own trap: something ELSE listening on
    // that port, not this control plane being down.
    let openSandboxHealthResult: Awaited<ReturnType<typeof probeOpenSandboxHealth>> | null = null;
    if (openSandboxAgents.length > 0 && !flags["no-probe"]) {
      const baseUrl = cfg.sandbox.opensandbox.base_url.replace(/\/+$/, "");
      openSandboxHealthResult = await probeOpenSandboxHealth(baseUrl);
      check(
        report,
        "opensandbox control plane",
        true,
        !openSandboxHealthResult.ok
          ? `unreachable: GET ${baseUrl}/health -> ${openSandboxHealthResult.error}`
          : openSandboxHealthResult.healthy
            ? `reachable: GET ${baseUrl}/health -> HTTP ${openSandboxHealthResult.status} {"status":"healthy"}`
            : openSandboxHealthResult.status === 404
              ? `GET ${baseUrl}/health -> HTTP 404 — usually means something ELSE is listening on this port, not this control plane (the spike hit exactly this on 8090 and remapped to 8095 — a troubleshooting note, not a default; see check #5)`
              : `GET ${baseUrl}/health -> HTTP ${openSandboxHealthResult.status}, not the expected {"status":"healthy"}`,
        openSandboxHealthResult.ok && openSandboxHealthResult.healthy ? "info" : "warn",
      );
    }

    // #4 — API key posture, opensandbox only. Prints the key NAME only,
    // never the value. warn (not a hard fail) when unset AND the control
    // plane is on a routable (non-loopback) address — an insecure control
    // plane reachable off-box.
    if (openSandboxAgents.length > 0) {
      const keyEnv = cfg.sandbox.opensandbox.api_key_env;
      const set = Boolean(process.env[keyEnv]);
      const baseUrl = cfg.sandbox.opensandbox.base_url;
      const routable = !isLoopbackUrl(baseUrl);
      check(
        report,
        "opensandbox API key posture",
        true,
        set
          ? `${keyEnv} is set`
          : routable
            ? `${keyEnv} is NOT set, and sandbox.opensandbox.base_url (${baseUrl}) is a routable address — an insecure control plane reachable off-box`
            : `${keyEnv} is not set (fine for a loopback control plane)`,
        set || !routable ? "info" : "warn",
      );

      // #5 — [docker].host_ip note. CONDITIONAL, on purpose: this gotcha
      // applies only to a containerized control plane; the README-canonical
      // `uvx opensandbox-server` host process needs nothing here, and
      // warning on plain loopback would be pure noise. Fires only when #3's
      // probe failed/timed out AND base_url is loopback.
      const probeFailed = openSandboxHealthResult !== null && (!openSandboxHealthResult.ok || !openSandboxHealthResult.healthy);
      if (probeFailed && isLoopbackUrl(baseUrl)) {
        check(
          report,
          "[docker].host_ip note",
          true,
          "if your control plane runs in a container (the compose route), its readiness probes and this host-side client must resolve [docker].host_ip to the SAME reachable address — the LAN IP (`ipconfig getifaddr en0`) is the only value that works for both; getting it wrong produces a 30s \"Egress sidecar did not become ready\". If you are running `uvx opensandbox-server` on the host, ignore this.",
          "info",
        );
      }

      // #6 — image pre-pull + readiness reminder, info only.
      check(
        report,
        "opensandbox image pre-pull",
        true,
        `the first sandbox of each kind pulls execd/egress lazily (30-90s cold, sub-2s warm) — this is a READINESS wait, separate from sandbox.request_timeout_seconds (${cfg.sandbox.request_timeout_seconds}s, the client-side HTTP timeout on control-plane calls); confusing the two is how "Egress sidecar did not become ready" gets misdiagnosed as an HTTP timeout. skipHealthCheck is deliberately not used.`,
        "info",
      );
    }

    // #7 — cloudflare config, hard ✗ if selected and bridge_url/api_token_env
    // unset. Static, knowable without network. `bridge_url`/`api_token_env`
    // are sandbox-wide (not per-agent), so this is naturally roster-wide.
    if (cloudflareAgents.length > 0) {
      const bridgeUrl = cfg.sandbox.cloudflare.bridge_url.trim();
      const tokenEnv = cfg.sandbox.cloudflare.api_token_env.trim();
      check(
        report,
        "cloudflare config",
        Boolean(bridgeUrl) && Boolean(tokenEnv),
        !bridgeUrl
          ? "sandbox.cloudflare.bridge_url is empty — required when the resolved backend is \"cloudflare\""
          : !tokenEnv
            ? "sandbox.cloudflare.api_token_env is unset — required when the resolved backend is \"cloudflare\""
            : `bridge_url=${bridgeUrl}, api_token_env=${tokenEnv}${process.env[tokenEnv] ? " (set)" : " (NOT set)"}`,
      );

      // #8 — cloudflare bridge reachability, info/warn. The bridge's own
      // unauthenticated `GET /health` (design doc §4.2/O-2).
      if (bridgeUrl && !flags["no-probe"]) {
        const result = await probeGet(`${bridgeUrl.replace(/\/+$/, "")}/health`);
        check(
          report,
          "cloudflare bridge reachability",
          true,
          result.ok
            ? `reachable: GET ${bridgeUrl}/health -> HTTP ${result.status}`
            : `unreachable: GET ${bridgeUrl}/health -> ${result.error}`,
          result.ok ? "info" : "warn",
        );
      }
    }

    // #9 — env injection posture, one line per NON-LOCAL agent (the resolved
    // key set is per-agent — §3.1). Never prints values, only key NAMES.
    // warn for an allowlisted key absent from the operator env, and warn
    // when env_allowlist is non-empty while egress.default: allow.
    for (const agent of nonLocalAgents) {
      const agentAllow = agent.env_allowlist; // undefined/null = no further narrowing
      const keyNames = [...new Set(agentAllow == null ? cfg.sandbox.env_allowlist : cfg.sandbox.env_allowlist.filter((k) => agentAllow.includes(k)))].sort();
      const missing = keyNames.filter((k) => process.env[k] === undefined);
      const broadEgressWithCreds = keyNames.length > 0 && cfg.sandbox.egress.default === "allow";
      const warn = missing.length > 0 || broadEgressWithCreds;
      check(
        report,
        `agent "${agent.name}" sandbox env injection`,
        true,
        keyNames.length === 0
          ? "no keys injected (sandbox.env_allowlist is empty, or this agent's own env_allowlist narrows it to nothing)"
          : `injects: ${keyNames.join(", ")}` +
              (missing.length > 0 ? ` — NOT set in the operator env: ${missing.join(", ")}` : "") +
              (broadEgressWithCreds ? " — egress.default: allow with live credentials in the sandbox is worth a second look" : ""),
        warn ? "warn" : "info",
      );
    }

    // #9b — SPF #15 PR B (§6.1/§7): the credential broker's own describe()
    // line, one per non-local agent. `static` (the only registered broker)
    // issues exactly the key set check #9 just printed — reused here rather
    // than re-resolved, and reused rather than a real `broker.issue(spec)`
    // call: doctor has no live SandboxSpec (no Run exists), and deliberately
    // never reads an operator-env VALUE just to build this string.
    if (nonLocalAgents.length > 0) {
      const brokerKnown = sandbox.KNOWN_CREDENTIAL_BROKER_IDS.includes(cfg.sandbox.credentials.broker);
      for (const agent of nonLocalAgents) {
        const agentAllow = agent.env_allowlist;
        const keyNames = agentAllow == null ? cfg.sandbox.env_allowlist : cfg.sandbox.env_allowlist.filter((k) => agentAllow.includes(k));
        check(
          report,
          `agent "${agent.name}" credential grant`,
          brokerKnown,
          brokerKnown
            ? sandbox.describeStaticCredentials(keyNames)
            : `sandbox.credentials.broker ${JSON.stringify(cfg.sandbox.credentials.broker)} is not registered — known: ${sandbox.KNOWN_CREDENTIAL_BROKER_IDS.join(", ")}`,
          brokerKnown ? "info" : undefined,
        );
      }
    }

    // #10 — egress policy, verbatim, info only.
    if (nonLocalAgents.length > 0) {
      check(
        report,
        "sandbox egress policy",
        true,
        `default=${cfg.sandbox.egress.default}, allow=[${cfg.sandbox.egress.allow.join(", ")}]`,
        "info",
      );
    }

    // #11 — live leases. The lease JOURNAL (<data_dir>/sandboxes.json,
    // design doc §4.3) is not written by this build's core sandbox module —
    // only the in-process registry exists, which is always empty inside
    // `spf doctor`'s own process (doctor never creates a lease itself), so
    // this cannot yet report an orphan left by a killed run. Reported
    // honestly rather than fabricating a journal read.
    if (nonLocalAgents.length > 0) {
      const live = sandbox.leases();
      check(
        report,
        "sandbox live leases",
        true,
        `${live.length} in THIS process (the lease journal at <data_dir>/sandboxes.json is not implemented in this build — cross-process/orphan visibility via \`spf sandbox list\` is not yet available)`,
        "info",
      );
    }

    // #12 — claude_code x remote backend, hard ✗, roster-wide (validate()
    // above is chain-scoped to whatever `required` it was called with —
    // doctor happens to pass the whole roster there too, but this is named
    // separately so the specific rule that failed has its own line).
    for (const agent of cfg.agents) {
      const backend = resolvedBackend(agent);
      if (agent.coding_agent === "claude_code" && backend !== "local") {
        check(
          report,
          `agent "${agent.name}" coding_agent x sandbox`,
          false,
          `coding_agent "claude_code" cannot use sandbox backend ${JSON.stringify(backend)} — it always spawns a host process with no sandbox seam; set agent.sandbox: local (or sandbox.backend: local) for this agent`,
        );
      }
    }

    // #13 — image set, and able to run the transport. Hard ✗ only when
    // empty on a resolved opensandbox backend (the key has no default and
    // is required for that backend); otherwise a warn on a known-git-less
    // base image.
    if (openSandboxAgents.length > 0) {
      const image = cfg.sandbox.image.trim();
      if (!image) {
        check(
          report,
          "sandbox.image",
          false,
          'sandbox.image is empty — required when the resolved backend is "opensandbox": the image MUST contain git, tar and base64 (the workspace transport shells out to all three)',
        );
      } else {
        const knownGitless = /python:.*-slim|^alpine(:|$)/.test(image) && !cfg.sandbox.setup.some((cmd) => /\bgit\b/.test(cmd));
        check(
          report,
          "sandbox.image",
          true,
          knownGitless
            ? `${image} is a known git-less base — the mandatory create-time preflight (git/tar/base64) will fail unless sandbox.setup installs git`
            : `${image} (git/tar/base64 verified at create time by the mandatory preflight, not here)`,
          knownGitless ? "warn" : "info",
        );
      }
    }

    // #14 — handoff/scratch dir placement, hard ✗, roster-wide. Same rule,
    // same reason as validateSandboxConfig's (agents.ts) — duplicated here
    // in miniature because that function is not exported, and this is a
    // static, network-free, config-shape check that doesn't need a per-agent
    // loop (workspace_dir/handoff_dir/scratch_dir are sandbox-wide, not
    // per-agent). Reported here as well as in validate() because the
    // failure it prevents (a PermissionBreach on turn 1 of every sandboxed
    // run) is expensive and its cause is non-obvious.
    if (nonLocalAgents.length > 0) {
      const posixUnderOrEqual = (root: string, child: string): boolean => {
        const normRoot = path.posix.normalize(root).replace(/\/+$/, "") || "/";
        const normChild = path.posix.normalize(child);
        return normChild === normRoot || normChild.startsWith(`${normRoot}/`);
      };
      const placementProblems: string[] = [];
      for (const key of ["handoff_dir", "scratch_dir"] as const) {
        if (posixUnderOrEqual(cfg.sandbox.workspace_dir, cfg.sandbox[key])) {
          placementProblems.push(`sandbox.${key} (${cfg.sandbox[key]}) is inside sandbox.workspace_dir (${cfg.sandbox.workspace_dir})`);
        }
      }
      if (path.posix.normalize(cfg.sandbox.handoff_dir) === path.posix.normalize(cfg.sandbox.scratch_dir)) {
        placementProblems.push(`sandbox.scratch_dir must not equal sandbox.handoff_dir (${cfg.sandbox.handoff_dir})`);
      }
      check(
        report,
        "sandbox handoff/scratch dir placement",
        placementProblems.length === 0,
        placementProblems.length === 0
          ? `handoff_dir=${cfg.sandbox.handoff_dir}, scratch_dir=${cfg.sandbox.scratch_dir}, both outside workspace_dir=${cfg.sandbox.workspace_dir}`
          : placementProblems.join("; "),
      );
    }

    // #15 — scope: run x divergent env, hard ✗, roster-wide. validate()
    // above is chain-scoped to whatever `required` it ran with; this calls
    // the SAME exported function over the WHOLE roster, so a repo with
    // several chains learns scope: run is unsafe for this roster before
    // picking the one chain that would trip it.
    const runScopeProblems = agents.validateSandboxRunScope(cfg, cfg.agents.map((a) => a.name));
    if (cfg.sandbox.scope === "run") {
      check(
        report,
        "sandbox scope: run env divergence (roster-wide)",
        runScopeProblems.length === 0,
        runScopeProblems.length === 0 ? "every non-local agent in the roster resolves to the same backend + env key set" : runScopeProblems.join("; "),
      );
    }

    // #16 — submodules present, warn, static, network-free. Deliberately a
    // warning, not a validate() failure: a submodule-bearing repo must still
    // be able to run (the superproject alone is seeded/synced/extracted).
    if (nonLocalAgents.length > 0 && existsSync(path.join(anchor.repo_root, ".gitmodules"))) {
      check(
        report,
        "sandbox + submodules",
        true,
        `${anchor.repo_root} has .gitmodules — submodule content is not seeded, synced, or extracted by the sandbox transport (the superproject only is)`,
        "warn",
      );
    }

    // #17 — timeout relation, hard ✗, roster-wide, network-free. The
    // DEFAULT deadline must fit inside the client timeout; a caller-supplied
    // timeoutMs still passes through unmodified (no clamp — sandbox.ts).
    if (nonLocalAgents.length > 0) {
      check(
        report,
        "sandbox timeout relation",
        cfg.sandbox.request_timeout_seconds >= cfg.sandbox.exec_timeout_seconds,
        cfg.sandbox.request_timeout_seconds >= cfg.sandbox.exec_timeout_seconds
          ? `request_timeout_seconds=${cfg.sandbox.request_timeout_seconds} >= exec_timeout_seconds=${cfg.sandbox.exec_timeout_seconds} — a model-requested timeout longer than exec_timeout_seconds is honored, not clamped, exactly as on backend: local`
          : `sandbox.request_timeout_seconds (${cfg.sandbox.request_timeout_seconds}) must be >= sandbox.exec_timeout_seconds (${cfg.sandbox.exec_timeout_seconds})`,
      );
    }
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

    // The "repo chain X suites/owners" loop above only covers chains with a
    // `.source` (loaded from `.spf/chains/*.yaml`) — a BUILT-IN chain named
    // by `watch.chain` (the common case: `plan-build-test`, etc.) never went
    // through that check, and the "roster + suites validate" call earlier
    // only validates suites already present in `cfg.quality.suites`, not
    // whether `watch.chain` actually NEEDS one that's missing entirely. That
    // gap is exactly how `spf doctor` can report clean while `spf watch`'s
    // very first claimed issue fails at runtime with "quality.suites.\"test\"
    // is not configured" — this closes it by checking the chain `spf watch`
    // will ACTUALLY dispatch, the same way the repo-chain loop already does.
    if (watchChain) {
      checkChainRequirements(report, `watch.chain "${cfg.watch.chain}"`, watchChain, cfg);
    }

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
      // `hasCommitStep` (structural: the derived phase string shows a real
      // `git(commit` step), not a substring match on the word "commit" — the
      // same predicate `watch.fanout commit phase` below uses, so a chain
      // whose phase LABEL merely contains "commit" without an actual commit
      // step can't get "includes" here and a hard ✗ on the very next line.
      const hasCommitPhase = hasCommitStep(watchChain.phases);
      check(
        report,
        "watch.chain review posture",
        true,
        `${hasReviewer ? "includes" : "does not include"} a reviewer; ${hasCommitPhase ? "includes" : "does not include"} a commit phase`,
      );
    }

    // watch.fanout — the best-of-N multiplier `watch.fanout.n`/
    // `watch.fanout.concurrency` drive (see `WatchFanoutConfigSchema`'s doc
    // comment). This line always prints, even at the default n=1: n=1 is a
    // no-op for the running DAEMON (`core/watch.ts`'s design doc, §7), but
    // not a total no-op at the CLI surface — an operator should be able to
    // see the posture either way. b-d below only fire when n > 1.
    {
      const n = cfg.watch.fanout.n;
      const a = cfg.watch.fanout.concurrency;
      const c = cfg.watch.concurrency;
      if (n <= 1) {
        check(report, "watch.fanout", true, "n=1 — single dispatch per claimed issue (best-of-N off)", "info");
      } else {
        check(
          report,
          "watch.fanout",
          true,
          `n=${n}, attempts in flight per issue=${a}; with watch.concurrency=${c} that is up to ` +
            `${c} x ${a} = ${c * a} chain runs in flight, up to ${c} x ${n} = ${c * n} worktrees on disk at once ` +
            `(a successful attempt's tree is kept until every sibling settles), and ${n} chain runs per claimed issue`,
          "info",
        );

        if (watchChain) {
          // b — only when SOME dispatched agent of watch.chain resolves
          // non-local. Reuses check #1's own resolvedBackend +
          // resolveRequiredAgents computation (recomputed here, scoped to
          // THIS chain rather than every chain) so the two can never
          // disagree about what "resolves non-local" means.
          const resolvedBackendForFanout = (agent: AgentConfig): string => agent.sandbox ?? cfg.sandbox.backend;
          const required = resolveRequiredAgents(watchChain, cfg.watch.chain_options);
          const sandboxed = required.filter((name) => {
            const agent = cfg.agents.find((a2) => a2.name === name);
            return agent !== undefined && resolvedBackendForFanout(agent) !== "local";
          });
          if (sandboxed.length > 0) {
            const perAttempt = cfg.sandbox.scope === "run" ? 1 : sandboxed.length;
            check(
              report,
              "watch.fanout sandbox cost",
              true,
              `${perAttempt} sandbox(es) per attempt under scope: ${cfg.sandbox.scope} (dispatched agents: ${sandboxed.join(", ")}) ` +
                `-> up to ${c} x ${a} x ${perAttempt} = ${c * a * perAttempt} in flight; ${n} x ${perAttempt} = ${n * perAttempt} sandbox creations per claimed issue`,
              "info",
            );
          }

          // c — hard ✗ when n > 1 and watch.chain has no commit phase.
          // Mirrors `spf watch`'s own startup refusal, so `spf doctor`
          // catches this before the daemon is ever started.
          check(
            report,
            "watch.fanout commit phase",
            hasCommitStep(watchChain.phases),
            hasCommitStep(watchChain.phases)
              ? `watch.chain "${cfg.watch.chain}" has a commit phase`
              : `watch.fanout.n is ${n} but watch.chain "${cfg.watch.chain}" has no commit phase (${watchChain.phases}) — ` +
                  `best-of-N discards every losing attempt's worktree, uncommitted work included; see \`spf watch\`'s own startup refusal for the full explanation`,
          );
        }

        // d — warn, not a hard failure: an unbounded run is the documented
        // default (every reachability/posture check in this file is
        // info/warn rather than a hard failure). A daemon repeats this bill
        // every tick, though, which is what earns the warn over check #1's
        // plain info line.
        if (cfg.defaults.max_run_cost === undefined && cfg.defaults.max_run_tokens === undefined) {
          check(
            report,
            "watch.fanout budget ceiling",
            true,
            `no defaults.max_run_cost / defaults.max_run_tokens configured — every claimed issue runs ${n} attempts to completion, unbounded`,
            "warn",
          );
        }
      }
    }

    if (cfg.watch.refine.enabled) {
      const refineChain = findChain(cfg.watch.refine.chain);
      check(
        report,
        "watch.refine.chain",
        Boolean(refineChain),
        refineChain ? `${cfg.watch.refine.chain}${refineChain.source ? ` (repo: ${repoChainLabel(refineChain.source)})` : ""}` : `"${cfg.watch.refine.chain}" is not a registered chain`,
      );
      if (refineChain) {
        checkChainRequirements(report, `watch.refine.chain "${cfg.watch.refine.chain}"`, refineChain, cfg);
      }
      check(
        report,
        "watch.refine issue authoring",
        cfg.watch.issue_provider === "github" || cfg.watch.issue_provider === "jira",
        cfg.watch.issue_provider === "github"
          ? "github supports issue authoring (createIssue/sub-issues)"
          : cfg.watch.issue_provider === "jira"
            ? "jira supports issue authoring (createIssue/parent field) — run `spf watch init` to validate watch.jira.issue_types against the real project"
            : `watch.issue_provider is ${JSON.stringify(cfg.watch.issue_provider)} — the refine lane needs "github" or "jira"`,
      );
    }
  }

  // OTel span export: informational in every direction. It is off unless
  // `observability.otel` exists (no env var can turn it on — see
  // core/otel.ts), and when it IS on, an unreachable collector must never fail
  // `spf doctor` any more than it fails a run: export is a lossy projection of
  // a trace SQLite already holds. What doctor adds is visibility — "configured
  // but nothing is listening" is otherwise a single redacted log line inside a
  // run nobody re-reads.
  if (cfg.observability.otel) {
    const url = resolveTracesUrl(cfg.observability.otel.endpoint);
    const insecure = url.startsWith("http://") && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(url);
    check(
      report,
      "observability.otel",
      true,
      // endpointLabel() drops any userinfo and query string — both are places
      // a token gets smuggled into a URL, and doctor's output gets pasted into
      // issues. Header VALUES are never printed at all, only their key names.
      `span export -> ${endpointLabel(url)} (service_name: ${cfg.observability.otel.service_name}` +
        `${cfg.observability.otel.headers ? `, headers: ${Object.keys(cfg.observability.otel.headers).join(", ")}` : ""})` +
        (insecure ? " — WARNING: plain http to a non-loopback host sends this telemetry in cleartext" : ""),
      insecure ? "warn" : "info",
    );
    if (!flags["no-probe"]) {
      // Captured into a local: TS narrowing from the outer `if (cfg.observability.otel)` doesn't survive into this closure.
      const otelHeaders = cfg.observability.otel.headers;
      const result = await withProbeStatus("observability.otel reachability", () => probeOtel(url, otelHeaders));
      check(
        report,
        "observability.otel reachability",
        true, // informational/warning only — same rule as the base-URL probes above
        result.ok
          ? `reachable: POST ${endpointLabel(url)} (empty batch) -> HTTP ${result.status}${result.status >= 400 ? " — reachable but rejecting; check the path (/v1/traces) and headers" : ""}`
          : `unreachable: POST ${endpointLabel(url)} -> ${result.error}`,
        result.ok && result.status < 400 ? "info" : "warn",
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

async function finish(report: Report, json: boolean): Promise<number> {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  const footer = { ok: report.ok, message: report.ok ? "spf doctor: clean" : "spf doctor: problems found above" };
  if (isInteractive()) {
    const { renderChecklist } = await import("../ui/reports.tsx");
    await renderChecklist(
      report.checks.map((c) => ({
        icon: c.severity === "warn" ? "warn" : c.severity === "info" ? "info" : c.ok ? "ok" : "fail",
        name: c.name,
        detail: c.detail,
      })),
      footer,
    );
  } else {
    for (const c of report.checks) {
      const icon = c.severity === "warn" ? "⚠" : c.severity === "info" ? "ℹ" : c.ok ? "✓" : "✗";
      console.log(`${icon} ${c.name}: ${c.detail}`);
    }
    console.log(`\n${footer.message}`);
  }
  return report.ok ? 0 : 1;
}
