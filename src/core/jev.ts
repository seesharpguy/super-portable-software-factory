/**
 * Jev — TypeSafe's "System One" typed-decision model — as a BOUNDED advisor
 * to spf's deterministic code. Ticket #103 (epic #102); operator docs in
 * `docs/jev.md`; the brainstorm that chose where it plugs in is
 * `docs/brainstorms/jev-in-the-factory.md`.
 *
 * spf's rule is "deterministic TypeScript owns the graph — agent proposes,
 * code disposes". Jev does not get an exception. Everything a feature needs
 * to stay inside that rule lives HERE, once, so no feature re-implements
 * (and subtly weakens) it:
 *
 *  1. OFF BY DEFAULT. No `jev:` config (or `enabled: false`) means `decide()`
 *     returns the caller's own fallback with `reason: "disabled"` — no client
 *     is built, no network call happens, and NO trace event is written, so a
 *     run's trace is byte-identical to one from before this module existed.
 *  2. CLOSED SETS ONLY. `decide()` takes the option list from the CALLER
 *     (code builds it: an enum, an operator-declared chain menu, ...). Jev's
 *     answer is only ever used if it is literally one of those values;
 *     anything else is `invalid_choice` and the fallback acts. Jev never
 *     names a chain, step, gate, model, or command code did not offer it.
 *  3. EVERY DECISION HAS A DETERMINISTIC FALLBACK, supplied by the caller
 *     (itself a member of the option set), and used on: disabled, per-kind
 *     `off`, shadow mode, missing API key, error, timeout, malformed answer,
 *     an out-of-set choice, a choice outside `permitted`, or confidence
 *     below the threshold. `decide()` never throws for any of those — the
 *     only throws are PROGRAMMER errors in the request itself (empty option
 *     set, fallback not in the set, ...), raised before any network call so
 *     a bad call site fails its own unit test instead of a run.
 *  4. SHADOW vs ACT. `mode: shadow` calls Jev and records what it said, but
 *     the fallback ACTS. `mode: act` lets Jev's answer act, only when it
 *     passes every check in (3).
 *  5. EVERYTHING IS RECORDED. Every decision made while Jev is enabled for
 *     its kind — shadow or act, success or failure — is handed to the
 *     `DecisionRecorder`, which for a run is `traceDecisionRecorder`: ONE
 *     `type: "log"`, `name: "jev_decision"` event whose payload is the
 *     whole `Decision`. `findRecordedDecision` reads it back so a replay or
 *     an estimate reuses the recorded answer instead of calling Jev again
 *     (pass it as `DecisionRequest.replay`).
 *  6. MONOTONE AUTHORITY is the CALLER's job, but `permitted` exists to make
 *     it cheap: a feature whose option set includes something Jev may only
 *     choose under conditions (e.g. `escalate_tier` only below the spend
 *     ceiling) passes the currently-allowed subset, and an answer outside it
 *     is `not_permitted`. Jev may add a rejection or stop early; it may never
 *     approve past a gate, drop a gate, raise a retry ceiling, or spend past
 *     an operator ceiling — no option set a feature builds may contain such
 *     a move in the first place.
 *  7. PURE MODULES STAY PURE. Resolve a decision ONCE (e.g. in `startRun`)
 *     and pass the resulting `Decision` into a pure function as data —
 *     never call `decide()` from inside `core/tiering.ts` or its peers.
 *  8. NO NETWORK IN TESTS. `JevClient` is an interface; tests inject
 *     `src/test/fake_jev.ts`'s `FakeJevClient` either directly
 *     (`createJev({client})`) or process-wide via `setJevClientFactory` for
 *     code paths (like `startRun`) that build their own `Jev`.
 *  9. NO NEW DEPENDENCY. `HttpJevClient` is ~40 lines over global `fetch`;
 *     the official `@typesafe-ai/sdk` is deliberately not used.
 *
 * WIRE FORMAT (researched 2026-09-25, ten days after launch — VERIFY
 * AGAINST A LIVE RESPONSE before flipping anything to `act`): one endpoint,
 * `POST {base_url}/systemone`, `Authorization: Bearer <key>`, body
 * `{model, state, questions: {name: Question}}`, response
 * `{model, answers: {name: Answer}, usage: {input_tokens, output_tokens}}`.
 * A `choice` question's `criteria` maps option key -> description and its
 * answer is `{type:"choice", choice, probabilities, confidence}`; a `score`
 * question's `criteria` is an ORDERED array of 2-10 level descriptions and
 * its answer is `{type:"score", score, legend, probabilities, confidence}`.
 * Answers are parsed defensively (`v.looseObject`) because the exact shapes
 * are the least-verified part of that research — an answer that does not
 * parse is `invalid_response`, i.e. the fallback, never a crash. When an
 * answer carries no `confidence`, it is derived from `probabilities` with
 * TypeSafe's published formula `(n * peak - 1) / (n - 1)`; with neither, the
 * confidence is unknown and treated as below any threshold.
 *
 * NOT DONE HERE, deliberately: retries. Jev's value is ~100 ms decisions; a
 * retry loop inside a 2 s timeout buys little, and every failure already has
 * a correct answer (the fallback). A 429/529 is recorded as `error` with its
 * status in `detail`, which is exactly what shadow-mode analysis should see.
 */

