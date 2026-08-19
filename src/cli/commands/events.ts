import { parseCli } from "../../core/utils.ts";
import { openTrace } from "./trace.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printEvent(e: { rowid: number; type: string | null; name: string | null; payload_json: string | null }): void {
  let payload = "";
  try {
    payload = JSON.stringify(JSON.parse(e.payload_json ?? "{}"));
  } catch {
    payload = e.payload_json ?? "";
  }
  console.log(`${e.rowid}  ${(e.type ?? "").padEnd(12)} ${(e.name ?? "").padEnd(24)} ${payload}`);
}

export async function eventsCommand(argv: string[]): Promise<number> {
  const { positionals, options, flags } = parseCli(argv, ["cwd", "config", "after", "limit"], ["json", "follow"]);
  if (positionals.length < 1) {
    console.error("usage: sf events <adw_id> [--after <rowid>] [--follow] [--cwd <dir>] [--config <path>] [--json]");
    return 1;
  }
  const adwId = positionals[0];
  const { db } = openTrace(options);
  let after = options["after"] ? Number.parseInt(options["after"], 10) : 0;

  const page = db.events(adwId, after, options["limit"] ? Number.parseInt(options["limit"], 10) : 500);
  if (flags["json"] && !flags["follow"]) {
    console.log(JSON.stringify(page.events, null, 2));
    return 0;
  }
  for (const e of page.events) printEvent(e);
  after = page.cursor;

  if (!flags["follow"]) return 0;

  console.error(`-- following ${adwId}; ^C to stop --`);
  for (;;) {
    await sleep(500);
    const session = db.session(adwId);
    const next = db.events(adwId, after, 500);
    for (const e of next.events) printEvent(e);
    if (next.events.length > 0) after = next.cursor;
    if (session && session.status !== "running" && next.events.length === 0) {
      console.error(`-- ${adwId} is ${session.status}, stopping --`);
      return session.status === "success" ? 0 : 1;
    }
  }
}
