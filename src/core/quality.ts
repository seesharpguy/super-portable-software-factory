/**
 * Deterministic lint, typecheck, build, and test blocks — configured, not
 * hardcoded. A known command is not a judgement call. Anything whose
 * invocation you can write down belongs here as code — it runs in
 * milliseconds, costs nothing, and returns the same answer every time.
 * Agents are for the parts that need reading and deciding.
 *
 * `quality.checks`/`quality.suites` in spf.config.yaml name the commands and
 * group them into what a chain actually runs. There is no packaged default
 * suite — an unconfigured suite fails at agents.validate() time, before
 * anything spawns, rather than silently reporting green the way a
 * placeholder echo command used to.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";
import type {
  EventRecord,
  Phase,
  QualityCheckResult,
  QualityCheckSpec,
  QualityConfig,
  QualityResult,
  VerifyOutputT,
} from "./data_types.ts";
import { VerifyOutput, makeEventRecord } from "./data_types.ts";
import { nowIso, operatorEnv } from "./utils.ts";

// How much of a failing command's output rides back inside the envelope. Enough
// for a builder to act on without opening the artifact; bounded so a runaway
// stack trace can't swamp the next agent's context.
const TAIL_CHARS = 4_000;

export class QualityNotConfigured extends Error {}

export interface RunLike {
  cfg: { quality: QualityConfig };
  phases: Phase[];
  context_handoff_dir: string;
  repo_root: string;
  console: { note: (message: string) => void };
  tracer: { event: (record: EventRecord) => string };
  adw_id: string;
}

/** Every suite name declared anywhere in `quality.suites`, checked names included. */
export function resolveSuite(run: RunLike, suiteName: string): QualityCheckSpec[] {
  const names = run.cfg.quality.suites[suiteName];
  if (!names || names.length === 0) {
    const known = Object.keys(run.cfg.quality.suites);
    throw new QualityNotConfigured(
      `quality.suites.${suiteName} is not configured — add it to spf.config.yaml` +
        (known.length > 0 ? ` (configured suites: ${known.join(", ")})` : " (no suites are configured yet)"),
    );
  }
  const specs: QualityCheckSpec[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const spec = run.cfg.quality.checks.find((c) => c.name === name);
    if (spec) specs.push(spec);
    else missing.push(name);
  }
  if (missing.length > 0) {
    throw new QualityNotConfigured(
      `quality.suites.${suiteName} names check(s) not in quality.checks: ${missing.join(", ")}`,
    );
  }
  return specs;
}

