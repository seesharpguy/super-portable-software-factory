# Roster

Add or retune agents in `spf.config.yaml`. There's nothing to generate — `spf
init` seeds a starter `.spf/spf.config.yaml` with a couple of commented
examples; everything else is inherited from the packaged defaults until you
override it. `spf doctor` always shows what's actually in effect and where it
came from.

## The rule

**One agent, one prompt, one purpose.** A roster entry defines who an agent
*is*: its model, thinking level, and exactly one system prompt plus one user
prompt. How it's *used* — the output type, a per-call prompt override —
lives at the chain call site, never here. See `authoring_chains.md`.

## Retune model or thinking

```yaml
agents:
  - name: builder
    model: anthropic/claude-sonnet-4-6   # ALWAYS provider/model-id
    thinking: high                       # was medium
```

Write the model as `provider/model-id`, never a bare id — SPF has no live
model catalog to check against (that was `pi --list-models`; Flue has no
public equivalent), so an unqualified or malformed pattern is only caught by
shape at `agents.validate()` time, and a genuinely wrong id surfaces at the
first real dispatch. Thinking levels: `off | minimal | low | medium | high |
xhigh | max` — inert (no error, no effect) on a model that isn't a reasoning
model.

**This is Flue's model vocabulary, not every backend's.** An agent with
`coding_agent: claude_code` (see below) writes `model:` in Claude Code's own
vocabulary instead — a bare alias (`sonnet`, `opus`) or a full model name —
never `provider/model-id`. `agents.validate()` knows which shape check
applies from `coding_agent`, so mixing the two conventions in the same
roster is fine as long as each agent's own `model:` matches its own
backend.

**A model change means a fresh session.** `agent_map.json` records the
model each agent's Flue conversation was created with. When a joined run
(`--adw-id`) finds the config's model no longer matches, that agent starts a
**new** conversation rather than resuming — never a bad resume. Thinking
changes don't invalidate a session; model changes do.

## Recolor an agent's lane

```yaml
agents:
  - name: builder
    color: "#22d3ee"      # hex; the starter roster ships violet/cyan/amber/red/magenta
```

Cosmetic, safe mid-project — rides the `agent_start` event and the
`agent_sessions` row, so the UI picks it up on the next run without
touching past sessions. Omit it for the UI's fallback palette.

## Coding agent backends

`coding_agent: flue` (the default) or `coding_agent: claude_code` — set per
agent or in `defaults`. Both read the same roster shape (`tools:`,
`writes:`, `thinking:`), but each backend interprets a couple of fields in
its own vocabulary:

```yaml
agents:
  - name: builder
    coding_agent: claude_code
    model: sonnet              # Claude Code's own alias/name, NOT provider/model-id
    thinking: high
    tools: [read, edit, bash]  # same canonical names either way — see "Retune tools" below
```

`claude_code` shells out to your own installed `claude` CLI (`spf doctor`
checks it's on `PATH`) — it needs no separate npm install, since SPF never
depends on it directly. A missing `ANTHROPIC_API_KEY` is informational, not
a hard failure: Claude Code also supports its own `claude login` flow.

**Pointing a `claude_code` agent at Ollama** — local or cloud — needs no
config at all, just environment variables set before you run `spf` (Claude
Code's CLI reads them itself):

```bash
# local Ollama
export ANTHROPIC_BASE_URL=http://localhost:11434
export ANTHROPIC_AUTH_TOKEN=ollama   # any non-empty value; Ollama doesn't check it locally

spf build "..." --config .spf/spf.config.yaml   # any chain naming a claude_code agent
```

For Ollama's cloud offering, point `ANTHROPIC_BASE_URL` at that instead and
set `ANTHROPIC_AUTH_TOKEN` to a real Ollama Cloud API key. This is exactly
the same environment-variable pass-through every agent already gets — no
SPF-specific plumbing, no `provider:` config section to write.

## Retune tools

Known tool names: `read`, `bash`, `edit`, `write`, `grep`, `glob` (`find` is
accepted as an alias for `glob`). These are canonical across BOTH backends —
Flue maps them to its own lowercase tool functions, Claude Code maps them to
its own capitalized names (`Read`, `Bash`, ...); a roster entry never has to
say which. `ls` is a recognized name with **no built-in on either backend**
— bash/glob cover it, so listing it is harmless but it never mounts as its
own tool.

```yaml
defaults:
  tools: [read, bash, edit, write, grep, glob]

