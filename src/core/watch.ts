/**
 * The `spf watch` state machine — two lanes over the same poll loop.
 *
 * The build lane: poll -> claim -> run a chain -> PR -> done/blocked.
 * The refine lane (`watch.refine.enabled`, off by default): poll a
 * `spec-ready` product spec -> claim -> decompose it into a feature/story
 * tree -> publish those as real issues -> done/blocked. A spec is not
 * individually workable, so this lane never opens a PR — it hands the build
 * lane its next batch of `ready`-able work instead (see `core/refine.ts`).
 * When the refiner raises material ambiguity instead of a tree, this lane
 * loops through a human instead of guessing or blocking: `escalateSpec`
 * posts the questions and moves the spec to `needs-feedback`; a human
 * answers in the issue's comments and adds `continue-refinement`;
 * `claimSpecs` resumes it — the SAME `adw_id`, comment thread folded into
 * the prompt (`buildSpecPrompt`) — for as many rounds as it takes. See
 * `provider.ts`'s `WatchState` doc comment for the full state diagram.
 *
 * Provider-agnostic (drives whatever `IssueProvider` it's given) and
 * chain-agnostic (drives whatever `runChain`/`runRefine` callback it's
 * given) — deliberately kept out of `src/chains/`'s dependency direction,
 * so this stays testable against a fake provider and fake callbacks with no
 * chain registry involved.
 *
 * Design lifted from the user's own GitHub-poller reference implementation
 * (a label-as-state-machine daemon), leaned down for a v1: no per-issue
 * telemetry, no dashboard, no Projects v2 mirroring, no CI-fix retry loop,
 * no auto-merge. What's kept, because it's cheap and load-bearing:
 *
 *  - `transition()` is the ONE state mutator (see `provider.ts`) — every
 *    state change traces to one call site.
 *  - A marker (a hidden HTML comment on the issue) is the durable scratch
 *    state — zero infrastructure, survives a daemon crash.
 *  - `listInState("review", {includeAll: true})` — a tracker that
 *    auto-closes an issue the instant its linked PR merges (GitHub's
 *    `Closes #n`) can make it vanish from an open-only query before the
 *    next tick runs.
 *  - Orphan reconciliation: any `working` issue this process isn't
 *    tracking gets one of three outcomes (resume via its marker's PR,
 *    retry up to a cap, or give up and block) every tick — a hung daemon
 *    restart never leaves an issue silently stuck.
 *  - Worktree-per-issue, isolated outside the repo, made cheap by SPF's
 *    own `--cwd` support: no new chain-dispatch plumbing needed, just
 *    pointing an existing chain at a different working tree.
 *
 * What's NEW since the lean v1 above: `claimNewWork` no longer walks
 * `listEligible()` in whatever order the tracker happened to return —
 * `orderEligible` sorts by priority (a `<prefix>:priority:pN` label), then
 * sibling affinity (prefer a leaf whose parent already has work in flight),
 * then creation order; and it refuses to claim a leaf whose `blocked_by`
 * isn't fully `<prefix>:done` yet (`frontierBlockedOn`) — making real, at
 * last, the frontier `assets/prompts/refiner/system.md` has always promised
 * the refiner. `finishReviews` also now closes a landed leaf and rolls a
 * container up to `done` + closed once every child under it carries
 * `<prefix>:done` (`rollUp`) — still no Projects v2 mirroring, no CI-fix
 * retry loop, no auto-merge; those remain deliberately out of scope.
 */
import path from "node:path";
import type { GitHandle } from "./git_helper.ts";
import { attemptAdwId, attemptBranch, attemptWorktreePath, runBestOf, type AttemptDispatch, type AttemptMetrics } from "./fanout.ts";
import type { CodeHostProvider, Issue, IssueComment, IssueProvider, WatchMarker, WatchState } from "./issues/provider.ts";
import type { NotifyEvent } from "./notify/channel.ts";
import { PRIORITY_RANK, type RefinedPriority } from "./data_types.ts";
import { redact } from "./otel.ts";
import { parseRefineMarker } from "./refine.ts";
import { acquirePidLock, newId, releasePidLock } from "./utils.ts";

const MAX_ORPHAN_ATTEMPTS = 2;
/** GitHub's own documented sub-issue nesting cap (see `github_provider.ts`'s `linkChild` doc comment) — `rollUp`'s own recursion bound, so a malformed/cyclic hierarchy can't spin forever. */
const MAX_ROLLUP_DEPTH = 8;
/** Twin of `MAX_N` in `cli/commands/fanout.ts` — the fan-out lane's own attempt-count ceiling (`watch.fanout.n`'s schema bound), duplicated as a literal so the pre-sweep (§8.5) can size itself without importing a CLI command module. */
const MAX_FANOUT_N = 8;
/** §8.7's salt ceiling — and therefore §8.5's sweep range too. Bounds an otherwise-unbounded probe/sweep against an issue fanned out over and over. */
const MAX_FANOUT_SALT = 8;

export interface ChainRunResult {
  accepted: boolean;
  adwId: string;
  /** Shown to the engineer via a `blocked` comment on a failed/no-op run. */
  detail: string;
  /**
   * A short, already-sanitized/truncated digest of the reviewer's verdict
   * (approved/blocking/findings), read back best-effort from the sessions DB
   * — see `cli/commands/watch.ts`'s `runChain`. `undefined` when the chain
   * that ran has no reviewer step, or the DB read/parse failed; `runIssue`
   * below falls back to `reviewRequired` to tell those two apart in the PR
   * body and `pr_opened` notification.
   */
  reviewSummary?: string;
  /** Whether the chain that ran declares a "reviewer" in its `requiredAgents` — distinguishes "reviewer approved" from "nothing reviewed this change" when `reviewSummary` is absent. */
  reviewRequired?: boolean;
}

/** One issue the refine lane created — enough for `announceRefined`'s summary comment and the marker's idempotency record. */
export interface RefinedIssueRef {
  id: string;
  title: string;
  kind: string;
  isLeaf: boolean;
}

/**
 * One open question the refiner raised instead of a tree — mirrors
 * `RefineQuestionSchema` (`core/data_types.ts`) field-for-field, kept as its
 * own local shape rather than importing that type, the same way
 * `RefinedIssueRef` above mirrors `RefinedIssue` rather than importing it:
 * this module stays deliberately decoupled from the chain layer (see the
 * module doc comment), reading only what `escalateSpec`'s comment needs.
 */
export interface RefinedQuestionRef {
  id: string;
  question: string;
  why_it_matters: string;
  options: string[];
  recommendation: string;
  evidence: string[];
}

export interface RefineRunResult {
  accepted: boolean;
  adwId: string;
  /** Shown to the engineer via a `blocked` comment on a failed/no-op run. */
  detail: string;
  /** What `steps.publishIssues()` created, read back from its side-channel file — see `cli/commands/watch.ts`'s `runRefine`. Empty when `!accepted` or when the run escalated instead of publishing. */
  created: RefinedIssueRef[];
  /** What the refiner is asking, read back from its own side-channel file — see `cli/commands/watch.ts`'s `runRefine`. Empty when `!accepted` or when the run published a tree instead of escalating; `gates.refinementWellFormed` guarantees `created` and `questions` are never both non-empty. */
  questions: RefinedQuestionRef[];
}

/**
 * The fan-out lane's injected trio + the two values `WatchDeps` cannot derive.
 * Exported as a NAMED type (not an inline object literal) because
 * `cli/commands/watch.ts`'s `makeWatchFanoutDispatch` factory returns it and
 * `src/test/watch_fanout_sandbox_wiring.test.ts` names it — an inline literal
 * would have to be duplicated in three places.
 */
export interface WatchFanoutDeps {
  /** > 1. `cli/commands/watch.ts` passes `undefined` for this whole object when `watch.fanout.n` is 1. */
  n: number;
  /** Attempts IN FLIGHT within one issue — NOT `WatchDeps.concurrency`, which counts issues. Does NOT bound worktrees on disk (see the module's fan-out doc). */
  concurrency: number;
  /** The MAIN repo root. `GitHandle` has no accessor for it — `cli/commands/watch.ts` passes its anchor's `repo_root`, the same value `deps.git` is bound to. */
  repoRoot: string;
  /** One attempt's chain, in that attempt's own worktree — the same ctx `runChain` builds, per attempt. */
  runAttempt: (dispatch: AttemptDispatch) => Promise<number>;
  /** Gate/usage rows for one attempt's adw_id, from the SHARED db. Must not throw. */
  readMetrics: (adwId: string) => AttemptMetrics;
  /**
   * True when NOT ONE of these adw_ids has a session row yet — the same db,
   * the same predicate and the same reasoning as `spf fanout`'s reuse
   * preflight (`cli/commands/fanout.ts`, `preflight.session(id) !== null`).
   * This is what advances the fan-out lane's base-adw_id salt on EVERY claim
   * (see `runIssueFanout`'s salt probe) — the sessions the previous claim's
   * attempts left behind are the only thing that reliably changes on every
   * re-claim, unlike `WatchMarker.attempt`, which only advances on the
   * orphan-retry path.
   *
   * Must not throw, and its safe direction is FALSE: a db it cannot read
   * reports "taken", which burns an id and keeps the selection basis clean,
   * rather than reporting "free" and letting a previous run's rows decide
   * this run's winner.
   */
  adwIdsFree: (adwIds: string[]) => boolean;
  /** The winner's review posture, read back post-hoc — the same two fields `runChain` returns, keyed on a WINNER instead of the sole attempt. */
  reviewFor: (opts: { cwd: string; adwId: string; chainOptions: Record<string, string> }) => { reviewRequired: boolean; reviewSummary?: string };
}

