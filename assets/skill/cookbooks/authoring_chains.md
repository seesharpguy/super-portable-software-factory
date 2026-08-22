# Authoring Chains

Composing a new chain, extending an existing one, and adding the engine
primitives a chain needs (an output type, a gate, a step) is one skill with
four doors. Engine primitives (a new gate, a new envelope type, a modified
phase primitive) live in `src/` inside the SPF package itself — those do
require forking the package, because they change what every repo's chains
can mean. But COMPOSING a chain out of the existing step factories does not:
that's what a repo-local chain (below) is for. Read that section first if
you just want your own chain in your own repo — reach for the rest of this
document only once you've decided you need a new primitive.

## Repo-local chains (`.spf/chains/*.yaml`)

The zero-fork door: a `.spf/chains/*.yaml` file in a target repo names
existing step factories from `spf`'s own `src/chains/steps.ts` and passes
them params — never imports or runs code from the target repo. `spf init`
scaffolds `.spf/chains/example.yaml`, fully commented out, showing the shape.

```yaml
# .spf/chains/ship-it.yaml — spf ship-it "<prompt>" / spf run ship-it "<prompt>"
name: ship-it
describe: plan, build, test, land — with our own reviewer in the loop
steps:
  - step: request               # every chain opens with this
  - step: plan
    owner: architect             # any agent named in spf.config.yaml
  - step: build
    retries: 2
    extraGates: [jsonParses]     # additive — see below
  - step: fixLoop
    suite: test
  - step: commit
    onlyIfAccepted: true
```

**Shape.** One file, one chain — the filename is a handle a problem can point
at. `steps` is a flat list; each entry names a `step:` and its params sit as
FLAT SIBLINGS of `step:` — never nested under a `params:` key. Param names are
exactly the step factory's `opts` keys, camelCase (`extraGates`, `fixExtraGates`,
`onlyIfAccepted`, ...). An unknown param, an unknown step, or a param of the
wrong type is a load-time problem naming the step index and what's allowed —
never a silently-ignored typo and never a runtime surprise.

**Step vocabulary** (`repo_chains.STEP_NAMES`) — the same factories the table
in Step 2 below documents: `request`, `plan`, `build`, `scout`, `promptOnly`,
`qualityCheck`, `fixLoop`, `reviseLoop`, `commit`, `changes`, `document`,
`refine`, `publishIssues`.

**Gates are additive only, and per-step.** A step's built-in gates
(`diffMatchesClaims` on `build`, `verdictConsistent` on `reviseLoop`'s review
phase, ...) are non-removable — there is no `gates:` param that replaces
them, and there must never be one (see `GATE_ALLOWLIST`'s comment in
`steps.ts` for why: the first thing anyone deletes under deadline pressure is
the gate that keeps failing). `extraGates` can only ADD from an explicit
allowlist SCOPED to what that param's envelope actually supports:
`artifactsExist`/`filesNonEmpty`/`jsonParses` anywhere (they only read
`envelope.artifacts`, present on every envelope); `diffMatchesClaims` only on
a param whose phase produces a `BuildOutput` (`build.extraGates`,
`fixLoop.fixExtraGates`, `reviseLoop.reviseExtraGates`); `verdictConsistent`
only on `reviseLoop.extraGates` (the review phase, a `ReviewOutput`). Naming
a gate outside its param's list is a load problem, not a chain that loads
clean and then fails (or vacuously passes) its gate on every run.

