/**
 * Step primitives: named, reusable pieces of chain composition.
 *
 * Every chain used to be a hand-written module repeating the same prologue,
 * the same `request` phase, and — where chains overlapped — byte-identical
 * `plan`/`build`/test-fix/review-revise/commit phases. This file is that
 * code, extracted once: a `Step` is one `run.phase(...)` call (or a small
 * bounded group of them) lifted out verbatim and parameterized only where
 * the chains genuinely differed.
 *
 * A Step reads and writes a shared `ChainState` — the local variables a
 * hand-written chain would otherwise thread from one `run.phase` call to the
 * next (the last envelope, the last quality result, whether the run is
 * accepted). Composing a chain is then an ordered array of Steps.
 *
 * The loops (`fixLoop`, `reviseLoop`) own their bounded iteration and dynamic
 * phase naming (`test_1`, `fix_1`, ...) INTERNALLY — a chain's step list is
 * therefore always flat, with no loop or conditional syntax at the
 * composition layer. That is what would make a future declarative (YAML)
 * chain tractable: it would only ever need to name steps and pass them
 * tuning params, never express control flow.
 */

import * as changesLib from "../core/changes.ts";
import * as gates from "../core/gates.ts";
import * as quality from "../core/quality.ts";
import * as agentsCfg from "../core/agents.ts";
import * as session from "../core/session.ts";
import { DOCUMENT_NOTES } from "../core/prompts.ts";
import {
  BuildOutput,
  DocumentOutput,
  GenericOutput,
  PlanOutput,
  ReviewOutput,
  ScoutOutput,
  makeAgentCall,
  makeChangeCapture,
  makePhaseParams,
  type EnvelopeBase,
  type EnvelopeType,
  type GateFn,
  type QualityResult,
  type ReviewOutputT,
} from "../core/data_types.ts";
import type { ChangeSet } from "../core/data_types.ts";
import { Run, type PhaseHandle } from "../core/runner.ts";
import type { ChainContext } from "./context.ts";

// ── shared state ─────────────────────────────────────────────────────────

/** What one step hands the next — the parts of a hand-written chain's local variables. */
export interface ChainState {
  prompt: string;
  options: Record<string, string>;
  /** The last agent envelope produced — what the next agent step feeds forward as `previous`. */
  previous: EnvelopeBase | null;
  quality: QualityResult | null;
  review: ReviewOutputT | null;
  changeset: ChangeSet | null;
  /** HEAD, pinned by request({logBaseline: true}) before the run commits anything. */
  baseline: string;
  /** The run's own acceptance criterion — distinct from "every phase succeeded"; see Run.finish(). */
  accepted: boolean;
  /** Why not, when accepted is false — passed straight to run.finish(). */
  reason: string;
}

function makeState(prompt: string, options: Record<string, string>): ChainState {
  return { prompt, options, previous: null, quality: null, review: null, changeset: null, baseline: "", accepted: true, reason: "" };
}

/**
 * One phase (or a small bounded group of them). Callable like a plain
 * function; the optional properties are how a step declares what it needs
 * so `deriveRequiredAgents`/`deriveRequiredSuites`/`derivePhases` can build
 * `ChainDefinition.requiredAgents`/`requiredSuites`/`phases` from a step list
 * instead of those being a second, separately maintained set of exports.
 */
export interface Step {
  (run: Run, state: ChainState): Promise<void>;
  requiredAgents?: string[] | ((options: Record<string, string>) => string[]);
  requiredSuites?: string[];
  /** Display fragment for derivePhases() — e.g. "planner", "git(commit)". */
  label?: string;
}

function makeStep(
  fn: (run: Run, state: ChainState) => Promise<void>,
  meta: { requiredAgents?: Step["requiredAgents"]; requiredSuites?: string[]; label?: string } = {},
): Step {
  const step = fn as Step;
  step.requiredAgents = meta.requiredAgents;
  step.requiredSuites = meta.requiredSuites;
  step.label = meta.label;
  return step;
}

// ── layer 1: the shared prologue ────────────────────────────────────────

/** The identical loadConfig -> validate -> session.ensure prologue every chain repeated. */
export function startRun(ctx: ChainContext, requiredAgents: string[], requiredSuites: string[]): Run {
  const cfg = agentsCfg.loadConfig(ctx.config_paths);
  agentsCfg.validate(cfg, requiredAgents, requiredSuites, ctx.cwd);
  return session.ensure(cfg, ctx.adw_id, ctx.cwd, ctx.chain_name);
}

