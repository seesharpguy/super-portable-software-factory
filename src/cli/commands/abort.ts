/**
 * `spf abort <adw_id>` — there is no in-process Flue handle to call .abort()
 * on from a separate CLI invocation, so this is OS-level: find the pid(s)
 * recorded as still running for this adw_id and SIGTERM them. Since Flue
 * runs in-process, that pid is the whole `spf` invocation driving the chain
 * — this stops the run, not just the current model call.
 *
 * LOCAL-FILE-SPECIFIC: reads the `processes` table through a second raw
 * `Database` handle on the same sqlite file `db` already opened — there is
 * no such file for a `kind:"d1"` repo (SPF #66), so this fails clearly
 * instead of pretending a network-backed process table works the same way.
 * A future release could reach the same table over `SfDb`'s own (now async)
 * query surface instead of a raw second handle — not done here because nothing
 * else in this command needs it, and the raw handle already matched
 * `db.journalMode`'s existing guarantees for the local case.
 */
import { Database } from "../../core/sqlite.ts";
import { parseCli } from "../../core/utils.ts";
import { openTrace, resolveTrace } from "./trace.ts";

interface ProcessRow {
  pid: number;
  kind: string;
  name: string;
  command: string;
}

export async function abortCommand(argv: string[]): Promise<number> {
  const { positionals, options } = parseCli(argv, ["cwd", "config"]);
  if (positionals.length < 1) {
    console.error("usage: spf abort <adw_id> [--cwd <dir>] [--config <path>]");
    return 1;
  }
  const adwId = positionals[0];

  // Checked BEFORE opening anything: a d1-backed repo has no local process
  // table regardless of whether its trace db can even be reached, so there
  // is no reason to pay for (or risk failing) an `openTrace` HTTP round
  // trip just to then refuse. This also means no `SfDb` handle is ever
  // opened for the d1 case — nothing to leave unclosed.
  const { dataPaths } = resolveTrace(options);
  if (dataPaths.db.kind === "d1") {
    console.error(
      `spf abort is not supported for a d1-backed repo (observability.db.kind: "d1") — ` +
        `there is no local process table to read for database_id ${JSON.stringify(dataPaths.db.database_id)}. ` +
        `Stop the process by pid/OS tooling directly, or on the machine that ran it.`,
    );
    return 1;
  }

  const { db, dataDir } = await openTrace(options);
  if (db.path === null) {
    // Unreachable in practice — the `dataPaths.db.kind === "d1"` guard above
    // already rejected the only case `db.path` can be null for — but keeps
    // this typed as a real narrowing rather than a `!` assertion.
    throw new Error("spf abort: db.path is null after the d1 guard — this should never happen");
  }

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
