import { readFileSync } from "node:fs";
import path from "node:path";
import { PACKAGE_ROOT } from "../../core/paths.ts";

export function versionCommand(): number {
  const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf-8")) as { name: string; version: string };
  console.log(`${pkg.name} ${pkg.version}`);
  return 0;
}
