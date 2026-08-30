import "./hermetic_git.ts";

/**
 * Real-git integration coverage for `watch.fanout` — modelled directly on
 * `src/test/fanout_sandbox_wiring.test.ts`, but pointed at WATCH's
 * composition (`core/watch.ts`'s `claimNewWork` + `deps.fanout`, built by
 * `cli/commands/watch.ts`'s exported `makeWatchFanoutDispatch`) instead of
 * `fanoutCommand`. Same technique: a fake `ChainDefinition.run` (the same
 * imperative escape hatch `run_sandbox_wiring.test.ts`/
 * `fanout_sandbox_wiring.test.ts` use) so no real agent/LLM is involved,
 * while `withRunWorktree`, `withRunScope`, the lease registry and every git
 * operation are all REAL.
 *
 * `src/core/fanout.ts` is UNMODIFIED — this file proves that
 * `sandbox.fanout: "sandbox"` reaches watch's per-attempt dispatch through
 * the COMPOSED watch+fanout path with NO new sandbox-specific code: the same
 * `withRunScope(dispatch.adwId, ...)` + `ctx.cwd` wiring `cli/commands/
 * watch.ts`'s single-dispatch `runChain` already used is reused verbatim by
 * `makeWatchFanoutDispatch`'s `runAttempt`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as agents from "../core/agents.ts";
import * as paths from "../core/paths.ts";
import { makeGit } from "../core/git_helper.ts";
import { registerRepoChains, findChain, type ChainDefinition } from "../chains/index.ts";
import * as sandbox from "../core/sandbox.ts";
import type { SandboxTransport } from "../core/sandbox.ts";
import type { SandboxSpec } from "../core/data_types.ts";
import { attemptAdwId, attemptBranch, attemptWorktreePath } from "../core/fanout.ts";
import { excludeSpfDataFromGit } from "../core/worktree_data.ts";
import { branchNameFor, claimNewWork, createWatchState, type ChainRunResult, type RefineRunResult, type WatchDeps, type WatchFanoutDeps } from "../core/watch.ts";
import { makeWatchFanoutDispatch } from "../cli/commands/watch.ts";
import type { CodeHostProvider, EnsureLabelsResult, Issue, IssueComment, IssueProvider, PrRef, PrStatus, WatchMarker, WatchState } from "../core/issues/provider.ts";

// ── shared fixtures (see fanout_sandbox_wiring.test.ts for the originals) ──

const NOOP_TRANSPORT: SandboxTransport = {
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  readFileBuffer: async () => new Uint8Array(),
  writeFile: async () => {},
  size: async () => null,
};

function fakeSpec(adwId: string, root: string): SandboxSpec {
  return {
    backend: "opensandbox",
    adw_id: adwId,
    agent: "builder",
    lease_key: `${adwId}/builder`,
    scope: "agent",
    host_root: root,
    workspace_dir: path.join(root, "workspace"),
    handoff_host: path.join(root, "handoff-host"),
    handoff_sandbox: "/spf/handoff",
    scratch_dir: "/spf/tmp",
    env: {},
    image: "debian",
    setup: [],
    egress: { default: "deny", allow: [] },
    lifetime_seconds: 3600,
    max_total_lifetime_seconds: 21600,
    request_timeout_seconds: 960,
    exec_timeout_seconds: 900,
    transport: { max_patch_bytes: 8_388_608, max_seed_bytes: 134_217_728, max_mirror_bytes: 4_194_304, mirror: [] },
    opensandbox: { base_url: "http://127.0.0.1:8090", api_key_env: "OPENSANDBOX_API_KEY", use_server_proxy: false, metadata_prefix: "spf" },
    cloudflare: { bridge_url: "", api_token_env: "CLOUDFLARE_API_TOKEN", sandbox_name: "" },
  };
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function gitOut(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * A real repo with one commit on a branch literally named "main", with an
 * `origin` remote pointing at ITSELF — `spf watch`'s own `runIssueFanout`
 * does an UNGUARDED, fatal `git fetch origin <base>` (deliberately loud —
 * see `git_helper.ts`'s rationale), unlike `spf fanout`'s own
 * `createRunWorktree`, whose fetch failure is non-fatal. A self-referential
 * remote makes that fetch succeed trivially without a second real repo.
 */
