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
import type { ConversationStreamChunk } from "@flue/runtime";
import * as v from "valibot";
import * as agentFlue from "./agent_flue.ts";
import * as paths from "./paths.ts";
import * as permissions from "./permissions.ts";
import * as prompts from "./prompts.ts";
import {
  GateReport,
  UsageBreakdown,
  makeEventRecord,
  SFConfigSchema,
  type AgentCall,
  type AgentConfig,
  type EnvelopeBase,
  type FlueRequest,
  type Phase,
  type SFConfig,
} from "./data_types.ts";
import { newId } from "./utils.ts";

const JSON_FIX_ATTEMPTS = 2; // continue-with-correction attempts for malformed JSON

export class GateFailure extends Error {}

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

/** `defaults`/`observability`/`quality` merge key-by-key; `agents` merges by name. */
function mergeRawConfig(base: Record<string, any>, override: Record<string, any>): Record<string, any> {
  return {
    defaults: { ...(base.defaults || {}), ...(override.defaults || {}) },
    observability: { ...(base.observability || {}), ...(override.observability || {}) },
    quality: { ...(base.quality || {}), ...(override.quality || {}) },
    agents: mergeAgentLists(base.agents || [], override.agents || []),
  };
}

/**
 * Load and merge every existing path in `configPaths`, in order — later
 * paths override earlier ones. Built-in defaults first, an optional `.sf/`
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
  for (const agent of raw.agents || []) {
    for (const key of ["coding_agent", "model", "thinking", "color", "tools", "writes"]) {
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
        `quality.suites.${JSON.stringify(suiteName)} is not configured — add it to sf.config.yaml before running a chain that needs it`,
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
    if (agent.coding_agent !== "flue") {
      problems.push(`agent ${JSON.stringify(name)}: coding_agent ${JSON.stringify(agent.coding_agent)} is not implemented (flue only)`);
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
    try {
      agentFlue.resolveModel(agent.model);
    } catch (error) {
      problems.push(`agent ${JSON.stringify(name)}: ${(error as Error).message}`);
    }
    // harness_engineering (pi -e extensions) has no Flue analogue — a
    // subagent/skill built the same way is now useSubagent()/defineSkill()
    // inside a custom tool, not a config path. Fail loudly rather than
    // silently loading nothing.
    if (agent.harness_engineering.length > 0) {
      problems.push(
        `agent ${JSON.stringify(name)}: harness_engineering is not supported under Flue (${JSON.stringify(agent.harness_engineering)}) — ` +
          `use useSubagent()/defineSkill() in a custom tool instead`,
      );
    }
    for (const toolName of agent.tools ?? []) {
      if (!agentFlue.isKnownToolName(toolName)) {
        problems.push(`agent ${JSON.stringify(name)}: unknown tool ${JSON.stringify(toolName)} — known: read, write, edit, bash, grep, glob, find (alias for glob), ls (dropped, covered by bash/glob)`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error("config validation failed:\n- " + problems.join("\n- "));
  }
}

// ── execution ────────────────────────────────────────────────────────────────

interface RunForAgents {
  cfg: SFConfig;
  adw_id: string;
  repo_root: string;
  sf_dir: string | null;
  data_dir: string;
  session_dir: string;
  context_handoff_dir: string;
  agent_map: Record<string, { session_id: string; model: string; coding_agent: string }>;
  tracer: {
    event: (record: ReturnType<typeof makeEventRecord>) => string;
    processStart: (adwId: string, kind: string, name: string, pid: number, command: string) => void;
    processEnd: (adwId: string, pid: number) => void;
    envelopeRow: (phase: Phase, agent: string, outputType: string, payloadJson: string, valid: boolean, attempt: number) => void;
    gateRow: (phase: Phase, gate: string, report: GateReport, attempt: number) => void;
    agentSessionRow: (adwId: string, agent: AgentConfig, sessionId: string, contextTokens?: number, contextWindow?: number) => void;
  };
  console: {
    agentStarted: (name: string, model: string, sessionId: string) => void;
    gateResult: (name: string, report: GateReport) => void;
    retry: (name: string, attempt: number, limit: number, reason: string) => void;
    envelopeSummary: (envelope: EnvelopeBase, typeName: string) => void;
    agentFinished: (name: string, tokens: number, cost: number) => void;
  };
  addUsage: (tokens: number, cost: number) => void;
  saveAgentMap: (agent: string, entry: { session_id: string; model: string; coding_agent: string }) => void;
}

/** One agent call: render prompts -> pi run -> typed parse -> gates -> envelope. */
export async function execute(run: RunForAgents, phase: Phase, call: AgentCall): Promise<EnvelopeBase> {
  const agent = resolve(run.cfg, phase.params.owner);
  const agentDir = path.join(run.session_dir, agent.name);
  mkdirSync(agentDir, { recursive: true });

  const variables = {
    prompt: call.prompt,
    previous_envelope: call.previous ? JSON.stringify(call.previous, null, 2) : "(none)",
    context_handoff_dir: run.context_handoff_dir,
  };
  const systemText = prompts.render(paths.resolvePromptRef(run, agent.prompt_engineering.system), variables);
  const userText = prompts.render(paths.resolvePromptRef(run, agent.prompt_engineering.user), variables);
  prompts.save(path.join(agentDir, "prompts"), "system.md", systemText);
  prompts.save(path.join(agentDir, "prompts"), "user.md", userText);

  const sessionId = agentSessionId(run, agent);
  run.tracer.event(
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
  run.console.agentStarted(agent.name, agent.model, sessionId);

  // Parse retries and gate corrections re-enter the SAME Flue conversation,
  // so the last send is the one whose context occupancy is current — while
  // spend is the opposite: every send costs, so usage accumulates across all.
  let latest: FlueResultLike | null = null;
  const spent = new UsageBreakdown();

  async function send(promptText: string): Promise<FlueResultLike> {
    const request: FlueRequest = {
      prompt: promptText,
      system_prompt: systemText,
      model: agent.model,
      thinking: agent.thinking,
      session_id: sessionId,
      tools: agent.tools ?? undefined,
      output_schema: call.output_type.schema,
      output_type_name: call.output_type.name,
      cwd: run.repo_root,
      flue_db_path: path.join(run.data_dir, "flue.db"),
    };
    const result = await agentFlue.run(
      request,
      eventForwarder(run, phase, agent.name),
      (pid) => run.tracer.processStart(run.adw_id, "agent", agent.name, pid, `${agent.coding_agent} ${agent.name} ${agent.model}`),
      (pid) => run.tracer.processEnd(run.adw_id, pid),
    );
    run.addUsage(result.tokens, result.cost);
    spent.merge(result.usage);
    latest = result;
    return result;
  }

  // What the tree looked like before this agent got its hands on it. Every
  // send in this phase — first prompt, JSON retries, gate corrections — is
  // measured against this one baseline.
  const treeBefore = permissions.snapshot(run);

  let result = await send(userText);
  let parsed = await parseWithRetries(run, phase, call, result, send);
  let envelope = parsed.envelope;

  // claim gates — violations flow back into the SAME session as corrections
  for (let gateAttempt = 1; gateAttempt <= Math.max(1, phase.params.retries + 1); gateAttempt++) {
    const violations: string[] = [];
    for (const gate of call.gates || []) {
      const report = asReport(gate(envelope, run));
      const found = report.violations;
      run.tracer.gateRow(phase, gate.name, report, gateAttempt);
      run.tracer.event(
        makeEventRecord({
          adw_id: run.adw_id,
          phase_id: phase.phase_id,
          type: found.length > 0 ? "gate_fail" : "gate_pass",
          name: gate.name,
          payload: { attempt: gateAttempt, violations: found, checks: report.checks },
        }),
      );
      run.console.gateResult(gate.name, report);
      violations.push(...found);
    }
    if (violations.length === 0) break;
    if (gateAttempt > phase.params.retries) {
      throw new GateFailure(`${agent.name} failed gates after ${gateAttempt} attempt(s):\n- ` + violations.join("\n- "));
    }
    phase.attempt = gateAttempt;
    run.console.retry(agent.name, gateAttempt, phase.params.retries, `${violations.length} gate violation(s)`);
    const correction =
      "Your previous response failed validation:\n- " +
      violations.join("\n- ") +
      "\n\nFix these problems, then re-emit ONLY your Report JSON.";
    result = await send(correction);
    parsed = await parseWithRetries(run, phase, call, result, send);
    envelope = parsed.envelope;
  }

  // Permission is checked after every send is done, and before the envelope is
  // accepted: an agent does not get to report success on a phase in which it
  // wrote somewhere it was not allowed to.
  let touched: string[];
  try {
    touched = permissions.enforce(run, phase, agent, treeBefore);
  } catch (breach) {
    run.tracer.event(
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
    run.tracer.event(
      makeEventRecord({
        adw_id: run.adw_id,
        phase_id: phase.phase_id,
        type: "log",
        name: "paths_touched",
        payload: { agent: agent.name, paths: touched },
      }),
    );
  }

  persistEnvelope(run, phase, agent.name, call, envelope, parsed.attempt, true);
  run.console.envelopeSummary(envelope, call.output_type.name);
  const context = latest ?? result;
  run.tracer.agentSessionRow(run.adw_id, agent, sessionId, context.context_tokens, context.context_window);
  run.saveAgentMap(agent.name, { session_id: sessionId, model: agent.model, coding_agent: agent.coding_agent });
  run.tracer.event(
    makeEventRecord({
      adw_id: run.adw_id,
      phase_id: phase.phase_id,
      type: "handoff",
      name: agent.name,
      payload: { artifacts: envelope.artifacts, summary: envelope.summary },
    }),
  );
  run.tracer.event(
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
  run.console.agentFinished(agent.name, spent.total_tokens, spent.total_cost);
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

function agentSessionId(run: RunForAgents, agent: AgentConfig): string {
  const entry = run.agent_map[agent.name];
  if (entry && entry.model === agent.model) return entry.session_id; // rejoin the existing context window
  return `sf-${run.adw_id}-${agent.name}-${newId(4)}`;
}

/** One tool_call event per real tool call, with its exact args and result. */
function eventForwarder(run: RunForAgents, phase: Phase, agentName: string) {
  const tracker = new agentFlue.ToolCallTracker();
  return (chunk: ConversationStreamChunk) => {
    const record = tracker.observe(chunk);
    if (record === null) return;
    // The call's span rides the columns; duration_ms stays in the payload as
    // Flue's own authoritative number.
    const { label, started_at, ended_at, ...rest } = record;
    run.tracer.event(
      makeEventRecord({
        adw_id: run.adw_id,
        phase_id: phase.phase_id,
        type: "tool_call",
        name: label,
        started_at: started_at ?? null,
        ended_at: ended_at ?? null,
        payload: { ...rest, agent: agentName },
      }),
    );
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
): Promise<{ envelope: EnvelopeBase; attempt: number }> {
  let current = result;
  for (let attempt = 1; attempt <= JSON_FIX_ATTEMPTS + 1; attempt++) {
    try {
      // The model may never call sf_report at all (plain text + stop) — fall
      // back to extracting JSON from the text in that case, same as before.
      const payload = current.report ?? extractJson(current.text);
      const envelope = v.parse(call.output_type.schema, payload) as EnvelopeBase;
      return { envelope, attempt };
    } catch (error) {
      const message = describeParseError(error);
      persistEnvelope(run, phase, phase.params.owner, call, null, attempt, false, current.text);
      if (attempt > JSON_FIX_ATTEMPTS) {
        throw new Error(`${phase.params.owner} never produced valid ${call.output_type.name} JSON: ${message}`);
      }
      run.console.retry(phase.params.owner, attempt, JSON_FIX_ATTEMPTS, `invalid ${call.output_type.name} JSON: ${message}`);
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

function persistEnvelope(
  run: RunForAgents,
  phase: Phase,
  agentName: string,
  call: AgentCall,
  envelope: EnvelopeBase | null,
  attempt: number,
  valid: boolean,
  raw: string = "",
): void {
  const payloadJson = envelope ? JSON.stringify(envelope, null, 2) : JSON.stringify({ raw: raw.slice(-2000) });
  run.tracer.envelopeRow(phase, agentName, call.output_type.name, payloadJson, valid, attempt);
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
