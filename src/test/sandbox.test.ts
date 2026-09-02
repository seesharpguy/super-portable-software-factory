import "./hermetic_git.ts";

/**
 * SPF #15 — sandbox backends. Hermetic unit coverage for the pieces this
 * slice owns: config resolution (`sandboxSpecFor`), the two `validate()`
 * hooks (`validateSandboxConfig`/`validateSandboxRunScope`), the bidirectional
 * envelope path translation, the lease registry + teardown chain, and the
 * workspace transport's git sequences (seed/reconcile/extract).
 *
 * The transport tests run real `git`/`tar`/`base64` against a REAL temp
 * directory standing in for "the sandbox" — no network, no Docker, no
 * provider SDK. `SandboxTransport` is an interface; a fake that shells out
 * to a local directory is exactly as hermetic as `hermetic_git.ts`'s own
 * git-spawning tests elsewhere in this repo, and it is the only way to
 * actually exercise the shell command strings this module builds (the git
 * sequences are the point of this feature, not incidental plumbing).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import {
  AgentConfigSchema,
  SFConfigSchema,
  type AgentConfig,
  type EnvelopeBase,
  type SandboxSpec,
  type SFConfig,
} from "../core/data_types.js";
import {
  sandboxSpecFor,
  translateEnvelopePaths,
  translateEnvelopeToSandbox,
  validateSandboxConfig,
  validateSandboxRunScope,
} from "../core/agents.js";
import * as sandbox from "../core/sandbox.js";
import type { SandboxTransport } from "../core/sandbox.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeCfg(sandboxOverrides: Record<string, unknown> = {}): SFConfig {
  return v.parse(SFConfigSchema, { sandbox: sandboxOverrides }) as SFConfig;
}

function makeAgent(overrides: Record<string, unknown> = {}): AgentConfig {
  return v.parse(AgentConfigSchema, {
    name: "builder",
    prompt_engineering: { system: "s.md", user: "u.md" },
    ...overrides,
  }) as AgentConfig;
}

/** The minimal shape `sandboxSpecFor` reads from a `RunForAgents` — not exported, so a structural literal stands in. */
function makeRun(cfg: SFConfig, overrides: Partial<{ adw_id: string; repo_root: string; context_handoff_dir: string }> = {}) {
  const adw_id = overrides.adw_id ?? "run1";
  return {
    cfg,
    adw_id,
    tokens: 0,
    cost: 0,
    repo_root: overrides.repo_root ?? "/repo",
    spf_dir: null,
    data_dir: "/repo/.spf/data",
    session_dir: `/repo/.spf/data/sessions/${adw_id}`,
    context_handoff_dir: overrides.context_handoff_dir ?? `/repo/.spf/data/sessions/${adw_id}/context_handoff`,
    agent_map: {},
    tracer: {
      event: () => "",
      processStart: () => {},
      processEnd: () => {},
      envelopeRow: () => {},
      gateRow: () => {},
      agentSessionRow: () => {},
    },
    console: {
      agentStarted: () => {},
      gateResult: () => {},
      retry: () => {},
      envelopeSummary: () => {},
      agentFinished: () => {},
    },
    addUsage: () => {},
    saveAgentMap: () => {},
  };
}

// ── sandboxSpecFor ───────────────────────────────────────────────────────────

test("sandboxSpecFor: backend: local (the default) returns undefined — AgentRequest.sandbox stays unset", () => {
  const cfg = makeCfg();
  const run = makeRun(cfg);
  assert.equal(sandboxSpecFor(run as any, makeAgent()), undefined);
});

test("sandboxSpecFor: agent.sandbox three-state resolution — unset inherits, null inherits, a name overrides", () => {
  const cfg = makeCfg({ backend: "opensandbox" });
  const run = makeRun(cfg);

  const inherited = sandboxSpecFor(run as any, makeAgent());
  assert.equal(inherited?.backend, "opensandbox", "unset -> inherit sandbox.backend");

  const nulled = sandboxSpecFor(run as any, makeAgent({ sandbox: null }));
  assert.equal(nulled?.backend, "opensandbox", "null -> same as unset");

  const forcedLocal = sandboxSpecFor(run as any, makeAgent({ sandbox: "local" }));
  assert.equal(forcedLocal, undefined, "\"local\" on the agent forces local even when the repo default is remote");
});

test("sandboxSpecFor: lease_key is <adw_id>/<agent> under scope: agent (the default), <adw_id> under scope: run — and never carries a session id", () => {
  const perAgent = sandboxSpecFor(makeRun(makeCfg({ backend: "opensandbox" }), { adw_id: "abc123" }) as any, makeAgent({ name: "builder" }));
  assert.equal(perAgent?.lease_key, "abc123/builder");
  assert.ok(!perAgent!.lease_key.includes("spf-"), "lease_key must not carry a claude_code/flue session id shape");

  const perRun = sandboxSpecFor(
    makeRun(makeCfg({ backend: "opensandbox", scope: "run" }), { adw_id: "abc123" }) as any,
    makeAgent({ name: "builder" }),
  );
  assert.equal(perRun?.lease_key, "abc123");
});

test("sandboxSpecFor: handoff_sandbox preserves the sessions/<adw_id>/context_handoff shape two shipped prompts parse", () => {
  const spec = sandboxSpecFor(
    makeRun(makeCfg({ backend: "opensandbox", handoff_dir: "/spf/handoff" }), { adw_id: "xyz" }) as any,
    makeAgent(),
  )!;
  assert.equal(spec.handoff_sandbox, "/spf/handoff/sessions/xyz/context_handoff");
  // structural, not a string compare against a fixture: last three components match handoff_host's shape.
  const sandboxTail = spec.handoff_sandbox.split("/").slice(-3);
  const hostTail = spec.handoff_host.split("/").slice(-3);
  assert.deepEqual(sandboxTail, hostTail);
});

test("sandboxSpecFor: env_allowlist: [] (the default) yields {} even with a live operator secret planted — the single-agent exfiltration test", () => {
  const saved = process.env["SPF_SBX_SECRET"];
  try {
    process.env["SPF_SBX_SECRET"] = "should-never-appear";
    const spec = sandboxSpecFor(makeRun(makeCfg({ backend: "opensandbox" })) as any, makeAgent())!;
    assert.deepEqual(spec.env, {});
  } finally {
    if (saved === undefined) delete process.env["SPF_SBX_SECRET"];
    else process.env["SPF_SBX_SECRET"] = saved;
  }
});

