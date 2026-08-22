/**
 * The OTLP span exporter. Six things are pinned here, and every one of them is
 * a thing a "simplification" would quietly break:
 *
 *  1. ID derivation — deterministic, right length, lowercase hex, never zero.
 *  2. `traceparent` parsing — strict W3C, and GARBAGE IS SILENT (a malformed CI
 *     variable must degrade to "own root", never throw, never half-parse).
 *  3. THE ALLOWLIST — a synthetic EventRecord whose payload carries a marker
 *     string, asserted absent from the literal JSON body the exporter would
 *     POST. This is the exfiltration test: `EventRecord.payload` holds tool
 *     args, result snippets, and the repo's own source. If someone adds a
 *     `stringValue` read from a payload, this test is what says no.
 *  4. The queue bound — 3000 spans pushed synchronously stay <= the bound, with
 *     the overflow counted (drop-OLDEST, so the newest spans survive).
 *  5. The wire shape — against an in-process `node:http` receiver, not a fetch
 *     mock, so the assertions are on real bytes: resourceSpans -> scopeSpans ->
 *     spans nesting, hex ids, AnyValue-wrapped attributes, and nanosecond
 *     timestamps AS STRINGS (a JSON number loses precision past 2^53).
 *  6. Failure isolation — an endpoint that 500s or does not exist must resolve
 *     quietly, because export is never allowed to fail a run.
 *
 * Hermetic: every exporter is constructed with an explicit `env` (so the
 * developer's own TRACEPARENT cannot leak in) and every network case talks to a
 * loopback server on an ephemeral port.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  OtelExporter,
  endpointLabel,
  inboundTraceparent,
  nanosFromIso,
  parseTraceparent,
  redact,
  resolveTracesUrl,
  spanIdFor,
  toolSpanName,
  traceIdFor,
} from "../core/otel.js";
import * as v from "valibot";
import { AgentConfigSchema, GateReport, makeEventRecord, makePhaseParams, type EventRecord, type Phase } from "../core/data_types.js";

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

function exporter(endpoint: string, log: (m: string) => void = () => {}): OtelExporter {
  return new OtelExporter({
    cfg: { endpoint, service_name: "spf", headers: undefined },
    adwId: "adw_test",
    chainName: "plan-build-test",
    log,
    env: {}, // hermetic: never inherit the developer's own TRACEPARENT
  });
}

function phase(overrides: Partial<Phase> = {}): Phase {
  return {
    phase_id: "adw_test_01_build",
    adw_id: "adw_test",
    seq: 1,
    params: makePhaseParams({ name: "build", kind: "agent", owner: "builder", description: "write the code the plan asked for" }),
    status: "success",
    attempt: 0,
    error: null,
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:00:10.500Z",
    ...overrides,
  };
}

/** A one-request receiver. Resolves with the parsed body of the first POST. */
async function receiver(): Promise<{ url: string; body: Promise<any>; close: () => Promise<void> }> {
  let resolveBody: (value: any) => void;
  const body = new Promise<any>((resolve) => {
    resolveBody = resolve;
  });
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      resolveBody({
        method: req.method,
        contentType: req.headers["content-type"],
        raw: Buffer.concat(chunks).toString("utf-8"),
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    body,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── 1. ids ──────────────────────────────────────────────────────────────────

test("trace/span ids: deterministic, hex, exact length — the bespoke sha256 convention", () => {
  const traceId = traceIdFor("adw_abc123");
  assert.match(traceId, HEX32, "trace-id must be 32 lowercase hex chars");
  assert.equal(traceId, traceIdFor("adw_abc123"), "same adw_id -> same trace-id, so a re-export lands on the same trace");
  assert.notEqual(traceId, traceIdFor("adw_abc124"), "a different run must not collide");

  const spanId = spanIdFor("adw_abc123_01_plan");
  assert.match(spanId, HEX16, "span-id must be 16 lowercase hex chars");
  assert.equal(spanId, spanIdFor("adw_abc123_01_plan"), "same key -> same span-id: a child can name its parent before the parent is emitted");
  assert.notEqual(spanId, spanIdFor("adw_abc123_02_build"));
  assert.notEqual(spanId.slice(0, 16), traceId.slice(0, 16), "span ids are NOT a prefix of the trace id");
});

// ── 2. traceparent ──────────────────────────────────────────────────────────

test("parseTraceparent: accepts a valid W3C header and reads the sampled flag", () => {
  const parsed = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  assert.deepEqual(parsed, {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    sampled: true,
  });
  assert.equal(parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00")?.sampled, false);
});

test("parseTraceparent: every malformed shape returns null, silently", () => {
  for (const bad of [
    undefined,
    null,
    "",
    "   ",
    "not-a-traceparent",
    "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", // unknown version: never guess
    "00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01", // trace-id 31 chars
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b-01", // span-id 15 chars
    "00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01", // uppercase
    "00-00000000000000000000000000000000-00f067aa0ba902b7-01", // all-zero trace-id
    "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01", // all-zero span-id
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7", // three fields
    "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-zz", // non-hex flags
    "<script>alert(1)</script>",
  ]) {
    assert.equal(parseTraceparent(bad as string | null | undefined), null, `must reject: ${JSON.stringify(bad)}`);
  }
});

test("inboundTraceparent: reads TRACEPARENT, falls back to OTEL_TRACEPARENT, ignores everything else", () => {
  const valid = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  assert.equal(inboundTraceparent({ TRACEPARENT: valid })?.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(inboundTraceparent({ OTEL_TRACEPARENT: valid })?.spanId, "00f067aa0ba902b7");
  assert.equal(inboundTraceparent({}), null);
  // The whole point of EXPLICIT CONFIG ONLY: an exporter endpoint in the
  // environment is not a switch, and it is not a parent either.
  assert.equal(inboundTraceparent({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://evil:4318" }), null);
});

test("an inbound traceparent adopts its trace-id and parents the run's root span under it", async () => {
  const sink = await receiver();
  try {
    const exp = new OtelExporter({
      cfg: { endpoint: sink.url, service_name: "spf", headers: undefined },
      adwId: "adw_test",
      chainName: "plan",
      log: () => {},
      env: { TRACEPARENT: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
    });
    exp.recordSessionFinish(true);
    await exp.flush(true);
    const span = JSON.parse((await sink.body).raw).resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.traceId, "4bf92f3577b34da6a3ce929d0e0e4736", "the CI trace, not our own sha256(adw_id)");
    assert.equal(span.parentSpanId, "00f067aa0ba902b7", "the run joins the CI trace instead of orphaning a root");
  } finally {
    await sink.close();
  }
});

// ── small pure helpers ──────────────────────────────────────────────────────

test("resolveTracesUrl: a bare origin gets /v1/traces; an explicit path is left alone", () => {
  assert.equal(resolveTracesUrl("http://localhost:4318"), "http://localhost:4318/v1/traces");
  assert.equal(resolveTracesUrl("http://localhost:4318/"), "http://localhost:4318/v1/traces");
  assert.equal(resolveTracesUrl("https://collector.example.com/v1/traces"), "https://collector.example.com/v1/traces");
  assert.equal(resolveTracesUrl("https://collector.example.com/otlp/v1/traces"), "https://collector.example.com/otlp/v1/traces");
});

test("endpointLabel: drops userinfo and query — doctor output gets pasted into issues", () => {
  assert.equal(endpointLabel("https://user:s3cr3t@collector.example.com/v1/traces?token=abc"), "https://collector.example.com/v1/traces");
  assert.equal(endpointLabel("garbage"), "(unparseable endpoint)");
});

test("nanosFromIso: uint64 nanoseconds as a STRING, with a fallback for junk", () => {
  assert.equal(nanosFromIso("2026-01-01T00:00:00.000Z"), "1767225600000000000");
  assert.equal(typeof nanosFromIso("2026-01-01T00:00:00.000Z"), "string", "a JSON number would lose precision past 2^53");
  assert.match(nanosFromIso("2026-01-01T00:00:00.500Z"), /^\d+000000$/, "millisecond input -> six trailing zeros");
  assert.equal(nanosFromIso("not a date", 1000), "1000000000", "unparseable falls back rather than emitting NaN");
  assert.equal(nanosFromIso(null, 1000), "1000000000");
});

test("toolSpanName: the tool's identity, never the argument-bearing label", () => {
  // agent_flue.ts's labelFor() builds "bash: <command>" from real arguments.
  assert.equal(toolSpanName("bash: cat src/core/secrets.ts"), "bash");
  assert.equal(toolSpanName("quality:typecheck"), "quality");
  assert.equal(toolSpanName("Read"), "Read");
  assert.equal(toolSpanName(""), "tool_call");
  assert.equal(toolSpanName(undefined), "tool_call");
  assert.equal(toolSpanName("weird name with spaces"), "weirdnamewithspaces", "character-restricted, so an event name can't smuggle a payload");
});

test("redact: the endpoint and every header VALUE are unprintable", () => {
  const line = redact("connect ECONNREFUSED https://collector.example.com/v1/traces (Bearer sk-abc123456)", [
    "https://collector.example.com/v1/traces",
    "Bearer sk-abc123456",
  ]);
  assert.ok(!line.includes("sk-abc123456"), "a header value must never reach a log");
  assert.ok(!line.includes("collector.example.com"), "nor the endpoint");
  assert.ok(line.includes("ECONNREFUSED"), "the useful part of the message survives");
});

// ── 3. THE ALLOWLIST ────────────────────────────────────────────────────────

test("allowlist: nothing from EventRecord.payload reaches the wire", () => {
  const MARKER = "ZZ_TOP_SECRET_REPO_SOURCE_ZZ";
  const exp = exporter("http://127.0.0.1:1/v1/traces");
  const phaseId = "adw_test_01_build";

  const events: EventRecord[] = [
    makeEventRecord({
      adw_id: "adw_test",
      phase_id: phaseId,
      type: "agent_start",
      name: "builder",
      // model/coding_agent are allowlisted, but they must come from the TYPED
      // AgentConfig, not from here — a payload read of any string is the bug.
      payload: { model: MARKER, coding_agent: MARKER, session_id: MARKER, purpose: MARKER },
    }),
    makeEventRecord({
      adw_id: "adw_test",
      phase_id: phaseId,
      type: "tool_call",
      name: `bash: cat ${MARKER}`, // the human label is built FROM tool args
      started_at: "2026-01-01T00:00:01.000Z",
      ended_at: "2026-01-01T00:00:02.000Z",
      payload: { tool: "bash", agent: "builder", args: { command: `cat ${MARKER}` }, result_snippet: MARKER, ok: true },
    }),
    makeEventRecord({
      adw_id: "adw_test",
      phase_id: phaseId,
      type: "log",
      name: "paths_touched",
      payload: { agent: "builder", paths: [`src/${MARKER}.ts`] },
    }),
    makeEventRecord({
      adw_id: "adw_test",
      phase_id: phaseId,
      type: "handoff",
      name: "builder",
      payload: { summary: MARKER, artifacts: [MARKER] },
    }),
    makeEventRecord({
      adw_id: "adw_test",
      phase_id: phaseId,
      type: "error",
      name: "permission_breach",
      payload: { error: MARKER, writes: [MARKER] },
    }),
    makeEventRecord({
      adw_id: "adw_test",
      phase_id: phaseId,
      type: "agent_end",
      name: "builder",
      tokens: 1234,
      // Numbers ride; the string-valued siblings must not. `total_tokens` here
      // is a STRING on purpose: numOrNull must drop it, not coerce it.
      payload: { cost: 0.42, usage: { input_tokens: 100, output_tokens: 24, total_tokens: MARKER }, note: MARKER },
    }),
  ];
  events.forEach((record, i) => exp.recordEvent(record, `evt_${i}`, "2026-01-01T00:00:05.000Z"));

  const gate = new GateReport();
  gate.check(`the agent claimed ${MARKER}`, false, MARKER);
  exp.recordGate(phase(), "no_placeholders", gate, 1);

  // A failed phase: `phase.error` is repo/agent text and must not ride along.
  exp.recordPhase(phase({ status: "fail", error: `TypeError in ${MARKER}` }));
  exp.recordSessionFinish(false);

  const json = exp.pendingJson();
  assert.ok(!json.includes(MARKER), `the marker leaked into the OTLP body:\n${json}`);
  // Positive controls: the allowlisted fields ARE there, so this test can't
  // pass by exporting nothing at all.
  assert.ok(json.includes("spf.phase.name"), "phase attributes are still exported");
  assert.ok(json.includes("no_placeholders"), "the gate NAME is allowlisted");
  assert.ok(json.includes('"spf.gate.violation_count"'), "the violation COUNT is what crosses, not the text");
  assert.ok(json.includes('"doubleValue":0.42'), "cost still rides as an attribute");
  // `record.tokens` (a real number) exports; `payload.usage.total_tokens` was
  // the MARKER string and must have been dropped by numOrNull rather than
  // stringified into an attribute — so exactly one total-tokens attribute
  // exists, and it is the numeric one.
  const agentSpan = JSON.parse(json).resourceSpans[0].scopeSpans[0].spans.find((s: any) => s.name === "agent builder");
  const totals = agentSpan.attributes.filter((a: any) => a.key === "spf.tokens.total");
  assert.equal(totals.length, 1);
  assert.deepEqual(totals[0].value, { intValue: "1234" }, "the number rode; the string did not");
});

test("allowlist: agent model/coding_agent come from the typed AgentConfig, never the payload", () => {
  const exp = exporter("http://127.0.0.1:1/v1/traces");
  exp.recordAgentSession(
    v.parse(AgentConfigSchema, {
      name: "builder",
      model: "google/gemini-3.6-flash",
      prompt_engineering: { system: "s.md", user: "u.md" },
    }),
  );
  exp.recordEvent(
    makeEventRecord({ adw_id: "adw_test", phase_id: "adw_test_01_build", type: "agent_start", name: "builder", payload: {} }),
    "evt_a",
    "2026-01-01T00:00:00.000Z",
  );
  exp.recordEvent(
    makeEventRecord({ adw_id: "adw_test", phase_id: "adw_test_01_build", type: "agent_end", name: "builder", tokens: 10, payload: {} }),
    "evt_b",
    "2026-01-01T00:00:09.000Z",
  );
  const json = exp.pendingJson();
  assert.ok(json.includes("google/gemini-3.6-flash"), "the model is allowlisted and comes from config");
  assert.ok(json.includes('"spf.agent.coding_agent"'), "so is the backend");
  assert.ok(json.includes('"gen_ai.request.model"'), "and it is also emitted under the GenAI semantic convention");
});

// ── 4. the queue bound ──────────────────────────────────────────────────────

test("queue bound: a synchronous burst of 3000 spans stays bounded, and the overflow is counted", () => {
  const exp = exporter("http://127.0.0.1:1/v1/traces");
  for (let i = 0; i < 3000; i++) {
    exp.recordEvent(
      makeEventRecord({
        adw_id: "adw_test",
        phase_id: "adw_test_01_build",
        type: "tool_call",
        name: "bash: echo hi",
        started_at: "2026-01-01T00:00:01.000Z",
        ended_at: "2026-01-01T00:00:01.100Z",
        payload: { tool: "bash", agent: "builder" },
      }),
      `evt_${i}`,
      "2026-01-01T00:00:01.000Z",
    );
  }
  const stats = exp.stats();
  assert.ok(stats.queued <= 2048, `queue must stay bounded, saw ${stats.queued}`);
  assert.equal(stats.queued, 2048, "the bound is 2048 spans");
  assert.equal(stats.dropped, 3000 - 2048, "every span over the bound is counted, not silently forgotten");
  // Drop-OLDEST: the surviving spans are the newest ones, which are the ones
  // still explaining what the run was doing when it filled up.
  const spans = JSON.parse(exp.pendingJson()).resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans[spans.length - 1].spanId, spanIdFor("tool:adw_test_01_build:evt_2999"));
});

test("span events per phase are bounded too — a runaway phase can't grow the buffer forever", () => {
  const exp = exporter("http://127.0.0.1:1/v1/traces");
  for (let i = 0; i < 500; i++) {
    exp.recordEvent(
      makeEventRecord({ adw_id: "adw_test", phase_id: "adw_test_01_build", type: "handoff", name: "note", payload: {} }),
      `evt_${i}`,
      "2026-01-01T00:00:01.000Z",
    );
  }
  exp.recordPhase(phase());
  const span = JSON.parse(exp.pendingJson()).resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.events.length, 64, "capped at MAX_EVENTS_PER_SPAN");
  assert.equal(exp.stats().droppedEvents, 500 - 64);
});

test("log events are dropped outright, not buffered — they can't crowd handoff/error out of the per-phase cap", () => {
  const exp = exporter("http://127.0.0.1:1/v1/traces");
  for (let i = 0; i < 70; i++) {
    exp.recordEvent(
      makeEventRecord({ adw_id: "adw_test", phase_id: "adw_test_01_build", type: "log", name: "console", payload: {} }),
      `log_${i}`,
      "2026-01-01T00:00:01.000Z",
    );
  }
  exp.recordEvent(
    makeEventRecord({ adw_id: "adw_test", phase_id: "adw_test_01_build", type: "handoff", name: "handoff", payload: {} }),
    "evt_handoff",
    "2026-01-01T00:00:01.500Z",
  );
  exp.recordPhase(phase());
  const span = JSON.parse(exp.pendingJson()).resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.events.length, 1, "the 70 log events were dropped, not buffered");
  assert.equal(span.events[0].name, "handoff");
  assert.equal(exp.stats().droppedEvents, 0, "log events are dropped before touching the buffer, so they don't count as droppedEvents either");
});

test("recordEvent is fail-closed: an unrecognized EventRecord.type is dropped, not exported by default", () => {
  const exp = exporter("http://127.0.0.1:1/v1/traces");
  exp.recordEvent(
    { adw_id: "adw_test", phase_id: "adw_test_01_build", type: "future_type" as never, name: "agent-output-derived-name", payload: {}, parent_id: "" },
    "evt_future",
    "2026-01-01T00:00:01.000Z",
  );
  exp.recordPhase(phase());
  const span = JSON.parse(exp.pendingJson()).resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.events.length, 0, "an unknown event type must not fall through to export");
});

// ── 5. the wire shape ───────────────────────────────────────────────────────

test("OTLP/HTTP-JSON shape: resourceSpans -> scopeSpans -> spans, hex ids, stringified nanos", async () => {
  const sink = await receiver();
  try {
    const exp = exporter(sink.url);
    exp.recordSessionStart("2026-01-01T00:00:00.000Z");
    exp.recordEvent(
      makeEventRecord({ adw_id: "adw_test", phase_id: "adw_test_01_build", type: "agent_start", name: "builder", payload: {} }),
      "evt_1",
      "2026-01-01T00:00:01.000Z",
    );
    exp.recordEvent(
      makeEventRecord({
        adw_id: "adw_test",
        phase_id: "adw_test_01_build",
        type: "tool_call",
        name: "bash: ls",
        started_at: "2026-01-01T00:00:02.000Z",
        ended_at: "2026-01-01T00:00:03.000Z",
        payload: { tool: "bash", agent: "builder" },
      }),
      "evt_2",
      "2026-01-01T00:00:02.000Z",
    );
    exp.recordEvent(
      makeEventRecord({
        adw_id: "adw_test",
        phase_id: "adw_test_01_build",
        type: "agent_end",
        name: "builder",
        tokens: 999,
        payload: { cost: 1.5, usage: { input_tokens: 700, output_tokens: 299, total_tokens: 999 } },
      }),
      "evt_3",
      "2026-01-01T00:00:04.000Z",
    );
    exp.recordPhase(phase());
    exp.recordSessionFinish(true);
    await exp.flush(true);

    const request = await sink.body;
    assert.equal(request.method, "POST");
    assert.equal(request.contentType, "application/json");
    const payload = JSON.parse(request.raw);

    assert.equal(payload.resourceSpans.length, 1, "one resourceSpans entry");
    const resource = payload.resourceSpans[0].resource;
    assert.deepEqual(
      resource.attributes.find((a: any) => a.key === "service.name"),
      { key: "service.name", value: { stringValue: "spf" } },
      "resource attributes are AnyValue-wrapped KeyValue pairs",
    );
    assert.equal(payload.resourceSpans[0].scopeSpans.length, 1, "scopeSpans nests INSIDE resourceSpans");
    const scopeSpans = payload.resourceSpans[0].scopeSpans[0];
    assert.equal(scopeSpans.scope.name, "spf");
    const spans = scopeSpans.spans;
    assert.equal(spans.length, 4, "root + phase + agent call + tool call");

    for (const span of spans) {
      assert.match(span.traceId, HEX32, "trace ids are lowercase hex strings, not base64");
      assert.match(span.spanId, HEX16);
      assert.equal(typeof span.startTimeUnixNano, "string", "nanosecond timestamps MUST be strings");
      assert.equal(typeof span.endTimeUnixNano, "string");
      assert.match(span.startTimeUnixNano, /^\d+$/);
      assert.equal(span.kind, 1, "INTERNAL");
      assert.equal(span.traceId, traceIdFor("adw_test"), "one run = one trace");
    }

    const root = spans.find((s: any) => s.name === "spf run plan-build-test");
    const phaseSpan = spans.find((s: any) => s.name === "phase build");
    const agentSpan = spans.find((s: any) => s.name === "agent builder");
    const toolSpan = spans.find((s: any) => s.name === "bash");
    assert.ok(root && phaseSpan && agentSpan && toolSpan, "every level of the span model is present");

    assert.equal(root.parentSpanId, "", "no inbound traceparent -> the run is the root");
    assert.equal(root.spanId, spanIdFor("run:adw_test"));
    assert.equal(phaseSpan.parentSpanId, root.spanId, "phases hang off the run");
    assert.equal(phaseSpan.spanId, spanIdFor("adw_test_01_build"), "a phase span's id is sha256(phase_id)");
    assert.equal(agentSpan.parentSpanId, phaseSpan.spanId, "agent calls are CHILDREN of their phase");
    assert.equal(toolSpan.parentSpanId, agentSpan.spanId, "tool calls hang off the agent call that made them");
    assert.equal(phaseSpan.status.code, 1, "a successful phase reports OK");
    assert.equal(phaseSpan.startTimeUnixNano, nanosFromIso("2026-01-01T00:00:00.000Z"), "real phase clock, not send time");
    assert.equal(phaseSpan.endTimeUnixNano, nanosFromIso("2026-01-01T00:00:10.500Z"));
    assert.equal(toolSpan.startTimeUnixNano, nanosFromIso("2026-01-01T00:00:02.000Z"), "tool spans carry real elapsed time");

    const tokens = agentSpan.attributes.find((a: any) => a.key === "spf.tokens.total");
    assert.deepEqual(tokens.value, { intValue: "999" }, "token counts are intValue STRINGS");
    const cost = agentSpan.attributes.find((a: any) => a.key === "spf.cost.total");
    assert.deepEqual(cost.value, { doubleValue: 1.5 }, "cost is a double");
  } finally {
    await sink.close();
  }
});

test("a failed phase exports ERROR status and NO error message", async () => {
  const sink = await receiver();
  try {
    const exp = exporter(sink.url);
    exp.recordPhase(phase({ status: "fail", error: "TypeError: cannot read property 'x' of undefined in src/app.ts" }));
    await exp.flush(true);
    const span = JSON.parse((await sink.body).raw).resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.status.code, 2, "ERROR");
    assert.equal(span.status.message, undefined, "the message is agent/repo text — the status code is the whole signal");
    assert.ok(!(await sink.body).raw.includes("src/app.ts"));
  } finally {
    await sink.close();
  }
});

test("gate events land on the phase span as span EVENTS, with the count and not the text", async () => {
  const sink = await receiver();
  try {
    const exp = exporter(sink.url);
    const report = new GateReport();
    report.check("plan.md must exist", false, "not found");
    report.check("no TODO markers", false, "3 found in src/app.ts");
    exp.recordGate(phase(), "plan_gate", report, 2);
    exp.recordPhase(phase());
    await exp.flush(true);
    const span = JSON.parse((await sink.body).raw).resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.events.length, 1);
    assert.equal(span.events[0].name, "gate_fail");
    assert.equal(typeof span.events[0].timeUnixNano, "string");
    const byKey = Object.fromEntries(span.events[0].attributes.map((a: any) => [a.key, a.value]));
    assert.deepEqual(byKey["spf.gate.name"], { stringValue: "plan_gate" });
    assert.deepEqual(byKey["spf.gate.passed"], { boolValue: false });
    assert.deepEqual(byKey["spf.gate.violation_count"], { intValue: "2" });
    assert.deepEqual(byKey["spf.gate.attempt"], { intValue: "2" });
    assert.ok(!(await sink.body).raw.includes("src/app.ts"), "violation text stays in SQLite");
  } finally {
    await sink.close();
  }
});

test("the final flush carries the drop counter as a resource attribute", async () => {
  const sink = await receiver();
  const lines: string[] = [];
  try {
    const exp = exporter(sink.url, (m) => lines.push(m));
    for (let i = 0; i < 2100; i++) {
      exp.recordEvent(
        makeEventRecord({ adw_id: "adw_test", phase_id: "p", type: "tool_call", name: "bash: x", payload: {} }),
        `evt_${i}`,
        "2026-01-01T00:00:01.000Z",
      );
    }
    await exp.flush(true);
    const resource = JSON.parse((await sink.body).raw).resourceSpans[0].resource;
    assert.deepEqual(
      resource.attributes.find((a: any) => a.key === "spf.otel.dropped_spans"),
      { key: "spf.otel.dropped_spans", value: { intValue: "52" } },
      "the gap is visible in the backend, not only in a log nobody kept",
    );
    assert.equal(lines.length, 1, "exactly one warn line, not one per drop");
    assert.match(lines[0]!, /dropped 52 span\(s\)/);
  } finally {
    await sink.close();
  }
});

// ── 6. failure isolation ────────────────────────────────────────────────────

test("a rejecting collector logs once, redacted, and never throws", async () => {
  const lines: string[] = [];
  const server = createServer((_req, res) => {
    res.writeHead(500);
    res.end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const exp = new OtelExporter({
      cfg: { endpoint: `http://127.0.0.1:${port}/v1/traces`, service_name: "spf", headers: { authorization: "Bearer sk-topsecret" } },
      adwId: "adw_test",
      chainName: "plan",
      log: (m) => lines.push(m),
      env: {},
    });
    exp.recordPhase(phase());
    await exp.flush(true); // must resolve, not reject
    exp.recordPhase(phase({ phase_id: "adw_test_02_test", seq: 2 }));
    await exp.flush(true);
    assert.equal(lines.length, 1, "one line for the life of the exporter, not one per batch");
    assert.ok(!lines[0]!.includes("sk-topsecret"), "header values are never logged");
    assert.ok(!lines[0]!.includes(String(port)), "nor the endpoint");
    assert.match(lines[0]!, /the run is unaffected/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("drain(): resolves on its own budget against a dead endpoint, and never throws", async () => {
  // 127.0.0.1:1 is closed on every platform CI runs on — a connection refusal,
  // which is the fast path; the budget covers the hang case.
  const exp = exporter("http://127.0.0.1:1/v1/traces");
  exp.recordPhase(phase());
  const started = Date.now();
  await exp.drain(200);
  assert.ok(Date.now() - started < 3_000, "a dead collector cannot stall shutdown");
  assert.equal(exp.stats().queued, 0, "the queue is drained either way");
});

test("drain() with no queued spans and no config activity is a silent no-op", async () => {
  const exp = exporter("http://127.0.0.1:1/v1/traces");
  await exp.drain(50);
  await exp.drain(50); // idempotent: the root span is emitted at most once
  assert.equal(exp.stats().queued, 0);
});
