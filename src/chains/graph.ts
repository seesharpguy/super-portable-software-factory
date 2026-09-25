/**
 * Declared chain transitions — phase 2 of dynamic chains (#109, epic #102).
 *
 * WHAT THIS IS. A repo chain (`.spf/chains/*.yaml`, see `./repo_chains.ts`)
 * is a flat step list, run top to bottom. This module lets that list carry
 * DECLARED EDGES instead: a step may have an `id`, a `next:` list of step
 * ids it may hand off to, and a `default` among them. The driver
 * (`steps.runSteps`, via `walkGraph` below) then walks the graph. At a step
 * with more than one declared edge, Jev (`core/jev.ts`, kind `chain_edge`)
 * picks one of THOSE edges and nothing else; its deterministic fallback is
 * the `default` edge (or, when the linear next step is one of the declared
 * edges, that step). A chain with no `next:` anywhere never reaches this
 * module: it is a plain list, run exactly as it always was.
 *
 * WHY THE GRAPH IS STILL CODE-DISPOSED. The operator declares every edge;
 * Jev only picks among them, and the load-time checks below reject any
 * graph in which a Jev-picked path could do something the default path
 * could not be trusted with:
 *
 *   - every edge target exists and every step is reachable from the start;
 *   - every cycle passes through a step with `max_visits` (so the graph is
 *     acyclic once those steps are removed), and a chain-wide `max_steps`
 *     budget caps total step executions regardless;
 *   - the DEFAULT PATH — what runs with Jev off, or on any fallback — must
 *     finish within that budget;
 *   - a `commit` can only be reached through paths on which every gating
 *     step (`qualityCheck`/`fixLoop`/`reviseLoop`) that the default path
 *     runs before it also runs. A Jev-picked edge may ADD checks before a
 *     commit; it can never skip one (invariant 6, and the same rule
 *     `steps.ts`'s GATE_ALLOWLIST applies to gates);
 *   - a `commit` with `onlyIfAccepted` is reachable only through paths on
 *     which at least one gating step runs, so `accepted` can never be the
 *     untouched initial `true` when it lands.
 *
 * ACCEPTANCE IS AGGREGATED ON A GRAPH. In a linear chain each gating step
 * overwrites `state.accepted`. On a graph that would let a Jev-picked branch
 * launder a failure: tests fail, Jev routes to a review that approves, and
 * the review's `accepted: true` overwrites the red suite just before an
 * `onlyIfAccepted` commit. So `walkGraph` keeps the LATEST result of every
 * gating step that has run and sets `state.accepted` to "all of them
 * passed". Re-running a gate (a declared retry cycle) replaces that gate's
 * own result; a different gate never does. That is strictly stricter than
 * the linear rule, so `onlyIfAccepted` keeps its meaning: commit only when
 * the checks that ran are green.
 *
 * DETERMINISTIC REPLAY. Every transition is written to the trace as a
 * `chain_edge` log event (from, to, how it was chosen, the Jev decision key),
 * and a completed walk writes one `chain_path` event with the whole path.
 * A Jev decision's key is `<step id>#<visit>` — stable across runs, never an
 * array index — so `walkGraph(..., { replay })` can feed a recorded decision
 * back in (`findRecordedDecision(db, adwId, "chain_edge", key)`) and retrace
 * the same path without calling Jev.
 *
 * Pure except for `walkGraph`: validation and the transition rule are plain
 * functions over data, so the load-time check and the run-time walk use the
 * SAME `transition()` and cannot disagree about what the default path is.
 */
import { isValidOptionSet, type Decision, type JevOption } from "../core/jev.ts";
import { CHAIN_EDGE_KIND } from "../core/jev_kinds.ts";
import { makeEventRecord } from "../core/data_types.ts";
import type { Run } from "../core/runner.ts";
import type { ChainState, Step } from "./steps.ts";

/** The trace log-event names this module writes — `type: "log"`, never a new EventRecordType. */
export const CHAIN_EDGE_EVENT = "chain_edge";
export const CHAIN_PATH_EVENT = "chain_path";

/** Upper bound on `max_visits` — same reasoning as `repo_chains.ts`'s `Max`: raise deliberately. */
export const MAX_VISITS_LIMIT = 10;
/** Upper bound on an explicit `max_steps`. */
export const MAX_STEPS_LIMIT = 50;
/** `max_steps` when the file omits it: twice the step count, capped at MAX_STEPS_LIMIT. */
export function defaultMaxSteps(stepCount: number): number {
  return Math.min(MAX_STEPS_LIMIT, Math.max(1, stepCount * 2));
}

