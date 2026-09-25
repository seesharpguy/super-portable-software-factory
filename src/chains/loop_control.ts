/**
 * Jev loop control — ticket #105 (epic #102); operator docs in
 * `docs/jev.md` under "### `loop_control`".
 *
 * `fixLoop` and `reviseLoop` (`./steps.ts`) are bounded: check, repair,
 * check again, at most `max` rounds. Today every failed round that is not
 * the last one simply spends another repair round on the same agent and
 * the same model. This module lets Jev weigh in at exactly that point —
 * after a FAILED round, only when another repair round would otherwise run —
 * with one of three code-built answers:
 *
 *  - `continue`       the next repair round runs as it always has. This is
 *                     the fallback, so every failure mode of Jev (disabled,
 *                     shadow, timeout, error, low confidence, ...) is
 *                     byte-for-byte today's loop.
 *  - `escalate_tier`  the repairing role runs the rest of THIS loop one rung
 *                     higher on `tiering.tiers`. Permitted only when
 *                     `nextRung()` says so — see its conditions below — and
 *                     at most once per loop.
 *  - `stop_blocked`   end the loop now, NOT accepted. Jev may stop early; it
 *                     may never approve: the failed round's verdict stands.
 *
 * What no answer can do (invariant 6): add a round (the loop's `for` bound
 * is untouched — this module is never asked on the final round and has no
 * say over the bound), skip or weaken a gate (the check phase and every gate
 * on the repair phase run exactly as before), mark the run accepted, or move
 * a role above the operator's `jev.decisions.loop_control.max_tier`. Absent
 * `max_tier`, `escalate_tier` is never in `permitted`, so `decide()` reports
 * `not_permitted` and the fallback (`continue`) acts — on replay too.
 *
 * `nextRung()` is PURE (config + resolution in, a verdict out) and is where
 * every escalation bound lives, so it is tested without a run. The only
 * impure piece is `createLoopControl()`, which asks Jev and — on an
 * `escalate_tier` that acted — swaps `run.tiering` for a copy with ONE
 * routing entry changed, restored by `restore()` when the loop exits. The
 * escalation therefore reaches the repairing role through the same
 * `effectiveAgent()` dispatch seam tiering already uses, and never outlives
 * the loop that asked for it (a later loop or step sees the run's original
 * routing, and asks again if it wants more).
 *
 * Escalation has one side effect beyond the model: the repairing role's
 * escalated rounds open a FRESH agent session (agents.ts rejoins a session
 * only on the model it was opened with), so they do not see the earlier
 * rounds' conversation — only the prompt plus the failing round's verbatim
 * output, which is all a repair round is ever given. `restore()` puts the
 * role's pre-escalation `agent_map` entry back so later phases on the
 * original model rejoin their session as they would have.
 *
 * Replay (invariant 5): each decision's `key` is `<loop>[#n]:<round phase>`
 * (see `loopKeyPrefix`), unique within a run, and a replay driver hands in
 * recorded decisions through `setLoopControlReplay()`; `decide()` re-judges
 * them under today's policy and `permitted`.
 */

import { LOOP_CONTROL_CHOICES, LOOP_CONTROL_KIND } from "../core/jev_kinds.ts";
import { findRecordedDecision, parseDecisionExtras, type Decision, type Jev, type JevOption } from "../core/jev.ts";
import * as tiering from "../core/tiering.ts";
import { makeEventRecord, type SFConfig } from "../core/data_types.ts";
import type { Run } from "../core/runner.ts";
import type { TraceDb } from "../core/trace_db.ts";

export type LoopControlChoice = (typeof LOOP_CONTROL_CHOICES)[number];

/** Today's behavior, and every failure path's answer. */
export const LOOP_CONTROL_FALLBACK: LoopControlChoice = "continue";

const DESCRIPTIONS: Record<LoopControlChoice, string> = {
  continue:
    "Run the next repair round as configured: same agent, same model. Right when the failures look fixable by another attempt — the first failure, or failures that changed or shrank since the previous round.",
  escalate_tier:
    "Run the next repair round (and the rest of this loop) with the repairing agent moved up ONE rung to a stronger model. Only meaningful when state.escalation.available is true; right when the same failure persists across attempts and looks beyond the current model.",
  stop_blocked:
    "Stop the loop now with no further repair round; the run ends NOT accepted. Right when another round cannot plausibly help: identical failures repeating with no progress, an environment/infrastructure problem (missing tool, network, permissions, timeout) the agent cannot fix, or a requirement outside what the agent may change.",
};

