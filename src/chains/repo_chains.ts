/**
 * Repo-local chains: `<repo>/.spf/chains/*.yaml` read as DATA.
 *
 * WHAT THIS IS. A target repo can compose its own chain out of the step
 * factories `./steps.ts` already exports, by naming them in a yaml file and
 * passing them params. One file, one chain:
 *
 *     # .spf/chains/ship-it.yaml
 *     name: ship-it
 *     describe: plan, build, test, land — with our own reviewer in the loop
 *     steps:
 *       - step: request
 *       - step: plan
 *         owner: architect
 *       - step: build
 *         retries: 2
 *         extraGates: [jsonParses]
 *       - step: fixLoop
 *         suite: test
 *       - step: commit
 *         onlyIfAccepted: true
 *
 * WHY DATA, AND NOT CODE. SPF's contract is "agent proposes, code disposes",
 * and the code that disposes is SPF'S code. A chain that could `import`
 * something out of the target repo would move the disposer into the repo
 * being worked on — the agent's own blast radius — and there would be
 * nothing left holding the line. So a repo chain names existing factories
 * and nothing else: no expressions, no shell, no module paths, no way to
 * introduce behavior that isn't already compiled into spf and covered by
 * spf's tests. It is also what keeps the promise that a target repo is
 * zero-setup and language-agnostic: the only thing it ever gains is `.spf/`,
 * with no build step, no dependency on this package, and nothing to compile.
 *
 * The counterpart rule lives in `steps.ts` (see GATE_ALLOWLIST): params may
 * only ADD. A repo chain can demand more checking than a built-in does; it
 * can never demand less.
 *
 * ONE RUN PATH. Every chain here is built with `index.ts`'s `stepChain()` —
 * the very same function the built-ins use — so it is a plain
 * `ChainDefinition` with a `steps` array, its `phases`/`requiredAgents`/
 * `requiredSuites` derived by the same code, executed by the same
 * `steps.runSteps()` driver. There is deliberately no second interpreter,
 * no "yaml runtime", and no branch anywhere downstream on "is this a repo
 * chain": the only difference a repo chain carries is `source`, the file it
 * came from, which exists so a run can be traced back to a definition that
 * may since have been edited.
 *
 * NEVER THROWS. `loadRepoChains()` returns `{ chains, problems }`. That is
 * not politeness: this function runs at CLI startup for EVERY command (see
 * `cli/index.ts`), so a single malformed yaml must not be able to break
 * `spf sessions`, `spf trace`, `spf doctor` or `spf --version` in a repo
 * that has one. Anything that goes wrong — unreadable directory, invalid
 * yaml, unknown step, wrong param type, bad description, unknown gate,
 * colliding name — becomes a `{ file, message }` problem carrying enough
 * detail to fix the file, and the other files still load.
 *
 * THE VOCABULARY IS THE FACTORY SIGNATURE. A step's yaml name is its
 * exported function name (`fixLoop`, `promptOnly`, `publishIssues`) and its
 * params are that function's `opts` keys, camelCase and all (`extraGates`,
 * `onlyIfAccepted`, `fromPlan`). No snake_case aliasing, no renaming layer:
 * a second spelling of the same thing is a second thing to keep in sync, and
 * a chain author reading `steps.ts` (or `spf list`) would be reading a
 * vocabulary that isn't the one they type. The schemas below are the ONE
 * place that mapping is written down; each mirrors exactly one factory's
 * `opts`, and adding a param to a factory without adding it here simply
 * means yaml cannot reach it yet (a safe, loud default: unknown params are
 * rejected, never ignored).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";
import { parse as parseYaml } from "yaml";
import type * as paths from "../core/paths.ts";
import * as steps from "./steps.ts";
import { BUILTIN_CHAIN_NAMES, stepChain, type ChainDefinition } from "./index.ts";

/** What went wrong in one file, and which file. */
export interface RepoChainProblem {
  /** Absolute path — the thing the operator has to open and edit. */
  file: string;
  message: string;
}

// ── the param vocabulary ─────────────────────────────────────────────────

/**
 * A step's yaml surface: the schema its params must satisfy, and how to
 * build the actual `Step` from them.
 *
 * `params` is redundant with the schema's own entries, and kept anyway: it
 * lets an unknown param be reported as `unknown param "ownr" — allowed:
 * owner, description, ...`, which is what an author needs, instead of
 * valibot's structural complaint about an unexpected key.
 */
