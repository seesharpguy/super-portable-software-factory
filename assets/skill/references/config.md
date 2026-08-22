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
   field by field (`defaults`/`observability`/`quality`/`watch`/`notifications`
   merge key-by-key — `notifications.channels` replaces wholesale, same as
   `quality.checks`; `agents` merges by `name`: a matching name patches that
   entry, a new name appends).
3. An explicit `--config <path>` replaces both — standalone, no built-in
   underneath it.

`spf init` seeds step 2 — on a TTY, via an interview that asks the fields
below and appends whatever secrets they imply to `.env`; non-interactively
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
| `protected_files` | string[] | Paths no agent may touch unless named in its own `writes`. Default `[".spf/", "spf.config.yaml"]`. |
| `data_dir` | path | Runtime home, repo-relative. Default `.spf/data`. |

### `observability`

| Field | Type | Meaning |
|---|---|---|
| `db` | path | The trace sqlite db. Default `.spf/data/spf.db`. |
| `poll_ms` | int | UI live-poll cadence. Default `500`. |

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
| `repo` | string | Required once watch is actually run (not schema-validated — fails loudly at `spf watch` startup instead). `"owner/name"` for `code_host: github`, `"workspace/repo_slug"` for `code_host: bitbucket`. |
| `label_prefix` | string | State-machine label prefix — polls/writes `<prefix>:ready`, `<prefix>:working`, etc. Default `spf`. |
| `chain` | string | Which registered chain runs per claimed `<prefix>:ready` issue. Default `plan-build-test`. |
| `base_branch` | string | Branch worktrees fork from and PRs target. Default `main`. |
| `poll_ms` | int | Tick interval. Default `60000`. |
| `concurrency` | int ≥1 | Max issues claimed and run at once, the build lane's own budget (independent of `refine.concurrency`). Default `2`. |
| `jira.base_url` / `jira.project_key` | string | Only consulted when `issue_provider: jira`. |
| `refine.enabled` | bool | Turns on the second lane: decompose a `<prefix>:spec-ready` product spec into a feature/story-or-bug tree of real issues, instead of running `chain` against it directly (a spec isn't individually workable). Default `false` — off by default, so an existing `watch:` config is unaffected by upgrading. Needs `issue_provider: github` — `spf watch` fails loudly at startup otherwise, since issue authoring (create + link a hierarchy) isn't implemented for Jira yet. |
| `refine.chain` | string | Which registered chain runs per claimed spec. Default `refine`. |
| `refine.concurrency` | int ≥1 | The refine lane's own budget, separate from `concurrency`. Default `1`. |

```yaml
watch:
  repo: owner/name
  label_prefix: spf
  chain: plan-build-test
  refine:
    enabled: true       # decompose spf:spec-ready specs into a feature/story tree
    chain: refine
    concurrency: 1
```

Generated issues carry a second, independent label vocabulary —
`<prefix>:type:epic|feature|story|bug|task` — seeded by `spf watch init`
alongside the state labels. A feature/epic (a container: some other node
names it as `parent`) gets only its type label; a leaf (story/bug/task)
additionally gets `<prefix>:refined`, so a human can review and promote it to
`<prefix>:ready` when it's worth building — the refine lane never
auto-promotes anything.


and every chain run (`spf <chain>` / `spf run`, including watch's own
per-issue runs). Interactive commands (`doctor`, `list`, `sessions`,
`phases`, `events`, `init`, `ui`, `migrate`, `eject`, `abort`, `version`)
never notify — you're already looking at the terminal for those. Off by
default; adding it is entirely additive.

| Field | Type | Meaning |
|---|---|---|
| `events` | `"off"` \| `"errors"` \| `"all"` | The whole filter. `off` (default): nothing. `errors`: only failed runs/phases, blocked issues, watch errors. `all`: every curated milestone (run started, issue claimed, PR opened, ...) plus errors. |
| `timeout_ms` | int | Per-request timeout for a channel's HTTP POST. Default `5000`. |
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
  events: errors
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

### `agents[]`

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | The identifier chains use. Chains name agents, never models. |
| `prompt_engineering.system` / `.user` | yes | Paths to the two prompt files. Resolved against the repo root, then `.spf/`, then `.spf/prompt_engineering/`, then the packaged assets — first hit wins; a total miss throws listing every path tried. |
| `purpose` | no | One sentence; should match the system prompt's stated purpose. |
| `coding_agent`, `model`, `thinking`, `color`, `harness_engineering` | no | Override the matching `defaults` key. |
| `tools` | no | Allowlist. Omitting it means all tools usable. A capability list, not a boundary — see `writes`. |
| `writes` | no | What this agent may modify **in the repo**, enforced after every call. `undefined`/`null` = unrestricted (still barred from `protected_files`); `[]` = no repo writes; a list = only those paths (trailing `/` = directory prefix, `*` = one path segment, `**` = crosses segments, anything else = exact path). |

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
etc.) — `spf doctor` checks the common ones are set.

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

These names are canonical across backends — a roster entry never says
which; each backend module (`agent_flue.ts`, `agent_cc.ts`) maps them to
its own tool vocabulary (Flue's lowercase functions, Claude Code's
capitalized `Read`/`Bash`/...).

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

No config section for this — it's an environment-variable recipe, since
`agent_cc.ts` passes the operator's environment straight through to the
`claude` subprocess, exactly like every other env var. Set
`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` (local or cloud Ollama) before
running `spf`; see `roster.md`'s "Coding agent backends" section for the
exact commands.