import { createHash } from "node:crypto";
import * as v from "valibot";
import { JevConfigSchema, makeEventRecord, type EventRecord, type JevConfig, type JevDecisionMode } from "./data_types.ts";
import { JEV_DECISION_KINDS, type JevDecisionKindSpec } from "./jev_kinds.ts";
import type { TraceDb } from "./trace_db.ts";

export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
export const JEV_SYSTEM_ONE_PATH = "/systemone";
/** The ONE trace event name for a decision — always `type: "log"` (see `traceDecisionRecorder` for why not a new event type). */
export const JEV_DECISION_EVENT = "jev_decision";
/** TypeSafe's documented per-question caps. */
export const JEV_MAX_CHOICE_OPTIONS = 255;
export const JEV_MIN_SCORE_LEVELS = 2;
export const JEV_MAX_SCORE_LEVELS = 10;

// ── wire types ──────────────────────────────────────────────────────────────

/** The unstructured context Jev evaluates. State + questions share a ~32k-token budget per call. */
export type JevState = string | Record<string, unknown> | unknown[];

export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } };

export interface SystemOneRequest {
  model: string;
  state: JevState;
  questions: Record<string, JevQuestion>;
}

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

/** `answers` values are `unknown` on purpose — parsed defensively by `decide()`, never trusted. */
export interface SystemOneResponse {
  model?: string;
  answers: Record<string, unknown>;
  usage?: Partial<JevUsage>;
}

/**
 * The seam every test fakes. `signal` aborts at the decision's timeout; a
 * client that ignores it is still bounded (`decide()` races it), it just
 * leaks its own socket until the server answers.
 */
export interface JevClient {
  systemOne(request: SystemOneRequest, options: { signal: AbortSignal }): Promise<SystemOneResponse>;
}