/** One step of a graph chain. */
export interface GraphNode {
  /** The yaml `id`, or `<step>@<index>` for a step that declared none (never a target: a yaml id cannot contain `@`). */
  id: string;
  /** The factory name (`fixLoop`, `commit`, ...) — for messages. */
  step_name: string;
  step: Step;
  /** Declared edges; `null` = none declared (hand off to the linear next step, or end if last); `[]` = end here. */
  next: string[] | null;
  /** The declared fallback edge, when `next` has more than one entry. */
  default: string | null;
  /** How many times this step may run in one walk; `null` = unbounded (the budget still applies). */
  max_visits: number | null;
  /** Sets `state.accepted` (qualityCheck / fixLoop / reviseLoop) — see ACCEPTANCE IS AGGREGATED. */
  gate: boolean;
  /** A commit step, and whether it is `onlyIfAccepted`. */
  commit: null | "plain" | "only_if_accepted";
}

export interface ChainGraph {
  /** The chain's name — part of the state Jev sees. */
  chain: string;
  /** In declaration order; `nodes[0]` is the start step. */
  nodes: GraphNode[];
  /** The step budget: total step executions one walk may make. */
  max_steps: number;
}

// ── the transition rule (shared by load-time simulation and the walk) ──────

/** What happens after a step ran. */
export type Transition =
  | { kind: "end" }
  | { kind: "go"; to: string; via: "linear" | "declared" | "only_permitted" }
  | { kind: "choose"; options: string[]; permitted: string[]; fallback: string }
  | { kind: "stop"; reason: string };

function nodeIndex(graph: ChainGraph): Map<string, number> {
  return new Map(graph.nodes.map((n, i) => [n.id, i]));
}

/** The linear successor's id, or null for the last step. */
function linearNext(graph: ChainGraph, index: number): string | null {
  return graph.nodes[index + 1]?.id ?? null;
}

/** Every edge out of a node — declared, or the implicit linear one. */
export function successors(graph: ChainGraph, index: number): string[] {
  const node = graph.nodes[index]!;
  if (node.next !== null) return node.next;
  const lin = linearNext(graph, index);
  return lin === null ? [] : [lin];
}

/** The node's preferred fallback edge when it has several: `default`, else the linear next step (the loader guarantees one is in `next`). */
function preferredEdge(graph: ChainGraph, index: number): string {
  const node = graph.nodes[index]!;
  return node.default ?? linearNext(graph, index)!;
}

/**
 * After node `index` ran: where the walk may go next, given how often each
 * node has run. An edge into a node that has used up its `max_visits` is
 * not permitted. If the preferred fallback is exhausted, the first declared
 * edge that is not becomes the fallback — deterministic, and still one of
 * the operator's own edges. No edge left at all stops the walk (the run is
 * then not accepted: it did not finish the path it was declared to take).
 */
export function transition(graph: ChainGraph, index: number, visits: ReadonlyMap<string, number>): Transition {
  const node = graph.nodes[index]!;
  const targets = successors(graph, index);
  if (targets.length === 0) return { kind: "end" };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const open = targets.filter((t) => {
    const cap = byId.get(t)?.max_visits ?? null;
    return cap === null || (visits.get(t) ?? 0) < cap;
  });
  if (open.length === 0) {
    return { kind: "stop", reason: `every edge out of step "${node.id}" leads to a step that has used up its max_visits (${targets.join(", ")})` };
  }
  if (node.next === null) return { kind: "go", to: open[0]!, via: "linear" };
  if (targets.length === 1) return { kind: "go", to: open[0]!, via: "declared" };
  if (open.length === 1) return { kind: "go", to: open[0]!, via: "only_permitted" };
  const preferred = preferredEdge(graph, index);
  const fallback = open.includes(preferred) ? preferred : open[0]!;
  return { kind: "choose", options: [...targets], permitted: open, fallback };
}

/** The path the graph takes with every choice resolved to its fallback — what runs with Jev off. */
export function defaultPath(graph: ChainGraph): { path: string[]; stopped: string | null } {
  const index = nodeIndex(graph);
  const visits = new Map<string, number>();
  const path: string[] = [];
  let current: number | null = 0;
  while (current !== null) {
    if (path.length >= graph.max_steps) return { path, stopped: budgetMessage(graph, graph.nodes[current]!.id) };
    const id = graph.nodes[current]!.id;
    visits.set(id, (visits.get(id) ?? 0) + 1);
    path.push(id);
    const t = transition(graph, current, visits);
    if (t.kind === "end") return { path, stopped: null };
    if (t.kind === "stop") return { path, stopped: t.reason };
    current = index.get(t.kind === "go" ? t.to : t.fallback)!;
  }
  return { path, stopped: null };
}

