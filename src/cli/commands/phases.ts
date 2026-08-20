import { parseCli } from "../../core/utils.ts";
import { openTrace } from "./trace.ts";

export function phasesCommand(argv: string[]): number {
  const { positionals, options, flags } = parseCli(argv, ["cwd", "config"], ["json"]);
  if (positionals.length < 1) {
    console.error("usage: spf phases <adw_id> [--cwd <dir>] [--config <path>] [--json]");
    return 1;
  }
  const adwId = positionals[0];
  const { db } = openTrace(options);
  const rows = db.phases(adwId);

  if (flags["json"]) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (rows.length === 0) {
    console.log(`no phases recorded for ${adwId}`);
    return 1;
  }
  for (const p of rows) {
    const marker = p.status === "success" ? "✓" : p.status === "fail" ? "✗" : "…";
    console.log(`${String(p.seq).padStart(2, "0")} ${marker} ${(p.name ?? "").padEnd(20)} ${(p.kind ?? "").padEnd(9)} ${(p.owner ?? "").padEnd(12)} ${p.error ?? ""}`);
  }
  return 0;
}
