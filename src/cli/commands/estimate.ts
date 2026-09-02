/**
 * `spf estimate <chain> "<prompt>"` — a read-only projection of what a chain
 * WOULD cost and WHICH models it would dispatch on, built only from real
 * trace rows already on disk. Never mints an `adw_id`, never opens a
 * session, never writes a row (design doc §5).
 *
 * Two questions, one command:
 *  - "what will this run on?" — the SAME `resolveTiering` (`core/tiering.ts`)
 *    a real run calls from `startRun`, so the printed routing cannot drift
 *    from what dispatch does.
 *  - "what will this cost?" — projected from real `sessions`/`phases`/
 *    `agent_end` rows for this exact chain name (never a joined session's),
 *    reported in TOKENS (never a fabricated per-token price table — see
 *    §5.3 for why cost is `$0.00` for exactly the rosters this feature is
 *    for) with an honest refusal — exit 3, no number — when there is
 *    nothing to project from.
 */
import * as agents from "../../core/agents.ts";
import { parseCli, resolvePrompt } from "../../core/utils.ts";
import { findChain, resolveRequiredAgents, resolveRequiredSuites } from "../../chains/index.ts";
import { probeServedOllamaTags, resolveTiering, type TierResolution } from "../../core/tiering.ts";
import { openTraceIfExists } from "./trace.ts";
import type { ChainHistorySession } from "../../ui/server/db.ts";

const KNOWN_OPTIONS = ["config", "cwd", "agent", "n"];
const KNOWN_FLAGS = ["json", "no-probe"];
const SAMPLE_CAP = 20;

export function usage(): string {
  return 'usage: spf estimate <chain> "<prompt or path/to/prompt.md>" [--n N] [--json] [--config <path>] [--cwd <dir>] [--no-probe] [--agent <name>]';
}

// ── fanout-sibling recognition (design doc §5.2) ────────────────────────────

/**
 * The base an attempt was derived from, per `fanout.ts`'s own naming scheme
 * (`attemptAdwId`: `${baseAdwId}-${index}`, `fanout.ts:129-131`) — a
 * heuristic, not a foreign key (there is no column recording it), which is
 * why the design doc calls the base "recoverable from the suffix scheme"
 * rather than "stored".
 *
 * The base itself is always `newId(8)` (`fanout.ts:277`) — 8 lowercase hex
 * characters, never containing `-` — so the match requires exactly that
 * shape rather than "any dash then digits". A bare `/^(.+)-\d+$/` is far too
 * loose: `spf watch` mints `adw_id`s like `issue-41`/`issue-42`/`issue-43`
 * (`watch.ts:357,469`, `Issue.id` a decimal string), and every one of those
 * ends in `-<digits>` despite never having gone through `spf fanout` — the
 * loose regex collapsed 41/42/43 into one shared "issue" base. Requiring the
 * base to look like `newId(8)`'s actual output means `issue-41` doesn't
 * match at all (`issue` isn't 8 hex chars) and is correctly treated as its
 * own independent run.
 */
function fanoutBaseOf(adwId: string): string {
  const match = /^([0-9a-f]{8})-\d+$/.exec(adwId);
  return match ? match[1]! : adwId;
}

/** At most one attempt per fanout base, most-recent kept (input is already recency-ordered). Does not cap; the caller decides how many of the result to keep. */
function collapseFanoutSiblings(sessions: ChainHistorySession[]): { deduped: ChainHistorySession[]; collapsed: number } {
  const seenBases = new Set<string>();
  const deduped: ChainHistorySession[] = [];
  let collapsed = 0;
  for (const session of sessions) {
    const base = fanoutBaseOf(session.adw_id);
    if (seenBases.has(base)) {
      collapsed++;
      continue;
    }
    seenBases.add(base);
    deduped.push(session);
  }
  return { deduped, collapsed };
}

// ── sample selection (design doc §5.3) ──────────────────────────────────────

export type SampleStatus = "success" | "any" | "none";

export interface Sample {
  sessions: ChainHistorySession[];
  status: SampleStatus;
  fanoutCollapsed: number;
  joinedExcluded: number;
}

/**
 * Two tiers, stopping at the first that qualifies, and an honest refusal.
 * `sessions` is already most-recent-first (db.ts's own ORDER BY).
 */
