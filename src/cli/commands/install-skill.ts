/**
 * `spf install-skill` — copy the packaged Claude Code skill (`assets/skill/`)
 * into a target repo (or `~/.claude/skills/spf` with `--user`), on explicit
 * request only. Nothing here ever runs unless a user asks for it.
 *
 * Idempotent via a manifest (`.spf-skill-version`: {package, version,
 * files: {relpath: sha256}}) written at the skill root:
 *   - unchanged file, unchanged source -> no-op
 *   - unchanged file, source changed (version bump) -> upgraded in place
 *   - user-edited file (its on-disk hash no longer matches what we last
 *     installed) -> NEVER silently overwritten; the incoming version is
 *     written to a `.new` sibling instead, unless --force
 *   - a file present in the OLD manifest but absent from the current
 *     package (renamed/removed cookbook) -> deleted, but only if it was
 *     never edited; an edited stale file is left in place and reported
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import * as paths from "../../core/paths.ts";
import { parseCli } from "../../core/utils.ts";

const MANIFEST_NAME = ".spf-skill-version";

interface Manifest {
  package: string;
  version: string;
  files: Record<string, string>;
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function listFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf-8" })
    .filter((entry) => statSync(path.join(root, entry)).isFile())
    .sort();
}

function readManifest(manifestPath: string): Manifest | null {
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
  } catch {
    return null; // corrupt/foreign file at this path — treat as "no manifest", never crash the install
  }
}

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(paths.PACKAGE_ROOT, "package.json"), "utf-8")) as { version: string };
  return pkg.version;
}

export function installSkillCommand(argv: string[]): number {
  const { options, flags } = parseCli(argv, ["cwd", "target"], ["user", "force"]);

  const destRoot = options["target"]
    ? path.resolve(options["target"])
    : flags["user"]
      ? path.join(homedir(), ".claude", "skills", "spf")
      : path.join(paths.resolveAnchor(options["cwd"]).repo_root, ".claude", "skills", "spf");

  const srcRoot = path.join(paths.ASSETS_DIR, "skill");
  const sourceFiles = listFiles(srcRoot);
  const manifestPath = path.join(destRoot, MANIFEST_NAME);
  const oldManifest = readManifest(manifestPath);
  const version = packageVersion();

  const finalFiles: Record<string, string> = {};
  const report: string[] = [];

  for (const relpath of sourceFiles) {
    const srcPath = path.join(srcRoot, relpath);
    const destPath = path.join(destRoot, relpath);
    const sourceContent = readFileSync(srcPath);
    const sourceHash = sha256(sourceContent);
    const previousHash = oldManifest?.files[relpath];

    if (!existsSync(destPath)) {
      mkdirSync(path.dirname(destPath), { recursive: true });
      writeFileSync(destPath, sourceContent);
      finalFiles[relpath] = sourceHash;
      report.push(`+ ${relpath}`);
      continue;
    }

    const destHash = sha256(readFileSync(destPath));
    if (destHash === sourceHash) {
      finalFiles[relpath] = sourceHash;
      continue; // already exactly right — true no-op
    }
    if (previousHash !== undefined && destHash === previousHash) {
      writeFileSync(destPath, sourceContent); // untouched since our last install — safe to upgrade
      finalFiles[relpath] = sourceHash;
      report.push(`^ ${relpath} (upgraded)`);
      continue;
    }
    if (flags["force"]) {
      writeFileSync(destPath, sourceContent);
      finalFiles[relpath] = sourceHash;
      report.push(`! ${relpath} (forced over local edits)`);
      continue;
    }
    writeFileSync(`${destPath}.new`, sourceContent);
    finalFiles[relpath] = previousHash ?? destHash; // keep tracking what's actually on disk
    report.push(`? ${relpath} (locally modified — wrote ${relpath}.new instead; --force to overwrite)`);
  }

  const sourceSet = new Set(sourceFiles);
  for (const relpath of Object.keys(oldManifest?.files ?? {})) {
    if (sourceSet.has(relpath)) continue;
    const destPath = path.join(destRoot, relpath);
    if (!existsSync(destPath)) continue;
    const destHash = sha256(readFileSync(destPath));
    if (destHash === oldManifest!.files[relpath]) {
      rmSync(destPath);
      report.push(`- ${relpath} (removed — no longer shipped)`);
    } else {
      report.push(`  ${relpath} (no longer shipped, but locally modified — left in place)`);
    }
  }

  mkdirSync(destRoot, { recursive: true });
  const manifest: Manifest = { package: "@gr8ful/spf", version, files: finalFiles };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`spf install-skill: ${destRoot} (v${version})`);
  if (report.length === 0) {
    console.log("  already up to date");
  } else {
    for (const line of report) console.log(`  ${line}`);
  }
  return 0;
}
