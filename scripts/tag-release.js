#!/usr/bin/env node
/**
 * `npm run tag:<major|minor|patch>` — bump the version and push the release.
 *
 * `ci.yml` deliberately has no `on: push: tags:` trigger (a tag pushed
 * alongside its branch would otherwise fire a second, duplicate workflow run
 * for the same commit — see the comment there). Its `check-tag` job instead
 * looks for a version tag on HEAD *within* the branch-triggered run, so the
 * commit and its tag must land on the remote together, in one `git push` —
 * not as two separate pushes, which would race the moment CI starts
 * checking out the commit against whichever push happened to arrive second.
 * `--follow-tags` is what gets both refs to the remote in that one call.
 */
import { execFileSync } from "node:child_process";

const bump = process.argv[2];
if (!["major", "minor", "patch"].includes(bump)) {
  console.error(`usage: node scripts/tag-release.js <major|minor|patch>`);
  process.exit(1);
}

const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf-8" }).trim();
if (branch !== "main") {
  console.error(`tag:${bump}: must be run from main (currently on ${JSON.stringify(branch)}) — CI's release check only looks for a tag on a commit pushed to main.`);
  process.exit(1);
}

execFileSync("npm", ["version", bump, "-m", "Bump version to %s"], { stdio: "inherit" });
execFileSync("git", ["push", "--follow-tags", "origin", "main"], { stdio: "inherit" });