export interface WatchDeps {
  provider: IssueProvider;
  codeHost: CodeHostProvider;
  git: GitHandle; // bound to the main repo root
  /** Bound to a specific worktree path (diffFiles/push run there) — inject `git_helper.makeGit` for real use, a fake for tests. */
  worktreeGit: (worktreePath: string) => GitHandle;
  labelPrefix: string;
  chain: string;
  baseBranch: string;
  concurrency: number;
  /**
   * `watch.chain_options` (see `WatchConfigSchema`'s doc comment) — passed
   * unchanged into both `runChain`'s and `runRefine`'s opts below, exactly
   * like `spf <chain> --suite <name>` builds an options map for an
   * interactive dispatch (`cli/commands/run.ts`). Fixes the KNOWN
   * LIMITATION from PR #20: an unattended `spf watch` dispatch used to call
   * `runChainDef` with no options at all, so nothing --suite-shaped could
   * ever reach it. One shared map for both lanes — `spf watch` has no
   * separate `refine.chain_options` today.
   */
  chainOptions: Record<string, string>;
  /**
   * The second lane — decomposing a `<prefix>:spec-ready` product spec
   * instead of building a `<prefix>:ready` issue. `false` (the default) is
   * a complete no-op: `claimSpecs`/`reconcileRefining` return immediately,
   * so an existing `spf watch` config sees no new poll traffic at all until
   * this is turned on. See `WatchConfigSchema`'s `refine` field.
   */
  refineEnabled: boolean;
  refineConcurrency: number;
  refineChain: string;
  /** Same shape as `runChain`, for the refine lane — see its own doc comment for why the two aren't unified into one callback. */
  runRefine: (opts: { prompt: string; cwd: string; adwId: string; issueId: string; chainOptions: Record<string, string> }) => Promise<RefineRunResult>;
  worktreesDir: string; // OUTSIDE the repo — see module doc comment
  /**
   * Symlink (or otherwise wire up) `<worktreePath>/.spf/data` to the MAIN
   * repo's own persistent data_dir, called once per worktree right after
   * it's created. Without this, a chain run's session/trace data resolves
   * relative to `cwd` (the worktree — see ChainContext's doc comment) and
   * lands in a fresh, throwaway `.spf/data` that `cleanupWorktree` deletes
   * along with the rest of the worktree once the issue finishes: no trace
   * in `spf ui`, and no trace anywhere at all after cleanup. Injected (not
   * called directly) so watch.ts's own tests never touch the real
   * filesystem for it.
   */
  linkDataDir: (worktreePath: string) => void;
  dryRun: boolean;
  runChain: (opts: { prompt: string; cwd: string; adwId: string; chainOptions: Record<string, string> }) => Promise<ChainRunResult>;
  /**
   * `IssueAuthoringProvider.listChildren`'s read-back, injected as a bound
   * function rather than a whole provider object — same reasoning as
   * `runChain`/`runRefine`/`linkDataDir`: this module drives whatever it's
   * given without importing a concrete provider type. `undefined` on any
   * tracker that doesn't implement `IssueAuthoringProvider` (Jira today —
   * see `jira_provider.ts`'s module comment); `rollUp` treats that as a
   * logged no-op, not a failure — the build lane still functions without
   * container roll-up, unlike the refine lane, which cannot function
   * without authoring at all (see `cli/commands/watch.ts`'s startup check).
   */
  listChildren?: (parent: Issue) => Promise<Issue[]>;
  log: (message: string) => void;
  /**
   * Structured push, alongside `log`'s plain string — a required field, like
   * `log`, so a test must consciously supply one (a no-op fake is fine).
   * Fired only at meaningful state transitions (claim, PR, done, blocked,
   * error) — NOT at routine self-healing (an orphan resume/retry, a lost
   * claim race, a cleanup warning), which recovers on its own and would
   * just be noise in a channel.
   */
  notify: (event: NotifyEvent) => void;
  /**
   * Best-of-N per claimed issue (`watch.fanout`). `undefined` — the default,
   * and what every existing test constructs — means single dispatch:
   * `runIssue` takes the path it always has.
   *
   * ONE OPTIONAL OBJECT, not several optional fields: everything the fan-out
   * lane needs is required WHEN THE LANE IS ON and meaningless when it is
   * off, so the optionality belongs at the lane, not at each field. There is
   * no "optional but secretly required" member to get wrong.
   */
  fanout?: WatchFanoutDeps;
}

export interface WatchRunState {
  inflight: Set<string>;
  /**
   * Separate from `inflight` — not a defensive copy of the same set, a
   * genuinely different budget. The refine lane's `claimSpecs` caps against
   * `refineConcurrency`, independent of the build lane's `concurrency`; a
   * shared set would conflate "how many specs are being refined" with "how
   * many issues are being built" and make either budget impossible to
   * enforce on its own. The two never collide on an id in practice (a
   * `spec-ready` issue and a `ready` issue are never the same issue), but
   * that isn't why this is separate — the budgets are what require it.
   */
  refining: Set<string>;
  /**
   * Issue id -> its container's real issue id, recorded the moment
   * `claimNewWork` claims a leaf whose hidden `spf-refine:` marker names a
   * parent, deleted in the same `.finally()` that clears `inflight`. Zero
   * API cost — no tracker read needed to populate it — and it's the whole
   * basis of sibling affinity in `orderEligible`: a sibling of something
   * already in flight sorts ahead of an equal-priority issue from an
   * unrelated feature, so a feature already underway tends to finish before
   * the daemon starts a new one instead of interleaving both. This holds
   * only while a sibling is ACTUALLY in flight — a daemon restart begins
   * with this empty, so ordering falls back to priority + created-asc until
   * the in-memory picture rebuilds itself over the next few ticks.
   */
  inflightParents: Map<string, string>;
}

export function createWatchState(): WatchRunState {
  return { inflight: new Set(), refining: new Set(), inflightParents: new Map() };
}

function slugifyTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5)
      .join("-")
      .replace(/[^a-z0-9-]/g, "") || "issue"
  );
}

export function branchNameFor(issue: Issue): string {
  // The issue's own id in the branch name isn't just labeling: Jira's
  // Bitbucket integration auto-links a PR to the issue when its key
  // appears anywhere in the branch name, no explicit API call needed.
  return `spf-watch/${issue.id}-${slugifyTitle(issue.title)}`.slice(0, 200);
}

/** Same idea as `branchNameFor`, for the refine lane's throwaway worktree — a spec never gets a PR, so this branch is only ever fetched-from-and-thrown-away, never pushed. */
export function refineBranchNameFor(issue: Issue): string {
  return `spf-refine/${issue.id}-${slugifyTitle(issue.title)}`.slice(0, 200);
}

function worktreePathFor(deps: WatchDeps, issue: Issue): string {
  return path.join(deps.worktreesDir, `issue-${issue.id}`);
}

function specWorktreePathFor(deps: WatchDeps, issue: Issue): string {
  return path.join(deps.worktreesDir, `spec-${issue.id}`);
}

/**
 * A local, atomic, PID-checked lock per `adwId` (`issue-<id>`/`spec-<id>`) —
 * sibling to `worktreesDir`, so it lives at the same per-repo root
 * (`~/.spf/watch/<repo>/locks/`). `provider.claim()`'s own read-modify-write
 * (see `IssueProvider.claim`'s doc comment) only verifies the END STATE
 * looks claimed, not that no one else raced it — the real exclusivity has
 * to live here, gating `claim()` itself, because a resumed/orphaned spec
 * dispatches straight into the SAME deterministic worktree and
 * `context_handoff_dir` a still-running prior attempt already owns (see
 * `chains/steps.ts`'s `clearStaleRefineOutputFiles` doc comment). A dead
 * holder (the daemon that owned it got killed, not stopped) never blocks a
 * fresh claim — `acquirePidLock`'s stale-steal — but a genuinely live
 * holder (this daemon restarted while the OLD process's chain run, spawned
 * fire-and-forget from `claimNewWork`/`claimSpecs`, was still in flight)
 * does, until that run's own `.finally()` releases it.
 */
export function issueLockPath(deps: WatchDeps, adwId: string): string {
  return path.join(path.dirname(deps.worktreesDir), "locks", `${adwId}.lock`);
}

function cleanupWorktree(deps: WatchDeps, marker: WatchMarker | null): void {
  if (!marker) return;
  try {
    if (marker.worktree) deps.git.worktreeRemove(marker.worktree);
    if (marker.branch) deps.git.deleteLocalBranch(marker.branch);
  } catch (error) {
    deps.log(`watch: cleanup warning: ${(error as Error).message}`);
  }
}

/**
 * Any issue labeled `working` that THIS process isn't tracking is an
 * orphan — a daemon restart, or another instance's claim this process
 * never saw. Resume if its marker points at a still-open (or already
 * merged) PR; otherwise retry up to `MAX_ORPHAN_ATTEMPTS`, then give up.
 */
export async function reconcileOrphans(deps: WatchDeps, state: WatchRunState): Promise<void> {
  const working = await deps.provider.listInState("working");
  for (const issue of working) {
    if (state.inflight.has(issue.id)) continue;
    const marker = await deps.provider.readMarker(issue);
    if (marker?.pr) {
      const status = await deps.codeHost.prStatus({ number: marker.pr, branch: marker.branch ?? "", url: "" });
      if (status.state === "open" || status.merged) {
        deps.log(`watch: ${issue.id} orphaned with an open/merged PR #${marker.pr} — resuming as review`);
        if (!deps.dryRun) await deps.provider.transition(issue, "review");
        continue;
      }
    }
    const attempt = (marker?.attempt ?? 0) + 1;
    if (attempt <= MAX_ORPHAN_ATTEMPTS) {
      deps.log(`watch: ${issue.id} orphaned, retry ${attempt}/${MAX_ORPHAN_ATTEMPTS} — back to ready`);
      if (!deps.dryRun) {
        await deps.provider.writeMarker(issue, { ...marker, attempt });
        await deps.provider.transition(issue, "ready");
      }
    } else {
      deps.log(`watch: ${issue.id} orphaned past ${MAX_ORPHAN_ATTEMPTS} attempts — blocked`);
      deps.notify({
        kind: "issue_blocked",
        level: "notice",
        title: `issue ${issue.id} blocked`,
        detail: `Gave up after ${MAX_ORPHAN_ATTEMPTS} orphaned attempts.`,
        fields: [["issue", issue.id], ["title", issue.title]],
      });
      if (!deps.dryRun) {
        await deps.provider.transition(issue, "blocked", `Gave up after ${MAX_ORPHAN_ATTEMPTS} orphaned attempts.`);
        cleanupWorktree(deps, marker);
      }
    }
  }
}

