/**
 * Concrete data types for the SPF ADW system.
 *
 * RULE (four-param rule): any function that takes more than 4 parameters takes
 * ONE of these objects instead. AgentCall and PhaseParams are the pattern.
 *
 * Every agent call declares a concrete output type — an envelope built with
 * envelopeType() — that its final JSON response is parsed against. No untyped
 * handoffs. Validation is Valibot's job here (zod's/Python's pydantic
 * equivalent) — chosen because Flue's own structured-output wiring is built
 * on Valibot, so an envelope type doubles as the tool schema handed to it
 * with no second definition.
 */

import * as v from "valibot";

export type PhaseKind = "engineer" | "agent" | "code";
export type PhaseStatus = "queued" | "running" | "success" | "fail";

// ── Phases ────────────────────────────────────────────────────────────────────

/** Everything run.phase() needs. Passed as one object, never loose params. */
const PhaseParamsShape = v.object({
  name: v.string(), // short id, unique within the run: "plan", "build"
  kind: v.picklist(["engineer", "agent", "code"]),
  owner: v.string(), // engineer's name, "git", or an agent name from config
  description: v.string(), // REQUIRED: what this phase does and why — see below
  retries: v.optional(v.pipe(v.number(), v.integer()), 0), // agent phases: gate-failure retries via continue
});

/**
 * A phase name identifies; a description explains. Both are required.
 *
 * The description is the only sentence the trace, the console, and the
 * phase block in the UI ever show about intent — everything else is ids,
 * statuses, and timings. `commit_plan: "Commit the plan"` tells a reader
 * nothing they could not already see, so an echo is rejected the same way
 * a blank one is. This is a construction-time error on purpose: it fires
 * before the phase opens, not after a run is already in the trace.
 */
export const PhaseParamsSchema = v.pipe(
  PhaseParamsShape,
  v.rawTransform(({ dataset, addIssue, NEVER }) => {
    const value = dataset.value;
    const text = value.description.split(/\s+/).filter(Boolean).join(" ");
    const name = value.name || "?";
    if (!text) {
      addIssue({
        message:
          `phase ${JSON.stringify(name)}: description is required — one sentence on what this ` +
          `phase does and why. It is what the trace and the UI show.`,
      });
      return NEVER;
    }
    if (text.replace(/\.+$/, "").toLowerCase() === name.replace(/_/g, " ").toLowerCase()) {
      addIssue({
        message:
          `phase ${JSON.stringify(name)}: description ${JSON.stringify(text)} only restates the phase name — ` +
          `say what it does and why instead.`,
      });
      return NEVER;
    }
    return { ...value, description: text };
  }),
);
export type PhaseParams = v.InferOutput<typeof PhaseParamsSchema>;

export function makePhaseParams(input: v.InferInput<typeof PhaseParamsShape>): PhaseParams {
  return v.parse(PhaseParamsSchema, input);
}

/** The persisted phase record — PhaseParams plus lifecycle. */
export interface Phase {
  phase_id: string;
  adw_id: string;
  seq: number;
  params: PhaseParams;
  status: PhaseStatus; // success must be earned
  attempt: number;
  error?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
}

// ── Envelopes (agent output types) ───────────────────────────────────────────

const EnvelopeBaseEntries = {
  status: v.picklist(["success", "fail"]),
  summary: v.optional(v.string(), ""),
  artifacts: v.optional(v.array(v.string()), () => []),
  notes_for_next_agent: v.optional(v.string(), ""),
};
export const EnvelopeBaseSchema = v.object(EnvelopeBaseEntries);
export type EnvelopeBase = v.InferOutput<typeof EnvelopeBaseSchema>;

export interface EnvelopeType<T> {
  name: string;
  // Every envelope schema is built with v.object(...), so its real input
  // type is object-shaped — this is also exactly the ToolInputSchema shape
  // Flue's useTool()/sf_report wiring requires (agent_flue.ts).
  schema: v.GenericSchema<Record<string, unknown>, T>;
  fields: string[];
}

function envelopeType<Entries extends v.ObjectEntries>(name: string, entries: Entries) {
  const schema = v.object({ ...EnvelopeBaseEntries, ...entries });
  return { name, schema, fields: Object.keys(schema.entries) } as EnvelopeType<v.InferOutput<typeof schema>>;
}

export const GenericOutput = envelopeType("GenericOutput", {});
export type GenericOutputT = v.InferOutput<typeof GenericOutput.schema>;

export const PlanOutput = envelopeType("PlanOutput", {
  // Subject for committing the PLAN — the spec file the planner wrote, not the
  // implementation it describes. Each agent's commit_message covers its own
  // work product, so a chain that commits per step never reuses one agent's
  // words for another agent's diff.
  commit_message: v.optional(v.string(), ""),
});
export type PlanOutputT = v.InferOutput<typeof PlanOutput.schema>;

export const BuildOutput = envelopeType("BuildOutput", {
  changed_files: v.optional(v.array(v.string()), () => []),
  commit_message: v.optional(v.string(), ""), // consumed by the git commit phase
});
export type BuildOutputT = v.InferOutput<typeof BuildOutput.schema>;

export const ScoutFindingSchema = v.object({
  file: v.string(),
  note: v.optional(v.string(), ""),
});
export type ScoutFinding = v.InferOutput<typeof ScoutFindingSchema>;

export const ScoutOutput = envelopeType("ScoutOutput", {
  findings: v.optional(v.array(ScoutFindingSchema), () => []),
});
export type ScoutOutputT = v.InferOutput<typeof ScoutOutput.schema>;

/** One thing the request (or plan) asked for, and whether it is there. */
export const ReviewFindingSchema = v.object({
  requirement: v.string(), // the ask, in the requester's words
  met: v.boolean(),
  evidence: v.optional(v.string(), ""), // where it lives, or what is missing
});
export type ReviewFinding = v.InferOutput<typeof ReviewFindingSchema>;

