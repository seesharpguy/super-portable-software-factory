import "./hermetic_git.ts";

/**
 * SPF #15 — the OpenSandbox adapter, 8.3a's "adapter-argument lane" (design
 * doc §8.3a): always runs, no real SDK, no network. `openSandboxDriver`/
 * `openSandboxFactory` are exercised against a hand-written fake module —
 * injected through the `SdkLoader` seam (§4.1) — so nothing here imports
 * `@alibaba-group/opensandbox` and nothing opens a socket.
 *
 * The fake's `commands.run` defaults to a REAL local shell rooted at a real
 * temp directory (mirroring `sandbox.test.ts`'s own `localTransport()`), so
 * the find-or-create tests exercise the actual preflight/seed git sequences
 * end to end — hermetic in the same sense the rest of this repo's git tests
 * are (no Docker, no network, a real local `git`/`tar`/`base64`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SandboxDiedError } from "@flue/runtime";
import type { SandboxSpec } from "../core/data_types.js";
import * as sandboxCore from "../core/sandbox.js";
import { loadOpenSandboxSdk, openSandboxDriver, openSandboxFactory, type OpenSandboxModule, type SdkLoader } from "../core/sandbox_opensandbox.js";
import type {
  OpenSandboxCommandOptions,
  OpenSandboxCommandResult,
  OpenSandboxCreateOptions,
  OpenSandboxExecutionHandlers,
  OpenSandboxInstance,
} from "../core/sandbox_sdk_types.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<SandboxSpec> = {}): SandboxSpec {
  return {
    backend: "opensandbox",
    adw_id: "run1",
    agent: "builder",
    lease_key: "run1/builder",
    scope: "agent",
    host_root: "/repo",
    // A real, already-existing directory — not "/workspace" (a placeholder
    // that only exists inside a real sandbox) — so the fakes' local-backed
    // `commands.run` (a real `bash -c` rooted here) never needs to create a
    // filesystem root directory it has no permission to create.
    workspace_dir: tmpdir(),
    handoff_host: "/repo/.spf/data/sessions/run1/context_handoff",
    handoff_sandbox: "/spf/handoff/sessions/run1/context_handoff",
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
    ...overrides,
  };
}

// ── a hand-written fake OpenSandbox module (no real SDK involved) ──────────

type RunFn = (
  command: string,
  options?: OpenSandboxCommandOptions,
  handlers?: OpenSandboxExecutionHandlers,
) => Promise<OpenSandboxCommandResult>;

const defaultLocalRun: RunFn = async (command, options) => {
  const requestedCwd = options?.workingDirectory ?? process.cwd();
  // Some tests pass an arbitrary/unwritable path (e.g. "/some/other/dir")
  // purely to assert the option-key mapping (cwd -> workingDirectory), not
  // to actually execute anything there — fall back to a real cwd rather
  // than crashing the fake on a permission/ENOENT error irrelevant to that
  // assertion (option capture already happened in runCalls, above `run()`).
  let cwd = requestedCwd;
  try {
    mkdirSync(cwd, { recursive: true });
  } catch {
    cwd = process.cwd();
  }
  const result = spawnSync("bash", ["-c", command], {
    cwd,
    env: options?.envs ? { ...process.env, ...options.envs } : process.env,
  });
  return {
    logs: {
      stdout: [{ text: (result.stdout ?? Buffer.alloc(0)).toString("utf-8") }],
      stderr: [{ text: (result.stderr ?? Buffer.alloc(0)).toString("utf-8") }],
    },
    exitCode: result.status ?? 1,
    executionTimeMs: 0,
  };
};

interface RunCallRecord {
  command: string;
  options?: OpenSandboxCommandOptions;
  hadHandlers: boolean;
}

interface FakeInstanceHandle {
  instance: OpenSandboxInstance;
  events: string[];
  runCalls: RunCallRecord[];
  setState: (state: string) => void;
}

function makeInstance(id: string, run: RunFn): FakeInstanceHandle {
  const events: string[] = [];
  const runCalls: RunCallRecord[] = [];
  // Capitalized, matching the real SDK's own `SandboxState` union
  // ("Creating" | "Running" | ...) — exercises the liveness comparison's
  // real casing rather than papering over a case-sensitivity bug.
  let state = "Running";
  const instance: OpenSandboxInstance = {
    id,
    commands: {
      run: async (command, options, handlers) => {
        runCalls.push({ command, options, hadHandlers: !!(handlers?.onStdout || handlers?.onStderr) });
        return run(command, options, handlers);
      },
    },
    files: {
      createDirectories: async (dirs) => {
        for (const d of dirs) mkdirSync(d.path, { recursive: true });
      },
      // Deliberately does NOT pre-create parents — matches the design's
      // "writeFile does not pre-create parents" contract for the driver
      // built over this fake (`sandbox-api.md:113`).
      writeFiles: async (files) => {
        for (const f of files) writeFileSync(f.path, typeof f.data === "string" ? f.data : Buffer.from(f.data));
      },
      readFile: async (p) => readFileSync(p, "utf-8"),
      search: async () => [],
      deleteDirectories: async (paths) => {
        for (const p of paths) rmSync(p, { recursive: true, force: true });
      },
    },
    getInfo: async () => ({ status: { state }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
    pause: async () => {},
    resume: async () => instance,
    renew: async () => {},
    kill: async () => {
      events.push("kill");
    },
    close: async () => {
      events.push("close");
    },
    getEndpoint: async (port) => ({ endpoint: `127.0.0.1:${port}` }),
    getEndpointUrl: async (port) => `http://127.0.0.1:${port}`,
    getEgressPolicy: async () => ({ defaultAction: "deny", egress: [] }),
    patchEgressRules: async () => {},
  };
  return { instance, events, runCalls, setState: (s) => (state = s) };
}

interface FakeSdk {
  module: OpenSandboxModule;
  createCalls: OpenSandboxCreateOptions[];
  instances: FakeInstanceHandle[];
}

function makeFakeSdk(options: { run?: RunFn } = {}): FakeSdk {
  const createCalls: OpenSandboxCreateOptions[] = [];
  const instances: FakeInstanceHandle[] = [];
  let counter = 0;
  const module: OpenSandboxModule = {
    Sandbox: {
      create: async (opts) => {
        createCalls.push(opts);
        counter += 1;
        const handle = makeInstance(`fake-${counter}`, options.run ?? defaultLocalRun);
        instances.push(handle);
        return handle.instance;
      },
    },
    SandboxManager: {
      create: async () => ({ listSandboxInfos: async () => ({ items: [] }), close: async () => {} }),
    },
  };
  return { module, createCalls, instances };
}

function loaderFor(fake: FakeSdk): SdkLoader {
  return async () => fake.module;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A `commands.run` that takes REAL (bounded) time to resolve — simulating a
 * remote command the driver's own timeout/liveness logic moves on from
 * without waiting for it. Deliberately never a promise that hangs forever:
 * node:test flags a promise still pending when a test's own callback
 * returns, so every test using this awaits past `delayMs` before finishing.
 */
