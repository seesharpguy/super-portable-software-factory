import { test } from "node:test";
import assert from "node:assert/strict";
import { isKnownToolName, CcToolCallTracker, resolveClaudeCmdSpec } from "../core/agent_cc.js";

/** Saves/restores SPF_CLAUDE_CMD around a test — process.env is real global state. */
function withClaudeCmd(value: string | undefined, fn: () => void): void {
  const original = process.env.SPF_CLAUDE_CMD;
  if (value === undefined) delete process.env.SPF_CLAUDE_CMD;
  else process.env.SPF_CLAUDE_CMD = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env.SPF_CLAUDE_CMD;
    else process.env.SPF_CLAUDE_CMD = original;
  }
}

// Regression for a real production bug: routing coding_agent: claude_code
// through `SPF_CLAUDE_CMD="ollama launch claude --model <fixed-tag>"` made
// every claude_code agent's own model: field inert — the fixed tag baked
// into the ONE process-wide env var served every agent identically,
// regardless of what each agent's own config said. `{model}` substitutes
// per call instead, so `ollama launch`'s OWN --model flag (the one that
// actually pins the served model) can vary per agent.
test("resolveClaudeCmdSpec: {model} substitutes with this call's own model", () => {
  withClaudeCmd("ollama launch claude --model {model}", () => {
    assert.equal(resolveClaudeCmdSpec("kimi-k2.7-code:cloud"), "ollama launch claude --model kimi-k2.7-code:cloud");
  });
});

test("resolveClaudeCmdSpec: a second, different agent's model reaches the same wrapper string differently — the actual bug this closes", () => {
  withClaudeCmd("ollama launch claude --model {model}", () => {
    assert.equal(resolveClaudeCmdSpec("qwen3-coder:cloud"), "ollama launch claude --model qwen3-coder:cloud");
  });
});

test("resolveClaudeCmdSpec: no {model} token in SPF_CLAUDE_CMD -> unchanged, model is simply unused", () => {
  withClaudeCmd("ollama launch claude --model granite4.1:8b", () => {
    assert.equal(resolveClaudeCmdSpec("sonnet"), "ollama launch claude --model granite4.1:8b");
  });
});

test("resolveClaudeCmdSpec: SPF_CLAUDE_CMD unset -> plain claude, byte-identical to before {model} existed", () => {
  withClaudeCmd(undefined, () => {
    assert.equal(resolveClaudeCmdSpec("sonnet"), "claude");
  });
});

test("isKnownToolName: SPF's lowercase vocabulary maps onto Claude Code's own tool names, ls is known-but-dropped, typos are unknown", () => {
  for (const name of ["read", "write", "edit", "bash", "grep", "glob"]) {
    assert.equal(isKnownToolName(name), true, name);
  }
  assert.equal(isKnownToolName("find"), true, "find aliases to glob");
  assert.equal(isKnownToolName("ls"), true, "ls is a known name, just dropped");
  assert.equal(isKnownToolName("harness_engineering_only"), false);
  assert.equal(isKnownToolName("bogus"), false);
});

// Every message shape below is a real captured line from `claude -p
// --output-format stream-json --verbose` (v2.1.237), not a guess — see
// agent_cc.ts's module doc comment for the exact commands run.

test("CcToolCallTracker: folds a real tool_use + tool_result pair into one record", () => {
  const tracker = new CcToolCallTracker();
  assert.equal(
    tracker.observe({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "toolu_01ABC", name: "Read", input: { file_path: "/private/tmp/cc-probe/test.txt" } }],
      },
      timestamp: "2026-08-20T11:40:00.000Z",
    }),
    null,
    "the assistant's tool_use alone produces no record",
  );
  const record = tracker.observe({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "toolu_01ABC", content: "1\thello world\n2\t" }],
    },
    timestamp: "2026-08-20T11:40:00.500Z",
  });
  assert.ok(record);
  assert.equal(record!.tool, "Read");
  assert.equal(record!.tool_call_id, "toolu_01ABC");
  assert.deepEqual(record!.args, { file_path: "/private/tmp/cc-probe/test.txt" });
  assert.equal(record!.ok, true);
  assert.equal(record!.label, "Read: /private/tmp/cc-probe/test.txt");
  assert.equal(record!.result_snippet, "1\thello world\n2\t");
  assert.equal(record!.duration_ms, 500);
});

test("CcToolCallTracker: a real StructuredOutput call folds like any other tool call, deliberately unfiltered", () => {
  const tracker = new CcToolCallTracker();
  tracker.observe({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_01MPFgPqyPeEzWfqRE25JLzF",
          name: "StructuredOutput",
          input: { status: "success", summary: "hello from claude code" },
        },
      ],
    },
  });
  const record = tracker.observe({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "toolu_01MPFgPqyPeEzWfqRE25JLzF", content: "Structured output provided successfully" }],
    },
  });
  assert.ok(record);
  assert.equal(record!.tool, "StructuredOutput");
  assert.equal(record!.ok, true);
  assert.equal(record!.result_snippet, "Structured output provided successfully");
});

test("CcToolCallTracker: is_error:true on the tool_result folds to ok:false", () => {
  const tracker = new CcToolCallTracker();
  tracker.observe({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "toolu_err", name: "Bash", input: { command: "false" } }] },
  });
  const record = tracker.observe({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "toolu_err", content: "command failed", is_error: true }] },
  });
  assert.ok(record);
  assert.equal(record!.ok, false);
});

test("CcToolCallTracker: non-tool message types (system, thinking-only assistant, result) produce no record", () => {
  const tracker = new CcToolCallTracker();
  assert.equal(tracker.observe({ type: "system", subtype: "init", cwd: "/tmp", session_id: "s1", tools: [] }), null);
  assert.equal(tracker.observe({ type: "assistant", message: { content: [{ type: "thinking", thinking: "..." }] } }), null);
  assert.equal(tracker.observe({ type: "result", subtype: "success", session_id: "s1" }), null);
});

test("CcToolCallTracker: a tool_result with no matching tool_use still produces a record (defensive)", () => {
  const tracker = new CcToolCallTracker();
  const record = tracker.observe({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "orphan", content: "ok" }] },
  });
  assert.ok(record);
  assert.equal(record!.tool, "tool");
  assert.deepEqual(record!.args, {});
});
