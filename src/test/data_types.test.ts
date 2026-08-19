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
import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import {
  AgentConfigSchema,
  BuildOutput,
  ChangesOutput,
  DocumentOutput,
  GenericOutput,
  PhaseParamsSchema,
  PlanOutput,
  ReviewOutput,
  ScoutOutput,
  VerifyOutput,
  makePhaseParams,
} from "../core/data_types.js";

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
