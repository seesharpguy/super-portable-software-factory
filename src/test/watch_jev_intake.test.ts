/**
 * Jev watch intake (#108): the `intake_feedback` classifier (inside
 * `claimFeedback` -> `runIssueSingle`) and the `intake_readiness` router
 * (inside `claimNewWork`), both driven through their REAL call sites in
 * `core/watch.ts` with a `FakeJevClient` — never the network. The provider,
 * code host and git fakes are deliberately small local copies rather than
 * imports from `watch.test.ts` (which exports none, and stays unmodified).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimFeedback, claimNewWork, createWatchState, type ChainRunResult, type RefineRunResult, type WatchDeps } from "../core/watch.js";
import type { CodeHostProvider, Issue, IssueComment, IssueProvider, PrComment, PrRef, PrStatus, WatchMarker, WatchState } from "../core/issues/provider.js";
import type { GitHandle } from "../core/git_helper.js";
import { createJev, listRecordedDecisions, normalizeJevConfig, setJevClientFactory, traceDecisionRecorder, type Decision, type Jev } from "../core/jev.js";
import type { JevConfig } from "../core/data_types.js";
import { loadConfig } from "../core/agents.js";
import { Tracer } from "../core/tracer.js";
import { JEV_DECISION_KINDS } from "../core/jev_kinds.js";
import { openWatchIntakeJev } from "../cli/commands/watch.js";
import { FakeJevClient } from "./fake_jev.js";

// ── fakes ───────────────────────────────────────────────────────────────────

interface Entry {
  issue: Issue;
  state: WatchState;
  marker: WatchMarker | null;
  comments: IssueComment[];
}

class Provider implements IssueProvider {
  entries = new Map<string, Entry>();
  transitions: Array<{ id: string; to: WatchState; detail?: string }> = [];
  claimCalls: string[] = [];
  markerReads = 0;
  add(id: string, state: WatchState, marker: WatchMarker | null = null, body = "Do the thing. Acceptance: it works."): void {
    this.entries.set(id, { issue: { id, title: `Issue ${id}`, body, labels: [`spf:${state}`] }, state, marker, comments: [] });
  }
  async ensureLabels() {
    return { created: [], updated: [], unchanged: [] };
  }
  async listEligible(): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => e.state === "ready").map((e) => e.issue);
  }
  async listInState(state: WatchState): Promise<Issue[]> {
    return [...this.entries.values()].filter((e) => e.state === state).map((e) => e.issue);
  }
  async getIssue(id: string): Promise<Issue | null> {
    return this.entries.get(id)?.issue ?? null;
  }
  async claim(issue: Issue, opts?: { from?: WatchState; to?: WatchState }): Promise<boolean> {
    this.claimCalls.push(issue.id);
    const e = this.entries.get(issue.id)!;
    if (e.state !== (opts?.from ?? "ready")) return false;
    e.state = opts?.to ?? "working";
    return true;
  }
  async transition(issue: Issue, to: WatchState, detail?: string): Promise<void> {
    const e = this.entries.get(issue.id)!;
    e.state = to;
    this.transitions.push({ id: issue.id, to, detail });
    if (detail) e.comments.push({ id: String(e.comments.length + 1), author: "spf", created_at: new Date().toISOString(), body: detail });
  }
  async comment(issue: Issue, body: string): Promise<void> {
    const e = this.entries.get(issue.id)!;
    e.comments.push({ id: String(e.comments.length + 1), author: "spf", created_at: new Date().toISOString(), body });
  }
  async readMarker(issue: Issue): Promise<WatchMarker | null> {
    this.markerReads++;
    return this.entries.get(issue.id)?.marker ?? null;
  }
  async writeMarker(issue: Issue, marker: WatchMarker): Promise<void> {
    this.entries.get(issue.id)!.marker = marker;
  }
  async listComments(issue: Issue): Promise<IssueComment[]> {
    return this.entries.get(issue.id)?.comments ?? [];
  }
}

class CodeHost implements CodeHostProvider {
  prs = new Map<number, PrStatus>();
  prComments = new Map<number, PrComment[]>();
  openedPrs: string[] = [];
  async openPr(opts: { branch: string }): Promise<PrRef> {
    this.openedPrs.push(opts.branch);
    return { number: 1000 + this.openedPrs.length, branch: opts.branch, url: "https://example.invalid/pr" };
  }
  async prStatus(pr: PrRef): Promise<PrStatus> {
    return this.prs.get(pr.number) ?? { merged: false, state: "open", ciStatus: "pending" };
  }
  async listPrComments(pr: PrRef): Promise<PrComment[]> {
    return this.prComments.get(pr.number) ?? [];
  }
}

function git(): GitHandle {
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
  };
}

interface Harness {
  provider: Provider;
  codeHost: CodeHost;
  deps: WatchDeps;
  chainRuns: string[];
  logs: string[];
}

function harness(overrides: Partial<WatchDeps> = {}): Harness {
  const provider = new Provider();
  const codeHost = new CodeHost();
  const chainRuns: string[] = [];
  const logs: string[] = [];
  const deps: WatchDeps = {
    provider,
    codeHost,
    git: git(),
    worktreeGit: () => git(),
    labelPrefix: "spf",
    chain: "plan-build-test",
    baseBranch: "main",
    concurrency: 2,
    chainOptions: {},
    refineEnabled: false,
    refineConcurrency: 1,
    refineChain: "refine",
    runRefine: async (opts): Promise<RefineRunResult> => ({ accepted: true, adwId: opts.adwId, detail: "", created: [], questions: [], split: [] }),
    worktreesDir: join(tmpdir(), "spf-watch-jev-intake-worktrees"),
    linkDataDir: () => {},
    dryRun: false,
    runChain: async (opts): Promise<ChainRunResult> => {
      chainRuns.push(opts.adwId);
      return { accepted: true, adwId: opts.adwId, detail: "" };
    },
    log: (m) => logs.push(m),
    notify: () => {},
    ...overrides,
  };
  return { provider, codeHost, deps, chainRuns, logs };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** `deps.intakeJev` over a fake client and an in-memory recorder — the recorder sees exactly what the CLI's trace recorder would. */
