/**
 * Declared chain transitions (#109) — `chains/graph.ts` + the graph half of
 * `chains/repo_chains.ts`'s loader.
 *
 * Two halves, mirroring the module:
 *
 *   LOAD TIME  — every edge target exists, every step is reachable, every
 *                cycle is bounded by max_visits, the default path fits the
 *                step budget, and a commit can never be reached by skipping
 *                a gate the default path runs. Each failure is a `problems`
 *                entry, never a throw.
 *   RUN TIME   — through the REAL call site (`runChain` -> `steps.runSteps`
 *                -> `walkGraph`), with quality suites of `true`/`false` so no
 *                agent is spawned. Jev off (no `jev:` block) walks the
 *                default path with zero `jev_decision` rows (R8); shadow
 *                records but the default acts; act takes Jev's edge;
 *                max_visits / max_steps / gate aggregation hold whatever Jev
 *                says; a recorded path replays without calling Jev.
 *
 * Jev is always a `FakeJevClient` (setJevClientFactory, reset in `finally`) —
 * nothing here touches the network.
 */
import "./hermetic_git.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RepoAnchor } from "../core/paths.js";
import { loadRepoChains } from "../chains/repo_chains.js";
import { chainHasCommitStep, hasCommitStep, runChain, resolveRequiredSuites, stepChain, type ChainDefinition } from "../chains/index.js";
import * as steps from "../chains/steps.js";
import { defaultPath, graphProblems, walkGraph, type ChainGraph } from "../chains/graph.js";
import { Tracer } from "../core/tracer.js";
import { JEV_DECISION_EVENT, findRecordedDecision, parseRecordedDecision, setJevClientFactory } from "../core/jev.js";
import { CHAIN_EDGE_KIND, JEV_DECISION_KINDS } from "../core/jev_kinds.js";
import { FakeJevClient } from "./fake_jev.js";

// ── helpers ────────────────────────────────────────────────────────────────

