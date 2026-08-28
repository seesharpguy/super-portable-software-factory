/**
 * Bitbucket Cloud REST API v2.0 implementation of `CodeHostProvider` —
 * `spf watch`'s PR seam, not its tracker seam (see `provider.ts`'s module
 * comment): this class never touches issues/labels, so it's paired with an
 * `IssueProvider` (`github_provider.ts` or `jira_provider.ts`) at the CLI
 * layer.
 *
 * Auth is HTTP Basic with an Atlassian account email + API token
 * (`BITBUCKET_EMAIL` / `BITBUCKET_API_TOKEN`) — verified directly against
 * Atlassian's current docs before writing this, not assumed from training
 * data: Bitbucket Cloud app passwords are being fully removed (brownout
 * window closes July 28, 2026), so this project only supports the
 * replacement — API tokens, same auth shape as `jira_provider.ts`.
 *
 * `repo` is `"workspace/repo_slug"` (Bitbucket's own two-part identifier),
 * the same config field GitHub uses for `"owner/name"` — the shape just
 * means something different per `code_host`.
 */
import { fetchRetryTransient } from "../utils.ts";
import type { CodeHostProvider, PrRef, PrStatus } from "./provider.ts";

const API = "https://api.bitbucket.org/2.0";

interface BbPullRequest {
  id: number;
  state: "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED";
  links: { html: { href: string } };
  source: { branch: { name: string }; commit: { hash: string } };
}

interface BbCommitStatus {
  state: "SUCCESSFUL" | "FAILED" | "INPROGRESS" | "STOPPED";
}

export class BitbucketProvider implements CodeHostProvider {
  private readonly workspace: string;
  private readonly repoSlug: string;

  constructor(
    repo: string, // "workspace/repo_slug"
    private readonly email: string,
    private readonly apiToken: string,
  ) {
    const [workspace, repoSlug] = repo.split("/");
    if (!workspace || !repoSlug) throw new Error(`watch.repo ${JSON.stringify(repo)} is not "workspace/repo_slug"`);
    this.workspace = workspace;
    this.repoSlug = repoSlug;
  }

  private async bb<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchRetryTransient(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString("base64")}`,
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Bitbucket ${init?.method ?? "GET"} ${path} -> ${response.status}: ${detail.slice(0, 500)}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async openPr(opts: { branch: string; title: string; body: string; base: string }): Promise<PrRef> {
    const pr = await this.bb<BbPullRequest>(`/repositories/${this.workspace}/${this.repoSlug}/pullrequests`, {
      method: "POST",
      body: JSON.stringify({
        title: opts.title,
        description: opts.body,
        source: { branch: { name: opts.branch } },
        destination: { branch: { name: opts.base } },
      }),
    });
    return { number: pr.id, branch: opts.branch, url: pr.links.html.href };
  }

  async prStatus(pr: PrRef): Promise<PrStatus> {
    const detail = await this.bb<BbPullRequest>(`/repositories/${this.workspace}/${this.repoSlug}/pullrequests/${pr.number}`);
    let ciStatus: PrStatus["ciStatus"] = "pending";
    try {
      const statuses = await this.bb<{ values: BbCommitStatus[] }>(
        `/repositories/${this.workspace}/${this.repoSlug}/commit/${detail.source.commit.hash}/statuses?pagelen=100`,
      );
      if (statuses.values.length === 0) {
        ciStatus = "pending"; // no checks configured — never blocks a lean v1's own polling
      } else if (statuses.values.some((s) => s.state === "INPROGRESS")) {
        ciStatus = "pending";
      } else if (statuses.values.some((s) => s.state === "FAILED" || s.state === "STOPPED")) {
        ciStatus = "failure";
      } else {
        ciStatus = "success";
      }
    } catch {
      ciStatus = "pending"; // status lookup failing shouldn't block merge/close detection
    }
    return { merged: detail.state === "MERGED", state: detail.state === "OPEN" ? "open" : "closed", ciStatus };
  }
}
