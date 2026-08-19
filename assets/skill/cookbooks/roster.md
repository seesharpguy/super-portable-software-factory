# Roster

Add or retune agents in `sf.config.yaml`. There's nothing to generate — `sf
init` seeds a starter `.sf/sf.config.yaml` with a couple of commented
examples; everything else is inherited from the packaged defaults until you
override it. `sf doctor` always shows what's actually in effect and where it
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

Write the model as `provider/model-id`, never a bare id — SF has no live
model catalog to check against (that was `pi --list-models`; Flue has no
public equivalent), so an unqualified or malformed pattern is only caught by
shape at `agents.validate()` time, and a genuinely wrong id surfaces at the
first real dispatch. Thinking levels: `off | minimal | low | medium | high |
xhigh | max` — inert (no error, no effect) on a model that isn't a reasoning
model.

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

## Retune tools

Known tool names: `read`, `bash`, `edit`, `write`, `grep`, `glob` (`find` is
accepted as an alias for `glob`). `ls` is a recognized name with **no Flue
built-in** — bash/glob cover it, so listing it is harmless but it never
mounts as its own tool.

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

`harness_engineering` has **no Flue analogue** and must stay empty —
`agents.validate()` fails loudly if any entry is non-empty. (Flue's
equivalent surface — extra tools, subagents — is added via `useTool()`/
`useSandbox()` inside `src/core/agent_flue.ts` itself, an engine change, not
a config one; see `authoring_chains.md`.)

## Add a new agent

Three steps, all required — skipping any one fails `agents.validate()` at
startup, before anything spawns:

1. **Prompts.** Create `<name>/system.md` (Purpose + Instructions — static
   identity only) and `<name>/user.md` (one h3 per incoming datum —
   `{{prompt}}`, `{{previous_envelope}}`, `{{context_handoff_dir}}` — then
   the task, then a `## Report` section showing the exact output JSON).
   Copy an existing pair as the shape. If you're overriding in `.sf/`, put
   them under `.sf/prompt_engineering/<name>/`.
2. **Config entry.** Name, purpose, prompt refs, plus anything that differs
   from `defaults`.
3. **An output type.** Pick an existing envelope type or add one — see
   `authoring_chains.md`. The user prompt's `## Report` section must show
   exactly that JSON shape.

Then name the agent in a chain's `REQUIRED_AGENTS` and call it.

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
  protected_files: [.sf/, sf.config.yaml]   # the machinery that grades an agent's work

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
