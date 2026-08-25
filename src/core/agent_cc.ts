/**
 * Claude Code coding agent interface — a second backend alongside
 * `agent_flue.ts` (`coding_agent: claude_code` in config), for running
 * agents on the `claude` CLI instead of Flue. Subprocess-based, on purpose:
 * the official SDK's own platform-specific optional dependency is 300MB+
 * per platform, on top of the `claude` CLI itself (which anyone using this
 * backend needs installed anyway) — shelling out costs SPF zero new
 * dependencies, the same trade the pre-Flue `agent_pi.ts` made for `pi`.
 *
 * The `claude` command is resolved from `PATH` by default. To route it through
 * a wrapper, proxy server, or launcher (e.g., Ollama), set `SPF_CLAUDE_CMD` —
 * ordinarily via `env: { SPF_CLAUDE_CMD: "..." }` in `spf.config.yaml`
 * (see `SFConfigSchema`'s doc comment), since this is a declarative launcher
 * choice, not a secret; a real shell export still works and still wins, for
 * a one-off local override. Space-separated command chains are supported:
 *   - `SPF_CLAUDE_CMD="claude"` (default)
 *   - `SPF_CLAUDE_CMD="ollama launch claude --model <tag>"` (Ollama launcher —
 *     the `--model` is `ollama launch`'s OWN flag, and is mandatory in
 *     headless mode; see below)
 * The command/launcher must support the full Claude Code CLI interface.
 * When unset, defaults to `claude`.
 *
 * A literal `{model}` token anywhere in `SPF_CLAUDE_CMD` is substituted with
 * THIS call's own `request.model` before spawning — e.g.
 * `SPF_CLAUDE_CMD="ollama launch claude --model {model}"` with one agent's
 * `model: kimi-k2.7-code:cloud` and another's `model: qwen3-coder:cloud`
 * genuinely dispatches each to its own model, since `ollama launch`'s
 * `--model` (its OWN flag, resolved BEFORE `--`, not `claude`'s) is what
 * actually pins which model serves the whole launched process — without
 * `{model}`, that flag would have to be one fixed value for every
 * claude_code agent in the roster, making each agent's own `model:` field
 * inert no matter what it said.
 *
 * Wrapper contract for the flags this module appends (`-p`, `--json-schema`,
 * `--model`, ...): a wrapper token chain is spawned as `[...cmdTokens,
 * ...args]`, so a plain passthrough shim needs nothing special, and a
 * cmdSpec that already contains its own literal `--` is left completely
 * alone — `args` lands after it exactly as written. `ollama launch <cmd>
 * [flags...]` is the one documented shape that does NOT self-supply that
 * separator: it uses cobra flag parsing, which treats anything typed after
 * `launch <cmd>` as ITS OWN flags unless a literal `--` says otherwise —
 * spike-verified live: `SPF_CLAUDE_CMD="ollama launch claude"` alone dies
 * with `unknown shorthand flag: 'p' in -p` before `claude` ever starts
 * (scratchpad/ollama-spike/probe2-claudecode-ollama/run3_ollama_launch_claude.log).
 *
 * The `--` insertion below fixes THAT failure, but is NOT by itself
 * sufficient to reach `claude` — it only trades one error for the next one.
 * `ollama launch` also requires its OWN `--model <tag>` flag, typed BEFORE
 * the `--` separator, whenever it's run headless: with no model flag it
 * falls back to an interactive model picker, and SPF always spawns with
 * piped (non-interactive) stdio, so that picker can never run. Spike-verified
 * live: `--` alone (no `--model` anywhere) dies one step later with `Error:
 * model selection requires an interactive terminal; use --model to run in
 * headless mode` (.../run4_ollama_launch_claude_dashdash.log) — that log IS
 * the "just add `--`" experiment, and it fails. Putting `--model <tag>`
 * AFTER the separator doesn't help either: at that point it's parsed as
 * `claude`'s own `--model`, not `ollama launch`'s, so `ollama launch` still
 * sees no model and still fails the same way. Only supplying `ollama
 * launch`'s `--model` BEFORE the separator succeeds end-to-end
 * (.../run5_ollama_launch_claude_full.log). So the operator's `SPF_CLAUDE_CMD`
 * itself must read `ollama launch claude --model <tag>` (tag from `ollama
 * list`) — this module can insert the `--`, but cannot supply the model tag
 * on the operator's behalf; `doctor.ts` hard-fails a `SPF_CLAUDE_CMD` that
 * omits it, since this is a static, deterministic misconfiguration.
 *
 * This module special-cases exactly the `ollama launch ...` token shape
 * (with no `--` already present) and inserts the separator automatically at
 * that position — never for any other wrapper, and never a second `--` if
 * the operator already wrote one themselves.
 *
 * Every flag below was verified against a REAL local run of this exact
 * machine's `claude` CLI (v2.1.237) before being written — not assumed from
 * the SDK's docs, which describe a related but separately-versioned
 * product. Findings that shaped this file:
 *
 *  - `--json-schema` is real, and structured output arrives as a BUILT-IN
 *    tool call named `StructuredOutput` (visible in the `system/init`
 *    message's `tools` list the moment `--json-schema` is passed) — no
 *    custom tool registration needed, unlike Flue's injected `sf_report`.
 *    The final `result` message's `structured_output` field carries the
 *    validated object directly.
 *  - `--strict-mcp-config` (with no `--mcp-config` given) is REQUIRED, not
 *    optional: without it, a spawned `claude` process inherits this
 *    machine's entire user-level MCP server configuration (GitHub, Slack,
 *    Google Drive, whatever the operator has configured globally) — a real
 *    capability leak into what's supposed to be a `tools:`-bounded headless
 *    agent. `--tools ""` alone does NOT strip these; confirmed by a live
 *    run showing `mcp__github__*`/`mcp__claude_ai_*` tools still listed in
 *    `system/init` without it, and gone with it.
 *  - `--resume <uuid>` genuinely continues context (confirmed: a follow-up
 *    call answered from a file read in the FIRST call, never re-reading it)
 *    — the same continuity Flue's `init(agent, {id})` gives, so the
 *    same-session-correction design carries over unchanged.
 *  - The result message's `total_cost_usd` has no per-component breakdown
 *    (unlike Flue/pi-ai's `cost.{input,output,cacheRead,cacheWrite}`) — it's
 *    folded into `UsageBreakdown` under `total_cost` only, honestly, rather
 *    than fabricating a split CC doesn't provide.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { toJsonSchema } from "@valibot/to-json-schema";
import type { AgentRequest, AgentResult, ThinkingLevel } from "./data_types.ts";
import { UsageBreakdown, makeAgentResult } from "./data_types.ts";
import { nowIso, operatorEnv } from "./utils.ts";

const RESULT_SNIPPET_CHARS = 20_000;
const ARG_VALUE_CHARS = 20_000;
const LABEL_CHARS = 80;
const PRIMARY_ARGS = ["command", "path", "file_path", "pattern", "query", "url"];

function clipText(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit).trimEnd() + "…";
}

function labelFor(tool: string, args: Record<string, any>): string {
  let value = "";
  for (const key of PRIMARY_ARGS) {
    if (typeof args[key] === "string" && args[key].trim()) {
      value = args[key];
      break;
    }
  }
  if (!value) {
    for (const v of Object.values(args)) {
      if (typeof v === "string" && v.trim()) {
        value = v;
        break;
      }
    }
  }
  value = String(value).split(/\s+/).filter(Boolean).join(" ");
  return value ? `${tool}: ${clipText(value, LABEL_CHARS)}` : tool;
}

/** `tool_result.content` is a string in every observed case; defensive for the array-of-blocks form Anthropic's spec also allows. */
function snippetOf(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

interface OpenCall {
  tool: string;
  args: Record<string, any>;
  started_at: string;
}

/** One line of `claude -p --output-format stream-json` output, loosely typed — see the module doc comment for what's actually verified. */
export type CcStreamMessage = Record<string, any>;

/**
 * Folds a `tool_use` content block (on an `assistant` message) + its
 * matching `tool_result` block (on a LATER `user` message, linked by
 * `tool_use_id`) into one record — the same shape
 * `agent_flue.ToolCallTracker` produces, so `agents.ts`'s `eventForwarder`
 * needs no backend-specific branching downstream of picking which tracker
 * to use. `StructuredOutput` calls fold through here too, deliberately
 * unfiltered — Flue's `sf_report` tool shows up as an ordinary `tool_call`
 * event for the same reason, and that's useful trace information, not noise.
 */
export class CcToolCallTracker {
  private open = new Map<string, OpenCall>();

  observe(message: CcStreamMessage): Record<string, any> | null {
    if (message.type === "assistant") {
      for (const block of message.message?.content ?? []) {
        if (block.type === "tool_use") {
          this.open.set(block.id, {
            tool: block.name,
            args: block.input || {},
            started_at: message.timestamp || nowIso(),
          });
        }
      }
      return null;
    }
    if (message.type === "user") {
      for (const block of message.message?.content ?? []) {
        if (block.type === "tool_result") {
          return this.finish(block.tool_use_id, block.content, block.is_error !== true, message.timestamp);
        }
      }
    }
    return null;
  }

  private finish(callId: string, content: unknown, ok: boolean, endedAt: string | undefined): Record<string, any> {
    const opened = this.open.get(callId);
    this.open.delete(callId);
    const tool = opened?.tool || "tool";
    const args = opened?.args || {};
    const record: Record<string, any> = {
      tool,
      tool_call_id: callId,
      args: Object.fromEntries(
        Object.entries(args).map(([key, value]) => [key, typeof value === "string" ? clipText(value, ARG_VALUE_CHARS) : value]),
      ),
      ok,
      label: labelFor(tool, args),
    };
    const snippet = snippetOf(content);
    if (snippet) record.result_snippet = clipText(snippet, RESULT_SNIPPET_CHARS);
    record.ended_at = endedAt || nowIso();
    if (opened?.started_at) {
      record.started_at = opened.started_at;
      const startMs = Date.parse(opened.started_at);
      const endMs = Date.parse(record.ended_at);
      if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) record.duration_ms = Math.max(0, endMs - startMs);
    }
    return record;
  }
}

