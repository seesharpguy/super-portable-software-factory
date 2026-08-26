import "./hermetic_git.ts";

/**
 * SPF #15 — integration-shaped coverage for the CLI wiring `withRunScope`
 * needs to actually run: `dispatchChain` (`cli/commands/run.ts`) is the
 * shared entry both `spf <chain>` and `spf run <chain>` use, and it now
 * wraps `runChain` in `sandbox.withRunScope(adwId, ...)`. `withRunScope`
 * itself already has direct unit coverage in `sandbox.test.ts`; what THIS
 * file pins is that the wrap is actually reachable from a real dispatch —
 * a chain whose `run()` never imports `sandbox.ts` still has any lease it
 * (indirectly, via an agent that dispatched into a sandbox) created torn
 * down when the chain returns, without the caller doing anything extra.
 *
 * No real sandbox provider is involved — `ChainDefinition.run` is the
 * imperative escape hatch `runChain` calls directly (`chains/index.ts`),
 * so this registers a fake lease exactly the way an adapter's `createSandbox`
 * would, then asserts `dispatchChain`'s own return leaves the registry
 * empty for that adw_id.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SandboxSpec } from "../core/data_types.js";
import * as sandbox from "../core/sandbox.js";
import type { SandboxTransport } from "../core/sandbox.js";
import { dispatchChain } from "../cli/commands/run.js";
import type { ChainDefinition } from "../chains/index.js";

const NOOP_TRANSPORT: SandboxTransport = {
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  readFileBuffer: async () => new Uint8Array(),
  writeFile: async () => {},
  size: async () => null,
};

function fakeSandboxSpec(adwId: string, root: string): SandboxSpec {
  return {
    backend: "opensandbox",
    adw_id: adwId,
    agent: "test",
    lease_key: `${adwId}/test`,
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

test("dispatchChain: a completed run leaves sandbox.leases() empty for its adw_id — withRunScope's teardown actually runs on the real CLI dispatch path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "spf-run-wiring-"));
  let seenAdwId = "";
  try {
    const chain: ChainDefinition = {
      name: "fake-sandbox-registering-chain",
      describe: "test-only: registers a lease as a stand-in for an agent step that dispatched into a sandbox",
      phases: "",
      requiredAgents: [],
      requiredSuites: [],
      run: async (ctx) => {
        seenAdwId = ctx.adw_id!;
        sandbox.registerLease(`${ctx.adw_id}/test`, fakeSandboxSpec(ctx.adw_id!, root), NOOP_TRANSPORT);
        assert.equal(sandbox.leases().length, 1, "the lease must actually be live mid-run");
        return 0;
      },
    };

    const code = await dispatchChain(chain, ["a test prompt", "--cwd", root]);

    assert.equal(code, 0);
    assert.ok(seenAdwId.length > 0, "dispatchChain must mint (or pass through) an adw_id the chain can see");
    assert.equal(sandbox.leases().length, 0, "withRunScope's finally must have torn down the lease dispatchChain's own run created");
  } finally {
    await sandbox.teardownRun(seenAdwId); // belt-and-braces if the assertion above failed before teardown
    rmSync(root, { recursive: true, force: true });
  }
});
