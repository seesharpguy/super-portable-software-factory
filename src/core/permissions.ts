/**
 * What an agent may CHANGE, enforced in code after the fact.
 *
 * `tools:` is a capability list, not a sandbox, and two holes make it
 * unenforceable on its own:
 *
 *   * `bash` runs anything. A builder handed bash to run a test suite can also
 *     run `git checkout adws/` — which is not hypothetical: one did, discarding
 *     uncommitted changes to the very quality check it was about to be judged by.
 *   * `write` reaches any path, not just the one report file an agent was given
 *     it for. A reviewer configured with "no edit, so it cannot quietly fix"
 *     could still rewrite the code it was reviewing.
 *
 * So permission is verified the way every other claim in this system is —
 * after the fact, against the repo itself. `snapshot()` fingerprints the working
 * tree's change-set before an agent runs; `enforce()` compares it afterwards and
 * fails the phase if the agent touched anything outside its allowlist.
 *
 * Comparing change-sets, rather than watching for writes, is what catches the
 * `git checkout` case: a path that was modified before the agent ran and is clean
 * afterwards has been reverted, and a reversion is a modification. Appearing,
 * disappearing, and changing all count.
 *
 * A breach is NOT a gate violation. Gates are for work an agent can be asked to
 * redo; a breach cannot be corrected by re-prompting, because the write already
 * happened. It aborts the phase and names every offending path.
 *
 * Two keys drive it, both in spf.config.yaml:
 *     defaults.protected_files   paths no agent may touch unless it names them itself
 *     agents[].writes      undefined = unrestricted · [] = read-only · [...] = only these
 */

import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import path from "node:path";
import type { AgentConfig, SFConfig } from "./data_types.ts";

export class PermissionBreach extends Error {}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return result.status === 0 ? result.stdout : "";
}

interface RunLike {
  repo_root: string;
  cfg: SFConfig;
}

/**
 * Fingerprint every path the working tree currently differs on.
 *
 * Tracked files carry their numstat counts, so an edit to an already-dirty
 * file still registers as a change. Untracked files are listed by name.
 * Gitignored paths never appear, which is why the session runtime under
 * `data_dir` — where handoff files legitimately land — needs no special case.
 */
export function snapshot(run: RunLike): Record<string, string> {
  const fingerprints: Record<string, string> = {};
  for (const line of git(["diff", "HEAD", "--numstat"], run.repo_root).split("\n")) {
    const fields = line.split("\t");
    if (fields.length >= 3) {
      const p = fields[fields.length - 1].trim();
      fingerprints[p] = `${fields[0]},${fields[1]}`;
    }
  }
  for (const p of git(["ls-files", "--others", "--exclude-standard"], run.repo_root).split("\n")) {
    if (p.trim()) fingerprints[p.trim()] = "untracked";
  }
  return fingerprints;
}

/** Every path whose state differs — appeared, vanished, or was rewritten. */
export function changedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
  const all = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...all].filter((p) => before[p] !== after[p]).sort();
}

/**
 * Translate a pattern, with `*` stopping at a path separator.
 *
 * A naive glob-to-regex would let `*` cross `/`, which quietly widens every
 * pattern: `adws/adw_*.ts` would match `adws/adw_data/sessions/x/y.ts` as well
 * as the ADW scripts it means. `**` is the way to say "cross directories".
 */
function globToRegex(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (char === "*") {
      out += "[^/]*";
      i += 1;
    } else if (char === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

function matches(p: string, pattern: string): boolean {
  if (pattern.endsWith("/")) return p.startsWith(pattern); // directory prefix
  if (pattern.includes("*") || pattern.includes("?")) return globToRegex(pattern).test(p);
  return p === pattern;
}

/**
 * The session runtime, which EVERY agent must be able to write.
 *
 * `context_handoff/` is the one place agents hand work to each other, and an
 * agent's own prompts, raw_output.jsonl, and envelope.json land beside it.
 * Scout writes its findings there, the reviewer its review, the planner its
 * plan — a read-only agent is read-only with respect to the REPO, never with
 * respect to its own report.
 *
 * This is granted from `data_dir` rather than left to .gitignore. The runtime
 * is normally ignored, so it never even appears in a snapshot — but an agent's
 * ability to record its work must not hang on a gitignore entry that someone
 * can delete or that a changed `data_dir` can outgrow.
 */
export function alwaysWritable(cfg: SFConfig): string[] {
  return [cfg.defaults.data_dir.replace(/\/+$/, "") + "/"];
}

/** Session runtime first, then the agent's own list, then what is protected. */
export function permitted(p: string, agent: AgentConfig, cfg: SFConfig): boolean {
  if (alwaysWritable(cfg).some((pattern) => matches(p, pattern))) return true;
  if ((agent.writes || []).some((pattern) => matches(p, pattern))) return true; // naming a path is what unlocks a protected one
  if (cfg.defaults.protected_files.some((pattern) => matches(p, pattern))) return false;
  return agent.writes === undefined || agent.writes === null; // unrestricted = undefined/null, [] = no repo writes
}

/**
 * Undo one unauthorized change. Returns a word describing what happened.
 *
 * Only changes the agent INTRODUCED are undone. A path that was already dirty
 * when the agent started is left exactly as it is: the operator had
 * uncommitted work there, and discarding it to tidy up would be the same harm
 * this module exists to prevent, committed by the cleanup instead of the agent.
 */
function rollBack(
  run: RunLike,
  p: string,
  before: Record<string, string>,
  after: Record<string, string>,
): string {
  if (p in before) {
    // Already dirty beforehand. If it is gone from the diff now, the agent
    // reverted an engineer's uncommitted work and the content is not ours
    // to reconstruct — say so loudly rather than pretend it was handled.
    return !(p in after)
      ? "REVERTED-BY-AGENT (uncommitted work lost, cannot restore)"
      : "left as-is (was already modified)";
  }
  if (after[p] === "untracked") {
    try {
      unlinkSync(path.join(run.repo_root, p));
      return "deleted";
    } catch (error) {
      return `could not delete (${(error as Error).message})`;
    }
  }
  const result = spawnSync("git", ["checkout", "--", p], { cwd: run.repo_root, encoding: "utf-8" });
  return result.status === 0 ? "rolled back" : "could not roll back";
}

/**
 * Compare the tree against `before`; undo and raise if the agent overstepped.
 *
 * Returns the paths it legitimately changed, so the trace records what an
 * agent actually touched rather than only what it claimed in its envelope.
 *
 * Detection alone would leave the repo holding the unauthorized change while
 * reporting a failure, so anything the agent introduced outside its allowlist
 * is rolled back before the phase dies. What it cannot undo, it names.
 */
export function enforce(
  run: RunLike,
  _phase: unknown,
  agent: AgentConfig,
  before: Record<string, string>,
): string[] {
  const after = snapshot(run);
  const touched = changedPaths(before, after);
  const breaches = touched.filter((p) => !permitted(p, agent, run.cfg));
  if (breaches.length === 0) return touched;

  const outcomes = new Map(breaches.map((p) => [p, rollBack(run, p, before, after)]));
  const scope =
    agent.writes && agent.writes.length === 0
      ? "read-only"
      : agent.writes
        ? `limited to ${JSON.stringify(agent.writes)}`
        : `barred from ${JSON.stringify(run.cfg.defaults.protected_files)}`;
  const detail = [...outcomes.entries()].map(([p, outcome]) => `  - ${p} — ${outcome}`).join("\n");
  throw new PermissionBreach(
    `${agent.name} is ${scope} but modified ${breaches.length} path(s):\n${detail}`,
  );
}
