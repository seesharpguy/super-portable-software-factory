# Brainstorm: Jev in the SPF factory

## Problem
Where can a fast, cheap, typed-decision model (Jev: input → enum/score/choice + confidence, ~100 ms)
add leverage to spf without breaking its core rule: **"deterministic TypeScript owns the graph —
agent proposes, code disposes."**

Seed ideas: (user) dynamic chain decisions — Jev picks the chain / next step on the fly;
(prior research) Jev as model/effort router, Jev as eval scorer, verify vendor claims first.

## Constraints (from the codebase)
- Gates are additive-only and non-removable (`GATE_ALLOWLIST`, steps.ts). Jev may only ever ADD a rejection, never approve past a gate.
- The disposer is the operator's: `spf watch` loads `.spf/chains/` once from the main anchor. Jev must choose only from operator-declared options.
- Every decision must be replayable from the trace (SQLite). A Jev choice is recorded as an event, and replay reads the recorded choice rather than calling Jev again.
- `tiering.ts` is pure so that `spf estimate` and `startRun` agree. A Jev call breaks that purity unless its result is resolved once and passed in.
- Jev is early access and its benchmarks come from the vendor. Every use needs a deterministic fallback and a confidence threshold.

## Criteria (weight)
Impact on cost/quality (×3) · Fit with "code disposes" (×2) · Feasibility on existing seams (×2) · Low blast radius (×1). Scored 1–5.

## Diverge (32)
1. Claim-time chain picker: Jev picks from an allowlisted `watch.chains` menu per issue
2. Optional-step toggles: Jev enables or skips optional steps (plan, document) inside a template chain
3. Mid-run next-step decider over a declared transition graph (user's full idea)
4. Chain menu built from `spf list` describe/phases metadata as the choice labels
5. Unbounded composition: Jev assembles a chain from the step vocabulary per task
6. Loop-exit decider in fixLoop/reviseLoop: continue, escalate tier, or stop and mark blocked
7. Retry-budget allocator: set per-step `retries` at run start
8. Fan-out `n` decider: how many best-of attempts this issue deserves
9. Replace `classifyRisk` (chain name + word count) with a Jev risk classification
10. Per-phase reasoning-effort adjustment mid-task (the @miu21590 pattern)
11. Stuck detection: escalate tier after a repeated gate-failure signature
12. Per-role tier choice instead of one run-global shift
13. Second-opinion scorer on the reviewer's verdict (a `verdictConsistent` companion)
14. "Diff addresses the issue" probability, as an additive extraGate
15. Scope-creep gate: diff touches files unrelated to the request
16. Review-fix finding triage: sort external CLI findings into real / noise / style before the fix agent sees them
17. Risky-diff flag (auth, migrations, protected-adjacent files) → require human review on the PR
18. Issue readiness router: build lane / refine lane / needs-human
19. Duplicate or already-fixed issue detection before claim
20. Claim-order priority scoring
21. `spf:feedback` comment classifier: revise / question / approve / out-of-scope
22. Blocked-run triage: flaky infra (auto-retry) vs real failure (comment)
23. Failure-mode labeling of finished runs in SQLite, for dashboards
24. Live anomaly flag on the event stream (looping agent, runaway tokens) → kill switch
25. `spf estimate` predicted success probability alongside cost
26. Context-compaction trigger for long agent sessions
27. Offline eval: train or tune Jev on spf's own trace history (chain → accepted?)
28. Shadow mode: Jev predicts, the deterministic rule still acts, and agreement is logged
29. Config-level confidence-threshold and fallback policy shared by every Jev decision
30. Refine lane: "is this leaf individually workable?" score on the decomposition tree
31. Notification urgency scoring for Slack/Teams pushes
32. PR labels and conventional-commit type classification

## Cluster
- **A. Chain selection** (user's idea): 1, 2, 3, 4, 5, 7, 8
- **B. Model / effort routing**: 9, 10, 11, 12
- **C. Gates & evaluation**: 13, 14, 15, 16, 17
- **D. Watch intake & feedback**: 18, 19, 20, 21, 22, 30
- **E. Run control & ops**: 6, 23, 24, 25, 26, 31, 32
- **F. Safety rails / learning loop**: 27, 28, 29

## Converge (weighted, max 40)
| # | Idea | Impact×3 | Fit×2 | Feas×2 | Risk×1 | Total |
|---|---|---|---|---|---|---|
| 28+29 | Shadow mode + shared confidence/fallback policy | 3 | 5 | 5 | 5 | **34** |
| 9 | Jev risk classifier → existing tiering | 4 | 5 | 5 | 4 | **35** |
| 1 | Claim-time chain picker from allowlist | 5 | 4 | 4 | 4 | **35** |
| 6 | Loop-exit / escalation decider (hard max kept) | 4 | 4 | 4 | 4 | **32** |
| 16 | Review-fix finding triage | 4 | 4 | 4 | 4 | **32** |
| 21 | Feedback comment classifier | 3 | 5 | 4 | 5 | 32 |
| 18 | Issue readiness router | 4 | 4 | 3 | 4 | 30 |
| 3 | Mid-run next step over a declared graph | 5 | 3 | 2 | 2 | 29 |
| 10 | Mid-task effort changes | 4 | 3 | 2 | 3 | 27 |
| 14 | "Addresses issue" additive gate | 3 | 4 | 3 | 3 | 27 |
| 5 | Unbounded composition | 5 | 1 | 2 | 1 | 23 |

## Selected (in build order)
0. **Rails first (28+29).** One `jev:` config block with threshold, fallback and `mode: shadow|act`. Every decision is logged as a trace event with choice, confidence and fallback-used. This is also how the vendor claims get checked on spf's own work.
1. **Risk → tiering (9).** Swap `classifyRisk`'s heuristic for a Jev enum `low|standard|high`, resolved once in `startRun` and passed into the pure `resolveTiering`. The smallest change with measurable cost impact.
2. **Chain router (1), the bounded version of the user's idea.** `watch.chains: [build-test, plan-build-test, review-fix, ...]`. Jev picks one enum using each chain's `describe`. Below the threshold it uses the default chain. The chosen chain is logged. Code still runs the chain unchanged.
3. **Loop control (6).** Inside fixLoop/reviseLoop, after each failed round: `continue | escalate_tier | stop_blocked`. The configured max stays a hard ceiling, so Jev can only end a loop early or escalate.
4. **Finding triage (16).** For the review-fix chain, drop noise findings before they reach the fix agent. Findings are still logged, so nothing is suppressed silently.

## Runners-up
- 21 feedback classifier and 18 readiness router: good, cheap watch-lane wins after #2 ships.
- 3, the full mid-run graph: phase 2 of the chain idea. Operators declare `next:` edges in chain YAML, and Jev picks among declared edges only. Code enforces: commit only after its gates, a step budget, and no path skips a non-removable gate. Replay reads the recorded edges.
- 5, unbounded composition: rejected. It moves the graph into the model, which is exactly what spf exists to prevent.

## Next steps
1. Get Jev early access and define its typed schemas (risk enum, chain enum + confidence).
2. Add the `jev:` config plus trace event, shadow mode only. Run it on the watch lane for about 2 weeks.
3. Compare Jev's choices against the heuristic and the actual outcomes (accepted, blocked, cost) from SQLite.
4. Flip #1 to act mode if agreement and outcomes justify it, then #2.
