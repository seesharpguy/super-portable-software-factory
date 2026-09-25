/**
 * `core/jev.ts` — the Jev rails (#103). Every test here drives a
 * `FakeJevClient` (or a fake `fetch`) — none touches the network, per the
 * module header's invariant 8. Grouped by the invariant each one pins:
 *
 *   §1 off by default         — disabled/absent => no call, no record, fallback
 *   §3 fallback on everything — low confidence, timeout, error, invalid, no key
 *   §4 shadow vs act          — shadow calls+records but the fallback acts
 *   §5 recorded + replayable  — trace event round-trip, replay without a call
 *   config / merge / doctor   — schema defaults, layered merge, doctor checks
 */
import "./hermetic_git.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { JevConfigSchema, SFConfigSchema, type JevConfig } from "../core/data_types.js";
import { loadConfig } from "../core/agents.js";
import { Tracer } from "../core/tracer.js";
import {
  FALLBACK_REASONS,
  HttpJevClient,
  JEV_DECISION_EVENT,
  JevApiError,
  confidenceFromProbabilities,
  createJev,
  decisionsFromEvents,
  findRecordedDecision,
  jevDoctorChecks,
  jevEndpoint,
  listRecordedDecisions,
  parseDecisionExtras,
  parseRecordedDecision,
  resolveDecisionPolicy,
  setJevClientFactory,
  traceDecisionRecorder,
  type Decision,
  type DecisionRequest,
  type JevOption,
} from "../core/jev.js";
import { defineJevKind } from "../core/jev_kinds.js";
import { doctorCommand } from "../cli/commands/doctor.js";
import { FakeJevClient } from "./fake_jev.js";

type Risk = "low" | "standard" | "high";
const RISK_OPTIONS: JevOption<Risk>[] = [
  { value: "low", description: "a trivial, well-scoped change" },
  { value: "standard", description: "an ordinary change" },
  { value: "high", description: "a risky or broad change" },
];

function riskRequest(overrides: Partial<DecisionRequest<Risk>> = {}): DecisionRequest<Risk> {
  return {
    kind: "risk_tier",
    options: RISK_OPTIONS,
    instructions: "How risky is this change?",
    state: "rename a variable in README.md",
    fallback: "standard",
    ...overrides,
  };
}

function enabled(extra: Partial<JevConfig> = {}): Partial<JevConfig> {
  return { enabled: true, ...extra };
}

/** Collects what a Jev records, in order. */
function memoryRecorder(): { decisions: Decision[]; phases: string[]; recorder: (d: Decision, m: { phase_id: string }) => void } {
  const decisions: Decision[] = [];
  const phases: string[] = [];
  return { decisions, phases, recorder: (d, m) => void (decisions.push(d), phases.push(m.phase_id)) };
}

// ── §1 off by default ──────────────────────────────────────────────────────

test("jev: no config at all => fallback, reason disabled, zero calls, nothing recorded", async () => {
  const fake = FakeJevClient.choosing("high", 0.99);
  const mem = memoryRecorder();
  const jev = createJev({ client: fake, recorder: mem.recorder });
  const d = await jev.decide(riskRequest());
  assert.equal(d.choice, "standard");
  assert.equal(d.used_fallback, true);
  assert.equal(d.reason, "disabled");
  assert.equal(d.mode, "off");
  assert.equal(fake.calls.length, 0);
  assert.equal(mem.decisions.length, 0, "a disabled Jev must not write a trace event — the trace stays byte-identical");
});

test("jev: enabled:false with mode:act still never calls", async () => {
  const fake = FakeJevClient.choosing("high", 0.99);
  const jev = createJev({ config: { enabled: false, mode: "act" }, client: fake });
  const d = await jev.decide(riskRequest());
  assert.equal(d.reason, "disabled");
  assert.equal(fake.calls.length, 0);
});

