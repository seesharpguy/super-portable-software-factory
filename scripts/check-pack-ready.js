#!/usr/bin/env node
/**
 * `prepack` guard, not a build step. This SPA has never once shipped as
 * part of a real `npm pack` in this repo's history — `vue-tsc --noEmit` is
 * the only check it's ever passed — so the realistic failure mode is a
 * hand-run `npm pack`/`npm publish` from a tree where `npm run build` was
 * never run, shipping a tarball with no CLI or no UI. Fail loudly here
 * instead of shipping that silently.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const required = [
  ["dist/cli/bin.js", "the compiled CLI entry point"],
  ["dist/core/data_types.js", "the compiled core"],
  ["web/index.html", "the prebuilt visualizer SPA"],
];

const missing = required.filter(([rel]) => !existsSync(path.join(root, rel)));
if (missing.length > 0) {
  console.error("prepack: not ready to pack/publish — missing:");
  for (const [rel, what] of missing) console.error(`  ${rel}  (${what})`);
  console.error("\nRun `npm run build` first (builds both the CLI and the visualizer SPA).");
  process.exit(1);
}

// Issue #27: dist/test previously shipped in the published tarball (compiled
// test files, no runtime consumer). package.json's `files` array excludes it
// via `!dist/test`, but that exclusion is easy to lose silently on a future
// edit — so re-check the actual pack manifest here, every time, rather than
// trusting the files array stayed correct. --ignore-scripts skips a nested
// prepack (this script would otherwise re-run itself); it does NOT suppress
// `prepare`, so lefthook's own stdout lines can precede npm's JSON — find
// npm's own array/object line rather than assuming it's the first line.
const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf-8" });
const lines = raw.split("\n");
const jsonStart = lines.findIndex((line) => line.trim() === "[" || line.trim() === "{");
if (jsonStart === -1) {
  console.error("prepack: could not find the start of npm pack's JSON output:\n" + raw);
  process.exit(1);
}
const parsed = JSON.parse(lines.slice(jsonStart).join("\n"));
const info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
const shippedTestFiles = info.files.filter((f) => f.path.startsWith("dist/test/"));
if (shippedTestFiles.length > 0) {
  console.error(`prepack: ${shippedTestFiles.length} file(s) under dist/test/ would ship in the tarball:`);
  for (const f of shippedTestFiles.slice(0, 10)) console.error(`  ${f.path}`);
  console.error('\nRestore the "!dist/test" entry in package.json\'s "files" array.');
  process.exit(1);
}

console.log("prepack: dist/ and web/ are both present, dist/test/ is excluded — ready to pack.");
