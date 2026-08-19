# SF Overview

The system map the orchestrator reads on startup — what SF is, how a stamped repo is laid out, and which cookbook to load next.

## What SF is

Software Factory builds repeatable **agents plus code** workflows. Deterministic TypeScript (an ADW script, run by Bun) owns sequencing, retries, and acceptance; agents are bounded nodes inside that graph. Agent proposes, code disposes.

Your job as orchestrator: **run the system, observe the system, help the engineer interact with it.** You do not do the work an ADW exists to do.

## Layout of a stamped repo

```
adws/
├── adw_sf_config/
│   └── sf.config.yaml           the agent roster — one agent, one prompt, one purpose
├── package.json                  zod + yaml — `bun install` here once after /sf install
├── adw_prompt.ts                 smallest ADW: one agent, one prompt, traced end-to-end
├── adw_plan.ts, adw_scout.ts, adw_build.ts, adw_plan_build.ts, adw_build_test.ts, adw_plan_build_test.ts
├── adw_build_review.ts           build → review: is this what was asked for? (not testing)
├── adw_document.ts               write up the work just done, from git diff vs main
├── adw_simple_sdlc.ts            plan → build → test → review → document; commits each product
├── adw_modules/                  ALL low-level logic — ADW scripts stay thin
│   ├── data_types.ts             AgentCall, PhaseParams, Phase, Envelope + one output type per agent call (zod schemas)
│   ├── agents.ts                 loadConfig, validate, resolve entry → interface + model + thinking
│   ├── runner.ts                 the Run object: run.phase(params, fn) → ph.call(AgentCall)
│   ├── agent_pi.ts                Pi interface (v1)   ·   agent_cc.ts  Claude Code (v2, stubbed)
│   ├── gates.ts                  gate(envelope, run) -> GateReport — one check per item verified
│   ├── changes.ts                git diff vs a resolved base → ChangeSet → envelope for the documenter
│   ├── prompts.ts, session.ts, tracer.ts, console.ts, git_helper.ts, utils.ts
└── adw_data/
    ├── prompt_engineering/{agent}/{system.md,user.md}   tracked — edit prompts HERE, never in the skill
    │                                planner · builder · scout · reviewer · documenter
    ├── sessions/{adw_id}/                               gitignored runtime
    │   ├── agent_map.json       agent → coding-agent session_id + model
    │   ├── context_handoff/     the one place agents write files for the agents that follow
    │   └── {agent}/{prompts/, raw_output.jsonl, envelope.json}
    └── sf.db                    gitignored SQLite trace db the visualizer polls
```

**v1 runs Pi only.** `coding_agent: pi`, default model `gemini-3.6-flash`, thinking `medium`. `claude_code` is specced in the config and stubbed in the interface — it lands in v2.

## The phase model

Every ADW run is a sequence of **phases**, each one `await run.phase(makePhaseParams({...}), async (ph) => {...})`. Three kinds, three swim lanes:

- **engineer** — the human lane; today the system-input phase (who asked, and for what).
- **agent** — `ph.call(makeAgentCall({...}))`: prompt in → typed envelope out → gates verified.
- **code** — deterministic steps that stand alone (git branch, git commit, migrate). Never buried inside an agent phase.

**Success must be earned — every phase defaults to `fail`.** A clean exit flips it to success; agent phases additionally require the envelope to parse and all gates to come back green. A throw keeps it failed, records an error event, and aborts the run. `retries: N` on an agent phase buys extra gate-correction rounds through the same session before that throw happens.

## Envelopes

Agents have exactly two output channels: reference files written into `context_handoff/`, and a **final valid-JSON response** parsed against the output type the call declared. Code persists it as `envelope.json` and injects it into the next agent's `user.md` via `{{previous_envelope}}`. Bad JSON is never a restart — the harness re-prompts the *same session, context intact*, until it parses (bounded). See `references/handoff.md`.

**The output contract is a synced triad**: the envelope type in `data_types.ts` ↔ the `## Report` JSON example in the agent's `user.md` ↔ `output_type:` at the call site. Editing any one of the three means editing all three in the same change — drift between them taxes every call with correction retries.

## Running an ADW

```bash
bun run adws/adw_plan.ts "add a /health endpoint"
bun run adws/adw_plan_build.ts requests/health.md --adw-id a1b2c3d4
```

The prompt is inline text or a file path. `--adw-id` is optional on every ADW: given one, the run joins that session (same dirs, same `context_handoff/`, agents resume their existing context windows); omitted, a fresh id is minted and printed.

## When you have finished reading this

You are done with startup. List the ADWs (`ls adws/adw_*.ts`, plus each `Phases:` docstring line) as a table, and **wait for the engineer's request.**

Do not survey anything else — not the trace db, not the config, not past runs, not the repo tree. You do not yet know what the request is, so anything you gather now is a guess about what will matter, spent from the context the real work needs. Every cookbook and reference below is lazy-loaded, one per request, and that is the whole design.

## Where to go next

Load one cookbook per request — this overview is the only one you read up front.

| Request | Cookbook |
|---|---|
| Turn a request into the prompt an ADW gets | `how_to_prompt_for_the_eng.md` — **read before every launch** |
| Set the system up in a repo | `install.md` |
| Write a new ADW script | `create_adw.md` |
| Change an existing ADW chain | `update_adw.md` |
| Generate `sf.config.yaml` | `create_config.md` |
| Add or retune an agent | `update_config.md` |
| Add low-level logic or a gate | `update_modules.md` |
| Run and monitor a workflow | `how_to_prompt_for_the_eng.md`, then `run_adw.md` |

References, loaded when you need the spec: `references/config.md` (full config schema), `references/handoff.md` (envelope + session layout), `references/observability.md` (events, db tables, polling).
