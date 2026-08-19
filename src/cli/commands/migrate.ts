/**
 * `sf migrate` — move a repo stamped by the old skill-and-`bun run` design
 * (an `adws/` tree) onto the global-CLI `.sf/` convention. Detects the
 * stamped tree, then COPIES ONLY — nothing under `adws/` is ever deleted or
 * modified, so a bad migration costs nothing to walk away from. Defaults to
 * a dry run; pass `--apply` to actually write.
 *
 * What moves: the roster (rewritten onto `.sf/` paths, coding_agent: flue),
 * the prompt files, the trace db (WAL-checkpointed first) and its sessions/
 * directory as a strict sibling — the one invariant that must survive, or
 * `sf ui`/the prompts endpoint 404 on every migrated session.
 *
 * What does NOT move, on purpose: `adws/adw_modules/*.ts` and any custom
 * `adw_*.ts` chains. Hand-edited engine code has no automatic equivalent —
 * the report points at `sf eject` for a copy of the current engine to
 * reapply those edits onto. `harness_engineering/` entries are dropped for
 * the same reason `agents.validate()` rejects them going forward: no Flue
 * analogue exists.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import { Database } from "../../core/sqlite.ts";
import * as paths from "../../core/paths.ts";
import { parseCli } from "../../core/utils.ts";

interface Action {
  kind: "copy-file" | "copy-dir" | "write-config" | "note";
  detail: string;
}

function copyDirRecursive(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const srcPath = path.join(from, entry.name);
    const destPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else if (entry.isFile()) {
      mkdirSync(path.dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
    }
  }
}

/** The last two path segments — the convention new agent refs use: "<agent>/<file>". */
function shortRef(oldRef: string): string {
  const parts = oldRef.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

export function migrateCommand(argv: string[]): number {
  const { options, flags } = parseCli(argv, ["cwd"], ["apply", "force", "json"]);
  const anchor = paths.resolveAnchor(options["cwd"]);
  const apply = Boolean(flags["apply"]);

  const oldConfigPath = path.join(anchor.repo_root, "adws", "adw_sf_config", "sf.config.yaml");
  if (!existsSync(oldConfigPath)) {
    console.log(`no stamped adws/ tree found at ${anchor.repo_root} (looked for ${oldConfigPath}) — nothing to migrate`);
    return 0;
  }

  const newSfDir = path.join(anchor.repo_root, ".sf");
  const newConfigPath = path.join(newSfDir, "sf.config.yaml");
  if (existsSync(newConfigPath) && !flags["force"]) {
    console.error(`${newConfigPath} already exists — refusing to overwrite. Pass --force to proceed anyway.`);
    return 1;
  }

  const oldText = readFileSync(oldConfigPath, "utf-8");
  const oldConfig = parseYaml(oldText) as Record<string, any>;
  const doc = parseDocument(oldText);

  const oldAdwsRoot = path.join(anchor.repo_root, "adws");
  const resolveOld = (p: string): string => path.resolve(oldAdwsRoot, "..", p); // old refs are "adws/..."-relative to repo_root

  const actions: Action[] = [];
  const newDataDir = ".sf/data";
  const newDbRel = ".sf/data/sf.db";

  doc.setIn(["defaults", "data_dir"], newDataDir);
  doc.setIn(["observability", "db"], newDbRel);
  if (doc.getIn(["defaults", "coding_agent"]) !== undefined) doc.setIn(["defaults", "coding_agent"], "flue");
  const defaultsHarness = oldConfig?.defaults?.harness_engineering;
  if (Array.isArray(defaultsHarness) && defaultsHarness.length > 0) {
    actions.push({ kind: "note", detail: `defaults.harness_engineering (${defaultsHarness.join(", ")}) dropped — no Flue equivalent` });
  }
  doc.setIn(["defaults", "harness_engineering"], []);
  // .sf/ is now the whole per-repo footprint; the old adws/ paths no longer exist.
  doc.setIn(["defaults", "protected_files"], [".sf/", "sf.config.yaml"]);

  const agents: Array<Record<string, any>> = Array.isArray(oldConfig?.agents) ? oldConfig.agents : [];
  agents.forEach((agent, i) => {
    const name = agent.name;
    if (agent.coding_agent !== undefined) doc.setIn(["agents", i, "coding_agent"], "flue");
    const harness = agent.harness_engineering;
    if (Array.isArray(harness) && harness.length > 0) {
      actions.push({ kind: "note", detail: `${name}.harness_engineering (${harness.join(", ")}) dropped — no Flue equivalent` });
    }
    if (harness !== undefined) doc.setIn(["agents", i, "harness_engineering"], []);

    for (const slot of ["system", "user"] as const) {
      const oldRef: string | undefined = agent?.prompt_engineering?.[slot];
      if (!oldRef) continue;
      const srcPath = resolveOld(oldRef);
      const newRef = shortRef(oldRef); // "<agent>/system.md" — resolves via .sf/prompt_engineering/<agent>/...
      doc.setIn(["agents", i, "prompt_engineering", slot], newRef);
      if (existsSync(srcPath)) {
        actions.push({ kind: "copy-file", detail: `${path.relative(anchor.repo_root, srcPath)} -> .sf/prompt_engineering/${newRef}` });
      } else {
        actions.push({ kind: "note", detail: `${name}.prompt_engineering.${slot} (${oldRef}) not found on disk — not copied` });
      }
    }
  });

  const oldDbPath = resolveOld(oldConfig?.observability?.db ?? "adws/adw_data/sf.db");
  const oldSessionsDir = path.join(path.dirname(oldDbPath), "sessions");
  if (existsSync(oldDbPath)) {
    actions.push({ kind: "copy-file", detail: `${path.relative(anchor.repo_root, oldDbPath)} -> ${newDbRel} (WAL-checkpointed first)` });
  } else {
    actions.push({ kind: "note", detail: `no trace db found at ${path.relative(anchor.repo_root, oldDbPath)} — nothing to carry over` });
  }
  if (existsSync(oldSessionsDir)) {
    actions.push({ kind: "copy-dir", detail: `${path.relative(anchor.repo_root, oldSessionsDir)}/ -> .sf/data/sessions/ (must stay a sibling of sf.db)` });
  }

  actions.push({ kind: "write-config", detail: `.sf/sf.config.yaml (rewritten: data_dir, observability.db, prompt refs, coding_agent: flue)` });

  const oldAdwFiles = existsSync(oldAdwsRoot)
    ? readdirSync(oldAdwsRoot).filter((f) => f.startsWith("adw_") && f.endsWith(".ts"))
    : [];
  actions.push({
    kind: "note",
    detail:
      `adws/adw_modules/ and adws/${oldAdwFiles.length > 0 ? oldAdwFiles.join(", ") : "adw_*.ts"} were NOT migrated — ` +
      `hand-edited engine code has no automatic equivalent. Run \`sf eject\` for an editable copy of the current ` +
      `engine to reapply any customizations onto, then delete adws/ yourself once you've confirmed the migration.`,
  });

  if (flags["json"]) {
    console.log(JSON.stringify({ apply, actions }, null, 2));
  } else {
    console.log(apply ? `sf migrate --apply: ${anchor.repo_root}` : `sf migrate (dry run — pass --apply to write): ${anchor.repo_root}`);
    for (const a of actions) console.log(`  [${a.kind}] ${a.detail}`);
  }
  if (!apply) return 0;

  mkdirSync(newSfDir, { recursive: true });
  mkdirSync(path.join(anchor.repo_root, ".sf", "data"), { recursive: true });

  agents.forEach((agent) => {
    for (const slot of ["system", "user"] as const) {
      const oldRef: string | undefined = agent?.prompt_engineering?.[slot];
      if (!oldRef) continue;
      const srcPath = resolveOld(oldRef);
      if (!existsSync(srcPath)) continue;
      const destPath = path.join(newSfDir, "prompt_engineering", shortRef(oldRef));
      mkdirSync(path.dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
    }
  });

  if (existsSync(oldDbPath)) {
    try {
      const db = new Database(oldDbPath);
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      db.close();
    } catch (error) {
      console.error(`warning: could not checkpoint ${oldDbPath} before copying (${(error as Error).message}) — copying as-is`);
    }
    copyFileSync(oldDbPath, path.join(anchor.repo_root, newDbRel));
  }
  if (existsSync(oldSessionsDir)) {
    copyDirRecursive(oldSessionsDir, path.join(anchor.repo_root, ".sf", "data", "sessions"));
  }

  writeFileSync(newConfigPath, doc.toString());

  console.log(`\ndone. Verify with: sf doctor && sf sessions`);
  return 0;
}
