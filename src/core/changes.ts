/**
 * Deterministic change capture: what was built, straight from git.
 *
 * "What changed since main" is not a judgement call — it is two git commands and
 * a subtraction. So it is code, and an agent is only handed the result. The
 * capture writes the full diff into `context_handoff/` and returns a ChangeSet;
 * `asEnvelope` adapts that into the one door every agent handoff uses.
 *
 * The base is resolved, not assumed. Off the base branch the diff covers the
 * whole branch plus the working tree; on it, the uncommitted tree; and on a clean
 * tree, the last commit — because "document the work that was just done" still
 * has an answer right after a chain committed. Whichever it picked rides along in
 * `BaseRef.reason`, so the trace never leaves you guessing what a diff was
 * measured against.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";
import { isRepoAt, type GitHandle } from "./git_helper.ts";
import { BaseRef, ChangeSet, ChangesOutput, type ChangeCapture, type ChangesOutputT } from "./data_types.ts";

const DIFF_FILENAME = "changes.diff";

interface RunLike {
  context_handoff_dir: string;
  repo_root: string;
  git: GitHandle;
}

/** Pick the commit the work is measured from, and record why that one. */
export function resolveBase(run: RunLike, ref: string): BaseRef {
  if (!isRepoAt(run.repo_root)) {
    throw new Error(
      "not a git repository — change capture needs one. Run `git init` in " +
        "the repo root before running an ADW that documents a change.",
    );
  }
  if (!run.git.refExists(ref)) {
    throw new Error(
      `base ref ${JSON.stringify(ref)} does not exist in this repository — pass --base ` +
        `with a ref that does (e.g. --base master, --base HEAD~1).`,
    );
  }

  // Built first, then given its reason: BaseRef.label knows how to print a
  // pinned sha, and the reason is the line a human reads in the trace.
  const base = new BaseRef(ref, run.git.mergeBase(ref, "HEAD"));
  if (run.git.shortSha(base.commit) !== run.git.shortSha("HEAD")) {
    base.reason = `HEAD is ahead of ${base.label} — diffing every commit since, plus the working tree`;
  } else if (run.git.isDirty()) {
    base.reason = `HEAD is on ${base.label} — diffing the uncommitted working tree`;
  } else if (run.git.refExists("HEAD~1")) {
    base.commit = run.git.rev("HEAD~1");
    base.reason = `HEAD is on ${base.label} with a clean tree — falling back to the last commit`;
  } else {
    base.reason = `HEAD is on ${base.label} with a clean tree and no parent commit`;
  }
  return base;
}

/** Diff the working tree against the resolved base and persist the evidence. */
export function capture(run: RunLike, params: ChangeCapture): ChangeSet {
  const base = resolveBase(run, params.base);
  const files = run.git.diffFiles(base.commit);
  const untracked = params.include_untracked ? run.git.untrackedFiles() : [];
  const [insertions, deletions] = run.git.diffCounts(base.commit);
  const stat = run.git.diffStat(base.commit);

  let text = run.git.diffText(base.commit);
  const lines = text.split("\n");
  const truncated = lines.length > params.max_diff_lines;
  if (truncated) {
    text = lines.slice(0, params.max_diff_lines).join("\n");
    text += `\n\n[truncated at ${params.max_diff_lines} lines of ${lines.length} — run \`git diff ${base.commit}\` for the rest]`;
  }

  // Untracked files are absent from `git diff` by construction, so they are
  // named here rather than silently missing from the record. The reader has
  // `read` and can open any of them.
  const untrackedBlock = untracked.length > 0 ? untracked.map((f) => `  ${f}`).join("\n") : "  (none)";
  const diffPath = path.join(run.context_handoff_dir, DIFF_FILENAME);
  writeFileSync(
    diffPath,
    `# changes since ${base.label} @ ${run.git.shortSha(base.commit)}\n` +
      `# ${base.reason}\n` +
      `# +${insertions} -${deletions} across ${files.length} tracked file(s)\n\n` +
      `## stat\n${stat || "  (no tracked changes)"}\n\n` +
      `## untracked files\n${untrackedBlock}\n\n` +
      `## diff\n${text}\n`,
  );

  return new ChangeSet(base, files, untracked, insertions, deletions, stat, diffPath, truncated);
}

/**
 * Wrap a captured change so an agent can be handed it directly.
 *
 * Pure formatting over an already-captured ChangeSet — no `run`, no git
 * call. `commit` is always a full sha here, so it's shortened the same way
 * `BaseRef.label` shortens a pinned ref: a slice, not another subprocess.
 */
export function asEnvelope(changes: ChangeSet, notes: string = ""): ChangesOutputT {
  const total = changes.files.length + changes.untracked.length;
  return v.parse(ChangesOutput.schema, {
    status: "success",
    summary: `${total} file(s) changed since ${changes.base.label} (+${changes.insertions} -${changes.deletions})`,
    artifacts: [changes.diff_path],
    notes_for_next_agent: notes,
    base: `${changes.base.label} @ ${changes.base.commit.slice(0, 7)} — ${changes.base.reason}`,
    changed_files: [...changes.files, ...changes.untracked],
    insertions: changes.insertions,
    deletions: changes.deletions,
    stat: changes.stat,
    diff_path: changes.diff_path,
  });
}
