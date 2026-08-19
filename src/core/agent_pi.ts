/**
 * Pi coding agent interface — v1's only coding agent.
 *
 * Runs `pi -p --mode json` and tails its JSONL stdout line by line, forwarding
 * each event to a callback WHILE the agent works (the streaming crack, solved
 * by construction). `--session-id` creates-or-continues, so running and
 * continuing an agent are the same call: same session id = same context window.
 *
 * `run()` is async because streaming a child process's stdout while other work
 * proceeds needs it — Node/Bun have no synchronous "iterate lines as they
 * arrive" API. Everything upstream (agents.execute, run.phase, ADW mains)
 * is async for the same reason.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { PiRequest, PiResult } from "./data_types.ts";
import { makePiResult } from "./data_types.ts";
import { nowIso, operatorEnv } from "./utils.ts";

const PI_PATH = process.env.PI_PATH || "pi";
const MODELS_JSON = process.env.PI_MODELS_PATH || path.join(os.homedir(), ".pi", "agent", "models.json");

const RESULT_SNIPPET_CHARS = 20_000; // tool output rides along whole; clip only guards pathological cases
const ARG_VALUE_CHARS = 20_000; // args too — the UI scrolls, it must not be handed cut-off data
const LABEL_CHARS = 80; // "bash: <command>" shown as the event name

// The arg that identifies a call at a glance, in the order tools tend to use.
const PRIMARY_ARGS = ["command", "path", "file_path", "pattern", "query", "url"];

/** Parse pi's compact model-list counts (`272K`, `1.0M`). */
function parseCount(value: string): number {
  const suffixes: Record<string, number> = { K: 1_000, M: 1_000_000 };
  const suffix = value.slice(-1).toUpperCase();
  if (suffix in suffixes) return Math.trunc(parseFloat(value.slice(0, -1)) * suffixes[suffix]);
  return parseInt(value, 10);
}

let catalogCache: Array<[string, string, number]> | null = null;

/** Read pi's merged catalog, including built-in providers and custom models. */
function piCatalog(): Array<[string, string, number]> {
  if (catalogCache !== null) return catalogCache;
  let result;
  try {
    result = spawnSync(PI_PATH, ["--list-models"], { encoding: "utf-8", timeout: 30_000, env: operatorEnv() });
  } catch {
    catalogCache = [];
    return catalogCache;
  }
  if (result.error || result.status !== 0) {
    catalogCache = [];
    return catalogCache;
  }
  const rows: Array<[string, string, number]> = [];
  for (const line of result.stdout.split("\n").slice(1)) {
    const columns = line.split(/\s+/).filter(Boolean);
    if (columns.length < 3) continue;
    try {
      rows.push([columns[0], columns[1], parseCount(columns[2])]);
    } catch {
      continue;
    }
  }
  catalogCache = rows;
  return catalogCache;
}

/**
 * Resolve a model pattern to an explicit [provider, model_id] pair.
 *
 * Pi's catalog merges built-in models with `~/.pi/agent/models.json`. Using
 * that same merged view lets SF target direct providers such as
 * `openai/gpt-5.6-terra` without re-registering built-in models locally.
 */
export function resolveModel(pattern: string): [string, string] {
  const catalog = piCatalog().map(([provider, modelId]) => [provider, modelId] as [string, string]);
  if (pattern.includes("/")) {
    const [provider, modelId] = pattern.split("/", 2);
    if (catalog.some(([p, m]) => p === provider && m === modelId)) return [provider, modelId];
  }
  const matches = catalog.filter(([, modelId]) => pattern === modelId || modelId.includes(pattern));
  const exact = matches.filter(([, modelId]) => modelId === pattern || modelId.endsWith("/" + pattern));
  if (exact.length === 1) return exact[0];
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`model pattern ${JSON.stringify(pattern)} not found in pi --list-models — authenticate/register it or fix the config`);
  }
  throw new Error(`model pattern ${JSON.stringify(pattern)} is ambiguous: ${JSON.stringify(matches)}`);
}

