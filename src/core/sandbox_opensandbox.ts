/**
 * OpenSandbox backend adapter (SPF #15, design doc §4.1).
 *
 * Maps flue's 9-verb `SandboxDriver` onto the spike-verified
 * `@alibaba-group/opensandbox` v0.1.11 surface (see the scratchpad's
 * `sandbox-spike.json`), per the design's driver-method table:
 *
 *   exec           -> sandbox.commands.run(cmd, opts, handlers)   (streamed; no clamp — §3.1)
 *   readFile       -> sandbox.files.readFile(path)                (UTF-8 only, by contract)
 *   readFileBuffer -> exec("base64 -w0 < <path>") + decode        (SDK has no binary read)
 *   writeFile      -> sandbox.files.writeFiles([{path,data}])     (never pre-creates parents)
 *   mkdir          -> files.createDirectories | exec("mkdir -p")  (recursive via the shell)
 *   rm             -> exec("rm [-r][-f] -- <path>")                (fs.rm semantics, exactly)
 *   exists         -> exec("test -e <path>")                       (NO "--" — test/[ has no such convention)
 *   readdir        -> exec("test -d ... && ls -1A -- <path>")
 *   stat           -> exec("stat -c '%F|%s|%Y' -L -- <path>; test -L -- <path>")
 *
 * `openSandboxDriver`/`openSandboxFactory` are the module's public surface —
 * see their own doc comments. `find-or-create` lives in `openSandboxFactory`
 * against `sandbox.ts`'s process-local lease registry (`getLease`/
 * `registerLease`/`renewLease`); the underlying native OpenSandbox instance
 * and the `SandboxDriver` built over it are cached in this module's own
 * `NATIVE_BY_LEASE` map, keyed the same way, because `SandboxLease.native`'s
 * shape (§4.3) only carries the three narrow methods flue's `sandboxFromDriver`
 * must never see (`endpointUrl`/`egress`/`renew`) — not the raw handle.
 *
 * The `loadOpenSandboxSdk` indirection below is real and load-bearing: the
 * specifier MUST NOT be a literal at the `import()` call site, or a plain
 * `tsc -p tsconfig.json --noEmit` fails with TS2307 on every machine (the
 * SDK is a documented user install, never a `package.json` dependency — see
 * the design doc's §4.1). Keep that indirection; the obvious "simplification"
 * back to a literal is a build break.
 */

import type { FileStat, SandboxDriver, SandboxFactory } from "@flue/runtime";
import { SandboxDiedError, sandboxFromDriver } from "@flue/runtime";
import type { SandboxSpec } from "./data_types.ts";
import { getLease, preflight, registerLease, renewLease, seedViaTransport } from "./sandbox.ts";
import type { SandboxTransport } from "./sandbox.ts";
import type {
  OpenSandboxCommandOptions,
  OpenSandboxConnectionConfig,
  OpenSandboxCtor,
  OpenSandboxExecutionHandlers,
  OpenSandboxInstance,
  OpenSandboxManagerCtor,
} from "./sandbox_sdk_types.ts";

// ── the SDK loader seam (design §4.1) ───────────────────────────────────────

/** The hand-written narrow SDK surface this driver needs — see `sandbox_sdk_types.ts`. */
export interface OpenSandboxModule {
  Sandbox: OpenSandboxCtor;
  SandboxManager: OpenSandboxManagerCtor;
}

export type SdkLoader = () => Promise<OpenSandboxModule>;

// Indirected on purpose — see this module's header comment. Do not inline
// this string into the `import()` call below.
const OPENSANDBOX_SPECIFIER = "@alibaba-group/opensandbox";

