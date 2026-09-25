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

**Running an external CLI in a chain** (a third-party reviewer, a linter):
a step can't run an arbitrary command inline. Declare the command under
`quality.checks`, group it into a suite, and name that suite from
`fixLoop` — it runs the suite, hands failing output verbatim to the fix
agent, and re-runs, bounded. A check passes or fails on its exit code only,
so wrap a tool that exits 0 on findings. Put every command in ONE suite
rather than chaining two `fixLoop`s: each step overwrites `state.accepted`.
`spf init` scaffolds `.spf/chains/review-fix.yaml` (commented out) with the
full worked example; `ocr_reviewer.md` covers the alternative of having the
reviewer agent consult the tool as evidence instead.

**Jev finding triage** (`jev.decisions.finding_triage`, off by default; see
`docs/jev.md`) applies to `reviseLoop`'s structured review findings only. With
it on in `act` mode, each unmet finding is classified `real | noise | style`
before the revise agent sees it: `noise`/`style` findings move to a
"Deprioritized by jev" section (or are withheld with `drop: noise` or
`drop: noise_and_style`, and still recorded in the trace); if every unmet
finding is demoted, the full ask is kept and only labeled. The reviewer's
verdict is never changed and still decides `state.accepted`. `fixLoop` hands
the suite's output over verbatim and is never triaged, so choose the
reviewer-agent + `reviseLoop` shape when you want triage.

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

### Declared transitions (`next:`)

A repo chain normally runs its steps top to bottom. It can instead declare
**edges**, which lets a step hand off to one of several steps. At a step
with more than one edge, Jev (`docs/jev.md`, kind `chain_edge`) picks among
the declared edges only. With Jev off, or on any fallback, the `default`
edge is taken.

```yaml
# .spf/chains/triage-ship.yaml
name: triage-ship
describe: build and test, with an optional extra review before landing
max_steps: 12                  # optional step budget; default = 2 × the step count, at most 50
steps:
  - id: request
    step: request
  - id: build
    step: build
    max_visits: 2              # bounds the build <-> test retry cycle
  - id: test
    step: fixLoop
    suite: test
    next: [land, review, build]  # the declared edges
    default: land              # taken with Jev off, or on any fallback
  - id: review
    step: reviseLoop
    next: [land]
  - id: land
    step: commit
    onlyIfAccepted: true
```

- **Keys.** `id`, `next`, `default` and `max_visits` sit beside `step:`,
  like params, but they never reach the step factory. The file can also set
  `max_steps` at top level.
- **`id`.** Lowercase letters, digits, `_` and `-`. It is required on any
  step that declares `next:`, because it names that step's decision
  (`<id>#<visit>`) in the trace.
- **Edges.** A step without `next:` hands off to the step after it, or
  ends the chain if it is the last one. `next: []` ends the chain at that
  step. With several edges and no `default:`, the step after it must be one
  of the edges, and it becomes the default.
- **Old chains are unaffected.** A chain with no `next:` anywhere runs
  exactly as before. `default`, `max_visits` and `max_steps` are load
  problems in a chain like that.
- **Every edge target must be a declared `id`, and every step must be
  reachable** from the first step.
- **Cycles need a bound.** Every cycle must pass through a step with
  `max_visits` (at most 10). `max_steps` caps total step executions for the
  whole run. An edge into a step that has used up its `max_visits` is not
  offered. If no edge is left, or the budget runs out, the run stops and
  is **not accepted**. The default path (what runs with Jev off) must
  finish within `max_steps`, or the file does not load.
- **Edges add checks, never skip them.** If the default path runs a
  gating step (`qualityCheck`, `fixLoop`, `reviseLoop`) before a `commit`,
  every path to that commit must run it too. An `onlyIfAccepted` commit
  must have at least one gating step on every path to it. The example
  above passes both rules: `review` is an extra check on the way to
  `land`, and no edge skips `test`.
- **`accepted` is aggregated.** On a graph chain, `accepted` means every
  gating step's latest run passed. A review that Jev routes to after a red
  suite cannot turn the run green. Re-running the suite through a declared
  cycle can.
- **`spf list` shows the edges.** It prints branch points as
  `test:code(test) … =>(land|review|build)`. Agents and suites are derived
  from every step, including steps only a branch reaches, so
  `spf doctor`/`validate()` check all of them up front.
- **The trace keeps the path.** Each transition is a `chain_edge` event,
  and the whole path is one `chain_path` event, so a run can be replayed
  deterministically.

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
