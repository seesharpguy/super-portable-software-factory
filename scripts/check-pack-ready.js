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
console.log("prepack: dist/ and web/ are both present — ready to pack.");