export const loadOpenSandboxSdk: SdkLoader = async () => {
  try {
    return (await import(OPENSANDBOX_SPECIFIER)) as unknown as OpenSandboxModule;
  } catch (error) {
    throw new Error(
      `sandbox: the "opensandbox" backend needs the OpenSandbox SDK — install it with ` +
        `\`npm i -g @alibaba-group/opensandbox@0.1.11\` alongside SPF (or \`npm i -D @alibaba-group/opensandbox@0.1.11\` for local test lanes). ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
};

// ── small shell helpers ──────────────────────────────────────────────────

/** Single-quote a path for the container shell; embedded quotes become '\''. Mirrors flue's own (`dist/cloudflare/index.mjs:24-26`) and `sandbox.ts`'s copy. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ── liveness (design §4.1 point 4; `sandbox-api.md`'s liveness contract) ───

const LIVENESS_POLL_MS = 5_000;

/**
 * States in which a pending call may still complete. NOT a spike-verified
 * exhaustive enumeration — the spike observed a live `getInfo()` SHAPE
 * (`status:{state}`) but never enumerated every string the control plane
 * can report. Deliberately conservative: an unrecognized state is treated
 * as dead rather than alive, so an unmeasured value fails a hung call
 * loudly instead of silently hanging forever.
 *
 * Values are lower-cased, and MUST be compared case-insensitively below —
 * the SDK's own `SandboxState` union is capitalized
 * (`"Creating" | "Running" | "Pausing" | "Paused" | "Resuming" | "Deleting" |
 * "Deleted" | "Error" | string`), so a case-sensitive `Set.has` against a
 * live `"Running"` sandbox would misclassify it as dead. `paused` /
 * `deleting` / `deleted` / `error` are treated as dead.
 */
const OPENSANDBOX_LIVE_STATES = new Set(["running", "creating", "pausing", "resuming"]);

/** `setTimeout` + `.unref()` — never let a poll/watchdog timer hold the process open by itself (Node-only; harmless if `unref` is absent on a given timer handle). */
function unrefTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return timer;
}

function watchLiveness(native: OpenSandboxInstance, operation: string): { promise: Promise<never>; stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    const poll = () => {
      if (stopped) return;
      native
        .getInfo()
        .then((info) => {
          if (stopped) return;
          if (!OPENSANDBOX_LIVE_STATES.has(info.status.state.toLowerCase())) {
            stopped = true;
            reject(new SandboxDiedError({ operation, reason: "stopped" }));
            return;
          }
          timer = unrefTimeout(poll, LIVENESS_POLL_MS);
        })
        .catch(() => {
          // A getInfo() transport failure is NOT treated as death — only an
          // explicit non-live state is. A control-plane blip must not fail
          // an in-flight call; keep polling.
          if (!stopped) timer = unrefTimeout(poll, LIVENESS_POLL_MS);
        });
    };
    timer = unrefTimeout(poll, LIVENESS_POLL_MS);
  });
  return {
    promise,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** Races `work()` against the sandbox's liveness signal ONLY — never `signal` (that race belongs to `sandboxFromDriver`, one layer up). */
async function callWithLiveness<T>(native: OpenSandboxInstance, operation: string, work: () => Promise<T>): Promise<T> {
  const watcher = watchLiveness(native, operation);
  try {
    return await Promise.race([work(), watcher.promise]);
  } finally {
    watcher.stop();
  }
}

// ── exec, with the timeout convention (design §3.1/§4.1 point 3) ──────────

/**
 * `timeoutMs` is NEVER clamped (§3.1's named divergence from an earlier
 * draft) — a caller-supplied value above `exec_timeout_seconds` reaches the
 * SDK unmodified, forwarded best-effort as whole seconds, rounded UP (O-1 is
 * open: the spike never confirmed `commands.run` honors a deadline option,
 * so this adapter ALSO enforces the deadline host-side regardless). An
 * expired command resolves `exitCode: 124` with the timeout on stderr — the
 * `timeout(1)` convention — and never rejects; the still-running remote
 * command is left to settle on its own (fire-and-forget, never surfaced as
 * an unhandled rejection).
 */
async function runExecWithTimeout(
  native: OpenSandboxInstance,
  command: string,
  options: OpenSandboxCommandOptions,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const handlers: OpenSandboxExecutionHandlers = {
    onStdout: (chunk) => stdoutChunks.push(chunk.text),
    onStderr: (chunk) => stderrChunks.push(chunk.text),
  };

  const runPromise = native.commands.run(command, options, handlers);
  const mappedRun = runPromise.then((r) => ({
    stdout: r.logs.stdout.map((c) => c.text).join(""),
    stderr: r.logs.stderr.map((c) => c.text).join(""),
    exitCode: r.exitCode,
  }));
  mappedRun.catch(() => {}); // the timeout branch may win the race; the loser must never surface as an unhandled rejection

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    timer = unrefTimeout(() => {
      resolve({
        stdout: stdoutChunks.join(""),
        stderr: `${stderrChunks.join("")}\nsandbox: command timed out after ${timeoutMs}ms`,
        exitCode: 124,
      });
    }, timeoutMs);
  });

  try {
    return await Promise.race([mappedRun, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── the SandboxDriver (9 verbs, design §4.1's table) ────────────────────────

/**
 * Builds the flue `SandboxDriver` over a lazily-resolved native instance.
 * `getNative` is either a memoized create (standalone `openSandboxDriver`)
 * or an already-created instance (the factory's `createSandbox`) — both
 * shapes are `() => Promise<OpenSandboxInstance>`, so the 9 verbs below
 * don't need to know which.
 */
function buildDriver(getNative: () => Promise<OpenSandboxInstance>, spec: SandboxSpec): SandboxDriver {
  const driver: SandboxDriver = {
    exec: async (command, options) => {
      const native = await getNative();
      const cwd = options?.cwd ?? spec.workspace_dir;
      const timeoutMs = options?.timeoutMs ?? spec.exec_timeout_seconds * 1000;
      // The SDK's own RunCommandOpts fields are `workingDirectory`/`envs`,
      // not `cwd`/`env` — see OpenSandboxCommandOptions's doc comment.
      return callWithLiveness(native, "exec", () =>
        runExecWithTimeout(native, command, { workingDirectory: cwd, envs: options?.env, timeoutSeconds: Math.ceil(timeoutMs / 1000) }, timeoutMs),
      );
    },

    readFile: async (path) => {
      const native = await getNative();
      return callWithLiveness(native, "readFile", () => native.files.readFile(path));
    },

    // No SDK binary read (design §4.1's table) — decode a `base64 -w0` exec,
    // the redirect spelling (not a positional arg) for BusyBox/BSD `base64` parity.
    readFileBuffer: async (path) => {
      const r = await driver.exec(`base64 -w0 < ${shellQuote(path)}`, { cwd: spec.workspace_dir });
      if (r.exitCode !== 0) throw new Error(`sandbox: readFileBuffer failed for ${JSON.stringify(path)}: ${r.stderr || r.stdout}`);
      return new Uint8Array(Buffer.from(r.stdout, "base64"));
    },

    // Never pre-creates parents — the `sandboxFromDriver` wrapper's mkdir-retry owns that (`sandbox-api.md:113`).
    writeFile: async (path, content) => {
      const native = await getNative();
      return callWithLiveness(native, "writeFile", async () => {
        await native.files.writeFiles([{ path, data: content }]);
      });
    },

    mkdir: async (path, options) => {
      if (options?.recursive) {
        const r = await driver.exec(`mkdir -p -- ${shellQuote(path)}`, { cwd: spec.workspace_dir });
        if (r.exitCode !== 0) throw new Error(`sandbox: mkdir -p ${JSON.stringify(path)} failed: ${r.stderr || r.stdout}`);
        return;
      }
      const native = await getNative();
      return callWithLiveness(native, "mkdir", async () => {
        await native.files.createDirectories([{ path }]);
      });
    },

    // Already runs verbs through the shell, so the flags are implemented with
    // `rm` directly (`sandbox-api.md:221`) — exact `fs.rm` semantics, no
    // `SandboxOperationUnsupportedError` needed because the shell honors both.
    rm: async (path, options) => {
      const parts = ["rm"];
      if (options?.recursive) parts.push("-r");
      if (options?.force) parts.push("-f");
      parts.push("--", shellQuote(path));
      const r = await driver.exec(parts.join(" "), { cwd: spec.workspace_dir });
      if (r.exitCode !== 0) throw new Error(`sandbox: rm failed for ${JSON.stringify(path)}: ${r.stderr || r.stdout}`);
    },

    // MUST NOT use "--": `test`/`[` has no end-of-options convention — see
    // the design doc's boxed rule (§4.1). Quoting (not "--") is what guards
    // against whitespace/metacharacters here.
    exists: async (path) => {
      const r = await driver.exec(`test -e ${shellQuote(path)}`, { cwd: spec.workspace_dir });
      return r.exitCode === 0;
    },

    readdir: async (path) => {
      const r = await driver.exec(`test -d ${shellQuote(path)} && ls -1A -- ${shellQuote(path)}`, { cwd: spec.workspace_dir });
      if (r.exitCode !== 0) throw new Error(`sandbox: readdir failed — ${JSON.stringify(path)} is not a directory or does not exist`);
      return r.stdout.split("\n").filter((line) => line.length > 0);
    },

    // `-L` dereferences (so isFile/isDirectory/size/mtime describe the
    // TARGET); the companion `test -L` (non-following) answers isSymbolicLink.
    // Never fabricates: an unparseable size/mtime is OMITTED, not zeroed.
    stat: async (path) => {
      const [infoResult, symlinkResult] = await Promise.all([
        driver.exec(`stat -c '%F|%s|%Y' -L -- ${shellQuote(path)}`, { cwd: spec.workspace_dir }),
        driver.exec(`test -L -- ${shellQuote(path)}`, { cwd: spec.workspace_dir }),
      ]);
      if (infoResult.exitCode !== 0) throw new Error(`sandbox: stat failed for ${JSON.stringify(path)}: ${infoResult.stderr || infoResult.stdout}`);
      const [typeStr, sizeStr, mtimeStr] = infoResult.stdout.trim().split("|");
      const result: FileStat = {
        isFile: typeStr === "regular file",
        isDirectory: typeStr === "directory",
        isSymbolicLink: symlinkResult.exitCode === 0,
      };
      const size = Number.parseInt(sizeStr ?? "", 10);
      if (Number.isFinite(size)) result.size = size;
      const mtimeEpochSeconds = Number.parseInt(mtimeStr ?? "", 10);
      if (Number.isFinite(mtimeEpochSeconds)) result.mtime = new Date(mtimeEpochSeconds * 1000);
      return result;
    },
  };
  return driver;
}

/** Adapts a `SandboxDriver` into `sandbox.ts`'s narrower `SandboxTransport` (five verbs, `size` not `stat`). */
function transportFromDriver(driver: SandboxDriver, spec: SandboxSpec): SandboxTransport {
  return {
    exec: (cmd, opts) => driver.exec(cmd, { cwd: opts.cwd, timeoutMs: opts.timeoutMs }),
    readFile: (path) => driver.readFile(path),
    readFileBuffer: (path) => driver.readFileBuffer(path),
    writeFile: (path, data) => driver.writeFile(path, data),
    size: async (path) => {
      const r = await driver.exec(`wc -c < ${shellQuote(path)}`, { cwd: spec.workspace_dir });
      if (r.exitCode !== 0) return null;
      const n = Number.parseInt(r.stdout.trim(), 10);
      return Number.isFinite(n) ? n : null;
    },
  };
}

/** @internal not yet implemented in this build — see this module's header comment. */
export function openSandboxDriver(spec: SandboxSpec, load: SdkLoader = loadOpenSandboxSdk): SandboxDriver {
  let nativePromise: Promise<OpenSandboxInstance> | null = null;
  const ensureNative = (): Promise<OpenSandboxInstance> => {
    if (!nativePromise) nativePromise = createNativeSandbox(spec, load);
    return nativePromise;
  };
  return buildDriver(ensureNative, spec);
}

// ── create-time knobs (design §4.1's create-knobs note) ────────────────────

const DEFAULT_READY_TIMEOUT_SECONDS = 120;

/**
 * Raised past the SDK's own 120s default when the resolved egress policy
 * puts a sidecar in the sandbox's create path — the spike measured a 30-90s
 * cold sidecar start. `skipHealthCheck` is deliberately never set to `true`
 * (§4.1: skipping it would move the failure into the mandatory preflight,
 * where the error would misleadingly name `git` instead of the sidecar).
 */
function readyTimeoutSecondsFor(spec: SandboxSpec): number {
  if (spec.egress.default !== "deny") return DEFAULT_READY_TIMEOUT_SECONDS;
  return Math.max(DEFAULT_READY_TIMEOUT_SECONDS, Math.ceil(spec.lifetime_seconds / 10));
}

function connectionConfigFor(spec: SandboxSpec): OpenSandboxConnectionConfig {
  const parsed = new URL(spec.opensandbox.base_url);
  return {
    domain: parsed.host,
    protocol: parsed.protocol === "https:" ? "https" : "http",
    apiKey: process.env[spec.opensandbox.api_key_env],
    requestTimeoutSeconds: spec.request_timeout_seconds,
    useServerProxy: spec.opensandbox.use_server_proxy,
  };
}

/**
 * PR A creates with `spec.env` VERBATIM — no broker exists in this PR slice
 * (design §4.1's env table; §11's "Deliberately NOT in A"). `sandboxSpecFor`
 * already resolved it as `sandbox.env_allowlist ∩ (agent.env_allowlist ??
 * everything)` for exactly the agent this lease is keyed to.
 */
function createEnv(spec: SandboxSpec): Record<string, string> {
  return { ...spec.env };
}

/**
 * OpenSandbox validates every metadata value against Kubernetes label rules
 * AT CREATE (`_is_valid_label_value`: `[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?`,
 * <=63 chars) — `lease_key` under the default `scope: agent` is
 * `<adw_id>/<agent>`, and the `/` alone fails create unconditionally. Same
 * sanitization the Cloudflare adapter already applies to this exact field
 * (`sandbox_cloudflare.ts`'s `bridgeStub`).
 */
function sanitizeMetadataLabelValue(value: string): string {
  const replaced = value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 63);
  return replaced.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "") || "_";
}

async function createNativeSandbox(spec: SandboxSpec, load: SdkLoader): Promise<OpenSandboxInstance> {
  const sdk = await load();
  const metadataPrefix = spec.opensandbox.metadata_prefix;
  return sdk.Sandbox.create({
    connectionConfig: connectionConfigFor(spec),
    image: spec.image,
    env: createEnv(spec),
    timeoutSeconds: spec.lifetime_seconds,
    metadata: {
      [`${metadataPrefix}.adw_id`]: sanitizeMetadataLabelValue(spec.adw_id),
      [`${metadataPrefix}.agent`]: sanitizeMetadataLabelValue(spec.agent),
      [`${metadataPrefix}.lease_key`]: sanitizeMetadataLabelValue(spec.lease_key),
    },
    networkPolicy: {
      defaultAction: spec.egress.default,
      egress: spec.egress.allow.map((target) => ({ action: "allow" as const, target })),
    },
    readyTimeoutSeconds: readyTimeoutSecondsFor(spec),
  });
}

// ── find-or-create (design §4.1's lifecycle pseudocode) ────────────────────

/**
 * This module's own cache of the native instance + driver behind each live
 * lease, keyed identically to `sandbox.ts`'s `LEASES` map (`spec.lease_key`).
 * `SandboxLease.native` (§4.3) deliberately exposes only `endpointUrl` /
 * `egress` / `renew` — never the raw handle — so the `hit` branch below
 * resolves its driver here, not through the lease.
 */
const NATIVE_BY_LEASE = new Map<string, { native: OpenSandboxInstance; driver: SandboxDriver }>();

/** @internal not yet implemented in this build — see this module's header comment. */
export function openSandboxFactory(spec: SandboxSpec, load: SdkLoader = loadOpenSandboxSdk): SandboxFactory {
  return {
    async createSandbox({ id }) {
      const key = spec.lease_key;
      const existing = getLease(key);

      if (existing) {
        // HIT — no reconcile here (send()'s pre-dispatch call owns it, §5.4);
        // the clock is the only thing touched.
        await renewLease(existing);
        if (!existing.flue_conversation_ids.includes(id)) existing.flue_conversation_ids.push(id);
        const cached = NATIVE_BY_LEASE.get(key);
        if (!cached) {
          throw new Error(
            `sandbox: internal error — a lease exists for ${JSON.stringify(key)} but this process has no cached opensandbox driver for it`,
          );
        }
        return sandboxFromDriver(cached.driver, spec.workspace_dir, {
          onOrphanSettled: (settlement) =>
            existing.log({
              level: "warn",
              msg: "sandbox: a command orphaned by an abort settled after the caller was released",
              data: { command: settlement.command },
            }),
        });
      }

      // MISS — create, preflight, seed, register. Never leaves a lease or a
      // journal entry behind on failure; never leaks the native sandbox either.
      const native = await createNativeSandbox(spec, load);
      const driver = buildDriver(() => Promise.resolve(native), spec);
      const transport = transportFromDriver(driver, spec);
      try {
        await preflight(spec, transport);
        const seeded = await seedViaTransport(spec, transport);

        const lease = registerLease(key, spec, transport);
        lease.provider_id = native.id;
        lease.seeded = seeded;
        lease.native = {
          endpointUrl: (port: number) => native.getEndpointUrl(port),
          egress: () => native.getEgressPolicy(),
          renew: (seconds: number) => native.renew(seconds),
        };
        // Position 1 and (what will be) position 3 — position 2 stays free
        // for PR B's `credentials:revoke` (design §4.3/§11): a step's own
        // failure never skips the next one (`teardownLease` in `sandbox.ts`).
        // `provider:uncache` rides after both, at (what will be) position 4:
        // otherwise this module's own NATIVE_BY_LEASE cache — and the native
        // SDK handle (and its keep-alive undici pool) it holds — is retained
        // for the process lifetime; a long-lived `spf watch` accumulates one
        // entry per agent per issue forever.
        lease.teardown.push(
          { name: "provider:kill", run: () => native.kill() },
          { name: "provider:close", run: () => native.close() },
          { name: "provider:uncache", run: async () => { NATIVE_BY_LEASE.delete(key); } },
        );
        lease.flue_conversation_ids.push(id);
        NATIVE_BY_LEASE.set(key, { native, driver });

        return sandboxFromDriver(driver, spec.workspace_dir, {
          onOrphanSettled: (settlement) =>
            lease.log({
              level: "warn",
              msg: "sandbox: a command orphaned by an abort settled after the caller was released",
              data: { command: settlement.command },
            }),
        });
      } catch (error) {
        await native.kill().catch(() => {});
        await native.close().catch(() => {});
        throw error;
      }
    },
  };
}