/** The closed option set, built from the same constant as the kind spec's display-only `options` (rule R4). */
export const LOOP_CONTROL_OPTIONS: readonly JevOption<LoopControlChoice>[] = LOOP_CONTROL_CHOICES.map((value) => ({
  value,
  description: DESCRIPTIONS[value],
}));

// ── the escalation bound (pure) ─────────────────────────────────────────────

export type RungCheck =
  | { ok: true; from_tier: string; to_tier: string; route: tiering.TierRoute }
  | { ok: false; why: string };

/**
 * May `role` move up one rung right now? PURE. Every condition must hold:
 *
 *  1. `maxTier` is set (operator opt-in — the spend ceiling) and names a
 *     rung declared in `tiering.tiers`;
 *  2. the call site has no standing reason to refuse (`refuse` — e.g.
 *     reviseLoop with `reviewer === builder`, where retiering the author
 *     would retier the critic too, since routing is keyed by agent NAME);
 *  3. this loop has not already escalated (at most ONE rung per loop);
 *  4. tiering is enabled and actually routed `role` this run (a role
 *     tiering never touched has no rung to climb from — its own `model:`
 *     stands, as `resolveTiering` promises);
 *  5. the next rung up exists and is at or below `maxTier` on the ladder;
 *  6. that rung is usable by the same rule `resolveTiering` applies
 *     (`tiering.usable`: backend-compatible, and served if it is an
 *     `ollama/` tag). An unusable rung is NOT skipped past: escalation
 *     moves one rung or not at all.
 */
export function nextRung(input: {
  cfg: SFConfig;
  resolution: tiering.TierResolution | null;
  role: string;
  maxTier: string | undefined;
  servedOllamaTags: Set<string> | null;
  alreadyEscalated: boolean;
  /** A call-site reason escalation is never permitted in this loop (checked right after `maxTier`). */
  refuse?: string;
}): RungCheck {
  const { cfg, resolution, role, maxTier, servedOllamaTags, alreadyEscalated, refuse } = input;
  if (maxTier === undefined) return { ok: false, why: "jev.decisions.loop_control.max_tier is not set — escalation is disabled" };
  if (refuse !== undefined) return { ok: false, why: refuse };
  if (alreadyEscalated) return { ok: false, why: "this loop already escalated once — at most one rung per loop" };
  if (!cfg.tiering.enabled) return { ok: false, why: "tiering is disabled — there is no ladder to climb" };
  const route = resolution?.routing[role];
  if (!route) return { ok: false, why: `${role} is not routed by tiering this run — its own model stands` };
  const tiers = cfg.tiering.tiers;
  const maxIdx = tiers.findIndex((t) => t.name === maxTier);
  if (maxIdx === -1) return { ok: false, why: `max_tier ${JSON.stringify(maxTier)} is not declared in tiering.tiers` };
  const cur = tiers.findIndex((t) => t.name === route.tier);
  if (cur === -1) return { ok: false, why: `${role}'s current tier ${JSON.stringify(route.tier)} is not in tiering.tiers` };
  const next = cur + 1;
  if (next > maxIdx) return { ok: false, why: `${role} is already at or above max_tier ${JSON.stringify(maxTier)}` };
  const agent = cfg.agents.find((a) => a.name === role);
  const rung = tiers[next]!;
  if (!agent || !tiering.usable(rung, agent, servedOllamaTags)) {
    return { ok: false, why: `the next rung ${JSON.stringify(rung.name)} is not usable for ${role} (backend mismatch or unserved tag)` };
  }
  return { ok: true, from_tier: route.tier, to_tier: rung.name, route: { tier: rung.name, configured: route.configured, effective: rung.model } };
}

// ── config-path guard (pure) ────────────────────────────────────────────────

/**
 * Ticket #105 named the ceiling `jev.loop.max_tier`; it lives at
 * `jev.decisions.loop_control.max_tier` (the core contract puts every
 * feature's settings under its own kind's entry). `JevConfigSchema` is a
 * non-strict object, so a `jev.loop:` block written per the ticket is
 * STRIPPED at parse — escalation would stay silently disabled and every
 * `escalate_tier` would read `not_permitted` "max_tier is not set". Given
 * one RAW (pre-parse) config document, return the warning `spf doctor`
 * prints for that, or `null`. Pure; the doctor reads each config layer's
 * YAML and calls this.
 */