function initRepo(dir: string): void {
  git(["init", "-q"], dir);
  git(["checkout", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
  git(["remote", "add", "origin", dir], dir);
  git(["fetch", "-q", "origin"], dir);
}

function writeConfig(dir: string, yaml: string): void {
  mkdirSync(path.join(dir, ".spf"), { recursive: true });
  writeFileSync(path.join(dir, ".spf", "spf.config.yaml"), yaml);
}

/**
 * A fake `ChainDefinition` whose `phases` string satisfies `hasCommitStep`
 * and whose `run()` registers a FAKE lease under the attempt's own derived
 * adw_id and makes a REAL git commit in the attempt's own worktree. If
 * `onRun` is given it runs right before the commit, so a test can advance
 * `origin/main` mid-fan-out or fail a specific attempt.
 */
function makeFakeChain(opts: {
  runsByAdwId: Map<string, number>;
  failIndex?: number;
  onRun?: (adwId: string, index: number, cwd: string) => void;
}): ChainDefinition {
  return {
    name: "fake-watch-fanout-chain",
    describe: "test-only: watch.fanout through sandboxes/real git, no real agent involved",
    phases: "engineer(request) -> builder -> git(commit)",
    requiredAgents: ["builder"],
    requiredSuites: [],
    run: async (ctx) => {
      const adwId = ctx.adw_id!;
      const index = Number(adwId.split("-").pop());
      opts.runsByAdwId.set(adwId, (opts.runsByAdwId.get(adwId) ?? 0) + 1);
      sandbox.registerLease(`${adwId}/builder`, fakeSpec(adwId, ctx.cwd), NOOP_TRANSPORT);
      opts.onRun?.(adwId, index, ctx.cwd);
      if (opts.failIndex !== undefined && index === opts.failIndex) {
        throw new Error(`fake failure for attempt ${index}`);
      }
      writeFileSync(path.join(ctx.cwd, `attempt-${adwId}.txt`), "real work\n");
      git(["add", "-A"], ctx.cwd);
      git(["commit", "-q", "-m", `attempt ${adwId}`], ctx.cwd);
      return 0;
    },
  };
}

// ── a minimal, real-io-only WatchDeps harness (FakeProvider/FakeCodeHost —
// only the tracker/code-host sides are fake; everything else is real) ──────

const FAKE_STATE_LABELS = new Set((["ready", "working", "review", "done", "blocked"] as const).map((s) => `spf:${s}`));

class FakeProvider implements IssueProvider {
  entries = new Map<string, { issue: Issue; state: WatchState; marker: WatchMarker | null }>();
  transitions: Array<{ id: string; to: WatchState; detail?: string }> = [];

  addIssue(id: string, title: string, state: WatchState = "ready", marker: WatchMarker | null = null): void {
    this.entries.set(id, { issue: { id, title, body: "", labels: [`spf:${state}`] }, state, marker });
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
  private relabel(entry: { issue: Issue }, to: WatchState): void {
    entry.issue = { ...entry.issue, labels: [...entry.issue.labels.filter((l) => !FAKE_STATE_LABELS.has(l)), `spf:${to}`] };
  }
  async claim(issue: Issue, opts?: { from?: WatchState; to?: WatchState }): Promise<boolean> {
    const entry = this.entries.get(issue.id)!;
    const from = opts?.from ?? "ready";
    const to = opts?.to ?? "working";
    if (entry.state !== from) return false;
    entry.state = to;
    this.relabel(entry, to);
    return true;
  }
  async transition(issue: Issue, to: WatchState, detail?: string): Promise<void> {
    const entry = this.entries.get(issue.id)!;
    entry.state = to;
    this.relabel(entry, to);
    this.transitions.push({ id: issue.id, to, detail });
  }
  async comment(): Promise<void> {}
  async readMarker(issue: Issue): Promise<WatchMarker | null> {
    return this.entries.get(issue.id)?.marker ?? null;
  }
  async writeMarker(issue: Issue, marker: WatchMarker): Promise<void> {
    this.entries.get(issue.id)!.marker = marker;
  }
  async listComments(): Promise<IssueComment[]> {
    return [];
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
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Rig {
  deps: WatchDeps;
  repoDir: string;
  worktreesDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Builds a REAL `WatchDeps` (real git, real `makeWatchFanoutDispatch`) over
 * a fresh scratch repo. `sandboxYaml`/`chain` let each test vary the one
 * config axis it's testing.
 */
async function rig(opts: { sandboxYaml?: string; chain: ChainDefinition; n: number; concurrency?: number }): Promise<Rig> {
  const repoDir = mkdtempSync(path.join(tmpdir(), "spf-watch-fanout-e2e-"));
  const worktreesDir = mkdtempSync(path.join(tmpdir(), "spf-watch-fanout-e2e-wt-"));
  initRepo(repoDir);
  writeConfig(repoDir, opts.sandboxYaml ?? "# no sandbox block — defaults apply\n");
  registerRepoChains([opts.chain], []);

  const anchor = paths.resolveAnchor(repoDir);
  const configPaths = paths.resolveConfigPaths(anchor).paths;
  const cfg = agents.loadConfig(configPaths);
  const dataPaths = paths.resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db);
  const chainDef = findChain(opts.chain.name)!;

  const fanout: WatchFanoutDeps = {
    n: opts.n,
    concurrency: opts.concurrency ?? opts.n,
    repoRoot: anchor.repo_root,
    ...makeWatchFanoutDispatch(cfg, configPaths, dataPaths, chainDef),
  };

  const deps: WatchDeps = {
    provider: new FakeProvider(),
    codeHost: new FakeCodeHost(),
    git: makeGit(anchor.repo_root),
    worktreeGit: makeGit,
    labelPrefix: "spf",
    chain: chainDef.name,
    baseBranch: "main",
    concurrency: 2,
    chainOptions: cfg.watch.chain_options,
    refineEnabled: false,
    refineConcurrency: 1,
    refineChain: "refine",
    runRefine: async (o): Promise<RefineRunResult> => ({ accepted: true, adwId: o.adwId, detail: "", created: [], questions: [], split: [] }),
    worktreesDir,
    // The REAL closure shape (`cli/commands/watch.ts`'s own `linkDataDir`):
    // symlink `.spf/data` to the main repo's data dir, THEN exclude it from
    // git via `info/exclude` — not a no-op. The §6.6 regression this file
    // guards (a winner's commit staging `.spf/data`) can only be reproduced
    // if the symlink actually exists for `git add -A` to have a chance at
    // staging in the first place; a no-op here made the test below vacuous.
    linkDataDir: (worktreePath: string) => {
      const target = path.join(worktreePath, ".spf", "data");
      if (!existsSync(target)) {
        mkdirSync(path.dirname(target), { recursive: true });
        symlinkSync(dataPaths.data_dir, target, "dir");
      }
      excludeSpfDataFromGit(worktreePath);
    },
    dryRun: false,
    runChain: async (): Promise<ChainRunResult> => {
      throw new Error("runChain must never be called — deps.fanout is set");
    },
    log: () => {},
    notify: () => {},
    fanout,
  };

  return {
    deps,
    repoDir,
    worktreesDir,
    cleanup: async () => {
      registerRepoChains([], []);
      for (let i = 1; i <= opts.n; i++) {
        await sandbox.teardownRun(attemptAdwId("issue-7", i)).catch(() => {});
      }
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(worktreesDir, { recursive: true, force: true });
    },
  };
}

test("watch.fanout: sandbox.fanout: \"sandbox\" reaches per-attempt dispatch — every attempt's own lease (keyed by ITS OWN derived adw_id) is torn down, winner included, and the winner's real commit lands on the RENAMED branch", async () => {
  const runsByAdwId = new Map<string, number>();
  const chain = makeFakeChain({ runsByAdwId });
  const r = await rig({
    sandboxYaml: "sandbox:\n  backend: opensandbox\n  fanout: sandbox\n  image: debian-git\n  opensandbox:\n    base_url: http://127.0.0.1:8090\n",
    chain,
    n: 2,
  });
  const provider = r.deps.provider as FakeProvider;
  provider.addIssue("7", "Add a widget");
  const state = createWatchState();
  try {
    await claimNewWork(r.deps, state);
    await waitUntil(() => state.inflight.size === 0);

    const idA = attemptAdwId("issue-7", 1);
    const idB = attemptAdwId("issue-7", 2);
    assert.deepEqual(new Set(runsByAdwId.keys()), new Set([idA, idB]), "the chain must see each attempt's OWN derived adw_id");

    const codeHost = r.deps.codeHost as FakeCodeHost;
    assert.equal(codeHost.openedPrs.length, 1, "a PR must have been opened for the winner");
    const winnerBranch = codeHost.openedPrs[0]!.branch;
    assert.equal(winnerBranch, branchNameFor(provider.entries.get("7")!.issue), "the pushed branch is the CANONICAL renamed name, not spf/fanout/*");

    // Every lease this run created — for BOTH attempts — is gone.
    assert.equal(sandbox.leases().filter((l) => l.spec.adw_id === idA || l.spec.adw_id === idB).length, 0, "both attempts' leases must be torn down, winner included");

    // The winner's own attempt commit really landed on the renamed branch,
    // proving sandbox dispatch and real git composed correctly end to end.
    const log = gitOut(["log", "--format=%s", winnerBranch], r.repoDir);
    const winnerAdwId = log.includes(`attempt ${idA}`) ? idA : idB;
    assert.ok(log.includes(`attempt ${winnerAdwId}`), `expected the winner branch's log to include its own attempt commit; got:\n${log}`);
  } finally {
    await r.cleanup();
  }
});

test("watch.fanout: the winner's commit does NOT contain .spf/data (§6.6 regression)", async () => {
  const runsByAdwId = new Map<string, number>();
  const chain = makeFakeChain({ runsByAdwId });
  const r = await rig({ chain, n: 2 });
  const provider = r.deps.provider as FakeProvider;
  provider.addIssue("7", "Add a widget");
  const state = createWatchState();
  try {
    await claimNewWork(r.deps, state);
    await waitUntil(() => state.inflight.size === 0);
    const codeHost = r.deps.codeHost as FakeCodeHost;
    const winnerBranch = codeHost.openedPrs[0]!.branch;
    const files = gitOut(["show", "--name-only", "--format=", winnerBranch], r.repoDir).split("\n").filter(Boolean);
    assert.ok(!files.some((f) => f.startsWith(".spf/data")), `.spf/data must never be committed; got: ${files.join(", ")}`);

    // The stronger, more direct check: inside the winner's own worktree
    // (still checked out — cleanup happens on later claims, not this one),
    // `git status --porcelain` must show nothing under `.spf` at all — proof
    // the symlink was excluded via `info/exclude`, not merely that this
    // particular `git add -A` happened not to catch it.
    const winnerAdwId = /adw_id `(issue-7-\d)`/.exec(codeHost.openedPrs[0]!.body)?.[1];
    assert.ok(winnerAdwId, `expected the PR body to name the winner's adw_id; got: ${codeHost.openedPrs[0]!.body}`);
    const winnerAttemptPath = attemptWorktreePath(r.worktreesDir, "issue-7", Number(winnerAdwId!.split("-").pop()));
    const status = gitOut(["status", "--porcelain"], winnerAttemptPath);
    assert.ok(!status.split("\n").some((l) => l.includes(".spf")), `git status --porcelain in the winner's worktree must show nothing under .spf; got:\n${status}`);
  } finally {
    await r.cleanup();
  }
});

test("watch.fanout: a failed attempt's lease is torn down too, and does not win", async () => {
  const runsByAdwId = new Map<string, number>();
  const chain = makeFakeChain({ runsByAdwId, failIndex: 2 });
  const r = await rig({
    sandboxYaml: "sandbox:\n  backend: opensandbox\n  fanout: sandbox\n  image: debian-git\n  opensandbox:\n    base_url: http://127.0.0.1:8090\n",
    chain,
    n: 2,
  });
  const provider = r.deps.provider as FakeProvider;
  provider.addIssue("7", "Add a widget");
  const state = createWatchState();
  try {
    await claimNewWork(r.deps, state);
    await waitUntil(() => state.inflight.size === 0);
    const idA = attemptAdwId("issue-7", 1);
    const idB = attemptAdwId("issue-7", 2);
    const codeHost = r.deps.codeHost as FakeCodeHost;
    assert.equal(codeHost.openedPrs.length, 1, "attempt 1 must still win despite attempt 2 failing");
    assert.equal(sandbox.getLease(`${idB}/builder`), undefined, "the FAILED attempt's lease must still be torn down");
    assert.equal(sandbox.getLease(`${idA}/builder`), undefined, "the winner's lease is torn down too");
  } finally {
    await r.cleanup();
  }
});

test("watch.fanout: losing worktrees/branches are gone from the real repo; the winner survives under its RENAMED name", async () => {
  const runsByAdwId = new Map<string, number>();
  const chain = makeFakeChain({ runsByAdwId });
  const r = await rig({ chain, n: 3 });
  const provider = r.deps.provider as FakeProvider;
  provider.addIssue("7", "Add a widget");
  const state = createWatchState();
  try {
    await claimNewWork(r.deps, state);
    await waitUntil(() => state.inflight.size === 0);

    // Which attempt actually won is NOT hardcoded (all three attempts are
    // metrics-identical here, so `pickBest` breaks the tie on real wall
    // time — genuinely nondeterministic in a live-timing test) — it's read
    // back from the PR body instead. The RENAME (§8.3) only ever changes
    // which BRANCH is checked out at the winner's own fan-out worktree PATH
    // (`createBranch` checks out a new branch in place — it doesn't move
    // the directory), so that one path legitimately survives; only the
    // LOSERS' attempt worktrees are actually gone.
    const codeHost = r.deps.codeHost as FakeCodeHost;
    assert.equal(codeHost.openedPrs.length, 1);
    const winnerAdwId = /adw_id `(issue-7-\d)`/.exec(codeHost.openedPrs[0]!.body)?.[1];
    assert.ok(winnerAdwId, `expected the PR body to name the winner's adw_id; got: ${codeHost.openedPrs[0]!.body}`);
    const winnerIndex = Number(winnerAdwId!.split("-").pop());

    const worktreeList = gitOut(["worktree", "list"], r.repoDir);
    for (let i = 1; i <= 3; i++) {
      if (i === winnerIndex) continue;
      const attemptPath = attemptWorktreePath(r.worktreesDir, "issue-7", i);
      assert.ok(!worktreeList.includes(attemptPath), `loser attempt ${i}'s fan-out worktree must be gone from git worktree list: ${attemptPath}`);
    }
    const winnerPath = attemptWorktreePath(r.worktreesDir, "issue-7", winnerIndex);
    const winnerCheckoutLine = worktreeList.split("\n").find((l) => l.includes(winnerPath));
    assert.ok(winnerCheckoutLine?.includes(`[${branchNameFor(provider.entries.get("7")!.issue)}]`), `expected the winner's own worktree to now be checked out on the CANONICAL branch, not the fan-out one; got:\n${winnerCheckoutLine}`);

    const fanoutBranches = gitOut(["branch", "--list", "spf/fanout/issue-7-*"], r.repoDir);
    assert.equal(fanoutBranches, "", "no spf/fanout/issue-7-* ref may survive — the winner's was renamed, the losers' removed");

    const winnerBranch = codeHost.openedPrs[0]!.branch;
    const canonicalList = gitOut(["branch", "--list", winnerBranch], r.repoDir);
    assert.ok(canonicalList.includes(winnerBranch), "the canonical branch must exist locally");
  } finally {
    await r.cleanup();
  }
});

test("watch.fanout: every attempt branches off the SAME pinned base, and a commit landing on main mid-fan-out is not picked up by a later attempt (§8.8, over real git)", async () => {
  const runsByAdwId = new Map<string, number>();
  let advanced = false;
  const chain = makeFakeChain({
    runsByAdwId,
    // The FIRST attempt to run advances main's tip ON DISK — simulating
    // another PR merging while this fan-out is still in flight. Later
    // attempts (and the eventual `diffFiles` check) must still be pinned to
    // whatever main resolved to when the fan-out STARTED, not to this.
    onRun: (_adwId, _index, cwd) => {
      if (!advanced) {
        advanced = true;
        const repoRootOfWorktree = gitOut(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
        const mainRepoDir = path.dirname(repoRootOfWorktree); // .git's parent
        writeFileSync(path.join(mainRepoDir, "concurrent.txt"), "landed mid-fan-out\n");
        git(["add", "-A"], mainRepoDir);
        git(["commit", "-q", "-m", "a concurrent, unrelated commit landing mid-fan-out"], mainRepoDir);
      }
    },
  });
  const r = await rig({ chain, n: 2, concurrency: 1 }); // serialize so attempt 1 truly finishes (and advances main) before attempt 2 starts
  const provider = r.deps.provider as FakeProvider;
  provider.addIssue("7", "Add a widget");
  const state = createWatchState();
  try {
    const baseBefore = gitOut(["rev-parse", "main"], r.repoDir);

    await claimNewWork(r.deps, state);
    await waitUntil(() => state.inflight.size === 0);

    assert.ok(advanced, "sanity: the mid-fan-out commit must actually have landed");
    const baseAfter = gitOut(["rev-parse", "main"], r.repoDir);
    assert.notEqual(baseBefore, baseAfter, "sanity: main really did move during the fan-out");

    const codeHost = r.deps.codeHost as FakeCodeHost;
    assert.equal(codeHost.openedPrs.length, 1);
    const winnerBranch = codeHost.openedPrs[0]!.branch;
    const winnerLog = gitOut(["log", "--format=%H", winnerBranch], r.repoDir);
    assert.ok(winnerLog.includes(baseBefore), "the winner branch's history must include the ORIGINAL base commit");
    assert.ok(!winnerLog.includes(baseAfter), "the winner branch's history must NOT include the commit that landed mid-fan-out — every attempt was pinned to the original base");
  } finally {
    await r.cleanup();
  }
});

test("watch.fanout: fanout: worktree (default) — no lease registered, the same winner flow runs", async () => {
  const runsByAdwId = new Map<string, number>();
  const chain = makeFakeChain({ runsByAdwId });
  const r = await rig({ chain, n: 2 }); // no sandbox: block — defaults apply
  const provider = r.deps.provider as FakeProvider;
  provider.addIssue("7", "Add a widget");
  const state = createWatchState();
  try {
    await claimNewWork(r.deps, state);
    await waitUntil(() => state.inflight.size === 0);
    const codeHost = r.deps.codeHost as FakeCodeHost;
    assert.equal(codeHost.openedPrs.length, 1);
    const idA = attemptAdwId("issue-7", 1);
    const idB = attemptAdwId("issue-7", 2);
    assert.equal(sandbox.leases().filter((l) => l.spec.adw_id === idA || l.spec.adw_id === idB).length, 0, "no lease was ever registered — the fake chain only registers one under sandbox.fanout: sandbox config, which this test never wrote");
  } finally {
    await r.cleanup();
  }
});

test("watch.fanout: the pre-sweep wedge, over REAL git — a crashed post-rename winner does not permanently block the issue; a pairwise sweep (negative control) reproduces git's own refusal", async () => {
  const runsByAdwId = new Map<string, number>();
  const chain = makeFakeChain({ runsByAdwId });
  const r = await rig({ chain, n: 2 });
  const provider = r.deps.provider as FakeProvider;
  const issue: Issue = { id: "7", title: "Add a widget", body: "", labels: ["spf:ready"] };
  provider.entries.set("7", { issue, state: "ready", marker: { pr: 7 } });

  // Set the repo up as a crashed post-rename winner: a REAL worktree exists,
  // checked out on the CANONICAL branch, but under a fan-out (attempt) path
  // name — exactly what §8.3's rename leaves behind if the daemon dies right
  // after `createBranch` but before the marker/PR settle.
  const canonicalBranch = branchNameFor(issue);
  const staleWorktree = attemptWorktreePath(r.worktreesDir, "issue-7", 2);
  git(["worktree", "add", staleWorktree, "-b", canonicalBranch], r.repoDir);

  const state = createWatchState();
  try {
    await claimNewWork(r.deps, state);
    await waitUntil(() => state.inflight.size === 0);

    assert.deepEqual(provider.transitions.map((t) => t.to), ["review"], "the claim must reach review, not wedge in blocked forever");
    // The winner's fan-out attempt may or may not have reused the exact
    // stale path (`attemptWorktreePath(...,"issue-7",2)`) depending on
    // which attempt won — either way there must be exactly ONE worktree
    // left checked out on the canonical branch (the new winner's, created
    // fresh after the pre-sweep freed the name), never the crashed leftover
    // sitting alongside it.
    const worktreeList = gitOut(["worktree", "list"], r.repoDir);
    const canonicalCheckouts = worktreeList.split("\n").filter((l) => l.includes(`[${canonicalBranch}]`));
    assert.equal(canonicalCheckouts.length, 1, `expected exactly one worktree checked out on ${canonicalBranch}; got:\n${worktreeList}`);
    const branchList = gitOut(["branch", "--list", canonicalBranch], r.repoDir);
    assert.equal(branchList.split("\n").filter(Boolean).length, 1, "the canonical branch must exist exactly once, now owned by the new winner");
  } finally {
    await r.cleanup();
  }
});

test("watch.fanout: NEGATIVE CONTROL — a pairwise (name-by-name) sweep over the SAME crashed-winner setup fails with git's own 'used by worktree' refusal", async () => {
  const repoDir = mkdtempSync(path.join(tmpdir(), "spf-watch-fanout-pairwise-neg-"));
  const worktreesDir = mkdtempSync(path.join(tmpdir(), "spf-watch-fanout-pairwise-neg-wt-"));
  try {
    initRepo(repoDir);
    const issue: Issue = { id: "7", title: "Add a widget", body: "", labels: [] };
    const canonicalBranch = branchNameFor(issue);
    const staleWorktree = attemptWorktreePath(worktreesDir, "issue-7", 2);
    git(["worktree", "add", staleWorktree, "-b", canonicalBranch], repoDir);
    const canonicalWorktree = path.join(worktreesDir, "issue-7");
    const git0 = makeGit(repoDir);

    // Pairwise: the CANONICAL pair (canonicalWorktree, canonicalBranch) is
    // processed as ONE unit — worktreeRemove then deleteLocalBranch — before
    // ever reaching the attempt-name pair that actually holds the branch.
    git0.worktreeRemove(canonicalWorktree); // no-op: never existed
    git0.deleteLocalBranch(canonicalBranch); // REFUSED by real git — silently swallowed
    git0.worktreeRemove(staleWorktree); // only now does the real holder get removed
    git0.deleteLocalBranch(attemptBranch("issue-7", 2)); // a different name — never existed either

    // The branch survives the pairwise sweep that was supposed to clear it.
    const branchList = gitOut(["branch", "--list", canonicalBranch], repoDir);
    assert.ok(branchList.includes(canonicalBranch), "negative control: pairwise ordering must leave the canonical branch alive, proving two-pass is load-bearing, not stylistic");
    // And creating it again — the rename's own operation — fails exactly as
    // it would have wedged the issue. `execFileSync` throws on any non-zero
    // exit regardless of what stderr says, so the throw itself (not its
    // text) is the assertion; the branch's continued existence above is
    // already the direct evidence of git's refusal.
    let rethrown = false;
    try {
      execFileSync("git", ["checkout", "-b", canonicalBranch], { cwd: repoDir, stdio: "pipe" });
    } catch {
      rethrown = true;
    }
    assert.ok(rethrown, "creating the canonical branch again must fail — it still exists, exactly as a pairwise sweep would have left it");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(worktreesDir, { recursive: true, force: true });
  }
});
