/**
 * The two seams `spf watch` drives — the abstraction the user's own
 * reference implementation (a GitHub-issues SDLC poller) never had: its
 * GitHub client is a concrete class referenced by type everywhere, so
 * adding a second tracker would mean reworking the poll loop itself.
 *
 * `IssueProvider` (tracker: list/claim/transition/comment/markers) and
 * `CodeHostProvider` (PR lifecycle: open/status) are deliberately separate
 * interfaces, not one bundled seam — a tracker and a code host are
 * independent choices in practice (Jira issues against a Bitbucket repo is
 * a real setup, not a hypothetical one). `github_provider.ts`'s single
 * class implements both, since GitHub natively is both; `jira_provider.ts`
 * implements only `IssueProvider`, `bitbucket_provider.ts` only
 * `CodeHostProvider` — any tracker x host combination is just config
 * (`watch.issue_provider` x `watch.code_host`), never a poll-loop change.
 *
 * The label-as-state-machine design is deliberate, copied from that same
 * reference: `transition()` is the ONE mutator, so every state change is
 * traceable to one call site, and a provider can layer notifications
 * (Slack, a webhook, whatever) on top of it without the poll loop caring.
 */

export type WatchState = "ready" | "working" | "review" | "done" | "blocked";

export interface Issue {
  /** Opaque tracker identifier: a GitHub issue number stringified ("42"), a Jira key ("PROJ-123"). */
  id: string;
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

/** What `ensureLabels()` actually did, per label — for `spf watch init`'s report. */
export interface EnsureLabelsResult {
  created: string[];
  updated: string[];
  unchanged: string[];
}

export interface IssueProvider {
  /**
   * Idempotently seed whatever this tracker needs for the state machine to
   * work at all — GitHub: the five `<prefix>:*` labels, with a color and
   * description, created if missing and corrected if drifted. A tracker
   * with no such concept (Jira labels are freeform strings, not seedable
   * objects) can make this a no-op — `spf watch init` just reports
   * whatever comes back, empty results included.
   */
  ensureLabels(): Promise<EnsureLabelsResult>;
  /** Issues currently labeled `<prefix>:ready`. */
  listEligible(): Promise<Issue[]>;
  /**
   * Issues currently in `state`. `includeAll` queries closed issues too —
   * required for `review` on a tracker where closing an issue is a side
   * effect the tracker itself performs (GitHub auto-closes on a merged
   * `Closes #n` PR, often before the next poll tick runs); an open-only
   * query would let it vanish from tracking forever. A tracker where
   * nothing but `transition()` ever changes an issue's resolution (Jira,
   * under this design) can ignore the flag — there's no side channel to
   * miss.
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
  readMarker(issue: Issue): Promise<WatchMarker | null>;
  writeMarker(issue: Issue, marker: WatchMarker): Promise<void>;
}

/**
 * The PR-lifecycle seam, independent of `IssueProvider` — see the module
 * comment above. `openPr` takes no issue reference: cross-linking a PR to
 * its issue is the caller's job (put the issue's `id`/title in `title`/
 * `body`), not this seam's, since a code host paired with a different
 * tracker has no native "closes" convention to hook into anyway. `spf
 * watch`'s own polling (`finishReviews`), not the host's auto-close
 * behavior, is what drives `done`/`blocked` — see `watch.ts`.
 */
export interface CodeHostProvider {
  openPr(opts: { branch: string; title: string; body: string; base: string }): Promise<PrRef>;
  prStatus(pr: PrRef): Promise<PrStatus>;
}