export function misplacedLoopSettings(raw: unknown): string | null {
  const jev = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>)["jev"] : undefined;
  if (jev === null || typeof jev !== "object" || !("loop" in jev)) return null;
  const loop = (jev as Record<string, unknown>)["loop"];
  const hasMax = loop !== null && typeof loop === "object" && "max_tier" in loop;
  return (
    `jev.loop is not a setting and is ignored${hasMax ? " — so escalation stays DISABLED" : ""}; ` +
    `loop_control's ceiling is jev.decisions.loop_control.max_tier (move it there)`
  );
}

// ── the loop hook (impure: asks Jev, swaps run.tiering) ─────────────────────

/** Tail of a long output — failures print their cause last. Bounded so N rounds of history stay well inside Jev's ~32k-token state budget. */
export function clipTail(text: string, max = 4_000): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

/**
 * State bounds. Jev's state budget is ~32k tokens; a suite with hundreds of
 * failing checks (or a reviewer with dozens of blocking findings) must not
 * push the request past it — the call would then fail (`error` /
 * `invalid_response`, safe: `continue`) exactly on the runs where the
 * decision matters most. So every list is capped, `history` keeps only the
 * most recent rounds, and the whole serialized state is held under
 * `STATE_BUDGET_CHARS` (~12k tokens at ~4 chars/token) as a last resort.
 */
export const MAX_LIST_ITEMS = 20;
export const MAX_HISTORY_ROUNDS = 6;
export const STATE_BUDGET_CHARS = 48_000;

/** The first `max` items; if any were dropped, one trailing string says how many — the model sees that the list was cut, never a silently short one. */
export function capList<T>(items: readonly T[], max = MAX_LIST_ITEMS): Array<T | string> {
  return items.length <= max ? items.slice() : [...items.slice(0, max), `… and ${items.length - max} more`];
}

/**
 * Last-resort aggregate bound: if the serialized state is still over
 * `budget`, first drop `history` to its most recent round, then replace
 * `latest` with a clipped tail of its own JSON. Pure; exported for its test.
 */
export function boundState(state: Record<string, unknown>, budget = STATE_BUDGET_CHARS): Record<string, unknown> {
  const size = (s: Record<string, unknown>) => JSON.stringify(s).length;
  if (size(state) <= budget) return state;
  const history = Array.isArray(state["history"]) ? (state["history"] as unknown[]) : [];
  let out: Record<string, unknown> = { ...state, history: history.slice(-1), history_truncated: true };
  if (size(out) <= budget) return out;
  const { latest: _latest, ...rest } = out;
  const room = Math.max(1_000, budget - size(rest) - 200);
  out = { ...rest, latest: { truncated: true, json_tail: clipTail(JSON.stringify(state["latest"] ?? null), room) } };
  return out;
}

export interface FailedRound {
  /** 1-based round number — the loop's `i`. */
  round: number;
  /** The failed check/review phase's name (`test_1`, `review_2`, ...) — the decision's stable `key` is built from it. */
  phase: string;
  /** One line per failure/blocking item — what `history` keeps for later rounds (capped to `MAX_LIST_ITEMS` here). */
  brief: string[];
  /** The detail of THIS round (clipped outputs, findings; the call site caps its lists with `capList`) — sent only for the latest round. */
  detail: Record<string, unknown>;
}

export interface LoopControl {
  /** Ask after a failed, non-final round; returns the EFFECTIVE choice (already applied, for `escalate_tier`). */
  afterFailedRound(round: FailedRound): Promise<LoopControlChoice>;
  /** Undo this loop's escalation, if any. Idempotent; call from a `finally`. */
  restore(): void;
}

// ── replay seam ─────────────────────────────────────────────────────────────

/**
 * Where a replay/estimate driver hands in recorded decisions (invariant 5:
 * a replay must be ABLE to reuse a recorded decision instead of re-calling
 * Jev). Given the decision's (kind, key) it returns the recorded `Decision`
 * to reuse, or `null` for "replay mode, nothing recorded" (fallback, no
 * call). The answer is passed as `DecisionRequest.replay`, so `decide()`
 * re-judges it under TODAY's policy and today's `permitted`: a recorded
 * `escalate_tier` replays as `not_permitted` once `max_tier` is gone.
 */
export type LoopControlReplay = (kind: string, key: string) => Promise<Decision | null>;

/** Per-run replay resolvers — a WeakMap so `Run` gains no field and a finished run is collectable. */
const replayResolvers = new WeakMap<object, LoopControlReplay>();

