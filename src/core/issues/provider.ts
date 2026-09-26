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

import type { RefinedIssue, SpecSplit } from "../data_types.ts";

/**
 * Every `kind` `IssueAuthoringProvider.createIssue` can be asked to create:
 * `RefinedIssue["kind"]` (a node in a decomposed spec's tree — never
 * includes `"spec"`, since a spec is never a node `gates.refinementWellFormed`
 * validates) plus `"spec"` itself — a spec proposed by `core/refine.ts`'s
 * `publishSpecs()` when a spec splits into several (see `WatchMarker.split`
 * below). Kept as its own union here rather than folded into
 * `RefinedIssueSchema.kind` in `data_types.ts`, because widening THAT
 * picklist would also widen what `gates.refinementWellFormed`'s
 * container/leaf derivation has to reason about for a shape ("spec") that
 * can never legally appear in a `RefineOutput.issues` tree in the first
 * place.
 */
export type IssueAuthoringKind = RefinedIssue["kind"] | "spec";

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
 * `split-proposed`/`split-approved` are a second escape hatch alongside
 * `needs-feedback`, for a different problem: not ambiguity, but a spec that
 * is honestly too big to decompose within the leaf budget (see
 * `gates.refinementWellFormed`'s budget checks). Instead of asking a
 * `questions`-shaped question, the refiner proposes splitting the spec into
 * several standalone specs (`RefineOutput.split` — see `SpecSplitSchema` in
 * `data_types.ts`); `watch.ts`'s `proposeSpecSplit` records the proposal in
 * `WatchMarker.split` and moves the spec to `split-proposed`. A human reviews
 * the proposal comment and either adds `split-approved` (executed
 * deterministically, no agent re-run — `watch.ts`'s `executeApprovedSplits`)
 * or answers inline and adds `continue-refinement` to have the refiner
 * revise its proposal. Deliberately a DIFFERENT label from
 * `continue-refinement`'s own approval path: approving a split is an
 * instruction to CODE ("go create these"), not new information a refiner
 * session needs to reason about, so it skips the agent entirely.
 *
 * `feedback` is the BUILD lane's own human-in-the-loop escape hatch, added
 * later and modeled directly on `needs-feedback`/`continue-refinement`
 * above — but simpler, because it's one label instead of two: a declined PR
 * already tells the human "spf needs you" (`blocked`, plus an invite
 * comment naming the PR — see `finishReviews` in `watch.ts`), so there's no
 * separate "spf asked a question" state to enter first. A human leaves
 * corrections as COMMENTS ON THE PR (not the issue — see
 * `CodeHostProvider.listPrComments` below) and adds `<prefix>:feedback`;
 * `claimFeedback` (`watch.ts`) claims `feedback -> working` and reruns the
 * SAME issue (deterministic adw_id `issue-<id>`, exactly like a fresh
 * claim) with the PR's comment thread folded into the prompt
 * (`buildIssuePrompt`). Unlike the refine lane's loop, this can fire against
 * a PR that's still OPEN, not only a closed/declined one — the primary use
 * case is "leave a review comment on the open PR, then add the label,"
 * updating that same PR in place; a declined PR instead gets a fresh
 * `-rN`-suffixed branch and a new PR (see `branchNameFor`'s `round`
 * parameter and `openPrForWinner`'s `existingPr` option). See
 * `WatchMarker.revision` for the round/watermark bookkeeping this shares
 * conceptually with `WatchMarker.feedback`, kept as a separate field because
 * the two lanes' watermark semantics differ (a build revision's `since` is
 * "when we last pushed," not "when we last asked a question").
 *
 * All fourteen still live in one `WatchState` union (not several separate
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
  | "feedback"
  | "spec-ready"
  | "refining"
  | "refined"
  | "needs-feedback"
  | "continue-refinement"
  | "spec-in-progress"
  | "split-proposed"
  | "split-approved";

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
 * One comment (or review) read back off a PR — the build lane's own
 * `IssueComment` twin (see `IssueProvider.listComments`), for
 * `CodeHostProvider.listPrComments` below. `path`/`line` are set only for an
 * inline/diff-anchored comment, when the host reports one; `verdict` is set
 * only where the host distinguishes a review decision from a plain comment
 * (GitHub: `APPROVED`/`CHANGES_REQUESTED`/`COMMENTED`/`DISMISSED`; Bitbucket
 * has no such concept on a comment, so it's always absent there).
 */
export interface PrComment {
  id: string;
  author: string;
  created_at: string;
  body: string;
  path?: string;
  line?: number;
  verdict?: string;
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
 *
 * `split` is the recorded proposal behind `split-proposed` /
 * `split-approved` (see `WatchState`'s doc comment above): the exact specs
 * `watch.ts`'s `proposeSpecSplit` posted as a comment, so a human's approval
 * executes precisely what they read rather than whatever the marker happens
 * to hold by the time `executeApprovedSplits` runs. `rounds` mirrors
 * `feedback.rounds` — how many times this spec has been through the
 * propose/revise loop, for the same "answered after N rounds" summary-comment
 * purpose.
 *
 * `revision` is the BUILD lane's own cursor, the `feedback` field's build-lane
 * twin (see `WatchState`'s `feedback` doc comment above) but with different
 * watermark semantics: `since` is stamped on every PUSH (`openPrForWinner`),
 * not on every question asked — "PR comments at or after this timestamp are
 * corrections on the current state of the PR," which is also correct for a
 * developer who comments and declines BEFORE spf ever posts an invite (there
 * is no invite to time against, only the last push). `rounds` both counts
 * revisions for logging and — on a declined PR, where a fresh branch is
 * required — names the branch suffix (`branchNameFor`'s `round` parameter).
 * A separate field from `feedback` rather than a shared one because the two
 * lanes' claims never touch the same field name on the same code path, and
 * `reconcileOrphans`/`reconcileRefining` would otherwise have to disambiguate
 * which lane a shared field belonged to.
 *
 * `chain` is set only when the Jev chain router (`watch.chains`, #107)
 * routed this issue to a chain OTHER than `watch.chain`: the chain that
 * built the PR. A `feedback` revision rebuilds with it (when it is still
 * allowlisted) instead of `watch.chain`, deterministically and without
 * asking Jev again, so a revision never switches workflows under a PR.
 * Absent — every marker written by a daemon with no routing — means
 * `watch.chain`, exactly as before the field existed.
 */
export interface WatchMarker {
  worktree?: string;
  branch?: string;
  pr?: number;
  attempt?: number;
  refined?: string[];
  feedback?: { rounds: number; asked_at: string };
  split?: { specs: SpecSplit[]; proposed_at: string; rounds: number };
  revision?: { rounds: number; since: string };
  chain?: string;
  /**
   * Set only by the Jev intake readiness router (`watch.ts`'s
   * `routeReadiness`, #108) when it moved a `ready` issue AWAY from the
   * build lane (`refine` -> `spec-ready`, `needs_human` -> `blocked`). Its
   * mere presence — like any marker at all — makes the router stand down on
   * that issue for good: a human who relabels it `ready` has overruled the
   * router, and the next claim builds it as-is. Overwritten (dropped) by the
   * build lane's own claim-time marker write, like every other lane field.
   */
  intake?: { routed: "refine" | "needs_human"; at: string };
  /**
   * Set only by the Jev intake feedback classifier (`watch.ts`'s
   * `classifyFeedback`, #108) when an act-mode answer other than `revise`
   * declined to rerun the chain: the decision `key` it answered
   * (`pr<n>:r<round>:<last comment id>`) and that answer. A later
   * `<prefix>:feedback` claim whose key is the SAME — the human re-added the
   * label without writing a new PR comment — is the human overruling the
   * classifier, so it revises with no Jev call (the readiness router's own
   * "speaks once" rule). Written over the prior marker with every other
   * field kept; dropped by the revision run's own marker write, whose new
   * round changes the key anyway.
   */
  intake_feedback?: { key: string; intent: "question" | "approve" | "out_of_scope"; at: string };
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
  /**
   * Every comment/review left on a PR, oldest-first — the build lane's
   * `feedback` revision loop's one read (see `WatchState`'s `feedback` doc
   * comment, `watch.ts`'s `claimFeedback`/`buildIssuePrompt`). OPTIONAL, same
   * pattern as `IssueProvider.closeIssue?`/`IssueAuthoringProvider`: not
   * every code host can list PR comments cheaply (there is none that
   * genuinely can't today — GitHub and Bitbucket both implement it — but the
   * seam stays optional so a future minimal host isn't forced to). A host
   * that omits this makes `feedback` an honest dead end: `claimFeedback`
   * blocks the issue again with an explanation rather than silently running
   * with no corrections.
   */
  listPrComments?(pr: PrRef): Promise<PrComment[]>;
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
  createIssue(input: { title: string; body: string; labels: string[]; kind: IssueAuthoringKind }): Promise<Issue>;
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
  /**
   * Best-effort: relate a freshly published tree's ROOT issue back to the
   * spec issue (`specId`) it was refined FROM — `core/refine.ts`'s
   * `publish()` calls this once per root node (a node with no `parent` of
   * its own within the refined tree) when it was given a `specIssueId`.
   *
   * Deliberately NOT `linkChild`: that method sets the tracker's
   * HIERARCHY field (Jira's `parent`, GitHub's sub-issues API), and a
   * spec's own issue type (Story by default — `JiraIssueTypeMapSchema.spec`)
   * frequently cannot legally PARENT a root node's type in Jira's
   * issue-type hierarchy — see `JiraProvider`'s own doc comment on
   * `publishSpecs()` for the same constraint. `linkToSpec` uses a plain,
   * symmetric issue-to-issue reference instead (Jira's generic "issue
   * link"), which has no such hierarchy restriction.
   *
   * OPTIONAL, not every tracker needs one: GitHub already gets a native,
   * visible cross-reference for free the moment `renderBody`'s "## Parent"
   * section renders a plain "#N" in the body — GitHub auto-links same-repo
   * issue mentions into a real timeline "referenced this issue" event, no
   * API call required. Jira does not do this for plain text, which is why
   * `JiraProvider` implements this and `GitHubProvider` does not.
   */
  linkToSpec?(specId: string, issue: Issue): Promise<void>;
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
