/**
 * Validation gates: verify the envelope's CLAIMS, never guesses.
 *
 * A gate is `gate(envelope, run) -> GateReport` — one check per item it looked at.
 * Violations are derived from the failed checks and sent back to the SAME agent
 * session as a correction. Every check is recorded either way, so a green gate
 * says WHAT it verified instead of only that it passed.
 *
 * Gates check what is mechanically checkable; plan quality is a reviewer's job.
 *
 * An envelope's artifact/file paths are the AGENT's claims, and the agent runs
 * with `run.repo_root` as its cwd — so a relative claim is resolved against
 * that root, never against this process's own cwd. A claim that resolves
 * outside the repo entirely is reported as a violation rather than silently
 * stat'd (or not found) somewhere unexpected.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { GateReport, type EnvelopeBase, type GateFn, type RefinedIssue, type RunContext } from "./data_types.ts";
import { operatorEnv } from "./utils.ts";

const TAIL_CHARS = 1000; // command output kept as evidence on a failure

/**
 * Anchor an envelope-declared path to `run.repo_root`. Absolute paths pass
 * through unchanged (an agent that reports an absolute path meant exactly
 * that path). Returns `null` when the resolved path escapes the repo — a
 * gate should report that as a violation, not silently check outside it.
 */
function resolveClaim(p: string, run: RunContext): string | null {
  const resolved = path.isAbsolute(p) ? p : path.resolve(run.repo_root, p);
  const rel = path.relative(run.repo_root, resolved);
  if (rel === "..") return null;
  if (rel.startsWith(`..${path.sep}`)) return null;
  return resolved;
}