// ── tool-name resolution ─────────────────────────────────────────────────────

// SPF's canonical lowercase vocabulary -> Claude Code's own tool names.
// "ls" has no confirmed CC built-in (bash/glob cover it) — treated the same
// way agent_flue.ts treats it: a known name that resolves to nothing, not an
// unknown one, so a roster entry mentioning it fails nothing at validate time.
const TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
};
const TOOL_ALIASES: Record<string, string> = { find: "glob" };
const DROPPED_TOOLS = new Set(["ls"]);

export function isKnownToolName(name: string): boolean {
  return DROPPED_TOOLS.has(name) || (TOOL_ALIASES[name] ?? name) in TOOL_NAME_MAP;
}

/** `null`/`undefined` = every built-in tool (CC's own `--tools default`). `[]` = none (`--tools ""`). */
function toolsFlagValue(toolNames: string[] | null | undefined): string {
  if (!toolNames) return "default";
  const resolved = toolNames.filter((n) => !DROPPED_TOOLS.has(n)).map((n) => TOOL_NAME_MAP[TOOL_ALIASES[n] ?? n]).filter(Boolean);
  return resolved.join(",");
}

// SPF's off|minimal|low|medium|high|xhigh|max -> CC's --effort low|medium|high|xhigh|max.
// CC has no "disabled reasoning" level for a headless run; off/minimal both
// round down to CC's floor rather than omitting --effort (which would fall
// through to CC's own default, "high" — the opposite of what "off" asked for).
const EFFORT_MAP: Record<ThinkingLevel, string> = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * Resolve `SPF_CLAUDE_CMD` for THIS call, substituting a literal `{model}`
 * token with `model` — see the module doc comment for why a fixed tag baked
 * into the wrapper string can't give per-agent model choice under a
 * launcher like `ollama launch`. Exported as its own pure function so this
 * substitution is unit-testable without spawning a real subprocess.
 */
