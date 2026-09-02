import { test } from "node:test";
import assert from "node:assert/strict";
import { isKnownToolName, OcToolCallTracker, resolveOpencodeCmdSpec, pendingSessionLabel, sessionArgs } from "../core/agent_opencode.js";

/** Saves/restores SPF_OPENCODE_CMD around a test — process.env is real global state. Mirrors agent_cc.test.ts's withClaudeCmd. */
function withOpencodeCmd(value: string | undefined, fn: () => void): void {
  const original = process.env.SPF_OPENCODE_CMD;
  if (value === undefined) delete process.env.SPF_OPENCODE_CMD;
  else process.env.SPF_OPENCODE_CMD = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env.SPF_OPENCODE_CMD;
    else process.env.SPF_OPENCODE_CMD = original;
  }
}

// ── resolveOpencodeCmdSpec ───────────────────────────────────────────────────

test("resolveOpencodeCmdSpec: SPF_OPENCODE_CMD unset -> plain opencode", () => {
  withOpencodeCmd(undefined, () => {
    assert.equal(resolveOpencodeCmdSpec("anthropic/claude-sonnet-4-6"), "opencode");
  });
});

test("resolveOpencodeCmdSpec: {model} substitutes with this call's own model", () => {
  withOpencodeCmd("ollama launch opencode --model {model}", () => {
    assert.equal(resolveOpencodeCmdSpec("qwen3-coder:cloud"), "ollama launch opencode --model qwen3-coder:cloud");
  });
});

test("resolveOpencodeCmdSpec: no {model} token in SPF_OPENCODE_CMD -> unchanged, model is simply unused", () => {
  withOpencodeCmd("opencode-wrapper --profile default", () => {
    assert.equal(resolveOpencodeCmdSpec("anthropic/claude-sonnet-4-6"), "opencode-wrapper --profile default");
  });
});

// ── sessionArgs ──────────────────────────────────────────────────────────────
// The headline "DEVIATION" judgment call from the module doc comment: keys
// off the id's SHAPE (a placeholder means genuinely first contact), not
// `request.resume` — see run()'s comment for why.

test("sessionArgs: a pendingSessionLabel() placeholder -> no --session flag (let opencode mint one)", () => {
  assert.deepEqual(sessionArgs(pendingSessionLabel()), []);
});

test("sessionArgs: a real opencode-shaped session id -> --session <id>", () => {
  assert.deepEqual(sessionArgs("ses_3cf7dd8d4ffeUPfENpVxfFojZ2"), ["--session", "ses_3cf7dd8d4ffeUPfENpVxfFojZ2"]);
});

test("sessionArgs: a same-phase-corrected id (not this module's own placeholder shape) still gets --session", () => {
  // Exactly the case the DEVIATION note describes: agents.ts's sessionId was
  // reassigned mid-phase from a prior send()'s real captured id.
  assert.deepEqual(sessionArgs("ses_anyRealLookingId"), ["--session", "ses_anyRealLookingId"]);
});

// ── isKnownToolName ───────────────────────────────────────────────────────────

test("isKnownToolName: SPF's lowercase vocabulary maps onto opencode's own permission keys, ls is known-but-dropped, find aliases to glob, unknown names are false", () => {
  for (const name of ["read", "write", "edit", "bash", "grep", "glob", "webfetch"]) {
    assert.equal(isKnownToolName(name), true, name);
  }
  assert.equal(isKnownToolName("find"), true, "find aliases to glob");
  assert.equal(isKnownToolName("ls"), true, "ls is a known name, just dropped");
  assert.equal(isKnownToolName("foo"), false);
});

// ── pendingSessionLabel ──────────────────────────────────────────────────────

test("pendingSessionLabel: returns a placeholder string starting with oc-pending-, different across calls", () => {
  const a = pendingSessionLabel();
  const b = pendingSessionLabel();
  assert.ok(a.startsWith("oc-pending-"), a);
  assert.ok(b.startsWith("oc-pending-"), b);
  assert.notEqual(a, b, "not a strict global-uniqueness proof, just a randomness sanity check");
});

// ── OcToolCallTracker ─────────────────────────────────────────────────────────
//
// Synthetic-but-internally-consistent fixtures matching the shape
// OcToolCallTracker.observe() actually reads (see agent_opencode.ts): one
// `tool_use` event per call, `part.id`/`.callID`/`.toolCallId`, `part.tool`,
// `part.state.status`/`.input`/`.output`/`.time.{start,end}`, folding on
// "looks terminal" (state.output present, or status completed/error/done) —
// NOT a two-message tool_use/tool_result pair like CC's tracker.

test("OcToolCallTracker: a single non-terminal tool_use line (pending, no output) produces no record", () => {
  const tracker = new OcToolCallTracker();
  const record = tracker.observe({
    type: "tool_use",
    timestamp: 1000,
    part: {
      id: "call_1",
      tool: "read",
      state: { status: "pending", input: { file_path: "/tmp/a.txt" } },
    },
  });
  assert.equal(record, null);
});

