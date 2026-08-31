---
version: 1
slug: "app-src"
primary_target: "app/src"
related_targets: ["app/src/components/SessionsList.vue","app/src/components/SessionTrace.vue","app/src/components/PhaseDetail.vue"]
---

# Trace UI (spf ui)

## Scope & mode
Operate. Two sub-surfaces sharing one world: the sessions list (paper timetable) and the session trace (departure board). Read-only except one deliberate write: archiving a session ("I reviewed this run").

## Audience, job, action
Engineers watching a live run and engineers catching up after it. Job: attribute every phase to an actor, spot the failure fast, sign off. Action: open a run, read its trace, archive when reviewed.

## Proof & content
Everything on screen is recorded fact from spf.db — phases, events, envelopes, gates, usage costs. No marketing content; empty states teach ("run an ADW to see it here").

## Constraints
- Poll-driven live data (500ms tick; cursor-paginated event stream) — rows update under the reader.
- Vue 3 SPA served by the Hono/node:sqlite backend while the WAL db is still being written.
- Self-hosted latin-subset woff2 fonts; nothing renders below 16px.
- Six default agents, arbitrary per-repo rosters — lane content is config-driven, never hardcoded.

## Chosen direction
The Timetable (user-pinned, 2026-08-26, replacing the retired aurora/glow/purple-cyan gradient world as anti-reference): paper sessions list + dark departure-board trace; Overpass + Overpass Mono; hairlines instead of shadows; color is signal (green/red verdicts, amber board-live, red paper wayfinding, ballpoint live annotation); the board animates on state change, the paper stays still.

## Memorable moment
A phase status on the live board ticking from running to success in the split-flap grammar — the board speaking.

## Unresolved decisions
- Exact palette values (paper, ink, bone, board black, timetable red, hairline grays, ballpoint blue).
- Split-flap realism: true character flip vs. simpler roll/fade on state change.
- Column scheme for the paper list rows (what replaces the card grid's timeline thumbnail).
- Label-column collapse behavior on narrow viewports.
- Archive affordance on paper rows (the incumbent's hover-reveal × belongs to the old world).
