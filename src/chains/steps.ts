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
 * composition layer. That is what makes a declarative (YAML) chain
 * tractable: it only ever names steps and passes them tuning params, never
 * expresses control flow. `chains/repo_chains.ts` is that reader — every
 * factory below is a name a `.spf/chains/*.yaml` file may use, and its
 * `opts` object is that step's entire vocabulary.
 *
 * Consequences of being that vocabulary, all of which apply to the code
 * below and none of which are cosmetic:
 *
 *  - EVERY DEFAULT IS A PUBLISHED DEFAULT. `src/test/chains.test.ts` pins the
 *    exact `phases`/`requiredAgents`/`requiredSuites` strings every built-in
 *    chain derives from these factories. A factory called with no opts must
 *    keep producing byte-identical output forever; if a default label moves,
 *    that is a bug in this file, not in the test.
 *  - PARAMS ADD, THEY DO NOT SUBTRACT. A repo-local chain is data supplied by
 *    the target repo; it may widen what a step does (an extra gate, a
 *    different owner, more retries) but it must never be able to weaken the
 *    checks spf itself imposes. See GATE_ALLOWLIST below for the one place
 *    that rule bites hardest.
 *  - A BAD PARAM MUST FAIL AT DEFINITION TIME. A factory validates what it
 *    can the moment it is called (see `preflightDescription`), so a malformed
 *    chain is a load-time problem the loader can report against a file and a
 *    line, never a phase that blows up ten minutes into an unattended run.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import * as changesLib from "../core/changes.ts";
import * as gates from "../core/gates.ts";
import * as quality from "../core/quality.ts";
import * as agentsCfg from "../core/agents.ts";
import * as session from "../core/session.ts";
import * as refineLib from "../core/refine.ts";
import * as tiering from "../core/tiering.ts";
import { DOCUMENT_NOTES } from "../core/prompts.ts";
import {
  BuildOutput,
  DocumentOutput,
  GenericOutput,
  PlanOutput,
  RefineOutput,
  ReviewOutput,
  ScoutOutput,
  makeAgentCall,
  makeChangeCapture,
  makeEventRecord,
  makePhaseParams,
  type EnvelopeBase,
  type EnvelopeType,
  type GateFn,
  type QualityResult,
  type RefinedIssue,
  type RefineQuestion,
  type ReviewOutputT,
} from "../core/data_types.ts";
import type { ChangeSet } from "../core/data_types.ts";
import { Run, type PhaseHandle } from "../core/runner.ts";
import type { ChainContext } from "./context.ts";
import type { CommitterIdentity } from "../core/git_helper.ts";

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
  /**
   * The originating tracker issue, only meaningful to `publishIssues()` —
   * lifted from `ChainContext.issue_id` (see its doc comment) because a
   * `Step` only ever sees `(run, state)`, never the `ChainContext` itself.
   */
  issue_id: string | null;
  /** The run's own acceptance criterion — distinct from "every phase succeeded"; see Run.finish(). */
  accepted: boolean;
  /** Why not, when accepted is false — passed straight to run.finish(). */
  reason: string;
}

function makeState(prompt: string, options: Record<string, string>, issueId: string | null): ChainState {
  return { prompt, options, previous: null, quality: null, review: null, changeset: null, baseline: "", issue_id: issueId, accepted: true, reason: "" };
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
  /** Static for most quality/fixLoop steps; dynamic wherever --suite can override the compiled-in default (see qualityCheck/fixLoop). */
  requiredSuites?: string[] | ((options: Record<string, string>) => string[]);
  /** Display fragment for derivePhases() — e.g. "planner", "git(commit)". */
  label?: string;
}

function makeStep(
  fn: (run: Run, state: ChainState) => Promise<void>,
  meta: { requiredAgents?: Step["requiredAgents"]; requiredSuites?: Step["requiredSuites"]; label?: string } = {},
): Step {
  const step = fn as Step;
  step.requiredAgents = meta.requiredAgents;
  step.requiredSuites = meta.requiredSuites;
  step.label = meta.label;
  return step;
}

// ── layer 1: the shared prologue ────────────────────────────────────────

/**
 * The identical loadConfig -> validate -> session.ensure prologue every
 * chain repeated. `async` since the tiering availability probe below is an
 * awaited `fetch` — firing it unawaited would let `agents.execute` read
 * `run.tiering` before the probe resolved. Both call sites are already
 * inside `async` functions, so this stays a one-token change for each.
 */
