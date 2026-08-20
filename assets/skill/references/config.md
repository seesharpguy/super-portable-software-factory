# Config Reference

The full `spf.config.yaml` spec: every field, how defaults merge, and how
model / thinking / tools map onto Flue. The schema is Valibot-enforced —
`agents.validate()` refuses a bad config before anything spawns — so this is
semantics and gotchas, not a shape you have to memorize by hand; `spf doctor`
always shows the resolved, merged result for the repo you're in.

## Resolution order

1. The packaged built-in default (`assets/defaults/spf.config.yaml` inside
   the installed CLI).
2. `.spf/spf.config.yaml` in the target repo, if present — merged on top,
   field by field (`defaults`/`observability`/`quality` merge key-by-key;
   `agents` merges by `name`: a matching name patches that entry, a new name
   appends).
3. An explicit `--config <path>` replaces both — standalone, no built-in
   underneath it.

`spf init` seeds step 2 with a commented starter; omitting it entirely means
running off pure built-ins, which is a fully supported, valid state.

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
| `coding_agent` | `"flue"` | Only implemented value — enforced by the schema. |
| `model` | string | `provider/model-id`. Default `google/gemini-3.6-flash`. |
| `thinking` | enum | `off\|minimal\|low\|medium\|high\|xhigh\|max`. Default `medium`. |
| `color` | hex string | Lane color fallback for agents that don't set their own. |
| `harness_engineering` | string[] | **Must stay `[]`** — no Flue analogue; a non-empty entry fails validate(). |
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
at `agents.validate()` time, not with a placeholder green. See `roster.md`
and `authoring_chains.md`.

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

Always write `model` as `provider/model-id`. There is no live catalog to
validate against (Flue has no public model-registry API) — `agents.ts`
checks only the static shape at `agents.validate()` time; a genuinely wrong
provider or id surfaces at the first real dispatch instead. Provider
credentials come from the environment, matching the provider you named
(`GEMINI_API_KEY`/`GOOGLE_API_KEY` for `google/...`, `ANTHROPIC_API_KEY` for
`anthropic/...`, etc.) — `spf doctor` checks the common ones are set.

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
| `ls` | recognized name, **no Flue built-in** — harmless to list, never mounts |

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

Kept as a field for config-shape stability, but it must be empty. Flue's
equivalents (extra tools, subagents, MCP-style extension) are engine-level
changes made inside `src/core/agent_flue.ts`, not config — see
`authoring_chains.md`.