function checkDir(run: RunLike, name: string): string {
  const seq = run.phases.length > 0 ? run.phases[run.phases.length - 1].seq : 0;
  const dirPath = path.join(run.context_handoff_dir, "quality", `${String(seq).padStart(2, "0")}_${name}`);
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function shellJoin(argv: string[]): string {
  return argv
    .map((arg) => (/[\s"'$`\\!*?[\](){}<>|&;#~]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg))
    .join(" ");
}

function runCheck(spec: QualityCheckSpec, run: RunLike): QualityCheckResult {
  const phase = run.phases[run.phases.length - 1];
  const outputDir = checkDir(run, spec.name);
  const outputArtifact = path.join(outputDir, "command.log");
  const command = shellJoin(spec.argv);
  const env = operatorEnv(); // the engineer's own shell environment

  run.console.note(`quality ${spec.name}: ${command}`);
  const startedAt = nowIso();
  const clock = performance.now();
  let stdout = "";
  let stderr = "";
  let returncode: number;
  try {
    const completed = spawnSync(spec.argv[0], spec.argv.slice(1), {
      cwd: run.repo_root,
      env,
      encoding: "utf-8",
      timeout: spec.timeout_seconds * 1000,
    });
    if (completed.error && (completed.error as NodeJS.ErrnoException).code === "ENOENT") {
      // A missing binary lands here as exit 127 with the real message — no
      // pre-flight probe needed, and none wanted.
      returncode = 127;
      stderr = completed.error.message;
    } else if (completed.signal === "SIGTERM" && completed.status === null) {
      returncode = 124;
      stdout = completed.stdout || "";
      stderr = (completed.stderr || "") + `\nTimed out after ${spec.timeout_seconds}s.`;
    } else {
      returncode = completed.status ?? 1;
      stdout = completed.stdout || "";
      stderr = completed.stderr || "";
    }
  } catch (error) {
    returncode = 127;
    stderr = (error as Error).message;
  }

  const duration = (performance.now() - clock) / 1000;
  writeFileSync(
    outputArtifact,
    `$ ${command}\nexit: ${returncode}\nduration_seconds: ${duration.toFixed(3)}\n` +
      `\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
  );
  const passed = returncode === 0;
  run.tracer.event(
    makeEventRecord({
      adw_id: run.adw_id,
      phase_id: phase.phase_id,
      type: "tool_call",
      name: `quality:${spec.name}`,
      payload: {
        area: spec.area,
        operation: spec.operation,
        command,
        returncode,
        passed,
        output_artifact: outputArtifact,
      },
      started_at: startedAt,
      ended_at: nowIso(),
    }),
  );
  run.console.note(`quality ${spec.name}: ${passed ? "passed" : "failed"} (exit ${returncode}, ${duration.toFixed(1)}s)`);
  return {
    name: spec.name,
    area: spec.area,
    operation: spec.operation,
    command,
    returncode,
    passed,
    duration_seconds: duration,
    output_artifact: outputArtifact,
    output_tail: (stdout + stderr).slice(-TAIL_CHARS),
  };
}

/**
 * Run every check in a configured suite and collect ALL failures — one pass
 * tells you everything.
 *
 * Ordering contract for the caller: a failing check does NOT fail the phase.
 * The runner did its job; the CODE is what failed. Hand this result to the
 * builder and let the bounded repair loop decide the run's fate. Throws
 * QualityNotConfigured (via resolveSuite) if the suite or any of its checks
 * isn't in the config — before any check runs, let alone any agent spawns.
 */
export function runSuite(run: RunLike, suiteName: string): QualityResult {
  const specs = resolveSuite(run, suiteName);
  const checks = specs.map((spec) => runCheck(spec, run));
  // A failure is the command, its exit code, and what it actually printed —
  // everything a builder needs to repair without opening a log or being told
  // what the error "means" by a parser that guessed.
  const failures = checks
    .filter((check) => !check.passed)
    .map((check) => `${check.name}: \`${check.command}\` exited ${check.returncode}\n${check.output_tail}`.trimEnd());
  return {
    passed: failures.length === 0,
    checks,
    failures,
    artifacts: checks.map((check) => check.output_artifact),
  };
}

/**
 * The `test` suite alone — the deterministic test phase most chains use.
 *
 * This is what replaces a `tester` agent once the command is written down. An
 * agent rediscovering the runner on every run costs a fortune to learn what a
 * subprocess already knows; the repair loop is unchanged, because a failure
 * still reaches the builder through `asEnvelope` below.
 */
export function runTests(run: RunLike): QualityResult {
  return runSuite(run, "test");
}

/** Every configured check, across every configured suite's union — the `all` suite. */
export function runQuality(run: RunLike): QualityResult {
  return runSuite(run, "all");
}

/**
 * Log a deterministic block's verdict — the same shape every chain uses.
 *
 * Every quality/test phase in every chain reported this same summary by
 * hand; one copy here instead of one per chain.
 */
export function record(ph: { log: (payload: Record<string, unknown>) => void }, result: QualityResult): void {
  const passed = result.checks.filter((c) => c.passed).length;
  ph.log({ passed: result.passed, checks: `${passed}/${result.checks.length}`, artifacts: result.artifacts.join(", ") });
}

/**
 * Wrap a deterministic result so an agent can be handed it directly.
 *
 * Agents hand each other typed envelopes; code blocks return QualityResult.
 * This is the adapter, so a failing lint or test run flows back into the
 * builder through exactly the same door an agent's report would — the ADW
 * script is the only thing that knows the difference.
 */
export function asEnvelope(result: QualityResult, what: string): VerifyOutputT {
  return v.parse(VerifyOutput.schema, {
    status: result.passed ? "success" : "fail",
    summary: result.passed
      ? `${what}: all ${result.checks.length} check(s) passed`
      : `${what}: ${result.failures.length} of ${result.checks.length} check(s) failed`,
    artifacts: result.artifacts,
    notes_for_next_agent: result.passed
      ? ""
      : "Fix every failure below. The output is verbatim from the command — trust it over any summary.",
    passed: result.passed,
    failures: result.failures,
  });
}