/** Confirmation that what was built is what was asked for — not a test run. */
export const ReviewOutput = envelopeType("ReviewOutput", {
  approved: v.optional(v.boolean(), false),
  findings: v.optional(v.array(ReviewFindingSchema), () => []),
  blocking: v.optional(v.array(v.string()), () => []), // what must change before approval
});
export type ReviewOutputT = v.InferOutput<typeof ReviewOutput.schema>;

/** Where the write-up of a completed change landed. */
export const DocumentOutput = envelopeType("DocumentOutput", {
  document_path: v.optional(v.string(), ""), // the doc in the repo, e.g. app_docs/<adw_id>_<slug>.md
  documented_files: v.optional(v.array(v.string()), () => []),
  commit_message: v.optional(v.string(), ""),
});
export type DocumentOutputT = v.InferOutput<typeof DocumentOutput.schema>;

/**
 * One node in a decomposed product spec — a feature/epic container, or a
 * story/bug/task leaf. Flat with a `parent` key, not nested JSON: a model
 * emits a flat list far more reliably than a recursive tree, and a flat
 * shape is what lets `blocked_by` reference ANY other node, container or
 * leaf, not just siblings under the same parent.
 *
 * `key` is the refiner's own local id for this run (e.g. "F1", "S1.1") —
 * scoped to one `RefineOutput`, never a tracker id; `core/refine.ts`
 * resolves `key`s to real issue numbers as it creates them, in dependency
 * order. See `gates.refinementWellFormed` for the shape rules enforced on
 * this list before publish ever runs (unique keys, resolvable references,
 * no cycles, container/leaf kind agreement, at least one leaf).
 */
/**
 * `p0` (drop everything) .. `p3` (someday) — see `assets/prompts/refiner/system.md`'s
 * `## Priority` section for what each rung means. Two rules the schema alone
 * can't enforce, checked instead by `gates.refinementWellFormed`
 * (monotonicity: no node outranks its `parent`) and `core/refine.ts`'s
 * `publish()` (the spec's own priority, when known, is a ceiling clamped onto
 * every node): see both files' doc comments.
 */
export const RefinedPrioritySchema = v.picklist(["p0", "p1", "p2", "p3"]);
export type RefinedPriority = v.InferOutput<typeof RefinedPrioritySchema>;

/** Lower rank = more urgent. The one place both `gates.refinementWellFormed` (monotonicity) and `core/refine.ts`'s `publish()` (the spec-priority ceiling) get their ordering from — see `RefinedPrioritySchema`'s doc comment. */
export const PRIORITY_RANK: Record<RefinedPriority, number> = { p0: 0, p1: 1, p2: 2, p3: 3 };

/** `priority`, pulled down to `ceiling` if it outranks it — never raised. `ceiling` nullish (a bare `spf refine` with nothing to inherit from) is a no-op. */
export function clampPriority(priority: RefinedPriority, ceiling: RefinedPriority | null | undefined): RefinedPriority {
  if (!ceiling) return priority;
  return PRIORITY_RANK[priority] < PRIORITY_RANK[ceiling] ? ceiling : priority;
}

export const RefinedIssueSchema = v.object({
  key: v.string(),
  kind: v.picklist(["epic", "feature", "story", "bug", "task"]),
  title: v.string(),
  body: v.string(), // "## What to build" / "## Acceptance criteria" — see assets/prompts/refiner/user.md
  parent: v.optional(v.string(), ""), // another node's `key`; "" = top level
  blocked_by: v.optional(v.array(v.string()), () => []), // other nodes' `key`s that must land first
  priority: v.optional(RefinedPrioritySchema, "p2"), // what spf watch's build lane schedules by — see RefinedPrioritySchema
});
export type RefinedIssue = v.InferOutput<typeof RefinedIssueSchema>;

/**
 * One open question the refiner could not answer itself — material ambiguity
 * (scope, data model, an external dependency choice, a UX contract, anything
 * that would contradict an ADR) it is refusing to guess on, per
 * `assets/prompts/refiner/system.md`'s "ask, don't decide" rule. `id` is
 * stable within one round so a resumed run's answers can be matched back to
 * the question they answer; `why_it_matters`/`options`/`recommendation`/
 * `evidence` exist so a human can answer in one word ("go with your rec")
 * instead of re-deriving the tradeoff the refiner already worked out.
 * `gates.refinementWellFormed` requires `issues` to be empty whenever this is
 * non-empty — escalating means publishing nothing THIS round, never a
 * partial tree pinned to an unanswered question.
 */
export const RefineQuestionSchema = v.object({
  id: v.string(),
  question: v.string(),
  why_it_matters: v.optional(v.string(), ""),
  options: v.optional(v.array(v.string()), () => []),
  recommendation: v.optional(v.string(), ""),
  evidence: v.optional(v.array(v.string()), () => []),
});
export type RefineQuestion = v.InferOutput<typeof RefineQuestionSchema>;

/** A product spec decomposed into a feature/story tree — see `steps.refine()` and `core/refine.ts`. */
export const RefineOutput = envelopeType("RefineOutput", {
  issues: v.optional(v.array(RefinedIssueSchema), () => []),
  questions: v.optional(v.array(RefineQuestionSchema), () => []),
});
export type RefineOutputT = v.InferOutput<typeof RefineOutput.schema>;

// ── Deterministic quality blocks ─────────────────────────────────────────────

export const QualityAreaSchema = v.picklist(["frontend", "backend"]);
export type QualityArea = v.InferOutput<typeof QualityAreaSchema>;

export const QualityOperationSchema = v.picklist(["lint", "typecheck", "build"]);
export type QualityOperation = v.InferOutput<typeof QualityOperationSchema>;

/** One deterministic quality command, as configured in spf.config.yaml's `quality.checks`. */
export const QualityCheckSpecSchema = v.object({
  name: v.string(),
  area: v.optional(QualityAreaSchema, "backend"),
  operation: QualityOperationSchema,
  argv: v.pipe(v.array(v.string()), v.minLength(1, "argv must name at least the binary to run")),
  timeout_seconds: v.optional(v.number(), 120),
});
export type QualityCheckSpec = v.InferOutput<typeof QualityCheckSpecSchema>;