export function selectSample(sessions: ChainHistorySession[], joinedExcluded: number): Sample {
  const successes = sessions.filter((s) => s.status === "success");
  const { deduped: successDeduped, collapsed: successCollapsed } = collapseFanoutSiblings(successes);
  if (successDeduped.length >= 3) {
    return { sessions: successDeduped.slice(0, SAMPLE_CAP), status: "success", fanoutCollapsed: successCollapsed, joinedExcluded };
  }
  const { deduped: anyDeduped, collapsed: anyCollapsed } = collapseFanoutSiblings(sessions);
  if (anyDeduped.length >= 1) {
    return { sessions: anyDeduped.slice(0, SAMPLE_CAP), status: "any", fanoutCollapsed: anyCollapsed, joinedExcluded };
  }
  return { sessions: [], status: "none", fanoutCollapsed: 0, joinedExcluded };
}

// ── projection (design doc §5.3) ────────────────────────────────────────────

/** p50, no interpolation — a 3-sample percentile is false precision (design doc §5.3). Even-length arrays average the two middle values, the ordinary definition. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Strip a loop factory's trailing `_<digits>` (`steps.ts:572-579,597-600,670,683`) — `fix_1`/`fix_2` -> `fix`, `test_1` -> `test`. Reads the recorded name; never predicts it. */
export function normalizePhaseName(name: string): string {
  return name.replace(/_\d+$/, "");
}

export interface PhaseProjection {
  name: string;
  p50: number;
  min: number;
  max: number;
}

/**
 * Per run: sum every iteration of a normalized phase into one observation.
 * Across runs: median (p50) and min/max of those per-run sums. A phase
 * absent from a given run (a fix loop that never triggered) counts as a
 * `0` observation for that run — not a skip — so its median reflects how
 * often the phase actually ran, not just its size when it did.
 */
export function aggregatePhases(sessions: ChainHistorySession[]): PhaseProjection[] {
  const perRunSums: Map<string, number>[] = sessions.map(() => new Map());
  const firstSeq = new Map<string, number>();
  sessions.forEach((session, i) => {
    for (const phase of session.phases) {
      const name = normalizePhaseName(phase.name);
      perRunSums[i]!.set(name, (perRunSums[i]!.get(name) ?? 0) + phase.tokens);
      if (!firstSeq.has(name) || phase.seq < firstSeq.get(name)!) firstSeq.set(name, phase.seq);
    }
  });
  const names = [...firstSeq.keys()].sort((a, b) => firstSeq.get(a)! - firstSeq.get(b)!);
  return names.map((name) => {
    const perRun = perRunSums.map((m) => m.get(name) ?? 0);
    return { name, p50: median(perRun), min: Math.min(...perRun), max: Math.max(...perRun) };
  });
}

export interface RunTotalsProjection {
  p50: number;
  min: number;
  max: number;
}

/** The HEADLINE: median of sampled runs' `sessions.total_tokens` — NOT the sum of the per-phase medians (those are different numbers; median of sums != sum of medians). */
export function projectRunTotals(sessions: ChainHistorySession[]): RunTotalsProjection | null {
  if (sessions.length === 0) return null;
  const totals = sessions.map((s) => s.total_tokens);
  return { p50: median(totals), min: Math.min(...totals), max: Math.max(...totals) };
}

/** Where a p50 run would be cut off by `max_run_tokens`, walking the phase breakdown cumulatively in the order phases first appeared. `undefined` means unset; `null` means set but never reached on the p50 path. */
export function findCutoffPhase(phases: PhaseProjection[], maxRunTokens: number | undefined): string | null | undefined {
  if (maxRunTokens === undefined) return undefined;
  let cumulative = 0;
  for (const phase of phases) {
    cumulative += phase.p50;
    if (cumulative >= maxRunTokens) return phase.name;
  }
  return null;
}

// ── model drift (design doc §5.3) ───────────────────────────────────────────

export interface DriftWarning {
  agent: string;
  historical: string;
  current: string;
}

/**
 * Compares each sampled agent's HISTORICAL dispatch model against the
 * resolution's EFFECTIVE model — `res.routing[agent]?.effective ?? agent's
 * own configured model` — never against `roles`/`tiers` in isolation. That
 * is what makes the warning fire correctly whether or not tiering is
 * enabled: with tiering off, "effective" is just the agent's own `model:`,
 * so an operator who edited the roster directly between runs (no tiering
 * involved) still gets an accurate warning.
 */
