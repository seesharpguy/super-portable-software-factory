/** Shared by `init` and `eject` — append missing entries to the repo's `.gitignore`, idempotently. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function ensureGitignore(repoRoot: string, entries: string[]): void {
  const gitignorePath = path.join(repoRoot, ".gitignore");
  const hadFile = existsSync(gitignorePath);
  const existing = hadFile ? readFileSync(gitignorePath, "utf-8").split("\n") : [];
  const missing = entries.filter((entry) => !existing.includes(entry));
  if (missing.length === 0) return;
  const body = hadFile ? existing.join("\n").replace(/\n*$/, "\n") + "\n" : "";
  writeFileSync(gitignorePath, `${body}# spf runtime\n${missing.join("\n")}\n`);
  console.log(`updated ${gitignorePath} (added ${missing.join(", ")})`);
}
