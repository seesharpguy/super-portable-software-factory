/**
 * Hand-written surface of `@alibaba-group/opensandbox` v0.1.11 (SPF #15
 * design doc §4.1's "SDK dependency — no new entry in package.json").
 *
 * NOTHING in this file imports the real package — every shape below is
 * copied from the spike's MEASURED API surface (see the scratchpad's
 * `sandbox-spike.json`, `api_surface` field), not from the package's own
 * `.d.ts` (which is never on disk in this tree: the SDK is a documented user
 * install, §4.1, never a `package.json` dependency). `sandbox_opensandbox.ts`
 * types `loadOpenSandboxSdk`'s return value against these interfaces so the
 * whole tree typechecks with the SDK absent from `node_modules` — exactly
 * the trade `CloudflareSandboxStub` makes deliberately
 * (`dist/cloudflare/index.d.mts:6-12`: "A wrong object fails loudly on the
 * first method call").
 *
 * A shape mismatch against a REAL installed SDK surfaces as a runtime error
 * from the first call that touches the mismatched field, never as a compile
 * error — there is nothing here for `tsc` to check it against.
 */

// ── ConnectionConfig ─────────────────────────────────────────────────────────

export interface OpenSandboxConnectionConfig {
  domain: string;
  protocol?: "http" | "https";
  apiKey?: string;
  /** The SDK's CLIENT-SIDE HTTP timeout for control-plane calls. NOT a bound on a streamed `commands.run`. */
  requestTimeoutSeconds?: number;
  headers?: Record<string, string>;
  useServerProxy?: boolean;
}

// ── create ────────────────────────────────────────────────────────────────

export interface OpenSandboxNetworkPolicy {
  defaultAction: "allow" | "deny";
  egress?: Array<{ action: "allow" | "deny"; target: string }>;
}

export interface OpenSandboxCreateOptions {
  connectionConfig: OpenSandboxConnectionConfig;
  image: string;
  entrypoint?: string;
  /** Provider-side lease expiry, in seconds — `sandbox.renew()` extends it while a lease is live. */
  timeoutSeconds?: number;
  env?: Record<string, string>;
  resource?: unknown;
  metadata?: Record<string, string>;
  networkPolicy?: OpenSandboxNetworkPolicy;
  credentialProxy?: unknown;
  extensions?: unknown;
  skipHealthCheck?: boolean;
  healthCheck?: unknown;
  /** Readiness bound — distinct from `requestTimeoutSeconds`. The spike measured a 30-90s cold egress-sidecar start against exactly this knob. */
  readyTimeoutSeconds?: number;
}

// ── commands.run ─────────────────────────────────────────────────────────

export interface OpenSandboxCommandOptions {
  /** Maps to the API's `cwd` — the SDK's own field name is `workingDirectory`, not `cwd` (confirmed against the installed SDK's `.d.ts`). */
  workingDirectory?: string;
  /** The SDK's own field name is `envs`, not `env`. */
  envs?: Record<string, string>;
  /**
   * O-1 (open question, design §12): the spike documented `commands.run`'s
   * signature but never measured whether it accepts a per-command deadline.
   * Forwarded best-effort, seconds, rounded UP per `sandbox-api.md:225` —
   * the adapter's OWN host-side timer (§4.1 point 3) is what actually
   * enforces the deadline regardless of whether the SDK honors this field.
   */
  timeoutSeconds?: number;
}

export interface OpenSandboxLogChunk {
  text: string;
}

export interface OpenSandboxCommandResult {
  logs: { stdout: OpenSandboxLogChunk[]; stderr: OpenSandboxLogChunk[] };
  exitCode: number;
  executionTimeMs: number;
}

export interface OpenSandboxExecutionHandlers {
  onStdout?: (chunk: OpenSandboxLogChunk) => void;
  onStderr?: (chunk: OpenSandboxLogChunk) => void;
  onExecutionComplete?: (result: OpenSandboxCommandResult) => void;
}

export interface OpenSandboxCommandsApi {
  run(command: string, options?: OpenSandboxCommandOptions, handlers?: OpenSandboxExecutionHandlers): Promise<OpenSandboxCommandResult>;
}

// ── files ─────────────────────────────────────────────────────────────────

export interface OpenSandboxDirEntry {
  path: string;
  mode?: number;
}

export interface OpenSandboxFileEntry {
  path: string;
  data: string | Uint8Array;
  mode?: number;
}

export interface OpenSandboxFilesApi {
  createDirectories(dirs: OpenSandboxDirEntry[]): Promise<void>;
  writeFiles(files: OpenSandboxFileEntry[]): Promise<void>;
  readFile(path: string): Promise<string>;
  search(options: { path: string; pattern: string }): Promise<unknown>;
  deleteDirectories(paths: string[]): Promise<void>;
}

// ── lifecycle / egress / endpoints ──────────────────────────────────────────

export interface OpenSandboxInfo {
  status: { state: string };
  createdAt: string;
  expiresAt: string;
}

export interface OpenSandboxEgressRule {
  action: "allow" | "deny";
  target: string;
}

export interface OpenSandboxEgressPolicy {
  defaultAction: "allow" | "deny";
  egress: OpenSandboxEgressRule[];
}

// ── the Sandbox instance ─────────────────────────────────────────────────

export interface OpenSandboxInstance {
  readonly id: string;
  commands: OpenSandboxCommandsApi;
  files: OpenSandboxFilesApi;
  getInfo(): Promise<OpenSandboxInfo>;
  pause(): Promise<void>;
  /** Resumes returns a FRESH connected instance — not `this`, per the spike. */
  resume(): Promise<OpenSandboxInstance>;
  renew(seconds: number): Promise<void>;
  /** Terminates the remote sandbox + sidecar. Does NOT release the local HTTP agent — see `close()`. */
  kill(): Promise<void>;
  /** Releases the Node undici keep-alive agent. Separate from `kill()` — BOTH are required teardown calls (spike caveat). */
  close(): Promise<void>;
  getEndpoint(port: number): Promise<{ endpoint: string }>;
  getEndpointUrl(port: number): Promise<string>;
  /** Talks directly to the egress sidecar's own REST surface on sandbox port 18080 — NOT proxied through the control plane. */
  getEgressPolicy(): Promise<OpenSandboxEgressPolicy>;
  patchEgressRules(rules: OpenSandboxEgressRule[]): Promise<void>;
}

export interface OpenSandboxCtor {
  create(options: OpenSandboxCreateOptions): Promise<OpenSandboxInstance>;
}

// ── SandboxManager (admin sweep) ─────────────────────────────────────────

export interface OpenSandboxManagerListItem {
  id: string;
  metadata?: Record<string, string>;
  status?: { state: string };
}

export interface OpenSandboxManagerListResult {
  items: OpenSandboxManagerListItem[];
  pagination?: unknown;
}

export interface OpenSandboxManagerInstance {
  listSandboxInfos(options?: { states?: string[]; pageSize?: number }): Promise<OpenSandboxManagerListResult>;
  close(): Promise<void>;
}

export interface OpenSandboxManagerCtor {
  create(options: { connectionConfig: OpenSandboxConnectionConfig }): Promise<OpenSandboxManagerInstance>;
}

/** The module namespace shape `import(OPENSANDBOX_SPECIFIER)` resolves to. */
export interface OpenSandboxModuleShape {
  Sandbox: OpenSandboxCtor;
  SandboxManager: OpenSandboxManagerCtor;
}
