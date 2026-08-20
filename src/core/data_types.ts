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
  coding_agent: v.optional(v.picklist(["flue"]), "flue"),
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
});
export type AgentConfig = v.InferOutput<typeof AgentConfigSchema>;

export const ConfigDefaultsSchema = v.object({
  coding_agent: v.optional(v.picklist(["flue"]), "flue"),
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
});
export type ConfigDefaults = v.InferOutput<typeof ConfigDefaultsSchema>;

export const ObservabilityConfigSchema = v.object({
  db: v.optional(v.string(), ".spf/data/spf.db"),
  poll_ms: v.optional(v.number(), 500),
});
export type ObservabilityConfig = v.InferOutput<typeof ObservabilityConfigSchema>;

export const SFConfigSchema = v.object({
  defaults: v.optional(ConfigDefaultsSchema, () => v.parse(ConfigDefaultsSchema, {})),
  observability: v.optional(ObservabilityConfigSchema, () => v.parse(ObservabilityConfigSchema, {})),
  agents: v.optional(v.array(AgentConfigSchema), () => []),
  quality: v.optional(QualityConfigSchema, () => v.parse(QualityConfigSchema, {})),
});
export type SFConfig = v.InferOutput<typeof SFConfigSchema>;

// ── Tracing ──────────────────────────────────────────────────────────────────

/** One traced event, always logged against adw_id + phase. */
export interface EventRecord {
  adw_id: string;
  phase_id: string;
  // phase_start | agent_start | tool_call | handoff | gate_pass | gate_fail | log | agent_end | phase_end | error
  type: string;
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

export function makeEventRecord(input: Partial<EventRecord> & { adw_id: string; type: string }): EventRecord {
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
  tools?: string[] | null;
  output_schema: v.GenericSchema<Record<string, unknown>, unknown>;
  output_type_name: string;
  cwd: string; // set from run.repo_root — the codebase root agents work in
  flue_db_path: string; // Flue-specific: its own conversation store, consulted only by agent_flue.ts
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
