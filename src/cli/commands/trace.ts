/** Shared by sessions/phases/events/abort/estimate — resolve the workspace and open its trace db. */
import * as agents from "../../core/agents.ts";
import * as paths from "../../core/paths.ts";
import type { SFConfig } from "../../core/data_types.ts";
import { SfDb } from "../../ui/server/db.ts";

export interface TraceHandle {
  db: SfDb;
  anchor: paths.RepoAnchor;
  dataDir: string;
  /** Already loaded by this same resolution — `spf estimate` needs it (ceilings, resolveTiering) and reusing it means one loadConfig, not two. */
  cfg: SFConfig;
}

/**
 * The one place anchor/config/data-path resolution happens, so `openTrace`
 * and `openTraceIfExists` cannot diverge on it. Exported (not just used
 * internally) so a caller that needs to inspect `dataPaths.db.kind` BEFORE
 * deciding whether to open anything at all — `abort.ts`'s d1 guard — can
 * reuse this exact resolution instead of a second, divergence-prone copy.
 */
export function resolveTrace(options: Record<string, string>): { dataPaths: paths.DataPaths; anchor: paths.RepoAnchor; dataDir: string; cfg: SFConfig } {
  const anchor = paths.resolveAnchor(options["cwd"]);
  const cfg = agents.loadConfig(paths.resolveConfigPaths(anchor, options["config"]).paths);
  const dataPaths = paths.resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db);
  return { dataPaths, anchor, dataDir: dataPaths.data_dir, cfg };
}

export async function openTrace(options: Record<string, string>): Promise<TraceHandle> {
  const { dataPaths, anchor, dataDir, cfg } = resolveTrace(options);
  return { db: await SfDb.open(dataPaths.db, dataPaths.sessions_dir), anchor, dataDir, cfg };
}

/**
 * Like `openTrace`, but never throws on a db that has never been written
 * to: `db` is `null` in that one slot instead. `anchor`/`dataDir`/`cfg`
 * still come from the SAME `resolveTrace` call either way — a cold start
 * (no `spf.db` yet, or a fresh D1 database with no `sessions` table) still
 * carries a real, loaded `cfg`, which is what lets `spf estimate` echo
 * `defaults.max_run_tokens`/`max_run_cost` and resolve planned routing
 * before it exits, rather than crashing with `SfDb`'s "point spf ui at a
 * target repo" message (which is about `spf ui`, not `spf estimate`).
 *
 * `SfDb.exists` covers both backends: `existsSync(dataPaths.db_path)` for
 * local sqlite, and a cheap `sqlite_master` probe (false, not a throw, when
 * the `sessions` table isn't there yet) for d1 — so `spf estimate`'s
 * documented cold-start path (report + exit 3) actually reaches on a fresh
 * D1 repo instead of crashing.
 */
export async function openTraceIfExists(
  options: Record<string, string>,
): Promise<{ db: SfDb | null; anchor: paths.RepoAnchor; dataDir: string; cfg: SFConfig }> {
  const { dataPaths, anchor, dataDir, cfg } = resolveTrace(options);
  const db = (await SfDb.exists(dataPaths)) ? await SfDb.open(dataPaths.db, dataPaths.sessions_dir) : null;
  return { db, anchor, dataDir, cfg };
}