export function resolveClaudeCmdSpec(model: string): string {
  return (process.env.SPF_CLAUDE_CMD || "claude").replaceAll("{model}", model);
}

// ── process lifecycle ────────────────────────────────────────────────────────

const inFlight = new Set<ChildProcessWithoutNullStreams>();

/** Kill any still-running `claude` children — call once, at process exit. Safe if none are running. */
export async function shutdown(): Promise<void> {
  for (const child of inFlight) child.kill("SIGTERM");
  inFlight.clear();
}

class CcRunError extends Error {}

/**
 * Run one `claude -p` turn against `request.session_id` (a UUID minted by
 * `agents.ts`'s `agentSessionId()` for a fresh session, or carried over from
 * `agent_map.json` for a rejoin) — `--session-id` on first contact,
 * `--resume` when `request.resume` says this session already exists. CC has
 * no single create-or-continue flag the way Flue's `init(id)` is, which is
 * exactly why `AgentRequest.resume` exists — see its doc comment in
 * `data_types.ts`.
 *
 * `onEvent` receives each parsed stream-json line UNFOLDED, exactly as
 * `agent_flue.run()` forwards raw `ConversationStreamChunk`s — folding into
 * one record per tool call is `eventForwarder`'s job (`agents.ts`), via
 * this module's `CcToolCallTracker`. Folding here too would fold twice.
 */
