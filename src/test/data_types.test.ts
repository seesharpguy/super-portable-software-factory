/**
 * Regression tests for the zod -> Valibot conversion. Not exhaustive schema
 * tests — these guard the three specific things that conversion could get
 * wrong: the three-state writes/tools semantics that hard rule 9 depends on,
 * default-value reference freshness (verified NOT to be a live bug in
 * valibot 1.4.2 — see the comment below — kept as a tripwire against a
 * future version regressing it), and toJsonSchema staying convertible now
 * that it backs the sf_report tool wiring landing in the Flue phase.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import {
  AgentConfigSchema,
  BuildOutput,
  ChangesOutput,
  DocumentOutput,
  EventRecordTypeSchema,
  GenericOutput,
  NotificationsConfigSchema,
  PhaseParamsSchema,
  PlanOutput,
  RefineOutput,
  ReviewConfigSchema,
  ReviewOutput,
  ScoutOutput,
  SFConfigSchema,
  TierSchema,
  TieringConfigSchema,
  VerifyOutput,
  WatchConfigSchema,
  WatchFanoutConfigSchema,
  clampPriority,
  makePhaseParams,
} from "../core/data_types.js";
import { agentEnv, loadConfig } from "../core/agents.js";

test("writes: three-state semantics — absent, null, and [] all mean something different", () => {
  const base = { name: "builder", prompt_engineering: { system: "s.md", user: "u.md" } };

  const unrestricted = v.parse(AgentConfigSchema, base);
  assert.equal(unrestricted.writes, undefined, "key absent -> undefined (unrestricted)");

  const explicitNull = v.parse(AgentConfigSchema, { ...base, writes: null });
  assert.equal(explicitNull.writes, null, "explicit null -> null (also unrestricted)");

  const readOnly = v.parse(AgentConfigSchema, { ...base, writes: [] });
  assert.deepEqual(readOnly.writes, [], "explicit [] -> read-only, must stay an empty array, not undefined/null");

  const allowlisted = v.parse(AgentConfigSchema, { ...base, writes: ["specs/"] });
  assert.deepEqual(allowlisted.writes, ["specs/"]);

  assert.throws(() => v.parse(AgentConfigSchema, { ...base, writes: "specs/" }), "a bare string must not be silently accepted as an allowlist");
});

test("array defaults never alias across parses (tripwire, not a fix — see module comment)", () => {
  const first = v.parse(BuildOutput.schema, { status: "success" });
  const second = v.parse(BuildOutput.schema, { status: "success" });
  first.artifacts.push("should-not-leak");
  first.changed_files.push("should-not-leak");
  assert.deepEqual(second.artifacts, [], "a later parse must not see an earlier parse's push");
  assert.deepEqual(second.changed_files, []);
  assert.notEqual(first.artifacts, second.artifacts, "distinct array references");
});

test("PhaseParamsSchema rejects a blank description and an echo of the name, with the exact messages", () => {
  assert.throws(
    () => makePhaseParams({ name: "commit_plan", kind: "code", owner: "git", description: "   " }),
    /description is required/,
  );
  assert.throws(
    () => makePhaseParams({ name: "commit_plan", kind: "code", owner: "git", description: "Commit Plan" }),
    /only restates the phase name/,
  );
  const ok = makePhaseParams({ name: "commit_plan", kind: "code", owner: "git", description: "  Commit the plan file to the repo  " });
  assert.equal(ok.description, "Commit the plan file to the repo", "whitespace is collapsed, not just trimmed");
});

test("every envelope type still converts to JSON Schema (the sf_report tool wiring depends on this)", () => {
  for (const envelope of [GenericOutput, PlanOutput, BuildOutput, ScoutOutput, ReviewOutput, DocumentOutput, ChangesOutput, VerifyOutput, RefineOutput]) {
    assert.doesNotThrow(() => toJsonSchema(envelope.schema), `${envelope.name} must stay convertible — no rawTransform allowed on an envelope schema`);
  }
});

test("RefineOutput: questions defaults to [] when absent — a pre-existing issues-only payload parses byte-identical to before this field existed", () => {
  const withoutQuestions = v.parse(RefineOutput.schema, {
    status: "success",
    issues: [{ key: "S1", kind: "story", title: "A leaf", body: "## What to build" }],
  });
  assert.deepEqual(withoutQuestions.questions, []);

  const withQuestions = v.parse(RefineOutput.schema, {
    status: "success",
    issues: [],
    questions: [{ id: "Q1", question: "Should invitations expire?" }],
  });
  assert.equal(withQuestions.questions.length, 1);
  assert.equal(withQuestions.questions[0]!.id, "Q1");
  assert.equal(withQuestions.questions[0]!.why_it_matters, "", "optional question fields still default like the rest of the envelope schemas");
});

test("RefineOutput: a node's priority defaults to p2 when the model omits it", () => {
  const parsed = v.parse(RefineOutput.schema, {
    status: "success",
    issues: [{ key: "S1", kind: "story", title: "A leaf", body: "## What to build" }],
  });
  assert.equal(parsed.issues[0]!.priority, "p2");

  const explicit = v.parse(RefineOutput.schema, {
    status: "success",
    issues: [{ key: "S1", kind: "story", title: "A leaf", body: "## What to build", priority: "p0" }],
  });
  assert.equal(explicit.issues[0]!.priority, "p0");
});

test("clampPriority: pulls a node down to the ceiling when it outranks it, never raises it, and no-ops on a nullish ceiling", () => {
  assert.equal(clampPriority("p0", "p2"), "p2", "p0 outranks p2 — clamp down");
  assert.equal(clampPriority("p3", "p2"), "p3", "p3 does not outrank p2 — left alone");
  assert.equal(clampPriority("p2", "p2"), "p2", "equal to the ceiling — left alone");
  assert.equal(clampPriority("p0", null), "p0", "no ceiling — no-op");
  assert.equal(clampPriority("p0", undefined), "p0", "no ceiling — no-op");
});

test("PhaseParamsSchema itself (the one schema WITH a rawTransform) correctly refuses JSON Schema conversion", () => {
  assert.throws(() => toJsonSchema(PhaseParamsSchema), /raw_transform/);
});

test("NotificationsConfigSchema defaults to off, no channels", () => {
  const parsed = v.parse(NotificationsConfigSchema, {});
  assert.equal(parsed.events, "off");
  assert.equal(parsed.timeout_ms, 5_000);
  assert.deepEqual(parsed.channels, []);
});

test("a channel's own `events` overrides the top-level scope; unset inherits it", () => {
  const parsed = v.parse(NotificationsConfigSchema, {
    events: "errors",
    channels: [{ kind: "slack" }, { kind: "teams", events: "all" }],
  });
  assert.equal(parsed.channels[0]!.events, undefined, "unset per-channel scope stays undefined, not defaulted to the top-level value — the caller inherits at read time");
  assert.equal(parsed.channels[1]!.events, "all");
});

test("notifications survives loadConfig's merge — key-by-key like observability/quality, channels replaced wholesale on override", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-notify-merge-test-"));
  try {
    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(
      base,
      "notifications:\n  events: off\n  channels:\n    - {kind: webhook, webhook_url_env: BASE_HOOK}\n",
    );
    writeFileSync(
      override,
      "notifications:\n  events: all\n  channels:\n    - {kind: slack, webhook_url_env: SLACK_WEBHOOK_URL}\n",
    );
    const cfg = loadConfig([base, override]);
    assert.equal(cfg.notifications.events, "all", "events: key-by-key, override wins");
    assert.deepEqual(
      cfg.notifications.channels.map((c) => c.kind),
      ["slack"],
      "channels: a whole-array replace, not an append — same semantics as quality.checks",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ReviewConfigSchema: defaults to require_human_signoff=false, signoff_timeout_seconds=300", () => {
  const parsed = v.parse(ReviewConfigSchema, {});
  assert.equal(parsed.require_human_signoff, false, "this release fails OPEN by default — see the schema's own doc comment");
  assert.equal(parsed.signoff_timeout_seconds, 300);
});

// The silent-drop trap: mergeRawConfig (core/agents.ts) is a FIXED-SHAPE
// object literal, so a `review:` key in a real config file that isn't named
// on both sides of that literal is dropped before SFConfigSchema ever sees
// it — parsing would then succeed anyway, quietly, on the schema default.
// This is adversarial history on this branch, not a hypothetical: it is
// exactly the bug `observability`/`notifications` already guard against, and
// `review` gets the same guard the day it is added.
test("review survives loadConfig's merge — the silent-drop trap mergeRawConfig's fixed-shape literal sets, for a single config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-review-merge-test-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, "review:\n  require_human_signoff: true\n  signoff_timeout_seconds: 45\n");
    const cfg = loadConfig([configPath]);
    assert.equal(cfg.review.require_human_signoff, true, "a review: value from a real config file must reach SFConfig, not be dropped by mergeRawConfig's object literal");
    assert.equal(cfg.review.signoff_timeout_seconds, 45);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review merges key-by-key across two layered config files, like observability/notifications", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-review-merge-layered-test-"));
  try {
    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(base, "review:\n  require_human_signoff: false\n  signoff_timeout_seconds: 120\n");
    writeFileSync(override, "review:\n  require_human_signoff: true\n");
    const cfg = loadConfig([base, override]);
    assert.equal(cfg.review.require_human_signoff, true, "override wins for the key it names");
    assert.equal(cfg.review.signoff_timeout_seconds, 120, "unset in the override -> the base's value survives, key-by-key, not a whole-block replace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env: defaults to {} — SFConfigSchema parses fine with no env: key at all", () => {
  const cfg = loadConfig([]);
  assert.deepEqual(cfg.env, {});
});

test("env survives loadConfig's merge — the silent-drop trap mergeRawConfig's fixed-shape literal sets, for a single config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-env-merge-test-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, 'env:\n  SPF_CLAUDE_CMD: "ollama launch claude --model {model}"\n');
    const cfg = loadConfig([configPath]);
    assert.deepEqual(cfg.env, { SPF_CLAUDE_CMD: "ollama launch claude --model {model}" }, "an env: value from a real config file must reach SFConfig, not be dropped by mergeRawConfig's object literal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env merges key-by-key across two layered config files, like defaults/watch — an override adding one key keeps the base's other keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-env-merge-layered-test-"));
  try {
    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(base, "env:\n  SPF_CLAUDE_CMD: claude\n  FOO: base-value\n");
    writeFileSync(override, "env:\n  SPF_CLAUDE_CMD: ollama launch claude --model {model}\n");
    const cfg = loadConfig([base, override]);
    assert.equal(cfg.env.SPF_CLAUDE_CMD, "ollama launch claude --model {model}", "override wins for the key it names");
    assert.equal(cfg.env.FOO, "base-value", "unset in the override -> the base's value survives, key-by-key, not a whole-block replace");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WatchConfigSchema: chain_options defaults to {} — an existing watch: config with no chain_options is unaffected", () => {
  const parsed = v.parse(WatchConfigSchema, {});
  assert.deepEqual(parsed.chain_options, {});
});

// watch.chain_options — fix for PR #20's stated KNOWN LIMITATION: an
// unattended `spf watch` dispatch used to call runChainDef with no options
// at all, so nothing --suite-shaped could ever reach it (see
// cli/commands/watch.ts / core/watch.ts). `watch` itself is spread WHOLE by
// mergeRawConfig (not enumerated field-by-field), so a new WatchConfigSchema
// field like this one already passes through that spread — the boundary
// that actually matters is WatchConfigSchema itself, which is what this
// pins.
test("watch.chain_options survives loadConfig's merge for a single config file — not stripped by mergeRawConfig or by WatchConfigSchema", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-watch-chain-options-merge-test-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, "watch:\n  chain: plan-build-test\n  chain_options:\n    suite: strict\n");
    const cfg = loadConfig([configPath]);
    assert.deepEqual(cfg.watch.chain_options, { suite: "strict" }, "a watch.chain_options value from a real config file must reach SFConfig, not be dropped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watch.chain_options is a whole-map replace across layered config files, like observability.otel — not merged key-by-key", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-watch-chain-options-merge-layered-test-"));
  try {
    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(base, "watch:\n  chain_options:\n    suite: base-suite\n    agent: base-agent\n");
    writeFileSync(override, "watch:\n  chain_options:\n    suite: override-suite\n");
    const cfg = loadConfig([base, override]);
    assert.deepEqual(
      cfg.watch.chain_options,
      { suite: "override-suite" },
      "override replaces the whole chain_options map — the base's agent key does not survive alongside it",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// watch.fanout — best-of-N per claimed issue (core/watch.ts's design doc).
// `watch` is spread WHOLE by mergeRawConfig (see the chain_options tests
// above), so the boundary that actually matters for a new WatchConfigSchema
// field is WatchConfigSchema itself, which is what these pin.
test("WatchFanoutConfigSchema defaults: n=1, concurrency=2", () => {
  const parsed = v.parse(WatchFanoutConfigSchema, {});
  assert.deepEqual(parsed, { n: 1, concurrency: 2 });
});

test("watch.fanout defaults — a watch: block with no fanout: key parses to {n: 1, concurrency: 2}", () => {
  const parsed = v.parse(WatchConfigSchema, {});
  assert.deepEqual(parsed.fanout, { n: 1, concurrency: 2 });
});

test("watch.fanout survives loadConfig's merge for a single config file — not stripped by mergeRawConfig or by WatchConfigSchema", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-watch-fanout-merge-test-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, "watch:\n  chain: plan-build-test\n  fanout:\n    n: 3\n");
    const cfg = loadConfig([configPath]);
    assert.equal(cfg.watch.fanout.n, 3, "a watch.fanout.n value from a real config file must reach SFConfig, not be dropped");
    assert.equal(cfg.watch.fanout.concurrency, 2, "concurrency keeps its own schema default since the file above never set it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watch.fanout is a whole-object replace across layered config files, like watch.jira/watch.refine", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-watch-fanout-merge-layered-test-"));
  try {
    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(base, "watch:\n  fanout:\n    n: 3\n    concurrency: 4\n");
    writeFileSync(override, "watch:\n  fanout:\n    n: 2\n");
    const cfg = loadConfig([base, override]);
    assert.deepEqual(
      cfg.watch.fanout,
      { n: 2, concurrency: 2 },
      "override replaces the whole fanout object — the base's concurrency: 4 does not survive alongside the override's n: 2; concurrency falls back to the schema default",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watch.fanout.n rejects 0 and 9 — the schema bounds (minValue(1), maxValue(8)) fail at loadConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-watch-fanout-bounds-test-"));
  try {
    const tooLow = join(dir, "too-low.yaml");
    writeFileSync(tooLow, "watch:\n  fanout:\n    n: 0\n");
    assert.throws(() => loadConfig([tooLow]), /invalid config/);

    const tooHigh = join(dir, "too-high.yaml");
    writeFileSync(tooHigh, "watch:\n  fanout:\n    n: 9\n");
    assert.throws(() => loadConfig([tooHigh]), /invalid config/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// observability.otel is the one nested OBJECT under a top-level key that
// mergeRawConfig spreads field-by-field, so its merge semantics differ from its
// siblings' and are worth pinning: `otel:` is replaced as a WHOLE OBJECT by an
// override that names it (you never want a half-merged endpoint/headers pair —
// that is how an auth token gets POSTed to the wrong collector), while
// `observability`'s other keys still merge key-by-key around it. Also the
// activation contract: absent by default, so no repo starts exporting because
// it upgraded.
test("observability.otel survives loadConfig's merge — absent by default, whole-object replace on override", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-otel-merge-test-"));
  try {
    const bare = join(dir, "bare.yaml");
    writeFileSync(bare, "observability:\n  poll_ms: 250\n");
    assert.equal(loadConfig([bare]).observability.otel, undefined, "no otel: block -> export stays off, the default for every repo");

    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(
      base,
      "observability:\n  poll_ms: 250\n  otel:\n    endpoint: http://base-collector:4318/v1/traces\n    headers: {authorization: base-token}\n    service_name: base\n",
    );
    writeFileSync(override, "observability:\n  otel:\n    endpoint: http://override-collector:4318/v1/traces\n");
    const cfg = loadConfig([base, override]);
    assert.equal(cfg.observability.poll_ms, 250, "observability's other keys still merge key-by-key around otel");
    assert.equal(cfg.observability.otel?.endpoint, "http://override-collector:4318/v1/traces");
    assert.equal(cfg.observability.otel?.headers, undefined, "whole-object replace: the base's auth header does NOT follow the override's endpoint");
    assert.equal(cfg.observability.otel?.service_name, "spf", "and the base's service_name doesn't either — the schema default applies");

    // A single config file must reach SFConfig at all — the silent-drop trap
    // mergeRawConfig's fixed-shape object literal sets for any new key.
    const single = join(dir, "single.yaml");
    writeFileSync(single, "observability:\n  otel:\n    endpoint: https://collector.example.com/v1/traces\n");
    assert.equal(loadConfig([single]).observability.otel?.endpoint, "https://collector.example.com/v1/traces");

    // A typo fails at config load, not as a silent per-run export failure.
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, "observability:\n  otel:\n    endpoint: not-a-url\n");
    assert.throws(() => loadConfig([bad]), /invalid config/, "endpoint is URL-validated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EventRecordTypeSchema accepts every observed event type and rejects an unknown one", () => {
  for (const type of ["phase_start", "agent_start", "tool_call", "handoff", "gate_pass", "gate_fail", "log", "agent_end", "phase_end", "error"]) {
    assert.equal(v.parse(EventRecordTypeSchema, type), type);
  }
  assert.throws(() => v.parse(EventRecordTypeSchema, "bogus_type"), "an event type outside the observed set must be rejected, not silently stored");
});

test("AgentConfigSchema: env_allowlist is optional and defaults to undefined (byte-identical to before this field existed)", () => {
  const base = { name: "builder", prompt_engineering: { system: "s.md", user: "u.md" } };
  const unset = v.parse(AgentConfigSchema, base);
  assert.equal(unset.env_allowlist, undefined);

  const allowlisted = v.parse(AgentConfigSchema, { ...base, env_allowlist: ["MY_API_KEY"] });
  assert.deepEqual(allowlisted.env_allowlist, ["MY_API_KEY"]);

  const nulled = v.parse(AgentConfigSchema, { ...base, env_allowlist: null });
  assert.equal(nulled.env_allowlist, null, "null must parse (the 'unrestricted' spelling config.md teaches for writes)");
});

// This is the load-bearing half of the field: the schema merely declares
// the shape, agentEnv() is what actually filters the operator's own
// environment down to the allowlist. A test that only exercised the schema
// (as the previous version of this test did) would never notice agentEnv
// silently failing to filter anything.
test("agentEnv: filters the operator environment down to the allowlist plus the baseline keys", () => {
  const base = { name: "builder", prompt_engineering: { system: "s.md", user: "u.md" } };
  const savedApiKey = process.env["MY_API_KEY"];
  const savedSecret = process.env["SECRET_TOKEN"];
  try {
    process.env["MY_API_KEY"] = "abc123";
    process.env["SECRET_TOKEN"] = "should-never-appear";

    // unset -> undefined: both backends fall back to `request.env ?? operatorEnv()`,
    // so this is byte-identical to the unfiltered behavior that predates the field.
    const unset = v.parse(AgentConfigSchema, base);
    assert.equal(agentEnv(unset), undefined);

    // [] -> baseline-only: every ENV_BASELINE_KEYS entry actually present in
    // process.env, and nothing else — SECRET_TOKEN must not leak through.
    const empty = v.parse(AgentConfigSchema, { ...base, env_allowlist: [] });
    const baselineOnly = agentEnv(empty)!;
    const baselineKeys = ["PATH", "HOME", "USER", "LANG", "TERM", "TMPDIR"];
    for (const key of Object.keys(baselineOnly)) {
      assert.ok(baselineKeys.includes(key), `${key} is not a baseline key — [] must yield baseline-only`);
    }
    assert.equal(baselineOnly["SECRET_TOKEN"], undefined);
    assert.equal(baselineOnly["MY_API_KEY"], undefined);

    // ["MY_API_KEY"] -> baseline + MY_API_KEY, with SECRET_TOKEN provably absent.
    const allowlisted = v.parse(AgentConfigSchema, { ...base, env_allowlist: ["MY_API_KEY"] });
    const filtered = agentEnv(allowlisted)!;
    assert.equal(filtered["MY_API_KEY"], "abc123");
    assert.equal(filtered["SECRET_TOKEN"], undefined, "an unrelated secret must not survive the filter");
    for (const key of Object.keys(filtered)) {
      assert.ok(
        baselineKeys.includes(key) || key === "MY_API_KEY",
        `${key} leaked through the allowlist unexpectedly`,
      );
    }
  } finally {
    if (savedApiKey === undefined) delete process.env["MY_API_KEY"];
    else process.env["MY_API_KEY"] = savedApiKey;
    if (savedSecret === undefined) delete process.env["SECRET_TOKEN"];
    else process.env["SECRET_TOKEN"] = savedSecret;
  }
});

// ── tiering (SPF #14) — merge survival ───────────────────────────────────────
//
// The same silent-drop trap `review`/`notifications`/`observability.otel`
// already guard against: `mergeRawConfig` (core/agents.ts) is a FIXED-SHAPE
// object literal, so a top-level `tiering:` key not named on both sides of
// it is dropped before `SFConfigSchema` ever sees it, and parsing then
// succeeds anyway on the schema default — quietly wrong, not a crash.

test("TieringConfigSchema defaults: enabled=false, tiers=[], roles={}; TierSchema's coding_agent defaults to flue", () => {
  const parsed = v.parse(TieringConfigSchema, {});
  assert.equal(parsed.enabled, false, "OFF by default — absence must be a total no-op");
  assert.deepEqual(parsed.tiers, []);
  assert.deepEqual(parsed.roles, {});

  const tier = v.parse(TierSchema, { name: "scout", model: "ollama/granite4.1:8b" });
  assert.equal(tier.coding_agent, "flue", "same default as AgentConfigSchema's own coding_agent field");
});

test("tiering: survives loadConfig's merge for a single config file — not dropped by mergeRawConfig's fixed-shape literal", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-tiering-merge-test-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(
      configPath,
      "tiering:\n" +
        "  enabled: true\n" +
        "  tiers:\n" +
        "    - {name: scout, coding_agent: flue, model: ollama/granite4.1:8b}\n" +
        "  roles:\n" +
        "    scout: scout\n",
    );
    const cfg = loadConfig([configPath]);
    assert.equal(cfg.tiering.enabled, true, "a tiering: value from a real config file must reach SFConfig, not be dropped by mergeRawConfig");
    assert.deepEqual(cfg.tiering.tiers, [{ name: "scout", coding_agent: "flue", model: "ollama/granite4.1:8b" }]);
    assert.deepEqual(cfg.tiering.roles, { scout: "scout" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tiering merges key-by-key across two layered config files — an override that only flips enabled keeps the base's tiers/roles", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-tiering-merge-layered-test-"));
  try {
    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(
      base,
      "tiering:\n" +
        "  enabled: false\n" +
        "  tiers:\n" +
        "    - {name: scout, coding_agent: flue, model: ollama/granite4.1:8b}\n" +
        "    - {name: builder, coding_agent: flue, model: ollama/qwen3.8:27b-mlx}\n" +
        "  roles:\n" +
        "    scout: scout\n" +
        "    documenter: scout\n" +
        "    planner: builder\n" +
        "    builder: builder\n" +
        "    refiner: builder\n" +
        "    reviewer: builder\n",
    );
    writeFileSync(override, "tiering:\n  enabled: true\n");
    const cfg = loadConfig([base, override]);
    assert.equal(cfg.tiering.enabled, true, "override wins for the key it names");
    assert.deepEqual(
      cfg.tiering.tiers.map((t) => t.name),
      ["scout", "builder"],
      "unset in the override -> the base's ladder survives, key-by-key, not a whole-block replace",
    );
    assert.deepEqual(cfg.tiering.roles, {
      scout: "scout",
      documenter: "scout",
      planner: "builder",
      builder: "builder",
      refiner: "builder",
      reviewer: "builder",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tiering.tiers is a whole-list replace on override — a repo's own ladder replaces the base's wholesale, not an unordered splice of both", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-tiering-merge-list-replace-test-"));
  try {
    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(
      base,
      "tiering:\n  tiers:\n    - {name: scout, model: google/gemini-3.6-flash}\n    - {name: builder, model: fireworks/accounts/fireworks/models/kimi-k3}\n",
    );
    writeFileSync(override, "tiering:\n  tiers:\n    - {name: local, model: ollama/granite4.1:8b}\n");
    const cfg = loadConfig([base, override]);
    assert.deepEqual(
      cfg.tiering.tiers.map((t) => t.name),
      ["local"],
      "the override's own ladder replaces the base's entirely — same semantics as quality.checks/notifications.channels",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tiering.roles is a whole-object replace on override — a half-merged role map would route some agents by the base's ladder and some by the override's", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-tiering-merge-roles-replace-test-"));
  try {
    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(base, "tiering:\n  roles:\n    scout: scout\n    builder: builder\n");
    writeFileSync(override, "tiering:\n  roles:\n    reviewer: deep\n");
    const cfg = loadConfig([base, override]);
    assert.deepEqual(cfg.tiering.roles, { reviewer: "deep" }, "the override's roles map replaces the base's entirely, not a merge of both");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── sandbox backends (SPF #15) — merge survival ─────────────────────────────
//
// The same silent-drop trap `review`/`notifications`/`tiering` already
// guard against: `mergeRawConfig` (core/agents.ts) is a FIXED-SHAPE object
// literal, so a top-level `sandbox:` key not named on both sides of it is
// dropped before `SFConfigSchema` ever sees it.

test("SandboxConfigSchema: with no config file naming sandbox:, cfg.sandbox is nevertheless DEFINED with backend: local and scope: agent", () => {
  const cfg = v.parse(SFConfigSchema, {});
  assert.equal(cfg.sandbox.backend, "local", "the total predicate agent.sandbox ?? cfg.sandbox.backend and every doctor gate rely on this");
  assert.equal(cfg.sandbox.scope, "agent", "the default scope, asserted positively so a later schema edit cannot silently flip it back to run");
  assert.equal(cfg.sandbox.workspace_dir, "/workspace");
  assert.equal(cfg.sandbox.handoff_dir, "/spf/handoff");
  assert.equal(cfg.sandbox.scratch_dir, "/spf/tmp");
  assert.ok(!cfg.sandbox.scratch_dir.startsWith(`${cfg.sandbox.workspace_dir}/`), "the shipped defaults must satisfy validateSandboxConfig's own placement check");
});

test("sandbox: survives loadConfig's merge — the silent-drop trap mergeRawConfig's fixed-shape literal sets, for a single config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-sandbox-merge-test-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, "sandbox:\n  backend: opensandbox\n  scope: run\n  scratch_dir: /spf/tmp2\n  max_total_lifetime_seconds: 99999\n  request_timeout_seconds: 1200\n  exec_timeout_seconds: 1000\n  transport:\n    max_mirror_bytes: 1048576\n");
    const cfg = loadConfig([configPath]);
    assert.equal(cfg.sandbox.backend, "opensandbox", "a sandbox: value from a real config file must reach SFConfig, not be dropped by mergeRawConfig");
    assert.equal(cfg.sandbox.scope, "run");
    assert.equal(cfg.sandbox.scratch_dir, "/spf/tmp2");
    assert.equal(cfg.sandbox.max_total_lifetime_seconds, 99999);
    assert.equal(cfg.sandbox.request_timeout_seconds, 1200);
    assert.equal(cfg.sandbox.exec_timeout_seconds, 1000);
    assert.equal(cfg.sandbox.transport.max_mirror_bytes, 1048576);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox merges key-by-key across two layered config files, and nested opensandbox/cloudflare/egress/transport/credentials are WHOLE-OBJECT replaces", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-sandbox-merge-layered-test-"));
  try {
    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(
      base,
      "sandbox:\n  backend: opensandbox\n  workspace_dir: /workspace\n  opensandbox:\n    base_url: http://base:8090\n    api_key_env: BASE_KEY\n",
    );
    writeFileSync(override, "sandbox:\n  workspace_dir: /custom-workspace\n  opensandbox:\n    base_url: http://override:8090\n");
    const cfg = loadConfig([base, override]);
    assert.equal(cfg.sandbox.backend, "opensandbox", "unset in the override -> the base's value survives, key-by-key, not a whole-block replace");
    assert.equal(cfg.sandbox.workspace_dir, "/custom-workspace", "override wins for the key it names");
    assert.equal(cfg.sandbox.opensandbox.base_url, "http://override:8090");
    assert.equal(cfg.sandbox.opensandbox.api_key_env, "OPENSANDBOX_API_KEY", "whole-object replace: the base's api_key_env does NOT survive alongside the override's base_url — the schema default applies instead");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sandbox.credentials.broker survives layered merge as a whole-object replace, same as opensandbox/cloudflare's own keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-sandbox-credentials-merge-test-"));
  try {
    const base = join(dir, "base.yaml");
    const override = join(dir, "override.yaml");
    writeFileSync(base, "sandbox:\n  backend: opensandbox\n  credentials:\n    broker: static\n");
    // The override touches a DIFFERENT sandbox key — credentials must survive
    // untouched (key-by-key at the `sandbox:` level), exactly like the
    // opensandbox/cloudflare test above.
    writeFileSync(override, "sandbox:\n  workspace_dir: /custom-workspace\n");
    const cfg = loadConfig([base, override]);
    assert.equal(cfg.sandbox.credentials.broker, "static");
    assert.equal(cfg.sandbox.workspace_dir, "/custom-workspace");

    // An override that DOES touch credentials: is a whole-object replace,
    // same rule as opensandbox/cloudflare.
    const override2 = join(dir, "override2.yaml");
    writeFileSync(override2, "sandbox:\n  credentials:\n    broker: mystery\n");
    const cfg2 = loadConfig([base, override2]);
    assert.equal(cfg2.sandbox.credentials.broker, "mystery", "not restricted to a fixed picklist at the schema layer — validateSandboxConfig is the enforcement point (§6.1)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agents[].sandbox survives mergeAgentLists and is NOT back-filled from defaults — the back-fill list (agents.ts) stays the fixed literal it always was", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-sandbox-agent-override-test-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(
      configPath,
      "sandbox:\n  backend: opensandbox\nagents:\n  - name: builder\n    sandbox: local\n    prompt_engineering: {system: s.md, user: u.md}\n  - name: reviewer\n    prompt_engineering: {system: s.md, user: u.md}\n",
    );
    const cfg = loadConfig([configPath]);
    assert.equal(cfg.agents.find((a) => a.name === "builder")?.sandbox, "local");
    assert.equal(cfg.agents.find((a) => a.name === "reviewer")?.sandbox, undefined, "an agent that doesn't set sandbox: must NOT inherit sandbox.backend via back-fill — resolution is agent.sandbox ?? cfg.sandbox.backend, a runtime expression, not a config-load-time copy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the back-fill list at agents.ts's loadConfig did not grow — sandbox is a top-level key, not a defaults key", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-sandbox-backfill-list-test-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(
      configPath,
      "defaults:\n  model: base-model\nsandbox:\n  backend: opensandbox\nagents:\n  - name: builder\n    prompt_engineering: {system: s.md, user: u.md}\n",
    );
    const cfg = loadConfig([configPath]);
    const agent = cfg.agents.find((a) => a.name === "builder")!;
    assert.ok(!("sandbox" in agent) || agent.sandbox === undefined, "sandbox.backend must never be copied down onto an agent as a per-agent 'sandbox' back-fill");
    assert.equal(agent.model, "base-model", "the real back-fill keys (model, etc.) still work — this is not a regression in the existing list");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tiering: is NOT back-filled onto agents — a tiering: block leaves every cfg.agents[i] without a tiering key", () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-tiering-no-backfill-test-"));
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(
      configPath,
      "tiering:\n  enabled: true\n  tiers:\n    - {name: scout, model: ollama/granite4.1:8b}\n  roles:\n    builder: scout\n" +
        "agents:\n  - name: builder\n    prompt_engineering: {system: s.md, user: u.md}\n",
    );
    const cfg = loadConfig([configPath]);
    for (const agent of cfg.agents) {
      assert.ok(!("tiering" in agent), `agent ${agent.name} must not carry a tiering key — it is a RUN-scoped config, not a per-agent setting`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
