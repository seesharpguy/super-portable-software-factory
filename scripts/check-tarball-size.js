#!/usr/bin/env node
/**
 * Tarball size gate, run in CI after `npm run build`. `npm pack --dry-run
 * --json` reports the real size without writing a .tgz to disk. Budget
 * verified against this package's actual first build (239.2kB packed /
 * 635.5kB unpacked): ≤400 KB packed, ≤1.2 MB unpacked, leaving headroom
 * for growth without silently regressing past what a "companion CLI"
 * install should cost.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const PACKED_BUDGET = 400_000;
const UNPACKED_BUDGET = 1_200_000;

const root = path.resolve(import.meta.dirname, "..");
// --ignore-scripts: this check runs AFTER `npm run build` in CI, so the
// prepack guard has already had its say; running it again here would only
// print its own output onto the same stdout stream this script parses as JSON.
const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf-8" });
const [info] = JSON.parse(raw);

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
