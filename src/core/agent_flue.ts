/**
 * Flue coding agent interface — replaces agent_pi.ts.
 *
 * One generic Flue agent function (`SfAgent`), driven entirely by YAML: a
 * module-level registry maps a Flue conversation id (== SPF's session id) to
 * the model/thinking/sandbox/tools/instruction that call should use, set by
 * `run()` just before dispatching. SPF's roster stays data; Flue never learns
 * there are five different "kinds" of agent.
 *
 * Structured output has no Flue-native "constrain this agent's final
 * result" mechanism (that exists only for a nested `harness.prompt()` call
 * inside a tool) — so every call gets one injected tool, `sf_report`, whose
 * `input` schema IS the envelope's Valibot schema. Flue validates the
 * model's arguments against it before `run()` fires, and `run()` returns
 * `{terminate: true}` — the same loop-ending contract Flue's own built-in
 * `finish`/`give_up` tools use — so a report ends the turn structurally,
 * not just by instruction. The captured data rides back via
 * `useDataWriter`, which is what `AgentReply.data` surfaces to the caller.
 * `agents.ts`'s existing JSON-extraction fallback stays as a safety net for
 * a model that never calls the tool at all.
 *
 * `run()`'s signature deliberately mirrors the old agent_pi.ts `run()` so
 * agents.ts's `send()` closure changes only its imports and field names.
 */

import {
  AgentRunError,
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  init,
  observe,
  useDataWriter,
  useModel,
  useSandbox,
  useTool,
  type Agent,
  type AgentFunction,
  type AgentProps,
  type AgentStatics,
  type ConversationStreamChunk,
  type Sandbox,
  type SandboxFactory,
} from "@flue/runtime";
import { local, sqlite, start, type Flue } from "@flue/runtime/node";
import type { AgentRequest, AgentResult, ThinkingLevel } from "./data_types.ts";
import { UsageBreakdown, makeAgentResult } from "./data_types.ts";
import { nowIso, operatorEnv } from "./utils.ts";

const RESULT_SNIPPET_CHARS = 20_000; // tool output rides along whole; clip only guards pathological cases
const ARG_VALUE_CHARS = 20_000; // args too — the UI scrolls, it must not be handed cut-off data
const LABEL_CHARS = 80; // "bash: <command>" shown as the event name

// The arg that identifies a call at a glance, in the order tools tend to use.
// Unverified against Flue's own built-in tool argument names beyond what
// their published schemas show (path/command/pattern) — kept from pi's list
// since the overlap is exact where it matters; a mismatch here only means a
// less specific label, never a wrong one.
const PRIMARY_ARGS = ["command", "path", "file_path", "pattern", "query", "url"];

function hasMessage(value: unknown): value is { message: string } {
  return typeof value === "object" && value !== null && typeof (value as { message?: unknown }).message === "string";
}

function clipText(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit).trimEnd() + "…";
}

/** One-line human name for a tool call: `bash: ls -la src`. */
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

