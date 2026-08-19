/**
 * The workspace anchor: the one place `process.cwd()` is read, and the one
 * place that decides what "the repo" means for a run.
 *
 * Everything downstream — session dirs, the trace db, gate checks, git
 * operations — is anchored to `repo_root`, an absolute path, never to
 * whatever directory the process happened to be started from. Before this
 * module existed, those two were silently assumed to be the same directory;
 * a chain launched from a subdirectory (or, later, by a globally-installed
 * CLI run from an arbitrary cwd) would resolve config/prompts/gates against
 * one anchor and git/agent-subprocess work against another.
 *
 * This is also where the packaged built-in defaults live, relative to this
 * module's own location — `PACKAGE_ROOT` is two directories up from
 * `dist/core/paths.js` (or `src/core/paths.ts` run directly; both are two
 * levels below the package root, so the same relative path resolves either
 * way), with `assets/` a direct child of it.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "./git_helper.ts";

export const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const ASSETS_DIR = path.join(PACKAGE_ROOT, "assets");
/** The prebuilt SPA — a sibling of dist/ and assets/, built once at publish time (see app/). */
export const WEB_DIR = path.join(PACKAGE_ROOT, "web");
export const BUILTIN_CONFIG_PATH = path.join(ASSETS_DIR, "defaults", "sf.config.yaml");
export const BUILTIN_PROMPTS_DIR = path.join(ASSETS_DIR, "prompts");

export interface RepoAnchor {
  /** The invocation cwd this anchor was resolved from (already absolute). */
  cwd: string;
  /** Git toplevel containing `cwd`, or `cwd` itself if it's not a repo. Always absolute. */
  repo_root: string;
  /** Nearest `.sf/` directory walking up from `cwd`, capped at `repo_root`. `null` if none exists. */
  sf_dir: string | null;
}

/** Walk up from `cwd` to (and including) `repoRoot` looking for a `.sf/` directory. */
function findSfDir(cwd: string, repoRoot: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, ".sf");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    if (dir === repoRoot) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root — stop
    dir = parent;
  }
}

/** Resolve the repo anchor. `cwd` defaults to `process.cwd()` — read here, once. */
export function resolveAnchor(cwd?: string): RepoAnchor {
  const resolvedCwd = path.resolve(cwd ?? process.cwd());
  const repo_root = findRepoRoot(resolvedCwd);
  return { cwd: resolvedCwd, repo_root, sf_dir: findSfDir(resolvedCwd, repo_root) };
}

export interface ConfigResolution {
  /** In load order — later paths override earlier ones (agents.loadConfig). */
  paths: string[];
  source: "explicit" | "sf-dir" | "built-in-only";
}

/**
 * Where the config is, given an optional explicit `--config`.
 *
 * An explicit path is used STANDALONE — no merge with the built-in defaults,
 * because naming a file is "use exactly this." Otherwise the built-in
 * packaged config always loads first, and a discovered `.sf/sf.config.yaml`
 * merges on top of it if one exists — this is the "override one field"
 * path, via agents.loadConfig's merge.
 */
export function resolveConfigPaths(anchor: RepoAnchor, explicit?: string): ConfigResolution {
  if (explicit) return { paths: [path.resolve(anchor.cwd, explicit)], source: "explicit" };
  if (anchor.sf_dir) {
    const override = path.join(anchor.sf_dir, "sf.config.yaml");
    if (existsSync(override)) return { paths: [BUILTIN_CONFIG_PATH, override], source: "sf-dir" };
  }
  return { paths: [BUILTIN_CONFIG_PATH], source: "built-in-only" };
}

export interface DataPaths {
  /** Absolute — for every fs call. */
  data_dir: string;
  /** Repo-root-relative, forward-slash — for matching against git's own path output. */
  data_dir_rel: string;
  /** Absolute. */
  db_path: string;
  /** Absolute. ALWAYS a sibling of `db_path` — relocating `data_dir` must never break this. */
  sessions_dir: string;
}

/**
 * Anchor a config's own `data_dir`/`observability.db` (as loaded — relative
 * or absolute, whichever the YAML says) to `repo_root`.
 *
 * Deliberately does NOT touch the config object itself: `permissions.
 * alwaysWritable()` matches `cfg.defaults.data_dir` against repo-relative git
 * output, so that field stays exactly as configured. This produces a
 * parallel, absolute set of paths for filesystem use instead of mutating it.
 */
export function resolveDataPaths(anchor: RepoAnchor, rawDataDir: string, rawDbPath: string): DataPaths {
  const data_dir = path.resolve(anchor.repo_root, rawDataDir);
  const data_dir_rel = path.relative(anchor.repo_root, data_dir).split(path.sep).join("/");
  const db_path = path.resolve(anchor.repo_root, rawDbPath);
  const sessions_dir = path.resolve(path.dirname(db_path), "sessions");
  return { data_dir, data_dir_rel, db_path, sessions_dir };
}

/**
 * Resolve a prompt ref (a `prompt_engineering.system`/`.user` value from
 * config) to an absolute path, trying every root a ref could sensibly be
 * written against. An absolute ref passes through unchanged. Throws naming
 * every path it tried on a total miss — closing the historical "no fallback
 * if a prompt file is missing" gap, where a bad ref just threw ENOENT deep
 * inside readFileSync with no context.
 */
export function resolvePromptRef(anchor: Pick<RepoAnchor, "repo_root" | "sf_dir">, ref: string): string {
  if (path.isAbsolute(ref)) {
    if (existsSync(ref)) return ref;
    throw new Error(`prompt ref not found: ${ref}`);
  }
  const candidates = [path.join(anchor.repo_root, ref)];
  if (anchor.sf_dir) {
    candidates.push(path.join(anchor.sf_dir, ref), path.join(anchor.sf_dir, "prompt_engineering", ref));
  }
  candidates.push(path.join(ASSETS_DIR, ref), path.join(BUILTIN_PROMPTS_DIR, ref));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`prompt ref ${JSON.stringify(ref)} not found — tried:\n  ${candidates.join("\n  ")}`);
}
