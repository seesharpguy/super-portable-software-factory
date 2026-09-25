# Brainstorm: how herdr could be used in the factory

**Date:** 2026-09-25
**Method:** diverge → cluster → converge

## Problem

Herdr (a Rust, AGPL agent multiplexer) runs coding agents in real PTY panes. It detects each agent's state (blocked, working, done or idle), keeps sessions alive across disconnects, has a remote mode, and exposes a CLI plus a local socket API that agents can use to control each other. Where, if anywhere, does it belong in spf?

## Constraints (from how spf actually works)

- **Code owns the loop.** "Agent proposes, code disposes." Agents run headless (`claude -p`, flue, opencode) over piped stdio and return typed JSON envelopes. Anything that makes an *agent* the orchestrator cuts against the product's core idea.
- **Zero setup.** `npm i -g @gr8ful/spf` runs against any repo, so herdr has to be optional and detected, never required.
- **Headless paths must keep working unchanged.** `spf watch`, CI and `--once` under cron.
- **License.** spf is MIT and herdr is AGPL. Driving herdr as a separate process over its CLI or socket is fine. Vendoring or linking its code is not.
- **Detection gap.** Herdr detects state by recognizing agent TUIs *inside its own panes*. spf's headless child processes won't be detected natively, so spf would have to push state into herdr itself. Whether herdr allows that is still unverified; see Next steps.

## Criteria (weighted, 1–5 each, max 50)

| Criterion | Weight | Meaning |
|---|---|---|
| Philosophy fit | ×3 | Keeps sequencing, retries and acceptance in TypeScript |
| Operator value | ×3 | Helps someone running many issues and attempts at once |
| Ease | ×2 | Inverse of effort |
| Low risk / coupling | ×2 | Optional, degrades cleanly, no AGPL or format lock-in |

## Diverge (32 ideas, unfiltered)

1. `spf watch` opens one herdr pane per claimed issue, tailing `spf events <adw> --follow`
2. One pane per `watch.fanout` attempt; the winner is highlighted when `pickBest` settles
3. spf pushes phase/label state into the herdr sidebar (`working` → working, `blocked` → blocked, `done` → done)
4. Pane titles carry issue #, priority label and current phase
5. A "control room" layout preset: `spf ui` in one pane, event tails in the rest
6. A herdr plugin that reads `.spf/data/spf.db` directly
7. Run `claude_code` agents *inside* herdr PTYs instead of piped child processes
8. Run interactive (non `-p`) Claude Code in a pane, drive it over the socket, and harvest the envelope from `context_handoff/`
9. Run the `spf watch` daemon itself in a herdr session so it survives SSH drops
10. Run the factory on a remote box with herdr remote mode and attach from a laptop
11. `coding_agent: herdr`, a generic backend for any TUI agent spf doesn't support natively
12. Stuck-phase takeover: once correction rounds or a timeout run out, spf opens a pane in that worktree for a human, then re-runs the gates
13. Route `simple-sdlc`'s attended signoff prompt to a pane that shows as *blocked*
14. The `<prefix>:blocked` label turns the pane blocked, for at-a-glance triage
15. An `engineer`-kind phase that *is* a herdr pane handed to the human, which completes when they mark it done
16. For a `<prefix>:feedback` revision, open a pane in the PR's branch worktree so the human can poke at it before labeling
17. Use herdr's idle/blocked detection as a hang detector for the known "agent hangs silently" failure
18. Detect an agent stuck on a permission prompt and fail the phase fast
19. An idle-too-long policy that automatically runs `spf abort`
20. Herdr state vs. trace activity disagreeing → an anomaly event in the trace
21. The planner spawns builder helpers through herdr's socket (herdr's native pattern)
22. The reviewer spawns a scout pane to investigate a finding
23. **spf's TypeScript is the "lead agent"**: code, not a model, calls the herdr socket to spawn, watch and close panes
24. Fanout attempts spawned as herdr panes by code
25. spf chains exposed as launchable herdr workflows
26. An `spf` plugin in herdr's marketplace as an acquisition channel to herdr's 9K-star audience
27. An `spf init` interview question: "Use herdr as your control room?"
28. `spf doctor` detects herdr and checks its version and socket reachability
29. A packaged template: `ts-cc-herdr`
30. Cookbook: "running `spf watch` inside herdr" (no code)
31. Import human-driven herdr sessions into the spf trace for comparison
32. Record a successful ad-hoc herdr session → scaffold a repo-local spf chain from it