test("jev: per-kind mode:off silences one kind — no call, no record — while others still run", async () => {
  const fake = FakeJevClient.choosing("high", 0.99);
  const mem = memoryRecorder();
  const jev = createJev({ config: enabled({ mode: "act", decisions: { risk_tier: { mode: "off" } } }), client: fake, recorder: mem.recorder });
  const off = await jev.decide(riskRequest());
  assert.equal(off.reason, "kind_off");
  assert.equal(fake.calls.length, 0);
  const other = await jev.decide(riskRequest({ kind: "other_kind" }));
  assert.equal(other.choice, "high");
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(mem.decisions.map((x) => x.kind), ["other_kind"]);
});

test("jev: request validation throws even when disabled — a bad call site fails its own unit test", async () => {
  const jev = createJev();
  await assert.rejects(jev.decide(riskRequest({ fallback: "bogus" as Risk })), /fallback "bogus" is not one of the options/);
  await assert.rejects(jev.decide(riskRequest({ options: [] })), /options is empty/);
  await assert.rejects(jev.decide(riskRequest({ options: [...RISK_OPTIONS, RISK_OPTIONS[0]!] })), /duplicate option values/);
  await assert.rejects(jev.decide(riskRequest({ permitted: ["low"] })), /permitted must include the fallback/);
  await assert.rejects(jev.decide(riskRequest({ question: "score", options: [RISK_OPTIONS[1]!], fallback: "standard" })), /2-10 levels/);
});

// ── §4 shadow vs act ───────────────────────────────────────────────────────

test("jev: shadow (the default mode) calls Jev and records it, but the fallback ACTS", async () => {
  const fake = FakeJevClient.choosing("high", 0.95);
  const mem = memoryRecorder();
  const jev = createJev({ config: enabled(), client: fake, recorder: mem.recorder });
  const d = await jev.decide(riskRequest({ phase_id: "ph_1" }));
  assert.equal(fake.calls.length, 1);
  assert.equal(d.mode, "shadow");
  assert.equal(d.choice, "standard", "shadow: the deterministic path acts");
  assert.equal(d.jev_choice, "high");
  assert.equal(d.confidence, 0.95);
  assert.equal(d.used_fallback, true);
  assert.equal(d.reason, "shadow");
  assert.equal(d.would_act, true, "valid + confident: act mode would have used it");
  assert.equal(d.agrees, false);
  assert.equal(mem.decisions.length, 1);
  assert.equal(mem.phases[0], "ph_1");
});

test("jev: the request sent is the closed option set, as choice criteria — Jev is never asked an open question", async () => {
  const fake = FakeJevClient.choosing("low", 0.9);
  const jev = createJev({ config: enabled({ model: "jev-1.13" }), client: fake });
  await jev.decide(riskRequest());
  const sent = fake.calls[0]!;
  assert.equal(sent.model, "jev-1.13");
  assert.equal(sent.state, "rename a variable in README.md");
  assert.deepEqual(sent.questions, {
    q0: {
      type: "choice",
      instructions: "How risky is this change?",
      criteria: { low: "a trivial, well-scoped change", standard: "an ordinary change", high: "a risky or broad change" },
    },
  });
});

test("jev: act + confident => Jev's choice acts", async () => {
  const fake = FakeJevClient.choosing("low", 0.91);
  const mem = memoryRecorder();
  const jev = createJev({ config: enabled({ mode: "act" }), client: fake, recorder: mem.recorder });
  const d = await jev.decide(riskRequest());
  assert.equal(d.choice, "low");
  assert.equal(d.used_fallback, false);
  assert.equal(d.reason, null);
  assert.equal(d.detail, "");
  assert.equal(d.would_act, true);
  assert.deepEqual(d.usage, { input_tokens: 10, output_tokens: 0 });
  assert.equal(mem.decisions.length, 1, "act decisions are recorded too");
});

test("jev: a per-kind mode:act overrides a global shadow", async () => {
  const jev = createJev({ config: enabled({ mode: "shadow", decisions: { risk_tier: { mode: "act" } } }), client: FakeJevClient.choosing("high", 0.9) });
  assert.equal((await jev.decide(riskRequest())).choice, "high");
});

// ── §3 fallback on every failure ───────────────────────────────────────────

