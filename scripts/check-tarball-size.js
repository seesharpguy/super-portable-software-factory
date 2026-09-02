#!/usr/bin/env node
/**
 * Tarball size gate, run in CI after `npm run build`. `npm pack --dry-run
 * --json` reports the real size without writing a .tgz to disk. Budget
 * re-verified against this package's build after the doctor.ts
 * built-in-chain validation fix plus the declarative `env:` config block /
 * `{model}` per-agent-under-Ollama fix (README/config.md/roster.md doc
 * growth + new tests) (541.4kB packed / 1536.3kB unpacked). Previously
 * 514.1kB/1455.7kB (after Jira issue-authoring + priority/frontier/roll-up +
 * spec-completion), and 478.5kB/1342.6kB before that (after tiering #14) —
 * raise these again, the same way, whenever a real feature deliberately
 * grows the package; this gate exists to catch unintentional bloat (an
 * accidentally-included file, a runaway dependency), not to cap the
 * project's size forever.
 *
 * Raised again for SPF #15 (sandbox backends: `sandbox.ts`/
 * `sandbox_opensandbox.ts`/`sandbox_cloudflare.ts`/`sandbox_sdk_types.ts` +
 * their compiled `.d.ts`), rebased onto the above and re-measured at
 * 597.1kB packed / 1729.6kB unpacked, 186 files: ≤625 KB packed, ≤1.81 MB
 * unpacked — ~5% headroom, same rationale as every prior raise.
 *
 * Raised again for watch --n N (sandboxed best-of-N fan-out per claimed
 * issue) rebased onto #53's `spf loop` landing independently on main in the
 * same window: 630.0kB packed / 1828.6kB unpacked, 192 files: ≤660 KB
 * packed, ≤1.92 MB unpacked — ~5% headroom, same rationale as every prior
 * raise.
 *
 * Raised again for the refiner over-decomposition fix: `assets/prompts/
 * refiner/system.md`/`user.md` grew substantially (the slice test, the
 * sizing/budget section, a worked example, a spec-split Report shape) plus
 * new `gates.ts` budget/shape checks, `watch.ts`'s split-proposal state
 * machine, and README/config.md doc growth to match — 675.2kB packed /
 * 1962.2kB unpacked, 195 files: ≤710 KB packed, ≤2.06 MB unpacked — ~5%
 * headroom, same rationale as every prior raise.
 *
 * Raised again for the Timetable UI (#59): the app replaces Play's two
 * woff2 files with the self-hosted Overpass family (five: sans 400/600/700
 * + mono 400/700) and adds DESIGN.md/PRODUCT.md + the design sidecar —
 * re-measured at 719.5kB packed / 2011.7kB unpacked, 198 files: ≤755 KB
 * packed, ≤2.06 MB unpacked — ~5% headroom on the packed side, unpacked
 * unchanged (headroom there grew).
 *
 * Raised again for the WebMCP + on-device AI batch (#67 WebMCP tools, #68
 * in-browser semantic search, #69 Summarizer session summaries, #70 Prompt
 * API Q&A): no new packaged files (still 198), but the app's shipped bundle
 * grew by four components' worth of source plus their API shims —
 * re-measured at 735.8kB packed / 2084.7kB unpacked, 198 files: ≤775 KB
 * packed, ≤2.19 MB unpacked — ~5% headroom, same rationale as every prior
 * raise.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const PACKED_BUDGET = 775_000;
const UNPACKED_BUDGET = 2_190_000;

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