## Cluster (6 themes)

| Theme | Ideas | Idea in one line |
|---|---|---|
| **A. Factory board** (herdr as the display) | 1, 2, 3, 4, 5, 6, 24 | Herdr's sidebar becomes a live view of what the factory is doing |
| **B. Agent runtime** (herdr hosts the agents) | 7, 8, 11 | Agents run in herdr PTYs instead of spf's piped processes |
| **C. Engineer-lane escalation** | 12, 13, 14, 15, 16 | When code needs a human, a herdr pane is where the human goes |
| **D. Health signals** | 17, 18, 19, 20 | Herdr's state detection as a second opinion on agent liveness |
| **E. Orchestration control** | 21, 22, 23, 25 | Who drives the socket: an agent, or code? |
| **F. Ops & distribution** | 9, 10, 26, 27, 28, 29, 30, 31, 32 | Persistence, remote boxes, discovery, onboarding |

## Converge (scored)

| # | Idea | Fit ×3 | Value ×3 | Ease ×2 | Risk ×2 | **Total** |
|---|---|---|---|---|---|---|
| 3 | Phase/label state → herdr sidebar | 5 | 5 | 3 | 4 | **44** |
| 9+10+30 | Daemon in a persistent/remote herdr session (cookbook) | 5 | 3 | 5 | 5 | **44** |
| 1 | Pane per claimed issue tailing events | 5 | 4 | 4 | 4 | **43** |
| 13 | Signoff prompt as a blocked pane | 5 | 4 | 3 | 4 | **41** |
| 28 | `spf doctor` detects herdr | 5 | 2 | 5 | 5 | **41** |
| 12 | Stuck-phase takeover pane | 5 | 5 | 2 | 3 | **40** |
| 24 | Fanout attempts as panes | 5 | 4 | 3 | 3 | **39** |
| 23 | Code-as-lead via socket | 5 | 4 | 2 | 3 | **37** |
| 26 | Herdr marketplace plugin | 4 | 4 | 3 | 3 | **36** |
| 17 | Hang detector | 4 | 4 | 2 | 2 | **32** |
| 32 | Record session → chain | 3 | 5 | 1 | 2 | **30** |
| 31 | Import herdr sessions to trace | 3 | 3 | 2 | 3 | **28** |
| 7 | Agents inside herdr PTYs | 3 | 3 | 2 | 2 | **26** |
| 21 | Agents spawn agents via socket | 1 | 3 | 3 | 2 | **22** |
| 11 | `coding_agent: herdr` backend | 2 | 3 | 1 | 2 | **21** |

### The one-line synthesis

> **Herdr is the display, spf is the decision-maker.** Herdr's own model is "agents coordinate agents," and spf's model is "code coordinates agents." So spf should use herdr for what it does best: displaying state, keeping sessions alive, and giving humans a place to step in. The TypeScript chain stays the only thing that drives the socket.

### Selected (top 3, staged)

**1. Ship now: the zero-code cookbook** (9, 10, 30 → 44)
Document running `spf watch` inside a persistent herdr session, optionally on a remote box, with `spf ui` and `spf events --follow` in sibling panes. It costs nothing, changes no code, and tests whether herdr users want spf at all before any integration code gets written.

