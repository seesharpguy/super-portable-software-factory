import "./hermetic_git.ts";

/**
 * SPF #15 PR B — fan-out THROUGH sandboxes (design §5.5, §11's PR B test
 * list). `src/core/fanout.ts` is UNMODIFIED by this PR — its own module
 * comment and `cli/commands/fanout.ts`'s `runAttempt` say so — so nothing
 * fan-out-specific exists to unit-test there. What PR B actually adds is:
 * per-attempt sandbox specs derived from the attempt's own worktree/adw_id
 * (the ORDINARY `sandboxSpecFor` path, unchanged by this PR), and the
 * ALREADY-SHIPPED `withRunScope` wrap (`cli/commands/fanout.ts:377`, PR A)
 * doing the teardown work for free.
 *
 * These tests exercise that real machinery directly — REAL
 * `attemptAdwId()`-derived ids, REAL `withRunScope`/`teardownRun`/
 * `registerLease` — against a fake remote backend (no SDK, no network), the
 * same style §8.1's own "two concurrent scopes" key-attribution test uses
 * (`sandbox.test.ts`), applied end-to-end with a real derived `<base>-<i>`
 * shape instead of the placeholder `scope-a`/`scope-b` ids that test used.
 *
 * A real, chain-driven, real-git-worktree version of this same story lives
 * in `fanout_sandbox_wiring.test.ts` (mirroring `run_sandbox_wiring.test.ts`'s
 * `ChainDefinition.run` escape hatch) — this file is the precise,
 * controlled-overlap half; that one is the "it's actually wired into `spf
 * fanout`" half.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentConfig, SFConfig, SandboxSpec } from "../core/data_types.js";
import { SFConfigSchema, AgentConfigSchema } from "../core/data_types.js";
import * as v from "valibot";
import { sandboxSpecFor } from "../core/agents.js";
import { attemptAdwId } from "../core/fanout.js";
import { linkFanoutDataDir } from "../cli/commands/fanout.js";
import * as sandbox from "../core/sandbox.js";
import type { SandboxTransport } from "../core/sandbox.js";

const NOOP_TRANSPORT: SandboxTransport = {
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  readFileBuffer: async () => new Uint8Array(),
  writeFile: async () => {},
  size: async () => null,
};

function fakeSpec(adwId: string, agent: string): SandboxSpec {
  return {
    backend: "opensandbox",
    adw_id: adwId,
    agent,
    lease_key: `${adwId}/${agent}`,
    scope: "agent",
    host_root: "/repo",
    workspace_dir: "/workspace",
    handoff_host: "/repo/.spf/data/sessions/x/context_handoff",
    handoff_sandbox: "/spf/handoff/sessions/x/context_handoff",
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

/** Stands in for one sandboxed agent dispatch inside an attempt's chain — the shape a real adapter's `createSandbox` MISS branch leaves behind. */
function fakeCreateLease(adwId: string, agent: string): void {
  sandbox.registerLease(`${adwId}/${agent}`, fakeSpec(adwId, agent), NOOP_TRANSPORT);
}

// ── §8.1's key-attribution pattern, end to end with REAL <base>-<i> ids ────

test("fan-out through sandboxes: two concurrent attempts (REAL attemptAdwId-derived ids, one lease per dispatched agent) tear down disjoint sets — neither tears down the other's lease", async () => {
  const baseAdwId = `fanout-sbx-${Date.now()}`;
  const idA = attemptAdwId(baseAdwId, 1);
  const idB = attemptAdwId(baseAdwId, 2);
  assert.equal(idA, `${baseAdwId}-1`);
  assert.equal(idB, `${baseAdwId}-2`);

  let releaseA: () => void = () => {};
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });

  // Attempt A: TWO leases (planner + builder) under the default scope:
  // agent — held open until the test releases it.
  const attemptA = sandbox.withRunScope(idA, async () => {
    fakeCreateLease(idA, "planner");
    fakeCreateLease(idA, "builder");
    await gateA;
  });

  // Attempt B runs to COMPLETION while A is still mid-flight — the real
  // overlap shape a concurrency>1 fan-out produces.
  await sandbox.withRunScope(idB, async () => {
    fakeCreateLease(idB, "planner");
  });

  // B is fully torn down. A — a DIFFERENT attempt sharing the same base
  // adw_id — must be completely unaffected: this is the actual bug class
  // (cross-attempt teardown) the design's §4.3 key-attribution guarantee
  // exists to prevent.
  assert.equal(sandbox.getLease(`${idB}/planner`), undefined, "B's own lease must already be torn down");
  assert.equal(sandbox.getLease(`${idA}/planner`)?.spec.adw_id, idA, "A's lease must survive B's teardown");
  assert.equal(sandbox.getLease(`${idA}/builder`)?.spec.adw_id, idA, "A's second lease must survive B's teardown too");

  releaseA();
  await attemptA;
  assert.equal(sandbox.getLease(`${idA}/planner`), undefined, "A's own leases must be torn down once ITS scope ends");
  assert.equal(sandbox.getLease(`${idA}/builder`), undefined);
});

test("fan-out through sandboxes: a failed attempt's leases are torn down too — withRunScope's finally covers a thrown chain", async () => {
  const baseAdwId = `fanout-sbx-fail-${Date.now()}`;
  const id = attemptAdwId(baseAdwId, 3);

  await assert.rejects(
    sandbox.withRunScope(id, async () => {
      fakeCreateLease(id, "builder");
      assert.equal(sandbox.leases().filter((l) => l.spec.adw_id === id).length, 1, "the lease must be live mid-attempt, before the throw");
      throw new Error("fake chain failure");
    }),
    /fake chain failure/,
  );
  assert.equal(sandbox.getLease(`${id}/builder`), undefined, "a FAILED attempt's lease must still be torn down — teardown is not conditioned on success");
});

