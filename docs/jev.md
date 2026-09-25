# Jev in spf

**Status:** rails only. The config, client, policy, trace event, and doctor
checks ship first, and no decision kind uses them yet. Each feature ticket
under epic #102 adds one kind and a subsection under [Decisions](#decisions).
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
      include_diffstat: true   # a feature-specific key, validated by that feature
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
| `input_sha256` | hash of state + instructions + options (the state itself is not stored) |
| `replayed` | this decision was reused from an earlier trace |

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
  A recorded `Decision` is reused without calling Jev. `null` means replay
  mode with nothing recorded, so the fallback acts and Jev is not called.
- Tests use `src/test/fake_jev.ts`'s `FakeJevClient`, passed as
  `createJev({ client })` or process-wide with `setJevClientFactory(() => fake)`.
  Always reset it with `setJevClientFactory(null)`.
- `decide()` throws only on programmer errors, such as an empty option set
  or a fallback that is not one of the options. It throws these even when
  Jev is disabled, so the call site's own unit test catches them.

## Decisions

Each feature ticket appends one subsection here with: the kind name, the
option set, the fallback (the existing heuristic), where it is resolved,
what acting on it can and cannot do, and any `jev.decisions.<kind>`
settings it adds.

*(none yet)*

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
