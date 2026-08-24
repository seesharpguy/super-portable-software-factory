/**
 * The seams `spf watch` drives — the abstraction the user's own reference
 * implementation (a GitHub-issues SDLC poller) never had: its GitHub client
 * is a concrete class referenced by type everywhere, so adding a second
 * tracker would mean reworking the poll loop itself.
 *
 * `IssueProvider` (tracker: list/claim/transition/comment/markers) and
 * `CodeHostProvider` (PR lifecycle: open/status) are deliberately separate
 * interfaces, not one bundled seam — a tracker and a code host are
 * independent choices in practice (Jira issues against a Bitbucket repo is
 * a real setup, not a hypothetical one). `github_provider.ts`'s single
 * class implements all three (GitHub natively is a tracker, a code host,
 * AND an authoring API); `jira_provider.ts` implements `IssueProvider` and
 * `IssueAuthoringProvider` (Jira is a tracker and can author, but never
 * opens PRs); `bitbucket_provider.ts` only `CodeHostProvider` — any tracker
 * x host combination is just config (`watch.issue_provider` x
 * `watch.code_host`), never a poll-loop change.
 * `IssueAuthoringProvider` (create/link, at the bottom of this file) is a
 * third, again separate — the refine lane's own need, optional per tracker
 * (not every tracker's write API can author + link a hierarchy), and
 * orthogonal to which one is the code host. `isAuthoringProvider()` (below)
 * is how the rest of the codebase asks "can this provider author?" without
 * caring which concrete class answers yes.
 *
 * The label-as-state-machine design is deliberate, copied from that same
 * reference: `transition()` is the ONE mutator, so every state change is
 * traceable to one call site, and a provider can layer notifications
 * (Slack, a webhook, whatever) on top of it without the poll loop caring.
 */

import type { RefinedIssue } from "../data_types.ts";

/**
 * `spec-ready`/`refining` drive the SECOND lane's state machine (a product
 * spec being decomposed — see `reconcileRefining`/`claimSpecs` in
 * `watch.ts`), independent of the build lane's own `ready..blocked` states.
 * `refined` is not a lane state at all — it never appears on the left of a
 * `transition()` call. It is the terminal label a generated LEAF issue
 * (story/bug/task) gets, marking it awaiting a human's promotion to `ready`.
 *
 * `needs-feedback`/`continue-refinement` are the refine lane's human-in-the-
 * loop loop, layered onto the same three states: a `refining` run whose
 * refiner raised material ambiguity (see `RefineOutput.questions`) posts its
 * questions and moves the spec to `needs-feedback` (`watch.ts`'s
 * `escalateSpec`) instead of either finishing or blocking. A human answers in
 * the issue's comments, then adds `continue-refinement` — `claimSpecs`
 * accepts an optional `from` state precisely so it can claim
 * `continue-refinement -> refining` the same way it claims
 * `spec-ready -> refining`, resuming the SAME `adw_id` (deterministic from
 * the issue id) with the comment thread folded into the prompt. This can
 * loop any number of rounds; there is no cap.
 *
 * `spec-in-progress` is where a spec lands once it's been decomposed and
 * published — deliberately NOT `done` yet: a product manager watching this
 * spec's status must not see "done" until every issue the refiner produced
 * (every story/bug/task, and every feature/epic container once its own
 * children finish — see `rollUp` in `watch.ts`) is itself `<prefix>:done`.
 * `announceRefined` (`watch.ts`) makes the move `refining -> spec-in-progress`
 * once publish succeeds; `finishTrackedSpecs` (`watch.ts`) polls every
 * `spec-in-progress` spec each tick and moves it the rest of the way,
 * `-> done`, once `WatchMarker.refined` is entirely `<prefix>:done`.
 *
 * All eleven still live in one `WatchState` union (not several separate
 * unions) because `transition()`'s "strip every `<prefix>:<state>` label,
 * then add one" logic (see `github_provider.ts`/`jira_provider.ts`) has to
 * know about every one of them to strip correctly, and `ensureLabels()`
 * seeds all of them from one `STATES` array.
 */
