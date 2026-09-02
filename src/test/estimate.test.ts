import "./hermetic_git.js";

/**
 * `spf estimate` — design doc §7.4. Numbers in each test name/comment refer
 * to that section's numbered list.
 *
 * Built against a REAL temp SQLite opened by the REAL `Tracer`
 * (`core/tracer.ts`), so the schema and its migrations are the real ones;
 * synthetic sessions/phases/`agent_end` events are then written through the
 * real tracer methods, exactly as the design doc specifies. `estimateCommand`
 * itself is driven end to end — the same function `cli/index.ts` dispatches
 * `spf estimate` to — with console output captured rather than mocked.
 *
 * `hermetic_git.js` is imported first because `openTraceIfExists` ->
 * `paths.resolveAnchor` spawns a read-only `git rev-parse` to find the repo
 * root; every temp dir here is expected to resolve to ITSELF (not the real
 * spf checkout this test runs inside), and a leaked `GIT_DIR` would break
 * that silently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Tracer } from "../core/tracer.js";
import { makeEventRecord, makePhaseParams, type AgentConfig } from "../core/data_types.js";
import { Database } from "../core/sqlite.js";
import { estimateCommand, type EstimateReport } from "../cli/commands/estimate.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

function tmpRepo(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A minimal `.spf/data/spf.db`-anchored repo: `resolveDataPaths` (with the
 * schema defaults for `defaults.data_dir`/`observability.db`) puts the db at
 * exactly `<dir>/.spf/data/spf.db` when `dir` is the resolved `repo_root` —
 * which it is here, since a bare OS temp dir is never inside a real git
 * repo, so `paths.resolveAnchor` falls back to `cwd` itself.
 */
function dbPathFor(dir: string): string {
  return join(dir, ".spf", "data", "spf.db");
}

/**
 * `agentName` uses one of the packaged prompt dirs (`assets/prompts/<name>/`)
 * so `agents.validate()`'s prompt-ref check resolves for real without this
 * file needing to create any prompt files of its own — the same trick
 * `tiering.test.ts`'s `agent()` fixture uses.
 */
function agentYaml(name: string, opts: { model?: string; coding_agent?: "flue" | "claude_code" } = {}): string {
  return (
    `  - name: ${name}\n` +
    `    coding_agent: ${opts.coding_agent ?? "flue"}\n` +
    `    model: ${opts.model ?? "test/model-a"}\n` +
    `    prompt_engineering:\n` +
    `      system: ${name}/system.md\n` +
    `      user: ${name}/user.md\n`
  );
}

function writeConfig(dir: string, agentsYaml: string, extraYaml = ""): string {
  const configPath = join(dir, "spf.config.yaml");
  writeFileSync(configPath, `agents:\n${agentsYaml}${extraYaml}`);
  return configPath;
}

interface SeedPhase {
  name: string;
  owner: string;
  tokens: number;
}

/** One synthetic session: a real `sessions` row + real `phases` rows + a real `agent_end` event per phase (tokens on each), all through the real `Tracer`. */
async function seedSession(
  tracer: Tracer,
  adwId: string,
  chainName: string,
  status: "success" | "fail",
  phases: SeedPhase[],
  totals: { tokens: number; cost: number },
): Promise<void> {
  await tracer.sessionStart(adwId, "tester", chainName);
  for (const [i, p] of phases.entries()) {
    const seq = i + 1;
    const phase = {
      phase_id: `${adwId}_${String(seq).padStart(2, "0")}_${p.name}`,
      adw_id: adwId,
      seq,
      params: makePhaseParams({ name: p.name, kind: "agent", owner: p.owner, description: `synthetic fixture phase for ${p.name}`, retries: 0 }),
      status: "success" as const,
      attempt: 0,
      error: null,
      started_at: null,
      ended_at: null,
    };
    await tracer.phaseUpsert(phase);
    await tracer.event(makeEventRecord({ adw_id: adwId, phase_id: phase.phase_id, type: "agent_end", name: p.owner, tokens: p.tokens, payload: { cost: 0 } }));
  }
  await tracer.sessionAddUsage(adwId, totals.tokens, totals.cost);
  await tracer.sessionFinish(adwId, status === "success");
}