function fakeIntake(config: Partial<JevConfig>, client: FakeJevClient): { intakeJev: (adwId: string) => Jev; recorded: Array<{ adwId: string; d: Decision }> } {
  const recorded: Array<{ adwId: string; d: Decision }> = [];
  const base = createJev({ config, client, env: {} });
  return { recorded, intakeJev: (adwId) => base.withRecorder((d) => void recorded.push({ adwId, d })) };
}

const ON_ACT: Partial<JevConfig> = { enabled: true, mode: "act" };
const ON_SHADOW: Partial<JevConfig> = { enabled: true, mode: "shadow" };

function prComment(id: string, body: string, created_at = "2020-01-02T00:00:00.000Z"): PrComment {
  return { id, author: "alice", created_at, body };
}

/** One `feedback` issue with an open (or closed) PR #900 and one new PR comment. */
function feedbackIssue(h: Harness, prState: "open" | "closed" = "open", marker: WatchMarker = { pr: 900, branch: "spf-watch/70-issue-70", attempt: 0 }): void {
  h.provider.add("70", "feedback", marker);
  h.codeHost.prs.set(900, { merged: false, state: prState, ciStatus: "pending" });
  h.codeHost.prComments.set(900, [prComment("c1", "Why did you pick sqlite here?")]);
}

async function runFeedback(h: Harness): Promise<void> {
  const state = createWatchState();
  await claimFeedback(h.deps, state);
  await waitUntil(() => state.inflight.size === 0);
}

async function runReady(h: Harness): Promise<void> {
  const state = createWatchState();
  await claimNewWork(h.deps, state);
  await waitUntil(() => state.inflight.size === 0);
}

// ── registry ────────────────────────────────────────────────────────────────

test("intake kinds: both are registered, choice-shaped, with the documented closed option sets", () => {
  assert.deepEqual(JEV_DECISION_KINDS["intake_feedback"]?.options, ["revise", "question", "approve", "out_of_scope"]);
  assert.deepEqual(JEV_DECISION_KINDS["intake_readiness"]?.options, ["build", "refine", "needs_human"]);
  assert.equal(JEV_DECISION_KINDS["intake_feedback"]?.question, "choice");
  assert.equal(JEV_DECISION_KINDS["intake_readiness"]?.question, "choice");
});

