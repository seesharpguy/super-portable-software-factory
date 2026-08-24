/**
 * Publish logic for the refine lane: turn a gated `RefineOutput.issues` list
 * (a product spec decomposed into a feature/story tree — see
 * `RefinedIssueSchema` in `data_types.ts`) into real tracker issues, in
 * dependency order, with the right labels and parent/child links. Nothing
 * else: no marker bookkeeping, no `transition()`, no comment posted back
 * onto the spec issue. Those are watch-lifecycle concerns `core/watch.ts`'s
 * `runSpec` owns, exactly the way `runIssue` (the build lane) owns
 * `openPr`/`transition` rather than a chain step doing it — this file is
 * "given issues and a tracker, create them correctly," the one part
 * `to-tickets` (the skill this lane's prompt is ported from) leaves
 * entirely unspecified, and the part that makes a re-run duplicate every
 * ticket (see `WatchMarker.refined`'s doc comment in `provider.ts` for how
 * `runSpec` closes that gap using what this module returns).
 */
import { GitHubProvider } from "./issues/github_provider.ts";
import type { Issue, IssueAuthoringProvider } from "./issues/provider.ts";
import { clampPriority, type RefinedIssue, type RefinedPriority, type SFConfig } from "./data_types.ts";

export interface PublishedIssue {
  /** The `RefinedIssue.key` this came from — a run-local id, never a tracker id. */
  key: string;
  issue: Issue;
  kind: RefinedIssue["kind"];
  /** A node nothing else names as `parent` — the independently-workable unit `spf:refined` goes on. */
  isLeaf: boolean;
}

/**
 * `IssueAuthoringProvider` has a real implementation only on `GitHubProvider`
 * today — see `jira_provider.ts`'s module comment on why Jira isn't wired up
 * yet. Throws rather than returning `null` so a `code` phase calling this
 * (`steps.publishIssues()`) fails the phase with a clear, specific reason —
 * the same "fail loudly, never silently do nothing" contract
 * `agents.validate()` uses for an unconfigured quality suite.
 */
export function resolveAuthoringProvider(cfg: SFConfig): IssueAuthoringProvider {
  if (cfg.watch.issue_provider !== "github") {
    throw new Error(
      `watch.issue_provider ${JSON.stringify(cfg.watch.issue_provider)} does not support issue authoring — ` +
        `the refine lane needs "github" (see jira_provider.ts's module comment on why Jira isn't wired up yet)`,
    );
  }
  // Issue authoring always targets the ISSUE tracker's repo — `issue_repo`
  // if set, falling back to plain `repo` (the common case: issue_provider
  // and code_host are both github, so they're the same repo). Reading
  // `repo` alone would be wrong for a github-issues + bitbucket-code setup,
  // where `repo` names the BITBUCKET repo (see WatchConfigSchema's doc
  // comment) — this would try to create GitHub issues against a Bitbucket
  // identifier.
  const repo = cfg.watch.issue_repo.trim() || cfg.watch.repo.trim();
  if (!repo) {
    throw new Error(`watch.repo (or watch.issue_repo, if code_host names a different repo) is not configured — add it to spf.config.yaml's watch: section, e.g. "owner/name"`);
  }
  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN is not set — the refine lane needs a classic PAT with "repo" scope (or "public_repo" for a public-only repo)',
    );
  }
  return new GitHubProvider(repo, cfg.watch.label_prefix, token);
}

function typeLabel(labelPrefix: string, kind: string): string {
  return `${labelPrefix}:type:${kind}`;
}

/** `spf:priority:p0..p3` — see `RefinedPrioritySchema`'s doc comment for what each rung means. Mirrors `typeLabel` above, and `github_provider.ts`'s own private `priorityLabel()` method (used by `ensureLabels()` to seed these) — the two aren't unified for the same reason `typeLabel` isn't: this file stays provider-agnostic, building label strings by convention rather than reaching into a concrete `GitHubProvider`. */
function priorityLabel(labelPrefix: string, priority: RefinedPriority): string {
  return `${labelPrefix}:priority:${priority}`;
}

