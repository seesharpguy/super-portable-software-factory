/**
 * Deterministic lint, typecheck, build, and test blocks.
 *
 * A known command is not a judgement call. Anything whose invocation you can write
 * down belongs here as code — it runs in milliseconds, costs nothing, and returns
 * the same answer every time. Agents are for the parts that need reading and
 * deciding.
 *
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  REPLACE THE PLACEHOLDER COMMANDS BELOW.                                     ║
 * ║                                                                              ║
 * ║  Every block ships as an `echo` that exits 0 and announces it is fake. They   ║
 * ║  are placeholders on purpose: a stamped repo has no way to guess your test    ║
 * ║  runner, and a wrong-but-plausible command that silently passes is worse      ║
 * ║  than one that says so out loud.                                             ║
 * ║                                                                              ║
 * ║  For each block you want: swap `placeholder(...)` for the real argv, e.g.    ║
 * ║      argv: ["bun", "test", "apps/web/server.test.ts"]                        ║
 * ║      argv: ["bun", "x", "vitest", "run"]                                     ║
 * ║      argv: ["npm", "run", "lint"]                                            ║
 * ║  Delete the blocks you don't need, and drop them from runQuality()'s list.    ║
 * ║                                                                              ║
 * ║  Two rules when you write the real command:                                  ║
 * ║    1. argv LIST, never a shell string — no quoting bugs, no shell injection.  ║
 * ║    2. Call binaries by BARE NAME. These blocks inherit the operator's         ║
 * ║       environment (see utils.operatorEnv), so `bun`, `npm`, `pytest` resolve  ║
 * ║       exactly as they do in their terminal. Never hard-code an absolute path  ║
 * ║       like /Users/you/.bun/bin/bun — that bakes your machine into the trace.  ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
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
  QualityResult,
  VerifyOutputT,
} from "./data_types.ts";
import { VerifyOutput, makeEventRecord } from "./data_types.ts";
import { nowIso, operatorEnv } from "./utils.ts";

// How much of a failing command's output rides back inside the envelope. Enough
// for a builder to act on without opening the artifact; bounded so a runaway
// stack trace can't swamp the next agent's context.
const TAIL_CHARS = 4_000;

/** A command that does nothing and admits it. Replace every call to this. */
function placeholder(name: string): string[] {
  return [
    "echo",
    `PLACEHOLDER ${name}: edit adws/adw_modules/quality.ts and replace this echo with the real ${name} command`,
  ];
}

interface RunLike {
  phases: Phase[];
  context_handoff_dir: string;
  repo_root: string;
  console: { note: (message: string) => void };
  tracer: { event: (record: EventRecord) => string };
  adw_id: string;
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

// ── Blocks ────────────────────────────────────────────────────────────────────
// Replace every argv below. See the banner at the top of this file.

/** Run the project's test suite. The highest-value block to wire up first. */
export function test(run: RunLike): QualityCheckResult {
  return runCheck(
    {
      name: "test",
      area: "backend",
      operation: "build",
      argv: placeholder("test"), // e.g. ["bun", "test"]
      timeout_seconds: 600,
    },
    run,
  );
}

export function lint(run: RunLike): QualityCheckResult {
  return runCheck(
    {
      name: "lint",
      area: "backend",
      operation: "lint",
      argv: placeholder("lint"), // e.g. ["bun", "x", "oxlint@1.36.0", "src"]
      timeout_seconds: 120,
    },
    run,
  );
}

export function typecheck(run: RunLike): QualityCheckResult {
  return runCheck(
    {
      name: "typecheck",
      area: "backend",
      operation: "typecheck",
      argv: placeholder("typecheck"), // e.g. ["bun", "x", "tsc", "--noEmit"]
      timeout_seconds: 120,
    },
    run,
  );
}

export function build(run: RunLike): QualityCheckResult {
  // @ts-expect-error — pre-existing: computed for the placeholder comment below
  // but never passed through. `build()` is deleted entirely in the config-driven
  // quality.ts rewrite (chains lose their hardcoded quality blocks), so this is
  // left as-is rather than fixed in a file about to be replaced wholesale.
  const outputDir = path.join(checkDir(run, "build"), "bundle");
  return runCheck(
    {
      name: "build",
      area: "backend",
      operation: "build",
      argv: placeholder("build"), // e.g. ["bun", "build", "src/index.ts", "--outdir", outputDir]
      timeout_seconds: 120,
    },
    run,
  );
}

/**
 * The test suite alone, as a QualityResult — the deterministic test phase.
 *
 * This is what replaces a `tester` agent once the command is written down. An
 * agent rediscovering the runner on every run costs a fortune to learn what a
 * subprocess already knows; the repair loop is unchanged, because a failure
 * still reaches the builder through `asEnvelope` below.
 */
export function runTests(run: RunLike): QualityResult {
  const check = test(run);
  const failures = check.passed
    ? []
    : [`${check.name}: \`${check.command}\` exited ${check.returncode}\n${check.output_tail}`.trimEnd()];
  return { passed: check.passed, checks: [check], failures, artifacts: [check.output_artifact] };
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

/**
 * Run every block and collect ALL failures — one pass tells you everything.
 *
 * Ordering contract for the caller: a failing block does NOT fail the phase.
 * The runner did its job; the CODE is what failed. Hand this result to the
 * builder and let the bounded repair loop decide the run's fate.
 */
export function runQuality(run: RunLike): QualityResult {
  const blocks = [test, lint, typecheck, build];
  const checks = blocks.map((block) => block(run));
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