/**
 * `quality.checks` names the deterministic commands; `quality.suites` groups
 * them into what a chain actually runs (`test`, `all`, ...). An unconfigured
 * suite is a hard error at validate() time — see agents.validate() — not a
 * silent placeholder that reports green. There is deliberately no packaged
 * default suite: "no quality commands configured yet" must fail loudly on
 * the first quality-gated chain, not quietly pass one.
 */
export const QualityConfigSchema = v.object({
  checks: v.optional(v.array(QualityCheckSpecSchema), () => []),
  suites: v.optional(v.record(v.string(), v.array(v.string())), () => ({})),
});
export type QualityConfig = v.InferOutput<typeof QualityConfigSchema>;

/** Captured evidence from one quality command. */
export interface QualityCheckResult {
  name: string;
  area: QualityArea;
  operation: QualityOperation;
  command: string;
  returncode: number;
  passed: boolean;
  duration_seconds: number;
  output_artifact: string;
  // The tail of stdout+stderr, verbatim and unparsed. A failure has to travel
  // back to the builder as an envelope, and the builder cannot open a log file
  // it was never handed — so the evidence rides along. Deliberately raw: every
  // runner formats failures differently and a generic parser would be
  // confidently wrong. The full log is always at output_artifact.
  output_tail: string;
}

/** Aggregate result from a quality block: every check it ran, and the verdict. */
export interface QualityResult {
  passed: boolean;
  checks: QualityCheckResult[];
  failures: string[];
  artifacts: string[];
}

// ── Change capture (git diff, deterministic) ─────────────────────────────────

/** Everything changes.capture() needs. One object, never loose params. */
export interface ChangeCapture {
  base: string; // the ref the work is measured against
  max_diff_lines: number; // the diff artifact is truncated past this
  include_untracked: boolean; // a brand-new file is part of the change
}

export function makeChangeCapture(input: Partial<ChangeCapture> & { base?: string }): ChangeCapture {
  return {
    base: input.base ?? "main",
    max_diff_lines: input.max_diff_lines ?? 2000,
    include_untracked: input.include_untracked ?? true,
  };
}

/**
 * The commit a change is measured from, and why that one.
 *
 * `reason` is the line the trace shows. A diff is only as trustworthy as the
 * thing it was taken against, so the ADW records that choice instead of
 * leaving the reader to infer it.
 */
export class BaseRef {
  constructor(public ref: string, public commit: string, public reason: string = "") {}

  /** Display form — a named ref as itself, a pinned raw sha shortened. */
  get label(): string {
    if (this.ref.length === 40 && /^[0-9a-f]+$/.test(this.ref)) {
      return this.ref.slice(0, 7);
    }
    return this.ref;
  }
}

/** What changed since the base commit — pure git facts, no judgement. */
export class ChangeSet {
  constructor(
    public base: BaseRef,
    public files: string[] = [],
    public untracked: string[] = [],
    public insertions: number = 0,
    public deletions: number = 0,
    public stat: string = "",
    public diff_path: string = "", // the full diff, written into context_handoff/
    public truncated: boolean = false,
  ) {}

  get empty(): boolean {
    return this.files.length === 0 && this.untracked.length === 0;
  }
}

/**
 * A ChangeSet shaped as an envelope so an agent can be handed it directly.
 *
 * Same adapter idea as VerifyOutput: code computes the diff, the documenter
 * consumes it through the one door every agent handoff uses.
 */
export const ChangesOutput = envelopeType("ChangesOutput", {
  base: v.optional(v.string(), ""), // "<ref> @ <commit> — <reason>"
  changed_files: v.optional(v.array(v.string()), () => []),
  insertions: v.optional(v.number(), 0),
  deletions: v.optional(v.number(), 0),
  stat: v.optional(v.string(), ""),
  diff_path: v.optional(v.string(), ""), // read this for the full diff
});
export type ChangesOutputT = v.InferOutput<typeof ChangesOutput.schema>;

/**
 * A deterministic result, shaped as an envelope so an agent can consume it.
 *
 * Agents hand each other typed envelopes; code blocks return QualityResult.
 * This is the adapter, so a failing lint or test run flows back into the
 * builder through exactly the same door a tester agent's report used to —
 * the ADW script is the only thing that knows the difference.
 */
export const VerifyOutput = envelopeType("VerifyOutput", {
  passed: v.optional(v.boolean(), false),
  failures: v.optional(v.array(v.string()), () => []),
});
export type VerifyOutputT = v.InferOutput<typeof VerifyOutput.schema>;

// ── Agent calls ──────────────────────────────────────────────────────────────

/**
 * One thing a gate looked at, and what it found.
 *
 * `note` is the evidence — "exists, 2.1KB", "exit 0", "not in the diff". On a
 * failed check it doubles as the reason, so it is what the agent is told.
 */
export interface GateCheck {
  item: string; // what was checked: a path, a command, a test
  ok: boolean;
  note: string;
}

/**
 * What every gate returns: the checks it ran. Violations are derived.
 *
 * Authoring stays a one-liner per item — `report.check(...)` appends and
 * returns self, so a gate is a loop and a return.
 */
export class GateReport {
  checks: GateCheck[] = [];

  check(item: string, ok: boolean, note: string = ""): GateReport {
    this.checks.push({ item, ok, note });
    return this;
  }

  get violations(): string[] {
    return this.checks.filter((c) => !c.ok).map((c) => `${c.item}: ${c.note || "failed"}`);
  }

  get passed(): boolean {
    return this.violations.length === 0;
  }
}

/** The minimal shape a gate needs from a run — avoids a circular import with runner.ts. */
export interface RunContext {
  repo_root: string;
}

export type GateFn = (envelope: EnvelopeBase, run: RunContext) => GateReport | string[];

/** One agent invocation: prompt in, typed envelope out, gates verified. */
export interface AgentCall<T extends EnvelopeBase = EnvelopeBase> {
  output_type: EnvelopeType<T>;
  prompt: string;
  previous?: EnvelopeBase | null;
  gates?: GateFn[];
}