/**
 * Sentinel distinct from `github_provider.ts`'s `MARKER_RE` on purpose: that
 * one matches a hidden comment (`spf watch`'s own scratch state — worktree,
 * branch, PR number); this one matches a hidden block INSIDE the issue BODY
 * this file renders — the graph `spf watch`'s build lane needs to schedule
 * correctly (`parent`, `blocked_by`, `priority`) but that gets lost once
 * `blocked_by` is flattened to the human-readable `## Blocked by` prose
 * below. The two live in different places on the issue and are read by
 * different code (`readMarker`'s comment scan vs. a plain `Issue.body`
 * parse), so a single tracker `GET` — which already returns the body — is
 * all `claimNewWork`'s ordering needs, no per-issue marker-comment fetch.
 */
const REFINE_MARKER_RE = /<!--\s*spf-refine:\s*(\{.*?\})\s*-->/s;

/** What `parseRefineMarker` returns absent (or on a malformed/hand-edited) marker — exactly today's pre-priority, pre-frontier behavior: no parent, no blockers, the default priority. */
const NO_REFINE_MARKER: RefineMarker = { parent: null, blocked_by: [], priority: "p2" };

export interface RefineMarker {
  /** The parent's real issue id, or `null` for a top-level node. */
  parent: string | null;
  /** Real issue ids — resolved from `blocked_by` `key`s at publish time, see `renderBody`. */
  blocked_by: string[];
  priority: RefinedPriority;
}

/**
 * Pure and exported so it's directly unit-testable without a provider —
 * `core/watch.ts`'s `claimNewWork` and `rollUp` are the real callers, reading
 * it straight out of the `Issue.body` a `listEligible`/`getIssue` call
 * already returned. Never throws: a body with no marker (any issue not
 * created by this lane, or one whose marker a human stripped while editing)
 * degrades to `NO_REFINE_MARKER`, same as malformed JSON inside one.
 */
export function parseRefineMarker(body: string): RefineMarker {
  const match = REFINE_MARKER_RE.exec(body);
  if (!match) return NO_REFINE_MARKER;
  try {
    const parsed = JSON.parse(match[1]);
    return {
      parent: typeof parsed.parent === "string" ? parsed.parent : null,
      blocked_by: Array.isArray(parsed.blocked_by) ? parsed.blocked_by.filter((b: unknown) => typeof b === "string") : [],
      priority: ["p0", "p1", "p2", "p3"].includes(parsed.priority) ? parsed.priority : "p2",
    };
  } catch {
    return NO_REFINE_MARKER; // malformed marker JSON — tolerate it, same policy as github_provider.ts's own findMarkerComment
  }
}

/**
 * The body GitHub actually stores: the refiner's own `## What to build` /
 * `## Acceptance criteria` text, plus a `## Parent` back-reference to the
 * source spec (when there is one — a bare `spf refine` run with no
 * `--issue` has none), a `## Blocked by` section with real `#n` references
 * — `to-tickets`' own template shape, ported — and finally the hidden
 * `spf-refine:` marker `parseRefineMarker` reads back. Every `blocked_by`
 * key (and `node.parent`) is guaranteed to already be in `byKey` by the time
 * this runs: `topoOrder` visits a node's dependencies before the node itself.
 */