**Names are guarded.** A chain name must be lowercase letters/digits/`._-`
(it's typed on the command line). It cannot collide with an `spf` subcommand
(`run`, `list`, `init`, `watch`, ...) — `spf watch` would always run the
daemon, never a same-named chain. Two repo-chain files can't claim the same
`name` either: the trace's `chain_name` column has to keep meaning one thing.

**The `spf watch` divergence.** `spf watch` registers `.spf/chains/` from the
MAIN repo anchor ONCE, at daemon start — not per-issue, not per-worktree. A
chain file edited on an issue branch (inside the worktree `spf watch` checks
that branch out into) is NOT what runs for that issue; the daemon keeps using
whatever `.spf/chains/` looked like when it started. This is deliberate: the
disposer stays the OPERATOR's, never the branch's, which is exactly what
keeps an agent from rewriting its own quality gate mid-run by editing a chain
file as part of the change it's making.

Everything below this section is about the OTHER three doors: designing a
brand-new built-in chain, adding a step to the vocabulary above, or adding an
engine primitive (gate/envelope type/phase primitive) — none of which a
target repo needs, or can do, on its own.

## Step 1 — design the chain before writing code

Lay out the phases as a table: name, kind, owner, output type (if `agent`),
gates. This is the same table `spf list` will end up describing (derived from
the step list itself — see Step 2 — so it can't drift from what actually runs).

| Phase | Kind | Owner | Output type | Gates |
|---|---|---|---|---|
| request | engineer | engineer | — | — |
| scout | agent | scout | `ScoutOutput` | — |
| plan | agent | planner | `PlanOutput` | `artifactsExist` |
| build | agent | builder | `BuildOutput` | `diffMatchesClaims` |
| test | code | quality | — | (suite pass/fail is the phase's own result) |
| commit | code | git | — | — |

If you need to change engine behavior for a specific target repo without forking
the package, that's `spf eject`. It copies the installed engine's compiled
artifacts (`dist/core/` and `dist/chains/`) out to `.spf/engine/` for reference
or reading — but understand that these files are **not wired into any spf
command**: editing them changes nothing about how spf itself runs. Engine-level
changes (a new gate, a new envelope type, a modified phase primitive) have no
config surface by design, because the codebase is a single shared engine all
repos trust to sequence their work the same way. If you are genuinely changing
the engine semantics, you are forking the package itself, not ejecting a copy.

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

## Step 2 — compose the chain from steps

Almost every chain is a flat array of **steps** — named primitives from
`src/chains/steps.ts`, each one a `run.phase(...)` call (or a small bounded
group of them, for the two loops). There is no module to write and nothing to
register anywhere else: a `CHAINS` entry built with `stepChain()` *is* the
registration, in `src/chains/index.ts`.

```ts
stepChain("plan-build-test", "the standard chain — plan, build, test, commit", [
  steps.request(),
  steps.plan(),
  steps.build(),
  steps.fixLoop({ suite: "test" }),
  steps.commit({ onlyIfAccepted: true }),
]),
```

`stepChain()` derives `phases` (the `spf list` display string),
`requiredAgents`, and `requiredSuites` from the step list itself — nothing to
keep in sync by hand. The available steps:

| Step | What it replaces | Notes |
|---|---|---|
| `request({description?, logBaseline?})` | the opening `engineer(request)` phase | every chain starts with this |
| `plan()` | a `planner` phase producing `PlanOutput` | — |
| `build({fromPlan?, retries?})` | a `builder` phase producing `BuildOutput` | `fromPlan` only changes the phase's description |
| `scout()` | a `scout` phase producing `ScoutOutput` | read-only |
| `promptOnly()` | the `prompt` chain's one step | owner comes from `--agent`, default `builder` |
| `qualityCheck({suite})` | one deterministic quality/test phase | never fails its own phase — see below |
| `fixLoop({suite, max?, owner?})` | a bounded check→fix loop | owns its own iteration and phase naming (`test_1`, `fix_1`, ...) |
| `reviseLoop({max?})` | a bounded review→revise loop | same idea, for `reviewer`/`builder` |
| `changes({base?})` | a `git diff`-against-a-base code phase | feeds `document()` |
| `document()` | a `documenter` phase | requires a preceding `changes()` |
| `commit({onlyIfAccepted?})` | a `git commit` code phase | commits whatever the last agent step produced |

**Why the loops are steps, not a `for` you write in the chain.** `fixLoop`
and `reviseLoop` own their bounded iteration internally, so a chain's step
list is always flat — no loop or conditional syntax at the composition
layer. This is also what keeps a future declarative (YAML) chain tractable:
it only ever needs to name steps and pass them tuning params.

Steps read and write a shared `ChainState` (`prompt`, `options`, `previous` —
the last agent envelope, `accepted`/`reason` for `run.finish()`, etc.) so a
step never has to be told what the step before it produced; it just reads
`state.previous`.

**Before you ship it:** run it against a scratch repo (`spf <name> "..." --cwd
/tmp/scratch-repo`), then `spf phases <adw_id>` and `spf events <adw_id>` to
confirm every phase you designed actually appears with the status you
expect, and open one `envelope.json` under
`.spf/data/sessions/<adw_id>/<agent>/` to confirm it matches the type you
declared.

### When a chain doesn't fit the step vocabulary

`simple-sdlc` (`src/chains/simple_sdlc.ts`) is the one exception: three
commits, a pinned baseline, and a conditional retest don't collapse into a
flat list. A chain like that is still a module exporting `REQUIRED_AGENTS`,
`REQUIRED_SUITES`, and `main(ctx: ChainContext): Promise<number>`, registered
in `CHAINS` with a `run:` field instead of `steps:`. Reuse
`steps.startRun`/`commitEnvelope`/`logChangeset` and `quality.record` rather
than re-copying them — read `simple_sdlc.ts` before reaching for this escape
hatch; it is meant for the rare chain whose control flow genuinely doesn't
reduce to a list, not a shortcut around learning the step vocabulary.

## Step 3 — add a phase to an existing chain

Most of the time this means adding, removing, or reordering an entry in a
`stepChain(...)` array in `src/chains/index.ts` — nothing else needs to
change unless the new step's output feeds a later one (it will, automatically,
if it writes to `state.previous`/`state.changeset`/etc., since every step
reads from the same shared state).

If no existing step does what you need, write one in `src/chains/steps.ts`:
a function returning a `Step` (a `(run, state) => Promise<void>`), doing one
`run.phase(...)` call (or a small bounded group, if it's loop-shaped like
`fixLoop`/`reviseLoop`). Declare what it needs via the optional
`requiredAgents`/`requiredSuites`/`label` properties so
`deriveRequiredAgents`/`deriveRequiredSuites`/`derivePhases` pick it up
automatically — `makeStep(fn, meta)` attaches these for you.

## Step 4 — the bounded fix loop, if you need a different shape than `fixLoop()` provides

`steps.fixLoop({suite, max, owner})` already covers the common case — a
known check, and if it fails, the builder repairs it, bounded so a chain
can't spin forever, never leaving an unverified fix on the last iteration.
Reach for it first. If you need a genuinely different shape (a different
envelope type feeding the fix, say), its body in `src/chains/steps.ts` is the
reference implementation to start from:

```ts
for (let i = 1; i <= max; i++) {
  const result = await run.phase(
    makePhaseParams({ name: `test_${i}`, kind: "code", owner: "quality", description: "Run the suite" }),
    async (ph) => { const r = quality.runTests(run); quality.record(ph, r); return r; },
  );
  if (result.passed) break;
  if (i === max) break; // never leave an unverified fix on the table
  state.previous = await run.phase(
    makePhaseParams({ name: `fix_${i}`, kind: "agent", owner: "builder", retries: 1, description: "Repair what the suite reported" }),
    (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt: state.prompt, previous: quality.asEnvelope(result, "tests"), gates: [gates.diffMatchesClaims] })),
  );
}
```

A failing suite does **not** fail its own phase — the runner did its job,
the *code under test* is what failed. It's `run.finish()`'s job, at the end,
to decide whether the whole run is accepted — which is why a step sets
`state.accepted`/`state.reason` rather than throwing.

## Adding an engine primitive

These live in `src/core/`, not in a chain or a step. Chains and steps stay
thin: sequencing only, no business logic.

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

Then the two other legs of the synced triad: the calling step's
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
