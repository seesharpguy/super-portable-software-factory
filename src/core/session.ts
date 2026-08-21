/**
 * Session lifecycle: pin-or-create an adw_id, build the Run object.
 *
 * `ensure(cfg, adwId)` joins the session if it exists or creates it under
 * exactly that id (pinned ids for repeatable runs); omitted, a fresh id is
 * minted and printed so the next ADW can pick it up.
 */

import path from "node:path";
import * as paths from "./paths.ts";
import { Run } from "./runner.ts";
import { Tracer } from "./tracer.ts";
import type { SFConfig } from "./data_types.ts";
import { engineerName, newId } from "./utils.ts";
import { resolveNotifier } from "./notify/notifier.ts";

/**
 * A killed run still closes its own trace.
 *
 * Node's default SIGTERM/SIGINT handling exits without unwinding, so `just
 * kill` (or any `kill <pid>`) would leave the session reading `running`
 * forever and its process rows open — the trace would claim work is in
 * flight that is already dead. Handling the signal both finalizes here and
 * lets the phase's try/catch record the phase as failed on the way out
 * (best-effort: a signal can still land mid-write).
 */
function finalizeWhenKilled(run: Run): void {
  const handler = (signal: NodeJS.Signals) => {
    run.tracer.sessionFinish(run.adw_id, false); // also closes process rows
    process.exit(128 + (signal === "SIGINT" ? 2 : 15));
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}

/**
 * `cwd` anchors this run's repo_root and data_dir — it is NOT where the
 * process happened to start; it is an explicit decision, threaded down from
 * the CLI/chain context. Defaults to `process.cwd()` only for direct callers
 * (tests, scratch scripts) that have no anchor of their own to pass.
 *
 * `chainName` is the CLI name (`"plan-build-test"`, not a module basename) —
 * every chain is a composed step list now, not its own file, so there is no
 * longer a `process.argv[1]` basename that means anything. Direct callers
 * that have no chain of their own fall back to `"adw"`.
 */
export function ensure(cfg: SFConfig, adwId?: string | null, cwd?: string, chainName?: string): Run {
  const id = adwId || newId(8);
  const anchor = paths.resolveAnchor(cwd);
  const dataPaths = paths.resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db);
  const tracer = new Tracer(dataPaths.db_path, path.join(dataPaths.sessions_dir, id, "events.jsonl"));
  const run = new Run({
    cfg,
    adwId: id,
    tracer,
    engineer: engineerName(),
    repoRoot: anchor.repo_root,
    sfDir: anchor.spf_dir,
    dataDir: dataPaths.data_dir,
    chainName: chainName || "adw",
    notifier: resolveNotifier(cfg),
  });
  const scriptPath = process.argv[1] || "adw";
  tracer.sessionStart(id, run.engineer, chainName || "adw");
  // This process is the run. Record it before any phase opens, so a run that
  // hangs in its first agent call is still killable by adw_id.
  tracer.processStart(id, "adw", "", process.pid ?? -1, [path.basename(scriptPath), ...process.argv.slice(2)].join(" "));
  finalizeWhenKilled(run);
  run.console.sessionStarted(id, run.engineer);
  return run;
}
