import "./hermetic_git.ts";

/**
 * SPF #15 PR B — real dispatch coverage for `sandbox.fanout: "sandbox"`
 * through the ACTUAL `spf fanout` CLI path, over REAL git worktrees.
 * `registerRepoChains` plugs in a fake chain via `ChainDefinition.run` — the
 * SAME imperative escape hatch `run_sandbox_wiring.test.ts` uses for `spf
 * run` — so no real agent/LLM is involved, while `withRunWorktree`,
 * `withRunScope`, and the lease registry are all REAL. This is what proves
 * the wrap PR A already shipped (`cli/commands/fanout.ts`'s `runAttempt`,
 * §4.3) plus PR B's one line of printed posture (§5.5) actually fire on the
 * real dispatch path, over real derived `<base>-<i>` adw_ids — not just in
 * the lower-level, controlled-overlap tests in `sandbox_fanout.test.ts`.
 *
 * `src/core/fanout.ts` is UNMODIFIED — this file exercises the CLI wiring
 * around it, never that module itself.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fanoutCommand } from "../cli/commands/fanout.ts";
import { registerRepoChains, type ChainDefinition } from "../chains/index.ts";
import * as sandbox from "../core/sandbox.ts";
import type { SandboxTransport } from "../core/sandbox.ts";
import type { SandboxSpec } from "../core/data_types.ts";
import { attemptAdwId } from "../core/fanout.ts";

/** Same helper `fanout_cli.test.ts` and `estimate.test.ts` use. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    const result = await fn();
    return { result, logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

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

/**
 * `spf fanout` keys its worktree/data directory on `path.basename(anchor.repo_root)`
 * under `~/.spf/fanout/` (cli/commands/fanout.ts), NOT under the mkdtemp'd
 * repo dir itself — so removing the repo dir alone leaves an empty
 * `~/.spf/fanout/<basename>/` behind on every run, accumulating unboundedly
 * across CI/local runs. Clean up both.
 */
function cleanupFanoutDataDir(repoDir: string): void {
  rmSync(path.join(homedir(), ".spf", "fanout", path.basename(repoDir)), { recursive: true, force: true });
}

