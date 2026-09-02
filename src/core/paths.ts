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

import { existsSync, lstatSync, realpathSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { findRepoRoot } from "./git_helper.ts";
import { resolveObservabilityDb, type ObservabilityDbInput } from "./data_types.ts";

export const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const ASSETS_DIR = path.join(PACKAGE_ROOT, "assets");
/** The prebuilt SPA — a sibling of dist/ and assets/, built once at publish time (see app/). */
export const WEB_DIR = path.join(PACKAGE_ROOT, "web");
export const BUILTIN_CONFIG_PATH = path.join(ASSETS_DIR, "defaults", "spf.config.yaml");
export const BUILTIN_PROMPTS_DIR = path.join(ASSETS_DIR, "prompts");
/** `spf init --template <name>` reads `<name>.spf.config.yaml` from here. */
export const TEMPLATES_DIR = path.join(ASSETS_DIR, "templates");

export interface RepoAnchor {
  /** The invocation cwd this anchor was resolved from (already absolute). */
  cwd: string;
  /** Git toplevel containing `cwd`, or `cwd` itself if it's not a repo. Always absolute. */
  repo_root: string;
  /** Nearest `.spf/` directory walking up from `cwd`, capped at `repo_root`. `null` if none exists. */
  spf_dir: string | null;
}

/** Walk up from `cwd` to (and including) `repoRoot` looking for a `.spf/` directory. */
function findSfDir(cwd: string, repoRoot: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, ".spf");
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
  return { cwd: resolvedCwd, repo_root, spf_dir: findSfDir(resolvedCwd, repo_root) };
}

export interface ConfigResolution {
  /** In load order — later paths override earlier ones (agents.loadConfig). */
  paths: string[];
  source: "explicit" | "spf-dir" | "built-in-only";
}

/**
 * Where the config is, given an optional explicit `--config`.
 *
 * An explicit path is used STANDALONE — no merge with the built-in defaults,
 * because naming a file is "use exactly this." Otherwise the built-in
 * packaged config always loads first, and a discovered `.spf/spf.config.yaml`
 * merges on top of it if one exists — this is the "override one field"
 * path, via agents.loadConfig's merge.
 */
