# Handoff Reference

The envelope schema, the two-channel output contract, and the session directory layout — how context transfers in code, not in conversation.

## Two output channels, exactly

An agent may produce output in two ways and no others:

1. **Reference files** written into `context_handoff/` — plans, notes, artifacts for the agents that follow.
2. **A final valid-JSON response** — the envelope, its direct response and nothing else.

Code does the rest: parse the response against the output type the call declared, persist it as `envelope.json`, and inject it into the next agent's user prompt.

## Envelope schema

Every output type is built with `envelopeType()` over the base shape:

```ts
const EnvelopeBaseShape = {
  status: z.enum(["success", "fail"]),   // the only required field
  summary: z.string().default(""),        // one sentence: what happened
  artifacts: z.array(z.string()).default([]),   // paths written, usually inside context_handoff/
  notes_for_next_agent: z.string().default(""), // what the next agent must know
};
```

`status` is load-bearing: an envelope that parses but reports `status: "fail"` throws, failing the phase. An agent declaring its own failure is not a successful phase.

The starter types in `adw_modules/data_types.ts`:

```ts
export const GenericOutput = envelopeType("GenericOutput", {});   // fallback for an agent with no sharper contract yet

export const PlanOutput = envelopeType("PlanOutput", {
  commit_message: z.string().default(""),        // imperative git subject for the PLAN FILE itself
});

export const BuildOutput = envelopeType("BuildOutput", {
  changed_files: z.array(z.string()).default([]),
  commit_message: z.string().default(""),        // consumed by the git commit phase
});

export const ScoutOutput = envelopeType("ScoutOutput", {
  findings: z.array(ScoutFindingSchema).default([]),   // ScoutFinding: {file, note}
});

export const ReviewOutput = envelopeType("ReviewOutput", {
  approved: z.boolean().default(false),          // the verdict; status is only "did the review run"
  findings: z.array(ReviewFindingSchema).default([]),  // ReviewFinding: {requirement, met, evidence}
  blocking: z.array(z.string()).default([]),     // what must change before approval
});

export const DocumentOutput = envelopeType("DocumentOutput", {
  document_path: z.string().default(""),         // the write-up's home in the repo
  documented_files: z.array(z.string()).default([]),
  commit_message: z.string().default(""),
});
```

`commit_message` defaults to empty, so a git phase consuming it always needs a fallback — see `cookbooks/create_adw.md`.

**Each `commit_message` describes its own agent's work product, never the next one's**: `PlanOutput`'s covers the spec file, `BuildOutput`'s the code, `DocumentOutput`'s the write-up. A chain that commits once can use whichever fits; a chain that commits per step (`adw_simple_sdlc.ts`) needs all three, and reusing one agent's sentence for another's diff is how a commit log starts lying.

There is no test output type: running the suite is a `kind: "code"` phase, and its `QualityResult` reaches the next agent through `quality.asEnvelope`.

Two of these are adapters rather than agent reports — code shaped as an envelope so an agent can be handed a deterministic result through the same door: `VerifyOutput` (a lint/test block's result) and `ChangesOutput` (a captured `git diff`, from `changes.asEnvelope`). The consuming agent cannot tell the difference, which is the point.

The envelope is a **manifest of claims**. Gates verify those claims after the fact — declared artifacts exist and are non-empty, declared changes appear in the diff, declared tests actually pass. See `cookbooks/update_modules.md`.

## The typed-output rule

**Every agent call passes a concrete output type**, and the agent's final JSON is parsed against exactly that type. No untyped handoffs.

```ts
const plan = await run.phase(makePhaseParams({ name: "plan", kind: "agent", owner: "planner", description: "..." }),
  (ph) => ph.call(makeAgentCall({ output_type: PlanOutput, prompt, gates: [gates.artifactsExist] })));
```

The user prompt asks for the shape; the type enforces it. They always travel as a pair, which is what lets one agent serve many calls — same system prompt, different user prompt + output type per call site. Output types live in code, never in `sf.config.yaml`.

**Parse failure is not a restart.** If the response doesn't parse or doesn't validate, the harness re-prompts the **same session** with a correction naming the required fields — bounded by `JSON_FIX_ATTEMPTS` in `agents.ts` (2). Gate violations use the identical mechanism, bounded instead by the phase's `retries`. A cold restart would throw away the context that produced the near-miss.

In v1 there is no separate continue call to make: `agent_pi.run()` passes `--session-id`, which pi treats as create-or-continue, so running an agent and continuing it are the same call with the same id. Before parsing, the harness also tolerates a fenced `json` code block or prose wrapped around the object — but the prompt still asks for bare JSON, and every failed attempt is persisted as an invalid envelope row.

## Injecting the previous envelope

`prompts.ts` renders the agent's `user.md`, substituting:

| Placeholder | Value |
|---|---|
| `{{prompt}}` | the engineer's ask (or the ADW's per-call prompt) |
| `{{previous_envelope}}` | the upstream envelope JSON, from `AgentCall.previous` |
| `{{context_handoff_dir}}` | absolute path to this session's `context_handoff/` |

A `user.md` declares one h3 per incoming datum, then the task, then the output contract:

````markdown
# Scout Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Find what `prompt` asks about. Write findings into `context_handoff_dir`, then emit your `Report` JSON.

## Report

Respond with ONLY valid JSON matching `ScoutOutput` — no prose before or after:

```json
{
  "status": "success",
  "summary": "<one sentence on what you found>",
  "findings": [
    { "file": "src/server.ts", "note": "<why this file matters>" }
  ],
  "artifacts": ["<context_handoff_dir>/scout_findings.md"]
}
```
````

The `## Report` section shows the exact JSON shape of the declared output type — that is the agent's output contract, and it lives in `user.md` because the shape belongs to the *use*, not the identity. The matching `system.md` stays static: Purpose + Instructions only.

## Session directory layout

```
adws/adw_data/sessions/{adw_id}/
├── agent_map.json          agent name → coding-agent session_id + model
├── context_handoff/        the ONE place agents write files for the agents that follow
└── {agent_name}/
    ├── prompts/            exact prompts sent (system.md + user.md), saved before execution
    ├── pi_sessions/        pi's own session state for this agent
    ├── raw_output.jsonl    full JSONL stream from the coding agent, appended live
    └── envelope.json       the final valid-JSON response — captured, validated, persisted by code
```

`session.ensure(cfg, adwId)` mints or joins the id and creates these dirs. One `context_handoff/` per session, shared by every agent — the single location for cross-agent files.

## agent_map.json and resuming

```json
{
  "planner": {"session_id": "sf-a1b2c3d4-planner-9f2e",
              "model": "google/gemini-3.6-flash", "coding_agent": "pi"},
  "builder": {"session_id": "sf-a1b2c3d4-builder-71ac",
              "model": "google/gemini-3.6-flash", "coding_agent": "pi"}
}
```

This map is the key that lets a later ADW rejoin each agent's **existing context window**. Run `adw_build.ts --adw-id a1b2c3d4` after `adw_plan.ts` and the builder resumes its own session rather than starting cold.

The map records the model each session was created with. If config drift changes an agent's model, that agent starts a **fresh** session and the map is updated — never a bad resume. `agent_sessions` in `sf.db` is the queryable mirror of this file.

**Files are the raw record; the db is the queryable mirror.** Losing `sf.db` loses nothing that can't be rebuilt from `raw_output.jsonl`, `envelope.json`, and `agent_map.json`.
