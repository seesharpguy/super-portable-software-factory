/**
 * The chain registry — the one place a CLI-facing short name maps to a
 * chain module. `spf list` reads this; `spf <name>`/`spf run <name>` dispatch
 * through it. Replaces guessing a module filename from the CLI argument.
 */
import type { ChainContext } from "./context.ts";
import * as adwPrompt from "./adw_prompt.ts";
import * as adwScout from "./adw_scout.ts";
import * as adwPlan from "./adw_plan.ts";
import * as adwBuild from "./adw_build.ts";
import * as adwPlanBuild from "./adw_plan_build.ts";
import * as adwBuildTest from "./adw_build_test.ts";
import * as adwPlanBuildTest from "./adw_plan_build_test.ts";
import * as adwPlanBuildTestQuality from "./adw_plan_build_test_quality.ts";
import * as adwBuildReview from "./adw_build_review.ts";
import * as adwQuality from "./adw_quality.ts";
import * as adwDocument from "./adw_document.ts";
import * as adwSimpleSdlc from "./adw_simple_sdlc.ts";

export interface ChainDefinition {
  /** The name typed on the CLI: `spf <name> "..."`. */
  name: string;
  describe: string;
  phases: string;
  /** Static for most chains; adw_prompt's depends on --agent, so it's a function there. */
  requiredAgents: string[] | ((options: Record<string, string>) => string[]);
  requiredSuites: string[];
  run: (ctx: ChainContext, options?: Record<string, string>) => Promise<number>;
}

export const CHAINS: ChainDefinition[] = [
  {
    name: "prompt",
    describe: "one agent, one prompt, traced end to end — --agent <name> picks who (default: builder)",
    phases: "engineer(request) -> <agent>",
    requiredAgents: (options) => [options["agent"] ?? "builder"],
    requiredSuites: [],
    run: adwPrompt.main,
  },
  {
    name: "scout",
    describe: "read-only recon; nothing changes",
    phases: "engineer(request) -> scout",
    requiredAgents: adwScout.REQUIRED_AGENTS,
    requiredSuites: adwScout.REQUIRED_SUITES,
    run: adwScout.main,
  },
  {
    name: "plan",
    describe: "turn a request into an implementable plan",
    phases: "engineer(request) -> planner",
    requiredAgents: adwPlan.REQUIRED_AGENTS,
    requiredSuites: adwPlan.REQUIRED_SUITES,
    run: adwPlan.main,
  },
  {
    name: "build",
    describe: "implement an existing plan",
    phases: "engineer(request) -> builder",
    requiredAgents: adwBuild.REQUIRED_AGENTS,
    requiredSuites: adwBuild.REQUIRED_SUITES,
    run: adwBuild.main,
  },
  {
    name: "plan-build",
    describe: "small, well-understood work — plan, build, commit",
    phases: "engineer(request) -> planner -> builder -> git(commit)",
    requiredAgents: adwPlanBuild.REQUIRED_AGENTS,
    requiredSuites: adwPlanBuild.REQUIRED_SUITES,
    run: adwPlanBuild.main,
  },
  {
    name: "build-test",
    describe: "there is a suite to satisfy — build, test, bounded fix loop",
    phases: "engineer(request) -> builder -> code(test) [-> builder(fix) -> code(test) ...]",
    requiredAgents: adwBuildTest.REQUIRED_AGENTS,
    requiredSuites: adwBuildTest.REQUIRED_SUITES,
    run: adwBuildTest.main,
  },
  {
    name: "plan-build-test",
    describe: "the standard chain — plan, build, test, commit",
    phases: "engineer(request) -> planner -> builder -> code(test) [-> fix loop] -> git(commit)",
    requiredAgents: adwPlanBuildTest.REQUIRED_AGENTS,
    requiredSuites: adwPlanBuildTest.REQUIRED_SUITES,
    run: adwPlanBuildTest.main,
  },
  {
    name: "plan-build-test-quality",
    describe: "the repo has quality commands worth enforcing beyond tests — same, plus lint/typecheck/build gates",
    phases: "engineer(request) -> planner -> builder -> code(quality:all) [-> fix loop] -> git(commit)",
    requiredAgents: adwPlanBuildTestQuality.REQUIRED_AGENTS,
    requiredSuites: adwPlanBuildTestQuality.REQUIRED_SUITES,
    run: adwPlanBuildTestQuality.main,
  },
  {
    name: "build-review",
    describe: "\"is this what was asked for\" matters more than \"does it run\"",
    phases: "engineer(request) -> builder -> reviewer [-> revise loop]",
    requiredAgents: adwBuildReview.REQUIRED_AGENTS,
    requiredSuites: adwBuildReview.REQUIRED_SUITES,
    run: adwBuildReview.main,
  },
  {
    name: "quality",
    describe: "lint, typecheck, build — no agents at all",
    phases: "engineer(request) -> code(quality:all)",
    requiredAgents: adwQuality.REQUIRED_AGENTS,
    requiredSuites: adwQuality.REQUIRED_SUITES,
    run: adwQuality.main,
  },
  {
    name: "document",
    describe: "write up the work that was just done, from the diff",
    phases: "engineer(request) -> code(changes) -> documenter",
    requiredAgents: adwDocument.REQUIRED_AGENTS,
    requiredSuites: adwDocument.REQUIRED_SUITES,
    run: adwDocument.main,
  },
  {
    name: "simple-sdlc",
    describe: "the work is real and its shape is not obvious — plan, build, test, review, document; 3 commits",
    phases: "engineer(request) -> planner -> builder -> code(test) -> reviewer -> code(changes) -> documenter",
    requiredAgents: adwSimpleSdlc.REQUIRED_AGENTS,
    requiredSuites: adwSimpleSdlc.REQUIRED_SUITES,
    run: adwSimpleSdlc.main,
  },
];

export function findChain(name: string): ChainDefinition | undefined {
  return CHAINS.find((c) => c.name === name);
}

export function resolveRequiredAgents(chain: ChainDefinition, options: Record<string, string>): string[] {
  return typeof chain.requiredAgents === "function" ? chain.requiredAgents(options) : chain.requiredAgents;
}
