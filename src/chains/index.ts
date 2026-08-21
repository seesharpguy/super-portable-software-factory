/**
 * The chain registry — the one place a CLI-facing short name maps to a
 * chain module. `spf list` reads this; `spf <name>`/`spf run <name>` dispatch
 * through it. Replaces guessing a module filename from the CLI argument.
 *
 * Every chain but `simple-sdlc` is a flat `steps` list composed from
 * `./steps.ts`'s primitives — no module of its own, and no hand-written
 * `phases`/`requiredAgents`/`requiredSuites` to keep in sync with what
 * actually runs; those are derived from the step list itself.
 * `simple-sdlc`'s three-commit, pinned-baseline shape is still imperative —
 * see `./simple_sdlc.ts` — via the `run` escape hatch below.
 */
import type { ChainContext } from "./context.ts";
import * as steps from "./steps.ts";
import * as simpleSdlc from "./simple_sdlc.ts";

export interface ChainDefinition {
  /** The name typed on the CLI: `spf <name> "..."`. */
  name: string;
  describe: string;
  phases: string;
  /** Static for most chains; prompt's depends on --agent, so it's a function there. */
  requiredAgents: string[] | ((options: Record<string, string>) => string[]);
  requiredSuites: string[];
  /** The declarative path — a flat step list, run by runChain() via steps.runSteps(). */
  steps?: steps.Step[];
  /** The imperative escape hatch for a chain too shaped by its own logic to be a flat list (simple-sdlc). */
  run?: (ctx: ChainContext, options?: Record<string, string>) => Promise<number>;
}

/** Build a step-based ChainDefinition, deriving phases/requiredAgents/requiredSuites from its steps. */
function stepChain(name: string, describe: string, list: steps.Step[]): ChainDefinition {
  return {
    name,
    describe,
    phases: steps.derivePhases(list),
    requiredAgents: steps.deriveRequiredAgents(list),
    requiredSuites: steps.deriveRequiredSuites(list),
    steps: list,
  };
}

export const CHAINS: ChainDefinition[] = [
  stepChain("prompt", "one agent, one prompt, traced end to end — --agent <name> picks who (default: builder)", [
    steps.request(),
    steps.promptOnly(),
  ]),

  stepChain("scout", "read-only recon; nothing changes", [steps.request(), steps.scout()]),

  stepChain("plan", "turn a request into an implementable plan", [steps.request(), steps.plan()]),

  stepChain("build", "implement an existing plan", [steps.request(), steps.build({ fromPlan: false, retries: 1 })]),

  stepChain("plan-build", "small, well-understood work — plan, build, commit", [
    steps.request(),
    steps.plan(),
    steps.build(),
    steps.commit(),
  ]),

  stepChain("build-test", "there is a suite to satisfy — build, test, bounded fix loop", [
    steps.request(),
    steps.build({ fromPlan: false }),
    steps.fixLoop({ suite: "test" }),
  ]),

  stepChain("plan-build-test", "the standard chain — plan, build, test, commit", [
    steps.request(),
    steps.plan(),
    steps.build(),
    steps.fixLoop({ suite: "test" }),
    steps.commit({ onlyIfAccepted: true }),
  ]),

  stepChain("plan-build-test-quality", "the repo has quality commands worth enforcing beyond tests — same, plus lint/typecheck/build gates", [
    steps.request(),
    steps.plan(),
    steps.build(),
    steps.fixLoop({ suite: "all" }),
    steps.commit({ onlyIfAccepted: true }),
  ]),

  stepChain("build-review", '"is this what was asked for" matters more than "does it run"', [
    steps.request(),
    steps.build({ fromPlan: false }),
    steps.reviseLoop(),
  ]),

  stepChain("quality", "lint, typecheck, build — no agents at all", [
    steps.request({ description: "Capture why quality verification was requested" }),
    steps.qualityCheck({ suite: "all" }),
  ]),

  stepChain("document", "write up the work that was just done, from the diff", [steps.request(), steps.changes(), steps.document()]),

  {
    name: "simple-sdlc",
    describe: "the work is real and its shape is not obvious — plan, build, test, review, document; 3 commits",
    phases:
      "engineer(request) -> planner -> git(commit_plan) -> builder -> code(test) [-> builder(fix) -> code(test) ...] " +
      "-> reviewer [-> builder(revise) -> reviewer ...] -> code(retest, if revised) -> git(commit_build) " +
      "-> code(changes) -> documenter -> git(commit_docs)",
    requiredAgents: simpleSdlc.REQUIRED_AGENTS,
    requiredSuites: simpleSdlc.REQUIRED_SUITES,
    run: simpleSdlc.main,
  },
];

export function findChain(name: string): ChainDefinition | undefined {
  return CHAINS.find((c) => c.name === name);
}

export function resolveRequiredAgents(chain: ChainDefinition, options: Record<string, string>): string[] {
  return typeof chain.requiredAgents === "function" ? chain.requiredAgents(options) : chain.requiredAgents;
}

/**
 * Run a chain, whichever path it defines: `run` (the imperative escape
 * hatch) if it has one, otherwise `steps` through the shared driver. Both
 * CLI dispatch sites (`spf <chain>` and `spf watch`) go through this, never
 * `chain.run(...)` directly — the whole reason to route through here is that
 * a `steps`-only chain has no `run` to call.
 */
export async function runChain(chain: ChainDefinition, ctx: ChainContext, options: Record<string, string> = {}): Promise<number> {
  if (chain.run) return chain.run(ctx, options);
  return steps.runSteps(ctx, resolveRequiredAgents(chain, options), chain.requiredSuites, chain.steps!, options);
}