/** Commit an envelope in its own author's words — the message-fallback four chains repeated. */
export function commitEnvelope(run: Run, ph: PhaseHandle, envelope: EnvelopeBase & { commit_message?: string }): void {
  const message = envelope.commit_message || `spf(${run.adw_id}): ${envelope.summary}`;
  ph.log({ sha: run.git.commitAll(message), message });
}

/** Log a change-capture result the same way every chain that captures one did. */
export function logChangeset(ph: PhaseHandle, result: ChangeSet): void {
  ph.log({
    base: `${result.base.label} @ ${result.base.commit.slice(0, 7)}`,
    reason: result.base.reason,
    files: result.files.length + result.untracked.length,
    lines: `+${result.insertions} -${result.deletions}`,
    diff: result.diff_path,
  });
}

// ── layer 2: step factories ──────────────────────────────────────────────

/** The engineer(request) phase every chain opens with. */
export function request(opts: { description?: string; logBaseline?: boolean } = {}): Step {
  const fn = async (run: Run, state: ChainState) => {
    if (opts.logBaseline) state.baseline = run.git.rev("HEAD");
    await run.phase(
      makePhaseParams({ name: "request", kind: "engineer", owner: run.engineer, description: opts.description ?? "Capture the incoming ask" }),
      async (ph) => {
        const payload: Record<string, unknown> = { input: state.prompt };
        if (opts.logBaseline) payload.baseline = run.git.shortSha(state.baseline);
        ph.log(payload);
      },
    );
  };
  return makeStep(fn, { label: "engineer(request)" });
}

/** One agent phase: prompt in, typed envelope out, `previous` is whatever the prior step left in state. */
function agentStep<T extends EnvelopeBase>(opts: {
  name: string;
  owner: string;
  output_type: EnvelopeType<T>;
  description: string;
  gates?: GateFn[];
  retries?: number;
  label?: string;
}): Step {
  const fn = async (run: Run, state: ChainState) => {
    const envelope = await run.phase(
      makePhaseParams({ name: opts.name, kind: "agent", owner: opts.owner, description: opts.description, retries: opts.retries ?? 0 }),
      (ph) => ph.call(makeAgentCall({ output_type: opts.output_type, prompt: state.prompt, previous: state.previous, gates: opts.gates ?? [] })),
    );
    state.previous = envelope;
  };
  return makeStep(fn, { requiredAgents: [opts.owner], label: opts.label ?? opts.owner });
}

export function plan(): Step {
  return agentStep({
    name: "plan",
    owner: "planner",
    output_type: PlanOutput,
    description: "Turn the request into an implementable plan",
    gates: [gates.artifactsExist, gates.filesNonEmpty],
  });
}

/**
 * `fromPlan` only changes the description — whether a plan() step precedes
 * this one already decides whether `state.previous` is a plan or null, so
 * there is nothing else for this flag to gate.
 */
export function build(opts: { fromPlan?: boolean; retries?: number } = {}): Step {
  const fromPlan = opts.fromPlan ?? true;
  return agentStep({
    name: "build",
    owner: "builder",
    output_type: BuildOutput,
    description: fromPlan ? "Implement the plan exactly" : "Implement the request",
    gates: [gates.diffMatchesClaims],
    retries: opts.retries ?? 0,
  });
}

export function scout(): Step {
  return agentStep({
    name: "scout",
    owner: "scout",
    output_type: ScoutOutput,
    description: "Find and report where things live — change nothing",
    gates: [gates.artifactsExist],
  });
}

/** The `prompt` chain's one step: --agent picks who, at run time and at requiredAgents-derivation time alike. */
export function promptOnly(): Step {
  const fn = async (run: Run, state: ChainState) => {
    const owner = state.options["agent"] ?? "builder";
    const envelope = await run.phase(
      makePhaseParams({ name: "prompt", kind: "agent", owner, description: `Send the request straight to ${owner} and parse its envelope` }),
      (ph) => ph.call(makeAgentCall({ output_type: GenericOutput, prompt: state.prompt, previous: state.previous })),
    );
    state.previous = envelope;
  };
  return makeStep(fn, { requiredAgents: (options) => [options["agent"] ?? "builder"], label: "<agent>" });
}

