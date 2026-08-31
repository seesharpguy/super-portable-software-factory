/**
 * GitHub REST implementation of `IssueProvider`, `CodeHostProvider`, AND
 * `IssueAuthoringProvider` — one class, since GitHub natively is an issue
 * tracker, a code host, and (via sub-issues) an issue-hierarchy API all at
 * once — via Node 22's native `fetch()`: deliberately not `octokit`, whose
 * full meta-package resolves to ~82MB of installed dependencies (`@octokit/app`,
 * `oauth-app`, `webhooks`, ...) for what `spf watch` actually needs, which is
 * a couple dozen REST calls, none of them exotic. `spf`'s own package stays
 * dependency-free either way.
 *
 * Auth is a classic PAT via `GITHUB_TOKEN` (`repo` scope — plus `project` if
 * `watch.github.status_map` is configured, see below), read once at
 * construction — matching the reference implementation's pattern and this
 * project's existing env-var-for-credentials philosophy. `listByLabel`
 * paginates up to `MAX_LIST_PAGES` (500 issues per label query) — no longer
 * "not this version's problem to solve," now that priority ordering makes a
 * truncated first page a correctness bug (an old, high-priority issue past
 * page 1 would silently lose to a new low-priority one), not just a missed
 * issue. A repo past even that cap gets a loud warning, never a silent
 * truncation — see `listByLabel`'s own doc comment.
 *
 * State is modeled as labels (`<prefix>:ready`, etc.) — labels are spf's
 * ACTUAL state machine and always get written, unconditionally. Native
 * GitHub Projects v2 board status is a separate, OPTIONAL, best-effort layer
 * on top (`syncStatus()`), driven entirely by `watch.github.status_map` —
 * empty by default, so an existing config's behavior is unchanged. It's
 * opt-in, and GraphQL-only (Projects v2 has no REST API), because not every
 * repo has a board wired up, and a board's Status option names are per-
 * project configuration `spf` can't assume; a misconfigured or unreachable
 * entry degrades to a logged warning, never a thrown error — same rule
 * `jira_provider.ts`'s own `syncStatus()` follows, for the same reason: a
 * status-sync miss must never block the label update `spf watch` actually
 * depends on.
 */
import type { GithubStatusMap } from "../data_types.ts";
import type {
  CodeHostProvider,
  EnsureLabelsResult,
  Issue,
  IssueAuthoringKind,
  IssueAuthoringProvider,
  IssueComment,
  IssueProvider,
  PrRef,
  PrStatus,
  WatchMarker,
  WatchState,
} from "./provider.ts";

const API = "https://api.github.com";
const STATES: WatchState[] = [
  "ready",
  "working",
  "review",
  "done",
  "blocked",
  "spec-ready",
  "refining",
  "refined",
  "needs-feedback",
  "continue-refinement",
  "spec-in-progress",
  "split-proposed",
  "split-approved",
];
/**
 * GREEDY capture, not lazy: `WatchMarker.feedback` nests its own object
 * (`{rounds, asked_at}`), so a lazy `\{.*?\}` stops at the FIRST `}` it
 * finds — which is `feedback`'s own closing brace, not the marker's outer
 * one — capturing an unbalanced, unparseable fragment the instant a spec
 * escalates even once. `JSON.parse` then throws, is silently caught, and
 * `readMarker` returns `null` forever after that point: the round counter
 * can never advance past 1, a fresh marker comment gets posted every tick
 * instead of the existing one being edited in place, and — worst of all —
 * `buildSpecPrompt` never receives a valid `asked_at`, so a human's answer
 * is never recognized as one, just dumped into undifferentiated "earlier
 * discussion." A greedy match backtracks from the END of the string to find
 * the LAST `}` — the marker's own outer brace — which is exactly right
 * here since nothing meaningful follows it but the closing `-->`.
 */
const MARKER_RE = /<!--\s*spf-watch:\s*(\{.*\})\s*-->/s;
/** `listByLabel`'s pagination bound — see its own doc comment. */
const MAX_LIST_PAGES = 5;

/**
 * The refine lane's leaf/container taxonomy — see `data_types.ts`'s
 * `RefinedIssueSchema.kind` — plus `"spec"`, a proposed spec's own kind (see
 * `IssueAuthoringKind` in `provider.ts`). Not a `WatchState`: these never
 * appear on the left of a `transition()` call, so `transition()` never
 * strips them.
 */
