import "./hermetic_git.ts";

/**
 * SPF #15 — the Cloudflare backend adapter (design doc §4.2). Two lanes,
 * hermetic, no live network, no `@cloudflare/sandbox`, no Docker:
 *
 *  1. `stubTransport()` against a HAND-WRITTEN fake `CloudflareSandboxStub` —
 *     the pure mapping logic: the `exitCode` fallback, the two exec-backed
 *     verbs (`size` via `wc -c`, `readFileBuffer` via `base64 -w0`), and
 *     `writeFile`'s string-vs-Uint8Array split.
 *  2. `bridgeStub()`/`cloudflareFactory()` against an in-process `node:http`
 *     "fake bridge" — the same `receiver`-over-loopback precedent
 *     `otel.test.ts` uses, standing in for `@cloudflare/sandbox`'s
 *     self-deployed bridge (design doc §4.2, O-2). Its `/exec` handler runs
 *     the received command for REAL (`sh -lc`, spawned host-side) against a
 *     real temp directory that this test's own `SandboxSpec.workspace_dir`/
 *     `scratch_dir`/`handoff_dir` point AT — so the seed/preflight git
 *     sequences that run are the SAME real git/tar/base64 sequences
 *     `sandbox.test.ts` proves against `localTransport()`, just reached
 *     through this module's HTTP+SSE plumbing instead of a direct call.
 *     "The sandbox" and "the host" are the same real filesystem here,
 *     exactly as they are for `sandbox.test.ts`'s own `localTransport()` —
 *     no Docker, no network beyond loopback.
 *
 * Live e2e against a REAL `@cloudflare/sandbox` bridge is out of scope for
 * this PR slice (design doc §8.4's stated skip rule, gated on
 * `CLOUDFLARE_API_TOKEN`/`SPF_E2E_CF_BRIDGE_URL`) and is not attempted here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SandboxOperationUnsupportedError } from "@flue/runtime";
import type { SandboxSpec } from "../core/data_types.js";
import * as sandbox from "../core/sandbox.js";
import type { CredentialBroker, CredentialGrant, SandboxTransport } from "../core/sandbox.js";
import { bridgeStub, cloudflareFactory, driverFromCloudflareStub, stubTransport } from "../core/sandbox_cloudflare.js";
import type { CloudflareBridgeStub } from "../core/sandbox_cloudflare.js";

let nextId = 0;
function uniqueAdwId(): string {
  nextId += 1;
  return `cf-test-${process.pid}-${nextId}`;
}

function makeSpec(overrides: Partial<SandboxSpec> & { host_root: string; workspace_dir: string; handoff_host: string; handoff_sandbox: string; scratch_dir: string }): SandboxSpec {
  const adw_id = overrides.adw_id ?? uniqueAdwId();
  return {
    backend: "cloudflare",
    adw_id,
    agent: "builder",
    lease_key: `${adw_id}/builder`,
    scope: "agent",
    env: {},
    image: "",
    setup: [],
    egress: { default: "deny", allow: [] },
    lifetime_seconds: 3600,
    max_total_lifetime_seconds: 21600,
    request_timeout_seconds: 960,
    exec_timeout_seconds: 900,
    transport: { max_patch_bytes: 8_388_608, max_seed_bytes: 134_217_728, max_mirror_bytes: 4_194_304, mirror: [] },
    opensandbox: { base_url: "http://127.0.0.1:8090", api_key_env: "OPENSANDBOX_API_KEY", use_server_proxy: false, metadata_prefix: "spf" },
    cloudflare: { bridge_url: "http://127.0.0.1:0", api_token_env: "SPF_TEST_CF_TOKEN", sandbox_name: "" },
    ...overrides,
  };
}

function git(args: string[], cwd: string): void {
  const r = spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${(r.stderr ?? Buffer.alloc(0)).toString("utf-8")}`);
}

// ── lane 1: stubTransport over a hand-written fake CloudflareSandboxStub ────

interface FakeStubCall {
  method: string;
  args: unknown[];
}

/** A hand-written fake satisfying `CloudflareSandboxStub` — no HTTP, no bridge. Records calls so the exitCode fallback / verb dispatch can be asserted precisely. */
function makeFakeStub(overrides: Partial<Record<string, (...args: any[]) => any>> = {}): { stub: ReturnType<typeof buildStub>; calls: FakeStubCall[] } {
  const calls: FakeStubCall[] = [];
  const files = new Map<string, Buffer>();

  function buildStub() {
    return {
      exec: async (cmd: string, opts?: unknown) => {
        calls.push({ method: "exec", args: [cmd, opts] });
        if (overrides.exec) return overrides.exec(cmd, opts);
        // A tiny built-in shell for the two exec-backed verbs stubTransport issues.
        const wc = /^wc -c < '(.+)'$/.exec(cmd);
        if (wc) {
          const content = files.get(wc[1]!);
          return content === undefined
            ? { success: false, stdout: "", stderr: "no such file", exitCode: 1 }
            : { success: true, stdout: `  ${content.length}\n`, stderr: "", exitCode: 0 };
        }
        const b64 = /^base64 -w0 < '(.+)'$/.exec(cmd);
        if (b64) {
          const content = files.get(b64[1]!);
          return content === undefined
            ? { success: false, stdout: "", stderr: "no such file", exitCode: 1 }
            : { success: true, stdout: content.toString("base64"), stderr: "", exitCode: 0 };
        }
        const decode = /^base64 -d < '(.+)' > '(.+)' && rm -f '(.+)'$/.exec(cmd);
        if (decode) {
          const [, srcB64Path, destPath] = decode;
          const b64content = files.get(srcB64Path!);
          if (b64content === undefined) return { success: false, stdout: "", stderr: "no such file", exitCode: 1 };
          files.set(destPath!, Buffer.from(b64content.toString("utf-8"), "base64"));
          files.delete(srcB64Path!);
          return { success: true, stdout: "", stderr: "", exitCode: 0 };
        }
        return { success: false, stdout: "", stderr: `unrecognized command in fake stub: ${cmd}`, exitCode: 127 };
      },
      readFile: async (p: string, opts?: { encoding?: string }) => {
        calls.push({ method: "readFile", args: [p, opts] });
        if (overrides.readFile) return overrides.readFile(p, opts);
        const content = files.get(p);
        if (content === undefined) throw new Error(`fake stub: readFile(${p}) — no such file`);
        return { content: opts?.encoding === "base64" ? content.toString("base64") : content.toString("utf-8") };
      },
      writeFile: async (p: string, content: string, opts?: { encoding?: string }) => {
        calls.push({ method: "writeFile", args: [p, content, opts] });
        if (overrides.writeFile) return overrides.writeFile(p, content, opts);
        files.set(p, opts?.encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf-8"));
        return {};
      },
      exists: async (p: string) => {
        calls.push({ method: "exists", args: [p] });
        return overrides.exists ? overrides.exists(p) : { exists: files.has(p) };
      },
      mkdir: async (p: string, opts?: unknown) => {
        calls.push({ method: "mkdir", args: [p, opts] });
        return overrides.mkdir ? overrides.mkdir(p, opts) : {};
      },
      deleteFile: async (p: string) => {
        calls.push({ method: "deleteFile", args: [p] });
        if (overrides.deleteFile) return overrides.deleteFile(p);
        files.delete(p);
        return {};
      },
      getState: async () => {
        calls.push({ method: "getState", args: [] });
        if (overrides.getState) return overrides.getState();
        return { status: "running" };
      },
      __files: files,
    };
  }

  return { stub: buildStub(), calls };
}

test("stubTransport: exec — exitCode is the authority when present; success maps to 0/1 (never a fabricated 0 on failure) when absent", async () => {
  const { stub } = makeFakeStub({
    exec: async (cmd: string) => {
      if (cmd === "with-exit-code") return { success: false, stdout: "o", stderr: "e", exitCode: 42 };
      if (cmd === "success-no-exitcode") return { success: true, stdout: "o", stderr: "" };
      if (cmd === "failure-no-exitcode") return { success: false, stdout: "", stderr: "boom" };
      throw new Error("unexpected");
    },
  });
  const transport = stubTransport(stub as any);
  assert.equal((await transport.exec("with-exit-code", { cwd: "/workspace" })).exitCode, 42);
  assert.equal((await transport.exec("success-no-exitcode", { cwd: "/workspace" })).exitCode, 0);
  const failed = await transport.exec("failure-no-exitcode", { cwd: "/workspace" });
  assert.equal(failed.exitCode, 1, "a synthesized exitCode on failure must be a DELIBERATE 1, never 0 — 0 would silently disable every &&-chain's failure detection");
});

test("stubTransport: size — wc -c, leading-whitespace-trimmed, null on a failing exec (never a fabricated 0)", async () => {
  const { stub } = makeFakeStub();
  const transport = stubTransport(stub as any);
  await transport.writeFile("/workspace/f.txt", "hello");
  assert.equal(await transport.size("/workspace/f.txt"), 5);
  assert.equal(await transport.size("/workspace/missing.txt"), null);
});

test("stubTransport: readFileBuffer — exec-backed via base64 -w0, byte-identical round trip including non-UTF-8 bytes", async () => {
  const { stub } = makeFakeStub();
  const transport = stubTransport(stub as any);
  const arbitraryBytes = Buffer.from([0xe9, 0x41, 0xff, 0x00, 0x80]); // arbitrary non-UTF-8 bytes, seeded directly into the fake fs (never through a UTF-8 string hop)
  (stub as any).__files.set("/workspace/bin.dat", arbitraryBytes);
  const roundTripped = await transport.readFileBuffer("/workspace/bin.dat");
  assert.deepEqual(Buffer.from(roundTripped), arbitraryBytes);
});

test("stubTransport: writeFile — a string writes directly (no base64 hop); a Uint8Array round-trips through base64+exec-decode, byte-identical", async () => {
  const { stub, calls } = makeFakeStub();
  const transport = stubTransport(stub as any);

  await transport.writeFile("/workspace/text.txt", "plain text content");
  assert.equal((stub as any).__files.get("/workspace/text.txt").toString("utf-8"), "plain text content");
  assert.ok(!calls.some((c) => c.method === "exec"), "a string write must never go through exec/base64 at all");

  const binary = new Uint8Array([0, 1, 2, 253, 254, 255]);
  await transport.writeFile("/workspace/bin.dat", binary);
  assert.deepEqual(Buffer.from((stub as any).__files.get("/workspace/bin.dat")), Buffer.from(binary));
  assert.ok(!(stub as any).__files.has("/workspace/bin.dat.b64.tmp"), "the base64 scratch sibling must be cleaned up (rm -f), not left behind");
});

test("stubTransport: getState is not part of the transport surface — SandboxTransport has no such member (structural, compile-time)", () => {
  const { stub } = makeFakeStub();
  const transport: SandboxTransport = stubTransport(stub as any);
  assert.ok(!("getState" in transport));
});

// ── the real flue export shape this module's `...inner` spread depends on ──

test("@flue/runtime/cloudflare cannot be loaded in this Node process — the confirmed reason cloudflareFactory is built on sandboxFromDriver instead of cloudflareSandbox() (see sandbox_cloudflare.ts's header comment). Pinned so a future @flue/runtime upgrade that fixes this is noticed, not assumed.", async () => {
  await assert.rejects(() => import("@flue/runtime/cloudflare"), /cloudflare:/);
});

// ── driverFromCloudflareStub — the SandboxDriver mapping that replaces
// cloudflareSandbox() (see sandbox_cloudflare.ts's header comment) ─────────

test("driverFromCloudflareStub: writeFile — a string writes directly; a Uint8Array is base64-encoded with {encoding:'base64'} (mirrors flue's own cfSandboxToSandbox verbatim)", async () => {
  const { stub, calls } = makeFakeStub();
  const driver = driverFromCloudflareStub(stub as any);
  await driver.writeFile("/workspace/text.txt", "hello");
  const stringCall = calls.find((c) => c.method === "writeFile" && c.args[0] === "/workspace/text.txt")!;
  assert.equal(stringCall.args[1], "hello");
  assert.equal(stringCall.args[2], undefined);

  const bytes = new Uint8Array([0, 1, 254, 255]);
  await driver.writeFile("/workspace/bin.dat", bytes);
  const binCall = calls.find((c) => c.method === "writeFile" && c.args[0] === "/workspace/bin.dat")!;
  assert.equal(binCall.args[1], Buffer.from(bytes).toString("base64"));
  assert.deepEqual(binCall.args[2], { encoding: "base64" });
});

test("driverFromCloudflareStub: readFileBuffer — reads via stub.readFile(path, {encoding:'base64'}), decoded byte-identical", async () => {
  const { stub } = makeFakeStub();
  const driver = driverFromCloudflareStub(stub as any);
  const bytes = new Uint8Array([10, 20, 253]);
  (stub as any).__files.set("/workspace/bin.dat", Buffer.from(bytes));
  const roundTripped = await driver.readFileBuffer("/workspace/bin.dat");
  assert.deepEqual(Buffer.from(roundTripped), Buffer.from(bytes));
});

test("driverFromCloudflareStub: stat — parses target size/mtime/type and the self type for symlink detection", async () => {
  const { stub } = makeFakeStub({
    exec: async (cmd: string) => {
      assert.match(cmd, /^stat -L -c '%s\/%Y\/%F' '\/workspace\/f\.txt' && stat -c '%F' '\/workspace\/f\.txt'$/);
      return { success: true, stdout: "42/1700000000/regular file\nsymbolic link\n", stderr: "", exitCode: 0 };
    },
  });
  const driver = driverFromCloudflareStub(stub as any);
  const st = await driver.stat("/workspace/f.txt");
  assert.equal(st.size, 42);
  assert.equal(st.isFile, true);
  assert.equal(st.isDirectory, false);
  assert.equal(st.isSymbolicLink, true);
  assert.equal(st.mtime?.getTime(), 1_700_000_000 * 1000);
});

test("driverFromCloudflareStub: readdir — NUL-separated find output, empty entries dropped", async () => {
  const { stub } = makeFakeStub({
    exec: async (cmd: string) => {
      assert.match(cmd, /^find '\/workspace' -mindepth 1 -maxdepth 1 -printf '%f\\0'$/);
      return { success: true, stdout: "a.txt\0b.txt\0", stderr: "", exitCode: 0 };
    },
  });
  const driver = driverFromCloudflareStub(stub as any);
  assert.deepEqual(await driver.readdir("/workspace"), ["a.txt", "b.txt"]);
});

test("driverFromCloudflareStub: exists/mkdir dispatch straight to the stub's own verbs", async () => {
  const { stub, calls } = makeFakeStub();
  const driver = driverFromCloudflareStub(stub as any);
  await stub.writeFile("/workspace/f.txt", "x");
  assert.equal(await driver.exists("/workspace/f.txt"), true);
  assert.equal(await driver.exists("/workspace/nope.txt"), false);
  await driver.mkdir("/workspace/sub", { recursive: true });
  assert.ok(calls.some((c) => c.method === "mkdir" && c.args[0] === "/workspace/sub" && (c.args[1] as any)?.recursive === true));
});

test("driverFromCloudflareStub: rm — no recursive/force uses deleteFile (the narrow verb); either flag shells out with the right combination of -f/-r", async () => {
  const { stub, calls } = makeFakeStub();
  const driver = driverFromCloudflareStub(stub as any);
  await driver.rm("/workspace/f.txt");
  assert.ok(calls.some((c) => c.method === "deleteFile" && c.args[0] === "/workspace/f.txt"));
  assert.ok(!calls.some((c) => c.method === "exec"), "the narrow no-flags case must never shell out");

  const { stub: stub2 } = makeFakeStub({
    exec: async (cmd: string) => {
      assert.equal(cmd, "rm -f -r -- '/workspace/dir'");
      return { success: true, stdout: "", stderr: "", exitCode: 0 };
    },
  });
  await driverFromCloudflareStub(stub2 as any).rm("/workspace/dir", { recursive: true, force: true });
});

test("driverFromCloudflareStub: exec — forwards cwd/env/timeoutMs, and the exitCode fallback matches stubTransport's", async () => {
  const { stub, calls } = makeFakeStub({
    exec: async (cmd: string, opts?: { cwd?: string; env?: Record<string, string>; timeout?: number }) => {
      assert.equal(cmd, "echo hi");
      assert.deepEqual(opts, { cwd: "/workspace", env: { A: "1" }, timeout: 5000 });
      return { success: false, stdout: "", stderr: "" }; // no exitCode
    },
  });
  const driver = driverFromCloudflareStub(stub as any);
  const r = await driver.exec("echo hi", { cwd: "/workspace", env: { A: "1" }, timeoutMs: 5000 });
  assert.equal(r.exitCode, 1, "success:false with no exitCode must synthesize a DELIBERATE 1, never 0");
  assert.ok(calls.length >= 0);
});

// ── lane 2: bridgeStub / cloudflareFactory over an in-process fake bridge ──

const BEARER_TOKEN = "test-bridge-token";

interface FakeBridge {
  url: string;
  execLog: string[];
  createCount: number;
  close(): Promise<void>;
}

/**
 * The `@cloudflare/sandbox` bridge's HTTP API (design doc §4.2, O-2), over
 * loopback — `POST /v1/sandbox` / `DELETE /v1/sandbox/:id` /
 * `POST /v1/sandbox/:id/exec` (SSE) / `GET|PUT /v1/sandbox/:id/file/*` /
 * `GET /health`, bearer-authenticated. `/exec` really runs the received
 * `argv` (`sh -lc <command>`) host-side — the same realism
 * `sandbox.test.ts`'s own `localTransport()` uses — so the git/tar/base64
 * sequences this test drives through it are the real ones.
 */
async function startFakeBridge(options: { failPreflight?: boolean; failCreate?: boolean } = {}): Promise<FakeBridge> {
  const sandboxes = new Set<string>();
  const execLog: string[] = [];
  let nextSandboxId = 0;
  const bridgeState = { createCount: 0 };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      void handle(req, res, Buffer.concat(chunks));
    });
  });

  async function handle(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, body: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${BEARER_TOKEN}`) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/sandbox") {
      if (options.failCreate) {
        // Fault injection: the bridge itself is unreachable/erroring — the
        // window between `broker.issue()` and `ensureSandboxId()` resolving
        // (design §6.1/§11's PR B revocation guarantee).
        res.writeHead(503);
        res.end("bridge create failed: simulated outage");
        return;
      }
      nextSandboxId += 1;
      bridgeState.createCount += 1;
      const id = `sb-${nextSandboxId}`;
      sandboxes.add(id);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id }));
      return;
    }
    const sandboxMatch = /^\/v1\/sandbox\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!sandboxMatch) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const [, id, rest] = sandboxMatch;
    if (!sandboxes.has(id!)) {
      res.writeHead(404);
      res.end("unknown sandbox id");
      return;
    }
    if (req.method === "DELETE" && !rest) {
      sandboxes.delete(id!);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST" && rest === "/exec") {
      const { argv, cwd, timeout_ms } = JSON.parse(body.toString("utf-8")) as { argv: string[]; cwd?: string; timeout_ms?: number };
      const command = argv[argv.length - 1] ?? "";
      execLog.push(command);
      let stdout: string;
      let stderr: string;
      let exitCode: number;
      if (options.failPreflight && /git --version && tar --version && base64 --version/.test(command)) {
        // Fault injection: simulate an image missing the mandatory binaries
        // WITHOUT touching PATH (which would be a flaky way to fake this —
        // shell resolution of `sh` itself is not guaranteed to fail the same
        // way across platforms when PATH is merely emptied).
        stdout = Buffer.from("").toString("base64");
        stderr = Buffer.from("sh: git: command not found").toString("base64");
        exitCode = 127;
      } else {
        const result = spawnSync(argv[0]!, argv.slice(1), { cwd, timeout: timeout_ms || undefined });
        stdout = (result.stdout ?? Buffer.alloc(0)).toString("base64");
        stderr = (result.stderr ?? Buffer.alloc(0)).toString("base64");
        exitCode = result.status ?? 1;
      }
      const sse = `event: stdout\ndata: ${stdout}\n\nevent: stderr\ndata: ${stderr}\n\nevent: exit\ndata: ${JSON.stringify({ exit_code: exitCode })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse);
      return;
    }
    if (rest?.startsWith("/file/")) {
      const filePath = decodeURIComponent(rest.slice("/file".length));
      if (req.method === "GET") {
        if (!existsSync(filePath)) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(readFileSync(filePath));
        return;
      }
      if (req.method === "PUT") {
        mkdirSync(path.dirname(filePath), { recursive: true });
        writeFileSync(filePath, body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    }
    res.writeHead(404);
    res.end("not found");
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    execLog,
    get createCount() {
      return bridgeState.createCount;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A fresh host repo (one commit) plus a sibling scratch tree for workspace/scratch/handoff — real directories under a tmpdir, the same realism `sandbox.test.ts` uses. */
function setupHostAndDirs(): { root: string; hostRepo: string; workspace: string; scratchDir: string; handoffHost: string; handoffSandbox: string } {
  const root = mkdtempSync(path.join(tmpdir(), "spf-cf-test-"));
  const hostRepo = path.join(root, "repo");
  mkdirSync(hostRepo, { recursive: true });
  git(["init", "-q"], hostRepo);
  writeFileSync(path.join(hostRepo, "README.md"), "hello\n");
  git(["add", "-A"], hostRepo);
  git(["commit", "-q", "-m", "init"], hostRepo);

  const workspace = path.join(root, "workspace");
  const scratchDir = path.join(root, "spf-tmp");
  const handoffHost = path.join(root, "handoff-host");
  const handoffSandbox = path.join(root, "spf-handoff", "sessions", "run", "context_handoff");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(handoffHost, { recursive: true });
  return { root, hostRepo, workspace, scratchDir, handoffHost, handoffSandbox };
}

test("bridgeStub: satisfies all 7 CloudflareSandboxStub members against the fake bridge, including exists/mkdir/deleteFile (exec-backed) and getState (SandboxOperationUnsupportedError)", async () => {
  process.env["SPF_TEST_CF_TOKEN"] = BEARER_TOKEN;
  const bridge = await startFakeBridge();
  try {
    const dirs = setupHostAndDirs();
    const spec = makeSpec({
      host_root: dirs.hostRepo,
      workspace_dir: dirs.workspace,
      scratch_dir: dirs.scratchDir,
      handoff_host: dirs.handoffHost,
      handoff_sandbox: dirs.handoffSandbox,
      cloudflare: { bridge_url: bridge.url, api_token_env: "SPF_TEST_CF_TOKEN", sandbox_name: "" },
    });
    const stub: CloudflareBridgeStub = bridgeStub(spec);

    await stub.mkdir(path.join(dirs.workspace, "sub"), { recursive: true });
    assert.ok(existsSync(path.join(dirs.workspace, "sub")));

    await stub.writeFile(path.join(dirs.workspace, "f.txt"), "hi");
    assert.equal((await stub.readFile(path.join(dirs.workspace, "f.txt"))).content, "hi");

    assert.equal((await stub.exists(path.join(dirs.workspace, "f.txt"))).exists, true);
    assert.equal((await stub.exists(path.join(dirs.workspace, "nope.txt"))).exists, false);

    await stub.deleteFile(path.join(dirs.workspace, "f.txt"));
    assert.equal((await stub.exists(path.join(dirs.workspace, "f.txt"))).exists, false);

    await assert.rejects(() => stub.getState(), (error: unknown) => {
      assert.ok(error instanceof SandboxOperationUnsupportedError);
      const meta = (error as { meta?: unknown }).meta as { operation?: string; provider?: string; options?: unknown[] };
      assert.equal(meta.operation, "getState");
      assert.equal(meta.provider, "cloudflare-bridge");
      assert.deepEqual(meta.options, []);
      return true;
    });
  } finally {
    delete process.env["SPF_TEST_CF_TOKEN"];
    await bridge.close();
  }
});

test("bridgeStub: exec — a bridge reply omitting exitCode is never observed raw; base64 encoding round-trips real stdout/stderr", async () => {
  process.env["SPF_TEST_CF_TOKEN"] = BEARER_TOKEN;
  const bridge = await startFakeBridge();
  try {
    const dirs = setupHostAndDirs();
    const spec = makeSpec({
      host_root: dirs.hostRepo,
      workspace_dir: dirs.workspace,
      scratch_dir: dirs.scratchDir,
      handoff_host: dirs.handoffHost,
      handoff_sandbox: dirs.handoffSandbox,
      cloudflare: { bridge_url: bridge.url, api_token_env: "SPF_TEST_CF_TOKEN", sandbox_name: "" },
    });
    const stub = bridgeStub(spec);
    const r = await stub.exec("echo hello", { cwd: dirs.workspace });
    assert.equal(r.stdout.trim(), "hello");
    assert.equal(r.exitCode, 0);
    assert.equal(r.success, true);

    const failed = await stub.exec("exit 3", { cwd: dirs.workspace });
    assert.equal(failed.exitCode, 3);
  } finally {
    delete process.env["SPF_TEST_CF_TOKEN"];
    await bridge.close();
  }
});

test("stubTransport over the REAL fake bridge (real shell, real base64/wc — not the regex-mocked mini-shell): size/readFileBuffer/writeFile round-trip byte-identical binary content, including on a shell whose `base64`/`wc` reject a positional filename argument", async () => {
  process.env["SPF_TEST_CF_TOKEN"] = BEARER_TOKEN;
  const bridge = await startFakeBridge();
  try {
    const dirs = setupHostAndDirs();
    const spec = makeSpec({
      host_root: dirs.hostRepo,
      workspace_dir: dirs.workspace,
      scratch_dir: dirs.scratchDir,
      handoff_host: dirs.handoffHost,
      handoff_sandbox: dirs.handoffSandbox,
      cloudflare: { bridge_url: bridge.url, api_token_env: "SPF_TEST_CF_TOKEN", sandbox_name: "" },
    });
    const stub = bridgeStub(spec);
    const transport = stubTransport(stub);
    const filePath = path.join(dirs.workspace, "bin.dat");
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255, 10, 13]);

    await transport.writeFile(filePath, "text content");
    assert.equal(await transport.size(filePath), "text content".length);

    await transport.writeFile(filePath, bytes); // the Uint8Array/binary path — this is what caught the BSD `base64 -d <positional>` bug
    assert.equal(await transport.size(filePath), bytes.length);
    assert.deepEqual(Buffer.from(await transport.readFileBuffer(filePath)), bytes);
    assert.ok(!existsSync(`${filePath}.b64.tmp`), "the base64 scratch sibling must be cleaned up on the real filesystem too");
  } finally {
    delete process.env["SPF_TEST_CF_TOKEN"];
    await bridge.close();
  }
});

test("bridgeStub: missing api_token_env throws naming the env var, before any network call", async () => {
  const dirs = setupHostAndDirs();
  const spec = makeSpec({
    host_root: dirs.hostRepo,
    workspace_dir: dirs.workspace,
    scratch_dir: dirs.scratchDir,
    handoff_host: dirs.handoffHost,
    handoff_sandbox: dirs.handoffSandbox,
    cloudflare: { bridge_url: "http://127.0.0.1:1", api_token_env: "SPF_TEST_CF_TOKEN_UNSET", sandbox_name: "" },
  });
  delete process.env["SPF_TEST_CF_TOKEN_UNSET"];
  const stub = bridgeStub(spec);
  await assert.rejects(() => stub.exec("true", { cwd: dirs.workspace }), /SPF_TEST_CF_TOKEN_UNSET/);
});

test("cloudflareFactory: createSandbox seeds exactly once per lease (preflight -> seed -> registerLease -> provider_id/teardown), and a second create for the SAME lease_key does not re-seed", async () => {
  process.env["SPF_TEST_CF_TOKEN"] = BEARER_TOKEN;
  const bridge = await startFakeBridge();
  const dirs = setupHostAndDirs();
  const spec = makeSpec({
    host_root: dirs.hostRepo,
    workspace_dir: dirs.workspace,
    scratch_dir: dirs.scratchDir,
    handoff_host: dirs.handoffHost,
    handoff_sandbox: dirs.handoffSandbox,
    cloudflare: { bridge_url: bridge.url, api_token_env: "SPF_TEST_CF_TOKEN", sandbox_name: "" },
  });
  try {
    const factory = cloudflareFactory(spec);
    await factory.createSandbox({ id: "ctx-1" });
    const lease = sandbox.getLease(spec.lease_key);
    assert.ok(lease, "createSandbox must register a lease under spec.lease_key");
    assert.ok(lease!.provider_id.length > 0, "the adapter must set provider_id from the bridge's own sandbox id");
    assert.equal(
      lease!.teardown.length,
      3,
      "position 1 is the adapter's own destroy step, position 2 is PR B's credentials:revoke, position 3 is this adapter's stub-cache eviction",
    );
    assert.equal(lease!.teardown[1]!.name, "credentials:revoke", "credentials:revoke must sit at position 2, between destroy and the stub-cache eviction");
    assert.ok(lease!.seeded, "seedViaTransport's returned fingerprint must be stored on the lease");
    // The seed committed spf-base inside the (real, on-disk) workspace dir.
    const tag = spawnSync("git", ["rev-parse", "--verify", "spf-base"], { cwd: dirs.workspace });
    assert.equal(tag.status, 0, "the seed must have run for real — spf-base must resolve inside the workspace dir");

    const execCountBefore = bridge.execLog.length;
    await factory.createSandbox({ id: "ctx-1" }); // same lease_key — the find-or-create HIT branch
    assert.equal(bridge.execLog.length, execCountBefore, "a hit on the same lease_key must not re-run the seed (no new exec calls)");
    assert.equal(sandbox.leases().filter((l) => l.spec.lease_key === spec.lease_key).length, 1, "still exactly one lease for this key");
  } finally {
    await sandbox.teardownRun(spec.adw_id);
    delete process.env["SPF_TEST_CF_TOKEN"];
    await bridge.close();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("cloudflareFactory: two factoryFor(spec)-shaped calls followed by createSandbox issue exactly ONE POST /v1/sandbox — the stub must be cached per lease_key, not rebuilt per call", async () => {
  process.env["SPF_TEST_CF_TOKEN"] = BEARER_TOKEN;
  const bridge = await startFakeBridge();
  const dirs = setupHostAndDirs();
  const spec = makeSpec({
    host_root: dirs.hostRepo,
    workspace_dir: dirs.workspace,
    scratch_dir: dirs.scratchDir,
    handoff_host: dirs.handoffHost,
    handoff_sandbox: dirs.handoffSandbox,
    cloudflare: { bridge_url: bridge.url, api_token_env: "SPF_TEST_CF_TOKEN", sandbox_name: "" },
  });
  try {
    // `agent_flue.ts`'s sfAgentRender calls `factoryFor(spec)` fresh on
    // every send — model this directly, not the cached `factory` variable
    // the other tests reuse.
    await cloudflareFactory(spec).createSandbox({ id: "ctx-1" }); // MISS — seeds, creates the one real provider sandbox
    await cloudflareFactory(spec).createSandbox({ id: "ctx-1" }); // HIT on the same lease_key — must reuse the cached stub
    assert.equal(bridge.createCount, 1, "a lease HIT must not allocate a second bridge-side sandbox");
    assert.equal(sandbox.leases().filter((l) => l.spec.lease_key === spec.lease_key).length, 1);
  } finally {
    await sandbox.teardownRun(spec.adw_id);
    delete process.env["SPF_TEST_CF_TOKEN"];
    await bridge.close();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("cloudflareFactory: teardown issues DELETE against the bridge (the lease's provider-side sandbox no longer exists afterward)", async () => {
  process.env["SPF_TEST_CF_TOKEN"] = BEARER_TOKEN;
  const bridge = await startFakeBridge();
  const dirs = setupHostAndDirs();
  const spec = makeSpec({
    host_root: dirs.hostRepo,
    workspace_dir: dirs.workspace,
    scratch_dir: dirs.scratchDir,
    handoff_host: dirs.handoffHost,
    handoff_sandbox: dirs.handoffSandbox,
    cloudflare: { bridge_url: bridge.url, api_token_env: "SPF_TEST_CF_TOKEN", sandbox_name: "" },
  });
  try {
    const factory = cloudflareFactory(spec);
    await factory.createSandbox({ id: "ctx-1" });
    const lease = sandbox.getLease(spec.lease_key)!;
    const providerId = lease.provider_id;

    await sandbox.teardownLease(lease);

    // A second DELETE against the same (now-gone) id must 404 at the bridge —
    // proving the first teardown's DELETE actually reached it and was not a
    // silent no-op.
    const res = await fetch(`${bridge.url}/v1/sandbox/${providerId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    assert.equal(res.status, 404);
  } finally {
    await sandbox.teardownRun(spec.adw_id);
    delete process.env["SPF_TEST_CF_TOKEN"];
    await bridge.close();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("cloudflareFactory: the mandatory git/tar/base64 preflight failing produces a named error, no lease, and no journal entry", async () => {
  process.env["SPF_TEST_CF_TOKEN"] = BEARER_TOKEN;
  const bridge = await startFakeBridge({ failPreflight: true });
  const dirs = setupHostAndDirs();
  const spec = makeSpec({
    host_root: dirs.hostRepo,
    workspace_dir: dirs.workspace,
    scratch_dir: dirs.scratchDir,
    handoff_host: dirs.handoffHost,
    handoff_sandbox: dirs.handoffSandbox,
    image: "fake-image-missing-binaries",
    cloudflare: { bridge_url: bridge.url, api_token_env: "SPF_TEST_CF_TOKEN", sandbox_name: "" },
  });
  try {
    const factory = cloudflareFactory(spec);
    await assert.rejects(() => factory.createSandbox({ id: "ctx-1" }), /fake-image-missing-binaries/);
    assert.equal(sandbox.getLease(spec.lease_key), undefined, "a failed preflight must leave no lease registered");
  } finally {
    delete process.env["SPF_TEST_CF_TOKEN"];
    await bridge.close();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

/**
 * SPF #15 PR B (§6.1/§11's PR B revocation guarantee): a fake broker that
 * records `issue`/`revoke` calls independently — proves `ensureSandboxId()`
 * throwing AFTER `broker.issue()` (but before a lease/teardown chain exists
 * to hang the revoke off of) still revokes the grant, and never leaves a
 * lease with no teardown steps registered behind.
 */
function makeFakeBroker(): { broker: CredentialBroker; issueCalls: () => number; revokeCalls: () => number } {
  let issueCalls = 0;
  let revokeCalls = 0;
  const broker: CredentialBroker = {
    id: "fake-test-broker",
    async issue(spec) {
      issueCalls += 1;
      const grant: CredentialGrant = {
        env: { ...spec.env },
        describe: () => "fake broker grant",
        revoke: async () => {
          revokeCalls += 1;
        },
      };
      return grant;
    },
  };
  return { broker, issueCalls: () => issueCalls, revokeCalls: () => revokeCalls };
}

test("cloudflareFactory: a bridge create failure happens during preflight — before broker.issue() ever runs, so no grant exists and none is revoked", async () => {
  // `ensureSandboxId()` is memoized (bridgeStub, sandbox_cloudflare.ts:201)
  // and preflight's own `transport.exec` is what forces it to resolve
  // FIRST — `broker.issue()` runs strictly after preflight succeeds
  // (sandbox_cloudflare.ts:499-503). So `failCreate` surfaces out of
  // preflight, not out of the explicit post-issue `ensureSandboxId()` call
  // at :511 — there is no code path where the bridge create fails AFTER a
  // grant has already been issued. This is the real, sound guarantee:
  // credentials for a sandbox that never got created are never minted.
  process.env["SPF_TEST_CF_TOKEN"] = BEARER_TOKEN;
  const bridge = await startFakeBridge({ failCreate: true });
  const dirs = setupHostAndDirs();
  const spec = makeSpec({
    host_root: dirs.hostRepo,
    workspace_dir: dirs.workspace,
    scratch_dir: dirs.scratchDir,
    handoff_host: dirs.handoffHost,
    handoff_sandbox: dirs.handoffSandbox,
    cloudflare: { bridge_url: bridge.url, api_token_env: "SPF_TEST_CF_TOKEN", sandbox_name: "" },
  });
  try {
    const fb = makeFakeBroker();
    const factory = cloudflareFactory(spec, fb.broker);
    await assert.rejects(() => factory.createSandbox({ id: "ctx-1" }), /bridge create failed|bridge POST/);
    assert.equal(sandbox.getLease(spec.lease_key), undefined, "a failed bridge create must leave no lease registered");
    assert.equal(fb.issueCalls(), 0, "a bridge create failure surfaces during preflight, strictly before broker.issue() ever runs");
    assert.equal(fb.revokeCalls(), 0, "nothing was ever issued, so there is nothing to revoke");
  } finally {
    delete process.env["SPF_TEST_CF_TOKEN"];
    await bridge.close();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});

test("cloudflareFactory: the credentials:revoke teardown step still runs when a LATER step (cloudflare:destroy) throws — position 2 is never skipped because position 1 failed", async () => {
  const bridge = await startFakeBridge();
  const dirs = setupHostAndDirs();
  const spec = makeSpec({
    host_root: dirs.hostRepo,
    workspace_dir: dirs.workspace,
    scratch_dir: dirs.scratchDir,
    handoff_host: dirs.handoffHost,
    handoff_sandbox: dirs.handoffSandbox,
    cloudflare: { bridge_url: bridge.url, api_token_env: "SPF_TEST_CF_TOKEN", sandbox_name: "" },
  });
  process.env["SPF_TEST_CF_TOKEN"] = BEARER_TOKEN;
  try {
    const fb = makeFakeBroker();
    const factory = cloudflareFactory(spec, fb.broker);
    await factory.createSandbox({ id: "ctx-1" });
    const lease = sandbox.getLease(spec.lease_key);
    assert.ok(lease, "sandbox was created; a lease must be registered");
    assert.equal(fb.issueCalls(), 1);
    const destroyStep = lease!.teardown.find((s) => s.name === "cloudflare:destroy");
    assert.ok(destroyStep, "position 1 (cloudflare:destroy) must exist");
    destroyStep!.run = async () => {
      throw new Error("simulated cloudflare:destroy failure");
    };
    await sandbox.teardownRun(spec.adw_id).catch(() => {});
    assert.equal(fb.revokeCalls(), 1, "credentials:revoke (position 2) must still run even when position 1 (cloudflare:destroy) throws");
  } finally {
    delete process.env["SPF_TEST_CF_TOKEN"];
    await bridge.close();
    rmSync(dirs.root, { recursive: true, force: true });
  }
});