**2. Build: the factory board** (3, 1, 24, 23, 28 → 37–44)
An optional `herdr` integration that `spf doctor` detects. When it's present and the run is attended, or `watch.herdr: true` is set, code opens one pane per claimed issue or fanout attempt. Each pane runs `spf events <adw> --follow` and is titled with issue #, priority and phase. spf pushes state as phases and labels transition: working / blocked / done. The agents still run exactly as today (headless, envelope-typed, trace-first). Herdr only *shows* them. This fixes the problem that nothing shows the whole fleet at once when `concurrency × fanout.n` runs are in flight.

**3. Build next: engineer-lane escalation** (13, 12, 14 → 40–41)
When the chain needs a human (a signoff prompt, gates still failing after the correction budget runs out, or a `blocked` transition), spf flips that issue's pane to *blocked*. It then opens a takeover pane in the worktree with the failing envelope and gate report printed at the top. When the human exits, spf re-runs the gates, so code still does the accepting. This is what the existing `engineer` swim lane was built for, and herdr's "who's blocked?" sidebar is exactly the right display for it.

### Runners-up (revisit later)

- **Marketplace plugin (26):** worth doing once #2 exists, since it puts spf in front of herdr's audience.
- **Hang detector (17):** only works if agents run in herdr panes, which depends on the rejected cluster B. Getting the same signal from trace inactivity is cheaper and doesn't need herdr.
- **Record → chain (32):** high value but a research project: turning ad-hoc human+agent work into a repeatable chain. That's the factory's whole reason to exist, so keep it on the list.

### Deliberately rejected

- **Agents spawning agents through the socket (21, 22).** Herdr's signature feature, and exactly what spf exists to prevent. Sequencing would move back into a prompt, where it can't be traced, retried or gated.
- **Herdr as the agent runtime (7, 8, 11).** Scraping a PTY in place of a typed stdout JSON stream loses the determinism the envelope contract is built on. It also collides with the `--` / `--model` headless-launcher handling in `agent_cc.ts`.

## Outcome (2026-09-25)

- **API verified** against herdr 0.7.5 (socket protocol 17) with a live server. An external process can `pane.split` (returns the pane id), `pane.rename`, `pane.send_text`, `pane.report_agent` (`idle | working | blocked | unknown`; no `done`), `pane.report_metadata` (title, state labels), `pane.release_agent`, and `notification.show`. herdr then lists the pane as agent `spf` with the reported status. Wire format: one newline-terminated JSON `{id, method, params}` per Unix-socket connection, which is the same shape herdr's own built-in integrations use.
- **#1 shipped:** `assets/skill/cookbooks/herdr.md`, section (a).
- **#2 shipped as a notify channel** (`kind: herdr`, `src/core/notify/herdr_channel.ts`), not a new subsystem. `deps.notify` already fires at every watch lifecycle step, so `watch.ts` is untouched. The doctor check (step 4) shipped with it. One design change from the plan: the trace tail starts on the run's own `run_started`, not on the claim. At claim time a fresh repo has no trace db yet, and a revision's previous session is already finished, which `--follow` would print and exit on.
- **#3 still held**, as planned.

## Next steps (as originally planned)

1. **Verify herdr's API surface. This decides whether #2 is feasible.** Can an external process (a) create a pane running an arbitrary command, (b) set a pane's title, and (c) set or override its displayed state (working/blocked/done) for a process herdr didn't detect itself? If (c) is impossible, #2 falls back to titles only, and much of its value goes with it.
2. Write the cookbook (#1) under `assets/skill/cookbooks/`, then gauge interest.
3. Spike #2 behind a feature flag: a `core/herdr.ts` adapter that shells out to the herdr CLI, is a no-op when herdr isn't found, and is exercised by a unit test with a fake CLI (like `fake_tty.ts`).
4. Add a `herdr` line to `spf doctor` (present / version / socket reachable) in the same PR as the spike.
5. Hold #3 until #2 has been used on a real `watch` run with `concurrency ≥ 2`.