export async function startRun(ctx: ChainContext, requiredAgents: string[], requiredSuites: string[]): Promise<Run> {
  const cfg = agentsCfg.loadConfig(ctx.config_paths);
  agentsCfg.validate(cfg, requiredAgents, requiredSuites, ctx.cwd);
  const run = session.ensure(cfg, ctx.adw_id, ctx.cwd, ctx.chain_name);
  // Provenance, once per run, before any phase opens: a repo-local chain
  // (.spf/chains/*.yaml) records the file it came from. `chain_name` alone
  // stops being enough to reconstruct a run the moment a target repo can
  // ship its own chain definitions — the same name can mean a different
  // step list next week, and the trace is the only copy that does not
  // change when the yaml does.
  //
  // Deliberately a `type: "log"` event with a `chain_source` name, NOT a new
  // event kind: EventRecord.type is a closed picklist mirrored by the UI
  // (data_types.ts's EVENT_RECORD_TYPES <-> ui/shared/types.ts's EventType),
  // and "this run's chain came from a file" is not a new lifecycle stage —
  // it is a note. Adding a picklist member would force a UI change for a
  // payload the UI already renders generically.
  if (ctx.chain_source) {
    run.tracer.event(
      makeEventRecord({ adw_id: run.adw_id, type: "log", name: "chain_source", payload: { source: ctx.chain_source } }),
    );
  }

  // Tiering resolution (SPF #14) — one more run-scoped fact, computed once,
  // before any phase opens, beside chain_source above. `risk`/`signals` are
  // always computed (a pure function of chain name + prompt); `routing`/
  // `notes` are only ever non-empty when `cfg.tiering.enabled` — see
  // `resolveTiering`'s own no-op guarantee.
  const servedOllamaTags = await tiering.probeServedOllamaTags(cfg);
  run.tiering = tiering.resolveTiering({
    cfg,
    chainName: ctx.chain_name,
    prompt: ctx.prompt,
    servedOllamaTags,
    required: requiredAgents,
  });
  run.tracer.event(
    makeEventRecord({
      adw_id: run.adw_id,
      type: "log",
      name: "tiering",
      payload: {
        risk: run.tiering.risk,
        signals: run.tiering.signals,
        routing: run.tiering.routing,
        notes: run.tiering.notes,
      },
    }),
  );
  // One console line per RETIERED agent (changedModels — not per routing
  // entry: a role whose tier resolves to the model it was already
  // configured with is not news). Routed through the existing
  // `Console.note()` — no new Console method. This is what reconciles
  // `run.cfg.agents[].model` (which keeps the configured value) with
  // `agent_sessions.model` (which records the effective one) for a human
  // reading the console when the two disagree.
  for (const [agentName, effective] of Object.entries(tiering.changedModels(run.tiering))) {
    const route = run.tiering.routing[agentName]!;
    run.console.note(`[spf] tiering ${agentName} ${route.tier} (${route.configured} -> ${effective}) risk=${run.tiering.risk}`);
  }

  return run;
}

/** A trailer line: `Key: value...`, one per line, no blank lines inside the block. */
const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*: .+$/;

/**
 * Append `trailer` as a proper trailer: joined into the message's existing
 * trailer block (its LAST paragraph, if every line there is already
 * `Key: value` shaped) or, failing that, appended after a blank line of its
 * own — never glued onto prose with no separation. `commitEnvelope` builds
 * its message from agent-authored free text, so this cannot assume the
 * message already ends cleanly.
 *
 * A single paragraph is never treated as a trailer block, even when it
 * happens to be `Key: value` shaped — a lone paragraph is the commit's
 * SUBJECT line, and every conventional-commit subject (`feat: add X`,
 * `fix: handle Y`) matches that shape. Joining onto it directly (no blank
 * line) would glue the trailer onto the subject itself — invisible to git
 * as a trailer at all (`git interpret-trailers` requires the trailer block
 * to be its own paragraph, separated from the subject by a blank line).
 * Only a message that ALREADY has a body — at least two paragraphs — can
 * have an existing trailer block to join.
 */
function appendTrailer(message: string, trailer: string): string {
  const trimmed = message.replace(/\s+$/, "");
  if (!trimmed) return trailer;
  const paragraphs = trimmed.split(/\n[ \t]*\n/);
  const last = paragraphs[paragraphs.length - 1];
  const lastLines = last.split("\n").map((l) => l.trim()).filter(Boolean);
  const isTrailerBlock = paragraphs.length > 1 && lastLines.length > 0 && lastLines.every((l) => TRAILER_LINE.test(l));
  if (isTrailerBlock) {
    paragraphs[paragraphs.length - 1] = `${last}\n${trailer}`;
    return paragraphs.join("\n\n");
  }
  return `${trimmed}\n\n${trailer}`;
}

