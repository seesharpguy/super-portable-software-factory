#!/usr/bin/env node
/**
 * `npm run tag:<major|minor|patch>` — bump the version, commit it, and push
 * the current branch. Deliberately does NOT create a git tag itself: a tag
 * created here couldn't survive a squash/rebase/merge-commit anyway (none of
 * GitHub's PR merge methods preserve the original commit's SHA onto `main`),
 * so tagging pre-merge was never reliable for a PR-based workflow. Instead,
 * `ci.yml`'s `check-tag` job creates and pushes the release tag itself once
 * this version bump lands on `main` (by any merge method) and tests/pack
 * pass there — see that job's own comment.
 *
 * Runnable from any branch, including `main` directly (a solo/admin release
 * with no PR in between) — `git push origin <branch>` targets whatever
 * branch is checked out rather than hardcoding `main`, so both flows use the
 * same command.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const bump = process.argv[2];
if (!["major", "minor", "patch"].includes(bump)) {
  console.error(`usage: node scripts/tag-release.js <major|minor|patch>`);
  process.exit(1);
}

const branch = execFileSync("git", ["branch", "--show-current"], { encoding: "utf-8" }).trim();

// --no-git-tag-version: bump package.json/package-lock.json only — no commit,
// no tag. The commit below is ours to make, with this repo's own message
// convention; there is no tag to make at all anymore (see the module comment).
execFileSync("npm", ["version", bump, "--no-git-tag-version"], { stdio: "inherit" });
const { version } = JSON.parse(readFileSync("package.json", "utf-8"));

execFileSync("git", ["add", "package.json", "package-lock.json"], { stdio: "inherit" });
execFileSync("git", ["commit", "-m", `Tagging & Publishing v${version}`], { stdio: "inherit" });
execFileSync("git", ["push", "origin", branch], { stdio: "inherit" });

console.log(
  branch === "main"
    ? `\nv${version} pushed to main — CI will tag and publish it automatically once tests/pack pass.`
    : `\nv${version} bumped and pushed to ${branch}. Open a PR into main — once it merges, CI tags and publishes v${version} automatically.`,
);