test("fan-out through sandboxes: N=3 attempts (mixed success/failure) leave ZERO leases behind and never cross-attribute", async () => {
  const baseAdwId = `fanout-sbx-n3-${Date.now()}`;
  const ids = [1, 2, 3].map((i) => attemptAdwId(baseAdwId, i));
  const seenDuringRun: string[][] = [];

  await Promise.all(
    ids.map((id, i) =>
      sandbox.withRunScope(id, async () => {
        fakeCreateLease(id, "builder");
        // Snapshot which adw_ids have a live lease right now — every entry
        // must belong to THIS run's own family of ids (never garbage from a
        // sibling that already tore down, and never missing this attempt's
        // own lease while it's mid-flight).
        seenDuringRun.push(sandbox.leases().map((l) => l.spec.adw_id));
        if (i === 1) throw new Error("attempt 2 fails");
      }).catch(() => {}),
    ),
  );

  assert.equal(sandbox.leases().length, 0, "every attempt's lease must be torn down, success or failure alike");
  for (const snapshot of seenDuringRun) {
    for (const seenId of snapshot) {
      assert.ok(ids.includes(seenId), `saw a lease for ${seenId}, which is not one of this run's own attempt ids: ${ids.join(", ")}`);
    }
  }
});

// ── the negative env test, extended to a fan-out-derived adw_id (§11) ──────

test("sandboxSpecFor: env_allowlist: [] still yields {} for a fan-out-derived <base>-<i> adw_id — the exfiltration guarantee doesn't weaken under fan-out", () => {
  const saved = process.env["SPF_FANOUT_SBX_SECRET"];
  try {
    process.env["SPF_FANOUT_SBX_SECRET"] = "leak-me-not";
    const cfg = v.parse(SFConfigSchema, { sandbox: { backend: "opensandbox" } }) as SFConfig;
    const agent = v.parse(AgentConfigSchema, {
      name: "builder",
      prompt_engineering: { system: "s.md", user: "u.md" },
    }) as AgentConfig;
    const baseAdwId = "fanoutbase01";
    const attemptId = attemptAdwId(baseAdwId, 2);
    const run = {
      cfg,
      adw_id: attemptId,
      tokens: 0,
      cost: 0,
      repo_root: "/fanout/worktree-2",
      spf_dir: null,
      data_dir: "/fanout/worktree-2/.spf/data",
      session_dir: `/fanout/worktree-2/.spf/data/sessions/${attemptId}`,
      context_handoff_dir: `/fanout/worktree-2/.spf/data/sessions/${attemptId}/context_handoff`,
      agent_map: {},
      addUsage: () => {},
      saveAgentMap: () => {},
    };
    const spec = sandboxSpecFor(run as any, agent);
    assert.equal(spec?.adw_id, attemptId, "the spec's adw_id must be the ATTEMPT's own derived id, not the base");
    assert.equal(spec?.lease_key, `${attemptId}/builder`);
    assert.deepEqual(spec?.env, {}, "env_allowlist: [] (the default) must yield {} for a fan-out attempt exactly as it does for a plain run");
  } finally {
    if (saved === undefined) delete process.env["SPF_FANOUT_SBX_SECRET"];
    else process.env["SPF_FANOUT_SBX_SECRET"] = saved;
  }
});

// ── compile-time (not just runtime): linkDataDir stays sync ────────────────

/**
 * `runBestOf` (design §5.5) is load-bearing on `linkDataDir` never growing
 * an `await` — provisioning happens lazily inside `createSandbox`, never
 * inside it. TypeScript does not catch a regression here on its own: a
 * `void`-returning `linkDataDir` accepts `() => Promise<void>` structurally
 * (the "void return is special" compatibility rule), so this is pinned
 * explicitly against the real exported `linkFanoutDataDir` (not just the
 * interface), so a regression fails `tsc` rather than being caught only by
 * someone reading a diff.
 *
 * `readMetrics` USED to carry the same pin (`AttemptMetrics`, not
 * `Promise<AttemptMetrics>`) — TypeScript's own structural check on that
 * return type made the assertion redundant with the real interface, so it
 * doubled as a second guard. SPF #66 (the D1 trace-db adapter) deliberately
 * removes that invariant: `readMetrics` reads the SHARED trace db
 * (`SfDb`/`Tracer`), which is now async for BOTH backends — see
 * `core/trace_db.ts`'s header for why even the local sqlite path pays that
 * cost. `readMetrics` growing an `await` is not a regression any more; it is
 * the whole point.
 */
type AssertSyncReturn<F extends (...args: never[]) => unknown> = ReturnType<F> extends Promise<unknown> ? never : true;
const linkFanoutDataDirStaysSync: AssertSyncReturn<typeof linkFanoutDataDir> = true;

test("compile-time sync assertion above did not silently no-op — linkFanoutDataDir really is a plain sync function at runtime too", () => {
  // Referencing the `const` above is the point: `tsc` fails THIS FILE
  // (TS2322, "type Promise<...> is not assignable to type never") the moment
  // this callback's real return type ever grows an `await` — a much
  // earlier, much louder failure than a runtime test noticing a hang.
  assert.equal(linkFanoutDataDirStaysSync, true);

  const worktree = mkdtempSync(path.join(tmpdir(), "spf-sync-check-wt-"));
  const dataParent = mkdtempSync(path.join(tmpdir(), "spf-sync-check-data-"));
  try {
    const result = linkFanoutDataDir(worktree, path.join(dataParent, ".spf", "data"));
    assert.equal(result, undefined, "linkFanoutDataDir must return void synchronously, not a Promise");
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(dataParent, { recursive: true, force: true });
  }
});