function slowRun(delayMs: number): RunFn {
  return () => delay(delayMs).then(() => ({ logs: { stdout: [], stderr: [] }, exitCode: 0, executionTimeMs: delayMs }));
}

function git(args: string[], cwd: string): void {
  const r = spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${(r.stderr ?? Buffer.alloc(0)).toString("utf-8")}`);
}

/** A real temp git repo standing in for `host_root`, with real sibling temp dirs for workspace/scratch/handoff. */
function makeFixture(adwId: string): { root: string; spec: SandboxSpec } {
  const root = mkdtempSync(path.join(tmpdir(), "spf-sbx-os-fixture-"));
  const hostRoot = path.join(root, "host");
  mkdirSync(hostRoot, { recursive: true });
  git(["init", "-q"], hostRoot);
  writeFileSync(path.join(hostRoot, "f.txt"), "v1\n");
  git(["add", "-A"], hostRoot);
  git(["commit", "-q", "-m", "initial"], hostRoot);

  const workspace_dir = path.join(root, "sbx", "workspace");
  const scratch_dir = path.join(root, "sbx", "scratch");
  const handoff_sandbox = path.join(root, "sbx", "handoff");
  const handoff_host = path.join(root, "handoff-host");
  mkdirSync(workspace_dir, { recursive: true });
  mkdirSync(handoff_host, { recursive: true });

  const spec = makeSpec({
    host_root: hostRoot,
    workspace_dir,
    scratch_dir,
    handoff_sandbox,
    handoff_host,
    adw_id: adwId,
    lease_key: `${adwId}/builder`,
  });
  return { root, spec };
}

// ── the adapter -> SDK argument object (§8.3a) ─────────────────────────────

test("openSandboxDriver: Sandbox.create receives image/env/networkPolicy/metadata/timeoutSeconds/connectionConfig in the right fields", async () => {
  const fake = makeFakeSdk();
  const spec = makeSpec({
    image: "ghcr.io/example/debian-git:latest",
    env: { GH_TOKEN: "secret" },
    egress: { default: "deny", allow: ["example.com"] },
    lifetime_seconds: 1800,
    request_timeout_seconds: 500,
    opensandbox: { base_url: "http://127.0.0.1:8095", api_key_env: "OPENSANDBOX_API_KEY", use_server_proxy: true, metadata_prefix: "spf" },
  });
  const driver = openSandboxDriver(spec, loaderFor(fake));
  await driver.exec("true", { cwd: spec.workspace_dir });

  assert.equal(fake.createCalls.length, 1);
  const call = fake.createCalls[0]!;
  assert.equal(call.image, spec.image);
  assert.deepEqual(call.env, { GH_TOKEN: "secret" });
  assert.deepEqual(call.networkPolicy, { defaultAction: "deny", egress: [{ action: "allow", target: "example.com" }] });
  assert.equal(call.timeoutSeconds, 1800);
  assert.equal(call.connectionConfig.domain, "127.0.0.1:8095");
  assert.equal(call.connectionConfig.protocol, "http");
  assert.equal(call.connectionConfig.requestTimeoutSeconds, 500);
  assert.equal(call.connectionConfig.useServerProxy, true);
  assert.equal(call.metadata?.["spf.adw_id"], spec.adw_id);
  assert.equal(call.metadata?.["spf.agent"], spec.agent);
  // Sanitized, not verbatim: under the default `scope: agent`, lease_key is
  // "<adw_id>/<agent>" — see the label-validity test below for why.
  assert.equal(call.metadata?.["spf.lease_key"], "run1_builder");
});

test("openSandboxDriver: every metadata value is a valid Kubernetes label value — no '/', <=63 chars, alnum start/end (OpenSandbox validates this AT CREATE)", async () => {
  const fake = makeFakeSdk();
  // The default scope's lease_key shape, "<adw_id>/<agent>" — the exact
  // value the control plane rejected with HTTP 400 SANDBOX::INVALID_METADATA_LABEL.
  const spec = makeSpec({ adw_id: "adw_mt6knto3_1", agent: "smoke", lease_key: "adw_mt6knto3_1/smoke" });
  const driver = openSandboxDriver(spec, loaderFor(fake));
  await driver.exec("true", { cwd: spec.workspace_dir });
  const call = fake.createCalls[0]!;
  const labelValueRe = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;
  for (const [key, value] of Object.entries(call.metadata ?? {})) {
    assert.ok(labelValueRe.test(value), `metadata[${JSON.stringify(key)}] = ${JSON.stringify(value)} is not a valid label value`);
    assert.ok(value.length <= 63, `metadata[${JSON.stringify(key)}] exceeds 63 characters`);
  }
  assert.equal(call.metadata?.["spf.lease_key"], "adw_mt6knto3_1_smoke");
});

test("openSandboxDriver: readyTimeoutSeconds is raised past the SDK default when egress.default is deny, and skipHealthCheck stays unset", async () => {
  const fake = makeFakeSdk();
  const spec = makeSpec({ egress: { default: "deny", allow: [] }, lifetime_seconds: 3600 });
  const driver = openSandboxDriver(spec, loaderFor(fake));
  await driver.exec("true", { cwd: spec.workspace_dir });
  const call = fake.createCalls[0]!;
  assert.equal(call.readyTimeoutSeconds, 360, "max(120, lifetime_seconds/10) — a sidecar is in the create path");
  assert.equal(call.skipHealthCheck, undefined, "never used — skipping would misdirect a failure into the preflight");
});

test("openSandboxDriver: env_allowlist: [] resolves to an EMPTY create env — the operator environment must never reach it", async () => {
  process.env.SPF_FAKE_OS_SECRET = "leak-me-not";
  try {
    const fake = makeFakeSdk();
    const spec = makeSpec({ env: {} });
    const driver = openSandboxDriver(spec, loaderFor(fake));
    await driver.exec("true", { cwd: spec.workspace_dir });
    assert.deepEqual(fake.createCalls[0]!.env, {});
  } finally {
    delete process.env.SPF_FAKE_OS_SECRET;
  }
});

test("openSandboxDriver: two agents' distinct env_allowlists reach two distinct create calls, per agent", async () => {
  const fake = makeFakeSdk();
  const specA = makeSpec({ agent: "builder", lease_key: "run1/builder", env: { SPF_FAKE_A: "a" } });
  const specB = makeSpec({ agent: "reviewer", lease_key: "run1/reviewer", env: { SPF_FAKE_B: "b" } });
  await openSandboxDriver(specA, loaderFor(fake)).exec("true", { cwd: specA.workspace_dir });
  await openSandboxDriver(specB, loaderFor(fake)).exec("true", { cwd: specB.workspace_dir });
  assert.equal(fake.createCalls.length, 2);
  assert.deepEqual(fake.createCalls[0]!.env, { SPF_FAKE_A: "a" });
  assert.deepEqual(fake.createCalls[1]!.env, { SPF_FAKE_B: "b" });
});

test("loadOpenSandboxSdk: names the exact install command when the SDK is not installed", async () => {
  await assert.rejects(loadOpenSandboxSdk(), /npm i -g @alibaba-group\/opensandbox@0\.1\.11/);
});

// ── exec: the timeout convention (§3.1, §4.1 point 3) ──────────────────────

test("exec: timeoutMs is forwarded best-effort as whole seconds, ROUNDED UP, and is NEVER clamped to exec_timeout_seconds", async () => {
  const fake = makeFakeSdk();
  const spec = makeSpec({ exec_timeout_seconds: 5 });
  const driver = openSandboxDriver(spec, loaderFor(fake));
  await driver.exec("true", { cwd: spec.workspace_dir, timeoutMs: 12_500 });
  const call = fake.instances[0]!.runCalls[0]!;
  assert.equal(call.options?.timeoutSeconds, 13, "12500ms rounds UP to 13s and is not clamped down to exec_timeout_seconds=5");
});

test("exec: with NO timeoutMs, the driver supplies exec_timeout_seconds as the default deadline (a default, not dead config)", async () => {
  const fake = makeFakeSdk();
  const spec = makeSpec({ exec_timeout_seconds: 7 });
  const driver = openSandboxDriver(spec, loaderFor(fake));
  await driver.exec("true", { cwd: spec.workspace_dir });
  assert.equal(fake.instances[0]!.runCalls[0]!.options?.timeoutSeconds, 7);
});

test("exec: commands.run receives the SDK's own option keys (workingDirectory/envs/timeoutSeconds) — NOT cwd/env, which the real SDK silently ignores", async () => {
  const fake = makeFakeSdk();
  const spec = makeSpec();
  const driver = openSandboxDriver(spec, loaderFor(fake));
  await driver.exec("pwd", { cwd: "/some/other/dir", env: { FOO: "bar" } });
  const call = fake.instances[0]!.runCalls[0]!;
  assert.deepEqual(Object.keys(call.options ?? {}).sort(), ["envs", "timeoutSeconds", "workingDirectory"]);
  assert.equal((call.options as unknown as { workingDirectory?: string })?.workingDirectory, "/some/other/dir");
  assert.deepEqual((call.options as unknown as { envs?: Record<string, string> })?.envs, { FOO: "bar" });
});

test("exec: every commands.run call carries streaming ExecutionHandlers", async () => {
  const fake = makeFakeSdk();
  const spec = makeSpec();
  const driver = openSandboxDriver(spec, loaderFor(fake));
  await driver.exec("true", { cwd: spec.workspace_dir });
  assert.equal(fake.instances[0]!.runCalls[0]!.hadHandlers, true);
});

test("exec: timeoutMs expiry resolves exitCode 124 with the timeout on stderr, and never rejects", async () => {
  const fake = makeFakeSdk({ run: slowRun(200) }); // slower than the 20ms deadline below
  const spec = makeSpec();
  const driver = openSandboxDriver(spec, loaderFor(fake));
  const result = await driver.exec("sleep 999", { cwd: spec.workspace_dir, timeoutMs: 20 });
  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /timed out after 20ms/);
  await delay(250); // let the "orphaned" remote call actually finish before the test ends — nothing left pending
});

// ── liveness (design §4.1 point 4) ──────────────────────────────────────────

test(
  "liveness: a sandbox whose getInfo() reports a dead state rejects a pending exec with SandboxDiedError — never by listening for signal",
  { timeout: 15_000 },
  async () => {
    const fake = makeFakeSdk({ run: slowRun(6_000) }); // outlives the liveness poll interval (5s) so the death wins the race
    const spec = makeSpec();
    const driver = openSandboxDriver(spec, loaderFor(fake));

    // Force creation via a verb that never touches commands.run.
    await assert.rejects(driver.readFile("/does/not/exist"));
    fake.instances[0]!.setState("stopped");

    await assert.rejects(
      driver.exec("sleep 999", { cwd: spec.workspace_dir }),
      (err: unknown) => err instanceof SandboxDiedError,
    );
    await delay(6_500); // let the "orphaned" remote call actually finish before the test ends — nothing left pending
  },
);

// ── the measured `exists` defect this driver must not repeat (§4.1's boxed rule) ──

test("exists' documented defect: `test -e -- <path>` is a shell syntax error, not a valid existence check", () => {
  const r = spawnSync("bash", ["-c", "test -e -- /etc/hosts"]);
  assert.equal(r.status, 2, "the '--' spelling must fail as a binary-operator syntax error — the negative control the fix guards against");
});

test("exists: true for a real path, false (never throwing) for a missing one, true for a path with a space and a quote", async () => {
  const fake = makeFakeSdk();
  const dir = mkdtempSync(path.join(tmpdir(), "spf-sbx-exists-"));
  try {
    const spec = makeSpec({ workspace_dir: dir });
    const driver = openSandboxDriver(spec, loaderFor(fake));
    writeFileSync(path.join(dir, "f.txt"), "x");
    assert.equal(await driver.exists(path.join(dir, "f.txt")), true);
    assert.equal(await driver.exists(path.join(dir, "missing.txt")), false);

    const trickyDir = path.join(dir, "wei rd", "it's");
    mkdirSync(trickyDir, { recursive: true });
    writeFileSync(path.join(trickyDir, "a b.txt"), "x");
    assert.equal(await driver.exists(path.join(trickyDir, "a b.txt")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readdir: lists entry names for a real directory and throws for a non-directory or a missing path", async () => {
  const fake = makeFakeSdk();
  const dir = mkdtempSync(path.join(tmpdir(), "spf-sbx-readdir-"));
  try {
    writeFileSync(path.join(dir, "a.txt"), "1");
    writeFileSync(path.join(dir, "b.txt"), "2");
    const spec = makeSpec({ workspace_dir: dir });
    const driver = openSandboxDriver(spec, loaderFor(fake));
    const names = (await driver.readdir(dir)).sort();
    assert.deepEqual(names, ["a.txt", "b.txt"]);
    await assert.rejects(driver.readdir(path.join(dir, "a.txt")));
    await assert.rejects(driver.readdir(path.join(dir, "does-not-exist")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The driver issues GNU coreutils' `stat -c '%F|%s|%Y' -L` (design §4.1's
// table — the same debian-family assumption the mandatory git/tar/base64
// preflight already imposes). A dev machine's OWN local `stat` may be BSD
// (macOS), so this is a fake `run` emulating the GNU wire shape rather than
// a real local `stat` call — hermetic across platforms, not tied to
// whatever `stat` happens to be installed on the machine running the suite.
function gnuStatRun(byPath: Record<string, { type: string; size: number; mtimeEpochSeconds: number; isSymlink: boolean }>): RunFn {
  return async (command) => {
    for (const [p, info] of Object.entries(byPath)) {
      const quoted = `'${p}'`;
      if (command.startsWith("stat -c") && command.includes(quoted)) {
        return {
          logs: { stdout: [{ text: `${info.type}|${info.size}|${info.mtimeEpochSeconds}\n` }], stderr: [] },
          exitCode: 0,
          executionTimeMs: 0,
        };
      }
      if (command.startsWith("test -L") && command.includes(quoted)) {
        return { logs: { stdout: [{ text: "" }], stderr: [] }, exitCode: info.isSymlink ? 0 : 1, executionTimeMs: 0 };
      }
    }
    return { logs: { stdout: [{ text: "" }], stderr: [{ text: "unmapped command" }] }, exitCode: 1, executionTimeMs: 0 };
  };
}

test("stat: reports isFile/isDirectory/isSymbolicLink and never fabricates size/mtime", async () => {
  const filePath = "/ws/f.txt";
  const dirPath = "/ws";
  const linkPath = "/ws/link.txt";
  const fake = makeFakeSdk({
    run: gnuStatRun({
      [filePath]: { type: "regular file", size: 5, mtimeEpochSeconds: 1_700_000_000, isSymlink: false },
      [dirPath]: { type: "directory", size: 4096, mtimeEpochSeconds: 1_700_000_000, isSymlink: false },
      [linkPath]: { type: "regular file", size: 5, mtimeEpochSeconds: 1_700_000_000, isSymlink: true }, // -L dereferences: the TARGET's type
    }),
  });
  const spec = makeSpec();
  const driver = openSandboxDriver(spec, loaderFor(fake));

  const fileStat = await driver.stat(filePath);
  assert.equal(fileStat.isFile, true);
  assert.equal(fileStat.isDirectory, false);
  assert.equal(fileStat.isSymbolicLink, false);
  assert.equal(fileStat.size, 5);
  assert.ok(fileStat.mtime instanceof Date);

  const dirStat = await driver.stat(dirPath);
  assert.equal(dirStat.isDirectory, true);

  const linkStat = await driver.stat(linkPath);
  assert.equal(linkStat.isSymbolicLink, true, "test -L identifies the link itself");
  assert.equal(linkStat.isFile, true, "stat -L dereferences, so the TARGET's type is reported");
});

test("stat: an unparseable result omits size/mtime rather than fabricating 0 / new Date()", async () => {
  const fake = makeFakeSdk({
    run: async (command) => {
      if (command.includes("stat -c")) {
        return { logs: { stdout: [{ text: "regular file|not-a-number|also-not-a-number\n" }], stderr: [] }, exitCode: 0, executionTimeMs: 0 };
      }
      return { logs: { stdout: [{ text: "" }], stderr: [] }, exitCode: 1, executionTimeMs: 0 }; // test -L: not a symlink
    },
  });
  const spec = makeSpec();
  const driver = openSandboxDriver(spec, loaderFor(fake));
  const result = await driver.stat("/whatever");
  assert.equal(result.isFile, true);
  assert.equal(result.size, undefined);
  assert.equal(result.mtime, undefined);
});

test("rm: honors recursive/force with fs.rm-equivalent shell semantics", async () => {
  const fake = makeFakeSdk();
  const dir = mkdtempSync(path.join(tmpdir(), "spf-sbx-rm-"));
  try {
    const spec = makeSpec({ workspace_dir: dir });
    const driver = openSandboxDriver(spec, loaderFor(fake));

    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "sub", "a.txt"), "x");
    await assert.rejects(driver.rm(path.join(dir, "sub")), "a non-empty directory without recursive must fail");
    await driver.rm(path.join(dir, "sub"), { recursive: true });
    assert.equal(existsSync(path.join(dir, "sub")), false);

    await driver.rm(path.join(dir, "never-existed.txt"), { force: true }); // must not throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeFile: does NOT pre-create parent directories — the sandboxFromDriver wrapper's mkdir-retry owns that", async () => {
  const fake = makeFakeSdk();
  const dir = mkdtempSync(path.join(tmpdir(), "spf-sbx-write-"));
  try {
    const spec = makeSpec({ workspace_dir: dir });
    const driver = openSandboxDriver(spec, loaderFor(fake));
    await assert.rejects(driver.writeFile(path.join(dir, "nested", "out.txt"), "hi"), /ENOENT/);
    assert.equal(existsSync(path.join(dir, "nested")), false);
    await driver.writeFile(path.join(dir, "flat.txt"), "hi");
    assert.equal(readFileSync(path.join(dir, "flat.txt"), "utf-8"), "hi");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFileBuffer: round-trips raw bytes through base64 -w0, including a byte that is not valid standalone UTF-8", async () => {
  const fake = makeFakeSdk();
  const dir = mkdtempSync(path.join(tmpdir(), "spf-sbx-rfb-"));
  try {
    const spec = makeSpec({ workspace_dir: dir });
    const driver = openSandboxDriver(spec, loaderFor(fake));
    const bytes = Buffer.from([0x68, 0x65, 0xff, 0x00, 0x6c, 0x6c, 0x6f]);
    writeFileSync(path.join(dir, "bin.dat"), bytes);
    const read = await driver.readFileBuffer(path.join(dir, "bin.dat"));
    assert.deepEqual(Buffer.from(read), bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── openSandboxFactory: find-or-create against sandbox.ts's lease registry ─

test("openSandboxFactory: find-or-create issues exactly one create across repeated createSandbox({id}) calls; teardown calls kill() then close()", async () => {
  const { root, spec } = makeFixture("os-find-or-create");
  try {
    const fake = makeFakeSdk();
    const factory = openSandboxFactory(spec, loaderFor(fake));
    await factory.createSandbox({ id: "conv-1" });
    await factory.createSandbox({ id: "conv-2" });
    assert.equal(fake.createCalls.length, 1, "the SAME lease_key must issue exactly one create");

    const lease = sandboxCore.getLease(spec.lease_key);
    assert.ok(lease, "a lease must be registered after a successful create+seed");
    assert.equal(lease!.provider_id, fake.instances[0]!.instance.id);
    assert.deepEqual(lease!.flue_conversation_ids, ["conv-1", "conv-2"]);

    await sandboxCore.teardownRun(spec.adw_id);
    assert.deepEqual(fake.instances[0]!.events, ["kill", "close"], "kill THEN close, in that order — both required (the spike's caveat)");
    assert.equal(sandboxCore.getLease(spec.lease_key), undefined, "teardown must remove the lease");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openSandboxFactory: two different lease_keys issue two creates", async () => {
  // Two INDEPENDENT fixtures — two real sandboxes cannot share one workspace_dir any more than two real containers could.
  const a = makeFixture("os-two-keys-a");
  const b = makeFixture("os-two-keys-b");
  try {
    const fake = makeFakeSdk();
    await openSandboxFactory(a.spec, loaderFor(fake)).createSandbox({ id: "c1" });
    await openSandboxFactory(b.spec, loaderFor(fake)).createSandbox({ id: "c2" });
    assert.equal(fake.createCalls.length, 2);
    assert.notEqual(a.spec.lease_key, b.spec.lease_key);
  } finally {
    await sandboxCore.teardownRun(a.spec.adw_id);
    await sandboxCore.teardownRun(b.spec.adw_id);
    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  }
});

test("openSandboxFactory: the mandatory git/tar/base64 preflight failing produces a named error and leaves no lease, no leaked native sandbox", async () => {
  const { root, spec } = makeFixture("os-preflight-fail");
  try {
    const fake = makeFakeSdk({
      run: async () => ({ logs: { stdout: [{ text: "" }], stderr: [{ text: "not found" }] }, exitCode: 127, executionTimeMs: 0 }),
    });
    await assert.rejects(openSandboxFactory(spec, loaderFor(fake)).createSandbox({ id: "c1" }), /missing git, tar, or base64/);
    assert.equal(sandboxCore.getLease(spec.lease_key), undefined);
    assert.deepEqual(fake.instances[0]!.events, ["kill", "close"], "the native sandbox must not be leaked when preflight fails");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openSandboxFactory: a throwing Sandbox.create surfaces a named error, not a hang", async () => {
  const spec = makeSpec({ adw_id: "os-throwing-create", lease_key: "os-throwing-create/builder" });
  const fake: FakeSdk = {
    module: {
      Sandbox: {
        create: async () => {
          throw new Error("boom: control plane unreachable");
        },
      },
      SandboxManager: { create: async () => ({ listSandboxInfos: async () => ({ items: [] }), close: async () => {} }) },
    },
    createCalls: [],
    instances: [],
  };
  await assert.rejects(openSandboxFactory(spec, loaderFor(fake)).createSandbox({ id: "c1" }), /boom: control plane unreachable/);
  assert.equal(sandboxCore.getLease(spec.lease_key), undefined);
});

test("openSandboxFactory: a throwing Sandbox.create still revokes a grant that was already issued — there is no native sandbox yet to hang the revoke off of", async () => {
  const spec = makeSpec({ adw_id: "os-throwing-create-revoke", lease_key: "os-throwing-create-revoke/builder" });
  const fake: FakeSdk = {
    module: {
      Sandbox: {
        create: async () => {
          throw new Error("boom: control plane unreachable");
        },
      },
      SandboxManager: { create: async () => ({ listSandboxInfos: async () => ({ items: [] }), close: async () => {} }) },
    },
    createCalls: [],
    instances: [],
  };
  const fb = makeFakeBroker();
  await assert.rejects(
    openSandboxFactory(spec, loaderFor(fake), fb.broker).createSandbox({ id: "c1" }),
    /boom: control plane unreachable/,
  );
  assert.equal(sandboxCore.getLease(spec.lease_key), undefined);
  assert.equal(fb.issueCalls, 1, "the grant was issued before Sandbox.create ran");
  assert.equal(fb.revokeCalls, 1, "a throwing create() must not strand the grant it was issued for");
});

// ── credential broker ordering (SPF #15 PR B, design §11's PR B test list) ──

/**
 * Records every `issue()` call and lets the test control the returned
 * grant's `env`/`describe`/`revoke` independently — a fake broker is the
 * only way to prove `issue()` happens INSIDE `createSandbox`'s MISS branch,
 * exactly once per lease, and never again on a HIT (§6.1).
 */
function makeFakeBroker(): {
  broker: sandboxCore.CredentialBroker;
  issueCalls: number;
  revokeCalls: number;
  lastGrant: sandboxCore.CredentialGrant | null;
} {
  const state = { issueCalls: 0, revokeCalls: 0, lastGrant: null as sandboxCore.CredentialGrant | null };
  const broker: sandboxCore.CredentialBroker = {
    id: "fake-test-broker",
    async issue(spec) {
      state.issueCalls += 1;
      const grant: sandboxCore.CredentialGrant = {
        env: { ...spec.env, FAKE_BROKER_KEY: "issued-by-fake-broker" },
        describe: () => "fake broker grant",
        revoke: async () => {
          state.revokeCalls += 1;
        },
      };
      state.lastGrant = grant;
      return grant;
    },
  };
  return { broker, get issueCalls() { return state.issueCalls; }, get revokeCalls() { return state.revokeCalls; }, get lastGrant() { return state.lastGrant; } };
}

test("openSandboxFactory: broker.issue(spec) happens INSIDE createSandbox's MISS branch, before Sandbox.create, and its env reaches the create call", async () => {
  const { root, spec } = makeFixture("os-broker-order");
  try {
    const fake = makeFakeSdk();
    const fb = makeFakeBroker();
    await openSandboxFactory(spec, loaderFor(fake), fb.broker).createSandbox({ id: "c1" });
    assert.equal(fb.issueCalls, 1, "issue() must be called exactly once for a fresh lease");
    assert.equal(fake.createCalls.length, 1);
    assert.deepEqual(fake.createCalls[0]!.env, { ...spec.env, FAKE_BROKER_KEY: "issued-by-fake-broker" }, "Sandbox.create must receive the GRANT's env, not spec.env directly");
  } finally {
    await sandboxCore.teardownRun(spec.adw_id);
    rmSync(root, { recursive: true, force: true });
  }
});

test("openSandboxFactory: repeated createSandbox({id}) calls for the SAME lease issue exactly ONE broker.issue() — the HIT branch never re-issues", async () => {
  const { root, spec } = makeFixture("os-broker-no-reissue");
  try {
    const fake = makeFakeSdk();
    const fb = makeFakeBroker();
    const factory = openSandboxFactory(spec, loaderFor(fake), fb.broker);
    await factory.createSandbox({ id: "conv-1" });
    await factory.createSandbox({ id: "conv-2" });
    await factory.createSandbox({ id: "conv-3" });
    assert.equal(fb.issueCalls, 1, "three createSandbox calls against the same lease_key must issue exactly one grant");
    assert.equal(fake.createCalls.length, 1);
  } finally {
    await sandboxCore.teardownRun(spec.adw_id);
    rmSync(root, { recursive: true, force: true });
  }
});

test("openSandboxFactory: credentials:revoke sits at position 2 and still runs when kill() throws (the real chain, not a fake TeardownStep)", async () => {
  const { root, spec } = makeFixture("os-broker-revoke-on-kill-throw");
  try {
    const fake = makeFakeSdk();
    const fb = makeFakeBroker();
    const factory = openSandboxFactory(spec, loaderFor(fake), fb.broker);
    await factory.createSandbox({ id: "c1" });

    const lease = sandboxCore.getLease(spec.lease_key)!;
    assert.equal(lease.teardown[0]!.name, "provider:kill");
    assert.equal(lease.teardown[1]!.name, "credentials:revoke");

    // Make the native sandbox's kill() throw AFTER create — proving revoke
    // still runs even though the step ahead of it in the chain failed.
    fake.instances[0]!.instance.kill = async () => {
      throw new Error("kill failed: provider unreachable");
    };

    await sandboxCore.teardownRun(spec.adw_id);
    assert.equal(fb.revokeCalls, 1, "credentials:revoke (position 2) must still run when kill() (position 1) throws");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openSandboxFactory: a preflight failure after broker.issue() still revokes the grant — no lease and no teardown chain exists yet to fall back on", async () => {
  const { root, spec } = makeFixture("os-broker-revoke-on-preflight-fail");
  try {
    const fake = makeFakeSdk({
      run: async () => ({ logs: { stdout: [{ text: "" }], stderr: [{ text: "not found" }] }, exitCode: 127, executionTimeMs: 0 }),
    });
    const fb = makeFakeBroker();
    await assert.rejects(
      openSandboxFactory(spec, loaderFor(fake), fb.broker).createSandbox({ id: "c1" }),
      /missing git, tar, or base64/,
    );
    assert.equal(sandboxCore.getLease(spec.lease_key), undefined, "a failed MISS branch must not leave a lease behind");
    assert.equal(fb.issueCalls, 1, "the grant was issued before preflight ran");
    assert.equal(fb.revokeCalls, 1, "a live credential must never be stranded behind a dead sandbox");
    assert.deepEqual(fake.instances[0]!.events, ["kill", "close"], "the native sandbox must not be leaked either");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