test("sandboxSpecFor: per-agent env is the intersection, and two agents under scope: agent get DIFFERENT keys AND different lease_keys — the multi-agent regression", () => {
  const savedA = process.env["SPF_SBX_A"];
  const savedB = process.env["SPF_SBX_B"];
  try {
    process.env["SPF_SBX_A"] = "a-value";
    process.env["SPF_SBX_B"] = "b-value";
    const cfg = makeCfg({ backend: "opensandbox", env_allowlist: ["SPF_SBX_A", "SPF_SBX_B"] });
    const run = makeRun(cfg);
    const builder = sandboxSpecFor(run as any, makeAgent({ name: "builder", env_allowlist: ["SPF_SBX_A"] }))!;
    const reviewer = sandboxSpecFor(run as any, makeAgent({ name: "reviewer", env_allowlist: ["SPF_SBX_B"] }))!;

    assert.deepEqual(builder.env, { SPF_SBX_A: "a-value" });
    assert.deepEqual(reviewer.env, { SPF_SBX_B: "b-value" });
    assert.notEqual(builder.lease_key, reviewer.lease_key);
    // ENV_BASELINE_KEYS (PATH/HOME/...) must NOT be unioned in for a remote container.
    assert.ok(!("PATH" in builder.env), "no baseline-key union on the remote path");
  } finally {
    if (savedA === undefined) delete process.env["SPF_SBX_A"];
    else process.env["SPF_SBX_A"] = savedA;
    if (savedB === undefined) delete process.env["SPF_SBX_B"];
    else process.env["SPF_SBX_B"] = savedB;
  }
});

// ── validateSandboxConfig ────────────────────────────────────────────────────

test("validateSandboxConfig: claude_code + a resolved remote backend is rejected, naming both keys", () => {
  const cfg = makeCfg({ backend: "opensandbox", image: "debian-git", opensandbox: { base_url: "http://x" } });
  const problems = validateSandboxConfig(cfg, makeAgent({ coding_agent: "claude_code" }));
  assert.ok(problems.some((p) => p.includes("claude_code") && p.includes("opensandbox")));
});

test("validateSandboxConfig: opencode + a resolved remote backend is rejected, naming both keys — same subprocess-agent-on-a-remote-sandbox check now generalized to cover opencode alongside claude_code", () => {
  const cfg = makeCfg({ backend: "opensandbox", image: "debian-git", opensandbox: { base_url: "http://x" } });
  const problems = validateSandboxConfig(cfg, makeAgent({ coding_agent: "opencode" }));
  assert.ok(problems.some((p) => p.includes("opencode") && p.includes("opensandbox")));
});

test("validateSandboxConfig: opensandbox requires base_url and image; cloudflare requires bridge_url and api_token_env", () => {
  const os = validateSandboxConfig(makeCfg({ backend: "opensandbox", opensandbox: { base_url: "" } }), makeAgent());
  assert.ok(os.some((p) => p.includes("sandbox.opensandbox.base_url")));
  assert.ok(os.some((p) => p.includes("sandbox.image")));

  const cf = validateSandboxConfig(makeCfg({ backend: "cloudflare", cloudflare: { api_token_env: "" } }), makeAgent());
  assert.ok(cf.some((p) => p.includes("sandbox.cloudflare.bridge_url")));
  assert.ok(cf.some((p) => p.includes("sandbox.cloudflare.api_token_env")));

  // accepts an empty image on cloudflare — the key is meaningless there.
  const cfOk = validateSandboxConfig(makeCfg({ backend: "cloudflare", cloudflare: { bridge_url: "https://bridge", api_token_env: "TOK" } }), makeAgent());
  assert.ok(!cfOk.some((p) => p.includes("sandbox.image")));
});

test("validateSandboxConfig: sandbox.fanout: \"sandbox\" is honored as of PR B — no longer rejected", () => {
  const problems = validateSandboxConfig(makeCfg({ backend: "opensandbox", image: "debian-git", opensandbox: { base_url: "http://x" }, fanout: "sandbox" }), makeAgent());
  assert.ok(!problems.some((p) => p.includes("sandbox.fanout")), `sandbox.fanout: "sandbox" must not be rejected any more — got:\n${problems.join("\n")}`);
});

// ── credentials.broker (SPF #15 PR B, §6.1) ─────────────────────────────────

test("validateSandboxConfig: an unregistered sandbox.credentials.broker name is rejected, naming the value and the known registry", () => {
  const problems = validateSandboxConfig(makeCfg({ credentials: { broker: "openrouter" } }), makeAgent());
  assert.ok(problems.some((p) => p.includes("sandbox.credentials.broker") && p.includes("openrouter") && p.includes("static")));
});

test("validateSandboxConfig: the default \"static\" broker, and any other case-sensitive spelling of it, are accepted / rejected exactly", () => {
  assert.deepEqual(
    validateSandboxConfig(makeCfg({}), makeAgent()).filter((p) => p.includes("credentials.broker")),
    [],
    "the default (unset -> \"static\") must not be rejected",
  );
  const cased = validateSandboxConfig(makeCfg({ credentials: { broker: "Static" } }), makeAgent());
  assert.ok(cased.some((p) => p.includes("credentials.broker")), "broker ids are compared exactly — \"Static\" is not \"static\"");
});

test("validateSandboxConfig: max_total_lifetime_seconds < lifetime_seconds and request_timeout_seconds < exec_timeout_seconds are both rejected, naming both values", () => {
  const lifetime = validateSandboxConfig(makeCfg({ lifetime_seconds: 100, max_total_lifetime_seconds: 50 }), makeAgent());
  assert.ok(lifetime.some((p) => p.includes("max_total_lifetime_seconds") && p.includes("100") && p.includes("50")));

  const timeout = validateSandboxConfig(makeCfg({ exec_timeout_seconds: 1000, request_timeout_seconds: 500 }), makeAgent());
  assert.ok(timeout.some((p) => p.includes("request_timeout_seconds") && p.includes("exec_timeout_seconds")));
});

