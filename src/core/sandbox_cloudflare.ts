/**
 * Cloudflare backend adapter (SPF #15, design doc §4.2).
 *
 * ============================================================================
 * DEVIATION FROM THE DESIGN DOC, DISCOVERED DURING IMPLEMENTATION — read
 * before touching this file. §4.2's pseudocode calls
 * `@flue/runtime/cloudflare`'s `cloudflareSandbox(stub, {cwd}): SandboxFactory`
 * directly. That function IS real (verified: `dist/cloudflare/index.d.mts:
 * 13-68`, 7-method structural stub `exec`/`readFile`/`writeFile`/`exists`/
 * `mkdir`/`deleteFile`/`getState`) — but the MODULE it lives in cannot be
 * loaded in a plain Node.js process AT ALL, statically or dynamically:
 * `@flue/runtime/cloudflare` unconditionally imports `cloudflare:workers` at
 * its own top level (`dist/tracing-mRWmVbdr.mjs:4`, pulled in transitively
 * through `dist/cloudflare/index.mjs`), and Node's default ESM loader has no
 * handler for that URL scheme outside a Cloudflare Worker. Reproduced
 * directly against this repo's installed package:
 *
 *   node -e "import('@flue/runtime/cloudflare').then(()=>console.log('OK'))
 *     .catch(e=>console.log('FAIL', e.message))"
 *   -> FAIL Only URLs with a scheme in: file, data, and node are supported
 *      by the default ESM loader. Received protocol 'cloudflare:'
 *
 * A dynamic `import()` does not help — Node still has to load and execute
 * the module graph the first time it's awaited, so the crash just moves
 * from "every `spf` command" (a top-level import) to "the first time a
 * `cloudflare`-backend spec is created" (still a hard failure, just later).
 * §4.2's own O-2 anticipated bridge-wire uncertainty, but not this: the
 * design's premise that `cloudflareSandbox()` is callable from "SPF is a
 * Node CLI" does not hold for the currently-installed `@flue/runtime`.
 *
 * RESOLUTION SHIPPED HERE: bypass `cloudflareSandbox()` and go one layer
 * lower, to `sandboxFromDriver(driver: SandboxDriver, cwd): Sandbox` — flue's
 * own first-party primitive, exported from the MAIN `@flue/runtime` package
 * (confirmed Node-safe: no `cloudflare:workers` in its own import chain),
 * and the SAME primitive the OpenSandbox adapter is built on (design doc
 * §4.1). `driverFromCloudflareStub()` below maps a `CloudflareSandboxStub`
 * (still built exactly per the 7-method shape above, via `bridgeStub()`) onto
 * the 9-verb `SandboxDriver` — a byte-faithful reproduction of what
 * `cloudflareSandbox()`'s own internal `cfSandboxToSandbox` does
 * (`dist/cloudflare/index.mjs:84-152`, read and copied verb-for-verb below),
 * MINUS its `raceContainerDeath` liveness poller, which depends on a working
 * `getState()` that this adapter cannot honor either (see `bridgeStub`'s own
 * comment) — so a hung command now relies on the HTTP call's own timeout
 * instead of a liveness probe, a real but explicitly-accepted narrowing.
 * This still satisfies "wired via flue's first-party sandbox machinery" in
 * substance — `sandboxFromDriver` is that machinery — but is a real
 * deviation from the doc's literal `cloudflareSandbox()` call, made because
 * the literal call is not possible in this environment. Flagged prominently
 * rather than silently worked around, per this task's own instructions.
 * ============================================================================
 *
 * `bridgeStub()` builds the `CloudflareSandboxStub` shape over
 * `@cloudflare/sandbox`'s self-deployed HTTP bridge (design doc §4.2, open
 * question O-2): every one of its 7 methods becomes a fetch call against
 * `sandbox.cloudflare.bridge_url`, bearer-authenticated from
 * `process.env[sandbox.cloudflare.api_token_env]`. The exact bridge wire
 * contract (endpoint paths, the exec SSE event framing) is O-2 — verified
 * against developers.cloudflare.com/sandbox/bridge/http-api/ at
 * implementation time, isolated below so it is easy to correct once a real
 * bridge is available to test against; the CF unit tests exercise SPF's own
 * mapping (arguments, the exitCode fallback, base64 chunking, the seed/
 * preflight orchestration) against an in-process FAKE bridge built to this
 * same contract — never the real network — matching the design's own
 * "argument lane vs. wire lane" split for the OpenSandbox adapter (§8.3a/b),
 * applied here by analogy. Live e2e against a real bridge is gated on
 * `CLOUDFLARE_API_TOKEN`/`SPF_E2E_CF_BRIDGE_URL` and is out of this PR
 * slice's test scope (§8.4's stated skip rule).
 */

