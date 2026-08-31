#!/usr/bin/env node
/**
 * Seed a demo spf.db for UI development — no real agent runs needed.
 *
 * Writes through the real Tracer (dist/core/tracer.js), so the db it produces
 * is shaped exactly like one a live run writes: WAL mode, same tables, same
 * payload JSON. Build first (`npm run build:cli`), then:
 *
 *   node scripts/seed-demo-db.mjs            # writes tmp/demo/spf.db (gitignored)
 *   node dist/cli/bin.js ui --db tmp/demo/spf.db --port 4600 --no-open
 *   npm --prefix app run dev                  # vite on :4601, /api proxied to :4600
 *
 * The dataset covers every UI state worth designing against: success / fail /
 * running / archived sessions, multi-agent lanes with configured colors, an
 * in-flight agent that only exists as an agent_start event (no agent_sessions
 * row yet), retried phases, gate passes AND fails with per-check evidence,
 * valid and invalid envelopes, tool-call spans with durations, usage
 * breakdowns with reasoning tokens, and on-disk prompt files.
 */
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Tracer } from "../dist/core/tracer.js";
import { makeEventRecord, GateReport } from "../dist/core/data_types.js";
import { Database } from "../dist/core/sqlite.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoDir = join(root, "tmp", "demo");
const dbPath = join(demoDir, "spf.db");

rmSync(demoDir, { recursive: true, force: true });
mkdirSync(demoDir, { recursive: true });

const tracer = new Tracer(dbPath, join(demoDir, "events.jsonl"));

// ── time helpers ─────────────────────────────────────────────────────────────
const NOW = Date.now();
const minAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const at = (m, s = 0) => new Date(NOW - m * 60_000 + s * 1000).toISOString();

// ── agent roster (only name/coding_agent/model/color are read by the row) ───
const AGENTS = {
  planner: { name: "planner", coding_agent: "claude_code", model: "claude-opus-5", color: "#a78bfa", purpose: "turn a request into a bounded plan" },
  builder: { name: "builder", coding_agent: "claude_code", model: "claude-sonnet-5", color: "#60a5fa", purpose: "implement the plan" },
  reviewer: { name: "reviewer", coding_agent: "flue", model: "google/gemini-3.6-flash", color: "#34d399", purpose: "adversarial review" },
  scout: { name: "scout", coding_agent: "flue", model: "google/gemini-3.6-flash", color: "#fbbf24", purpose: "read-only recon" },
};

const usage = (inTok, outTok, reasoning, cacheRead, cacheWrite) => ({
  input_tokens: inTok,
  output_tokens: outTok,
  reasoning_tokens: reasoning,
  cache_read_tokens: cacheRead,
  cache_write_tokens: cacheWrite,
  total_tokens: inTok + outTok + cacheRead + cacheWrite,
  input_cost: (inTok / 1e6) * 15,
  output_cost: (outTok / 1e6) * 75,
  cache_read_cost: (cacheRead / 1e6) * 1.5,
  cache_write_cost: (cacheWrite / 1e6) * 18.75,
  total_cost: (inTok / 1e6) * 15 + (outTok / 1e6) * 75 + (cacheRead / 1e6) * 1.5 + (cacheWrite / 1e6) * 18.75,
});

function phaseRow(adw, seq, name, kind, owner, extra = {}) {
  return {
    phase_id: `${adw}_${String(seq).padStart(2, "0")}_${name}`,
    adw_id: adw,
    seq,
    params: { name, kind, owner, description: extra.description ?? `${name} phase`, retries: extra.retries ?? 0 },
    status: extra.status ?? "success",
    attempt: extra.attempt ?? 0,
    error: extra.error ?? null,
    started_at: extra.started_at ?? null,
    ended_at: extra.ended_at ?? null,
  };
}