// ── R8: no `jev:` block, through the real call sites ────────────────────────

test("intake R8: with NO jev: block, feedback revises, ready builds, zero Jev calls, zero jev_decision rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-watch-jev-intake-"));
  const fake = FakeJevClient.choosing("approve", 0.99);
  setJevClientFactory(() => fake);
  try {
    const configPath = join(dir, "spf.config.yaml");
    writeFileSync(configPath, "watch:\n  repo: acme/widgets\n");
    const cfg = loadConfig([configPath]);
    const dataPaths = { data_dir: join(dir, "data"), db: { kind: "sqlite" as const, path: join(dir, "trace.db") } };
    // The CLI's own wiring: nothing opened, no intakeJev at all.
    assert.equal(await openWatchIntakeJev(cfg.jev, dataPaths), undefined);

    // Belt and braces: even a daemon handed a Jev built from that same
    // (disabled) config, recording into a real trace db, changes nothing.
    const tracer = await Tracer.open(dataPaths.db, join(dir, "events.jsonl"));
    try {
      const intakeJev = (adwId: string) => createJev({ config: cfg.jev, recorder: traceDecisionRecorder(tracer, adwId) });
      for (const deps of [{}, { intakeJev }] as Array<Partial<WatchDeps>>) {
        const h = harness(deps);
        feedbackIssue(h);
        h.provider.add("71", "ready");
        await runFeedback(h);
        await runReady(h);
        assert.deepEqual(h.chainRuns.sort(), ["issue-70", "issue-71"], "the revision ran and the ready issue was built — today's behavior");
        assert.equal(h.provider.entries.get("70")!.state, "review");
        assert.equal(h.provider.entries.get("71")!.state, "review");
      }
      assert.equal(fake.calls.length, 0);
      assert.equal((await listRecordedDecisions(tracer.db, "issue-70")).length, 0);
      assert.equal((await listRecordedDecisions(tracer.db, "issue-71")).length, 0);
      const rows = (await tracer.db.query("SELECT COUNT(*) AS n FROM events WHERE name='jev_decision'").get()) as { n: number };
      assert.equal(rows.n, 0);
    } finally {
      await tracer.close();
    }
  } finally {
    setJevClientFactory(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── openWatchIntakeJev (the CLI wiring) ─────────────────────────────────────

test("openWatchIntakeJev: off when disabled or when both intake kinds are off; on, it records into the trace db under the issue's adw_id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spf-watch-jev-intake-"));
  const fake = FakeJevClient.choosing("question", 0.95);
  setJevClientFactory(() => fake);
  try {
    const dataPaths = { data_dir: join(dir, "data"), db: { kind: "sqlite" as const, path: join(dir, "trace.db") } };
    assert.equal(await openWatchIntakeJev(normalizeJevConfig({ enabled: false, mode: "act" }), dataPaths), undefined);
    const bothOff = normalizeJevConfig({ enabled: true, decisions: { intake_feedback: { mode: "off" }, intake_readiness: { mode: "off" } } });
    assert.equal(await openWatchIntakeJev(bothOff, dataPaths), undefined);

    const intake = await openWatchIntakeJev(normalizeJevConfig({ enabled: true, mode: "act", decisions: { intake_readiness: { mode: "off" } } }), dataPaths);
    assert.ok(intake);
    try {
      const h = harness({ intakeJev: intake.intakeJev });
      feedbackIssue(h);
      await runFeedback(h);
      assert.deepEqual(h.chainRuns, [], "question — no revision run");
      const tracer = await Tracer.open(dataPaths.db, join(dir, "read.jsonl"));
      try {
        const rows = await listRecordedDecisions(tracer.db, "issue-70", { kind: "intake_feedback" });
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.choice, "question");
        assert.equal(rows[0]!.key, "pr900:r1:c1");
      } finally {
        await tracer.close();
      }
    } finally {
      await intake.close();
    }
  } finally {
    setJevClientFactory(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── intake_feedback ─────────────────────────────────────────────────────────

test("intake_feedback act: question -> acknowledgement comment, no revision run, back to review; PR and marker untouched", async () => {
  const fake = FakeJevClient.choosing("question", 0.95);
  const { intakeJev, recorded } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeJev });
  feedbackIssue(h);
  await runFeedback(h);
  assert.deepEqual(h.chainRuns, []);
  assert.equal(h.codeHost.openedPrs.length, 0);
  const entry = h.provider.entries.get("70")!;
  assert.equal(entry.state, "review");
  assert.match(entry.comments.at(-1)!.body, /as a question rather than a requested change/);
  assert.match(entry.comments.at(-1)!.body, /`spf:feedback` again/);
  assert.deepEqual(entry.marker, { pr: 900, branch: "spf-watch/70-issue-70", attempt: 0 }, "marker unchanged");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.adwId, "issue-70");
  assert.equal(recorded[0]!.d.kind, "intake_feedback");
  assert.equal(recorded[0]!.d.reason, null, "Jev's answer acted");
  // The closed option set Jev was offered, verbatim.
  const q = fake.calls[0]!.questions["q0"]!;
  assert.equal(q.type, "choice");
  assert.deepEqual(Object.keys((q as { criteria: Record<string, string> }).criteria), ["revise", "question", "approve", "out_of_scope"]);
});

