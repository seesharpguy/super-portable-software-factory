/**
 * Session lifecycle: pin-or-create an adw_id, build the Run object.
 *
 * `ensure(cfg, adwId)` joins the session if it exists or creates it under
 * exactly that id (pinned ids for repeatable runs); omitted, a fresh id is
 * minted and printed so the next ADW can pick it up.
 */

import path from "node:path";
import { Run } from "./runner.ts";
import { Tracer } from "./tracer.ts";
import type { SFConfig } from "./data_types.ts";
import { engineerName, newId } from "./utils.ts";

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

export function ensure(cfg: SFConfig, adwId?: string | null): Run {
  const id = adwId || newId(8);
  const tracer = new Tracer(cfg.observability.db, path.join(cfg.defaults.data_dir, "sessions", id, "events.jsonl"));
  const run = new Run(cfg, id, tracer, engineerName());
  const scriptPath = process.argv[1] || "adw";
  const adwName = path.basename(scriptPath, path.extname(scriptPath));
  tracer.sessionStart(id, run.engineer, adwName);
  // This process is the run. Record it before any phase opens, so a run that
  // hangs in its first agent call is still killable by adw_id.
  tracer.processStart(id, "adw", "", process.pid ?? -1, [path.basename(scriptPath), ...process.argv.slice(2)].join(" "));
  finalizeWhenKilled(run);
  run.console.sessionStarted(id, run.engineer);
  return run;
}