export interface StepSpec {
  schema: v.GenericSchema;
  build: (params: any) => steps.Step;
  params: readonly string[];
}

/** Build a StepSpec from valibot entries, so the schema and `params` cannot disagree. */
function spec<E extends v.ObjectEntries>(entries: E, build: (params: v.InferOutput<v.StrictObjectSchema<E, undefined>>) => steps.Step): StepSpec {
  return {
    // strictObject, not object: an unrecognized param is a mistake worth
    // reporting. Silently ignoring `retires: 2` would leave an author
    // convinced they had configured something they hadn't.
    schema: v.strictObject(entries) as unknown as v.GenericSchema,
    build: build as (params: any) => steps.Step,
    params: Object.keys(entries),
  };
}

// `v.trim()` before `v.minLength(1)`: without it, a whitespace-only string
// ("   ") satisfies minLength and loads clean, producing an invisible blank
// where `spf list`/`spf doctor` would show an owner or a suite name — it
// does still fail closed (agents.validate() rejects the unknown/blank agent
// before anything spawns), but the failure names an agent nobody can see.
const Description = v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, "description must not be empty")));
const Owner = v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, "owner must name an agent from spf.config.yaml")));
/**
 * Upper bounds, not just lower ones — `retries`/`max` are the one lane with
 * nobody watching it (see `ChainContext.unattended`, and `GATE_ALLOWLIST`'s
 * comment for the same argument applied to gates instead of iteration
 * counts). `max: 100000` on `fixLoop` or `retries: 9999` on `build` is
 * accepted with no problem today — a single typo becomes unbounded agent
 * spawns under an unattended `spf watch` run, with nobody at the console to
 * notice. The bounds below sit a little above the highest value any
 * built-in chain uses (`fixLoop`/`reviseLoop` default `max` to 3, `document`
 * defaults `retries` to 1) — raise them deliberately here if a chain
 * genuinely needs more, rather than leaving the lane unbounded for everyone.
 */
const Retries = v.optional(
  v.pipe(
    v.number("retries must be a number"),
    v.integer("retries must be a whole number"),
    v.minValue(0, "retries must not be negative"),
    v.maxValue(5, "retries above 5 re-prompts the same agent more than any built-in chain does — raise this bound deliberately in repo_chains.ts if a chain genuinely needs it"),
  ),
);
const Max = v.optional(
  v.pipe(
    v.number("max must be a number"),
    v.integer("max must be a whole number"),
    v.minValue(1, "max must be at least 1"),
    v.maxValue(10, "max above 10 loops more than any built-in chain does — raise this bound deliberately in repo_chains.ts if a chain genuinely needs it"),
  ),
);
const Suite = v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, "suite must name a suite from quality.suites in spf.config.yaml")));
/**
 * Gate names, validated against a per-PARAM allowlist — never the flat
 * `steps.GATE_NAMES` (see `steps.ts`'s `GENERIC_GATE_NAMES` /
 * `*_ENVELOPE_GATE_NAMES` comment for why a global list is wrong here: a
 * gate that reads a field only one envelope shape populates is meaningless,
 * not merely unchecked, on every other step). Checked here so a typo — or a
 * gate that doesn't apply to this step's envelope — is a load-time problem
 * rather than either the throw `resolveExtraGates` would raise, or worse, a
 * gate that silently passes vacuously or fails every time at run time.
 */
function extraGatesSchema(allowed: readonly string[]) {
  return v.optional(
    v.array(v.picklist(allowed as string[], `unknown gate — allowed: ${allowed.join(", ")}`), "extraGates must be a list of gate names"),
  );
}
const GenericExtraGates = extraGatesSchema(steps.GENERIC_GATE_NAMES);
const BuildExtraGates = extraGatesSchema(steps.BUILD_ENVELOPE_GATE_NAMES);
const ReviewExtraGates = extraGatesSchema(steps.REVIEW_ENVELOPE_GATE_NAMES);

/**
 * One entry per exported flat-step factory in `steps.ts`. The key is what a
 * yaml `step:` names.
 *
 * `qualityCheck`/`fixLoop` default their `suite` HERE as well as in the
 * factory signature: the factory's default lives on the whole `opts` object
 * (`opts = { suite: "test" }`), which a yaml-supplied `{}` would satisfy
 * without ever supplying `suite`. Defaulting in the schema is what makes
 * `- step: fixLoop` with no params mean the same thing as `fixLoop()`.
 */
