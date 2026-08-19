#!/usr/bin/env bun
/**
 * make_config — generate adws/adw_sf_config/sf.config.yaml with great defaults.
 *
 * Usage:
 *   bun run <skill>/scripts/make_config.ts [--force]
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const TEMPLATE = path.join(import.meta.dir, "..", "templates", "sf.config.yaml");

function main(): number {
  const force = process.argv.slice(2).includes("--force");

  const dest = path.join(process.cwd(), "adws", "adw_sf_config", "sf.config.yaml");
  if (existsSync(dest) && !force) {
    console.log(`${dest} already exists — use --force to overwrite`);
    return 1;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(TEMPLATE, dest);
  console.log(`wrote ${dest}`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
