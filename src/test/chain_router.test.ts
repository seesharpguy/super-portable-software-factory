import "./hermetic_git.ts";

/**
 * The Jev chain router for `spf watch` (#107) — three layers, each through
 * its own seam, none touching the network (FakeJevClient) or a real agent:
 *
 *  1. `core/chain_router.ts`'s `routeChain` — the decision itself: menu,
 *     commit filter, shadow/act/fallback, degenerate menus.
 *  2. `core/watch.ts` — that `WatchDeps.routeChain`'s answer reaches
 *     `runChain`/`runAttempt`, the PR body and the issue thread, that a
 *     throwing router never blocks an issue, and that an UNSET router
 *     leaves every call byte-identical.
 *  3. `cli/commands/watch.ts`'s `makeWatchChainRouter` — the REAL call site
 *     the daemon ships, against a real trace db: R8 (no `jev:` block ->
 *     `watch.chain`, zero `jev_decision` rows), trace recording, the
 *     fan-out commit filter over the real chain registry. Plus `spf doctor`
 *     and the config default.
 *
 * A NEW FILE rather than growing `watch.test.ts`/`watch_fanout.test.ts`,
 * which stay unmodified — their passing unchanged is the evidence that an
 * unset `routeChain` is a no-op.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { chainRouteMenu, chainRouteReplay, routeChain, MAX_ROUTED_BODY_CHARS, type RoutableChain } from "../core/chain_router.js";
import { createJev, findRecordedDecision, listRecordedDecisions, parseDecisionExtras, JEV_DECISION_EVENT, type Decision, type DecisionRecorder } from "../core/jev.js";
import { CHAIN_ROUTER_KIND, JEV_DECISION_KINDS } from "../core/jev_kinds.js";
import { FakeJevClient } from "./fake_jev.js";
import type { NotifyEvent } from "../core/notify/channel.js";
import { claimFeedback, claimNewWork, createWatchState, type ChainRunResult, type RefineRunResult, type WatchDeps, type WatchFanoutDeps } from "../core/watch.js";
import type { AttemptDispatch } from "../core/fanout.js";
import type { GitHandle } from "../core/git_helper.js";
import type { CodeHostProvider, EnsureLabelsResult, Issue, IssueComment, IssueProvider, PrComment, PrRef, PrStatus, WatchMarker, WatchState } from "../core/issues/provider.js";
import { makeWatchChainRouter, unknownWatchChains } from "../cli/commands/watch.js";
import { doctorCommand } from "../cli/commands/doctor.js";
import * as agents from "../core/agents.js";
import * as paths from "../core/paths.js";
import { Tracer } from "../core/tracer.js";
import { WatchConfigSchema, type SFConfig } from "../core/data_types.js";

// ── 1. routeChain (core/chain_router.ts) ───────────────────────────────────

const PBT: RoutableChain = { name: "plan-build-test", describe: "the standard chain", phases: "plan -> build -> test -> git(commit)", commits: true };
const PB: RoutableChain = { name: "plan-build", describe: "small work", phases: "plan -> build -> git(commit)", commits: true };
const REVIEW: RoutableChain = { name: "build-review", describe: "review matters most", phases: "build -> review", commits: false };
const ISSUE = { id: "42", title: "Fix a typo in the README", body: "The word 'teh' should be 'the'." };

function recorder(): { rec: DecisionRecorder; seen: Decision[] } {
  const seen: Decision[] = [];
  return { rec: (d) => void seen.push(d), seen };
}

test("chain_router kind is registered, choice-typed, with no static options (the menu is built from watch.chains)", () => {
  assert.equal(CHAIN_ROUTER_KIND.kind, "chain_router");
  assert.equal(JEV_DECISION_KINDS["chain_router"], CHAIN_ROUTER_KIND);
  assert.equal(CHAIN_ROUTER_KIND.question, "choice");
  assert.equal(CHAIN_ROUTER_KIND.options, undefined);
  assert.deepEqual(parseDecisionExtras(undefined, CHAIN_ROUTER_KIND), { replay: true }, "replay defaults on");
  assert.deepEqual(parseDecisionExtras({ decisions: { chain_router: { replay: false } } }, CHAIN_ROUTER_KIND), { replay: false });
  assert.throws(() => parseDecisionExtras({ decisions: { chain_router: { replay: "yes" } } }, CHAIN_ROUTER_KIND), /jev\.decisions\.chain_router: replay/);
});

test("chainRouteMenu: fallback first, allowlist in operator order, de-duplicated; requireCommit drops non-commit chains", () => {
  assert.deepEqual(chainRouteMenu({ fallback: PBT, allowlist: [PB, REVIEW, PBT, PB], requireCommit: false }).map((c) => c.name), ["plan-build-test", "plan-build", "build-review"]);
  assert.deepEqual(chainRouteMenu({ fallback: PBT, allowlist: [PB, REVIEW], requireCommit: true }).map((c) => c.name), ["plan-build-test", "plan-build"]);
});

test("routeChain: jev disabled (no config) -> the configured chain, zero calls, nothing recorded, no note", async () => {
  const fake = FakeJevClient.choosing("plan-build", 0.99);
  const { rec, seen } = recorder();
  const route = await routeChain(createJev({ client: fake, recorder: rec }), { fallback: PBT, allowlist: [PB, REVIEW], requireCommit: false, issue: ISSUE });
  assert.equal(route.chain, "plan-build-test");
  assert.equal(route.decision?.reason, "disabled");
  assert.equal(route.note, null);
  assert.equal(fake.calls.length, 0);
  assert.equal(seen.length, 0);
});

test("routeChain: shadow -> Jev is asked and recorded, but the configured chain acts and NOTHING is announced on the tracker", async () => {
  const fake = FakeJevClient.choosing("plan-build", 0.95);
  const { rec, seen } = recorder();
  const jev = createJev({ config: { enabled: true, mode: "shadow" }, client: fake, recorder: rec });
  const route = await routeChain(jev, { fallback: PBT, allowlist: [PB, REVIEW], requireCommit: false, issue: ISSUE });
  assert.equal(route.chain, "plan-build-test");
  assert.equal(route.decision?.reason, "shadow");
  assert.equal(route.decision?.jev_choice, "plan-build");
  assert.equal(route.decision?.would_act, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.kind, "chain_router");
  assert.equal(seen[0]!.key, "42", "key is the issue id — stable across runs (R1)");
  assert.deepEqual(seen[0]!.options, ["plan-build-test", "plan-build", "build-review"]);
  assert.equal(route.note, null, "shadow is trace + log only: no issue comment, no PR line");
});

test("routeChain: act mode announces a fallback and what Jev suggested", async () => {
  const fake = FakeJevClient.choosing("plan-build", 0.3);
  const jev = createJev({ config: { enabled: true, mode: "act" }, client: fake });
  const route = await routeChain(jev, { fallback: PBT, allowlist: [PB], requireCommit: false, issue: ISSUE });
  assert.match(route.note!, /mode act\): ran the default chain `plan-build-test` \(fallback: low_confidence; Jev suggested `plan-build`\)/);
});

test("routeChain: a replayed decision reuses the recorded answer — zero Jev calls, replayed: true, re-judged under today's policy", async () => {
  const live = createJev({ config: { enabled: true, mode: "act" }, client: FakeJevClient.choosing("plan-build", 0.9) });
  const first = await routeChain(live, { fallback: PBT, allowlist: [PB], requireCommit: false, issue: ISSUE });
  assert.equal(first.chain, "plan-build");

  const fake = FakeJevClient.choosing("plan-build-test", 0.99);
  const { rec, seen } = recorder();
  const input = { fallback: PBT, allowlist: [PB], requireCommit: false, issue: ISSUE };
  const replay = chainRouteReplay(first.decision, input);
  assert.ok(replay);
  const again = await routeChain(createJev({ config: { enabled: true, mode: "act" }, client: fake, recorder: rec }), { ...input, replay });
  assert.equal(again.chain, "plan-build");
  assert.equal(again.decision?.replayed, true);
  assert.equal(fake.calls.length, 0);
  assert.equal(seen.length, 1, "the replay is itself recorded");

  // Today's policy wins: the same recorded answer under shadow does not act.
  const shadow = await routeChain(createJev({ config: { enabled: true, mode: "shadow" }, client: fake }), { ...input, replay });
  assert.equal(shadow.chain, "plan-build-test");
  assert.equal(shadow.decision?.reason, "shadow");
  assert.equal(fake.calls.length, 0);
});

test("chainRouteReplay: only a row where Jev answered THIS menu is reused — failures and changed menus ask Jev live", async () => {
  const input = { fallback: PBT, allowlist: [PB], requireCommit: false, issue: ISSUE };
  const answered = (await routeChain(createJev({ config: { enabled: true, mode: "act" }, client: FakeJevClient.choosing("plan-build", 0.9) }), input)).decision!;
  const failed = (await routeChain(createJev({ config: { enabled: true, mode: "act" }, client: FakeJevClient.failing(new Error("boom")) }), input)).decision!;
  assert.equal(chainRouteReplay(answered, input), answered);
  assert.equal(chainRouteReplay(null, input), undefined);
  assert.equal(chainRouteReplay(failed, input), undefined, "a recorded outage is not pinned onto every re-claim");
  assert.equal(chainRouteReplay(answered, { ...input, allowlist: [PB, REVIEW] }), undefined, "the operator changed watch.chains");
  assert.equal(chainRouteReplay(answered, { ...input, fallback: PB, allowlist: [PBT] }), undefined, "the operator changed watch.chain");
  assert.equal(chainRouteReplay(answered, { ...input, issue: { ...ISSUE, id: "43" } }), undefined, "another issue");
});

test("routeChain: act + confident -> Jev's chain acts; the closed option set and the issue text are what Jev saw", async () => {
  const fake = FakeJevClient.choosing("plan-build", 0.9);
  const jev = createJev({ config: { enabled: true, mode: "act" }, client: fake });
  const route = await routeChain(jev, { fallback: PBT, allowlist: [PB, REVIEW], requireCommit: false, issue: ISSUE });
  assert.equal(route.chain, "plan-build");
  assert.equal(route.decision?.reason, null);
  assert.match(route.note!, /routed to chain `plan-build` instead of the default `plan-build-test` \(confidence 0\.90\)/);
  const question = fake.calls[0]!.questions["q0"]!;
  assert.equal(question.type, "choice");
  assert.deepEqual(Object.keys(question.type === "choice" ? question.criteria : {}), ["plan-build-test", "plan-build", "build-review"]);
  const state = fake.calls[0]!.state as { issue: { title: string; body: string }; default_chain: string; require_commit: boolean };
  assert.equal(state.issue.title, ISSUE.title);
  assert.equal(state.default_chain, "plan-build-test");
  assert.equal(state.require_commit, false);
});

test("routeChain: act fallbacks — low confidence, an out-of-menu answer, a timeout, an error, and no API key all run the configured chain", async () => {
  const cases: Array<{ name: string; client: FakeJevClient | null; env?: NodeJS.ProcessEnv; reason: string; extra?: object }> = [
    { name: "low confidence", client: FakeJevClient.choosing("plan-build", 0.3), reason: "low_confidence" },
    { name: "invented chain", client: FakeJevClient.choosing("rm-rf-everything", 0.99), reason: "invalid_choice" },
    { name: "timeout", client: FakeJevClient.hanging(), reason: "timeout", extra: { timeout_ms: 20 } },
    { name: "error", client: FakeJevClient.failing(new Error("boom")), reason: "error" },
    { name: "no api key", client: null, env: {}, reason: "no_api_key" },
  ];
  for (const c of cases) {
    const { rec, seen } = recorder();
    const jev = createJev({ config: { enabled: true, mode: "act", ...c.extra }, client: c.client, env: c.env ?? {}, recorder: rec });
    const route = await routeChain(jev, { fallback: PBT, allowlist: [PB], requireCommit: false, issue: ISSUE });
    assert.equal(route.chain, "plan-build-test", c.name);
    assert.equal(route.decision?.reason, c.reason, c.name);
    assert.equal(seen.length, 1, `${c.name}: every live decision is recorded, failures included`);
    assert.match(route.note!, new RegExp(`fallback: ${c.reason}`), c.name);
  }
});

test("routeChain: requireCommit (best-of-N) filters non-commit chains BEFORE Jev is asked — a non-commit answer can never act", async () => {
  const fake = FakeJevClient.choosing("build-review", 0.99);
  const jev = createJev({ config: { enabled: true, mode: "act" }, client: fake });
  const route = await routeChain(jev, { fallback: PBT, allowlist: [PB, REVIEW], requireCommit: true, issue: ISSUE });
  assert.equal(route.chain, "plan-build-test");
  assert.equal(route.decision?.reason, "invalid_choice");
  const question = fake.calls[0]!.questions["q0"]!;
  assert.deepEqual(Object.keys(question.type === "choice" ? question.criteria : {}), ["plan-build-test", "plan-build"], "build-review is never on the menu");
  assert.equal((fake.calls[0]!.state as { require_commit: boolean }).require_commit, true);
});

test("routeChain: a degenerate menu skips decide() entirely — no call, no record, the configured chain", async () => {
  const menus: Array<{ name: string; fallback: RoutableChain; allowlist: RoutableChain[]; requireCommit: boolean }> = [
    { name: "allowlist is only the default", fallback: PBT, allowlist: [PBT], requireCommit: false },
    { name: "every alternative filtered out by requireCommit", fallback: PBT, allowlist: [REVIEW], requireCommit: true },
    { name: "the default itself cannot commit under requireCommit", fallback: REVIEW, allowlist: [PB, PBT], requireCommit: true },
  ];
  for (const m of menus) {
    const fake = FakeJevClient.choosing("plan-build", 0.99);
    const { rec, seen } = recorder();
    const route = await routeChain(createJev({ config: { enabled: true, mode: "act" }, client: fake, recorder: rec }), { ...m, issue: ISSUE });
    assert.equal(route.chain, m.fallback.name, m.name);
    assert.equal(route.decision, null, m.name);
    assert.equal(route.note, null, m.name);
    assert.equal(fake.calls.length, 0, m.name);
    assert.equal(seen.length, 0, m.name);
  }
});

test("routeChain: jev.decisions.chain_router.mode: off -> no call, not recorded, no note, even with global mode act", async () => {
  const fake = FakeJevClient.choosing("plan-build", 0.99);
  const { rec, seen } = recorder();
  const jev = createJev({ config: { enabled: true, mode: "act", decisions: { chain_router: { mode: "off" } } }, client: fake, recorder: rec });
  const route = await routeChain(jev, { fallback: PBT, allowlist: [PB], requireCommit: false, issue: ISSUE });
  assert.equal(route.chain, "plan-build-test");
  assert.equal(route.decision?.reason, "kind_off");
  assert.equal(route.note, null);
  assert.equal(fake.calls.length, 0);
  assert.equal(seen.length, 0);
});

test("routeChain: a long issue body is truncated in the state Jev sees", async () => {
  const fake = FakeJevClient.choosing("plan-build", 0.9);
  const jev = createJev({ config: { enabled: true, mode: "act" }, client: fake });
  await routeChain(jev, { fallback: PBT, allowlist: [PB], requireCommit: false, issue: { ...ISSUE, body: "x".repeat(MAX_ROUTED_BODY_CHARS * 3) } });
  const body = (fake.calls[0]!.state as { issue: { body: string } }).issue.body;
  assert.ok(body.length < MAX_ROUTED_BODY_CHARS + 50);
  assert.match(body, /\(truncated\)$/);
});

// ── 2. core/watch.ts: routeChain threading ─────────────────────────────────

const FAKE_STATE_LABELS = new Set((["ready", "working", "review", "done", "blocked", "feedback"] as const).map((s) => `spf:${s}`));

interface FakeEntry {
  issue: Issue;
  state: WatchState;
  marker: WatchMarker | null;
  comments: IssueComment[];
}

class FakeProvider implements IssueProvider {
  entries = new Map<string, FakeEntry>();
  transitions: Array<{ id: string; to: WatchState; detail?: string }> = [];
  addIssue(id: string, title: string, state: WatchState = "ready", marker: WatchMarker | null = null, body = ""): void {
    this.entries.set(id, { issue: { id, title, body, labels: [`spf:${state}`] }, state, marker, comments: [] });
  }
  async ensureLabels(): Promise<EnsureLabelsResult> {
    return { created: [], updated: [], unchanged: [] };
  }
  async listEligible(): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => e.state === "ready").map((e) => e.issue);
  }
  async listInState(state: WatchState): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => e.state === state).map((e) => e.issue);
  }
  private relabel(entry: FakeEntry, to: WatchState): void {
    entry.issue = { ...entry.issue, labels: [...entry.issue.labels.filter((l) => !FAKE_STATE_LABELS.has(l)), `spf:${to}`] };
  }
  async claim(issue: Issue, opts?: { from?: WatchState; to?: WatchState }): Promise<boolean> {
    const entry = this.entries.get(issue.id)!;
    if (entry.state !== (opts?.from ?? "ready")) return false;
    entry.state = opts?.to ?? "working";
    this.relabel(entry, entry.state);
    return true;
  }
  async transition(issue: Issue, to: WatchState, detail?: string): Promise<void> {
    const entry = this.entries.get(issue.id)!;
    entry.state = to;
    this.relabel(entry, to);
    this.transitions.push({ id: issue.id, to, detail });
  }
  async comment(issue: Issue, body: string): Promise<void> {
    this.entries.get(issue.id)!.comments.push({ id: String(Math.random()), author: "spf", created_at: new Date(0).toISOString(), body });
  }
  async readMarker(issue: Issue): Promise<WatchMarker | null> {
    return this.entries.get(issue.id)?.marker ?? null;
  }
  async writeMarker(issue: Issue, marker: WatchMarker): Promise<void> {
    this.entries.get(issue.id)!.marker = marker;
  }
  async listComments(issue: Issue): Promise<IssueComment[]> {
    return this.entries.get(issue.id)?.comments ?? [];
  }
  async getIssue(id: string): Promise<Issue | null> {
    return this.entries.get(id)?.issue ?? null;
  }
}

class FakeCodeHost implements CodeHostProvider {
  prs = new Map<number, PrStatus>();
  openedPrs: Array<{ title: string; branch: string; body: string }> = [];
  nextPrNumber = 1000;
  async openPr(opts: { branch: string; title: string; body: string }): Promise<PrRef> {
    const number = this.nextPrNumber++;
    this.openedPrs.push({ title: opts.title, branch: opts.branch, body: opts.body });
    this.prs.set(number, { merged: false, state: "open", ciStatus: "pending" });
    return { number, branch: opts.branch, url: `https://example.invalid/pr/${number}` };
  }
  async prStatus(pr: PrRef): Promise<PrStatus> {
    return this.prs.get(pr.number) ?? { merged: false, state: "open", ciStatus: "pending" };
  }
  async listPrComments(): Promise<PrComment[]> {
    return [];
  }
}

function fakeGit(overrides: Partial<GitHandle> = {}): GitHandle {
  return {
    currentBranch: () => "main",
    createBranch: (n) => n,
    isRepo: () => true,
    commitAll: () => "abc123",
    changedFiles: () => [],
    refExists: () => true,
    rev: () => "abc123",
    shortSha: () => "abc123",
    mergeBase: () => "abc123",
    isDirty: () => false,
    untrackedFiles: () => [],
    diffFiles: () => ["src/index.ts"],
    diffStat: () => "",
    diffCounts: () => [0, 0],
    diffText: () => "",
    fetch: () => {},
    worktreeAdd: () => {},
    worktreeRemove: () => {},
    deleteLocalBranch: () => {},
    push: () => {},
    ...overrides,
  };
}

type RunChainOpts = Parameters<WatchDeps["runChain"]>[0];

/** `dir` is a per-test tmp dir: worktrees AND `issueLockPath`'s `locks/` (a sibling of `worktreesDir`) both land inside it, never in a shared tmpdir. */
function makeDeps(provider: FakeProvider, codeHost: CodeHostProvider, dir: string, overrides: Partial<WatchDeps> = {}): { deps: WatchDeps; runs: RunChainOpts[]; logs: string[] } {
  const runs: RunChainOpts[] = [];
  const logs: string[] = [];
  const deps: WatchDeps = {
    provider,
    codeHost,
    git: fakeGit(),
    worktreeGit: () => fakeGit(),
    labelPrefix: "spf",
    chain: "plan-build-test",
    baseBranch: "main",
    concurrency: 2,
    chainOptions: {},
    refineEnabled: false,
    refineConcurrency: 1,
    refineChain: "refine",
    runRefine: async (o): Promise<RefineRunResult> => ({ accepted: true, adwId: o.adwId, detail: "", created: [], questions: [], split: [] }),
    worktreesDir: path.join(dir, "worktrees"),
    linkDataDir: () => {},
    dryRun: false,
    runChain: async (opts): Promise<ChainRunResult> => {
      runs.push(opts);
      return { accepted: true, adwId: opts.adwId, detail: "" };
    },
    log: (m) => void logs.push(m),
    notify: () => {},
    ...overrides,
  };
  return { deps, runs, logs };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function withTmp(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-chain-router-test-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("watch: no routeChain (the default) -> runChain gets exactly today's arguments, no chain key, no router comment", async () => {
  await withTmp(async (dir) => {
    const provider = new FakeProvider();
    provider.addIssue("1", "Add a widget");
    const codeHost = new FakeCodeHost();
    const { deps, runs } = makeDeps(provider, codeHost, dir);
    const state = createWatchState();
    await claimNewWork(deps, state);
    await waitUntil(() => state.inflight.size === 0);
    assert.equal(runs.length, 1);
    assert.equal("chain" in runs[0]!, false);
    assert.equal(provider.entries.get("1")!.comments.length, 0);
    assert.match(codeHost.openedPrs[0]!.body, /chain `plan-build-test`/);
    assert.doesNotMatch(codeHost.openedPrs[0]!.body, /Chain router/);
  });
});

test("watch: a routed chain reaches runChain, the PR body names it with the router's note, and the issue gets one comment", async () => {
  await withTmp(async (dir) => {
    const provider = new FakeProvider();
    provider.addIssue("7", "Fix a typo", "ready", null, "teh -> the");
    const codeHost = new FakeCodeHost();
    const calls: Array<{ id: string; adwId: string; requireCommit: boolean }> = [];
    const { deps, runs } = makeDeps(provider, codeHost, dir, {
      routeChain: async (issue, opts) => {
        calls.push({ id: issue.id, ...opts });
        return { chain: "plan-build", note: "_Chain router (Jev, mode act): routed to chain `plan-build`._" };
      },
      chains: ["plan-build"],
    });
    const state = createWatchState();
    await claimNewWork(deps, state);
    await waitUntil(() => state.inflight.size === 0);
    assert.deepEqual(calls, [{ id: "7", adwId: "issue-7", requireCommit: false }]);
    assert.equal(runs[0]!.chain, "plan-build");
    const body = codeHost.openedPrs[0]!.body;
    assert.match(body, /chain `plan-build`, adw_id `issue-7`/);
    assert.match(body, /Chain router \(Jev, mode act\): routed to chain `plan-build`/);
    const comments = provider.entries.get("7")!.comments;
    assert.equal(comments.length, 1);
    assert.match(comments[0]!.body, /built by chain `plan-build`/);
  });
});

test("watch: a router answering the default chain passes no chain key (byte-identical dispatch) but still posts its note", async () => {
  await withTmp(async (dir) => {
    const provider = new FakeProvider();
    provider.addIssue("8", "Something");
    const codeHost = new FakeCodeHost();
    const { deps, runs } = makeDeps(provider, codeHost, dir, {
      routeChain: async () => ({ chain: "plan-build-test", note: "_Chain router (Jev, mode shadow): ran the default chain `plan-build-test` (fallback: shadow)._" }),
    });
    const state = createWatchState();
    await claimNewWork(deps, state);
    await waitUntil(() => state.inflight.size === 0);
    assert.equal("chain" in runs[0]!, false);
    assert.match(codeHost.openedPrs[0]!.body, /fallback: shadow/);
    assert.equal(provider.entries.get("8")!.comments.length, 1);
  });
});

test("watch: a throwing router never blocks the issue — the configured chain runs, and the failure is logged", async () => {
  await withTmp(async (dir) => {
    const provider = new FakeProvider();
    provider.addIssue("9", "Something");
    const codeHost = new FakeCodeHost();
    const { deps, runs, logs } = makeDeps(provider, codeHost, dir, {
      routeChain: async () => {
        throw new Error("router exploded");
      },
    });
    const state = createWatchState();
    await claimNewWork(deps, state);
    await waitUntil(() => state.inflight.size === 0);
    assert.equal(runs.length, 1);
    assert.equal("chain" in runs[0]!, false);
    assert.deepEqual(provider.transitions.map((t) => t.to), ["review"]);
    assert.ok(logs.some((l) => /chain router failed \(router exploded\)/.test(l)));
  });
});

test("watch: a feedback revision never asks the router — with no recorded chain it keeps watch.chain", async () => {
  await withTmp(async (dir) => {
    const provider = new FakeProvider();
    provider.addIssue("10", "Revise me", "feedback", { pr: 55, branch: "spf-watch/10-revise-me", attempt: 0 });
    const codeHost = new FakeCodeHost();
    let routed = 0;
    const { deps, runs } = makeDeps(provider, codeHost, dir, {
      routeChain: async () => {
        routed++;
        return { chain: "plan-build", note: "x" };
      },
    });
    const state = createWatchState();
    await claimFeedback(deps, state);
    await waitUntil(() => runs.length === 1 && state.inflight.size === 0);
    assert.equal(routed, 0);
    assert.equal("chain" in runs[0]!, false);
  });
});

test("watch: a router answering OFF the watch.chains allowlist is refused in core — the default runs, logged, nothing posted", async () => {
  await withTmp(async (dir) => {
    const provider = new FakeProvider();
    provider.addIssue("12", "Something");
    const codeHost = new FakeCodeHost();
    const { deps, runs, logs } = makeDeps(provider, codeHost, dir, {
      routeChain: async () => ({ chain: "rm-rf-everything", note: "_routed somewhere odd_" }),
      chains: ["plan-build"],
    });
    const state = createWatchState();
    await claimNewWork(deps, state);
    await waitUntil(() => state.inflight.size === 0);
    assert.equal(runs.length, 1);
    assert.equal("chain" in runs[0]!, false);
    assert.equal(provider.entries.get("12")!.comments.length, 0);
    assert.doesNotMatch(codeHost.openedPrs[0]!.body, /routed somewhere odd/);
    assert.equal(provider.entries.get("12")!.marker?.chain, undefined);
    assert.ok(logs.some((l) => /chain router answered "rm-rf-everything", not in watch\.chains — running the default chain "plan-build-test"/.test(l)));
  });
});

test("watch: with no chains allowlist at all, a router can only ever run the configured chain", async () => {
  await withTmp(async (dir) => {
    const provider = new FakeProvider();
    provider.addIssue("13", "Something");
    const codeHost = new FakeCodeHost();
    const { deps, runs } = makeDeps(provider, codeHost, dir, { routeChain: async () => ({ chain: "plan-build", note: "x" }) });
    const state = createWatchState();
    await claimNewWork(deps, state);
    await waitUntil(() => state.inflight.size === 0);
    assert.equal("chain" in runs[0]!, false);
  });
});

test("watch: with a router, issue_claimed is sent once routing is done and names the chain that runs; dry-run says routing is on", async () => {
  await withTmp(async (dir) => {
    const provider = new FakeProvider();
    provider.addIssue("14", "Route me");
    const codeHost = new FakeCodeHost();
    const events: NotifyEvent[] = [];
    const { deps } = makeDeps(provider, codeHost, dir, {
      routeChain: async () => ({ chain: "plan-build", note: null }),
      chains: ["plan-build"],
      notify: (e) => void events.push(e),
    });
    const state = createWatchState();
    await claimNewWork(deps, state);
    await waitUntil(() => state.inflight.size === 0);
    const claimed = events.filter((e) => e.kind === "issue_claimed");
    assert.equal(claimed.length, 1);
    assert.deepEqual(claimed[0]!.fields.find(([k]) => k === "chain"), ["chain", "plan-build"]);
    assert.ok(events.findIndex((e) => e.kind === "issue_claimed") < events.findIndex((e) => e.kind === "pr_opened"));

    const dry = new FakeProvider();
    dry.addIssue("15", "Dry");
    const { deps: dryDeps, logs } = makeDeps(dry, codeHost, dir, { dryRun: true, routeChain: async () => ({ chain: "plan-build" }), chains: ["plan-build"] });
    await claimNewWork(dryDeps, createWatchState());
    assert.ok(logs.some((l) => /\[dry-run\] would claim 15 .*run chain "plan-build-test" \(watch\.chains routing enabled: .*\[plan-build\]/.test(l)));
  });
});

test("watch: a feedback revision of a PR built by a ROUTED chain rebuilds with that chain — no router call — and only while it is allowlisted", async () => {
  await withTmp(async (dir) => {
    const codeHost = new FakeCodeHost();
    let routed = 0;
    const router = async (): Promise<{ chain: string }> => {
      routed++;
      return { chain: "plan-build-test" };
    };

    // 1. A plain claim routed to plan-build records it on the marker.
    const provider = new FakeProvider();
    provider.addIssue("16", "Build then revise");
    const first = makeDeps(provider, codeHost, dir, { routeChain: async () => ({ chain: "plan-build", note: null }), chains: ["plan-build"] });
    const state = createWatchState();
    await claimNewWork(first.deps, state);
    await waitUntil(() => state.inflight.size === 0);
    const marker = provider.entries.get("16")!.marker!;
    assert.equal(marker.chain, "plan-build");
    assert.ok(marker.pr);

    // 2. The feedback revision reuses it.
    provider.entries.get("16")!.state = "feedback";
    const second = makeDeps(provider, codeHost, dir, { routeChain: router, chains: ["plan-build"] });
    const s2 = createWatchState();
    await claimFeedback(second.deps, s2);
    await waitUntil(() => second.runs.length === 1 && s2.inflight.size === 0);
    assert.equal(routed, 0);
    assert.equal(second.runs[0]!.chain, "plan-build");
    assert.equal(provider.entries.get("16")!.marker?.chain, "plan-build", "kept for the next revision");

    // 3. Dropped from watch.chains since: the revision runs watch.chain.
    provider.entries.get("16")!.state = "feedback";
    const third = makeDeps(provider, codeHost, dir, { routeChain: router, chains: [] });
    const s3 = createWatchState();
    await claimFeedback(third.deps, s3);
    await waitUntil(() => third.runs.length === 1 && s3.inflight.size === 0);
    assert.equal("chain" in third.runs[0]!, false);
    assert.ok(third.logs.some((l) => /no longer in watch\.chains/.test(l)));
  });
});

test("watch fan-out: the router is asked with requireCommit: true and the base adw_id; every attempt and reviewFor get the routed chain", async () => {
  await withTmp(async (dir) => {
    const provider = new FakeProvider();
    provider.addIssue("11", "Fan me out");
    const codeHost = new FakeCodeHost();
    const attempts: Array<{ dispatch: AttemptDispatch; chain?: string }> = [];
    const reviewChains: Array<string | undefined> = [];
    const calls: Array<{ adwId: string; requireCommit: boolean }> = [];
    const fanout: WatchFanoutDeps = {
      n: 2,
      concurrency: 2,
      repoRoot: "/repo",
      runAttempt: async (dispatch, chain) => {
        attempts.push({ dispatch, chain });
        return 0;
      },
      readMetrics: async () => ({ gate_passes: 1, gate_failures: 0, cost: 0, tokens: 0 }),
      adwIdsFree: async () => true,
      reviewFor: async (o) => {
        reviewChains.push(o.chain);
        return { reviewRequired: false };
      },
    };
    const { deps, logs } = makeDeps(provider, codeHost, dir, {
      // `runBestOf` refuses to reuse an existing attempt branch — only origin refs "exist" here.
      git: fakeGit({ refExists: (ref) => ref.startsWith("origin/") }),
      fanout,
      routeChain: async (_issue, opts) => {
        calls.push(opts);
        return { chain: "plan-build", note: "_routed_" };
      },
      chains: ["plan-build"],
    });
    const state = createWatchState();
    await claimNewWork(deps, state);
    await waitUntil(() => state.inflight.size === 0);
    assert.deepEqual(calls, [{ adwId: "issue-11", requireCommit: true }]);
    assert.equal(attempts.length, 2, logs.join("\n") + JSON.stringify(provider.transitions));
    assert.ok(attempts.every((a) => a.chain === "plan-build"));
    assert.deepEqual(reviewChains, ["plan-build"]);
    assert.match(codeHost.openedPrs[0]!.body, /chain `plan-build`/);
    assert.match(codeHost.openedPrs[0]!.body, /_routed_/);
    assert.equal(provider.entries.get("11")!.marker?.chain, "plan-build", "the winner's marker records the routed chain");
  });
});

// ── 3. cli/commands/watch.ts: makeWatchChainRouter, the REAL call site ────

function loadCfg(dir: string, yaml: string): SFConfig {
  const configPath = path.join(dir, "spf.config.yaml");
  writeFileSync(configPath, yaml);
  return agents.loadConfig([configPath]);
}

function dataPathsFor(dir: string, cfg: SFConfig): paths.DataPaths {
  return paths.resolveDataPaths(paths.resolveAnchor(dir), cfg.defaults.data_dir, cfg.observability.db);
}

async function jevRowCount(dir: string, cfg: SFConfig): Promise<number> {
  const dp = dataPathsFor(dir, cfg);
  const tracer = await Tracer.open(dp.db, path.join(dir, "probe.jsonl"));
  try {
    const row = (await tracer.db.query("SELECT COUNT(*) AS n FROM events WHERE type='log' AND name=?").get(JEV_DECISION_EVENT)) as { n: number };
    return row.n;
  } finally {
    await tracer.close();
  }
}

const ISSUE_42: Issue = { id: "42", title: "Fix a typo in the README", body: "teh -> the", labels: [] };

test("makeWatchChainRouter: no watch.chains -> undefined (no routing code on the daemon's path at all)", async () => {
  await withTmp(async (dir) => {
    const cfg = loadCfg(dir, "watch:\n  repo: acme/widgets\n");
    assert.deepEqual(cfg.watch.chains, []);
    assert.equal(makeWatchChainRouter(cfg, dataPathsFor(dir, cfg), () => {}), undefined);
  });
});

test("makeWatchChainRouter (R8): watch.chains set but NO jev: block -> watch.chain, no note, zero calls, zero jev_decision rows — also end to end through claimNewWork", async () => {
  await withTmp(async (dir) => {
    const cfg = loadCfg(dir, "watch:\n  repo: acme/widgets\n  chain: plan-build-test\n  chains: [plan-build, build-review]\n");
    const fake = FakeJevClient.choosing("plan-build", 0.99);
    const router = makeWatchChainRouter(cfg, dataPathsFor(dir, cfg), () => {}, { client: fake })!;
    assert.ok(router);
    const route = await router(ISSUE_42, { adwId: "issue-42", requireCommit: false });
    assert.deepEqual(route, { chain: "plan-build-test", note: null });
    assert.equal(fake.calls.length, 0);

    const provider = new FakeProvider();
    provider.addIssue("43", "Another");
    const codeHost = new FakeCodeHost();
    const { deps, runs } = makeDeps(provider, codeHost, dir, { routeChain: router });
    const state = createWatchState();
    await claimNewWork(deps, state);
    await waitUntil(() => state.inflight.size === 0);
    assert.equal("chain" in runs[0]!, false, "the heuristic (watch.chain) runs, dispatched exactly as without a router");
    assert.equal(provider.entries.get("43")!.comments.length, 0);
    assert.doesNotMatch(codeHost.openedPrs[0]!.body, /Chain router/);
    assert.equal(fake.calls.length, 0);
    assert.equal(await jevRowCount(dir, cfg), 0);
  });
});

test("makeWatchChainRouter: jev act + a confident fake -> routes, logs the decision, and records ONE jev_decision under the claim's adw_id", async () => {
  await withTmp(async (dir) => {
    const cfg = loadCfg(dir, "watch:\n  repo: acme/widgets\n  chain: plan-build-test\n  chains: [plan-build]\njev:\n  enabled: true\n  mode: act\n");
    const fake = FakeJevClient.choosing("plan-build", 0.9);
    const logs: string[] = [];
    const router = makeWatchChainRouter(cfg, dataPathsFor(dir, cfg), (m) => void logs.push(m), { client: fake })!;
    const route = await router(ISSUE_42, { adwId: "issue-42", requireCommit: false });
    assert.equal(route.chain, "plan-build");
    assert.match(route.note!, /routed to chain `plan-build`/);
    assert.ok(logs.some((l) => /jev chain_router mode=act choice="plan-build"/.test(l)));
    const dp = dataPathsFor(dir, cfg);
    const tracer = await Tracer.open(dp.db, path.join(dir, "probe.jsonl"));
    try {
      const recorded = await findRecordedDecision(tracer.db, "issue-42", "chain_router", "42");
      assert.equal(recorded?.choice, "plan-build");
      assert.deepEqual(recorded?.options, ["plan-build-test", "plan-build"]);
      assert.equal((await listRecordedDecisions(tracer.db, "issue-42")).length, 1);
    } finally {
      await tracer.close();
    }
  });
});

test("makeWatchChainRouter: a re-claim of the same issue replays the recorded decision — zero new Jev calls; replay: false asks again", async () => {
  await withTmp(async (dir) => {
    const cfg = loadCfg(dir, "watch:\n  repo: acme/widgets\n  chain: plan-build-test\n  chains: [plan-build]\njev:\n  enabled: true\n  mode: act\n");
    const dp = dataPathsFor(dir, cfg);
    const first = FakeJevClient.choosing("plan-build", 0.9);
    const r1 = await makeWatchChainRouter(cfg, dp, () => {}, { client: first })!(ISSUE_42, { adwId: "issue-42", requireCommit: false });
    assert.equal(r1.chain, "plan-build");
    assert.equal(first.calls.length, 1);

    // A different answer is waiting, but the re-claim never asks.
    const second = FakeJevClient.choosing("plan-build-test", 0.99);
    const logs: string[] = [];
    const r2 = await makeWatchChainRouter(cfg, dp, (m) => void logs.push(m), { client: second })!(ISSUE_42, { adwId: "issue-42", requireCommit: false });
    assert.equal(r2.chain, "plan-build");
    assert.equal(second.calls.length, 0);
    assert.ok(logs.some((l) => /\(replayed\)/.test(l)));
    const tracer = await Tracer.open(dp.db, path.join(dir, "probe.jsonl"));
    try {
      const rows = await listRecordedDecisions(tracer.db, "issue-42", { kind: "chain_router", key: "42" });
      assert.equal(rows.length, 2);
      assert.equal(rows[1]!.replayed, true);
    } finally {
      await tracer.close();
    }

    const off = loadCfg(dir, "watch:\n  repo: acme/widgets\n  chain: plan-build-test\n  chains: [plan-build]\njev:\n  enabled: true\n  mode: act\n  decisions:\n    chain_router: {replay: false}\n");
    const third = FakeJevClient.choosing("plan-build-test", 0.99);
    const r3 = await makeWatchChainRouter(off, dp, () => {}, { client: third })!(ISSUE_42, { adwId: "issue-42", requireCommit: false });
    assert.equal(third.calls.length, 1);
    assert.equal(r3.chain, "plan-build-test");
  });
});

test("makeWatchChainRouter: act mode with an UNOPENABLE trace db never acts untraced — Jev is asked in shadow and watch.chain runs", async () => {
  await withTmp(async (dir) => {
    const cfg = loadCfg(dir, "watch:\n  repo: acme/widgets\n  chain: plan-build-test\n  chains: [plan-build]\njev:\n  enabled: true\n  mode: act\n");
    // A FILE where the sessions dir should be: the Tracer cannot create <sessions>/<adw_id>/.
    const blocker = path.join(dir, "not-a-dir");
    writeFileSync(blocker, "");
    const dp = { ...dataPathsFor(dir, cfg), sessions_dir: blocker };
    const fake = FakeJevClient.choosing("plan-build", 0.99);
    const logs: string[] = [];
    const route = await makeWatchChainRouter(cfg, dp, (m) => void logs.push(m), { client: fake })!(ISSUE_42, { adwId: "issue-42", requireCommit: false });
    assert.equal(route.chain, "plan-build-test");
    assert.equal(route.note, null);
    assert.equal(fake.calls.length, 1, "still asked, so the log shows what it would have done");
    assert.ok(logs.some((l) => /could not open the trace db .* an unrecorded decision never acts/.test(l)));
    assert.ok(logs.some((l) => /jev chain_router mode=shadow choice="plan-build-test" jev_choice="plan-build".* reason=shadow/.test(l)));

    // Shadow stays shadow, untraced.
    const shadowCfg = loadCfg(dir, "watch:\n  repo: acme/widgets\n  chains: [plan-build]\njev:\n  enabled: true\n");
    const shadowFake = FakeJevClient.choosing("plan-build", 0.99);
    const shadowLogs: string[] = [];
    const s = await makeWatchChainRouter(shadowCfg, dp, (m) => void shadowLogs.push(m), { client: shadowFake })!(ISSUE_42, { adwId: "issue-42", requireCommit: false });
    assert.equal(s.chain, "plan-build-test");
    assert.equal(shadowFake.calls.length, 1);
    assert.ok(shadowLogs.some((l) => /deciding untraced \(shadow\)/.test(l)));
  });
});

test("makeWatchChainRouter: shadow -> recorded, but watch.chain acts", async () => {
  await withTmp(async (dir) => {
    const cfg = loadCfg(dir, "watch:\n  repo: acme/widgets\n  chains: [plan-build]\njev:\n  enabled: true\n");
    const fake = FakeJevClient.choosing("plan-build", 0.9);
    const router = makeWatchChainRouter(cfg, dataPathsFor(dir, cfg), () => {}, { client: fake })!;
    const route = await router(ISSUE_42, { adwId: "issue-42", requireCommit: false });
    assert.equal(route.chain, "plan-build-test");
    assert.equal(fake.calls.length, 1);
    assert.equal(await jevRowCount(dir, cfg), 1);
  });
});

test("makeWatchChainRouter: requireCommit over the REAL registry — build-review (no commit step) is never offered, and choosing it cannot act", async () => {
  await withTmp(async (dir) => {
    const cfg = loadCfg(dir, "watch:\n  repo: acme/widgets\n  chain: plan-build-test\n  chains: [build-review, plan-build]\njev:\n  enabled: true\n  mode: act\n");
    const fake = FakeJevClient.choosing("build-review", 0.99);
    const router = makeWatchChainRouter(cfg, dataPathsFor(dir, cfg), () => {}, { client: fake })!;
    const route = await router(ISSUE_42, { adwId: "issue-42", requireCommit: true });
    assert.equal(route.chain, "plan-build-test");
    const q = fake.calls[0]!.questions["q0"]!;
    assert.deepEqual(Object.keys(q.type === "choice" ? q.criteria : {}), ["plan-build-test", "plan-build"]);
    // The single lane (no commit requirement) does offer it.
    const single = await router(ISSUE_42, { adwId: "issue-42", requireCommit: false });
    assert.equal(single.chain, "build-review");
  });
});

test("makeWatchChainRouter: kind off -> the trace db is never even opened for the decision", async () => {
  await withTmp(async (dir) => {
    const cfg = loadCfg(dir, "watch:\n  repo: acme/widgets\n  chains: [plan-build]\njev:\n  enabled: true\n  mode: act\n  decisions:\n    chain_router: {mode: off}\n");
    const fake = FakeJevClient.choosing("plan-build", 0.99);
    const router = makeWatchChainRouter(cfg, dataPathsFor(dir, cfg), () => {}, { client: fake })!;
    const route = await router(ISSUE_42, { adwId: "issue-42", requireCommit: false });
    assert.deepEqual(route, { chain: "plan-build-test", note: null });
    assert.equal(fake.calls.length, 0);
    assert.equal(await jevRowCount(dir, cfg), 0);
  });
});

test("unknownWatchChains: names every watch.chains entry findChain cannot resolve", async () => {
  await withTmp(async (dir) => {
    const cfg = loadCfg(dir, "watch:\n  chains: [plan-build, no-such-chain, also-missing]\n");
    assert.deepEqual(unknownWatchChains(cfg), ["no-such-chain", "also-missing"]);
  });
});

test("WatchConfigSchema: chains defaults to [] — an existing watch: config is unaffected", () => {
  assert.deepEqual(v.parse(WatchConfigSchema, {}).chains, []);
  assert.deepEqual(v.parse(WatchConfigSchema, { chains: ["plan-build"] }).chains, ["plan-build"]);
});

// ── spf doctor ─────────────────────────────────────────────────────────────

interface DoctorReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string; severity?: "info" | "warn" }>;
}

async function runDoctor(dir: string, yaml: string): Promise<DoctorReport> {
  mkdirSync(path.join(dir, ".spf"), { recursive: true });
  writeFileSync(path.join(dir, ".spf", "spf.config.yaml"), yaml);
  const logs: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  console.error = () => {};
  console.warn = () => {};
  try {
    await doctorCommand(["--cwd", dir, "--json", "--no-probe"]);
  } finally {
    Object.assign(console, original);
  }
  return JSON.parse(logs.join("\n")) as DoctorReport;
}

test("doctor: an unregistered watch.chains entry fails 'watch.chains' and flips report.ok", async () => {
  await withTmp(async (dir) => {
    const report = await runDoctor(dir, "watch:\n  repo: acme/widgets\n  chain: build-review\n  chains: [no-such-chain]\n");
    const c = report.checks.find((x) => x.name === "watch.chains");
    assert.ok(c);
    assert.equal(c!.ok, false);
    assert.match(c!.detail, /no-such-chain/);
    assert.equal(report.ok, false);
  });
});

test("doctor: a valid watch.chains prints the menu (jev off), and under fan-out warns which chains are never offered", async () => {
  await withTmp(async (dir) => {
    const report = await runDoctor(dir, "watch:\n  repo: acme/widgets\n  chain: plan-build\n  chains: [build-review, plan-build]\n  fanout:\n    n: 2\n");
    const c = report.checks.find((x) => x.name === "watch.chains");
    assert.equal(c?.ok, true);
    assert.match(c!.detail, /chain router menu: plan-build, build-review/);
    assert.match(c!.detail, /jev is off/);
    const warn = report.checks.find((x) => x.name === "watch.chains fanout eligibility");
    assert.equal(warn?.severity, "warn");
    assert.match(warn!.detail, /build-review has no commit phase/);
  });
});

test("doctor: no watch.chains -> no watch.chains line at all", async () => {
  await withTmp(async (dir) => {
    const report = await runDoctor(dir, "watch:\n  repo: acme/widgets\n  chain: build-review\n");
    assert.equal(report.checks.some((x) => x.name.startsWith("watch.chains")), false);
  });
});