/**
 * Post the summary comment on a decomposed spec and move it to
 * `spec-in-progress` — deliberately NOT `done`: a product manager watching
 * this spec's status must not see "done" until every issue the refiner
 * produced is itself `<prefix>:done` (`finishTrackedSpecs`, below, is what
 * makes THAT move, once it's actually true). Reached from both the normal
 * path (`runSpec`, right after a successful publish) and the orphan-resume
 * path (`reconcileRefining`, when a completed publish's marker survived a
 * crash the `transition` itself didn't). `created` only has titles/kinds in
 * the normal path — an orphan resume has nothing but the ids
 * `WatchMarker.refined` recorded, and the comment degrades to a bare list of
 * `#id`s rather than blocking on a re-fetch.
 *
 * One exception: a decomposition that produced ZERO issues (shouldn't
 * happen — `gates.refinementWellFormed` requires at least one leaf, but this
 * stays defensive rather than assumed) has nothing for `finishTrackedSpecs`
 * to ever wait on, so it goes straight to `done` instead of `spec-in-progress`.
 */
async function announceRefined(
  deps: WatchDeps,
  issue: Issue,
  created: Array<{ id: string; title?: string; kind?: string }>,
  rounds = 0,
): Promise<void> {
  const roundsNote = rounds > 0 ? ` (after ${rounds} round${rounds === 1 ? "" : "s"} of feedback)` : "";
  const body =
    created.length > 0
      ? `spf watch refined this spec into ${created.length} issue(s)${roundsNote}:\n\n` +
        created.map((c) => (c.title ? `- #${c.id} (${c.kind}): ${c.title}` : `- #${c.id}`)).join("\n") +
        `\n\nPromote any of them to \`${deps.labelPrefix}:ready\` when it's worth building. ` +
        `This spec moves to \`${deps.labelPrefix}:done\` once every one of them does.`
      : `spf watch refined this spec but the refiner produced no issues.`;
  deps.notify({
    kind: "spec_refined",
    level: "info",
    title: `spec ${issue.id} refined`,
    detail: `${created.length} issue(s) created.`,
    fields: [["issue", issue.id], ["title", issue.title], ["created", String(created.length)]],
  });
  if (!deps.dryRun) {
    await deps.provider.comment(issue, body);
    if (created.length === 0) {
      await deps.provider.transition(issue, "done");
      // Best-effort and never fatal, same reasoning as finishTrackedSpecs'
      // own closeIssue call below: the spec is already `done` by the time
      // this runs, so a tracker that can't close must not turn a
      // successfully refined spec into `blocked`.
      await deps.provider.closeIssue?.(issue).catch((error) => {
        deps.log(`watch: spec ${issue.id}: closeIssue failed — left open, still \`${deps.labelPrefix}:done\`: ${(error as Error).message}`);
      });
      return;
    }
    await deps.provider.transition(issue, "spec-in-progress");
  }
}

/**
 * Poll every `spec-in-progress` spec: once every id `WatchMarker.refined`
 * recorded — every issue the refiner produced, leaf or container — carries
 * `<prefix>:done`, the spec's own decomposed work is actually finished, and
 * only then does this move it `-> done`. This is the whole point of
 * `announceRefined` landing on `spec-in-progress` rather than `done`
 * straight away: the spec's status is what a product manager reads to know
 * whether the work is finished, and "done" the instant a tree gets PUBLISHED
 * would be a lie — the work hasn't started yet, let alone finished.
 *
 * A container in the refined list is done exactly when `rollUp` (see
 * `finishReviews`) has already rolled it up — by the time every id here is
 * `<prefix>:done`, every leaf beneath every container is too, transitively,
 * with no need to walk the hierarchy again from this side.
 *
 * A referenced id that 404s (deleted from the tracker) is treated as
 * satisfied — same policy as `frontierBlockedOn`'s blockers: a removed issue
 * must not wedge the spec's completion forever. A spec with no marker, or an
 * empty `refined` list, is left alone with a log line rather than assumed
 * done — data that shouldn't exist given the gate's at-least-one-leaf rule,
 * but never silently marked complete on that assumption.
 */
export async function finishTrackedSpecs(deps: WatchDeps): Promise<void> {
  const tracked = await deps.provider.listInState("spec-in-progress");
  const doneLabel = `${deps.labelPrefix}:done`;
  for (const issue of tracked) {
    const marker = await deps.provider.readMarker(issue);
    const refined = marker?.refined ?? [];
    if (refined.length === 0) {
      deps.log(`watch: spec ${issue.id} is spec-in-progress with no refined issues recorded — leaving it alone`);
      continue;
    }

    const finished: Issue[] = [];
    let allDone = true;
    for (const id of refined) {
      const child = await deps.provider.getIssue(id);
      if (!child) {
        deps.log(`watch: spec ${issue.id}: refined issue #${id} no longer exists — treating it as done rather than wedging the spec forever`);
        continue;
      }
      if (!child.labels.includes(doneLabel)) {
        allDone = false;
        break; // one unfinished issue is enough to know — no need to check the rest this tick
      }
      finished.push(child);
    }
    if (!allDone) {
      deps.log(`watch: spec ${issue.id}: still waiting on work — not every refined issue is \`${doneLabel}\` yet`);
      continue;
    }

    deps.log(`watch: spec ${issue.id}: every refined issue is \`${doneLabel}\` — closing`);
    deps.notify({
      kind: "spec_done",
      level: "info",
      title: `spec ${issue.id} done`,
      detail: `${refined.length} issue(s) all landed.`,
      fields: [["issue", issue.id], ["title", issue.title], ["refined", String(refined.length)]],
    });
    if (!deps.dryRun) {
      const body =
        `spf watch: every issue decomposed from this spec is now \`${doneLabel}\`:\n\n` +
        finished.map((c) => `- #${c.id}: ${c.title}`).join("\n");
      await deps.provider.comment(issue, body);
      await deps.provider.transition(issue, "done");
      await deps.provider.closeIssue?.(issue).catch((error) => {
        deps.log(`watch: spec ${issue.id}: closeIssue failed — left open, still \`${doneLabel}\`: ${(error as Error).message}`);
      });
    }
  }
}

const MAX_THREAD_CHARS = 20_000;

/**
 * Render the spec issue's comment thread for the refiner's prompt, replacing
 * the previous bare `title\n\nbody` — the whole reason a human's answer
 * could never reach a resumed run before this feature. When `feedback` names
 * the timestamp of the most recent question comment, everything at or after
 * it is surfaced as "answers to your open questions" (what a resumed run
 * most needs to read); everything earlier is "earlier discussion" — context,
 * not necessarily an answer. A spec that has never been escalated (no
 * `feedback`) has no such split: any pre-existing comments are all "earlier
 * discussion".
 *
 * Truncates the RENDERED thread, not the comment list, to roughly
 * `MAX_THREAD_CHARS`, dropping the oldest comments first — an explicit
 * "N earlier comment(s) omitted" line, never a silent truncation.
 *
 * `priority` — the spec's own `<prefix>:priority:pN` label, read by
 * `runSpec` below — renders as its own `## Priority` section right after the
 * header, present or absent independent of whether there's any comment
 * thread at all: a spec with no priority label (the common case today) omits
 * the section entirely, exactly the prompt this function produced before
 * priority existed. `core/refine.ts`'s `publish()` is what actually ENFORCES
 * the ceiling this section only asks for — see its own doc comment.
 *
 * Exported and pure (no provider, no I/O) so it's directly unit-testable.
 */
export function buildSpecPrompt(issue: Issue, comments: IssueComment[], feedback?: WatchMarker["feedback"], priority?: RefinedPriority | null): string {
  const withoutPriority = `${issue.title}\n\n${issue.body}`.trim();
  const header = priority
    ? `${withoutPriority}\n\n## Priority\n\nThis spec is labeled ${priority}. That's a CEILING for everything you produce: no node may be more urgent than ${priority} — less urgent is fine, more urgent is not.`
    : withoutPriority;
  if (comments.length === 0) return header;

  const render = (list: IssueComment[]): string => list.map((c) => `**@${c.author}** (${c.created_at}):\n${c.body.trim()}`).join("\n\n");

  let kept = comments;
  let dropped = 0;
  while (render(kept).length > MAX_THREAD_CHARS && kept.length > 1) {
    kept = kept.slice(1);
    dropped++;
  }

  const askedAt = feedback?.asked_at ? Date.parse(feedback.asked_at) : null;
  const answers = askedAt !== null ? kept.filter((c) => Date.parse(c.created_at) >= askedAt) : [];
  const earlier = askedAt !== null ? kept.filter((c) => Date.parse(c.created_at) < askedAt) : kept;

  const parts: string[] = [];
  if (dropped > 0) parts.push(`_... ${dropped} earlier comment(s) omitted for length._`);
  if (answers.length > 0) parts.push(`### Answers to your open questions (round ${feedback!.rounds})\n\n${render(answers)}`);
  if (earlier.length > 0) parts.push(`### Earlier discussion\n\n${render(earlier)}`);
  if (parts.length === 0) return header;

  return `${header}\n\n## Discussion on the spec issue\n\n${parts.join("\n\n")}`;
}

/**
 * The refine lane's own finishing move for "the refiner can't proceed
 * without a human" — the escalation twin of `announceRefined` above. Posts every
 * question as its own rich comment section (the question, why it matters,
 * the options considered, its recommendation, and the evidence it read — so
 * a human can often answer in a word or two), records the round in the
 * marker so a resumed run's prompt (`buildSpecPrompt`) can tell "answers"
 * from "earlier discussion", and moves the spec to `needs-feedback` rather
 * than `blocked` — the refiner correctly refusing to guess is a legitimate
 * outcome, not a failure. `marker` is spread first so `worktree`/`branch`
 * (just written by the caller) survive into the marker this writes.
 */
