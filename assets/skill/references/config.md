# Config Reference

The full `spf.config.yaml` spec: every field, how defaults merge, and how
model / thinking / tools map onto each coding-agent backend (Flue by
default, or Claude Code). The schema is Valibot-enforced —
`agents.validate()` refuses a bad config before anything spawns — so this is
semantics and gotchas, not a shape you have to memorize by hand; `spf doctor`
always shows the resolved, merged result for the repo you're in.

## Resolution order

1. The packaged built-in default (`assets/defaults/spf.config.yaml` inside
   the installed CLI).
2. `.spf/spf.config.yaml` in the target repo, if present — merged on top,
   field by field (`env`/`defaults`/`observability`/`quality`/`watch`/`notifications`/`review`/`tiering`/`sandbox`
   merge key-by-key — `notifications.channels` replaces wholesale, same as
   `quality.checks`, `tiering.tiers`/`tiering.roles`, and `sandbox`'s own
   nested blocks (`opensandbox`/`cloudflare`/`egress`/`transport`/
   `credentials`); `agents` merges by `name`: a matching name patches that
   entry, a new name appends).
3. An explicit `--config <path>` replaces both — standalone, no built-in
   underneath it.

`spf init` seeds step 2 — on a TTY, via an interview that asks the fields
below and appends whatever secrets they imply to `.env` (a non-secret,
declarative setting like `SPF_CLAUDE_CMD` goes into this file's own `env:`
block instead — see "Declarative env vars" below); non-interactively
(`--yes`, `--template <name>`, or no TTY) it writes a commented starter
instead. Omitting `.spf/spf.config.yaml` entirely means running off pure
built-ins, which is a fully supported, valid state.

## Shape

```yaml
defaults:
  coding_agent: flue                       # the only implemented value
  model: google/gemini-3.6-flash           # ALWAYS provider/model-id
  thinking: medium
  tools: [read, bash, edit, write, grep, glob]
  protected_files: [.spf/, spf.config.yaml]
  data_dir: .spf/data

observability:
  db: .spf/data/spf.db
  poll_ms: 500

quality:
  checks:
    - {name: test, operation: build, argv: ["npm", "test"], timeout_seconds: 600}
  suites:
    test: [test]
    all: [test]

agents:
  - name: planner
    model: google/gemini-3.6-flash
    thinking: high
    color: "#a78bfa"
    purpose: Turn a request into a plan the builder can implement without asking questions.
    prompt_engineering:
      system: planner/system.md
      user: planner/user.md
    writes: [specs/]
    tools: [read, grep, glob, bash, write]
```

## Fields

### `defaults`