test("validateSandboxConfig: handoff_dir/scratch_dir at or under workspace_dir are rejected, including the normalized form — one shared rule for both planes", () => {
  const direct = validateSandboxConfig(makeCfg({ workspace_dir: "/workspace", handoff_dir: "/workspace/.spf/handoff" }), makeAgent());
  assert.ok(direct.some((p) => p.includes("handoff_dir")));

  const normalized = validateSandboxConfig(
    makeCfg({ workspace_dir: "/workspace", scratch_dir: "/workspace/../workspace/.spf/tmp" }),
    makeAgent(),
  );
  assert.ok(normalized.some((p) => p.includes("scratch_dir")));

  const equalPlanes = validateSandboxConfig(makeCfg({ handoff_dir: "/spf/x", scratch_dir: "/spf/x" }), makeAgent());
  assert.ok(equalPlanes.some((p) => p.includes("must not equal")));

  const relative = validateSandboxConfig(makeCfg({ workspace_dir: "workspace" }), makeAgent());
  assert.ok(relative.some((p) => p.includes("absolute path")));

  // the shipped defaults are accepted.
  assert.deepEqual(
    validateSandboxConfig(makeCfg({ backend: "local" }), makeAgent()).filter((p) => p.includes("workspace_dir") || p.includes("handoff_dir") || p.includes("scratch_dir")),
    [],
  );
});

// ── validateSandboxRunScope ──────────────────────────────────────────────────

test("validateSandboxRunScope: does not fire under scope: agent (the default) or when every required agent is local", () => {
  const cfg = makeCfg({ backend: "opensandbox", scope: "agent" });
  assert.deepEqual(validateSandboxRunScope(cfg, ["builder", "reviewer"]), []);

  const allLocal = makeCfg({ backend: "local", scope: "run" });
  assert.deepEqual(validateSandboxRunScope(allLocal, ["builder"]), []);
});

test("validateSandboxRunScope: scope: run accepts identical resolved env sets reached by different spellings", () => {
  const cfg: any = makeCfg({ backend: "opensandbox", scope: "run", env_allowlist: ["GH_TOKEN", "NPM_TOKEN"] });
  cfg.agents = [
    makeAgent({ name: "builder" }), // unset -> everything
    makeAgent({ name: "reviewer", env_allowlist: ["GH_TOKEN", "NPM_TOKEN"] }), // same set, spelled explicitly
  ];
  assert.deepEqual(validateSandboxRunScope(cfg, ["builder", "reviewer"]), []);
});

test("validateSandboxRunScope: scope: run rejects a divergent env set OR backend, naming both agents and the differing key names", () => {
  const cfg: any = makeCfg({ backend: "opensandbox", scope: "run", env_allowlist: ["GH_TOKEN"] });
  cfg.agents = [makeAgent({ name: "builder", env_allowlist: ["GH_TOKEN"] }), makeAgent({ name: "reviewer", env_allowlist: [] })];
  const envDivergence = validateSandboxRunScope(cfg, ["builder", "reviewer"]);
  assert.ok(envDivergence.some((p) => p.includes("builder") && p.includes("reviewer") && p.includes("GH_TOKEN")));

  const cfgBackend: any = makeCfg({ backend: "opensandbox", scope: "run" });
  cfgBackend.agents = [makeAgent({ name: "builder" }), makeAgent({ name: "reviewer", sandbox: "cloudflare" })];
  const backendDivergence = validateSandboxRunScope(cfgBackend, ["builder", "reviewer"]);
  assert.ok(backendDivergence.some((p) => p.includes("same sandbox backend")));
});

// ── envelope path translation (§5.3a) ───────────────────────────────────────

