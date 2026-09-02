/**
 * The chain registry — the one place a CLI-facing short name resolves to a
 * chain. `spf list` reads it; `spf <name>`/`spf run <name>` dispatch through
 * it. Replaces guessing a module filename from the CLI argument.
 *
 * TWO TIERS, and the distinction is load-bearing:
 *
 *  1. BUILT-INS — `CHAINS`, below. Compiled in, always present, the same in
 *     every repo spf is ever run against. Every one but `simple-sdlc` is a
 *     flat `steps` list composed from `./steps.ts`'s primitives — no module
 *     of its own, and no hand-written `phases`/`requiredAgents`/
 *     `requiredSuites` to keep in sync with what actually runs; those are
 *     derived from the step list itself. `simple-sdlc`'s three-commit,
 *     pinned-baseline shape is still imperative — see `./simple_sdlc.ts` —
 *     via the `run` escape hatch below.
 *  2. REPO-LOCAL CHAINS — registered at CLI startup from
 *     `<repo>/.spf/chains/*.yaml` by `registerRepoChains()`, having been
 *     read by `./repo_chains.ts`. These are DATA: a yaml file names built-in
 *     step factories and passes them params. It cannot introduce code, and
 *     it runs on the same `steps.runSteps()` driver as a built-in, because
 *     "agent proposes, code disposes" only means anything if the code that
 *     disposes is SPF's code — not the target repo's.
 *
 * `CHAINS` stays a built-in-only const: nothing ever pushes into it, and
 * `src/test/chains.test.ts` pins its exact name set. Repo chains live in a
 * separate module-level list that `registerRepoChains()` REPLACES (never
 * appends to), so a second registration — a long-lived process, `spf watch`
 * re-reading after an edit, a test — cannot double-register a name. Read
 * both tiers through `allChains()`; built-ins always come first, and
 * `findChain()` resolves them first, so a built-in name can never be
 * shadowed by a file on disk.
 */
import type { ChainContext } from "./context.ts";
import * as steps from "./steps.ts";
import * as simpleSdlc from "./simple_sdlc.ts";
import * as otel from "../core/otel.ts";
import * as session from "../core/session.ts";

export interface ChainDefinition {
  /** The name typed on the CLI: `spf <name> "..."`. */
  name: string;
  describe: string;
  phases: string;
  /** Static for most chains; prompt's depends on --agent, so it's a function there. */
  requiredAgents: string[] | ((options: Record<string, string>) => string[]);
  /** Static unless a step's suite can be overridden by --suite (qualityCheck/fixLoop), in which case it's a function — see steps.deriveRequiredSuites. */
  requiredSuites: string[] | ((options: Record<string, string>) => string[]);
  /** The declarative path — a flat step list, run by runChain() via steps.runSteps(). */
  steps?: steps.Step[];
  /** The imperative escape hatch for a chain too shaped by its own logic to be a flat list (simple-sdlc). */
  run?: (ctx: ChainContext, options?: Record<string, string>) => Promise<number>;
  /**
   * Absolute path of the `.spf/chains/*.yaml` this chain was loaded from —
   * set only for a repo-local chain, `undefined` for a built-in (a built-in
   * has no source file: it IS spf). The CLI copies it into
   * `ChainContext.chain_source` so the run's trace records whose definition
   * ran, and `spf list`/`spf doctor` use its presence to mark which chains
   * came from the repo.
   */
  source?: string;
}

/** Chains eligible to fan out: their derived phase string must show at least one commit step. */
export function hasCommitStep(phases: string): boolean {
  return phases.includes("git(commit");
}

/**
 * Build a step-based ChainDefinition, deriving phases/requiredAgents/
 * requiredSuites from its steps.
 *
 * Exported so `./repo_chains.ts` builds a yaml-defined chain through the
 * EXACT same function as a built-in. That is deliberate and should not be
 * "simplified" into a second, parallel constructor: a repo chain must be
 * indistinguishable downstream — same derivation of phases/agents/suites,
 * same `steps` array, same `runSteps` driver, one run path — or the
 * guarantees the built-ins are tested for stop applying to it.
 */
export function stepChain(name: string, describe: string, list: steps.Step[]): ChainDefinition {
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

  stepChain("refine", "decompose a product spec into a feature/story-or-bug tree of tracker issues — spf watch's spec-ready lane", [
    steps.request(),
    // Grounds the decomposition in code that actually exists, rather than
    // leaving "explore the codebase" as prose the refiner may or may not
    // follow (see assets/prompts/refiner/system.md). Its ScoutOutput flows
    // into refine() as `previous` — agentStep() threads state.previous into
    // every agent phase, and refiner/user.md already renders it as
    // {{previous_envelope}}. This makes `scout` a required agent for this
    // chain: a roster that pruned it fails agents.validate() by name at
    // `spf watch` startup, same as any other missing required agent.
    // retries: 2 (3 attempts total) — `gates.artifactsExist` failing here has
    // historically been transient (a declared artifact briefly missing,
    // since fixed at the source by giving `claim()` real per-issue
    // exclusivity — see `core/watch.ts`'s `issueLockPath`), so a same-session
    // correction retry or two is worth it before this blocks the whole spec
    // and pages a human.
    steps.scout({ description: "Map the subsystems this spec touches — change nothing", retries: 2 }),
    steps.refine(),
    steps.publishIssues(),
  ]),

  {
    name: "simple-sdlc",
    describe: "the work is real and its shape is not obvious — plan, build, test, review, document; 3 commits",
    phases:
      "engineer(request) -> planner -> git(commit_plan) -> builder -> code(test) [-> builder(fix) -> code(test) ...] " +
      "-> reviewer [-> builder(revise) -> reviewer ...] -> code(retest, if revised) -> engineer(signoff) -> git(commit_build) " +
      "-> code(changes) -> documenter -> git(commit_docs)",
    requiredAgents: simpleSdlc.REQUIRED_AGENTS,
    requiredSuites: simpleSdlc.REQUIRED_SUITES,
    run: simpleSdlc.main,
  },
];

