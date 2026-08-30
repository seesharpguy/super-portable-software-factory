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
import {
  DEFAULT_REFINE_MAX_DEPTH,
  DEFAULT_REFINE_MAX_LEAVES,
  DEFAULT_REFINE_MAX_NODES,
  GateReport,
  PRIORITY_RANK,
  type EnvelopeBase,
  type GateFn,
  type RefinedIssue,
  type RefineQuestion,
  type RunContext,
  type SpecSplit,
} from "./data_types.ts";
import { operatorEnv } from "./utils.ts";

const TAIL_CHARS = 1000; // command output kept as evidence on a failure
const MIN_OUTCOME_CHARS = 20; // shortest string that can still be the sentence RefinedIssue.user_outcome asks for

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
 * The decomposition budget in force for this run: `watch.refine`'s
 * configured ceilings, or the packaged defaults when the caller handed us no
 * `cfg` (see `RunContext.cfg`). Its own function, and exported, so `spf
 * doctor` can print the three numbers this gate enforces by calling the SAME
 * resolution the gate uses, rather than a second reading of the config that
 * can drift from it — the `clampPriority` pattern.
 */
export interface RefineBudget {
  maxLeaves: number;
  maxNodes: number;
  maxDepth: number;
}

export function refineBudget(run: RunContext): RefineBudget {
  const refine = run.cfg?.watch.refine;
  return {
    maxLeaves: refine?.max_leaves ?? DEFAULT_REFINE_MAX_LEAVES,
    maxNodes: refine?.max_nodes ?? DEFAULT_REFINE_MAX_NODES,
    maxDepth: refine?.max_depth ?? DEFAULT_REFINE_MAX_DEPTH,
  };
}

/**
 * How many containment levels deep `key` sits: a top-level node is 1, a node
 * under a top-level container is 2. Bounded by a `seen` set — the cycle
 * check earlier in this gate already reports a `parent` cycle as its own
 * violation, so this just has to not hang on one, not detect it again.
 */