async function escalateSpec(
  deps: WatchDeps,
  issue: Issue,
  marker: WatchMarker,
  questions: RefinedQuestionRef[],
  adwId: string,
  round: number,
): Promise<void> {
  const body =
    `## spf needs your input (round ${round})\n\n` +
    questions
      .map((q) => {
        const lines = [`### ${q.question}`];
        if (q.why_it_matters) lines.push(`**Why it matters:** ${q.why_it_matters}`);
        if (q.options.length > 0) lines.push(`**Options considered:**\n${q.options.map((o) => `- ${o}`).join("\n")}`);
        if (q.recommendation) lines.push(`**Recommendation:** ${q.recommendation}`);
        if (q.evidence.length > 0) lines.push(`**Evidence:**\n${q.evidence.map((e) => `- ${e}`).join("\n")}`);
        return lines.join("\n\n");
      })
      .join("\n\n---\n\n") +
    `\n\n---\n\nAnswer inline, then add the \`${deps.labelPrefix}:continue-refinement\` label — refinement resumes from where it left off (adw_id \`${adwId}\`).`;

  deps.notify({
    // "notice" level, not "info" — this is the same class of event as
    // issue_blocked ("spf needs a human"), and it belongs on an
    // `attention`-scope channel just as much as an `all`-scope one.
    kind: "spec_needs_feedback",
    level: "notice",
    title: `spec ${issue.id} needs feedback`,
    detail: `${questions.length} question(s), round ${round}.`,
    fields: [
      ["issue", issue.id],
      ["title", issue.title],
      ["chain", deps.refineChain],
      ["adw_id", adwId],
      ["round", String(round)],
    ],
  });

  if (!deps.dryRun) {
    await deps.provider.comment(issue, body);
    await deps.provider.writeMarker(issue, { ...marker, feedback: { rounds: round, asked_at: new Date().toISOString() } });
    await deps.provider.transition(issue, "needs-feedback");
  }
}

/**
 * The refine lane's own `reconcileOrphans` — a `refining`-labeled spec this
 * process isn't tracking is one of three things: a completed publish that
 * crashed before its own `transition(issue, "done")` ran (resume: finish it,
 * no re-run), a completed escalation that crashed before its own
 * `transition(issue, "needs-feedback")` ran (resume: finish THAT transition,
 * no re-asking — `escalateSpec` writes the marker's `feedback` before it
 * transitions, so seeing `feedback` on a still-`refining` spec can only mean
 * that last step didn't complete), or a genuine orphan (retry up to
 * `MAX_ORPHAN_ATTEMPTS`, then give up). A no-op entirely when `watch.refine`
 * is off — see `WatchDeps.refineEnabled`.
 */
export async function reconcileRefining(deps: WatchDeps, state: WatchRunState): Promise<void> {
  if (!deps.refineEnabled) return;
  const refining = await deps.provider.listInState("refining");
  for (const issue of refining) {
    if (state.refining.has(issue.id)) continue;
    const marker = await deps.provider.readMarker(issue);
    if (marker?.refined && marker.refined.length > 0) {
      deps.log(`watch: spec ${issue.id} orphaned after publish already completed — finishing`);
      await announceRefined(deps, issue, marker.refined.map((id) => ({ id })), marker.feedback?.rounds ?? 0);
      continue;
    }
    if (marker?.feedback) {
      deps.log(`watch: spec ${issue.id} orphaned after asking round ${marker.feedback.rounds} — finishing the transition to needs-feedback`);
      deps.notify({
        kind: "spec_needs_feedback",
        level: "notice",
        title: `spec ${issue.id} needs feedback`,
        detail: `Round ${marker.feedback.rounds}.`,
        fields: [["issue", issue.id], ["title", issue.title], ["round", String(marker.feedback.rounds)]],
      });
      if (!deps.dryRun) await deps.provider.transition(issue, "needs-feedback");
      continue;
    }
    const attempt = (marker?.attempt ?? 0) + 1;
    if (attempt <= MAX_ORPHAN_ATTEMPTS) {
      deps.log(`watch: spec ${issue.id} orphaned mid-refine, retry ${attempt}/${MAX_ORPHAN_ATTEMPTS} — back to spec-ready`);
      if (!deps.dryRun) {
        await deps.provider.writeMarker(issue, { ...marker, attempt });
        await deps.provider.transition(issue, "spec-ready");
      }
    } else {
      deps.log(`watch: spec ${issue.id} orphaned past ${MAX_ORPHAN_ATTEMPTS} attempts — blocked`);
      deps.notify({
        kind: "issue_blocked",
        level: "notice",
        title: `spec ${issue.id} blocked`,
        detail: `Gave up after ${MAX_ORPHAN_ATTEMPTS} orphaned refine attempts.`,
        fields: [["issue", issue.id], ["title", issue.title]],
      });
      if (!deps.dryRun) {
        await deps.provider.transition(issue, "blocked", `Gave up after ${MAX_ORPHAN_ATTEMPTS} orphaned refine attempts.`);
        cleanupWorktree(deps, marker);
      }
    }
  }
}

/**
 * `containerId`'s parent's parent's ... — the chain of `parent`s a nested
 * epic-of-features roll-up needs to climb, each hop read straight out of an
 * already-fetched `Issue.body`'s hidden `spf-refine:` marker (no extra
 * tracker call). `depth` guards against a cycle a malformed marker could
 * otherwise spin on forever, bounded to `MAX_ROLLUP_DEPTH` — GitHub's own
 * documented sub-issue nesting cap (see `github_provider.ts`'s `linkChild`
 * doc comment).
 */
function parentOf(issue: Issue): string | null {
  return parseRefineMarker(issue.body).parent;
}

/**
 * A container is `done` the instant every child `listChildren` reports
 * carries `<prefix>:done` — reached reactively, from the child that just
 * finished (`finishReviews` below), never a periodic full scan: cheap on a
 * quiet tick, and it means the moment the LAST child lands is the moment the
 * container notices, not up to a poll interval later.
 *
 * A no-op, logged once, when `deps.listChildren` is unset (any tracker but
 * GitHub today — see `WatchDeps`'s own doc comment) or when `containerId`
 * is `null` (a top-level leaf has no container to roll up at all).
 *
 * Recurses on the container's OWN parent once it finishes, so an epic whose
 * features each roll up in turn eventually rolls up itself — bounded by
 * `MAX_ROLLUP_DEPTH` against a cyclic or absurdly deep marker.
 */
