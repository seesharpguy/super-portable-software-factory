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
import type { CodeHostProvider, PrComment, PrRef, PrStatus } from "./provider.ts";

const API = "https://api.bitbucket.org/2.0";
/**
 * `listPrComments`'s pagination bound — this file's first pagination loop
 * (`prStatus`'s own `statuses` call takes a single `pagelen=100` page and
 * accepts truncation, since it only needs to know "is anything still
 * failing/in-progress," not the complete list). A PR's comment thread is
 * exactly where a truncated page would silently drop the corrections this
 * feature exists to read, so this one walks Bitbucket's `next` cursor,
 * capped the same defensive way GitHub's `MAX_PR_COMMENT_PAGES` is.
 */
const MAX_PR_COMMENT_PAGES = 5;

interface BbPullRequest {
  id: number;
  state: "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED";
  links: { html: { href: string } };
  source: { branch: { name: string }; commit: { hash: string } };
}

interface BbCommitStatus {
  state: "SUCCESSFUL" | "FAILED" | "INPROGRESS" | "STOPPED";
}

interface BbComment {
  id: number;
  content: { raw: string };
  user: { display_name: string } | null;
  created_on: string;
  deleted: boolean;
  inline?: { path: string; to: number | null; from: number | null } | null;
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

  /**
   * `GET /pullrequests/{id}/comments`, oldest-first (Bitbucket's own order),
   * walking `next` up to `MAX_PR_COMMENT_PAGES` — see that constant's doc
   * comment. Unlike GitHub, Bitbucket has no separate "reviews" surface: a
   * general comment and an inline/diff comment come back from the same
   * endpoint, distinguished only by whether `inline` is present, and a
   * decline/approve verdict lives on the PR's own `participants[]` (a
   * `prStatus()` concern, not this one) rather than on any comment — so
   * `verdict` is always left unset here.
   */
  async listPrComments(pr: PrRef): Promise<PrComment[]> {
    const results: PrComment[] = [];
    let path: string | null = `/repositories/${this.workspace}/${this.repoSlug}/pullrequests/${pr.number}/comments?pagelen=100`;
    for (let page = 1; path && page <= MAX_PR_COMMENT_PAGES; page++) {
      const response: { values: BbComment[]; next?: string } = await this.bb(path);
      for (const c of response.values) {
        if (c.deleted) continue;
        results.push({
          id: String(c.id),
          author: c.user?.display_name ?? "unknown",
          created_at: c.created_on,
          body: c.content.raw,
          path: c.inline?.path,
          line: c.inline?.to ?? c.inline?.from ?? undefined,
        });
      }
      if (!response.next) return results;
      // `next` is a full absolute URL — strip the API root back off so the
      // next iteration goes back through `bb()`'s own base-URL prefixing.
      path = response.next.startsWith(API) ? response.next.slice(API.length) : response.next;
      if (page === MAX_PR_COMMENT_PAGES) {
        console.error(
          `spf watch: listPrComments(PR #${pr.number}) hit the ${MAX_PR_COMMENT_PAGES}-page (${MAX_PR_COMMENT_PAGES * 100}-comment) cap — ` +
            `older comments past this cap are invisible this tick`,
        );
      }
    }
    return results;
  }
}