function fakeAgentConfig(name: string, model: string): AgentConfig {
  return {
    name,
    coding_agent: "flue",
    model,
    thinking: "medium",
    color: "",
    purpose: "",
    prompt_engineering: { system: `${name}/system.md`, user: `${name}/user.md` },
    harness_engineering: [],
  } as AgentConfig;
}

/** Capture console output for the duration of `fn`, restoring it after — even if `fn` throws. Mirrors `fanout_cli.test.ts`'s helper. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  console.warn = () => {}; // db.ts warns on a non-WAL journal_mode; irrelevant noise here
  try {
    const result = await fn();
    return { result, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

/** Runs `estimateCommand` and parses its `--json` stdout into an `EstimateReport`. */
async function runJson(argv: string[]): Promise<{ code: number; report: EstimateReport; errors: string[] }> {
  const { result: code, logs, errors } = await captureConsole(() => estimateCommand([...argv, "--json"]));
  const report = JSON.parse(logs.join("\n")) as EstimateReport;
  return { code, report, errors };
}

// ── 18: per-phase median over 3 runs, incl. an outlier ──────────────────────

test("18: per-phase median over 3 runs is not moved by an outlier that would move a mean", async () => {
  const dir = tmpRepo("spf-estimate-median-");
  try {
    const configPath = writeConfig(dir, agentYaml("scout"));
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    await seedSession(tracer, "r1", "scout", "success", [{ name: "scout", owner: "scout", tokens: 100 }], { tokens: 100, cost: 0 });
    await seedSession(tracer, "r2", "scout", "success", [{ name: "scout", owner: "scout", tokens: 100 }], { tokens: 100, cost: 0 });
    await seedSession(tracer, "r3", "scout", "success", [{ name: "scout", owner: "scout", tokens: 900 }], { tokens: 900, cost: 0 });
    await tracer.close();

    const { code, report } = await runJson(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]);
    assert.equal(code, 0);
    assert.equal(report.sample.status, "success", "3 successes qualifies for the success-only tier");
    assert.equal(report.sample.n, 3);
    const scoutPhase = report.phases.find((p) => p.name === "scout")!;
    assert.equal(scoutPhase.p50, 100, "the median of [100,100,900] is 100 — an outlier that WOULD move a mean (366.6) must not move the median");
    assert.equal(scoutPhase.min, 100);
    assert.equal(scoutPhase.max, 900);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 19: loop normalization ──────────────────────────────────────────────────

test("19: fix_1+fix_2 sum as ONE observation of 'fix'; verify_1 and test_1 stay distinct phases", async () => {
  const dir = tmpRepo("spf-estimate-loop-");
  try {
    const configPath = writeConfig(dir, agentYaml("scout"));
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    await seedSession(
      tracer,
      "r1",
      "scout",
      "success",
      [
        { name: "fix_1", owner: "scout", tokens: 50 },
        { name: "fix_2", owner: "scout", tokens: 70 },
        { name: "test_1", owner: "scout", tokens: 30 },
        { name: "verify_1", owner: "scout", tokens: 40 },
      ],
      { tokens: 190, cost: 0 },
    );
    await tracer.close();

    const { code, report } = await runJson(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]);
    assert.equal(code, 0);
    const names = report.phases.map((p) => p.name).sort();
    assert.deepEqual(names, ["fix", "test", "verify"], "fix_1/fix_2 collapse to one 'fix' entry; test_1/verify_1 stay distinct, not conflated");
    assert.equal(report.phases.find((p) => p.name === "fix")!.p50, 120, "fix_1 (50) + fix_2 (70) sum as ONE run observation of 'fix'");
    assert.equal(report.phases.find((p) => p.name === "test")!.p50, 30);
    assert.equal(report.phases.find((p) => p.name === "verify")!.p50, 40);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 20: joined sessions excluded ────────────────────────────────────────────

test("20: a joined session's adw_name does not enter either chain's sample, and the output says so", async () => {
  const dir = tmpRepo("spf-estimate-joined-");
  try {
    const configPath = writeConfig(dir, agentYaml("scout"));
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    // The REAL join mechanism: two sessionStart() calls on the SAME adw_id
    // with different chain names concatenate adw_name, exactly as
    // tracer.ts:215 does for a real joined run.
    await tracer.sessionStart("joined-1", "tester", "scout");
    await tracer.sessionStart("joined-1", "tester", "document");
    await tracer.sessionFinish("joined-1", true);
    await tracer.close();

    const { code, report } = await runJson(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]);
    assert.equal(code, 3, "no EXACT-match session for 'scout' exists — this is cold start, not a sample of one");
    assert.equal(report.sample.n, 0);
    assert.equal(report.sample.joined_excluded, 1, "the joined session named 'scout' as a component — excluded, but counted and reported");
    assert.equal(report.projected, null, "no fabricated number from a session that cannot be attributed to this chain alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 21: fanout siblings collapsed ───────────────────────────────────────────

test("21: five fanout siblings of one base contribute ONE observation, and the output says how many were collapsed", async () => {
  const dir = tmpRepo("spf-estimate-fanout-");
  try {
    const configPath = writeConfig(dir, agentYaml("scout"));
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    // A realistic fanout base: `newId(8)` (fanout.ts:277) is 8 lowercase hex
    // chars, and each attempt's adw_id is `${base}-${index}` (attemptAdwId,
    // fanout.ts:129-131) — the exact shape `fanoutBaseOf` now requires.
    const base = "cafef00d";
    for (let i = 1; i <= 5; i++) {
      await seedSession(tracer, `${base}-${i}`, "scout", "success", [{ name: "scout", owner: "scout", tokens: 100 * i }], { tokens: 100 * i, cost: 0 });
    }
    await tracer.close();

    const { code, report } = await runJson(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]);
    assert.equal(code, 0);
    assert.equal(report.sample.n, 1, `all 5 attempts share fanout base '${base}' — collapsed to one observation`);
    assert.equal(report.sample.fanout_collapsed, 4, "4 of the 5 siblings were collapsed away");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("21b: spf watch's issue-41/issue-42/issue-43 are NOT fanout siblings — no collapsing", async () => {
  const dir = tmpRepo("spf-estimate-watch-ids-");
  try {
    const configPath = writeConfig(dir, agentYaml("scout"));
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    // `spf watch` mints `adw_id = issue-${issue.id}` (watch.ts:357) with
    // `Issue.id` a decimal string — every one of these ends in `-<digits>`
    // despite never having gone through `spf fanout`. A loose "any
    // dash-then-digits" heuristic would misread all three as siblings of one
    // shared "issue" base and collapse two of them away.
    await seedSession(tracer, "issue-41", "scout", "success", [{ name: "scout", owner: "scout", tokens: 100 }], { tokens: 100, cost: 0 });
    await seedSession(tracer, "issue-42", "scout", "success", [{ name: "scout", owner: "scout", tokens: 100 }], { tokens: 100, cost: 0 });
    await seedSession(tracer, "issue-43", "scout", "success", [{ name: "scout", owner: "scout", tokens: 100 }], { tokens: 100, cost: 0 });
    await tracer.close();

    const { code, report } = await runJson(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]);
    assert.equal(code, 0);
    assert.equal(report.sample.n, 3, "issue-41/42/43 are three independent runs, not fanout siblings of one base");
    assert.equal(report.sample.fanout_collapsed, 0, "nothing should be collapsed — 'issue' is not the real 8-hex fanout base shape");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 22: failed sessions ──────────────────────────────────────────────────────

test("22a: failed sessions are excluded once 3+ successes exist", async () => {
  const dir = tmpRepo("spf-estimate-failed-a-");
  try {
    const configPath = writeConfig(dir, agentYaml("scout"));
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    await seedSession(tracer, "s1", "scout", "success", [{ name: "scout", owner: "scout", tokens: 100 }], { tokens: 100, cost: 0 });
    await seedSession(tracer, "s2", "scout", "success", [{ name: "scout", owner: "scout", tokens: 100 }], { tokens: 100, cost: 0 });
    await seedSession(tracer, "s3", "scout", "success", [{ name: "scout", owner: "scout", tokens: 100 }], { tokens: 100, cost: 0 });
    await seedSession(tracer, "f1", "scout", "fail", [{ name: "scout", owner: "scout", tokens: 5 }], { tokens: 5, cost: 0 });
    await seedSession(tracer, "f2", "scout", "fail", [{ name: "scout", owner: "scout", tokens: 5 }], { tokens: 5, cost: 0 });
    await tracer.close();

    const { report } = await runJson(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]);
    assert.equal(report.sample.status, "success");
    assert.equal(report.sample.n, 3, "the 2 failed runs are excluded once 3 successes qualify the success-only tier");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("22b: failed sessions are included, with the caveat, when fewer than 3 successes exist", async () => {
  const dir = tmpRepo("spf-estimate-failed-b-");
  try {
    const configPath = writeConfig(dir, agentYaml("scout"));
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    await seedSession(tracer, "s1", "scout", "success", [{ name: "scout", owner: "scout", tokens: 100 }], { tokens: 100, cost: 0 });
    await seedSession(tracer, "f1", "scout", "fail", [{ name: "scout", owner: "scout", tokens: 5 }], { tokens: 5, cost: 0 });
    await seedSession(tracer, "f2", "scout", "fail", [{ name: "scout", owner: "scout", tokens: 5 }], { tokens: 5, cost: 0 });
    await tracer.close();

    const { report } = await runJson(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]);
    assert.equal(report.sample.status, "any");
    assert.equal(report.sample.n, 3, "only 1 success exists — falls to the any-status tier, which includes the 2 failed runs");

    const { logs } = await captureConsole(() => estimateCommand(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]));
    assert.match(logs.join("\n"), /truncated run under-reports later phases/, "the any-status tier prints the caveat the design doc requires");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 23: cold start, all three shapes, one behavior ──────────────────────────

test("23a: db file does not exist at all — exit 3, no 'spf ui' message, names the chain", async () => {
  const dir = tmpRepo("spf-estimate-cold-a-");
  try {
    const configPath = writeConfig(dir, agentYaml("scout"));
    // Deliberately no Tracer constructed — no .spf/data/spf.db at all.
    const { result: code, logs } = await captureConsole(() =>
      estimateCommand(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]),
    );
    assert.equal(code, 3);
    const text = logs.join("\n");
    assert.doesNotMatch(text, /spf ui/, "this is SfDb's 'point spf ui at a target repo' advice — the wrong message for a cold spf estimate");
    assert.match(text, /scout/, "the message must name the chain");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("23b: db exists but is empty — same exit 3, same no-'spf ui' behavior", async () => {
  const dir = tmpRepo("spf-estimate-cold-b-");
  try {
    const configPath = writeConfig(dir, agentYaml("scout"));
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    await tracer.close(); // schema created, nothing written

    const { result: code, logs } = await captureConsole(() =>
      estimateCommand(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]),
    );
    assert.equal(code, 3);
    assert.doesNotMatch(logs.join("\n"), /spf ui/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("23c: sessions table predates the adw_name migration — no SQLite error, reads as cold start", async () => {
  const dir = tmpRepo("spf-estimate-cold-c-");
  try {
    const configPath = writeConfig(dir, agentYaml("scout"));
    const dbPath = dbPathFor(dir);
    mkdirSync(dirname(dbPath), { recursive: true });
    // The pre-migration shape (tracer.ts:109-116's MIGRATIONS list add
    // adw_name later) — built directly, bypassing Tracer, so no migration
    // ever runs against it.
    const raw = new Database(dbPath);
    raw.exec(
      "CREATE TABLE sessions (adw_id TEXT PRIMARY KEY, request TEXT, status TEXT, engineer TEXT, started_at TEXT, ended_at TEXT, total_tokens INTEGER DEFAULT 0, total_cost REAL DEFAULT 0)",
    );
    raw.exec("CREATE TABLE phases (phase_id TEXT PRIMARY KEY, adw_id TEXT, seq INTEGER, name TEXT)");
    raw.close();

    const { result: code, logs } = await captureConsole(() =>
      estimateCommand(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]),
    );
    assert.equal(code, 3, "must read as cold start, not throw 'no such column: adw_name'");
    assert.doesNotMatch(logs.join("\n"), /spf ui/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 24: model drift ─────────────────────────────────────────────────────────

test("24: historical model differs from the currently-resolved effective model — the warning fires, numbers are not rescaled", async () => {
  const dir = tmpRepo("spf-estimate-drift-");
  try {
    const configPath = writeConfig(
      dir,
      agentYaml("scout", { model: "ollama/granite4.1:8b" }),
      "tiering:\n" +
        "  enabled: true\n" +
        "  tiers:\n" +
        "    - { name: cheap, coding_agent: flue, model: ollama/granite4.1:8b }\n" +
        "    - { name: strong, coding_agent: flue, model: ollama/qwen3.8:27b-mlx }\n" +
        "  roles:\n" +
        "    scout: cheap\n",
    );
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    await seedSession(tracer, "r1", "scout", "success", [{ name: "scout", owner: "scout", tokens: 1000 }], { tokens: 1000, cost: 0 });
    await tracer.agentSessionRow("r1", fakeAgentConfig("scout", "ollama/granite4.1:8b"), "sess-1");
    await tracer.close();

    // scout has chainWeight -1; a >=400-word prompt forces promptWeight +1 ->
    // risk "high" unconditionally (classifyRisk's own documented cell) -> the
    // ladder shifts scout UP one rung, from "cheap" to "strong".
    const longPrompt = Array.from({ length: 420 }, (_, i) => `w${i}`).join(" ");
    const { code, report } = await runJson(["scout", longPrompt, "--config", configPath, "--cwd", dir, "--no-probe"]);
    assert.equal(code, 0);
    assert.equal(report.risk, "high");
    assert.equal(report.routing["scout"]?.effective, "ollama/qwen3.8:27b-mlx");
    assert.equal(report.drift.length, 1);
    assert.deepEqual(report.drift[0], { agent: "scout", historical: "ollama/granite4.1:8b", current: "ollama/qwen3.8:27b-mlx" });
    assert.equal(report.projected?.p50, 1000, "the projection is the raw sampled tokens — never rescaled for a tokenizer mismatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 25: --n multiplies the headline ─────────────────────────────────────────

test("25: --n 3 multiplies the projected headline and names the fanout case", async () => {
  const dir = tmpRepo("spf-estimate-n-");
  try {
    const configPath = writeConfig(dir, agentYaml("scout"));
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    await seedSession(tracer, "r1", "scout", "success", [{ name: "scout", owner: "scout", tokens: 1000 }], { tokens: 1000, cost: 0 });
    await tracer.close();

    const { report } = await runJson(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe", "--n", "3"]);
    assert.equal(report.projected?.p50, 3000);
    assert.equal(report.fanout_n, 3);

    const { logs } = await captureConsole(() =>
      estimateCommand(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe", "--n", "3"]),
    );
    assert.match(logs.join("\n"), /spf fanout/i, "the x3 case is named as the fanout case");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 26: budget interaction ──────────────────────────────────────────────────

test("26: max_run_tokens below the projection names the cut-off phase; exit code stays 0", async () => {
  const dir = tmpRepo("spf-estimate-budget-");
  try {
    const configPath = writeConfig(dir, agentYaml("scout"), "defaults:\n  max_run_tokens: 150\n");
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    await seedSession(
      tracer,
      "r1",
      "scout",
      "success",
      [
        { name: "request", owner: "engineer", tokens: 100 },
        { name: "scout", owner: "scout", tokens: 100 },
      ],
      { tokens: 200, cost: 0 },
    );
    await tracer.close();

    const { code, report } = await runJson(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]);
    assert.equal(code, 0, "estimate reports, it does not gate — exit 3 is reserved for 'no history'");
    assert.equal(report.ceilings.max_run_tokens, 150);
    assert.equal(report.ceilings.cutoff_phase, "scout", "cumulative p50 crosses 150 partway through the 2nd phase");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 27: routing agrees with dispatch ────────────────────────────────────────

test("27: reported {risk, signals, routing} deep-equals resolveTiering's own output for the same inputs, including an unchanged role", async () => {
  const dir = tmpRepo("spf-estimate-agree-");
  try {
    const configPath = writeConfig(
      dir,
      agentYaml("scout", { model: "ollama/granite4.1:8b" }),
      "tiering:\n  enabled: true\n  tiers:\n    - { name: only, coding_agent: flue, model: ollama/granite4.1:8b }\n  roles:\n    scout: only\n",
    );
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    await seedSession(tracer, "r1", "scout", "success", [{ name: "scout", owner: "scout", tokens: 10 }], { tokens: 10, cost: 0 });
    await tracer.close();

    const { report } = await runJson(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]);
    assert.ok(Object.keys(report.routing).length > 0, "fixture must exercise non-empty routing");
    assert.equal(report.routing["scout"]?.configured, report.routing["scout"]?.effective, "fixture must include an UNCHANGED role — the case a diff-only view could not have shown");

    const { resolveTiering } = await import("../core/tiering.js");
    const { loadConfig } = await import("../core/agents.js");
    const cfg = loadConfig([configPath]);
    const direct = resolveTiering({ cfg, chainName: "scout", prompt: "look around", servedOllamaTags: null, required: ["scout"] });
    assert.deepEqual(report.risk, direct.risk);
    assert.deepEqual(report.signals, direct.signals);
    assert.deepEqual(report.routing, direct.routing);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("27b: --agent is forwarded by conditional insertion, not a `?? \"\"` sentinel", async () => {
  const dir = tmpRepo("spf-estimate-agent-flag-");
  try {
    const configPath = writeConfig(
      dir,
      agentYaml("scout") + agentYaml("builder"),
      "tiering:\n  enabled: true\n  tiers:\n    - { name: t, coding_agent: flue, model: test/model-a }\n  roles:\n    scout: t\n    builder: t\n",
    );
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    await seedSession(tracer, "r1", "prompt", "success", [{ name: "builder", owner: "builder", tokens: 10 }], { tokens: 10, cost: 0 });
    await tracer.close();

    const withAgent = await runJson(["prompt", "hi", "--config", configPath, "--cwd", dir, "--no-probe", "--agent", "scout"]);
    assert.deepEqual(Object.keys(withAgent.report.routing), ["scout"], "--agent scout must route 'scout', not fall back to 'builder'");

    const withoutAgent = await runJson(["prompt", "hi", "--config", configPath, "--cwd", dir, "--no-probe"]);
    assert.deepEqual(
      Object.keys(withoutAgent.report.routing),
      ["builder"],
      "omitting --agent must leave chainOptions with no 'agent' key at all, so steps.ts's own `?? \"builder\"` default fires — not an empty-string sentinel that would resolve to [\"\"]",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("27c: a rule-T backend mismatch is reported, not thrown — exit 0, the role is omitted from routing, the note names validate()", async () => {
  const dir = tmpRepo("spf-estimate-ruleT-");
  try {
    const configPath = writeConfig(
      dir,
      agentYaml("scout", { coding_agent: "claude_code", model: "sonnet" }),
      "tiering:\n  enabled: true\n  tiers:\n    - { name: t, coding_agent: flue, model: ollama/granite4.1:8b }\n  roles:\n    scout: t\n",
    );
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    // At least one history row so this test isolates the rule-T behavior
    // from the separate "no history -> exit 3" case (test 23).
    await seedSession(tracer, "r1", "scout", "success", [{ name: "scout", owner: "scout", tokens: 10 }], { tokens: 10, cost: 0 });
    await tracer.close();

    const { code, report } = await runJson(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]);
    assert.equal(code, 0, "a config error is reported, never thrown — estimate gates on nothing but missing history");
    assert.equal(report.routing["scout"], undefined, "the mismatched role gets no routing entry");
    assert.ok(report.validate_error, "a real run of this config would fail agents.validate() at start");
    assert.match(report.validate_error!, /coding_agent: claude_code/);
    assert.match(report.validate_error!, /coding_agent: flue/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 28: --no-probe ───────────────────────────────────────────────────────────

test("28: --no-probe never calls fetch, and drops no ollama rung (servedOllamaTags: null, fail open)", async () => {
  const dir = tmpRepo("spf-estimate-noprobe-");
  try {
    const configPath = writeConfig(
      dir,
      agentYaml("scout", { model: "ollama/granite4.1:8b" }),
      "tiering:\n  enabled: true\n  tiers:\n    - { name: only, coding_agent: flue, model: ollama/granite4.1:8b }\n  roles:\n    scout: only\n",
    );
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    await seedSession(tracer, "r1", "scout", "success", [{ name: "scout", owner: "scout", tokens: 10 }], { tokens: 10, cost: 0 });
    await tracer.close();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("--no-probe must never call fetch");
    }) as typeof fetch;
    try {
      const { report } = await runJson(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]);
      assert.equal(report.routing["scout"]?.effective, "ollama/granite4.1:8b", "the ollama rung is not dropped — fail open, nothing probed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 29: --json shape ─────────────────────────────────────────────────────────

test("29: --json is a stable shape carrying the FULL routing map, not a diff", async () => {
  const dir = tmpRepo("spf-estimate-json-");
  try {
    const configPath = writeConfig(
      dir,
      agentYaml("scout", { model: "ollama/granite4.1:8b" }),
      "tiering:\n  enabled: true\n  tiers:\n    - { name: only, coding_agent: flue, model: ollama/granite4.1:8b }\n  roles:\n    scout: only\n",
    );
    const tracer = await Tracer.open(dbPathFor(dir), join(dir, ".spf", "data", "sessions", "events.jsonl"));
    await seedSession(tracer, "r1", "scout", "success", [{ name: "scout", owner: "scout", tokens: 10 }], { tokens: 10, cost: 0 });
    await tracer.close();

    const { report } = await runJson(["scout", "look around", "--config", configPath, "--cwd", dir, "--no-probe"]);
    for (const key of ["chain", "risk", "signals", "routing", "notes", "sample", "phases", "projected", "ceilings"]) {
      assert.ok(key in report, `--json must contain "${key}"`);
    }
    assert.equal(report.sample.n, "number" === typeof report.sample.n ? report.sample.n : NaN);
    assert.deepEqual(report.routing, { scout: { tier: "only", configured: "ollama/granite4.1:8b", effective: "ollama/granite4.1:8b" } });
    assert.ok("status" in report.sample && "joined_excluded" in report.sample && "fanout_collapsed" in report.sample);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