import { SandboxOperationUnsupportedError, sandboxFromDriver } from "@flue/runtime";
import type { SandboxDriver, SandboxFactory } from "@flue/runtime";
import type { CloudflareSandboxStub } from "@flue/runtime/cloudflare";
import type { SandboxSpec } from "./data_types.ts";
import { getLease, preflight, registerLease, seedViaTransport, staticBroker } from "./sandbox.ts";
import type { CredentialBroker, SandboxTransport } from "./sandbox.ts";

// ── shell/path helpers (this module's own copy — sandbox.ts's is private,
// and flue's own cloudflare/index.mjs likewise keeps its own local copy
// rather than sharing one across the boundary) ──────────────────────────────

/** Single-quote a value for the container shell; embedded quotes become '\''. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** `/file/*`'s wildcard segment, percent-encoded per path SEGMENT so embedded slashes in a filename can't be confused with the route's own separators, while real separators survive untouched. */
function encodeBridgeFilePath(filePath: string): string {
  return filePath.split("/").map((seg) => (seg === "" ? "" : encodeURIComponent(seg))).join("/");
}

function requiredBridgeToken(spec: SandboxSpec): string {
  const key = spec.cloudflare.api_token_env;
  const token = process.env[key];
  if (!token) {
    throw new Error(
      `sandbox: env var ${JSON.stringify(key)} (sandbox.cloudflare.api_token_env) is not set — required to authenticate to the cloudflare bridge at ${spec.cloudflare.bridge_url}`,
    );
  }
  return token;
}

// ── the bridge wire contract (O-2) ──────────────────────────────────────────

interface StubExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
}

/**
 * `POST {bridge}/v1/sandbox/:id/exec` returns `text/event-stream`: `stdout`/
 * `stderr` events carry base64-encoded chunks, and the stream ends with
 * exactly one terminal event — `exit` (`{"exit_code": N}`) or `error`
 * (`{"error": "...", "code": "..."}`). Parsed here rather than assumed
 * streamed live: `SandboxTransport.exec`/`CloudflareSandboxStub.exec` both
 * declare a single resolved `Promise`, not a callback surface, so collecting
 * the whole stream before resolving is the correct shape either way.
 */
function parseExecEventStream(text: string): StubExecResult {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  let success = true;
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
    }
    const data = dataLines.join("\n");
    if (event === "stdout") stdout += Buffer.from(data, "base64").toString("utf-8");
    else if (event === "stderr") stderr += Buffer.from(data, "base64").toString("utf-8");
    else if (event === "exit") {
      try {
        exitCode = (JSON.parse(data) as { exit_code?: number }).exit_code;
      } catch {
        /* leave undefined — the success->exitCode fallback (§4.2 point 2a) covers it */
      }
      success = (exitCode ?? 1) === 0;
    } else if (event === "error") {
      success = false;
      let message = data;
      try {
        message = (JSON.parse(data) as { error?: string }).error ?? data;
      } catch {
        /* keep the raw payload */
      }
      stderr += (stderr ? "\n" : "") + message;
    }
  }
  return { success, stdout, stderr, exitCode };
}

function envPrefixedCommand(command: string, env: Record<string, string> | undefined): string {
  if (!env || Object.keys(env).length === 0) return command;
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("; ");
  return `${exports}; ${command}`;
}

/** The richer shape `bridgeStub` actually returns — a real `CloudflareSandboxStub` (so `cloudflareSandbox()` accepts it unmodified) plus the two bridge-lifecycle operations flue's stub type has no room for. Exported for the hermetic unit tests (§8.1) — `cloudflareFactory` is the only caller in production code. */
export interface CloudflareBridgeStub extends CloudflareSandboxStub {
  /** Bridge-assigned sandbox id, creating it on first use. Memoized: every stub method resolves the SAME id. */
  ensureSandboxId(): Promise<string>;
  /** `DELETE {bridge}/v1/sandbox/:id` — SPF's own responsibility; unlike the Worker/Durable-Object case `cloudflareSandbox()`'s own doc comment shows, nothing else here ever tears the bridge-side sandbox down. */
  destroy(): Promise<void>;
}

