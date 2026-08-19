/**
 * Small shared helpers. Anything bigger belongs in its own module.
 *
 * Bun loads .env files automatically for anything run with `bun run`/`bun`,
 * so there is no load_dotenv() call to make here — that parity is free.
 */

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The engineer's own environment, as their shell would hand it over.
 *
 * Python's version stripped a `uv run` venv's bin dir off PATH so a
 * subprocess's `python3` resolved the operator's own interpreter, not the
 * ADW's ephemeral one. Bun scripts run directly (no venv layer prepended to
 * PATH), so there is nothing to strip here — this exists for call-site parity
 * and as the one place to patch if a future wrapper starts doing the same
 * thing to PATH.
 */
export function operatorEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function newId(length: number = 8): string {
  return randomBytes(Math.floor(length / 2)).toString("hex");
}

/** Matches Python's `datetime.now(timezone.utc).isoformat(timespec="milliseconds")`. */
export function nowIso(): string {
  const iso = new Date().toISOString(); // e.g. 2024-01-01T12:00:00.123Z
  return iso.replace("Z", "+00:00");
}

export function ensureDir(dirPath: string): string {
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

/** CLI prompt arg: a file path resolves to its contents, else inline text. */
export function resolvePrompt(arg: string): string {
  try {
    if (existsSync(arg) && statSync(arg).isFile()) {
      return readFileSync(arg, "utf-8");
    }
  } catch {
    // not a valid path — fall through to inline text
  }
  return arg;
}

export function engineerName(): string {
  const name = (process.env.ENGINEER_NAME || "").trim();
  if (name) return name;
  try {
    const out = spawnSync("git", ["config", "user.name"], { encoding: "utf-8", timeout: 5000 });
    if (out.status === 0 && out.stdout.trim()) return out.stdout.trim();
  } catch {
    // git not available or not configured — fall through
  }
  return process.env.USER || process.env.USERNAME || "engineer";
}

/**
 * Minimal `--flag value` / `--bare-flag` CLI parsing — the CLI only ever
 * needs a handful of positionals plus a handful of named options and bare
 * boolean flags, so a full argparse port would be more machinery than the
 * job needs. `flagNames` are boolean — present means true, never consumes
 * the next argv value; anything else in `optionNames` always takes a value.
 */
export function parseCli(
  argv: string[],
  optionNames: string[],
  flagNames: string[] = [],
): { positionals: string[]; options: Record<string, string>; flags: Record<string, boolean> } {
  const positionals: string[] = [];
  const options: Record<string, string> = {};
  const flags: Record<string, boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (flagNames.includes(name)) {
        flags[name] = true;
        continue;
      }
      if (!optionNames.includes(name)) throw new Error(`unknown option: --${name}`);
      const value = argv[++i];
      if (value === undefined) throw new Error(`--${name} requires a value`);
      options[name] = value;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, options, flags };
}

/** Run an ADW's async main() and translate its outcome into a process exit code. */
export function runMain(main: () => Promise<number>): void {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}

export { path };