export const STEP_SPECS: Record<string, StepSpec> = {
  request: spec({ description: Description, logBaseline: v.optional(v.boolean("logBaseline must be true or false")) }, (p) =>
    steps.request(p),
  ),

  plan: spec({ owner: Owner, description: Description, retries: Retries, extraGates: GenericExtraGates }, (p) => steps.plan(p)),

  // extraGates: BuildExtraGates — build()'s envelope is a BuildOutput, so
  // diffMatchesClaims (already built in) is at least a coherent thing to
  // name again here; verdictConsistent never would be (see steps.ts).
  build: spec(
    {
      fromPlan: v.optional(v.boolean("fromPlan must be true or false")),
      owner: Owner,
      description: Description,
      retries: Retries,
      extraGates: BuildExtraGates,
    },
    (p) => steps.build(p),
  ),

  scout: spec({ owner: Owner, description: Description, retries: Retries, extraGates: GenericExtraGates }, (p) => steps.scout(p)),

  // No `owner`: this step's owner is chosen by `--agent` at invocation time —
  // see promptOnly()'s doc comment. Envelope is generic (GenericOutput), so
  // only the shape-agnostic gates apply.
  promptOnly: spec({ description: Description, retries: Retries, extraGates: GenericExtraGates }, (p) => steps.promptOnly(p)),

  qualityCheck: spec({ suite: Suite, description: Description }, (p) => steps.qualityCheck({ ...p, suite: p.suite ?? "all" })),

  // fixExtraGates gates the repair phase, whose envelope is a BuildOutput —
  // same reasoning as build() above.
  fixLoop: spec(
    {
      suite: Suite,
      max: Max,
      owner: Owner,
      description: Description,
      fixDescription: Description,
      fixRetries: Retries,
      fixExtraGates: BuildExtraGates,
    },
    (p) => steps.fixLoop({ ...p, suite: p.suite ?? "test" }),
  ),

  // extraGates gates the REVIEW phase (a ReviewOutput — verdictConsistent
  // applies); reviseExtraGates gates the separate REVISE phase (a
  // BuildOutput — diffMatchesClaims applies instead). Two different
  // envelopes, two different allowlists, on the same step.
  reviseLoop: spec(
    {
      max: Max,
      reviewer: Owner,
      builder: Owner,
      description: Description,
      retries: Retries,
      extraGates: ReviewExtraGates,
      reviseDescription: Description,
      reviseRetries: Retries,
      reviseExtraGates: BuildExtraGates,
    },
    (p) => steps.reviseLoop(p),
  ),

  commit: spec({ onlyIfAccepted: v.optional(v.boolean("onlyIfAccepted must be true or false")), description: Description }, (p) =>
    steps.commit(p),
  ),

  changes: spec({ base: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1, "base must name a git ref"))), description: Description }, (p) =>
    steps.changes(p),
  ),

  document: spec({ owner: Owner, description: Description, retries: Retries, extraGates: GenericExtraGates }, (p) => steps.document(p)),

  refine: spec({ owner: Owner, description: Description, retries: Retries, extraGates: GenericExtraGates }, (p) => steps.refine(p)),

  publishIssues: spec({ description: Description }, (p) => steps.publishIssues(p)),
};

/** Every step name a yaml file may use — for schema validation and for error messages. */
export const STEP_NAMES: readonly string[] = Object.freeze(Object.keys(STEP_SPECS));

// ── the file schema ──────────────────────────────────────────────────────

/**
 * A chain name is typed on the command line (`spf <name> "..."`), so it is
 * held to what a shell word can be: no spaces, no leading dash (which would
 * parse as a flag), nothing that needs quoting.
 */
const CHAIN_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * The whole file. One document, one chain — deliberately not a list: the
 * filename then documents which chain lives where, and a problem can point
 * at a file the operator can open, which is the only handle they have.
 *
 * `steps` is validated loosely here (each entry only has to be an object
 * naming a `step`); the per-step params are validated against that step's
 * own schema afterwards, because which schema applies depends on the value
 * of `step`.
 */