async function rollUp(deps: WatchDeps, containerId: string | null, depth = 0): Promise<void> {
  if (!containerId || depth >= MAX_ROLLUP_DEPTH) return;
  if (!deps.listChildren) {
    deps.log(`watch: ${containerId}: no listChildren on this tracker — container roll-up is GitHub-only, skipping`);
    return;
  }
  const container = await deps.provider.getIssue(containerId);
  if (!container) return; // deleted — nothing left to roll up
  const doneLabel = `${deps.labelPrefix}:done`;
  if (container.labels.includes(doneLabel)) return; // already rolled up — never re-process, never loop on its own parent again

  const children = await deps.listChildren(container);
  const unfinished = children.filter((c) => !c.labels.includes(doneLabel));
  if (unfinished.length > 0) {
    deps.log(`watch: ${containerId} waiting on ${unfinished.map((c) => `#${c.id}`).join(", ")} before it can roll up`);
    return;
  }

  deps.log(`watch: ${containerId}: every child is done — rolling up`);
  deps.notify({
    kind: "feature_done",
    level: "info",
    title: `feature ${containerId} done`,
    detail: `${children.length} child issue(s) all landed.`,
    fields: [["issue", containerId], ["title", container.title], ["children", String(children.length)]],
  });
  if (!deps.dryRun) {
    const body = `spf watch: every child issue landed:\n\n${children.map((c) => `- #${c.id}: ${c.title}`).join("\n")}`;
    await deps.provider.comment(container, body);
    await deps.provider.transition(container, "done");
    await deps.provider.closeIssue?.(container).catch((error) => {
      deps.log(`watch: ${containerId}: closeIssue failed — left open, still \`${doneLabel}\`: ${(error as Error).message}`);
    });
  }
  await rollUp(deps, parentOf(container), depth + 1);
}

/** Poll every `review`-labeled issue's PR for merged (-> done) or closed-without-merging (-> blocked). */
export async function finishReviews(deps: WatchDeps): Promise<void> {
  const reviewing = await deps.provider.listInState("review", { includeAll: true });
  for (const issue of reviewing) {
    const marker = await deps.provider.readMarker(issue);
    if (!marker?.pr) continue;
    const status = await deps.codeHost.prStatus({ number: marker.pr, branch: marker.branch ?? "", url: "" });
    if (status.merged) {
      deps.log(`watch: ${issue.id}'s PR #${marker.pr} merged — done`);
      deps.notify({
        kind: "issue_done",
        // Same reasoning as pr_opened above: a merge landing is a milestone
        // worth a human's attention (it's what closes the loop on the PR
        // that alerted them in the first place), not a routine "info" tick.
        level: "notice",
        title: `issue ${issue.id} done`,
        detail: `PR #${marker.pr} merged.`,
        fields: [["issue", issue.id], ["title", issue.title], ["pr", `#${marker.pr}`]],
      });
      if (!deps.dryRun) {
        await deps.provider.transition(issue, "done");
        // Best-effort, never fatal — same pattern as announceRefined's own
        // closeIssue call: the issue is already correctly `<prefix>:done`
        // by the time this runs, so a tracker that can't close (or doesn't
        // implement it at all) must not turn a successfully landed issue
        // into `blocked`.
        await deps.provider.closeIssue?.(issue).catch((error) => {
          deps.log(`watch: ${issue.id}: closeIssue failed — left open, still \`${deps.labelPrefix}:done\`: ${(error as Error).message}`);
        });
        await rollUp(deps, parentOf(issue));
        cleanupWorktree(deps, marker);
      }
    } else if (status.state === "closed") {
      deps.log(`watch: ${issue.id}'s PR #${marker.pr} closed without merging — blocked`);
      deps.notify({
        kind: "issue_blocked",
        level: "notice",
        title: `issue ${issue.id} blocked`,
        detail: `PR #${marker.pr} was closed without merging.`,
        fields: [["issue", issue.id], ["title", issue.title], ["pr", `#${marker.pr}`]],
      });
      if (!deps.dryRun) {
        await deps.provider.transition(issue, "blocked", `PR #${marker.pr} was closed without merging.`);
        cleanupWorktree(deps, marker);
      }
    }
  }
}

/**
 * The half of a claimed issue's path that runs once a WINNING tree exists:
 * empty-diff check, push, PR, marker, transition, notify. Called by
 * `runIssueSingle` with its sole attempt's tree and by `runIssueFanout` with
 * `pickBest`'s winner — it never learns which, because nothing about opening
 * a PR depends on how many candidates were considered.
 *
 * `diffBase` is a PARAMETER, not `origin/${deps.baseBranch}` recomputed here:
 * the fan-out lane pins one base SHA for the whole fan-out (see
 * `runIssueFanout`) and the winner must be diffed against the SAME commit its
 * siblings were ranked against, not against wherever `origin/<base>` has
 * moved to by now. The single lane passes `origin/${deps.baseBranch}` — the
 * literal expression it used inline before this extraction.
 *
 * `extraNotifyFields`, when given, are appended to the `pr_opened` notify's
 * `fields` — additive, never replacing any of the four fields below. The
 * fan-out lane uses this for one `["fanout", "<n> attempts, won by <adw_id>"]`
 * entry; the single lane passes nothing, so its notify is byte-identical to
 * before this extraction.
 *
 * IT CATCHES NOTHING, deliberately. The try/catch that covers this region
 * lives one level up, in each lane's own caller, and this extraction does not
 * move it. So EVERY caller must still hold the winner's `{worktreePath,
 * branch}` in whatever its own catch cleans up, for the whole duration of
 * this call: the throws in here are ordinary (`push` rejected, `openPr` 5xx,
 * a tracker write failing), and on any of them the caller's catch is the only
 * thing that removes the tree and deletes the branch.
 */
async function openPrForWinner(
  deps: WatchDeps,
  issue: Issue,
  won: {
    branch: string;
    worktreePath: string;
    adwId: string;
    diffBase: string;
    reviewRequired?: boolean;
    reviewSummary?: string;
    extraNotifyFields?: Array<[string, string]>;
  },
): Promise<void> {
  const wtGit = deps.worktreeGit(won.worktreePath);
  if (wtGit.diffFiles(won.diffBase).length === 0) {
    deps.log(`watch: ${issue.id}: chain succeeded but committed nothing — blocked`);
    deps.notify({
      kind: "issue_blocked",
      level: "notice",
      title: `issue ${issue.id} blocked`,
      detail: `Chain "${deps.chain}" (adw_id ${won.adwId}) completed but left no committed changes.`,
      fields: [["issue", issue.id], ["title", issue.title], ["chain", deps.chain], ["adw_id", won.adwId]],
    });
    await deps.provider.transition(issue, "blocked", `Chain "${deps.chain}" (adw_id ${won.adwId}) completed but left no committed changes.`);
    cleanupWorktree(deps, { worktree: won.worktreePath, branch: won.branch });
    return;
  }

  wtGit.push("origin", won.branch);
  // The human merging this PR sees whatever the reviewer found — or, if
  // nothing reviewed this change at all, is told that plainly rather than
  // left to assume a silent approval. `reviewSummary` is already
  // sanitized/truncated by the caller (see runChain's own doc comment).
  const reviewLine = won.reviewSummary
    ? won.reviewSummary
    : won.reviewRequired
      ? "Reviewer ran, but no verdict could be read back from the session data."
      : `Nothing reviewed this change — chain \`${deps.chain}\` has no reviewer step.`;
  // The reviewer's biggest complaint about a bare "automated by spf watch"
  // body: it never says what was actually asked for, only chain plumbing.
  // The issue body IS that ask (it's the same text `runIssue`/`runChain`
  // built the prompt from) and is already sitting on `issue` — no new DB
  // read needed to surface it. Capped defensively: a Jira description can
  // be arbitrarily long, and this is a PR body, not the source of record.
  const MAX_ISSUE_BODY_CHARS = 4000;
  const issueBody = issue.body.trim();
  const askSection =
    issueBody.length > MAX_ISSUE_BODY_CHARS ? `${issueBody.slice(0, MAX_ISSUE_BODY_CHARS)}\n\n_(truncated)_` : issueBody || "_(no description on the issue)_";
  // No cross-linking magic keyword here on purpose (a code host paired
  // with a different tracker has no "Closes #n" convention to hook into
  // — see provider.ts) — the issue id in the title/body is plain text
  // for humans, and, on a Jira+Bitbucket pairing, exactly what Jira's own
  // Bitbucket integration scans for to link the PR automatically.
  const pr = await deps.codeHost.openPr({
    branch: won.branch,
    title: `${issue.title} (${issue.id})`,
    body: `${askSection}\n\n---\n\n**Review:** ${reviewLine}\n\n_Automated by \`spf watch\` — chain \`${deps.chain}\`, adw_id \`${won.adwId}\`, issue ${issue.id}._`,
    base: deps.baseBranch,
  });
  await deps.provider.writeMarker(issue, { worktree: won.worktreePath, branch: won.branch, pr: pr.number, attempt: 0 });
  await deps.provider.transition(issue, "review");
  deps.log(`watch: ${issue.id}: opened PR #${pr.number} — review`);
  deps.notify({
    kind: "pr_opened",
    // Unlike `issue_claimed`/`issue_done` (routine milestones), an opened PR
    // is a standing ask for a human reviewer — the same "needs a human, not
    // a failure" bucket as `issue_blocked`, so it ships to an
    // `attention`-scoped channel, not just `all`.
    level: "notice",
    title: `PR #${pr.number} opened`,
    detail: reviewLine,
    fields: [
      ["issue", issue.id],
      ["title", issue.title],
      ["chain", deps.chain],
      ["review", won.reviewSummary ? "reviewed" : won.reviewRequired ? "reviewer ran, no verdict" : "not reviewed"],
      ...(won.extraNotifyFields ?? []),
    ],
    url: pr.url || undefined,
  });
}

/**
 * `issue-<id>` at `r = 0` — matching `runIssueSingle`'s own adw_id scheme, so
 * the common case (an issue's first fan-out) is the id a human would guess
 * (`spf phases issue-42-2` works as advertised). `r > 0` salts it — see
 * `runIssueFanout`'s salt probe for why a PROBED salt, not a counter anyone
 * maintains, decides `r`.
 */
function baseFor(issue: Issue, r: number): string {
  return r === 0 ? `issue-${issue.id}` : `issue-${issue.id}-r${r}`;
}

/**
 * Tear down a whole SET of worktree/branch pairs — EVERY worktree in the
 * list first, then every branch, never pair by pair. The pairs a fan-out
 * pre-sweep has to cover are cross-linked (the winner's renamed branch can
 * live in a *different* entry's fan-out worktree — see the rename step in
 * `runIssueFanout`), and `git branch -D` refuses to delete a branch that is
 * checked out in ANY worktree still on disk while `deleteLocalBranch`
 * swallows that refusal (a bare `spawnSync` whose status is never read —
 * `git_helper.ts`). A name-by-name (pairwise) sweep can therefore try to
 * delete a branch that is still checked out in an entry later in the SAME
 * list, silently fail, and leave the issue permanently wedged the next time
 * something tries to create that branch. Two full passes over the whole list
 * remove that ordering dependency entirely — the same rule
 * `removeRunWorktree` documents for its own single pair (worktree before
 * branch), applied at the granularity a sweep across many pairs needs.
 */
function sweepPairs(deps: WatchDeps, pairs: Array<{ worktree?: string; branch?: string }>): void {
  for (const p of pairs) {
    if (!p.worktree) continue;
    try {
      deps.git.worktreeRemove(p.worktree);
    } catch (error) {
      deps.log(`watch: sweep warning: ${(error as Error).message}`);
    }
  }
  for (const p of pairs) {
    if (!p.branch) continue;
    try {
      deps.git.deleteLocalBranch(p.branch);
    } catch (error) {
      deps.log(`watch: sweep warning: ${(error as Error).message}`);
    }
  }
}

/**
 * `watch.fanout.n > 1`: run `n` sibling attempts of this issue's prompt via
 * `core/fanout.ts`'s `runBestOf`, let it pick a winner, rename the winner's
 * branch onto the canonical `spf-watch/<id>-<slug>` name, then hand it to
 * `openPrForWinner` — the same tail `runIssueSingle` uses.
 *
 * `won` is a single mutable local (unlike the single lane's deterministic
 * `worktreePath`/`branch` locals) because the fan-out lane's cleanup
 * coordinates change three times over the course of one claim: null while
 * nothing of watch's own exists yet, the winner's fan-out tree/branch right
 * after selection, then the winner's tree on the renamed canonical branch
 * from the rename onward — including all the way through `openPrForWinner`,
 * which catches nothing itself. `won` is intentionally never nulled before
 * that call: doing so would disarm this catch for `push`/`openPr` failures,
 * the single most failure-prone part of the whole flow, and leak a full
 * checkout plus the canonical branch on every one of them.
 */
async function runIssueFanout(deps: WatchDeps, issue: Issue, fanout: WatchFanoutDeps): Promise<void> {
  const n = fanout.n;
  let won: { worktree: string; branch: string } | null = null;
  try {
    // Read for its PAIR (the pre-sweep needs to know what a previous cycle
    // recorded), never for `attempt` — see the salt probe below for why that
    // field cannot be the fan-out lane's re-claim counter.
    const marker0 = await deps.provider.readMarker(issue);

    // SALT PROBE (§8.7 in the design doc): the smallest r whose n attempt
    // ids have NO session rows yet. `WatchMarker.attempt` only advances on
    // reconcileOrphans' retry path — an ordinary blocked -> re-labeled ready
    // -> re-claim never touches it — so it cannot answer "is this base
    // still clean," but the sessions a previous claim's attempts actually
    // wrote can (adwIdsFree's own doc comment has the full argument).
    let salt = 0;
    for (; salt <= MAX_FANOUT_SALT; salt++) {
      const ids = Array.from({ length: n }, (_, i) => attemptAdwId(baseFor(issue, salt), i + 1));
      if (fanout.adwIdsFree(ids)) break;
    }
    const baseAdwId = salt <= MAX_FANOUT_SALT ? baseFor(issue, salt) : `issue-${issue.id}-x${newId(4)}`;
    if (salt > MAX_FANOUT_SALT) {
      deps.log(`watch: ${issue.id}: exhausted ${MAX_FANOUT_SALT + 1} deterministic fan-out base id(s) — falling back to a random one (${baseAdwId})`);
    }

    // PRE-SWEEP: one list, two passes (sweepPairs) — marker0's own recorded
    // pair (the only way to reach a stale RENAMED winner from a crash after
    // §8.3's rename), the canonical single-lane pair (the rename target
    // below must find it free), and every deterministic attempt name under
    // every base this claim can have used (0..salt inclusive — bases above
    // salt were never reached, so nothing can be there).
    const branch = branchNameFor(issue);
    const worktreePath = worktreePathFor(deps, issue);
    const pairs: Array<{ worktree?: string; branch?: string }> = [
      { worktree: marker0?.worktree, branch: marker0?.branch },
      { worktree: worktreePath, branch },
    ];
    for (let r = 0; r <= Math.min(salt, MAX_FANOUT_SALT); r++) {
      const base = baseFor(issue, r);
      for (let i = 1; i <= MAX_FANOUT_N; i++) {
        pairs.push({
          worktree: attemptWorktreePath(deps.worktreesDir, base, i),
          branch: attemptBranch(base, i),
        });
      }
    }
    sweepPairs(deps, pairs);

    // The base is fetched and resolved to a SHA exactly ONCE, loudly, here —
    // matching the single lane's own unguarded, fatal-on-failure fetch
    // (`runIssueSingle`) rather than `runBestOf`'s own per-attempt,
    // failure-swallowing fetch. `pinnedGit` suppresses the N redundant
    // fetches `runBestOf` would otherwise issue against a base already
    // fetched here, and pins every attempt (and the eventual `diffFiles`
    // check in `openPrForWinner`) to the identical commit even if
    // `origin/<base>` moves mid-fan-out.
    deps.git.fetch("origin", deps.baseBranch);
    const baseSha = deps.git.rev(`origin/${deps.baseBranch}`);
    const pinnedGit: GitHandle = { ...deps.git, fetch: () => {} };

    // CLAIM-TIME MARKER WRITE — mirrors the single lane's own write
    // (`runIssueSingle`) and, like it, drops `pr`. Without this, a marker
    // surviving from a PREVIOUS cycle (e.g. a human hand-returning a
    // `review` issue with an open PR back to `ready`) would carry that
    // stale `pr` through the sweep and the whole fan-out window untouched —
    // and if the daemon dies mid-fan-out, `reconcileOrphans` would read that
    // stale `marker.pr` on restart, find it open or merged, and resume the
    // issue straight to `review` (its RESUME path, never reached again from
    // `ready`/`blocked`), leaking this claim's worktrees/branches forever
    // with nothing left to sweep them on a future claim. `attempt` is
    // PRESERVED here (not reset to 0) so the orphan-retry counter survives a
    // claim that has not yet produced a winner; it only becomes the literal
    // `0` once a real winner marker is written below, matching the single
    // lane's own reset at that point.
    await deps.provider.writeMarker(issue, { attempt: marker0?.attempt ?? 0 });

    const result = await runBestOf({
      chainName: deps.chain,
      prompt: `${issue.title}\n\n${issue.body}`.trim(),
      n,
      concurrency: fanout.concurrency,
      baseAdwId,
      baseBranch: baseSha,
      repoRoot: fanout.repoRoot,
      worktreesDir: deps.worktreesDir,
      git: pinnedGit,
      linkDataDir: deps.linkDataDir,
      runAttempt: fanout.runAttempt,
      readMetrics: fanout.readMetrics,
      log: deps.log,
    });
    deps.log(`watch: ${issue.id}: best of ${n} — ${result.basis}`);

    if (!result.winner) {
      const first = attemptAdwId(baseAdwId, 1);
      const last = attemptAdwId(baseAdwId, n);
      const detail =
        `Chain "${deps.chain}" did not succeed in any of ${n} attempt(s) (adw_ids ${first}..${last}): ${result.basis}. ` +
        `Run \`spf phases <adw_id>\` on any attempt for detail.`;
      deps.notify({
        kind: "issue_blocked",
        level: "notice",
        title: `issue ${issue.id} blocked`,
        detail,
        fields: [
          ["issue", issue.id],
          ["title", issue.title],
          ["chain", deps.chain],
          ["adw_id", `${baseAdwId}-1..${n}`],
          ["attempts", String(n)],
        ],
      });
      await deps.provider.transition(issue, "blocked", detail);
      // NO cleanupWorktree call: `won` is still null — nothing of watch's
      // own survived `runBestOf`, which already cleaned every attempt it
      // owned (losers as it went, and there is no winner to keep here).
      return;
    }

    const winner = result.winner;
    won = { worktree: winner.worktree, branch: winner.branch }; // still spf/fanout/*
    await deps.provider.writeMarker(issue, { worktree: won.worktree, branch: won.branch, attempt: 0 });

    // RENAME (§8.3): `spf/fanout/*` branches are never pushed by SPF
    // (`core/fanout.ts`'s own stated contract) — pushing one from watch
    // would contradict the module this composes. Renaming preserves
    // everything downstream that reads a branch name (WatchMarker.branch,
    // the PR head, finishReviews' cleanup, the Jira/Bitbucket branch-name
    // auto-link). Order matters: `createBranch` (a `git checkout -b` INSIDE
    // the winner's worktree) must run before `deleteLocalBranch` on the old
    // name, because git refuses to delete a branch checked out in a
    // worktree — the winner's own worktree is that checkout until this line
    // runs. `createBranch` CAN throw (most commonly: the canonical name
    // already exists) — the pre-sweep above is what keeps that name free by
    // the time this runs; if it still throws, `won` has not been reassigned
    // yet, so the catch below cleans the pre-rename pair, correctly.
    const wtGit = deps.worktreeGit(winner.worktree);
    wtGit.createBranch(branch);
    deps.git.deleteLocalBranch(winner.branch);
    won = { worktree: winner.worktree, branch };
    await deps.provider.writeMarker(issue, { worktree: won.worktree, branch: won.branch, attempt: 0 });

    const review = fanout.reviewFor({ cwd: winner.worktree, adwId: winner.adw_id, chainOptions: deps.chainOptions });

    // `won` stays set from here on — openPrForWinner catches nothing, so
    // this function's own catch (below) is the only cleanup for a throw
    // from push/openPr/writeMarker/transition/notify inside it, exactly as
    // runIssueSingle's catch is for the single lane.
    await openPrForWinner(deps, issue, {
      branch: won.branch,
      worktreePath: won.worktree,
      adwId: winner.adw_id,
      diffBase: baseSha,
      reviewRequired: review.reviewRequired,
      reviewSummary: review.reviewSummary,
      extraNotifyFields: [["fanout", `${n} attempts, won by ${winner.adw_id}`]],
    });
  } catch (error) {
    const message = (error as Error).message;
    deps.log(`watch: ${issue.id}: error: ${message}`);
    deps.notify({
      kind: "watch_error",
      level: "error",
      title: `issue ${issue.id} errored`,
      detail: message,
      fields: [["issue", issue.id], ["title", issue.title]],
    });
    await deps.provider.transition(issue, "blocked", `spf watch error: ${message}`).catch(() => undefined);
    cleanupWorktree(deps, won);
  }
}

/**
 * Today's single-dispatch path — `runIssue`'s entire body before fan-out
 * existed, moved intact with its post-win tail extracted into
 * `openPrForWinner` above: same statements, same order, same values. This is
 * what makes `watch.fanout.n: 1` (the default) a no-op for the running
 * daemon: same adw_id, same worktree, same fetch semantics, same marker,
 * same PR, same notifications as before this feature existed.
 */
async function runIssueSingle(deps: WatchDeps, issue: Issue): Promise<void> {
  const branch = branchNameFor(issue);
  const worktreePath = worktreePathFor(deps, issue);
  const adwId = `issue-${issue.id}`;
  try {
    // Both worktreePath and branch are fully deterministic from issue.id —
    // the only way either could already exist is a previous spf watch
    // attempt for THIS issue that never reached its own cleanup (killed
    // mid-run, crashed, machine restart). `git worktree add -b` refuses
    // outright if the branch already exists ("fatal: a branch named '...'
    // already exists"), which without this would permanently block the
    // issue from ever being claimed again — it'd fail this same way on
    // every single retry. Safe to clear unconditionally: worktreeRemove/
    // deleteLocalBranch are both no-ops if there's nothing to remove.
    cleanupWorktree(deps, { worktree: worktreePath, branch });
    deps.git.fetch("origin", deps.baseBranch);
    deps.git.worktreeAdd(worktreePath, branch, `origin/${deps.baseBranch}`);
    deps.linkDataDir(worktreePath);
    await deps.provider.writeMarker(issue, { worktree: worktreePath, branch, attempt: 0 });

    const prompt = `${issue.title}\n\n${issue.body}`.trim();
    const result = await deps.runChain({ prompt, cwd: worktreePath, adwId, chainOptions: deps.chainOptions });

    if (!result.accepted) {
      deps.log(`watch: ${issue.id}: chain "${deps.chain}" did not succeed — blocked`);
      const detail = result.detail || `Chain "${deps.chain}" (adw_id ${adwId}) did not complete successfully. Run \`spf phases ${adwId}\` for detail.`;
      deps.notify({
        kind: "issue_blocked",
        level: "notice",
        title: `issue ${issue.id} blocked`,
        detail,
        fields: [["issue", issue.id], ["title", issue.title], ["chain", deps.chain], ["adw_id", adwId]],
      });
      await deps.provider.transition(issue, "blocked", detail);
      cleanupWorktree(deps, { worktree: worktreePath, branch });
      return;
    }

    await openPrForWinner(deps, issue, {
      branch,
      worktreePath,
      adwId,
      diffBase: `origin/${deps.baseBranch}`,
      reviewRequired: result.reviewRequired,
      reviewSummary: result.reviewSummary,
    });
  } catch (error) {
    const message = (error as Error).message;
    deps.log(`watch: ${issue.id}: error: ${message}`);
    deps.notify({
      kind: "watch_error",
      level: "error",
      title: `issue ${issue.id} errored`,
      detail: message,
      fields: [["issue", issue.id], ["title", issue.title]],
    });
    await deps.provider.transition(issue, "blocked", `spf watch error: ${message}`).catch(() => undefined);
    cleanupWorktree(deps, { worktree: worktreePath, branch });
  }
}

/**
 * One issue's full claim -> chain -> PR path, run in the background —
 * `claimNewWork` doesn't await this. `deps.fanout` unset (or `n <= 1`) takes
 * the single-dispatch path exactly as it always has; `watch.fanout.n > 1`
 * fans out via `runBestOf` first.
 */
async function runIssue(deps: WatchDeps, issue: Issue): Promise<void> {
  if (!deps.fanout || deps.fanout.n <= 1) return runIssueSingle(deps, issue);
  return runIssueFanout(deps, issue, deps.fanout);
}

/**
 * The spec's own `<prefix>:priority:pN` label, or `null` if it was never
 * set. Deliberately NOT `issuePriority`'s default-to-`p2` behavior: `null`
 * here means "no ceiling" (`clampPriority`'s own no-op case, `core/refine.ts`),
 * so a spec predating this feature — the common case, since nothing sets
 * this label automatically on a spec issue — publishes exactly as it always
 * has, uncapped, rather than silently forcing every generated leaf down to
 * `p2`. A spec's OWN priority never comes from a hidden `spf-refine:`
 * marker: only refine-lane-created issues carry that marker, and a spec is,
 * by definition, not one of those.
 */
function specPriorityLabel(issue: Issue, labelPrefix: string): RefinedPriority | null {
  for (const p of ["p0", "p1", "p2", "p3"] as const) {
    if (issue.labels.includes(`${labelPrefix}:priority:${p}`)) return p;
  }
  return null;
}

/**
 * One spec's full claim -> decompose -> publish path, run in the background
 * — `claimSpecs` doesn't await this. The build lane's `runIssue`, minus the
 * PR half: no `diffFiles` check (the refiner has `writes: []`, so an empty
 * diff is the CORRECT outcome, not a failure), no push, no `openPr`. Its
 * mirror image is "publish, then finish" instead of "commit, then review".
 */
async function runSpec(deps: WatchDeps, issue: Issue): Promise<void> {
  const branch = refineBranchNameFor(issue);
  const worktreePath = specWorktreePathFor(deps, issue);
  const adwId = `spec-${issue.id}`;
  try {
    // A spec re-claimed after a completed publish (the transition/comment
    // that should have followed never ran — a crash, a kill) already has
    // its answer on disk: skip straight to finishing rather than asking the
    // refiner to redo work that already exists on the tracker. `to-tickets`
    // (the skill this lane's prompt is ported from) has no such guard and
    // would duplicate every issue on a re-run.
    const existingMarker = await deps.provider.readMarker(issue);
    if (existingMarker?.refined && existingMarker.refined.length > 0) {
      deps.log(`watch: spec ${issue.id}: a previous attempt already published ${existingMarker.refined.length} issue(s) — finishing without re-running the refiner`);
      await announceRefined(deps, issue, existingMarker.refined.map((id) => ({ id })), existingMarker.feedback?.rounds ?? 0);
      return;
    }

    // See runIssue's identical comment: worktreePath/branch are deterministic
    // from issue.id, so a leftover from a killed prior attempt is the only
    // way either could already exist — clear it unconditionally.
    cleanupWorktree(deps, { worktree: worktreePath, branch });
    deps.git.fetch("origin", deps.baseBranch);
    deps.git.worktreeAdd(worktreePath, branch, `origin/${deps.baseBranch}`);
    deps.linkDataDir(worktreePath);
    // Spread existingMarker (not a bare object) so a spec resuming after a
    // prior escalation carries its `feedback` (round count, last-asked-at)
    // through to whatever this run writes next — escalateSpec below and the
    // final writeMarker on a successful publish both build on this object.
    const marker: WatchMarker = { ...existingMarker, worktree: worktreePath, branch, attempt: 0 };
    await deps.provider.writeMarker(issue, marker);

    // The comment thread is what makes this a HUMAN-in-the-loop, not just a
    // one-shot prompt: a resumed run needs the human's answers, and
    // buildSpecPrompt tells them apart from any earlier discussion using
    // existingMarker.feedback.asked_at (unset on a spec that's never been
    // escalated, in which case every comment is "earlier discussion").
    const comments = await deps.provider.listComments(issue);
    // The spec's own priority label, threaded two ways: into the prompt
    // (buildSpecPrompt's `## Priority` section, so the refiner's per-node
    // judgment is informed) AND into chainOptions (steps.publishIssues()
    // reads `options["priority"]` and passes it to `core/refine.ts`'s
    // `publish()` as a hard ceiling) — the prompt makes the rule sensible,
    // the ceiling is what makes it TRUE regardless of what the model does
    // with the prompt. `null` (no label set) reaches both as "no ceiling",
    // unchanged from before this feature existed.
    const specPriority = specPriorityLabel(issue, deps.labelPrefix);
    const prompt = buildSpecPrompt(issue, comments, existingMarker?.feedback, specPriority);
    const chainOptions = specPriority ? { ...deps.chainOptions, priority: specPriority } : deps.chainOptions;
    const result = await deps.runRefine({ prompt, cwd: worktreePath, adwId, issueId: issue.id, chainOptions });

    if (!result.accepted) {
      deps.log(`watch: spec ${issue.id}: refine chain "${deps.refineChain}" did not succeed — blocked`);
      const detail = result.detail || `Refine chain "${deps.refineChain}" (adw_id ${adwId}) did not complete successfully. Run \`spf phases ${adwId}\` for detail.`;
      deps.notify({
        kind: "issue_blocked",
        level: "notice",
        title: `spec ${issue.id} blocked`,
        detail,
        fields: [["issue", issue.id], ["title", issue.title], ["chain", deps.refineChain], ["adw_id", adwId]],
      });
      await deps.provider.transition(issue, "blocked", detail);
      cleanupWorktree(deps, { worktree: worktreePath, branch });
      return;
    }

    // Mutually exclusive by construction — gates.refinementWellFormed
    // guarantees a `questions`-bearing envelope publishes no `issues` — so
    // this branches before, never alongside, the publish path below.
    if (result.questions.length > 0) {
      const round = (existingMarker?.feedback?.rounds ?? 0) + 1;
      await escalateSpec(deps, issue, marker, result.questions, adwId, round);
      cleanupWorktree(deps, { worktree: worktreePath, branch });
      return;
    }

    await deps.provider.writeMarker(issue, { ...marker, refined: result.created.map((c) => c.id) });
    await announceRefined(deps, issue, result.created, existingMarker?.feedback?.rounds ?? 0);
    cleanupWorktree(deps, { worktree: worktreePath, branch });
  } catch (error) {
    const message = (error as Error).message;
    deps.log(`watch: spec ${issue.id}: refine error: ${message}`);
    deps.notify({
      kind: "watch_error",
      level: "error",
      title: `spec ${issue.id} errored`,
      detail: message,
      fields: [["issue", issue.id], ["title", issue.title]],
    });
    await deps.provider.transition(issue, "blocked", `spf watch refine error: ${message}`).catch(() => undefined);
    cleanupWorktree(deps, { worktree: worktreePath, branch });
  }
}

/**
 * `issue`'s priority, as `claimNewWork` schedules by: the `<prefix>:priority:pN`
 * LABEL first — a human relabeling an issue is the whole override mechanism
 * (see `RefinedPrioritySchema`'s doc comment and the "Priority" section of
 * `assets/prompts/refiner/system.md`), so it must win over whatever the
 * hidden `spf-refine:` marker still says from publish time — and the marker
 * only as a fallback, for an issue whose label was never applied at all (a
 * hand-created issue with no `spf:priority:*` label, or one predating this
 * feature). `parseRefineMarker` itself defaults to `p2` absent a marker, so
 * this never needs its own fallback beyond that.
 */
function issuePriority(issue: Issue, labelPrefix: string): RefinedPriority {
  for (const p of ["p0", "p1", "p2", "p3"] as const) {
    if (issue.labels.includes(`${labelPrefix}:priority:${p}`)) return p;
  }
  return parseRefineMarker(issue.body).priority;
}

/**
 * Sort `issues` the way `claimNewWork` walks them: priority first (p0 ahead
 * of p2 regardless of creation order), then sibling affinity (a leaf whose
 * hidden marker names a parent already in `inflightParents.values()` sorts
 * ahead of an equal-priority leaf from an unrelated feature — the mechanism
 * that tends to finish one feature before starting the next, without giving
 * up the one-PR-per-story design), then creation order (oldest first,
 * matching `listByLabel`'s own `sort=created&direction=asc` — the final,
 * stable tiebreaker when priority and affinity both tie).
 *
 * Pure and exported so it's directly unit-testable without a provider, same
 * spirit as `buildSpecPrompt` below. Two honest limits, both already true of
 * what feeds it: affinity only reflects a sibling ACTUALLY in flight in this
 * process right now — a daemon restart begins with `inflightParents` empty,
 * so ordering degrades to priority + created-asc until it rebuilds itself
 * over the next few ticks; and priority is read from the label, so an issue
 * a human just relabeled sorts by its NEW priority starting next tick, never
 * retroactively re-ordering claims a previous tick already made.
 */
export function orderEligible(issues: Issue[], inflightParents: Map<string, string>, labelPrefix: string): Issue[] {
  const inflightParentIds = new Set(inflightParents.values());
  return issues
    .map((issue, index) => ({
      issue,
      index, // preserves listEligible's own created-asc order as the final tiebreaker
      priority: PRIORITY_RANK[issuePriority(issue, labelPrefix)],
      hasAffinity: (() => {
        const parent = parseRefineMarker(issue.body).parent;
        return parent !== null && inflightParentIds.has(parent);
      })(),
    }))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.hasAffinity !== b.hasAffinity) return a.hasAffinity ? -1 : 1;
      return a.index - b.index;
    })
    .map((w) => w.issue);
}