export function makeAgentCall<T extends EnvelopeBase>(input: {
  output_type: EnvelopeType<T>;
  prompt: string;
  previous?: EnvelopeBase | null;
  gates?: GateFn[];
}): AgentCall<T> {
  return { previous: null, gates: [], ...input };
}

// ── Config ───────────────────────────────────────────────────────────────────

export const PromptEngineeringSchema = v.object({
  system: v.string(), // path to system.md
  user: v.string(), // path to user.md
});
export type PromptEngineering = v.InferOutput<typeof PromptEngineeringSchema>;

export const ThinkingLevelSchema = v.picklist(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = v.InferOutput<typeof ThinkingLevelSchema>;

export const AgentConfigSchema = v.object({
  name: v.string(),
  coding_agent: v.optional(v.picklist(["flue", "claude_code"]), "flue"),
  model: v.optional(v.string(), "google/gemini-3.6-flash"),
  thinking: v.optional(ThinkingLevelSchema, "medium"),
  color: v.optional(v.string(), ""), // hex swatch for this agent's lane in the UI
  purpose: v.optional(v.string(), ""),
  prompt_engineering: PromptEngineeringSchema,
  harness_engineering: v.optional(v.array(v.string()), () => []),
  tools: v.optional(v.nullable(v.array(v.string()))), // allowlist; undefined/null = all tools usable
  // What this agent may MODIFY in the repo, enforced in code after every call
  // (see core/permissions.ts). `tools` cannot express this: `bash` runs
  // anything and `write` reaches any path, so an agent's capability list is a
  // statement of intent that nothing checks.
  //   undefined -> unrestricted, except the roster-wide `protected_files` paths
  //   []        -> read-only: may modify nothing tracked
  //   [...]     -> only these. A trailing "/" means a directory prefix; a "*"
  //                makes it a glob; anything else is an exact path.
  writes: v.optional(v.nullable(v.array(v.string()))),
  // Opt-in env allowlist for this agent's subprocess/sandbox environment.
  // undefined/null (the default) -> unrestricted: the full operator
  // environment is passed through, byte-identical to before this field
  // existed — same three-state shape as `writes` above, so `null` (the
  // spelling config.md teaches for "unrestricted") parses instead of
  // rejecting. Set -> only these keys, plus the baseline
  // (PATH/HOME/USER/LANG/TERM/TMPDIR) that agent_flue.ts's local() sandbox
  // would keep anyway.
  env_allowlist: v.optional(v.nullable(v.array(v.string()))),
});
export type AgentConfig = v.InferOutput<typeof AgentConfigSchema>;

export const ConfigDefaultsSchema = v.object({
  coding_agent: v.optional(v.picklist(["flue", "claude_code"]), "flue"),
  model: v.optional(v.string(), "google/gemini-3.6-flash"),
  thinking: v.optional(ThinkingLevelSchema, "medium"),
  color: v.optional(v.string(), ""),
  harness_engineering: v.optional(v.array(v.string()), () => []),
  tools: v.optional(v.nullable(v.array(v.string()))), // roster-wide allowlist; unset = all tools usable
  // Off-limits to every agent that has not named them in its own `writes`.
  // The factory's own code is the default: an agent must not be able to edit
  // the machinery that decides whether its work passed.
  // .spf/ is the whole per-repo footprint now — no adws/ tree to protect.
  protected_files: v.optional(v.array(v.string()), () => [".spf/", "spf.config.yaml"]),
  data_dir: v.optional(v.string(), ".spf/data"),
  /**
   * RUN BUDGET CEILINGS — the two knobs that bound what one adw_id may spend.
   *
   * BOTH ABSENT BY DEFAULT, and absence is a total no-op: `agents.ts`'s
   * `assertRunBudget()` returns immediately when neither is set, so every
   * existing config behaves byte-identically to before this field existed.
   * There is no ambient environment variable and no implicit default — an
   * unbounded run stays the default because a surprise mid-run failure on a
   * ceiling nobody chose is worse than the spend.
   *
   * SCOPE IS THE RUN, NOT THE CALL. Enforced against the Run's ACCUMULATED
   * usage (`run.tokens`/`run.cost` — the same totals `run.addUsage()` mirrors
   * into the sessions row), checked BEFORE every agent dispatch including
   * every JSON-repair retry and every gate correction, because the cost of
   * the call about to happen is unknowable in advance. That makes these a
   * hard cap on FURTHER spend rather than a post-hoc report: reaching the
   * ceiling stops the next call, it does not merely note that the last one
   * was expensive. A tripped ceiling fails the phase closed — see
   * `agents.ts`'s `BudgetExceeded`.
   *
   * `max_run_cost` is USD (the same unit the provider's own usage.cost
   * arrives in, summed by `UsageBreakdown`); `max_run_tokens` is TOTAL
   * tokens, i.e. the spend number — every turn re-sends the whole
   * conversation, so this counts cached re-reads too, exactly like the
   * `total_tokens` column in `sessions` (see `ui/server/db.ts`'s `usage()`
   * for why that number is much larger than "material moved").
   *
   * Both are `> 0`, not `>= 0`: a zero ceiling would mean "no agent may ever
   * run", which is a config mistake, not a budget — it would fail the first
   * phase of every chain with a budget message instead of saying what is
   * actually wrong.
   *
   * THE BACK-FILL TRAP (see `agents.ts`'s `loadConfig`): that function copies
   * a handful of `defaults` keys DOWN onto each agent that hasn't set them
   * (coding_agent/model/thinking/color/tools/writes/env_allowlist). These two
   * keys are deliberately NOT in that list and must never be added to it —
   * they are RUN-scoped ceilings, not per-agent settings, and a per-agent
   * copy would read as "each agent may spend this much", which is a
   * different (and unenforced) feature. `mergeRawConfig`'s `defaults` spread
   * is what carries them through config layering, key-by-key; pinned by
   * `src/test/budget.test.ts`.
   */
  max_run_cost: v.optional(v.pipe(v.number(), v.gtValue(0))),
  max_run_tokens: v.optional(v.pipe(v.number(), v.integer(), v.gtValue(0))),
});
export type ConfigDefaults = v.InferOutput<typeof ConfigDefaultsSchema>;

/**
 * OpenTelemetry span export — OFF unless this block exists, and `endpoint` is
 * required BY THIS SCHEMA rather than defaulted, because presence of the block
 * IS the activation switch. No ambient environment variable can turn export on
 * (notably NOT `OTEL_EXPORTER_OTLP_ENDPOINT`): an unrelated shell variable must
 * never become a data-egress switch. See `core/otel.ts`'s header for the full
 * set of constraints, including the attribute allowlist that keeps repo source
 * code (tool args, prompts, envelopes, the request text) off the wire.
 *
 * `endpoint` is URL-validated so a typo fails at config load rather than as a
 * silent per-run export failure. Either the full OTLP traces path
 * (`https://collector:4318/v1/traces`) or a bare origin (`/v1/traces` is
 * appended — see `resolveTracesUrl`). `headers` is where a collector's auth
 * token goes; its VALUES are treated as secrets and never logged.
 */
export const OTelConfigSchema = v.object({
  endpoint: v.pipe(v.string(), v.url()),
  headers: v.optional(v.record(v.string(), v.string()), undefined),
  service_name: v.optional(v.string(), "spf"),
});
export type OTelConfig = v.InferOutput<typeof OTelConfigSchema>;

export const ObservabilityConfigSchema = v.object({
  db: v.optional(v.string(), ".spf/data/spf.db"),
  poll_ms: v.optional(v.number(), 500),
  // Absent by default. `agents.ts`'s mergeRawConfig spreads `observability`
  // field-by-field, so this nested object merges as a WHOLE-OBJECT replace on
  // override — an override that sets `otel:` replaces the base's entirely,
  // which is the semantics you want for an endpoint + its headers (a
  // half-merged pair of the two would send tokens to the wrong collector).
  // Pinned by a merge-survival test in src/test/data_types.test.ts.
  otel: v.optional(OTelConfigSchema),
});
export type ObservabilityConfig = v.InferOutput<typeof ObservabilityConfigSchema>;

/**
 * `spf watch`'s configuration. `issue_provider` (the tracker) and
 * `code_host` (where PRs open) are independent enums, not one combined
 * `provider` — a tracker and a code host are independent choices in
 * practice (Jira issues against a Bitbucket repo, e.g.), and `watch.ts`'s
 * poll loop is written against `IssueProvider`/`CodeHostProvider`
 * separately (see `core/issues/provider.ts`) precisely so any combination
 * is just config, never a rewrite of the loop. Adding a tracker or host
 * later is a new module (`core/issues/*_provider.ts`) plus one more enum
 * entry here.
 *
 * `repo` has no sensible default and is validated as required at `spf
 * watch` startup, not here — an empty string parses fine (this schema has
 * no opinion on whether watch is even configured), matching the same
 * "fails loudly before anything spawns, not eagerly at parse time" pattern
 * `quality:` already uses. `repo` always names `code_host`'s own repo —
 * its shape depends on `code_host`: "owner/name" for github,
 * "workspace/repo_slug" for bitbucket. `resolveCodeHostProvider`
 * (`cli/commands/watch.ts`) always reads it.
 *
 * `issue_repo` exists for exactly one combination where that single field
 * stops being enough: `issue_provider: github` with `code_host: bitbucket`
 * — GitHub-issues-against-a-Bitbucket-repo, a real setup this project
 * explicitly supports, where the issue tracker and the code host are
 * genuinely different repos in different systems, not the same repo worn
 * two ways. Every other combination stays a single field: `issue_provider:
 * github` + `code_host: github` is one repo by construction; `issue_provider:
 * jira` never reads `repo` at all (it uses `jira.base_url`/`project_key`),
 * so `repo` unambiguously belongs to whichever code host is configured.
 * `resolveIssueProvider`'s github branch and `core/refine.ts`'s
 * `resolveAuthoringProvider` (issue authoring always targets the issue
 * tracker, never the code host) both read `issue_repo || repo` — leaving
 * `issue_repo` unset is a complete no-op, so no existing config needs to
 * change.
 */
export const WatchIssueProviderSchema = v.picklist(["github", "jira"]);
export type WatchIssueProviderKind = v.InferOutput<typeof WatchIssueProviderSchema>;

export const WatchCodeHostSchema = v.picklist(["github", "bitbucket"]);
export type WatchCodeHostKind = v.InferOutput<typeof WatchCodeHostSchema>;

/**
 * What each `RefinedIssue.kind` creates as, on Jira — Jira's create endpoint
 * requires a real `issuetype`, and project setups vary (renamed types,
 * non-English instances, custom schemes), so this is a name -> name map,
 * not a hardcoded assumption. Every field defaults independently: a config
 * that only sets `bug: Defect` still gets Epic/Epic/Story/Task for the
 * other four. `jira_provider.ts`'s `createIssue`/`validateIssueTypes` are
 * the readers; `spf watch init` and `spf watch`'s own startup check
 * (`cli/commands/watch.ts`) both validate this against the real project
 * before anything unattended runs on it.
 */
export const JiraIssueTypeMapSchema = v.object({
  epic: v.optional(v.string(), "Epic"),
  feature: v.optional(v.string(), "Epic"),
  story: v.optional(v.string(), "Story"),
  bug: v.optional(v.string(), "Bug"),
  task: v.optional(v.string(), "Task"),
});
export type JiraIssueTypeMap = v.InferOutput<typeof JiraIssueTypeMapSchema>;

/**
 * Only consulted when `issue_provider: jira`. Auth is `JIRA_EMAIL` +
 * `JIRA_API_TOKEN` env vars, checked at startup like `GITHUB_TOKEN`. Whole-
 * object replace on config-file-layer merge, like `refine`/
 * `observability.otel` (see `agents.ts`'s `mergeRawConfig`) — an override
 * file that touches `watch.jira` at all must repeat `issue_types` too if it
 * wants to keep a customized mapping, same caveat that already applies to
 * `base_url`/`project_key` today.
 */
export const WatchJiraConfigSchema = v.object({
  base_url: v.optional(v.string(), ""), // e.g. "https://your-domain.atlassian.net"
  project_key: v.optional(v.string(), ""), // e.g. "PROJ"
  issue_types: v.optional(JiraIssueTypeMapSchema, () => v.parse(JiraIssueTypeMapSchema, {})),
});
export type WatchJiraConfig = v.InferOutput<typeof WatchJiraConfigSchema>;

/**
 * The second `spf watch` lane: decompose a `<prefix>:spec-ready` product
 * spec into a feature/story tree of real issues, instead of running
 * `watch.chain` against it directly (a spec is not individually workable —
 * see `core/refine.ts`). Off by default so an existing `watch:` config's
 * behavior is unchanged by upgrading. Needs `issue_provider: github` or
 * `"jira"` — both implement `IssueAuthoringProvider` (create/link/list) —
 * any other value fails loudly at `spf watch` startup rather than running a
 * refine lane that can never publish anything.
 */
export const WatchRefineConfigSchema = v.object({
  enabled: v.optional(v.boolean(), false),
  chain: v.optional(v.string(), "refine"),
  concurrency: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 1),
});
export type WatchRefineConfig = v.InferOutput<typeof WatchRefineConfigSchema>;