export const RepoChainFileSchema = v.strictObject({
  name: v.pipe(
    v.string("name is required — it is what `spf <name>` types"),
    v.regex(CHAIN_NAME_RE, "name must be lowercase letters/digits/._- and start with a letter or digit (it is typed on the command line)"),
  ),
  describe: v.pipe(v.string("describe is required — it is the line `spf list` prints"), v.minLength(1, "describe must not be empty")),
  steps: v.pipe(
    v.array(v.looseObject({ step: v.string("each step entry needs a `step:` naming a step factory") }), "steps must be a list"),
    v.minLength(1, "steps must name at least one step — a chain with no steps would run nothing and report success"),
  ),
});
export type RepoChainFile = v.InferOutput<typeof RepoChainFileSchema>;

/**
 * Names `cli/index.ts`'s command switch claims before it ever consults the
 * chain registry. A chain called `watch` would be reachable only as
 * `spf run watch` — the bare `spf watch` form every doc and every habit
 * uses would silently run the daemon instead. Rejected rather than allowed
 * to be that confusing.
 *
 * Yes, this duplicates that switch, and yes, it can go stale: a subcommand
 * added there and not added here just means one fewer name is flagged.
 * That's the whole cost, it fails in the harmless direction (a repo chain
 * named after a brand-new subcommand stops being reachable bare, exactly as
 * it would today), and the alternative — exporting the command list from
 * `cli/index.ts` and importing the CLI layer into a chains module — inverts
 * the dependency direction for a usability check.
 */
const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "run",
  "fanout",
  "list",
  "init",
  "install-skill",
  "migrate",
  "eject",
  "doctor",
  "ui",
  "watch",
  "sessions",
  "phases",
  "events",
  "abort",
  "version",
  "help",
]);

// ── loading ──────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Flatten valibot issues into one line an author can act on, each prefixed with where it was. */
function describeIssues(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues
    .map((issue) => {
      const at = v.getDotPath(issue);
      return at ? `${at}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * Build one step from one yaml entry. Returns the Step, or a message.
 *
 * The `spec.build(...)` call is wrapped because a factory validates what a
 * schema cannot: `preflightDescription` rejects a description that is blank
 * once whitespace-collapsed or that merely echoes the phase name (see
 * `core/data_types.ts`'s PhaseParamsSchema — the description is the one
 * sentence the trace, the console and the UI ever show about intent, so
 * `description: "build"` on the `build` step is refused). That check has to
 * happen at chain-DEFINITION time, which is here: an unattended `spf watch`
 * run must not start a session it was always going to abort four phases in.
 */
function buildStep(index: number, entry: Record<string, unknown>): { step: steps.Step } | { message: string } {
  const where = `steps[${index}]`;
  const { step: stepName, ...params } = entry;
  const spec = STEP_SPECS[String(stepName)];
  if (!spec) {
    return { message: `${where}: unknown step ${JSON.stringify(stepName)} — available steps: ${STEP_NAMES.join(", ")}` };
  }

  const unknownParams = Object.keys(params).filter((key) => !spec.params.includes(key));
  if (unknownParams.length > 0) {
    return {
      message:
        `${where} (${stepName}): unknown param(s) ${unknownParams.map((k) => JSON.stringify(k)).join(", ")} — ` +
        (spec.params.length > 0 ? `${stepName} accepts: ${spec.params.join(", ")}` : `${stepName} takes no params`),
    };
  }

  const parsed = v.safeParse(spec.schema, params);
  if (!parsed.success) {
    return { message: `${where} (${stepName}): ${describeIssues(parsed.issues)}` };
  }

  try {
    return { step: spec.build(parsed.output) };
  } catch (error) {
    return { message: `${where} (${stepName}): ${errorMessage(error)}` };
  }
}

/**
 * Read, parse, validate and build one file. Returns the chain, a message, or
 * `skip` for a document that declares no chain at all — an empty file or one
 * that is entirely comments parses to `null`/`undefined` via `parseYaml`,
 * and that is not a malformed chain, it is the absence of one (this is also
 * what a freshly-scaffolded, not-yet-uncommented `spf init` template looks
 * like — it must load silently, not report a problem against itself). A
 * document that parses to something else non-object (a bare string, a
 * number, a list) still gets the "is empty" message below: that shape did
 * declare *something*, just not a chain.
 */
function loadOne(file: string): { chain: ChainDefinition } | { message: string } | { skip: true } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (error) {
    return { message: `could not be read: ${errorMessage(error)}` };
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (error) {
    // yaml's own parse errors already carry line/column — pass them through
    // verbatim rather than summarizing away the only positional information
    // the operator gets.
    return { message: `is not valid YAML: ${errorMessage(error)}` };
  }
  if (doc === null || doc === undefined) {
    return { skip: true };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    return { message: "is empty — a chain file needs `name`, `describe` and `steps`" };
  }

  const parsed = v.safeParse(RepoChainFileSchema, doc);
  if (!parsed.success) {
    return { message: describeIssues(parsed.issues) };
  }
  const file_chain = parsed.output;

  if (RESERVED_COMMAND_NAMES.has(file_chain.name)) {
    return { message: `name ${JSON.stringify(file_chain.name)} is an spf subcommand — \`spf ${file_chain.name}\` would never reach this chain; pick another name` };
  }

  const built: steps.Step[] = [];
  for (const [index, entry] of file_chain.steps.entries()) {
    const result = buildStep(index, entry as Record<string, unknown>);
    if ("message" in result) return { message: result.message };
    built.push(result.step);
  }

  // The same constructor the built-ins use — see stepChain()'s comment.
  return { chain: { ...stepChain(file_chain.name, file_chain.describe, built), source: file } };
}