export const ISSUE_KINDS = ["epic", "feature", "story", "bug", "task", "spec"] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

// GitHub label colors are 6 hex digits, no leading '#'.
const LABEL_META: Record<WatchState, { color: string; description: string }> = {
  ready: { color: "0e8a16", description: "spf watch will claim this issue on its next poll" },
  working: { color: "fbca04", description: "spf watch has claimed this issue and is running a chain against it" },
  review: { color: "1d76db", description: "spf watch opened a PR for this issue — awaiting merge" },
  done: { color: "5319e7", description: "spf watch's PR for this issue merged" },
  blocked: { color: "d93f0b", description: "spf watch gave up — needs a human" },
  "spec-ready": { color: "0e8a16", description: "spf watch's refine lane will claim this spec on its next poll" },
  refining: { color: "fbca04", description: "spf watch has claimed this spec and is decomposing it into issues" },
  refined: { color: "c2e0c6", description: "generated by spf watch's refine lane — promote to spf:ready when it's worth building" },
  "needs-feedback": { color: "d93f0b", description: "spf's refiner needs a human answer before it can finish decomposing this spec" },
  "continue-refinement": { color: "0e8a16", description: "add this once you've answered — spf will resume refining from where it left off" },
  "spec-in-progress": { color: "1d76db", description: "decomposed and published — waiting on every generated issue to reach spf:done" },
  "split-proposed": { color: "d93f0b", description: "spf's refiner proposed splitting this spec into several — review the proposal comment" },
  "split-approved": { color: "0e8a16", description: "add this once you approve the proposed split — spf will create the new specs" },
};

const TYPE_LABEL_META: Record<IssueKind, { color: string; description: string }> = {
  epic: { color: "5319e7", description: "a container generated by spf watch's refine lane — not directly workable" },
  feature: { color: "1d76db", description: "a container generated by spf watch's refine lane — not directly workable" },
  story: { color: "bfd4f2", description: "a leaf generated by spf watch's refine lane — vertical-slice, independently workable" },
  bug: { color: "e99695", description: "a leaf generated by spf watch's refine lane — vertical-slice, independently workable" },
  task: { color: "d4c5f9", description: "a leaf generated by spf watch's refine lane — vertical-slice, independently workable" },
  spec: { color: "fef2c0", description: "a standalone spec proposed by splitting a larger one — not yet decomposed" },
};

/**
 * What `claimNewWork` (`watch.ts`) schedules by — see `RefinedPrioritySchema`
 * in `data_types.ts`. Deliberately a LABEL, not this repo's own GitHub
 * Projects v2 "Priority" field (a single-select with its own Urgent/High/
 * Medium/Low options): a Projects v2 value is GraphQL-only, needs a
 * `project` token scope and a project id in config, and has no Jira
 * equivalent — the exact abstraction `jira_provider.ts` exists to protect.
 * If a repo's board also carries a Priority field, the two are independent
 * and nothing reconciles them; `spf watch` obeys only this label. See
 * README.md's `spf watch` section for the reconciliation-by-hand caveat.
 */
const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
type Priority = (typeof PRIORITIES)[number];

const PRIORITY_LABEL_META: Record<Priority, { color: string; description: string }> = {
  p0: { color: "b60205", description: "drop everything — a broken promise to users, or blocking everything else" },
  p1: { color: "d93f0b", description: "the spec's core value — the slices without which it isn't shipped" },
  p2: { color: "fbca04", description: "the default — real scope, can wait a cycle" },
  p3: { color: "c5def5", description: "worth writing down, not worth scheduling yet" },
};

interface GhIssue {
  id: number; // the database id — distinct from `number`, see Issue.internal_id's doc comment
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
}

export class GitHubProvider implements IssueProvider, CodeHostProvider, IssueAuthoringProvider {
  /** Resolved lazily by `resolveProjectStatusField()` — cached only on SUCCESS, so a transient GraphQL hiccup gets retried the next call rather than disabling status sync for this instance's entire (potentially daemon-long) lifetime. */
  private projectMeta?: { projectId: string; statusFieldId: string; options: Map<string, string> };

