/** Shared by sessions/phases/events/abort — resolve the workspace and open its trace db. */
import * as agents from "../../core/agents.ts";
import * as paths from "../../core/paths.ts";
import { SfDb } from "../../ui/server/db.ts";

export interface TraceHandle {
  db: SfDb;
  anchor: paths.RepoAnchor;
  dataDir: string;
}

export function openTrace(options: Record<string, string>): TraceHandle {
  const anchor = paths.resolveAnchor(options["cwd"]);
  const cfg = agents.loadConfig(paths.resolveConfigPaths(anchor, options["config"]).paths);
  const dataPaths = paths.resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db);
  return { db: new SfDb(dataPaths.db_path), anchor, dataDir: dataPaths.data_dir };
}
