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
  ReviewOutput,
  ScoutOutput,
  VerifyOutput,
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
  for (const envelope of [GenericOutput, PlanOutput, BuildOutput, ScoutOutput, ReviewOutput, DocumentOutput, ChangesOutput, VerifyOutput]) {
    assert.doesNotThrow(() => toJsonSchema(envelope.schema), `${envelope.name} must stay convertible — no rawTransform allowed on an envelope schema`);
  }
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