/** A non-2xx HTTP answer. `status` is what shadow analysis groups on (401 key, 422 request, 429 rate, 529 overloaded). */
export class JevApiError extends Error {
  readonly status: number;
  constructor(status: number, body: string) {
    super(`jev: HTTP ${status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    this.name = "JevApiError";
    this.status = status;
  }
}

/** Raised (internally) when a call outlives its `timeout_ms`; surfaces only as `reason: "timeout"`. */
export class JevTimeoutError extends Error {
  constructor(ms: number) {
    super(`jev: no answer within ${ms} ms`);
    this.name = "JevTimeoutError";
  }
}

/** Normalize `base_url`: empty -> the official endpoint; a trailing slash is dropped so `+ "/systemone"` never doubles it. */
export function jevEndpoint(baseUrl: string | undefined): string {
  const base = (baseUrl ?? "").trim() || JEV_DEFAULT_BASE_URL;
  return `${base.replace(/\/+$/, "")}${JEV_SYSTEM_ONE_PATH}`;
}

/**
 * The real client — global `fetch`, no SDK. Never logs or echoes the key:
 * an error carries only the status and a clipped response body.
 */
export class HttpJevClient implements JevClient {
  private readonly apiKey: string;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch }) {
    this.apiKey = options.apiKey;
    this.url = jevEndpoint(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async systemOne(request: SystemOneRequest, options: { signal: AbortSignal }): Promise<SystemOneResponse> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: options.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new JevApiError(response.status, text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`jev: response is not JSON (${text.slice(0, 120)})`);
    }
    if (!parsed || typeof parsed !== "object" || !("answers" in parsed) || typeof (parsed as { answers: unknown }).answers !== "object") {
      throw new Error("jev: response has no `answers` object");
    }
    return parsed as SystemOneResponse;
  }
}

// ── client resolution (and the one test hook) ────────────────────────────────

export type JevClientFactory = (config: JevConfig, env: NodeJS.ProcessEnv) => JevClient | null;

let clientFactoryOverride: JevClientFactory | null = null;

/**
 * Process-wide client override, for tests whose code path builds its own
 * `Jev` (e.g. `startRun` -> `Run.jev`) where injecting a client directly is
 * not practical. Pass `null` to restore the real behavior — always do so in
 * a `finally`/`after`. An override skips the API-key check (a fake needs no
 * key). NEVER call this from non-test code.
 */
export function setJevClientFactory(factory: JevClientFactory | null): void {
  clientFactoryOverride = factory;
}

/** Explicit client > test override > `HttpJevClient` when the key env var is set > `null` (every decision then falls back with `no_api_key`). */
function resolveClient(config: JevConfig, env: NodeJS.ProcessEnv, explicit: JevClient | null | undefined): JevClient | null {
  if (explicit) return explicit;
  if (clientFactoryOverride) return clientFactoryOverride(config, env);
  const apiKey = env[config.api_key_env]?.trim();
  if (!apiKey) return null;
  return new HttpJevClient({ apiKey, baseUrl: config.base_url });
}

// ── policy ─────────────────────────────────────────────────────────────────

/** The fully-resolved knobs for ONE decision kind — global `jev:` values with `jev.decisions.<kind>` layered on top. */
export interface DecisionPolicy {
  kind: string;
  /** `off` whenever `jev.enabled` is false, regardless of any per-kind override. */
  mode: JevDecisionMode;
  threshold: number;
  timeout_ms: number;
  model: string;
  /** Everything in `jev.decisions.<kind>` except `mode`/`threshold`/`timeout_ms` — the feature's own settings, unvalidated. Use `parseDecisionExtras`. */
  extras: Record<string, unknown>;
}

const COMMON_OVERRIDE_KEYS = new Set(["mode", "threshold", "timeout_ms"]);

/** Parse-with-defaults, so callers holding a partial/absent block (tests, `SFConfig["jev"]` from an older build) get the same answer. */
export function normalizeJevConfig(config: Partial<JevConfig> | null | undefined): JevConfig {
  return v.parse(JevConfigSchema, config ?? {});
}

export function resolveDecisionPolicy(config: Partial<JevConfig> | null | undefined, kind: string): DecisionPolicy {
  const cfg = normalizeJevConfig(config);
  const override = cfg.decisions[kind] ?? {};
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(override)) {
    if (!COMMON_OVERRIDE_KEYS.has(key)) extras[key] = value;
  }
  return {
    kind,
    mode: cfg.enabled ? (override.mode ?? cfg.mode) : "off",
    threshold: override.threshold ?? cfg.threshold,
    timeout_ms: override.timeout_ms ?? cfg.timeout_ms,
    model: cfg.model,
    extras,
  };
}

/**
 * A feature's own settings from `jev.decisions.<kind>`, parsed with the
 * schema its `jev_kinds.ts` spec declares. Throws a config-shaped error
 * (`jev.decisions.<kind>: ...`) — call it at load/startRun time, not deep in
 * a phase. A spec with no `extras` schema returns `{}`-typed extras as-is.
 */
export function parseDecisionExtras<E>(config: Partial<JevConfig> | null | undefined, spec: Pick<JevDecisionKindSpec<E>, "kind" | "extras">): E {
  const { extras } = resolveDecisionPolicy(config, spec.kind);
  if (!spec.extras) return extras as E;
  const result = v.safeParse(spec.extras, extras);
  if (!result.success) {
    const issues = result.issues.map((i) => `${i.path?.map((p) => String(p.key)).join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`jev.decisions.${spec.kind}: ${issues}`);
  }
  return result.output;
}

// ── decisions ──────────────────────────────────────────────────────────────

/** One member of a closed option set. `description` is what Jev reads; `value` is what code acts on. */
export interface JevOption<T extends string = string> {
  value: T;
  description: string;
}

/**
 * Why the fallback acted instead of Jev's answer — checked in THIS order,
 * first match wins, so `reason` names the EARLIEST thing that disqualified
 * Jev's answer. In shadow mode that makes `reason: "shadow"` mean "Jev
 * answered validly and confidently — act mode WOULD have used it", which is
 * the number shadow-mode analysis actually wants (see `would_act`).
 */
export const FALLBACK_REASONS = [
  "disabled", // jev.enabled false (or no jev: block) — nothing called, nothing recorded
  "kind_off", // jev.decisions.<kind>.mode: off — nothing called, nothing recorded
  "replay_missing", // replay requested (`replay: null`) but nothing was recorded — nothing called
  "no_api_key", // enabled, but the key env var is unset — nothing called
  "timeout",
  "error", // transport / HTTP / non-JSON — `detail` has the message (and status)
  "invalid_response", // answer missing or not the shape the question type returns
  "invalid_choice", // answered with a value outside the closed option set
  "not_permitted", // in the set, but outside the caller's `permitted` subset
  "low_confidence", // below threshold, or confidence unknown
  "shadow", // valid + confident + permitted, but mode is shadow
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

export type DecisionQuestionType = "choice" | "score";

export interface DecisionRequest<T extends string = string> {
  /** The decision kind — register it in `core/jev_kinds.ts`. Selects `jev.decisions.<kind>` policy. */
  kind: string;
  /** Disambiguates repeated decisions of one kind in one run (e.g. `"fix_2"`), so a replay finds the right one. Default `""`. */
  key?: string;
  /** Default `"choice"`. For `"score"`, `options` is the rubric in ORDER (lowest level first), 2-10 levels. */
  question?: DecisionQuestionType;
  /** The CLOSED set, built by code. Non-empty, unique values, ≤255 (choice) / 2-10 (score). */
  options: readonly JevOption<T>[];
  /** The question itself — what Jev is asked to decide about `state`. */
  instructions: string;
  /** The context Jev reads (issue body, findings, prompt, ...). Not recorded — only its sha256 is. */
  state: JevState;
  /** The deterministic answer. Must be one of `options`. This is what acts whenever Jev's answer may not. */
  fallback: T;
  /** Optional subset of `options` Jev's answer may ACT on right now (see header §6). Must contain `fallback`. */
  permitted?: readonly T[];
  /**
   * `undefined` (the default): live — call Jev per policy.
   * A recorded `Decision` (from `findRecordedDecision`): reuse it verbatim,
   *   no call — provided its kind/key/options/fallback still match this request.
   * `null`: replay requested but nothing recorded — fallback, no call.
   */
  replay?: Decision | null;
  /** Phase this decision belongs to, for the trace event. Default `""` (run-scoped). */
  phase_id?: string;
}

/** A `DecisionRequest` minus `state`, for `decideBatch` (which shares one state across its items). */
export type DecisionBatchItem<T extends string = string> = Omit<DecisionRequest<T>, "state">;

export interface Decision<T extends string = string> {
  kind: string;
  key: string;
  question: DecisionQuestionType;
  options: T[];
  /** THE EFFECTIVE CHOICE — what code acts on. Jev's answer when `used_fallback` is false, else `fallback`. */
  choice: T;
  /** What Jev answered, if it answered with a member of `options`; else `null`. Shadow analysis compares this to `fallback`. */
  jev_choice: T | null;
  /** 0-1, as reported (or derived from probabilities); `null` when Jev was not called or reported none. */
  confidence: number | null;
  /** For a score question: Jev's continuous probability-weighted score, as returned. `null` otherwise. */
  score: number | null;
  /** Per-option probabilities as returned (keys are option values for choice; level indices for score). */
  probabilities: Record<string, number> | null;
  fallback: T;
  used_fallback: boolean;
  /** `null` exactly when `used_fallback` is false. */
  reason: FallbackReason | null;
  /** Human-readable context for `reason` (error message, confidence vs threshold, ...). Never contains the API key. */
  detail: string;
  /** True when act mode would have used Jev's answer (valid + confident + permitted) — independent of the actual mode. */
  would_act: boolean;
  /** `jev_choice === fallback`, or `null` when there is no `jev_choice`. */
  agrees: boolean | null;
  latency_ms: number;
  mode: JevDecisionMode;
  threshold: number;
  model: string | null;
  usage: JevUsage | null;
  /** sha256 of `{state, instructions, options}` — lets a replay notice the input drifted since recording. */
  input_sha256: string;
  /** True when this Decision was reused from the trace rather than decided now. */
  replayed: boolean;
}

/** Receives every decision made while Jev is enabled for its kind. Errors are swallowed (see `Jev.record`). */
export type DecisionRecorder = (decision: Decision, meta: { phase_id: string }) => void | Promise<void>;

/** Programmer-error checks — see header §3. Runs even when Jev is disabled, so a bad call site fails its own unit test. */
function validateRequest<T extends string>(item: DecisionBatchItem<T>): void {
  const where = `jev decide(${JSON.stringify(item.kind)})`;
  if (!item.kind) throw new Error("jev decide(): kind is required");
  const question = item.question ?? "choice";
  const values = item.options.map((o) => o.value);
  if (values.length === 0) throw new Error(`${where}: options is empty`);
  if (new Set(values).size !== values.length) throw new Error(`${where}: duplicate option values`);
  if (values.some((value) => typeof value !== "string" || value.length === 0)) throw new Error(`${where}: every option value must be a non-empty string`);
  if (question === "choice" && values.length > JEV_MAX_CHOICE_OPTIONS) throw new Error(`${where}: at most ${JEV_MAX_CHOICE_OPTIONS} choice options`);
  if (question === "score" && (values.length < JEV_MIN_SCORE_LEVELS || values.length > JEV_MAX_SCORE_LEVELS)) {
    throw new Error(`${where}: a score rubric needs ${JEV_MIN_SCORE_LEVELS}-${JEV_MAX_SCORE_LEVELS} levels`);
  }
  if (!values.includes(item.fallback)) throw new Error(`${where}: fallback ${JSON.stringify(item.fallback)} is not one of the options`);
  if (item.permitted) {
    const stray = item.permitted.filter((p) => !values.includes(p));
    if (stray.length > 0) throw new Error(`${where}: permitted names non-options ${JSON.stringify(stray)}`);
    if (!item.permitted.includes(item.fallback)) throw new Error(`${where}: permitted must include the fallback`);
  }
}

function inputDigest(state: JevState, item: DecisionBatchItem): string {
  return createHash("sha256")
    .update(JSON.stringify({ state, instructions: item.instructions, options: item.options }))
    .digest("hex");
}

function toQuestion(item: DecisionBatchItem): JevQuestion {
  if ((item.question ?? "choice") === "score") {
    return { type: "score", instructions: item.instructions, criteria: item.options.map((o) => o.description) };
  }
  return { type: "choice", instructions: item.instructions, criteria: Object.fromEntries(item.options.map((o) => [o.value, o.description])) };
}

const ProbabilitiesSchema = v.record(v.string(), v.number());
const ChoiceAnswerSchema = v.looseObject({
  choice: v.string(),
  probabilities: v.optional(ProbabilitiesSchema),
  confidence: v.optional(v.number()),
});
const ScoreAnswerSchema = v.looseObject({
  score: v.optional(v.number()),
  legend: v.optional(v.record(v.string(), v.string())),
  probabilities: v.optional(ProbabilitiesSchema),
  confidence: v.optional(v.number()),
});

/** TypeSafe's published confidence formula: `(n * peak - 1) / (n - 1)` — 0 for a uniform spread, 1 for certainty. */
export function confidenceFromProbabilities(probabilities: Record<string, number>, n: number): number | null {
  const values = Object.values(probabilities);
  if (values.length === 0 || n < 2) return null;
  const peak = Math.max(...values);
  return Math.min(1, Math.max(0, (n * peak - 1) / (n - 1)));
}

interface ParsedAnswer {
  /** Raw answered value (may be outside the option set — checked by the caller). `null` = unparseable. */
  value: string | null;
  confidence: number | null;
  score: number | null;
  probabilities: Record<string, number> | null;
  problem: string;
}

/**
 * Map a score answer onto a rubric level. Level keys in `probabilities`/
 * `legend` are indices whose BASE (0 or 1) the research could not pin down,
 * so it is inferred: from `legend`'s keys when present, else from
 * `probabilities`' keys, else 0. The level is the probability argmax when
 * probabilities exist (the continuous `score` is a weighted mean and can
 * sit between levels), else `round(score)`.
 */
function parseScoreAnswer(answer: unknown, options: readonly JevOption[]): ParsedAnswer {
  const parsed = v.safeParse(ScoreAnswerSchema, answer);
  if (!parsed.success) return { value: null, confidence: null, score: null, probabilities: null, problem: "score answer did not parse" };
  const { score, legend, probabilities, confidence } = parsed.output;
  const indexKeys = Object.keys(legend ?? probabilities ?? {})
    .map(Number)
    .filter((n) => Number.isInteger(n));
  const base = indexKeys.length > 0 && Math.min(...indexKeys) === 1 ? 1 : 0;
  let index: number | null = null;
  if (probabilities && Object.keys(probabilities).length > 0) {
    const [bestKey] = Object.entries(probabilities).reduce((best, entry) => (entry[1] > best[1] ? entry : best));
    const byDescription = options.findIndex((o) => o.description === bestKey);
    index = byDescription >= 0 ? byDescription : Number(bestKey) - base;
  } else if (typeof score === "number") {
    index = Math.round(score) - base;
  }
  const derived = confidence ?? (probabilities ? confidenceFromProbabilities(probabilities, options.length) : null);
  if (index === null || !Number.isInteger(index) || index < 0 || index >= options.length) {
    return { value: `level:${String(index)}`, confidence: derived, score: score ?? null, probabilities: probabilities ?? null, problem: `score level ${String(index)} is outside the ${options.length}-level rubric` };
  }
  return { value: options[index]!.value, confidence: derived, score: score ?? null, probabilities: probabilities ?? null, problem: "" };
}

function parseAnswer(answer: unknown, item: DecisionBatchItem): ParsedAnswer {
  if (answer === undefined || answer === null) return { value: null, confidence: null, score: null, probabilities: null, problem: "no answer for this question" };
  if ((item.question ?? "choice") === "score") return parseScoreAnswer(answer, item.options);
  const parsed = v.safeParse(ChoiceAnswerSchema, answer);
  if (!parsed.success) return { value: null, confidence: null, score: null, probabilities: null, problem: "choice answer did not parse" };
  const { choice, probabilities, confidence } = parsed.output;
  const derived = confidence ?? (probabilities ? confidenceFromProbabilities(probabilities, item.options.length) : null);
  return { value: choice, confidence: derived, score: null, probabilities: probabilities ?? null, problem: "" };
}

function sameOptions(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function baseDecision<T extends string>(item: DecisionBatchItem<T>, policy: DecisionPolicy, digest: string): Decision<T> {
  return {
    kind: item.kind,
    key: item.key ?? "",
    question: item.question ?? "choice",
    options: item.options.map((o) => o.value),
    choice: item.fallback,
    jev_choice: null,
    confidence: null,
    score: null,
    probabilities: null,
    fallback: item.fallback,
    used_fallback: true,
    reason: null,
    detail: "",
    would_act: false,
    agrees: null,
    latency_ms: 0,
    mode: policy.mode,
    threshold: policy.threshold,
    model: null,
    usage: null,
    input_sha256: digest,
    replayed: false,
  };
}

function withFallback<T extends string>(decision: Decision<T>, reason: FallbackReason, detail: string): Decision<T> {
  return { ...decision, choice: decision.fallback, used_fallback: true, reason, detail };
}

/** Turn one parsed answer into the final Decision — the whole shadow/act/threshold/permitted policy, in `FALLBACK_REASONS` order. */
function judge<T extends string>(decision: Decision<T>, item: DecisionBatchItem<T>, policy: DecisionPolicy, answer: ParsedAnswer): Decision<T> {
  const values: readonly string[] = decision.options;
  const out: Decision<T> = { ...decision, confidence: answer.confidence, score: answer.score, probabilities: answer.probabilities };
  if (answer.value === null) return withFallback(out, "invalid_response", answer.problem);
  if (!values.includes(answer.value)) {
    return withFallback(out, "invalid_choice", answer.problem || `answered ${JSON.stringify(answer.value)}, not one of ${JSON.stringify(values)}`);
  }
  const jevChoice = answer.value as T;
  out.jev_choice = jevChoice;
  out.agrees = jevChoice === item.fallback;
  if (item.permitted && !item.permitted.includes(jevChoice)) {
    return withFallback(out, "not_permitted", `answered ${JSON.stringify(jevChoice)}, permitted now: ${JSON.stringify(item.permitted)}`);
  }
  if (answer.confidence === null || answer.confidence < policy.threshold) {
    return withFallback(out, "low_confidence", `confidence ${answer.confidence === null ? "unknown" : answer.confidence.toFixed(3)} < threshold ${policy.threshold}`);
  }
  out.would_act = true;
  if (policy.mode === "shadow") return withFallback(out, "shadow", `shadow: Jev chose ${JSON.stringify(jevChoice)}, fallback ${JSON.stringify(item.fallback)} acts`);
  return { ...out, choice: jevChoice, used_fallback: false, reason: null, detail: "" };
}

function describeError(error: unknown): { reason: "timeout" | "error"; detail: string } {
  if (error instanceof JevTimeoutError) return { reason: "timeout", detail: error.message };
  if (error instanceof Error && error.name === "AbortError") return { reason: "timeout", detail: "jev: aborted at timeout" };
  if (error instanceof JevApiError) return { reason: "error", detail: error.message };
  return { reason: "error", detail: error instanceof Error ? error.message : String(error) };
}

function nowMs(): number {
  return performance.now();
}

export interface JevOptions {
  /** `cfg.jev` — absent/partial is fine (normalized with defaults, i.e. disabled). */
  config?: Partial<JevConfig> | null;
  /** Inject a client (tests: `FakeJevClient`). Skips the API-key requirement. */
  client?: JevClient | null;
  /** Where the API key is read from. Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Receives every recorded decision — `traceDecisionRecorder(...)` for a run. */
  recorder?: DecisionRecorder | null;
}

/**
 * One configured Jev — config + (lazily) a client + a recorder. Cheap to
 * construct: nothing touches the network or the env until a decision is
 * actually made with Jev enabled for its kind. `Run.jev` is one of these,
 * already wired to the run's trace.
 */
export class Jev {
  readonly config: JevConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly explicitClient: JevClient | null;
  private readonly recorder: DecisionRecorder | null;
  private client: JevClient | null | undefined = undefined;
  private recordErrorWarned = false;

  constructor(options: JevOptions = {}) {
    this.config = normalizeJevConfig(options.config);
    this.env = options.env ?? process.env;
    this.explicitClient = options.client ?? null;
    this.recorder = options.recorder ?? null;
  }

  /** Same config/client/env, different recorder — e.g. a `Jev` built before its run's tracer existed. */
  withRecorder(recorder: DecisionRecorder | null): Jev {
    return new Jev({ config: this.config, client: this.explicitClient, env: this.env, recorder });
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  policy(kind: string): DecisionPolicy {
    return resolveDecisionPolicy(this.config, kind);
  }

  /** One decision, one call. See the module header for the full contract. */
  async decide<T extends string>(request: DecisionRequest<T>): Promise<Decision<T>> {
    const { state, ...item } = request;
    const [decision] = await this.decideBatch(state, [item]);
    return decision!;
  }

  /**
   * Several decisions over ONE shared `state`, in ONE HTTP call — TypeSafe's
   * headline feature (questions are answered in parallel and in isolation,
   * so a batch costs little more latency than one question). Each item gets
   * its own policy, fallback, and trace event exactly as if decided alone;
   * items whose kind is off/disabled or which carry a `replay` never reach
   * the wire. The call's timeout is the LARGEST `timeout_ms` among the live
   * items (one request can only have one deadline). Results are in item order.
   */
  async decideBatch<T extends string>(state: JevState, items: readonly DecisionBatchItem<T>[]): Promise<Decision<T>[]> {
    for (const item of items) validateRequest(item);
    const results: Decision<T>[] = new Array(items.length);
    const live: number[] = [];

    items.forEach((item, i) => {
      const policy = this.policy(item.kind);
      const base = baseDecision(item, policy, inputDigest(state, item));
      if (item.replay) {
        results[i] = this.replayed(base, item);
      } else if (!this.config.enabled) {
        results[i] = withFallback(base, "disabled", "");
      } else if (policy.mode === "off") {
        results[i] = withFallback(base, "kind_off", `jev.decisions.${item.kind}.mode is off`);
      } else if (item.replay === null) {
        results[i] = withFallback(base, "replay_missing", "replay requested, no recorded decision");
      } else {
        live.push(i);
      }
    });

    if (live.length > 0) {
      if (this.client === undefined) this.client = resolveClient(this.config, this.env, this.explicitClient);
      const client = this.client;
      if (!client) {
        for (const i of live) {
          const item = items[i]!;
          results[i] = withFallback(baseDecision(item, this.policy(item.kind), inputDigest(state, item)), "no_api_key", `${this.config.api_key_env} is not set`);
        }
      } else {
        await this.callLive(client, state, items, live, results);
      }
    }

    // Record everything Jev was enabled for — see header §1/§5. `disabled`
    // and `kind_off` are never recorded: that is the "off is a total no-op"
    // guarantee, in the trace as well as on the wire.
    for (let i = 0; i < items.length; i++) {
      const decision = results[i]!;
      if (decision.reason === "disabled" || decision.reason === "kind_off") continue;
      await this.record(decision, items[i]!.phase_id ?? "");
    }
    return results;
  }

  private replayed<T extends string>(base: Decision<T>, item: DecisionBatchItem<T>): Decision<T> {
    const recorded = item.replay!;
    const matches =
      recorded.kind === item.kind &&
      recorded.key === (item.key ?? "") &&
      recorded.fallback === item.fallback &&
      sameOptions(recorded.options, base.options) &&
      (base.options as readonly string[]).includes(recorded.choice);
    if (!matches) {
      // A recorded decision for a DIFFERENT question is not a replay of this
      // one — fall back rather than act on a stale answer, and say why.
      return withFallback({ ...base, replayed: true }, "replay_missing", "recorded decision does not match this request (kind/key/options/fallback changed)");
    }
    return { ...(recorded as Decision<T>), replayed: true };
  }

  private async callLive<T extends string>(
    client: JevClient,
    state: JevState,
    items: readonly DecisionBatchItem<T>[],
    live: number[],
    results: Decision<T>[],
  ): Promise<void> {
    const questions: Record<string, JevQuestion> = {};
    for (const i of live) questions[`q${i}`] = toQuestion(items[i]!);
    const timeoutMs = Math.max(...live.map((i) => this.policy(items[i]!.kind).timeout_ms));
    const request: SystemOneRequest = { model: this.config.model, state, questions };

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const started = nowMs();
    let response: SystemOneResponse | null = null;
    let failure: unknown = null;
    try {
      const call = Promise.resolve().then(() => client.systemOne(request, { signal: controller.signal }));
      call.catch(() => {}); // a late rejection after the timeout won the race must never be unhandled
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new JevTimeoutError(timeoutMs));
        }, timeoutMs);
        // Deliberately NOT unref'd: a caller is awaiting this decision, so
        // the deadline must keep the loop alive until it fires — an unref'd
        // timer beside a handle-less hung call would let the process exit
        // mid-decision. It is always cleared in `finally` below.
      });
      response = await Promise.race([call, deadline]);
    } catch (error) {
      failure = error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const latency = Math.round(nowMs() - started);
    const usage: JevUsage | null = response?.usage
      ? { input_tokens: response.usage.input_tokens ?? 0, output_tokens: response.usage.output_tokens ?? 0 }
      : null;

    for (const i of live) {
      const item = items[i]!;
      const policy = this.policy(item.kind);
      const base: Decision<T> = { ...baseDecision(item, policy, inputDigest(state, item)), latency_ms: latency, model: response?.model ?? this.config.model, usage };
      if (failure !== null || !response) {
        const { reason, detail } = describeError(failure);
        results[i] = withFallback(base, reason, detail);
        continue;
      }
      results[i] = judge(base, item, policy, parseAnswer(response.answers?.[`q${i}`], item));
    }
  }

