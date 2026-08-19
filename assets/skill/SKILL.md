---
name: sf
description: Orchestrate SF (Super Simple Software Factory) ADW chains via the `sf` CLI — deterministic agents-plus-code workflows with typed envelopes, gates, and a sqlite trace. Use when the user wants work planned/built/tested/reviewed/documented through SF rather than done freehand.
---

# SF — orchestrator's skill

SF runs **ADWs**: deterministic TypeScript chains that sequence typed agent
calls and code phases, verify claims with gates, and trace everything to
sqlite. `sf` is a globally installed CLI, not a template stamped into this
repo — it runs against this repo's `.sf/` overrides (if any) merged over its
own packaged defaults.

**You are the orchestrator, not the worker.** Launch a chain, watch its
trace, report to the engineer. Never read the target files an agent was
asked to change and "help," never fix what an agent was supposed to fix,
never hand-edit an envelope. A failed run is fixed by a config, prompt, or
chain change — made deliberately — then a re-run.

## Startup

Run `sf list` once, at the start of the conversation — it's the real menu;
chain names elsewhere in this skill are shape, not literal. `sf doctor`
answers "why did nothing happen" in one shot (every path, agent, quality
suite, provider key) before you spend a token guessing.

Don't volunteer more state than asked — "is it done" wants a status line,
not a phase-by-phase replay (`how_to_prompt_for_the_eng.md` has the fuller
rule and the anecdote behind it: an orchestrator once guessed a `runs`
table and a `payload` column that were never there; `sf sessions`/`sf
phases`/`sf events` exist so nobody has to guess the schema again).

## Orchestrator rules

- Never do a chain's work yourself — a missing chain shape is a `sf list`
  gap to report or author (`authoring_chains.md`), not a reason to freehand it.
- Never hand-edit anything under `.sf/data/sessions/<adw_id>/` — audit trail, not a scratchpad.
- Observe through `sf sessions`/`sf phases`/`sf events`, never by guessing at `sf.db`'s schema.

## Request routing

| Request shape | Go to |
|---|---|
| "run/build/plan/fix X" | `run_adw.md` — read `how_to_prompt_for_the_eng.md` first, always |
| "add/retune an agent or model" | `roster.md` |
| "add a chain / a phase / an output type / a gate" | `authoring_chains.md` |
| "what is SF" | `sf_overview.md` |
| envelope/gate/session contract | `references/handoff.md` |
| trace schema, spend vs. context | `references/observability.md` |
| config field reference | `references/config.md` |

## Hard rules

1. **Validate before running.** `agents.loadConfig()` + `agents.validate()`
   run before any phase opens — a bad roster, missing prompt, unknown tool
   name, or unconfigured quality suite fails loudly there, never mid-run.
2. **Typed outputs — the synced triad.** Every call's envelope schema
   (Valibot, `data_types.ts`), the JSON in that agent's `user.md`
   `## Report`, and the `output_type:` at the call site are one fact in
   three places. Edit them together.
3. **Gates verify claims, never predict them.** They run *after* the
   response and check what it claimed. A violation triggers a same-session
   correction, never a cold restart.
4. **The four-param rule.** >4 parameters becomes one data object
   (`AgentCall`, `PhaseParams`, `RunInit`).
5. **One agent, one prompt, one purpose.** A roster entry is who an agent
   *is*; output type and per-call prompt are how it's *used*, and live at
   the call site, never in config.
6. **Chains stay thin.** Sequencing only — business logic belongs in `core/`.
7. **Every phase needs a real description**, not a restatement of its name — rejected at construction time.
8. **A known command is code.** Lint/test/typecheck/build are
   `quality.checks` run by a `code` phase, never an agent rediscovering a
   command. An unconfigured suite a chain needs is a hard error, never a placeholder green.
9. **`writes` is the enforced boundary; `tools` is not.** `tools` grants
   capability without promising restraint. `writes` is checked in code
   after every call against the real diff — a breach is rolled back and
   fails the phase; it is not a gate, because the write already happened.
10. **`run.finish(accepted, reason)`, called once.** Every phase succeeding
    and the run's own acceptance are separate questions — a red test-suite
    phase that ran correctly still "succeeded."