/** Load one chain file from a throwaway `.spf/chains/`. */
function load(yaml: string) {
  const root = mkdtempSync(path.join(tmpdir(), "spf-graph-load-"));
  try {
    const spfDir = path.join(root, ".spf");
    mkdirSync(path.join(spfDir, "chains"), { recursive: true });
    writeFileSync(path.join(spfDir, "chains", "g.yaml"), yaml);
    const anchor: RepoAnchor = { cwd: root, repo_root: root, spf_dir: spfDir };
    return loadRepoChains(anchor);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function loadOk(yaml: string): ChainDefinition {
  const { chains, problems } = load(yaml);
  assert.deepEqual(problems, [], "expected the chain to load clean");
  assert.equal(chains.length, 1);
  return chains[0]!;
}

function loadProblem(yaml: string): string {
  const { chains, problems } = load(yaml);
  assert.equal(chains.length, 0, "expected the chain to be rejected");
  assert.equal(problems.length, 1);
  return problems[0]!.message;
}

const head = (name = "g") => [`name: ${name}`, "describe: a graph chain under test", "steps:"];

/** Quality suites that need no agent: `ok` always passes, `bad` always fails. */
const QUALITY = [
  "quality:",
  "  checks:",
  '    - { name: ok, operation: build, argv: ["true"] }',
  '    - { name: bad, operation: build, argv: ["false"] }',
  "  suites:",
  "    pass: [ok]",
  "    lefty: [ok]",
  "    righty: [ok]",
  "    again: [ok]",
  "    done: [ok]",
  "    fail: [bad]",
].join("\n");

const JEV_ACT = "jev:\n  enabled: true\n  mode: act\n";
const JEV_SHADOW = "jev:\n  enabled: true\n  mode: shadow\n";

/** start -> check -> {left (default) | right}; left ends the chain, right is last. */
const BRANCH_CHAIN = [
  ...head("branchy"),
  "  - id: start",
  "    step: request",
  "  - id: check",
  "    step: qualityCheck",
  "    suite: pass",
  "    next: [left, right]",
  "    default: left",
  "  - id: left",
  "    step: qualityCheck",
  "    suite: lefty",
  "    next: []",
  "  - id: right",
  "    step: qualityCheck",
  "    suite: righty",
  "",
].join("\n");

interface EventRow {
  type: string;
  name: string;
  payload_json: string;
}

interface GraphRun {
  /** The exit code, or -1 when the run threw (see `thrown`). */
  code: number;
  /** What `runChain` threw, if it did — a step's own error propagates, exactly as in a linear chain. */
  thrown: unknown;
  adwId: string;
  events: EventRow[];
  phases: string[];
  path: string[];
  jevRows: EventRow[];
}

/**
 * Load `chainYaml` from a scratch repo's `.spf/chains/`, run it through
 * `runChain` (the real dispatch path) with `configYaml`, then read the
 * trace back. `body` gets the scratch dir while it still exists.
 */
async function runGraph(
  chainYaml: string,
  configYaml: string,
  adwId: string,
  body?: (dir: string, chain: ChainDefinition, run: GraphRun) => Promise<void>,
  opts: { expectThrow?: boolean } = {},
): Promise<GraphRun> {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-graph-run-"));
  try {
    const spfDir = path.join(dir, ".spf");
    mkdirSync(path.join(spfDir, "chains"), { recursive: true });
    writeFileSync(path.join(spfDir, "chains", "g.yaml"), chainYaml);
    const configPath = path.join(dir, "spf.config.yaml");
    writeFileSync(configPath, `${QUALITY}\n${configYaml}`);
    const { chains, problems } = loadRepoChains({ cwd: dir, repo_root: dir, spf_dir: spfDir });
    assert.deepEqual(problems, []);
    const chain = chains[0]!;
    let code = -1;
    let thrown: unknown = undefined;
    try {
      code = await runChain(chain, {
        prompt: "exercise the graph",
        config_paths: [configPath],
        adw_id: adwId,
        cwd: dir,
        chain_name: chain.name,
        chain_source: chain.source,
        unattended: true,
      });
    } catch (error) {
      thrown = error;
    }
    const tracer = await Tracer.open(path.join(dir, ".spf", "data", "spf.db"), path.join(dir, ".spf", "data", "sessions", "events.jsonl"));
    let result: GraphRun;
    try {
      const events = (await tracer.db.query("SELECT type, name, payload_json FROM events WHERE adw_id=? ORDER BY rowid").all(adwId)) as EventRow[];
      const pathEvent = events.find((e) => e.name === "chain_path");
      result = {
        code,
        thrown,
        adwId,
        events,
        phases: events.filter((e) => e.type === "phase_start").map((e) => e.name),
        path: pathEvent ? (JSON.parse(pathEvent.payload_json).path as string[]) : [],
        jevRows: events.filter((e) => e.type === "log" && e.name === JEV_DECISION_EVENT),
      };
    } finally {
      await tracer.close();
    }
    if (thrown !== undefined && !opts.expectThrow) throw thrown;
    if (body) await body(dir, chain, result);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withFake<T>(fake: FakeJevClient, body: () => Promise<T>): Promise<T> {
  setJevClientFactory(() => fake);
  try {
    return await body();
  } finally {
    setJevClientFactory(null);
  }
}

// ── the kind ───────────────────────────────────────────────────────────────

test("chain_edge is a registered Jev kind (a choice, no static options, no extras)", () => {
  assert.equal(CHAIN_EDGE_KIND.kind, "chain_edge");
  assert.equal(JEV_DECISION_KINDS["chain_edge"], CHAIN_EDGE_KIND);
  assert.equal(CHAIN_EDGE_KIND.question, "choice");
  assert.equal(CHAIN_EDGE_KIND.options, undefined, "the closed set is each branch point's own declared edges");
  assert.equal(CHAIN_EDGE_KIND.extras, undefined);
});

// ── load time: chains without next: are untouched ──────────────────────────

test("a chain with no next: is a plain list — no graph, and ids alone change nothing", () => {
  const plain = loadOk([...head(), "  - step: request", "  - step: fixLoop", "    suite: test", ""].join("\n"));
  const withIds = loadOk([...head(), "  - id: a", "    step: request", "  - id: b", "    step: fixLoop", "    suite: test", ""].join("\n"));
  const builtIn = stepChain("g", "x", [steps.request(), steps.fixLoop({ suite: "test" })]);
  for (const chain of [plain, withIds]) {
    assert.equal(chain.graph, undefined);
    assert.equal(chain.phases, builtIn.phases);
  }
});

test("default / max_visits / max_steps without any next: are problems, not silent no-ops", () => {
  assert.match(loadProblem([...head(), "  - step: request", "    max_visits: 2", ""].join("\n")), /only mean something in a chain that declares next/);
  assert.match(loadProblem(["name: g", "describe: x", "max_steps: 5", "steps:", "  - step: request", ""].join("\n")), /max_steps only means something/);
});

// ── load time: edge syntax ─────────────────────────────────────────────────

test("an edge to an unknown step id is a load problem naming the declared ids", () => {
  const msg = loadProblem([...head(), "  - id: a", "    step: request", "    next: [nowhere]", ""].join("\n"));
  assert.match(msg, /next names unknown step id\(s\) "nowhere"/);
  assert.match(msg, /declared ids: a/);
});

test("duplicate ids, next without id, default outside next, and default without next are all rejected", () => {
  assert.match(loadProblem([...head(), "  - id: a", "    step: request", "  - id: a", "    step: plan", "    next: []", ""].join("\n")), /already used by steps\[0\]/);
  assert.match(loadProblem([...head(), "  - step: request", "    next: []", ""].join("\n")), /needs an id/);
  assert.match(
    loadProblem([...head(), "  - id: a", "    step: request", "    next: [b]", "    default: c", "  - id: b", "    step: plan", "  - id: c", "    step: scout", ""].join("\n")),
    /default "c" is not one of its next/,
  );
  assert.match(loadProblem([...head(), "  - id: a", "    step: request", "    default: b", "  - id: b", "    step: plan", "    next: []", ""].join("\n")), /default needs a next/);
  assert.match(loadProblem([...head(), "  - id: a", "    step: request", "    nxt: [b]", ""].join("\n")), /unknown param\(s\) "nxt"/);
});

test("several edges with no default need the linear next step among them", () => {
  const msg = loadProblem(
    [...head(), "  - id: a", "    step: request", "    next: [c, d]", "  - id: b", "    step: plan", "  - id: c", "    step: scout", "  - id: d", "    step: plan", "    owner: other", ""].join("\n"),
  );
  assert.match(msg, /no default, and the step after it is not one of them/);
  // ...and it is fine when the linear next step IS one of the edges: that is the fallback.
  const ok = loadOk([...head(), "  - id: a", "    step: request", "    next: [b, c]", "  - id: b", "    step: plan", "    next: []", "  - id: c", "    step: scout", ""].join("\n"));
  assert.deepEqual(defaultPath(ok.graph!).path, ["a", "b"]);
});

test("a step no path reaches is a load problem, not dead yaml", () => {
  const msg = loadProblem([...head(), "  - id: a", "    step: request", "    next: []", "  - id: b", "    step: plan", ""].join("\n"));
  assert.match(msg, /"b" can never run/);
});

// ── load time: cycles and the budget ───────────────────────────────────────

test("a cycle with no max_visits step is rejected; the same cycle bounded by max_visits loads", () => {
  const cycle = (bound: string[]) =>
    [
      ...head(),
      "  - id: start",
      "    step: request",
      "  - id: build",
      "    step: build",
      ...bound,
      "  - id: test",
      "    step: qualityCheck",
      "    suite: test",
      "    next: [done, build]",
      "    default: done",
      "  - id: done",
      "    step: document",
      "",
    ].join("\n");
  assert.match(loadProblem(cycle([])), /cycle "build" -> "test" -> "build" has no step with max_visits/);
  const chain = loadOk(cycle(["    max_visits: 3"]));
  assert.deepEqual(defaultPath(chain.graph!).path, ["start", "build", "test", "done"]);
  assert.equal(chain.graph!.max_steps, 8, "max_steps defaults to twice the step count");
});

test("max_visits and max_steps have upper bounds", () => {
  assert.match(
    loadProblem([...head(), "  - id: a", "    step: request", "    max_visits: 11", "    next: []", ""].join("\n")),
    /max_visits above 10/,
  );
  assert.match(loadProblem(["name: g", "describe: x", "max_steps: 51", "steps:", "  - id: a", "    step: request", "    next: []", ""].join("\n")), /max_steps above 50/);
});

test("a default path longer than max_steps is a load problem — what runs with Jev off must finish", () => {
  const msg = loadProblem(
    ["name: g", "describe: x", "max_steps: 2", "steps:", "  - id: a", "    step: request", "  - id: b", "    step: plan", "  - id: c", "    step: scout", "    next: []", ""].join("\n"),
  );
  assert.match(msg, /default path .* does not finish: step budget exhausted: max_steps 2/);
});

// ── load time: commits and their gates (invariant 6) ───────────────────────

test("a declared edge that skips a gate the default path runs before a commit is rejected", () => {
  const msg = loadProblem(
    [
      ...head(),
      "  - id: build",
      "    step: build",
      "    next: [test, land]",
      "    default: test",
      "  - id: test",
      "    step: fixLoop",
      "    suite: test",
      "  - id: land",
      "    step: commit",
      "",
    ].join("\n"),
  );
  assert.match(msg, /"land" \(commit\) can be reached without running "test"/);
});

test("an extra check on an alternative path before a commit is fine — edges may add gates", () => {
  const chain = loadOk(
    [
      ...head(),
      "  - id: build",
      "    step: build",
      "  - id: test",
      "    step: fixLoop",
      "    suite: test",
      "    next: [land, review]",
      "    default: land",
      "  - id: review",
      "    step: reviseLoop",
      "    next: [land]",
      "  - id: land",
      "    step: commit",
      "    onlyIfAccepted: true",
      "",
    ].join("\n"),
  );
  assert.deepEqual(defaultPath(chain.graph!).path, ["build", "test", "land"]);
});

test("an onlyIfAccepted commit reachable with no gate run at all is rejected", () => {
  const msg = loadProblem([...head(), "  - id: build", "    step: build", "    next: [land]", "  - id: land", "    step: commit", "    onlyIfAccepted: true", ""].join("\n"));
  assert.match(msg, /onlyIfAccepted\) is reachable through a path on which no gating step/);
});

// ── derivation over all reachable steps ────────────────────────────────────

test("phases/requiredSuites cover EVERY reachable step, including branch-only ones", () => {
  const chain = loadOk(BRANCH_CHAIN);
  assert.deepEqual(resolveRequiredSuites(chain, {}).sort(), ["lefty", "pass", "righty"]);
  assert.equal(chain.phases, "start:engineer(request) -> check:code(pass) =>(left|right) -> left:code(lefty) =>(end) -> right:code(righty)");
  assert.deepEqual(chain.graph!.nodes.map((n) => n.id), ["start", "check", "left", "right"]);
});

// ── run time, through runChain ─────────────────────────────────────────────

test("R8: with NO jev: block a graph chain walks its default path — same result as the heuristic, zero jev_decision rows, zero Jev calls", async () => {
  const fake = FakeJevClient.choosing("right", 0.99);
  const r = await withFake(fake, () => runGraph(BRANCH_CHAIN, "", "adw_graph_off"));
  assert.equal(r.code, 0);
  assert.deepEqual(r.path, ["start", "check", "left"]);
  assert.deepEqual(r.phases, ["request", "pass", "lefty"]);
  assert.equal(r.jevRows.length, 0);
  assert.equal(fake.calls.length, 0);
  const edges = r.events.filter((e) => e.name === "chain_edge").map((e) => JSON.parse(e.payload_json));
  assert.deepEqual(
    edges.map((e) => [e.from, e.to, e.via]),
    [
      ["start", "check", "linear"],
      ["check", "left", "fallback"],
    ],
  );
  assert.equal(edges[1].key, "check#1", "the decision key is <step id>#<visit> — stable, never an index");
});

test("shadow: Jev is asked and recorded, but the default edge acts", async () => {
  const fake = FakeJevClient.choosing("right", 0.95);
  const r = await withFake(fake, () => runGraph(BRANCH_CHAIN, JEV_SHADOW, "adw_graph_shadow"));
  assert.equal(r.code, 0);
  assert.deepEqual(r.path, ["start", "check", "left"]);
  assert.equal(fake.calls.length, 1);
  assert.equal(r.jevRows.length, 1);
  const d = parseRecordedDecision(JSON.parse(r.jevRows[0]!.payload_json))!;
  assert.equal(d.kind, "chain_edge");
  assert.equal(d.key, "check#1");
  assert.deepEqual(d.options, ["left", "right"], "the closed set is exactly the declared edges");
  assert.equal(d.fallback, "left");
  assert.equal(d.jev_choice, "right");
  assert.equal(d.choice, "left");
  assert.equal(d.reason, "shadow");
});

test("act: Jev's declared edge is taken", async () => {
  const fake = FakeJevClient.choosing("right", 0.95);
  const r = await withFake(fake, () => runGraph(BRANCH_CHAIN, JEV_ACT, "adw_graph_act"));
  assert.equal(r.code, 0);
  assert.deepEqual(r.path, ["start", "check", "right"]);
  assert.deepEqual(r.phases, ["request", "pass", "righty"]);
  const edge = r.events.filter((e) => e.name === "chain_edge").map((e) => JSON.parse(e.payload_json))[1];
  assert.equal(edge.via, "jev");
  assert.equal(parseRecordedDecision(JSON.parse(r.jevRows[0]!.payload_json))!.choice, "right");
});

test("act, but a low-confidence / undeclared / failing answer falls back to the default edge", async () => {
  for (const [label, fake, reason] of [
    ["low confidence", FakeJevClient.choosing("right", 0.2), "low_confidence"],
    ["undeclared step", FakeJevClient.choosing("deploy", 0.99), "invalid_choice"],
    ["error", FakeJevClient.failing(new Error("boom")), "error"],
  ] as const) {
    const r = await withFake(fake, () => runGraph(BRANCH_CHAIN, JEV_ACT, `adw_graph_fb_${reason}`));
    assert.deepEqual(r.path, ["start", "check", "left"], label);
    assert.equal(parseRecordedDecision(JSON.parse(r.jevRows[0]!.payload_json))!.reason, reason, label);
  }
});

/** A self-loop bounded by max_visits: `again` may re-run itself, else go to `done`. */
const LOOP_CHAIN = (extra: string[] = []) =>
  [
    "name: loopy",
    "describe: a bounded loop",
    ...extra,
    "steps:",
    "  - id: start",
    "    step: request",
    "  - id: again",
    "    step: qualityCheck",
    "    suite: again",
    "    max_visits: 3",
    "    next: [done, again]",
    "    default: done",
    "  - id: done",
    "    step: qualityCheck",
    "    suite: done",
    "",
  ].join("\n");

test("max_visits: Jev choosing the loop forever still stops at the bound, then the only open edge is taken without asking", async () => {
  const fake = FakeJevClient.choosing("again", 0.99);
  const r = await withFake(fake, () => runGraph(LOOP_CHAIN(), JEV_ACT, "adw_graph_visits"));
  assert.equal(r.code, 0);
  assert.deepEqual(r.path, ["start", "again", "again", "again", "done"]);
  assert.equal(fake.calls.length, 2, "asked on visits 1 and 2; on visit 3 the loop edge is exhausted, so nothing to choose");
  const edges = r.events.filter((e) => e.name === "chain_edge").map((e) => JSON.parse(e.payload_json));
  assert.deepEqual(edges[1].permitted, ["done", "again"]);
  assert.equal(edges.at(-1).via, "only_permitted");
});

test("max_steps: the step budget caps total executions — the walk stops and the run is not accepted", async () => {
  const fake = FakeJevClient.choosing("again", 0.99);
  const r = await withFake(fake, () => runGraph(LOOP_CHAIN(["max_steps: 3"]), JEV_ACT, "adw_graph_budget"));
  assert.equal(r.code, 1, "stopping short of the declared path is not an accepted run");
  assert.deepEqual(r.path, ["start", "again", "again"]);
  const pathEvent = JSON.parse(r.events.find((e) => e.name === "chain_path")!.payload_json);
  assert.match(pathEvent.stopped, /step budget exhausted: max_steps 3/);
  const notAccepted = r.events.find((e) => e.name === "not_accepted");
  assert.match(JSON.parse(notAccepted!.payload_json).reason, /step budget exhausted/);
});

test("gate aggregation: a Jev-picked passing check cannot launder an earlier failing gate past an onlyIfAccepted commit", async () => {
  // tests fail; Jev routes to an extra (passing) check; the commit must
  // still see accepted=false. (Were the passing check allowed to overwrite
  // it, commit() would run and throw — there is no envelope to commit.)
  const chain = [
    ...head("launder"),
    "  - id: start",
    "    step: request",
    "  - id: tests",
    "    step: qualityCheck",
    "    suite: fail",
    "    next: [land, extra]",
    "    default: land",
    "  - id: extra",
    "    step: qualityCheck",
    "    suite: pass",
    "    next: [land]",
    "  - id: land",
    "    step: commit",
    "    onlyIfAccepted: true",
    "",
  ].join("\n");
  const fake = FakeJevClient.choosing("extra", 0.99);
  const r = await withFake(fake, () => runGraph(chain, JEV_ACT, "adw_graph_launder"));
  assert.deepEqual(r.path, ["start", "tests", "extra", "land"]);
  assert.equal(r.code, 1);
  assert.ok(!r.phases.includes("commit"), "the commit phase never opened");
  assert.match(JSON.parse(r.events.find((e) => e.name === "not_accepted")!.payload_json).reason, /quality failed/);
});

test("replay: a recorded path is retraced from the trace without calling Jev, even when today's Jev would answer differently", async () => {
  const first = FakeJevClient.choosing("right", 0.95);
  const replayFake = FakeJevClient.choosing("left", 0.99);
  await withFake(first, () =>
    runGraph(BRANCH_CHAIN, JEV_ACT, "adw_graph_rec", async (dir, chain, recorded) => {
      assert.deepEqual(recorded.path, ["start", "check", "right"]);
      setJevClientFactory(() => replayFake);
      const run = await steps.startRun(
        { prompt: "exercise the graph", config_paths: [path.join(dir, "spf.config.yaml")], adw_id: "adw_graph_replay", cwd: dir, chain_name: chain.name, unattended: true },
        [],
        ["pass", "lefty", "righty"],
      );
      try {
        const state: steps.ChainState = { prompt: "exercise the graph", options: {}, previous: null, quality: null, review: null, changeset: null, baseline: "", issue_id: null, accepted: true, reason: "" };
        const walk = await walkGraph(run, state, chain.graph!, {
          replay: (key) => findRecordedDecision(run.tracer.db, "adw_graph_rec", CHAIN_EDGE_KIND.kind, key),
        });
        assert.deepEqual(walk.path, recorded.path);
        assert.equal(replayFake.calls.length, 0);
        const replayed = await findRecordedDecision(run.tracer.db, "adw_graph_replay", CHAIN_EDGE_KIND.kind, "check#1");
        assert.equal(replayed?.replayed, true);
        assert.equal(replayed?.choice, "right");
      } finally {
        await run.tracer.close();
      }
    }),
  );
});

// ── review follow-ups (#109): commits off the default path ─────────────────

/** Probe 1: `build` may hand off to a plain `quick` commit that skips the `test` gate the default path runs. */
const SKIP_TO_PLAIN_COMMIT = [
  ...head("skippy"),
  "  - id: start",
  "    step: request",
  "  - id: build",
  "    step: build",
  "    next: [test, quick]",
  "    default: test",
  "  - id: test",
  "    step: fixLoop",
  "    suite: test",
  "    next: [land]",
  "  - id: land",
  "    step: commit",
  "    onlyIfAccepted: true",
  "    next: []",
  "  - id: quick",
  "    step: commit",
  "",
].join("\n");

/** Probe 2: `lint` satisfies "some gate ran" for `land2`, but `land2` never runs the `test` gate the default path requires. */
const SKIP_VIA_OTHER_GATE = [
  ...head("linty"),
  "  - id: start",
  "    step: request",
  "  - id: build",
  "    step: build",
  "    next: [test, lint]",
  "    default: test",
  "  - id: test",
  "    step: fixLoop",
  "    suite: test",
  "    next: [land]",
  "  - id: land",
  "    step: commit",
  "    onlyIfAccepted: true",
  "    next: []",
  "  - id: lint",
  "    step: qualityCheck",
  "    suite: lint",
  "    next: [land2]",
  "  - id: land2",
  "    step: commit",
  "    onlyIfAccepted: true",
  "",
].join("\n");

test("a commit reachable ONLY through a Jev-picked edge is held to the default path's gates (probe: plain commit skipping the test gate)", () => {
  const msg = loadProblem(SKIP_TO_PLAIN_COMMIT);
  assert.match(msg, /"quick" \(commit\) can be reached without running "test", which the default path runs before it commits/);
  assert.match(msg, /"quick" \(commit\) is reachable only off the default path but is not onlyIfAccepted/);
});

test("a commit reachable ONLY through a Jev-picked edge cannot swap the default path's gate for a different one (probe: lint instead of test)", () => {
  const msg = loadProblem(SKIP_VIA_OTHER_GATE);
  assert.match(msg, /"land2" \(commit\) can be reached without running "test"/);
});

test("the gate rule is enforced by graphProblems itself, so a hand-built graph gets the same verdict as a yaml one", () => {
  // Same shape as SKIP_VIA_OTHER_GATE, built without the loader.
  const node = (id: string, step: steps.Step, extra: Partial<ChainGraph["nodes"][number]> = {}): ChainGraph["nodes"][number] => ({
    id,
    step_name: id,
    step,
    next: null,
    default: null,
    max_visits: null,
    gate: step.gate === true,
    commit: null,
    ...extra,
  });
  const graph: ChainGraph = {
    chain: "hand",
    max_steps: 12,
    nodes: [
      node("start", steps.request()),
      node("build", steps.build(), { next: ["test", "lint"], default: "test" }),
      node("test", steps.fixLoop({ suite: "test" }), { next: ["land"] }),
      node("land", steps.commit({ onlyIfAccepted: true }), { next: [], commit: "only_if_accepted" }),
      node("lint", steps.qualityCheck({ suite: "lint" }), { next: ["land2"] }),
      node("land2", steps.commit({ onlyIfAccepted: true }), { commit: "only_if_accepted" }),
    ],
  };
  assert.ok(graphProblems(graph).some((p) => /"land2" \(commit\) can be reached without running "test"/.test(p)));
});

test("a plain commit off the default path is rejected even when every default gate runs before it", () => {
  const msg = loadProblem(
    [
      ...head(),
      "  - id: build",
      "    step: build",
      "  - id: test",
      "    step: fixLoop",
      "    suite: test",
      "    next: [land, quick]",
      "    default: land",
      "  - id: land",
      "    step: commit",
      "    onlyIfAccepted: true",
      "    next: []",
      "  - id: quick",
      "    step: commit",
      "",
    ].join("\n"),
  );
  assert.match(msg, /"quick" \(commit\) is reachable only off the default path but is not onlyIfAccepted/);
  assert.doesNotMatch(msg, /can be reached without running/, "test dominates quick; only the plain-commit rule fires");
});

/** Legal: tests (failing) -> {land (default) | extra -> land2}; land2 is an onlyIfAccepted commit only Jev reaches, and `tests` dominates it. */
const JEV_ONLY_COMMIT = [
  ...head("jevland"),
  "  - id: start",
  "    step: request",
  "  - id: tests",
  "    step: qualityCheck",
  "    suite: fail",
  "    next: [land, extra]",
  "    default: land",
  "  - id: extra",
  "    step: qualityCheck",
  "    suite: pass",
  "    next: [land2]",
  "  - id: land",
  "    step: commit",
  "    onlyIfAccepted: true",
  "    next: []",
  "  - id: land2",
  "    step: commit",
  "    onlyIfAccepted: true",
  "",
].join("\n");

test("act: Jev routing to a commit only it can reach still runs every default-path gate first, and the commit phase never opens past a red one", async () => {
  const chain = loadOk(JEV_ONLY_COMMIT);
  assert.deepEqual(defaultPath(chain.graph!).path, ["start", "tests", "land"]);
  const fake = FakeJevClient.choosing("extra", 0.99);
  const r = await withFake(fake, () => runGraph(JEV_ONLY_COMMIT, JEV_ACT, "adw_graph_jevland"));
  assert.deepEqual(r.path, ["start", "tests", "extra", "land2"]);
  assert.ok(r.path.indexOf("tests") < r.path.indexOf("land2"), "the default path's gate ran before the Jev-only commit");
  assert.equal(r.code, 1);
  assert.ok(!r.phases.includes("commit"), "the commit phase never opened: the default gate failed");
  assert.match(JSON.parse(r.events.find((e) => e.name === "not_accepted")!.payload_json).reason, /quality failed/);
});

// ── review follow-ups: fanout eligibility follows the default path ─────────

test("chainHasCommitStep: a graph chain counts only commits on its DEFAULT path — a Jev-only commit does not make it fanout-eligible", () => {
  const offPath = loadOk(
    [
      ...head("offpath"),
      "  - id: start",
      "    step: request",
      "  - id: test",
      "    step: qualityCheck",
      "    suite: pass",
      "    next: [done, land]",
      "    default: done",
      "  - id: done",
      "    step: document",
      "    next: []",
      "  - id: land",
      "    step: commit",
      "    onlyIfAccepted: true",
      "",
    ].join("\n"),
  );
  assert.deepEqual(defaultPath(offPath.graph!).path, ["start", "test", "done"]);
  assert.equal(hasCommitStep(offPath.phases), true, "the display string lists every step, the Jev-only commit included");
  assert.equal(chainHasCommitStep(offPath), false, "with Jev off / in shadow / on fallback this chain never commits");

  const onPath = loadOk(
    [
      ...head("onpath"),
      "  - id: start",
      "    step: request",
      "  - id: test",
      "    step: qualityCheck",
      "    suite: pass",
      "    next: [land, done]",
      "    default: land",
      "  - id: land",
      "    step: commit",
      "    onlyIfAccepted: true",
      "    next: []",
      "  - id: done",
      "    step: document",
      "",
    ].join("\n"),
  );
  assert.equal(chainHasCommitStep(onPath), true);

  // A linear chain answers exactly as hasCommitStep(phases) always did.
  const linear = stepChain("lin", "x", [steps.request(), steps.build(), steps.commit()]);
  assert.equal(chainHasCommitStep(linear), hasCommitStep(linear.phases));
  assert.equal(chainHasCommitStep(linear), true);
});

// ── review follow-ups: run-time edge cases ─────────────────────────────────

/** `again` may loop (max 2), go to `extra`, or end at `done` (the default). */
const THREE_EDGE_LOOP = [
  "name: loopy3",
  "describe: a bounded loop with three edges",
  "steps:",
  "  - id: start",
  "    step: request",
  "  - id: again",
  "    step: qualityCheck",
  "    suite: again",
  "    max_visits: 2",
  "    next: [done, again, extra]",
  "    default: done",
  "  - id: extra",
  "    step: qualityCheck",
  "    suite: pass",
  "    next: [done]",
  "  - id: done",
  "    step: qualityCheck",
  "    suite: done",
  "",
].join("\n");

test("max_visits: Jev picking an exhausted target while two edges are still open is not_permitted, and the default edge is taken", async () => {
  const fake = FakeJevClient.choosing("again", 0.99);
  const r = await withFake(fake, () => runGraph(THREE_EDGE_LOOP, JEV_ACT, "adw_graph_notperm"));
  assert.equal(r.code, 0);
  assert.deepEqual(r.path, ["start", "again", "again", "done"]);
  assert.equal(fake.calls.length, 2, "asked on both visits: on visit 2 two edges (done, extra) are still open");
  const decisions = r.jevRows.map((row) => parseRecordedDecision(JSON.parse(row.payload_json))!);
  const second = decisions.find((d) => d.key === "again#2")!;
  assert.equal(second.jev_choice, "again");
  assert.equal(second.reason, "not_permitted");
  assert.equal(second.choice, "done");
  const edge = r.events.filter((e) => e.name === "chain_edge").map((e) => JSON.parse(e.payload_json)).find((e) => e.key === "again#2");
  assert.deepEqual(edge.options, ["done", "again", "extra"]);
  assert.deepEqual(edge.permitted, ["done", "extra"]);
  assert.equal(edge.via, "fallback");
});

test("a step throwing mid-walk propagates, and the trace still holds the path so far (chain_edge events AND a chain_path marked threw)", async () => {
  // `land` is a plain commit on the default path after a gate; with no agent
  // step before it there is no envelope, so commit() throws.
  const chain = [
    ...head("throwy"),
    "  - id: start",
    "    step: request",
    "    next: [check]",
    "  - id: check",
    "    step: qualityCheck",
    "    suite: pass",
    "  - id: land",
    "    step: commit",
    "",
  ].join("\n");
  const r = await runGraph(chain, "", "adw_graph_throw", undefined, { expectThrow: true });
  assert.ok(r.thrown instanceof Error);
  assert.match((r.thrown as Error).message, /nothing to commit/);
  const edges = r.events.filter((e) => e.name === "chain_edge").map((e) => JSON.parse(e.payload_json));
  assert.deepEqual(
    edges.map((e) => [e.from, e.to]),
    [
      ["start", "check"],
      ["check", "land"],
    ],
  );
  assert.deepEqual(r.path, ["start", "check", "land"]);
  const pathEvent = JSON.parse(r.events.find((e) => e.name === "chain_path")!.payload_json);
  assert.match(pathEvent.stopped, /^threw: .*nothing to commit/);
});

test("replay: a recorded decision whose options no longer match the edited yaml replays as replay_missing — the fallback acts, never a stale edge, and Jev is not called", async () => {
  const first = FakeJevClient.choosing("right", 0.95);
  const replayFake = FakeJevClient.choosing("right", 0.99);
  // The same chain, edited: `check` gained a third edge.
  const edited = loadOk(
    BRANCH_CHAIN.replace("    next: [left, right]", "    next: [left, right, other]") + ["  - id: other", "    step: qualityCheck", "    suite: righty", ""].join("\n"),
  );
  await withFake(first, () =>
    runGraph(BRANCH_CHAIN, JEV_ACT, "adw_graph_rec2", async (dir, chain, recorded) => {
      assert.deepEqual(recorded.path, ["start", "check", "right"]);
      setJevClientFactory(() => replayFake);
      const run = await steps.startRun(
        { prompt: "exercise the graph", config_paths: [path.join(dir, "spf.config.yaml")], adw_id: "adw_graph_replay2", cwd: dir, chain_name: chain.name, unattended: true },
        [],
        ["pass", "lefty", "righty"],
      );
      try {
        const state: steps.ChainState = { prompt: "exercise the graph", options: {}, previous: null, quality: null, review: null, changeset: null, baseline: "", issue_id: null, accepted: true, reason: "" };
        const walk = await walkGraph(run, state, edited.graph!, {
          replay: (key) => findRecordedDecision(run.tracer.db, "adw_graph_rec2", CHAIN_EDGE_KIND.kind, key),
        });
        assert.deepEqual(walk.path, ["start", "check", "left"], "the fallback edge, not the recorded (stale) one");
        assert.equal(replayFake.calls.length, 0);
        const replayed = await findRecordedDecision(run.tracer.db, "adw_graph_replay2", CHAIN_EDGE_KIND.kind, "check#1");
        assert.equal(replayed?.reason, "replay_missing");
        assert.equal(replayed?.choice, "left");
      } finally {
        await run.tracer.close();
      }
    }),
  );
});