  /** Never throws: a trace-write failure must not turn an advisory decision into a failed phase. Warns once per `Jev`. */
  private async record(decision: Decision, phaseId: string): Promise<void> {
    if (!this.recorder) return;
    try {
      await this.recorder(decision, { phase_id: phaseId });
    } catch (error) {
      if (!this.recordErrorWarned) {
        this.recordErrorWarned = true;
        process.stderr.write(`[spf] jev: could not record a decision (${(error as Error).message}) — continuing\n`);
      }
    }
  }
}

export function createJev(options: JevOptions = {}): Jev {
  return new Jev(options);
}

/** Free-function form of `Jev.decide`, for call sites that hold a `Jev` but read better as `decide(jev, {...})`. */
export function decide<T extends string>(jev: Jev, request: DecisionRequest<T>): Promise<Decision<T>> {
  return jev.decide(request);
}

// ── trace: record + look up ──────────────────────────────────────────────────

/**
 * The event a decision is recorded as. `type: "log"` with `name:
 * "jev_decision"`, NOT a new `EventRecordType`: that picklist is closed and
 * mirrored by the UI (data_types.ts's EVENT_RECORD_TYPES <->
 * ui/shared/types.ts's EventType — `tiering.test.ts` pins it), and a
 * decision is a note about the run, not a new lifecycle stage — the same
 * reasoning `startRun`'s `chain_source` and `tiering` events follow. The UI
 * already renders log payloads generically. otel never exports `log`
 * events, so decision payloads (which quote option descriptions) stay local.
 */
