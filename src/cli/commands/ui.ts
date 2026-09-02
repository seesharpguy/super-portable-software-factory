import path from "node:path";
import * as agents from "../../core/agents.ts";
import * as paths from "../../core/paths.ts";
import type { NormalizedObservabilityDb } from "../../core/data_types.ts";
import { parseCli } from "../../core/utils.ts";
import { runUi } from "../../ui/server/serve.ts";

export async function uiCommand(argv: string[]): Promise<number> {
  const { options, flags } = parseCli(argv, ["cwd", "config", "db", "port"], ["no-open"]);
  const anchor = paths.resolveAnchor(options["cwd"]);

  let db: NormalizedObservabilityDb;
  let sessionsDir: string | undefined;
  let label: string;
  if (options["db"]) {
    // `--db <path>` always names a local sqlite file — there is no D1
    // equivalent of "point at this one file" from the CLI yet.
    const dbPath = path.resolve(anchor.cwd, options["db"]);
    db = { kind: "sqlite", path: dbPath };
    label = dbPath;
  } else {
    const cfg = agents.loadConfig(paths.resolveConfigPaths(anchor, options["config"]).paths);
    const dataPaths = paths.resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db);
    db = dataPaths.db;
    sessionsDir = dataPaths.sessions_dir;
    label = db.kind === "sqlite" ? db.path : `d1:${db.database_id}`;
  }

  try {
    const handle = await runUi({
      db,
      sessionsDir,
      webDir: paths.WEB_DIR,
      port: options["port"] ? Number.parseInt(options["port"], 10) : undefined,
      open: !flags["no-open"],
    });
    console.log(`[spf] ui        ${handle.url}`);
    console.log(`[spf] db        ${label}`);
    // runUi() already registers SIGINT/SIGTERM handlers that exit the
    // process; just keep this call from returning until then.
    await new Promise(() => {});
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}