/** A real repo with one commit on a branch literally named "main" — regardless of this machine's `init.defaultBranch`. */
function initRepo(dir: string): void {
  git(["init", "-q"], dir);
  git(["checkout", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@example.com"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  git(["add", "-A"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

/**
 * A fake `ChainDefinition` whose `phases` string satisfies `hasCommitStep`
 * (`git(commit`) and whose `run()` does two things per attempt: registers a
 * FAKE lease under the ATTEMPT'S OWN derived adw_id — the shape a real
 * adapter's `createSandbox` MISS branch leaves behind — and makes a REAL git
 * commit in the attempt's OWN worktree, so a winner really does carry real
 * work. `failIndex`, when set, makes exactly that attempt's `run()` throw.
 */
function makeFakeChain(opts: { failIndex?: number; runsByAdwId: Map<string, number> }): ChainDefinition {
  return {
    name: "fake-sandbox-fanout-chain",
    describe: "test-only: fan-out through sandboxes, no real agent involved",
    phases: "engineer(request) -> builder -> git(commit)",
    requiredAgents: ["builder"],
    requiredSuites: [],
    run: async (ctx) => {
      const adwId = ctx.adw_id!;
      opts.runsByAdwId.set(adwId, (opts.runsByAdwId.get(adwId) ?? 0) + 1);
      sandbox.registerLease(`${adwId}/builder`, fakeSpec(adwId, ctx.cwd), NOOP_TRANSPORT);

      const index = Number(adwId.split("-").pop());
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

function writeConfig(dir: string, sandboxYaml: string): void {
  mkdirSync(path.join(dir, ".spf"), { recursive: true });
  writeFileSync(path.join(dir, ".spf", "spf.config.yaml"), sandboxYaml);
}

test("spf fanout: sandbox.fanout: \"sandbox\" — a winner's branch carries a REAL commit, every attempt's own lease (keyed by ITS OWN derived adw_id) is torn down, and the §5.5 posture line prints", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-fanout-sbx-e2e-"));
  const runsByAdwId = new Map<string, number>();
  const chain = makeFakeChain({ runsByAdwId });
  try {
    initRepo(dir);
    writeConfig(dir, "sandbox:\n  backend: opensandbox\n  fanout: sandbox\n  image: debian-git\n  opensandbox:\n    base_url: http://127.0.0.1:8090\n");
    registerRepoChains([chain], []);

    const baseAdwId = "e2ebase1";
    const { result, logs } = await captureConsole(() =>
      fanoutCommand([chain.name, "do the thing", "--cwd", dir, "--n", "2", "--adw-id", baseAdwId]),
    );

    assert.equal(result, 0, `expected a winner; logs:\n${logs.join("\n")}`);
    const idA = attemptAdwId(baseAdwId, 1);
    const idB = attemptAdwId(baseAdwId, 2);
    assert.deepEqual(new Set(runsByAdwId.keys()), new Set([idA, idB]), "the chain must see each attempt's OWN derived adw_id, exactly the two expected");

    // The §5.5 posture line — present, and NOT confused with the
    // accountability line it must never move or replace.
    assert.ok(logs.some((l) => l.includes("attempts ran in opensandbox sandboxes; branch is local")), `expected the posture line; got:\n${logs.join("\n")}`);
    assert.ok(logs.some((l) => l.includes("SPF does not merge the winner — you do")), "the accountability line must still print, byte-identical");

    // The winner's branch carries a REAL commit made inside its own attempt.
    const winnerLine = logs.find((l) => l.trimStart().startsWith("winner:"));
    assert.ok(winnerLine, `expected a winner: line; got:\n${logs.join("\n")}`);
    const winnerAdwId = winnerLine!.match(/winner:\s+(\S+)/)?.[1];
    assert.ok(winnerAdwId === idA || winnerAdwId === idB);
    const winnerBranch = `spf/fanout/${winnerAdwId}`;
    const log = execFileSync("git", ["log", "--format=%s", winnerBranch], { cwd: dir, encoding: "utf-8" });
    assert.ok(log.includes(`attempt ${winnerAdwId}`), `expected the winner branch's log to include its own attempt commit; got:\n${log}`);

    // Every lease this run created — for BOTH attempts — is gone: sandboxing
    // is tied to the RUN completing, not to which attempt won.
    assert.equal(sandbox.leases().filter((l) => l.spec.adw_id === idA || l.spec.adw_id === idB).length, 0, "both attempts' fake leases must be torn down, winner included");
  } finally {
    registerRepoChains([], []);
    await sandbox.teardownRun(attemptAdwId("e2ebase1", 1));
    await sandbox.teardownRun(attemptAdwId("e2ebase1", 2));
    // The winner's worktree/branch live under `~/.spf/fanout/...`
    // (`fanoutCommand`'s own `worktreesDir`, NOT under `dir`) — clean up
    // with the command's own designed tool rather than reimplementing its
    // removal logic here.
    await captureConsole(() => fanoutCommand(["--clean", "e2ebase1", "--cwd", dir]));
    rmSync(dir, { recursive: true, force: true });
    cleanupFanoutDataDir(dir);
  }
});

test("spf fanout: sandbox.fanout: \"sandbox\" — a FAILED attempt's lease is torn down too, and does not win", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-fanout-sbx-fail-"));
  const runsByAdwId = new Map<string, number>();
  const chain = makeFakeChain({ failIndex: 2, runsByAdwId });
  try {
    initRepo(dir);
    writeConfig(dir, "sandbox:\n  backend: opensandbox\n  fanout: sandbox\n  image: debian-git\n  opensandbox:\n    base_url: http://127.0.0.1:8090\n");
    registerRepoChains([chain], []);

    const baseAdwId = "e2efail1";
    const idA = attemptAdwId(baseAdwId, 1);
    const idB = attemptAdwId(baseAdwId, 2);
    const { result, logs } = await captureConsole(() =>
      fanoutCommand([chain.name, "do the thing", "--cwd", dir, "--n", "2", "--adw-id", baseAdwId]),
    );

    assert.equal(result, 0, `attempt 1 must still win despite attempt 2 failing; logs:\n${logs.join("\n")}`);
    const winnerLine = logs.find((l) => l.trimStart().startsWith("winner:"));
    assert.ok(winnerLine?.includes(idA), `expected attempt 1 (${idA}) to win; got:\n${winnerLine}`);

    assert.equal(sandbox.getLease(`${idB}/builder`), undefined, "the FAILED attempt's lease must still be torn down");
    assert.equal(sandbox.getLease(`${idA}/builder`), undefined, "the winner's lease is torn down too — sandboxing ends with the run, not with losing");
  } finally {
    registerRepoChains([], []);
    await sandbox.teardownRun(attemptAdwId("e2efail1", 1));
    await sandbox.teardownRun(attemptAdwId("e2efail1", 2));
    await captureConsole(() => fanoutCommand(["--clean", "e2efail1", "--cwd", dir]));
    rmSync(dir, { recursive: true, force: true });
    cleanupFanoutDataDir(dir);
  }
});

test("spf fanout: printed contract is UNCHANGED when sandbox.fanout is left at its \"worktree\" default — no posture line, nothing else moved", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "spf-fanout-sbx-off-"));
  const runsByAdwId = new Map<string, number>();
  const chain = makeFakeChain({ runsByAdwId });
  try {
    initRepo(dir);
    // No sandbox: block at all — backend: local, fanout: worktree, both
    // defaults. Written explicitly (rather than skipping `.spf/` entirely)
    // to match the other two tests' config-resolution path.
    writeConfig(dir, "# no sandbox block — defaults apply\n");
    registerRepoChains([chain], []);

    const baseAdwId = "e2eoff01";
    const { result, logs } = await captureConsole(() =>
      fanoutCommand([chain.name, "do the thing", "--cwd", dir, "--n", "2", "--adw-id", baseAdwId]),
    );

    assert.equal(result, 0, `logs:\n${logs.join("\n")}`);
    assert.ok(!logs.some((l) => l.includes("sandboxes; branch is local")), "the posture line must NOT print when nothing is sandboxed");
    assert.ok(logs.some((l) => l.includes("SPF does not merge the winner — you do")), "the accountability line is unaffected either way");
  } finally {
    registerRepoChains([], []);
    await sandbox.teardownRun(attemptAdwId("e2eoff01", 1));
    await sandbox.teardownRun(attemptAdwId("e2eoff01", 2));
    await captureConsole(() => fanoutCommand(["--clean", "e2eoff01", "--cwd", dir]));
    rmSync(dir, { recursive: true, force: true });
    cleanupFanoutDataDir(dir);
  }
});