/**
 * Whether every id in `blockedBy` currently carries `<prefix>:done` — the
 * frontier check `assets/prompts/refiner/system.md:62` has always promised
 * the refiner ("the factory works the frontier: any leaf whose blockers are
 * all done") but nothing enforced before this. `cache` is per-tick, shared
 * across every candidate `claimNewWork` considers in one pass, so a blocker
 * several leaves share costs exactly one `getIssue` call, not one per leaf.
 * A blocker that 404s (deleted) is treated as satisfied, with a warning —
 * a removed blocker must not wedge its dependents forever.
 */
async function frontierBlockedOn(deps: WatchDeps, blockedBy: string[], cache: Map<string, boolean>): Promise<string | null> {
  const doneLabel = `${deps.labelPrefix}:done`;
  for (const id of blockedBy) {
    let done = cache.get(id);
    if (done === undefined) {
      const blocker = await deps.provider.getIssue(id);
      if (!blocker) {
        deps.log(`watch: blocker #${id} no longer exists — treating it as satisfied rather than wedging its dependents`);
        done = true;
      } else {
        done = blocker.labels.includes(doneLabel);
      }
      cache.set(id, done);
    }
    if (!done) return id;
  }
  return null;
}

/**
 * Claim as many `ready` issues as the concurrency budget allows, in priority
 * + sibling-affinity + created-asc order (`orderEligible`), skipping any
 * whose `blocked_by` isn't fully `<prefix>:done` yet (`frontierBlockedOn`),
 * and kick off `runIssue` for each claimed one in the background.
 */
