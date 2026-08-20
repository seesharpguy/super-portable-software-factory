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
 */
import type { EnsureLabelsResult, Issue, IssueProvider, WatchMarker, WatchState } from "./provider.ts";

const STATES: WatchState[] = ["ready", "working", "review", "done", "blocked"];
const MARKER_RE = /\[spf-watch-marker\]\s*(\{.*?\})/s;

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

export class JiraProvider implements IssueProvider {
  constructor(
    private readonly baseUrl: string, // e.g. "https://your-domain.atlassian.net", no trailing slash
    private readonly projectKey: string,
    private readonly labelPrefix: string,
    private readonly email: string,
    private readonly apiToken: string,
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

  async claim(issue: Issue): Promise<boolean> {
    const next = issue.labels.filter((l) => l !== this.label("ready"));
    next.push(this.label("working"));
    await this.jira(`/rest/api/3/issue/${issue.id}`, { method: "PUT", body: JSON.stringify({ fields: { labels: next } }) });
    const fresh = await this.jira<JiraIssue>(`/rest/api/3/issue/${issue.id}?fields=summary,description,labels`);
    const labels = fresh.fields.labels;
    const claimed = labels.includes(this.label("working")) && !labels.includes(this.label("ready"));
    if (!claimed) {
      const revert = labels.filter((l) => l !== this.label("working"));
      revert.push(this.label("ready"));
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

  private async findMarkerComment(issueId: string): Promise<{ id: string; marker: WatchMarker } | null> {
    const result = await this.jira<{ comments: JiraComment[] }>(`/rest/api/3/issue/${issueId}/comment?maxResults=100`);
    let found: { id: string; marker: WatchMarker } | null = null;
    for (const c of result.comments) {
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