/**
 * Put `run`'s loops in replay mode: every later `loop_control` decision in
 * this run resolves through `resolver` instead of a live Jev call. `null`
 * returns to live. Nothing in spf calls this yet (`spf estimate` does not
 * run loops); it is the seam a replay driver uses, and it is tested.
 */
export function setLoopControlReplay(run: Run, resolver: LoopControlReplay | null): void {
  if (resolver) replayResolvers.set(run, resolver);
  else replayResolvers.delete(run);
}

/** The usual resolver: replay the decisions recorded by run `sourceAdwId` in `db` (latest match per (kind, key), per `findRecordedDecision`). */
export function recordedDecisionReplay(db: TraceDb, sourceAdwId: string): LoopControlReplay {
  return (kind, key) => findRecordedDecision(db, sourceAdwId, kind, key);
}

/** Per-run count of live loop_control loops, per loop kind — the ordinal in the decision key. */
const loopOrdinals = new WeakMap<object, Map<string, number>>();

function nextLoopOrdinal(run: Run, loop: string): number {
  let counts = loopOrdinals.get(run);
  if (!counts) loopOrdinals.set(run, (counts = new Map()));
  const n = (counts.get(loop) ?? 0) + 1;
  counts.set(loop, n);
  return n;
}

/**
 * The decision's replay key: `fix:test_1` for the run's first fixLoop,
 * `fix#2:test_1` for its second, and so on (likewise `revise`). A repo chain
 * may list `fixLoop` twice over one suite, or `reviseLoop` twice — both
 * name their phases `test_1`/`review_1`, so the phase alone would collide
 * and a replay would reuse the other loop's answer. The ordinal counts loops
 * in the order they start, which a fixed chain makes stable across runs
 * (rule R1). The first loop keeps the bare form so the common single-loop
 * chain reads naturally.
 */
export function loopKeyPrefix(loop: "fix" | "revise", ordinal: number): string {
  return ordinal === 1 ? loop : `${loop}#${ordinal}`;
}

const INSTRUCTIONS: Record<"fix" | "revise", string> = {
  fix:
    "A deterministic check suite just FAILED inside a bounded check -> repair loop, and a repair round is about to run. " +
    "Decide what the loop does next. The number of rounds is fixed by the operator and cannot be raised. " +
    "Compare `latest` with `history`: progress (fewer or different failures) favors continue; the same failure repeating favors " +
    "escalate_tier when escalation.available is true, else stop_blocked if nothing suggests another attempt will differ; " +
    "an environment or infrastructure failure the agent cannot fix by editing code favors stop_blocked.",
  revise:
    "A reviewer just REJECTED the work inside a bounded review -> revise loop, and a revision round is about to run. " +
    "Decide what the loop does next. The number of rounds is fixed by the operator and cannot be raised. " +
    "Compare `latest` blocking findings with `history`: findings closing or changing favors continue; the same blocking " +
    "findings repeating favors escalate_tier when escalation.available is true, else stop_blocked if another revision is unlikely " +
    "to differ; findings that ask for something outside the request or the code the agent may change favor stop_blocked.",
};

/**
 * The per-loop hook, or `null` when Jev is off for this kind (disabled, or
 * `jev.decisions.loop_control.mode: off`) — the loop then runs exactly as
 * it always has, with no state built, no probe, no call, no trace row. A
 * run-shaped stub with no `jev` at all (older tests) is treated as off.
 */