test("intake_feedback act: approve / out_of_scope are logged only — no comment, no run; a closed PR goes back to blocked", async () => {
  for (const [choice, prState, back] of [
    ["approve", "open", "review"],
    ["out_of_scope", "open", "review"],
    ["approve", "closed", "blocked"],
  ] as const) {
    const { intakeJev } = fakeIntake(ON_ACT, FakeJevClient.choosing(choice, 0.95));
    const h = harness({ intakeJev });
    feedbackIssue(h, prState);
    await runFeedback(h);
    assert.deepEqual(h.chainRuns, [], choice);
    assert.equal(h.codeHost.openedPrs.length, 0);
    const entry = h.provider.entries.get("70")!;
    assert.equal(entry.state, back);
    assert.equal(entry.comments.length, 0, "logged, not commented");
    assert.equal(h.provider.transitions.at(-1)!.detail, undefined);
    assert.ok(h.logs.some((l) => l.includes(`classified ${choice}`)), h.logs.join("\n"));
  }
});

test("intake_feedback act: revise runs the revision exactly as today", async () => {
  const { intakeJev, recorded } = fakeIntake(ON_ACT, FakeJevClient.choosing("revise", 0.95));
  const h = harness({ intakeJev });
  feedbackIssue(h);
  await runFeedback(h);
  assert.deepEqual(h.chainRuns, ["issue-70"]);
  assert.equal(h.provider.entries.get("70")!.state, "review");
  assert.equal(h.provider.entries.get("70")!.marker?.revision?.rounds, 1);
  assert.equal(recorded[0]!.d.choice, "revise");
});

test("intake_feedback shadow: Jev is asked and recorded, but the fallback (revise) acts", async () => {
  const fake = FakeJevClient.choosing("approve", 0.99);
  const { intakeJev, recorded } = fakeIntake(ON_SHADOW, fake);
  const h = harness({ intakeJev });
  feedbackIssue(h);
  await runFeedback(h);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(h.chainRuns, ["issue-70"], "revision ran");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.d.reason, "shadow");
  assert.equal(recorded[0]!.d.jev_choice, "approve");
  assert.equal(recorded[0]!.d.choice, "revise");
});

test("intake_feedback fallbacks: low confidence, error, timeout, no API key, kind off — all revise", async () => {
  const cases: Array<{ name: string; client: FakeJevClient | null; config: Partial<JevConfig>; reason: string | null }> = [
    { name: "low_confidence", client: FakeJevClient.choosing("approve", 0.3), config: ON_ACT, reason: "low_confidence" },
    { name: "error", client: FakeJevClient.failing(new Error("boom")), config: ON_ACT, reason: "error" },
    { name: "timeout", client: FakeJevClient.hanging(), config: { ...ON_ACT, timeout_ms: 20 }, reason: "timeout" },
    { name: "no_api_key", client: null, config: ON_ACT, reason: "no_api_key" },
    { name: "kind_off", client: FakeJevClient.choosing("approve", 0.99), config: { ...ON_ACT, decisions: { intake_feedback: { mode: "off" } } }, reason: null },
  ];
  for (const c of cases) {
    const recorded: Decision[] = [];
    const base = createJev({ config: c.config, client: c.client ?? undefined, env: {} });
    const h = harness({ intakeJev: () => base.withRecorder((d) => void recorded.push(d)) });
    feedbackIssue(h);
    await runFeedback(h);
    assert.deepEqual(h.chainRuns, ["issue-70"], `${c.name}: revision ran`);
    if (c.reason === null) {
      assert.equal(recorded.length, 0, `${c.name}: kind off is never recorded`);
    } else {
      assert.equal(recorded.length, 1, c.name);
      assert.equal(recorded[0]!.reason, c.reason, c.name);
      assert.equal(recorded[0]!.choice, "revise", c.name);
    }
  }
});