/**
 * Commit an envelope in its own author's words — the message-fallback four
 * chains repeated.
 *
 * `signoff`, when passed, MUST be a human's own recorded explicit "yes" —
 * see `chains/simple_sdlc.ts`'s `decideSignoff`, the only caller that ever
 * passes one. It is appended as a real `Signed-off-by:` trailer (blank-line
 * separated, or joined into an existing trailer block — see
 * `appendTrailer`). Every other caller (every chain built from `./steps.ts`'s
 * own `commit()`, plus `simple_sdlc`'s `commit_plan`/`commit_docs`) passes
 * nothing, because nothing gates those commits on an AI verdict — the
 * `fixLoop` chains gate on tests, which is the philosophy working. Omitted
 * -> no trailer, ever: a trailer that lies launders an AI verdict into a git
 * attestation.
 */
export function commitEnvelope(
  run: Run,
  ph: PhaseHandle,
  envelope: EnvelopeBase & { commit_message?: string },
  signoff?: CommitterIdentity | null,
): void {
  let message = envelope.commit_message || `spf(${run.adw_id}): ${envelope.summary}`;
  if (signoff) {
    const trailerLine = `Signed-off-by: ${signoff.name} <${signoff.email}>`;
    // An agent that already wrote its own sign-off line (verbatim) does not
    // get a second, duplicate one.
    const alreadyPresent = message.split("\n").some((line) => line.trim() === trailerLine);
    if (!alreadyPresent) message = appendTrailer(message, trailerLine);
  }
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

// ── layer 1.5: the params a chain DEFINITION may supply ─────────────────

/**
 * The gates a chain definition is allowed to name, by name.
 *
 * An EXPLICIT map, not `gates` itself and not a lookup on `gates[name]`:
 * `core/gates.ts` is a module of exported functions, and reflecting over it
 * would silently promote every future export (and every internal helper that
 * ever gets exported for a test) into the surface a target repo's YAML can
 * reach. Adding a gate to this map is a deliberate, reviewable act.
 *
 * CRITICAL POLICY — this map backs `extraGates`, which is ADDITIVE ONLY. A
 * step's built-in gates are NON-REMOVABLE: there is no `gates:` param that
 * replaces them, and there must never be one.
 *
 * The reason is what a repo-local chain IS. SPF's contract is "agent
 * proposes, code disposes", and the code that disposes is SPF'S code — that
 * is precisely why chains load as data (YAML naming these factories) instead
 * of as imported repo code. A `gates: []` override would hand that back:
 * the target repo would be editing its own disposer, and the first thing
 * anyone under deadline pressure deletes is the gate that keeps failing —
 * `diffMatchesClaims` (the builder claimed files it never wrote) or
 * `verdictConsistent` (the reviewer approved while listing blockers).
 * Those two are exactly the checks that catch an agent grading its own
 * homework, and `spf watch` runs chains UNATTENDED (see
 * `ChainContext.unattended`), so nobody is at the console to notice they
 * stopped running. A weaker chain must therefore be un-expressible, not
 * merely discouraged.
 *
 * `gates.testsPass` is deliberately absent: it is a FACTORY over a shell
 * command string, so allowing it by name would mean letting a YAML file
 * name an arbitrary command to execute inside a gate. Commands belong in
 * `quality.checks`/`quality.suites` in spf.config.yaml, where
 * `core/quality.ts` owns them and `core/permissions.ts` applies. If a
 * command-running gate is ever wanted here, it needs its own param with its
 * own review, not an entry in this map.
 */
export const GATE_ALLOWLIST: Readonly<Record<string, GateFn>> = Object.freeze({
  artifactsExist: gates.artifactsExist,
  filesNonEmpty: gates.filesNonEmpty,
  jsonParses: gates.jsonParses,
  diffMatchesClaims: gates.diffMatchesClaims,
  verdictConsistent: gates.verdictConsistent,
});

/** Every name a chain definition may put in SOME `extraGates` param — for the module-level backstop in `resolveExtraGates` only. Schema validation must use the narrower, per-param lists below, never this one. */
export const GATE_NAMES: readonly string[] = Object.freeze(Object.keys(GATE_ALLOWLIST));

/**
 * Which gate names are meaningful on which envelope shape — the missing
 * per-step subset `GATE_ALLOWLIST` never had. `GATE_ALLOWLIST` says "these
 * functions exist and are the ones a chain may ever name"; these three lists
 * say "here is the subset that reads fields THIS envelope actually has."
 *
 * `artifactsExist`/`filesNonEmpty`/`jsonParses` only ever read
 * `envelope.artifacts`, which every envelope has (see `EnvelopeBase`) — safe
 * anywhere. `diffMatchesClaims` reads `changed_files`, which only a
 * `BuildOutput`-shaped envelope populates; naming it on a step whose
 * envelope is something else (e.g. a review) makes it read an absent field
 * as `[]` and pass vacuously — silent, not a real check. `verdictConsistent`
 * reads `approved`/`blocking`/`findings`, which only a review envelope
 * populates; on anything else its "rejection names a problem" check reads
 * `approved: false` with nothing to blame and fails EVERY time, which is
 * exactly the shape of bug this module exists to make load-time-visible
 * instead of run-time-fatal.
 */
export const GENERIC_GATE_NAMES: readonly string[] = Object.freeze(["artifactsExist", "filesNonEmpty", "jsonParses"]);
export const BUILD_ENVELOPE_GATE_NAMES: readonly string[] = Object.freeze([...GENERIC_GATE_NAMES, "diffMatchesClaims"]);
export const REVIEW_ENVELOPE_GATE_NAMES: readonly string[] = Object.freeze([...GENERIC_GATE_NAMES, "verdictConsistent"]);

/**
 * Resolve `extraGates` names to functions, throwing on an unknown one.
 *
 * The loader validates names against `GATE_NAMES` first, so in practice a
 * YAML typo is reported as a load problem and never reaches here; this
 * throw is the backstop for a programmatic caller (a test, a built-in chain)
 * and for any future path that forgets to pre-validate. Failing loudly at
 * factory-call time beats an `undefined` landing in a gate list and blowing
 * up mid-phase.
 */
function resolveExtraGates(names: string[] | undefined): GateFn[] {
  if (!names || names.length === 0) return [];
  return names.map((name) => {
    const gate = GATE_ALLOWLIST[name];
    if (!gate) {
      throw new Error(`unknown gate ${JSON.stringify(name)} — allowed: ${GATE_NAMES.join(", ")}`);
    }
    return gate;
  });
}

/** Built-in gates first, in their compiled-in order, then whatever the definition added. Never fewer. */
function withExtraGates(builtIn: GateFn[], extra: string[] | undefined): GateFn[] {
  return [...builtIn, ...resolveExtraGates(extra)];
}

/**
 * Validate a chain-definition-supplied `description` NOW, at factory-call
 * time, instead of letting `makePhaseParams` reject it when the phase opens.
 *
 * `makePhaseParams` throws on a blank description and on one that merely
 * echoes the phase name (see PhaseParamsSchema) — a rule worth keeping
 * exactly as strict for a repo-authored description as for spf's own. But a
 * chain definition is read minutes or hours before the phase it describes
 * runs: `repo_chains.ts` builds every step at LOAD time, so a bad
 * description surfaces there as a `{file, message}` problem, and an
 * unattended `spf watch` run never starts a session it was always going to
 * abort in phase four.
 *
 * The phase name used here is the step's STATIC name. Two steps compute
 * their real name at run time from `--suite` (`qualityCheck`, `fixLoop`)
 * and the loops append an iteration counter (`test_1`, `fix_1`) — so this
 * is a pre-flight, not a replacement for the real check inside
 * `makePhaseParams`, which still runs on the actual name. Both are wanted:
 * this one catches the definition, that one catches the run.
 */
function preflightDescription(phaseName: string, description: string | undefined): void {
  if (description === undefined) return;
  // kind/owner are irrelevant to the description rule; any valid pair works.
  // Thrown as-is on purpose: makePhaseParams' message already names the phase
  // and says what is wrong, and the loader prefixes the file it came from.
  makePhaseParams({ name: phaseName, kind: "code", owner: "spf", description });
}

// ── layer 2: step factories ──────────────────────────────────────────────

/** The engineer(request) phase every chain opens with. */
export function request(opts: { description?: string; logBaseline?: boolean } = {}): Step {
  preflightDescription("request", opts.description);
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

/**
 * `owner` names WHO plans, defaulting to the `planner` agent. It flows
 * straight into `agentStep`'s existing owner argument, which is also what
 * `makeStep` records as `requiredAgents` and as the display `label` — so a
 * chain that plans with a differently-named agent updates its own
 * `spf list` line and its own config validation with no second place to
 * edit. Same shape for `build`/`scout`/`document` below.
 */
export function plan(opts: { owner?: string; description?: string; retries?: number; extraGates?: string[] } = {}): Step {
  preflightDescription("plan", opts.description);
  return agentStep({
    name: "plan",
    owner: opts.owner ?? "planner",
    output_type: PlanOutput,
    description: opts.description ?? "Turn the request into an implementable plan",
    gates: withExtraGates([gates.artifactsExist, gates.filesNonEmpty], opts.extraGates),
    retries: opts.retries ?? 0,
  });
}

/**
 * `fromPlan` only changes the description — whether a plan() step precedes
 * this one already decides whether `state.previous` is a plan or null, so
 * there is nothing else for this flag to gate. An explicit `description`
 * therefore makes `fromPlan` moot; it is still accepted rather than made
 * mutually exclusive, because the two chains that pass `fromPlan` today read
 * better for it and a definition that sets both is not ambiguous (the
 * explicit text wins).
 */
export function build(opts: { fromPlan?: boolean; owner?: string; description?: string; retries?: number; extraGates?: string[] } = {}): Step {
  const fromPlan = opts.fromPlan ?? true;
  preflightDescription("build", opts.description);
  return agentStep({
    name: "build",
    owner: opts.owner ?? "builder",
    output_type: BuildOutput,
    description: opts.description ?? (fromPlan ? "Implement the plan exactly" : "Implement the request"),
    gates: withExtraGates([gates.diffMatchesClaims], opts.extraGates),
    retries: opts.retries ?? 0,
  });
}

export function scout(opts: { owner?: string; description?: string; retries?: number; extraGates?: string[] } = {}): Step {
  preflightDescription("scout", opts.description);
  return agentStep({
    name: "scout",
    owner: opts.owner ?? "scout",
    output_type: ScoutOutput,
    description: opts.description ?? "Find and report where things live — change nothing",
    gates: withExtraGates([gates.artifactsExist], opts.extraGates),
    retries: opts.retries ?? 0,
  });
}

/**
 * The `prompt` chain's one step: --agent picks who, at run time and at
 * requiredAgents-derivation time alike.
 *
 * No `owner` param, unlike the steps above: this step's whole purpose is
 * that the OPERATOR chooses the agent at invocation time, so an owner baked
 * into a definition would defeat it. A chain that wants a fixed agent
 * already has one — that is what `plan`/`build`/`scout` with an `owner` are.
 * `extraGates` is accepted (the default is genuinely no gates — a generic
 * envelope claims nothing specific) so a definition can still demand, say,
 * that whatever files the agent claims actually exist.
 */
export function promptOnly(opts: { description?: string; retries?: number; extraGates?: string[] } = {}): Step {
  preflightDescription("prompt", opts.description);
  const fn = async (run: Run, state: ChainState) => {
    const owner = state.options["agent"] ?? "builder";
    const envelope = await run.phase(
      makePhaseParams({
        name: "prompt",
        kind: "agent",
        owner,
        description: opts.description ?? `Send the request straight to ${owner} and parse its envelope`,
        retries: opts.retries ?? 0,
      }),
      (ph) =>
        ph.call(
          makeAgentCall({
            output_type: GenericOutput,
            prompt: state.prompt,
            previous: state.previous,
            gates: resolveExtraGates(opts.extraGates),
          }),
        ),
    );
    state.previous = envelope;
  };
  return makeStep(fn, { requiredAgents: (options) => [options["agent"] ?? "builder"], label: "<agent>" });
}

/**
 * One deterministic quality block, standalone — never throws; sets
 * state.accepted for run.finish() to check.
 *
 * `opts.suite` names any suite in `quality.suites`, not just "test"/"all" —
 * those two keep their historical phase name ("test"/"quality") and
 * description; any other configured suite name is used verbatim for both, so
 * a chain naming a custom suite still reads truthfully in its trace and in
 * `spf list`. `--suite` (see run.ts) overrides the compiled-in default at
 * invocation time, the same way `promptOnly()` lets `--agent` override its
 * owner.
 */
export function qualityCheck(opts: { suite: string; description?: string } = { suite: "all" }): Step {
  const staticName = opts.suite === "all" ? "quality" : opts.suite;
  // No extraGates here, and none below on fixLoop's suite phase either: a
  // gate validates an AGENT's envelope against reality (see core/gates.ts).
  // A `code` phase has no envelope to check — its command's exit status IS
  // the check. Widening a deterministic block belongs in
  // `quality.checks`/`quality.suites`, not in a gate list.
  preflightDescription(staticName, opts.description);
  const fn = async (run: Run, state: ChainState) => {
    const suiteName = state.options["suite"] ?? opts.suite;
    const name = suiteName === "all" ? "quality" : suiteName;
    await run.phase(
      makePhaseParams({
        name,
        kind: "code",
        owner: "quality",
        description:
          opts.description ??
          (suiteName === "all" ? "Run the deterministic quality blocks" : "Run the suite — a known command, so code runs it and no agent has to rediscover it"),
      }),
      async (ph) => {
        const result = quality.runSuite(run, suiteName);
        quality.record(ph, result);
        state.quality = result;
        state.accepted = result.passed;
        state.reason = result.passed ? "" : `quality failed: ${result.failures.join("; ")}`;
      },
    );
  };
  return makeStep(fn, {
    requiredSuites: (options) => [options["suite"] ?? opts.suite],
    label: `code(${staticName})`,
  });
}

/**
 * Bounded check -> fix loop: a known command finds the failure, the builder
 * repairs it. Always guards the last iteration — a fix on the final attempt
 * is never re-verified, so it is never spawned. Sets state.accepted/reason.
 *
 * `opts.suite` names any suite in `quality.suites` — "all" alone keeps its
 * historical "verify"/"verification" naming; every other suite (including
 * the default, "test") is named for itself, exactly as in `qualityCheck()`.
 * `--suite` (run.ts) overrides the compiled-in default at invocation time.
 */
export function fixLoop(
  opts: {
    suite: string;
    max?: number;
    owner?: string;
    /** The suite phase's description (`test_1`, `verify_1`, ...). */
    description?: string;
    /** The repair phase's description (`fix_1`, ...) — a separate phase, so a separate override. */
    fixDescription?: string;
    fixRetries?: number;
    fixExtraGates?: string[];
  } = { suite: "test" },
): Step {
  const max = opts.max ?? 3;
  const owner = opts.owner ?? "builder";
  const staticStepName = opts.suite === "all" ? "verify" : opts.suite;
  const fixGates = withExtraGates([gates.diffMatchesClaims], opts.fixExtraGates);
  preflightDescription(staticStepName, opts.description);
  preflightDescription("fix", opts.fixDescription);
  const fn = async (run: Run, state: ChainState) => {
    const suiteName = state.options["suite"] ?? opts.suite;
    const stepName = suiteName === "all" ? "verify" : suiteName;
    const what = suiteName === "all" ? "verification" : suiteName === "test" ? "tests" : suiteName;
    let result: QualityResult | null = null;
    for (let i = 1; i <= max; i++) {
      result = await run.phase(
        makePhaseParams({
          name: `${stepName}_${i}`,
          kind: "code",
          owner: "quality",
          description:
            opts.description ??
            (suiteName === "all"
              ? "Lint, typecheck, and build before testing"
              : "Run the suite — a known command, so code runs it and no agent has to rediscover it"),
        }),
        async (ph) => {
          const r = quality.runSuite(run, suiteName);
          quality.record(ph, r);
          return r;
        },
      );

      if (result.passed) break;
      if (i === max) break; // never leave an unverified fix on the table

      state.previous = await run.phase(
        makePhaseParams({
          name: `fix_${i}`,
          kind: "agent",
          owner,
          retries: opts.fixRetries ?? 1,
          description: opts.fixDescription ?? "Repair what the suite reported, from its verbatim output",
        }),
        (ph) =>
          ph.call(
            makeAgentCall({
              output_type: BuildOutput,
              prompt: state.prompt,
              previous: quality.asEnvelope(result!, what),
              gates: fixGates,
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
    requiredSuites: (options) => [options["suite"] ?? opts.suite],
    label: `code(${staticStepName}) [-> ${owner}(fix) -> code(${staticStepName}) ...] bounded`,
  });
}

/**
 * Bounded review -> revise loop. Sets state.accepted/reason from the final
 * verdict.
 *
 * `reviewer`/`builder` name the two agents by role, defaulting to the agents
 * literally called "reviewer" and "builder". They are two params rather than
 * one because the whole point of this loop is that the critic and the author
 * are DIFFERENT agents — a chain that points both at the same name has an
 * agent reviewing its own work, which is the failure mode
 * `gates.verdictConsistent` exists to make visible. Nothing here enforces
 * that they differ (a repo may legitimately have one strong agent and want
 * the self-review anyway), but the trace will say so plainly: the derived
 * label below is built from these names, so `spf list` and the run's phases
 * both read `x [-> x(revise) -> x ...]`.
 */
export function reviseLoop(
  opts: {
    max?: number;
    reviewer?: string;
    builder?: string;
    /** The review phase's description (`review_1`, ...). */
    description?: string;
    retries?: number;
    extraGates?: string[];
    /** The revise phase's description (`revise_1`, ...) — a separate phase, so a separate override. */
    reviseDescription?: string;
    reviseRetries?: number;
    reviseExtraGates?: string[];
  } = {},
): Step {
  const max = opts.max ?? 3;
  const reviewer = opts.reviewer ?? "reviewer";
  const builder = opts.builder ?? "builder";
  const reviewGates = withExtraGates([gates.artifactsExist, gates.verdictConsistent], opts.extraGates);
  const reviseGates = withExtraGates([gates.diffMatchesClaims], opts.reviseExtraGates);
  preflightDescription("review", opts.description);
  preflightDescription("revise", opts.reviseDescription);
  const fn = async (run: Run, state: ChainState) => {
    let review: ReviewOutputT | null = null;
    for (let i = 1; i <= max; i++) {
      review = await run.phase(
        makePhaseParams({
          name: `review_${i}`,
          kind: "agent",
          owner: reviewer,
          retries: opts.retries ?? 0,
          description: opts.description ?? "Rule on every requirement in the spec, against the code on disk",
        }),
        (ph) => ph.call(makeAgentCall({ output_type: ReviewOutput, prompt: state.prompt, previous: state.previous, gates: reviewGates })),
      );

      if (review.approved || i === max) break;

      state.previous = await run.phase(
        makePhaseParams({
          name: `revise_${i}`,
          kind: "agent",
          owner: builder,
          retries: opts.reviseRetries ?? 1,
          description: opts.reviseDescription ?? "Close every blocking finding the reviewer named",
        }),
        (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt: state.prompt, previous: review!, gates: reviseGates })),
      );
    }
    state.review = review;
    state.accepted = review !== null && review.approved;
    state.reason = state.accepted ? "" : `the reviewer never approved after ${max} revision(s)`;
  };
  // requiredAgents deduplicates via deriveRequiredAgents' Set, so pointing
  // both roles at one agent yields a one-name list, not a duplicate.
  return makeStep(fn, {
    requiredAgents: [reviewer, builder],
    label: `${reviewer} [-> ${builder}(revise) -> ${reviewer} ...] bounded`,
  });
}

/** Commit the last agent step's envelope. `onlyIfAccepted` gates it on state.accepted (a preceding fixLoop/reviseLoop). */
export function commit(opts: { onlyIfAccepted?: boolean; description?: string } = {}): Step {
  preflightDescription("commit", opts.description);
  const fn = async (run: Run, state: ChainState) => {
    if (opts.onlyIfAccepted && !state.accepted) return;
    if (!state.previous) throw new Error("commit() has nothing to commit — no preceding agent step produced an envelope");
    await run.phase(
      makePhaseParams({
        name: "commit",
        kind: "code",
        owner: "git",
        description:
          opts.description ??
          (opts.onlyIfAccepted ? "Land the code only after the suite came back green" : "Land the builder's changes, using the message it wrote"),
      }),
      async (ph) => commitEnvelope(run, ph, state.previous as EnvelopeBase & { commit_message?: string }),
    );
  };
  return makeStep(fn, { label: "git(commit)" });
}

/** Diff the working tree against a base ref — code, not judgement. `--base` (default "main") if opts.base is unset. */
export function changes(opts: { base?: string; description?: string } = {}): Step {
  preflightDescription("changes", opts.description);
  const fn = async (run: Run, state: ChainState) => {
    const base = opts.base ?? state.options["base"] ?? "main";
    const changeset = await run.phase(
      makePhaseParams({
        name: "changes",
        kind: "code",
        owner: "git",
        // The default names the base it actually diffed against, which is only
        // known once --base is resolved — an override trades that for whatever
        // the definition says, so it should say something at least as specific.
        description: opts.description ?? `Diff the working tree against ${base} — the change to be written up`,
      }),
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
export function document(opts: { owner?: string; description?: string; retries?: number; extraGates?: string[] } = {}): Step {
  const owner = opts.owner ?? "documenter";
  const docGates = withExtraGates([gates.artifactsExist, gates.filesNonEmpty], opts.extraGates);
  preflightDescription("document", opts.description);
  const fn = async (run: Run, state: ChainState) => {
    if (!state.changeset) throw new Error("document() requires a preceding changes() step in the chain's step list");
    const envelope = await run.phase(
      makePhaseParams({
        name: "document",
        kind: "agent",
        owner,
        // Default 1, not 0: a write-up's gates check files the documenter
        // claims it wrote, and "wrote the file somewhere else" is a mistake
        // the same session fixes on a re-prompt. Historical behavior; kept as
        // the default so an existing chain is unchanged.
        retries: opts.retries ?? 1,
        description: opts.description ?? "Turn the captured diff into a write-up an engineer can read",
      }),
      (ph) =>
        ph.call(
          makeAgentCall({
            output_type: DocumentOutput,
            prompt: state.prompt,
            previous: changesLib.asEnvelope(state.changeset!, DOCUMENT_NOTES),
            gates: docGates,
          }),
        ),
    );
    state.previous = envelope;
  };
  return makeStep(fn, { requiredAgents: [owner], label: owner });
}

/** Decompose the spec in `prompt` into a feature/story tree — see `RefinedIssueSchema`'s doc comment. Gated so a malformed tree (wrong container/leaf kinds, an unresolved reference, a dependency cycle) re-prompts the same session before publishIssues() ever runs. */
export function refine(opts: { owner?: string; description?: string; retries?: number; extraGates?: string[] } = {}): Step {
  preflightDescription("refine", opts.description);
  return agentStep({
    name: "refine",
    owner: opts.owner ?? "refiner",
    output_type: RefineOutput,
    description: opts.description ?? "Decompose the spec into a feature/story tree of vertical slices",
    // refinementWellFormed is NOT in GATE_ALLOWLIST — it is meaningless on
    // any other envelope type (it reads `issues`/`questions`), so there is
    // nothing to gain by letting a definition name it, and it stays
    // non-removable here.
    //
    // retries: 1, not 0 — this gate's own doc comment says a violation
    // "re-prompts the SAME refiner session before publishIssues() ever
    // runs." With 0 retries that was never true: agents.ts throws
    // GateFailure on the first violation and the whole spec goes straight to
    // spf:blocked with no correction round-trip. The mutual-exclusion rule
    // between `issues` and `questions` (see refinementWellFormed) makes that
    // mismatch more likely to bite in practice, not less.
    gates: withExtraGates([gates.refinementWellFormed], opts.extraGates),
    retries: opts.retries ?? 1,
  });
}

/**
 * Create the tree `refine()` produced on the tracker, in dependency order,
 * and link each node to its parent. A `code` phase, not an agent one — the
 * decision-making (topological order, label assignment, `## Blocked by`
 * rendering) is `core/refine.ts`'s job; this step is sequencing only, per
 * SKILL.md's "chains stay thin" rule. Requires a preceding refine() step.
 *
 * When the refiner raised material ambiguity instead of a tree
 * (`envelope.questions` non-empty — `gates.refinementWellFormed` already
 * guarantees `issues` is empty whenever that's true), this publishes
 * nothing: it writes those questions to
 * `<context_handoff_dir>/refine_questions.json` instead of
 * `refine_publish.json` and returns. That is a successful phase outcome, not
 * a failure — escalating to a human is a legitimate way for this chain to
 * end, same as publishing a tree is.
 *
 * Writes what it created (or asked) to `<context_handoff_dir>/`, one of
 * `refine_publish.json` or `refine_questions.json` — the side channel
 * `cli/commands/watch.ts`'s `runRefine` reads after the chain returns, since
 * a chain's own return value is just an exit code. `spf watch`'s own
 * marker/comment/transition bookkeeping for the spec issue (including
 * posting the questions and moving it to `needs-feedback`) lives entirely in
 * `core/watch.ts`'s `runSpec`/`escalateSpec`, never here — a bare `spf
 * refine` run (no daemon, no spec issue in play) still needs this step to
 * work standalone, and just leaves the questions on disk for a human to
 * read.
 */
export function publishIssues(opts: { description?: string } = {}): Step {
  preflightDescription("publish", opts.description);
  const fn = async (run: Run, state: ChainState) => {
    const envelope = state.previous as (EnvelopeBase & { issues?: RefinedIssue[]; questions?: RefineQuestion[] }) | null;
    if (!envelope || !Array.isArray(envelope.issues)) {
      throw new Error("publishIssues() requires a preceding refine() step in the chain's step list");
    }
    const questions = envelope.questions ?? [];
    await run.phase(
      makePhaseParams({
        name: "publish",
        kind: "code",
        owner: "tracker",
        description: opts.description ?? "Create the feature/story tree on the tracker, in dependency order, and link each to its parent",
      }),
      async (ph) => {
        if (questions.length > 0) {
          writeFileSync(path.join(run.context_handoff_dir, "refine_questions.json"), JSON.stringify(questions, null, 2));
          ph.log({ escalated: questions.length });
          return;
        }
        const tracker = refineLib.resolveAuthoringProvider(run.cfg);
        const created = await refineLib.publish(tracker, envelope.issues!, {
          labelPrefix: run.cfg.watch.label_prefix,
          specIssueId: state.issue_id,
        });
        writeFileSync(
          path.join(run.context_handoff_dir, "refine_publish.json"),
          JSON.stringify(created.map((c) => ({ id: c.issue.id, title: c.issue.title, kind: c.kind, isLeaf: c.isLeaf })), null, 2),
        );
        ph.log({ created: created.length, leaves: created.filter((c) => c.isLeaf).length });
      },
    );
  };
  return makeStep(fn, { label: "code(publish)" });
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

export function deriveRequiredSuites(steps: Step[]): string[] | ((options: Record<string, string>) => string[]) {
  const dynamicSteps = steps.filter((s): s is Step & { requiredSuites: (o: Record<string, string>) => string[] } => typeof s.requiredSuites === "function");
  const staticSteps = steps.filter((s): s is Step & { requiredSuites: string[] } => Array.isArray(s.requiredSuites));
  if (dynamicSteps.length === 0) {
    return [...new Set(staticSteps.flatMap((s) => s.requiredSuites))];
  }
  return (options: Record<string, string>) => {
    const set = new Set<string>();
    for (const s of staticSteps) for (const suite of s.requiredSuites) set.add(suite);
    for (const s of dynamicSteps) for (const suite of s.requiredSuites(options)) set.add(suite);
    return [...set];
  };
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
  const run = await startRun(ctx, requiredAgents, requiredSuites);
  const state = makeState(ctx.prompt, options, ctx.issue_id ?? null);
  for (const step of steps) {
    await step(run, state);
  }
  return run.finish(state.accepted, state.reason);
}
