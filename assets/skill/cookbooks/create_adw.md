# Create ADW

Compose a new ADW script — a thin, deterministic TypeScript workflow (run by Bun) over agents already in the config. Design the chain first, then generate or hand-write it.

## Step 1 — Design the chain

Answer four questions, in order:

1. **What agents, in what order?** Pick from the roster (`adws/adw_sf_config/sf.config.yaml`). The starter six cover most chains:

| Agent | Use when | Output type | Typical gates |
|---|---|---|---|
| `scout` | you need to FIND something first — read-only recon | `ScoutOutput` | `artifactsExist` |
| `planner` | the work needs a plan before code changes | `PlanOutput` | `artifactsExist`, `filesNonEmpty` |
| `builder` | code must change | `BuildOutput` | `diffMatchesClaims` |
| `reviewer` | the change must be confirmed to BE what was asked for | `ReviewOutput` | `artifactsExist`, `verdictConsistent` |
| *(no tester)* | verifying that it RUNS is a `kind: "code"` phase over `quality.ts`, not an agent | `QualityResult` → `asEnvelope` | the exit code is the check |
| `documenter` | finished work needs a write-up (runs after a build, off the diff) | `DocumentOutput` | `artifactsExist`, `filesNonEmpty` |
| any agent, generic ask | one-off prompt, no special shape | `GenericOutput` | as needed |

   A new kind of agent needs a config entry + prompt pair + output type first — see `update_config.md`.

   **The suite and the reviewer answer different questions.** "Does it run" is a test, and code can ask that. "Is this the thing that was asked for" is a review, and only an agent can. A green suite over a feature nobody requested is still a failed request, and neither one covers for the other.

2. **Where does code act?** Git branch/commit, migrations, deploys each get their own `kind: "code"` phase — never buried inside an agent phase.

   **Running the suite is one of these — there is no tester agent.** The command is written down in `quality.ts`, so a `kind: "code"` phase runs it (`quality.runTests(run)` → `quality.asEnvelope(result, "tests")` back into the builder) and the bounded repair loop is unchanged. An agent rediscovering `bun test` on every run buys nothing a subprocess does not already know. Capturing what changed is one of these: `changes.capture(run, makeChangeCapture({base: "main"}))` diffs the working tree against a resolved base, writes `context_handoff/changes.diff`, and `changes.asEnvelope(...)` hands it to the next agent. A diff is two git commands, not a judgement call.

3. **Does anything loop?** Test-fix cycles are bounded fix loops (see `update_adw.md`), not phase retries.

4. **What does each call need to prove?** Pick gates per call from `gates.ts`: `artifactsExist`, `filesNonEmpty`, `jsonParses`, `diffMatchesClaims`, `testsPass("cmd")` — or an inline one-off.

## Step 2 — Ownership rules (the swim lanes depend on these)

