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

No Bun, no separate coding-agent binary to install first, no template stamped into your repo. `spf` ships with a packaged default agent roster and default prompts — it runs against any repo with zero setup, and only writes files into that repo if you explicitly ask it to (`spf init`, which also installs the Claude Code skill unless you pass `--no-skills`; `spf install-skill` does just the skill by hand).

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

Every `spf init` run — interview or not — also installs the repo-local Claude Code skill (`.claude/skills/spf`), the same work `spf install-skill` does by hand: pass `--no-skills` to skip it. It's idempotent (a no-op once the skill is already current, and writes a `.new` sibling instead of overwriting a file you've locally edited), so re-running `spf init` never clobbers anything there. `spf install-skill --user` (installing to `~/.claude/skills/spf` instead) is still its own separate invocation.

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

Six starter agents ship in the box: `planner`, `builder`, `scout` (read-only recon), `refiner` (decomposes a product spec for `spf watch`'s refine lane — see "`spf watch`" below), `reviewer`, and `documenter`. There is no tester, because running a suite is a known command and therefore code, not an agent's job.

Every agent gets its own model, thinking level, prompts, and tools. Give the planner a frontier model and the builder a cheap fast one. Give the reviewer no ability to write code at all.

**`tools` is a capability list. `writes` is the boundary.** They are not the same thing: `bash` runs anything, including `git checkout`, and `write` reaches any path. So "this agent changes nothing" is enforced in code, after every call, by comparing the repo before and after. Unauthorized changes are rolled back and the phase fails. A read-only agent is read-only with respect to your repo, never unable to write its own report.

Config defines who an agent **is**. The chain call site defines how it is **used**. That split is what lets one agent serve many different calls. **Chains name agents, never models.**

### A second backend: Claude Code

Set `coding_agent: claude_code` on any agent (or in `defaults`) to run it on your own installed [Claude Code](https://claude.com/product/claude-code) CLI instead of Flue — `spf doctor` checks whatever `SPF_CLAUDE_CMD`'s first token resolves to on `PATH` (`claude` itself, by default). Model names follow Claude Code's own vocabulary (a bare alias like `sonnet`, not `provider/model-id`); everything else — `tools`, `writes`, `thinking` — stays the same shape. Pointing a `claude_code` agent at a local or cloud [Ollama](https://ollama.com) server needs no config at all — just `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` set before you run `spf`, since Claude Code's CLI reads those itself.

#### Proxy or wrapper launchers

To route the `claude` command through a wrapper, proxy server, or launcher (e.g., [Ollama](https://ollama.com)), set the `SPF_CLAUDE_CMD` environment variable before running `spf`. Space-separated command chains are supported:

```bash
# Route through Ollama's launcher
export SPF_CLAUDE_CMD="ollama launch claude --model granite4.1:8b"
spf build "your prompt"
```

`ollama launch <cmd>` uses cobra flag parsing, which treats anything typed after it as its own flags unless a literal `--` says otherwise — without one, `claude`'s own flags (`-p`, `--json-schema`, ...) fail with `unknown shorthand flag: 'p' in -p` before `claude` is ever reached. `agent_cc.ts` detects exactly this `ollama launch ...` shape and inserts that `--` automatically, so you never add the separator by hand for this specific launcher.

That `--` alone is not enough to reach `claude`, though: `ollama launch` also needs its OWN `--model <tag>` flag (a tag from `ollama list`), typed BEFORE the auto-inserted `--`, whenever it runs headless — which it always does under SPF, since SPF spawns with piped stdio. Without it, `ollama launch` falls back to an interactive model picker that can never run, and fails one step later than the `--` problem, with `model selection requires an interactive terminal; use --model to run in headless mode`. A `--model` typed after the `--` doesn't help — at that point it belongs to `claude`, not to `ollama launch`. So `SPF_CLAUDE_CMD` must include `ollama launch`'s `--model` yourself, exactly as written above; `spf doctor` hard-fails if it's missing.

```bash
# Or use a custom wrapper script
export SPF_CLAUDE_CMD=/path/to/my-wrapper
spf build "your prompt"
```

The command/launcher must support the full Claude Code CLI interface: `-p` for prompt, `--json-schema`, `--model`, `--session-id`/`--resume`, `--output-format stream-json`, and all other flags `agent_cc` uses. When unset, `SPF_CLAUDE_CMD` defaults to `claude` (resolved from `PATH` normally). A cmdSpec that already contains its own literal `--` is left completely alone — `agent_cc.ts` never inserts a second one.

### flue + local Ollama

Point the default `flue` backend at a local Ollama server the same way you'd pick any other Flue provider — the model string's own prefix, `ollama/<tag>` (whatever `ollama list` shows on your machine) instead of `openai/...`/`anthropic/...`:

```yaml
defaults:
  coding_agent: flue
  model: ollama/qwen3.8:27b-mlx
```

```bash
export OLLAMA_BASE_URL=http://localhost:11434/v1   # default if unset
spf build "your prompt"
```

That's the whole config change. `ollama` is a keyless provider — `spf doctor` and the `spf init` interview both know this: no API key is ever asked for or checked, and interview.ts asks for `OLLAMA_BASE_URL` instead when you pick `ollama` as your provider. A ready-to-run starting point ships at [`assets/templates/ts-flue-ollama.spf.config.yaml`](assets/templates/ts-flue-ollama.spf.config.yaml) (`spf init --template ts-flue-ollama`).

Two things worth knowing before pointing a full roster at local models: tool-calling — the injected `sf_report` contract every agent's structured output rides on — worked reliably in testing down to a 3B-parameter model, which isn't a "only frontier models get tools" situation. And context-window occupancy reporting is disabled for `ollama/*` models specifically, which turns off threshold-based compaction rather than reporting a number Ollama's OpenAI-compatible API doesn't actually provide per model.

---

## Isolation: post-hoc, not a sandbox

Agent isolation in SPF is enforced **after the fact**, not upfront. This matters because the `tools:` capability list is not a sandbox — a `bash` tool can run `git checkout` to discard changes, and a `write` tool can reach any path, regardless of the allowlist you write. So permission is verified the way every other claim in this system is: the working tree is fingerprinted before an agent runs, then compared after. If the agent touched anything outside its `writes:` allowlist (or a `protected_files:` path it wasn't given access to), the phase fails and anything the agent *introduced* outside its allowlist is rolled back. What it cannot undo, it names: a file that was already dirty before the agent ran is left alone rather than discarded, and uncommitted work the agent reverted cannot be restored. And because the check is post-hoc and tree-scoped, nothing outside the working tree is in scope at all — a push, a network call, a write above `repo_root`. When running an agent on the claude_code backend, SPF spawns it with `--permission-mode bypassPermissions --dangerously-skip-permissions` because the backend has no need to enforce — SPF will enforce in code instead, within those bounds.

For unattended work, `spf watch`'s PR-merge is the only human accountability checkpoint: the daemon opens a PR for each automated run, and a human approves the merge. For any other workflow, this enforcement is the backbone of letting a bounded agent proposal survive code's inspection without a human having to read it in between — but it is bounded, not a sandbox, and the scope above is what a reviewer should actually rely on. (Attended `simple-sdlc` runs get a second checkpoint of their own — see below.)

See `core/permissions.ts` for the implementation — the snapshot/compare logic, not the config terms.

`simple-sdlc`'s `commit_build` phase is the one place in this codebase where an AI reviewer's `approved` flag alone would otherwise gate a commit — everywhere else the reviewer either doesn't run (`plan-build-test`, ...) or nothing commits on its verdict (`build-review` has no commit step). Run attended, that phase asks before committing — default **no**, never `review.approved` itself, bounded by `review.signoff_timeout_seconds` (default 300s; expiry answers no) — and only an explicit, recorded "yes" ever earns a `Signed-off-by:` trailer, built from `git config user.name`/`user.email` at the repo, never an env var. Run unattended (`spf watch`, CI), there is nobody to ask: `spf watch`'s own human gate is the PR merge above, informed by the reviewer's digest in the PR body, and the phase either proceeds on the AI verdict alone with a loud warning (`review.require_human_signoff: false`, this release's default — fail-open until `spf watch` itself becomes signoff-aware) or fails closed and asks you to rerun attended (`require_human_signoff: true`). See `assets/skill/references/config.md`'s `review` section for the two knobs, and [`assets/skill/cookbooks/ocr_reviewer.md`](assets/skill/cookbooks/ocr_reviewer.md) if you want the reviewer to fold a third-party review tool's findings into its own verdict as one more piece of evidence.

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
spf <chain> "<prompt or path/to/prompt.md>" [--config <path>] [--adw-id a1b2c3d4] [--cwd <dir>] [--suite <name>]
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

A chain with a compiled-in quality suite (`build-test`, `plan-build-test`, `plan-build-test-quality`, `quality`) accepts `--suite <name>` to override it for one run — `spf list` marks which chains this applies to with `(--suite overrides)`. `simple-sdlc`'s suite is not overridable this way; passing `--suite` to it is rejected rather than silently ignored.

`--adw-id` is optional everywhere. Omit it and a fresh id is minted and printed. Supply it and the run joins that session — same session directory, each agent **resumes its existing context window** instead of starting cold. That's how you chain runs:

```bash
spf plan "add a /health endpoint"                        # prints adw_id a1b2c3d4
spf build-test "implement the plan" --adw-id a1b2c3d4
```

### Repo-local chains

Every chain above is built in. A target repo can also compose its own out of
the same step factories, with zero forking and zero build step, by dropping a
file in `.spf/chains/*.yaml` — `spf init` scaffolds `.spf/chains/example.yaml`
(fully commented out) showing the shape:

```yaml
# .spf/chains/ship-it.yaml — spf ship-it "<prompt>" / spf run ship-it "<prompt>"
name: ship-it
describe: plan, build, test, land — with our own reviewer in the loop
steps:
  - step: request
  - step: plan
    owner: architect
  - step: build
    extraGates: [jsonParses]   # additive only — a step's built-in gates can never be removed
  - step: fixLoop
    suite: test
  - step: commit
    onlyIfAccepted: true
```

It shows up in `spf list`/`spf doctor` exactly like a built-in, and runs on
the identical `stepChain()` driver — there is no second interpreter. The full
step vocabulary, the gate rules, and the `spf watch` main-anchor divergence
(a chain edited on an issue branch is *not* what an in-flight `spf watch` run
uses) are documented in the installed skill's "Repo-local chains" section
(`.claude/skills/spf/cookbooks/authoring_chains.md`, after `spf init`).

---

## `spf watch`

Polls an issue tracker for issues labeled `<prefix>:ready`, runs a configured chain against each in its own git worktree, opens a PR against a code host, and tracks it through to merged or blocked — driving the same chains above rather than reimplementing an SDLC. Labels are the whole state machine: `ready → working → review → done`/`blocked`.

A second, optional lane (`watch.refine`, off by default) decomposes a `<prefix>:spec-ready` product spec into a feature/story-or-bug tree of real issues instead — see "Refining specs" below.

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

```yaml
# .spf/spf.config.yaml — GitHub issues + Bitbucket PRs, in TWO DIFFERENT repos
watch:
  issue_provider: github
  code_host: bitbucket
  repo: workspace/repo_slug     # Bitbucket's repo — the CODE HOST always reads plain `repo`
  issue_repo: owner/name        # GitHub's repo — only needed here, where issue tracker != code host
  label_prefix: spf             # polls GitHub issues labeled spf:ready
  chain: plan-build-test
  base_branch: main
```

`repo` always names the code host's own repo; `issue_repo` overrides it for
the issue-tracker side. This only matters for `issue_provider: github` +
`code_host: bitbucket` — the one combination where they're genuinely
different repos in different systems, not the same repo worn two ways
(`github`+`github` is one repo by construction; `issue_provider: jira` never
reads `repo` at all, so it's never ambiguous). Leave `issue_repo` unset
everywhere else. `spf doctor` flags this specific combination when
`issue_repo` is missing, since the silent failure mode — polling GitHub with
the Bitbucket identifier — finds no matching issues and looks exactly like
nothing being configured at all.

```bash
spf watch init                # idempotently seed tracker state (labels are a no-op report on Jira — see below); run this first
spf watch                    # foreground daemon; Ctrl-C drains in-flight claims first
spf watch --once             # one poll tick, then exit — good for cron
spf watch --dry-run          # log intended claims/transitions, mutate nothing
```

No GitHub App, no webhook, no Jira/Bitbucket app install — it's a plain REST poll against whichever combination is configured, same philosophy as the trace db's own polling contract. See [`assets/templates/`](assets/templates/) for full worked configs (also usable directly via `spf init --template <name>`), and `spf install-skill`'s installed skill (`roster.md`, `references/config.md`) for the field-by-field reference.

### Priority, dependencies, and picking what's next

Among every `<prefix>:ready` issue, `spf watch` claims in this order:

1. **Priority** — the `<prefix>:priority:p0|p1|p2|p3` label (`p0` drop-everything, `p2` the default, `p3` someday). `spf watch init` seeds all four. A human relabeling an issue is the whole override mechanism — there's no separate priority command.
2. **Sibling affinity** — among issues at the same priority, one whose parent feature already has a sibling in flight goes first. This is what tends to finish one feature before starting the next without giving up the one-PR-per-story design (see "Refining specs" below): each story is still its own claim, its own worktree, its own PR — affinity only orders which claim happens next.
3. **Creation order** (oldest first) — the final tiebreaker.

Before claiming anything, `spf watch` also checks the **frontier**: an issue's `blocked_by` dependencies (set by the refine lane, or by hand) must all carry `<prefix>:done` first. A leaf whose blockers aren't done yet is skipped, not blocked — it's simply reconsidered next tick, once the log line naming what it's waiting on stops applying.

This is a **label**, not this repo's own GitHub Projects v2 "Priority" field (if your board has one — Urgent/High/Medium/Low, say). `spf watch` never reads or writes Projects v2: no GraphQL, no `project` token scope, no Jira equivalent. If you use both, they're independent — nothing reconciles them, and `spf watch` obeys only the label. Keep them aligned yourself, or don't use the board field for this repo's issues.

### Refining specs (`watch.refine`)

A product spec isn't individually workable — it needs to become a feature,
broken down into user stories and bugs, before the build lane above has
anything to claim. `watch.refine` is a second lane over the same poll loop
that does exactly that: it polls `<prefix>:spec-ready`, runs a decomposition
chain (`refine` by default — `request → scout → refiner → publish`) against
the spec in its own worktree, and publishes what it produces as real tracker
issues — a feature/epic container plus story/bug/task leaves, linked into a
real hierarchy: GitHub's native sub-issues API, or Jira's `parent` field.

```yaml
watch:
  issue_provider: github    # or jira — both implement issue authoring
  repo: owner/name
  refine:
    enabled: true
    chain: refine           # any chain that ends in steps.publishIssues()
    concurrency: 1          # this lane's own budget, independent of watch.concurrency
```

On Jira, every `RefinedIssue.kind` (`epic`/`feature`/`story`/`bug`/`task`) maps
to a real Jira issue type through `watch.jira.issue_types` — defaults
`epic`/`feature` → `Epic`, `story` → `Story`, `bug` → `Bug`, `task` → `Task`,
overridable per kind since real projects rename or customize these:

```yaml
watch:
  issue_provider: jira
  jira:
    base_url: https://your-domain.atlassian.net
    project_key: PROJ
    issue_types:        # optional — shown are the defaults
      epic: Epic
      feature: Epic
      story: Story
      bug: Bug
      task: Task
  refine:
    enabled: true
```

Hierarchy uses Jira's modern `parent` field only (no legacy "Epic Link"
custom-field support) — this works on team-managed projects and on
company-managed projects with Jira's current issue-hierarchy setting; a
project not configured for it surfaces Jira's own API error, unmodified.
One accepted platform limitation: Jira doesn't support Epic-under-Epic
nesting the way GitHub's sub-issues API supports up to 8 levels, so a
`feature` node parented under another `epic`/`feature` (both `Epic` by
default) will fail at publish time on Jira specifically — a real platform
difference, not a bug. Both `spf watch init` and `spf watch`'s own startup
check validate `watch.jira.issue_types` against the real project before
anything unattended runs — see "Jira" below.

Every generated issue carries a `<prefix>:type:epic|feature|story|bug|task`
label AND a `<prefix>:priority:p0|p1|p2|p3` label (see "Priority, dependencies,
and picking what's next" above) — the refiner proposes the priority, a human
can relabel it before promoting. A container (a feature/epic — something
else names it as `parent`) gets only those two labels; a leaf additionally
gets `<prefix>:refined` — **never** `<prefix>:ready`. Promoting a leaf to
`<prefix>:ready` is a deliberate human decision: the refine lane never
auto-promotes anything, so a spec fanning out into twenty stories doesn't
turn into twenty unattended chain runs and twenty PRs with nobody having
looked at the breakdown first. Once you do promote a leaf, the existing build
lane picks it up completely unchanged — including the frontier check: a
promoted leaf isn't claimed until every issue named in its `blocked_by` is
`<prefix>:done`.

A spec issue's own `<prefix>:priority:pN` label, if it has one, reaches the
refiner as a **ceiling**: no generated node may be more urgent than the spec
itself (enforced regardless of what the refiner emits — see
`core/refine.ts`'s `publish()`). `spf refine ... --priority p1` sets the same
ceiling for a bare manual run with no spec issue to read a label from.

Grounding the decomposition in real code is structural, not just prose: a
`scout` phase maps the subsystems the spec touches before the refiner ever
runs, and its findings flow straight into the refiner as context. This makes
`scout` a required agent for the `refine` chain — a roster that pruned it
fails `spf watch` startup by name, the same as any other missing required
agent.

#### Human-in-the-loop escalation

The refiner is instructed not to guess on anything material (scope, data
model, an external dependency choice, a UX contract, a breaking change, or
anything that would contradict an existing ADR — see
`assets/prompts/refiner/system.md`'s "Ask, don't decide"). When it hits real
ambiguity it raises questions instead of publishing a partial tree, and the
spec moves through an extra loop before it's even fully published:

```text
spec-ready → refining ──┬─→ spec-in-progress → done / blocked   (published a tree, THEN tracked to completion)
                         └─→ needs-feedback                      (raised questions)
                                  │  a human answers in the issue's comments,
                                  │  then adds continue-refinement
                                  ▼
                            refining (again, same adw_id) → ...
```

Answer the refiner's questions as comments on the spec issue, then add the
`<prefix>:continue-refinement` label. `spf watch` resumes the **same**
`adw_id` — the refiner's own coding-agent session continues, with the
comment thread folded into its prompt — so it never re-derives context it
already had, and it can loop through as many rounds as it takes; there's no
cap. If channels are configured (see "Notifications" below), a
`spec_needs_feedback` event fires every round.

**Publishing a tree does not mean the spec is done.** A product manager
watching a spec's status needs "done" to mean the work is actually finished,
not merely that a decomposition happened — so once the refiner publishes,
the spec moves to `<prefix>:spec-in-progress`, not `<prefix>:done`. It stays
there — with a summary comment listing every issue it created, noting how
many rounds of feedback it took, if any — until **every one of those
issues** reaches `<prefix>:done` (a leaf that lands, or a feature/epic
container once `rollUp` has already finished it — see "Container roll-up"
below). Only then does `spf watch` transition the spec to `<prefix>:done`,
post a closing comment, and close it on the tracker where the tracker
supports closing at all — GitHub does (best-effort: a failed close never
turns completed work back into `blocked`); Jira doesn't have this wired up,
so a Jira spec still relabels and comments correctly, just stays open. A
`spec_done` event fires either way, distinct from the earlier
`spec_refined`. A spec whose
generated leaf never gets promoted, or whose work stalls `blocked`, simply
stays `spec-in-progress` — which is the truthful state, not a bug.

The spec issue's full lifecycle: `spec-ready → refining → needs-feedback ⇄
refining → spec-in-progress → done`/`blocked` (the `needs-feedback ⇄
refining` loop only when the refiner actually escalates). Try it by hand
first, against a real spec, before turning on the daemon:

```bash
spf refine "<spec text or path/to/spec.md>" --issue 42               # --issue renders a "## Parent" section, "Decomposed from #42."
spf refine "<spec text or path/to/spec.md>" --issue 42 --priority p1 # --priority clamps every generated node to p1 or less urgent
```

#### Container roll-up

A feature or epic isn't itself a unit of work, so it's never claimed and
never opens a PR — but it isn't abandoned once its children exist, either.
Every time a leaf's PR merges, `spf watch` checks that leaf's parent: once
**every** child under a container carries `<prefix>:done`, the container
gets a summary comment (every child it rolled up, by id), transitions to
`<prefix>:done`, and closes on the tracker if the tracker supports closing
at all (GitHub does; Jira doesn't have this wired up, so a Jira container
still relabels and comments, just stays open) — then the same check runs on
*its* parent, so an epic of features rolls up once its last feature does.
A container with even one unfinished child (including one still sitting at
`<prefix>:refined`, never promoted) is left exactly as it is; nothing times
out or force-closes it.

Roll-up needs to read back the hierarchy `publish()` created — GitHub's
native sub-issues API, or a Jira `parent = "<id>"` JQL search — so it works
on both providers today, same as authoring itself. A tracker that isn't
authoring-capable at all gets a logged no-op, not a startup failure, since
the build lane still works fine without roll-up.

`spf watch init` seeds the type labels alongside the state ones — **re-run
it** after upgrading to this version, so it can create the new
`<prefix>:needs-feedback` and `<prefix>:continue-refinement` labels. This
lane's prompt (`assets/prompts/refiner/`) is adapted from a "tracer-bullet
ticket" decomposition skill — vertical slices, a `blocked_by` dependency
graph, and an expand/migrate/contract sequence for wide mechanical refactors
— with a gate (`gates.refinementWellFormed`) added on top to enforce the
container/leaf shape that skill left as prose convention rather than a
checked rule, now also enforcing that a refinement never publishes issues and
raises questions in the same round.

### GitHub (`issue_provider: github` and/or `code_host: github`)

```bash
export GITHUB_TOKEN=...   # classic PAT; spf doctor checks it's set
```

`spf watch init` seeds `<prefix>:ready`/`working`/`review`/`done`/`blocked`/`spec-ready`/`refining`/`refined` labels, plus `<prefix>:type:epic`/`feature`/`story`/`bug`/`task` (used by the refine lane whether or not it's enabled), each with a color and description — safe to re-run any time (creates what's missing, corrects any that drifted, leaves the rest alone).

A **classic** PAT (fine-grained tokens use different permission names — not covered here), scoped to the minimum that covers every call `spf watch`/`spf watch init` makes on GitHub: creating/editing labels, reading and labeling issues, posting comments, opening PRs, reading PR/check-run status, and — with `watch.refine.enabled` — creating issues and linking them via the sub-issues API. All of it is already covered by `repo`/`public_repo`; refine needs no additional scope.

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

`spf watch init` still doesn't create any labels here (Jira labels are freeform strings with no color/description registry to seed, unlike GitHub's) — it reports the labels this run will use. But with `watch.refine.enabled`, it now also validates `watch.jira.issue_types` against the real project's issue types, read-only, and exits non-zero on a mismatch — see "Refining specs" above.

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
  events: attention         # off (default) | errors | attention | all
  channels:
    - kind: slack            # slack | teams | webhook
      webhook_url_env: SLACK_WEBHOOK_URL   # optional; this is the default for slack
```

`events` is the whole filter, narrowest to widest:

- `errors` sends only true failures — a failed run/phase (`run_failed`,
  `phase_failed`) or a `watch_error`.
- `attention` adds anything that needs a human but isn't itself a failure —
  a blocked issue (`issue_blocked`) or a spec needing feedback
  (`spec_needs_feedback` — see "Human-in-the-loop escalation" above).
- `all` adds every remaining milestone — run started/finished, issue
  claimed, PR opened, issue done, a container's roll-up (`feature_done` —
  see "Container roll-up" above), and a spec reaching actual completion
  (`spec_done` — distinct from `spec_refined`, which fires the moment a
  tree is published; see "Human-in-the-loop escalation" above).

Each tier includes everything the narrower tiers send. A channel's own
`events` overrides the top-level scope for just that channel. `spf doctor`
reports whether each configured channel's env var is set.

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

## Observability

Every run produces a complete trace: all events, phases, agent calls, and tool invocations stream into SQLite as they happen. The local trace stays the source of truth — prompts, envelopes, tool arguments, and your source code never leave the machine. Token counts and costs ride alongside.

```bash
spf ui                           # browser-based visualizer over the trace
spf events <adw_id> --follow    # live event stream, tailable
```

The default export is SQLite only (`.spf/data/spf.db`). Optionally, you can export **spans only** (phase/agent/tool timing and allowlisted metadata) to an OpenTelemetry collector for integration with a trace UI or observability platform:

```yaml
observability:
  db: .spf/data/spf.db
  poll_ms: 500
  otel:
    endpoint: https://your-otel-collector/v1/traces
    service_name: spf                    # optional; default "spf"
    headers:                             # optional; e.g. auth headers
      Authorization: Bearer ...
```

OTEL export is **explicit config only** — an unrelated shell variable cannot become a data-egress switch. OTEL is strictly a spans-only export: each phase is a span with child spans for agent calls and tool calls, annotated with phase status, agent model, token/cost counts, and gate results. This export never blocks a run: if the collector is slow or unreachable, SPF continues normally and logs a single line per run when export fails (not one per batch), and reports the number of dropped spans on the final flush as `spf.otel.dropped_spans` for the backend to surface. The complete trace stays in SQLite regardless.

**Attribute allowlist**: only phase name/kind/owner/status, chain name, adw_id, agent name/model/coding_agent, gate name + passed + violation count, token counts and cost, and durations. Prompts, envelopes, tool arguments, and your source code never leave — that guarantee is enforced in code, not just in documentation.

See `assets/skill/references/config.md`'s `observability` section for the full field reference.

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
    └── skill/       # a Claude Code skill — `spf init` installs it by default (`--no-skills` to opt out), or `spf install-skill` by hand
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