test("jev: act + confidence below threshold => fallback, reason low_confidence", async () => {
  const jev = createJev({ config: enabled({ mode: "act", threshold: 0.8 }), client: FakeJevClient.choosing("high", 0.79) });
  const d = await jev.decide(riskRequest());
  assert.equal(d.choice, "standard");
  assert.equal(d.reason, "low_confidence");
  assert.equal(d.jev_choice, "high", "what Jev said is still recorded for shadow analysis");
  assert.match(d.detail, /0\.790 < threshold 0\.8/);
  assert.equal(d.would_act, false);
});

test("jev: a per-kind threshold overrides the global one", async () => {
  const jev = createJev({
    config: enabled({ mode: "act", threshold: 0.5, decisions: { risk_tier: { threshold: 0.95 } } }),
    client: FakeJevClient.choosing("high", 0.9),
  });
  assert.equal((await jev.decide(riskRequest())).reason, "low_confidence");
});

test("jev: no confidence field => derived from probabilities with (n*peak-1)/(n-1); neither => unknown => low_confidence", async () => {
  assert.equal(confidenceFromProbabilities({ a: 1, b: 0, c: 0 }, 3), 1);
  assert.equal(confidenceFromProbabilities({ a: 1 / 3, b: 1 / 3, c: 1 / 3 }, 3), 0);
  const derived = createJev({
    config: enabled({ mode: "act", threshold: 0.5 }),
    client: FakeJevClient.answering({ q0: { type: "choice", choice: "high", probabilities: { low: 0.05, standard: 0.05, high: 0.9 } } }),
  });
  const d = await derived.decide(riskRequest());
  assert.equal(d.choice, "high");
  assert.ok(Math.abs(d.confidence! - 0.85) < 1e-9);

  const unknown = createJev({ config: enabled({ mode: "act", threshold: 0 }), client: FakeJevClient.answering({ q0: { type: "choice", choice: "high" } }) });
  const u = await unknown.decide(riskRequest());
  assert.equal(u.reason, "low_confidence");
  assert.equal(u.confidence, null);
});

test("jev: timeout => fallback, reason timeout, bounded by timeout_ms even if the client never answers", async () => {
  const mem = memoryRecorder();
  const jev = createJev({ config: enabled({ mode: "act", timeout_ms: 25 }), client: FakeJevClient.hanging(), recorder: mem.recorder });
  const started = Date.now();
  const d = await jev.decide(riskRequest());
  assert.ok(Date.now() - started < 2_000);
  assert.equal(d.choice, "standard");
  assert.equal(d.reason, "timeout");
  assert.equal(mem.decisions[0]?.reason, "timeout", "failures are recorded too");
});

test("jev: HTTP error => fallback, reason error, status in detail", async () => {
  const jev = createJev({ config: enabled({ mode: "act" }), client: FakeJevClient.failing(new JevApiError(529, "overloaded")) });
  const d = await jev.decide(riskRequest());
  assert.equal(d.choice, "standard");
  assert.equal(d.reason, "error");
  assert.match(d.detail, /HTTP 529/);
});

test("jev: an answer outside the closed set => fallback, reason invalid_choice — Jev never invents an option", async () => {
  const jev = createJev({ config: enabled({ mode: "act" }), client: FakeJevClient.choosing("delete-the-gate", 0.99) });
  const d = await jev.decide(riskRequest());
  assert.equal(d.choice, "standard");
  assert.equal(d.reason, "invalid_choice");
  assert.equal(d.jev_choice, null);
});

test("jev: a missing or malformed answer => fallback, reason invalid_response", async () => {
  const missing = createJev({ config: enabled({ mode: "act" }), client: FakeJevClient.answering({}) });
  assert.equal((await missing.decide(riskRequest())).reason, "invalid_response");
  const malformed = createJev({ config: enabled({ mode: "act" }), client: FakeJevClient.answering({ q0: { choice: 42 } }) });
  assert.equal((await malformed.decide(riskRequest())).reason, "invalid_response");
});

test("jev: a valid answer outside `permitted` => fallback, reason not_permitted (monotone authority)", async () => {
  const jev = createJev({ config: enabled({ mode: "act" }), client: FakeJevClient.choosing("high", 0.99) });
  const d = await jev.decide(riskRequest({ permitted: ["low", "standard"] }));
  assert.equal(d.choice, "standard");
  assert.equal(d.reason, "not_permitted");
  assert.equal(d.jev_choice, "high");
});