/**
 * Builds the `CloudflareSandboxStub` `cloudflareSandbox()` wants, over the
 * `@cloudflare/sandbox` bridge's HTTP API (design doc §4.2, O-2): `POST
 * /v1/sandbox` (create, `{id}`), `DELETE /v1/sandbox/:id` (destroy), `POST
 * /v1/sandbox/:id/exec` (the event-stream above), `GET`/`PUT
 * /v1/sandbox/:id/file/*` (raw bytes). Bearer auth on every `/v1/sandbox/*`
 * route. There is no direct `exists`/`mkdir`/`deleteFile` endpoint at this
 * layer, so those three (and `size`/`readFileBuffer` in `stubTransport`
 * below) are bridged through `exec` — the one verb the bridge unambiguously
 * exposes for arbitrary shell work, the same "fall back to exec" move
 * flue's own reference `cf-sandbox.mjs` makes for `stat`/`readdir`/recursive
 * `rm` against the real Durable Object stub.
 *
 * `getState` has no bridge equivalent richer than a coarse `{running}`
 * boolean (`GET /v1/sandbox/:id/running`) — not the `status` STRING
 * `getState`'s own contract promises (`"stopped"`/`"stopped_with_code"`/…),
 * and inventing one of those values from a boolean would be exactly the
 * fabrication this design refuses elsewhere (§4.2 point 2a's `exitCode`
 * fallback is careful for the same reason). So `getState` throws the named
 * `SandboxOperationUnsupportedError` the design specifies for this exact
 * gap — harmless to flue's own liveness poller (`raceContainerDeath`),
 * which treats a rejected `getState()` as "poll again later" and simply
 * falls back to the real RPC's own resolution, never hanging on it.
 */
export function bridgeStub(spec: SandboxSpec): CloudflareBridgeStub {
  const base = spec.cloudflare.bridge_url.replace(/\/+$/, "");
  let idPromise: Promise<string> | null = null;

  function ensureSandboxId(): Promise<string> {
    if (!idPromise) {
      idPromise = (async () => {
        const name = spec.cloudflare.sandbox_name || spec.lease_key.replace(/[^A-Za-z0-9_.-]/g, "_");
        const res = await fetch(`${base}/v1/sandbox`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${requiredBridgeToken(spec)}` },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) {
          throw new Error(`sandbox: cloudflare bridge POST /v1/sandbox failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
        }
        const body = (await res.json()) as { id?: string };
        if (!body.id) throw new Error("sandbox: cloudflare bridge POST /v1/sandbox returned no \"id\"");
        return body.id;
      })();
      idPromise.catch(() => {
        idPromise = null; // a failed create must not poison every later call with the same rejected promise
      });
    }
    return idPromise;
  }

  async function bridgeFetch(pathSuffix: string, init?: RequestInit): Promise<Response> {
    const id = await ensureSandboxId();
    const headers: Record<string, string> = { authorization: `Bearer ${requiredBridgeToken(spec)}`, ...(init?.headers as Record<string, string> | undefined) };
    return fetch(`${base}/v1/sandbox/${id}${pathSuffix}`, { ...init, headers });
  }

  async function bridgeExec(command: string, options?: { cwd?: string; env?: Record<string, string>; timeout?: number }): Promise<StubExecResult> {
    // A CONFIG error (no bridge_url, no token env set) must propagate as a
    // real rejection, immediately and unambiguously — never get folded into
    // a resolved {success:false} result the way a NETWORK-level failure
    // below does, or it would surface as a vague "missing git/tar/base64"
    // preflight message instead of the actual misconfiguration. Resolved
    // BEFORE the try/catch on purpose.
    const id = await ensureSandboxId();
    const token = requiredBridgeToken(spec);

    const controller = new AbortController();
    const timer = options?.timeout ? setTimeout(() => controller.abort(), options.timeout) : null;
    try {
      const res = await fetch(`${base}/v1/sandbox/${id}/exec`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          argv: ["sh", "-lc", envPrefixedCommand(command, options?.env)],
          cwd: options?.cwd,
          timeout_ms: options?.timeout,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        return { success: false, stdout: "", stderr: `sandbox: cloudflare bridge exec failed: HTTP ${res.status}`, exitCode: 1 };
      }
      return parseExecEventStream(await res.text());
    } catch (error) {
      if (controller.signal.aborted) {
        return { success: false, stdout: "", stderr: `sandbox: command timed out after ${options?.timeout}ms`, exitCode: 124 };
      }
      return { success: false, stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    exec: bridgeExec,
    async readFile(filePath, options) {
      const res = await bridgeFetch(`/file/${encodeBridgeFilePath(filePath)}`);
      if (!res.ok) throw new Error(`sandbox: cloudflare bridge GET file ${filePath} failed: HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      return { content: options?.encoding === "base64" ? bytes.toString("base64") : bytes.toString("utf-8") };
    },
    async writeFile(filePath, content, options) {
      const bytes = options?.encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf-8");
      const res = await bridgeFetch(`/file/${encodeBridgeFilePath(filePath)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: bytes,
      });
      if (!res.ok) throw new Error(`sandbox: cloudflare bridge PUT file ${filePath} failed: HTTP ${res.status}`);
      return {};
    },
    async exists(filePath) {
      const r = await bridgeExec(`test -e ${shellQuote(filePath)}`);
      return { exists: (r.exitCode ?? (r.success ? 0 : 1)) === 0 };
    },
    async mkdir(dirPath, options) {
      await bridgeExec(`mkdir ${options?.recursive ? "-p " : ""}${shellQuote(dirPath)}`);
      return {};
    },
    async deleteFile(filePath) {
      await bridgeExec(`rm -f ${shellQuote(filePath)}`);
      return {};
    },
    async getState() {
      throw new SandboxOperationUnsupportedError({ operation: "getState", provider: "cloudflare-bridge", options: [] });
    },
    ensureSandboxId,
    async destroy() {
      const id = await ensureSandboxId();
      const res = await fetch(`${base}/v1/sandbox/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${requiredBridgeToken(spec)}` },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`sandbox: cloudflare bridge DELETE /v1/sandbox/${id} failed: HTTP ${res.status}`);
      }
    },
  };
}

