/** Shared by sessions/phases/events/abort/estimate — resolve the workspace and open its trace db. */
import { existsSync } from "node:fs";
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

/** The one place anchor/config/data-path resolution happens, so `openTrace` and `openTraceIfExists` cannot diverge on it. */
function resolveTrace(options: Record<string, string>): { dbPath: string; anchor: paths.RepoAnchor; dataDir: string; cfg: SFConfig } {
  const anchor = paths.resolveAnchor(options["cwd"]);
  const cfg = agents.loadConfig(paths.resolveConfigPaths(anchor, options["config"]).paths);
  const dataPaths = paths.resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db);
  return { dbPath: dataPaths.db_path, anchor, dataDir: dataPaths.data_dir, cfg };
}

export function openTrace(options: Record<string, string>): TraceHandle {
  const { dbPath, anchor, dataDir, cfg } = resolveTrace(options);
  return { db: new SfDb(dbPath), anchor, dataDir, cfg };
}

/**
 * Like `openTrace`, but never throws on a missing db file: `db` is `null`
 * in that one slot instead. `anchor`/`dataDir`/`cfg` still come from the
 * SAME `resolveTrace` call either way — a cold start (no `spf.db` yet)
 * still carries a real, loaded `cfg`, which is what lets `spf estimate`
 * echo `defaults.max_run_tokens`/`max_run_cost` and resolve planned routing
 * before it exits, rather than crashing with `SfDb`'s "point spf ui at a
 * target repo" message (which is about `spf ui`, not `spf estimate`).
 */
export function openTraceIfExists(options: Record<string, string>): { db: SfDb | null; anchor: paths.RepoAnchor; dataDir: string; cfg: SFConfig } {
  const { dbPath, anchor, dataDir, cfg } = resolveTrace(options);
  return { db: existsSync(dbPath) ? new SfDb(dbPath) : null, anchor, dataDir, cfg };
}
