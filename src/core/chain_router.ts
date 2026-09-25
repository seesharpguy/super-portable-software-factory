/**
 * Jev chain router for `spf watch` (#107, epic #102; operator docs in
 * `docs/jev.md` under "`chain_router`").
 *
 * WHAT IT DECIDES: which chain builds one claimed issue, chosen from a
 * CLOSED menu the operator declared — `watch.chain` (the default, and the
 * deterministic fallback) plus every name in `watch.chains`. Jev reads the
 * issue's title/body and each chain's `describe`/`phases` text and picks
 * one; code then disposes, under `core/jev.ts`'s policy (shadow by default,
 * threshold, timeout, `enabled: false` = total no-op).
 *
 * WHY IT LIVES HERE AND NOT IN `core/watch.ts`: the watch loop is
 * deliberately chain-agnostic (it never imports `src/chains/` — see its
 * module doc), so it takes a `routeChain` callback exactly like it takes
 * `runChain`. This module is the data half of that callback: it takes
 * chains as plain `RoutableChain` records (name/describe/phases plus a
 * precomputed `commits` flag), so it too stays out of `src/chains/`'s
 * dependency direction and is unit-testable with no registry at all.
 * `cli/commands/watch.ts`'s `makeWatchChainRouter` is the other half: it
 * resolves names via `findChain`, computes `commits` with `hasCommitStep`,
 * builds the `Jev` with a trace recorder, and hands the result to
 * `WatchDeps.routeChain`.
 *
 * SAFETY, in order of what could go wrong:
 *
 *  - Jev never names a chain. The option values are exactly the menu's
 *    chain names, built here from operator config; an out-of-set answer is
 *    `invalid_choice` inside `decide()` and the default acts.
 *  - Best-of-N eligibility is enforced IN CODE, before Jev is asked:
 *    `requireCommit: true` (the watch fan-out lane) drops every chain with
 *    no commit step from the menu, so a non-commit chain can never be the
 *    answer where one is required — not even on a replay. `watch.chain`
 *    itself is already required to commit when `watch.fanout.n > 1`
 *    (`spf watch`'s startup refusal), so the fallback always survives the
 *    filter; if it somehow does not, the menu is degenerate and the router
 *    returns the default without asking.
 *  - A degenerate menu (fewer than two distinct chains after filtering, or
 *    anything `isValidOptionSet` rejects) skips `decide()` entirely — no
 *    call, no trace row — rather than letting operator data throw (R3).
 *  - Routing only ever picks WHICH chain runs. Every chain's own gates run
 *    unchanged inside it; nothing here approves, skips, or removes a gate,
 *    raises a retry ceiling, or changes a budget (invariant 6).
 */
import { isValidOptionSet, type Decision, type Jev, type JevOption } from "./jev.ts";
import { CHAIN_ROUTER_KIND } from "./jev_kinds.ts";

/** One chain as the router sees it — plain data, no `src/chains/` import. */
export interface RoutableChain {
  name: string;
  /** `ChainDefinition.describe` — the one line `spf list` prints. */
  describe: string;
  /** `ChainDefinition.phases` — the derived step string (`plan -> build -> git(commit) ...`). */
  phases: string;
  /** `hasCommitStep(phases)`, computed by the caller (it owns the chain registry). */
  commits: boolean;
}

/** The issue text Jev reads. Only its sha256 reaches the trace (see `Decision.input_sha256`). */
export interface RoutableIssue {
  id: string;
  title: string;
  body: string;
}

export interface ChainRouteInput {
  /** `watch.chain` — the deterministic fallback, always on the menu. */
  fallback: RoutableChain;
  /** `watch.chains`, resolved, in operator order. Duplicates and the fallback's own name are dropped. */
  allowlist: readonly RoutableChain[];
  /** True in the best-of-N lane (`watch.fanout.n > 1`): only commit chains are offered. */
  requireCommit: boolean;
  issue: RoutableIssue;
}

export interface ChainRoute {
  /** The chain to run — ALWAYS a menu member (the fallback when nothing else acted). */
  chain: string;
  /** The recorded decision, or `null` when `decide()` was skipped (degenerate menu). */
  decision: Decision<string> | null;
  /**
   * One markdown line for the issue comment / PR body, or `null` when
   * nothing worth telling a human happened — Jev disabled or the kind
   * `off`, or a skipped (degenerate) menu. `null` is what keeps a
   * `jev:`-less daemon's tracker output byte-identical.
   */
  note: string | null;
}

