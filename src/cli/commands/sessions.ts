import { parseCli } from "../../core/utils.ts";
import { openTrace } from "./trace.ts";

export function sessionsCommand(argv: string[]): number {
  const { options, flags } = parseCli(argv, ["cwd", "config", "limit"], ["json"]);
  const { db } = openTrace(options);
  const limit = options["limit"] ? Number.parseInt(options["limit"], 10) : 20;
  const rows = db.sessions(limit);

  if (flags["json"]) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log("no sessions yet");
    return 0;
  }
  for (const s of rows) {
    console.log(`${s.adw_id}  ${(s.status ?? "").padEnd(8)}  ${s.started_at}  ${(s.request ?? "").slice(0, 60)}`);
  }
  return 0;
}
