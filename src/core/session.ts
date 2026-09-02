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
import type { RunObserver } from "./console.ts";
import { Tracer } from "./tracer.ts";
import type { SFConfig } from "./data_types.ts";
import { engineerName, newId } from "./utils.ts";
import { resolveNotifier, drainAll as drainNotifiers } from "./notify/notifier.ts";
import * as otel from "./otel.ts";

/**
 * How long a signalled run may spend pushing spans / webhook sends before it
 * exits anyway. Short on purpose: someone who just pressed ^C is waiting, and
 * neither an observability projection nor a Slack ping is ever worth making a
 * kill feel broken. The budget is enforced inside `otel.flushAll()` and
 * `notify.drainAll()` (each a raced, unref'd deadline), so an unreachable
 * collector or webhook host costs exactly this and not one tick more.
 */
const SIGNAL_DRAIN_MS = 750;

/**
 * Runs currently in flight in THIS process, keyed by adw_id — what the one
 * shared signal handler below acts on, and what `finalize()` removes a run
 * from once its own dispatch has settled.
 *
 * `spf watch`'s daemon loop calls `ensure()` once per claimed issue, in the
 * same process, for the life of the daemon. Installing a FRESH
 * SIGTERM/SIGINT listener per `ensure()` call (the old shape) meant every
 * listener ever registered stayed registered and fired on the NEXT signal —
 * so ^C during issue 72 would also re-run issue 70 and 71's long-finished
 * handlers, flipping their already-`success` sessions back to `fail`, on top
 * of leaking a `MaxListenersExceededWarning` at the 11th run. One listener,
 * installed once, acting on whichever runs are still in `ACTIVE`, fixes
 * both: a signal only ever finalizes runs that are actually still running.
 */
const ACTIVE = new Map<string, Run>();
let installed = false;
let draining = false;

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
 * and notify drains are appended after it and can only ever cost time, never
 * correctness. `notify`'s in-flight Slack/Teams/webhook sends get the SAME
 * timeout-and-swallow discipline as the otel drain (see `Notifier.drain()` /
 * `notify.drainAll()` in `notify/notifier.ts`): bounded by the same
 * `SIGNAL_DRAIN_MS` budget, run concurrently with the otel drain (not after
 * it, so a killed run never pays both budgets back to back), and never able
 * to throw into this handler.
 * A second signal during the drain exits immediately — someone pressing ^C
 * twice means "now", and a shutdown path that ignores that is a hang.
 */