export function decisionEventRecord(decision: Decision, adwId: string, phaseId = ""): EventRecord {
  return makeEventRecord({
    adw_id: adwId,
    phase_id: phaseId,
    type: "log",
    name: JEV_DECISION_EVENT,
    payload: { ...decision } as unknown as Record<string, unknown>,
  });
}

/** The recorder a run uses — `Run` wires one into `run.jev`. `phase_id` comes from the request, not from here. */
export function traceDecisionRecorder(tracer: { event(record: EventRecord): Promise<string> }, adwId: string): DecisionRecorder {
  return async (decision, meta) => {
    await tracer.event(decisionEventRecord(decision, adwId, meta.phase_id));
  };
}

const RecordedDecisionSchema = v.looseObject({
  kind: v.string(),
  key: v.optional(v.string(), ""),
  question: v.optional(v.picklist(["choice", "score"]), "choice"),
  options: v.array(v.string()),
  choice: v.string(),
  jev_choice: v.optional(v.nullable(v.string()), null),
  confidence: v.optional(v.nullable(v.number()), null),
  score: v.optional(v.nullable(v.number()), null),
  probabilities: v.optional(v.nullable(v.record(v.string(), v.number())), null),
  fallback: v.string(),
  used_fallback: v.boolean(),
  reason: v.optional(v.nullable(v.picklist(FALLBACK_REASONS)), null),
  detail: v.optional(v.string(), ""),
  would_act: v.optional(v.boolean(), false),
  agrees: v.optional(v.nullable(v.boolean()), null),
  latency_ms: v.optional(v.number(), 0),
  mode: v.picklist(["off", "shadow", "act"]),
  threshold: v.optional(v.number(), 0),
  model: v.optional(v.nullable(v.string()), null),
  usage: v.optional(v.nullable(v.object({ input_tokens: v.number(), output_tokens: v.number() })), null),
  input_sha256: v.optional(v.string(), ""),
  replayed: v.optional(v.boolean(), false),
});