test("intake_feedback: no comments since the last push -> nothing to classify, no Jev call, revise", async () => {
  const fake = FakeJevClient.choosing("approve", 0.99);
  const { intakeJev, recorded } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeJev });
  feedbackIssue(h, "open", { pr: 900, branch: "spf-watch/70-issue-70", attempt: 0, revision: { rounds: 1, since: "2030-01-01T00:00:00.000Z" } });
  await runFeedback(h);
  assert.equal(fake.calls.length, 0);
  assert.equal(recorded.length, 0);
  assert.deepEqual(h.chainRuns, ["issue-70"]);
});

test("intake_feedback: only comments since the watermark reach Jev, and the key names the PR, round and last comment", async () => {
  const fake = FakeJevClient.choosing("revise", 0.95);
  const { intakeJev, recorded } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeJev });
  feedbackIssue(h, "open", { pr: 900, branch: "spf-watch/70-issue-70", attempt: 0, revision: { rounds: 2, since: "2020-06-01T00:00:00.000Z" } });
  h.codeHost.prComments.set(900, [prComment("old", "stale discussion", "2020-01-01T00:00:00.000Z"), prComment("new", "rename the flag", "2020-07-01T00:00:00.000Z")]);
  await runFeedback(h);
  const state = fake.calls[0]!.state as { comments: Array<{ body: string }>; round: number };
  assert.deepEqual(state.comments.map((c) => c.body), ["rename the flag"]);
  assert.equal(state.round, 3);
  assert.equal(recorded[0]!.d.key, "pr900:r3:new");
});

// ── intake_readiness ────────────────────────────────────────────────────────

test("intake_readiness act: needs_human -> blocked with a needs-info comment + marker, never claimed, no chain, no budget spent", async () => {
  const fake = FakeJevClient.choosing("needs_human", 0.95);
  const { intakeJev, recorded } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeJev, concurrency: 1 });
  h.provider.add("80", "ready");
  h.provider.add("81", "ready");
  await runReady(h);
  for (const id of ["80", "81"]) {
    const entry = h.provider.entries.get(id)!;
    assert.equal(entry.state, "blocked", id);
    assert.match(entry.comments.at(-1)!.body, /needs more information from a human/);
    assert.equal(entry.marker?.intake?.routed, "needs_human");
  }
  assert.deepEqual(h.provider.claimCalls, [], "routed before the tracker-side claim — and concurrency 1 didn't stop the second route");
  assert.deepEqual(h.chainRuns, []);
  assert.deepEqual(recorded.map((r) => [r.adwId, r.d.kind, r.d.choice]), [
    ["issue-80", "intake_readiness", "needs_human"],
    ["issue-81", "intake_readiness", "needs_human"],
  ]);
});

test("intake_readiness: a human's relabel wins — an issue with any watch marker builds with no Jev call", async () => {
  const fake = FakeJevClient.choosing("needs_human", 0.99);
  const { intakeJev } = fakeIntake(ON_ACT, fake);
  const h = harness({ intakeJev });
  h.provider.add("82", "ready", { intake: { routed: "needs_human", at: "2020-01-01T00:00:00.000Z" } });
  await runReady(h);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(h.chainRuns, ["issue-82"]);
  assert.equal(h.provider.entries.get("82")!.state, "review");
});