test("jev: enabled with no API key and no injected client => no_api_key, no network", async () => {
  let fetched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error("must not fetch");
  }) as typeof fetch;
  try {
    const mem = memoryRecorder();
    const jev = createJev({ config: enabled({ mode: "act" }), env: {}, recorder: mem.recorder });
    const d = await jev.decide(riskRequest());
    assert.equal(d.reason, "no_api_key");
    assert.match(d.detail, /TYPESAFE_API_KEY is not set/);
    assert.equal(fetched, false);
    assert.equal(mem.decisions.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("jev: a throwing recorder never fails the decision", async () => {
  const jev = createJev({
    config: enabled({ mode: "act" }),
    client: FakeJevClient.choosing("low", 0.9),
    recorder: () => {
      throw new Error("db is gone");
    },
  });
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.equal((await jev.decide(riskRequest())).choice, "low");
  } finally {
    process.stderr.write = originalWrite;
  }
});

test("jev: FALLBACK_REASONS is the closed, ordered reason vocabulary", () => {
  assert.deepEqual(
    [...FALLBACK_REASONS],
    ["disabled", "kind_off", "replay_missing", "no_api_key", "timeout", "error", "invalid_response", "invalid_choice", "not_permitted", "low_confidence", "shadow"],
  );
});

// ── score + batch ──────────────────────────────────────────────────────────

test("jev: a score question maps the argmax level onto the ordered rubric", async () => {
  const fake = FakeJevClient.scoring(2, 0.9);
  const jev = createJev({ config: enabled({ mode: "act" }), client: fake });
  const d = await jev.decide(riskRequest({ question: "score" }));
  assert.equal(fake.calls[0]!.questions.q0!.type, "score");
  assert.deepEqual((fake.calls[0]!.questions.q0 as { criteria: string[] }).criteria, RISK_OPTIONS.map((o) => o.description));
  assert.equal(d.question, "score");
  assert.equal(d.choice, "high");
  assert.equal(d.score, 2);
});

test("jev: a 1-based score legend is detected; an out-of-range level is invalid_choice", async () => {
  const oneBased = createJev({
    config: enabled({ mode: "act" }),
    client: FakeJevClient.answering({ q0: { type: "score", score: 1.2, legend: { "1": "a", "2": "b", "3": "c" }, confidence: 0.9 } }),
  });
  assert.equal((await oneBased.decide(riskRequest({ question: "score" }))).choice, "low");
  const outOfRange = createJev({ config: enabled({ mode: "act" }), client: FakeJevClient.answering({ q0: { type: "score", score: 7, confidence: 0.9 } }) });
  assert.equal((await outOfRange.decide(riskRequest({ question: "score" }))).reason, "invalid_choice");
});

test("jev: decideBatch sends ONE call for every live item, skips off kinds, and returns results in item order", async () => {
  const fake = new FakeJevClient(() => ({
    answers: { q0: { type: "choice", choice: "noise", confidence: 0.9 }, q2: { type: "choice", choice: "real", confidence: 0.4 } },
  }));
  const mem = memoryRecorder();
  const jev = createJev({ config: enabled({ mode: "act", decisions: { muted: { mode: "off" } } }), client: fake, recorder: mem.recorder });
  const options: JevOption<"real" | "noise">[] = [
    { value: "real", description: "a real defect" },
    { value: "noise", description: "not actionable" },
  ];
  const results = await jev.decideBatch("the diff", [
    { kind: "finding_triage", key: "f1", options, instructions: "finding 1", fallback: "real" },
    { kind: "muted", key: "f2", options, instructions: "finding 2", fallback: "real" },
    { kind: "finding_triage", key: "f3", options, instructions: "finding 3", fallback: "real" },
  ]);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(Object.keys(fake.calls[0]!.questions), ["q0", "q2"]);
  assert.deepEqual(results.map((r) => [r.key, r.choice, r.reason]), [["f1", "noise", null], ["f2", "real", "kind_off"], ["f3", "real", "low_confidence"]]);
  assert.deepEqual(mem.decisions.map((d) => d.key), ["f1", "f3"]);
});

// ── §5 recorded + replayable ───────────────────────────────────────────────

test("jev: decisions round-trip through the real trace db as one log/jev_decision event, and replay reuses them without a call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-jev-trace-"));
  try {
    const tracer = await Tracer.open(join(dir, "trace.db"), join(dir, "events.jsonl"));
    const fake = FakeJevClient.choosing("high", 0.93);
    const jev = createJev({ config: enabled({ mode: "act" }), client: fake, recorder: traceDecisionRecorder(tracer, "adw_1") });
    const live = await jev.decide(riskRequest({ key: "run", phase_id: "ph_x" }));
    await jev.decide(riskRequest({ key: "other" }));

    const rows = (await tracer.db.query("SELECT type, name, phase_id FROM events WHERE adw_id=?").all("adw_1")) as Array<{ type: string; name: string; phase_id: string }>;
    assert.deepEqual(rows.map((r) => [r.type, r.name]), [["log", JEV_DECISION_EVENT], ["log", JEV_DECISION_EVENT]]);
    assert.equal(rows[0]!.phase_id, "ph_x");

    const recorded = await findRecordedDecision(tracer.db, "adw_1", "risk_tier", "run");
    assert.ok(recorded);
    assert.equal(recorded!.choice, "high");
    assert.equal(recorded!.input_sha256, live.input_sha256);
    assert.equal((await listRecordedDecisions(tracer.db, "adw_1")).length, 2);
    assert.equal(await findRecordedDecision(tracer.db, "adw_1", "risk_tier", "nope"), null);

    // Replay: a fresh Jev with a client that would answer differently is never called.
    const replayFake = FakeJevClient.choosing("low", 0.99);
    const replayJev = createJev({ config: enabled({ mode: "act" }), client: replayFake });
    const replayed = await replayJev.decide(riskRequest({ key: "run", replay: recorded }));
    assert.equal(replayFake.calls.length, 0);
    assert.equal(replayed.choice, "high");
    assert.equal(replayed.replayed, true);

    // replay: null => "replay mode, nothing recorded" => fallback, still no call.
    const missing = await replayJev.decide(riskRequest({ key: "run", replay: null }));
    assert.equal(missing.reason, "replay_missing");
    assert.equal(replayFake.calls.length, 0);

    // A recorded decision for a different question is not a replay of this one.
    const mismatched = await replayJev.decide(riskRequest({ key: "run", fallback: "low", replay: recorded }));
    assert.equal(mismatched.choice, "low");
    assert.equal(mismatched.reason, "replay_missing");
    assert.equal(replayFake.calls.length, 0);
    await tracer.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("jev: decisionsFromEvents/parseRecordedDecision ignore foreign and corrupt payloads", () => {
  const good = { kind: "k", options: ["a", "b"], choice: "a", fallback: "b", used_fallback: false, mode: "act" };
  assert.ok(parseRecordedDecision(good));
  assert.equal(parseRecordedDecision({ ...good, choice: "zzz" }), null, "a choice outside its own options is not a decision");
  assert.equal(parseRecordedDecision({ tiering: true }), null);
  const found = decisionsFromEvents([
    { type: "log", name: "tiering", payload: good },
    { type: "log", name: JEV_DECISION_EVENT, payload: { junk: 1 } },
    { type: "log", name: JEV_DECISION_EVENT, payload: good },
  ]);
  assert.equal(found.length, 1);
});

test("jev: setJevClientFactory injects a fake process-wide, for code that builds its own Jev", async () => {
  const fake = FakeJevClient.choosing("low", 0.9);
  setJevClientFactory(() => fake);
  try {
    const jev = createJev({ config: enabled({ mode: "act" }), env: {} });
    assert.equal((await jev.decide(riskRequest())).choice, "low", "the override needs no API key");
  } finally {
    setJevClientFactory(null);
  }
  assert.equal((await createJev({ config: enabled(), env: {} }).decide(riskRequest())).reason, "no_api_key");
});

// ── HttpJevClient (fake fetch — never the real network) ─────────────────────

test("jev: HttpJevClient POSTs {model,state,questions} to <base>/systemone with a Bearer key; non-2xx => JevApiError", async () => {
  assert.equal(jevEndpoint(""), "https://api.typesafe.ai/v1/systemone");
  assert.equal(jevEndpoint("https://proxy.example/v1/"), "https://proxy.example/v1/systemone");
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ model: "jev-1.13", answers: { q0: { type: "choice", choice: "low", confidence: 0.9 } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new HttpJevClient({ apiKey: "sk-test", fetchImpl });
  const jev = createJev({ config: enabled({ mode: "act" }), client });
  const d = await jev.decide(riskRequest());
  assert.equal(d.choice, "low");
  assert.equal(d.model, "jev-1.13");
  assert.equal(seen[0]!.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal((seen[0]!.init.headers as Record<string, string>).authorization, "Bearer sk-test");
  assert.deepEqual(Object.keys(JSON.parse(seen[0]!.init.body as string)), ["model", "state", "questions"]);

  const failing = new HttpJevClient({ apiKey: "sk-test", fetchImpl: (async () => new Response("rate limited", { status: 429 })) as unknown as typeof fetch });
  const failed = await createJev({ config: enabled({ mode: "act" }), client: failing }).decide(riskRequest());
  assert.equal(failed.reason, "error");
  assert.match(failed.detail, /HTTP 429/);
  assert.doesNotMatch(failed.detail, /sk-test/);
});

// ── config ─────────────────────────────────────────────────────────────────

test("jev config: defaults — off, shadow, jev-latest, 0.7, 2000ms, TYPESAFE_API_KEY, official endpoint", () => {
  const cfg = v.parse(SFConfigSchema, {});
  assert.deepEqual(cfg.jev, {
    enabled: false,
    mode: "shadow",
    model: "jev-latest",
    threshold: 0.7,
    timeout_ms: 2000,
    api_key_env: "TYPESAFE_API_KEY",
    base_url: "",
    decisions: {},
  });
});

test("jev config: rejects an unknown mode, a threshold outside 0-1, and a non-positive timeout", () => {
  assert.throws(() => v.parse(JevConfigSchema, { mode: "yolo" }));
  assert.throws(() => v.parse(JevConfigSchema, { threshold: 1.5 }));
  assert.throws(() => v.parse(JevConfigSchema, { timeout_ms: 0 }));
  assert.throws(() => v.parse(JevConfigSchema, { decisions: { risk_tier: { mode: "maybe" } } }));
});

test("jev config: per-kind entries keep feature extras, and resolveDecisionPolicy layers them over the globals", () => {
  const cfg = v.parse(JevConfigSchema, { enabled: true, threshold: 0.6, decisions: { risk_tier: { mode: "act", timeout_ms: 500, include_diffstat: true } } });
  assert.deepEqual(resolveDecisionPolicy(cfg, "risk_tier"), {
    kind: "risk_tier",
    mode: "act",
    threshold: 0.6,
    timeout_ms: 500,
    model: "jev-latest",
    extras: { include_diffstat: true },
  });
  assert.equal(resolveDecisionPolicy({ ...cfg, enabled: false }, "risk_tier").mode, "off", "global enabled:false beats any per-kind mode");
  const spec = defineJevKind({ kind: "risk_tier", summary: "s", question: "choice", extras: v.object({ include_diffstat: v.optional(v.boolean(), false) }) });
  assert.deepEqual(parseDecisionExtras(cfg, spec), { include_diffstat: true });
  assert.deepEqual(parseDecisionExtras({}, spec), { include_diffstat: false });
  assert.throws(() => parseDecisionExtras({ decisions: { risk_tier: { include_diffstat: "yes" } } }, spec), /jev\.decisions\.risk_tier: include_diffstat/);
  assert.throws(() => defineJevKind({ kind: "Bad Kind", summary: "", question: "choice" }), /snake_case/);
});

test("jev config: survives loadConfig and merges key-by-key across layered files; decisions is a whole-object replace", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-jev-merge-"));
  try {
    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(base, "jev:\n  threshold: 0.9\n  model: jev-1.13\n  decisions:\n    a: {mode: act}\n    b: {mode: off}\n");
    writeFileSync(override, "jev:\n  enabled: true\n  decisions:\n    c: {threshold: 0.5}\n");
    const cfg = loadConfig([base, override]);
    assert.equal(cfg.jev.enabled, true);
    assert.equal(cfg.jev.threshold, 0.9, "base's scalar survives an override that did not name it");
    assert.equal(cfg.jev.model, "jev-1.13");
    assert.deepEqual(Object.keys(cfg.jev.decisions), ["c"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── doctor ─────────────────────────────────────────────────────────────────

test("jev doctor: disabled is invisible; enabled without a key warns (never fails); bad base_url fails; unknown kind warns; bad extras fail", () => {
  assert.deepEqual(jevDoctorChecks({ decisions: { whatever: {} } }, {}), []);

  const noKey = jevDoctorChecks({ enabled: true }, {});
  const keyCheck = noKey.find((c) => c.name === "jev api key")!;
  assert.equal(keyCheck.ok, true);
  assert.equal(keyCheck.severity, "warn");
  assert.match(keyCheck.detail, /TYPESAFE_API_KEY is not set/);
  assert.ok(noKey.every((c) => c.ok));

  const withKey = jevDoctorChecks({ enabled: true, api_key_env: "MY_JEV_KEY" }, { MY_JEV_KEY: "x" });
  assert.equal(withKey.find((c) => c.name === "jev api key")!.severity, "info");

  const badUrl = jevDoctorChecks({ enabled: true, base_url: "not a url" }, {});
  assert.equal(badUrl.find((c) => c.name === "jev base_url")?.ok, false);

  const unknown = jevDoctorChecks({ enabled: true, decisions: { risk_teir: {} } }, {}, {});
  const u = unknown.find((c) => c.name === 'jev decision "risk_teir"')!;
  assert.equal(u.ok, true);
  assert.equal(u.severity, "warn");

  const kinds = { risk_tier: defineJevKind({ kind: "risk_tier", summary: "risk", question: "choice", extras: v.object({ n: v.optional(v.number(), 1) }) }) };
  const bad = jevDoctorChecks({ enabled: true, decisions: { risk_tier: { n: "x" } } }, {}, kinds);
  assert.equal(bad.find((c) => c.name === 'jev decision "risk_tier"')!.ok, false);
  const good = jevDoctorChecks({ enabled: true, decisions: { risk_tier: { n: 2, mode: "act" } } }, {}, kinds);
  assert.match(good.find((c) => c.name === 'jev decision "risk_tier"')!.detail, /mode=act/);
});

test("jev doctor: spf doctor --json surfaces the api-key warning when jev is enabled, and nothing jev-related when it is not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-jev-doctor-"));
  const saved = process.env["SPF_JEV_DOCTOR_TEST_KEY"];
  delete process.env["SPF_JEV_DOCTOR_TEST_KEY"];
  const run = async (): Promise<{ checks: Array<{ name: string; ok: boolean; severity?: string }> }> => {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    console.error = () => {};
    try {
      await doctorCommand(["--cwd", dir, "--json", "--no-probe"]);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    return JSON.parse(logs.join("\n"));
  };
  try {
    mkdirSync(join(dir, ".spf"), { recursive: true });
    writeFileSync(join(dir, ".spf", "spf.config.yaml"), "watch:\n  repo: acme/widgets\n");
    const off = await run();
    assert.equal(off.checks.filter((c) => c.name.startsWith("jev")).length, 0);

    writeFileSync(join(dir, ".spf", "spf.config.yaml"), "watch:\n  repo: acme/widgets\njev:\n  enabled: true\n  api_key_env: SPF_JEV_DOCTOR_TEST_KEY\n");
    const on = await run();
    const key = on.checks.find((c) => c.name === "jev api key");
    assert.ok(key);
    assert.equal(key!.ok, true);
    assert.equal(key!.severity, "warn");
  } finally {
    if (saved !== undefined) process.env["SPF_JEV_DOCTOR_TEST_KEY"] = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