/** One full agent phase: agent_start → tool calls → agent_end (+ envelope + row). */
function agentPhase({ adw, phase, agent, startMin, durSec, tools, envelope, ctx, sessionId }) {
  const startEvt = tracer.event(
    makeEventRecord({
      adw_id: adw, phase_id: phase.phase_id, type: "agent_start", name: agent.name,
      payload: { model: agent.model, thinking: "medium", session_id: sessionId, color: agent.color, coding_agent: agent.coding_agent, purpose: agent.purpose, tools: tools?.map((t) => t.tool) ?? null },
      started_at: at(startMin),
    }),
  );
  let t = 2;
  for (const tc of tools ?? []) {
    tracer.event(
      makeEventRecord({
        adw_id: adw, phase_id: phase.phase_id, parent_id: startEvt, type: "tool_call", name: tc.tool,
        payload: { tool: tc.tool, tool_call_id: `tc_${Math.abs(Math.sin(t) * 1e9 | 0)}`, args: tc.args, result_snippet: tc.result, ok: tc.ok ?? true, duration_ms: tc.ms, agent: agent.name },
        started_at: at(startMin, t), ended_at: at(startMin, t + tc.ms / 1000),
        tokens: tc.tokens ?? null,
      }),
    );
    t += tc.ms / 1000 + 1.5;
  }
  const u = envelope.usage;
  tracer.event(
    makeEventRecord({
      adw_id: adw, phase_id: phase.phase_id, parent_id: startEvt, type: "agent_end", name: agent.name,
      payload: { cost: u.total_cost, usage: u, context_tokens: ctx.tokens, context_window: ctx.window },
      tokens: u.total_tokens, started_at: at(startMin, durSec), ended_at: at(startMin, durSec),
    }),
  );
  tracer.envelopeRow(phase, agent.name, envelope.type, JSON.stringify(envelope.payload), envelope.valid ?? true, phase.attempt);
  tracer.agentSessionRow(adw, agent, sessionId, ctx.tokens, ctx.window);
  tracer.sessionAddUsage(adw, u.total_tokens, u.total_cost);
}