// ── the {exec, readFile, readFileBuffer, writeFile, size} transport ────────

/**
 * The surface `SandboxLease.transport` declares (§4.3), over the 7-method
 * `CloudflareSandboxStub`. `size`/`readFileBuffer` are exec-backed — `wc
 * -c`/`base64 -w0`, exactly as §8.1 specifies — the same convention the
 * OpenSandbox driver uses for the flue `stat` verb it likewise cannot map
 * onto natively (§4.1): `CloudflareSandboxStub` has no `stat` member at all
 * (verified `dist/cloudflare/index.d.mts:13-48`), so this is what proves
 * `size` is implementable where `stat` was not.
 */
export function stubTransport(stub: CloudflareSandboxStub): SandboxTransport {
  const execChainExitCode = (r: StubExecResult): number => r.exitCode ?? (r.success ? 0 : 1);

  return {
    async exec(cmd, opts) {
      const r = await stub.exec(cmd, { cwd: opts.cwd, timeout: opts.timeoutMs });
      // success -> exitCode fallback (§4.2 point 2a): exitCode is the
      // authority when present; a bridge that omits it maps a successful
      // step to 0 and a failed one to a DELIBERATE 1 — never 0 — so every
      // in-sandbox `&&` chain's failure detection still fires correctly.
      return { stdout: r.stdout, stderr: r.stderr, exitCode: execChainExitCode(r) };
    },
    async readFile(filePath) {
      return (await stub.readFile(filePath)).content;
    },
    async readFileBuffer(filePath) {
      // Stdin redirection, not a positional file argument — same rule as
      // the writeFile binary path below (verified live: BSD base64 rejects
      // a positional filename entirely, `-w0` or not).
      const r = await stub.exec(`base64 -w0 < ${shellQuote(filePath)}`);
      if (execChainExitCode(r) !== 0) throw new Error(`sandbox: cloudflare readFileBuffer(${filePath}) failed: ${r.stderr}`);
      return Buffer.from(r.stdout.trim(), "base64");
    },
    async writeFile(filePath, data) {
      if (typeof data === "string") {
        // The plain-text path — this is what sandbox.ts's shared transport
        // uses for the code-plane's own base64 TEXT files (seed.patch.b64,
        // out.patch.b64: a base64 STRING is the file's content, decoded by
        // a separate in-sandbox `base64 -d` step in sandbox.ts, not here).
        await stub.writeFile(filePath, data);
        return;
      }
      // Uint8Array: the stub's own `writeFile` is string-only (no
      // Uint8Array, no streaming — §4.2's stated stub limitation). Applies
      // to the handoff mirror's binary pushes (sandbox.ts's
      // pushHandoffMirror), which — unlike the code-plane patches — call
      // this method directly with raw bytes and expect them to land
      // verbatim. Same base64-over-exec discipline §5.2/§4.2 use for the
      // patches, self-contained here: write the base64 TEXT to a scratch
      // sibling, then decode it into real bytes at the real destination.
      const tmpPath = `${filePath}.b64.tmp`;
      await stub.writeFile(tmpPath, Buffer.from(data).toString("base64"));
      // Stdin redirection (`< file`), not a positional file argument — same
      // rule sandbox.ts's applyPatchInSandbox follows: GNU coreutils' base64
      // accepts both spellings, but a BusyBox/BSD base64 only accepts the
      // redirect form (verified live: BSD base64 rejects a positional arg
      // to `-d` with "invalid argument").
      const r = await stub.exec(`base64 -d < ${shellQuote(tmpPath)} > ${shellQuote(filePath)} && rm -f ${shellQuote(tmpPath)}`);
      if (execChainExitCode(r) !== 0) throw new Error(`sandbox: cloudflare writeFile(${filePath}) (binary) failed: ${r.stderr}`);
    },
    async size(filePath) {
      const r = await stub.exec(`wc -c < ${shellQuote(filePath)}`);
      if (execChainExitCode(r) !== 0) return null;
      // trim is load-bearing: BSD/busybox `wc` pads the number with leading whitespace.
      const n = Number.parseInt(r.stdout.trim(), 10);
      return Number.isFinite(n) ? n : null;
    },
  };
}