/**
 * Tokens occupying the window after a turn.
 *
 * Mirrors pi's own `calculateContextTokens` (coding-agent
 * `core/compaction/compaction.ts`), which is what pi compacts against and
 * shows in its footer: prefer the provider's `totalTokens`, else sum the
 * parts. Cache reads count — cached prompt is still prompt.
 */
function contextTokensOf(usage: Record<string, any>): number {
  const total = usage.totalTokens || 0;
  if (total) return Math.trunc(total);
  return Math.trunc(["input", "output", "cacheRead", "cacheWrite"].reduce((sum, part) => sum + (usage[part] || 0), 0));
}

/** The model's context ceiling from pi's merged model catalog. */
export function contextWindow(provider: string, modelId: string): number {
  try {
    const registry = JSON.parse(readFileSync(MODELS_JSON, "utf-8"));
    for (const model of registry?.providers?.[provider]?.models || []) {
      if (model.id === modelId) return Number(model.contextWindow || 0);
    }
  } catch {
    // registry missing or unreadable — fall through to the catalog
  }
  for (const [listedProvider, listedModel, window] of piCatalog()) {
    if (listedProvider === provider && listedModel === modelId) return window;
  }
  return 0;
}

/** Join the text blocks of anything pi shapes as {content: [...]} — a message or a tool result. */
function textOf(container: Record<string, any>): string {
  return (container.content || [])
    .filter((part: any) => part && typeof part === "object" && part.type === "text")
    .map((part: any) => part.text || "")
    .join("");
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

interface OpenCall {
  tool: string;
  args: Record<string, any>;
  started_at: string;
  clock: number;
}

/**
 * Folds pi's tool stream into ONE normalized record per completed call.
 *
 * pi announces a call as a `toolCall` content block, then emits
 * tool_execution_start / _update / _end for it. Only the end carries the
 * result, so that is where a record is emitted — one trace event per real
 * tool call, the moment it returns, instead of three shapeless ones.
 *
 * The record carries the call's real span (started_at/ended_at), which the
 * tracer writes to columns so the UI can lay tool calls on a time axis
 * without parsing every payload.
 */
export class ToolCallTracker {
  private open = new Map<string, OpenCall>();

  /** Returns the record for a finished tool call, else null. */
  observe(event: Record<string, any>): Record<string, any> | null {
    const etype = event.type || "";
    if (etype === "message_end") {
      for (const block of event.message?.content || []) {
        if (block && typeof block === "object" && block.type === "toolCall") {
          this.announce(block.id, block.name, block.arguments);
        }
      }
      return null;
    }
    if (etype === "tool_execution_start") {
      this.announce(event.toolCallId, event.toolName, event.args);
      return null;
    }
    if (etype !== "tool_execution_end") return null;

    const callId = String(event.toolCallId || "");
    const opened = this.open.get(callId);
    this.open.delete(callId);
    const tool = String(event.toolName || opened?.tool || "tool");
    const args: Record<string, any> = event.args || opened?.args || {};
    const record: Record<string, any> = {
      tool,
      tool_call_id: callId,
      args: Object.fromEntries(
        Object.entries(args).map(([key, value]) => [key, typeof value === "string" ? clipText(value, ARG_VALUE_CHARS) : value]),
      ),
      ok: !event.isError,
      label: labelFor(tool, args),
    };
    const resultText = textOf(event.result || {});
    if (resultText) record.result_snippet = clipText(resultText, RESULT_SNIPPET_CHARS);
    record.ended_at = nowIso();
    if (opened?.clock) record.duration_ms = Math.round(performance.now() - opened.clock);
    if (opened?.started_at) record.started_at = opened.started_at;
    return record;
  }

  /** First sighting starts the clock; a later sighting only fills gaps. */
  private announce(callId: unknown, tool: unknown, args: unknown): void {
    if (!callId) return;
    const key = String(callId);
    const known = this.open.get(key);
    this.open.set(key, {
      tool: (tool as string) || known?.tool || "",
      args: (args as Record<string, any>) || known?.args || {},
      started_at: known?.started_at || nowIso(), // wall clock, for the row
      clock: known?.clock || performance.now(), // monotonic, for duration
    });
  }
}

/**
 * Run one non-interactive pi turn.
 *
 * `onSpawn(pid)` and `onExit(pid)` bracket the child process so the caller
 * can record it as killable — a hung coding agent is otherwise a pid you have
 * to hunt for in `ps` while the run sits there.
 */
export function run(
  request: PiRequest,
  onEvent?: (event: Record<string, any>) => void,
  onSpawn?: (pid: number) => void,
  onExit?: (pid: number) => void,
): Promise<PiResult> {
  const [provider, modelId] = resolveModel(request.model);
  const cmd = [
    "-p",
    "--mode",
    "json",
    "--provider",
    provider,
    "--model",
    modelId,
    "--thinking",
    request.thinking,
    "--session-id",
    request.session_id,
    "--session-dir",
    request.session_dir,
    "--system-prompt",
    request.system_prompt,
  ];
  if (request.tools && request.tools.length > 0) {
    cmd.push("--tools", request.tools.join(","));
  }
  for (const extension of request.extensions) {
    cmd.push("-e", extension);
  }
  cmd.push(request.prompt);

  mkdirSync(path.dirname(request.raw_output_path), { recursive: true });

  const result = makePiResult({
    session_id: request.session_id,
    context_window: contextWindow(provider, modelId),
  });

  return new Promise<PiResult>((resolve, reject) => {
    // stdin is ignored, deliberately. The prompt travels in argv, so the child
    // never needs stdin — but inheriting the parent's means pi could see a
    // non-TTY and sit forever waiting for piped input that will never arrive.
    // That failure is silent and total: no request goes out, no bytes come
    // back, and the ADW blocks with nothing to read.
    const child = spawn(PI_PATH, cmd, {
      cwd: request.cwd,
      env: operatorEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid && onSpawn) onSpawn(child.pid);

    let buffer = "";
    const stderrChunks: string[] = [];

    function handleLine(line: string): void {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: Record<string, any>;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (event.type === "message_end") {
        const message = event.message || {};
        if (message.role === "assistant") {
          const text = textOf(message);
          if (text) result.text = text; // last assistant message wins
          const usage = message.usage || {};
          const turn = contextTokensOf(usage);
          result.tokens += turn;
          result.usage.add_turn(usage, turn);
          // Occupancy is read off the last VALID assistant turn, the way pi
          // does it — an aborted or errored turn reports usage you can't
          // trust, so it must not overwrite a good reading.
          if (turn && !["aborted", "error"].includes(message.stopReason)) {
            result.context_tokens = turn;
          }
          result.cost += (usage.cost || {}).total || 0;
        }
      }
      if (onEvent) onEvent(event);
    }

    child.stdout!.setEncoding("utf-8");
    child.stdout!.on("data", (chunk: string) => {
      appendFileSync(request.raw_output_path, chunk); // events land on disk as they happen
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    });

    child.stderr!.setEncoding("utf-8");
    child.stderr!.on("data", (chunk: string) => stderrChunks.push(chunk));

    child.on("error", (error) => reject(error));

    child.on("close", (code) => {
      if (buffer.trim()) {
        appendFileSync(request.raw_output_path, buffer);
        handleLine(buffer);
      }
      if (child.pid && onExit) onExit(child.pid);
      result.returncode = code ?? 0;
      if (result.returncode !== 0 && !result.text) {
        const stderr = stderrChunks.join("");
        reject(new Error(`pi exited ${result.returncode}: ${stderr.trim().slice(-800)}`));
        return;
      }
      resolve(result);
    });
  });
}
