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
import { chainRouteMenu, routeChain, MAX_ROUTED_BODY_CHARS, type RoutableChain } from "../core/chain_router.js";
import { createJev, findRecordedDecision, listRecordedDecisions, JEV_DECISION_EVENT, type Decision, type DecisionRecorder } from "../core/jev.js";
import { CHAIN_ROUTER_KIND, JEV_DECISION_KINDS } from "../core/jev_kinds.js";
import { FakeJevClient } from "./fake_jev.js";
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

test("routeChain: shadow -> Jev is asked and recorded, but the configured chain acts; the note says what Jev suggested", async () => {
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
  assert.match(route.note!, /ran the default chain `plan-build-test` \(fallback: shadow; Jev suggested `plan-build`\)/);
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

test("watch: a feedback revision is never routed — it keeps watch.chain", async () => {
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