export async function claimNewWork(deps: WatchDeps, state: WatchRunState): Promise<void> {
  if (state.inflight.size >= deps.concurrency) return;
  const eligible = await deps.provider.listEligible();
  const ordered = orderEligible(eligible, state.inflightParents, deps.labelPrefix);
  const blockerCache = new Map<string, boolean>(); // per-tick — see frontierBlockedOn's doc comment
  for (const issue of ordered) {
    if (state.inflight.size >= deps.concurrency) break;
    if (state.inflight.has(issue.id)) continue;
    const marker = parseRefineMarker(issue.body);
    if (marker.blocked_by.length > 0) {
      const waitingOn = await frontierBlockedOn(deps, marker.blocked_by, blockerCache);
      if (waitingOn) {
        deps.log(`watch: ${issue.id} waiting on #${waitingOn} — not yet at the frontier`);
        continue;
      }
    }
    if (deps.dryRun) {
      deps.log(`watch: [dry-run] would claim ${issue.id} (${issue.title}) and run chain "${deps.chain}"`);
      continue;
    }
    // Gate the tracker-side claim itself behind local exclusivity — see
    // `issueLockPath`'s doc comment. A held lock means a live process (this
    // machine, this tick or an earlier one) already owns this issue's
    // worktree, so skip identically to a lost tracker-side claim race
    // rather than ever writing the tracker label.
    const lockPath = issueLockPath(deps, `issue-${issue.id}`);
    const lock = acquirePidLock(lockPath);
    if (!lock.ok) {
      deps.log(`watch: ${issue.id} is locked by another live \`spf watch\` process (pid ${lock.holderPid}) — skipping`);
      continue;
    }
    const claimed = await deps.provider.claim(issue);
    if (!claimed) {
      deps.log(`watch: ${issue.id} lost the claim race this tick — skipping`);
      releasePidLock(lockPath);
      continue;
    }
    deps.log(`watch: claimed ${issue.id}: ${issue.title}`);
    deps.notify({
      kind: "issue_claimed",
      level: "info",
      title: `issue ${issue.id} claimed`,
      fields: [["issue", issue.id], ["title", issue.title], ["chain", deps.chain]],
    });
    state.inflight.add(issue.id);
    if (marker.parent) state.inflightParents.set(issue.id, marker.parent);
    runIssue(deps, issue).finally(() => {
      state.inflight.delete(issue.id);
      state.inflightParents.delete(issue.id);
      releasePidLock(lockPath);
    });
  }
}

