/**
 * The Run object: config + adw_id + agent_map + tracer + console, bound once.
 *
 * `run.phase(params, fn)` is the ONE phase primitive — an async scope for all
 * three kinds (engineer, agent, code), replacing Python's `with run.phase(...)
 * as ph:` context manager (JS has no direct equivalent, so the callback form
 * is the idiomatic stand-in). Success must be earned: every phase defaults to
 * fail; only a clean exit flips it (agent phases additionally require a
 * parsed envelope + green gates, enforced inside ph.call).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as agents from "./agents.ts";
import { makeGit, type GitHandle } from "./git_helper.ts";
import { Console, type RunObserver } from "./console.ts";
import { Tracer } from "./tracer.ts";
import { makeEventRecord, type AgentCall, type EnvelopeBase, type Phase, type PhaseParams, type SFConfig } from "./data_types.ts";
import type { TierResolution } from "./tiering.ts";
import { ensureDir, nowIso } from "./utils.ts";
import type { Notifier } from "./notify/notifier.ts";

interface AgentMapEntry {
  session_id: string;
  model: string;
  coding_agent: string;
}

export interface PhaseHandle {
  log(payload: Record<string, unknown>): void;
  call<T extends EnvelopeBase>(call: AgentCall<T>): Promise<T>;
}

class PhaseHandleImpl implements PhaseHandle {
  constructor(private run: Run, private phase: Phase) {}

  log(payload: Record<string, unknown>): void {
    this.run.tracer.event(
      makeEventRecord({
        adw_id: this.run.adw_id,
        phase_id: this.phase.phase_id,
        type: "log",
        name: this.phase.params.name,
        payload,
      }),
    );
    this.run.console.note(Object.entries(payload).map(([k, v]) => `${k}: ${v}`).join(", "));
    if (this.phase.params.kind === "engineer" && "input" in payload) {
      this.run.tracer.sessionRequest(this.run.adw_id, String(payload.input));
    }
  }

  async call<T extends EnvelopeBase>(call: AgentCall<T>): Promise<T> {
    if (this.phase.params.kind !== "agent") {
      throw new Error("ph.call() is only valid inside an agent phase");
    }
    return (await agents.execute(this.run, this.phase, call)) as T;
  }
}

export interface RunInit {
  cfg: SFConfig;
  adwId: string;
  tracer: Tracer;
  engineer: string;
  /** Absolute. Resolved once, upstream, by paths.resolveAnchor(). */
  repoRoot: string;
  /** From the same paths.resolveAnchor() call as repoRoot — for prompts.resolveRef(). */
  sfDir: string | null;
  /** Absolute. Resolved once, upstream, by paths.resolveDataPaths(). */
  dataDir: string;
  /** The CLI chain name, for a notification's title — see session.ts. */
  chainName?: string;
  /** `null`/omitted when notifications are off (the default) or no channel resolved. */
  notifier?: Notifier | null;
  /** Where a printed line goes — see `Console`'s own constructor doc. Omitted everywhere except an interactive `cli/commands/run.ts` dispatch. */
  sink?: (line: string) => void;
  /** See `RunObserver`'s doc comment (`core/console.ts`). `null`/omitted outside an interactive dispatch. */
  observer?: RunObserver | null;
}

export class Run {
  cfg: SFConfig;
  adw_id: string;
  tracer: Tracer;
  console: Console;
  /** `null` when notifications are off — `run.notify?.send(...)` at any future call site. */
  notify: Notifier | null;
  engineer: string;
  phases: Phase[] = [];
  tokens = 0;
  cost = 0;
  repo_root: string; // where every agent is spawned to work — always absolute
  /** Every git operation for this run, bound to repo_root. Never call git_helper directly. */
  git: GitHandle;
  /** From the same anchor as repo_root — null if no .spf/ dir exists. */
  spf_dir: string | null;
  /** Absolute. Sibling of it: flue.db (Flue's own conversation store), sessions/. */
  data_dir: string;
  session_dir: string;
  context_handoff_dir: string;
  agent_map: Record<string, AgentMapEntry>;
  /**
   * Set once by `startRun` (`src/chains/steps.ts`), before any phase opens —
   * `null` until then. Not a `RunInit` field: it is computed FROM the `Run`
   * (it needs `run.tracer`/`run.console` to trace and print its own
   * finding), not passed into its construction. See `core/tiering.ts`.
   */
  tiering: TierResolution | null = null;
  private seq: number; // a joined run continues the sequence
  private agentMapPath: string;

