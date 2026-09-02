import { parseCli } from "../../core/utils.ts";
import { openTrace } from "./trace.ts";
import { isInteractive } from "../ask.ts";

export async function phasesCommand(argv: string[]): Promise<number> {
  const { positionals, options, flags } = parseCli(argv, ["cwd", "config"], ["json"]);
  if (positionals.length < 1) {
    console.error("usage: spf phases <adw_id> [--cwd <dir>] [--config <path>] [--json]");
    return 1;
  }
  const adwId = positionals[0];
  const { db } = await openTrace(options);
  const rows = await db.phases(adwId);

  if (flags["json"]) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log(`no phases recorded for ${adwId}`);
    return 1;
  }
  const table = rows.map((p) => [
    String(p.seq).padStart(2, "0"),
    p.status === "success" ? "✓" : p.status === "fail" ? "✗" : "…",
    p.name ?? "",
    p.kind ?? "",
    p.owner ?? "",
    p.error ?? "",
  ]);
  if (isInteractive()) {
    const { renderTable } = await import("../ui/reports.tsx");
    await renderTable(table, { rowColor: (i) => (rows[i]!.status === "fail" ? "red" : undefined) });
  } else {
    for (const [seq, marker, name, kind, owner, error] of table) {
      console.log(`${seq} ${marker} ${name.padEnd(20)} ${kind.padEnd(9)} ${owner.padEnd(12)} ${error}`);
    }
  }
  return 0;
}