/** One deterministic quality block, standalone — never throws; sets state.accepted for run.finish() to check. */
export function qualityCheck(opts: { suite: "test" | "all"; description?: string } = { suite: "all" }): Step {
  const fn = async (run: Run, state: ChainState) => {
    await run.phase(
      makePhaseParams({
        name: opts.suite === "all" ? "quality" : "test",
        kind: "code",
        owner: "quality",
        description:
          opts.description ??
          (opts.suite === "all" ? "Run the deterministic quality blocks" : "Run the suite — a known command, so code runs it and no agent has to rediscover it"),
      }),
      async (ph) => {
        const result = opts.suite === "all" ? quality.runQuality(run) : quality.runTests(run);
        quality.record(ph, result);
        state.quality = result;
        state.accepted = result.passed;
        state.reason = result.passed ? "" : `quality failed: ${result.failures.join("; ")}`;
      },
    );
  };
  return makeStep(fn, { requiredSuites: [opts.suite], label: opts.suite === "all" ? "code(quality)" : "code(test)" });
}

/**
 * Bounded check -> fix loop: a known command finds the failure, the builder
 * repairs it. Always guards the last iteration — a fix on the final attempt
 * is never re-verified, so it is never spawned. Sets state.accepted/reason.
 */
export function fixLoop(opts: { suite: "test" | "all"; max?: number; owner?: string } = { suite: "test" }): Step {
  const max = opts.max ?? 3;
  const owner = opts.owner ?? "builder";
  const stepName = opts.suite === "all" ? "verify" : "test";
  const what = opts.suite === "all" ? "verification" : "tests";
  const fn = async (run: Run, state: ChainState) => {
    let result: QualityResult | null = null;
    for (let i = 1; i <= max; i++) {
      result = await run.phase(
        makePhaseParams({
          name: `${stepName}_${i}`,
          kind: "code",
          owner: "quality",
          description:
            opts.suite === "all"
              ? "Lint, typecheck, and build before testing"
              : "Run the suite — a known command, so code runs it and no agent has to rediscover it",
        }),
        async (ph) => {
          const r = opts.suite === "all" ? quality.runQuality(run) : quality.runTests(run);
          quality.record(ph, r);
          return r;
        },
      );

      if (result.passed) break;
      if (i === max) break; // never leave an unverified fix on the table

      state.previous = await run.phase(
        makePhaseParams({ name: `fix_${i}`, kind: "agent", owner, retries: 1, description: "Repair what the suite reported, from its verbatim output" }),
        (ph) =>
          ph.call(
            makeAgentCall({
              output_type: BuildOutput,
              prompt: state.prompt,
              previous: quality.asEnvelope(result!, what),
              gates: [gates.diffMatchesClaims],
            }),
          ),
      );
    }
    state.quality = result;
    state.accepted = result !== null && result.passed;
    state.reason = state.accepted ? "" : `the suite still failed after ${max} fix attempt(s)`;
  };
  return makeStep(fn, {
    requiredAgents: [owner],
    requiredSuites: [opts.suite],
    label: `code(${stepName}) [-> ${owner}(fix) -> code(${stepName}) ...] bounded`,
  });
}

/** Bounded review -> revise loop. Sets state.accepted/reason from the final verdict. */
export function reviseLoop(opts: { max?: number } = {}): Step {
  const max = opts.max ?? 3;
  const fn = async (run: Run, state: ChainState) => {
    let review: ReviewOutputT | null = null;
    for (let i = 1; i <= max; i++) {
      review = await run.phase(
        makePhaseParams({ name: `review_${i}`, kind: "agent", owner: "reviewer", description: "Rule on every requirement in the spec, against the code on disk" }),
        (ph) => ph.call(makeAgentCall({ output_type: ReviewOutput, prompt: state.prompt, previous: state.previous, gates: [gates.artifactsExist, gates.verdictConsistent] })),
      );

      if (review.approved || i === max) break;

      state.previous = await run.phase(
        makePhaseParams({ name: `revise_${i}`, kind: "agent", owner: "builder", retries: 1, description: "Close every blocking finding the reviewer named" }),
        (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt: state.prompt, previous: review!, gates: [gates.diffMatchesClaims] })),
      );
    }
    state.review = review;
    state.accepted = review !== null && review.approved;
    state.reason = state.accepted ? "" : `the reviewer never approved after ${max} revision(s)`;
  };
  return makeStep(fn, { requiredAgents: ["reviewer", "builder"], label: "reviewer [-> builder(revise) -> reviewer ...] bounded" });
}

