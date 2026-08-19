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
 * NOTE: this is Phase 2's version — it resolves `repo_root` and turns a
 * config's own `data_dir`/`observability.db` into absolute paths. It does
 * NOT yet do `.sf/` discovery or built-in-default fallback; that lands with
 * the full config-resolution phase, extending `resolveConfigPath` below
 * rather than replacing this module's shape.
 */

import path from "node:path";
import { findRepoRoot } from "./git_helper.ts";

export interface RepoAnchor {
  /** The invocation cwd this anchor was resolved from (already absolute). */
  cwd: string;
  /** Git toplevel containing `cwd`, or `cwd` itself if it's not a repo. Always absolute. */
  repo_root: string;
}

/** Resolve the repo anchor. `cwd` defaults to `process.cwd()` — read here, once. */
export function resolveAnchor(cwd?: string): RepoAnchor {
  const resolvedCwd = path.resolve(cwd ?? process.cwd());
  return { cwd: resolvedCwd, repo_root: findRepoRoot(resolvedCwd) };
}

/**
 * Where the config file is, given an optional explicit `--config`.
 *
 * Phase 2 scope: explicit path (resolved against `anchor.cwd`, so a relative
 * `--config` behaves the way an operator typing it in a shell expects), else
 * `<repo_root>/sf.config.yaml`. `.sf/` discovery and the packaged built-in
 * fallback are added here, not elsewhere, once that phase lands.
 */
export function resolveConfigPath(anchor: RepoAnchor, explicit?: string): string {
  if (explicit) return path.resolve(anchor.cwd, explicit);
  return path.join(anchor.repo_root, "sf.config.yaml");
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
