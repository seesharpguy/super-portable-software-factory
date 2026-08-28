import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebFetchTool, isKnownToolName, resolveModel, stripHtml, ToolCallTracker } from "../core/agent_flue.js";
import type { Sandbox } from "@flue/runtime";

test("resolveModel: accepts provider/model-id, rejects anything else", () => {
  assert.deepEqual(resolveModel("openrouter/google/gemini-3.6-flash"), ["openrouter", "google/gemini-3.6-flash"]);
  assert.deepEqual(resolveModel("openai/gpt-5.6-terra"), ["openai", "gpt-5.6-terra"]);
  assert.throws(() => resolveModel("gpt-5.6-terra"), /must be written as provider\/model-id/);
  assert.throws(() => resolveModel("/gpt-5.6-terra"), /must be written as provider\/model-id/);
  assert.throws(() => resolveModel("openai/"), /must be written as provider\/model-id/);
});

test("isKnownToolName: pi vocabulary maps onto Flue's seven builtins, ls is known-but-dropped, typos are unknown", () => {
  for (const name of ["read", "write", "edit", "bash", "grep", "glob", "webfetch"]) {
    assert.equal(isKnownToolName(name), true, name);
  }
  assert.equal(isKnownToolName("find"), true, "find aliases to glob");
  assert.equal(isKnownToolName("ls"), true, "ls is a known name, just dropped");
  assert.equal(isKnownToolName("subagent_create"), false, "harness_engineering-only names are unknown here");
  assert.equal(isKnownToolName("bogus"), false);
});

// ── createWebFetchTool ───────────────────────────────────────────────────

/** Only `exec` is exercised by createWebFetchTool — every other Sandbox method is unused and left unimplemented. */
function fakeSandbox(exec: Sandbox["exec"]): Sandbox {
  return { exec } as unknown as Sandbox;
}

function fakeToolContext(url: string) {
  return { toolCallId: "t1", log: { info() {}, warn() {}, error() {} }, data: { url } };
}

test("stripHtml: drops script/style blocks and tags, decodes entities, collapses whitespace", () => {
  const html = "<html><head><style>.x{}</style><script>alert(1)</script></head><body><p>Hello &amp; welcome</p>\n\n\n<p>Bye</p></body></html>";
  assert.equal(stripHtml(html), "Hello & welcome\n\nBye");
});

test("stripHtml: passes plain text/JSON through essentially unchanged", () => {
  assert.equal(stripHtml('{"a": 1}'), '{"a": 1}');
});

test("createWebFetchTool: rejects a non-http(s) URL without ever calling exec", async () => {
  let execCalled = false;
  const tool = createWebFetchTool(fakeSandbox(async () => {
    execCalled = true;
    return { stdout: "", stderr: "", exitCode: 0 };
  }));
  const result = await tool.run(fakeToolContext("file:///etc/passwd") as any);
  assert.equal(execCalled, false);
  assert.match(String(result), /unsupported scheme/);
});

test("createWebFetchTool: rejects an unparseable URL without ever calling exec", async () => {
  let execCalled = false;
  const tool = createWebFetchTool(fakeSandbox(async () => {
    execCalled = true;
    return { stdout: "", stderr: "", exitCode: 0 };
  }));
  const result = await tool.run(fakeToolContext("not a url") as any);
  assert.equal(execCalled, false);
  assert.match(String(result), /not a valid URL/);
});

test("createWebFetchTool: a successful fetch runs curl/wget through env.exec and returns cleaned text", async () => {
  let seenCommand = "";
  const tool = createWebFetchTool(fakeSandbox(async (command) => {
    seenCommand = command;
    return { stdout: "<p>Hello &amp; welcome</p>", stderr: "", exitCode: 0 };
  }));
  const result = await tool.run(fakeToolContext("https://example.com/docs") as any);
  assert.equal(result, "Hello & welcome");
  assert.match(seenCommand, /curl/);
  assert.match(seenCommand, /'https:\/\/example\.com\/docs'/);
});

test("createWebFetchTool: a failed fetch (non-zero exit) reports the failure instead of throwing", async () => {
  const tool = createWebFetchTool(fakeSandbox(async () => ({ stdout: "", stderr: "curl: (6) Could not resolve host", exitCode: 6 })));
  const result = await tool.run(fakeToolContext("https://nonexistent.invalid/") as any);
  assert.match(String(result), /webfetch: fetching https:\/\/nonexistent\.invalid\/ failed \(exit 6\)/);
  assert.match(String(result), /Could not resolve host/);
});

test("ToolCallTracker: folds tool-input + tool-output into one record", () => {
  const tracker = new ToolCallTracker();
  assert.equal(
    tracker.observe({
      type: "tool-input",
      conversationId: "c1",
      messageId: "m1",
      toolCallId: "call1",
      toolName: "bash",
      input: { command: "ls -la src" },
      position: { batch: 0, index: 0 },
    } as any),
    null,
    "tool-input alone produces no record",
  );
  const record = tracker.observe({
    type: "tool-output",
    conversationId: "c1",
    toolCallId: "call1",
    output: "src/index.ts\nsrc/core",
    durationMs: 12,
    position: { batch: 0, index: 1 },
  } as any);
  assert.ok(record);
  assert.equal(record!.tool, "bash");
  assert.equal(record!.tool_call_id, "call1");
  assert.deepEqual(record!.args, { command: "ls -la src" });
  assert.equal(record!.ok, true);
  assert.equal(record!.label, "bash: ls -la src");
  assert.equal(record!.result_snippet, "src/index.ts\nsrc/core");
  assert.equal(record!.duration_ms, 12);
});

test("ToolCallTracker: tool-output-error folds to ok:false with the error text as the snippet", () => {
  const tracker = new ToolCallTracker();
  tracker.observe({
    type: "tool-input",
    conversationId: "c1",
    messageId: "m1",
    toolCallId: "call2",
    toolName: "read",
    input: { path: "missing.txt" },
    position: { batch: 0, index: 0 },
  } as any);
  const record = tracker.observe({
    type: "tool-output-error",
    conversationId: "c1",
    toolCallId: "call2",
    errorText: "ENOENT: no such file",
    position: { batch: 0, index: 1 },
  } as any);
  assert.ok(record);
  assert.equal(record!.ok, false);
  assert.equal(record!.result_snippet, "ENOENT: no such file");
  assert.equal(record!.label, "read: missing.txt");
});

test("ToolCallTracker: a tool-output with no matching tool-input still produces a record (defensive)", () => {
  const tracker = new ToolCallTracker();
  const record = tracker.observe({
    type: "tool-output",
    conversationId: "c1",
    toolCallId: "orphan",
    output: "ok",
    position: { batch: 0, index: 0 },
  } as any);
  assert.ok(record);
  assert.equal(record!.tool, "tool");
  assert.deepEqual(record!.args, {});
});