agents:
  - name: reviewer
    tools: [read, grep, glob, bash, write]   # explicit list wins over defaults
```

**Resolution:** the agent's own list wins → else it inherits `defaults.tools`
→ else unset, meaning every built-in tool. An empty list is not "all tools";
it's a tool-less agent, and it will stall. `agents.validate()` rejects an
unknown tool name at startup, before anything spawns.

Narrow by role, not by reflex:

- Any agent producing a `context_handoff/` artifact needs **`write`** — the
  session runtime under `data_dir` is always writable regardless of
  `writes:` (below), but the agent still needs the `write` tool itself to
  use that grant.
- Withhold `edit`/`write` only where the restriction *is* the guarantee — a
  reviewer's contract is "change nothing," so dropping `edit` makes that
  structural rather than merely prompted. (`writes: []`, below, is what
  actually enforces it either way.)
- Recon agents get the full read surface (`read`, `grep`, `glob`) — cheaper
  and more legible in the trace than the equivalent `bash` calls.

`harness_engineering` has **no analogue on any current backend** and must
stay empty — `agents.validate()` fails loudly if any entry is non-empty.
(Flue's equivalent surface — extra tools, subagents — is added via
`useTool()`/`useSandbox()` inside `src/core/agent_flue.ts` itself; Claude
Code's is an MCP server or plugin passed to `agent_cc.ts`. Either way it's
an engine change, not a config one; see `authoring_chains.md`.)

## Add a new agent

Three steps, all required — skipping any one fails `agents.validate()` at
startup, before anything spawns:

1. **Prompts.** Create `<name>/system.md` (Purpose + Instructions — static
   identity only) and `<name>/user.md` (one h3 per incoming datum —
   `{{prompt}}`, `{{previous_envelope}}`, `{{context_handoff_dir}}` — then
   the task, then a `## Report` section showing the exact output JSON).
   Copy an existing pair as the shape. If you're overriding in `.spf/`, put
   them under `.spf/prompt_engineering/<name>/`.
2. **Config entry.** Name, purpose, prompt refs, plus anything that differs
   from `defaults`.
3. **An output type.** Pick an existing envelope type or add one — see
   `authoring_chains.md`. The user prompt's `## Report` section must show
   exactly that JSON shape.

Then use it as a step's `owner` (`steps.build()`, `steps.plan()`, ...) or write
a new step naming it — see `authoring_chains.md`. A chain's `requiredAgents` is
derived from its step list, not hand-maintained.

## Write permissions — `writes` and `protected_files`

`tools` cannot express a safety boundary: `bash` runs anything (including
`git checkout`, which discards uncommitted work) and `write` reaches any
path, not only the one report file an agent was granted it for.
`core/permissions.ts` enforces the real boundary, after the fact, by
fingerprinting the working tree's change-set before an agent runs and
comparing it after. A path that was modified beforehand and is clean
afterward has been **reverted** — a reversion counts as a modification.
That's what catches the `git checkout` case.

```yaml
defaults:
  protected_files: [.spf/, spf.config.yaml]   # the machinery that grades an agent's work

agents:
  - name: builder      # no `writes` key -> unrestricted, minus protected_files
  - name: scout
    writes: []          # no repo writes; findings still land in context_handoff/
  - name: planner
    writes: [specs/]
  - name: documenter
    writes: [app_docs/, docs/, "**/*.md", "*.md"]
```

A breach is **not** a gate violation — a gate is for work an agent can be
asked to redo, but a write already happened. Instead: everything the agent
introduced outside its allowlist is rolled back (tracked files via `git
checkout --`, untracked files by deletion), anything that was *already*
dirty before the agent ran is left untouched (the operator's own
uncommitted work is not this module's to discard), and the phase fails
naming every path and what happened to it.

**The session runtime under `data_dir` is always writable, for every
agent**, regardless of `writes:`. `writes: []` means read-only with respect
to the repo, not unable to write its own report.

Full field-by-field spec: `references/config.md`.