/**
 * Longest issue body sent as state. Jev's documented budget is ~32k tokens
 * for state + questions together; a Jira description can be arbitrarily
 * long, and the first few thousand characters are what say what kind of
 * work this is. Same cap `openPrForWinner` puts on the PR body's copy.
 */
export const MAX_ROUTED_BODY_CHARS = 4000;

const INSTRUCTIONS =
  "You route a software issue to the spf chain (a fixed, multi-step agent workflow) best suited to build it. " +
  "Each option is a chain: its description says what kind of work it is for, and its phases list the steps it runs. " +
  "Read the issue's title and body in state.issue. Prefer state.default_chain unless the issue clearly calls for a " +
  "different workflow (for example a docs-only change, a pure investigation, or a change large enough to need planning and tests).";

/**
 * The closed menu, in a stable order: the fallback first, then the
 * allowlist in operator order, de-duplicated by name. With `requireCommit`,
 * every chain without a commit step is dropped — the fallback included, in
 * which case the caller sees a menu without its fallback and must not ask
 * (`routeChain` handles that as degenerate).
 */
export function chainRouteMenu(input: Pick<ChainRouteInput, "fallback" | "allowlist" | "requireCommit">): RoutableChain[] {
  const seen = new Set<string>();
  const out: RoutableChain[] = [];
  for (const chain of [input.fallback, ...input.allowlist]) {
    if (seen.has(chain.name)) continue;
    seen.add(chain.name);
    if (input.requireCommit && !chain.commits) continue;
    out.push(chain);
  }
  return out;
}

/** Menu -> `decide()` options. The description is what Jev reads; only the VALUE is ever recorded or acted on. */
export function chainRouteOptions(menu: readonly RoutableChain[]): JevOption<string>[] {
  return menu.map((chain) => ({ value: chain.name, description: `${chain.describe} (phases: ${chain.phases})` }));
}

function routeNote(decision: Decision<string>, fallback: string): string | null {
  if (decision.reason === "disabled" || decision.reason === "kind_off") return null;
  const conf = decision.confidence === null ? "n/a" : decision.confidence.toFixed(2);
  if (!decision.used_fallback) {
    return decision.choice === fallback
      ? `_Chain router (Jev, mode ${decision.mode}): kept the default chain \`${fallback}\` (confidence ${conf})._`
      : `_Chain router (Jev, mode ${decision.mode}): routed to chain \`${decision.choice}\` instead of the default \`${fallback}\` (confidence ${conf})._`;
  }
  const suggested = decision.jev_choice && decision.jev_choice !== fallback ? `; Jev suggested \`${decision.jev_choice}\`` : "";
  return `_Chain router (Jev, mode ${decision.mode}): ran the default chain \`${fallback}\` (fallback: ${decision.reason}${suggested})._`;
}

/**
 * Pick the chain for one claimed issue. Never throws for anything Jev or
 * the operator's menu can do — the worst case is the fallback. The
 * heuristic (the configured default) is computed first, on every call,
 * act mode included (R2).
 *
 * `key` is the issue id — stable across daemon restarts and re-claims (R1)
 * — and `phase_id` is `""`: the decision precedes the chain run, so there
 * is no phase yet.
 */
export async function routeChain(jev: Jev, input: ChainRouteInput): Promise<ChainRoute> {
  const fallback = input.fallback.name;
  const menu = chainRouteMenu(input);
  const options = chainRouteOptions(menu);
  // R3: operator-built set — check it before `decide()` so bad data degrades
  // to the default instead of throwing. Fewer than two chains is not a
  // choice worth a network call (or a trace row).
  if (menu.length < 2 || !isValidOptionSet(options, fallback)) {
    return { chain: fallback, decision: null, note: null };
  }
  const body = input.issue.body.trim();
  const decision = await jev.decide<string>({
    kind: CHAIN_ROUTER_KIND.kind,
    key: input.issue.id,
    options,
    instructions: INSTRUCTIONS,
    state: {
      issue: {
        id: input.issue.id,
        title: input.issue.title,
        body: body.length > MAX_ROUTED_BODY_CHARS ? `${body.slice(0, MAX_ROUTED_BODY_CHARS)}\n\n(truncated)` : body,
      },
      default_chain: fallback,
      require_commit: input.requireCommit,
    },
    fallback,
  });
  // Belt and braces: `decide()` only ever returns a member of `options`, but
  // the one property this whole module exists to guarantee is checked here
  // too, in plain code, rather than trusted.
  const chain = menu.some((c) => c.name === decision.choice) ? decision.choice : fallback;
  return { chain, decision, note: routeNote(decision, fallback) };
}