export const WatchConfigSchema = v.object({
  issue_provider: v.optional(WatchIssueProviderSchema, "github"),
  code_host: v.optional(WatchCodeHostSchema, "github"),
  repo: v.optional(v.string(), ""),
  issue_repo: v.optional(v.string(), ""),
  label_prefix: v.optional(v.string(), "spf"),
  chain: v.optional(v.string(), "plan-build-test"),
  base_branch: v.optional(v.string(), "main"),
  poll_ms: v.optional(v.number(), 60_000),
  concurrency: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 2),
  /**
   * Threaded straight through as `runChainDef`'s `options` argument for
   * every unattended `spf watch` dispatch (build lane AND refine lane) —
   * the exact same `Record<string, string>` shape an interactive `spf
   * <chain> --suite <name>` builds in `cli/commands/run.ts`'s
   * `dispatchChain` (e.g. `{suite: "strict"}`, `{agent: "..."}`). Fixes the
   * KNOWN LIMITATION called out in PR #20: `cli/commands/watch.ts`'s
   * `runChain`/`runRefine` wrappers used to call `runChainDef` with no
   * options at all, so nothing --suite-shaped could ever reach a chain run
   * `spf watch` dispatched — see `cli/commands/watch.ts`. Empty by default,
   * so an existing `watch:` config's behavior is unchanged by upgrading.
   * Whole-object replace on merge, like `jira`/`refine` above and
   * `observability.otel` — see `agents.ts`'s `mergeRawConfig` and
   * `data_types.test.ts`'s merge-survival test for this field.
   */
  chain_options: v.optional(v.record(v.string(), v.string()), () => ({})),
  jira: v.optional(WatchJiraConfigSchema, () => v.parse(WatchJiraConfigSchema, {})),
  refine: v.optional(WatchRefineConfigSchema, () => v.parse(WatchRefineConfigSchema, {})),
});
export type WatchConfig = v.InferOutput<typeof WatchConfigSchema>;