| Field | Type | Meaning |
|---|---|---|
| `coding_agent` | `"flue"` \| `"claude_code"` | Which backend runs the agent. Default `flue`. `claude_code` shells out to your own installed `claude` CLI — `spf doctor` checks it's on `PATH`. |
| `model` | string | Vocabulary depends on `coding_agent`: Flue wants `provider/model-id`; Claude Code wants its own bare alias/full name (`sonnet`, `claude-sonnet-5`, ...). Default `google/gemini-3.6-flash`. |
| `thinking` | enum | `off\|minimal\|low\|medium\|high\|xhigh\|max`. Default `medium`. On a `claude_code` agent this maps to `--effort` (`off`/`minimal` both floor to Claude Code's own minimum — it has no true "disabled" level for a headless run). |
| `color` | hex string | Lane color fallback for agents that don't set their own. |
| `harness_engineering` | string[] | **Must stay `[]`** — no analogue on any current backend; a non-empty entry fails validate(). |
| `tools` | string[] \| null | Roster-wide allowlist. Unset/null = every built-in tool usable. |
| `writes` | string[] \| null | Roster-wide write allowlist, back-filled onto any agent that doesn't set its own — see `writes` under `agents[]` below for the three-state semantics. |
| `env_allowlist` | string[] \| null | Roster-wide env allowlist, back-filled the same way as `writes`. Unset/null = every agent gets the full operator environment (see `env_allowlist` under `agents[]`). |
| `protected_files` | string[] | Paths no agent may touch unless named in its own `writes`. Default `[".spf/", "spf.config.yaml"]`. |
| `data_dir` | path | Runtime home, repo-relative. Default `.spf/data`. |
| `max_run_cost` | number > 0 (USD) | Stops the NEXT agent call once a run has already spent this much — checked before each call, never after. A single call is never capped (a run can overshoot by one whole call), and a chain with only one agent dispatch (`scout`, `prompt`, `build`) can never trip it at all. Absent (default) = unbounded. Throws `BudgetExceeded`, which fails the phase closed. |
| `max_run_tokens` | integer > 0 | Same semantics as `max_run_cost`, on `sessions.total_tokens` instead of cost. Absent (default) = unbounded. |

### `spf fanout`

`spf fanout <chain> "<prompt>" [--n 3] [--concurrency N] [--base <branch>]
[--adw-id <id>] [--first-success] [--config <path>] [--cwd <dir>]` — best-of-N:
runs `<chain>` N times in parallel, each in its own git worktree and branch
(`spf/fanout/<base-adw-id>-<i>`), then picks ONE winner by code (succeeded >
fewest gate failures > most gate passes > lowest cost > fewest tokens >
lowest wall time > adw_id) and deletes the rest. SPF never merges the
winner — it prints the branch and the basis; a human runs `git merge`. The
chain named MUST have a commit step (`plan-build`, `plan-build-test`,
`plan-build-test-quality`, `simple-sdlc`, or a repo-local chain with one) —
`spf fanout` refuses any chain without one, since a winner with no commit
leaves its only copy of the work as uncommitted edits in a worktree.
`--first-success` opts into stopping early once one attempt succeeds
(first-past-the-post) instead of the default, which runs every attempt to
completion for a true N-way comparison. `spf fanout --clean <base-adw-id>`
removes any worktrees/branches a killed or discarded run left behind under
that id — a `--adw-id` is never safe to reuse against session rows still in
the shared db, so a rerun with the same id fails loudly instead of mixing
the two runs' cost/tokens/gates together.

### `observability`

| Field | Type | Meaning |
|---|---|---|
| `db` | path | The trace sqlite db. Default `.spf/data/spf.db`. |
| `poll_ms` | int | UI live-poll cadence. Default `500`. |
| `otel.endpoint` | string | OTLP/HTTP collector endpoint (e.g., `https://your-host/v1/traces`). Omit to disable OTel export. |
| `otel.headers` | object | Optional HTTP headers (e.g., auth tokens). Each value is a string. |
| `otel.service_name` | string | Optional service name in exported spans. Default `spf`. |

**No ambient env activation**: OTEL export requires explicit `observability.otel` config — the `OTEL_EXPORTER_OTLP_ENDPOINT` shell variable is never consulted. An unrelated shell env variable must not become a data-egress switch.

### `quality`

`checks[]`: `{name, area: "frontend"|"backend", operation: "lint"|"typecheck"|"build", argv: string[], timeout_seconds}`.
`suites`: `{suite_name: [check_name, ...]}`. No packaged default suite exists
on purpose — a chain that needs one and finds it unconfigured fails loudly
at `agents.validate()` time, not with a placeholder green. Adding a check
whose result is really a test run, not a lint/typecheck/build, still needs
one of those three `operation` values — it only affects how the trace/UI
labels the check, never what actually runs — `build` is the closest fit.

```yaml
quality:
  checks:
    - { name: typecheck, operation: typecheck, argv: ["npm", "run", "typecheck"], timeout_seconds: 60 }
    - { name: build, operation: build, argv: ["npm", "run", "build"], timeout_seconds: 300 }
    - { name: test, operation: build, argv: ["npm", "test"], timeout_seconds: 300 }
  suites:
    test: [test]              # what build-test/plan-build-test's fix loop runs
    all: [typecheck, build, test]   # what plan-build-test-quality/quality run
```

A full worked example, including the `defaults.coding_agent`/`watch:`
sections: `assets/templates/ts.spf.config.yaml` in the spf package (or
`spf init --template ts` to write it straight into `.spf/spf.config.yaml`).
`spf init` with no `--template` prints every packaged template's name.

### `watch`

Full mechanism: the main README's "`spf watch`" section. Field reference:

| Field | Type | Meaning |
|---|---|---|
| `issue_provider` | `"github"` \| `"jira"` | The tracker `spf watch` polls. Default `github`. |
| `code_host` | `"github"` \| `"bitbucket"` | Where PRs open — independent of `issue_provider` (Jira issues against a Bitbucket repo is a real setup). Default `github`. |
| `repo` | string | The **code host's** repo — required once watch is actually run (not schema-validated — fails loudly at `spf watch` startup instead). `"owner/name"` for `code_host: github`, `"workspace/repo_slug"` for `code_host: bitbucket`. |
| `issue_repo` | string | Overrides `repo` for the **issue tracker** side, only meaningful (and only needed) for `issue_provider: github` + `code_host: bitbucket` — the one combination where the tracker and the code host are genuinely different repos in different systems. Unset (the default) falls back to `repo`, which is exactly right for `github`+`github` (one repo) and for `issue_provider: jira` (which never reads `repo` at all). |
| `label_prefix` | string | State-machine label prefix — polls/writes `<prefix>:ready`, `<prefix>:working`, etc. Default `spf`. |
| `chain` | string | Which registered chain runs per claimed `<prefix>:ready` issue. Default `plan-build-test`. |
| `base_branch` | string | Branch worktrees fork from and PRs target. Default `main`. |
| `poll_ms` | int | Tick interval. Default `60000`. |
| `concurrency` | int ≥1 | Max ISSUES claimed and run at once — not attempts; see `fanout.concurrency`. The build lane's own budget (independent of `refine.concurrency`). Default `2`. |
| `chain_options` | map of string -> string | Options passed straight through to `chain` (and `refine.chain`) for every unattended dispatch — the same shape an interactive `spf <chain> --suite <name>` builds, e.g. `{suite: strict}` or `{agent: some-agent}`. Default `{}`. Only useful for a chain whose behavior actually reads the option (a step-derived chain's `--suite`; an imperative chain ignores an option it doesn't know about). |
| `jira.base_url` / `jira.project_key` | string | Only consulted when `issue_provider: jira`. |
| `jira.issue_types` | map: `epic`/`feature`/`story`/`bug`/`task`/`spec` -> string | Only consulted when `issue_provider: jira` AND `refine.enabled`. What each `RefinedIssue.kind` (plus `spec`, a standalone spec proposed by a split — see below) creates as on Jira — defaults `epic`/`feature` → `Epic`, `story`/`spec` → `Story`, `bug` → `Bug`, `task` → `Task`, overridable per kind. Validated against the real project by both `spf watch init` and `spf watch`'s own startup check. |
| `jira.status_map` | map: `spec-ready`/`ready`/`working`/`review`/`done`/`blocked` -> string | Only consulted when `issue_provider: jira`. Optional, empty (unset) by default — when a state has no entry, `spf watch` updates only the `<prefix>:<state>` label on that transition, exactly as before this field existed. When a state IS mapped to a real Jira status name (e.g. `working: "In Progress"`), `spf watch` also transitions the issue's native Status field there, best-effort: no reachable transition, or a rejected one, is logged and skipped rather than failing the run — the label update is what `spf watch` actually depends on, status sync is a convenience on top. Validated against the real project's statuses by both `spf watch init` and `spf watch`'s own startup check, same as `issue_types`. |
| `github.project_number` | int ≥0 | Only consulted when `issue_provider: github`. Which of the repo OWNER's Projects v2 boards `status_map` syncs against (Projects v2 numbers are per-owner, not per-repo — see the board's own URL). Default `0`, which disables status sync outright regardless of `status_map`; there's no sane "guess the board" default. |
| `github.status_map` | map: `spec-ready`/`ready`/`working`/`review`/`done`/`blocked` -> string | Only consulted when `issue_provider: github` AND `project_number` is set. Optional, empty (unset) by default — an unmapped state stays label-only, a mapped one also sets the Projects v2 "Status" field, best-effort (no matching Status option, or a rejected mutation, is logged and skipped, never thrown — the label update is what `spf watch` actually depends on, status sync is a convenience on top). Needs `GITHUB_TOKEN` to carry the `project` scope in addition to `repo`/`public_repo` — Projects v2 is GraphQL-only. Validated against the real project's Status options by both `spf watch init` and `spf watch`'s own startup check. |
| `refine.enabled` | bool | Turns on the second lane: decompose a `<prefix>:spec-ready` product spec into a feature/story-or-bug tree of real issues, instead of running `chain` against it directly (a spec isn't individually workable). Default `false` — off by default, so an existing `watch:` config is unaffected by upgrading. Needs `issue_provider: github` or `"jira"` — both implement issue authoring (create + link a hierarchy); any other value fails loudly at startup. |
| `refine.chain` | string | Which registered chain runs per claimed spec. Default `refine`. |
| `refine.concurrency` | int ≥1 | The refine lane's own budget, separate from `concurrency`. Default `1`. |
| `refine.max_leaves` | int ≥1 | The decomposition budget: at most this many LEAVES per refinement — each one becomes its own worktree, chain run, and pull request once promoted, so this is a human-review budget, not a model-effort one. Default `4`. Enforced by `gates.refinementWellFormed`; exceeding it (with no human-approved split already in the thread) sends the refiner back for a correction, and a genuine overrun proposes a `split` into several specs instead of publishing (see below) rather than force-fitting an oversized tree. |
| `refine.max_nodes` | int ≥1 | Total node ceiling (leaves + containers). Default `6`. Doesn't bind at the other two defaults — it exists so raising `max_leaves` or `max_depth` alone can't silently uncap the whole tree. |
| `refine.max_depth` | int ≥1 | Containment-depth ceiling — `1` is a top-level leaf/container, `2` is a leaf directly under a top-level container. Default `2`. **Raising this above 2 is unsafe on Jira**: `epic`/`feature` both map to Jira's Epic type by default, and Jira has no Epic-under-Epic nesting, so a 3-level tree fails partway through a non-transactional publish. At the default, that shape is rejected before any issue is created. |
| `fanout.n` | int, 1-8 | Best-of-N per claimed issue: run `n` sibling attempts of the same issue and let code pick a winner (`core/fanout.ts`'s `pickBest`, the same mechanism `spf fanout` uses standalone). Default `1` — single dispatch, byte-identical to `spf watch` before this key existed. `n > 1` requires `chain` to have a commit step (`spf watch` refuses to start otherwise — a chain with no commit step would have its N-1 losing attempts' uncommitted work destroyed by best-of-N's own cleanup). |
| `fanout.concurrency` | int ≥1 | Attempts of ONE issue's fan-out IN FLIGHT at once — **not** `concurrency`, which counts issues. The two multiply: `concurrency: 2` × `fanout.concurrency: 2` is up to 4 chain runs in flight; `spf doctor`'s `watch.fanout` line prints the exact product. Does **not** bound worktrees on disk — a successful attempt's tree is kept until every sibling in its fan-out has settled, so disk peak is `concurrency × fanout.n`, not `concurrency × fanout.concurrency`. Default `2`. |

```yaml
watch:
  repo: owner/name
  label_prefix: spf
  chain: plan-build-test
  chain_options:
    suite: strict        # only if plan-build-test's chain declares a step-derived requiredSuites
  refine:
    enabled: true       # decompose spf:spec-ready specs into a feature/story tree
    chain: refine
    concurrency: 1
    max_leaves: 4       # optional — shown are the defaults; see refine.max_leaves above
    max_nodes: 6
    max_depth: 2
  fanout:
    n: 1                 # attempts per claimed issue. 1 = single dispatch (default) — no-op for the daemon
    concurrency: 2        # attempts IN FLIGHT per issue — not watch.concurrency (issues in flight)
```

Generated issues carry a second, independent label vocabulary —
`<prefix>:type:epic|feature|story|bug|task` — seeded by `spf watch init`
alongside the state labels. A feature/epic (a container: some other node
names it as `parent`) gets only its type label; a leaf (story/bug/task)
additionally gets `<prefix>:refined`, so a human can review and promote it to
`<prefix>:ready` when it's worth building — the refine lane never
auto-promotes anything.

A third label vocabulary — `<prefix>:priority:p0|p1|p2|p3` — is what
`claimNewWork` actually schedules `<prefix>:ready` issues by: priority first,
then sibling affinity (a leaf whose parent already has a sibling in flight
goes first), then creation order. The refiner proposes a priority per node
(clamped to the spec's own priority, when the spec issue has one, as a
ceiling — never a floor); a human can relabel before promoting, which is the
entire override mechanism. Independently, a `<prefix>:ready` leaf whose
`blocked_by` isn't fully `<prefix>:done` is skipped until it is — the
frontier check. This label is separate from any GitHub Projects v2
"Priority" field a repo's board might have; `spf watch` never touches
Projects v2, so the two are unreconciled if you use both.

The `refine` chain grounds its decomposition with a `scout` phase before the
refiner runs, so `scout` is a required agent for it — a roster that pruned
it fails `spf watch` startup by name.

The refine lane's own state machine has two extra loops beyond
`spec-ready → refining → spec-in-progress → done`/`blocked`, for two
different problems. When the refiner raises material ambiguity instead of a
tree (see `assets/prompts/refiner/system.md`'s "Ask, don't decide"), the spec
moves to `<prefix>:needs-feedback` with a comment naming its questions,
instead of publishing anything. A human answers in the issue's comments and
adds `<prefix>:continue-refinement`; `spf watch` claims that label back into
`refining` and resumes the **same** `adw_id` — the comment thread (split
into "answers to your open questions" and "earlier discussion") is folded
into the resumed prompt, and the refiner's own coding-agent session
continues rather than starting cold. This can loop any number of rounds.

The other loop is for size, not ambiguity: when the spec honestly exceeds
`refine.max_leaves` (see above), the refiner proposes a `split` into two or
more standalone specs instead of a scope question, and the spec moves to
`<prefix>:split-proposed` with a comment naming each proposed spec and why
it's coherent on its own. A human either adds `<prefix>:split-approved`
(executed deterministically — `core/refine.ts`'s `publishSpecs()`, no agent
re-run: it creates exactly what the proposal comment showed, each new spec
carrying `<prefix>:type:spec` + `<prefix>:spec-ready`, never
`<prefix>:refined`) or revises the proposal the same way a question gets
answered (`<prefix>:continue-refinement`). The original spec then tracks
both child specs' own trees to completion transitively, the same way it
tracks a published tree's leaves.

Publishing a tree does NOT mean the spec is done: `<prefix>:spec-in-progress`
is where a spec lands right after publish, and it stays there — with a
summary comment listing every issue created — until **every one of those
issues** is itself `<prefix>:done` (`finishTrackedSpecs`, polled every tick,
reads `WatchMarker.refined` back to check). Only then does it move to
`<prefix>:done`, get a closing comment, and close on the tracker (GitHub
only, best-effort) — firing `spec_done`, distinct from the earlier
`spec_refined`. This exists so a spec's tracker status means what a product
manager expects it to mean: "done" is the work being finished, not merely
having been decomposed. `spf watch init` must be re-run after upgrading to
this version to seed the new labels.

Container roll-up mirrors that same "close, don't just label" behavior for a
generated feature/epic: once every child under it carries `<prefix>:done`
(checked reactively, each time a leaf's PR merges), the container gets a
summary comment and transitions to `<prefix>:done` — then the check repeats
on ITS OWN parent, so an epic rolls up once its last feature does. A
container with one unfinished child (including a leaf still sitting at
`<prefix>:refined`, never promoted) is left alone; nothing forces it. This
needs a native hierarchy read-back — GitHub's sub-issues API, or a Jira
`parent = "<id>"` JQL search — so it works on both today; a tracker that
implements neither gets a logged no-op, not a startup failure, since the
build lane still works fine without roll-up. Whether the container actually
CLOSES on the tracker (not just relabels) depends on `closeIssue` being
implemented at all — GitHub yes, Jira no (its own resolution workflow isn't
wired up), same asymmetry as leaf and spec completion already have on Jira.

### `notifications`

Optional outbound push for unattended work — `spf watch`'s daemon lifecycle,
and every chain run (`spf <chain>` / `spf run`, including watch's own
per-issue runs). Interactive commands (`doctor`, `list`, `sessions`,
`phases`, `events`, `init`, `ui`, `migrate`, `eject`, `abort`, `version`)
never notify — you're already looking at the terminal for those. Off by
default; adding it is entirely additive.

| Field | Type | Meaning |
|---|---|---|
| `events` | `"off"` \| `"errors"` \| `"attention"` \| `"all"` | The whole filter, narrowest to widest. `off` (default): nothing. `errors`: only true failures — failed runs/phases (`run_failed`/`phase_failed`), `watch_error`. `attention`: `errors` plus anything needing a human but not itself a failure — a blocked issue (`issue_blocked`) or a spec needing feedback (`spec_needs_feedback`). `all`: every curated milestone (run started, issue claimed, PR opened, ...) plus `attention` and `errors`. |
| `timeout_ms` | int | Per-request timeout for a channel's HTTP POST. Default `5000`. |
| `project` | string | Label prefixed onto every outbound title (`[api] watch: ...`) and added as a `repo` field — for disambiguating multiple `spf` instances that share one webhook. Default `""`, which falls back to `watch.repo`. |
| `channels[]` | array | See below. |

`channels[].kind`: `"slack"` \| `"teams"` \| `"webhook"`. `channels[].events`
overrides `events` for just that channel (unset = inherit). `webhook_url_env`
names the `.env` key holding the secret URL — never the URL itself, matching
`GITHUB_TOKEN`/`JIRA_API_TOKEN`. Empty/omitted uses the kind's own default:
`SLACK_WEBHOOK_URL`, `TEAMS_WEBHOOK_URL`, `SPF_WEBHOOK_URL`. `name` is a
cosmetic label for warning lines when you have two channels of the same
kind.

```yaml
notifications:
  events: attention
  channels:
    - kind: slack
      webhook_url_env: SLACK_WEBHOOK_URL   # optional; this is the default for slack
    - kind: teams
      events: all                           # per-channel override
    - kind: webhook
      webhook_url_env: OPS_WEBHOOK_URL
      name: ops-bus
```

Delivery never blocks or fails a run: a channel with an unset env var is
skipped with one warning at startup (`spf doctor` reports the same thing as
a check); a failed POST logs one line and is swallowed, never changing the
run's exit code. See the main README's "Notifications" section for how to
get each channel's webhook URL, and `spf init`'s interview, which asks for
this section and collects the URL straight into `.env`.

### `review`

The human sign-off gate in front of `simple-sdlc`'s `commit_build` phase —
the one place in this codebase an AI reviewer's `approved` flag alone would
otherwise gate a commit (`build-review` has no commit step, and no other
chain runs a reviewer at all). See the main README's "Isolation" section for
the full behavior; this is just the two knobs.

| Field | Type | Meaning |
|---|---|---|
| `require_human_signoff` | bool | `false` (default, this release): an unattended run (`spf watch`, CI, no TTY) proceeds on the reviewer's verdict alone, with a loud warning printed and traced every time. `true`: an unattended run instead fails the phase closed — rerun attended, or route the work through `spf watch`, whose own human gate is the PR merge. Never affects an attended run's prompt, which is always shown either way. |
| `signoff_timeout_seconds` | number ≥1 | Bounds the attended confirm prompt. Default `300`. Not required to be an integer — `1.5` parses and becomes a 1500ms timer. Expiry resolves to the prompt's own default — **not accepted**, same as if the answer had been "no" — never an unbounded `stdin` read inside `run.phase()`. |

```yaml
review:
  require_human_signoff: false   # this release's default — see above
  signoff_timeout_seconds: 300
```

The confirm prompt's own default is always `false` — never `review.approved`,
so an AI's own verdict can never auto-approve itself by way of an unanswered
default. A `Signed-off-by:` trailer is appended to the commit only on a
recorded explicit "yes," built from `git config user.name`/`user.email` at
the repo (never `ENGINEER_NAME`/`$USER`, which are spoofable and fall back to
the literal string `"engineer"`) — an unattended run's AI-only commit never
carries one, because nobody said yes to attest to.

### `tiering`

Risk-tiered per-role model routing (SPF #14) — a run-global cost/strength
shift on top of the static roster, decided ONCE at run start from signals
code can read without asking an agent anything (the chain's name and the
prompt's word count), never re-evaluated mid-run. **OFF by default, and
`enabled: false`/absent is a TOTAL no-op**: every agent dispatches at
exactly the model its roster entry names, byte-identical to before this key
existed — the same discipline `defaults.max_run_cost`/`max_run_tokens` hold
themselves to.

**Top-level, not nested under `defaults:`.** `loadConfig`'s back-fill loop
copies a fixed list of `defaults` keys down onto every agent that hasn't set
them, and a stray copy would be silently *stripped* at parse rather than
rejected — a top-level key sits outside that loop entirely, so the trap
cannot apply here. Merges **key-by-key** with a base config, same as
`review`/`notifications`: a repo that only flips `enabled: true` keeps the
base's `tiers`/`roles`; `tiers` and `roles` are each a **whole replace** on
override (a repo's own ladder replaces the packaged one wholesale, never an
unordered splice of both).

| Field | Type | Meaning |
|---|---|---|
| `enabled` | bool | Default `false`. `true` turns on the ladder walk described below; `false` (or the key absent) is a total no-op, checked nowhere and dispatched nowhere. |
| `tiers` | array, WEAKEST FIRST | The ladder. A risk level shifts every routed role UP or DOWN this list by the same step — order is the whole semantics, which is why this is a sequence and not a mapping. Default `[]`. |
| `tiers[].name` | string | What `roles` values point at. |
| `tiers[].coding_agent` | `"flue"` \| `"claude_code"` | Which backend's vocabulary this rung's `model` speaks. Default `flue`, same default an agent's own `coding_agent` uses. A tier changes an agent's `model` and **nothing else** — `coding_agent` always stays the agent's own — so a rung can only route roles whose backend matches (**rule T**, below). |
| `tiers[].model` | string | Same vocabulary as an agent's own `model:` for that backend: `provider/model-id` for `flue`, Claude Code's bare alias/full name for `claude_code`. No per-provider table — for `flue` the provider is already the string's first segment. |
| `roles` | map of agent name -> tier name | The baseline tier per **role**. Naming an agent here is the operator's statement "route this one by tier" — the resolved tier then wins over that agent's own `model:`. An agent **not** named here is never retiered; its `model:` stands, untouched. That is the whole precedence rule. Default `{}`. |

```yaml
tiering:
  enabled: true
  tiers:
    - { name: cheap,  coding_agent: flue, model: ollama/granite4.1:8b }
    - { name: strong, coding_agent: flue, model: ollama/qwen3.8:27b-mlx }
  roles:
    scout:    cheap
    builder:  strong
    reviewer: strong
```

**The risk signal.** Two integer-weighted signals, summed: the chain's own
kind (`scout`/`prompt`/`document`/`quality` weigh `-1`; `simple-sdlc`/
`plan-build-test-quality`/`refine` weigh `+1`; everything else, including
every repo-local `.spf/chains/*.yaml` chain, weighs `0`) and the prompt's
word count (`-1` at ≤60 words, `+1` at ≥400, `0` between). The sum
classifies to `low`/`standard`/`high`: reaching `high` needs only one
signal to agree (a long prompt forces `high` outright), reaching `low`
needs both to agree — demoting a role a rung is the expensive mistake (a
wrong answer, a whole re-run); promoting one is the cheap mistake (some
extra tokens), so the classifier is deliberately asymmetric toward the
cheap failure. `standard` (step `0`) leaves every role on its configured
baseline rung.

**Rule T — the backend-compatibility rule.** `coding_agent` is a per-agent
field and model vocabulary is backend-dependent, so a tier is only usable
for a role whose `coding_agent` matches the tier's own declared
`coding_agent`. `enabled: true` on a repo that inherited the packaged
flue-shaped ladder (every repo does, via key-by-key merge, until it
declares its own) while running a `claude_code` roster fails **loudly, by
name** at `agents.validate()` time, before anything spawns — never a silent
skip, and never a `fireworks/...` id handed to Claude Code.

**Degradation.** A rung that is unusable — a model tag `probeServedOllamaTags`
found absent from a local Ollama server's `/models` list, or a rule-T
backend mismatch — is walked **down**, never up: a degradation must never
silently escalate spend. If every rung at or below the target is unusable,
the role dispatches on its own configured `model:` unchanged, plus one noted
line. The availability probe **fails open**: an unreachable server drops
nothing rather than silently downgrading every agent to the bottom rung.

**Visibility.** Because a retiered agent's *configured* `model:` (what
`spf.config.yaml` says) and its *effective* model (what actually dispatched)
can now disagree, every run traces one `tiering` log event carrying the full
resolved routing, and prints one console line per retiered agent
(`[spf] tiering <agent> <tier> (<configured> -> <effective>) risk=<risk>`).
`spf doctor` reports the same resolved ladder and every routed role's
effective model when `tiering.enabled` — see below.

`spf init`'s interview does not write this block: it collects one model for
the whole roster, and a `tiering` block over a single-model roster is a
no-op by construction. `spf init --template ts-flue-ollama` is the one
packaged template that ships it **on**, with two tags measured live against
a real local Ollama server; the non-interactive starter (`--yes` / piped
stdin) shows the shape commented out. Every other packaged template
inherits the built-in default's populated-but-`enabled: false` ladder
through key-by-key merge — harmless until a repo opts in, and invisible to
`spf doctor` until it does (see below).

**`spf doctor`**, only when `cfg.tiering.enabled` — a disabled ladder is
invisible to doctor, on purpose, so a repo that never opted in (which is
every packaged template except `ts-flue-ollama`, plus every `spf init`
starter) can't fail on an unset provider key for a rung that will never
dispatch:

- the same provider-key check the roster gets, run over `tiers[].model`
  instead, branching on **the tier's own** `coding_agent`;
- the `OLLAMA_BASE_URL` reachability probe now also fires for an `ollama/*`
  rung even when no `cfg.agents[]` entry itself names one;
- a new report section: the resolved ladder, every routed role's effective
  model (including roles whose effective model equals their configured
  one), any degradation note, and — probed the same way `probeServedOllamaTags`
  does, fail-open — which `ollama/*` rungs are and aren't in `ollama list`.

### `sandbox`

Remote sandbox backends (SPF #15) — runs an agent's `bash`/`read`/`write`/
`edit` tools inside an isolated remote container instead of the real working
tree. **Absent, or `backend: local` (the default), is byte-identical to SPF
before this feature existed**: every agent runs against the real working
tree, exactly as today. Top-level, not nested under `defaults:` — same
reasoning as `tiering` above (a stray copy onto `loadConfig`'s `defaults`
back-fill loop would be silently *stripped*, not rejected). Nested blocks
(`opensandbox`, `cloudflare`, `egress`, `transport`, `credentials`) are a
**whole-object replace** on override, same rule as `observability.otel` — a
half-merged `bridge_url`/`api_token_env` pair would authenticate to the
wrong control plane; `sandbox`'s own scalar keys still merge key-by-key
around them.

| Field | Type | Meaning |
|---|---|---|
| `backend` | `local` \| `opensandbox` \| `cloudflare` | Default `local`. Repo-wide default; an agent's own `sandbox:` field can override it. |
| `scope` | `agent` \| `run` | Default `agent` — **the default because it is the only scope under which per-agent `env_allowlist` is honored by construction.** One sandbox per `(run, agent)`, created with exactly that agent's resolved env. `run` — one sandbox for the whole run (cheaper: one create, one seed, one `setup`), admitted only when every agent the chain dispatches resolves to the SAME backend and the SAME resolved env key set — `spf validate`/`spf doctor` hard-reject `scope: run` otherwise, naming the agents and keys that differ. |
| `workspace_dir` | absolute path (in-sandbox) | Default `/workspace` — the agent's cwd inside the sandbox. |
| `handoff_dir` | absolute path (in-sandbox) | Default `/spf/handoff` — the **root** of the handoff plane (session artifacts, `context_handoff_dir`'s remote counterpart). The per-run directory a rendered prompt actually sees is derived from it as `<handoff_dir>/sessions/<adw_id>/context_handoff`, mirroring the host's own `context_handoff_dir` shape — this is not cosmetic: the shipped `planner`/`documenter` prompts parse `<adw_id>` out of that exact shape to name `specs/<adw_id>_<slug>.md`/`app_docs/<adw_id>_<slug>.md`. **MUST NOT be under `workspace_dir`** — `validate()` rejects it if it is: nested, it would ride the extract's `git add -A` onto the host at a path `spf init`'s `.gitignore` entries don't cover, and `permissions.enforce` kills the run on a `protected_files` breach. |
| `scratch_dir` | absolute path (in-sandbox) | Default `/spf/tmp` — the transport's OWN scratch plane (the seed archive, the in-flight patches). Same "not under `workspace_dir`" rule, same reason, same enforcement as `handoff_dir`; also must not equal `handoff_dir`. |
| `image` | string | **`opensandbox` only. No default** — `validate()`/`spf doctor` reject an empty `image` when the resolved backend is `opensandbox`, naming the three required binaries. MUST contain `git`, `tar`, and `base64`: the workspace transport shells out to all three to keep the sandbox's tree byte-identical to the host's. A `git`-less base (`python:*-slim`, bare `alpine`) fails the mandatory create-time preflight unless `setup` installs `git` first. Meaningless (and not required) on `cloudflare`. |
| `setup` | array of strings | Default `[]`. Shell commands run **once** per sandbox, right after seeding — e.g. `["npm ci --omit=dev"]`. |
| `request_timeout_seconds` | number | Default `960`. The **client-side** HTTP timeout on control-plane calls (create/renew/kill/file ops) — raised well above the SDK's own default because a first-run image pull can take a while. **Not** the bound on a long agent command: `exec` streams, so a caller-supplied timeout is honored unclamped (see `exec_timeout_seconds`). Must stay `>= exec_timeout_seconds`. |
| `lifetime_seconds` | number | Default `3600`. Provider-side expiry, renewed while a lease stays live — the teardown backstop that survives a `SIGKILL`ed `spf`. |
| `max_total_lifetime_seconds` | number | Default `21600`. A hard ceiling from creation; renewal refuses past it rather than letting a long-lived `spf watch` daemon renew one lease forever. |
| `exec_timeout_seconds` | number | Default `900`. The **default** per-command deadline, used only when the model's own tool call supplies none. **Not a ceiling** — a caller-supplied timeout (the model's own `timeout` argument to `bash`) passes through unmodified, exactly as `backend: local` behaves today; there is no clamp. |
| `env_allowlist` | array of strings | Default `[]` — **deliberately empty**, unlike `backend: local`, which passes the whole operator environment through today. A secret going into a remote container is a change of kind, not degree. The set that actually reaches a given agent's container is this list **intersected with that agent's own `env_allowlist`** (unset = no further narrowing) — per-agent, which is exactly why `scope: agent` is the default. `spf doctor` prints the resulting key **names**, never values, one line per agent. |
| `credentials.broker` | `static` | Default, and the only **registered** value in this release — plain env injection at create time, nothing really revocable yet (`revoke()` just clears SPF's own in-memory copy). An unrecognized name is a hard `validate()` failure naming the key, never a silent fallback to `static`. `spf doctor` prints the resulting grant's own honest one-liner per agent — key **names** only, never values. |
| `egress.default` / `egress.allow` | `deny`\|`allow` / array of hostnames | Default `deny` / `[]`. Repo-wide network egress policy for a remote sandbox. |
| `transport.max_patch_bytes` / `.max_seed_bytes` / `.max_mirror_bytes` | number | Defaults `8388608` (8 MiB) / `134217728` (128 MiB) / `4194304` (4 MiB, **each direction**, per file). Exceeding any of them **fails the phase**; none of them ever silently truncate. |
| `transport.mirror` | array of repo-relative paths | Default `[]`. Extra paths to sync out of the sandbox that git cannot carry (gitignored build artifacts you still want back on the host). |
| `fanout` | `worktree` \| `sandbox` | Default `worktree`. `sandbox` fans out **through** sandboxes too: each `spf fanout` attempt gets its own sandbox lease(s), keyed on that attempt's own derived `<base>-<i>` adw_id — never a session id, never shared across attempts. The local worktree and branch stay the record of truth either way; `spf fanout`'s output adds one line noting where the attempts ran (`attempts ran in <backend> sandboxes; branch is local`). See `sandbox.scope` above for the per-attempt sandbox count. |
| `opensandbox.base_url` | string | Default `http://127.0.0.1:8090`. |
| `opensandbox.api_key_env` | string | Default `OPENSANDBOX_API_KEY` — an env **key name**, never the key itself, same spelling as `GITHUB_TOKEN`. |
| `opensandbox.use_server_proxy` | bool | Default `false`. |
| `opensandbox.metadata_prefix` | string | Default `spf`. Best-effort create-time labelling only — the teardown sweep relies on SPF's own host-side lease record, not on reading this back. |
| `cloudflare.bridge_url` | string | Default `""`. The base URL of a deployed `@cloudflare/sandbox` bridge — **required** when the resolved backend is `cloudflare` (`validate()`/`spf doctor` reject an empty value). SPF is a Node CLI, not a Worker, so it talks to the bridge's HTTP API rather than a `getSandbox()` binding. |
| `cloudflare.api_token_env` | string | Default `CLOUDFLARE_API_TOKEN` — an env **key name**, never the key itself. |
| `cloudflare.sandbox_name` | string | Default `""` (derives a stable name from the lease key instead). Optional stable name for the bridge-side sandbox. |

```yaml
sandbox:
  backend: opensandbox
  image: ghcr.io/you/spf-sandbox:debian-git   # must contain git + tar + base64
  env_allowlist: ["GH_TOKEN"]
  egress:
    default: deny
    allow: ["github.com", "registry.npmjs.org"]
  opensandbox:
    base_url: http://127.0.0.1:8090

agents:
  - name: builder
    env_allowlist: ["GH_TOKEN"]   # this agent's own narrowing — see the table above
  - name: reviewer
    sandbox: local                # force this one agent back to the real working tree
```

**Env posture, stated plainly.** `backend: local` today hands an agent's
subprocess the *entire* operator environment. A remote backend does the
opposite by design: nothing crosses unless it is named in **both**
`sandbox.env_allowlist` and (if set) that agent's own `env_allowlist`. This
is why `scope: agent` is the default rather than `scope: run` — a
container's process environment is fixed once, at creation, and there is no
verb to change it afterward, so two agents with different allowlists cannot
safely share one container.

**`spf doctor`**, gated on the **resolved backend, per check** — not a
coarse "not local": checks that only make sense for `opensandbox` (SDK
presence, control-plane reachability, the `[docker].host_ip` gotcha, image
pre-pull timing) fire only when some agent resolves to `opensandbox`;
`cloudflare`'s config/bridge-reachability checks fire only when some agent
resolves to `cloudflare` — a repo running only `cloudflare` never fails
doctor over a missing OpenSandbox SDK it will never load. Backend-agnostic
checks (the resolved sandbox count per chain, per-agent env injection
posture, egress policy, live in-process leases, the `claude_code` x remote
rejection, `image`/handoff-scratch-placement/`scope: run`/timeout-relation
roster-wide static checks, a `.gitmodules` warning) run whenever any agent
resolves to a non-local backend, regardless of which one.

**Submodules are out of scope for this release** — the transport seeds,
syncs, and extracts the superproject only; `spf doctor` warns (never fails)
when `.gitmodules` is present.

### `agents[]`

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | The identifier chains use. Chains name agents, never models. |
| `prompt_engineering.system` / `.user` | yes | Paths to the two prompt files. Resolved against the repo root, then `.spf/`, then `.spf/prompt_engineering/`, then the packaged assets — first hit wins; a total miss throws listing every path tried. |
| `purpose` | no | One sentence; should match the system prompt's stated purpose. |
| `coding_agent`, `model`, `thinking`, `color`, `harness_engineering` | no | Override the matching `defaults` key. |
| `tools` | no | Allowlist. Omitting it means all tools usable. A capability list, not a boundary — see `writes`. |
| `writes` | no | What this agent may modify **in the repo**, enforced after every call. `undefined`/`null` = unrestricted (still barred from `protected_files`); `[]` = no repo writes; a list = only those paths (trailing `/` = directory prefix, `*` = one path segment, `**` = crosses segments, anything else = exact path). |
| `env_allowlist` | no | Opt-in filter on the environment handed to this agent's subprocess/sandbox. `undefined` (default) = the full operator environment, unchanged. A list = only those keys, plus the baseline (`PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`) either backend keeps regardless. |
| `sandbox` | no | Per-agent backend override — see `sandbox` below. `undefined`/`null` = inherit `sandbox.backend`; `"local"` = force local for this agent regardless of the repo-wide setting; a backend name = use that backend for this agent only. A bare name, never a nested block — everything else (`image`, `egress`, `transport`, credentials *policy*) stays repo-wide. |

Output types are deliberately absent from config: an entry defines who an
agent *is*; the call site defines how it's *used*.

## Model resolution

**For `coding_agent: flue` (the default):** always write `model` as
`provider/model-id`. There is no live catalog to validate against (Flue has
no public model-registry API) — `agents.ts` checks only the static shape at
`agents.validate()` time; a genuinely wrong provider or id surfaces at the
first real dispatch instead. Provider credentials come from the
environment, matching the provider you named (`GEMINI_API_KEY`/
`GOOGLE_API_KEY` for `google/...`, `ANTHROPIC_API_KEY` for `anthropic/...`,
etc.) — `spf doctor` checks the common ones are set. `ollama/...` is the one
keyless provider (`PROVIDER_ENV_KEYS.ollama` is `[]`) — instead of a key, set
`OLLAMA_BASE_URL` (default `http://localhost:11434/v1` if unset) to point at
your server; the `spf init` interview asks for this instead of a secret when
you pick `ollama`, and `spf doctor` probes it (informational — a down server
is reported, never a hard failure). See README.md's "flue + local Ollama"
section for the full walkthrough and
[`assets/templates/ts-flue-ollama.spf.config.yaml`](../../templates/ts-flue-ollama.spf.config.yaml)
for a ready-to-run starting config.

**For `coding_agent: claude_code`:** write `model` in Claude Code's own
vocabulary — a bare alias (`sonnet`, `opus`) or a full model name — never
`provider/model-id`. `agents.validate()` only checks it's non-empty; a
genuinely wrong name surfaces at the first real dispatch, same as Flue.
Credentials come from whatever the `claude` CLI itself is authenticated
with (`ANTHROPIC_API_KEY`, or its own `claude login` flow) — `spf doctor`
treats a missing key as informational for this backend, not a failure.

The resolved model is recorded per agent in `agent_map.json`, mirrored in
the `agent_sessions` table. **Changing an agent's model invalidates its
session** — a joined run starts that agent fresh instead of resuming.

## Tools

| Tool | Purpose |
|---|---|
| `read` | read file contents |
| `bash` | execute bash commands |
| `edit` | find/replace edits |
| `write` | create/overwrite files |
| `grep` | search file contents |
| `glob` (alias: `find`) | find files by pattern |
| `ls` | recognized name, **no built-in on either backend** — harmless to list, never mounts |
| `webfetch` | fetch a URL over HTTP(S), return its content as plain text — e.g. a library/API's current docs |

These names are canonical across backends — a roster entry never says
which; each backend module (`agent_flue.ts`, `agent_cc.ts`) maps them to
its own tool vocabulary (Flue's lowercase functions, Claude Code's
capitalized `Read`/`Bash`/...). `webfetch` maps to Claude Code's own native
`WebFetch` on that backend; Flue has no such built-in, so on `flue` it's a
custom tool that runs `curl`/`wget` through the agent's own `Sandbox.exec()`
— which means a remote sandbox's `egress` policy (see `sandbox` below)
governs it exactly like any other `bash`-issued network call, with no
separate rule to configure.

**Resolution order:** an agent's own `tools` wins → else `defaults.tools` →
else unset (all tools usable). An empty list is a tool-less agent, and it
will stall — not "all tools."

## Write permissions — `writes` and `protected_files`

Full mechanism and rationale: `roster.md`'s "Write permissions" section.
Short version: `permissions.ts` fingerprints the working tree's diff before
and after an agent runs; anything outside its allowlist is rolled back
(reverting a previously-clean file counts as a change; a file that was
already dirty is left alone) and the phase fails, naming every path. This is
not a gate — it's checked in code, not by asking the model to redo work.

## Harness engineering — no longer applicable

Kept as a field for config-shape stability, but it must be empty. Each
backend's own equivalent (Flue: extra tools/subagents via `useTool()`/
`useSandbox()`; Claude Code: an MCP server or plugin) is an engine-level
change made inside that backend's own module, not config — see
`authoring_chains.md`.

## Pointing `claude_code` at Ollama

Set `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` (local or cloud Ollama)
before running `spf`; see `roster.md`'s "Coding agent backends" section for
the exact commands. `spf doctor` probes `ANTHROPIC_BASE_URL` (informational
— a down endpoint or wrong path is reported, never a hard failure) and flags
a base URL that already ends in `/v1` as a likely double-path mistake, since
the `claude` CLI appends `/v1/messages` itself.

Routing through `SPF_CLAUDE_CMD` instead — e.g.
`env: { SPF_CLAUDE_CMD: "ollama launch claude --model {model}" }` in
`spf.config.yaml` (declarative, not a secret — see "Declarative env vars"
below; a plain shell export also works and still wins) — needs an explicit
`--` before `claude`'s own flags (cobra flag parsing otherwise consumes them
as `ollama launch`'s own) — `agent_cc.ts` detects this exact
`ollama launch ...` token shape and inserts that separator automatically, so
you never add it by hand. The `--model` before that separator is NOT
optional, though: it's `ollama launch`'s own flag, and it's mandatory in
headless mode (SPF always pipes stdio, so the interactive model picker
`ollama launch` falls back to without it can never run) — a `--model` typed
after the `--` belongs to `claude`, not to `ollama launch`, and doesn't help.
`spf doctor` hard-fails a `SPF_CLAUDE_CMD` missing it. A literal `{model}`
token anywhere in `SPF_CLAUDE_CMD` is substituted with the calling agent's
own `model:` field before spawning — since `ollama launch`'s `--model` is
what actually pins the model for the whole launched process, a FIXED tag
there means every `claude_code` agent shares one model regardless of its own
`model:`; `{model}` is what makes per-agent model choice real under this
launcher. See README.md's "Proxy or wrapper launchers" section for the full
explanation.

For `flue` (the default backend) pointed at Ollama instead of `claude_code`
— i.e. `model: ollama/<tag>` — see "Model resolution" above and README.md's
"flue + local Ollama" section.

## Declarative env vars

A top-level `env:` map in `spf.config.yaml` sets `process.env` defaults for
settings that are configuration, not secrets — `SPF_CLAUDE_CMD` above is the
motivating case. Applied once, in `cli/index.ts`'s `main()`, right after
`.env` loads and before any command runs. Merge is key-by-key (like
`defaults`/`watch`), so a `.spf/spf.config.yaml` override can add one key
without repeating the rest.

```yaml
env:
  SPF_CLAUDE_CMD: "ollama launch claude --model {model}"
  SOME_TOKEN: "${SOME_SECRET_FROM_DOTENV}"
```

A plain value commits as literal text. `${VAR}` interpolates from whatever's
already in `process.env` at that point — the real shell, or `.env`, both of
which load first — so a genuine secret can stay in `.env` (gitignored) and
be referenced here without ever being written into this (committed) file.
Precedence: an already-set `process.env` value always wins over `env:`'s —
this block supplies a default, never forces an override, the same way
`process.loadEnvFile()` itself never overwrites an already-set var. A
`${VAR}` reference to something genuinely unset fails loudly at startup,
naming the missing variable — see `agents.ts`'s `interpolateEnvValue`/
`applyConfigEnv`.
