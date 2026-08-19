#!/usr/bin/env node
/**
 * The process entry point. This file must have NO static imports of anything
 * that transitively touches node:sqlite (that means core/tracer.ts and
 * everything downstream of it) — ESM hoists static imports, so a static
 * import here would evaluate node:sqlite, and emit its ExperimentalWarning,
 * before the patch below ever runs. Dynamic import() is not hoisted, which
 * is the whole reason this file is split from index.ts.
 *
 * NOTE: this is a Phase 1 stub — just enough to run one chain end-to-end for
 * the golden-master verification. list/sessions/doctor/ui/etc. land in the
 * CLI-surface phase; this file's dispatch logic will be replaced, not
 * layered on top of.
 */

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning.message;
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if (type === "ExperimentalWarning" && message.includes("SQLite")) return;
  return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

await (await import("./index.js")).main();
