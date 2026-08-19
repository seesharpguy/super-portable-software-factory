# Update ADW

Modify an existing ADW chain — add phases, add gates, add a bounded fix loop.

## Add a phase

Insert an `await run.phase(...)` block where it belongs in the sequence. Pick the right `kind`: `agent` for a `ph.call(...)`, `code` for a deterministic step, `engineer` for a human touchpoint. If the new phase names an agent not already in `REQUIRED_AGENTS`, add it there too — otherwise validation passes and the run dies mid-flight instead of at startup.

```ts
const found = await run.phase(makePhaseParams({ name: "scout", kind: "agent", owner: "scout",
                                  description: "Locate the code the request touches" }),
  (ph) => ph.call(makeAgentCall({ output_type: ScoutOutput, prompt })));
```

Phase `name` must be unique within the run — that is what the UI keys blocks on. In a loop, suffix it (`` `test_${i}` ``).

`description` is **required**, and `makePhaseParams` rejects both a blank one and one that merely restates the name. It is the single line of intent the trace, the console, and the UI phase block show, so write what the phase does and why — `"Land the code only now: green suite, approved review"`, not `"Commit build"`.

A code phase does its work in the block body and logs what it did. The commit phase that closes `adw_plan_build.ts` and `adw_plan_build_test.ts` is the pattern:

```ts
await run.phase(makePhaseParams({ name: "commit", kind: "code", owner: "git",
                                  description: "Land the builder's changes, using the message it wrote" }), async (ph) => {
  const message = build.commit_message || `sf(${run.adw_id}): ${build.summary}`;
  ph.log({ sha: gitHelper.commitAll(message), message });
});
```

`commit_message` is a field on `PlanOutput`, `BuildOutput`, and `DocumentOutput` that the agent fills in **for its own work product**, so always pair it with a fallback — it defaults to empty. `commitAll` throws if the cwd is not a git repo or nothing changed, which fails the phase rather than committing nothing. A chain that commits more than once (`adw_simple_sdlc.ts`) commits each product with its own author's message.

## Remove a phase

Delete the block, drop any now-unused agent from `REQUIRED_AGENTS`, and re-thread the chain: whatever the removed phase produced was probably somebody's `previous:`. Point that call at the surviving upstream envelope.

## Add gates

Gates are functions over the finished envelope — `gate(envelope, run) -> GateReport`, recording one `check(item, ok, note)` per thing they looked at, with violations derived from the failed ones. Compose them per call:

```ts
const build = await run.phase(makePhaseParams({ name: "build", kind: "agent", owner: "builder" , description: "..." }),
  (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt, previous: plan,
                                  gates: [gates.artifactsExist, gates.diffMatchesClaims] })));
```

On violations the harness does **not** restart the agent — it sends the violation list back into the **same session** as a correction (pi's `--session-id` creates-or-continues, so the context window is intact), bounded by that phase's `retries`. Every gate result is traced to the `gate_results` table. Exhausting the retries throws `GateFailure` and fails the phase.

Gate claims, not guesses: declared artifacts exist and are non-empty, declared JSON parses, declared changes appear in the diff, declared test commands pass. Never hardcode counts — express quantity as a property of the declared list ("at least one artifact", "ALL declared paths valid"). Plan quality and code taste are not gateable; that is a reviewer agent or a human. New reusable gates go in `adw_modules/gates.ts` (`update_modules.md`).

## Add a bounded fix loop

The pattern from `adw_build_test.ts` — always bounded by a module-level constant. The runner is a **code** phase, because the command is known; only repairing it needs an agent:

```ts
const MAX_FIX_LOOPS = 3;

let test: QualityResult | null = null;
for (let i = 1; i <= MAX_FIX_LOOPS; i++) {
  test = await run.phase(makePhaseParams({ name: `test_${i}`, kind: "code", owner: "quality",
                                    description: "Run the suite — a known command, so code runs it" }), async (ph) => {
    const result = quality.runTests(run);          // QualityResult, not an envelope
    ph.log({ passed: result.passed, artifacts: result.artifacts.join(", ") });
    return result;
  });

  if (test.passed) break;

  previous = await run.phase(makePhaseParams({ name: `fix_${i}`, kind: "agent", owner: "builder", retries: 1,
                                    description: "Repair what the suite reported, from its verbatim output" }),
    (ph) => ph.call(makeAgentCall({ output_type: BuildOutput, prompt,
                                    previous: quality.asEnvelope(test!, "tests"),
                                    gates: [gates.diffMatchesClaims] })));
}

return run.finish(test !== null && test.passed, `the suite still failed after ${MAX_FIX_LOOPS} fix attempt(s)`);
```

`run.finish()` ends every ADW, and it takes the acceptance criterion the phase
statuses cannot express. A test phase that ran a red suite **succeeded** — the
runner did its job — so phases alone would report a green run that never passed
its tests, in the db and the UI as well as the terminal. Pass `accepted` and
the exit code, the session status, and the banner are decided together.

`quality.asEnvelope` is the adapter: a deterministic result shaped as an envelope, so the builder cannot tell it came from code. Wire the real command in `quality.ts` first — the stamped blocks are `echo` placeholders that announce themselves.

Three distinctions worth keeping straight:

- **Gate retries vs. JSON retries.** `retries` buys extra *gate*-correction rounds. Malformed final JSON is handled separately and always — `JSON_FIX_ATTEMPTS` in `adw_modules/agents.ts` (2 by default) re-prompts the same session for a valid object even on a phase with `retries: 0`. Raising the phase's `retries` does not buy more JSON attempts, and vice versa.
- **Phase retries vs. fix loops.** `retries: N` on `PhaseParams` re-attempts one agent phase's gate corrections, re-sent into the same session with its context intact. (Code-phase re-execution is not implemented in v1.) A fix loop is a *chain* of phases repeated — different agents, new envelopes each pass.
- **The test phase succeeds when it runs and reports correctly.** A failing suite does not fail that phase; it fails the run, checked at the end. The runner did its job; the code didn't.

## Keep scripts thin

An ADW is sequencing and acceptance — nothing else. The moment you are writing parsing, subprocess handling, retry mechanics, or a reusable predicate inside `adw_*.ts`, it belongs in `adw_modules/`. See `update_modules.md`.
