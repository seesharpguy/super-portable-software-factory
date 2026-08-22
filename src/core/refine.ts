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
import type { RefinedIssue, SFConfig } from "./data_types.ts";

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

/**
 * The body GitHub actually stores: the refiner's own `## What to build` /
 * `## Acceptance criteria` text, plus a `## Parent` back-reference to the
 * source spec (when there is one — a bare `spf refine` run with no
 * `--issue` has none), plus a `## Blocked by` section with real `#n`
 * references — `to-tickets`' own template shape, ported. Every `blocked_by`
 * key is guaranteed to already be in `byKey` by the time this runs:
 * `topoOrder` visits a node's dependencies before the node itself.
 */
function renderBody(node: RefinedIssue, byKey: Map<string, PublishedIssue>, specIssueId: string | null | undefined): string {
  const parts = [node.body.trim()];
  if (specIssueId) parts.push(`## Parent\n\nDecomposed from #${specIssueId}.`);
  if (node.blocked_by.length > 0) {
    const refs = node.blocked_by.map((key) => {
      const published = byKey.get(key);
      // Defensive only: gates.refinementWellFormed already rejects a
      // blocked_by key that doesn't resolve to another node in the list.
      return published ? `#${published.issue.id}` : key;
    });
    parts.push(`## Blocked by\n\n${refs.map((r) => `- ${r}`).join("\n")}`);
  } else {
    parts.push(`## Blocked by\n\nNone (can start immediately).`);
  }
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
}

/**
 * Create every node in `issues`, in dependency order, with its
 * `<prefix>:type:<kind>` label (plus `<prefix>:refined` on leaves only —
 * see `WatchState`'s doc comment in `provider.ts`), link each to its parent
 * via the tracker's native hierarchy, and render real `#n` references into
 * `## Blocked by`. Returns what it created, in creation order.
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

  for (const node of ordered) {
    const isLeaf = !childKeys.has(node.key);
    const labels = [typeLabel(opts.labelPrefix, node.kind)];
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