/**
 * Every built-in name, reserved. `repo_chains.ts` checks against this to
 * refuse a repo chain that reuses one — a collision is reported as a
 * problem, never resolved by shadowing either way round.
 */
export const BUILTIN_CHAIN_NAMES: ReadonlySet<string> = new Set(CHAINS.map((c) => c.name));

// ── tier 2: repo-local chains, registered at startup ────────────────────

/**
 * Module-level, not a parameter threaded through every call site: `spf list`,
 * `spf <chain>`, `spf watch`, `spf doctor` and the interview all resolve
 * chains by name from unrelated places, and passing a registry object to
 * each would mean four more chances for one of them to be looking at the
 * built-ins only. One process, one repo, one registration.
 */
let REPO_CHAINS: ChainDefinition[] = [];
let REPO_CHAIN_PROBLEMS: { file: string; message: string }[] = [];

/**
 * Install the repo-local chains (and the problems found reading them) for
 * this process. Call once, early, from the CLI entry point.
 *
 * REPLACES rather than appends, so it is idempotent: calling it twice with
 * the same input leaves exactly one copy of each chain. That matters because
 * a long-running `spf watch` may re-read `.spf/chains/` after an edit, and
 * because a partial second registration (say, one file fixed) must not leave
 * the previous file's stale definition behind.
 *
 * The `problems` list is stored, not thrown and not printed: loading is
 * never allowed to fail a command that has nothing to do with the broken
 * file (`spf trace`, `spf sessions`, `spf --version` must all still work in
 * a repo with one malformed yaml). `spf list` and `spf doctor` surface them;
 * dispatch surfaces them when the name someone typed is missing.
 */
export function registerRepoChains(chains: ChainDefinition[], problems: { file: string; message: string }[]): void {
  REPO_CHAINS = [...chains];
  REPO_CHAIN_PROBLEMS = [...problems];
}

/** Built-ins first, then repo-local chains — the order `spf list` prints and `findChain` resolves in. */
export function allChains(): ChainDefinition[] {
  return [...CHAINS, ...REPO_CHAINS];
}

/** What went wrong reading `.spf/chains/*.yaml`, for `spf list`/`spf doctor` to report. */
export function repoChainProblems(): { file: string; message: string }[] {
  return [...REPO_CHAIN_PROBLEMS];
}

/**
 * Resolve a CLI-facing name. Built-ins are consulted FIRST and win
 * unconditionally — a repo chain that reuses a built-in name is rejected at
 * load time (see `repo_chains.ts`), so this ordering is a second line of
 * defence rather than the policy itself, and it is what makes `spf build` in
 * any repo mean what the docs say it means.
 */
export function findChain(name: string): ChainDefinition | undefined {
  return CHAINS.find((c) => c.name === name) ?? REPO_CHAINS.find((c) => c.name === name);
}

export function resolveRequiredAgents(chain: ChainDefinition, options: Record<string, string>): string[] {
  return typeof chain.requiredAgents === "function" ? chain.requiredAgents(options) : chain.requiredAgents;
}

/** Same idea as resolveRequiredAgents(), for the suite(s) --suite can override before validate() ever runs. */
export function resolveRequiredSuites(chain: ChainDefinition, options: Record<string, string>): string[] {
  return typeof chain.requiredSuites === "function" ? chain.requiredSuites(options) : chain.requiredSuites;
}

/**
 * Run a chain, whichever path it defines: `run` (the imperative escape
 * hatch) if it has one, otherwise `steps` through the shared driver. Both
 * CLI dispatch sites (`spf <chain>` and `spf watch`) go through this, never
 * `chain.run(...)` directly — the whole reason to route through here is that
 * a `steps`-only chain has no `run` to call.
 *
 * Also the one call site both dispatch paths share on the way OUT — success
 * or thrown error alike, `finally` runs either way — which is what makes it
 * the right seam for `otel.releaseOtelExporter()` (see otel.ts's RUN-SCOPED
 * CLEANUP note / #26): a `spf watch` daemon calls this once per issue, in
 * the same process, for as long as it runs, so a run's exporter has to be
 * dropped here rather than living until the whole daemon exits. `session.
 * finalize()` is the same idea for the run itself — it stops the process-
 * wide signal handler from reaching this (now finished) run, and closes its
 * Tracer's sqlite handle, so a long `spf watch` daemon does not hold every
 * issue it has ever processed reachable for the rest of its life.
 */
export async function runChain(chain: ChainDefinition, ctx: ChainContext, options: Record<string, string> = {}): Promise<number> {
  try {
    if (chain.run) return await chain.run(ctx, options);
    return await steps.runSteps(ctx, resolveRequiredAgents(chain, options), resolveRequiredSuites(chain, options), chain.steps!, options);
  } finally {
    // Both are no-ops for a one-shot `spf <chain>` invocation with no
    // explicit `--adw-id` (ctx.adw_id is null; the id session.ensure()
    // actually minted never makes it back up here) — that process exits
    // right after this call returns, and the existing end-of-process
    // `flushAll()` in `cli/index.ts`'s `finally` still drains the exporter
    // exactly as it always did (the signal listener needs no such fallback:
    // the process is gone).
    await otel.releaseOtelExporter(ctx.adw_id);
    await session.finalize(ctx.adw_id);
  }
}