export function detectModelDrift(
  historicalModels: Map<string, string>,
  currentModel: (agent: string) => string | undefined,
): DriftWarning[] {
  const warnings: DriftWarning[] = [];
  for (const [agent, historical] of historicalModels) {
    const current = currentModel(agent);
    if (current !== undefined && current !== historical) warnings.push({ agent, historical, current });
  }
  return warnings;
}

// ── the command ──────────────────────────────────────────────────────────────

export interface EstimateReport {
  chain: string;
  risk: TierResolution["risk"];
  signals: TierResolution["signals"];
  routing: TierResolution["routing"];
  notes: string[];
  sample: { n: number; status: SampleStatus; joined_excluded: number; fanout_collapsed: number };
  phases: PhaseProjection[];
  projected: RunTotalsProjection | null;
  observed_cost: number;
  drift: DriftWarning[];
  validate_error: string | null;
  ceilings: { max_run_tokens: number | undefined; max_run_cost: number | undefined; cutoff_phase: string | null | undefined };
  fanout_n: number;
}

export async function estimateCommand(argv: string[]): Promise<number> {
  const { positionals, options, flags } = parseCli(argv, KNOWN_OPTIONS, KNOWN_FLAGS);
  if (positionals.length < 2) {
    console.error(usage());
    return 1;
  }
  const [chainName, promptArg] = positionals;
  const chain = findChain(chainName!);
  if (!chain) {
    console.error(`unknown chain: ${chainName} — run \`spf list\` to see every chain`);
    return 1;
  }
  const n = options["n"] !== undefined ? Number.parseInt(options["n"], 10) : 1;
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--n must be a positive integer, got ${JSON.stringify(options["n"])}`);
    return 1;
  }
  const prompt = resolvePrompt(promptArg!);

  const trace = await openTraceIfExists(options);
  const cfg = trace.cfg;

  // Same shape as run.ts:54-56 — conditional insertion, never `{agent: flags["agent"] ?? ""}`.
  // `flags` never carries a value-taking option, and an empty-string sentinel
  // would defeat steps.ts:492's own `options["agent"] ?? "builder"` default.
  const chainOptions: Record<string, string> = {};
  if (options["agent"] !== undefined) chainOptions["agent"] = options["agent"];

  const required = resolveRequiredAgents(chain, chainOptions);
  const requiredSuites = resolveRequiredSuites(chain, chainOptions);

  const servedOllamaTags = flags["no-probe"] ? null : await probeServedOllamaTags(cfg);
  const res = resolveTiering({ cfg, chainName: chain.name, prompt, servedOllamaTags, required });

  // Same detector `validate()` itself runs at every real `startRun` — never
  // thrown here, only reported: `estimate` gates nothing (exit 3 is reserved
  // for "no history"), it just tells the operator a real run would fail.
  let validateError: string | null = null;
  try {
    agents.validate(cfg, required, requiredSuites, trace.anchor.cwd);
  } catch (error) {
    validateError = error instanceof Error ? error.message : String(error);
  }

  const history = trace.db ? await trace.db.chainPhaseHistory(chain.name) : { sessions: [], joinedExcluded: 0 };
  const sample = selectSample(history.sessions, history.joinedExcluded);
  const coldStart = sample.sessions.length === 0;

  const phases = aggregatePhases(sample.sessions);
  const projectedRaw = projectRunTotals(sample.sessions);
  const projected = projectedRaw && n > 1 ? { p50: projectedRaw.p50 * n, min: projectedRaw.min * n, max: projectedRaw.max * n } : projectedRaw;
  const observedCost = sample.sessions.length > 0 ? median(sample.sessions.map((s) => s.total_cost)) * n : 0;

  const historicalModels = new Map<string, string>();
  if (trace.db) {
    for (const session of sample.sessions) {
      for (const row of await trace.db.agentSessions(session.adw_id)) {
        if (row.model !== null && !historicalModels.has(row.agent)) historicalModels.set(row.agent, row.model);
      }
    }
  }
  const currentModel = (agent: string): string | undefined => res.routing[agent]?.effective ?? cfg.agents.find((a) => a.name === agent)?.model;
  const drift = detectModelDrift(historicalModels, currentModel);

  const maxTokens = cfg.defaults.max_run_tokens;
  const maxCost = cfg.defaults.max_run_cost;
  const cutoffPhase = findCutoffPhase(phases, maxTokens);

  const report: EstimateReport = {
    chain: chain.name,
    risk: res.risk,
    signals: res.signals,
    routing: res.routing,
    notes: res.notes,
    sample: { n: sample.sessions.length, status: sample.status, joined_excluded: sample.joinedExcluded, fanout_collapsed: sample.fanoutCollapsed },
    phases,
    projected,
    observed_cost: observedCost,
    drift,
    validate_error: validateError,
    ceilings: { max_run_tokens: maxTokens, max_run_cost: maxCost, cutoff_phase: cutoffPhase },
    fanout_n: n,
  };

  if (flags["json"]) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report, coldStart);
  }
  return coldStart ? 3 : 0;
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function printText(report: EstimateReport, coldStart: boolean): void {
  const lines: string[] = [];
  lines.push(`chain      ${report.chain}`);
  lines.push(
    `tier       ${report.risk}  (chain ${report.signals.chain} = ${report.signals.chain_weight}, ` +
      `prompt ${report.signals.prompt_words}w = ${report.signals.prompt_weight}, sum ${report.signals.sum})`,
  );

  const routingEntries = Object.entries(report.routing);
  if (routingEntries.length === 0) {
    lines.push("routing    (tiering.enabled is false, or nothing in this chain's roster is routed by tiering.roles)");
  } else {
    for (const [agent, route] of routingEntries) {
      const same = route.configured === route.effective;
      lines.push(`routing    ${agent} -> ${route.tier} tier (${route.effective})   ${same ? "[= configured]" : `[was ${route.configured}]`}`);
    }
  }
  for (const note of report.notes) lines.push(`note       ${note}`);
  if (report.validate_error) {
    lines.push(`note       a real run of this config would fail agents.validate() at start: ${report.validate_error}`);
  }

  if (coldStart) {
    lines.push("");
    lines.push(
      `sample     no trace history for chain "${report.chain}" yet — run \`spf ${report.chain} "..."\` once; ` +
        "this projects from real trace rows only",
    );
    if (report.sample.joined_excluded > 0) {
      lines.push(`           (${report.sample.joined_excluded} joined session(s) named this chain but cannot be attributed to it alone — excluded)`);
    }
  } else {
    const label = report.sample.status === "success" ? "successful" : "run(s), including failed/partial";
    lines.push("");
    lines.push(`sample     ${report.sample.n} ${label} of "${report.chain}"`);
    const extras: string[] = [];
    if (report.sample.joined_excluded > 0) extras.push(`${report.sample.joined_excluded} joined session(s) excluded`);
    if (report.sample.fanout_collapsed > 0) extras.push(`${report.sample.fanout_collapsed} fanout sibling(s) collapsed`);
    if (report.sample.status === "any") extras.push("a truncated run under-reports later phases");
    if (extras.length > 0) lines.push(`           (${extras.join("; ")})`);

    if (report.phases.length > 0) {
      lines.push("");
      lines.push("phase                p50 tokens        range");
      for (const phase of report.phases) {
        lines.push(`${phase.name.padEnd(20)} ${fmt(phase.p50).padStart(12)}    ${fmt(phase.min)} - ${fmt(phase.max)}`);
      }
    }
    if (report.projected) {
      lines.push("");
      lines.push(
        `projected  ${fmt(report.projected.p50).padStart(12)}    ${fmt(report.projected.min)} - ${fmt(report.projected.max)}   ` +
          "(median of RUN TOTALS, not the sum of the per-phase p50 column)",
      );
      if (report.fanout_n > 1) {
        lines.push(`           x${report.fanout_n} (spf fanout) already applied above`);
      }
    }
    lines.push(`observed cost   $${report.observed_cost.toFixed(3)}  (cost is reported as observed in the sample, never modelled — $0.00 for a local roster)`);

    for (const w of report.drift) {
      lines.push(
        `drift      ${w.agent}: sample ran ${w.historical}, current tiering picks ${w.current} — ` +
          "token counts are not comparable across tokenizers; treat this projection as an order of magnitude, never rescaled",
      );
    }
  }

  lines.push("");
  if (report.ceilings.max_run_tokens !== undefined) {
    lines.push(
      `max_run_tokens   ${fmt(report.ceilings.max_run_tokens)}` +
        (report.ceilings.cutoff_phase ? `  -> would stop at "${report.ceilings.cutoff_phase}" on a p50 run` : ""),
    );
    lines.push('           (checked BEFORE each call: a run can overshoot by one call, and a one-dispatch chain can never trip it)');
  }
  if (report.ceilings.max_run_cost !== undefined) {
    lines.push(`max_run_cost     $${report.ceilings.max_run_cost.toFixed(3)}`);
  }

  console.log(lines.join("\n"));
}