function makeSpec(overrides: Partial<SandboxSpec> & { host_root: string; workspace_dir: string; handoff_host: string; handoff_sandbox: string }): SandboxSpec {
  return {
    backend: "opensandbox",
    adw_id: "run1",
    agent: "builder",
    lease_key: "run1/builder",
    scope: "agent",
    scratch_dir: path.posix.join(overrides.workspace_dir, "..", "scratch"),
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

test("translateEnvelopePaths: outbound rewrite — workspace_dir and handoff_sandbox prefixes rewritten, everything else untouched", () => {
  const spec = makeSpec({
    host_root: "/repo",
    workspace_dir: "/workspace",
    handoff_host: "/repo/.spf/data/sessions/run1/context_handoff",
    handoff_sandbox: "/spf/handoff/sessions/run1/context_handoff",
  });
  const envelope: EnvelopeBase & { changed_files?: string[] } = {
    status: "success",
    summary: "",
    notes_for_next_agent: "",
    artifacts: ["/workspace/specs/plan.md", "/spf/handoff/sessions/run1/context_handoff/plan.md", "/etc/passwd", "specs/relative.md"],
    changed_files: ["/workspace/src/x.ts"],
  };
  translateEnvelopePaths(envelope, spec);
  assert.deepEqual(envelope.artifacts, [
    "/repo/specs/plan.md",
    "/repo/.spf/data/sessions/run1/context_handoff/plan.md",
    "/etc/passwd",
    "specs/relative.md",
  ]);
  assert.deepEqual(envelope.changed_files, ["/repo/src/x.ts"]);
});

test("translateEnvelopeToSandbox: inbound rewrite is a COPY (never mutates), and checks handoff_host BEFORE host_root when handoff_host is nested under host_root", () => {
  const spec = makeSpec({
    host_root: "/repo",
    workspace_dir: "/workspace",
    handoff_host: "/repo/.spf/data/sessions/run1/context_handoff", // nested under host_root — the ordering-sensitive case
    handoff_sandbox: "/spf/handoff/sessions/run1/context_handoff",
  });
  const previous: EnvelopeBase = {
    status: "success",
    summary: "",
    notes_for_next_agent: "",
    artifacts: ["/repo/.spf/data/sessions/run1/context_handoff/changes.diff", "/repo/src/x.ts"],
  };
  const original = JSON.parse(JSON.stringify(previous));
  const translated = translateEnvelopeToSandbox(previous, spec);
  assert.deepEqual(translated.artifacts, ["/spf/handoff/sessions/run1/context_handoff/changes.diff", "/workspace/src/x.ts"]);
  assert.deepEqual(previous, original, "the caller's own object must be untouched — only the returned copy is rewritten");
});

test("translateEnvelopeToSandbox: rewrites diff_path too, not just artifacts/changed_files — ChangesOutput sets it as an absolute host path the documenter reads directly", () => {
  const spec = makeSpec({
    host_root: "/repo",
    workspace_dir: "/workspace",
    handoff_host: "/repo/.spf/data/sessions/run1/context_handoff",
    handoff_sandbox: "/spf/handoff/sessions/run1/context_handoff",
  });
  const hostDiffPath = "/repo/.spf/data/sessions/run1/context_handoff/changes.diff";
  const previous = {
    status: "success",
    summary: "",
    notes_for_next_agent: "",
    artifacts: [hostDiffPath],
    diff_path: hostDiffPath,
  } as EnvelopeBase & { diff_path: string };
  const translated = translateEnvelopeToSandbox(previous, spec) as EnvelopeBase & { diff_path?: string };
  assert.equal(translated.diff_path, "/spf/handoff/sessions/run1/context_handoff/changes.diff");
  assert.equal(previous.diff_path, hostDiffPath, "the caller's own object must be untouched — only the returned copy is rewritten");
});

test("translateEnvelopePaths: rewrites diff_path outbound too (sandbox -> host), mirroring the inbound direction", () => {
  const spec = makeSpec({
    host_root: "/repo",
    workspace_dir: "/workspace",
    handoff_host: "/repo/.spf/data/sessions/run1/context_handoff",
    handoff_sandbox: "/spf/handoff/sessions/run1/context_handoff",
  });
  const envelope = {
    status: "success",
    summary: "",
    notes_for_next_agent: "",
    artifacts: [],
    diff_path: "/spf/handoff/sessions/run1/context_handoff/changes.diff",
  } as EnvelopeBase & { diff_path: string };
  translateEnvelopePaths(envelope, spec);
  assert.equal(envelope.diff_path, "/repo/.spf/data/sessions/run1/context_handoff/changes.diff");
});

test("translateEnvelopeToSandbox / translateEnvelopePaths round-trip: translate in, echo back, translate out lands on the original host path", () => {
  const spec = makeSpec({
    host_root: "/repo",
    workspace_dir: "/workspace",
    handoff_host: "/repo/.spf/data/sessions/run1/context_handoff",
    handoff_sandbox: "/spf/handoff/sessions/run1/context_handoff",
  });
  const hostPath = "/repo/.spf/data/sessions/run1/context_handoff/changes.diff";
  const inbound = translateEnvelopeToSandbox({ status: "success", summary: "", notes_for_next_agent: "", artifacts: [hostPath] }, spec);
  const echoedBack: EnvelopeBase = { status: "success", summary: "", notes_for_next_agent: "", artifacts: [...inbound.artifacts] };
  translateEnvelopePaths(echoedBack, spec);
  assert.deepEqual(echoedBack.artifacts, [hostPath]);
});

test("translateEnvelopePaths: a local agent (no spec) never runs — call sites in agents.ts guard with `if (spec)`", () => {
  // Documented as a behavioral property of the call sites, not this pure
  // function — asserted here as a reminder: translateEnvelopePaths itself
  // has no spec-less branch, by design (agents.ts never calls it without one).
  assert.equal(typeof translateEnvelopePaths, "function");
});

// ── lease registry + logger channel + teardown chain ────────────────────────

test("registerRunLog: a lease's log resolves the CURRENT registration for its adw_id, with a no-op fallback, and overwrites rather than duplicating", async () => {
  const adwId = `test-log-${Date.now()}`;
  const spec = makeSpec({ host_root: "/repo", workspace_dir: "/workspace", handoff_host: "/repo/h", handoff_sandbox: "/spf/handoff", adw_id: adwId, lease_key: `${adwId}/builder` });
  const fakeTransport = {} as SandboxTransport;

  // no registration yet -> logs nowhere, never throws, even inside a failing teardown step.
  const early = sandbox.registerLease(spec.lease_key, spec, fakeTransport);
  assert.doesNotThrow(() => early.log({ level: "info", msg: "hello" }));

  const firstEvents: unknown[] = [];
  sandbox.registerRunLog(adwId, (e) => firstEvents.push(e));
  early.log({ level: "info", msg: "first" });
  assert.equal(firstEvents.length, 1);

  const secondEvents: unknown[] = [];
  sandbox.registerRunLog(adwId, (e) => secondEvents.push(e)); // overwrite, not a second subscriber
  early.log({ level: "warn", msg: "second" });
  assert.equal(firstEvents.length, 1, "the first registration must not still receive events");
  assert.equal(secondEvents.length, 1);

  await sandbox.teardownRun(adwId);
  assert.doesNotThrow(() => early.log({ level: "error", msg: "after teardown" }), "a lease surviving past teardownRun must still log safely (no-op)");
});

test("teardownLease: a position-2 step runs even when position 1 throws, every failure is logged, and teardownLease itself never throws", async () => {
  const spec = makeSpec({ host_root: "/repo", workspace_dir: "/workspace", handoff_host: "/repo/h", handoff_sandbox: "/spf/handoff" });
  const order: string[] = [];
  const logged: string[] = [];
  const lease = sandbox.registerLease("teardown-order-test", spec, {} as SandboxTransport);
  lease.log = (e) => logged.push(e.msg);
  lease.teardown = [
    { name: "provider:kill", run: async () => { order.push("kill"); throw new Error("kill failed"); } },
    { name: "credentials:revoke", run: async () => { order.push("revoke"); } },
    { name: "provider:close", run: async () => { order.push("close"); } },
  ];
  await assert.doesNotReject(() => sandbox.teardownLease(lease));
  assert.deepEqual(order, ["kill", "revoke", "close"], "revoke (position 2) must never be skipped because kill (position 1) threw");
  assert.ok(logged.some((m) => m.includes("provider:kill")));
});

// ── staticBroker / CredentialGrant (SPF #15 PR B, §6.1/§6.2) ────────────────

test("staticBroker.issue: returns spec.env VERBATIM — identity on the env plane, exactly §6.1's 'observably a no-op' claim", async () => {
  const spec = makeSpec({
    host_root: "/repo",
    workspace_dir: "/workspace",
    handoff_host: "/repo/h",
    handoff_sandbox: "/spf/handoff",
    env: { GH_TOKEN: "secret-value", NPM_TOKEN: "another-secret" },
  });
  const grant = await sandbox.staticBroker.issue(spec);
  assert.deepEqual(grant.env, { GH_TOKEN: "secret-value", NPM_TOKEN: "another-secret" });
  // A DIFFERENT object from spec.env — mutating the grant must never mutate the spec.
  assert.notEqual(grant.env, spec.env);
});

test("staticBroker.issue().describe(): key NAMES only, sorted, NEVER a value", async () => {
  const spec = makeSpec({
    host_root: "/repo",
    workspace_dir: "/workspace",
    handoff_host: "/repo/h",
    handoff_sandbox: "/spf/handoff",
    env: { NPM_TOKEN: "leak-me-not", GH_TOKEN: "also-leak-me-not" },
  });
  const grant = await sandbox.staticBroker.issue(spec);
  const description = grant.describe();
  assert.ok(description.includes("GH_TOKEN") && description.includes("NPM_TOKEN"), `expected both key names in: ${description}`);
  assert.ok(description.indexOf("GH_TOKEN") < description.indexOf("NPM_TOKEN"), "key names are sorted");
  assert.ok(!description.includes("leak-me-not") && !description.includes("also-leak-me-not"), `describe() must never include a value: ${description}`);
});

test("staticBroker.issue().describe(): the empty-env case names reality, not a fake key list", async () => {
  const spec = makeSpec({ host_root: "/repo", workspace_dir: "/workspace", handoff_host: "/repo/h", handoff_sandbox: "/spf/handoff", env: {} });
  const grant = await sandbox.staticBroker.issue(spec);
  assert.ok(/no credentials issued/.test(grant.describe()));
});

test("staticBroker.issue().revoke(): clears the grant's OWN env object in place — honest about meaning nothing beyond that (§6.2)", async () => {
  const spec = makeSpec({
    host_root: "/repo",
    workspace_dir: "/workspace",
    handoff_host: "/repo/h",
    handoff_sandbox: "/spf/handoff",
    env: { GH_TOKEN: "secret" },
  });
  const grant = await sandbox.staticBroker.issue(spec);
  assert.deepEqual(grant.env, { GH_TOKEN: "secret" });
  await grant.revoke();
  assert.deepEqual(grant.env, {}, "revoke() clears SPF's own in-memory copy — it cannot un-inject an already-created container's env");
  await assert.doesNotReject(() => grant.revoke(), "revoke() must be safe to call more than once");
});

test("describeStaticCredentials: pure function of key names — no SandboxSpec required, matching doctor's config-only call site", () => {
  assert.equal(sandbox.describeStaticCredentials([]), sandbox.describeStaticCredentials([]));
  const withDupes = sandbox.describeStaticCredentials(["B_TOKEN", "A_TOKEN", "A_TOKEN"]);
  assert.ok(withDupes.includes("2 key(s)"), `duplicates must be deduplicated: ${withDupes}`);
  assert.ok(withDupes.indexOf("A_TOKEN") < withDupes.indexOf("B_TOKEN"), "sorted");
});

test("KNOWN_CREDENTIAL_BROKER_IDS: contains exactly \"static\" in this build (§10 non-goal 2 — no other broker registered)", () => {
  assert.deepEqual(sandbox.KNOWN_CREDENTIAL_BROKER_IDS, ["static"]);
});

test("withRunScope: two concurrent scopes with different adw_ids tear down disjoint lease sets, and a throwing body still tears down", async () => {
  const idA = `scope-a-${Date.now()}`;
  const idB = `scope-b-${Date.now()}`;
  const specA1 = makeSpec({ host_root: "/repo", workspace_dir: "/workspace", handoff_host: "/repo/h", handoff_sandbox: "/spf/handoff", adw_id: idA, lease_key: `${idA}/builder` });
  const specA2 = makeSpec({ host_root: "/repo", workspace_dir: "/workspace", handoff_host: "/repo/h", handoff_sandbox: "/spf/handoff", adw_id: idA, lease_key: `${idA}/reviewer` });
  const specB1 = makeSpec({ host_root: "/repo", workspace_dir: "/workspace", handoff_host: "/repo/h", handoff_sandbox: "/spf/handoff", adw_id: idB, lease_key: `${idB}/builder` });

  sandbox.registerLease(specA1.lease_key, specA1, {} as SandboxTransport);
  sandbox.registerLease(specA2.lease_key, specA2, {} as SandboxTransport);
  sandbox.registerLease(specB1.lease_key, specB1, {} as SandboxTransport);

  await sandbox.withRunScope(idA, async () => {
    assert.ok(sandbox.getLease(specB1.lease_key), "sibling run's lease must still exist while A's scope is active");
  });
  assert.equal(sandbox.getLease(specA1.lease_key), undefined, "A's leases are torn down");
  assert.equal(sandbox.getLease(specA2.lease_key), undefined, "ALL of A's leases (both agents) are torn down — a set, not a single lease");
  assert.ok(sandbox.getLease(specB1.lease_key), "B's lease is untouched by A's scope");

  await assert.rejects(
    () =>
      sandbox.withRunScope(idB, async () => {
        throw new Error("phase failed");
      }),
    /phase failed/,
  );
  assert.equal(sandbox.getLease(specB1.lease_key), undefined, "a throwing body still tears down its run's leases");
});

test("renewLease: refuses past max_total_lifetime_seconds rather than silently truncating to zero", async () => {
  const spec = makeSpec({
    host_root: "/repo",
    workspace_dir: "/workspace",
    handoff_host: "/repo/h",
    handoff_sandbox: "/spf/handoff",
    max_total_lifetime_seconds: 1,
  });
  const lease = sandbox.registerLease("renew-test", spec, {} as SandboxTransport);
  lease.created_at = new Date(Date.now() - 5_000).toISOString(); // already past the 1s ceiling
  let renewed = false;
  lease.native.renew = async () => {
    renewed = true;
  };
  await assert.rejects(() => sandbox.renewLease(lease), /max_total_lifetime_seconds/);
  assert.equal(renewed, false);
});

// ── factoryFor (dispatch only — the adapters themselves ship separately) ────

test("factoryFor: dispatches by backend name to a real SandboxFactory for both remote backends — SYNC, no I/O until createSandbox() is awaited (each adapter's own module contract)", () => {
  const spec = makeSpec({ host_root: "/repo", workspace_dir: "/workspace", handoff_host: "/repo/h", handoff_sandbox: "/spf/handoff", backend: "opensandbox" });
  const os = sandbox.factoryFor(spec);
  assert.equal(typeof os.createSandbox, "function");

  const cf = sandbox.factoryFor({ ...spec, backend: "cloudflare" });
  assert.equal(typeof cf.createSandbox, "function");
});

// ── preflight ────────────────────────────────────────────────────────────────

test("preflight: succeeds silently when git/tar/base64 are all present, and fails naming the image + missing binaries otherwise", async () => {
  const spec = makeSpec({ host_root: "/repo", workspace_dir: "/workspace", handoff_host: "/repo/h", handoff_sandbox: "/spf/handoff", image: "debian-git" });
  const ok: SandboxTransport = {
    exec: async () => ({ stdout: "git version 2.50.1\ntar (GNU tar) 1.35\nbase64 (GNU coreutils) 9.4\n", stderr: "", exitCode: 0 }),
    readFile: async () => "",
    readFileBuffer: async () => new Uint8Array(),
    writeFile: async () => {},
    size: async () => null,
  };
  await assert.doesNotReject(() => sandbox.preflight(spec, ok));

  const missing: SandboxTransport = { ...ok, exec: async () => ({ stdout: "", stderr: "git: not found", exitCode: 127 }) };
  await assert.rejects(() => sandbox.preflight(spec, missing), /debian-git/);
});

// ── the workspace transport: seed / reconcile / extract (real git, real tar, real base64) ──

/** What a real adapter does after `seedViaTransport` resolves: register the lease AND set `lease.seeded` from the return value. */
async function seedAndRegister(spec: SandboxSpec, transport: SandboxTransport): Promise<sandbox.SandboxLease> {
  const seeded = await sandbox.seedViaTransport(spec, transport);
  const lease = sandbox.registerLease(spec.lease_key, spec, transport);
  lease.seeded = seeded;
  return lease;
}

/** Real bash/git/tar/base64 against a real local directory standing in for "the sandbox" — see this file's header comment. */
function localTransport(): SandboxTransport {
  return {
    exec: async (cmd, opts) => {
      mkdirSync(opts.cwd, { recursive: true });
      const result = spawnSync("bash", ["-c", cmd], { cwd: opts.cwd });
      return {
        stdout: (result.stdout ?? Buffer.alloc(0)).toString("utf-8"),
        stderr: (result.stderr ?? Buffer.alloc(0)).toString("utf-8"),
        exitCode: result.status ?? 1,
      };
    },
    readFile: async (p) => readFileSync(p, "utf-8"),
    readFileBuffer: async (p) => new Uint8Array(readFileSync(p)),
    writeFile: async (p, data) => {
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, typeof data === "string" ? data : Buffer.from(data));
    },
    size: async (p) => {
      try {
        return statSync(p).size;
      } catch {
        return null;
      }
    },
  };
}

function countingTransport(inner: SandboxTransport): SandboxTransport & { execCalls: number } {
  const wrapped = {
    ...inner,
    execCalls: 0,
    exec: async (cmd: string, opts: { cwd: string; timeoutMs?: number }) => {
      wrapped.execCalls += 1;
      return inner.exec(cmd, opts);
    },
  };
  return wrapped;
}

function git(args: string[], cwd: string): void {
  const r = spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${(r.stderr ?? Buffer.alloc(0)).toString("utf-8")}`);
}

/** The tree `write-tree` would produce for the LIVE working tree — over a temporary index, so the real index is never touched. */
function treeOf(dir: string): string {
  const idx = mkdtempSync(path.join(tmpdir(), "spf-sbx-tree-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(idx, "index") };
    spawnSync("git", ["read-tree", "HEAD"], { cwd: dir, env });
    spawnSync("git", ["add", "-A"], { cwd: dir, env });
    const out = spawnSync("git", ["write-tree"], { cwd: dir, env });
    return out.stdout.toString("utf-8").trim();
  } finally {
    rmSync(idx, { recursive: true, force: true });
  }
}

/** A fresh {hostRoot, spec} pair: hostRoot is a real git repo with one commit; spec's workspace/scratch/handoff dirs are real sibling temp dirs. */
function makeFixture(adwId: string = `sbx-${Date.now()}-${Math.random().toString(36).slice(2)}`): { root: string; hostRoot: string; spec: SandboxSpec } {
  const root = mkdtempSync(path.join(tmpdir(), "spf-sbx-fixture-"));
  const hostRoot = path.join(root, "host");
  mkdirSync(hostRoot, { recursive: true });
  git(["init", "-q"], hostRoot);
  writeFileSync(path.join(hostRoot, ".gitignore"), "node_modules/\n");
  writeFileSync(path.join(hostRoot, "f.txt"), "v1\n");
  git(["add", "-A"], hostRoot);
  git(["commit", "-q", "-m", "initial"], hostRoot);

  const workspace_dir = path.join(root, "sbx", "workspace");
  const scratch_dir = path.join(root, "sbx", "scratch");
  const handoff_sandbox = path.join(root, "sbx", "handoff");
  const handoff_host = path.join(root, "handoff-host");
  mkdirSync(workspace_dir, { recursive: true }); // the image is assumed to pre-create the workspace dir — see seedViaTransport's own comment
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
  return { root, hostRoot, spec };
}

test("seedViaTransport: the sandbox tree is byte-identical to a dirty host tree — modified, untracked, deleted, mode-changed, all at once", async () => {
  const { root, hostRoot, spec } = makeFixture();
  try {
    writeFileSync(path.join(hostRoot, "s.sh"), "#!/bin/sh\necho hi\n");
    writeFileSync(path.join(hostRoot, "h.txt"), "will be deleted\n");
    git(["add", "-A"], hostRoot);
    git(["commit", "-q", "-m", "add s.sh and h.txt"], hostRoot);

    writeFileSync(path.join(hostRoot, "f.txt"), "v2\n"); // modified tracked
    writeFileSync(path.join(hostRoot, "g.txt"), "new untracked\n"); // untracked add
    spawnSync("rm", [path.join(hostRoot, "h.txt")]); // tracked deletion
    spawnSync("chmod", ["+x", path.join(hostRoot, "s.sh")]); // mode change

    const transport = localTransport();
    await sandbox.seedViaTransport(spec, transport);

    assert.equal(readFileSync(path.join(spec.workspace_dir, "f.txt"), "utf-8"), "v2\n");
    assert.equal(readFileSync(path.join(spec.workspace_dir, "g.txt"), "utf-8"), "new untracked\n");
    assert.ok(!existsSync(path.join(spec.workspace_dir, "h.txt")), "the deletion must carry");
    assert.equal(statSync(path.join(spec.workspace_dir, "s.sh")).mode & 0o111, 0o111, "the mode change must carry");

    const sandboxTag = spawnSync("git", ["rev-parse", "spf-local^{tree}"], { cwd: spec.workspace_dir }).stdout.toString("utf-8").trim();
    assert.equal(sandboxTag, treeOf(hostRoot), "spf-local^{tree} must equal the host's live tree — not merely 'spf-local resolves'");

    const status = spawnSync("git", ["status", "--short"], { cwd: spec.workspace_dir }).stdout.toString("utf-8");
    assert.equal(status, "", "the sandbox working tree must be clean after the seed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedViaTransport: a CLEAN host tree tags spf-local at spf-base directly (git apply on an empty patch is skipped, not attempted)", async () => {
  const { root, hostRoot, spec } = makeFixture();
  try {
    await sandbox.seedViaTransport(spec, localTransport());
    const base = spawnSync("git", ["rev-parse", "spf-base^{tree}"], { cwd: spec.workspace_dir }).stdout.toString("utf-8").trim();
    const local = spawnSync("git", ["rev-parse", "spf-local^{tree}"], { cwd: spec.workspace_dir }).stdout.toString("utf-8").trim();
    assert.equal(local, base);
    assert.equal(local, treeOf(hostRoot));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedViaTransport: scratch_dir and handoff_dir files never appear in an extract patch — out-of-workspace plane isolation", async () => {
  const { root, spec } = makeFixture();
  try {
    await sandbox.seedViaTransport(spec, localTransport());
    writeFileSync(path.join(spec.workspace_dir, "real-work.txt"), "the agent's actual output\n");
    // simulate stray scratch/handoff content an operator's forced-nested layout would produce, IF it were reachable —
    // in the validated sibling layout used here it is structurally impossible for git add -A to see it at all.
    const patch = spawnSync("bash", ["-c", "git -c core.autocrlf=false add -A && git -c core.autocrlf=false diff --cached --binary HEAD --name-only"], {
      cwd: spec.workspace_dir,
    })
      .stdout.toString("utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.deepEqual(patch, ["real-work.txt"], "nothing but the agent's own file crosses");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedViaTransport step 6.5: the handoff mirror is populated in a FRESH sandbox BEFORE any dispatch — the positive cross-agent test", async () => {
  const { root, spec } = makeFixture();
  try {
    writeFileSync(path.join(spec.handoff_host, "plan.md"), "the plan\n"); // as if an earlier agent already wrote this
    await sandbox.seedViaTransport(spec, localTransport());
    assert.equal(readFileSync(path.join(spec.handoff_sandbox, "plan.md"), "utf-8"), "the plan\n", "handoff content must be present before this agent's first send, not only after its first reconcile");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedViaTransport: a repo with .gitmodules seeds successfully and emits exactly one warn naming the submodule paths", async () => {
  const { root, hostRoot, spec } = makeFixture();
  try {
    writeFileSync(hostRoot + "/.gitmodules", '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = https://example.com/lib.git\n');
    git(["add", "-A"], hostRoot);
    git(["commit", "-q", "-m", "add .gitmodules"], hostRoot);

    const events: unknown[] = [];
    sandbox.registerRunLog(spec.adw_id, (e) => events.push(e));
    try {
      await sandbox.seedViaTransport(spec, localTransport());
    } finally {
      await sandbox.teardownRun(spec.adw_id);
    }

    const warnings = events.filter((e: any) => e.level === "warn");
    assert.equal(warnings.length, 1, "exactly one warn, not one per submodule");
    assert.ok((warnings[0] as any).data?.submodules?.includes("vendor/lib"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractWorkspace: a send that writes NOTHING to the workspace succeeds (--allow-empty) and still advances turn/spf-local", async () => {
  const { root, hostRoot, spec } = makeFixture();
  try {
    const transport = localTransport();
    const lease = await seedAndRegister(spec, transport);

    // scout/refiner/reviewer shape: only the handoff dir gets written.
    writeFileSync(path.join(spec.handoff_sandbox, "notes.md"), "handoff-only write\n");

    await assert.doesNotReject(() => sandbox.extractWorkspace(spec));
    assert.equal(lease.turn, 1);
    const hostStatus = spawnSync("git", ["status", "--short"], { cwd: hostRoot }).stdout.toString("utf-8");
    assert.equal(hostStatus, "", "an empty workspace delta must not touch the host tree at all");
    assert.equal(readFileSync(path.join(spec.handoff_host, "notes.md"), "utf-8"), "handoff-only write\n", "the handoff mirror pull must still run on an empty-patch extract");

    // the NEXT send's real edit produces a patch naming only that file — the empty turn did not break the increment.
    writeFileSync(path.join(spec.workspace_dir, "real.txt"), "now something real\n");
    await sandbox.extractWorkspace(spec);
    assert.equal(lease.turn, 2);
    assert.equal(readFileSync(path.join(hostRoot, "real.txt"), "utf-8"), "now something real\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractWorkspace: idempotent across two turns — the marker commit prevents the cumulative-patch bug", async () => {
  const { root, hostRoot, spec } = makeFixture();
  try {
    const transport = localTransport();
    await seedAndRegister(spec, transport);

    writeFileSync(path.join(spec.workspace_dir, "one.txt"), "first send\n");
    writeFileSync(path.join(spec.workspace_dir, "f.txt"), "v2 from sandbox\n");
    await sandbox.extractWorkspace(spec);
    assert.equal(readFileSync(path.join(hostRoot, "one.txt"), "utf-8"), "first send\n");

    writeFileSync(path.join(spec.workspace_dir, "two.txt"), "second send\n");
    await assert.doesNotReject(() => sandbox.extractWorkspace(spec), "the second extract must apply cleanly — no 'already exists' on one.txt");
    assert.equal(readFileSync(path.join(hostRoot, "two.txt"), "utf-8"), "second send\n");
    assert.equal(readFileSync(path.join(hostRoot, "one.txt"), "utf-8"), "first send\n", "the first send's file is still there (union, not replaced)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractWorkspace: a non-UTF-8 (Latin-1) text edit round-trips byte-for-byte through the base64 hop", async () => {
  const { root, hostRoot, spec } = makeFixture();
  try {
    const latin1Bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1 — 0xe9 is not valid UTF-8 alone
    writeFileSync(path.join(hostRoot, "latin1.txt"), latin1Bytes);
    git(["add", "-A"], hostRoot);
    git(["commit", "-q", "-m", "add latin1 file"], hostRoot);

    const transport = localTransport();
    await seedAndRegister(spec, transport);

    const editedBytes = Buffer.concat([latin1Bytes, Buffer.from([0xe9, 0x0a])]); // append another non-UTF-8 byte
    writeFileSync(path.join(spec.workspace_dir, "latin1.txt"), editedBytes);
    await sandbox.extractWorkspace(spec);

    assert.deepEqual(readFileSync(path.join(hostRoot, "latin1.txt")), editedBytes, "the edit must land byte-for-byte on the host, not UTF-8-corrupted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcileWorkspace: skips the workspace reset/re-seed (but still pushes the handoff mirror) when the fingerprint already matches", async () => {
  const { root, spec } = makeFixture();
  try {
    const inner = localTransport();
    const transport = countingTransport(inner);
    await seedAndRegister(spec, transport);
    const callsAfterFirst = transport.execCalls;
    await sandbox.reconcileWorkspace(spec); // workspace tree unchanged since — no reset/re-seed calls
    // The handoff-mirror push (`mkdir -p handoff_sandbox` at minimum) still
    // runs on every reconcile — see pushHandoffMirror's call at the top of
    // the matching-fingerprint branch — so this is no longer a true no-op,
    // only a skip of the (much larger) reset/re-seed work.
    assert.equal(transport.execCalls, callsAfterFirst + 1, "only the handoff mirror's own mkdir, no workspace reset/re-seed calls");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcileWorkspace: a lease HIT (fingerprint unchanged) still delivers a handoff file another agent wrote in between", async () => {
  const { root, spec } = makeFixture();
  try {
    const transport = localTransport();
    await seedAndRegister(spec, transport);

    // Simulate a reviewer's `writes: []` step: a handoff-only write, no
    // workspace delta — the host fingerprint does not move.
    mkdirSync(spec.handoff_host, { recursive: true });
    writeFileSync(path.join(spec.handoff_host, "review.md"), "looks good\n");

    await sandbox.reconcileWorkspace(spec); // fingerprint HIT — must still push the new handoff file
    assert.equal(readFileSync(path.join(spec.handoff_sandbox, "review.md"), "utf-8"), "looks good\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcileWorkspace ROW 2 (working-tree edits only): resets to spf-base and re-applies, and a gitignored setup artifact survives clean -fd", async () => {
  const { root, hostRoot, spec } = makeFixture();
  try {
    const transport = localTransport();
    await seedAndRegister(spec, transport);

    mkdirSync(path.join(spec.workspace_dir, "node_modules"), { recursive: true });
    writeFileSync(path.join(spec.workspace_dir, "node_modules", "dep.js"), "// setup artifact\n");

    writeFileSync(path.join(hostRoot, "f.txt"), "host-side quality fix\n"); // NOT committed
    await sandbox.reconcileWorkspace(spec);

    assert.equal(readFileSync(path.join(spec.workspace_dir, "f.txt"), "utf-8"), "host-side quality fix\n");
    assert.ok(existsSync(path.join(spec.workspace_dir, "node_modules", "dep.js")), "clean -fd (never -fdx) must not remove a gitignored setup artifact");
    const sandboxTree = spawnSync("git", ["rev-parse", "spf-local^{tree}"], { cwd: spec.workspace_dir }).stdout.toString("utf-8").trim();
    assert.equal(sandboxTree, treeOf(hostRoot));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconcileWorkspace ROW 3 (host committed): full re-seed lands on the POST-commit tree, and a stale sandbox-only tracked file is removed", async () => {
  const { root, hostRoot, spec } = makeFixture();
  try {
    const transport = localTransport();
    await seedAndRegister(spec, transport);

    // plant a tracked file in the SANDBOX the new host HEAD will not contain (e.g. a send that threw before its extract).
    writeFileSync(path.join(spec.workspace_dir, "stale.txt"), "stale\n");
    spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", "add", "-A"], { cwd: spec.workspace_dir });
    spawnSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "agent turn"], { cwd: spec.workspace_dir });

    writeFileSync(path.join(hostRoot, "f.txt"), "v2-committed\n");
    git(["add", "-A"], hostRoot);
    git(["commit", "-q", "-m", "host commit"], hostRoot);

    await sandbox.reconcileWorkspace(spec);

    assert.equal(readFileSync(path.join(spec.workspace_dir, "f.txt"), "utf-8"), "v2-committed\n");
    assert.ok(!existsSync(path.join(spec.workspace_dir, "stale.txt")), "the stale sandbox-only tracked file must be gone — additive tar -xf alone would have kept it");
    const sandboxTree = spawnSync("git", ["rev-parse", "spf-local^{tree}"], { cwd: spec.workspace_dir }).stdout.toString("utf-8").trim();
    assert.equal(sandboxTree, treeOf(hostRoot), "must equal the POST-commit host tree, not the pre-run one");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the seed is attributes-proof: export-ignore is honored and export-subst is NOT substituted (checkout-index, never git archive)", async () => {
  const { root, hostRoot, spec } = makeFixture();
  try {
    writeFileSync(path.join(hostRoot, ".gitattributes"), "ignored.txt export-ignore\nsubst.txt export-subst\n");
    writeFileSync(path.join(hostRoot, "ignored.txt"), "would be dropped by git archive\n");
    writeFileSync(path.join(hostRoot, "subst.txt"), "$Format:%H$\n");
    git(["add", "-A"], hostRoot);
    git(["commit", "-q", "-m", "attributes fixture"], hostRoot);

    await sandbox.seedViaTransport(spec, localTransport());

    assert.equal(readFileSync(path.join(spec.workspace_dir, "ignored.txt"), "utf-8"), "would be dropped by git archive\n", "export-ignore must NOT drop the file — checkout-index writes blobs verbatim");
    assert.equal(readFileSync(path.join(spec.workspace_dir, "subst.txt"), "utf-8"), "$Format:%H$\n", "export-subst must NOT be substituted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