/** A `jev_decision` payload back into a `Decision`, or `null` if it is not one (older/foreign/corrupt row). */
export function parseRecordedDecision(payload: unknown): Decision | null {
  const parsed = v.safeParse(RecordedDecisionSchema, payload);
  if (!parsed.success) return null;
  const out = parsed.output;
  if (!out.options.includes(out.choice) || !out.options.includes(out.fallback)) return null;
  return out as Decision;
}

export interface RecordedEventLike {
  type: string;
  name: string;
  payload: unknown;
}

/** Every recorded decision in `events` (in-memory rows, a parsed `events.jsonl`, ...), in the order given, optionally filtered. */
export function decisionsFromEvents(events: Iterable<RecordedEventLike>, filter: { kind?: string; key?: string } = {}): Decision[] {
  const out: Decision[] = [];
  for (const event of events) {
    if (event.type !== "log" || event.name !== JEV_DECISION_EVENT) continue;
    const decision = parseRecordedDecision(event.payload);
    if (!decision) continue;
    if (filter.kind !== undefined && decision.kind !== filter.kind) continue;
    if (filter.key !== undefined && decision.key !== filter.key) continue;
    out.push(decision);
  }
  return out;
}

/** Every recorded decision for a run, oldest first, from the trace db (local sqlite or D1 — `run.tracer.db`). */
export async function listRecordedDecisions(db: TraceDb, adwId: string, filter: { kind?: string; key?: string } = {}): Promise<Decision[]> {
  const rows = await db
    .query<{ payload_json: string }, [string, string, string]>(
      "SELECT payload_json FROM events WHERE adw_id=? AND type=? AND name=? ORDER BY started_at, rowid",
    )
    .all(adwId, "log", JEV_DECISION_EVENT);
  const events: RecordedEventLike[] = [];
  for (const row of rows) {
    try {
      events.push({ type: "log", name: JEV_DECISION_EVENT, payload: JSON.parse(row.payload_json) });
    } catch {
      // A corrupt row is not a decision — skip it, never fail a replay over it.
    }
  }
  return decisionsFromEvents(events, filter);
}

