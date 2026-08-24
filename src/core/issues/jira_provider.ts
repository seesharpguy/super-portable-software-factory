/**
 * Jira Cloud REST API v3 implementation of `IssueProvider` — `spf watch`'s
 * tracker seam, not its PR seam (see `provider.ts`'s module comment): this
 * class never opens a PR, so it's paired with a `CodeHostProvider`
 * (`github_provider.ts` or `bitbucket_provider.ts`) at the CLI layer.
 *
 * Auth is HTTP Basic with an Atlassian account email + API token
 * (`JIRA_EMAIL` / `JIRA_API_TOKEN`), base64-encoded — verified against
 * developer.atlassian.com's current auth docs, not assumed.
 *
 * Two API-v3 specifics that would otherwise silently break this:
 *  - `/rest/api/3/search` (GET, JQL as a query param) was fully removed
 *    from Jira Cloud in October 2025. The only working search endpoint
 *    now is `/rest/api/3/search/jql`.
 *  - Comment/description bodies in API v3 are Atlassian Document Format
 *    (ADF) JSON, not plain strings — `{"body": "text"}` is rejected
 *    outright. `toAdf`/`adfToText` are the minimal round-trip this needs:
 *    one paragraph of plain text, nothing richer.
 *
 * State is modeled as Jira labels (`<prefix>:ready`, etc.), mirroring
 * `github_provider.ts` exactly, rather than native workflow status
 * transitions — the latter would need per-project transition-id mapping
 * (workflows vary by project/scheme in Jira), while labels work
 * identically everywhere with zero per-project setup. One caveat, verified
 * against Atlassian's own docs: colons ARE a legal label character and JQL
 * matches on them fine, they just don't show up in Jira's label
 * autocomplete UI — cosmetic only, not a functional issue.
 *
 * `ensureLabels()` is a no-op that reports the labels this run will use:
 * Jira labels are freeform strings with no color/description registry to
 * seed, unlike GitHub's.
 *
 * Implements `IssueAuthoringProvider` — the refine lane's create/link seam
 * — via Jira's native issue types plus the `parent` field: `createIssue`
 * maps a `RefinedIssue.kind` to a real Jira issue type name through the
 * configured `issueTypes` map (project setups rename/customize these often
 * enough that hardcoding "Epic"/"Story"/"Bug"/"Task" would break silently
 * on plenty of real projects), and `linkChild` sets the child's `parent`
 * field to the parent's key. This is the MODERN mechanism only — it works
 * on team-managed projects and on company-managed projects with Jira's
 * current issue-hierarchy setting; it does NOT fall back to the legacy
 * "Epic Link" custom field some older company-managed projects still rely
 * on. A project not configured for `parent`-based hierarchy gets Jira's own
 * API error surfaced as-is (this file's `jira()` wrapper never swallows a
 * non-2xx), never silently ignored. `listChildren` reads the hierarchy back
 * via a `parent = "<id>"` JQL search (same POST-body pattern
 * `searchByLabel` already uses below), which is what makes container
 * roll-up (`rollUp` in `watch.ts`) work here too, not just on GitHub.
 * `validateIssueTypes()` (below) is a plain method, not part of any shared
 * interface — GitHub has no equivalent concept — that `spf watch init` and
 * `spf watch`'s own startup check (`cli/commands/watch.ts`) both call to
 * catch a misconfigured `issueTypes` entry before anything unattended runs.
 *
 * One accepted platform limitation: Jira doesn't support Epic-under-Epic
 * nesting the way GitHub's sub-issues API supports up to 8 levels. A
 * refiner tree with a `feature` node parented under another `epic`/
 * `feature` (both mapping to Jira's Epic type by default) surfaces a real
 * Jira API error at publish time — a genuine platform difference, not
 * something this file tries to paper over.
 */