/**
 * Claim as many specs in `from` as `refineConcurrency` allows, and kick off
 * `runSpec` for each in the background. A no-op when `watch.refine` is off.
 *
 * `from` defaults to `spec-ready` (a fresh spec) but `tick()` also calls this
 * with `"continue-refinement"` — a human's signal that they've answered a
 * prior round's questions and refinement should resume. Both share this same
 * function (and `state.refining`'s budget) rather than a second copy of the
 * claim loop, the same way the build lane's `claim()` itself takes a
 * parameterized `{from, to}` rather than a hardcoded `ready -> working`.
 *
 * Known, deliberate wart: `claim()` only removes `from`'s label, so while a
 * resumed run is in flight the issue briefly still carries
 * `<prefix>:needs-feedback` alongside the (now claimed) `refining` state that
 * replaced `continue-refinement`. Nothing polls `needs-feedback` on its own,
 * and the run's own terminating `transition()` — to `needs-feedback` again,
 * `done`, or `blocked` — strips every state label from the fresh snapshot it
 * reads at that point, so this self-heals on the very next transition rather
 * than needing a second mutator alongside `transition()`.
 */
export async function claimSpecs(deps: WatchDeps, state: WatchRunState, from: WatchState = "spec-ready"): Promise<void> {
  if (!deps.refineEnabled) return;
  if (state.refining.size >= deps.refineConcurrency) return;
  const eligible = await deps.provider.listInState(from);
  for (const issue of eligible) {
    if (state.refining.size >= deps.refineConcurrency) break;
    if (state.refining.has(issue.id)) continue;
    if (deps.dryRun) {
      deps.log(`watch: [dry-run] would claim spec ${issue.id} (${issue.title}) and run refine chain "${deps.refineChain}"`);
      continue;
    }
    // See claimNewWork's identical guard and issueLockPath's doc comment —
    // same local-exclusivity gate, keyed to match runSpec's own adwId
    // (`spec-<id>`) so it covers the SAME deterministic worktree a resumed
    // (`continue-refinement`) claim reruns into.
    const lockPath = issueLockPath(deps, `spec-${issue.id}`);
    const lock = acquirePidLock(lockPath);
    if (!lock.ok) {
      deps.log(`watch: spec ${issue.id} is locked by another live \`spf watch\` process (pid ${lock.holderPid}) — skipping`);
      continue;
    }
    const claimed = await deps.provider.claim(issue, { from, to: "refining" });
    if (!claimed) {
      deps.log(`watch: spec ${issue.id} lost the claim race this tick — skipping`);
      releasePidLock(lockPath);
      continue;
    }
    deps.log(`watch: claimed spec ${issue.id}: ${issue.title}`);
    deps.notify({
      kind: "issue_claimed",
      level: "info",
      title: `spec ${issue.id} claimed`,
      fields: [["issue", issue.id], ["title", issue.title], ["chain", deps.refineChain]],
    });
    state.refining.add(issue.id);
    runSpec(deps, issue).finally(() => {
      state.refining.delete(issue.id);
      releasePidLock(lockPath);
    });
  }
}

function tickErrorHandler(deps: WatchDeps, stage: string): (error: unknown) => void {
  return (error: unknown) => {
    // undici (and the tracker/code-host clients built on `fetch`) collapse
    // every connection-level failure to the bare string "fetch failed" and
    // put the actual reason (DNS, ECONNREFUSED, a TLS error — each with a
    // different fix) on `error.cause` — same fold-in `doctor.ts`'s
    // `probeOtel` already does, otherwise this alert has no diagnostic value.
    const err = error as Error & { cause?: { message?: string; code?: string } };
    const cause = err.cause;
    const detail = cause ? ` (${cause.code ?? cause.message ?? String(cause)})` : "";
    // redact(): a fetch failure routinely embeds the URL it attempted, which
    // may carry credentials (e.g. a tracker API token) — never let that reach
    // a log line or an outbound Slack/Teams/webhook notification.
    const message = redact(`${err.message}${detail}`, []);
    deps.log(`watch: ${stage} error: ${message}`);
    deps.notify({ kind: "watch_error", level: "error", title: `watch: ${stage} error`, detail: message, fields: [] });
  };
}

/**
 * One poll tick: reconcile both lanes, finish reviews, then claim both
 * lanes — each stage independently caught, so one stage's error never blocks
 * the rest. `claimSpecs` runs twice: resumed specs (`continue-refinement`,
 * a human who already answered and is waiting) before fresh ones
 * (`spec-ready`) — both share `state.refining`'s budget, so
 * `refine.concurrency` still caps the lane as a whole either way.
 */
export async function tick(deps: WatchDeps, state: WatchRunState): Promise<void> {
  await reconcileOrphans(deps, state).catch(tickErrorHandler(deps, "reconcileOrphans"));
  await reconcileRefining(deps, state).catch(tickErrorHandler(deps, "reconcileRefining"));
  await finishReviews(deps).catch(tickErrorHandler(deps, "finishReviews"));
  // Right after finishReviews, not before it: a leaf that just landed this
  // very tick (and, transitively, any container rollUp() rolled up because
  // of it) can also be the last thing a spec-in-progress spec was waiting
  // on — checking in the same tick is strictly cheaper than making a product
  // manager wait one extra poll interval to see it.
  await finishTrackedSpecs(deps).catch(tickErrorHandler(deps, "finishTrackedSpecs"));
  await claimSpecs(deps, state, "continue-refinement").catch(tickErrorHandler(deps, "claimSpecs(resume)"));
  await claimSpecs(deps, state).catch(tickErrorHandler(deps, "claimSpecs"));
  await claimNewWork(deps, state).catch(tickErrorHandler(deps, "claimNewWork"));
}