export type WatchState =
  | "ready"
  | "working"
  | "review"
  | "done"
  | "blocked"
  | "spec-ready"
  | "refining"
  | "refined"
  | "needs-feedback"
  | "continue-refinement"
  | "spec-in-progress";

export interface Issue {
  /** Opaque tracker identifier: a GitHub issue number stringified ("42"), a Jira key ("PROJ-123"). */
  id: string;
  title: string;
  body: string;
  labels: string[];
  /**
   * The tracker's own internal/database id, distinct from `id` (the
   * human-facing number/key) — only populated where an authoring operation
   * needs it. GitHub's sub-issue API is the reason this exists: `POST
   * /repos/{o}/{r}/issues/{n}/sub_issues` takes `sub_issue_id` as the
   * issue's database id, not its issue number, so `linkChild()` cannot work
   * from `id` alone. `undefined` on any issue this provider didn't just
   * create/fetch with that field available.
   */
  internal_id?: string;
}

/** One comment on an issue, as read back for the refine lane's escalation loop — see `IssueProvider.listComments`. */
export interface IssueComment {
  id: string;
  /** Display handle — GitHub's `user.login`, Jira's `author.displayName`. */
  author: string;
  /** ISO 8601, verbatim from the tracker. */
  created_at: string;
  body: string;
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
 * `refined` is the refine lane's own idempotency record: the ids of every
 * issue a completed publish pass created for this spec. A re-claimed spec
 * whose marker already lists them skips creation entirely — `to-tickets`
 * (the skill this lane's prompt is ported from) has no such guard and
 * duplicates every ticket on a re-run; this is what closes that gap. It does
 * double duty once the spec reaches `spec-in-progress`: `finishTrackedSpecs`
 * (`watch.ts`) reads this same list back to check whether every one of them
 * is `<prefix>:done` yet — the gate on the spec's OWN move to `done`.
 *
 * `feedback` is the refine lane's human-in-the-loop cursor: `rounds` counts
 * how many times this spec has been escalated (so a resumed run's summary
 * comment can say "answered after 2 rounds"), and `asked_at` is the ISO
 * timestamp of the most recent question comment — `watch.ts`'s
 * `buildSpecPrompt` uses it to split the issue's comment thread into
 * "answers to the open questions" versus "earlier discussion" when building
 * the resumed run's prompt.
 */
export interface WatchMarker {
  worktree?: string;
  branch?: string;
  pr?: number;
  attempt?: number;
  refined?: string[];
  feedback?: { rounds: number; asked_at: string };
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
   * work at all — GitHub: every `<prefix>:*` state label plus the
   * `<prefix>:type:*` vocabulary the refine lane's generated issues carry,
   * each with a color and description, created if missing and corrected if
   * drifted. A tracker with no such concept (Jira labels are freeform
   * strings, not seedable objects) can make this a no-op — `spf watch init`
   * just reports whatever comes back, empty results included.
   */
  ensureLabels(): Promise<EnsureLabelsResult>;
  /** Issues currently labeled `<prefix>:ready`. */
  listEligible(): Promise<Issue[]>;
  /**
   * One issue by its tracker-facing id, or `null` if it no longer exists
   * (deleted, or — on a tracker where a closed item 404s a plain fetch —
   * closed). The frontier check needs this on every tracker (`claimNewWork`
   * in `watch.ts` calls it once per distinct `blocked_by` id per tick, to
   * decide whether a leaf's blockers all carry `<prefix>:done`), so unlike
   * `IssueAuthoringProvider`'s methods below, this is required, not optional.
   */
  getIssue(id: string): Promise<Issue | null>;
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
   * Move `opts.from` (default `ready`) -> `opts.to` (default `working`),
   * with a read-back verify (like the reference implementation's
   * `claimIssue`) — not a true atomic claim, but enough to catch the common
   * case; the real safety net against two daemons racing the same issue is
   * `spf watch`'s own single-instance lockfile. Parameterized so the refine
   * lane's `spec-ready -> refining` claim (see `claimSpecs` in `watch.ts`)
   * reuses the identical DELETE-from/POST-to/read-back-verify dance the
   * build lane's `ready -> working` claim already does, rather than a
   * second copy of it per provider.
   */
  claim(issue: Issue, opts?: { from?: WatchState; to?: WatchState }): Promise<boolean>;
  /** The one state-mutating call. `detail`, if given, is also posted as a comment. */
  transition(issue: Issue, to: WatchState, detail?: string): Promise<void>;
  comment(issue: Issue, body: string): Promise<void>;
  readMarker(issue: Issue): Promise<WatchMarker | null>;
  writeMarker(issue: Issue, marker: WatchMarker): Promise<void>;
  /**
   * Oldest-first, the hidden marker comment excluded — the refine lane's
   * escalation loop reads a human's answers back out of the thread (see
   * `watch.ts`'s `buildSpecPrompt`). Every other seam on this interface is
   * write-only towards comments (`comment()`, and `transition()`'s own
   * `detail`); this is the one read.
   */
  listComments(issue: Issue): Promise<IssueComment[]>;
  /**
   * Close the issue as completed, where the tracker has such a concept.
   * Optional, like `IssueAuthoringProvider`'s methods below: the label IS the
   * state machine (see `transition()` above), and closing is a courtesy on
   * top of `<prefix>:done`, never something `spf watch` itself reads back —
   * a tracker (or a caller) that skips this leaves the spec `done` and open,
   * exactly as every state before this feature existed already behaved.
   */
  closeIssue?(issue: Issue): Promise<void>;
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

/**
 * The third seam: creating issues and linking them into a hierarchy — what
 * the refine lane needs and neither `IssueProvider` nor `CodeHostProvider`
 * provides (a tracker's read/claim/transition surface has no reason to
 * create new work items). Kept separate rather than folded into
 * `IssueProvider` for the same reason `CodeHostProvider` is separate: not
 * every tracker can do this — GitHub and Jira both implement it today
 * (GitHub via sub-issues, Jira via native issue types + the `parent`
 * field), Bitbucket does not — and a tracker that can't should be
 * recognized as such via `isAuthoringProvider()` (below), not a method
 * that throws at call time.
 */
export interface IssueAuthoringProvider {
  createIssue(input: { title: string; body: string; labels: string[]; kind: RefinedIssue["kind"] }): Promise<Issue>;
  /** Link `child` under `parent` using the tracker's native hierarchy — GitHub's sub-issues API, Jira's `parent` field. */
  linkChild(parent: Issue, child: Issue): Promise<void>;
  /**
   * Read back what `linkChild` wrote — every issue currently linked under
   * `parent`. What makes container roll-up possible at all (`rollUp` in
   * `watch.ts`: a container is `done` once every one of these carries
   * `<prefix>:done`); lives here rather than on `IssueProvider` for the same
   * reason `linkChild` does — a tracker's plain list/claim/transition surface
   * has no reason to know about a hierarchy it may not even have. A tracker
   * without this (Bitbucket-as-issue-tracker isn't a real combination this
   * codebase supports, so in practice: any provider that isn't `IssueAuthoringProvider`
   * at all) makes roll-up a logged no-op, not a startup failure the way
   * `watch.refine.enabled` without ANY authoring support is
   * (`cli/commands/watch.ts`) — the build lane still functions without
   * roll-up, refine cannot function without authoring at all.
   */
  listChildren(parent: Issue): Promise<Issue[]>;
}

/**
 * Structural, not nominal: checks for the three methods rather than
 * `instanceof SomeConcreteClass` — so a new authoring-capable provider is
 * recognized automatically everywhere this is used (today: `cli/commands/
 * watch.ts`'s container-roll-up wiring) without an edit to an `instanceof`
 * chain. Every current implementer (`GitHubProvider`, `JiraProvider`)
 * satisfies `IssueProvider` too, so the intersection type is sound in
 * practice, not just at the type level.
 */
export function isAuthoringProvider(provider: IssueProvider): provider is IssueProvider & IssueAuthoringProvider {
  const candidate = provider as Partial<IssueAuthoringProvider>;
  return typeof candidate.createIssue === "function" && typeof candidate.linkChild === "function" && typeof candidate.listChildren === "function";
}