  constructor(init: RunInit) {
    this.cfg = init.cfg;
    this.adw_id = init.adwId;
    this.tracer = init.tracer;
    this.notify = init.notifier ?? null;
    this.console = new Console(init.tracer, init.adwId, this.notify, init.chainName || "adw", init.sink, init.observer);
    this.engineer = init.engineer;
    this.seq = init.tracer.maxPhaseSeq(init.adwId);
    this.repo_root = init.repoRoot;
    this.spf_dir = init.sfDir;
    this.git = makeGit(init.repoRoot);
    this.data_dir = init.dataDir;
    this.session_dir = ensureDir(path.join(init.dataDir, "sessions", init.adwId));
    this.context_handoff_dir = ensureDir(path.join(this.session_dir, "context_handoff"));
    this.agentMapPath = path.join(this.session_dir, "agent_map.json");
    this.agent_map = existsSync(this.agentMapPath) ? JSON.parse(readFileSync(this.agentMapPath, "utf-8")) : {};
  }

  // ── agent map (adw_id -> per-agent coding-agent session ids) ────────────
  saveAgentMap(agent: string, entry: AgentMapEntry): void {
    this.agent_map[agent] = entry;
    writeFileSync(this.agentMapPath, JSON.stringify(this.agent_map, null, 2));
  }

  // ── usage (run totals mirror what the tracer accumulates in sqlite) ─────
  addUsage(tokens: number, cost: number): void {
    this.tokens += tokens;
    this.cost += cost;
    this.tracer.sessionAddUsage(this.adw_id, tokens, cost);
    this.console.notifyUsage(this.tokens, this.cost);
  }

  // ── the phase primitive ─────────────────────────────────────────────────
  async phase<T>(params: PhaseParams, fn: (ph: PhaseHandle) => Promise<T>): Promise<T> {
    this.seq += 1;
    const phase: Phase = {
      phase_id: `${this.adw_id}_${String(this.seq).padStart(2, "0")}_${params.name}`,
      adw_id: this.adw_id,
      seq: this.seq,
      params,
      status: "running",
      attempt: 0,
      error: null,
      started_at: nowIso(),
      ended_at: null,
    };
    this.phases.push(phase);
    this.tracer.phaseUpsert(phase);
    this.tracer.event(
      makeEventRecord({
        adw_id: this.adw_id,
        phase_id: phase.phase_id,
        type: "phase_start",
        name: params.name,
        payload: { kind: params.kind, owner: params.owner, description: params.description },
      }),
    );
    this.console.phaseStarted(phase);
    const clock = performance.now();
    try {
      const result = await fn(new PhaseHandleImpl(this, phase));
      phase.status = "success";
      phase.ended_at = nowIso();
      this.tracer.event(
        makeEventRecord({ adw_id: this.adw_id, phase_id: phase.phase_id, type: "phase_end", name: params.name, payload: { status: "success" } }),
      );
      this.tracer.phaseUpsert(phase);
      this.console.phaseEnded(phase, (performance.now() - clock) / 1000);
      return result;
    } catch (error) {
      phase.status = "fail"; // success must be earned
      phase.error = String((error as Error)?.message ?? error).slice(0, 1000);
      phase.ended_at = nowIso();
      this.tracer.event(
        makeEventRecord({ adw_id: this.adw_id, phase_id: phase.phase_id, type: "error", name: params.name, payload: { error: phase.error } }),
      );
      this.tracer.event(
        makeEventRecord({ adw_id: this.adw_id, phase_id: phase.phase_id, type: "phase_end", name: params.name, payload: { status: "fail" } }),
      );
      this.tracer.phaseUpsert(phase);
      this.tracer.sessionFinish(this.adw_id, false);
      this.console.phaseEnded(phase, (performance.now() - clock) / 1000);
      this.console.sessionFinished(false, this.tokens, this.cost, this.cfg.observability.db);
      throw error;
    }
  }

  /**
   * Finalize the run and return its exit code. Call this exactly once.
   *
   * Two criteria, not one. Every phase must have passed, AND the ADW's own
   * acceptance test must hold. They are different questions on purpose: a
   * test phase that ran a red suite succeeded at its job. Pass `accepted=`
   * so the exit code, the session status, and the banner are decided
   * together and cannot disagree.
   */
  finish(accepted: boolean = true, reason: string = ""): number {
    const phasesOk = this.phases.length > 0 && this.phases.every((p) => p.status === "success");
    const ok = phasesOk && accepted;
    if (phasesOk && !accepted) {
      const note = reason || "the run's acceptance criterion was not met";
      this.tracer.event(
        makeEventRecord({
          adw_id: this.adw_id,
          phase_id: this.phases.length > 0 ? this.phases[this.phases.length - 1].phase_id : "",
          type: "error",
          name: "not_accepted",
          payload: { reason: note },
        }),
      );
      this.console.note(`not accepted: ${note}`);
    }
    this.tracer.sessionFinish(this.adw_id, ok);
    this.console.sessionFinished(ok, this.tokens, this.cost, this.cfg.observability.db);
    return ok ? 0 : 1;
  }
}