function budgetMessage(graph: ChainGraph, at: string): string {
  return `step budget exhausted: max_steps ${graph.max_steps} reached before step "${at}" could run`;
}

// ── load-time checks ─────────────────────────────────────────────────────

/** Ids reachable from the start, walking `successors`, never entering `blocked`. */
function reachable(graph: ChainGraph, blocked: ReadonlySet<string> = new Set()): Set<string> {
  const index = nodeIndex(graph);
  const seen = new Set<string>();
  const start = graph.nodes[0]?.id;
  if (start === undefined || blocked.has(start)) return seen;
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of successors(graph, index.get(id)!)) {
      if (!seen.has(next) && !blocked.has(next) && index.has(next)) stack.push(next);
    }
  }
  return seen;
}

/** A cycle among nodes WITHOUT max_visits, as a list of ids, or null. */
function unboundedCycle(graph: ChainGraph): string[] | null {
  const index = nodeIndex(graph);
  const unbounded = new Set(graph.nodes.filter((n) => n.max_visits === null).map((n) => n.id));
  const state = new Map<string, "open" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, "open");
    stack.push(id);
    for (const next of successors(graph, index.get(id)!)) {
      if (!unbounded.has(next)) continue;
      if (state.get(next) === "open") return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };
  for (const node of graph.nodes) {
    if (unbounded.has(node.id) && !state.has(node.id)) {
      const found = visit(node.id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Every structural problem with a graph, as messages an author can act on.
 * Empty = the graph is safe to walk. Called by `repo_chains.ts` at load time
 * AFTER it has checked ids/next/default syntax (unique ids, existing
 * targets, default among next), so this assumes every edge resolves.
 */
export function graphProblems(graph: ChainGraph): string[] {
  const problems: string[] = [];
  const live = reachable(graph);
  const dead = graph.nodes.filter((n) => !live.has(n.id)).map((n) => n.id);
  if (dead.length > 0) {
    problems.push(`step(s) ${dead.map((d) => JSON.stringify(d)).join(", ")} can never run — no path from the start step reaches them`);
  }

  const cycle = unboundedCycle(graph);
  if (cycle) {
    problems.push(
      `cycle ${cycle.map((c) => JSON.stringify(c)).join(" -> ")} has no step with max_visits — every cycle must pass through a step that bounds it`,
    );
    return problems; // the default-path simulation below is meaningless on an unbounded cycle
  }

  const walk = defaultPath(graph);
  if (walk.stopped !== null) {
    problems.push(`the default path (what runs with Jev off) does not finish: ${walk.stopped}`);
    return problems;
  }

  const gateIds = new Set(graph.nodes.filter((n) => n.gate).map((n) => n.id));
  for (const node of graph.nodes) {
    if (node.commit === null || !live.has(node.id)) continue;
    // (a) every gate the default path runs before this commit must lie on
    // EVERY path to it: remove the gate, and the commit must become
    // unreachable.
    const firstVisit = walk.path.indexOf(node.id);
    if (firstVisit >= 0) {
      const before = [...new Set(walk.path.slice(0, firstVisit).filter((id) => gateIds.has(id)))];
      for (const gate of before) {
        if (reachable(graph, new Set([gate])).has(node.id)) {
          problems.push(
            `step "${node.id}" (commit) can be reached without running "${gate}", which the default path runs before it — ` +
              `a declared edge may add checks before a commit, never skip one`,
          );
        }
      }
    }
    // (b) an onlyIfAccepted commit must never be reachable with NO gate run.
    if (node.commit === "only_if_accepted" && reachable(graph, gateIds).has(node.id)) {
      problems.push(
        `step "${node.id}" (commit, onlyIfAccepted) is reachable through a path on which no gating step ` +
          `(qualityCheck/fixLoop/reviseLoop) runs — it would land with nothing having checked it`,
      );
    }
  }
  return problems;
}

/** A display string for `spf list`: every step in declaration order, branch points annotated with their declared edges. */
export function graphPhases(graph: ChainGraph): string {
  return graph.nodes
    .map((n) => {
      const label = n.step.label ?? "?";
      const named = n.id.includes("@") ? label : `${n.id}:${label}`;
      return n.next === null ? named : `${named} =>(${n.next.length > 0 ? n.next.join("|") : "end"})`;
    })
    .join(" -> ");
}

// ── the walk ─────────────────────────────────────────────────────────────

/** Where a replayed decision comes from: the recorded `chain_edge` decision for a key, or null. */
export type EdgeReplay = (key: string) => Promise<Decision | null>;

export interface GraphWalk {
  path: string[];
  /** Why the walk stopped short (budget, exhausted edges), or null if it reached an end. */
  stopped: string | null;
}

/** Truncate what Jev sees; only its sha256 is ever recorded, but the call still has a token budget. */
function clip(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** What Jev reads when picking an edge — the run's situation at the branch point, never the whole trace. */
function edgeState(graph: ChainGraph, state: ChainState, from: string, path: string[]): Record<string, unknown> {
  const previous = state.previous as { status?: unknown; summary?: unknown } | null;
  return {
    chain: graph.chain,
    request: clip(state.prompt),
    from,
    path,
    accepted: state.accepted,
    reason: clip(state.reason, 1000),
    last_envelope: previous ? { status: previous.status ?? null, summary: clip(String(previous.summary ?? ""), 1000) } : null,
    quality: state.quality ? { passed: state.quality.passed, failures: state.quality.failures.map((f) => clip(f, 500)).slice(0, 5) } : null,
    review: state.review ? { approved: state.review.approved, blocking: state.review.blocking?.length ?? 0 } : null,
  };
}

/**
 * Walk a graph chain: run the start step, then follow `transition()` until
 * an end, a stop, or the step budget. Sets `state.accepted`/`reason` from
 * the aggregated gate results (see the header) and to `false` if the walk
 * stopped short. Throws only what a step throws — exactly as the linear
 * driver does.
 */
export async function walkGraph(run: Run, state: ChainState, graph: ChainGraph, opts: { replay?: EdgeReplay } = {}): Promise<GraphWalk> {
  const index = nodeIndex(graph);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const visits = new Map<string, number>();
  /** Latest result per gating step, in first-run order. */
  const gates = new Map<string, { accepted: boolean; reason: string }>();
  const path: string[] = [];
  let stopped: string | null = null;
  let current: number | null = 0;

  const edgeEvent = (payload: Record<string, unknown>) =>
    run.tracer.event(makeEventRecord({ adw_id: run.adw_id, type: "log", name: CHAIN_EDGE_EVENT, payload }));

  while (current !== null) {
    const node: GraphNode = graph.nodes[current]!;
    if (path.length >= graph.max_steps) {
      stopped = budgetMessage(graph, node.id);
      break;
    }
    const visit = (visits.get(node.id) ?? 0) + 1;
    visits.set(node.id, visit);
    path.push(node.id);

    await node.step(run, state);

    if (node.gate) {
      gates.delete(node.id); // re-insert: a re-run gate's result is its latest
      gates.set(node.id, { accepted: state.accepted, reason: state.reason });
      const failing = [...gates.values()].find((g) => !g.accepted);
      state.accepted = failing === undefined;
      state.reason = failing?.reason ?? "";
    }

    const t = transition(graph, current, visits);
    if (t.kind === "end") break;
    if (t.kind === "stop") {
      stopped = t.reason;
      break;
    }
    if (t.kind === "go") {
      await edgeEvent({ from: node.id, to: t.to, via: t.via, visit });
      current = index.get(t.to)!;
      continue;
    }

    const key = `${node.id}#${visit}`;
    const options: JevOption<string>[] = t.options.map((id) => ({
      value: id,
      description: `run step "${id}" next (${byId.get(id)?.step.label ?? byId.get(id)?.step_name ?? "?"})`,
    }));
    let to = t.fallback;
    let via = "fallback";
    // R3: the set is operator-built (yaml). The loader already guarantees it
    // is well formed; this guard is what keeps a surprise from ever turning
    // into a thrown decide() mid-run.
    if (isValidOptionSet(options, t.fallback, { permitted: t.permitted })) {
      const decision = await run.jev.decide({
        kind: CHAIN_EDGE_KIND.kind,
        key,
        options,
        instructions:
          `The declared chain "${graph.chain}" just finished step "${node.id}". ` +
          `Pick which of its declared next steps should run now, given the request and how the run is going.`,
        state: edgeState(graph, state, node.id, path),
        fallback: t.fallback,
        permitted: t.permitted,
        phase_id: "",
        replay: opts.replay ? await opts.replay(key) : undefined,
      });
      to = decision.choice;
      via = decision.used_fallback ? "fallback" : "jev";
    }
    await edgeEvent({ from: node.id, to, via, visit, key, options: t.options, permitted: t.permitted, fallback: t.fallback });
    current = index.get(to)!;
  }

  if (stopped !== null) {
    state.accepted = false;
    state.reason = stopped;
  }
  await run.tracer.event(
    makeEventRecord({ adw_id: run.adw_id, type: "log", name: CHAIN_PATH_EVENT, payload: { path, steps: path.length, max_steps: graph.max_steps, stopped } }),
  );
  return { path, stopped };
}
