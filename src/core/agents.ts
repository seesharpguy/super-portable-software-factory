/**
 * Config loading/validation and agent execution.
 *
 * Every ADW validates its agents before running (fail fast, nothing spawns
 * against a half-valid config). Every agent call parses against a concrete
 * output type; parse failures and gate violations re-prompt the SAME session
 * with a correction — context intact, bounded retries. Agent proposes, code
 * disposes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import * as v from "valibot";
import * as agentCc from "./agent_cc.ts";
import * as agentFlue from "./agent_flue.ts";
import * as paths from "./paths.ts";
import * as permissions from "./permissions.ts";
import * as prompts from "./prompts.ts";
import * as sandbox from "./sandbox.ts";
import { effectiveAgent, type TierResolution } from "./tiering.ts";
import {
  GateReport,
  UsageBreakdown,
  makeEventRecord,
  SFConfigSchema,
  type AgentCall,
  type AgentConfig,
  type EnvelopeBase,
  type AgentRequest,
  type Phase,
  type SFConfig,
  type SandboxConfig,
  type SandboxSpec,
} from "./data_types.ts";
import { newId, operatorEnv } from "./utils.ts";

const JSON_FIX_ATTEMPTS = 2; // continue-with-correction attempts for malformed JSON

// Kept alongside agent_flue.ts's own comment on this same list — `local()`'s
// sandbox keeps these regardless of any `env` override, so an allowlist that
// omitted them would silently lose them there but not on agent_cc.ts's plain
// `spawn()`. Folding them in here keeps both backends' filtered env identical.
const ENV_BASELINE_KEYS = ["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR"];

/**
 * `undefined` (no `env_allowlist` configured — the default) means "don't
 * filter at all"; both backends treat that as `request.env ?? operatorEnv()`,
 * i.e. today's unfiltered behavior, byte-identical. Configured, this filters
 * the operator's own environment down to the named keys plus the baseline
 * `local()` would keep anyway.
 */
export function agentEnv(agent: AgentConfig): Record<string, string> | undefined {
  if (!agent.env_allowlist) return undefined;
  const operator = operatorEnv();
  const keep = new Set([...ENV_BASELINE_KEYS, ...agent.env_allowlist]);
  const env: Record<string, string> = {};
  for (const key of keep) {
    if (operator[key] !== undefined) env[key] = operator[key];
  }
  return env;
}

export class GateFailure extends Error {}

/**
 * A run that has reached (or passed) one of `defaults`' budget ceilings.
 *
 * Its own class, like `GateFailure`, so a caller can tell "this run was cut
 * off on purpose" from "the agent broke" — thrown from `send()` below, which
 * puts it inside `run.phase()`'s try/catch, so the phase records `fail` and
 * the run exits non-zero. That is the intended outcome: fail CLOSED. A budget
 * that logged a warning and kept spending would not be a budget.
 */
export class BudgetExceeded extends Error {}

/**
 * `$0.412` — three decimals, with a trailing zero trimmed so a round ceiling
 * reads as the operator wrote it (`$0.40`, not `$0.400`). Cents are not
 * enough precision here: a single cheap call is often sub-cent, and a budget
 * message that says `$0.00 of max_run_cost $0.40` tells nobody anything.
 */
export function formatUsd(value: number): string {
  const fixed = value.toFixed(3);
  return `$${fixed.endsWith("0") ? fixed.slice(0, -1) : fixed}`;
}

/**
 * The accumulating totals a budget check reads. Structurally a subset of
 * `Run` (`core/runner.ts`) — `run.tokens`/`run.cost` are incremented by
 * `run.addUsage()` after every send — so the real `Run` satisfies it with no
 * adapter, and a test can pass a plain object with fake usage.
 */
export interface RunBudgetState {
  cfg: SFConfig;
  tokens: number;
  cost: number;
}

/**
 * Throw if this run has spent its budget. Called BEFORE every agent
 * dispatch, never after.
 *
 * WHY BEFORE, AND WHY `>=`: the cost of the call about to happen is
 * unknowable until it finishes, so a ceiling can only ever be enforced as
 * "no further calls" — checked after the fact it would be a report, not a
 * cap. `>=` follows from that: a run that has already spent exactly its
 * ceiling has nothing left to spend, and letting one more (unbounded) call
 * through would make the ceiling soft by exactly one call — which, on a
 * chain whose last phase is the expensive one, is the whole overrun.
 *
 * Both ceilings absent (the default) returns immediately: zero behavior
 * change, no arithmetic, nothing to get wrong.
 */
export function assertRunBudget(run: RunBudgetState): void {
  const { max_run_cost: maxCost, max_run_tokens: maxTokens } = run.cfg.defaults;
  if (maxCost === undefined && maxTokens === undefined) return;
  if (maxCost !== undefined && run.cost >= maxCost) {
    throw new BudgetExceeded(
      `run budget exceeded: ${formatUsd(run.cost)} of max_run_cost ${formatUsd(maxCost)} — ` +
        `raise defaults.max_run_cost or split the work`,
    );
  }
  if (maxTokens !== undefined && run.tokens >= maxTokens) {
    throw new BudgetExceeded(
      `run budget exceeded: ${run.tokens.toLocaleString("en-US")} tokens of max_run_tokens ` +
        `${maxTokens.toLocaleString("en-US")} — raise defaults.max_run_tokens or split the work`,
    );
  }
}

/**
 * A ValiError's own `.message` is only its FIRST issue — fine for a quick
 * console line, not for something a human has to act on or a model has to
 * repair. `v.flatten()` gives every issue, keyed by field path; this renders
 * that as one line per field. Any other error (e.g. JSON.parse's
 * SyntaxError) falls back to its plain message, unchanged.
 */
