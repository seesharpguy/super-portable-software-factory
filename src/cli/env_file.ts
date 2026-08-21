/**
 * Idempotent `.env` upsert for `spf init`'s interview — the write-side
 * counterpart of `process.loadEnvFile()` in `src/cli/index.ts:66`, which
 * already loads `<repo_root>/.env` on every command. Modeled directly on
 * `ensureGitignore` (`./gitignore.ts`): read, compute only what's missing or
 * changed, log a one-line summary of key NAMES only — a secret value must
 * never reach stdout, a log line, or a trace event.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && ((trimmed[0] === '"' && trimmed.endsWith('"')) || (trimmed[0] === "'" && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteIfNeeded(value: string): string {
  if (/[\s#"]/.test(value)) return `"${value.replace(/"/g, '\\"')}"`;
  return value;
}

/** Parses simple `KEY=VALUE` lines; blank lines and `#` comments are ignored (and preserved verbatim on write). */
export function readEnvFile(p: string): Map<string, string> {
  const values = new Map<string, string>();
  if (!existsSync(p)) return values;
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    const match = KEY_LINE.exec(line.trim());
    if (match) values.set(match[1], unquote(match[2]));
  }
  return values;
}

/** Redacts a secret for display: keeps the last 4 characters, masks the rest. Short values are fully masked. */
export function maskSecret(value: string): string {
  if (value.length <= 4) return "•".repeat(Math.max(value.length, 1));
  return `${"•".repeat(value.length - 4)}${value.slice(-4)}`;
}

export interface EnvUpsertResult {
  added: string[];
  updated: string[];
  unchanged: string[];
}

/**
 * Upsert `entries` into `<repoRoot>/.env`, preserving every existing line —
 * comments, ordering, unrelated keys — verbatim. An existing key is
 * rewritten in place (never duplicated); a new key is appended under a
 * `# spf` header, matching `ensureGitignore`'s idempotent-append shape.
 */
export function upsertEnvFile(repoRoot: string, entries: Record<string, string>): EnvUpsertResult {
  const envPath = path.join(repoRoot, ".env");
  const hadFile = existsSync(envPath);
  const lines = hadFile ? readFileSync(envPath, "utf-8").split("\n") : [];
  const result: EnvUpsertResult = { added: [], updated: [], unchanged: [] };
  const remaining = new Map(Object.entries(entries));

  const rewritten = lines.map((line) => {
    const match = KEY_LINE.exec(line.trim());
    if (!match || !remaining.has(match[1])) return line;
    const key = match[1];
    const newValue = remaining.get(key)!;
    remaining.delete(key);
    if (unquote(match[2]) === newValue) {
      result.unchanged.push(key);
      return line;
    }
    result.updated.push(key);
    return `${key}=${quoteIfNeeded(newValue)}`;
  });

  const newKeys = [...remaining.keys()];
  if (newKeys.length > 0) {
    result.added.push(...newKeys);
    const body = hadFile ? rewritten.join("\n").replace(/\n*$/, "\n") + "\n" : "";
    const appended = newKeys.map((key) => `${key}=${quoteIfNeeded(remaining.get(key)!)}`);
    writeFileSync(envPath, `${body}# spf\n${appended.join("\n")}\n`);
  } else if (result.updated.length > 0) {
    writeFileSync(envPath, rewritten.join("\n"));
  }

  if (!hadFile) {
    try {
      chmodSync(envPath, 0o600);
    } catch {
      // best-effort — some filesystems (or Windows) don't support unix perms
    }
  }

  if (result.added.length > 0 || result.updated.length > 0) {
    console.log(`updated ${envPath} (added: ${result.added.join(", ") || "none"}; updated: ${result.updated.join(", ") || "none"})`);
  }
  return result;
}

/** Fills the `!.env.example` slot `.gitignore` already reserves — key names only, empty values, safe to commit. */
export function writeEnvExample(repoRoot: string, keys: string[]): void {
  if (keys.length === 0) return;
  const examplePath = path.join(repoRoot, ".env.example");
  const unique = [...new Set(keys)].sort();
  writeFileSync(examplePath, `# spf — keys required by this repo's spf.config.yaml; fill in real values in .env (gitignored)\n${unique.map((k) => `${k}=`).join("\n")}\n`);
  console.log(`wrote ${examplePath}`);
}
