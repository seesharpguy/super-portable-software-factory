/**
 * The issue-tracker seam `spf watch` drives — the abstraction the user's own
 * reference implementation (a GitHub-issues SDLC poller) never had: its
 * GitHub client is a concrete class referenced by type everywhere, so
 * adding a second tracker would mean reworking the poll loop itself. Here,
 * nothing outside `github_provider.ts` (or a future `jira_provider.ts`)
 * knows it's talking to GitHub.
 *
 * The label-as-state-machine design is deliberate, copied from that same
 * reference: `transition()` is the ONE mutator, so every state change is
 * traceable to one call site, and a provider can layer notifications
 * (Slack, a webhook, whatever) on top of it without the poll loop caring.
 */

export type WatchState = "ready" | "working" | "review" | "done" | "blocked";

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export interface PrRef {
  number: number;
  branch: string;
  url: string;
}

export interface PrStatus {
  merged: boolean;
  state: "open" | "closed";
  ciStatus: "pending" | "success" | "failure";
}

/**
 * The durable scratch state for one issue, stored as a hidden HTML comment
 * on the issue itself — zero infrastructure, survives a daemon crash,
 * human-readable. `attempt` bounds orphan-retry (see `watch.ts`); `ciFixes`
 * is reserved for a future fix-loop, unused by the lean v1 poll logic.
 */
export interface WatchMarker {
  worktree?: string;
  branch?: string;
  pr?: number;
  attempt?: number;
}

export interface IssueProvider {
  /** Issues currently labeled `<prefix>:ready`. */
  listEligible(): Promise<Issue[]>;
  /**
   * Issues currently in `state`. `includeAll` queries closed issues too —
   * required for `review`, since GitHub (or any tracker with a `Closes #n`
   * convention) can auto-close an issue the instant its PR merges, often
   * before the next poll tick runs; an open-only query would let it vanish
   * from tracking forever.
   */
  listInState(state: WatchState, opts?: { includeAll?: boolean }): Promise<Issue[]>;
  /**
   * Move `ready` -> `working`, with a read-back verify (like the reference
   * implementation's `claimIssue`) — not a true atomic claim, but enough to
   * catch the common case; the real safety net against two daemons racing
   * the same issue is `spf watch`'s own single-instance lockfile.
   */
  claim(issue: Issue): Promise<boolean>;
  /** The one state-mutating call. `detail`, if given, is also posted as a comment. */
  transition(issue: Issue, to: WatchState, detail?: string): Promise<void>;
  comment(issue: Issue, body: string): Promise<void>;
  openPr(issue: Issue, opts: { branch: string; title: string; body: string; base: string }): Promise<PrRef>;
  prStatus(pr: PrRef): Promise<PrStatus>;
  readMarker(issue: Issue): Promise<WatchMarker | null>;
  writeMarker(issue: Issue, marker: WatchMarker): Promise<void>;
}