  constructor(
    private readonly repo: string, // "owner/name"
    private readonly labelPrefix: string,
    private readonly token: string,
    private readonly projectNumber = 0, // 0 = status sync disabled, regardless of statusMap
    private readonly statusMap: GithubStatusMap = {},
  ) {}

  private async gh<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`GitHub ${init?.method ?? "GET"} ${path} -> ${response.status}: ${detail.slice(0, 500)}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /**
   * Projects v2 has no REST surface at all — this is the one place this
   * file talks GraphQL instead of REST. A GraphQL "not found" (bad login,
   * bad project number, missing `project` scope) comes back as a 200 with a
   * null data field plus an `errors` array, not a non-2xx — callers read
   * `data` being falsy as "couldn't resolve," same as a 404 elsewhere in
   * this file.
   */
  private async ghGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`GitHub GraphQL -> ${response.status}: ${detail.slice(0, 500)}`);
    }
    const json = (await response.json()) as { data?: T | null; errors?: Array<{ message: string }> };
    if (!json.data) {
      throw new Error(`GitHub GraphQL returned no data${json.errors ? `: ${json.errors.map((e) => e.message).join("; ")}` : ""}`);
    }
    return json.data;
  }

  private label(state: WatchState): string {
    return `${this.labelPrefix}:${state}`;
  }

  private typeLabel(kind: IssueKind): string {
    return `${this.labelPrefix}:type:${kind}`;
  }

  /** Mirrors `core/refine.ts`'s own module-level `priorityLabel()` — that one stays provider-agnostic (a plain string, no `this`); this one is `ensureLabels()`'s seeding half. */
  private priorityLabel(priority: Priority): string {
    return `${this.labelPrefix}:priority:${priority}`;
  }

  /** `null` on a real 404 (label doesn't exist yet) — any other non-2xx still throws, same as `gh()`. */
  private async getLabel(name: string): Promise<{ color: string; description: string | null } | null> {
    const response = await fetch(`${API}/repos/${this.repo}/labels/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`GitHub GET /repos/${this.repo}/labels/${name} -> ${response.status}: ${detail.slice(0, 500)}`);
    }
    return (await response.json()) as { color: string; description: string | null };
  }

  /**
   * Idempotent by inspection, not by "create and catch a 422": GET the
   * label first, then create/update/leave alone depending on what's
   * actually there. One fewer request in the common "already correct"
   * case, and no brittle matching against GitHub's error-message text.
   * Shared by `ensureLabels()`'s state-label and type-label passes.
   */
  private async ensureOneLabel(name: string, color: string, description: string, result: EnsureLabelsResult): Promise<void> {
    const existing = await this.getLabel(name);
    if (!existing) {
      await this.gh(`/repos/${this.repo}/labels`, { method: "POST", body: JSON.stringify({ name, color, description }) });
      result.created.push(name);
    } else if (existing.color !== color || (existing.description ?? "") !== description) {
      await this.gh(`/repos/${this.repo}/labels/${encodeURIComponent(name)}`, {
        method: "PATCH",
        body: JSON.stringify({ color, description }),
      });
      result.updated.push(name);
    } else {
      result.unchanged.push(name);
    }
  }

  async ensureLabels(): Promise<EnsureLabelsResult> {
    const result: EnsureLabelsResult = { created: [], updated: [], unchanged: [] };
    for (const state of STATES) {
      const { color, description } = LABEL_META[state];
      await this.ensureOneLabel(this.label(state), color, description, result);
    }
    for (const kind of ISSUE_KINDS) {
      const { color, description } = TYPE_LABEL_META[kind];
      await this.ensureOneLabel(this.typeLabel(kind), color, description, result);
    }
    // `<prefix>:priority:p0..p3` — what claimNewWork schedules by (see
    // PRIORITY_LABEL_META's doc comment above on why this is a label, not
    // this repo's own Projects v2 Priority field).
    for (const priority of PRIORITIES) {
      const { color, description } = PRIORITY_LABEL_META[priority];
      await this.ensureOneLabel(this.priorityLabel(priority), color, description, result);
    }
    return result;
  }

  private toIssue(raw: GhIssue): Issue {
    return {
      id: String(raw.number),
      internal_id: String(raw.id),
      title: raw.title,
      body: raw.body ?? "",
      labels: raw.labels.map((l) => (typeof l === "string" ? l : l.name)),
    };
  }

  /**
   * `sort=created&direction=asc` is stated, not inherited: without it,
   * GitHub's own default (`created`, `desc` — newest first) is what
   * `claimNewWork` used to walk, silently, which is why a >100-issue ready
   * backlog used to be a real risk before pagination existed at all.
   * Oldest-first is also `orderEligible`'s own final tiebreaker (`watch.ts`),
   * so this method's order and that function's are the same order absent a
   * priority/affinity difference — no redundant client-side re-sort needed
   * for the plain case.
   *
   * Paginates up to `MAX_LIST_PAGES` (500 issues) — no longer "this
   * version's problem to solve": a client-side priority sort over a
   * truncated first page would silently misorder or hide real work, which is
   * worse than the old unordered-100-issues behavior it replaces. A repo
   * that still exceeds the cap gets a loud, named warning rather than a
   * silent truncation.
   */
  private async listByLabel(label: string, state: "open" | "all"): Promise<Issue[]> {
    const results: Issue[] = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const raw = await this.gh<GhIssue[]>(
        `/repos/${this.repo}/issues?labels=${encodeURIComponent(label)}&state=${state}&sort=created&direction=asc&per_page=100&page=${page}`,
      );
      results.push(...raw.filter((i) => !i.pull_request).map((i) => this.toIssue(i)));
      if (raw.length < 100) return results; // short page — this was the last one
      if (page === MAX_LIST_PAGES) {
        console.error(
          `spf watch: listByLabel(${JSON.stringify(label)}) hit the ${MAX_LIST_PAGES}-page (${MAX_LIST_PAGES * 100}-issue) cap — ` +
            `older ${JSON.stringify(label)} issues past this cap are invisible this tick`,
        );
      }
    }
    return results;
  }

  async listEligible(): Promise<Issue[]> {
    return this.listByLabel(this.label("ready"), "open");
  }

  async listInState(state: WatchState, opts?: { includeAll?: boolean }): Promise<Issue[]> {
    return this.listByLabel(this.label(state), opts?.includeAll ? "all" : "open");
  }

  /** `null` on a real 404 — deleted, or (state defaults to open in a plain fetch) an issue GitHub itself considers gone. Any other non-2xx still throws, same as `gh()`. */
  async getIssue(id: string): Promise<Issue | null> {
    const response = await fetch(`${API}/repos/${this.repo}/issues/${id}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`GitHub GET /repos/${this.repo}/issues/${id} -> ${response.status}: ${detail.slice(0, 500)}`);
    }
    return this.toIssue((await response.json()) as GhIssue);
  }

  /** `GET .../sub_issues` — the read-back half of `linkChild`; what makes container roll-up possible (`rollUp` in `watch.ts`). Closed children ARE returned (no `state` filter) — roll-up needs to see a `blocked` child too, to correctly NOT finish the container. */
  async listChildren(parent: Issue): Promise<Issue[]> {
    const raw = await this.gh<GhIssue[]>(`/repos/${this.repo}/issues/${parent.id}/sub_issues`);
    return raw.filter((i) => !i.pull_request).map((i) => this.toIssue(i));
  }

  async claim(issue: Issue, opts?: { from?: WatchState; to?: WatchState }): Promise<boolean> {
    const toState = opts?.to ?? "working";
    const from = this.label(opts?.from ?? "ready");
    const to = this.label(toState);
    await this.gh(`/repos/${this.repo}/issues/${issue.id}/labels/${encodeURIComponent(from)}`, {
      method: "DELETE",
    }).catch(() => undefined); // already gone is fine
    await this.gh(`/repos/${this.repo}/issues/${issue.id}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: [to] }),
    });
    const fresh = await this.gh<GhIssue>(`/repos/${this.repo}/issues/${issue.id}`);
    const labels = this.toIssue(fresh).labels;
    const claimed = labels.includes(to) && !labels.includes(from);
    if (!claimed) {
      // Lost the race (or something else relabeled it) — put the source label back so it's not stuck.
      await this.gh(`/repos/${this.repo}/issues/${issue.id}/labels`, {
        method: "POST",
        body: JSON.stringify({ labels: [from] }),
      }).catch(() => undefined);
    } else {
      await this.syncStatus(issue, toState);
    }
    return claimed;
  }

  async transition(issue: Issue, to: WatchState, detail?: string): Promise<void> {
    for (const state of STATES) {
      const label = this.label(state);
      if (issue.labels.includes(label)) {
        await this.gh(`/repos/${this.repo}/issues/${issue.id}/labels/${encodeURIComponent(label)}`, { method: "DELETE" }).catch(
          () => undefined,
        );
      }
    }
    await this.gh(`/repos/${this.repo}/issues/${issue.id}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: [this.label(to)] }),
    });
    await this.syncStatus(issue, to);
    if (detail) await this.comment(issue, detail);
  }

  /**
   * Best-effort native Projects v2 status sync — a no-op unless
   * `project_number` AND `status_map` both configure something for `to`.
   * Every failure mode (unconfigured, project/field not found, no matching
   * option, a rejected mutation) is logged and swallowed, never thrown —
   * see this file's module comment on why a status-sync miss must never
   * break the label update callers depend on.
   */
  private async syncStatus(issue: Issue, to: WatchState): Promise<void> {
    const statusName = (this.statusMap as Record<string, string | undefined>)[to];
    if (!statusName) return;
    const meta = await this.resolveProjectStatusField();
    if (!meta) return; // already logged inside resolveProjectStatusField, or simply unconfigured (project_number: 0)
    const optionId = meta.options.get(statusName);
    if (!optionId) {
      console.error(
        `spf watch: issue #${issue.id} — GitHub Projects #${this.projectNumber} has no Status option named ${JSON.stringify(statusName)} (watch.github.status_map.${to}) — skipping status sync, label already updated`,
      );
      return;
    }
    try {
      const itemId = await this.resolveProjectItemId(issue, meta.projectId);
      if (!itemId) return; // already logged inside resolveProjectItemId
      await this.ghGraphql(
        `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input: {projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: {singleSelectOptionId: $optionId}}) {
            clientMutationId
          }
        }`,
        { projectId: meta.projectId, itemId, fieldId: meta.statusFieldId, optionId },
      );
    } catch (err) {
      console.error(
        `spf watch: issue #${issue.id} — GitHub Projects status sync to ${JSON.stringify(statusName)} failed; label already updated — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Resolves (and caches — see `projectMeta`'s own doc comment) `watch.github.project_number`'s
   * "Status" single-select field against the repo OWNER's Projects v2 board
   * (Projects v2 numbers are per-owner, not per-repo — see
   * `WatchGithubConfigSchema`'s doc comment). Tries `organization(login:)`
   * first, then `user(login:)`: an owner is exactly one of the two, and
   * GraphQL returns that field as `null` (not a hard error) when it's the
   * wrong kind, so falling through is safe.
   */
  private async resolveProjectStatusField(): Promise<{ projectId: string; statusFieldId: string; options: Map<string, string> } | null> {
    if (!this.projectNumber) return null;
    if (this.projectMeta) return this.projectMeta;
    const owner = this.repo.split("/")[0]!;
    interface FieldNode {
      id: string;
      name: string;
      options: Array<{ id: string; name: string }>;
    }
    interface ProjectNode {
      id: string;
      fields: { nodes: Array<FieldNode | null> };
    }
    let data: { organization: { projectV2: ProjectNode | null } | null; user: { projectV2: ProjectNode | null } | null };
    try {
      data = await this.ghGraphql(
        `query($login: String!, $number: Int!) {
          organization(login: $login) { projectV2(number: $number) { id fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } }
          user(login: $login) { projectV2(number: $number) { id fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } }
        }`,
        { login: owner, number: this.projectNumber },
      );
    } catch (err) {
      console.error(
        `spf watch: couldn't resolve GitHub Projects v2 #${this.projectNumber} for ${owner} — status sync skipped this run — ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    const project = data.organization?.projectV2 ?? data.user?.projectV2;
    if (!project) {
      console.error(
        `spf watch: GitHub Projects v2 #${this.projectNumber} not found for ${owner} (or GITHUB_TOKEN lacks "project" scope) — status sync skipped this run`,
      );
      return null;
    }
    const statusField = project.fields.nodes.find((f): f is FieldNode => f !== null && f.name === "Status");
    if (!statusField) {
      console.error(`spf watch: GitHub Projects v2 #${this.projectNumber} has no "Status" single-select field — status sync skipped this run`);
      return null;
    }
    this.projectMeta = { projectId: project.id, statusFieldId: statusField.id, options: new Map(statusField.options.map((o) => [o.name, o.id])) };
    return this.projectMeta;
  }

  /** The item-id half of `syncStatus()`: an issue already on the project has one; otherwise this adds it, since a `status_map` entry is an implicit "yes, put this on the board" — the same way a Jira issue is already assumed to be on its project. `null` (logged) on any lookup/add failure. */
  private async resolveProjectItemId(issue: Issue, projectId: string): Promise<string | null> {
    const [owner, name] = this.repo.split("/") as [string, string];
    let data: { repository: { issue: { id: string; projectItems: { nodes: Array<{ id: string; project: { id: string } }> } } | null } | null };
    try {
      data = await this.ghGraphql(
        `query($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            issue(number: $number) { id projectItems(first: 20) { nodes { id project { id } } } }
          }
        }`,
        { owner, name, number: Number(issue.id) },
      );
    } catch (err) {
      console.error(
        `spf watch: issue #${issue.id} — couldn't look up its GitHub Projects item; status sync skipped, label already updated — ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    const ghIssue = data.repository?.issue;
    if (!ghIssue) return null; // deleted between the label update and here — nothing left to sync
    const existing = ghIssue.projectItems.nodes.find((n) => n.project.id === projectId);
    if (existing) return existing.id;
    try {
      const added = await this.ghGraphql<{ addProjectV2ItemById: { item: { id: string } } }>(
        `mutation($projectId: ID!, $contentId: ID!) { addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) { item { id } } }`,
        { projectId, contentId: ghIssue.id },
      );
      return added.addProjectV2ItemById.item.id;
    } catch (err) {
      console.error(
        `spf watch: issue #${issue.id} — couldn't add it to GitHub Projects #${this.projectNumber}; status sync skipped, label already updated — ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Read-only validation of the configured `status_map` against the real
   * project's Status options — what `spf watch init` and `spf watch`'s own
   * startup check call to catch a misnamed option before an unattended run
   * silently no-ops its status sync every time, the same role
   * `validateIssueTypes()`/`validateStatusMap()` play on the Jira side.
   * Empty when `status_map` has no entries configured at all — nothing to
   * report, not a mismatch.
   */
  async validateStatusMap(): Promise<Array<{ state: string; githubStatus: string; exists: boolean }>> {
    const entries = Object.entries(this.statusMap).filter((entry): entry is [string, string] => Boolean(entry[1]));
    if (entries.length === 0) return [];
    const meta = await this.resolveProjectStatusField();
    return entries.map(([state, githubStatus]) => ({ state, githubStatus, exists: meta ? meta.options.has(githubStatus) : false }));
  }

  async comment(issue: Issue, body: string): Promise<void> {
    await this.gh(`/repos/${this.repo}/issues/${issue.id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async openPr(opts: { branch: string; title: string; body: string; base: string }): Promise<PrRef> {
    const pr = await this.gh<{ number: number; html_url: string }>(`/repos/${this.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: opts.title, body: opts.body, head: opts.branch, base: opts.base }),
    });
    return { number: pr.number, branch: opts.branch, url: pr.html_url };
  }

  async prStatus(pr: PrRef): Promise<PrStatus> {
    const detail = await this.gh<{ merged: boolean; state: "open" | "closed"; head: { sha: string } }>(
      `/repos/${this.repo}/pulls/${pr.number}`,
    );
    let ciStatus: PrStatus["ciStatus"] = "pending";
    try {
      const checks = await this.gh<{ check_runs: Array<{ status: string; conclusion: string | null }> }>(
        `/repos/${this.repo}/commits/${detail.head.sha}/check-runs?per_page=100`,
      );
      if (checks.check_runs.length === 0) {
        ciStatus = "pending"; // no checks configured — never blocks a lean v1's own polling
      } else if (checks.check_runs.some((c) => c.status !== "completed")) {
        ciStatus = "pending";
      } else if (checks.check_runs.some((c) => ["failure", "timed_out", "cancelled", "action_required"].includes(c.conclusion ?? ""))) {
        ciStatus = "failure";
      } else {
        ciStatus = "success";
      }
    } catch {
      ciStatus = "pending"; // check-runs lookup failing shouldn't block merge/close detection
    }
    return { merged: detail.merged, state: detail.state, ciStatus };
  }

  /**
   * `IssueAuthoringProvider` — the refine lane's own need (see `provider.ts`'s
   * module doc). `input.kind` is unused here: GitHub has no native
   * issue-type field the way Jira does, and `input.labels` already carries
   * `<prefix>:type:<kind>` for GitHub's own bookkeeping — the parameter
   * exists on the shared interface for `JiraProvider`'s sake.
   */
  async createIssue(input: { title: string; body: string; labels: string[]; kind: IssueAuthoringKind }): Promise<Issue> {
    const raw = await this.gh<GhIssue>(`/repos/${this.repo}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: input.title, body: input.body, labels: input.labels }),
    });
    return this.toIssue(raw);
  }

  /**
   * `POST /repos/{o}/{r}/issues/{parent_number}/sub_issues` — GitHub's
   * native sub-issue link. Confirmed against GitHub's own REST docs: the
   * body param is `sub_issue_id`, the CHILD's database id, not its issue
   * number — hence `linkChild` requiring `child.internal_id` rather than
   * `child.id`. GitHub's documented limits (not enforced client-side here):
   * 100 sub-issues per parent, 8 levels of nesting.
   */
  async linkChild(parent: Issue, child: Issue): Promise<void> {
    if (!child.internal_id) {
      throw new Error(`linkChild: child issue #${child.id} has no internal_id — only an issue this provider just created/fetched can be linked`);
    }
    await this.gh(`/repos/${this.repo}/issues/${parent.id}/sub_issues`, {
      method: "POST",
      body: JSON.stringify({ sub_issue_id: Number(child.internal_id) }),
    });
  }

  /** The single fetch every comment-reading method (`findMarkerComment`, `listComments`) builds on. */
  private async fetchComments(issueId: string): Promise<Array<{ id: number; body: string; user: { login: string } | null; created_at: string }>> {
    return this.gh(`/repos/${this.repo}/issues/${issueId}/comments?per_page=100`);
  }

  private async findMarkerComment(issueId: string): Promise<{ id: number; marker: WatchMarker } | null> {
    const comments = await this.fetchComments(issueId);
    let found: { id: number; marker: WatchMarker } | null = null;
    for (const c of comments) {
      const match = MARKER_RE.exec(c.body || "");
      if (!match) continue;
      try {
        found = { id: c.id, marker: JSON.parse(match[1]) };
      } catch {
        // malformed marker JSON — tolerate it and keep looking, like the reference implementation does
      }
    }
    return found;
  }

  async readMarker(issue: Issue): Promise<WatchMarker | null> {
    const found = await this.findMarkerComment(issue.id);
    return found?.marker ?? null;
  }

  async writeMarker(issue: Issue, marker: WatchMarker): Promise<void> {
    const body = `<!-- spf-watch: ${JSON.stringify(marker)} -->`;
    const existing = await this.findMarkerComment(issue.id);
    if (existing) {
      await this.gh(`/repos/${this.repo}/issues/comments/${existing.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
    } else {
      await this.gh(`/repos/${this.repo}/issues/${issue.id}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    }
  }

  /** Oldest-first (GitHub's own comment order), the hidden marker comment filtered out. */
  async listComments(issue: Issue): Promise<IssueComment[]> {
    const comments = await this.fetchComments(issue.id);
    return comments
      .filter((c) => !MARKER_RE.test(c.body || ""))
      .map((c) => ({ id: String(c.id), author: c.user?.login ?? "unknown", created_at: c.created_at, body: c.body || "" }));
  }

  /** `state_reason: "completed"` — the refine lane's own reason for closing a spec once it's fully decomposed; see `finishSpec` in `watch.ts`. */
  async closeIssue(issue: Issue): Promise<void> {
    await this.gh(`/repos/${this.repo}/issues/${issue.id}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed", state_reason: "completed" }),
    });
  }
}
