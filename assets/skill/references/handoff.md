# Handoff Reference

The envelope schema, the two-channel output contract, and the session
directory layout — how context transfers in code, not in conversation.

## Two output channels, exactly

An agent may produce output in two ways and no others:

1. **Reference files** written into `context_handoff/` — plans, notes,
   artifacts for the agents that follow.
2. **A final valid-JSON response** — the envelope, its direct response and
   nothing else, validated by Flue's injected `sf_report` tool against the
   call's declared Valibot schema before the tool's handler ever fires.

Code does the rest: capture the validated data, persist it as
`envelope.json`, inject it into the next agent's user prompt.

## Envelope schema

Every output type is built with `envelopeType()` over the base shape
(`src/core/data_types.ts`):

```ts
const EnvelopeBaseEntries = {
  status: v.picklist(["success", "fail"]),        // the only required field
  summary: v.optional(v.string(), ""),              // one sentence: what happened
  artifacts: v.optional(v.array(v.string()), () => []),   // paths written, usually in context_handoff/
  notes_for_next_agent: v.optional(v.string(), ""), // what the next agent must know
};
```

`status` is load-bearing: an envelope that parses but reports `status:
"fail"` throws, failing the phase. An agent declaring its own failure is not
a successful phase.

The built-in types:

- `GenericOutput` — fallback for an agent with no sharper contract yet.
- `PlanOutput` — `commit_message` (the plan file's own commit subject).
- `BuildOutput` — `changed_files`, `commit_message`.
- `ScoutOutput` — `findings: [{file, note}]`.
- `ReviewOutput` — `approved`, `findings: [{requirement, met, evidence}]`, `blocking: string[]`.
- `DocumentOutput` — `document_path`, `documented_files`, `commit_message`.

**Each `commit_message` describes its own agent's work product, never the
next one's.** A chain that commits once uses whichever fits; one that
commits per step needs all three, and reusing one agent's sentence for
another's diff is how a commit log starts lying.

Two types are code-shaped-as-envelope adapters, not agent reports: `VerifyOutput`
(a quality-suite result, from `quality.asEnvelope`) and `ChangesOutput` (a
captured `git diff`, from `changes.asEnvelope`). The consuming agent can't
tell the difference, which is the point.

The envelope is a **manifest of claims**. Gates verify those claims after
the fact — declared artifacts exist and are non-empty, declared changed
files appear in the diff, a review's verdict agrees with its own findings.
See `authoring_chains.md` for adding a gate or an output type.

## The typed-output rule — the synced triad

**Every agent call passes a concrete output type**, and the model's final
JSON is validated against exactly that type by the injected `sf_report`
tool.

```ts
const plan = await run.phase(
  makePhaseParams({ name: "plan", kind: "agent", owner: "planner", description: "..." }),
  (ph) => ph.call(makeAgentCall({ output_type: PlanOutput, prompt, gates: [gates.artifactsExist] })),
);
```

Three things are one fact: the envelope schema in `data_types.ts`, the exact
JSON shown in that agent's `user.md` `## Report` section, and the
`output_type:` named at the call site. Edit them together, or the agent's
next response silently stops matching what code expects.

**Parse failure is not a restart.** If the model never calls `sf_report`
(or calls it with data that fails validation), the harness falls back to
extracting JSON from the response text, and if that still fails, re-prompts
the **same session** with a correction — bounded by `JSON_FIX_ATTEMPTS` in
`agents.ts`. Gate violations use the identical mechanism, bounded instead by
the phase's `retries`. A cold restart would throw away the context that
produced the near-miss.

## Injecting the previous envelope

`prompts.render()` substitutes into a `user.md`:

| Placeholder | Value |
|---|---|
| `{{prompt}}` | the engineer's ask (or the chain's per-call prompt) |
| `{{previous_envelope}}` | the upstream envelope JSON, from `AgentCall.previous` |
| `{{context_handoff_dir}}` | absolute path to this session's `context_handoff/` |

A `user.md` declares one h3 per incoming datum, then the task, then the
output contract:

````markdown
## Task

Find what `prompt` asks about. Write findings into `context_handoff_dir`,
then emit your `Report` JSON.

## Report

Respond with ONLY valid JSON matching `ScoutOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence on what you found>",
  "findings": [{ "file": "src/server.ts", "note": "<why this file matters>" }],
  "artifacts": ["<context_handoff_dir>/scout_findings.md"]
}
```
````

The `## Report` section shows the exact JSON shape of the declared output
type — the agent's output contract lives in `user.md` because the shape
belongs to the *use*, not the identity. The matching `system.md` stays
static: Purpose + Instructions only.

## Session directory layout

```
.spf/data/sessions/{adw_id}/
├── agent_map.json          agent name -> Flue conversation id + model
├── context_handoff/        the ONE place agents write files for the agents that follow
└── {agent_name}/
    ├── prompts/            exact prompts sent (system.md + user.md), saved before execution
    └── envelope.json       the final valid-JSON response — captured, validated, persisted by code
```

`session.ensure(cfg, adwId, cwd)` mints or joins the id and creates these
dirs. One `context_handoff/` per session, shared by every agent.

## agent_map.json and resuming

```json
{
  "planner": {"session_id": "a1b2c3d4-planner", "model": "google/gemini-3.6-flash", "coding_agent": "flue"},
  "builder": {"session_id": "a1b2c3d4-builder", "model": "google/gemini-3.6-flash", "coding_agent": "flue"}
}
```

This map is what lets a later run rejoin each agent's **existing Flue
conversation**. Run a `build` chain with `--adw-id a1b2c3d4` after a `plan`
chain used the same id, and the builder resumes its own conversation rather
than starting cold.

The map records the model each session was created with. If config drift
changes an agent's model, that agent starts a **fresh** conversation and the
map is updated — never a bad resume. `agent_sessions` in `spf.db` is the
queryable mirror of this file. Flue's own durable conversation state lives
separately, in `.spf/data/flue.db` — a sibling with a different lifetime
(resumed, not archived) from `spf.db`.

**Files are the raw record; the db is the queryable mirror.** Losing
`spf.db` loses nothing that can't be rebuilt from `envelope.json` and
`agent_map.json` (plus Flue's own `flue.db` for conversation replay).
