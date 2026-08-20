# Authoring Chains

Creating a new chain, extending an existing one, and adding the engine
primitives a chain needs (an output type, a gate) are one skill with three
doors. All three live in `src/` inside the SPF package itself — there is no
per-repo copy to edit. If you need to change engine behavior for a specific
target repo without forking the package, that's `spf eject` (prints the path
to the installed package's `src/` for you to copy and load from your own
`.spf/` — engine-level changes are the one thing `.spf/` config can't express).

## Step 1 — design the chain before writing code

Lay out the phases as a table: name, kind, owner, output type (if `agent`),
gates. This is the same table `spf list` will end up describing.

| Phase | Kind | Owner | Output type | Gates |
|---|---|---|---|---|
| request | engineer | engineer | — | — |
| scout | agent | scout | `ScoutOutput` | — |
| plan | agent | planner | `PlanOutput` | `artifactsExist` |
| build | agent | builder | `BuildOutput` | `diffMatchesClaims` |
| test | code | quality | — | (suite pass/fail is the phase's own result) |
| commit | code | git | — | — |

**Ownership rules**, non-negotiable:

- **`engineer`** phases capture input only — no agent, no code decision.
- **`agent`** phases: exactly one `ph.call({output_type, prompt, gates})`.
  Pick the narrowest existing envelope type that fits (`GenericOutput`,
  `PlanOutput`, `BuildOutput`, `ScoutOutput`, `ReviewOutput`,
  `DocumentOutput`, or the two code-adapter types, `VerifyOutput` /
  `ChangesOutput`) before adding a new one.
- **`code`** phases: a known command or a deterministic computation
  (`quality.runSuite`, `changes.capture`, `run.git.commitAll`). If a human
  could write the exact steps down without judgment, it's `code`.

## Step 2 — write the chain module

A chain is a module exporting `REQUIRED_AGENTS`, `REQUIRED_SUITES`, and
`main(ctx: ChainContext): Promise<number>`. No shebang, no `import.meta.main`
block — the CLI's chain registry (`src/chains/index.ts`) calls `main()`
directly, and `dist/cli/bin.js` is the only entry point that ever runs.

```ts
/**
 * ADW <Name> — <one sentence: what this chain is for and when to pick it>.
 *
 * Phases: engineer(request) -> scout -> planner -> builder -> code(test) -> git(commit)
 */
import * as agents from "../core/agents.ts";
import * as gates from "../core/gates.ts";
import * as quality from "../core/quality.ts";
import * as session from "../core/session.ts";
import { BuildOutput, PlanOutput, makeAgentCall, makePhaseParams } from "../core/data_types.ts";
import type { ChainContext } from "./context.ts";

export const REQUIRED_AGENTS = ["planner", "builder"];
export const REQUIRED_SUITES: string[] = ["test"]; // [] if this chain runs no quality suite

export async function main(ctx: ChainContext): Promise<number> {
  const { prompt, config_paths, adw_id, cwd } = ctx;
  const cfg = agents.loadConfig(config_paths);
  agents.validate(cfg, REQUIRED_AGENTS, REQUIRED_SUITES, cwd);
  const run = session.ensure(cfg, adw_id, cwd);

  await run.phase(
    makePhaseParams({ name: "request", kind: "engineer", owner: run.engineer, description: "Capture the incoming ask" }),
    async (ph) => { ph.log({ input: prompt }); },
  );

  const plan = await run.phase(
    makePhaseParams({ name: "plan", kind: "agent", owner: "planner", description: "Turn the request into an implementable plan" }),
    (ph) => ph.call(makeAgentCall({ output_type: PlanOutput, prompt, gates: [gates.artifactsExist] })),
  );

  const build = await run.phase(
    makePhaseParams({ name: "build", kind: "agent", owner: "builder", description: "Implement the plan" }),
    (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt, previous: plan, gates: [gates.diffMatchesClaims] })),
  );

  await run.phase(
    makePhaseParams({ name: "commit", kind: "code", owner: "git", description: "Commit the implementation" }),
    async () => run.git.commitAll(build.commit_message || `spf: ${prompt.slice(0, 72)}`),
  );

  return run.finish();
}
```

Then register it in `src/chains/index.ts`'s `CHAINS` array (name, describe,
phases string, `requiredAgents`/`requiredSuites`, `run`) — that's what makes
it show up in `spf list` and dispatchable as `spf <name>`.