/** Commit the last agent step's envelope. `onlyIfAccepted` gates it on state.accepted (a preceding fixLoop/reviseLoop). */
export function commit(opts: { onlyIfAccepted?: boolean } = {}): Step {
  const fn = async (run: Run, state: ChainState) => {
    if (opts.onlyIfAccepted && !state.accepted) return;
    if (!state.previous) throw new Error("commit() has nothing to commit — no preceding agent step produced an envelope");
    await run.phase(
      makePhaseParams({
        name: "commit",
        kind: "code",
        owner: "git",
        description: opts.onlyIfAccepted
          ? "Land the code only after the suite came back green"
          : "Land the builder's changes, using the message it wrote",
      }),
      async (ph) => commitEnvelope(run, ph, state.previous as EnvelopeBase & { commit_message?: string }),
    );
  };
  return makeStep(fn, { label: "git(commit)" });
}

/** Diff the working tree against a base ref — code, not judgement. `--base` (default "main") if opts.base is unset. */
export function changes(opts: { base?: string } = {}): Step {
  const fn = async (run: Run, state: ChainState) => {
    const base = opts.base ?? state.options["base"] ?? "main";
    const changeset = await run.phase(
      makePhaseParams({ name: "changes", kind: "code", owner: "git", description: `Diff the working tree against ${base} — the change to be written up` }),
      async (ph) => {
        const result = changesLib.capture(run, makeChangeCapture({ base }));
        logChangeset(ph, result);
        if (result.empty) {
          throw new Error(
            `nothing changed since ${result.base.label} (${result.base.reason}) — documenting runs after a build. ` +
              `Build something first, or point --base at the ref the work should be measured from.`,
          );
        }
        return result;
      },
    );
    state.changeset = changeset;
  };
  return makeStep(fn, { label: "code(changes)" });
}

/** Write up the captured change. Requires a preceding changes() step. */
export function document(): Step {
  const fn = async (run: Run, state: ChainState) => {
    if (!state.changeset) throw new Error("document() requires a preceding changes() step in the chain's step list");
    const envelope = await run.phase(
      makePhaseParams({ name: "document", kind: "agent", owner: "documenter", retries: 1, description: "Turn the captured diff into a write-up an engineer can read" }),
      (ph) =>
        ph.call(
          makeAgentCall({
            output_type: DocumentOutput,
            prompt: state.prompt,
            previous: changesLib.asEnvelope(state.changeset!, DOCUMENT_NOTES),
            gates: [gates.artifactsExist, gates.filesNonEmpty],
          }),
        ),
    );
    state.previous = envelope;
  };
  return makeStep(fn, { requiredAgents: ["documenter"], label: "documenter" });
}

// ── layer 3: derive ChainDefinition fields from a step list ─────────────

export function deriveRequiredAgents(steps: Step[]): string[] | ((options: Record<string, string>) => string[]) {
  const dynamicSteps = steps.filter((s): s is Step & { requiredAgents: (o: Record<string, string>) => string[] } => typeof s.requiredAgents === "function");
  const staticSteps = steps.filter((s): s is Step & { requiredAgents: string[] } => Array.isArray(s.requiredAgents));
  if (dynamicSteps.length === 0) {
    return [...new Set(staticSteps.flatMap((s) => s.requiredAgents))];
  }
  return (options: Record<string, string>) => {
    const set = new Set<string>();
    for (const s of staticSteps) for (const a of s.requiredAgents) set.add(a);
    for (const s of dynamicSteps) for (const a of s.requiredAgents(options)) set.add(a);
    return [...set];
  };
}

export function deriveRequiredSuites(steps: Step[]): string[] {
  const set = new Set<string>();
  for (const s of steps) for (const suite of s.requiredSuites ?? []) set.add(suite);
  return [...set];
}

/** A display string for `spf list` — derived so it can no longer drift from what actually runs. */
export function derivePhases(steps: Step[]): string {
  return steps.map((s) => s.label ?? "?").join(" -> ");
}

// ── the driver ────────────────────────────────────────────────────────────

/** Run a chain's step list start to finish: prologue, every step in order, then run.finish(). */
export async function runSteps(
  ctx: ChainContext,
  requiredAgents: string[],
  requiredSuites: string[],
  steps: Step[],
  options: Record<string, string> = {},
): Promise<number> {
  const run = startRun(ctx, requiredAgents, requiredSuites);
  const state = makeState(ctx.prompt, options);
  for (const step of steps) {
    await step(run, state);
  }
  return run.finish(state.accepted, state.reason);
}