- `kind: "agent"` → `owner` MUST be an agent name from the config — it selects the harness (model, thinking, tools, prompts) AND the lane. `ph.call()` runs whoever owns the phase.
- `kind: "engineer"` → `owner: run.engineer`. Every ADW opens with the engineer request phase — it is the system input record.
- `kind: "code"` → `owner` is a short actor label (`"git"`, `"db"`); all code phases share the code lane.
- Phase `name` must be unique within the run (`plan`, `build`, `test_1`, `fix_1`, …) — the UI keys blocks on it.
- **`description` is required and must earn its place.** The name identifies the phase; the description explains it — what this phase does and why, in one sentence. It rides the `phase_start` event and is the only line of intent the trace, the console, and the phase block ever show. `makePhaseParams` throws at construction on a blank description *or* one that merely restates the name (`commit_plan: "Commit the plan"`), so the rule fails before the phase opens rather than leaving an unreadable run in the db. Write `"Put the spec on record before any code exists to blur it"` instead.
- `retries: N` on an **agent** phase = extra gate-correction rounds re-sent into the same session (pi's `--session-id` creates-or-continues, so context stays intact). Code-phase re-execution is not implemented in v1.

## Step 3 — Generate or write it

```bash
bun run .claude/skills/sf/scripts/make_adw.ts --name review_docs --agents scout,builder
```

Writes `adws/adw_review_docs.ts`: one agent phase per name, chained through `previous`, starter agents mapped to their output types, unknown agents to `GenericOutput`. It does NOT create config entries or prompt files — do that first (`update_config.md`), or `agents.validate()` will stop the run and tell you what's missing.

## The canonical skeleton

Every `adw_*.ts`, generated or hand-written, is a Bun script with this shape:

```ts
#!/usr/bin/env bun
/**
 * ADW Plan Build — plan the request, then implement the plan.
 */

import * as agents from "./adw_modules/agents.ts";
import * as gates from "./adw_modules/gates.ts";
import * as gitHelper from "./adw_modules/git_helper.ts";
import * as session from "./adw_modules/session.ts";
import { BuildOutput, PlanOutput, makeAgentCall, makePhaseParams } from "./adw_modules/data_types.ts";
import { parseCli, resolvePrompt, runMain } from "./adw_modules/utils.ts";

const REQUIRED_AGENTS = ["planner", "builder"];        // names, never models

async function main(prompt: string, config = "adws/adw_sf_config/sf.config.yaml", adwId: string | null = null): Promise<number> {
  const cfg = agents.loadConfig(config);              // 1. point to config
  agents.validate(cfg, REQUIRED_AGENTS);               // 2. fail fast — nothing spawns on a half-valid config
  const run = session.ensure(cfg, adwId);              // 3. pin-or-create the session → the Run object

  await run.phase(makePhaseParams({ name: "request", kind: "engineer", owner: run.engineer,
                                    description: "Capture the incoming ask" }), async (ph) => {
    ph.log({ input: prompt });
  });

  const plan = await run.phase(makePhaseParams({ name: "plan", kind: "agent", owner: "planner",
                                    description: "Turn the request into an implementable plan" }),
    (ph) => ph.call(makeAgentCall({ output_type: PlanOutput, prompt, gates: [gates.artifactsExist, gates.filesNonEmpty] })));

  const build = await run.phase(makePhaseParams({ name: "build", kind: "agent", owner: "builder", retries: 1,
                                    description: "Implement the plan exactly" }),
    (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt, previous: plan, gates: [gates.diffMatchesClaims] })));

  await run.phase(makePhaseParams({ name: "commit", kind: "code", owner: "git",
                                    description: "Commit the working tree" }), async (ph) => {
    const message = build.commit_message || `sf(${run.adw_id}): ${build.summary}`;
    ph.log({ sha: gitHelper.commitAll(message), message });
  });

  return run.finish();
}

if (import.meta.main) {
  const { positionals, options } = parseCli(process.argv.slice(2), ["config", "adw-id"]);
  runMain(() => main(resolvePrompt(positionals[0]), options["config"] ?? "adws/adw_sf_config/sf.config.yaml", options["adw-id"] ?? null));
}
```

## Non-negotiables

- **`REQUIRED_AGENTS` + `agents.validate()`** — declare every agent name the script uses and validate before the first phase.
- **Every agent call declares a concrete output type** from `data_types.ts`. No untyped handoffs.
- **`previous:` carries the chain** — the upstream envelope lands in the next agent's `user.md` as `{{previous_envelope}}`; bulky context moves through `context_handoff/` files the envelope references.
- **The engineer request phase comes first**, always.
- **Four-param rule** — `run.phase()` and `ph.call()` each take exactly one object; new helpers with >4 params get a data type.
- **Stay thin** — sequencing and acceptance only; real logic goes in `adw_modules/` (`update_modules.md`).
- **Committing is a code phase, and it needs a fallback.** `PlanOutput`, `BuildOutput`, and `DocumentOutput` each carry a `commit_message` the agent writes **for its own work product** — the spec, the code, the write-up. It defaults to empty, so always `envelope.commit_message || <fallback>`, and commit each product with the message of the agent that made it (`adw_simple_sdlc.ts` commits three times and never crosses them). `gitHelper.commitAll(message)` stages everything, commits, and returns the short sha; it throws a clear error when the cwd isn't a git repo or nothing changed, and that throw fails the phase.

## Before you ship it

1. `bun run adws/adw_<name>.ts "a tiny real request"` — watch it go green end to end.
2. Check the trace: `sqlite3 adws/adw_data/sf.db "select seq,name,kind,owner,status from phases where adw_id='<id>' order by seq;"`
3. Read the final `envelope.json` — is the output type earning its fields, or should it be sharper?