function renderBody(node: RefinedIssue, byKey: Map<string, PublishedIssue>, specIssueId: string | null | undefined): string {
  const parts = [node.body.trim()];
  if (specIssueId) parts.push(`## Parent\n\nDecomposed from #${specIssueId}.`);
  const blockedByIds = node.blocked_by.map((key) => {
    const published = byKey.get(key);
    // Defensive only: gates.refinementWellFormed already rejects a
    // blocked_by key that doesn't resolve to another node in the list.
    return published ? published.issue.id : key;
  });
  if (blockedByIds.length > 0) {
    parts.push(`## Blocked by\n\n${blockedByIds.map((id) => `- #${id}`).join("\n")}`);
  } else {
    parts.push(`## Blocked by\n\nNone (can start immediately).`);
  }
  const parentId = node.parent ? byKey.get(node.parent)?.issue.id ?? node.parent : null;
  const marker: RefineMarker = { parent: parentId, blocked_by: blockedByIds, priority: node.priority };
  parts.push(`<!-- spf-refine: ${JSON.stringify(marker)} -->`);
  return parts.join("\n\n");
}

/**
 * Order nodes so every `parent` and every `blocked_by` reference is already
 * published (a real issue, in `byKey`) before the node that names it —
 * required both for the sub-issue link (the parent must exist first) and
 * for `renderBody`'s `#n` references. `gates.refinementWellFormed` has
 * already rejected a cyclic input by the time `publish()` ever runs; the
 * `visiting` check here is a defensive backstop against a caller that
 * skipped the gate, not the primary line of defense.
 */
function topoOrder(issues: RefinedIssue[]): RefinedIssue[] {
  const byKey = new Map(issues.map((i) => [i.key, i]));
  const ordered: RefinedIssue[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  function visit(node: RefinedIssue): void {
    if (done.has(node.key)) return;
    if (visiting.has(node.key)) {
      throw new Error(`refine: dependency cycle detected at key ${JSON.stringify(node.key)} — gates.refinementWellFormed should have caught this before publish ran`);
    }
    visiting.add(node.key);
    for (const depKey of [node.parent, ...node.blocked_by]) {
      if (!depKey) continue;
      const dep = byKey.get(depKey);
      if (dep) visit(dep);
    }
    visiting.delete(node.key);
    done.add(node.key);
    ordered.push(node);
  }

  for (const issue of issues) visit(issue);
  return ordered;
}

export interface PublishOptions {
  labelPrefix: string;
  /** The originating spec issue's id, for every created issue's `## Parent` back-reference. `null`/omitted for a manual run with no source issue. */
  specIssueId?: string | null;
  /**
   * The spec's own priority (its `spf:priority:pN` label, read by
   * `core/watch.ts`'s `runSpec`, or `spf refine`'s `--priority` flag for a
   * bare manual run) — a CEILING, never a floor. Every node is clamped down
   * to this if it outranks it (`clampPriority`), so a p3 "someday" spec
   * cannot spawn p0 work that jumps the build lane's queue, regardless of
   * what the refiner's own per-node judgment (or the gate's monotonicity
   * check, which only sees the tree, never the spec) would otherwise allow.
   * `null`/omitted — a bare run with nothing to inherit from — is a no-op:
   * `clampPriority`'s own default.
   */
  priorityCeiling?: RefinedPriority | null;
}

/**
 * Create every node in `issues`, in dependency order, with its
 * `<prefix>:type:<kind>` and `<prefix>:priority:<pN>` labels (plus
 * `<prefix>:refined` on leaves only — see `WatchState`'s doc comment in
 * `provider.ts`), link each to its parent via the tracker's native
 * hierarchy, and render real `#n` references into `## Blocked by` plus the
 * hidden `spf-refine:` marker `parseRefineMarker` reads back. Returns what
 * it created, in creation order.
 *
 * Not transactional: if a create or link call throws partway through, the
 * nodes already published stay published, orphaned from whatever hadn't run
 * yet. No rollback is attempted — the gate already ran, so this only fails
 * on a live tracker error (rate limit, network), which a human re-running
 * the spec (once the marker's `refined` list explains what already exists)
 * can sort out same as any other `spf watch` failure.
 */
export async function publish(tracker: IssueAuthoringProvider, issues: RefinedIssue[], opts: PublishOptions): Promise<PublishedIssue[]> {
  const ordered = topoOrder(issues);
  const childKeys = new Set(issues.filter((i) => i.parent).map((i) => i.parent));
  const byKey = new Map<string, PublishedIssue>();
  const created: PublishedIssue[] = [];

  for (const rawNode of ordered) {
    // Clamp once, up front — every downstream use (the label AND the hidden
    // marker's own `priority`) must agree, or `claimNewWork`'s label-based
    // ordering and a human reading the marker would disagree about what this
    // issue's priority actually is.
    const priority = clampPriority(rawNode.priority, opts.priorityCeiling);
    const node: RefinedIssue = { ...rawNode, priority };
    const isLeaf = !childKeys.has(node.key);
    const labels = [typeLabel(opts.labelPrefix, node.kind), priorityLabel(opts.labelPrefix, priority)];
    if (isLeaf) labels.push(`${opts.labelPrefix}:refined`);
    const body = renderBody(node, byKey, opts.specIssueId);
    const issue = await tracker.createIssue({ title: node.title, body, labels });
    const published: PublishedIssue = { key: node.key, issue, kind: node.kind, isLeaf };
    byKey.set(node.key, published);
    created.push(published);

    if (node.parent) {
      const parent = byKey.get(node.parent);
      // topoOrder guarantees the parent was visited (and thus published)
      // first; a missing entry here would mean the gate let an
      // unresolved parent through, which refinementWellFormed rejects.
      if (parent) await tracker.linkChild(parent.issue, issue);
    }
  }
  return created;
}
