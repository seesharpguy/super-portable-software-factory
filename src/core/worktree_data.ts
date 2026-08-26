/**
 * Keep a worktree's `.spf/data` symlink invisible to `git status`/`git add -A`.
 *
 * Moved here (out of `cli/commands/fanout.ts`) so both `cli/commands/fanout.ts`
 * and `cli/commands/watch.ts` can call it without either command importing the
 * other — `spawnSync` + `node:fs` only, no chains, no db, no sandbox, matching
 * `core/git_helper.ts`'s own dependency discipline.
 *
 * `.spf/data/` — a trailing-slash DIRECTORY pattern, the shape a tracked
 * `.gitignore` uses — does NOT match a SYMLINK of the same name, so without
 * this, `git status` shows `?? .spf/data` and a committing chain's
 * `git_helper.commitAll` (`git add -A`) stages it. Following a printed
 * `git merge <branch>` instruction then fast-forwards the symlink straight
 * into the MAIN repo, replacing its real `.spf/data` directory with a symlink
 * pointing back at itself — destroying the trace db (`ls .spf/data` becomes
 * `ELOOP`; see `paths.healBrokenDataDir` for the recovery side of this same
 * bug). `info/exclude` is per-worktree, local-only, and idempotent to append
 * to — the opposite of adding a pattern to a tracked `.gitignore`, which would
 * ship this workaround into every clone for a symlink only a scoped-worktree
 * caller (fan-out attempts, `spf watch`'s own build-lane worktrees) ever
 * creates.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export function excludeSpfDataFromGit(worktreePath: string): void {
  const resolved = spawnSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: worktreePath, encoding: "utf-8" });
  if (resolved.status !== 0) return; // best-effort: worst case is the pre-existing staging risk, not a crash
  const excludePath = path.resolve(worktreePath, resolved.stdout.trim());
  const line = ".spf/data";
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf-8") : "";
  if (existing.split("\n").some((l) => l.trim() === line)) return;
  mkdirSync(path.dirname(excludePath), { recursive: true });
  appendFileSync(excludePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}${line}\n`);
}
