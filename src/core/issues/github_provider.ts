/**
 * GitHub REST implementation of `IssueProvider`, via Node 22's native
 * `fetch()` — deliberately not `octokit`: the full `octokit` meta-package
 * resolves to ~82MB of installed dependencies (`@octokit/app`,
 * `oauth-app`, `webhooks`, ...) for what `spf watch` actually needs, which
 * is six REST calls. `spf`'s own package stays dependency-free either way.
 *
 * Auth is a classic PAT via `GITHUB_TOKEN` (`repo` scope), read once at
 * construction — matching the reference implementation's pattern and this
 * project's existing env-var-for-credentials philosophy. No pagination
 * beyond one page of 100: fine for the label-scoped queries a lean v1
 * makes (a repo with >100 open `<prefix>:ready` issues at once is not this
 * version's problem to solve).
 */
import type { Issue, IssueProvider, PrRef, PrStatus, WatchMarker, WatchState } from "./provider.ts";

const API = "https://api.github.com";
const STATES: WatchState[] = ["ready", "working", "review", "done", "blocked"];
const MARKER_RE = /<!--\s*spf-watch:\s*(\{.*?\})\s*-->/s;

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
}

export class GitHubProvider implements IssueProvider {
  constructor(
    private readonly repo: string, // "owner/name"
    private readonly labelPrefix: string,
    private readonly token: string,
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

  private label(state: WatchState): string {
    return `${this.labelPrefix}:${state}`;
  }

  private toIssue(raw: GhIssue): Issue {
    return {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? "",
      labels: raw.labels.map((l) => (typeof l === "string" ? l : l.name)),
    };
  }

  private async listByLabel(label: string, state: "open" | "all"): Promise<Issue[]> {
    const raw = await this.gh<GhIssue[]>(
      `/repos/${this.repo}/issues?labels=${encodeURIComponent(label)}&state=${state}&per_page=100`,
    );
    return raw.filter((i) => !i.pull_request).map((i) => this.toIssue(i));
  }

  async listEligible(): Promise<Issue[]> {
    return this.listByLabel(this.label("ready"), "open");
  }

  async listInState(state: WatchState, opts?: { includeAll?: boolean }): Promise<Issue[]> {
    return this.listByLabel(this.label(state), opts?.includeAll ? "all" : "open");
  }

  async claim(issue: Issue): Promise<boolean> {
    await this.gh(`/repos/${this.repo}/issues/${issue.number}/labels/${encodeURIComponent(this.label("ready"))}`, {
      method: "DELETE",
    }).catch(() => undefined); // already gone is fine
    await this.gh(`/repos/${this.repo}/issues/${issue.number}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: [this.label("working")] }),
    });
    const fresh = await this.gh<GhIssue>(`/repos/${this.repo}/issues/${issue.number}`);
    const labels = this.toIssue(fresh).labels;
    const claimed = labels.includes(this.label("working")) && !labels.includes(this.label("ready"));
    if (!claimed) {
      // Lost the race (or something else relabeled it) — put ready back so it's not stuck.
      await this.gh(`/repos/${this.repo}/issues/${issue.number}/labels`, {
        method: "POST",
        body: JSON.stringify({ labels: [this.label("ready")] }),
      }).catch(() => undefined);
    }
    return claimed;
  }

  async transition(issue: Issue, to: WatchState, detail?: string): Promise<void> {
    for (const state of STATES) {
      const label = this.label(state);
      if (issue.labels.includes(label)) {
        await this.gh(`/repos/${this.repo}/issues/${issue.number}/labels/${encodeURIComponent(label)}`, { method: "DELETE" }).catch(
          () => undefined,
        );
      }
    }
    await this.gh(`/repos/${this.repo}/issues/${issue.number}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: [this.label(to)] }),
    });
    if (detail) await this.comment(issue, detail);
  }

  async comment(issue: Issue, body: string): Promise<void> {
    await this.gh(`/repos/${this.repo}/issues/${issue.number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async openPr(issue: Issue, opts: { branch: string; title: string; body: string; base: string }): Promise<PrRef> {
    // Belt-and-suspenders: ensure the PR body closes the issue even if the
    // caller's body forgot to say so — this is how `finishReviews`-style
    // merge polling knows an issue's work landed at all.
    const closesTag = `Closes #${issue.number}`;
    const body = opts.body.includes(closesTag) ? opts.body : `${opts.body}\n\n${closesTag}`;
    const pr = await this.gh<{ number: number; html_url: string }>(`/repos/${this.repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title: opts.title, body, head: opts.branch, base: opts.base }),
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

  private async findMarkerComment(issueNumber: number): Promise<{ id: number; marker: WatchMarker } | null> {
    const comments = await this.gh<Array<{ id: number; body: string }>>(
      `/repos/${this.repo}/issues/${issueNumber}/comments?per_page=100`,
    );
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
    const found = await this.findMarkerComment(issue.number);
    return found?.marker ?? null;
  }

  async writeMarker(issue: Issue, marker: WatchMarker): Promise<void> {
    const body = `<!-- spf-watch: ${JSON.stringify(marker)} -->`;
    const existing = await this.findMarkerComment(issue.number);
    if (existing) {
      await this.gh(`/repos/${this.repo}/issues/comments/${existing.id}`, { method: "PATCH", body: JSON.stringify({ body }) });
    } else {
      await this.gh(`/repos/${this.repo}/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
    }
  }
}