// ── the SandboxDriver adapter (replaces cloudflareSandbox() — see this
// module's header comment for why) ──────────────────────────────────────────

/**
 * A byte-faithful reproduction of `cloudflareSandbox()`'s own internal
 * `cfSandboxToSandbox` driver mapping (`dist/cloudflare/index.mjs:84-152`,
 * read in full — see this module's header comment for why reproducing it
 * is necessary rather than calling the original), MINUS the
 * `raceContainerDeath` liveness wrapper: this adapter's `getState()` always
 * throws (`bridgeStub`'s own comment), so wrapping every call in a poller
 * that depends on it would only add latency for no signal. A hung command
 * relies on the HTTP call's own timeout instead.
 */
export function driverFromCloudflareStub(stub: CloudflareSandboxStub): SandboxDriver {
  return {
    async readFile(filePath) {
      return (await stub.readFile(filePath)).content;
    },
    async readFileBuffer(filePath) {
      const file = await stub.readFile(filePath, { encoding: "base64" });
      return Buffer.from(file.content, "base64");
    },
    async writeFile(filePath, content) {
      if (typeof content === "string") {
        await stub.writeFile(filePath, content);
      } else {
        await stub.writeFile(filePath, Buffer.from(content).toString("base64"), { encoding: "base64" });
      }
    },
    async stat(filePath) {
      const quoted = shellQuote(filePath);
      const result = await stub.exec(`stat -L -c '%s/%Y/%F' ${quoted} && stat -c '%F' ${quoted}`);
      if (!result.success) throw new Error(`sandbox: cloudflare stat(${filePath}) failed: ${result.stderr}`);
      const [target = "", self = ""] = (result.stdout ?? "").trim().split("\n");
      const [size = "0", mtime = "0", type = ""] = target.split("/");
      return {
        isFile: type.includes("regular"),
        isDirectory: type === "directory",
        isSymbolicLink: self.trim() === "symbolic link",
        size: Number.parseInt(size, 10),
        mtime: new Date(Number.parseInt(mtime, 10) * 1000),
      };
    },
    async readdir(dirPath) {
      const result = await stub.exec(`find ${shellQuote(dirPath)} -mindepth 1 -maxdepth 1 -printf '%f\\0'`);
      if (!result.success) throw new Error(`sandbox: cloudflare readdir(${dirPath}) failed: ${result.stderr}`);
      return result.stdout.split("\0").filter((s) => s.length > 0);
    },
    async exists(filePath) {
      return (await stub.exists(filePath)).exists;
    },
    async mkdir(dirPath, opts) {
      await stub.mkdir(dirPath, opts);
    },
    async rm(filePath, opts) {
      if (!opts?.recursive && !opts?.force) {
        await stub.deleteFile(filePath);
        return;
      }
      const result = await stub.exec(`rm ${opts.force ? "-f " : ""}${opts.recursive ? "-r " : ""}-- ${shellQuote(filePath)}`);
      if (!result.success) throw new Error(`sandbox: cloudflare rm(${filePath}) failed: ${result.stderr}`);
    },
    async exec(command, execOpts) {
      const result = await stub.exec(command, { cwd: execOpts?.cwd, env: execOpts?.env, timeout: execOpts?.timeoutMs });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? (result.success ? 0 : 1),
      };
    },
  };
}

