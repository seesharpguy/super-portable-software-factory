# Super Portable Factory

> **Repeatable agents-plus-code workflows, as a global CLI you run against any repo.**
> Deterministic TypeScript owns the graph. Coding agents are bounded nodes inside it.

A software factory does one thing: it gives you more leverage on your prompt. How much leverage depends entirely on what you invest in it. At the low end you chain two agents together and hope. At the high end you build a system of agents plus code that runs without you, and does the job about as well as you would.

Everyone can get an agent to write code once. Almost nobody gets the same result twice. This fixes that by moving the control plane out of the prompt and into TypeScript. A chain script owns sequencing, retries, and acceptance. Agents work inside named phases. Typed JSON envelopes carry context across the seams. Every event streams into SQLite while it is still happening. **Agent proposes, code disposes.**

---

## Install

```bash
npm i -g @gr8ful/spf
```

No Bun, no separate coding-agent binary to install first, no template stamped into your repo. `spf` ships with a packaged default agent roster and default prompts — it runs against any repo with zero setup, and only writes files into that repo if you explicitly ask it to (`spf init`, `spf install-skill`).

```bash
cd your-repo
spf doctor                          # confirm everything resolves — paths, roster, provider keys
spf scout "describe this repo"      # a real, read-only run, no setup required
```

`spf doctor` is the answer to "why did nothing happen": it resolves and prints every path, validates the whole roster and every quality suite, and checks the things that fail silently otherwise — a missing provider key, a quality check whose binary isn't on `PATH`, a stale `protected_files` pattern.

### Customizing a repo

```bash
spf init                       # on a TTY: an interview — agent, model, quality checks, spf watch, secrets
spf init --yes                 # skip the interview — seed the commented, all-defaults starter config instead
spf init --template ts-cc      # or start from a packaged, ready-to-run template instead
spf list                       # every chain this install knows, its phases, what it needs
```

On a real terminal, `spf init` asks a short interview — which coding agent (`claude_code` or `flue`) and model (optionally customized per agent instead of one model for the whole roster), which quality checks to gate on, whether to turn on `spf watch` and against which tracker/code host, and whether to push notifications to Slack/Teams/a webhook — and writes `.spf/spf.config.yaml` with only what you answered differently from the packaged defaults, plus whatever secrets those answers imply appended to `.env` (already gitignored, and already auto-loaded by every command) and their key names mirrored into a committable `.env.example`. Re-running it later shows any existing `.env` value masked and keeps it on an empty answer, so rotating one secret doesn't mean re-answering everything. Piped input, `--yes`, or `--template <name>` all skip the interview and fall back to the original non-interactive behavior — a scripted `spf init` never blocks on stdin.

Without an interview, `spf init` writes the same small starter `.spf/spf.config.yaml`, commented, that merges on top of the packaged built-ins field by field. `--template <name>` writes a real, filled-in config instead of the commented-out starter — every packaged template's name prints after `spf init` runs, and the same files live in [`assets/templates/`](assets/templates/) to browse directly. Nothing here needs to exist for `spf` to run; it's how you make one repo's roster diverge from the defaults.

### Local development

Working from a clone instead of the published package:

```bash
git clone git@github.com:seesharpguy/super-portable-software-factory.git
cd super-portable-software-factory
npm install
npm run build     # builds both the CLI (dist/) and the trace visualizer SPA (web/)
npm link          # makes `spf` resolve globally to THIS checkout
```

