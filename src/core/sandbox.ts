/**
 * Sandbox lease registry, workspace transport, and teardown chain — SPF #15.
 *
 * `SandboxSpec`/`SandboxBackend`/`SandboxScope` live in `data_types.ts`
 * beside the valibot schemas they are derived from (that leaf module imports
 * only valibot; this one is runtime machinery). Everything ELSE the design
 * needs lives here: `SandboxTransport`/`SandboxLease`/`TeardownStep`/
 * `SandboxLog`, the process-local lease registry keyed on `spec.lease_key`,
 * `registerRunLog`'s logger channel, the teardown chain, and the workspace
 * transport (seed / reconcile / extract) written ONCE against the abstract
 * `SandboxTransport` — both backends (OpenSandbox's `SandboxDriver`,
 * Cloudflare's `CloudflareSandboxStub`) satisfy it, so there is exactly one
 * copy of the git sequences below, not one per adapter.
 *
 * The ONE invariant everything in the transport section exists to hold:
 * at every sync point, the sandbox's git HEAD tree is byte-identical to the
 * host tree the judges (permissions/gates/quality/changes) will inspect —
 * tree equality, not history equality. See the design doc's §5.2 for the
 * full proof and the measured transcripts this code reproduces.
 *
 * Backend adapters (`sandbox_opensandbox.ts`, `sandbox_cloudflare.ts`) are a
 * separate slice of this feature — see their own module comments. This file
 * dispatches to them (`factoryFor`) and calls into their transport objects
 * (`seedViaTransport`, `preflight`, `reconcileWorkspace`, `extractWorkspace`)
 * but owns no SDK-specific code itself.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxFactory } from "@flue/runtime";
import type { SandboxSpec } from "./data_types.ts";
import { cloudflareFactory } from "./sandbox_cloudflare.ts";
import { openSandboxFactory } from "./sandbox_opensandbox.ts";

// ── shared runtime types (SandboxSpec/Backend/Scope stay in data_types.ts) ──

/**
 * The live handle the transport (seed/reconcile/extract below) issues
 * commands through. FIVE verbs — narrowed to exactly what BOTH backends can
 * satisfy: OpenSandbox's `SandboxDriver` and Cloudflare's
 * `CloudflareSandboxStub` (7 methods, no `stat`). `readFile` is
 * `Promise<string>` on both, so the transport never hands it a patch —
 * patches cross as base64 (see `applyPatchInSandbox`/`extractWorkspace`
 * below); `readFileBuffer` is for the handoff mirror's small binaries.
 * `size` replaces `stat` for the one thing the patch-size guard needs,
 * because neither backend has a native `stat` in common.
 *
 * `cwd` is REQUIRED on `exec`: the raw driver resolves relative paths
 * against the SDK's own default cwd, not `workspace_dir`.
 */