// ── the factory ──────────────────────────────────────────────────────────────

/**
 * Keyed exactly like `sandbox.ts`'s `LEASES` and the OpenSandbox adapter's
 * own `NATIVE_BY_LEASE` (`spec.lease_key`). `factoryFor(spec)` is called
 * fresh on every `agent_flue.ts` send — first prompt, every JSON-repair,
 * every gate correction — and `cloudflareFactory` is SYNC (§4.1's
 * "performs NO I/O" contract), so without this cache each call built a
 * brand-new `bridgeStub` with its own `idPromise = null`. On a lease HIT
 * (`getLease(key)` already set), `createSandbox` skips seeding but STILL
 * drove the sandbox through that new stub, whose first exec lazily
 * allocated a second bridge-side sandbox that was never registered for
 * teardown — up to one extra `POST /v1/sandbox` per send after the first.
 */
const STUB_BY_LEASE = new Map<string, CloudflareBridgeStub>();

/**
 * `broker` defaults to `staticBroker` — the only broker this build
 * registers. NOTE: unlike the OpenSandbox adapter, this bridge does not
 * currently thread ANY `env` into sandbox creation or `exec` (a pre-existing
 * gap in this file, not something PR B's credential-broker seam changes —
 * see this module's own header comment for its other Cloudflare-specific
 * deviations). `broker.issue(spec)` is still called here, on the same MISS
 * branch, so the credential lifecycle (grant + ordered revoke) is uniform
 * across backends even though this backend has nothing to hand the grant's
 * `env` to yet.
 */
export function cloudflareFactory(spec: SandboxSpec, broker: CredentialBroker = staticBroker): SandboxFactory {
  const key = spec.lease_key;
  let stub = STUB_BY_LEASE.get(key);
  if (!stub) {
    stub = bridgeStub(spec);
    STUB_BY_LEASE.set(key, stub);
  }
  const liveStub = stub;
  return {
    createSandbox: async () => {
      const sb = sandboxFromDriver(driverFromCloudflareStub(liveStub), spec.workspace_dir);
      // no reconcile on the hit branch — send() owns it (§4.1, §5.4)
      if (!getLease(key)) {
        const transport = stubTransport(liveStub);
        await preflight(spec, transport); // git && tar && base64, §4.1 — same three binaries, same named error
        const seeded = await seedViaTransport(spec, transport);
        // Awaited once, on this MISS branch only — never re-issued on a
        // later HIT (design §6.1).
        const grant = await broker.issue(spec);
        try {
          // `ensureSandboxId()` resolved BEFORE `registerLease` on purpose
          // (design §6.1) — a throwing bridge create must not leave a lease
          // registered with no teardown steps to revoke the grant it already
          // holds; a failed `ensureSandboxId()` never creates anything
          // bridge-side either (it clears its own memoized promise), so no
          // `cloudflare:destroy` counterpart is needed here.
          const providerId = await liveStub.ensureSandboxId();
          const lease = registerLease(key, spec, transport);
          lease.seeded = seeded;
          lease.provider_id = providerId;
          // Position 1, 2 (PR B's credentials:revoke — the slot PR A left
          // free), 3.
          lease.teardown.push(
            { name: "cloudflare:destroy", run: () => liveStub.destroy() },
            { name: "credentials:revoke", run: () => grant.revoke() },
            { name: "cloudflare:uncache", run: async () => { STUB_BY_LEASE.delete(key); } },
          );
        } catch (error) {
          await grant.revoke().catch(() => {});
          throw error;
        }
      }
      return sb;
    },
  };
}