`npm link` beats a real `npm i -g` here: it symlinks the global `spf` bin into this checkout, so every later `npm run build` takes effect immediately, no re-linking. Run it from any repo you want to test against.

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test against dist/**/*.test.js (runs build:cli first)
npm run size-check  # tarball size gate — what `npm pack` would actually publish
```

For a one-off check without touching global npm state at all, run the built CLI directly: `node dist/cli/bin.js doctor --cwd /path/to/repo`. When you're done with the linked version, `npm unlink -g @gr8ful/spf` removes it.

---

## Why this exists

Hand a capable model your whole SDLC and you get a machine with no seams. There is no phase boundary, so you cannot say which step failed. There is no acceptance criterion you can name, so "done" means "the agent stopped talking." A retry is a cold start that throws away everything the agent just learned. The only trace is a transcript you have to read like a novel. Run it twice, get two different systems.

The fix is not a better prompt. The fix is deciding, deliberately, that **code owns sequencing, retries, and acceptance, and the agent owns only the work inside one bounded phase**. Everything else falls out of that one line. Phases become the unit of the trace. Envelopes become the only way context crosses a seam. Gates become the definition of done. A correction becomes cheaper than a restart, because the session is still alive.

### Agents are great. You do not always need one.

This is the part most engineers are going to skip, and pay for later.

Code costs nothing. It runs at the speed of light. You can change it in a second. And you actually own it, which is not true of any model you are renting by the token.

So when the invocation is already known, write it down. `npm test` is not a judgement call. Neither is `tsc --noEmit`. An agent rediscovering your test runner burns a context window to learn what a subprocess already knows, and it charges you for the privilege every single run. Worse, it puts a passing test suite into a context window, which buys you nothing at all.

Agents are for the parts that need reading and deciding. Everything else is a `kind: "code"` phase — SPF's own `quality:` config section names the commands, and a chain runs them as code, not as an agent's rediscovery project. When code fails, the failure comes back to the builder as an envelope, through the same door an agent's report would have used. The repair loop is identical. You just stopped paying an agent to do arithmetic.

The bill for skipping this is not only tokens. It is cost, speed, and consistency, and you pay it on run one hundred and run one thousand, not on run one.

> *Same models. Same prompts. The difference is who owns the loop.*

---

## The agent roster

`spf.config.yaml` answers one question per entry: who is this agent. One agent, one prompt, one purpose. `spf init` seeds `.spf/spf.config.yaml`, merged on top of the packaged defaults — an entry only states what differs.

```yaml
defaults:
  coding_agent: flue                 # the engine agents run on
  model: google/gemini-3.6-flash     # provider/model-id — a bare id can match several providers
  thinking: medium                   # off | minimal | low | medium | high | xhigh | max
  protected_files: [.spf/, spf.config.yaml]   # no agent may edit the machinery that grades it
  data_dir: .spf/data

agents:
  - name: planner
    model: fireworks/accounts/fireworks/models/kimi-k3
    thinking: high
    color: "#a78bfa"                 # this agent's lane color in the trace UI
    purpose: Turn a request into a plan the builder can implement without asking questions.
    prompt_engineering:
      system: planner/system.md
      user: planner/user.md
    writes: [specs/]                 # the plan is all it may leave in the repo
```

Five starter agents ship in the box: `planner`, `builder`, `scout` (read-only recon), `reviewer`, and `documenter`. There is no tester, because running a suite is a known command and therefore code, not an agent's job.

Every agent gets its own model, thinking level, prompts, and tools. Give the planner a frontier model and the builder a cheap fast one. Give the reviewer no ability to write code at all.

**`tools` is a capability list. `writes` is the boundary.** They are not the same thing: `bash` runs anything, including `git checkout`, and `write` reaches any path. So "this agent changes nothing" is enforced in code, after every call, by comparing the repo before and after. Unauthorized changes are rolled back and the phase fails. A read-only agent is read-only with respect to your repo, never unable to write its own report.

Config defines who an agent **is**. The chain call site defines how it is **used**. That split is what lets one agent serve many different calls. **Chains name agents, never models.**

### A second backend: Claude Code

Set `coding_agent: claude_code` on any agent (or in `defaults`) to run it on your own installed [Claude Code](https://claude.com/product/claude-code) CLI instead of Flue — `spf doctor` checks it's on `PATH`. Model names follow Claude Code's own vocabulary (a bare alias like `sonnet`, not `provider/model-id`); everything else — `tools`, `writes`, `thinking` — stays the same shape. Pointing a `claude_code` agent at a local or cloud [Ollama](https://ollama.com) server needs no config at all — just `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` set before you run `spf`, since Claude Code's CLI reads those itself.

#### Proxy or wrapper launchers

To route the `claude` command through a wrapper, proxy server, or launcher (e.g., [Ollama](https://ollama.com)), set the `SPF_CLAUDE_CMD` environment variable before running `spf`. Space-separated command chains are supported:

```bash
# Route through Ollama's launcher
export SPF_CLAUDE_CMD="ollama launch claude"
spf build "your prompt"
```

```bash
# Or use a custom wrapper script
export SPF_CLAUDE_CMD=/path/to/my-wrapper
spf build "your prompt"
```

The command/launcher must support the full Claude Code CLI interface: `-p` for prompt, `--json-schema`, `--model`, `--session-id`/`--resume`, `--output-format stream-json`, and all other flags `agent_cc` uses. When unset, `SPF_CLAUDE_CMD` defaults to `claude` (resolved from `PATH` normally).

---

## Phases: three lanes, one primitive

Every run is a sequence of phases, and every phase is the same async scope no matter who owns it.

```ts
const REQUIRED_AGENTS = ["planner", "builder"];   // names, never models