import type { RefinedIssue, JiraIssueTypeMap } from "../data_types.ts";
import type { EnsureLabelsResult, Issue, IssueAuthoringProvider, IssueComment, IssueProvider, WatchMarker, WatchState } from "./provider.ts";

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
];
/**
 * GREEDY capture, not lazy — same fix and same reasoning as
 * `github_provider.ts`'s own `MARKER_RE`: `WatchMarker.feedback` nests its
 * own object, so a lazy `\{.*?\}` stops at `feedback`'s own closing brace
 * instead of the marker's outer one, producing unparseable JSON the moment
 * a spec escalates even once — `readMarker` then returns `null` forever,
 * `writeMarker` can never find the existing marker to edit in place (a new
 * one gets posted every tick instead), and `buildSpecPrompt` never sees a
 * valid `asked_at`, so a human's answer never gets flagged as one. Greedy
 * backtracks from the end of the comment body to the true last `}` — safe
 * here because nothing follows the JSON in this format at all.
 */
const MARKER_RE = /\[spf-watch-marker\]\s*(\{.*\})/s;

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description: unknown | null;
    labels: string[];
  };
}

interface JiraComment {
  id: string;
  body: unknown;
  author: { displayName: string };
  created: string;
}

function toAdf(text: string): unknown {
  return {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

/** Walks an ADF document's `text` nodes and joins them — the minimal inverse of `toAdf`, not a full ADF renderer. */
function adfToText(adf: unknown): string {
  if (!adf || typeof adf !== "object") return "";
  const node = adf as { type?: string; text?: string; content?: unknown[] };
  if (node.type === "text" && typeof node.text === "string") return node.text;
  if (Array.isArray(node.content)) return node.content.map(adfToText).join("");
  return "";
}

export class JiraProvider implements IssueProvider, IssueAuthoringProvider {
  constructor(
    private readonly baseUrl: string, // e.g. "https://your-domain.atlassian.net", no trailing slash
    private readonly projectKey: string,
    private readonly labelPrefix: string,
    private readonly email: string,
    private readonly apiToken: string,
    private readonly issueTypes: JiraIssueTypeMap,
  ) {}

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString("base64")}`;
  }

  private async jira<T>(path: string, init?: RequestInit): Promise<T> {
    const debug = Boolean(process.env["SPF_JIRA_DEBUG"]);
    if (debug) console.error(`[jira debug] ${init?.method ?? "GET"} ${this.baseUrl}${path} body=${init?.body ?? "(none)"}`);
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Jira ${init?.method ?? "GET"} ${path} -> ${response.status}: ${detail.slice(0, 500)}`);
    }
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (debug) console.error(`[jira debug] -> ${response.status} ${text.slice(0, 2000)}`);
    return text ? (JSON.parse(text) as T) : (undefined as T);
  }

  private label(state: WatchState): string {
    return `${this.labelPrefix}:${state}`;
  }

  /** Jira labels are freeform strings, not a seedable registry — report what's used, create nothing. */
  async ensureLabels(): Promise<EnsureLabelsResult> {
    return { created: [], updated: [], unchanged: STATES.map((s) => this.label(s)) };
  }

  private toIssue(raw: JiraIssue): Issue {
    return {
      id: raw.key,
      title: raw.fields.summary,
      body: raw.fields.description ? adfToText(raw.fields.description) : "",
      labels: raw.fields.labels,
    };
  }

  /**
   * POST with the JQL in the JSON body, NOT a GET with `jql` as a query
   * param: this endpoint's own real-world behavior (confirmed by multiple
   * independent bug reports against it, not just this project's own
   * testing) is to silently ignore query-string parameters and return an
   * empty `issues` array with a 200 OK — no error, nothing to catch. A
   * `spf watch` that builds this as a GET query string would run cleanly
   * forever without ever claiming a single issue.
   */
  private async searchByLabel(label: string): Promise<Issue[]> {
    const jql = `project = ${JSON.stringify(this.projectKey)} AND labels = ${JSON.stringify(label)}`;
    const result = await this.jira<{ issues: JiraIssue[] }>("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({ jql, maxResults: 100, fields: ["summary", "description", "labels"] }),
    });
    return result.issues.map((i) => this.toIssue(i));
  }

  async listEligible(): Promise<Issue[]> {
    return this.searchByLabel(this.label("ready"));
  }

  /**
   * `opts.includeAll` is ignored: nothing but this provider's own
   * `transition()` ever changes an issue's labels or resolution here, so
   * there's no side channel (like GitHub's `Closes #n` auto-close) that
   * could make a `review`-labeled issue vanish from an unfiltered query.
   */
  async listInState(state: WatchState): Promise<Issue[]> {
    return this.searchByLabel(this.label(state));
  }

  /**
   * `null` on a real 404 (deleted, or a key that never existed) — any other
   * non-2xx still throws, same as `jira()`. What `claimNewWork`'s frontier
   * check (`watch.ts`) uses to look up a `blocked_by` id's current labels.
   * Unlike `github_provider.ts`'s hidden `spf-refine:` body marker, this
   * file has no equivalent for a Jira issue's OWN parent/blockers — a
   * caller here only ever sees what `blocked_by` it already has in hand,
   * never discovers it from the issue body itself.
   */
  async getIssue(id: string): Promise<Issue | null> {
    const response = await fetch(`${this.baseUrl}/rest/api/3/issue/${id}?fields=summary,description,labels`, {
      headers: { Authorization: this.authHeader(), Accept: "application/json" },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Jira GET /rest/api/3/issue/${id} -> ${response.status}: ${detail.slice(0, 500)}`);
    }
    return this.toIssue((await response.json()) as JiraIssue);
  }

  /** `IssueAuthoringProvider` — the refine lane's own need (see `provider.ts`'s module doc). `POST /rest/api/3/issue`'s response is `{id, key, self}`, not the full read shape `toIssue` expects, so this constructs the returned `Issue` locally rather than re-fetching. */
  async createIssue(input: { title: string; body: string; labels: string[]; kind: RefinedIssue["kind"] }): Promise<Issue> {
    const response = await this.jira<{ id: string; key: string }>("/rest/api/3/issue", {
      method: "POST",
      body: JSON.stringify({
        fields: {
          project: { key: this.projectKey },
          summary: input.title,
          description: toAdf(input.body),
          issuetype: { name: this.issueTypes[input.kind] },
          labels: input.labels,
        },
      }),
    });
    return { id: response.key, title: input.title, body: input.body, labels: input.labels };
  }

  /**
   * The modern mechanism only — Jira's `parent` field, not the legacy
   * "Epic Link" custom field. Works on team-managed projects and on
   * company-managed projects with Jira's current issue-hierarchy setting;
   * a project not configured for it surfaces Jira's own API error here,
   * unmodified — see this file's module comment on the accepted
   * Epic-under-Epic limitation this implies.
   */
  async linkChild(parent: Issue, child: Issue): Promise<void> {
    await this.jira(`/rest/api/3/issue/${child.id}`, { method: "PUT", body: JSON.stringify({ fields: { parent: { key: parent.id } } }) });
  }

  /** The read-back half of `linkChild` — same JQL-in-body pattern as `searchByLabel`, since a GET with query params silently returns nothing on this endpoint (see the module comment). What makes container roll-up (`rollUp` in `watch.ts`) work on Jira too. */
  async listChildren(parent: Issue): Promise<Issue[]> {
    const jql = `parent = ${JSON.stringify(parent.id)}`;
    const result = await this.jira<{ issues: JiraIssue[] }>("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({ jql, maxResults: 100, fields: ["summary", "description", "labels"] }),
    });
    return result.issues.map((i) => this.toIssue(i));
  }

  /**
   * Read-only validation of the configured `issueTypes` map against this
   * project's real issue types — what `spf watch init` and `spf watch`'s
   * own refine-lane startup check (`cli/commands/watch.ts`) both call to
   * catch a bad mapping before anything unattended runs on it, rather than
   * discovering it the first time a spec tries to publish. Not part of
   * `IssueAuthoringProvider` — GitHub has no equivalent concept, since it
   * has no native issue-type field to get wrong.
   *
   * Fetches a single page (Jira's own default: 50) — a project with more
   * issue types than that is exotic enough to warrant a loud warning
   * rather than a silent multi-page fetch loop for an edge case this
   * unlikely.
   */
  async validateIssueTypes(): Promise<Array<{ kind: string; jiraType: string; exists: boolean }>> {
    const result = await this.jira<{ issueTypes: Array<{ name: string }>; isLast?: boolean }>(
      `/rest/api/3/issue/createmeta/${encodeURIComponent(this.projectKey)}/issuetypes`,
    );
    if (result.isLast === false) {
      console.error(
        `spf watch: ${this.projectKey} has more issue types than one page reports — validateIssueTypes() may be missing some; ` +
          `re-run with a narrower watch.jira.issue_types check if a false mismatch shows up`,
      );
    }
    const available = new Set(result.issueTypes.map((t) => t.name));
    return Object.entries(this.issueTypes).map(([kind, jiraType]) => ({ kind, jiraType, exists: available.has(jiraType) }));
  }

  async claim(issue: Issue, opts?: { from?: WatchState; to?: WatchState }): Promise<boolean> {
    const from = this.label(opts?.from ?? "ready");
    const to = this.label(opts?.to ?? "working");
    const next = issue.labels.filter((l) => l !== from);
    next.push(to);
    await this.jira(`/rest/api/3/issue/${issue.id}`, { method: "PUT", body: JSON.stringify({ fields: { labels: next } }) });
    const fresh = await this.jira<JiraIssue>(`/rest/api/3/issue/${issue.id}?fields=summary,description,labels`);
    const labels = fresh.fields.labels;
    const claimed = labels.includes(to) && !labels.includes(from);
    if (!claimed) {
      const revert = labels.filter((l) => l !== to);
      revert.push(from);
      await this.jira(`/rest/api/3/issue/${issue.id}`, { method: "PUT", body: JSON.stringify({ fields: { labels: revert } }) }).catch(
        () => undefined,
      );
    }
    return claimed;
  }

  async transition(issue: Issue, to: WatchState, detail?: string): Promise<void> {
    const next = issue.labels.filter((l) => !STATES.some((s) => this.label(s) === l));
    next.push(this.label(to));
    await this.jira(`/rest/api/3/issue/${issue.id}`, { method: "PUT", body: JSON.stringify({ fields: { labels: next } }) });
    if (detail) await this.comment(issue, detail);
  }

  async comment(issue: Issue, body: string): Promise<void> {
    await this.jira(`/rest/api/3/issue/${issue.id}/comment`, { method: "POST", body: JSON.stringify({ body: toAdf(body) }) });
  }

  /** The single fetch every comment-reading method (`findMarkerComment`, `listComments`) builds on. */
  private async fetchComments(issueId: string): Promise<JiraComment[]> {
    const result = await this.jira<{ comments: JiraComment[] }>(`/rest/api/3/issue/${issueId}/comment?maxResults=100`);
    return result.comments;
  }

  private async findMarkerComment(issueId: string): Promise<{ id: string; marker: WatchMarker } | null> {
    const comments = await this.fetchComments(issueId);
    let found: { id: string; marker: WatchMarker } | null = null;
    for (const c of comments) {
      const match = MARKER_RE.exec(adfToText(c.body));
      if (!match) continue;
      try {
        found = { id: c.id, marker: JSON.parse(match[1]) };
      } catch {
        // malformed marker JSON — tolerate it and keep looking, like github_provider.ts does
      }
    }
    return found;
  }

  /** Oldest-first (Jira's own comment order), the hidden `[spf-watch-marker]` comment filtered out. */
  async listComments(issue: Issue): Promise<IssueComment[]> {
    const comments = await this.fetchComments(issue.id);
    return comments
      .filter((c) => !MARKER_RE.test(adfToText(c.body)))
      .map((c) => ({ id: c.id, author: c.author?.displayName ?? "unknown", created_at: c.created, body: adfToText(c.body) }));
  }

  async readMarker(issue: Issue): Promise<WatchMarker | null> {
    const found = await this.findMarkerComment(issue.id);
    return found?.marker ?? null;
  }

  async writeMarker(issue: Issue, marker: WatchMarker): Promise<void> {
    // Unlike GitHub's HTML-comment trick, Jira's ADF has no way to actually
    // hide this from a viewer — it's a plainly visible comment, just one
    // that starts with a recognizable, regex-matchable tag.
    const body = toAdf(`[spf-watch-marker] ${JSON.stringify(marker)}`);
    const existing = await this.findMarkerComment(issue.id);
    if (existing) {
      await this.jira(`/rest/api/3/issue/${issue.id}/comment/${existing.id}`, { method: "PUT", body: JSON.stringify({ body }) });
    } else {
      await this.jira(`/rest/api/3/issue/${issue.id}/comment`, { method: "POST", body: JSON.stringify({ body }) });
    }
  }
}
