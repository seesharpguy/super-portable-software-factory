/** Prompt rendering: load system/user refs from config, replace {{placeholders}}. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Shared instructions for any documenter call fed a change.asEnvelope() capture. */
export const DOCUMENT_NOTES =
  "Read diff_path in full before writing. Document only what the diff shows, then copy the write-up into app_docs/ as your task describes.";

export function render(templatePath: string, variables: Record<string, string>): string {
  let text = readFileSync(templatePath, "utf-8");
  for (const [key, value] of Object.entries(variables)) {
    text = text.split(`{{${key}}}`).join(value);
  }
  return text;
}

/** Save the exact prompt sent, before execution — the audit copy. */
export function save(directory: string, name: string, content: string): string {
  mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, name);
  writeFileSync(filePath, content);
  return filePath;
}