function promptFiles(adw, agentName, system, user) {
  const dir = join(demoDir, "sessions", adw, agentName, "prompts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "system.md"), system);
  writeFileSync(join(dir, "user.md"), user);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. demo-plan-1 — the happy path: plan + build-test, two agents, all green
// ═════════════════════════════════════════════════════════════════════════════
{
  const adw = "demo-plan-1";
  tracer.sessionStart(adw, "jd", "plan");
  tracer.sessionStart(adw, "jd", "build-test");
  tracer.sessionRequest(adw, "Add a --json flag to spf sessions so watch scripts can consume run state without scraping the table output.");

  const p1 = phaseRow(adw, 1, "request", "engineer", "jd", { description: "operator request intake", started_at: at(120), ended_at: at(119) });
  tracer.phaseUpsert(p1);
  tracer.event(makeEventRecord({ adw_id: adw, phase_id: p1.phase_id, type: "phase_start", name: "request", started_at: at(120) }));
  tracer.event(makeEventRecord({ adw_id: adw, phase_id: p1.phase_id, type: "log", name: "request", payload: { input: "Add a --json flag to spf sessions" }, started_at: at(120) }));
  tracer.event(makeEventRecord({ adw_id: adw, phase_id: p1.phase_id, type: "phase_end", name: "request", started_at: at(119) }));

  const p2 = phaseRow(adw, 2, "plan", "agent", "planner", { description: "produce a bounded implementation plan", started_at: at(119), ended_at: at(112) });
  tracer.phaseUpsert(p2);
  agentPhase({
    adw, phase: p2, agent: AGENTS.planner, startMin: 119, durSec: 400, sessionId: "cc-sess-4f2a",
    tools: [
      { tool: "read", args: { path: "src/cli/commands/sessions.ts" }, result: "82 lines: renders the session table", ms: 900, tokens: 1200 },
      { tool: "grep", args: { pattern: "parseCli", glob: "src/cli/**" }, result: "14 matches across commands/", ms: 600, tokens: 400 },
      { tool: "read", args: { path: "src/core/utils.ts" }, result: "parseCli supports flags + options", ms: 700, tokens: 900 },
    ],
    envelope: {
      type: "PlanOutput", usage: usage(18000, 2400, 800, 52000, 9000), valid: true,
      payload: { status: "success", summary: "Add --json to sessions command; serialize SessionSummary[] straight from db.listSessions().", artifacts: ["docs/plans/sessions-json.md"], notes_for_next_agent: "Reuse the existing SfDb reader — do not open a second connection.", steps: ["extend parseCli flags", "branch on flags.json", "add ui_server test"] },
    },
    ctx: { tokens: 61000, window: 200000 },
  });
  tracer.gateRow(p2, "plan_quality", new GateReport().check("plan file exists", true, "docs/plans/sessions-json.md").check("steps are bounded", true, "3 steps, all in src/cli"), 0);
  promptFiles(adw, "planner",
    "# planner\n\nYou turn an operator request into a bounded, testable plan.\n\n- Stay inside the named repo.\n- Every step must name the file it touches.\n",
    "## Request\n\nAdd a `--json` flag to `spf sessions` so watch scripts can consume run state.\n\n## Constraints\n\n- No new dependencies.\n- Follow the existing parseCli pattern.\n");

  const p3 = phaseRow(adw, 3, "build", "agent", "builder", { description: "implement the plan", started_at: at(112), ended_at: at(101) });
  tracer.phaseUpsert(p3);
  agentPhase({
    adw, phase: p3, agent: AGENTS.builder, startMin: 112, durSec: 640, sessionId: "cc-sess-9b1c",
    tools: [
      { tool: "read", args: { path: "docs/plans/sessions-json.md" }, result: "3 steps", ms: 500, tokens: 600 },
      { tool: "edit", args: { path: "src/cli/commands/sessions.ts" }, result: "+18 -2", ms: 1400, tokens: 2100 },
      { tool: "edit", args: { path: "src/test/ui_server.test.ts" }, result: "+22", ms: 1100, tokens: 1600 },
      { tool: "bash", args: { command: "npm test" }, result: "47 passing", ms: 21000, tokens: 800 },
    ],
    envelope: {
      type: "BuildOutput", usage: usage(34000, 5200, 1600, 118000, 12000), valid: true,
      payload: { status: "success", summary: "sessions --json emits SessionSummary[]; table path untouched. Test added.", artifacts: ["src/cli/commands/sessions.ts", "src/test/ui_server.test.ts"], notes_for_next_agent: "" },
    },
    ctx: { tokens: 92000, window: 200000 },
  });
  promptFiles(adw, "builder",
    "# builder\n\nImplement exactly the plan you are handed. No scope creep.\n",
    "## Plan\n\nSee docs/plans/sessions-json.md — 3 steps.\n");

  const p4 = phaseRow(adw, 4, "quality", "code", "chain", { description: "typecheck + tests + size gate", started_at: at(101), ended_at: at(98) });
  tracer.phaseUpsert(p4);
  tracer.event(makeEventRecord({ adw_id: adw, phase_id: p4.phase_id, type: "log", name: "quality", payload: { checks: ["tsc --noEmit", "node --test", "size-check"] }, started_at: at(101) }));
  tracer.gateRow(p4, "quality_suite", new GateReport().check("tsc --noEmit", true, "0 errors").check("node --test", true, "47 passing").check("tarball size", true, "412 KB < 600 KB"), 0);
  tracer.event(makeEventRecord({ adw_id: adw, phase_id: p4.phase_id, type: "gate_pass", name: "quality_suite", payload: { violations: [] }, started_at: at(98) }));

  const p5 = phaseRow(adw, 5, "commit", "code", "chain", { description: "commit + branch push", started_at: at(98), ended_at: at(97) });
  tracer.phaseUpsert(p5);
  tracer.event(makeEventRecord({ adw_id: adw, phase_id: p5.phase_id, type: "handoff", name: "commit", payload: { branch: "spf/sessions-json", commit: "f3a9c21" }, started_at: at(97) }));
  tracer.sessionFinish(adw, true);
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. demo-fail-1 — retried build, invalid envelope, red gate, failed session
// ═════════════════════════════════════════════════════════════════════════════
{
  const adw = "demo-fail-1";
  tracer.sessionStart(adw, "jd", "build-test");
  tracer.sessionRequest(adw, "Migrate the tracer's events table to store payloads as JSONB.");

  const p1 = phaseRow(adw, 1, "request", "engineer", "jd", { started_at: at(64), ended_at: at(63) });
  tracer.phaseUpsert(p1);

  const p2 = phaseRow(adw, 2, "build", "agent", "builder", {
    description: "implement the migration", retries: 1, attempt: 1, status: "fail",
    error: "gate quality_suite failed after final attempt: node --test — 3 failing", started_at: at(63), ended_at: at(41),
  });
  tracer.phaseUpsert(p2);

  // attempt 0 — envelope did not parse
  tracer.event(makeEventRecord({ adw_id: adw, phase_id: p2.phase_id, type: "agent_start", name: "builder", payload: { model: AGENTS.builder.model, color: AGENTS.builder.color, coding_agent: "claude_code", purpose: AGENTS.builder.purpose, session_id: "cc-sess-77aa" }, started_at: at(63) }));
  tracer.envelopeRow(p2, "builder", "BuildOutput", JSON.stringify({ status: "success", summary: 42 }), false, 0);
  tracer.event(makeEventRecord({ adw_id: adw, phase_id: p2.phase_id, type: "error", name: "envelope_parse", payload: { error: "BuildOutput.summary: expected string, got number" }, started_at: at(58) }));

  // attempt 1 — parsed, but the gate stayed red
  agentPhase({
    adw, phase: p2, agent: AGENTS.builder, startMin: 56, durSec: 700, sessionId: "cc-sess-77aa",
    tools: [
      { tool: "edit", args: { path: "src/core/tracer.ts" }, result: "+41 -12", ms: 1800, tokens: 2600 },
      { tool: "bash", args: { command: "npm test" }, result: "3 failing: data_types, ui_server, otel", ms: 24000, ok: false, tokens: 1100 },
      { tool: "edit", args: { path: "src/core/tracer.ts" }, result: "+6 -6", ms: 900, tokens: 700 },
      { tool: "bash", args: { command: "npm test" }, result: "3 failing: data_types, ui_server, otel", ms: 23000, ok: false, tokens: 1100 },
    ],
    envelope: {
      type: "BuildOutput", usage: usage(52000, 8900, 3100, 160000, 21000), valid: true,
      payload: { status: "fail", summary: "JSONB rewrite breaks readers that string-compare payload_json; three suites red.", artifacts: ["src/core/tracer.ts"], notes_for_next_agent: "Readers must move to json_extract before the column type can change." },
    },
    ctx: { tokens: 148000, window: 200000 },
  });
  tracer.gateRow(p2, "quality_suite",
    new GateReport()
      .check("tsc --noEmit", true, "0 errors")
      .check("node --test", false, "3 failing: data_types, ui_server, otel")
      .check("protected_files untouched", true, ""),
    1);
  tracer.event(makeEventRecord({ adw_id: adw, phase_id: p2.phase_id, type: "gate_fail", name: "quality_suite", payload: { violations: ["node --test: 3 failing: data_types, ui_server, otel"] }, started_at: at(42) }));
  tracer.sessionFinish(adw, false);
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. demo-run-1 — live: one phase done, one agent mid-flight, one queued
// ═════════════════════════════════════════════════════════════════════════════
{
  const adw = "demo-run-1";
  tracer.sessionStart(adw, "jd", "plan");
  tracer.sessionRequest(adw, "Draft a rollout plan for per-agent token budgets with a hard session ceiling.");

  const p1 = phaseRow(adw, 1, "request", "engineer", "jd", { started_at: at(4), ended_at: at(3.8) });
  tracer.phaseUpsert(p1);
  tracer.event(makeEventRecord({ adw_id: adw, phase_id: p1.phase_id, type: "log", name: "request", payload: { input: "per-agent token budgets" }, started_at: at(4) }));

  const p2 = phaseRow(adw, 2, "plan", "agent", "planner", { status: "running", started_at: at(3.5) });
  tracer.phaseUpsert(p2);
  // In-flight: agent_start event exists, agent_sessions row does NOT — the
  // detail endpoint has to synthesize the lane from the event payload.
  const startEvt = tracer.event(makeEventRecord({
    adw_id: adw, phase_id: p2.phase_id, type: "agent_start", name: "planner",
    payload: { model: AGENTS.planner.model, thinking: "high", color: AGENTS.planner.color, coding_agent: "claude_code", purpose: AGENTS.planner.purpose, session_id: "cc-sess-live1" },
    started_at: at(3.5),
  }));
  tracer.event(makeEventRecord({ adw_id: adw, phase_id: p2.phase_id, parent_id: startEvt, type: "tool_call", name: "read", payload: { tool: "read", args: { path: "src/core/budget.ts" }, result_snippet: "run-level ceilings only today", ok: true, duration_ms: 800, agent: "planner" }, started_at: at(3.2), ended_at: at(3.1) }));
  tracer.event(makeEventRecord({ adw_id: adw, phase_id: p2.phase_id, parent_id: startEvt, type: "tool_call", name: "grep", payload: { tool: "grep", args: { pattern: "sessionAddUsage" }, result_snippet: "6 call sites", ok: true, duration_ms: 500, agent: "planner" }, started_at: at(2.5), ended_at: at(2.4) }));
  tracer.sessionAddUsage(adw, 21000, 0.41);

  const p3 = phaseRow(adw, 3, "review", "agent", "reviewer", { status: "queued" });
  tracer.phaseUpsert(p3);
  // no sessionFinish — this one stays "running"
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. demo-scout-1 — small read-only recon run, single flue agent
// ═════════════════════════════════════════════════════════════════════════════
{
  const adw = "demo-scout-1";
  tracer.sessionStart(adw, "jd", "scout");
  tracer.sessionRequest(adw, "Describe how the fanout command picks a winner between sibling runs.");
  const p1 = phaseRow(adw, 1, "scout", "agent", "scout", { started_at: at(33), ended_at: at(31) });
  tracer.phaseUpsert(p1);
  agentPhase({
    adw, phase: p1, agent: AGENTS.scout, startMin: 33, durSec: 110, sessionId: "flue-sess-0d3e",
    tools: [
      { tool: "read", args: { path: "src/cli/commands/fanout.ts" }, result: "spawns N worktree runs, scores envelopes", ms: 700, tokens: 900 },
      { tool: "read", args: { path: "src/core/budget.ts" }, result: "per-run spend ceilings", ms: 600, tokens: 700 },
    ],
    envelope: {
      type: "GenericOutput", usage: usage(9000, 1400, 300, 0, 4000), valid: true,
      payload: { status: "success", summary: "fanout runs N sibling worktrees, gates each, and picks the highest-scoring green envelope; budget.ts caps per-run spend.", artifacts: [], notes_for_next_agent: "" },
    },
    ctx: { tokens: 14000, window: 1048576 },
  });
  tracer.gateRow(p1, "read_only", new GateReport().check("no tracked file modified", true, "git status clean"), 0);
  tracer.sessionFinish(adw, true);
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. demo-arch-1 — yesterday's run, reviewed and archived
// ═════════════════════════════════════════════════════════════════════════════
{
  const adw = "demo-arch-1";
  tracer.sessionStart(adw, "jd", "build-test");
  tracer.sessionRequest(adw, "Bump lefthook and fix the pre-push hook's GIT_DIR leak.");
  const p1 = phaseRow(adw, 1, "request", "engineer", "jd", { started_at: at(1500), ended_at: at(1499) });
  tracer.phaseUpsert(p1);
  const p2 = phaseRow(adw, 2, "build", "agent", "builder", { started_at: at(1499), ended_at: at(1490) });
  tracer.phaseUpsert(p2);
  agentPhase({
    adw, phase: p2, agent: AGENTS.builder, startMin: 1499, durSec: 500, sessionId: "cc-sess-old01",
    tools: [{ tool: "edit", args: { path: "lefthook.yml" }, result: "+3 -3", ms: 800, tokens: 500 }],
    envelope: {
      type: "BuildOutput", usage: usage(12000, 1800, 500, 30000, 6000), valid: true,
      payload: { status: "success", summary: "lefthook 2.1.10; hook now unsets GIT_DIR before spawning.", artifacts: ["lefthook.yml"], notes_for_next_agent: "" },
    },
    ctx: { tokens: 31000, window: 200000 },
  });
  tracer.gateRow(p2, "quality_suite", new GateReport().check("node --test", true, "47 passing"), 0);
  tracer.sessionFinish(adw, true);
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. demo-longchain-1 — a 22-phase run: the phases column's overflow case
// ═════════════════════════════════════════════════════════════════════════════
{
  const adw = "demo-longchain-1";
  tracer.sessionStart(adw, "jd", "migrate");
  tracer.sessionRequest(adw, "Walk every call site off the deprecated envelope shape, file by file, verifying tests after each.");
  const PHASE_COUNT = 22;
  const FAIL_AT = 14; // one failure in the middle, well past the visible cap
  const RUNNING_AT = 19;
  for (let i = 1; i <= PHASE_COUNT; i++) {
    const status = i === FAIL_AT ? "fail" : i === RUNNING_AT ? "running" : i > RUNNING_AT ? "queued" : "success";
    const p = phaseRow(adw, i, `migrate_${String(i).padStart(2, "0")}`, "code", "chain", {
      description: `move call site ${i}/${PHASE_COUNT} off the old envelope shape`,
      status,
      started_at: status === "queued" ? null : at(PHASE_COUNT - i + 1),
      ended_at: status === "success" || status === "fail" ? at(PHASE_COUNT - i) : null,
    });
    tracer.phaseUpsert(p);
  }
  tracer.sessionAddUsage(adw, 8000, 0.12);
}

// ── backdate the rows the Tracer stamped with "now" ──────────────────────────
// sessionStart/Finish, envelopeRow, gateRow and agentSessionRow all stamp
// nowIso() internally; rewrite those so the list reads like real history.
const fix = new Database(dbPath);
const setSession = fix.query("UPDATE sessions SET started_at=?, ended_at=? WHERE adw_id=?");
setSession.run(minAgo(120), minAgo(97), "demo-plan-1");
setSession.run(minAgo(64), minAgo(41), "demo-fail-1");
fix.query("UPDATE sessions SET started_at=?, ended_at=NULL WHERE adw_id=?").run(minAgo(4), "demo-run-1");
setSession.run(minAgo(33), minAgo(31), "demo-scout-1");
setSession.run(minAgo(1500), minAgo(1490), "demo-arch-1");
fix.query("UPDATE sessions SET started_at=?, ended_at=NULL WHERE adw_id=?").run(minAgo(22), "demo-longchain-1");
fix.query("UPDATE sessions SET archived=1 WHERE adw_id=?").run("demo-arch-1");
for (const [adw, m] of [["demo-plan-1", 100], ["demo-fail-1", 42], ["demo-scout-1", 31], ["demo-arch-1", 1490]]) {
  fix.query("UPDATE envelopes SET created_at=? WHERE adw_id=?").run(minAgo(m), adw);
  fix.query("UPDATE gate_results SET created_at=? WHERE adw_id=?").run(minAgo(m), adw);
  fix.query("UPDATE agent_sessions SET created_at=?, last_used_at=? WHERE adw_id=?").run(minAgo(m + 5), minAgo(m), adw);
}
fix.close();

const check = new Database(dbPath, { readonly: true });
const counts = {};
for (const t of ["sessions", "phases", "events", "envelopes", "gate_results", "agent_sessions"]) {
  counts[t] = check.query(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
}
check.close();
console.log(`[seed] wrote ${dbPath}`);
console.log(`[seed] ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join("  ")}`);
console.log(`[seed] launch:  node dist/cli/bin.js ui --db tmp/demo/spf.db --port 4600 --no-open`);
console.log(`[seed] hot dev: npm --prefix app run dev   →  http://localhost:4601`);
