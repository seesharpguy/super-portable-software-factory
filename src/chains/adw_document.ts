/**
 * ADW Document — write up the work that was just done, from the diff.
 *
 * Usage:
 *   bun run adws/adw_document.ts "<prompt or path/to/prompt.md>" [--base main] [--config adws/adw_sf_config/sf.config.yaml] [--adw-id a1b2c3d4]
 *
 * Phases: engineer(request) -> code(changes) -> documenter
 *
 * This runs AFTER a build, and the guard is structural rather than advisory: the
 * change capture is a code phase, and an empty diff raises there — before the
 * documenter is ever spawned. There is nothing to document until something was
 * built, and the phase says so instead of paying an agent to discover it.
 *
 * `git diff` against `--base` (main by default) is what "the latest changes"
 * means here; see core/changes.ts for how the base commit is resolved on a
 * branch, on main, and on a clean tree right after a chain committed.
 */

import * as agents from "../core/agents.ts";
import * as changes from "../core/changes.ts";
import * as gates from "../core/gates.ts";
import * as session from "../core/session.ts";
import { DocumentOutput, makeAgentCall, makeChangeCapture, makePhaseParams } from "../core/data_types.ts";
import type { ChainContext } from "./context.ts";

const REQUIRED_AGENTS = ["documenter"];
const REQUIRED_SUITES: string[] = [];

const DOCUMENT_NOTES =
  "Read diff_path in full before writing. Document only what the diff shows, then copy the write-up into app_docs/ as your task describes.";

export async function main(ctx: ChainContext, options: { base?: string } = {}): Promise<number> {
  const { prompt, config_paths, adw_id, cwd } = ctx;
  const base = options.base ?? "main";
  const cfg = agents.loadConfig(config_paths);
  agents.validate(cfg, REQUIRED_AGENTS, REQUIRED_SUITES, cwd);
  const run = session.ensure(cfg, adw_id, cwd);

  await run.phase(makePhaseParams({ name: "request", kind: "engineer", owner: run.engineer, description: "Capture the incoming ask" }), async (ph) => {
    ph.log({ input: prompt });
  });

  const changeset = await run.phase(
    makePhaseParams({ name: "changes", kind: "code", owner: "git", description: `Diff the working tree against ${base} — the change to be written up` }),
    async (ph) => {
      const result = changes.capture(run, makeChangeCapture({ base }));
      ph.log({
        base: `${result.base.label} @ ${result.base.commit.slice(0, 7)}`,
        reason: result.base.reason,
        files: result.files.length + result.untracked.length,
        lines: `+${result.insertions} -${result.deletions}`,
        diff: result.diff_path,
      });
      if (result.empty) {
        throw new Error(
          `nothing changed since ${result.base.label} (${result.base.reason}) — documenting runs after a build. ` +
            `Build something first, or point --base at the ref the work should be measured from.`,
        );
      }
      return result;
    },
  );

  await run.phase(
    makePhaseParams({ name: "document", kind: "agent", owner: "documenter", retries: 1, description: "Turn the captured diff into a write-up an engineer can read" }),
    async (ph) => {
      await ph.call(
        makeAgentCall({
          output_type: DocumentOutput,
          prompt,
          previous: changes.asEnvelope(changeset, DOCUMENT_NOTES),
          gates: [gates.artifactsExist, gates.filesNonEmpty],
        }),
      );
    },
  );

  return run.finish();
}