export function createLoopControl(
  run: Run,
  opts: {
    loop: "fix" | "revise";
    role: string;
    subject: string;
    max: number;
    /** A standing reason escalation is never permitted in this loop (see `nextRung`'s condition 2). */
    refuseEscalation?: string;
  },
): LoopControl | null {
  const jev = (run as { jev?: Jev }).jev;
  if (!jev || jev.policy(LOOP_CONTROL_KIND.kind).mode === "off") return null;
  const { max_tier: maxTier } = parseDecisionExtras(run.cfg.jev, LOOP_CONTROL_KIND);
  const keyPrefix = loopKeyPrefix(opts.loop, nextLoopOrdinal(run, opts.loop));

  const original = run.tiering;
  let escalated: { from_tier: string; to_tier: string } | null = null;
  // The repairing role's agent_map entry as it stood before escalating —
  // see restore().
  let sessionBefore: Run["agent_map"][string] | undefined;
  const history: Array<{ round: number; phase: string; failures: Array<string>; action: LoopControlChoice }> = [];

  return {
    async afterFailedRound(round: FailedRound): Promise<LoopControlChoice> {
      // Just after `run.phase` returned for the failed round, that round is
      // the last phase this run opened — its id ties the decision to it.
      const phaseId = run.phases[run.phases.length - 1]?.phase_id ?? "";
      const servedOllamaTags = maxTier === undefined ? null : await tiering.probeServedOllamaTags(run.cfg);
      const rung = nextRung({
        cfg: run.cfg,
        resolution: run.tiering,
        role: opts.role,
        maxTier,
        servedOllamaTags,
        alreadyEscalated: escalated !== null,
        refuse: opts.refuseEscalation,
      });
      const permitted: LoopControlChoice[] = rung.ok ? ["continue", "escalate_tier", "stop_blocked"] : ["continue", "stop_blocked"];
      const route = run.tiering?.routing[opts.role];
      const key = `${keyPrefix}:${round.phase}`;
      const replayResolver = replayResolvers.get(run);
      const brief = capList(round.brief).map(String);

      const decision = await jev.decide<LoopControlChoice>({
        kind: LOOP_CONTROL_KIND.kind,
        key,
        options: LOOP_CONTROL_OPTIONS,
        instructions: INSTRUCTIONS[opts.loop],
        // `undefined` = live; a resolver answers with a recorded Decision
        // (re-judged under today's policy + `permitted`) or null
        // (replay_missing -> continue). Never consulted when the kind is
        // off — createLoopControl returned null above.
        ...(replayResolver ? { replay: await replayResolver(LOOP_CONTROL_KIND.kind, key) } : {}),
        state: boundState({
          loop: opts.loop === "fix" ? "fixLoop" : "reviseLoop",
          subject: opts.subject,
          round: round.round,
          max_rounds: opts.max,
          // Repair rounds still available after this one, INCLUDING the one about to run.
          repair_rounds_left: opts.max - round.round,
          repairing_agent: opts.role,
          repairing_tier: route?.tier ?? null,
          escalation: rung.ok ? { available: true, from_tier: rung.from_tier, to_tier: rung.to_tier } : { available: false, why: rung.why },
          escalated_this_loop: escalated,
          latest: round.detail,
          history: history.slice(-MAX_HISTORY_ROUNDS),
          ...(history.length > MAX_HISTORY_ROUNDS ? { history_omitted_rounds: history.length - MAX_HISTORY_ROUNDS } : {}),
        }),
        fallback: LOOP_CONTROL_FALLBACK,
        permitted,
        phase_id: phaseId,
      });

      const choice = decision.choice;
      // Belt and braces: `decide()` already refuses a choice outside
      // `permitted`, replay included — re-check `rung.ok` anyway so no
      // future change there can route around the ceiling here.
      if (choice === "escalate_tier" && rung.ok && run.tiering) {
        const entry = run.agent_map[opts.role];
        sessionBefore = entry ? { ...entry } : undefined;
        run.tiering = { ...run.tiering, routing: { ...run.tiering.routing, [opts.role]: rung.route } };
        escalated = { from_tier: rung.from_tier, to_tier: rung.to_tier };
        await run.console.note(`[spf] loop_control ${opts.role} ${rung.from_tier} -> ${rung.to_tier} (${rung.route.effective}) after ${round.phase}`);
      } else if (choice === "stop_blocked") {
        await run.console.note(`[spf] loop_control stopping after ${round.phase}: Jev judged the loop blocked`);
      }
      if (choice !== "continue") {
        await run.tracer.event(
          makeEventRecord({
            adw_id: run.adw_id,
            phase_id: phaseId,
            type: "log",
            name: "loop_control",
            payload: { choice, round: round.round, max_rounds: opts.max, role: opts.role, ...(escalated && choice === "escalate_tier" ? escalated : {}) },
          }),
        );
      }
      history.push({ round: round.round, phase: round.phase, failures: brief, action: choice });
      return choice;
    },
    restore(): void {
      if (escalated === null) return;
      run.tiering = original;
      // An escalated round runs on a different model, so agents.ts's
      // agentSessionId() does not rejoin the role's session (it rejoins only
      // when the stored model matches) — the escalated rounds open a FRESH
      // session, losing the earlier rounds' context window, and
      // saveAgentMap() then records that session under the escalated model.
      // Put the pre-escalation entry back so a later phase on the original
      // model rejoins the session it would have rejoined had this loop never
      // escalated, instead of starting fresh a second time.
      if (sessionBefore) {
        const now = run.agent_map[opts.role];
        if (!now || now.session_id !== sessionBefore.session_id || now.model !== sessionBefore.model) run.saveAgentMap(opts.role, sessionBefore);
      }
      escalated = null;
    },
  };
}