test("OcToolCallTracker: a terminal tool_use line (state.output present) folds into one record with tool/tool_call_id/args/ok/label/result_snippet/started_at/ended_at/duration_ms", () => {
  const tracker = new OcToolCallTracker();
  const record = tracker.observe({
    type: "tool_use",
    timestamp: 1500,
    part: {
      id: "call_1",
      tool: "read",
      state: {
        status: "completed",
        input: { file_path: "/tmp/a.txt" },
        output: "1\thello world\n",
        time: { start: 1000, end: 1500 },
      },
    },
  });
  assert.ok(record);
  assert.equal(record!.tool, "read");
  assert.equal(record!.tool_call_id, "call_1");
  assert.deepEqual(record!.args, { file_path: "/tmp/a.txt" });
  assert.equal(record!.ok, true);
  assert.equal(record!.label, "read: /tmp/a.txt");
  assert.equal(record!.result_snippet, "1\thello world\n");
  assert.equal(record!.started_at, new Date(1000).toISOString());
  assert.equal(record!.ended_at, new Date(1500).toISOString());
  assert.equal(record!.duration_ms, 500);
});

test("OcToolCallTracker: same call id — a non-terminal pending line then a terminal error line — folds to ONE record with ok:false, matched by id not orphaned", () => {
  const tracker = new OcToolCallTracker();
  const first = tracker.observe({
    type: "tool_use",
    timestamp: 2000,
    part: {
      id: "call_2",
      tool: "bash",
      state: { status: "pending", input: {}, time: { start: 2000 } },
    },
  });
  assert.equal(first, null);

  const second = tracker.observe({
    type: "tool_use",
    timestamp: 2400,
    part: {
      id: "call_2",
      tool: "bash",
      state: { status: "error", input: { command: "false" }, output: "command failed", time: { start: 2000, end: 2400 } },
    },
  });
  assert.ok(second);
  assert.equal(second!.tool, "bash");
  assert.equal(second!.tool_call_id, "call_2");
  assert.equal(second!.ok, false);
  assert.equal(second!.result_snippet, "command failed");
  // started_at came from the FIRST (pending) line's own time.start, proving
  // the two lines were matched by id into a single open call, not treated
  // as two separate/orphaned records.
  assert.equal(second!.started_at, new Date(2000).toISOString());
  assert.equal(second!.duration_ms, 400);
});

test("OcToolCallTracker: a line arriving AFTER an already-terminal line for the same id is dropped, not folded into a duplicate record", () => {
  const tracker = new OcToolCallTracker();
  // A "running" line that already streams output — the loose "looks
  // terminal" heuristic (state.output !== undefined) treats this as terminal
  // even though a later "completed" line for the same call is still coming.
  const first = tracker.observe({
    type: "tool_use",
    timestamp: 5000,
    part: { id: "call_5", tool: "bash", state: { status: "running", input: { command: "echo hi" }, output: "hi\n", time: { start: 5000, end: 5100 } } },
  });
  assert.ok(first, "the first (loosely-terminal) line still folds into a record");

  const second = tracker.observe({
    type: "tool_use",
    timestamp: 5200,
    part: { id: "call_5", tool: "bash", state: { status: "completed", input: { command: "echo hi" }, output: "hi\n", time: { start: 5000, end: 5200 } } },
  });
  assert.equal(second, null, "a later line for an already-closed id must not fold into a second record");
});

test("OcToolCallTracker: a later non-terminal line updates args from an initially-empty state.input — folded record uses the middle line's input, not the empty one", () => {
  const tracker = new OcToolCallTracker();
  const open = tracker.observe({
    type: "tool_use",
    timestamp: 3000,
    part: {
      id: "call_3",
      tool: "grep",
      state: { status: "pending", input: {}, time: { start: 3000 } },
    },
  });
  assert.equal(open, null);

  const running = tracker.observe({
    type: "tool_use",
    timestamp: 3100,
    part: {
      id: "call_3",
      tool: "grep",
      state: { status: "running", input: { pattern: "TODO", path: "src/" } },
    },
  });
  assert.equal(running, null);

  const done = tracker.observe({
    type: "tool_use",
    timestamp: 3200,
    part: {
      id: "call_3",
      tool: "grep",
      state: { status: "completed", input: {}, output: "src/a.ts:1:TODO", time: { start: 3000, end: 3200 } },
    },
  });
  assert.ok(done);
  assert.deepEqual(done!.args, { pattern: "TODO", path: "src/" }, "the middle line's input, not the initial empty one or the terminal line's own empty input");
});

test("OcToolCallTracker: a non-tool_use message type produces no record", () => {
  const tracker = new OcToolCallTracker();
  assert.equal(tracker.observe({ type: "text", part: { text: "hello" }, timestamp: 4000 }), null);
  assert.equal(tracker.observe({ type: "step_start", sessionID: "ses_abc", timestamp: 4000 }), null);
});

test("OcToolCallTracker: missing part.id/callID/toolCallId falls back to a `${tool}-${timestamp}` synthetic id, doesn't crash, and still folds when the same synthetic id naturally recurs", () => {
  const tracker = new OcToolCallTracker();
  const first = tracker.observe({
    type: "tool_use",
    timestamp: 5000,
    part: {
      tool: "glob",
      state: { status: "pending", input: { pattern: "**/*.ts" } },
    },
  });
  assert.equal(first, null);

  const second = tracker.observe({
    type: "tool_use",
    timestamp: 5000, // same timestamp -> same synthetic id "glob-5000"
    part: {
      tool: "glob",
      state: { status: "completed", input: { pattern: "**/*.ts" }, output: "src/a.ts\nsrc/b.ts", time: { start: 5000, end: 5050 } },
    },
  });
  assert.ok(second);
  assert.equal(second!.tool, "glob");
  assert.equal(second!.tool_call_id, "glob-5000");
  assert.equal(second!.ok, true);
  assert.equal(second!.result_snippet, "src/a.ts\nsrc/b.ts");
});