export interface SandboxTransport {
  exec(cmd: string, opts: { cwd: string; timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  /** Bytes, or null when it cannot be determined (`exec("wc -c < <path>")`, parsed). */
  size(path: string): Promise<number | null>;
}

export type SandboxLog = (event: { level: "info" | "warn" | "error"; msg: string; data?: unknown }) => void;

export type TeardownStep = { name: string; run: () => Promise<void> };

/**
 * The registered handle for one live sandbox. `registerLease` creates the
 * shell (three args — the logger is resolved per-call from `RUN_LOGS`, never
 * passed in); the adapter that created the underlying provider sandbox sets
 * `provider_id`/`native` and pushes its own `teardown` steps afterward.
 */
export interface SandboxLease {
  spec: SandboxSpec;
  /** Provider id — printed by `spf sandbox list`, the human's drop-in handle. Set by the adapter after create. */
  provider_id: string;
  transport: SandboxTransport;
  /** Resolved, per call, as `RUN_LOGS.get(this.spec.adw_id) ?? NOOP_LOG` — never captured at registration time. */
  log: SandboxLog;
  created_at: string;
  /** Seed fingerprint: {head_sha, patch_sha256}. Drives reconcile; updated by extractWorkspace on the way out. */
  seeded: { head_sha: string; patch_sha256: string } | null;
  /** Committed sync points so far. Names the extract's marker commit. */
  turn: number;
  /** Flue conversation ids that shared this lease. Trace only, never a key. */
  flue_conversation_ids: string[];
  /** Native, provider-specific surface. NEVER attached to the flue Sandbox. */
  native: { endpointUrl?(port: number): Promise<string>; egress?(): Promise<unknown>; renew?(seconds: number): Promise<void> };
  teardown: TeardownStep[];
}

// ── credential lifecycle (SPF #15 PR B, design §6) ──────────────────────────

/**
 * The live grant behind one lease's create-time `env`. `env` is what
 * `createEnv(spec)` (each adapter's `createSandbox` MISS branch) hands the
 * provider's create call — the ONLY place `issue()` is ever awaited
 * (`factoryFor` itself stays sync, §6.1/§9). `describe()` is the honest
 * one-liner `spf sandbox list`/`doctor` print: key NAMES only, NEVER a
 * value — the same never-log discipline this file already applies to patch
 * bytes and handoff content. `revoke()` is pushed as the `credentials:revoke`
 * teardown step, at position 2 of the chain both adapters left free for it
 * (see each adapter's MISS branch for the exact splice) — the ordering
 * guarantee itself (a position-2 step is never skipped because position 1
 * threw) is `teardownLease`'s, tested against a fake step; this is the real
 * step riding that proven chain.
 */
export interface CredentialGrant {
  env: Record<string, string>;
  describe(): string;
  revoke(): Promise<void>;
}

/**
 * `id` is the value `sandbox.credentials.broker` names in config —
 * `KNOWN_CREDENTIAL_BROKER_IDS` below is the registry `validateSandboxConfig`
 * (agents.ts) checks an unknown name against, so a typo is a hard config
 * error rather than a silent fallback to `static` (§6.1). `issue(spec)`
 * returns a `Promise` on purpose: a real provisioning broker (§6.3 — not
 * built here, §10 non-goal 2) needs the network, and shaping the interface
 * around that up front means a future broker is a pure insertion, never a
 * signature change to this one.
 */
export interface CredentialBroker {
  id: string;
  issue(spec: SandboxSpec): Promise<CredentialGrant>;
}

/**
 * Factored out of `staticBroker.issue()` so `spf doctor`'s per-agent line
 * (§7 check #9) can print the IDENTICAL sentence a real grant's `describe()`
 * would, from key NAMES it already resolved from config alone — doctor has
 * no live `SandboxSpec` and, deliberately, never reads operator-env VALUES
 * just to build this string.
 */
export function describeStaticCredentials(keyNames: string[]): string {
  const sorted = [...new Set(keyNames)].sort();
  if (sorted.length === 0) {
    return "static broker: no credentials issued (sandbox.env_allowlist resolves to none for this agent)";
  }
  return (
    `static broker: ${sorted.length} key(s) copied from the operator environment at create time (${sorted.join(", ")}) — ` +
    `revoke() clears SPF's own in-memory copy only; the key itself is never rotated or invalidated ` +
    `(§6.2 — true revocation needs a provider provisioning API, which this build does not have)`
  );
}

/**
 * The ONLY broker registered in this build (§10 non-goal 2; §11's "Deliberately
 * NOT in A"). `issue()` is the identity on `spec.env` — B is observably a
 * no-op on the env PLANE (§6.1); what it adds is this seam, the ordered
 * revoke step, and the describe() line. `revoke()` clears the grant's own
 * `env` object IN PLACE — it does not, and cannot, un-inject an
 * already-created container's process environment; §6.2 is explicit that
 * "revocable" means nothing for a static key, and this is the honest
 * implementation of that, not a `revoke()` that pretends otherwise.
 */
export const staticBroker: CredentialBroker = {
  id: "static",
  async issue(spec) {
    const env: Record<string, string> = { ...spec.env };
    const keyNames = Object.keys(env).sort();
    return {
      env,
      describe: () => describeStaticCredentials(keyNames),
      async revoke() {
        for (const key of Object.keys(env)) delete env[key];
      },
    };
  },
};

/** The registry `validateSandboxConfig` checks `sandbox.credentials.broker` against (agents.ts). */
export const KNOWN_CREDENTIAL_BROKER_IDS: readonly string[] = [staticBroker.id];

// ── the lease registry ──────────────────────────────────────────────────────

const NOOP_LOG: SandboxLog = () => {};

/**
 * THE LOGGER CHANNEL. Module-level, keyed on adw_id, called from where a
 * tracer is genuinely in hand (`agents.ts`'s `execute()`, immediately after
 * the spec is built). Leases resolve `lease.log` through this map with a
 * no-op fallback, so a lease created by a caller that never registered one
 * still works and simply logs nowhere. `teardownRun(adwId)` DELETES the
 * entry — otherwise `spf watch` would retain a closure over every Run it
 * ever processed.
 */
export function registerRunLog(adwId: string, log: SandboxLog): void {
  RUN_LOGS.set(adwId, log);
}

/**
 * Resolves the CURRENT registration for `adwId`, falling back to the no-op —
 * the same lookup `SandboxLease.log` performs, exposed for callers (the
 * seed) that run BEFORE any lease exists and therefore have no `lease.log`
 * to reach through.
 */
function resolveRunLog(adwId: string): SandboxLog {
  return RUN_LOGS.get(adwId) ?? NOOP_LOG;
}

const RUN_LOGS = new Map<string, SandboxLog>();
const LEASES = new Map<string, SandboxLease>();

/**
 * Registers a created lease. THREE arguments — the logger is not one of
 * them (see `SandboxLease.log`'s doc comment). Returns the mutable lease so
 * the caller (an adapter) can set `provider_id`/`native` and push its own
 * `teardown` steps once the underlying provider sandbox actually exists.
 */
export function registerLease(key: string, spec: SandboxSpec, transport: SandboxTransport): SandboxLease {
  const lease: SandboxLease = {
    spec,
    provider_id: "",
    transport,
    log: (event) => (RUN_LOGS.get(spec.adw_id) ?? NOOP_LOG)(event),
    created_at: new Date().toISOString(),
    seeded: null,
    turn: 0,
    flue_conversation_ids: [],
    native: {},
    teardown: [],
  };
  LEASES.set(key, lease);
  return lease;
}

/** Find-or-create lookup for adapters — not exported in the design doc's own code block, but required by it: `createSandbox`'s `hit`/`miss` branch reads exactly this. */
export function getLease(key: string): SandboxLease | undefined {
  return LEASES.get(key);
}

export function leases(): SandboxLease[] {
  return [...LEASES.values()];
}

/**
 * Bounded renewal for the adapter's `hit` branch: `min(lifetime_seconds,
 * remaining budget to max_total_lifetime_seconds)`. Throws — never silently
 * truncates to zero — once the ceiling from creation has passed, so a
 * long-lived `spf watch` process cannot renew a lease forever.
 */
export async function renewLease(lease: SandboxLease): Promise<void> {
  if (!lease.native.renew) return;
  const createdAtMs = new Date(lease.created_at).getTime();
  const maxEndMs = createdAtMs + lease.spec.max_total_lifetime_seconds * 1000;
  const remainingSeconds = Math.floor((maxEndMs - Date.now()) / 1000);
  if (remainingSeconds <= 0) {
    throw new Error(
      `sandbox: lease ${JSON.stringify(lease.spec.lease_key)} has exceeded sandbox.max_total_lifetime_seconds ` +
        `(${lease.spec.max_total_lifetime_seconds}s since ${lease.created_at}) — renewal refused`,
    );
  }
  const seconds = Math.min(lease.spec.lifetime_seconds, remainingSeconds);
  await lease.native.renew(seconds);
}

// ── teardown chain ───────────────────────────────────────────────────────────

export async function teardownLease(lease: SandboxLease): Promise<void> {
  for (const step of lease.teardown) {
    try {
      await step.run();
    } catch (error) {
      lease.log({
        level: "error",
        msg: `sandbox teardown step ${JSON.stringify(step.name)} failed`,
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

/** Tears down every lease whose `spec.adw_id === adwId` — a SET, not a single lease (see design §4.3). */
export async function teardownRun(adwId: string): Promise<void> {
  const mine = leases().filter((l) => l.spec.adw_id === adwId);
  for (const lease of mine) {
    await teardownLease(lease);
    for (const [key, value] of LEASES) {
      if (value === lease) {
        LEASES.delete(key);
        break;
      }
    }
  }
  RUN_LOGS.delete(adwId);
}

export async function teardownAll(): Promise<void> {
  for (const lease of leases()) await teardownLease(lease);
  LEASES.clear();
}

/**
 * Per-RUN scope, keyed EXPLICITLY on the run's adw_id — never on ambient
 * async context. Flue's claim loop is detached from the wrap site's own
 * async context (see the design doc's §4.3 "Why not AsyncLocalStorage"), so
 * `createSandbox` runs outside any `AsyncLocalStorage` scope a wrapper here
 * could establish. Attribution instead rides data already in hand:
 * `lease.spec.adw_id`, written at create time.
 */
export async function withRunScope<T>(adwId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    await teardownRun(adwId);
  }
}

// ── backend dispatch ─────────────────────────────────────────────────────────

/**
 * SYNC. Returns a closure; performs NO I/O. Every provider call — the
 * preflight, the seed, the `setup` commands — lives inside the returned
 * `createSandbox`, which is the async boundary flue awaits itself.
 */
export function factoryFor(spec: SandboxSpec): SandboxFactory {
  if (spec.backend === "opensandbox") return openSandboxFactory(spec);
  if (spec.backend === "cloudflare") return cloudflareFactory(spec);
  throw new Error(
    `sandbox.factoryFor: backend ${JSON.stringify(spec.backend)} has no remote factory — "local" is handled by agent_flue.ts's sandboxFor() directly and never reaches here`,
  );
}

// ── small path/shell helpers shared by the transport below ─────────────────

/** Single-quote a path for the container shell; embedded quotes become '\''. Mirrors flue's own `cloudflare/index.mjs` helper. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Repo-relative POSIX form of `child` under `root`, or null when `child` is not under `root` (both already-normalized POSIX paths). */
function relativeIfUnder(root: string, child: string): string | null {
  const normRoot = path.posix.normalize(root).replace(/\/+$/, "") || "/";
  const normChild = path.posix.normalize(child);
  if (normChild === normRoot) return "";
  if (normChild.startsWith(`${normRoot}/`)) return normChild.slice(normRoot.length + 1);
  return null;
}

// ── host-side git plumbing (byte-safe: Buffers, never a UTF-8 round-trip) ──

function runGit(args: string[], cwd: string, env?: Record<string, string>): { stdout: Buffer; stderr: Buffer; status: number } {
  const result = spawnSync("git", args, { cwd, env: env ? { ...process.env, ...env } : process.env });
  return { stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0), status: result.status ?? 1 };
}

/** For ASCII/short output only (rev-parse, write-tree, …) — never for diff bytes. */
function gitText(args: string[], cwd: string, env?: Record<string, string>): string {
  const r = runGit(args, cwd, env);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${r.stderr.toString("utf-8")}`);
  return r.stdout.toString("utf-8");
}

/** Raw bytes — the only safe way to capture `git diff --binary` output. */
function gitBuffer(args: string[], cwd: string, env?: Record<string, string>): Buffer {
  const r = runGit(args, cwd, env);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} (in ${cwd}) failed: ${r.stderr.toString("utf-8")}`);
  return r.stdout;
}

function requireHostCommit(hostRoot: string): void {
  const r = runGit(["rev-parse", "--verify", "HEAD"], hostRoot);
  if (r.status !== 0) {
    throw new Error(`sandbox: ${hostRoot} has no commits yet — run 'git commit' at least once before running a sandboxed chain here`);
  }
}

/**
 * Submodules are out of scope (§5.2): a gitlink carries no content in ANY
 * export mechanism, so `checkout-index` writes the gitlink directory entry
 * only — the seeded tree is the superproject alone. Detected once, at the
 * seed, and reported as a single `warn` naming the submodule paths — never
 * a `validate()` failure, because a submodule-bearing repo must still be
 * able to run. Parses `.gitmodules`'s `path = ` lines directly rather than
 * shelling out to `git submodule status`, which requires the submodules to
 * already be registered/initialized to enumerate cleanly.
 */
function listSubmodulePaths(hostRoot: string): string[] {
  const gitmodulesPath = path.join(hostRoot, ".gitmodules");
  if (!existsSync(gitmodulesPath)) return [];
  const text = readFileSync(gitmodulesPath, "utf-8");
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
    if (match) paths.push(match[1]!);
  }
  return paths;
}

/**
 * Attributes-proof HEAD tree, host-side: a TEMPORARY index (the operator's
 * real index is never touched) plus `checkout-index`, never `git archive`.
 * `git archive` honors in-tree `.gitattributes` — `export-ignore` drops
 * files, `export-subst` rewrites `$Format:…$` placeholders — so it does not
 * produce the host tree. `checkout-index` writes the index's blobs verbatim.
 */
function buildHeadTreeTar(hostRoot: string): Buffer {
  const workDir = mkdtempSync(path.join(tmpdir(), "spf-sbx-seed-"));
  try {
    const tmpIndex = path.join(workDir, "index");
    const checkoutDir = path.join(workDir, "tree");
    mkdirSync(checkoutDir, { recursive: true });
    const env = { GIT_INDEX_FILE: tmpIndex };
    gitText(["read-tree", "HEAD"], hostRoot, env);
    gitText(["checkout-index", "-a", "-f", `--prefix=${checkoutDir}${path.sep}`], hostRoot, env);
    const tarPath = path.join(workDir, "seed.tar");
    const tarResult = spawnSync("tar", ["-cf", tarPath, "-C", checkoutDir, "."]);
    if (tarResult.status !== 0) {
      throw new Error(`sandbox: tar -cf failed building the seed archive: ${(tarResult.stderr ?? Buffer.alloc(0)).toString("utf-8")}`);
    }
    return readFileSync(tarPath);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * The host's uncommitted delta (tracked edits + untracked adds + deletions +
 * mode changes), as ONE patch, computed against a TEMPORARY index so the
 * operator's real index is never touched. Empty (zero-length) on a clean
 * host tree — callers must treat that as the normal case, not an error.
 */
function computeUncommittedPatch(hostRoot: string): Buffer {
  const workDir = mkdtempSync(path.join(tmpdir(), "spf-sbx-patch-"));
  try {
    const tmpIndex = path.join(workDir, "index");
    const env = { GIT_INDEX_FILE: tmpIndex };
    gitText(["read-tree", "HEAD"], hostRoot, env);
    gitText(["add", "-A"], hostRoot, env);
    return gitBuffer(["-c", "core.autocrlf=false", "diff", "--cached", "--binary", "HEAD"], hostRoot, env);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** {head_sha, patch_sha256} — the fingerprint reconcile compares against `lease.seeded`. */
function hostFingerprint(hostRoot: string): { head_sha: string; patch_sha256: string } {
  const head_sha = gitText(["rev-parse", "HEAD"], hostRoot).trim();
  const patch = computeUncommittedPatch(hostRoot);
  const patch_sha256 = createHash("sha256").update(patch).digest("hex");
  return { head_sha, patch_sha256 };
}

// ── in-sandbox git plumbing, over SandboxTransport only ─────────────────────

/**
 * Materialize + apply/commit ONE patch inside the sandbox. Both directions
 * move a patch as base64 — never as a raw string through `readFile`/
 * `writeFile(string)` — because a non-UTF-8 byte in a TEXT diff hunk (any
 * source file without a NUL in its first 8000 bytes, e.g. Latin-1/Shift-JIS)
 * would be replaced by a UTF-8 round-trip, changing the patch's length and
 * making `git apply` fail on context mismatch. `--index` is what gives the
 * following commit something to commit; the empty-patch branch is the
 * MANDATORY else (a zero-byte patch makes `git apply` exit 128 — "No valid
 * patches in input" — and, without `--index`, a non-empty apply leaves the
 * commit with nothing staged, "no changes added to commit").
 */
async function applyPatchInSandbox(transport: SandboxTransport, spec: SandboxSpec, name: string, patch: Buffer): Promise<void> {
  const b64Path = path.posix.join(spec.scratch_dir, `${name}.b64`);
  const rawPath = path.posix.join(spec.scratch_dir, name);
  await transport.writeFile(b64Path, patch.toString("base64"));
  // Stdin redirection (`< file`), not a positional file argument: GNU
  // coreutils' `base64` accepts both spellings, but a BusyBox/BSD `base64`
  // may only support the redirect form — this keeps the transport working
  // on either without changing behavior on the GNU image the design targets.
  const decodeResult = await transport.exec(`base64 -d < ${shellQuote(b64Path)} > ${shellQuote(rawPath)}`, { cwd: spec.workspace_dir });
  if (decodeResult.exitCode !== 0) {
    throw new Error(`sandbox: failed to decode ${name} inside the sandbox: ${decodeResult.stderr}`);
  }

  if (patch.length === 0) {
    const r = await transport.exec("git tag -f spf-local spf-base", { cwd: spec.workspace_dir });
    if (r.exitCode !== 0) throw new Error(`sandbox: failed to tag spf-local at spf-base: ${r.stderr}`);
    return;
  }
  const applyCmd =
    `git -c core.autocrlf=false apply --index --binary --whitespace=nowarn ${shellQuote(rawPath)} && ` +
    `git -c user.email=spf@local -c user.name=spf commit -q -m spf-local && git tag -f spf-local`;
  const r = await transport.exec(applyCmd, { cwd: spec.workspace_dir });
  if (r.exitCode !== 0) throw new Error(`sandbox: failed to apply/commit the uncommitted host patch (${name}): ${r.stderr}`);
}

/** `.spf/` (belt) plus the handoff dir's repo-relative form when it happens to be nested despite validation — see the design doc's §5.2 step 5. */
async function excludeSpfFromSandboxGit(transport: SandboxTransport, spec: SandboxSpec): Promise<void> {
  const lines = [".spf/"];
  const handoffRel = relativeIfUnder(spec.workspace_dir, spec.handoff_sandbox);
  if (handoffRel !== null && handoffRel !== "") lines.push(`${handoffRel}/`);
  const excludePath = path.posix.join(spec.workspace_dir, ".git", "info", "exclude");
  const script = lines.map((line) => `printf '%s\\n' ${shellQuote(line)} >> ${shellQuote(excludePath)}`).join(" && ");
  const r = await transport.exec(script, { cwd: spec.workspace_dir });
  if (r.exitCode !== 0) throw new Error(`sandbox: failed to append ${excludePath}: ${r.stderr}`);
}

/** `exec("wc -c < <path>")`, trimmed and parsed — trim is load-bearing: BSD/busybox `wc` pads the number. */
async function sizeOf(transport: SandboxTransport, filePath: string, cwd: string): Promise<number | null> {
  const r = await transport.exec(`wc -c < ${shellQuote(filePath)}`, { cwd });
  if (r.exitCode !== 0) return null;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ── the handoff mirror (both directions; gitignored, so git cannot carry it) ─

function listHostFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out;
}

async function pushHandoffMirror(spec: SandboxSpec, transport: SandboxTransport): Promise<void> {
  await transport.exec(`mkdir -p ${shellQuote(spec.handoff_sandbox)}`, { cwd: spec.workspace_dir });
  for (const hostPath of listHostFilesRecursive(spec.handoff_host)) {
    const rel = path.relative(spec.handoff_host, hostPath).split(path.sep).join("/");
    const sandboxPath = path.posix.join(spec.handoff_sandbox, rel);
    const bytes = readFileSync(hostPath);
    if (bytes.length > spec.transport.max_mirror_bytes) {
      throw new Error(
        `sandbox: handoff mirror file ${hostPath} is ${bytes.length} bytes, over transport.max_mirror_bytes (${spec.transport.max_mirror_bytes})`,
      );
    }
    const dir = path.posix.dirname(sandboxPath);
    if (dir !== spec.handoff_sandbox) await transport.exec(`mkdir -p ${shellQuote(dir)}`, { cwd: spec.workspace_dir });
    await transport.writeFile(sandboxPath, bytes);
  }
}

async function mirrorFileBackToHost(transport: SandboxTransport, spec: SandboxSpec, sandboxPath: string, hostPath: string): Promise<void> {
  const size = await sizeOf(transport, sandboxPath, spec.workspace_dir);
  if (size !== null && size > spec.transport.max_mirror_bytes) {
    throw new Error(`sandbox: handoff mirror file ${sandboxPath} is ${size} bytes, over transport.max_mirror_bytes (${spec.transport.max_mirror_bytes})`);
  }
  const bytes = await transport.readFileBuffer(sandboxPath);
  if (bytes.length > spec.transport.max_mirror_bytes) {
    throw new Error(
      `sandbox: handoff mirror file ${sandboxPath} is ${bytes.length} bytes, over transport.max_mirror_bytes (${spec.transport.max_mirror_bytes})`,
    );
  }
  mkdirSync(path.dirname(hostPath), { recursive: true });
  writeFileSync(hostPath, bytes);
}

async function pullHandoffMirror(spec: SandboxSpec, transport: SandboxTransport): Promise<void> {
  const listing = await transport.exec(
    `[ -d ${shellQuote(spec.handoff_sandbox)} ] && find ${shellQuote(spec.handoff_sandbox)} -type f || true`,
    { cwd: spec.workspace_dir },
  );
  const sandboxPaths = listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const sandboxPath of sandboxPaths) {
    const rel = path.posix.relative(spec.handoff_sandbox, sandboxPath);
    const hostPath = path.join(spec.handoff_host, ...rel.split("/"));
    await mirrorFileBackToHost(transport, spec, sandboxPath, hostPath);
  }
  // Extra repo-relative paths git cannot carry (sandbox.transport.mirror).
  for (const relPath of spec.transport.mirror) {
    const sandboxPath = path.posix.join(spec.workspace_dir, relPath);
    const exists = await transport.exec(`test -e ${shellQuote(sandboxPath)}`, { cwd: spec.workspace_dir });
    if (exists.exitCode !== 0) continue;
    const hostPath = path.join(spec.host_root, ...relPath.split("/"));
    await mirrorFileBackToHost(transport, spec, sandboxPath, hostPath);
  }
}

// ── preflight ────────────────────────────────────────────────────────────────

/**
 * Mandatory create-time check, not a "leaning": the transport below shells
 * out to `git`, `tar` and `base64` inside the sandbox, so all three are hard
 * requirements of ANY image, not a convenience. Run by both adapters before
 * their seed.
 */
export async function preflight(spec: SandboxSpec, transport: SandboxTransport): Promise<void> {
  // Binaries first, against cwd "/" (always present) rather than
  // `workspace_dir` (not guaranteed to exist yet): a missing-binary image
  // must fail with the named "missing git, tar, or base64" error, not a
  // workspace_dir-creation error that happens to fire first because the
  // same broken exec path also can't run `mkdir`.
  const r = await transport.exec("git --version && tar --version && base64 --version", { cwd: "/" });
  if (r.exitCode !== 0) {
    throw new Error(
      `sandbox: image ${JSON.stringify(spec.image)} is missing git, tar, or base64 — the workspace transport requires all three. ` +
        `Use a debian-family image with git installed, or add the missing binaries via sandbox.setup. (${r.stderr || r.stdout})`,
    );
  }
  // Nothing creates `workspace_dir` before this point, and every exec after
  // preflight chdirs into it via `cwd` — create it now that binaries are confirmed.
  const mkdirResult = await transport.exec(`mkdir -p ${shellQuote(spec.workspace_dir)}`, { cwd: "/" });
  if (mkdirResult.exitCode !== 0) {
    throw new Error(`sandbox: failed to create workspace_dir ${JSON.stringify(spec.workspace_dir)}: ${mkdirResult.stderr}`);
  }
}

// ── seed (host -> sandbox), once per lease ──────────────────────────────────

/**
 * Seeds a freshly created sandbox from the host tree and returns the
 * fingerprint to store as `lease.seeded`. Steps mirror the design doc's
 * §5.2 exactly (refuse-no-commits, mkdir scratch+handoff FIRST, the
 * attributes-proof tar, extract, `git init`+`spf-base` tag, the uncommitted
 * delta as `spf-local`, the handoff mirror's mandatory first push, then
 * `setup`). Called by an adapter's `createSandbox` on the `miss` branch,
 * against the raw driver/stub transport before any lease exists.
 */
export async function seedViaTransport(spec: SandboxSpec, transport: SandboxTransport): Promise<{ head_sha: string; patch_sha256: string }> {
  requireHostCommit(spec.host_root);

  const submodulePaths = listSubmodulePaths(spec.host_root);
  if (submodulePaths.length > 0) {
    resolveRunLog(spec.adw_id)({
      level: "warn",
      msg: "sandbox: this repo has submodules — their content is not seeded, synced, or extracted (the superproject only is)",
      data: { submodules: submodulePaths },
    });
  }

  const mkdirResult = await transport.exec(`mkdir -p ${shellQuote(spec.scratch_dir)} ${shellQuote(spec.handoff_sandbox)}`, {
    cwd: spec.workspace_dir,
  });
  if (mkdirResult.exitCode !== 0) throw new Error(`sandbox: failed to create scratch_dir/handoff_dir: ${mkdirResult.stderr}`);

  // step 3 — attributes-proof HEAD tree, uploaded raw (no base64: this is a write of real bytes, not a read-back).
  const tar = buildHeadTreeTar(spec.host_root);
  if (tar.length > spec.transport.max_seed_bytes) {
    throw new Error(`sandbox: seed archive is ${tar.length} bytes, over transport.max_seed_bytes (${spec.transport.max_seed_bytes}) — fails loudly, never truncates`);
  }
  const seedTarPath = path.posix.join(spec.scratch_dir, "seed.tar");
  await transport.writeFile(seedTarPath, tar);

  // step 4
  const extractResult = await transport.exec(
    `tar -xf ${shellQuote(seedTarPath)} -C ${shellQuote(spec.workspace_dir)} && rm -f ${shellQuote(seedTarPath)}`,
    { cwd: spec.workspace_dir },
  );
  if (extractResult.exitCode !== 0) throw new Error(`sandbox: failed to extract the seed archive: ${extractResult.stderr}`);

  // step 5 — the -c user.email/-c user.name flags MUST attach to `commit`,
  // not to `add` (a no-op there): an image with no preconfigured git
  // identity otherwise fails this founding commit outright.
  const initResult = await transport.exec(
    "git init -q && git -c core.autocrlf=false add -A && " +
      "git -c user.email=spf@local -c user.name=spf commit -q -m spf-base && git tag -f spf-base",
    { cwd: spec.workspace_dir },
  );
  if (initResult.exitCode !== 0) throw new Error(`sandbox: failed to initialize the sandbox git repo: ${initResult.stderr}`);
  await excludeSpfFromSandboxGit(transport, spec);

  // step 6 — the host's uncommitted delta, so HEAD == the live host tree.
  const patch = computeUncommittedPatch(spec.host_root);
  if (patch.length > spec.transport.max_patch_bytes) {
    throw new Error(`sandbox: the host's uncommitted patch is ${patch.length} bytes, over transport.max_patch_bytes (${spec.transport.max_patch_bytes})`);
  }
  await applyPatchInSandbox(transport, spec, "seed.patch", patch);

  // step 6.5 — MANDATORY here: the first send's reconcileWorkspace is a
  // documented no-op (no lease exists yet), so this is the only thing that
  // establishes the handoff plane before the dispatch whose rendered prompt
  // names it.
  await pushHandoffMirror(spec, transport);

  // step 7 — setup, once per sandbox.
  for (const cmd of spec.setup) {
    const r = await transport.exec(cmd, { cwd: spec.workspace_dir, timeoutMs: spec.exec_timeout_seconds * 1000 });
    if (r.exitCode !== 0) throw new Error(`sandbox: setup command ${JSON.stringify(cmd)} failed (exit ${r.exitCode}): ${r.stderr}`);
  }

  return hostFingerprint(spec.host_root);
}

// ── reconcile: the host tree can change under the sandbox ──────────────────

/**
 * Compares the live host fingerprint against `lease.seeded` and applies
 * exactly one of two remedies on a mismatch — conflating them is a
 * data-loss bug (see the design doc's §5.4). A no-op when there is no lease
 * yet (the first send of a run — the seed that follows is the sync point)
 * OR when the fingerprint already matches (nothing has moved on the host
 * since the last sync point, so the sandbox's handoff content — already
 * synced by the last extract — cannot be stale either; no provider call at
 * all in that case).
 */
export async function reconcileWorkspace(spec: SandboxSpec): Promise<void> {
  const lease = LEASES.get(spec.lease_key);
  if (!lease) return;
  const transport = lease.transport;
  const live = hostFingerprint(spec.host_root);
  if (lease.seeded && lease.seeded.head_sha === live.head_sha && lease.seeded.patch_sha256 === live.patch_sha256) {
    // The WORKSPACE tree hasn't moved, but the handoff plane lives outside
    // git (under the gitignored data_dir) and is never covered by this
    // fingerprint — another agent can have written a handoff file (e.g. a
    // reviewer's `writes: []` review.md) since this lease's last sync
    // point. Push it every time, even on a fingerprint HIT, or a lease-hit
    // dispatch is handed artifact paths that don't exist in its container.
    await pushHandoffMirror(spec, transport);
    return; // workspace tree unchanged since the last sync point
  }

  if (lease.seeded && lease.seeded.head_sha === live.head_sha) {
    // ROW 2 — head_sha unchanged, patch differs: working-tree edits only.
    const resetResult = await transport.exec("git reset --hard spf-base && git clean -fd", { cwd: spec.workspace_dir });
    if (resetResult.exitCode !== 0) throw new Error(`sandbox: reconcile (working-tree edits) reset failed: ${resetResult.stderr}`);
    const patch = computeUncommittedPatch(spec.host_root);
    if (patch.length > spec.transport.max_patch_bytes) {
      throw new Error(`sandbox: reconcile patch is ${patch.length} bytes, over transport.max_patch_bytes (${spec.transport.max_patch_bytes})`);
    }
    await applyPatchInSandbox(transport, spec, "re.patch", patch);
  } else {
    // ROW 3 — the host committed: spf-base is stale. FULL RE-SEED, beginning
    // with the reset (tar -xf is additive; a stale tracked file the new
    // HEAD lacks would otherwise survive extraction). `setup` is NOT re-run.
    const tar = buildHeadTreeTar(spec.host_root);
    if (tar.length > spec.transport.max_seed_bytes) {
      throw new Error(`sandbox: re-seed archive is ${tar.length} bytes, over transport.max_seed_bytes (${spec.transport.max_seed_bytes})`);
    }
    const patch = computeUncommittedPatch(spec.host_root);
    if (patch.length > spec.transport.max_patch_bytes) {
      throw new Error(`sandbox: reconcile patch is ${patch.length} bytes, over transport.max_patch_bytes (${spec.transport.max_patch_bytes})`);
    }

    const resetResult = await transport.exec("git reset --hard spf-base && git clean -fd", { cwd: spec.workspace_dir });
    if (resetResult.exitCode !== 0) throw new Error(`sandbox: re-seed reset failed: ${resetResult.stderr}`);

    const seedTarPath = path.posix.join(spec.scratch_dir, "seed.tar");
    await transport.writeFile(seedTarPath, tar);
    // --allow-empty: the new HEAD's tree can coincide with the stale
    // spf-base's (e.g. a host-side no-op/--allow-empty commit) — the
    // re-seed's OWN commit must not fail merely because nothing changed,
    // for the same reason extractWorkspace's turn-commit doesn't either.
    const reseedResult = await transport.exec(
      `tar -xf ${shellQuote(seedTarPath)} -C ${shellQuote(spec.workspace_dir)} && rm -f ${shellQuote(seedTarPath)} && ` +
        "git -c core.autocrlf=false add -A && git -c user.email=spf@local -c user.name=spf commit -q --allow-empty -m spf-base && git tag -f spf-base",
      { cwd: spec.workspace_dir },
    );
    if (reseedResult.exitCode !== 0) throw new Error(`sandbox: re-seed extract/commit failed: ${reseedResult.stderr}`);

    await applyPatchInSandbox(transport, spec, "seed.patch", patch);
    lease.turn = 0;
  }

  lease.seeded = hostFingerprint(spec.host_root);
  await pushHandoffMirror(spec, transport);
}

// ── extract (sandbox -> host), after every dispatch resolves ───────────────

/**
 * Three ordered acts: stage+diff in-sandbox, apply on the host (atomic —
 * `--allow-empty` is mandatory here, the opposite fix from the in-sandbox
 * applies, because no commit follows it), then advance the sandbox's HEAD
 * with a marker commit so the NEXT extract emits an increment rather than
 * the cumulative delta again. A no-op when there is no lease yet.
 */
export async function extractWorkspace(spec: SandboxSpec): Promise<void> {
  const lease = LEASES.get(spec.lease_key);
  if (!lease) return;
  const transport = lease.transport;

  const outPatchPath = path.posix.join(spec.scratch_dir, "out.patch");
  const outPatchB64Path = path.posix.join(spec.scratch_dir, "out.patch.b64");
  const stageResult = await transport.exec(
    `git -c core.autocrlf=false add -A && git -c core.autocrlf=false diff --cached --binary HEAD > ${shellQuote(outPatchPath)} && ` +
      `base64 -w0 < ${shellQuote(outPatchPath)} > ${shellQuote(outPatchB64Path)}`,
    { cwd: spec.workspace_dir },
  );
  if (stageResult.exitCode !== 0) throw new Error(`sandbox: extract failed to stage/diff: ${stageResult.stderr}`);

  // size FIRST, read SECOND — fail loudly before transferring anything.
  const size = await sizeOf(transport, outPatchPath, spec.workspace_dir);
  if (size !== null && size > spec.transport.max_patch_bytes) {
    throw new Error(`sandbox: extract patch is ${size} bytes, over transport.max_patch_bytes (${spec.transport.max_patch_bytes})`);
  }
  const b64 = await transport.readFile(outPatchB64Path);
  const patch = Buffer.from(b64, "base64");
  if (size === null && patch.length > spec.transport.max_patch_bytes) {
    throw new Error(`sandbox: extract patch is ${patch.length} bytes, over transport.max_patch_bytes (${spec.transport.max_patch_bytes})`);
  }

  // 2. host: apply. Atomic; a failure changes nothing and fails the send.
  // --allow-empty is mandatory: scout/refiner/reviewer ship writes: [] and
  // write only into the handoff plane, so their workspace delta is empty by
  // design, every time — without the flag every one of their sends dies.
  const applyResult = spawnSync("git", ["apply", "--allow-empty", "--binary", "--whitespace=nowarn", "-p1", "-"], {
    cwd: spec.host_root,
    input: patch,
  });
  if (applyResult.status !== 0) {
    throw new Error(`sandbox: host git apply failed: ${(applyResult.stderr ?? Buffer.alloc(0)).toString("utf-8")}`);
  }

  // 3. in-sandbox, ONLY after the host apply succeeded: advance HEAD.
  lease.turn += 1;
  const commitResult = await transport.exec(
    `git -c user.email=spf@local -c user.name=spf -c core.autocrlf=false commit -q --allow-empty -m spf-turn-${lease.turn} && git tag -f spf-local`,
    { cwd: spec.workspace_dir },
  );
  if (commitResult.exitCode !== 0) throw new Error(`sandbox: extract's turn commit failed: ${commitResult.stderr}`);

  lease.seeded = hostFingerprint(spec.host_root);
  await pullHandoffMirror(spec, transport);
}