test("intake_readiness act: refine -> spec-ready only while watch.refine.enabled; otherwise not_permitted and it builds", async () => {
  {
    const { intakeJev, recorded } = fakeIntake(ON_ACT, FakeJevClient.choosing("refine", 0.95));
    const h = harness({ intakeJev, refineEnabled: false });
    h.provider.add("83", "ready");
    await runReady(h);
    assert.deepEqual(h.chainRuns, ["issue-83"]);
    assert.equal(recorded[0]!.d.reason, "not_permitted");
    assert.equal(recorded[0]!.d.choice, "build");
  }
  {
    const { intakeJev, recorded } = fakeIntake(ON_ACT, FakeJevClient.choosing("refine", 0.95));
    const h = harness({ intakeJev, refineEnabled: true });
    h.provider.add("84", "ready");
    await runReady(h);
    assert.deepEqual(h.chainRuns, []);
    assert.deepEqual(h.provider.claimCalls, []);
    const entry = h.provider.entries.get("84")!;
    assert.equal(entry.state, "spec-ready");
    assert.match(entry.comments.at(-1)!.body, /handed to the refine lane/);
    assert.equal(entry.marker?.intake?.routed, "refine");
    assert.equal(recorded[0]!.d.reason, null);
  }
});

test("intake_readiness: a refine-lane-created issue is never routed back to refine (no loop)", async () => {
  const { intakeJev, recorded } = fakeIntake(ON_ACT, FakeJevClient.choosing("refine", 0.95));
  const h = harness({ intakeJev, refineEnabled: true });
  h.provider.add("85", "ready", null, `Build it.\n\n<!-- spf-refine: ${JSON.stringify({ parent: "10", blocked_by: [], priority: "p2" })} -->`);
  await runReady(h);
  assert.deepEqual(h.chainRuns, ["issue-85"]);
  assert.equal(recorded[0]!.d.reason, "not_permitted");
});

test("intake_readiness shadow: recorded, but the issue is claimed and built as today", async () => {
  const fake = FakeJevClient.choosing("needs_human", 0.99);
  const { intakeJev, recorded } = fakeIntake(ON_SHADOW, fake);
  const h = harness({ intakeJev });
  h.provider.add("86", "ready");
  await runReady(h);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(h.chainRuns, ["issue-86"]);
  assert.equal(h.provider.entries.get("86")!.marker?.intake, undefined);
  assert.equal(recorded[0]!.d.reason, "shadow");
  assert.equal(recorded[0]!.d.jev_choice, "needs_human");
});

test("intake_readiness fallbacks: timeout and low confidence build; kind off skips even the marker read", async () => {
  for (const [client, config, reason] of [
    [FakeJevClient.hanging(), { ...ON_ACT, timeout_ms: 20 }, "timeout"],
    [FakeJevClient.choosing("needs_human", 0.2), ON_ACT, "low_confidence"],
  ] as const) {
    const { intakeJev, recorded } = fakeIntake(config, client);
    const h = harness({ intakeJev });
    h.provider.add("87", "ready");
    await runReady(h);
    assert.deepEqual(h.chainRuns, ["issue-87"], reason);
    assert.equal(recorded[0]!.d.reason, reason);
  }
  const fake = FakeJevClient.choosing("needs_human", 0.99);
  const { intakeJev, recorded } = fakeIntake({ ...ON_ACT, decisions: { intake_readiness: { mode: "off" } } }, fake);
  const h = harness({ intakeJev });
  h.provider.add("88", "ready");
  await runReady(h);
  assert.deepEqual(h.chainRuns, ["issue-88"]);
  assert.equal(fake.calls.length, 0);
  assert.equal(recorded.length, 0);
  // runIssueSingle reads the marker once itself; the router added none.
  assert.equal(h.provider.markerReads, 1);
});

test("intake_readiness: a tracker error while routing skips the issue this tick (still ready), never claims it", async () => {
  const { intakeJev } = fakeIntake(ON_ACT, FakeJevClient.choosing("needs_human", 0.95));
  const h = harness({ intakeJev });
  h.provider.add("89", "ready");
  h.provider.writeMarker = async () => {
    throw new Error("tracker down");
  };
  await runReady(h);
  assert.equal(h.provider.entries.get("89")!.state, "ready");
  assert.deepEqual(h.provider.claimCalls, []);
  assert.ok(h.logs.some((l) => l.includes("readiness intake error: tracker down")));
});