export async function run(
  request: AgentRequest,
  onEvent?: (message: CcStreamMessage) => void,
  onSpawn?: (pid: number) => void,
  onExit?: (pid: number) => void,
): Promise<AgentResult> {
  const args = [
    "-p",
    request.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    // `request.output_schema` is the raw Valibot schema object (which has its
    // own internal `kind`/`type`/`entries` fields) — CC's `--json-schema`
    // wants a real JSON Schema document, not that. Caught by a live run:
    // stringifying the Valibot object directly produced "unknown keyword:
    // kind" from CC's strict-mode validator.
    JSON.stringify(toJsonSchema(request.output_schema)),
    "--system-prompt",
    request.system_prompt,
    "--model",
    request.model,
    "--effort",
    EFFORT_MAP[request.thinking],
    request.resume ? "--resume" : "--session-id",
    request.session_id,
    "--permission-mode",
    "bypassPermissions",
    "--dangerously-skip-permissions",
    "--tools",
    toolsFlagValue(request.tools),
    "--strict-mcp-config", // see the module doc comment — required, not optional
  ];

  const cmdSpec = resolveClaudeCmdSpec(request.model);
  const cmdTokens = cmdSpec.split(/\s+/).filter(Boolean);
  const [cmd, ...cmdArgs] = cmdTokens;
  // See the module doc comment for why `ollama launch ...` (and ONLY that
  // shape) gets an auto-inserted `--`: cobra flag parsing otherwise consumes
  // `args`' own flags (e.g. `-p`) as `ollama launch`'s, before `claude` is
  // ever reached. Any cmdSpec that already contains a literal `--` token is
  // left completely alone — `args` is appended after it exactly as written,
  // never a second separator.
  const needsOllamaLaunchSeparator = cmdTokens[0] === "ollama" && cmdTokens[1] === "launch" && !cmdArgs.includes("--");
  const fullArgs = needsOllamaLaunchSeparator ? [...cmdArgs, "--", ...args] : [...cmdArgs, ...args];
  const child = spawn(cmd, fullArgs, { cwd: request.cwd, env: request.env ?? operatorEnv() });
  // The prompt travels as a positional argv element, not stdin — closing it
  // immediately avoids a real, observed ~3s "no stdin data received" stall
  // where `claude` otherwise waits to see whether anything is piped in.
  child.stdin.end();
  inFlight.add(child);
  const pid = child.pid ?? -1;
  onSpawn?.(pid);

  const lines = createInterface({ input: child.stdout });
  let result: CcStreamMessage | null = null;
  let lastTurnUsage: Record<string, number> | undefined;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: CcStreamMessage;
    try {
      message = JSON.parse(line);
    } catch {
      return; // a non-JSON stray line (shouldn't happen under stream-json) — not fatal
    }
    onEvent?.(message);
    if (message.type === "assistant" && message.message?.usage) lastTurnUsage = message.message.usage;
    if (message.type === "result") result = message;
  });

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on("error", reject); // spawn failure (e.g. claude not on PATH)
    child.on("close", (code) => resolve(code ?? 1));
  });
  inFlight.delete(child);
  onExit?.(pid);

  if (exitCode !== 0 && !result) {
    throw new CcRunError(`claude exited ${exitCode} before producing a result: ${stderr.slice(-2000) || "(no stderr)"}`);
  }
  if (!result) {
    throw new CcRunError(`claude produced no result message (exit ${exitCode}): ${stderr.slice(-2000) || "(no stderr)"}`);
  }
  // A plain `const` handoff — `result` above is a closure-reassigned `let`,
  // which TS's control-flow narrowing doesn't track across the `readline`
  // callback boundary, so the null-check above alone doesn't narrow it.
  const final: CcStreamMessage = result;
  if (final.is_error) {
    const detail = final.result ?? (stderr.slice(-2000) || "no detail");
    throw new CcRunError(`claude reported an error (${final.subtype ?? "unknown"}): ${detail}`);
  }

  const usage = new UsageBreakdown();
  const u = final.usage ?? {};
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const totalTokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + cacheRead + cacheWrite;
  usage.add_turn(
    {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead,
      cacheWrite,
      reasoning: u.output_tokens_details?.thinking_tokens ?? 0,
      // CC gives one total cost, not a per-component breakdown like Flue/pi-ai
      // do — folded honestly under `total`, not split up to fabricate one.
      cost: { total: final.total_cost_usd ?? 0 },
    },
    totalTokens,
  );

  const modelUsages: Record<string, { contextWindow?: number }> = final.modelUsage ?? {};
  const contextWindow = Object.values(modelUsages)[0]?.contextWindow ?? 0;
  const contextTokens = lastTurnUsage
    ? (lastTurnUsage.input_tokens ?? 0) +
      (lastTurnUsage.output_tokens ?? 0) +
      (lastTurnUsage.cache_read_input_tokens ?? 0) +
      (lastTurnUsage.cache_creation_input_tokens ?? 0)
    : 0;

  return makeAgentResult({
    session_id: final.session_id ?? request.session_id,
    text: typeof final.result === "string" ? final.result : "",
    report: final.structured_output ?? null,
    tokens: usage.total_tokens,
    cost: usage.total_cost,
    usage,
    context_tokens: contextTokens,
    context_window: contextWindow,
  });
}

/** CC requires a real UUID for `--session-id`/`--resume` — `agents.ts`'s `agentSessionId()` calls this to mint a fresh one for a claude_code agent's first contact. */
export function newSessionId(): string {
  return randomUUID();
}
