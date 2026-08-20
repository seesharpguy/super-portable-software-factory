/**
 * `spf eject` — copy the installed CLI's own compiled engine (`dist/core/`,
 * `dist/chains/`) out to disk for reference or hand-editing. There is no
 * wiring back in: `.spf/` config can override the roster and prompts, but an
 * engine-level change (a new gate, a new envelope type, a modified phase
 * primitive) has no config surface, by design — see
 * `authoring_chains.md`. This exists so `spf migrate`'s report has something
 * concrete to point at for repos with hand-edited `adw_modules/*.ts` from
 * the old stamped design, and for anyone who wants to read the engine
 * without cloning the package's source repo.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import * as paths from "../../core/paths.ts";
import { parseCli } from "../../core/utils.ts";

function copyDirRecursive(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const srcPath = path.join(from, entry.name);
    const destPath = path.join(to, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else if (entry.isFile()) copyFileSync(srcPath, destPath);
  }
}

export function ejectCommand(argv: string[]): number {
  const { options, flags } = parseCli(argv, ["cwd", "target"], ["force"]);
  const anchor = paths.resolveAnchor(options["cwd"]);
  const destRoot = options["target"] ? path.resolve(options["target"]) : path.join(anchor.repo_root, ".spf", "engine");

  if (existsSync(destRoot) && !flags["force"]) {
    console.error(`${destRoot} already exists — pass --force to overwrite, or --target to eject somewhere else.`);
    return 1;
  }

  const pkg = JSON.parse(readFileSync(path.join(paths.PACKAGE_ROOT, "package.json"), "utf-8")) as { version: string };
  const distDir = path.join(paths.PACKAGE_ROOT, "dist");

  mkdirSync(destRoot, { recursive: true });
  copyDirRecursive(path.join(distDir, "core"), path.join(destRoot, "core"));
  copyDirRecursive(path.join(distDir, "chains"), path.join(destRoot, "chains"));

  writeFileSync(
    path.join(destRoot, "NOTES.md"),
    `# Ejected engine — @grateful8/spf v${pkg.version}\n\n` +
      `A reference copy of this install's compiled engine (\`core/\`, \`chains/\`), for reading or for\n` +
      `reapplying hand-edited logic from an old stamped \`adws/adw_modules/\` tree.\n\n` +
      `**This is JS, not TypeScript** — the published package ships compiled output only. It is **not\n` +
      `wired into any \`spf\` command**: editing these files changes nothing about how \`spf\` itself runs.\n` +
      `Engine-level changes (a new gate, envelope type, or phase primitive) have no config surface by\n` +
      `design — see \`authoring_chains.md\` in the installed skill for where each kind of change belongs\n` +
      `and why it isn't a \`.spf/\` override.\n`,
  );

  console.log(`ejected v${pkg.version}'s core/ and chains/ into ${destRoot}`);
  return 0;
}
