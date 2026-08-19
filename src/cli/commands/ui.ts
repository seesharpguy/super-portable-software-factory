import path from "node:path";
import * as agents from "../../core/agents.ts";
import * as paths from "../../core/paths.ts";
import { parseCli } from "../../core/utils.ts";
import { runUi } from "../../ui/server/serve.ts";

export async function uiCommand(argv: string[]): Promise<number> {
  const { options, flags } = parseCli(argv, ["cwd", "config", "db", "port"], ["no-open"]);
  const anchor = paths.resolveAnchor(options["cwd"]);

  let dbPath: string;
  if (options["db"]) {
    dbPath = path.resolve(anchor.cwd, options["db"]);
  } else {
    const cfg = agents.loadConfig(paths.resolveConfigPaths(anchor, options["config"]).paths);
    dbPath = paths.resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db).db_path;
  }

  try {
    const handle = await runUi({
      dbPath,
      webDir: paths.WEB_DIR,
      port: options["port"] ? Number.parseInt(options["port"], 10) : undefined,
      open: !flags["no-open"],
    });
    console.log(`[sf] ui        ${handle.url}`);
    console.log(`[sf] db        ${dbPath}`);
    // runUi() already registers SIGINT/SIGTERM handlers that exit the
    // process; just keep this call from returning until then.
    await new Promise(() => {});
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}