/**
 * Read every chain in `<anchor.spf_dir>/chains/`.
 *
 * Never throws (see the module header). Returns the chains that loaded and a
 * problem per file that didn't; a file contributes at most one chain and, on
 * failure, exactly one problem — the first thing wrong with it, because the
 * second is usually a consequence of the first.
 */
export function loadRepoChains(anchor: paths.RepoAnchor): { chains: ChainDefinition[]; problems: RepoChainProblem[] } {
  const chains: ChainDefinition[] = [];
  const problems: RepoChainProblem[] = [];

  try {
    if (!anchor.spf_dir) return { chains, problems };
    const dir = path.join(anchor.spf_dir, "chains");
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return { chains, problems };

    let files: string[];
    try {
      // Sorted, so which of two colliding files is reported (and which wins)
      // is deterministic across machines and filesystems — a load order that
      // depends on directory iteration order would make a collision problem
      // reproduce differently for two people looking at the same repo.
      files = readdirSync(dir)
        .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
        .sort();
    } catch (error) {
      problems.push({ file: dir, message: `could not read the chains directory: ${errorMessage(error)}` });
      return { chains, problems };
    }

    /** name -> the file that claimed it, for collision reporting. */
    const claimed = new Map<string, string>();

    for (const entry of files) {
      const file = path.join(dir, entry);
      const loaded = loadOne(file);
      if ("skip" in loaded) continue;
      if ("message" in loaded) {
        problems.push({ file, message: loaded.message });
        continue;
      }
      const name = loaded.chain.name;

      // A built-in is NEVER shadowed — that direction is always a problem,
      // never a silent pick. `core/session.ts`'s `ensure()` writes
      // `chain_name` into the trace as the record of what ran; every session
      // row, every `spf sessions` line, every UI lane is keyed on that
      // string, so a repo chain reusing a built-in's name would make that
      // column stop meaning one thing — retroactively, for every run already
      // recorded under it too. Between two REPO files claiming the same
      // name, the sorted-first one wins deterministically (see the sort
      // above) and the loser is reported as a problem — an ergonomic
      // trade-off, not the same guarantee: renaming the winning file changes
      // which step list `chain_name: <name>` means for every future run,
      // which is exactly the ambiguity the built-in case above refuses to
      // allow. Don't read this as "collisions can't happen here" — they can,
      // deliberately, on this one axis.
      if (BUILTIN_CHAIN_NAMES.has(name)) {
        problems.push({
          file,
          message: `name ${JSON.stringify(name)} is a built-in chain — rename this chain; a repo chain never shadows a built-in`,
        });
        continue;
      }
      const prior = claimed.get(name);
      if (prior) {
        problems.push({
          file,
          message: `name ${JSON.stringify(name)} is already defined by ${path.basename(prior)} — two chains cannot share one name`,
        });
        continue;
      }

      claimed.set(name, file);
      chains.push(loaded.chain);
    }
  } catch (error) {
    // Backstop for anything the per-file guards above did not anticipate.
    // The contract is that this function never throws; a surprise here must
    // degrade to "no repo chains, one problem", not take down whatever
    // command the operator actually ran.
    problems.push({ file: anchor.spf_dir ? path.join(anchor.spf_dir, "chains") : anchor.cwd, message: `could not load repo chains: ${errorMessage(error)}` });
  }

  return { chains, problems };
}