function containmentDepth(key: string, byKey: Map<string, RefinedIssue>): number {
  let depth = 1;
  const seen = new Set<string>([key]);
  let current = byKey.get(key);
  while (current?.parent) {
    const parent = byKey.get(current.parent);
    if (!parent || seen.has(parent.key)) break;
    seen.add(parent.key);
    depth += 1;
    current = parent;
  }
  return depth;
}

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
 *
 * `issues` / `questions` / `split` (see `RefineQuestionSchema`'s and
 * `SpecSplitSchema`'s doc comments) are three mutually exclusive ways this
 * round can end: an unambiguous tree, material ambiguity to escalate, or a
 * spec too large for one decomposition. A refinement that raises questions
 * or proposes a split must publish NOTHING this round — a partial tree
 * pinned to either is worse than none. When `questions` or `split` is
 * non-empty this gate checks only that shape (never both at once, and never
 * alongside `issues`) and skips every `issues` rule below, since there is no
 * tree to validate.
 */
export function refinementWellFormed(envelope: EnvelopeBase, run: RunContext): GateReport {
  const report = new GateReport();
  const issues = ((envelope as any).issues as RefinedIssue[] | undefined) ?? [];
  const questions = ((envelope as any).questions as RefineQuestion[] | undefined) ?? [];
  const split = ((envelope as any).split as SpecSplit[] | undefined) ?? [];

  if (questions.length > 0 || split.length > 0) {
    report.check(
      "issues empty while escalating",
      issues.length === 0,
      issues.length === 0
        ? "no issues published alongside the escalation"
        : `${issues.length} issue(s) published alongside ${questions.length} question(s)/${split.length} split proposal(s) — escalating means publishing nothing this round`,
    );
    report.check(
      "questions xor split",
      !(questions.length > 0 && split.length > 0),
      questions.length > 0 && split.length > 0
        ? "both questions and split are non-empty — ambiguity (questions) and size (split) are different problems, escalate one at a time"
        : "exactly one escalation shape used",
    );
    if (split.length > 0) {
      report.check(
        "split has at least 2 entries",
        split.length >= 2,
        split.length >= 2
          ? `${split.length} proposed specs`
          : "a split into 1 entry is not a split — it's the same spec renamed. Either propose 2+ standalone specs, or this spec fits after all: emit issues instead",
      );
      split.forEach((s, i) => {
        report.check(`split[${i}].title`, s.title.trim().length > 0, s.title.trim().length > 0 ? "has text" : "blank title");
        report.check(`split[${i}].body`, s.body.trim().length > 0, s.body.trim().length > 0 ? "has text" : "blank body — each proposed spec needs its own complete problem/outcome/scope");
        report.check(
          `split[${i}].rationale`,
          s.rationale.trim().length > 0,
          s.rationale.trim().length > 0 ? "has text" : "blank rationale — say why this is a coherent standalone spec and roughly how many leaves you expect it to decompose into",
        );
      });
    } else {
      const seenIds = new Set<string>();
      for (const q of questions) {
        const blank = !q.id.trim();
        const dup = !blank && seenIds.has(q.id);
        seenIds.add(q.id);
        report.check(
          `question ${JSON.stringify(q.id)}`,
          !blank && !dup,
          blank ? "question id is blank" : dup ? "duplicate question id — every question needs a unique id within this round" : "id ok",
        );
        report.check(`question ${JSON.stringify(q.id)}.question`, q.question.trim().length > 0, q.question.trim().length > 0 ? "has text" : "question text is blank");
      }
    }
    return report;
  }

  if (issues.length === 0) {
    report.check("issues", false, "a refinement produced no issues at all and raised no questions or split — decompose the spec into at least one leaf, escalate what's ambiguous, or propose a split if it's too large");
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
  const childCount = new Map<string, number>(); // and HOW MANY name it — a container of exactly 1 is a violation below
  for (const issue of issues) {
    if (!issue.parent) continue;
    if (!byKey.has(issue.parent)) {
      report.check(`${issue.key}.parent`, false, `parent ${JSON.stringify(issue.parent)} does not match any issue's key`);
      continue;
    }
    childKeys.add(issue.parent);
    childCount.set(issue.parent, (childCount.get(issue.parent) ?? 0) + 1);
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

  // ── the decomposition budget ────────────────────────────────────────────
  //
  // The first CARDINALITY rules this gate has ever had, and the reason they
  // are gate rules rather than one more paragraph of prompt: a prompt-only
  // version was tried (c9a4471, "tests are not their own leaf") and the model
  // kept the ticket and renamed it around the banned noun. A count is not a
  // noun — there is nothing to rename.
  //
  // BOTH MESSAGES NAME THE ESCALATION BRANCH EXPLICITLY, and that is
  // load-bearing rather than decorative. `core/agents.ts`'s correction prompt
  // is generic ("Your previous response failed validation: ... Fix these
  // problems, then re-emit ONLY your Report JSON"), so a violation's own
  // `note` is the ONLY channel through which the refiner learns that
  // proposing a `split` is a legal way out. Without that sentence, the
  // correction round `steps.refine()`'s `retries` buys gets spent producing a
  // smaller WRONG tree instead of a split proposal.
  //
  // The leaf message also forecloses the other cheap escape: satisfying a
  // leaf cap by MERGING unrelated slices into a few oversized ones. That
  // passes every check here and violates the one rule no gate can measure
  // ("sized to fit what a reviewer can hold in their head" —
  // assets/prompts/refiner/system.md). Saying so is the only lever available.
  const budget = refineBudget(run);
  report.check(
    "leaf budget",
    leafCount <= budget.maxLeaves,
    leafCount <= budget.maxLeaves
      ? `${leafCount} leaf/leaves, within the budget of ${budget.maxLeaves}`
      : `${leafCount} leaves exceeds the budget of ${budget.maxLeaves}. Every leaf becomes its own branch, its own build run and its own pull request a person reads, so this spec as decomposed costs ${leafCount} human reviews. Take exactly one of two paths: (1) re-emit a tree of at most ${budget.maxLeaves} leaves, dropping slices that are process rather than product and combining slices that are genuinely one vertical slice — do NOT merge unrelated slices to hit the number, an oversized leaf is a worse outcome than a large tree; or (2) if this spec honestly cannot be built in ${budget.maxLeaves} slices, publish NOTHING: emit an empty "issues" and a "split" entry proposing 2 or more standalone specs to cut it into, each with your expected leaf count.`,
  );
  report.check(
    "node budget",
    issues.length <= budget.maxNodes,
    issues.length <= budget.maxNodes
      ? `${issues.length} node(s), within the budget of ${budget.maxNodes}`
      : `${issues.length} nodes exceeds the budget of ${budget.maxNodes} — drop containers that only group, or publish nothing and propose a "split" into separate specs instead`,
  );

  // ── no singleton container ──────────────────────────────────────────────
  //
  // A container with exactly one child buys nothing and costs twice: a
  // second tracker issue to create, link, label and roll up, and a second
  // place the same acceptance criteria are written down. A container's only
  // job is to GROUP (see `assets/prompts/refiner/system.md`'s "The tree"),
  // and one child is nothing to group. It is also the cheapest way an
  // over-decomposed tree pads its node count, which is why this sits beside
  // the budget rather than with the kind checks above.
  for (const issue of issues) {
    const children = childCount.get(issue.key) ?? 0;
    if (children === 0) continue; // a leaf — not this check's business
    report.check(
      `${issue.key}.children`,
      children >= 2,
      children >= 2
        ? `${children} children`
        : `container has exactly 1 child — a container exists only to group, and one child is nothing to group. Delete ${JSON.stringify(issue.key)} and re-parent its child to ${issue.parent ? JSON.stringify(issue.parent) : `top level (parent "")`}, folding anything ${JSON.stringify(issue.key)} said into the child's own body`,
    );
  }

  // ── depth cap ───────────────────────────────────────────────────────────
  //
  // Two levels by default: one top-level container, and the leaves directly
  // under it. Deeper nesting is exactly how "6 features and 14 stories" gets
  // built — an epic over features over stories READS as organization and
  // COSTS three tiers of tracker issue for one spec.
  //
  // It is also a live bug fix for the Jira provider, not only a scoping rule.
  // `jira.issue_types` maps both `epic` and `feature` to Jira's Epic type by
  // default, and Jira has no Epic-under-Epic nesting (see
  // `core/issues/jira_provider.ts`'s accepted-limitation note) — so a
  // `feature` parented under an `epic`/`feature` reaches `linkChild` and
  // returns a raw Atlassian API error PARTWAY THROUGH a publish that is
  // deliberately not transactional, leaving whatever was already created
  // stranded on the board. At the default `max_depth: 2`, that tree is now
  // refused before a single issue is created. See `WatchRefineConfigSchema`
  // for why raising this above 2 is unsafe on Jira specifically.
  for (const issue of issues) {
    const depth = containmentDepth(issue.key, byKey);
    report.check(
      `${issue.key}.depth`,
      depth <= budget.maxDepth,
      depth <= budget.maxDepth
        ? `level ${depth} of ${budget.maxDepth}`
        : `nested ${depth} levels deep, past the limit of ${budget.maxDepth} — the shape is one top-level container with its leaves directly under it, not an epic over features over stories. Re-parent ${JSON.stringify(issue.key)} onto a top-level container, or delete the intermediate container entirely`,
    );
  }

  // ── every leaf states a user-observable outcome ─────────────────────────
  //
  // A required SLOT, not a banned-word list. A leaf must say in one sentence
  // what someone can do once it lands that they could not before — see
  // `RefinedIssueSchema.user_outcome`. "Cross-browser testing" has no such
  // sentence that isn't obviously a restatement of a slice that already
  // exists, and a model made to write one tends to notice that itself. A word
  // list only renames the ticket (c9a4471); an empty slot has nowhere to
  // hide.
  //
  // This is a BACKSTOP TO THE BUDGET, not a substitute for it: a determined
  // model CAN write a plausible outcome for a process leaf ("an on-call
  // engineer can revert in under 5 minutes"). What actually kills a process
  // leaf is that it must beat a real product slice for one of `maxLeaves`
  // slots. If process leaves reappear despite this check, lower the budget —
  // do not add words to a list.
  //
  // Checked on LEAVES only (a container's outcome is the union of its
  // children's) and for SHAPE only — non-blank, long enough to be a sentence,
  // not the title again. Whether the sentence is TRUE is a reviewer's
  // judgment, not a mechanical fact, and a gate that tried to grade it would
  // be the word list under another name.
  for (const issue of issues) {
    if (childKeys.has(issue.key)) continue;
    const outcome = issue.user_outcome.trim();
    const blank = outcome.length === 0;
    const tooShort = !blank && outcome.length < MIN_OUTCOME_CHARS;
    const echoesTitle = !blank && outcome.toLowerCase() === issue.title.trim().toLowerCase();
    report.check(
      `${issue.key}.user_outcome`,
      !blank && !tooShort && !echoesTitle,
      blank
        ? `blank — every leaf must state, in ONE sentence, what someone can do once it lands that they could not before (e.g. "A workspace owner can invite a teammate by email and see the invite listed as pending."). A slice with no such sentence is process, not product: fold it into the slice whose behavior it actually serves, or drop it`
        : tooShort
          ? `${JSON.stringify(outcome)} is too short to be that sentence — name who, and what they can now do`
          : echoesTitle
            ? `repeats the title verbatim — the title NAMES the slice; this sentence says what changes for a person once it lands`
            : "states a user-observable outcome",
    );
  }

  // Monotonicity: no node may be MORE urgent than its own parent — p0 < p1 <
  // p2 < p3, so "more urgent" is a lower rank. Only checked against `parent`
  // (the containment edge), never `blocked_by` (a real dependency can easily
  // be less urgent than the thing it blocks — a p3 prefactor gating a p0
  // feature is normal, not a mistake). A violation here is a decomposition
  // mistake worth a correction round-trip (this gate's `retries: 1` —
  // steps.ts's `refine()`), not a hard block: a p0 story wearing a p3
  // feature's parent almost always means the feature was mis-scored, not the
  // story. The spec's OWN priority ceiling is enforced separately, in
  // `core/refine.ts`'s `publish()` — this gate only knows about the tree,
  // never the spec issue it came from.
  for (const issue of issues) {
    if (!issue.parent) continue;
    const parent = byKey.get(issue.parent);
    if (!parent) continue; // already reported above as an unresolved parent
    const childRank = PRIORITY_RANK[issue.priority] ?? 2;
    const parentRank = PRIORITY_RANK[parent.priority] ?? 2;
    report.check(
      `${issue.key}.priority`,
      childRank >= parentRank,
      childRank >= parentRank
        ? `${issue.priority} — no more urgent than parent ${JSON.stringify(issue.parent)} (${parent.priority})`
        : `${issue.priority} is more urgent than parent ${JSON.stringify(issue.parent)}'s ${parent.priority} — a container's priority is a ceiling for everything under it`,
    );
  }

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
