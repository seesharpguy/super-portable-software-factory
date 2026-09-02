/**
 * OpenCode coding agent interface — a third backend alongside `agent_flue.ts`
 * (`coding_agent: flue`) and `agent_cc.ts` (`coding_agent: claude_code`), for
 * running agents on the `opencode` CLI. Subprocess-based, for the same
 * reason `agent_cc.ts` is: shelling out costs SPF zero new dependencies, and
 * anyone using this backend needs the `opencode` CLI installed anyway.
 *
 * The `opencode` command is resolved from `PATH` by default. To route it
 * through a wrapper, proxy, or launcher, set `SPF_OPENCODE_CMD` — same
 * mechanism, same rationale, and same `{model}` token substitution as
 * `agent_cc.ts`'s `SPF_CLAUDE_CMD` (see that module's doc comment for the
 * `ollama launch`-style motivating example). Unlike `SPF_CLAUDE_CMD`, no
 * `ollama launch`-shaped wrapper is special-cased here: that fix was for a
 * specific cobra flag-parsing quirk in `claude`'s own launcher story, and
 * there is no equivalent evidence for `opencode` — inventing one would be
 * guessing at a bug that may not exist.
 *
 * This module's understanding of the real `opencode` CLI started from a docs
 * research spike, then was checked against real `opencode run --format json`
 * invocations (via `npx opencode-ai@1.18.26`, a free `opencode/*` model) —
 * a plain text reply, a bash tool call, a slow bash tool call (to look for
 * multi-line status transitions), a `--session <id>` resume, and an invalid
 * `--model` string. Every fact below is tagged:
 *
 *   [OFFICIAL]  — stated in opencode's own published docs.
 *   [VERIFIED]  — confirmed against a real `opencode run --format json`
 *                 invocation, per the spike above. One real run is
 *                 corroboration, not a version-pinned contract — still
 *                 parsed defensively.
 *   [SOURCE]    — inferred from opencode's repo/issue tracker, NOT written
 *                 down anywhere in prose, and NOT independently exercised by
 *                 the spike above (e.g. a multi-line tool_use transition
 *                 never actually appeared in any run tried). High confidence
 *                 on field NAMES, but not a contractual guarantee — parsed
 *                 defensively throughout this module for exactly that
 *                 reason.
 *
 * COMMAND SHAPE [OFFICIAL]: `opencode run [message..]` — the prompt is a
 * POSITIONAL argument, not a flag (contrast `claude -p <prompt>`, also
 * positional-ish but behind `-p`). Confirmed flags this module uses:
 * `--model`/`-m` (`provider/model` string, free-form — same vocabulary
 * shape as Flue's own `provider/model-id`, e.g. `anthropic/claude-sonnet-4-
 * 20250514`, `ollama/qwen3-coder:30b`), `--format json` (structured NDJSON
 * output — opencode's analog of `claude`'s `--output-format stream-json`),
 * `--dir` (working directory), `--session <id>` (resume a specific
 * session), `--auto` (auto-approve permissions not explicitly denied —
 * opencode's rough analog of `claude`'s `--dangerously-skip-permissions`),
 * `--variant` (provider-specific reasoning effort — opencode's analog of
 * `claude`'s `--effort`).
 *
 * NO SYSTEM-PROMPT FLAG [OFFICIAL]: opencode has nothing like `claude`'s
 * `--system-prompt`. `request.system_prompt` is prepended to the message
 * text instead (see `run()` below) — a REAL LIMITATION, not a workaround
 * that fully replicates a separate channel: from opencode's own point of
 * view, the system prompt is just the first paragraph of the user's
 * message, not a distinct role in the transcript it sees.
 *
 * NO PER-CALL TOOL-ALLOWLIST FLAG [OFFICIAL]: tool restriction is
 * CONFIG-ONLY, via a `permission` map in an `opencode.json` file (values
 * `"allow"`/`"ask"`/`"deny"` per tool name) pointed at by the `OPENCODE_CONFIG`
 * env var — see `writeTempPermissionConfig()` below. `--auto` only
 * suppresses `"ask"`; it never overrides an explicit `"deny"`.
 *
 * KNOWN LIMITATION — CONFIG PRECEDENCE: per opencode's own config-merge
 * docs, a target repo's OWN project-level `opencode.json` (if one exists)
 * merges at HIGHER precedence than the file `OPENCODE_CONFIG` points at.
 * That means a repo carrying its own `opencode.json` can silently override
 * (widen or narrow) the restriction this module writes — a real, documented
 * gap in this backend's tool-restriction guarantee, not a bug this module
 * can paper over from the outside.
 *
 * `write`/`apply_patch` ARE GATED THROUGH `edit` [OFFICIAL]: opencode's own
 * docs say these two are not independent permission keys — both ride the
 * `edit` key. This module never writes `write`/`apply_patch` keys of their
 * own for exactly that reason.
 *
 * NDJSON EVENT SHAPE [VERIFIED]: one JSON object per line,
 * `{ type, timestamp, sessionID, part, ... }`. Types this module reacts to:
 * `step_start` (carries the REAL `sessionID` — captured from the first one
 * seen and returned as `AgentResult.session_id`), `tool_use` (carries
 * `part.tool`/`part.callID`/`part.state.status`/`part.state.input`/
 * `part.state.output`/`part.state.time.{start,end}` — every observed call,
 * even a deliberately slow one, arrived as exactly ONE already-terminal
 * line, `status: "completed"`, never a separate pending/running line first),
 * `text` (carries the response text at `part.text`), `step_finish` (carries
 * `part.reason`: `"stop"` = done, `"tool-calls"` = more coming; and
 * `part.tokens.{input,output,reasoning,cache.{read,write}}` +
 * `part.cost` as a plain number — ALL VERIFIED field names/shapes), `error`
 * (carries `error.name`/`error.data.message` — verified via an invalid
 * `--model` string, which this build surfaced as `error.name:
 * "UnknownError"` with exit code 1, NOT the exit-0-on-error upstream bug
 * described below; that bug may be real for other error classes/versions,
 * so the defense against it stays).
 *
 * NDJSON EVENT SHAPE, UNVERIFIED PORTION [SOURCE]: whether `tool_use` can
 * ever arrive as MULTIPLE lines for the same call (a pending/running status
 * before the terminal one) was not observed in the spike above — every call
 * tried was a fast bash command that appeared already-`completed` on its
 * first (and only) line. `OcToolCallTracker` still defensively folds a
 * multi-line sequence if one occurs (see its own doc comment), but that path
 * is unexercised, not confirmed absent.
 *
 * SESSION IDS ARE NOT CLIENT-CHOOSABLE [OFFICIAL + VERIFIED]: opencode's
 * server assigns a ULID-based id (`ses_<26 chars>`, exact shape confirmed —
 * e.g. `ses_f9bf9448cffe9LnZCxoR5m2uyf`) on session creation. The spike
 * above also confirmed the RESUME half: capturing a `sessionID` from one
 * call and passing it back via `--session <id>` on a second, unrelated
 * `run()` genuinely continued the first call's conversation (the model
 * correctly recalled content from the first turn). So a first-contact call
 * passes NO `--session`/`--continue` at all, and the real id is captured
 * from the first `step_start` event. See
 * `pendingSessionLabel()` for the placeholder this module hands back before
 * that capture happens, and `agents.ts`'s `agentSessionId()`/`send()` for how
 * the placeholder gets replaced with the real id for the REST of a phase's
 * retries — this is the "session-id lifecycle" change described in that
 * module.
 *
 * DEVIATION FROM A LITERAL "only pass --session when request.resume" RULE:
 * within one phase, `agents.ts`'s `send()` re-assigns its local `sessionId`
 * to whatever THIS module's last call returned, but `AgentRequest.resume`
 * itself is computed once per phase and does NOT flip to `true` for a
 * same-phase JSON-repair retry or gate-correction (`agents.ts` only ever
 * threads `!isNewSession` through, unchanged, on every `send()` in a phase).
 * Passed literally, that would mean: brand-new phase, first call succeeds
 * and captures a real `ses_...` id — the very next correction in that same
 * phase would see `request.resume === false` and `request.session_id` ===
 * a REAL id, and a literal "only pass --session when resume" rule would
 * drop `--session` entirely, causing opencode to silently open a SECOND,
 * unrelated session and lose the conversation the correction is supposed to
 * continue. `run()` instead keys off whether `request.session_id` is this
 * module's OWN placeholder shape (see `isPendingSessionLabel()`): a
 * placeholder means genuinely first contact (no `--session`, let opencode
 * mint one); anything else — a same-phase corrected id OR a real id carried
 * over from `agent_map.json` on `resume: true` — gets `--session <id>`.
 * This is a deliberate judgment call flagged for review: it stays
 * functionally equivalent to "pass --session whenever there's a real id to
 * resume," which is what the source instructions' own mechanism (the
 * mid-phase `sessionId` correction) requires to actually work.
 *
 * KNOWN UPSTREAM BUGS [SOURCE, filed against opencode's own repo]: exit code
 * can be 0 even on a session error or an invalid-model error — this module
 * never trusts exit code 0 alone; it also requires either a `step_finish`
 * with `reason: "stop"` or an explicit `error` event, and treats "the
 * stream ended with neither" as a hard failure too (same spirit as
 * `agent_cc.ts`'s "no result message" check). Some invocations reportedly
 * hang indefinitely on upstream API errors with no exit code ever — this
 * module does NOT attempt a watchdog/timeout for that (out of scope, the
 * same choice `agent_cc.ts` makes: timeouts are the caller's job); it only
 * guarantees that a missing final event, once the process DOES exit, throws
 * a clear error instead of something worse.
 *
 * STDIN [OFFICIAL]: opencode reads stdin when it is not a TTY, merging it
 * with the positional message. `child.stdin.end()` runs immediately after
 * spawn — not for `agent_cc.ts`'s reason (a ~3s "waiting to see if anything
 * is piped" stall), but to avoid ANY unintended stdin-content merge into the
 * prompt, since the full prompt (system + user) already travels as the
 * positional `message` argument.
 *
 * AUTH [OFFICIAL]: `~/.local/share/opencode/auth.json` is the credential
 * store; `opencode auth list` is the documented non-interactive
 * is-it-configured check. This module does not drive `opencode auth login`
 * — see `cli/commands/doctor.ts`'s opencode checks, which treat auth the
 * same way `claude login` is treated for `claude_code`: already the
 * operator's job, informational only.
 *
 * KNOWN RISK — SINGLE-ARGV PROMPT SIZE: `system_prompt` + `prompt` travel as
 * ONE positional argv element (see `run()`'s `message`), unlike
 * `agent_cc.ts`'s two separate flags plus a separate `--json-schema` blob.
 * On Linux, `execve` enforces a ~128KB ceiling PER ARGUMENT
 * (`MAX_ARG_STRLEN`), independent of the much larger total `ARG_MAX` — a
 * large combined system+user prompt (e.g. a big `previous_envelope` JSON
 * blob folded into the user prompt, see `agents.ts`) could approach that
 * ceiling and fail with a bare `E2BIG` via `child.on("error")`, for a
 * prompt pair that would run fine under `claude_code`. STDIN is
 * deliberately closed above, foreclosing the natural workaround (opencode
 * DOES read and merge non-TTY stdin). Not fixed here: no measurement of
 * real envelope sizes against this ceiling has been done, and the fix
 * (piping the prompt some other way) needs opencode-side confirmation of
 * what it actually supports — disclosed as a real, unverified risk rather
 * than guessed at.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

/** `state.output` is expected to be a string in the common case; defensive for anything JSON-serializable. */
function snippetOf(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/** Epoch milliseconds (the confirmed shape of `part.state.time.{start,end}` — verified against a real run, see the module doc comment) -> ISO string. Falls back to `nowIso()` for anything that doesn't look like one. */
function isoFromEpochMs(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  return nowIso();
}

interface OpenCall {
  tool: string;
  args: Record<string, any>;
  started_at: string;
}

/** One line of `opencode run --format json` output, loosely typed — see the module doc comment for what's actually verified vs. inferred. */
export type OcStreamMessage = Record<string, any>;

/**
 * Folds `tool_use` events into the SAME record shape `agent_flue`'s
 * `ToolCallTracker` and `agent_cc`'s `CcToolCallTracker` produce, so
 * `agents.ts`'s `eventForwarder` needs no backend-specific branching beyond
 * picking which tracker class to instantiate.
 *
 * Unlike CC's assistant/tool_use + user/tool_result PAIR (two distinct
 * messages, linked by `tool_use_id`), opencode's NDJSON carries ONE
 * `tool_use` event per call [VERIFIED for the common case: every call
 * observed in the module's spike, including a deliberately slow one,
 * arrived as a single already-`"completed"` line]. Whether `part.state.status`
 * can ALSO transition across multiple lines for one call (e.g. `pending` ->
 * `running` -> `completed`/`error`) before that terminal line remains
 * [SOURCE]-only — not observed, not confirmed absent — so this folds on
 * "looks terminal" rather than a hardcoded status enum, in case it does:
 * `state.output` being present is treated as the authoritative terminal
 * signal (an explicit `"error"`/`"completed"`/`"done"` status also counts).
 */
export class OcToolCallTracker {
  private open = new Map<string, OpenCall>();
  // Ids already folded into a returned record. The "looks terminal"
  // heuristic (state.output present, OR an explicit terminal status) is
  // deliberately loose since the real status vocabulary is unverified — a
  // "running" line that already streams partial output would otherwise be
  // treated as terminal, get deleted from `open`, and a LATER "completed"
  // line for the SAME id would then look like a brand-new call (no entry in
  // `open`) and fold into a second, duplicate tool_call record. This set is
  // the guard against that: once an id has been emitted, every further line
  // for it is dropped, not re-opened.
  private closed = new Set<string>();

  observe(message: OcStreamMessage): Record<string, any> | null {
    if (message?.type !== "tool_use") return null;
    const part = message.part ?? {};
    const state = part.state ?? {};
    const id: string = part.id ?? part.callID ?? part.toolCallId ?? `${part.tool ?? "tool"}-${message.timestamp ?? nowIso()}`;
    const tool = part.tool ?? "tool";

    if (this.closed.has(id)) return null;

    const existing = this.open.get(id);
    if (!existing) {
      this.open.set(id, {
        tool,
        args: state.input ?? {},
        started_at: state.time?.start !== undefined ? isoFromEpochMs(state.time.start) : message.timestamp || nowIso(),
      });
    } else if (state.input && Object.keys(state.input).length > 0) {
      // A later line for the same call may be the first to carry the full
      // input (e.g. a "running" transition after a bare "pending") — keep
      // the freshest.
      existing.args = state.input;
    }

    const status = state.status;
    const isTerminal = state.output !== undefined || status === "completed" || status === "error" || status === "done";
    if (!isTerminal) return null;

    const opened = this.open.get(id);
    this.open.delete(id);
    this.closed.add(id);
    const finalArgs = opened?.args ?? state.input ?? {};
    const record: Record<string, any> = {
      tool,
      tool_call_id: id,
      args: Object.fromEntries(
        Object.entries(finalArgs).map(([key, value]) => [key, typeof value === "string" ? clipText(value, ARG_VALUE_CHARS) : value]),
      ),
      ok: status !== "error",
      label: labelFor(tool, finalArgs),
    };
    const snippet = snippetOf(state.output);
    if (snippet) record.result_snippet = clipText(snippet, RESULT_SNIPPET_CHARS);
    record.ended_at = state.time?.end !== undefined ? isoFromEpochMs(state.time.end) : message.timestamp || nowIso();
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

// SPF's canonical lowercase vocabulary -> opencode's `permission` config
// keys. SPF's canonical vocabulary is whatever agent_cc.ts's own
// TOOL_NAME_MAP recognizes (read/write/edit/bash/grep/glob/webfetch) — this
// module mirrors that set, not a narrower one, so a roster agent using
// "webfetch" (e.g. the packaged roster's scout/refiner) validates the same
// way under every backend. "write" and "edit" both resolve to opencode's own
// "edit" key — per opencode's docs, "write"/"apply_patch" are gated THROUGH
// "edit", not independent keys (see the module doc comment). "ls" has no
// opencode built-in either (same as agent_cc.ts's own "ls" note) — dropped,
// not unknown, so a roster entry naming it fails nothing at validate time.
const TOOL_NAME_MAP: Record<string, string> = {
  read: "read",
  write: "edit",
  edit: "edit",
  bash: "bash",
  grep: "grep",
  glob: "glob",
  webfetch: "webfetch",
};
const TOOL_ALIASES: Record<string, string> = { find: "glob" };
const DROPPED_TOOLS = new Set(["ls"]);

export function isKnownToolName(name: string): boolean {
  return DROPPED_TOOLS.has(name) || (TOOL_ALIASES[name] ?? name) in TOOL_NAME_MAP;
}

// Every permission key opencode itself recognizes [OFFICIAL] that this
// module can decide either way — "write"/"apply_patch" deliberately absent,
// since they ride "edit" (see above). None of "lsp"/"todowrite"/"websearch"/
// "question" has an spf-level tool name that maps to it, so a `tools:` list
// that restricts anything always denies these four — there is no spf
// vocabulary to request them with.
const OPENCODE_PERMISSION_KEYS = ["bash", "edit", "read", "grep", "glob", "lsp", "todowrite", "webfetch", "websearch", "question"] as const;

/** Builds the `permission` map for a temporary `opencode.json` — see `writeTempPermissionConfig`. */
function permissionMapFor(toolNames: string[]): Record<string, "allow" | "deny"> {
  const allowed = new Set(
    toolNames
      .filter((n) => !DROPPED_TOOLS.has(n))
      .map((n) => TOOL_NAME_MAP[TOOL_ALIASES[n] ?? n])
      .filter((v): v is string => Boolean(v)),
  );
  const permission: Record<string, "allow" | "deny"> = {};
  for (const key of OPENCODE_PERMISSION_KEYS) permission[key] = allowed.has(key) ? "allow" : "deny";
  return permission;
}

/**
 * `request.tools` is `null`/`undefined` -> no config file at all, `--auto`
 * alone (every tool usable, mirroring CC's `"default"`). An array (including
 * `[]`) -> a real temp `opencode.json` restricting to exactly what was
 * asked for. Caller is responsible for `rmSync`-ing `dir` when done — see
 * `run()`'s `finally`.
 */
function writeTempPermissionConfig(toolNames: string[]): { dir: string; configPath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "spf-opencode-"));
  const configPath = path.join(dir, "opencode.json");
  writeFileSync(configPath, JSON.stringify({ permission: permissionMapFor(toolNames) }, null, 2));
  return { dir, configPath };
}

// SPF's off|minimal|low|medium|high|xhigh|max -> opencode's --variant.
// opencode's docs confirm high/max/minimal as EXAMPLES, not an exhaustive
// enum [SOURCE for the full mapping below] — best-effort, documented as
// such rather than treated as verified.
const VARIANT_MAP: Record<ThinkingLevel, string> = {
  off: "minimal",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
  max: "max",
};

/**
 * Resolve `SPF_OPENCODE_CMD` for THIS call, substituting a literal `{model}`
 * token with `model` — same mechanism and rationale as `agent_cc.ts`'s
 * `resolveClaudeCmdSpec`. Exported as its own pure function for the same
 * reason: unit-testable without spawning a real subprocess.
 */
export function resolveOpencodeCmdSpec(model: string): string {
  return (process.env.SPF_OPENCODE_CMD || "opencode").replaceAll("{model}", model);
}

// ── session ids ──────────────────────────────────────────────────────────────

const PENDING_SESSION_PREFIX = "oc-pending-";

/**
 * NOT a real session id, and NOT interchangeable with `agent_cc.ts`'s
 * `newSessionId()` — opencode's server assigns its own `ses_<ULID>` id on
 * first contact; nothing this module mints is ever valid to pass to
 * `--session`. This exists purely as a COSMETIC placeholder for
 * `agents.ts`'s pre-call logging (the `agent_start` trace event, the
 * console line) before the real id is captured from the first response —
 * see `run()`'s session-id handling and this module's doc comment for the
 * full lifecycle.
 */
export function pendingSessionLabel(): string {
  return `${PENDING_SESSION_PREFIX}${randomUUID().slice(0, 8)}`;
}

function isPendingSessionLabel(sessionId: string): boolean {
  return sessionId.startsWith(PENDING_SESSION_PREFIX);
}

/**
 * The `--session` decision — see the module doc comment's "DEVIATION FROM A
 * LITERAL only-pass-when-resume RULE" note for why this keys off the id's
 * SHAPE (a placeholder means genuinely first contact) rather than
 * `request.resume`. Extracted as its own pure function specifically so this
 * judgment call is unit-testable without spawning a real subprocess.
 */
export function sessionArgs(sessionId: string): string[] {
  return isPendingSessionLabel(sessionId) ? [] : ["--session", sessionId];
}

// ── process lifecycle ────────────────────────────────────────────────────────

const inFlight = new Set<ChildProcessWithoutNullStreams>();

/** Kill any still-running `opencode` children — call once, at process exit. Safe if none are running. */
export async function shutdown(): Promise<void> {
  for (const child of inFlight) child.kill("SIGTERM");
  inFlight.clear();
}

class OcRunError extends Error {}

/**
 * Run one `opencode run` turn. See the module doc comment for the full
 * session-id lifecycle, the system-prompt-via-prepend limitation, and the
 * tool-restriction-via-temp-config mechanism.
 *
 * `onEvent` receives each parsed NDJSON line UNFOLDED, exactly as
 * `agent_cc.run()`/`agent_flue.run()` forward their own raw events — folding
 * into one record per tool call is `eventForwarder`'s job (`agents.ts`), via
 * this module's `OcToolCallTracker`.
 */
export async function run(
  request: AgentRequest,
  onEvent?: (message: OcStreamMessage) => void,
  onSpawn?: (pid: number) => void,
  onExit?: (pid: number) => void,
): Promise<AgentResult> {
  // No distinct system-prompt channel (see the module doc comment) — folded
  // into the one positional message opencode actually sees.
  const message = `${request.system_prompt}\n\n---\n\n${request.prompt}`;

  const args = [
    "run",
    message,
    "--format",
    "json",
    "--auto",
    "--model",
    request.model,
    "--dir",
    request.cwd,
    "--variant",
    VARIANT_MAP[request.thinking],
    ...sessionArgs(request.session_id),
  ];

  const cmdSpec = resolveOpencodeCmdSpec(request.model);
  const cmdTokens = cmdSpec.split(/\s+/).filter(Boolean);
  const [cmd, ...cmdArgs] = cmdTokens;
  const fullArgs = [...cmdArgs, ...args];

  const baseEnv = request.env ?? operatorEnv();
  // `request.tools` null/undefined -> every tool, no config file written at
  // all (see writeTempPermissionConfig's own doc comment). An array
  // (including []) -> a real temp opencode.json, pointed at via
  // OPENCODE_CONFIG on the CHILD's env only — never mutates process.env.
  const tempConfig = request.tools != null ? writeTempPermissionConfig(request.tools) : null;
  const childEnv = tempConfig ? { ...baseEnv, OPENCODE_CONFIG: tempConfig.configPath } : baseEnv;

  try {
    const child = spawn(cmd, fullArgs, { cwd: request.cwd, env: childEnv });
    // See the module doc comment's STDIN note — closed immediately to avoid
    // any unintended merge with the positional message.
    child.stdin.end();
    inFlight.add(child);
    const pid = child.pid ?? -1;
    onSpawn?.(pid);

    const lines = createInterface({ input: child.stdout });
    let capturedSessionId: string | null = null;
    let text = "";
    let sawStop = false;
    let sawError = false;
    let errorDetail = "";
    let lastFinishPart: Record<string, any> | null = null;
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    lines.on("line", (line) => {
      if (!line.trim()) return;
      let msg: OcStreamMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // a non-JSON stray line — not fatal, skip it
      }
      onEvent?.(msg);

      if (!capturedSessionId && typeof msg.sessionID === "string" && msg.sessionID) {
        capturedSessionId = msg.sessionID;
      }
      if (msg.type === "text") {
        // part.text [VERIFIED] — see the module doc comment. The `msg.text`
        // fallback is defensive belt-and-braces, not a second observed shape.
        const chunk = msg.part?.text ?? msg.text;
        if (typeof chunk === "string") text += chunk;
      } else if (msg.type === "step_finish") {
        const finishPart: Record<string, any> = msg.part ?? {};
        lastFinishPart = finishPart;
        if (finishPart.reason === "stop") sawStop = true;
      } else if (msg.type === "error") {
        sawError = true;
        errorDetail = msg.error?.data?.message || msg.error?.name || "unknown error";
      }
    });

    const exitCode: number = await new Promise((resolve, reject) => {
      child.on("error", reject); // spawn failure (e.g. opencode not on PATH)
      child.on("close", (code) => resolve(code ?? 1));
    });
    inFlight.delete(child);
    onExit?.(pid);

    // Known upstream bug [SOURCE, not reproduced] — an invalid-model run in
    // the module's spike surfaced as an `error` event with exit code 1 (the
    // well-behaved case), not exit 0. The upstream reports of exit-0-on-error
    // may still be real for other error classes/versions, so this module
    // still never trusts exit code 0 alone; an explicit error event or a
    // missing final "stop" is the real signal. See the module doc comment.
    if (exitCode !== 0 && !sawStop && !sawError) {
      throw new OcRunError(`opencode exited ${exitCode} before producing a result: ${stderr.slice(-2000) || "(no stderr)"}`);
    }
    if (sawError) {
      throw new OcRunError(`opencode reported an error (${errorDetail}): ${stderr.slice(-2000) || "no detail"}`);
    }
    if (!sawStop) {
      throw new OcRunError(`opencode produced no final result — no step_finish(reason="stop") and no error event (exit ${exitCode}): ${stderr.slice(-2000) || "(no stderr)"}`);
    }
    // A successful run with no captured session id would mean the
    // (verified, but not version-pinned) `sessionID` field assumption in
    // this module's NDJSON parsing stopped holding for whatever opencode
    // build is actually installed. Fail loud here rather than letting
    // `pendingSessionLabel()`'s placeholder leak into `AgentResult.session_id`
    // — agents.ts would otherwise silently persist it to agent_map.json, and
    // every later send() in this phase (and every later phase, via rejoin)
    // would permanently lose session continuity with no diagnostic at all.
    if (!capturedSessionId) {
      throw new OcRunError(
        "opencode reported success but no sessionID was seen on any NDJSON event — this module's assumption about the session-id field name may be wrong for the installed opencode version; refusing to silently continue with a placeholder session id",
      );
    }

    const usage = new UsageBreakdown();
    // Token/cost field shapes [VERIFIED] — see the module doc comment. Still
    // parsed defensively (absent fields fall back to 0 rather than throwing)
    // since a real cost/pricing provider's response wasn't exercised (the
    // spike's free `opencode/*` models always returned `cost: 0`).
    const finish: Record<string, any> = lastFinishPart ?? {};
    const tokens = finish.tokens ?? finish.usage ?? {};
    const cache = tokens.cache ?? {};
    const inputTokens = tokens.input ?? tokens.input_tokens ?? 0;
    const outputTokens = tokens.output ?? tokens.output_tokens ?? 0;
    const cacheRead = cache.read ?? tokens.cache_read ?? 0;
    const cacheWrite = cache.write ?? tokens.cache_write ?? 0;
    const reasoningTokens = tokens.reasoning ?? tokens.reasoning_tokens ?? 0;
    const totalTokens = inputTokens + outputTokens + cacheRead + cacheWrite;
    const cost = typeof finish.cost === "number" ? finish.cost : (finish.cost?.total ?? 0);
    usage.add_turn({ input: inputTokens, output: outputTokens, cacheRead, cacheWrite, reasoning: reasoningTokens, cost: { total: cost } }, totalTokens);

    return makeAgentResult({
      session_id: capturedSessionId ?? request.session_id,
      text,
      // No structured-output equivalent on this backend (see the module doc
      // comment) — the caller (agents.ts) falls back to extracting JSON from
      // `text`, same as agent_cc.ts's own `report: null` fallback path.
      report: null,
      tokens: usage.total_tokens,
      cost: usage.total_cost,
      usage,
      context_tokens: 0,
      context_window: 0,
    });
  } finally {
    if (tempConfig) rmSync(tempConfig.dir, { recursive: true, force: true });
  }
}