/**
 * Optional outbound push for unattended work (`spf watch`, any chain run) —
 * everything else (`spf doctor`, `list`, `sessions`, ...) is interactive, so
 * it stays console-only on purpose; see `core/notify/notifier.ts`.
 *
 * `events` is the whole filter: "off" sends nothing, "errors" sends only
 * NotifyEvents whose `level` is "error", "all" sends every curated
 * milestone. A channel's own `events` overrides the top-level scope for
 * just that channel (e.g. Slack gets everything, Teams gets errors only).
 *
 * `webhook_url_env` names the .env key holding the secret URL — never the
 * URL itself, matching GITHUB_TOKEN/JIRA_API_TOKEN. Empty = the kind's own
 * default key (see core/notify/notifier.ts's DEFAULT_ENV_KEY).
 */
export const NotifyScopeSchema = v.picklist(["off", "errors", "all"]);
export type NotifyScope = v.InferOutput<typeof NotifyScopeSchema>;

export const NotifyChannelKindSchema = v.picklist(["slack", "teams", "webhook"]);
export type NotifyChannelKind = v.InferOutput<typeof NotifyChannelKindSchema>;

export const NotifyChannelSchema = v.object({
  kind: NotifyChannelKindSchema,
  webhook_url_env: v.optional(v.string(), ""),
  events: v.optional(v.nullable(NotifyScopeSchema)),
  // Shown in warning lines / message footers to tell two channels of the
  // same kind apart (e.g. two webhook: entries) — cosmetic only.
  name: v.optional(v.string(), ""),
});
export type NotifyChannel = v.InferOutput<typeof NotifyChannelSchema>;

export const NotificationsConfigSchema = v.object({
  events: v.optional(NotifyScopeSchema, "off"),
  timeout_ms: v.optional(v.number(), 5_000),
  channels: v.optional(v.array(NotifyChannelSchema), () => []),
});
export type NotificationsConfig = v.InferOutput<typeof NotificationsConfigSchema>;

/**
 * `simple_sdlc`'s human-signoff gate — see the ACCEPTED ADVERSARIAL
 * AMENDMENTS on the review-accountability thread. `simple_sdlc.ts`'s
 * `commit_build` predicate is the ONLY place in this codebase where an AI
 * reviewer's `approved` flag gates a commit; `decideSignoff` (same file)
 * turns that PROPOSAL into a human's DISPOSAL wherever a human is at the
 * keyboard, and reads these two knobs when there isn't one.
 *
 * `require_human_signoff` defaults to FALSE for this release, deliberately:
 * flipping it to fail-closed-by-default would break every unattended
 * `simple-sdlc` run (`spf watch`, CI) the day this shipped, before `spf
 * watch` itself is signoff-aware (its own human gate today is the PR merge,
 * now informed by the reviewer digest — see `cli/commands/watch.ts`). An
 * unattended run instead proceeds on the AI verdict alone with a LOUD
 * one-time warning (`decideSignoff`'s `AI_ONLY_SIGNOFF_WARNING`) until that
 * changes. Set `true` and an unattended run fails the phase CLOSED instead —
 * see `decideSignoff`'s fail-closed branch — rather than silently
 * auto-approving because nobody typed at a prompt that was never shown.
 *
 * `signoff_timeout_seconds` bounds the interactive prompt itself: expiry
 * means NOT accepted (the confirm's own default), never an unbounded stdin
 * read inside `run.phase()` — see `cli/ask.ts`'s `confirm(..., {timeoutMs})`.
 */