const cfg = agents.loadConfig(configPaths);
agents.validate(cfg, REQUIRED_AGENTS, REQUIRED_SUITES, cwd);   // a missing agent fails before anything spawns
const run = session.ensure(cfg, adwId, cwd);                   // pin-or-create the session

const plan = await run.phase(
  makePhaseParams({ name: "plan", kind: "agent", owner: "planner", description: "Turn the request into a plan" }),
  (ph) => ph.call(makeAgentCall({ output_type: PlanOutput, prompt, gates: [gates.artifactsExist] })),
);

await run.phase(
  makePhaseParams({ name: "commit", kind: "code", owner: "git", description: "Commit the working tree" }),
  async () => run.git.commitAll(build.commit_message || `spf: ${prompt.slice(0, 72)}`),
);

return run.finish();
```

Three kinds, three swim lanes. **engineer** is the human lane. **agent** is `ph.call(...)`: prompt in, typed envelope out, gates verified. **code** is a deterministic step that stands on its own — a commit, a quality suite — and is never buried inside an agent phase, so the trace shows exactly when code ran and when an agent was working.

**Success must be earned.** Every phase defaults to `fail`. A clean exit flips it, and an agent phase also needs its envelope to parse and every gate to come back green. `run.finish(accepted, reason)` adds the second question, because phases passing is not the same as the run being acceptable: a test phase that ran a red suite did its job perfectly. One call settles the exit code, the session status, and the banner together, so they cannot disagree.

---

## Envelopes and gates

An agent has exactly two output channels: reference files written into `context_handoff/`, and a final valid-JSON response validated against the output type the call declared. Code persists that response as `envelope.json`, records it, and injects it into the next agent's prompt. Context transfers in code, not in conversation.

```ts
const BuildOutput = envelopeType("BuildOutput", {
  changed_files: v.optional(v.array(v.string()), () => []),
  commit_message: v.optional(v.string(), ""),   // consumed by the git commit phase
});
```

Determinism is wired into every step. Agents must return a specific structure, every time. If it does not validate, they get asked again until it does.

Gates verify claims, never predictions. Nobody knows which files an agent will touch before it finishes, so gates run **after** the fact against the envelope's own declarations: `artifactsExist`, `filesNonEmpty`, `jsonParses`, `diffMatchesClaims`, `testsPass(...)`. A gate is a function with the signature `gate(envelope, run) -> GateReport`, one `check(item, ok, note)` per thing it examined, so a green gate tells you *what* it verified.

When validation fails or a gate returns violations, **nothing restarts**. The harness re-prompts the same session with a correction naming exactly what was wrong, and the context window stays intact. A cold restart throws away everything the agent learned. A correction costs one message.

The output contract lives in three places and they are one thing: the type in `data_types.ts`, the JSON example in that agent's `user.md` `## Report` section, and `output_type:` at the call site. **Change one, change all three in the same edit** — the synced triad.

---

## The trace

One data path, no exceptions: **agents write to SQLite, readers poll SQLite.** Every event lands in `.spf/data/spf.db` while the agent is still working, not batched at the end — tool calls are visible mid-run.

```bash
spf sessions                       # recent runs
spf phases <adw_id>                # phase-by-phase status for one run
spf events <adw_id> --follow       # the live trace, tailable
spf ui                             # a browser-based visualizer over the same db
```

That's the entire transport: a rowid-cursor poll query, run on demand. No push, no WebSocket, no ingest endpoint — live view and full history are the same query at different cadence.