**Before you ship it:** run it against a scratch repo (`spf <name> "..." --cwd
/tmp/scratch-repo`), then `spf phases <adw_id>` and `spf events <adw_id>` to
confirm every phase you designed actually appears with the status you
expect, and open one `envelope.json` under
`.spf/data/sessions/<adw_id>/<agent>/` to confirm it matches the type you
declared.

## Step 3 — add a phase to an existing chain

Insert a `run.phase(...)` block in sequence; nothing else in the chain needs
to change unless the new phase's output feeds a later one (thread it through
as a local variable, the way `plan`/`build` are threaded above).

Removing a phase: delete the block; check nothing downstream reads its
return value, and check `REQUIRED_AGENTS`/`REQUIRED_SUITES` no longer needs
whatever only that phase used.

## Step 4 — add a bounded fix loop

The pattern every quality-gated chain uses — run a check, and if it fails,
loop the builder back in with the failure as `previous`, bounded so a chain
can't spin forever:

```ts
const MAX_FIX_LOOPS = 3;
let test: QualityResult | null = null;
for (let i = 1; i <= MAX_FIX_LOOPS; i++) {
  test = await run.phase(
    makePhaseParams({ name: `test_${i}`, kind: "code", owner: "quality", description: "Run the suite" }),
    async (ph) => { const result = quality.runTests(run); ph.log({ passed: result.passed }); return result; },
  );
  if (test.passed) break;
  await run.phase(
    makePhaseParams({ name: `fix_${i}`, kind: "agent", owner: "builder", retries: 1, description: "Repair what the suite reported" }),
    (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt, previous: quality.asEnvelope(test!, "tests"), gates: [gates.diffMatchesClaims] })),
  );
}
return run.finish(test !== null && test.passed, `the suite still failed after ${MAX_FIX_LOOPS} fix attempt(s)`);
```

A failing suite does **not** fail its own phase — the runner did its job,
the *code under test* is what failed. It's `run.finish()`'s job, at the end,
to decide whether the whole run is accepted.

## Adding an engine primitive

These live in `src/core/`, not in a chain. Chains stay thin: sequencing
only, no business logic.

### Adding an output type

In `src/core/data_types.ts`, build it with `envelopeType()` over the base
envelope shape (`status`, `summary`, `artifacts`, `notes_for_next_agent`):

```ts
export const MyOutput = envelopeType("MyOutput", {
  some_field: v.optional(v.string(), ""),
  some_list: v.optional(v.array(v.string()), () => []),
});
export type MyOutputT = v.InferOutput<typeof MyOutput.schema>;
```

Then the two other legs of the synced triad: the calling chain's
`output_type: MyOutput`, and the agent's `user.md` `## Report` section
showing the exact JSON shape. All three must move together — see
`references/handoff.md`.

### Adding a gate

A gate is `(envelope, run) -> GateReport`, in `src/core/gates.ts`. Build the
report with one `.check(item, ok, note)` call per thing looked at; resolve
any envelope-declared path against `run.repo_root` via `resolveClaim()`
rather than the process's own cwd — an agent's paths are relative to where
*it* ran, not to this process.

```ts
export function myGate(envelope: EnvelopeBase, run: RunContext): GateReport {
  const report = new GateReport();
  // ... report.check(item, ok, note) per thing verified
  return report;
}
```

### Never `console.log()` directly

Every phase's own logger (`ph.log(payload)`) both prints and writes a `log`
event to the trace, so the terminal and the trace agree by construction. A
bare `console.log` inside a phase is a message the trace will never have.

### The four-param rule

Any function needing more than 4 parameters takes one data object instead —
`AgentCall`, `PhaseParams`, `RunInit`, `ChangeCapture` are the pattern in
this codebase; follow it for new primitives too.

### Before you finish

Run the smallest chain that exercises the new code (`spf prompt "ping"` for
an engine-level change, or the specific chain for a chain-level one) and
confirm `spf phases <adw_id>` shows what you expect.