/** `tool-output`'s `output` is typed `unknown` — normalize whatever shape it turns out to be. */
function snippetOf(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

interface OpenCall {
  tool: string;
  args: Record<string, any>;
  started_at: string;
}

/**
 * Folds Flue's `tool-input` + `tool-output`/`tool-output-error` chunk pair
 * into ONE normalized record per completed call — the same shape
 * agent_pi.ts's tracker produced, so agents.ts's eventForwarder (and the
 * tracer/visualizer downstream of it) need no changes. `tool-output` never
 * carries the tool's name, which is exactly why folding is still required.
 */
export class ToolCallTracker {
  private open = new Map<string, OpenCall>();

  /** Returns the record for a finished tool call, else null. */
  observe(chunk: ConversationStreamChunk): Record<string, any> | null {
    if (chunk.type === "tool-input") {
      this.open.set(chunk.toolCallId, {
        tool: chunk.toolName,
        args: (chunk.input as Record<string, any>) || {},
        started_at: chunk.timestamp || nowIso(),
      });
      return null;
    }
    if (chunk.type === "tool-output") {
      return this.finish(chunk.toolCallId, chunk.output, true, chunk.durationMs);
    }
    if (chunk.type === "tool-output-error") {
      return this.finish(chunk.toolCallId, chunk.errorText, false, chunk.durationMs);
    }
    return null;
  }

  private finish(callId: string, output: unknown, ok: boolean, durationMs: number | undefined): Record<string, any> {
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
    const snippet = snippetOf(output);
    if (snippet) record.result_snippet = clipText(snippet, RESULT_SNIPPET_CHARS);
    record.ended_at = nowIso();
    if (durationMs !== undefined) record.duration_ms = Math.round(durationMs);
    if (opened?.started_at) record.started_at = opened.started_at;
    return record;
  }
}

// ── tool-name resolution ─────────────────────────────────────────────────────

const BUILTIN_TOOLS: Record<string, (env: Sandbox) => unknown> = {
  read: createReadTool,
  write: createWriteTool,
  edit: createEditTool,
  bash: createBashTool,
  grep: createGrepTool,
  glob: createGlobTool,
};
// pi's vocabulary -> Flue's. "ls" has no Flue built-in (bash/glob cover it);
// it is a KNOWN name that resolves to nothing, not an unknown one.
const TOOL_ALIASES: Record<string, string> = { find: "glob" };
const DROPPED_TOOLS = new Set(["ls"]);

/** Used by agents.validate() so a typo'd tool name fails before anything spawns. */
export function isKnownToolName(name: string): boolean {
  return DROPPED_TOOLS.has(name) || (TOOL_ALIASES[name] ?? name) in BUILTIN_TOOLS;
}

function resolveBuiltinTools(names: string[]): Array<(env: Sandbox) => unknown> {
  const factories: Array<(env: Sandbox) => unknown> = [];
  for (const name of names) {
    if (DROPPED_TOOLS.has(name)) continue;
    const factory = BUILTIN_TOOLS[TOOL_ALIASES[name] ?? name];
    if (factory) factories.push(factory);
  }
  return factories;
}

/**
 * `undefined`/`null` toolNames = every builtin (Flue's own default when no
 * `tools` override is given — matches SPF's "unset = all tools usable").
 * `local()`'s env does NOT inherit process.env by default (only PATH/HOME/
 * USER/LANG/TERM/TMPDIR) — operatorEnv() restores today's actual behavior.
 */
function sandboxFor(toolNames: string[] | null | undefined, cwd: string): SandboxFactory {
  const base = local({ cwd, env: operatorEnv() });
  if (!toolNames) return base;
  const factories = resolveBuiltinTools(toolNames);
  return { ...base, tools: (env) => factories.map((f) => f(env)) as any };
}

// ── model pattern validation ─────────────────────────────────────────────────

/**
 * Flue exposes no public catalog of registered models (only pi's --list-models
 * CLI did, and that command is gone with pi). This checks only the STATIC
 * `provider/model-id` shape — the same shape SPF's config docs already ask
 * for — not that the provider is reachable or the id exists. An actually
 * wrong model now surfaces at the first real dispatch instead of at
 * validate() time; that trade is made explicit here rather than pretending
 * a catalog check still happens.
 */
export function resolveModel(pattern: string): [string, string] {
  const slash = pattern.indexOf("/");
  if (slash <= 0 || slash === pattern.length - 1) {
    throw new Error(`model ${JSON.stringify(pattern)} must be written as provider/model-id`);
  }
  return [pattern.slice(0, slash), pattern.slice(slash + 1)];
}

// ── the one generic agent ────────────────────────────────────────────────────

interface RenderSpec {
  model: string;
  thinking: ThinkingLevel;
  cwd: string;
  toolNames: string[] | null | undefined;
  systemText: string;
  outputSchema: AgentRequest["output_schema"];
  outputTypeName: string;
}

const REGISTRY = new Map<string, RenderSpec>();

function sfAgentRender({ id }: AgentProps): string {
  const spec = REGISTRY.get(id);
  if (!spec) throw new Error(`agent_flue: no render spec registered for conversation ${id} — run() must set it before dispatching`);

  useModel(spec.model, { thinkingLevel: spec.thinking });
  useSandbox(sandboxFor(spec.toolNames, spec.cwd));

  const writeReport = useDataWriter("sf_report");
  useTool({
    name: "sf_report",
    description: `Emit your final ${spec.outputTypeName} report as your last action. Call this exactly once — it ends your turn.`,
    input: spec.outputSchema,
    run: ({ data }) => {
      writeReport(data);
      return { terminate: true };
    },
  });

  return spec.systemText;
}

const SfAgent: Agent = Object.assign(sfAgentRender as AgentFunction<AgentProps>, {
  agentName: "spf-agent",
} satisfies AgentStatics);

// ── runtime lifecycle ────────────────────────────────────────────────────────

interface UsageSlot {
  usage: UsageBreakdown;
  context_tokens: number;
}

const pendingUsage = new Map<string, UsageSlot>();
let runtimePromise: Promise<Flue> | null = null;

function ensureRuntime(flueDbPath: string): Promise<Flue> {
  if (!runtimePromise) {
    runtimePromise = start({ agents: [SfAgent], db: sqlite(flueDbPath) }).then((flue) => {
      observe((event) => {
        if (event.type !== "turn" || !event.submissionId) return;
        const slot = pendingUsage.get(event.submissionId);
        if (!slot) return; // not one of ours (or already collected) — ignore
        const usage = event.response.usage;
        if (!usage) return;
        const turnTokens = contextTokensOf(usage);
        slot.usage.add_turn(usage, turnTokens);
        // Occupancy is read off the last valid AGENT-purpose turn: compaction
        // turns cost real money (folded into usage above) but say nothing
        // about the agent's own conversation occupancy, and an errored turn's
        // reading can't be trusted either way.
        if (event.purpose === "agent" && turnTokens && !event.isError) {
          slot.context_tokens = turnTokens;
        }
      });
      return flue;
    });
  }
  return runtimePromise;
}

/** Graceful shutdown — call once, at process exit. Safe to call if never started. */
export async function shutdown(): Promise<void> {
  if (!runtimePromise) return;
  const flue = await runtimePromise;
  await flue.stop();
  runtimePromise = null;
}

/**
 * Mirrors pi's own `calculateContextTokens`: prefer the provider's
 * totalTokens, else sum the parts. Cache reads count — cached prompt is
 * still prompt. Verbatim from agent_pi.ts (Flue's PromptUsage shape matches
 * pi-ai's field names one-for-one).
 */
function contextTokensOf(usage: { totalTokens: number; input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  if (usage.totalTokens) return Math.trunc(usage.totalTokens);
  return Math.trunc(usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
}

/**
 * Run one Flue dispatch+read turn against the given conversation id,
 * creating it on first contact and continuing it on every later call with
 * the same `session_id` — the same continuity `pi --session-id` gave.
 *
 * `onSpawn`/`onExit` bracket this call the way they bracketed pi's child
 * process, but there is no child process here: Flue runs in-process, so
 * both fire with this process's own pid. A future `spf abort` can still find
 * and stop the right OS process; distinguishing WHICH in-flight submission
 * that pid is running is a `processes.submission_id` column left for later,
 * not attempted here.
 */
export async function run(
  request: AgentRequest,
  onEvent?: (chunk: ConversationStreamChunk) => void,
  onSpawn?: (pid: number) => void,
  onExit?: (pid: number) => void,
): Promise<AgentResult> {
  await ensureRuntime(request.flue_db_path);

  REGISTRY.set(request.session_id, {
    model: request.model,
    thinking: request.thinking,
    cwd: request.cwd,
    toolNames: request.tools,
    systemText: request.system_prompt,
    outputSchema: request.output_schema,
    outputTypeName: request.output_type_name,
  });

  const pid = process.pid ?? -1;
  onSpawn?.(pid);

  const handle = init(SfAgent, { id: request.session_id });
  const receipt = await handle.dispatch(request.prompt);
  const slot: UsageSlot = { usage: new UsageBreakdown(), context_tokens: 0 };
  pendingUsage.set(receipt.submissionId, slot);

  try {
    // Raw chunks pass straight through, exactly as agent_pi.ts's onEvent
    // carried pi's raw JSONL events — the folding into one record per tool
    // call is eventForwarder's job (agents.ts), via this module's own
    // ToolCallTracker. Folding here too would fold twice.
    const reply = await handle.read(receipt, { onEvent });
    const reportEntries = reply.data["sf_report"];
    const report = reportEntries && reportEntries.length > 0 ? reportEntries[reportEntries.length - 1] : null;
    return makeAgentResult({
      session_id: request.session_id,
      text: reply.text,
      report,
      tokens: slot.usage.total_tokens,
      cost: slot.usage.total_cost,
      usage: slot.usage,
      context_tokens: slot.context_tokens,
      context_window: 0,
    });
  } catch (error) {
    if (error instanceof AgentRunError) {
      // Verified by reproduction: a settled failure's `cause` is a plain
      // durably-recorded error record — {name, message, type, details} —
      // NOT a live Error instance (a durable settlement is read back from
      // storage, not rethrown from the original throw site). Duck-type the
      // message rather than checking `instanceof Error`, or every failure
      // prints the unhelpful "[object Object]".
      const cause = (error as unknown as { cause?: unknown }).cause;
      const detail = hasMessage(cause) ? cause.message : cause instanceof Error ? cause.message : cause ? JSON.stringify(cause) : error.message;
      throw new Error(`flue submission ${error.outcome}: ${detail}`);
    }
    throw error;
  } finally {
    pendingUsage.delete(receipt.submissionId);
    onExit?.(pid);
  }
}
