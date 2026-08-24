import "./hermetic_git.js";

/**
 * Regression test for a real production miss: `spf doctor` reported clean
 * on a config where `watch.chain: plan-build-test` (a BUILT-IN chain) needed
 * `quality.suites.test`, which was never configured at all — the daemon's
 * very first claimed issue then failed at runtime with "quality.suites.
 * \"test\" is not configured". The gap: `doctorCommand`'s "roster + suites
 * validate" check only validates suites already present in
 * `cfg.quality.suites`, and the repo-chain requirements loop only covers
 * chains with a `.source` (`.spf/chains/*.yaml`) — a built-in chain named by
 * `watch.chain` went through neither. See `checkChainRequirements()` in
 * `cli/commands/doctor.ts`, now called for `watch.chain`/`watch.refine.chain`
 * specifically, closing that gap.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorCommand } from "../cli/commands/doctor.js";
import { registerRepoChains } from "../chains/index.js";
import { loadRepoChains } from "../chains/repo_chains.js";
import * as paths from "../core/paths.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "spf-doctor-test-"));
}

/** Same helper `estimate.test.ts` uses — captures console output for the duration of `fn`, restoring it after, even if `fn` throws. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  console.error = () => {};
  console.warn = () => {};
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

interface DoctorReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string; severity?: "info" | "warn" }>;
}

/**
 * Config is written under `.spf/spf.config.yaml`, not passed via `--config`.
 * `resolveConfigPaths` treats an explicit `--config` path as "use exactly
 * this file, standalone" (no merge with the packaged built-in defaults) —
 * writing into `anchor.spf_dir` instead takes the `spf-dir` branch, which
 * merges the built-in roster (planner/builder/scout/refiner/reviewer/
 * documenter, ...) underneath this override, matching how a real `.spf/`
 * repo actually resolves its config.
 */
function writeSpfConfig(dir: string, yaml: string): void {
  mkdirSync(join(dir, ".spf"), { recursive: true });
  writeFileSync(join(dir, ".spf", "spf.config.yaml"), yaml);
}

async function runDoctor(dir: string): Promise<DoctorReport> {
  const { logs } = await captureConsole(() => doctorCommand(["--cwd", dir, "--json", "--no-probe"]));
  return JSON.parse(logs.join("\n")) as DoctorReport;
}

test("doctor: watch.chain naming a built-in chain (plan-build-test) with no quality.suites configured fails 'watch.chain \"plan-build-test\" suites', not just clean", async () => {
  const dir = tmpRepo();
  try {
    writeSpfConfig(dir, `watch:\n  repo: acme/widgets\n  chain: plan-build-test\n`);
    const report = await runDoctor(dir);

    const suitesCheck = report.checks.find((c) => c.name === 'watch.chain "plan-build-test" suites');
    assert.ok(suitesCheck, "expected a 'watch.chain \"plan-build-test\" suites' check to exist at all");
    assert.equal(suitesCheck!.ok, false);
    assert.match(suitesCheck!.detail, /unknown suite\(s\): test — not in cfg\.quality\.suites/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: the same check passes once quality.suites.test is configured with a real check", async () => {
  const dir = tmpRepo();
  try {
    writeSpfConfig(
      dir,
      `watch:\n  repo: acme/widgets\n  chain: plan-build-test\n` +
        `quality:\n  checks:\n    - {name: test, operation: build, argv: ["true"]}\n  suites:\n    test: [test]\n`,
    );
    const report = await runDoctor(dir);

    const suitesCheck = report.checks.find((c) => c.name === 'watch.chain "plan-build-test" suites');
    assert.ok(suitesCheck);
    assert.equal(suitesCheck!.ok, true, suitesCheck?.detail);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor: a repo-local chain's own owners/suites check is unaffected by the refactor into checkChainRequirements()", async () => {
  const dir = tmpRepo();
  try {
    const chainsDir = join(dir, ".spf", "chains");
    mkdirSync(chainsDir, { recursive: true });
    writeFileSync(
      join(chainsDir, "custom.yaml"),
      `name: custom\ndescribe: a minimal repo-local chain\nsteps:\n  - step: request\n  - step: scout\n`,
    );
    writeSpfConfig(dir, `watch:\n  repo: acme/widgets\n  chain: plan-build-test\n`);

    // `doctorCommand` itself never loads `.spf/chains/*.yaml` — only
    // `cli/index.ts`'s `main()` does, once, before any command dispatches
    // (see its own "Repo-local chains as DATA" comment). Mirror that exact
    // sequence here, and reset the module-level registry afterward — it's
    // process-global, so leaving "custom" registered would leak into every
    // later test in this same run.
    const anchor = paths.resolveAnchor(dir);
    const { chains, problems } = loadRepoChains(anchor);
    registerRepoChains(chains, problems);
    try {
      const report = await runDoctor(dir);
      const ownersCheck = report.checks.find((c) => c.name === 'repo chain "custom" owners');
      assert.ok(ownersCheck, "the repo-chain loop must still run for a .spf/chains/*.yaml chain");
      assert.equal(ownersCheck!.ok, true, ownersCheck?.detail);
    } finally {
      registerRepoChains([], []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