export const ReviewConfigSchema = v.object({
  require_human_signoff: v.optional(v.boolean(), false),
  signoff_timeout_seconds: v.optional(v.pipe(v.number(), v.minValue(1)), 300),
});
export type ReviewConfig = v.InferOutput<typeof ReviewConfigSchema>;

/**
 * Risk-tiered per-role model routing — SPF #14. One rung of a ladder:
 * `name` is what `tiering.roles` points at, `model` speaks EXACTLY the same
 * vocabulary as an agent's own `model:` for that backend (provider/model-id
 * for flue, Claude Code's bare alias/full-name for claude_code) — there is
 * deliberately no per-provider table, since for flue the provider is
 * already the first segment of the value.
 *
 * `coding_agent` declares WHICH BACKEND'S VOCABULARY this rung's `model`
 * speaks — same picklist and same default as `AgentConfigSchema`'s own
 * field (`:409`), reused rather than restated. A tier changes an agent's
 * `model` and NOTHING else (`coding_agent` stays the agent's own, always),
 * so a rung can only route roles whose `coding_agent` matches its own — see
 * `core/tiering.ts`'s rule T, enforced by `agents.ts`'s `validate()`.
 */
export const TierSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  coding_agent: v.optional(v.picklist(["flue", "claude_code"]), "flue"),
  model: v.pipe(v.string(), v.minLength(1)),
});
export type Tier = v.InferOutput<typeof TierSchema>;

/**
 * OFF by default, and `enabled: false`/absent is a TOTAL no-op: every agent
 * dispatches at exactly the model its roster entry names, byte-identical to
 * before this key existed — same discipline `max_run_cost`/`max_run_tokens`
 * hold themselves to (`ConfigDefaultsSchema`'s own comment above).
 *
 * TOP-LEVEL (`SFConfigSchema` below), deliberately NOT nested under
 * `defaults:` — `agents.ts`'s `loadConfig` back-fill loop copies a FIXED
 * list of `defaults` keys DOWN onto every agent that hasn't set them, and
 * `AgentConfigSchema` is a non-strict `v.object`, so a stray copy would be
 * silently STRIPPED at parse rather than rejected (see
 * `ConfigDefaultsSchema`'s "THE BACK-FILL TRAP" comment — `max_run_cost`/
 * `max_run_tokens` needed an explicit never-add-this-to-the-list comment to
 * survive exactly that trap). A top-level key sits outside that loop
 * entirely, so the trap cannot apply here at all.
 *
 * `tiers` is the ladder, WEAKEST FIRST: a risk level shifts every routed
 * role UP or DOWN this list by the same step, so order is the whole
 * semantics — a SEQUENCE states that unambiguously where a mapping's key
 * order would be parser-dependent.
 *
 * `roles` is the baseline tier per ROLE (an agent name). Naming an agent
 * here IS the operator's statement "route this one by tier" — so the
 * resolved tier wins over that agent's own `model:`. An agent NOT named
 * here is never retiered: its `model:` stands, untouched. See
 * `core/tiering.ts`'s `resolveTiering` for the full precedence rule.
 */
export const TieringConfigSchema = v.object({
  enabled: v.optional(v.boolean(), false),
  tiers: v.optional(v.array(TierSchema), () => []),
  roles: v.optional(v.record(v.string(), v.string()), () => ({})),
});
export type TieringConfig = v.InferOutput<typeof TieringConfigSchema>;

export const SFConfigSchema = v.object({
  defaults: v.optional(ConfigDefaultsSchema, () => v.parse(ConfigDefaultsSchema, {})),
  observability: v.optional(ObservabilityConfigSchema, () => v.parse(ObservabilityConfigSchema, {})),
  agents: v.optional(v.array(AgentConfigSchema), () => []),
  quality: v.optional(QualityConfigSchema, () => v.parse(QualityConfigSchema, {})),
  watch: v.optional(WatchConfigSchema, () => v.parse(WatchConfigSchema, {})),
  notifications: v.optional(NotificationsConfigSchema, () => v.parse(NotificationsConfigSchema, {})),
  review: v.optional(ReviewConfigSchema, () => v.parse(ReviewConfigSchema, {})),
  tiering: v.optional(TieringConfigSchema, () => v.parse(TieringConfigSchema, {})),
});
export type SFConfig = v.InferOutput<typeof SFConfigSchema>;

// ── Tracing ──────────────────────────────────────────────────────────────────

/** The full set of event kinds any tracer.event()/makeEventRecord() call site emits — kept in sync with src/ui/shared/types.ts's EventType. */
export const EVENT_RECORD_TYPES = [
  "phase_start",
  "agent_start",
  "tool_call",
  "handoff",
  "gate_pass",
  "gate_fail",
  "log",
  "agent_end",
  "phase_end",
  "error",
] as const;
export const EventRecordTypeSchema = v.picklist(EVENT_RECORD_TYPES);
export type EventRecordType = v.InferOutput<typeof EventRecordTypeSchema>;

/** One traced event, always logged against adw_id + phase. */
export interface EventRecord {
  adw_id: string;
  phase_id: string;
  type: EventRecordType;
  name: string;
  payload: Record<string, unknown>;
  parent_id: string;
  tokens?: number | null;
  // Spans: set both when an event covers real elapsed time (a tool call), so
  // the UI lays it out on a time axis without parsing payload JSON. Left unset,
  // the tracer stamps started_at with the moment the event was recorded.
  started_at?: string | null;
  ended_at?: string | null;
}