Files stay the raw record (`envelope.json`, `agent_map.json`, Flue's own conversation store). The db is the queryable mirror. Losing it loses nothing you cannot rebuild.

---

## The chains

```bash
spf list                                              # every chain, its phases, what it needs
spf <chain> "<prompt or path/to/prompt.md>" [--config <path>] [--adw-id a1b2c3d4] [--cwd <dir>]
```

| Chain | Phases | Reach for it when |
|---|---|---|
| `prompt` | engineer → \<agent\> | one agent, one prompt, `--agent NAME` picks who |
| `scout` | engineer → scout | read-only recon, nothing changes |
| `plan` | engineer → planner | you want the spec before any code |
| `build` | engineer → builder | the plan already exists |
| `quality` | engineer → code(quality) | lint, typecheck, build, no agents at all |
| `plan-build` | planner, builder, git(commit) | small, well-understood work |
| `build-test` | builder, code(test), bounded fix loop | there is a suite to satisfy |
| `build-review` | builder, reviewer, bounded revise loop | "is this what was asked for" matters more than "does it run" |
| `plan-build-test` | plan, build, code(test), git(commit) | the standard chain |
| `plan-build-test-quality` | same, plus lint/typecheck/build gates | the repo has quality commands worth enforcing |
| `document` | code(git diff), documenter | write up what just shipped |
| `simple-sdlc` | plan, build, test, review, document | the work is real and its shape is not obvious |

`--adw-id` is optional everywhere. Omit it and a fresh id is minted and printed. Supply it and the run joins that session — same session directory, each agent **resumes its existing context window** instead of starting cold. That's how you chain runs:

```bash
spf plan "add a /health endpoint"                        # prints adw_id a1b2c3d4
spf build-test "implement the plan" --adw-id a1b2c3d4
```

---

## `spf watch`

Polls an issue tracker for issues labeled `<prefix>:ready`, runs a configured chain against each in its own git worktree, opens a PR against a code host, and tracks it through to merged or blocked — driving the same chains above rather than reimplementing an SDLC. Labels are the whole state machine: `ready → working → review → done`/`blocked`.

The tracker (`issue_provider`) and the code host (`code_host`) are independent config choices, not one bundled "provider" — a tracker and a host are independent choices in practice (Jira issues against a Bitbucket repo is a real setup). Supported today: `issue_provider: github | jira`, `code_host: github | bitbucket` — any combination works, including Jira+GitHub or GitHub-issues+Bitbucket.

The easiest way into any of this is `spf init`'s interview: it asks whether to enable `spf watch`, which tracker and code host, and collects exactly the env vars that combination needs (below) straight into `.env` — no hand-editing YAML or hunting down which credential pair a given combination wants.

```yaml
# .spf/spf.config.yaml — GitHub issues + GitHub PRs (the default)
watch:
  issue_provider: github     # default
  code_host: github          # default
  repo: owner/name
  label_prefix: spf          # polls issues labeled spf:ready
  chain: plan-build-test     # any registered chain
  base_branch: main
  poll_ms: 60000
  concurrency: 2
```

```yaml
# .spf/spf.config.yaml — Jira issues + Bitbucket PRs
watch:
  issue_provider: jira
  code_host: bitbucket
  repo: workspace/repo_slug  # Bitbucket's own two-part identifier
  label_prefix: spf          # polls Jira issues labeled spf:ready
  chain: plan-build-test
  base_branch: main
  jira:
    base_url: https://your-domain.atlassian.net
    project_key: PROJ
```

```bash
spf watch init                # idempotently seed tracker state (no-op for Jira — see below); run this first
spf watch                    # foreground daemon; Ctrl-C drains in-flight claims first
spf watch --once             # one poll tick, then exit — good for cron
spf watch --dry-run          # log intended claims/transitions, mutate nothing
```

No GitHub App, no webhook, no Jira/Bitbucket app install — it's a plain REST poll against whichever combination is configured, same philosophy as the trace db's own polling contract. See [`assets/templates/`](assets/templates/) for full worked configs (also usable directly via `spf init --template <name>`), and `spf install-skill`'s installed skill (`roster.md`, `references/config.md`) for the field-by-field reference.

### GitHub (`issue_provider: github` and/or `code_host: github`)

```bash
export GITHUB_TOKEN=...   # classic PAT; spf doctor checks it's set
```

`spf watch init` seeds `<prefix>:ready`/`working`/`review`/`done`/`blocked` labels with a color and description each — safe to re-run any time (creates what's missing, corrects any that drifted, leaves the rest alone).

A **classic** PAT (fine-grained tokens use different permission names — not covered here), scoped to the minimum that covers every call `spf watch`/`spf watch init` makes on GitHub: creating/editing labels, reading and labeling issues, posting comments, opening PRs, and reading PR/check-run status.

| Target repo | Scope | Covers |
|---|---|---|
| Private | `repo` | Everything above, full read/write |
| Public only | `public_repo` | The same, restricted to public repos |

**Do not grant the `project` scope.** It's a separate, unrelated permission for GitHub Projects (classic/org/user boards) — `spf watch` doesn't touch Projects at all, so granting it would just be more access than this tool ever uses.

There's no dedicated "issues" or "pull requests" scope on classic PATs — GitHub bundles both into `repo`/`public_repo`, which is why that's the whole table.

### Jira (`issue_provider: jira`)

```bash
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...   # id.atlassian.com -> Security -> API tokens
```

State is modeled as Jira **labels** (`<prefix>:ready`, etc.), mirroring GitHub exactly, rather than native workflow status transitions — the latter would need per-project transition-id mapping, since workflows vary by project/scheme; labels work identically everywhere with zero per-project setup. One caveat: colons are a legal Jira label character and JQL matches on them fine, but they won't show up in Jira's own label autocomplete UI — cosmetic only.

`spf watch init` is a no-op here (Jira labels are freeform strings with no color/description registry to seed, unlike GitHub's) — it just reports the labels this run will use.

### Bitbucket (`code_host: bitbucket`)

```bash
export BITBUCKET_EMAIL=you@example.com
export BITBUCKET_API_TOKEN=...   # same Atlassian API token mechanism as Jira above
```

**Bitbucket Cloud app passwords are being fully removed** (brownout window closing July 28, 2026) — this project only supports the replacement, API tokens, which need the account's email alongside the token (username alone no longer works).

## Notifications

Optional, off by default: push a curated set of milestones to Slack,
Microsoft Teams, or a generic webhook. It's scoped to **unattended work**:
`spf watch`'s daemon lifecycle, and every chain run (`spf <chain>` / `spf
run`, including watch's own per-issue runs). Interactive commands — `doctor`,
`list`, `sessions`, `phases`, `events`, `init`, `ui`, `migrate`, `eject`,
`abort`, `version` — never notify; you're already looking at the terminal
for those.

```yaml
# .spf/spf.config.yaml
notifications:
  events: errors            # off (default) | errors | all
  channels:
    - kind: slack            # slack | teams | webhook
      webhook_url_env: SLACK_WEBHOOK_URL   # optional; this is the default for slack
```

`events` is the whole filter: `errors` sends only failed runs/phases, blocked
issues, and watch errors; `all` adds every milestone — run started/finished,
issue claimed, PR opened, issue done. A channel's own `events` overrides the
top-level scope for just that channel. `spf doctor` reports whether each
configured channel's env var is set.

The webhook URL is a secret and lives only in `.env` — `webhook_url_env`
names the key, never the URL itself, matching `GITHUB_TOKEN`/
`JIRA_API_TOKEN`. Defaults per kind: `SLACK_WEBHOOK_URL`, `TEAMS_WEBHOOK_URL`,
`SPF_WEBHOOK_URL`. `spf init`'s interview asks for this section and collects
the URL straight into `.env`, same as every other credential.

Getting each channel's URL:

- **Slack** — [Sending messages using Incoming Webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks): create a Slack app, enable Incoming Webhooks, "Add New Webhook to Workspace".
- **Microsoft Teams** — [Send messages in Teams using incoming webhooks](https://support.microsoft.com/en-us/office/post-a-workflow-when-a-webhook-request-is-received-in-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498): in the target channel, add a Workflows webhook template (search for one along the lines of "Post to a channel when a webhook request is received" / "Send webhook alerts to a channel" — Microsoft's own naming here has shifted between revisions) and copy the generated URL. This is the *only* supported path now — the old Office 365 connector webhook has been retired by Microsoft.
- **webhook** — any endpoint that accepts a JSON POST of the event: Discord,
  n8n, Zapier, a homegrown receiver.

Delivery never blocks or fails a run: an unconfigured/misconfigured channel
is skipped with one warning, and a failed POST logs one line and is
swallowed — never changes a run's exit code. One thing worth knowing under
`events: all`: `spf watch` runs its per-issue chains in-process, so a failed
issue produces **two** notifications for the same failure — `run_failed`
(keyed to the chain's own `adw_id`, e.g. `issue-142`) from the chain-run
side, and `issue_blocked` (keyed to the issue) from watch itself. Both are
genuinely informative, just worth expecting.

Full field reference: `spf install-skill`'s installed skill
(`references/config.md`).

## What's in this repo

```
super-portable-software-factory/
├── src/
│   ├── cli/        # the `spf` command surface
│   ├── chains/      # the twelve starter chains + the registry
│   ├── core/        # config, agents, gates, quality, the sqlite trace, paths
│   └── ui/          # the trace visualizer's server side
├── app/             # the trace visualizer SPA (Vue), built once at publish time
└── assets/
    ├── defaults/    # the packaged default roster
    ├── prompts/     # default system.md + user.md per starter agent
    └── skill/       # an optional Claude Code skill — `spf install-skill` to use it
```

There's no template stamped into your repo. Everything above ships inside the installed npm package; a repo you run `spf` against only ever gains a `.spf/` directory, and only if you ask for one.

---

## Where it can still fail

Honest edges, because knowing them is cheaper than discovering them.

| Failure | What actually happens | What to do |
|---|---|---|
| A quality-gated chain with no `quality:` configured | Fails loudly at `spf doctor`/validate time, before anything spawns | Add a `quality:` section to `.spf/spf.config.yaml` — there's no packaged default suite on purpose |
| A bare model pattern | The same model can sit under several providers, so an unqualified pattern is ambiguous | Always write `provider/model-id` |
| A coding agent hangs silently | No events, no tokens. The trace goes quiet rather than red | `spf phases <adw_id>` shows what's still `running`; `spf abort <adw_id>` stops it |
| The synced triad drifts | Envelope type, `## Report` example, and `output_type:` disagree, so every call burns correction rounds | Grep the type name and fix all three in one edit |
| Gates pass, output is bad | Gates check what a predicate can check, not plan quality or code taste | Run the `reviewer`, or read it yourself |
| An agent edits something it shouldn't | Detected and rolled back after the call, and the phase fails | Expected. Widen that agent's `writes` if the change was legitimate |
| Commit phase has nothing to commit | Throws if the cwd isn't a git repo or nothing changed | `git init` with one commit first |

Also missing on purpose, so you know what to add: chains run on your current branch by default. For real work you want a branch or worktree per run and a merge step at the end.

**Is this overkill for a one-off feature?** Yes. Prompt an agent and move on. This earns its keep when the same workflow runs a hundred times, when validation is the only thing standing between you and a bad merge, and when you need the thousandth run to look like the first.

---

## Built to be observed, customized, and reused

Nothing here is meant to survive contact with your codebase unchanged. The prompts describe a demo app, not your domain. The roster names the models that were good the week it was written. All of that is supposed to be replaced — `spf init` gives you the seam to do it one field at a time, and `spf eject` gives you an editable copy of the engine itself if you need to go further than config.

| Change | Where | Why |
|---|---|---|
| Your real commands | `.spf/spf.config.yaml`'s `quality:` | There's no packaged default suite — an unconfigured one fails loudly, on purpose |
| Your prompts | `.spf/prompt_engineering/{agent}/` | Where your standards live: what a good plan looks like, what a review has to catch |
| Your roster | `.spf/spf.config.yaml` | Models, thinking levels, tools, and what each agent is allowed to write |
| Your definition of done | a new gate in `core/gates.ts` (via `spf eject`) | A gate is one function |

So take it. Strip the parts you don't need, rename the agents, throw out half the chains, and roll what's left into the factory your project actually needs. The specific chains here matter far less than the shape: code owns the loop, agents own the phases, and every run leaves a trace you can go read.

---

## Provenance

Super Portable Factory began as a fork of [disler/super-simple-software-factory](https://github.com/disler/super-simple-software-factory). Its MIT license is preserved unmodified in this repo's [`LICENSE`](LICENSE).

## License

MIT, see [`LICENSE`](LICENSE).
