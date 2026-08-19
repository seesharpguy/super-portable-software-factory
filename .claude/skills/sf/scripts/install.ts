#!/usr/bin/env bun
/**
 * /install — stamp the SF factory from the skill into the cwd. Idempotent.
 *
 * Usage:
 *   bun run <skill>/scripts/install.ts [--force]
 *
 * Stamps: adws/ (modules + starter ADWs), adws/adw_data/prompt_engineering/
 * (4 starter agents), adws/adw_sf_config/sf.config.yaml, .env.sample,
 * .gitignore entries.
 * Existing files are skipped unless --force.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const TEMPLATES = path.join(import.meta.dir, "..", "templates");

const GITIGNORE_ENTRIES = [
  "adws/adw_data/sessions/",
  "adws/adw_data/sf.db*",
  ".env",
  // The ADWs are TypeScript run by Bun, so `bun install` in adws/ leaves a
  // node_modules there. Chains that end in a commit phase call `git add -A`,
  // so without this a stamped repo would try to commit its own dependency tree.
  "adws/node_modules/",
];

function stamp(src: string, dest: string, force: boolean, stamped: string[], skipped: string[]): void {
  if (statSync(src).isDirectory()) {
    for (const child of readdirSync(src).sort()) {
      if (child === "node_modules") continue;
      stamp(path.join(src, child), path.join(dest, child), force, stamped, skipped);
    }
    return;
  }
  if (existsSync(dest) && !force) {
    skipped.push(dest);
    return;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  stamped.push(dest);
}

function ensureGitignore(root: string, stamped: string[]): void {
  const gitignorePath = path.join(root, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8").split("\n") : [];
  const missing = GITIGNORE_ENTRIES.filter((entry) => !existing.includes(entry));
  if (missing.length > 0) {
    const base = existing.join("\n").replace(/\n*$/, "\n");
    writeFileSync(gitignorePath, base + "\n# sf runtime\n" + missing.join("\n") + "\n");
    stamped.push(`${gitignorePath} (+${missing.length} entries)`);
  }
}

function main(): number {
  const force = process.argv.slice(2).includes("--force");

  const root = process.cwd();
  const stamped: string[] = [];
  const skipped: string[] = [];

  stamp(path.join(TEMPLATES, "adws"), path.join(root, "adws"), force, stamped, skipped);
  stamp(path.join(TEMPLATES, "prompt_engineering"), path.join(root, "adws", "adw_data", "prompt_engineering"), force, stamped, skipped);
  stamp(path.join(TEMPLATES, "harness_engineering"), path.join(root, "adws", "adw_data", "harness_engineering"), force, stamped, skipped);
  stamp(path.join(TEMPLATES, "sf.config.yaml"), path.join(root, "adws", "adw_sf_config", "sf.config.yaml"), force, stamped, skipped);
  stamp(path.join(TEMPLATES, "env.sample"), path.join(root, ".env.sample"), force, stamped, skipped);
  // The recipes are part of the operating experience, and several cookbooks
  // plus the run banner tell you to use them, so a stamped repo has to have
  // them. Skipped like any other file if the repo already has a justfile.
  stamp(path.join(TEMPLATES, "justfile"), path.join(root, "justfile"), force, stamped, skipped);
  ensureGitignore(root, stamped);

  console.log(`sf installed into ${root}`);
  console.log(`  stamped: ${stamped.length} file(s)`);
  for (const s of stamped) console.log(`    + ${s}`);
  if (skipped.length > 0) {
    console.log(`  skipped (already exist, use --force to overwrite): ${skipped.length}`);
  }
  console.log("\nnext steps:");
  console.log("  1. cp .env.sample .env      # then set the key(s) your roster needs");
  console.log("  2. cd adws && bun install   # one-time — installs zod + yaml, then cd back");
  console.log("  3. just demo                # two cheap read-only runs, end to end");
  console.log("  4. just sessions            # what just happened");
  console.log("  5. just obs                 # the trace UI, needs bun");
  console.log("\n  no just? the raw form of step 3 is:");
  console.log('     bun run adws/adw_prompt.ts "say hello" --agent scout');
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
