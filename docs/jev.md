# Jev in spf

**Status:** the rails (config, client, policy, trace event, doctor checks)
plus the decision kinds listed under [Decisions](#decisions); `risk_tier`
(#104) is the first live kind. Each feature ticket under epic #102 adds one
kind and a subsection there.
Core ticket: #103. Background: [`brainstorms/jev-in-the-factory.md`](brainstorms/jev-in-the-factory.md).

## What Jev is

Jev is TypeSafe's "System One" model. You give it unstructured context
(`state`) and a set of typed questions. It returns typed answers with
probabilities and a confidence, in roughly 70–500 ms, for about $0.04 per
million input tokens. Output tokens are free. It does not generate text. It
answers three question shapes:

| Shape | You give it | It returns |
|---|---|---|
| `choice` | a closed set of labeled options (≤255) | one option key, per-option probabilities, confidence |
| `score` | an ordered rubric of 2–10 level descriptions | a continuous score, per-level probabilities, confidence |
| `noul` | a yes/no statement | a probability that it is true (spf does not use this shape yet) |

spf uses `choice` and `score` as a fast, cheap advisor to the deterministic
code. It never replaces that code.

## Invariants

spf's rule is *"deterministic TypeScript owns the graph: agent proposes,
code disposes."* Jev follows the same rule. `src/core/jev.ts` enforces all of
the following in one place, so individual features cannot weaken them:

1. **Off by default.** With no `jev:` block, or with `enabled: false`, there
   is no client, no network call, and no trace event. Every decision is the
   deterministic fallback, so runs behave exactly as they did before this
   feature existed.
2. **Closed sets only.** Code builds the option set: an enum, or an
   operator-declared menu. Jev's answer is used only if it is literally one
   of those options. Jev never names a chain, step, gate, model, or command
   that code did not offer it.
3. **Every decision has a deterministic fallback.** The fallback is used
   when Jev is disabled or the kind is `off`, in shadow mode, and when the
   API key is missing. It is also used on a timeout, an error, a malformed
   answer, an out-of-set answer, an answer outside the caller's `permitted`
   subset, or confidence below the threshold.
4. **Shadow vs act.** See [below](#shadow-vs-act).
5. **Every decision is recorded.** Whenever Jev is enabled for a kind, each
   decision (shadow or act, success or failure) is written as one trace
   event. A replay or `spf estimate` reuses the recorded decision instead of
   calling Jev again.
6. **Gates only get stricter.** Jev may add a rejection or stop a loop early.
   It may never approve past a gate, remove a gate, raise a retry ceiling,
   or spend beyond an operator-configured ceiling. None of those moves may
   appear in any option set, and `permitted` lets a caller narrow the set at
   run time (for example, "escalate only while under budget").
7. **Pure modules stay pure.** Resolve a decision once in an impure place,
   such as `startRun`, a loop body, or a watch hook. Then pass the resulting
   `Decision` into pure code (such as `core/tiering.ts`) as data.

## Configuration

```yaml
jev:
  enabled: false            # default. false = total no-op
  mode: shadow              # shadow | act — the default for every kind
  model: jev-latest         # or a pinned version, e.g. jev-1.13
  threshold: 0.7            # min confidence for an answer to act (0–1)
  timeout_ms: 2000          # per call; a timeout falls back
  api_key_env: TYPESAFE_API_KEY   # names the env var; never the key itself
  base_url: ""              # "" = https://api.typesafe.ai/v1 (POST …/systemone)
  decisions:                # per-kind overrides + feature settings
    risk_tier:              # (example — kinds are added by feature tickets)
      mode: act             # off | shadow | act
      threshold: 0.8
      timeout_ms: 500
      max_risk: standard    # a feature-specific key, validated by that feature
```

- **Merge across config layers.** Top-level keys merge key by key, so an
  override that only sets `enabled: true` keeps the base's threshold and
  model. `decisions` is replaced as a whole object, like `tiering.roles`.
- **`enabled: false` always wins.** It overrides every per-kind `mode`.
- **`spf doctor`.** When Jev is disabled, doctor shows nothing about it.
  When it is enabled, doctor shows:
  - the resolved settings, as info;
  - a **warning** if the API key env var is unset (every decision would fall
    back with `no_api_key`), which does not fail doctor;
  - a **failure** for a `base_url` that is not http(s);
  - a **warning** for a `decisions` key that is not a registered kind
    (usually a typo);
  - a **failure** for a known kind whose feature settings do not validate.

  Doctor never calls Jev, because a live probe would spend tokens on every
  run.

## Shadow vs act

| | Jev called? | Recorded? | What acts |
|---|---|---|---|
| disabled / kind `off` | no | no | fallback |
| `shadow` | yes | yes | **fallback** |
| `act` | yes | yes | Jev's answer if it is in the set, permitted, and confident; otherwise the fallback |

Run a kind in `shadow` first. Its recorded decisions show how often Jev
agreed with the heuristic, and whether act mode would have used its answer.
Compare that with the run's real outcome (accepted, blocked, cost) in the
trace db. Flip a single kind to `act` with `jev.decisions.<kind>.mode: act`
once the numbers support it.

## The trace event

Every recorded decision is one `events` row with `type: "log"` and
`name: "jev_decision"`. It is not a new event type, because that list is
closed and mirrored by the UI. The payload is the whole `Decision`:

| field | meaning |
|---|---|
| `kind`, `key` | which decision (`key` tells repeats in one run apart, e.g. `fix_2`) |
| `question` | `choice` or `score` |
| `options` | the closed set offered, in order |
| `choice` | **the effective choice**: what code acted on |
| `jev_choice` | what Jev answered, if it was in the set; else `null` |
| `confidence`, `score`, `probabilities` | as returned (confidence derived from probabilities if absent) |
| `fallback`, `used_fallback` | the deterministic answer, and whether it acted |
| `reason` | why the fallback acted, or `null` if Jev's answer acted (see below) |
| `detail` | human-readable context (error text, confidence vs threshold) |
| `would_act` | act mode would have used Jev's answer |
| `agrees` | `jev_choice === fallback` |
| `latency_ms`, `model`, `usage` | call cost and speed |
| `mode`, `threshold` | the policy in force |
| `input_sha256` | hash of state + instructions + options (the state itself is not stored). For offline analysis only: replay does not compare it. `""` when nothing was hashed |
| `replayed` | this decision reused an answer recorded in an earlier trace |

`reason` is the **first** check that disqualified Jev's answer, in this
order: `disabled`, `kind_off`, `replay_missing`, `no_api_key`, `timeout`,
`error`, `invalid_response`, `invalid_choice`, `not_permitted`,
`low_confidence`, `shadow`. In shadow mode, `reason: "shadow"` therefore
means "valid and confident: act mode would have used this answer."

The event is never exported to OpenTelemetry, because `log` events are not
in otel's allowlist.

## For feature implementers

```ts
import { findRecordedDecision, parseDecisionExtras } from "../core/jev.ts";
import { MY_KIND } from "../core/jev_kinds.ts";

const decision = await run.jev.decide({
  kind: MY_KIND.kind,          // registered in core/jev_kinds.ts
  key: "",                     // disambiguate repeats in one run
  options: [{ value: "low", description: "…" }, …],   // closed, code-built
  instructions: "…",           // the question
  state: issueBody,            // context; only its sha256 is recorded
  fallback: heuristicAnswer,   // what the code would have done anyway
  permitted: [...],            // optional run-time narrowing (monotone authority)
  phase_id: ph.phase.phase_id, // optional
});
act(decision.choice);          // ALWAYS act on .choice, never .jev_choice
```

- `run.jev` is already wired to the run's trace. For code that runs before a
  run exists (the watch lane), build one with
  `createJev({ config: cfg.jev, recorder: traceDecisionRecorder(tracer, adwId) })`.
- `decideBatch(state, items)` asks several questions over one shared state
  in **one** HTTP call, for example "triage each of these N findings".
- To replay, pass `replay: await findRecordedDecision(run.tracer.db, adwId, kind, key)`.
  The recorded **answer** is reused without calling Jev, then judged again
  under today's policy and `permitted`. With an unchanged policy the
  effective choice is the recorded one. If the caller no longer permits the
  recorded choice, it is `not_permitted`. If the kind is now in shadow mode,
  the fallback acts. A recorded failure (timeout, error, and so on) replays
  as that same failure. `null` means replay mode with nothing recorded, so
  the fallback acts and Jev is not called. A recording made for a different
  question (kind, key, question, options, or fallback changed) is
  `replay_missing`. `enabled: false` or a kind set to `off` beats any
  replay: the result is `disabled`/`kind_off` and nothing is recorded.
- Tests use `src/test/fake_jev.ts`'s `FakeJevClient`, passed as
  `createJev({ client })` or process-wide with `setJevClientFactory(() => fake)`.
  Always reset it with `setJevClientFactory(null)`.
- `decide()` throws only on programmer errors, such as an empty option set
  or a fallback that is not one of the options. It throws these even when
  Jev is disabled, so the call site's own unit test catches them.

### Rules for implementers

1. **`key` must be stable across runs.** Replay looks up the latest
   `(kind, key)` match. Use something that names the same logical question
   in every run, such as a finding fingerprint or `fix_<round>`. Never use
   an array index: once the list order changes, an index key replays the
   wrong item. (`decideBatch` question names `q0`, `q1`, ... are wire names
   only and are never used for replay.)
2. **Always compute the heuristic.** The fallback is computed on every
   call, in act mode too. It is the answer whenever Jev's cannot act, and
   shadow analysis compares against it.
3. **Check run-time option sets before calling `decide()`.** When options
   come from run-time or operator data (a chain menu from `watch.chains`,
   one option per finding), call `isValidOptionSet(options, fallback, {permitted})`
   (or `optionSetProblem(...)` for the message) first. If the set is
   degenerate (empty, duplicated, or missing the fallback), skip `decide()`
   and use the heuristic directly. Letting `decide()` throw is only for
   statically built sets, where it fails the call site's unit test. A throw
   from operator data would crash a run that works with no `jev:` block.
4. **`JevDecisionKindSpec.options` is display only.** Doctor shows it, and
   nothing checks it against the options a call site sends. Build the call
   site's options from the same constant as the spec so they cannot drift.
5. **`extras` and `parseDecisionExtras` are optional.** A kind with no
   feature settings omits `extras` and never calls `parseDecisionExtras`.
6. **Where to decide.** Inside a phase, pass that phase's
   `ph.phase.phase_id` as `phase_id`. For run-scoped decisions (such as
   `startRun`), leave it `""`. The watch lane has no `Run`: build a `Jev`
   with `createJev({ config: cfg.jev, recorder: traceDecisionRecorder(tracer, adwId) })`
   once the lane has a tracer and an `adwId`. Before then, use
   `recorder: null`. That decision still acts, but it is not in any trace,
   so say so in your kind's docs.
7. **Mixing kinds in one `decideBatch` is allowed.** Each item is judged
   under its own kind's policy, and the call's deadline is the largest live
   `timeout_ms`. Keep a batch to one kind unless the items genuinely share
   one `state`.
8. **Each feature proves invariant 1 through its real call site.** Add a
   test showing that with no `jev:` block the feature's result equals the
   heuristic and the trace has zero `jev_decision` rows. Keeping existing
   tests unmodified is not enough, because it cannot cover new code paths.

## Decisions

Each feature ticket appends one subsection here with: the kind name, the
option set, the fallback (the existing heuristic), where it is resolved,
what acting on it can and cannot do, and any `jev.decisions.<kind>`
settings it adds.

<!-- One "### `kind`" subsection per kind, ALPHABETICAL by kind. Insert yours in order; do not edit neighbors. -->

### `loop_control`

Ticket #105. After a failed round in `fixLoop` or `reviseLoop`
(`src/chains/steps.ts`), spf asks Jev what the loop should do next.

- **Kind:** `loop_control`, a `choice` question.
- **Options:** `continue`, `escalate_tier`, `stop_blocked`. Both the
  kind spec and the call site build these from the single constant
  `LOOP_CONTROL_CHOICES`.
- **Fallback:** `continue`. This is the existing behavior: spend the next
  repair round on the same agent and the same model. Every fallback reason
  (disabled, shadow, timeout, error, low confidence, a choice outside the
  set or outside `permitted`) runs the loop you have today.
- **When spf asks:** only after a round fails and another repair round would
  otherwise run. It never asks after a passing round or on the final round,
  because the loop ends there anyway. A loop with `max: 3` makes at most two
  decisions.
- **Where it is resolved:** `src/chains/loop_control.ts`
  (`createLoopControl`), called from the loop body between the failed round
  and the repair phase.
  - The decision's `phase_id` is the failed round's phase (`test_2`,
    `verify_1`, `review_1`, ...).
  - Its `key` is `fix:<round phase>` or `revise:<round phase>`, for example
    `fix:test_1` or `revise:review_2`. This stays stable across runs.
  - The `state` Jev sees: the loop and round, `max_rounds` and the repair
    rounds left, the repairing agent and its current tier, whether escalation
    is available (and if not, why), the latest round's detail, and a short
    history of earlier rounds with the action taken after each. For
    `fixLoop`, the latest round's detail is the failures plus each failed
    check's command, exit code, and clipped output tail. For `reviseLoop`, it
    is the reviewer's summary, its `blocking` list, and its unmet findings.
- **What acting on it can do:**
  - `stop_blocked` ends the loop immediately with no further repair round.
    The run is **not accepted**, and its reason reads
    `stopped after round N of M: ... (loop_control)`.
  - `escalate_tier` moves the repairing role (the fix `owner`, or the
    reviseLoop `builder`) up **one** rung of `tiering.tiers` for the rest of
    **this** loop. It goes through the same `effectiveAgent()` dispatch seam
    that tiering uses. Only the model changes. When the loop exits, the run's
    original routing is restored, even if a phase throws.
  - A `loop_control` log event and a console line record every
    non-`continue` action. An escalation also records its `from_tier` and
    `to_tier`.
- **What acting on it cannot do:**
  - add a round. The configured `max` is a hard ceiling;
  - skip, weaken, or pass a gate. Every check and review phase runs as
    before, and a stop never turns a failure into acceptance;
  - retier the reviewer;
  - skip a rung;
  - escalate more than once per loop;
  - escalate above the operator's ceiling. `escalate_tier` is in
    `permitted` only when every one of these holds:
    - `max_tier` is set and names a declared rung;
    - tiering is enabled and routed this role this run;
    - the next rung up is at or below `max_tier`;
    - that rung is usable under the same backend and served-tag rule as
      `resolveTiering`;
    - this loop has not already escalated.

    In every other case, Jev's `escalate_tier` becomes `not_permitted`, and
    the loop continues. The same holds on replay.
- **Settings (`extras`):**

  ```yaml
  jev:
    decisions:
      loop_control:
        mode: act           # common knobs as usual
        max_tier: strong    # the highest tiering.tiers rung escalation may reach
  ```

  `max_tier` is the operator spend ceiling (the ticket calls it
  `jev.loop.max_tier`). By design, it lives under the kind's own
  `jev.decisions` entry. When it is absent, which is the default,
  escalation is disabled and only `continue` and `stop_blocked` can act. A
  malformed value fails `spf doctor`. It also fails `startRun` whenever the
  kind is live. A `max_tier` that names no declared rung disables
  escalation, and the reason appears in the state Jev sees.

### `risk_tier`

Classifies a run's risk for tiering (#104). Code: `src/core/risk_tier.ts`.

- **Kind:** `risk_tier`, a `choice` question.
- **Options:** `low | standard | high`, in ladder order, weakest first. The
  set is closed and built from `RISK_TIER_KIND.options`.
- **Fallback:** the existing `classifyRisk` heuristic in
  `src/core/tiering.ts`, which adds chain weight and prompt word count. It is
  computed on every call, act mode included.
- **Where it is resolved:** once per `startRun` call in
  `src/chains/steps.ts`, before any phase opens.
  - `phase_id` is `""` (run-scoped).
  - `key` is the chain name, so a joined session's second `startRun` under
    a different chain has its own key.
  - The `Decision` goes into the pure `resolveTiering` as data
    (`TierInput.riskDecision`). `resolveTiering` never calls Jev.
  - The Jev call runs concurrently with the ollama tag probe, so it adds at
    most `max(probe, timeout_ms)` to run start, not their sum.
  - **Resume:** a run that re-enters `startRun` under the same `adw_id` and
    chain (the watch lane's continue-refinement resume, the build lane's
    `spf:feedback` loop) replays that run's own latest `risk_tier` decision
    instead of asking Jev again, so both halves of one run route from the
    same answer. The replay is judged again under today's policy and
    `max_risk`, and is recorded as another row with `replayed: true`. It is
    used only when the question is the same (same options and same
    heuristic fallback). A resumed prompt that lands in a different
    word-count bucket is a new question, so it is asked live and recorded.
- **When it is asked at all:** only when `jev.enabled` is true, the kind's
  mode is not `off`, and `tiering.enabled` is true. Risk changes nothing but
  tiering's routing, so with tiering off no call is spent. If any of the
  three is false, no call is made, no `jev_decision` row is written, the
  extras are not parsed, and the `tiering` event is unchanged.
- **Trace:** the full decision is its own `jev_decision` row. The existing
  `tiering` log event also carries a compact `jev` summary: `choice`,
  `jev_choice`, `confidence`, `fallback`, `used_fallback`, `reason`,
  `mode`, `would_act`, `replayed`, `kind` and `key`. `risk` in that event is
  the effective risk, and `signals` are still the heuristic's. A console
  note is printed only when Jev's answer moved the risk off the heuristic's.
- **`spf estimate`** never calls Jev. By default it uses the heuristic. With
  `--replay-risk <adw_id>`, it replays the decision that run recorded for
  this chain, judged again under today's policy, with no call and no row
  written. When `risk_tier` is live for the config, or a replay is asked
  for, the report says which source it used: `risk_source` in `--json`, and
  a `risk from` line in text. A replay only matches when today's heuristic
  gives the same fallback (same chain, and a prompt in the same word-count
  bucket). Otherwise the reason is `replay_missing` and the heuristic acts.
  A recording above today's `max_risk` replays as `not_permitted`. Invalid
  `risk_tier` extras with `--replay-risk` exit 1 with the
  `jev.decisions.risk_tier: ...` config error. With no trace db under
  `--cwd`, the detail says there is nothing to replay.
- **What acting on it can do:** pick which rung of the operator's own
  `tiering.tiers` ladder each routed role starts from. This is the same
  one-step shift the heuristic makes.
- **What it cannot do:**
  - name a model, add a rung, or route a role that `tiering.roles` does not
    name
  - walk up past an unusable rung (the walk only goes down)
  - raise `max_run_tokens` or `max_run_cost`, which are enforced as before
  - act above `max_risk` (see below)
- **Shadow mode:** Jev is asked and the answer is recorded, but the
  heuristic's risk routes the run.
- **What leaves the machine:** when the kind is live, Jev's `state` carries
  the chain name, the heuristic's signals, and the head of the operator's
  prompt (up to `max_prompt_chars`, default 4000). Prompts often embed issue
  bodies and comment threads (the watch resume folds the whole thread in).
  Set `max_prompt_chars: 0` to send only the chain name and the signals.
- **Config validation:** `startRun` validates the extras only when the kind
  is live, which includes `tiering.enabled`. With tiering off the extras are
  never read, so an invalid `max_risk` does not fail a run (a feature that
  is off is a no-op). `spf doctor` validates them regardless, so it catches
  a latent typo before tiering is turned on.

Extras, under `jev.decisions.risk_tier`:

| key | default | meaning |
|---|---|---|
| `max_risk` | `high` | The highest risk Jev's answer may act on (the `permitted` ceiling). The heuristic's own answer is always permitted, so this caps escalation driven by Jev and never lowers what the run would get without Jev. |
| `max_prompt_chars` | `4000` | How much of the prompt, from the start, goes into Jev's `state`. The rest is dropped and flagged `prompt_truncated`. `0` sends no prompt text. Integer, 0 to 200000. |

```yaml
jev:
  enabled: true
  decisions:
    risk_tier: { mode: act, threshold: 0.8, max_risk: standard }
tiering:
  enabled: true
  # tiers / roles as usual
```

## Wire format and caveats

- The endpoint is `POST {base_url}/systemone`, authenticated with
  `Authorization: Bearer $TYPESAFE_API_KEY`. The request body is
  `{model, state, questions}` and the response is `{model, answers, usage}`.
  No SDK is used; the client is a small wrapper over `fetch`.
- These shapes come from research done ten days after launch. Answers are
  parsed defensively, so any answer spf does not recognize becomes
  `invalid_response` and the fallback acts. **Verify against a live
  response before moving any kind to `act`.** Treat score-level index base
  (0 or 1) and confidence on `noul` answers as unverified.
- spf does not retry. Jev's value is fast answers, and every failure already
  has a correct answer (the fallback). A `429`/`529` is recorded as `error`
  with the status in `detail`.
- State and questions share a budget of about 32,000 tokens per call. Jev
  is documented as unreliable at counting, so ask one question per item
  and sum the answers in code.
