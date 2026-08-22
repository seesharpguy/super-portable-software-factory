/**
 * Regression net for the chain registry. Chains used to each be a hand-written
 * module; now every one but `simple-sdlc` is a `steps` list whose
 * `phases`/`requiredAgents`/`requiredSuites` are DERIVED (see
 * `chains/steps.ts`'s `derivePhases`/`deriveRequiredAgents`/
 * `deriveRequiredSuites`). These tests pin what that derivation produces
 * today, so a step-factory change that silently alters a chain's shape (an
 * agent dropped from `requiredAgents`, a suite no longer required, a phase
 * missing from the display string) fails here instead of only showing up as
 * a `spf list` diff nobody happened to read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAINS, findChain, resolveRequiredAgents } from "../chains/index.js";

// name -> [phases, requiredAgents (with no options), requiredSuites]
const EXPECTED: Record<string, { phases: string; agents: string[]; suites: string[] }> = {
  prompt: { phases: "engineer(request) -> <agent>", agents: ["builder"], suites: [] },
  scout: { phases: "engineer(request) -> scout", agents: ["scout"], suites: [] },
  plan: { phases: "engineer(request) -> planner", agents: ["planner"], suites: [] },
  build: { phases: "engineer(request) -> builder", agents: ["builder"], suites: [] },
  "plan-build": { phases: "engineer(request) -> planner -> builder -> git(commit)", agents: ["planner", "builder"], suites: [] },
  "build-test": {
    phases: "engineer(request) -> builder -> code(test) [-> builder(fix) -> code(test) ...] bounded",
    agents: ["builder"],
    suites: ["test"],
  },
  "plan-build-test": {
    phases: "engineer(request) -> planner -> builder -> code(test) [-> builder(fix) -> code(test) ...] bounded -> git(commit)",
    agents: ["planner", "builder"],
    suites: ["test"],
  },
  "plan-build-test-quality": {
    phases: "engineer(request) -> planner -> builder -> code(verify) [-> builder(fix) -> code(verify) ...] bounded -> git(commit)",
    agents: ["planner", "builder"],
    suites: ["all"],
  },
  "build-review": {
    phases: "engineer(request) -> builder -> reviewer [-> builder(revise) -> reviewer ...] bounded",
    agents: ["builder", "reviewer"],
    suites: [],
  },
  quality: { phases: "engineer(request) -> code(quality)", agents: [], suites: ["all"] },
  document: { phases: "engineer(request) -> code(changes) -> documenter", agents: ["documenter"], suites: [] },
  refine: { phases: "engineer(request) -> refiner -> code(publish)", agents: ["refiner"], suites: [] },
  "simple-sdlc": {
    phases:
      "engineer(request) -> planner -> git(commit_plan) -> builder -> code(test) [-> builder(fix) -> code(test) ...] " +
      "-> reviewer [-> builder(revise) -> reviewer ...] -> code(retest, if revised) -> git(commit_build) " +
      "-> code(changes) -> documenter -> git(commit_docs)",
    agents: ["planner", "builder", "reviewer", "documenter"],
    suites: ["test"],
  },
};

test("every chain in the registry has an expectation pinned here", () => {
  const names = CHAINS.map((c) => c.name).sort();
  assert.deepEqual(names, Object.keys(EXPECTED).sort(), "a chain was added/removed/renamed without updating this test");
});

for (const chain of CHAINS) {
  const expected = EXPECTED[chain.name];
  test(`${chain.name}: derived phases/requiredAgents/requiredSuites match what was hand-verified against \`spf list\``, () => {
    assert.equal(chain.phases, expected.phases);
    assert.deepEqual(resolveRequiredAgents(chain, {}), expected.agents);
    assert.deepEqual(chain.requiredSuites, expected.suites);
  });
}

test("prompt: requiredAgents depends on --agent, not a fixed list — the one dynamic case", () => {
  const chain = findChain("prompt")!;
  assert.deepEqual(resolveRequiredAgents(chain, {}), ["builder"], "no --agent -> falls back to builder");
  assert.deepEqual(resolveRequiredAgents(chain, { agent: "planner" }), ["planner"], "--agent overrides the default");
});

test("every chain but simple-sdlc is a steps list; simple-sdlc alone uses the imperative run() escape hatch", () => {
  for (const chain of CHAINS) {
    if (chain.name === "simple-sdlc") {
      assert.ok(chain.run, "simple-sdlc should still be the one hand-written chain");
      assert.equal(chain.steps, undefined);
    } else {
      assert.ok(chain.steps && chain.steps.length > 0, `${chain.name} should be a steps list`);
      assert.equal(chain.run, undefined, `${chain.name} should not also define run()`);
    }
  }
});

test("findChain resolves every registered name and nothing else", () => {
  for (const chain of CHAINS) {
    assert.equal(findChain(chain.name)?.name, chain.name);
  }
  assert.equal(findChain("not-a-real-chain"), undefined);
});