function size(p: string): string {
  const n = statSync(p).size;
  return n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`;
}

export function artifactsExist(envelope: EnvelopeBase, run: RunContext): GateReport {
  const report = new GateReport();
  for (const a of envelope.artifacts) {
    const resolved = resolveClaim(a, run);
    if (resolved === null) {
      report.check(a, false, `declared artifact resolves outside the repo (${run.repo_root})`);
      continue;
    }
    const exists = existsSync(resolved);
    report.check(a, exists, exists ? `exists, ${size(resolved)}` : "declared artifact does not exist");
  }
  return report;
}

export function filesNonEmpty(envelope: EnvelopeBase, run: RunContext): GateReport {
  const report = new GateReport();
  for (const a of envelope.artifacts) {
    const resolved = resolveClaim(a, run);
    if (resolved === null) continue; // artifactsExist's job to report the escape
    if (!existsSync(resolved) || !statSync(resolved).isFile()) continue; // existence is artifactsExist's job
    const empty = statSync(resolved).size === 0;
    report.check(a, !empty, empty ? "declared artifact is empty" : size(resolved));
  }
  return report;
}

export function jsonParses(envelope: EnvelopeBase, run: RunContext): GateReport {
  const report = new GateReport();
  for (const a of envelope.artifacts) {
    if (!a.endsWith(".json")) continue;
    const resolved = resolveClaim(a, run);
    if (resolved === null || !existsSync(resolved)) continue;
    try {
      const parsed = JSON.parse(readFileSync(resolved, "utf-8"));
      const kind = Array.isArray(parsed) ? "list" : typeof parsed === "object" && parsed !== null ? "dict" : typeof parsed;
      report.check(a, true, `parses, ${kind}`);
    } catch (error) {
      report.check(a, false, `declared JSON artifact does not parse: ${(error as Error).message}`);
    }
  }
  return report;
}

/** Every file claimed changed must exist on disk. */
export function diffMatchesClaims(envelope: EnvelopeBase, run: RunContext): GateReport {
  const report = new GateReport();
  const changedFiles = ((envelope as any).changed_files as string[] | undefined) ?? [];
  for (const f of changedFiles) {
    const resolved = resolveClaim(f, run);
    if (resolved === null) {
      report.check(f, false, `claimed changed file resolves outside the repo (${run.repo_root})`);
      continue;
    }
    const exists = existsSync(resolved);
    report.check(f, exists, exists ? `exists, ${size(resolved)}` : "claimed changed file does not exist");
  }
  return report;
}

/**
 * A review's verdict must agree with the findings it just wrote down.
 *
 * Nothing here judges the code — that is the reviewer's job. This checks the
 * envelope against itself: an approval that ships blocking items, or a
 * rejection that names no problem, is a claim the harness can refute without
 * reading a line of the diff.
 */
export function verdictConsistent(envelope: EnvelopeBase, _run: RunContext): GateReport {
  const report = new GateReport();
  const approved = Boolean((envelope as any).approved ?? false);
  const blocking = ((envelope as any).blocking as string[] | undefined) ?? [];
  const findings = ((envelope as any).findings as Array<{ met: boolean; requirement: string }> | undefined) ?? [];
  const unmet = findings.filter((f) => !f.met).map((f) => f.requirement);

  report.check(
    "approved vs blocking",
    !(approved && blocking.length > 0),
    blocking.length === 0
      ? "no blocking items"
      : approved
        ? `${blocking.length} blocking item(s) while approved=true`
        : `${blocking.length} blocking item(s), not approved`,
  );
  report.check(
    "approved vs findings",
    !(approved && unmet.length > 0),
    unmet.length === 0
      ? "every requirement met"
      : approved
        ? `${unmet.length} unmet requirement(s) while approved=true`
        : `${unmet.length} unmet requirement(s), not approved`,
  );
  report.check(
    "rejection names a problem",
    approved || blocking.length > 0 || unmet.length > 0,
    approved || blocking.length > 0 || unmet.length > 0
      ? "verdict is supported"
      : "approved=false but no blocking item or unmet requirement was given",
  );
  return report;
}

const CONTAINER_KINDS = new Set(["epic", "feature"]);
const LEAF_KINDS = new Set(["story", "bug", "task"]);

/**
 * The gate that turns `to-tickets`' flat, untyped ticket list into an
 * actually-enforced feature/story-or-bug tree — see `RefinedIssueSchema`'s
 * doc comment in `data_types.ts`. Checks the envelope's `issues` list
 * against itself, never anything already published: `core/refine.ts` never
 * gets a chance to publish a malformed tree in the first place, because a
 * violation here re-prompts the SAME refiner session before `steps.refine()`
 * ever hands off to `steps.publishIssues()`.
 *
 * "Container" and "leaf" are derived from the graph, not asserted by the
 * agent: a node is a container iff some other node names it as `parent`.
 */
export function refinementWellFormed(envelope: EnvelopeBase, _run: RunContext): GateReport {
  const report = new GateReport();
  const issues = ((envelope as any).issues as RefinedIssue[] | undefined) ?? [];

  if (issues.length === 0) {
    report.check("issues", false, "a refinement produced no issues at all — decompose the spec into at least one leaf");
    return report;
  }

  const byKey = new Map<string, RefinedIssue>();
  for (const issue of issues) {
    if (byKey.has(issue.key)) {
      report.check(`key ${JSON.stringify(issue.key)}`, false, "duplicate key — every node needs a unique key within this refinement");
    } else {
      byKey.set(issue.key, issue);
    }
  }

  const childKeys = new Set<string>(); // keys named as some OTHER node's parent -> that node is a container
  for (const issue of issues) {
    if (!issue.parent) continue;
    if (!byKey.has(issue.parent)) {
      report.check(`${issue.key}.parent`, false, `parent ${JSON.stringify(issue.parent)} does not match any issue's key`);
      continue;
    }
    childKeys.add(issue.parent);
  }
  for (const issue of issues) {
    for (const blocker of issue.blocked_by) {
      if (!byKey.has(blocker)) {
        report.check(`${issue.key}.blocked_by`, false, `blocked_by ${JSON.stringify(blocker)} does not match any issue's key`);
      }
    }
  }

  // Cycle check over the union of parent + blocked_by edges — both mean
  // "must exist before this node" from core/refine.ts's own topological
  // publish order, so a cycle in either (or across both) would hang it.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  let cyclic = false;
  const edgesFrom = (key: string): string[] => {
    const issue = byKey.get(key);
    if (!issue) return [];
    const out: string[] = [];
    if (issue.parent && byKey.has(issue.parent)) out.push(issue.parent);
    for (const b of issue.blocked_by) if (byKey.has(b)) out.push(b);
    return out;
  };
  const visit = (key: string): void => {
    if (cyclic) return;
    color.set(key, GRAY);
    for (const next of edgesFrom(key)) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        cyclic = true;
        return;
      }
      if (c === WHITE) visit(next);
    }
    color.set(key, BLACK);
  };
  for (const issue of issues) {
    if ((color.get(issue.key) ?? WHITE) === WHITE) visit(issue.key);
  }
  report.check("dependency graph", !cyclic, cyclic ? "parent/blocked_by edges form a cycle — nothing to publish first" : "acyclic");

  for (const issue of issues) {
    const isContainer = childKeys.has(issue.key);
    if (isContainer && !CONTAINER_KINDS.has(issue.kind)) {
      report.check(`${issue.key}.kind`, false, `has children but kind is ${JSON.stringify(issue.kind)} — a container must be "epic" or "feature"`);
    } else if (!isContainer && !LEAF_KINDS.has(issue.kind)) {
      report.check(`${issue.key}.kind`, false, `has no children but kind is ${JSON.stringify(issue.kind)} — a leaf must be "story", "bug", or "task"`);
    } else {
      report.check(`${issue.key}.kind`, true, isContainer ? "container" : "leaf");
    }
  }

  const leafCount = issues.filter((i) => !childKeys.has(i.key)).length;
  report.check(
    "has leaves",
    leafCount > 0,
    leafCount > 0 ? `${leafCount} leaf issue(s)` : "every node is a container — nothing here is independently workable",
  );

  return report;
}

/** Gate factory: the given shell command must exit 0, run from run.repo_root. */
export function testsPass(command: string): GateFn {
  const gate: GateFn = (_envelope, run) => {
    const result = spawnSync(command, { shell: true, encoding: "utf-8", cwd: run.repo_root, env: operatorEnv() });
    const ok = result.status === 0;
    let note = `exit ${result.status}`;
    if (!ok) {
      note += "\n" + ((result.stdout || "") + (result.stderr || "")).slice(-TAIL_CHARS);
    }
    return new GateReport().check(command, ok, note);
  };
  Object.defineProperty(gate, "name", { value: `tests_pass(${command})` });
  return gate;
}
