/**
 * `sf abort <adw_id>` — there is no in-process Flue handle to call .abort()
 * on from a separate CLI invocation, so this is OS-level: find the pid(s)
 * recorded as still running for this adw_id and SIGTERM them. Since Flue
 * runs in-process, that pid is the whole `sf` invocation driving the chain
 * — this stops the run, not just the current model call.
 */
import { Database } from "../../core/sqlite.ts";
import { parseCli } from "../../core/utils.ts";
import { openTrace } from "./trace.ts";

interface ProcessRow {
  pid: number;
  kind: string;
  name: string;
  command: string;
}

export function abortCommand(argv: string[]): number {
  const { positionals, options } = parseCli(argv, ["cwd", "config"]);
  if (positionals.length < 1) {
    console.error("usage: sf abort <adw_id> [--cwd <dir>] [--config <path>]");
    return 1;
  }
  const adwId = positionals[0];
  const { db, dataDir } = openTrace(options);

  // SfDb opens read-only; a live process row needs a separate writable
  // handle only to read it here (no write happens) — reuse the same file.
  const raw = new Database(db.path, { readonly: true });
  const rows = raw
    .query<ProcessRow, [string]>("SELECT pid, kind, name, command FROM processes WHERE adw_id = ? AND ended_at IS NULL")
    .all(adwId);
  raw.close();

  if (rows.length === 0) {
    console.log(`no live process recorded for ${adwId} (data_dir: ${dataDir}) — it may have already finished, or crashed without closing its trace`);
    return 1;
  }

  let ok = true;
  for (const row of rows) {
    try {
      process.kill(row.pid, "SIGTERM");
      console.log(`sent SIGTERM to pid ${row.pid} (${row.kind}${row.name ? `:${row.name}` : ""} — ${row.command})`);
    } catch (error) {
      ok = false;
      console.error(`could not signal pid ${row.pid}: ${(error as Error).message} — it may already be dead; the trace will still show it as running until finalizeWhenKilled's handler runs in that process`);
    }
  }
  return ok ? 0 : 1;
}