export function resolveConfigPaths(anchor: RepoAnchor, explicit?: string): ConfigResolution {
  if (explicit) return { paths: [path.resolve(anchor.cwd, explicit)], source: "explicit" };
  if (anchor.spf_dir) {
    const override = path.join(anchor.spf_dir, "spf.config.yaml");
    if (existsSync(override)) return { paths: [BUILTIN_CONFIG_PATH, override], source: "spf-dir" };
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
 * Self-heals one specific, previously-observed failure mode: `data_dir`
 * existing as a broken symlink — self-referential (points at itself) or
 * dangling (points at something that no longer exists) — instead of a real
 * directory. `spf watch`'s `linkDataDir` guards against ever CREATING one of
 * these now (see its comment in `cli/commands/watch.ts`), but a prior,
 * unguarded build already left one behind on at least one real checkout, and
 * that state persists across every later `spf` invocation until something
 * removes it: `mkdirSync(data_dir, {recursive: true})` — the very first
 * filesystem touch nearly every command makes, whether via `ensureDir`'s
 * session dirs or `acquireLock`'s lockfile dir — throws `ELOOP` before
 * anything else runs, with no recovery path of its own.
 *
 * This has to run HERE, in the one function every one of those call sites
 * resolves `data_dir` through, rather than as a guard inside each of them
 * individually — a fix duplicated at every call site is a fix that's one new
 * call site away from being missed again.
 *
 * `lstatSync` (never follows the link itself) distinguishes "nothing here
 * yet" (the ordinary first-run case — silently returns, nothing to heal)
 * from "a symlink sits here." Only for the symlink case does `realpathSync`
 * (which fully resolves it) get a chance to throw — `ELOOP` for a circular
 * link, `ENOENT` for a dangling target — and only then is anything removed.
 * A real directory never reaches the `realpathSync` call at all.
 */
function healBrokenDataDir(data_dir: string): void {
  let entry;
  try {
    entry = lstatSync(data_dir);
  } catch {
    return; // nothing at this path at all — ordinary first run
  }
  if (!entry.isSymbolicLink()) return; // a real directory (or file) — not this bug
  try {
    realpathSync(data_dir);
  } catch {
    rmSync(data_dir);
    console.error(`spf: removed a broken data_dir symlink at ${data_dir} (self-referential or dangling) — a fresh directory will be created in its place`);
  }
}

/**
 * Anchor a config's own `data_dir`/`observability.db` (as loaded — relative
 * or absolute, whichever the YAML says) to `repo_root`.
 *
 * Deliberately does NOT touch the config object itself: `permissions.
 * alwaysWritable()` matches `cfg.defaults.data_dir` against repo-relative git
 * output, so that field stays exactly as configured. This produces a
 * parallel, absolute set of paths for filesystem use instead of mutating it.
 *
 * Not otherwise side-effect-free: see `healBrokenDataDir` above, which every
 * caller needs run before its own first `mkdirSync` against `data_dir`.
 *
 * `rawDb` accepts every form `ObservabilityConfigSchema.db` accepts (bare
 * string, `{kind:"sqlite",...}`, `{kind:"d1",...}`) — normalized here via
 * `resolveObservabilityDb` — so every existing call site
 * (`resolveDataPaths(anchor, cfg.defaults.data_dir, cfg.observability.db)`)
 * keeps compiling and behaving unchanged with no call-site edit needed.
 *
 * For a `"sqlite"`-kind db (the only kind that existed before this PR, and
 * still the only kind any adapter can open), `db_path` resolves BYTE-FOR-
 * BYTE identically to before: `path.resolve(repo_root, path)`.
 *
 * For a `"d1"`-kind db there is no local file to resolve a path for — a
 * remote Cloudflare D1 database isn't "a sibling of `sessions_dir`" the way
 * every current caller's `db_path` usage (`new SfDb(dataPaths.db_path)`,
 * `existsSync(dataPaths.db_path)`, `Tracer(dataPaths.db_path, ...)`, plus
 * `spf doctor`'s and `spf init`'s own reads of it) all assume. Rather than
 * hand those unmodified callers a fabricated path that silently opens (or
 * creates) the wrong sqlite file, or a `null` that would need every one of
 * them updated to null-check it — this PR's whole point is introducing the
 * schema WITHOUT touching the adapter or those call sites (PR 2 builds the
 * D1 `Database` adapter; PR 3 updates `spf doctor`'s/`spf init`'s own
 * handling) — this throws a clear, actionable error instead. A repo that
 * sets `observability.db: {kind: d1, ...}` today gets a loud failure at the
 * first command that resolves data paths, not a silent local-file
 * fallback or a confusing low-level crash.
 */
export function resolveDataPaths(anchor: RepoAnchor, rawDataDir: string, rawDb: ObservabilityDbInput): DataPaths {
  const data_dir = path.resolve(anchor.repo_root, rawDataDir);
  healBrokenDataDir(data_dir);
  const data_dir_rel = path.relative(anchor.repo_root, data_dir).split(path.sep).join("/");

  const db = resolveObservabilityDb(rawDb);
  if (db.kind === "d1") {
    throw new Error(
      `observability.db is configured as a Cloudflare D1 database (database_id: ${JSON.stringify(db.database_id)}), ` +
        `but this build has no D1 adapter yet — that lands in a follow-up release. ` +
        `Configure observability.db as a local sqlite path (or omit it — ".spf/data/spf.db" is the default) in the meantime.`,
    );
  }
  const db_path = path.resolve(anchor.repo_root, db.path);
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
export function resolvePromptRef(anchor: Pick<RepoAnchor, "repo_root" | "spf_dir">, ref: string): string {
  if (path.isAbsolute(ref)) {
    if (existsSync(ref)) return ref;
    throw new Error(`prompt ref not found: ${ref}`);
  }
  const candidates = [path.join(anchor.repo_root, ref)];
  if (anchor.spf_dir) {
    candidates.push(path.join(anchor.spf_dir, ref), path.join(anchor.spf_dir, "prompt_engineering", ref));
  }
  candidates.push(path.join(ASSETS_DIR, ref), path.join(BUILTIN_PROMPTS_DIR, ref));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`prompt ref ${JSON.stringify(ref)} not found — tried:\n  ${candidates.join("\n  ")}`);
}
