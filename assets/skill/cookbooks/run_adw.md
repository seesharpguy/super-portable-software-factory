# Run a Chain

Run a workflow and report on it. **You run and observe — you never step
into the process or do the work yourself.**

## Step 0 — translate the request

**Read [how_to_prompt_for_the_eng.md](how_to_prompt_for_the_eng.md) before
you launch anything.** The prompt you pass is read by every agent in the
chain, so it gets written deliberately. This cookbook starts once you have
that prompt.

## Launch

`spf list` shows every chain this install knows, its phases, and what it
requires — the names are shape, not a fixed menu; read the actual output.

```bash
spf <chain> "<prompt>"                          # e.g. spf plan-build-test "add a /health endpoint"
spf <chain> requests/health.md                  # prompt can be a file path instead of inline text
spf <chain> "implement the plan" --adw-id a1b2c3d4   # join an existing session
spf <chain> "..." --config path/to/other.config.yaml # a non-default roster
spf <chain> "..." --cwd /path/to/other-repo          # run against a different repo
```

Launch in the background so you can poll while it works. `spf` prints the
`adw_id` on startup — capture it, everything else keys off it.

### Naming a roster

The chain says *what runs*; the config says *who runs it*. If the engineer
references a roster, a config file, or a model tier, pass `--config` — never
fall through to the default silently. Two things bite:

- **Never swap rosters on your own.** A different roster is a different
  cost and a different result. If the default's model looks wrong, say so
  and let the engineer choose.
- **Switching rosters mid-session breaks resumption.** `agent_map.json`
  records the model each agent's session was created with; a joined run
  whose config now names a different model starts that agent **fresh**
  instead of resuming — deliberate (a bad resume is worse), but it means
  "plan on one roster, build on another" costs the builder its accumulated
  context. Say so when you report it.

`--adw-id` is optional on every chain. Given one, the run joins that session
if it exists, or creates it pinned to exactly that id — same session
directory, same `context_handoff/`, envelopes appended, each agent resumes
its own Flue conversation via `agent_map.json`. That's how you chain runs:
plan under one id, then build under the same id.

## Observe

```bash
spf sessions [--limit N]              # recent runs
spf phases <adw_id>                   # phase-by-phase status for one run
spf events <adw_id> [--follow]        # the trace, live-tailable
spf abort <adw_id>                    # signal a stuck run's process to stop
```

`spf events --follow` polls the same rowid cursor the visualizer does — safe
to leave running. `spf phases` marks each phase ✓/✗/… — remember **every
phase defaults to fail**, so `✗` may mean it never completed, and `…` means
still running, not stuck.

For a visual view of the same data: `spf ui` — opens a browser, renders
sessions as cards and runs as swim lanes, phases and tool calls drill in.

## When a run is stuck

A hung agent produces no events at all, so the trace goes quiet rather than
red.

```bash
spf phases <adw_id>       # which phase is still "running"
spf abort <adw_id>        # stop it
```

`spf abort` sends `SIGTERM` to the OS process running the chain (there's no
separate per-agent handle to target from a different CLI invocation — Flue
runs in-process, so stopping the run means stopping that process). A killed
run finalizes its own trace: it lands on `fail` with its process rows
closed, never left claiming `running` forever.

## Report

Tell the engineer, in order: which chain and which roster you launched (name
the config whenever it wasn't the default), which phase is running now or
which failed, phase statuses in sequence, and for a failure the gate
violations or the error verbatim, from `spf phases`/`spf events`. Don't dress
up a partial run as a success.

Full trace schema and what each column means: `references/observability.md`.