function describeParseError(error: unknown): string {
  if (!(error instanceof v.ValiError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const flat = v.flatten(error.issues);
  const lines: string[] = [];
  if (flat.root) lines.push(...flat.root);
  if (flat.nested) {
    for (const [field, messages] of Object.entries(flat.nested)) {
      for (const message of messages ?? []) lines.push(`${field}: ${message}`);
    }
  }
  return lines.length > 0 ? lines.join("; ") : error.message;
}

// ── config ───────────────────────────────────────────────────────────────────

/** Same-name agents patch (shallow field overwrite); new names append. */
function mergeAgentLists(base: any[], override: any[]): any[] {
  const merged = base.map((agent) => ({ ...agent }));
  for (const overrideAgent of override) {
    const i = merged.findIndex((a) => a.name === overrideAgent.name);
    if (i === -1) merged.push({ ...overrideAgent });
    else merged[i] = { ...merged[i], ...overrideAgent };
  }
  return merged;
}

/**
 * `defaults`/`observability`/`quality`/`watch`/`notifications`/`review` merge
 * key-by-key; `agents` merges by name.
 *
 * THE SILENT-DROP TRAP (adversarial history, not a hypothetical): this
 * function returns a FIXED-SHAPE object literal — every top-level `SFConfig`
 * key has to be named on BOTH sides of every merged field here, by hand, or
 * a `.spf/spf.config.yaml` value for it is silently discarded before
 * `v.parse(SFConfigSchema, raw)` ever sees it. Adding a key to
 * `SFConfigSchema` without adding it here is exactly that bug — see
 * `data_types.test.ts`'s merge-survival test for `review`, which is the
 * regression guard this comment is here to justify.
 */
function mergeRawConfig(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  return {
    // Key-by-key, like `defaults`/`watch` — a repo override adding ONE env
    // var shouldn't have to repeat every built-in one.
    env: { ...(base.env || {}), ...(override.env || {}) },
    defaults: { ...(base.defaults || {}), ...(override.defaults || {}) },
    observability: { ...(base.observability || {}), ...(override.observability || {}) },
    quality: { ...(base.quality || {}), ...(override.quality || {}) },
    // `watch` is spread WHOLE — no per-sub-key enumeration inside it — so
    // any WatchConfigSchema field, present or future (jira, refine,
    // chain_options, ...), already passes through this line untouched.
    // The silent-drop trap this function's own doc comment warns about is
    // about the TOP-LEVEL keys named here, not watch's own fields; the
    // actual boundary for one of those is WatchConfigSchema itself (an
    // unknown key there is stripped at `v.parse`, same failure mode, just a
    // different gate) — see `chain_options`'s merge-survival test in
    // `data_types.test.ts` for the check that actually matters here.
    watch: { ...(base.watch || {}), ...(override.watch || {}) },
    // channels is a whole-array replace on override, same as quality.checks —
    // you don't want an override's channels appended to the built-in's.
    notifications: { ...(base.notifications || {}), ...(override.notifications || {}) },
    // review.require_human_signoff / review.signoff_timeout_seconds — see
    // data_types.ts's ReviewConfigSchema doc comment for why this key exists.
    review: { ...(base.review || {}), ...(override.review || {}) },
    // tiering.enabled / .tiers / .roles — key-by-key at this level, so a repo
    // that only flips `enabled` keeps the base's tiers/roles. `tiers` is a
    // whole-LIST replace on override (like quality.checks and
    // notifications.channels): a repo that declares its own ladder replaces
    // the packaged one wholesale rather than getting an unordered splice of
    // both. `roles` is a whole-OBJECT replace for the same reason — a
    // half-merged role map would route some agents by the base's ladder and
    // some by the override's. Pinned by src/test/data_types.test.ts.
    tiering: { ...(base.tiering || {}), ...(override.tiering || {}) },
    // sandbox.backend / .workspace_dir / .scope / ... — see data_types.ts's
    // SandboxConfigSchema. Nested opensandbox/cloudflare/egress/transport/
    // credentials are WHOLE-OBJECT replaces on override, same rule as
    // observability.otel (a half-merged base_url/api_key_env pair would
    // authenticate to the wrong control plane); sandbox's own scalar keys
    // still merge key-by-key around them. Pinned by a merge-survival test
    // in src/test/data_types.test.ts.
    sandbox: { ...(base.sandbox || {}), ...(override.sandbox || {}) },
    agents: mergeAgentLists(base.agents || [], override.agents || []),
  };
}

/**
 * Load and merge every existing path in `configPaths`, in order — later
 * paths override earlier ones. Built-in defaults first, an optional `.spf/`
 * override second is the normal case; a single explicit `--config` path
 * (the caller passes just that one path, no built-in) is used standalone.
 * A path that doesn't exist is silently skipped, EXCEPT that if none of them
 * exist the result is an all-defaults config — every field has a schema
 * default, so this degrades to "zero agents defined" rather than a crash,
 * and agents.validate() reports that plainly.
 */
export function loadConfig(configPaths: string[]): SFConfig {
  let raw: Record<string, any> = {};
  for (const configPath of configPaths) {
    if (!existsSync(configPath)) continue;
    const parsed = (parseYaml(readFileSync(configPath, "utf-8")) as Record<string, any>) || {};
    raw = mergeRawConfig(raw, parsed);
  }
  const defaults = raw.defaults || {};
  // THE BACK-FILL LIST IS PER-AGENT SETTINGS ONLY. Every key here is copied
  // DOWN onto each agent that didn't set it, so only fields that mean
  // something about ONE agent belong. Run-scoped `defaults` keys must stay
  // out: `data_dir`, `protected_files`, and `max_run_cost`/`max_run_tokens`
  // are properties of the RUN, and a per-agent copy of a run budget would
  // read as "each agent may spend this much" — a different, unenforced
  // feature. (AgentConfigSchema is a non-strict v.object, so a stray copy
  // would be silently STRIPPED at parse rather than rejected: the mistake
  // would look like it worked. See ConfigDefaultsSchema's own note.)
  for (const agent of raw.agents || []) {
    for (const key of ["coding_agent", "model", "thinking", "color", "tools", "writes", "env_allowlist"]) {
      if (key in defaults && !(key in agent)) agent[key] = defaults[key];
    }
    if (!("harness_engineering" in agent)) agent.harness_engineering = defaults.harness_engineering || [];
  }
  try {
    return v.parse(SFConfigSchema, raw);
  } catch (error) {
    throw new Error(`invalid config (${configPaths.join(", ")}): ${describeParseError(error)}`);
  }
}

const ENV_VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * `${VAR}` substitutes from `process.env` at call time — a real secret can
 * live in `.env` (gitignored) and be referenced from the committed
 * `spf.config.yaml` without ever being written into it. An undefined
 * reference throws rather than silently interpolating to `""`: a value like
 * `SPF_CLAUDE_CMD="ollama launch claude --model ${OLLAMA_TAG}"` silently
 * missing its tag would fail confusingly far downstream (a launcher error,
 * or a wrong-but-plausible model), not here where the actual cause is known.
 */
export function interpolateEnvValue(key: string, raw: string): string {
  return raw.replace(ENV_VAR_REF, (_match, name) => {
    const value = process.env[name];
    if (value === undefined) {
      throw new Error(`env.${key}: references \${${name}}, which is not set (.env or the shell) — set it before running spf`);
    }
    return value;
  });
}

/**
 * Apply `cfg.env` to `process.env` — called once, in `cli/index.ts`'s
 * `main()`, right after `.env` loads and before any command runs, so every
 * later `process.env[...]` read (provider keys, `SPF_CLAUDE_CMD`, ...) sees
 * the result. A key already set in `process.env` (a real shell export, or
 * `.env`, both of which load before this) is left untouched — `cfg.env`
 * supplies a DEFAULT, never forces an override, mirroring
 * `process.loadEnvFile()`'s own precedence for `.env` itself.
 */
export function applyConfigEnv(env: Record<string, string>): void {
  for (const [key, rawValue] of Object.entries(env)) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = interpolateEnvValue(key, rawValue);
  }
}

export function resolve(cfg: SFConfig, name: string): AgentConfig {
  const agent = cfg.agents.find((a) => a.name === name);
  if (!agent) {
    throw new Error(`agent ${JSON.stringify(name)} is not defined in the config — available: ${JSON.stringify(cfg.agents.map((a) => a.name))}`);
  }
  return agent;
}

/** Fail fast: every required name must resolve to a usable agent. */
export function validate(cfg: SFConfig, required: string[], requiredSuites: string[] = [], cwd?: string): void {
  const anchor = paths.resolveAnchor(cwd);
  const problems: string[] = [];
  for (const suiteName of requiredSuites) {
    const names = cfg.quality.suites[suiteName];
    if (!names || names.length === 0) {
      problems.push(
        `quality.suites.${JSON.stringify(suiteName)} is not configured — add it to spf.config.yaml before running a chain that needs it`,
      );
      continue;
    }
    const missing = names.filter((n) => !cfg.quality.checks.some((c) => c.name === n));
    if (missing.length > 0) {
      problems.push(`quality.suites.${suiteName} names check(s) not in quality.checks: ${missing.join(", ")}`);
    }
  }
  for (const name of required) {
    let agent: AgentConfig;
    try {
      agent = resolve(cfg, name);
    } catch (error) {
      problems.push((error as Error).message);
      continue;
    }
    for (const [label, ref] of [
      ["system", agent.prompt_engineering.system],
      ["user", agent.prompt_engineering.user],
    ] as const) {
      try {
        paths.resolvePromptRef(anchor, ref);
      } catch (error) {
        problems.push(`agent ${JSON.stringify(name)}: ${label} ${(error as Error).message}`);
      }
    }
    // Model shape depends on the backend: Flue needs provider/model-id (no
    // catalog to check against, only the static shape); claude_code takes
    // its own bare alias/full-name vocabulary (see agent_cc.ts), so only a
    // non-empty check applies.
    if (agent.coding_agent === "flue") {
      try {
        agentFlue.resolveModel(agent.model);
      } catch (error) {
        problems.push(`agent ${JSON.stringify(name)}: ${(error as Error).message}`);
      }
    } else if (!agent.model.trim()) {
      problems.push(`agent ${JSON.stringify(name)}: model is empty`);
    }
    // harness_engineering (pi -e extensions) has no analogue on any current
    // backend — a subagent/skill built the same way is
    // useSubagent()/defineSkill() (Flue) or an MCP server/plugin (Claude
    // Code) inside a custom tool, not a config path. Fail loudly rather
    // than silently loading nothing.
    if (agent.harness_engineering.length > 0) {
      problems.push(
        `agent ${JSON.stringify(name)}: harness_engineering is not supported (${JSON.stringify(agent.harness_engineering)}) — ` +
          `use useSubagent()/defineSkill() (flue) or an MCP server/plugin (claude_code) in a custom tool instead`,
      );
    }
    const isKnownToolName = agent.coding_agent === "claude_code" ? agentCc.isKnownToolName : agentFlue.isKnownToolName;
    for (const toolName of agent.tools ?? []) {
      if (!isKnownToolName(toolName)) {
        problems.push(`agent ${JSON.stringify(name)}: unknown tool ${JSON.stringify(toolName)} — known: read, write, edit, bash, grep, glob, find (alias for glob), ls (dropped, covered by bash/glob)`);
      }
    }
    // SPF #15 — sandbox backends. Chain-scoped, like every check above in
    // this loop: it fires before anything spawns, for the agents this run
    // will actually use. spf doctor's roster-wide equivalents (checks
    // #7/#12/#13/#14/#15/#17) are a deliberately different, wider scope —
    // see validateSandboxConfig's own doc comment.
    problems.push(...validateSandboxConfig(cfg, agent));
  }
  // SPF #15 — sandbox.scope: "run" is admitted only when the run's agents
  // are provably interchangeable. Once, after the per-agent loop, over the
  // SAME required list — see validateSandboxRunScope's own doc comment.
  problems.push(...validateSandboxRunScope(cfg, required));
  // Tiering (SPF #14) — every check below lives inside this ONE guard. A
  // disabled ladder is not a config error, it is a config that is off: none
  // of this fires for `enabled: false`, no matter what `tiers`/`roles` say —
  // the same reason the packaged ladder + roles map surviving key-by-key
  // merge into a repo that never opted in must not fail every chain.
  if (cfg.tiering.enabled) {
    // cfg-global: every declared rung must be well-formed for its OWN
    // declared backend — the same branch this function already runs for
    // agent.model, just keyed off the tier's coding_agent instead.
    for (const tier of cfg.tiering.tiers) {
      if (tier.coding_agent === "flue") {
        try {
          agentFlue.resolveModel(tier.model);
        } catch (error) {
          problems.push(`tiering.tiers[${JSON.stringify(tier.name)}]: ${(error as Error).message}`);
        }
      } else if (!tier.model.trim()) {
        problems.push(`tiering.tiers[${JSON.stringify(tier.name)}]: model is empty`);
      }
    }
    // cfg-global: `enabled: true` with nothing to route is a silent no-op —
    // the same reason an unconfigured quality.suites entry above is an
    // error rather than a quiet pass-through.
    if (cfg.tiering.tiers.length === 0) {
      problems.push("tiering.enabled is true but tiering.tiers is empty — declare at least one rung or set tiering.enabled: false");
    }
    if (Object.keys(cfg.tiering.roles).length === 0) {
      problems.push("tiering.enabled is true but tiering.roles is empty — name at least one role or set tiering.enabled: false");
    }
    // Scoped to `required` — same precedent as the per-agent loop above
    // (`:256`/`:277-288`): a `roles` key naming a role no phase in this run
    // will dispatch is neither routed nor validated. This is what lets the
    // packaged six-name `roles` map survive key-by-key merge into a repo
    // with a pruned/renamed roster without failing every chain.
    for (const name of required) {
      const tierName = cfg.tiering.roles[name];
      if (tierName === undefined) continue; // precedence: not named in roles -> untouched, nothing to check
      const tier = cfg.tiering.tiers.find((t) => t.name === tierName);
      if (!tier) {
        problems.push(`tiering.roles.${name} names tier ${JSON.stringify(tierName)}, which is not declared in tiering.tiers`);
        continue;
      }
      const agent = cfg.agents.find((a) => a.name === name);
      if (!agent) continue; // already reported above by the per-agent loop's own resolve() failure
      // Rule T — the backend-compatibility rule (§4.4A). A tier changes an
      // agent's `model` and NOTHING else, so a role is routable by a tier
      // only when their backends agree; a mismatch is a named error, never
      // a silent skip, because a config that says "route this role by tier"
      // and then quietly does not is the failure mode this codebase already
      // refuses for suites.
      if (agent.coding_agent !== tier.coding_agent) {
        problems.push(
          `agent ${JSON.stringify(name)} (coding_agent: ${agent.coding_agent}) is routed by tiering.roles to tier ${JSON.stringify(tier.name)} ` +
            `(coding_agent: ${tier.coding_agent}) — a tier's model only speaks its own backend's vocabulary; declare a ` +
            `${agent.coding_agent} rung for ${JSON.stringify(name)} or remove it from tiering.roles`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error("config validation failed:\n- " + problems.join("\n- "));
  }
}

// ── sandbox config validation (SPF #15) ─────────────────────────────────────

/** Repo-relative POSIX form of `child` under `root`, or null when `child` is not under `root` — both already-absolute POSIX paths. */
function posixUnderOrEqual(root: string, child: string): boolean {
  const normRoot = path.posix.normalize(root).replace(/\/+$/, "") || "/";
  const normChild = path.posix.normalize(child);
  return normChild === normRoot || normChild.startsWith(`${normRoot}/`);
}

/**
 * THIS AGENT's resolved keys: sandbox.env_allowlist ∩ (agent.env_allowlist
 * ?? everything), through the SAME discipline `agentEnv` uses (same source,
 * `operatorEnv()`; same never-log rule) — but deliberately WITHOUT
 * `ENV_BASELINE_KEYS`: PATH/HOME/TMPDIR from this (macOS/Linux) host would
 * be actively wrong inside a Linux container and would break the mandatory
 * `git`/`tar`/`base64` preflight itself. See sandboxSpecFor's own comment.
 */
function sandboxEnvFor(sb: SandboxConfig, agent: AgentConfig): Record<string, string> {
  const operator = operatorEnv();
  const agentAllow = agent.env_allowlist; // undefined/null = no further narrowing
  const env: Record<string, string> = {};
  for (const key of sb.env_allowlist) {
    if (agentAllow != null && !agentAllow.includes(key)) continue;
    if (operator[key] !== undefined) env[key] = operator[key];
  }
  return env;
}

/**
 * The sorted key NAMES `sandboxEnvFor` would resolve for this agent — no
 * operator env read at all, so this is safe in CI where an allowlisted key
 * legitimately may not exist. Used by `validateSandboxRunScope` to compare
 * agents' resolved env shape without ever touching a value.
 */
function sandboxEnvKeyNames(sb: SandboxConfig, agent: AgentConfig): string[] {
  const agentAllow = agent.env_allowlist;
  const names = agentAllow == null ? sb.env_allowlist : sb.env_allowlist.filter((k) => agentAllow.includes(k));
  return [...new Set(names)].sort();
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * Config-only, per-agent — no `Run`, no session id, no network, no fs
 * beyond the config already in hand. Called from `validate()`'s existing
 * per-agent loop, chain-scoped (only agents the resolved chain requires).
 * `spf doctor`'s equivalents (checks #7/#12/#13/#14/#17) walk the WHOLE
 * roster instead — a deliberately wider, separate scope; see `validate()`'s
 * own comment for why the two are not the same check.
 */
export function validateSandboxConfig(cfg: SFConfig, agent: AgentConfig): string[] {
  const problems: string[] = [];
  const sb = cfg.sandbox;
  const backend = agent.sandbox ?? sb.backend;

  // claude_code spawns a host process (agent_cc.ts's spawn()) with no
  // sandbox seam at all — sandboxing it would mean running the `claude` CLI
  // INSIDE the container, a different feature, not this config flag.
  if (agent.coding_agent === "claude_code" && backend !== "local") {
    problems.push(
      `agent ${JSON.stringify(agent.name)}: coding_agent "claude_code" cannot use sandbox backend ${JSON.stringify(backend)} — ` +
        `claude_code always spawns a host process with no sandbox seam; set agent.sandbox: local (or sandbox.backend: local) for this agent`,
    );
  }

  if (backend === "opensandbox") {
    if (!sb.opensandbox.base_url.trim()) {
      problems.push('sandbox.opensandbox.base_url is empty — required when the resolved backend is "opensandbox"');
    }
    if (!sb.image.trim()) {
      problems.push(
        'sandbox.image is empty — required when the resolved backend is "opensandbox": the image MUST contain git, tar and base64 ' +
          "(the workspace transport shells out to all three) — see sandbox.setup if your base image needs one of them added",
      );
    }
  }
  if (backend === "cloudflare") {
    if (!sb.cloudflare.bridge_url.trim()) {
      problems.push('sandbox.cloudflare.bridge_url is empty — required when the resolved backend is "cloudflare"');
    }
    if (!sb.cloudflare.api_token_env.trim()) {
      problems.push('sandbox.cloudflare.api_token_env is unset — required when the resolved backend is "cloudflare"');
    }
  }

  // sandbox.fanout: "sandbox" (fan-out THROUGH sandboxes) is honored as of
  // PR B — src/cli/commands/fanout.ts's runAttempt already derives each
  // attempt's own SandboxSpec from that attempt's own worktree/adw_id via
  // the ordinary sandboxSpecFor() path (src/core/fanout.ts is unmodified;
  // see its module comment). Nothing to reject here any more.

  // SPF #15 PR B (§6.1) — an unregistered credential broker name is a hard
  // config error, never a silent fallback to "static": the only broker this
  // build ever registers. Compared against the REGISTRY (sandbox.ts), not a
  // hardcoded literal, so a future broker (§6.3) is a code addition there,
  // not a second place this string has to be kept in sync.
  if (!sandbox.KNOWN_CREDENTIAL_BROKER_IDS.includes(sb.credentials.broker)) {
    problems.push(
      `sandbox.credentials.broker ${JSON.stringify(sb.credentials.broker)} is not a registered credential broker — ` +
        `known: ${sandbox.KNOWN_CREDENTIAL_BROKER_IDS.join(", ")} (never falls back to "static" silently)`,
    );
  }

  if (sb.max_total_lifetime_seconds < sb.lifetime_seconds) {
    problems.push(
      `sandbox.max_total_lifetime_seconds (${sb.max_total_lifetime_seconds}) must be >= sandbox.lifetime_seconds (${sb.lifetime_seconds})`,
    );
  }
  // The DEFAULT exec deadline has to fit inside the client-side control-plane
  // timeout; a caller-supplied timeoutMs still passes through unmodified
  // (no clamp — see sandbox.ts), so this relation covers only the default.
  if (sb.request_timeout_seconds < sb.exec_timeout_seconds) {
    problems.push(
      `sandbox.request_timeout_seconds (${sb.request_timeout_seconds}) must be >= sandbox.exec_timeout_seconds (${sb.exec_timeout_seconds})`,
    );
  }

  for (const [key, value] of [
    ["workspace_dir", sb.workspace_dir],
    ["handoff_dir", sb.handoff_dir],
    ["scratch_dir", sb.scratch_dir],
  ] as const) {
    if (!path.posix.isAbsolute(value)) problems.push(`sandbox.${key} must be an absolute path (got ${JSON.stringify(value)})`);
  }
  // The blocker: nested handoff/scratch dirs ride the extract's `git add -A`
  // onto the host at `<repo>/.spf/...`, which spf init's GITIGNORE_ENTRIES
  // does not cover, so permissions.enforce kills the phase. One shared rule
  // applied to BOTH planes — not two similar checks that can drift apart.
  if (path.posix.isAbsolute(sb.workspace_dir)) {
    for (const key of ["handoff_dir", "scratch_dir"] as const) {
      const value = sb[key];
      if (path.posix.isAbsolute(value) && posixUnderOrEqual(sb.workspace_dir, value)) {
        problems.push(
          `sandbox.${key} (${value}) must not be inside sandbox.workspace_dir (${sb.workspace_dir}) — ` +
            `it would be swept into the extract's "git add -A" onto the host and rejected by permissions.enforce`,
        );
      }
    }
  }
  if (
    path.posix.isAbsolute(sb.handoff_dir) &&
    path.posix.isAbsolute(sb.scratch_dir) &&
    path.posix.normalize(sb.handoff_dir) === path.posix.normalize(sb.scratch_dir)
  ) {
    problems.push(
      `sandbox.scratch_dir must not equal sandbox.handoff_dir (${sb.handoff_dir}) — the seed's housekeeping would delete handoff payloads`,
    );
  }

  return problems;
}

/**
 * `scope: "run"` is safe only when every required agent's create-time spec
 * is provably identical — compared as backend + resolved env KEY NAMES
 * (never values) + the create-time-reachable rest of the spec (image,
 * setup, egress, workspace_dir, handoff_dir). A no-op for `scope: "agent"`
 * (the default) and for a chain whose required agents all resolve to
 * `local` — the common path pays nothing.
 */
export function validateSandboxRunScope(cfg: SFConfig, required: string[]): string[] {
  const problems: string[] = [];
  if (cfg.sandbox.scope !== "run") return problems;

  type Tuple = { agent: string; backend: string; envKeys: string[] };
  const tuples: Tuple[] = [];
  for (const name of required) {
    const agent = cfg.agents.find((a) => a.name === name);
    if (!agent) continue; // reported by validate()'s own per-agent loop
    const backend = agent.sandbox ?? cfg.sandbox.backend;
    if (backend === "local") continue;
    tuples.push({ agent: name, backend, envKeys: sandboxEnvKeyNames(cfg.sandbox, agent) });
  }
  if (tuples.length < 2) return problems;

  const first = tuples[0]!;
  for (const other of tuples.slice(1)) {
    if (other.backend !== first.backend) {
      problems.push(
        `sandbox.scope: "run" requires every required agent to resolve to the same sandbox backend, but ` +
          `${JSON.stringify(first.agent)} resolves to ${JSON.stringify(first.backend)} while ${JSON.stringify(other.agent)} resolves to ` +
          `${JSON.stringify(other.backend)} — use scope: agent (the default) or align the agents' backends`,
      );
      continue;
    }
    if (!sameStringArray(first.envKeys, other.envKeys)) {
      const onlyFirst = first.envKeys.filter((k) => !other.envKeys.includes(k));
      const onlyOther = other.envKeys.filter((k) => !first.envKeys.includes(k));
      problems.push(
        `sandbox.scope: "run" requires every required agent to resolve to the SAME env key set, but ` +
          `${JSON.stringify(first.agent)} and ${JSON.stringify(other.agent)} differ ` +
          `(only in ${JSON.stringify(first.agent)}: ${JSON.stringify(onlyFirst)}; only in ${JSON.stringify(other.agent)}: ${JSON.stringify(onlyOther)}) — ` +
          `use scope: agent (the default) or align sandbox.env_allowlist / the agents' own env_allowlist`,
      );
    }
  }
  return problems;
}

// ── execution ────────────────────────────────────────────────────────────────

interface RunForAgents {
  cfg: SFConfig;
  adw_id: string;
  /** Run-total tokens/cost so far, mirrored by `addUsage` below — read by `assertRunBudget` before every send. */
  tokens: number;
  cost: number;
  repo_root: string;
  spf_dir: string | null;
  data_dir: string;
  session_dir: string;
  context_handoff_dir: string;
  agent_map: Record<string, { session_id: string; model: string; coding_agent: string }>;
  /**
   * Set once by `startRun` (`src/chains/steps.ts`), null until then. Optional
   * here — a structural interface must not force every present and future
   * test fake to carry it — and `effectiveAgent`'s own `?? base.model`
   * fallback already handles absence. See `core/tiering.ts`.
   */
  tiering?: TierResolution | null;
  tracer: {
    event: (record: ReturnType<typeof makeEventRecord>) => Promise<string>;
    processStart: (adwId: string, kind: string, name: string, pid: number, command: string) => Promise<void>;
    processEnd: (adwId: string, pid: number) => Promise<void>;
    envelopeRow: (phase: Phase, agent: string, outputType: string, payloadJson: string, valid: boolean, attempt: number) => Promise<void>;
    gateRow: (phase: Phase, gate: string, report: GateReport, attempt: number) => Promise<void>;
    agentSessionRow: (adwId: string, agent: AgentConfig, sessionId: string, contextTokens?: number, contextWindow?: number) => Promise<void>;
  };
  console: {
    agentStarted: (name: string, model: string, sessionId: string) => Promise<void>;
    gateResult: (name: string, report: GateReport) => Promise<void>;
    retry: (name: string, attempt: number, limit: number, reason: string) => Promise<void>;
    envelopeSummary: (envelope: EnvelopeBase, typeName: string) => Promise<void>;
    agentFinished: (name: string, tokens: number, cost: number) => Promise<void>;
  };
  addUsage: (tokens: number, cost: number) => Promise<void>;
  saveAgentMap: (agent: string, entry: { session_id: string; model: string; coding_agent: string }) => void;
}

/**
 * PURE, SYNC — no network, no filesystem, no session id (session ids exist
 * only after `agentSessionId()`, which runs after this — SPF #15's design
 * doc §4.4 walks through exactly why the ordering forces that). `run.cfg` +
 * `run.adw_id` + `run.repo_root` + `run.context_handoff_dir` + the agent in,
 * `SandboxSpec | undefined` out. `undefined` (the resolved backend is
 * "local") means `AgentRequest.sandbox` stays unset — byte-identical to
 * before this feature existed.
 *
 * `handoff_sandbox` PRESERVES `handoff_host`'s shape —
 * `<handoff_dir>/sessions/<adw_id>/context_handoff`, mirroring
 * `run.context_handoff_dir` — because two shipped prompts
 * (planner/user.md, documenter/user.md) parse `<adw_id>` out of that exact
 * shape to name `specs/<adw_id>_<slug>.md`/`app_docs/<adw_id>_<slug>.md`. A
 * bare `handoff_dir` would silently cost those filenames their provenance,
 * with `gates.artifactsExist` still green (it only checks the CLAIMED path).
 */
export function sandboxSpecFor(run: RunForAgents, agent: AgentConfig): SandboxSpec | undefined {
  const sb = run.cfg.sandbox;
  const backend = agent.sandbox ?? sb.backend;
  if (backend === "local") return undefined;

  const scope = sb.scope;
  const lease_key = scope === "run" ? run.adw_id : `${run.adw_id}/${agent.name}`;
  const handoff_sandbox = path.posix.join(sb.handoff_dir, "sessions", run.adw_id, "context_handoff");

  return {
    backend,
    adw_id: run.adw_id,
    agent: agent.name,
    lease_key,
    scope,
    host_root: run.repo_root,
    workspace_dir: sb.workspace_dir,
    handoff_host: run.context_handoff_dir,
    handoff_sandbox,
    scratch_dir: sb.scratch_dir,
    env: sandboxEnvFor(sb, agent),
    image: sb.image,
    setup: sb.setup,
    egress: sb.egress,
    lifetime_seconds: sb.lifetime_seconds,
    max_total_lifetime_seconds: sb.max_total_lifetime_seconds,
    request_timeout_seconds: sb.request_timeout_seconds,
    exec_timeout_seconds: sb.exec_timeout_seconds,
    transport: sb.transport,
    opensandbox: sb.opensandbox,
    cloudflare: sb.cloudflare,
  };
}

/**
 * Rewrite one path field's string entries by prefix, first rule to match
 * wins, everything else (including an unrelated absolute path) passes
 * through untouched.
 */
function translatePath(value: string, rules: ReadonlyArray<readonly [string, string]>): string {
  for (const [from, to] of rules) {
    if (value === from) return to;
    const prefix = from.endsWith("/") ? from : `${from}/`;
    if (value.startsWith(prefix)) return `${to}/${value.slice(prefix.length)}`;
  }
  return value;
}

/**
 * Envelope fields (besides `artifacts`/`changed_files`) that ALSO carry a
 * single absolute path, so both translate functions below must rewrite
 * them too. `diff_path` (`ChangesOutput`, `data_types.ts`) is the known
 * case: `changes.asEnvelope` sets it as an absolute host path alongside
 * (and duplicating) `artifacts[0]`, and the documenter is hard-instructed
 * to read it directly (`prompts.ts`, the documenter's own system/user
 * prompts) — a sandboxed documenter otherwise gets a host path it cannot
 * open. Add a new field here, not a new one-off `if`, the next time an
 * envelope schema grows a path-bearing scalar.
 */
const SINGLE_PATH_FIELDS = ["diff_path"] as const;

function translateSinglePathFields(
  envelope: EnvelopeBase,
  rules: ReadonlyArray<readonly [string, string]>,
): Partial<Record<(typeof SINGLE_PATH_FIELDS)[number], string>> {
  const out: Partial<Record<(typeof SINGLE_PATH_FIELDS)[number], string>> = {};
  const withFields = envelope as EnvelopeBase & Record<string, unknown>;
  for (const field of SINGLE_PATH_FIELDS) {
    const value = withFields[field];
    if (typeof value === "string" && value) out[field] = translatePath(value, rules);
  }
  return out;
}

/**
 * OUTBOUND (sandbox -> host), mutates the freshly parsed envelope in place.
 * Rewrites `artifacts` and, when present, `changed_files` — the handoff
 * rule is checked FIRST (disjoint from workspace_dir by validation, so
 * order is not load-bearing here, but the implementation still checks it
 * first so it stays correct if that invariant is ever relaxed). Applied
 * immediately after every parse (the first prompt AND every JSON-repair/
 * gate-correction re-parse), so it is total over every dispatch.
 */
export function translateEnvelopePaths(envelope: EnvelopeBase, spec: SandboxSpec): void {
  const rules = [
    [spec.handoff_sandbox, spec.handoff_host],
    [spec.workspace_dir, spec.host_root],
  ] as const;
  envelope.artifacts = envelope.artifacts.map((p) => translatePath(p, rules));
  const withChangedFiles = envelope as EnvelopeBase & { changed_files?: string[] };
  if (Array.isArray(withChangedFiles.changed_files)) {
    withChangedFiles.changed_files = withChangedFiles.changed_files.map((p) => translatePath(p, rules));
  }
  Object.assign(envelope, translateSinglePathFields(envelope, rules));
}

/**
 * INBOUND (host -> sandbox), the exact inverse — applied to `call.previous`
 * at the `variables` build site ONLY, before `JSON.stringify`. Returns a
 * COPY: the persisted envelope and the caller's own object must keep host
 * paths, so this one does not mutate where `translateEnvelopePaths` does.
 *
 * Rule order IS load-bearing here, unlike the outbound direction:
 * `handoff_host` is `<data_dir>/sessions/<adw_id>/context_handoff` and
 * `data_dir` resolves against `repo_root` by default, so `handoff_host` is
 * normally UNDER `host_root`. Checking `host_root` first would rewrite a
 * handoff-plane path to somewhere under `workspace_dir` the mirror never
 * populates — so `handoff_host` is checked FIRST, always.
 */
export function translateEnvelopeToSandbox(envelope: EnvelopeBase, spec: SandboxSpec): EnvelopeBase {
  const rules = [
    [spec.handoff_host, spec.handoff_sandbox],
    [spec.host_root, spec.workspace_dir],
  ] as const;
  const copy: EnvelopeBase & { changed_files?: string[] } = { ...envelope };
  copy.artifacts = (envelope.artifacts ?? []).map((p) => translatePath(p, rules));
  const withChangedFiles = envelope as EnvelopeBase & { changed_files?: string[] };
  if (Array.isArray(withChangedFiles.changed_files)) {
    copy.changed_files = withChangedFiles.changed_files.map((p) => translatePath(p, rules));
  }
  Object.assign(copy, translateSinglePathFields(envelope, rules));
  return copy;
}

/** One agent call: render prompts -> pi run -> typed parse -> gates -> envelope. */
export async function execute(run: RunForAgents, phase: Phase, call: AgentCall): Promise<EnvelopeBase> {
  // The single dispatch-site change tiering makes: one effective AgentConfig,
  // `model` and ONLY `model` possibly overridden (rule T — `coding_agent` is
  // never touched here). Every downstream reader below (`agent_start`'s
  // payload, `run.console.agentStarted`, the actual `AgentRequest`,
  // `agentSessionId`'s reuse comparison, the traced `agent_sessions.model`
  // column, `run.saveAgentMap`) becomes consistent for free. See
  // `core/tiering.ts`'s `effectiveAgent`.
  const agent = effectiveAgent(run, resolve(run.cfg, phase.params.owner));
  const agentDir = path.join(run.session_dir, agent.name);
  mkdirSync(agentDir, { recursive: true });

  // SPF #15 — built here, before `variables`/`prompts.render`, and NOT keyed
  // on the session id (unavailable this early — see sandboxSpecFor's own
  // comment). Both `context_handoff_dir` below and the inbound envelope
  // translation need the spec baked into the rendered prompt text.
  const spec = sandboxSpecFor(run, agent);
  if (spec) {
    sandbox.registerRunLog(spec.adw_id, (e) =>
      void run.tracer
        .event(
          makeEventRecord({
            adw_id: run.adw_id,
            phase_id: phase.phase_id,
            type: "log",
            name: "sandbox",
            payload: { level: e.level, msg: e.msg, ...(e.data ? { data: e.data } : {}) },
          }),
        )
        .catch(() => {}),
    );
  }

  const variables = {
    prompt: call.prompt,
    // Inverse translation (§5.3a): `call.previous` is the previous phase's
    // ALREADY-TRANSLATED host-path envelope; handing it to a sandboxed agent
    // verbatim gives it absolute host paths that do not exist in the
    // container. `changes.asEnvelope`'s `diff_path`/`artifacts` are the
    // sharp case — code-generated, so no prompt instruction can fix them.
    previous_envelope: call.previous
      ? JSON.stringify(spec ? translateEnvelopeToSandbox(call.previous, spec) : call.previous, null, 2)
      : "(none)",
    context_handoff_dir: spec ? spec.handoff_sandbox : run.context_handoff_dir,
  };
  const systemText = prompts.render(paths.resolvePromptRef(run, agent.prompt_engineering.system), variables);
  const userText = prompts.render(paths.resolvePromptRef(run, agent.prompt_engineering.user), variables);
  prompts.save(path.join(agentDir, "prompts"), "system.md", systemText);
  prompts.save(path.join(agentDir, "prompts"), "user.md", userText);

  const { session_id: sessionId, is_new: isNewSession } = agentSessionId(run, agent);
  await run.tracer.event(
    makeEventRecord({
      adw_id: run.adw_id,
      phase_id: phase.phase_id,
      type: "agent_start",
      name: agent.name,
      payload: {
        model: agent.model,
        thinking: agent.thinking,
        color: agent.color,
        session_id: sessionId,
        coding_agent: agent.coding_agent,
        purpose: agent.purpose,
        tools: agent.tools ?? null, // null = all tools
        harness_engineering: agent.harness_engineering,
      },
    }),
  );
  await run.console.agentStarted(agent.name, agent.model, sessionId);

  // Parse retries and gate corrections re-enter the SAME Flue conversation,
  // so the last send is the one whose context occupancy is current — while
  // spend is the opposite: every send costs, so usage accumulates across all.
  let latest: FlueResultLike | null = null;
  const spent = new UsageBreakdown();

  async function send(promptText: string): Promise<FlueResultLike> {
    // The ONE dispatch point for this phase — the first prompt, every
    // JSON-repair retry, and every gate correction all funnel through here,
    // so checking the run's ceilings here is what makes them a cap on the
    // WHOLE run rather than on the first call of each phase. See
    // `assertRunBudget` for why it is checked before, not after.
    assertRunBudget(run);
    const request: AgentRequest = {
      prompt: promptText,
      system_prompt: systemText,
      model: agent.model,
      thinking: agent.thinking,
      session_id: sessionId,
      resume: !isNewSession,
      tools: agent.tools ?? undefined,
      output_schema: call.output_type.schema,
      output_type_name: call.output_type.name,
      cwd: spec ? spec.workspace_dir : run.repo_root,
      flue_db_path: path.join(run.data_dir, "flue.db"),
      env: agentEnv(agent),
      sandbox: spec,
    };
    const forward = eventForwarder(run, phase, agent.name, agent.coding_agent);
    // Best-effort, fire-and-forget: these fire from a plain process-lifecycle
    // callback (agent_cc.ts/agent_flue.ts's onSpawn/onExit hooks), not from
    // this function's own async control flow, so there is nothing useful to
    // await here — same swallow-and-log discipline as tracer.ts's otel fanOut.
    const onSpawn = (pid: number) => void run.tracer.processStart(run.adw_id, "agent", agent.name, pid, `${agent.coding_agent} ${agent.name} ${agent.model}`).catch(() => {});
    const onExit = (pid: number) => void run.tracer.processEnd(run.adw_id, pid).catch(() => {});
    if (spec) await sandbox.reconcileWorkspace(spec);
    const result =
      agent.coding_agent === "claude_code"
        ? await agentCc.run(request, forward, onSpawn, onExit)
        : await agentFlue.run(request, forward, onSpawn, onExit);
    // SPEND IS RECORDED BEFORE THE EXTRACT CAN THROW: a failed extract must
    // not also lose this call's tokens/cost off the Run's ledger.
    await run.addUsage(result.tokens, result.cost);
    spent.merge(result.usage);
    latest = result;
    if (spec) await sandbox.extractWorkspace(spec);
    return result;
  }

  // What the tree looked like before this agent got its hands on it. Every
  // send in this phase — first prompt, JSON retries, gate corrections — is
  // measured against this one baseline.
  const treeBefore = permissions.snapshot(run);

  let result = await send(userText);
  let parsed = await parseWithRetries(run, phase, call, result, send, spec);
  let envelope = parsed.envelope;

  // claim gates — violations flow back into the SAME session as corrections
  for (let gateAttempt = 1; gateAttempt <= Math.max(1, phase.params.retries + 1); gateAttempt++) {
    const violations: string[] = [];
    for (const gate of call.gates || []) {
      const report = asReport(gate(envelope, run));
      const found = report.violations;
      await run.tracer.gateRow(phase, gate.name, report, gateAttempt);
      await run.tracer.event(
        makeEventRecord({
          adw_id: run.adw_id,
          phase_id: phase.phase_id,
          type: found.length > 0 ? "gate_fail" : "gate_pass",
          name: gate.name,
          payload: { attempt: gateAttempt, violations: found, checks: report.checks },
        }),
      );
      await run.console.gateResult(gate.name, report);
      violations.push(...found);
    }
    if (violations.length === 0) break;
    if (gateAttempt > phase.params.retries) {
      throw new GateFailure(`${agent.name} failed gates after ${gateAttempt} attempt(s):\n- ` + violations.join("\n- "));
    }
    phase.attempt = gateAttempt;
    await run.console.retry(agent.name, gateAttempt, phase.params.retries, `${violations.length} gate violation(s)`);
    const correction =
      "Your previous response failed validation:\n- " +
      violations.join("\n- ") +
      "\n\nFix these problems, then re-emit ONLY your Report JSON.";
    result = await send(correction);
    parsed = await parseWithRetries(run, phase, call, result, send, spec);
    envelope = parsed.envelope;
  }

  // Permission is checked after every send is done, and before the envelope is
  // accepted: an agent does not get to report success on a phase in which it
  // wrote somewhere it was not allowed to.
  let touched: string[];
  try {
    touched = permissions.enforce(run, phase, agent, treeBefore);
  } catch (breach) {
    await run.tracer.event(
      makeEventRecord({
        adw_id: run.adw_id,
        phase_id: phase.phase_id,
        type: "error",
        name: "permission_breach",
        payload: {
          agent: agent.name,
          error: (breach as Error).message,
          writes: agent.writes ?? null,
          protected_files: run.cfg.defaults.protected_files,
        },
      }),
    );
    throw breach;
  }
  if (touched.length > 0) {
    await run.tracer.event(
      makeEventRecord({
        adw_id: run.adw_id,
        phase_id: phase.phase_id,
        type: "log",
        name: "paths_touched",
        payload: { agent: agent.name, paths: touched },
      }),
    );
  }

  await persistEnvelope(run, phase, agent.name, call, envelope, parsed.attempt, true);
  await run.console.envelopeSummary(envelope, call.output_type.name);
  const context = latest ?? result;
  await run.tracer.agentSessionRow(run.adw_id, agent, sessionId, context.context_tokens, context.context_window);
  run.saveAgentMap(agent.name, { session_id: sessionId, model: agent.model, coding_agent: agent.coding_agent });
  await run.tracer.event(
    makeEventRecord({
      adw_id: run.adw_id,
      phase_id: phase.phase_id,
      type: "handoff",
      name: agent.name,
      payload: { artifacts: envelope.artifacts, summary: envelope.summary },
    }),
  );
  await run.tracer.event(
    makeEventRecord({
      adw_id: run.adw_id,
      phase_id: phase.phase_id,
      type: "agent_end",
      name: agent.name,
      // Phase totals, not the last send's: a retried phase paid for every attempt.
      tokens: spent.total_tokens,
      payload: {
        cost: spent.total_cost,
        usage: spent.toJSON(),
        context_tokens: context.context_tokens,
        context_window: context.context_window,
      },
    }),
  );
  await run.console.agentFinished(agent.name, spent.total_tokens, spent.total_cost);
  if (envelope.status !== "success") {
    throw new Error(`${agent.name} reported status=${JSON.stringify(envelope.status)}: ${envelope.summary}`);
  }
  return envelope;
}

// ── internals ────────────────────────────────────────────────────────────────

type FlueResultLike = Awaited<ReturnType<typeof agentFlue.run>>;

/** Accept a GateReport, or a legacy gate that returned a violations list. */
function asReport(result: GateReport | string[]): GateReport {
  if (result instanceof GateReport) return result;
  const report = new GateReport();
  for (const v of result || []) report.check(String(v), false);
  return report;
}

/**
 * `is_new` is Flue's own affair to ignore (its `init(agent, {id})` is
 * unconditionally create-or-continue) but `claude_code` needs it explicitly
 * — its CLI has no single create-or-continue flag, only `--session-id`
 * (first contact) vs `--resume` (rejoin), so `send()` threads this through
 * as `AgentRequest.resume`.
 */
function agentSessionId(run: RunForAgents, agent: AgentConfig): { session_id: string; is_new: boolean } {
  const entry = run.agent_map[agent.name];
  if (entry && entry.model === agent.model) return { session_id: entry.session_id, is_new: false }; // rejoin the existing context window
  const session_id = agent.coding_agent === "claude_code" ? agentCc.newSessionId() : `spf-${run.adw_id}-${agent.name}-${newId(4)}`;
  return { session_id, is_new: true };
}

/**
 * One tool_call event per real tool call, with its exact args and result.
 * Picks the tracker for whichever backend this agent runs on — each
 * backend's own module owns the ONE fold point for its raw event shape, so
 * this stays a plain pass-through regardless of which one it's given.
 */
function eventForwarder(run: RunForAgents, phase: Phase, agentName: string, codingAgent: string) {
  const tracker = codingAgent === "claude_code" ? new agentCc.CcToolCallTracker() : new agentFlue.ToolCallTracker();
  return (chunk: any) => {
    const record = tracker.observe(chunk);
    if (record === null) return;
    // The call's span rides the columns; duration_ms stays in the payload as
    // Flue's own authoritative number. Fire-and-forget, same reasoning as
    // onSpawn/onExit above: this callback fires from a synchronous stream
    // event handler (agent_cc.ts's readline `line` event / agent_flue.ts's
    // chunk stream), never from this function's own async control flow.
    const { label, started_at, ended_at, ...rest } = record;
    void run.tracer
      .event(
        makeEventRecord({
          adw_id: run.adw_id,
          phase_id: phase.phase_id,
          type: "tool_call",
          name: label,
          started_at: started_at ?? null,
          ended_at: ended_at ?? null,
          payload: { ...rest, agent: agentName },
        }),
      )
      .catch(() => {});
  };
}

function extractJson(text: string): unknown {
  let candidate = text;
  if (text.includes("```")) {
    const parts = text.split("```");
    for (let i = 1; i < parts.length; i += 2) {
      let block = parts[i];
      if (block.startsWith("json")) block = block.slice(4);
      block = block.trim();
      if (block.startsWith("{")) {
        candidate = block;
        break;
      }
    }
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in the response");
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Parse the final response against the declared output type; on failure,
 * continue the SAME session with a correction (bounded).
 */
async function parseWithRetries(
  run: RunForAgents,
  phase: Phase,
  call: AgentCall,
  result: FlueResultLike,
  send: (text: string) => Promise<FlueResultLike>,
  spec?: SandboxSpec,
): Promise<{ envelope: EnvelopeBase; attempt: number }> {
  let current = result;
  for (let attempt = 1; attempt <= JSON_FIX_ATTEMPTS + 1; attempt++) {
    try {
      // The model may never call sf_report at all (plain text + stop) — fall
      // back to extracting JSON from the text in that case, same as before.
      const payload = current.report ?? extractJson(current.text);
      const envelope = v.parse(call.output_type.schema, payload) as EnvelopeBase;
      // Outbound translation (§5.3a) — total over every parse: the first
      // prompt AND every JSON-repair/gate-correction re-parse, both call
      // sites of this function.
      if (spec) translateEnvelopePaths(envelope, spec);
      return { envelope, attempt };
    } catch (error) {
      const message = describeParseError(error);
      await persistEnvelope(run, phase, phase.params.owner, call, null, attempt, false, current.text);
      if (attempt > JSON_FIX_ATTEMPTS) {
        throw new Error(`${phase.params.owner} never produced valid ${call.output_type.name} JSON: ${message}`);
      }
      await run.console.retry(phase.params.owner, attempt, JSON_FIX_ATTEMPTS, `invalid ${call.output_type.name} JSON: ${message}`);
      const fields = call.output_type.fields.join(", ");
      current = await send(
        `Your response was not valid JSON for the required structure ` +
          `(${message}). Respond again with ONLY a JSON object with these ` +
          `fields: ${fields}. No prose, no code fences.`,
      );
    }
  }
  throw new Error("unreachable");
}

async function persistEnvelope(
  run: RunForAgents,
  phase: Phase,
  agentName: string,
  call: AgentCall,
  envelope: EnvelopeBase | null,
  attempt: number,
  valid: boolean,
  raw: string = "",
): Promise<void> {
  const payloadJson = envelope ? JSON.stringify(envelope, null, 2) : JSON.stringify({ raw: raw.slice(-2000) });
  await run.tracer.envelopeRow(phase, agentName, call.output_type.name, payloadJson, valid, attempt);
  if (envelope) {
    const record = {
      agent_name: agentName,
      purpose: resolve(run.cfg, agentName).purpose,
      output_type: call.output_type.name,
      attempt,
      ...envelope,
    };
    writeFileSync(path.join(run.session_dir, agentName, "envelope.json"), JSON.stringify(record, null, 2));
  }
}