export function makeEventRecord(input: Partial<EventRecord> & { adw_id: string; type: EventRecordType }): EventRecord {
  return {
    phase_id: "",
    name: "",
    payload: {},
    parent_id: "",
    tokens: null,
    started_at: null,
    ended_at: null,
    ...input,
  };
}

// ── Coding agent interface (backend-neutral: Flue, Claude Code, ...) ────────

/**
 * Everything one coding-agent dispatch+read turn needs, whichever backend
 * (`coding_agent:` in config) actually runs it — Flue today, others later.
 * Each backend module (`agent_flue.ts`, ...) is free to ignore fields it has
 * no use for (a subprocess-based backend has no use for `flue_db_path`) and
 * to interpret `model` in its own vocabulary (Flue: `provider/model-id`;
 * others may take a bare alias) — `agents.validate()` already branches its
 * model-shape check on `coding_agent` for exactly this reason.
 *
 * No `session_dir`/`raw_output_path` (Flue's own persistence is the durable
 * record for Flue; a subprocess backend owns its own equivalent) and no
 * `extensions` (harness_engineering has no analogue on any current backend —
 * see agents.validate()). `output_schema`/`output_type_name` is the one
 * contract every backend must honor somehow — Flue via an injected
 * `sf_report` tool, a CLI-shaped backend via its own structured-output flag —
 * so a Valibot envelope type becomes that backend's schema-validated output
 * with no second definition anywhere.
 */
export interface AgentRequest {
  prompt: string;
  system_prompt: string;
  model: string; // vocabulary depends on coding_agent — see above
  thinking: ThinkingLevel;
  session_id: string; // this backend's own conversation/session id: creates or continues
  // Flue's init(agent, {id}) is unconditionally create-or-continue, so
  // agent_flue.ts ignores this — but Claude Code's CLI needs the caller to
  // say explicitly which (--session-id vs --resume), since it has no
  // "create or continue" flag of its own. True whenever agents.ts's
  // agentSessionId() reused an existing agent_map.json entry.
  resume: boolean;
  tools?: string[] | null;
  output_schema: v.GenericSchema<Record<string, unknown>, unknown>;
  output_type_name: string;
  cwd: string; // set from run.repo_root — the codebase root agents work in
  flue_db_path: string; // Flue-specific: its own conversation store, consulted only by agent_flue.ts
  // Set only when the agent config carries an env_allowlist — the filtered
  // env to hand the backend's subprocess/sandbox. undefined (the common
  // case) means "pass the operator's own environment through unfiltered",
  // which both agent_cc.ts and agent_flue.ts implement as `request.env ??
  // operatorEnv()`.
  env?: Record<string, string>;
}

/**
 * Tokens and the dollars they cost, per component, summed over a call.
 *
 * Mirrors pi's `usage` shape one-for-one so the numbers reconcile with what
 * pi itself reports: `input` EXCLUDES cache reads, which bill at their own
 * (cheaper) rate — add them to learn the size of the prompt that was sent.
 */
export class UsageBreakdown {
  input_tokens = 0;
  output_tokens = 0;
  cache_read_tokens = 0;
  cache_write_tokens = 0;
  // Thinking tokens. NOT a fifth component: measured across every session on
  // disk, reasoning is always <= output and the four components above always
  // sum to totalTokens, so reasoning is the thinking SHARE of output, billed
  // at the output rate. Report it nested under output, never added to it.
  reasoning_tokens = 0;
  total_tokens = 0;
  input_cost = 0.0;
  output_cost = 0.0;
  cache_read_cost = 0.0;
  cache_write_cost = 0.0;
  total_cost = 0.0;

  /**
   * Fold in one pi `message_end` usage object.
   *
   * `totalTokens` is passed in rather than re-derived: the caller already
   * computes it pi's way (totalTokens, else the sum of the parts).
   */
  add_turn(usage: Record<string, any>, totalTokens: number): void {
    const cost = usage.cost || {};
    this.input_tokens += usage.input || 0;
    this.output_tokens += usage.output || 0;
    this.cache_read_tokens += usage.cacheRead || 0;
    this.cache_write_tokens += usage.cacheWrite || 0;
    this.reasoning_tokens += usage.reasoning || 0;
    this.total_tokens += totalTokens;
    this.input_cost += cost.input || 0.0;
    this.output_cost += cost.output || 0.0;
    this.cache_read_cost += cost.cacheRead || 0.0;
    this.cache_write_cost += cost.cacheWrite || 0.0;
    this.total_cost += cost.total || 0.0;
  }

  /** Add another call's usage — a phase that retries spends more than once. */
  merge(other: UsageBreakdown): void {
    for (const key of Object.keys(this) as (keyof UsageBreakdown)[]) {
      (this[key] as number) = (this[key] as number) + (other[key] as number);
    }
  }

  toJSON(): Record<string, number> {
    return { ...this } as unknown as Record<string, number>;
  }
}

export interface AgentResult {
  text: string;
  /**
   * The validated structured output, however this backend produced it —
   * Flue's injected `sf_report` tool call, or another backend's own
   * schema-validated result field. Present whenever the backend captured
   * one, regardless of whether it also produced JSON in `text`. `null`
   * means it never validated, so the caller falls back to extracting JSON
   * from `text` directly.
   */
  report: unknown | null;
  session_id: string;
  tokens: number;
  cost: number;
  usage: UsageBreakdown;
  // Context occupancy after the LAST turn — not a sum. `tokens` bills every
  // turn; this is how full the window is right now, which is what the
  // visualizer's context bar measures against `context_window`.
  context_tokens: number;
  context_window: number; // 0 if this backend has no way to report it (Flue never does; see agent_flue.ts)
}

export function makeAgentResult(input: Partial<AgentResult> & { session_id: string }): AgentResult {
  return {
    text: "",
    report: null,
    tokens: 0,
    cost: 0,
    usage: new UsageBreakdown(),
    context_tokens: 0,
    context_window: 0,
    ...input,
  };
}