function handleSignal(signal: NodeJS.Signals): void {
  const code = 128 + (signal === "SIGINT" ? 2 : 15);
  if (draining) process.exit(code);
  draining = true;
  const runs = [...ACTIVE.values()]; // snapshot: finalize() may mutate ACTIVE mid-drain
  // `sessionFinish` is now async (see tracer.ts's header — a D1-backed run's
  // write is a real network call) — a signal handler cannot itself be async,
  // so this fires every run's finish without awaiting it directly. For the
  // LOCAL backend that costs nothing: `LocalTraceDb` performs the write
  // SYNCHRONOUSLY before ever returning the (already-resolved) Promise this
  // discards, so by the time `sessionFinish(...)` returns here the write has
  // already landed — same as before this class existed. Only a run whose
  // `tracer.dbPath` is `null` (d1-backed — see `Tracer.open`) is genuinely
  // still in flight at this point, so ONLY THEN does this add a bounded wait
  // (same `SIGNAL_DRAIN_MS` budget the otel/notify drains already use) before
  // exiting — a killed D1-backed run gets a real chance to land its final
  // write, and every local-only repo keeps exiting with no extra tick.
  const finishes = runs.map((run) => run.tracer.sessionFinish(run.adw_id, false).catch(() => {})); // also closes process rows
  const anyRemote = runs.some((run) => run.tracer.dbPath === null);
  const drains: Array<Promise<void>> = [];
  if (anyRemote) drains.push(Promise.race([Promise.all(finishes), sleep(SIGNAL_DRAIN_MS)]).then(() => {}));
  if (runs.some((run) => run.tracer.otel)) drains.push(otel.flushAll(SIGNAL_DRAIN_MS));
  if (runs.some((run) => run.notify)) drains.push(drainNotifiers(SIGNAL_DRAIN_MS));
  // Unconfigured, local-only (the default) exits SYNCHRONOUSLY, exactly as it
  // did before otel/notify/D1 existed — no extra tick between the signal and
  // the exit for the repos that never opted in to any of the three.
  if (drains.length === 0) {
    process.exit(code);
    return;
  }
  // Bounded and never-throwing: every drain swallows its own failures and
  // resolves on its own deadline, so this always reaches process.exit().
  void Promise.all(drains).then(
    () => process.exit(code),
    () => process.exit(code),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

function finalizeWhenKilled(run: Run): void {
  ACTIVE.set(run.adw_id, run);
  if (installed) return;
  installed = true;
  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);
}

/**
 * The symmetric teardown for `finalizeWhenKilled()` above: drop `adwId` from
 * `ACTIVE` (so a later signal can no longer reach it) and close its Tracer's
 * sqlite handle. Call once a run's own dispatch has fully settled — success
 * or thrown error alike; `chains/index.ts`'s `runChain()` finally is the one
 * seam every dispatch path (one-shot CLI and `spf watch` alike) shares on
 * the way out, exactly where `otel.releaseOtelExporter()` already lives for
 * the identical reason (see otel.ts's RUN-SCOPED CLEANUP note / #26).
 *
 * Without this, `spf watch` held every finished run's `Run` (and its
 * Tracer, its open sqlite handle, and its Notifier) strongly reachable from
 * the signal listener for the rest of the daemon's life — the listener
 * closes over the `run` a fresh `finalizeWhenKilled()` call captured, but
 * since #26 only that one listener installs once now, and `ACTIVE` is the
 * only thing keeping a finished run reachable from it.
 *
 * A one-shot invocation with no explicit `--adw-id` makes `adwId` here the
 * caller's `ctx.adw_id` (`null`) rather than the id `session.ensure()`
 * actually minted, so this is a harmless no-op for it — same caveat as
 * `releaseOtelExporter`, and harmless for the same reason: that process
 * exits right after anyway.
 */
export async function finalize(adwId: string | null | undefined): Promise<void> {
  if (!adwId) return;
  const run = ACTIVE.get(adwId);
  if (!run) return;
  ACTIVE.delete(adwId);
  await run.tracer.close();
}

/** Tests only: which adw_ids the process-wide signal handler currently considers active. */
export function activeRunIdsForTest(): string[] {
  return [...ACTIVE.keys()];
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
export async function ensure(
  cfg: SFConfig,
  adwId?: string | null,
  cwd?: string,
  chainName?: string,
  /** See `RunObserver`'s doc comment (`core/console.ts`). Omitted for every caller except an interactive `cli/commands/run.ts` dispatch — a `spf watch` per-issue run, `spf fanout`'s per-attempt runs, and every test all continue to build a plain, unobserved `Console`. */
  renderHooks?: { sink?: (line: string) => void; observer?: RunObserver | null },
): Promise<Run> {
  const id = adwId || newId(8);
  const anchor = paths.resolveAnchor(cwd);
  const dataPaths = paths.resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db);
  // `null` unless `observability.otel` is configured — no environment variable
  // can turn this on (see core/otel.ts's EXPLICIT CONFIG ONLY). Constructed
  // BEFORE the Tracer because the Tracer's write methods are the fan-out
  // seams: the trace db stays the source of truth, otel is a projection off
  // it, and registering here (module-level LIVE, exactly like
  // resolveNotifier) is what lets the CLI's finally block and the signal
  // handler above drain it without threading a handle through every call site.
  const otelExporter = otel.resolveOtelExporter(cfg, { adwId: id, chainName: chainName || "adw" });
  const tracer = await Tracer.open(dataPaths.db, path.join(dataPaths.sessions_dir, id, "events.jsonl"), otelExporter);

  // `maxPhaseSeq` is a real trace-db read now (D1: a network call) — resolved
  // BEFORE `new Run(...)` because `Run`'s constructor cannot itself be async.
  const startSeq = await tracer.maxPhaseSeq(id);

  const run = new Run({
    cfg,
    adwId: id,
    tracer,
    startSeq,
    engineer: engineerName(),
    repoRoot: anchor.repo_root,
    sfDir: anchor.spf_dir,
    dataDir: dataPaths.data_dir,
    chainName: chainName || "adw",
    notifier: resolveNotifier(cfg),
    sink: renderHooks?.sink,
    observer: renderHooks?.observer,
  });
  const scriptPath = process.argv[1] || "adw";
  await tracer.sessionStart(id, run.engineer, chainName || "adw");
  // This process is the run. Record it before any phase opens, so a run that
  // hangs in its first agent call is still killable by adw_id.
  await tracer.processStart(id, "adw", "", process.pid ?? -1, [path.basename(scriptPath), ...process.argv.slice(2)].join(" "));
  finalizeWhenKilled(run);
  await run.console.sessionStarted(id, run.engineer);
  return run;
}
