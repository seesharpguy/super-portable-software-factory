# Jev in spf

**Status:** the rails (config, client, policy, trace event, doctor checks)
plus the decision kinds listed under [Decisions](#decisions); `risk_tier`
(#104) is the first live kind. Each feature ticket under epic #102 adds one
kind and a subsection there.
Core ticket: #103. Background: [`brainstorms/jev-in-the-factory.md`](brainstorms/jev-in-the-factory.md).

## What Jev is

Jev is TypeSafe's "System One" model. You give it unstructured context
(`state`) and a set of typed questions. It returns typed answers with
probabilities and a confidence, in roughly 70–500 ms, for about $0.04 per
million input tokens. Output tokens are free. It does not generate text. It
answers three question shapes:

| Shape | You give it | It returns |
|---|---|---|
| `choice` | a closed set of labeled options (≤255) | one option key, per-option probabilities, confidence |
| `score` | an ordered rubric of 2–10 level descriptions | a continuous score, per-level probabilities, confidence |
| `noul` | a yes/no statement | a probability that it is true (spf does not use this shape yet) |

spf uses `choice` and `score` as a fast, cheap advisor to the deterministic
code. It never replaces that code.

## Invariants

spf's rule is *"deterministic TypeScript owns the graph: agent proposes,
code disposes."* Jev follows the same rule. `src/core/jev.ts` enforces all of
the following in one place, so individual features cannot weaken them:

1. **Off by default.** With no `jev:` block, or with `enabled: false`, there
   is no client, no network call, and no trace event. Every decision is the
   deterministic fallback, so runs behave exactly as they did before this
   feature existed.
2. **Closed sets only.** Code builds the option set: an enum, or an
   operator-declared menu. Jev's answer is used only if it is literally one
   of those options. Jev never names a chain, step, gate, model, or command
   that code did not offer it.
3. **Every decision has a deterministic fallback.** The fallback is used
   when Jev is disabled or the kind is `off`, in shadow mode, and when the
   API key is missing. It is also used on a timeout, an error, a malformed
   answer, an out-of-set answer, an answer outside the caller's `permitted`
   subset, or confidence below the threshold.
4. **Shadow vs act.** See [below](#shadow-vs-act).
5. **Every decision is recorded.** Whenever Jev is enabled for a kind, each
   decision (shadow or act, success or failure) is written as one trace
   event. A replay or `spf estimate` reuses the recorded decision instead of
   calling Jev again.
6. **Gates only get stricter.** Jev may add a rejection or stop a loop early.
   It may never approve past a gate, remove a gate, raise a retry ceiling,
   or spend beyond an operator-configured ceiling. None of those moves may
   appear in any option set, and `permitted` lets a caller narrow the set at
   run time (for example, "escalate only while under budget").
7. **Pure modules stay pure.** Resolve a decision once in an impure place,
   such as `startRun`, a loop body, or a watch hook. Then pass the resulting
   `Decision` into pure code (such as `core/tiering.ts`) as data.

## Configuration

```yaml
jev:
  enabled: false            # default. false = total no-op
  mode: shadow              # shadow | act — the default for every kind
  model: jev-latest         # or a pinned version, e.g. jev-1.13
  threshold: 0.7            # min confidence for an answer to act (0–1)
  timeout_ms: 2000          # per call; a timeout falls back
  api_key_env: TYPESAFE_API_KEY   # names the env var; never the key itself
  base_url: ""              # "" = https://api.typesafe.ai/v1 (POST …/systemone)
  decisions:                # per-kind overrides + feature settings
    risk_tier:              # (example — kinds are added by feature tickets)
      mode: act             # off | shadow | act
      threshold: 0.8
      timeout_ms: 500
      max_risk: standard    # a feature-specific key, validated by that feature
```

- **Merge across config layers.** Top-level keys merge key by key, so an
  override that only sets `enabled: true` keeps the base's threshold and
  model. `decisions` is replaced as a whole object, like `tiering.roles`.
- **`enabled: false` always wins.** It overrides every per-kind `mode`.
- **`spf doctor`.** When Jev is disabled, doctor shows nothing about it.
  When it is enabled, doctor shows:
  - the resolved settings, as info;
  - a **warning** if the API key env var is unset (every decision would fall
    back with `no_api_key`), which does not fail doctor;
  - a **failure** for a `base_url` that is not http(s);
  - a **warning** for a `decisions` key that is not a registered kind
    (usually a typo);
  - a **failure** for a known kind whose feature settings do not validate.

  Doctor never calls Jev, because a live probe would spend tokens on every
  run.

## Shadow vs act

| | Jev called? | Recorded? | What acts |
|---|---|---|---|
| disabled / kind `off` | no | no | fallback |
| `shadow` | yes | yes | **fallback** |
| `act` | yes | yes | Jev's answer if it is in the set, permitted, and confident; otherwise the fallback |

Run a kind in `shadow` first. Its recorded decisions show how often Jev
agreed with the heuristic, and whether act mode would have used its answer.
Compare that with the run's real outcome (accepted, blocked, cost) in the
trace db. Flip a single kind to `act` with `jev.decisions.<kind>.mode: act`
once the numbers support it.

## The trace event

Every recorded decision is one `events` row with `type: "log"` and
`name: "jev_decision"`. It is not a new event type, because that list is
closed and mirrored by the UI. The payload is the whole `Decision`:

| field | meaning |
|---|---|
| `kind`, `key` | which decision (`key` tells repeats in one run apart, e.g. `fix_2`) |
| `question` | `choice` or `score` |
| `options` | the closed set offered, in order |
| `choice` | **the effective choice**: what code acted on |
| `jev_choice` | what Jev answered, if it was in the set; else `null` |
| `confidence`, `score`, `probabilities` | as returned (confidence derived from probabilities if absent) |
| `fallback`, `used_fallback` | the deterministic answer, and whether it acted |
| `reason` | why the fallback acted, or `null` if Jev's answer acted (see below) |
| `detail` | human-readable context (error text, confidence vs threshold) |
| `would_act` | act mode would have used Jev's answer |
| `agrees` | `jev_choice === fallback` |
| `latency_ms`, `model`, `usage` | call cost and speed |
| `mode`, `threshold` | the policy in force |
| `input_sha256` | hash of state + instructions + options (the state itself is not stored). For offline analysis only: replay does not compare it. `""` when nothing was hashed |
| `replayed` | this decision reused an answer recorded in an earlier trace |

`reason` is the **first** check that disqualified Jev's answer, in this
order: `disabled`, `kind_off`, `replay_missing`, `no_api_key`, `timeout`,
`error`, `invalid_response`, `invalid_choice`, `not_permitted`,
`low_confidence`, `shadow`. In shadow mode, `reason: "shadow"` therefore
means "valid and confident: act mode would have used this answer."

The event is never exported to OpenTelemetry, because `log` events are not
in otel's allowlist.

## For feature implementers

```ts
import { findRecordedDecision, parseDecisionExtras } from "../core/jev.ts";
import { MY_KIND } from "../core/jev_kinds.ts";

const decision = await run.jev.decide({
  kind: MY_KIND.kind,          // registered in core/jev_kinds.ts
  key: "",                     // disambiguate repeats in one run
  options: [{ value: "low", description: "…" }, …],   // closed, code-built
  instructions: "…",           // the question
  state: issueBody,            // context; only its sha256 is recorded
  fallback: heuristicAnswer,   // what the code would have done anyway
  permitted: [...],            // optional run-time narrowing (monotone authority)
  phase_id: ph.phase_id,       // optional; PhaseHandle exposes the open phase's id
});
act(decision.choice);          // ALWAYS act on .choice, never .jev_choice
```

- `run.jev` is already wired to the run's trace. For code that runs before a
  run exists (the watch lane), build one with
  `createJev({ config: cfg.jev, recorder: traceDecisionRecorder(tracer, adwId) })`.
- `decideBatch(state, items)` asks several questions over one shared state
  in **one** HTTP call, for example "triage each of these N findings".
- To replay, pass `replay: await findRecordedDecision(run.tracer.db, adwId, kind, key)`.
  The recorded **answer** is reused without calling Jev, then judged again
  under today's policy and `permitted`. With an unchanged policy the
  effective choice is the recorded one. If the caller no longer permits the
  recorded choice, it is `not_permitted`. If the kind is now in shadow mode,
  the fallback acts. A recorded failure (timeout, error, and so on) replays
  as that same failure. `null` means replay mode with nothing recorded, so
  the fallback acts and Jev is not called. A recording made for a different
  question (kind, key, question, options, or fallback changed) is
  `replay_missing`. `enabled: false` or a kind set to `off` beats any
  replay: the result is `disabled`/`kind_off` and nothing is recorded.
- Tests use `src/test/fake_jev.ts`'s `FakeJevClient`, passed as
  `createJev({ client })` or process-wide with `setJevClientFactory(() => fake)`.
  Always reset it with `setJevClientFactory(null)`.
- `decide()` throws only on programmer errors, such as an empty option set
  or a fallback that is not one of the options. It throws these even when
  Jev is disabled, so the call site's own unit test catches them.

### Rules for implementers

1. **`key` must be stable across runs.** Replay looks up the latest
   `(kind, key)` match. Use something that names the same logical question
   in every run, such as a finding fingerprint or `fix_<round>`. Never use
   an array index: once the list order changes, an index key replays the
   wrong item. (`decideBatch` question names `q0`, `q1`, ... are wire names
   only and are never used for replay.)
2. **Always compute the heuristic.** The fallback is computed on every
   call, in act mode too. It is the answer whenever Jev's cannot act, and
   shadow analysis compares against it.
3. **Check run-time option sets before calling `decide()`.** When options
   come from run-time or operator data (a chain menu from `watch.chains`,
   one option per finding), call `isValidOptionSet(options, fallback, {permitted})`
   (or `optionSetProblem(...)` for the message) first. If the set is
   degenerate (empty, duplicated, or missing the fallback), skip `decide()`
   and use the heuristic directly. Letting `decide()` throw is only for
   statically built sets, where it fails the call site's unit test. A throw
   from operator data would crash a run that works with no `jev:` block.
4. **`JevDecisionKindSpec.options` is display only.** Doctor shows it, and
   nothing checks it against the options a call site sends. Build the call
   site's options from the same constant as the spec so they cannot drift.
5. **`extras` and `parseDecisionExtras` are optional.** A kind with no
   feature settings omits `extras` and never calls `parseDecisionExtras`.
6. **Where to decide.** Inside a phase, pass that phase's
   `ph.phase_id` as `phase_id`. For run-scoped decisions (such as
   `startRun`), leave it `""`. The watch lane has no `Run`: build a `Jev`
   with `createJev({ config: cfg.jev, recorder: traceDecisionRecorder(tracer, adwId) })`
   once the lane has a tracer and an `adwId`. Before then, use
   `recorder: null`. That decision still acts, but it is not in any trace,
   so say so in your kind's docs.
7. **Mixing kinds in one `decideBatch` is allowed.** Each item is judged
   under its own kind's policy, and the call's deadline is the largest live
   `timeout_ms`. Keep a batch to one kind unless the items genuinely share
   one `state`.
8. **Each feature proves invariant 1 through its real call site.** Add a
   test showing that with no `jev:` block the feature's result equals the
   heuristic and the trace has zero `jev_decision` rows. Keeping existing
   tests unmodified is not enough, because it cannot cover new code paths.

## Decisions

Each feature ticket appends one subsection here with: the kind name, the
option set, the fallback (the existing heuristic), where it is resolved,
what acting on it can and cannot do, and any `jev.decisions.<kind>`
settings it adds.

<!-- One "### `kind`" subsection per kind, ALPHABETICAL by kind. Insert yours in order; do not edit neighbors. -->

### `chain_edge`

Picks the next step at a branch point of a repo graph chain: a
`.spf/chains/*.yaml` step that declares more than one `next:` edge. Ticket
#109. Code: `src/chains/graph.ts`. How to author a graph chain:
[`authoring_chains.md`](../assets/skill/cookbooks/authoring_chains.md#declared-transitions-next).

- **Question and options.** A `choice` over that step's declared `next:`
  step ids, in the order the yaml lists them. The set is built from the
  yaml, so the kind declares no static `options`. Jev cannot name a step
  the author did not list as an edge of that step.
- **Fallback.** The step's `default:` edge. If `default:` is omitted, the
  fallback is the linear next step, which the loader requires to be one of
  the edges. If the fallback's target has used up its `max_visits`, the
  first declared edge whose target has not becomes the fallback. This is
  exactly the path the chain takes with no `jev:` block.
- **Where it is resolved.** In `walkGraph` (called by `steps.runSteps`)
  after the branch step finishes and before the next one starts, through
  `run.jev`. `phase_id` is `""` because the decision sits between phases.
  `key` is `<step id>#<visit>`, for example `triage#2` for the second time
  `triage` ran. It is stable across runs and never a list index. The state
  Jev sees is the chain name, the request (clipped), the path so far,
  `accepted`/`reason`, the last envelope's status and summary, and the
  last quality or review result in brief.
- **`permitted`.** Only the edges whose target still has `max_visits` left.
  When only one edge is open, Jev is not asked. When none is open, the walk
  stops and the run is not accepted.
- **What acting on it can do.** Jev can take a different declared edge.
  That can run an extra check or review, loop back to a step for another
  bounded attempt, or end the chain early at a `next: []` step.
- **What it cannot do.** The loader rejects any graph in which that could
  weaken the chain (invariant 6):
  - every cycle must pass through a `max_visits` step, and `max_steps`
    caps total step executions;
  - no path may reach a `commit` without every gating step
    (`qualityCheck`, `fixLoop`, `reviseLoop`) that the default path runs
    before it;
  - an `onlyIfAccepted` commit needs at least one gating step on every
    path to it.

  At run time, `accepted` on a graph chain is the AND of each gating
  step's latest result. A passing check Jev routes to therefore cannot
  overwrite an earlier failure.
- **Replay.** Every transition is a `chain_edge` log event, with
  `from`/`to`/`via`/`visit` and, at a branch point, `key`, `options`,
  `permitted` and `fallback`. A finished walk also writes one `chain_path`
  event holding the whole path. To retrace a run without calling Jev, pass
  `walkGraph(run, state, graph, { replay: (key) => findRecordedDecision(db, adwId, "chain_edge", key) })`.
- **Extras.** None. Tune it with `jev.decisions.chain_edge.{mode,threshold,timeout_ms}` only.


### `chain_router`

Picks which chain builds an issue that `spf watch` claims. Ticket #107.

```yaml
watch:
  chain: plan-build-test              # the default, and the fallback
  chains: [plan-build, build-review]  # the allowlist the router may pick from
jev:
  enabled: true
  decisions:
    chain_router: { mode: shadow }    # or act / off; threshold, timeout_ms as usual; replay: true (default)
```

- **Kind:** `chain_router`, a `choice` question.
- **Options:** built by code at claim time, not static. The menu is
  `watch.chain` first, then each `watch.chains` entry in the order written,
  with duplicates removed. Each option's value is the chain name. Its
  description, which only Jev sees, is the chain's `describe` line plus its
  derived `phases` string. The state Jev reads is the issue's id, title and
  body (the body is cut to 4,000 characters), the default chain, and whether
  a commit chain is required. The trace records only a sha256 of that state.
- **Fallback:** `watch.chain`, the one chain `spf watch` ran before this
  feature existed. It is always on the menu, so you do not need to repeat it
  in `watch.chains`.
- **Where it is resolved:** in `core/watch.ts`, at claim time and before
  any worktree is created, through the `WatchDeps.routeChain` callback. That
  callback is built by `makeWatchChainRouter` in `cli/commands/watch.ts`
  over `core/chain_router.ts`. `key` is the issue id and `phase_id` is `""`,
  because no chain has started yet. The decision is written to the main
  repo's trace db under the claim's adw_id: `issue-<id>` for single
  dispatch, or the best-of-N base id (for example `issue-<id>`) that the
  attempt ids derive from. `spf phases issue-<id>` shows it. If the trace db
  cannot be opened, the claim never blocks, but an unrecorded decision never
  acts either: in `act` mode Jev is asked in shadow for that claim (the log
  line shows its suggestion) and `watch.chain` runs; in `shadow` mode the
  decision is simply untraced. One log line says which. Plain `ready`
  claims are routed. A `feedback` revision never asks Jev: it rebuilds with
  the chain recorded on the issue's marker (`WatchMarker.chain`, written
  only when a claim was routed away from `watch.chain`) while that chain is
  still in `watch.chains`, and otherwise runs `watch.chain`.
- **Replay:** a re-claim of the same issue (`blocked` back to `ready`, a
  daemon restart) looks up the latest recorded `chain_router` decision for
  that adw_id and issue id and passes it to `decide()` as `replay`: no Jev
  call, the recorded answer re-judged under today's mode, threshold and
  menu. A row is reused only when Jev actually answered (a recorded
  timeout or error is asked again, not pinned forever) and the menu and
  fallback are unchanged (edit `watch.chain`/`watch.chains` and the next
  claim asks live). A best-of-N base id bumped past a crashed attempt is a
  new adw_id, so it asks live too. Set `replay: false` to ask on every
  claim.
- **Best-of-N:** when `watch.fanout.n > 1`, chains with no commit step are
  removed from the menu in code before Jev is asked, so Jev never sees
  them. This uses the same `hasCommitStep` check as the startup refusal. A
  routed chain is checked again when each attempt dispatches.
- **Degenerate menus skip Jev:** if the menu has fewer than two chains
  after filtering (for example the allowlist holds only non-commit chains
  under best-of-N), `decide()` is not called. The fallback runs and no
  trace row is written.
- **What acting can do:** swap which operator-allowlisted chain runs for
  this one issue. `core/watch.ts` re-checks the answer against `watch.chain`
  plus `watch.chains` before dispatching, so even a router that strayed off
  its menu cannot start any other registered chain. Only `act` mode is
  announced: spf posts one issue comment naming the chosen chain and why
  (routed, kept, or which fallback), and the PR body gets the same line. In
  `shadow` mode, and with Jev off, nothing appears on the tracker; Jev's
  suggestion is in the trace and the daemon log only. With routing
  configured, the `issue_claimed` notification is sent after routing, so
  its `chain` field names the chain that runs, and `--dry-run` says routing
  is enabled.
- **What acting cannot do:** name a chain outside the menu (that answer is
  `invalid_choice` and the fallback runs), pick a non-commit chain under
  best-of-N, or change anything inside a chain. Every chain's own gates,
  retry limits and budget ceilings run unchanged. Routing never changes
  `watch.chain_options`, the adw_id, the branch, or the worktree.
- **Validation:** every `watch.chains` name must resolve through
  `findChain`. This is checked at `spf watch` startup, not when the config
  is loaded (the chain registry is per repo and is built after config load,
  the same as for `watch.chain`): `spf watch` refuses to start, and
  `spf doctor` fails a `watch.chains` check. Doctor also runs the same suites and owners
  checks on each allowlisted chain as on `watch.chain`, and under best-of-N
  it warns which allowlisted chains will never be offered.
- **Extras:** `replay` (boolean, default `true`), described under
  **Replay** above. An invalid value stops `spf watch` at startup and fails
  `spf doctor`.


### `finding_triage`

Ticket #106. Before a rejected review's findings reach the fixing agent,
Jev classifies each **unmet** finding (`met: false` in the reviewer's
`ReviewOutput`) so the fixer spends its round on what matters.

- **Question:** `choice`, one per unmet finding, all asked in ONE
  `decideBatch` call per round. The state is the request plus the review
  (summary, up to 25 `blocking` entries, and the unmet findings, each with
  an `id` = its fingerprint). Each question is a short pointer ("classify
  the finding whose id is ...") and never restates the finding. The state
  is clipped by progressively tighter limits until it fits a fixed
  character budget, so the whole request stays inside Jev's ~32k-token
  budget even at the cap (`TRIAGE_REQUEST_CHAR_BUDGET` in
  `chains/finding_triage.ts`; a test pins the worst case). At most 50
  distinct findings are asked about per round; any beyond that keep the
  fallback.
- **Options:** `real | noise | style` (`FINDING_TRIAGE_CLASSES` in
  `core/jev_kinds.ts`; the call site builds its options from that tuple).
  `real` = a genuine unmet requirement or defect; `noise` = a false
  positive, already satisfied, out of scope, or unactionable; `style` = a
  cosmetic preference that does not decide whether the request is met.
- **Fallback:** `real` for every finding, which is today's behavior: the
  fixer is asked to close all of them.
- **Key:** `revise_<round>:<fingerprint>`, where the fingerprint is the
  first 16 hex chars of sha256 of the finding's normalized requirement text
  (case, whitespace, and evidence do not change it). Findings with the same
  requirement share one question.
- **Where:** inside the revise phase of `reviseLoop` (`chains/steps.ts`) and
  of the built-in `simple_sdlc` chain's review loop, so each decision's
  `phase_id` is that `revise_<round>` phase (`ph.phase_id`). The call site is live only; it
  does not pass `replay` yet, but the keys are stable, so a replay caller
  can look decisions up with `findRecordedDecision(db, adwId,
  "finding_triage", key)`.
- **What acting on it does (act mode, confident answer):** a `noise` or
  `style` finding is removed from the handoff's `findings`. Any `blocking`
  entry whose text is the same requirement (after case and whitespace
  normalization) goes with it. A blocker worded differently stays, because
  spf never guesses which free-text blocker a finding means. This only
  happens while at least one unmet finding is still `real` (see "never
  empties the ask" below). With the
  default `drop: none`, each demoted finding is listed again under a
  `## Deprioritized by jev` section appended to the envelope's
  `notes_for_next_agent`, so the fixer still sees it, ranked after the real
  work. When anything was demoted, one `log`/`jev_triage` event on the
  revise phase records what was kept, deprioritized, and dropped.
- **What it can never do:**
  - It never changes `approved`. The loop's verdict, `state.review`, and
    `state.accepted` all come from the reviewer's original envelope, and
    the reviewer rules on every requirement again next round. Triage shapes
    what the fixer is asked to fix. It cannot turn a rejection into an
    approval.
  - It never empties the ask. If every unmet finding comes back demoted,
    the handoff's `findings` and `blocking` are passed through unchanged,
    whatever `drop` says; the demotions only add the
    `## Deprioritized by jev` note. The `jev_triage` event records
    `all_demoted: true` (and `drop_suspended: true` when `drop` would have
    withheld some). So a rejected review always reaches the fixer with a
    non-empty structured to-do list, and every handoff still passes
    `gates.verdictConsistent` just as the reviewer's own envelope did.
  - The next review round is handed the builder's envelope, never the
    triaged handoff.
  - A failure writing the `jev_triage` event is warned about once on
    stderr and never fails the revise phase, the same as `jev_decision`
    rows.
  - It never triages `met: true` findings or an approving review.
- **Shadow mode:** Jev is called and every decision is recorded, but the
  fallback (`real`) acts, so the fixer receives the reviewer's envelope
  unchanged.
- **Not triaged:** `fixLoop`'s suite output. A `QualityResult` holds one
  verbatim output blob per check (whatever the linter or test runner
  printed), not a list of findings, and splitting arbitrary tool output per
  finding would mean parsing formats spf does not own. To get triage for an
  external reviewer, have a reviewer agent consult it and use `reviseLoop`
  (see `cookbooks/ocr_reviewer.md`).
- **Extras** (`jev.decisions.finding_triage`):

  ```yaml
  jev:
    enabled: true
    decisions:
      finding_triage:
        mode: act
        timeout_ms: 10000   # recommended: one call carries up to 50 questions
        drop: none          # none | noise | noise_and_style
  ```

  The ticket's `jev.triage.drop` is spelled
  `jev.decisions.finding_triage.drop` here, following the
  `jev.decisions.<kind>` convention every kind uses. A top-level
  `jev.triage:` key is not a setting: the config schema ignores unknown
  `jev:` keys without a warning, so a setting placed there silently does
  nothing.

  **Timeout.** The global default `timeout_ms: 2000` is sized for one
  question. A triage batch asks up to 50 in one call, so give this kind its
  own `timeout_ms` (10000 is a reasonable start). A timeout is safe, since
  every finding falls back to `real`, but it turns triage off for that
  round.

  `drop` picks which demoted findings are withheld from the fixer entirely
  rather than deprioritized. `none` (default): every finding still reaches
  the fixer. `noise`: `noise` findings are withheld and `style` findings are
  deprioritized. `noise_and_style`: both are withheld. A withheld finding
  is never silent: its `jev_decision` row and the `jev_triage` event both
  record it. An invalid value fails the run in `startRun` with
  `jev.decisions.finding_triage: ...`, before the first phase and so
  before any agent spend (`startRun` parses the settings of every
  registered kind that is not `off`; `risk_tier` keeps its own narrower
  rule and is parsed only while tiering is on too). `spf doctor` reports
  it too.


### `intake_feedback`

Ticket #108. It classifies the new PR comments behind a `<prefix>:feedback`
label in the build lane's revision loop.

- **Options** (`choice`): `revise` | `question` | `approve` | `out_of_scope`.
- **Fallback**: `revise`. This is today's behavior: every `feedback` claim
  reruns the chain.
- **Resolved in** `core/watch.ts` `classifyFeedback`, called from
  `runIssueSingle`'s revision branch after `claimFeedback` claims the issue
  and the PR's comments are read. This happens before any worktree write.
  The adw_id is `issue-<id>`, which the revision run reuses,
  and `phase_id` is `""`. The key is `pr<n>:r<round>:<last comment id>`.
  Jev reads the same comments `buildIssuePrompt` shows as "Corrections to
  address": the comments since the last push, or all comments when there is
  no watermark. The issue body is not included. If there are no such
  comments, Jev is not called and the result is `revise`.
- **Acting on it**:
  - `revise` runs the revision exactly as before.
  - `question` posts an acknowledgement comment on the issue and does not
    run the chain.
  - `approve` and `out_of_scope` are logged only while the PR is open. On
    a closed PR they also post a one-line comment, because the issue lands
    on `blocked`, and a silent `blocked` would be a dead end.
  - Every choice except `revise` moves the issue back to `review` if the PR
    is open, or `blocked` if it is closed. It first records the answered
    key and choice on the marker (`WatchMarker.intake_feedback`). The PR,
    its branch, and every other marker field are not changed.
- **Human override**: when the human adds `feedback` again with no new PR
  comment, the key is the same as the recorded one. spf reads that as
  "revise anyway": it revises and does not call Jev. With a new comment,
  the key changes, and Jev classifies the new batch. So a wrong answer
  costs one relabel, and the issue never bounces between `feedback` and
  `review`.
- **What it cannot do**: skip a revision's gates, merge or approve a PR, or
  move anything to `done`. `approve` only means "no rerun". The PR still
  needs a human to merge it, and `finishReviews` still decides `done`. The
  worst a wrong answer can do is skip a revision a human asked for until
  the human adds the label again (see the override above). Turning the kind
  to `off` restores today's behavior.
- **Replay**: never replayed. In act mode each key is asked at most once:
  a non-`revise` answer is on the marker before anything else acts, and the
  next claim with that key is the override. A `revise` answer bumps the
  round, which changes the key. The recorded decision is for offline
  analysis only (`listRecordedDecisions`).
- **Default on**: none of the intake decisions needs its own opt-in.
  `jev.enabled: true` turns this kind on at the global `jev.mode`. If that
  mode is `act`, the kind acts on your tracker. To opt out, set
  `jev.decisions.intake_feedback.mode: off`.
- **Extras**: none. Use `jev.decisions.intake_feedback.mode` to turn it on
  or off independently of `intake_readiness`.


### `intake_readiness`

Ticket #108. It decides, before `spf watch` claims a `<prefix>:ready`
issue, whether to build it as written.

- **Options** (`choice`): `build` | `refine` | `needs_human`.
- **Fallback**: `build`. This is today's behavior.
- **Resolved in** `core/watch.ts` `routeReadiness`, called from
  `claimNewWork` after the frontier check and local lock, and before the
  tracker-side `claim()`. The adw_id is `issue-<id>`, `phase_id` is `""`,
  and the key is `""`. Jev reads the issue's id, title, labels, and body
  (truncated).
- **`permitted`**:
  - `build` and `needs_human` are always permitted.
  - `refine` is permitted only while `watch.refine.enabled` is true, and
    only for an issue the refine lane did not create itself (no
    `spf-refine:` marker in the body). This prevents a loop.
- **Runs once per issue**: an issue that already has any watch marker is
  always `build`, and Jev is not called. This covers an earlier routing, an
  earlier build, or a PR. Relabeling a routed issue `ready` therefore
  overrules the router.
- **Acting on it**:
  - `refine` moves the issue to `<prefix>:spec-ready` with an explanatory
    comment.
  - `needs_human` moves the issue to `<prefix>:blocked` with a needs-info
    comment, then sends an `issue_blocked` notification. This reuses the
    existing blocked state, so there is no new label.

  Only after that transition succeeds does the router write the marker
  (`WatchMarker.intake = {routed, at}`), so the marker only records routings
  that happened. A routed issue is never claimed and never uses the
  concurrency budget. A tracker error while routing skips the issue for
  that tick:
  - If the transition fails, the issue stays `ready` with no marker and no
    notification, and the next tick routes it again.
  - If the marker write fails after the transition, the issue stays routed
    but has no marker. A human's relabel to `ready` then routes it once
    more.
- **Per-tick cap**: routings that send an issue away (and routing errors)
  do not spend the concurrency budget. Instead, they are capped at
  `watch.concurrency` per tick, and the other issues wait for the next
  tick. A tick therefore makes at most 2 x `concurrency` readiness calls,
  each bounded by `timeout_ms`.
- **Replay**: never replayed. The router only asks about an issue with no
  marker. After an answer, an issue has no marker only if a tracker write
  failed. In that case a fresh answer about the issue as it is now is the
  right one. The recorded decision is for offline analysis only
  (`listRecordedDecisions`).
- **Several daemons**: the router runs before `claim()`'s compare-and-set,
  and the pid lock only protects one machine. So two daemons on different
  machines watching the same repo could both route one issue in the same
  tick. That means a duplicate comment and a duplicate Jev call. This is
  accepted, because the watch lane does not support that setup anyway:
  `reconcileOrphans` treats every `working` issue that its own process is
  not running as an orphan.
- **What it cannot do**: skip a gate or push work forward. It can only send
  unclaimed work away from the build lane, to a human or to decomposition.
  `refine` is impossible while the refine lane is off. A mode of `off`
  skips the marker read too, so it adds no tracker call.
- **Default on**: `jev.enabled: true` turns this kind on at the global
  `jev.mode`, just like `intake_feedback`. There is no separate intake
  opt-in. To opt out, set `jev.decisions.intake_readiness.mode: off`.
- **Extras**: none. Use `jev.decisions.intake_readiness.mode` to toggle it.

**Tracing for both kinds**: `spf watch` has no `Run` before a claim. When
`jev.enabled` is true and at least one intake kind is not `off`,
`cli/commands/watch.ts` `openWatchIntakeJev` opens one Tracer for the
daemon's lifetime on the normal trace db. It records each decision under
the issue's adw_id. The JSONL copy goes to
`<data_dir>/watch/jev_events.jsonl`. Otherwise nothing is opened and
`WatchDeps.intakeJev` is unset.


### `loop_control`

Ticket #105. After a failed round in `fixLoop` or `reviseLoop`
(`src/chains/steps.ts`), spf asks Jev what the loop should do next.

- **Kind:** `loop_control`, a `choice` question.
- **Options:** `continue`, `escalate_tier`, `stop_blocked`. Both the
  kind spec and the call site build these from the single constant
  `LOOP_CONTROL_CHOICES`.
- **Fallback:** `continue`. This is the existing behavior: spend the next
  repair round on the same agent and the same model. Every fallback reason
  (disabled, shadow, timeout, error, low confidence, a choice outside the
  set or outside `permitted`) runs the loop you have today.
- **When spf asks:** only after a round fails and another repair round would
  otherwise run. It never asks after a passing round or on the final round,
  because the loop ends there anyway. A loop with `max: 3` makes at most two
  decisions.
- **Where it is resolved:** `src/chains/loop_control.ts`
  (`createLoopControl`), called from the loop body between the failed round
  and the repair phase.
  - The decision's `phase_id` is the failed round's phase (`test_2`,
    `verify_1`, `review_1`, ...).
  - Its `key` is `fix:<round phase>` or `revise:<round phase>`, for example
    `fix:test_1` or `revise:review_2`. A chain that runs the same loop again
    in one run (a repo chain listing `fixLoop` twice over one suite, or
    `reviseLoop` twice) numbers the later loops: `fix#2:test_1`,
    `revise#2:review_1`. Loops are counted in the order they start, so for a
    fixed chain the key stays stable across runs and never collides within
    one.
  - Replay: a replay or estimate driver puts a run's loops in replay mode
    with `setLoopControlReplay(run, resolver)`. The usual resolver is
    `recordedDecisionReplay(db, sourceAdwId)`, which looks up the recorded
    decision by that key. `decide()` re-judges the recorded answer under
    today's policy and today's `permitted`, so a recorded `escalate_tier`
    replays as `not_permitted` once `max_tier` is removed, and a loop with
    nothing recorded falls back (`replay_missing`, `continue`). Nothing in
    spf drives a replay yet; `spf estimate` does not run loops.
  - The `state` Jev sees: the loop and round, `max_rounds` and the repair
    rounds left, the repairing agent and its current tier, whether escalation
    is available (and if not, why), the latest round's detail, and a short
    history of earlier rounds with the action taken after each. For
    `fixLoop`, the latest round's detail is the failures plus each failed
    check's command, exit code, and clipped output tail. For `reviseLoop`, it
    is the reviewer's summary, its `blocking` list, and its unmet findings.
  - The state is bounded so it stays inside Jev's state budget: each list
    keeps its first 20 entries plus a "… and N more" line (with the full
    count alongside), every text field is clipped, the history keeps the
    last 6 rounds, and a state still over about 48,000 characters is cut
    down further (older history first, then the latest detail).
- **What acting on it can do:**
  - `stop_blocked` ends the loop immediately with no further repair round.
    The run is **not accepted**, and its reason reads
    `stopped after round N of M: ... (loop_control)`.
  - `escalate_tier` moves the repairing role (the fix `owner`, or the
    reviseLoop `builder`) up **one** rung of `tiering.tiers` for the rest of
    **this** loop. It goes through the same `effectiveAgent()` dispatch seam
    that tiering uses. Only the model changes. When the loop exits, the run's
    original routing is restored, even if a phase throws.
  - Escalating opens a fresh agent session for the repairing role. spf
    rejoins a session only on the model it was opened with, so the escalated
    rounds do not see the earlier rounds' conversation. They get the prompt
    and the failing round's verbatim output, which is what every repair
    round gets. When the loop exits, spf restores the role's
    `agent_map.json` entry, so later phases on the original model rejoin
    their original session.
  - A `loop_control` log event and a console line record every
    non-`continue` action. An escalation also records its `from_tier` and
    `to_tier`.
- **What acting on it cannot do:**
  - add a round. The configured `max` is a hard ceiling;
  - skip, weaken, or pass a gate. Every check and review phase runs as
    before, and a stop never turns a failure into acceptance;
  - retier the reviewer. When one agent is both the reviewer and the
    builder of a `reviseLoop`, escalation is refused for that loop, because
    tiering routes by agent name and moving the author would move the
    critic too. Only `continue` and `stop_blocked` can act there;
  - skip a rung;
  - escalate more than once per loop;
  - escalate above the operator's ceiling. `escalate_tier` is in
    `permitted` only when every one of these holds:
    - `max_tier` is set and names a declared rung;
    - tiering is enabled and routed this role this run;
    - the next rung up is at or below `max_tier`;
    - that rung is usable under the same backend and served-tag rule as
      `resolveTiering`;
    - the reviewer and the builder are different agents (`reviseLoop` only);
    - this loop has not already escalated.

    In every other case, Jev's `escalate_tier` becomes `not_permitted`, and
    the loop continues. The same holds on replay.
- **Settings (`extras`):**

  ```yaml
  jev:
    decisions:
      loop_control:
        mode: act           # common knobs as usual
        max_tier: strong    # the highest tiering.tiers rung escalation may reach
  ```

  `max_tier` is the operator spend ceiling. Ticket #105 called it
  `jev.loop.max_tier`, but it lives under the kind's own `jev.decisions`
  entry, as the core contract requires for every feature setting. A
  `jev.loop:` block is dropped when the config is parsed, so it would leave
  escalation silently off; `spf doctor` warns (`jev.loop`) when any config
  layer has one. When it is absent, which is the default,
  escalation is disabled and only `continue` and `stop_blocked` can act. A
  malformed value fails `spf doctor`. It also fails `startRun` whenever the
  kind is live. A `max_tier` that names no declared rung disables
  escalation, and the reason appears in the state Jev sees.


### `risk_tier`

Classifies a run's risk for tiering (#104). Code: `src/core/risk_tier.ts`.

- **Kind:** `risk_tier`, a `choice` question.
- **Options:** `low | standard | high`, in ladder order, weakest first. The
  set is closed and built from `RISK_TIER_KIND.options`.
- **Fallback:** the existing `classifyRisk` heuristic in
  `src/core/tiering.ts`, which adds chain weight and prompt word count. It is
  computed on every call, act mode included.
- **Where it is resolved:** once per `startRun` call in
  `src/chains/steps.ts`, before any phase opens.
  - `phase_id` is `""` (run-scoped).
  - `key` is the chain name, so a joined session's second `startRun` under
    a different chain has its own key.
  - The `Decision` goes into the pure `resolveTiering` as data
    (`TierInput.riskDecision`). `resolveTiering` never calls Jev.
  - The Jev call runs concurrently with the ollama tag probe, so it adds at
    most `max(probe, timeout_ms)` to run start, not their sum.
  - **Resume:** a run that re-enters `startRun` under the same `adw_id` and
    chain (the watch lane's continue-refinement resume, the build lane's
    `spf:feedback` loop) replays that run's own latest `risk_tier` decision
    instead of asking Jev again, so both halves of one run route from the
    same answer. The replay is judged again under today's policy and
    `max_risk`, and is recorded as another row with `replayed: true`. It is
    used only when the question is the same (same options and same
    heuristic fallback). A resumed prompt that lands in a different
    word-count bucket is a new question, so it is asked live and recorded.
- **When it is asked at all:** only when `jev.enabled` is true, the kind's
  mode is not `off`, and `tiering.enabled` is true. Risk changes nothing but
  tiering's routing, so with tiering off no call is spent. If any of the
  three is false, no call is made, no `jev_decision` row is written, the
  extras are not parsed, and the `tiering` event is unchanged.
- **Trace:** the full decision is its own `jev_decision` row. The existing
  `tiering` log event also carries a compact `jev` summary: `choice`,
  `jev_choice`, `confidence`, `fallback`, `used_fallback`, `reason`,
  `mode`, `would_act`, `replayed`, `kind` and `key`. `risk` in that event is
  the effective risk, and `signals` are still the heuristic's. A console
  note is printed only when Jev's answer moved the risk off the heuristic's.
- **`spf estimate`** never calls Jev. By default it uses the heuristic. With
  `--replay-risk <adw_id>`, it replays the decision that run recorded for
  this chain, judged again under today's policy, with no call and no row
  written. When `risk_tier` is live for the config, or a replay is asked
  for, the report says which source it used: `risk_source` in `--json`, and
  a `risk from` line in text. A replay only matches when today's heuristic
  gives the same fallback (same chain, and a prompt in the same word-count
  bucket). Otherwise the reason is `replay_missing` and the heuristic acts.
  A recording above today's `max_risk` replays as `not_permitted`. Invalid
  `risk_tier` extras with `--replay-risk` exit 1 with the
  `jev.decisions.risk_tier: ...` config error. With no trace db under
  `--cwd`, the detail says there is nothing to replay.
- **What acting on it can do:** pick which rung of the operator's own
  `tiering.tiers` ladder each routed role starts from. This is the same
  one-step shift the heuristic makes.
- **What it cannot do:**
  - name a model, add a rung, or route a role that `tiering.roles` does not
    name
  - walk up past an unusable rung (the walk only goes down)
  - raise `max_run_tokens` or `max_run_cost`, which are enforced as before
  - act above `max_risk` (see below)
- **Shadow mode:** Jev is asked and the answer is recorded, but the
  heuristic's risk routes the run.
- **What leaves the machine:** when the kind is live, Jev's `state` carries
  the chain name, the heuristic's signals, and the head of the operator's
  prompt (up to `max_prompt_chars`, default 4000). Prompts often embed issue
  bodies and comment threads (the watch resume folds the whole thread in).
  Set `max_prompt_chars: 0` to send only the chain name and the signals.
- **Config validation:** `startRun` validates the extras only when the kind
  is live, which includes `tiering.enabled`. With tiering off the extras are
  never read, so an invalid `max_risk` does not fail a run (a feature that
  is off is a no-op). `spf doctor` validates them regardless, so it catches
  a latent typo before tiering is turned on.

Extras, under `jev.decisions.risk_tier`:

| key | default | meaning |
|---|---|---|
| `max_risk` | `high` | The highest risk Jev's answer may act on (the `permitted` ceiling). The heuristic's own answer is always permitted, so this caps escalation driven by Jev and never lowers what the run would get without Jev. |
| `max_prompt_chars` | `4000` | How much of the prompt, from the start, goes into Jev's `state`. The rest is dropped and flagged `prompt_truncated`. `0` sends no prompt text. Integer, 0 to 200000. |

```yaml
jev:
  enabled: true
  decisions:
    risk_tier: { mode: act, threshold: 0.8, max_risk: standard }
tiering:
  enabled: true
  # tiers / roles as usual
```

## Wire format and caveats

- The endpoint is `POST {base_url}/systemone`, authenticated with
  `Authorization: Bearer $TYPESAFE_API_KEY`. The request body is
  `{model, state, questions}` and the response is `{model, answers, usage}`.
  No SDK is used; the client is a small wrapper over `fetch`.
- These shapes come from research done ten days after launch. Answers are
  parsed defensively, so any answer spf does not recognize becomes
  `invalid_response` and the fallback acts. **Verify against a live
  response before moving any kind to `act`.** Treat score-level index base
  (0 or 1) and confidence on `noul` answers as unverified.
- spf does not retry. Jev's value is fast answers, and every failure already
  has a correct answer (the fallback). A `429`/`529` is recorded as `error`
  with the status in `detail`.
- State and questions share a budget of about 32,000 tokens per call. Jev
  is documented as unreliable at counting, so ask one question per item
  and sum the answers in code.
