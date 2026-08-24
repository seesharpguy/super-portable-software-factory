#!/usr/bin/env node
/**
 * Tarball size gate, run in CI after `npm run build`. `npm pack --dry-run
 * --json` reports the real size without writing a .tgz to disk. Budget
 * re-verified against this package's build after the Jira issue-authoring
 * work landed alongside priority/frontier/roll-up and spec-completion
 * (514.1kB packed / 1455.7kB unpacked): ≤540 KB packed, ≤1.53 MB unpacked —
 * ~5% headroom so a modest PR doesn't trip CI, without silently regressing
 * back toward shipping compiled test files. Previously 478.5kB/1342.6kB
 * (after tiering #14) — raise these again, the same way, whenever a real
 * feature deliberately grows the package; this gate exists to catch
 * unintentional bloat (an accidentally-included file, a runaway
 * dependency), not to cap the project's size forever.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const PACKED_BUDGET = 540_000;
const UNPACKED_BUDGET = 1_530_000;

const root = path.resolve(import.meta.dirname, "..");
// --ignore-scripts: this check runs AFTER `npm run build` in CI, so the
// prepack guard has already had its say; running it again here would only
// print its own output onto the same stdout stream this script parses as JSON.
// It does NOT suppress `prepare`, though (verified directly: npm still ran
// `lefthook install` here despite the flag, printing "sync hooks: ..." onto
// stdout) — `prepare`'s whole point is to run before packing regardless, so
// rather than fight that, find where npm's own JSON array actually starts
// (its own line, always "[") and parse from there instead of the raw string.
const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf-8" });
const lines = raw.split("\n");
const jsonStart = lines.findIndex((line) => line.trim() === "[" || line.trim() === "{");
if (jsonStart === -1) {
  console.error("check-tarball-size: could not find the start of npm pack's JSON output:\n" + raw);
  process.exit(1);
}
const parsed = JSON.parse(lines.slice(jsonStart).join("\n"));
// npm <11 reports an array (`[{...}]`); npm >=12 reports an object keyed by
// package id (`{"@scope/name": {...}}`) -- support both rather than pin to
// whichever shape happened to be installed when this was last verified.
const info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];

function fmt(bytes) {
  return `${(bytes / 1000).toFixed(1)}kB`;
}

console.log(`tarball: ${fmt(info.size)} packed, ${fmt(info.unpackedSize)} unpacked, ${info.entryCount} files`);

const failures = [];
if (info.size > PACKED_BUDGET) failures.push(`packed ${fmt(info.size)} exceeds budget ${fmt(PACKED_BUDGET)}`);
if (info.unpackedSize > UNPACKED_BUDGET) failures.push(`unpacked ${fmt(info.unpackedSize)} exceeds budget ${fmt(UNPACKED_BUDGET)}`);

if (failures.length > 0) {
  console.error("check-tarball-size: over budget:");
  for (const f of failures) console.error(`  ${f}`);
  console.error("\nIf the growth is deliberate, raise PACKED_BUDGET/UNPACKED_BUDGET in this script alongside the change that caused it.");
  process.exit(1);
}
console.log("check-tarball-size: within budget.");
