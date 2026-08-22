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
import * as otel from "./otel.ts";

/**
 * How long a signalled run may spend pushing spans before it exits anyway.
 * Short on purpose: someone who just pressed ^C is waiting, and an
 * observability projection is never worth making a kill feel broken. The
 * budget is enforced inside `otel.flushAll()` (a raced, unref'd deadline), so
 * an unreachable collector costs exactly this and not one tick more.
 */
const SIGNAL_DRAIN_MS = 750;

/**
 * A killed run still closes its own trace.
 *
 * Node's default SIGTERM/SIGINT handling exits without unwinding, so `just
 * kill` (or any `kill <pid>`) would leave the session reading `running`
 * forever and its process rows open — the trace would claim work is in
 * flight that is already dead. Handling the signal both finalizes here and
 * lets the phase's try/catch record the phase as failed on the way out
 * (best-effort: a signal can still land mid-write).
 *
 * SQLite is written FIRST and synchronously, exactly as before — the otel
 * drain is appended after it and can only ever cost time, never correctness.
 * (`notify` has no equivalent drain on this path: its in-flight webhooks are
 * dropped on a signal today. Fixing that means touching the notifier's
 * lifecycle, which is outside this change; only the otel path is drained here.)
 * A second signal during the drain exits immediately — someone pressing ^C
 * twice means "now", and a shutdown path that ignores that is a hang.
 */
function finalizeWhenKilled(run: Run): void {
  let draining = false;
  const handler = (signal: NodeJS.Signals) => {
    const code = 128 + (signal === "SIGINT" ? 2 : 15);
    if (draining) process.exit(code);
    draining = true;
    run.tracer.sessionFinish(run.adw_id, false); // also closes process rows
    // Unconfigured (the default) exits SYNCHRONOUSLY, exactly as it did before
    // otel existed — no extra tick between the signal and the exit for the
    // repos that never opted in.
    if (!run.tracer.otel) process.exit(code);
    // Bounded and never-throwing: flushAll() swallows its own failures and
    // resolves on its own deadline, so this always reaches process.exit().
    void otel.flushAll(SIGNAL_DRAIN_MS).then(
      () => process.exit(code),
      () => process.exit(code),
    );
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
  // `null` unless `observability.otel` is configured — no environment variable
  // can turn this on (see core/otel.ts's EXPLICIT CONFIG ONLY). Constructed
  // BEFORE the Tracer because the Tracer's write methods are the fan-out
  // seams: SQLite stays the source of truth, otel is a projection off it, and
  // registering here (module-level LIVE, exactly like resolveNotifier) is what
  // lets the CLI's finally block and the signal handler above drain it without
  // threading a handle through every call site.
  const otelExporter = otel.resolveOtelExporter(cfg, { adwId: id, chainName: chainName || "adw" });
  const tracer = new Tracer(dataPaths.db_path, path.join(dataPaths.sessions_dir, id, "events.jsonl"), otelExporter);

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