/**
 * The MOST RECENT recorded decision of `kind` (+ `key`) for a run, or
 * `null`. Pass the result straight into `DecisionRequest.replay` — a
 * `null` there means "replay mode, nothing recorded: use the fallback, do
 * not call Jev".
 */
export async function findRecordedDecision(db: TraceDb, adwId: string, kind: string, key = ""): Promise<Decision | null> {
  const all = await listRecordedDecisions(db, adwId, { kind, key });
  return all.length > 0 ? all[all.length - 1]! : null;
}

// ── spf doctor ──────────────────────────────────────────────────────────────

export interface JevDoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  severity?: "info" | "warn";
}

/**
 * Everything `spf doctor` reports about `jev:` — pure (env passed in), so it
 * is unit-tested without running doctor. EMPTY when Jev is disabled: an
 * unused block must be invisible, the same rule doctor applies to a disabled
 * `tiering:` ladder. Only a malformed `base_url` or a known kind's invalid
 * feature settings fail doctor; everything else is info/warn, because every
 * other problem already degrades to the deterministic fallback at run time.
 */
export function jevDoctorChecks(
  config: Partial<JevConfig> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  kinds: Readonly<Record<string, JevDecisionKindSpec<unknown>>> = JEV_DECISION_KINDS,
): JevDoctorCheck[] {
  const cfg = normalizeJevConfig(config);
  if (!cfg.enabled) return [];
  const checks: JevDoctorCheck[] = [];
  const endpoint = jevEndpoint(cfg.base_url);
  checks.push({
    name: "jev",
    ok: true,
    detail: `mode=${cfg.mode} model=${cfg.model} threshold=${cfg.threshold} timeout=${cfg.timeout_ms}ms endpoint=${endpoint}`,
    severity: "info",
  });
  let urlOk = true;
  try {
    const url = new URL(endpoint);
    urlOk = url.protocol === "https:" || url.protocol === "http:";
  } catch {
    urlOk = false;
  }
  if (!urlOk) checks.push({ name: "jev base_url", ok: false, detail: `${JSON.stringify(cfg.base_url)} is not an http(s) URL` });
  const keySet = Boolean(env[cfg.api_key_env]?.trim());
  checks.push({
    name: "jev api key",
    ok: true, // a missing key degrades every decision to its fallback (reason no_api_key) — never a hard failure
    detail: keySet ? `${cfg.api_key_env} is set` : `${cfg.api_key_env} is not set — every Jev decision will fall back (reason: no_api_key)`,
    severity: keySet ? "info" : "warn",
  });
  for (const kind of Object.keys(cfg.decisions).sort()) {
    const policy = resolveDecisionPolicy(cfg, kind);
    const spec = kinds[kind];
    if (!spec) {
      const known = Object.keys(kinds);
      checks.push({
        name: `jev decision "${kind}"`,
        ok: true,
        detail: `not a known decision kind — this entry does nothing (known: ${known.length > 0 ? known.join(", ") : "none yet"})`,
        severity: "warn",
      });
      continue;
    }
    try {
      parseDecisionExtras(cfg, spec);
      checks.push({
        name: `jev decision "${kind}"`,
        ok: true,
        detail: `${spec.summary} — mode=${policy.mode} threshold=${policy.threshold} timeout=${policy.timeout_ms}ms${spec.options ? ` options=${spec.options.join("|")}` : ""}`,
        severity: "info",
      });
    } catch (error) {
      checks.push({ name: `jev decision "${kind}"`, ok: false, detail: (error as Error).message });
    }
  }
  return checks;
}
