# Changelog

This project doesn't otherwise keep a changelog file (releases are tagged
straight off `main` — see `scripts/tag-release.js`); this file starts with
the OTel SDK migration below because it's large enough, and cuts closely
enough to `observability.otel`'s existing invariants, to be worth a written
record independent of the commit log.

## Unreleased

### Added — Jev rails (off by default) — #103

- **`core/jev.ts`** (new): a typed client for TypeSafe's Jev
  ("System One") decision model built on global `fetch`, with no new
  dependency. It also adds one `Jev.decide()`/`decideBatch()` policy shared
  by every future decision kind. Jev only chooses from a closed option set
  that code builds. Every decision has a deterministic fallback, which is
  used when Jev is disabled, in shadow mode, or on a missing key, timeout,
  error, invalid answer, or low confidence. `mode: shadow` (the default)
  records Jev's answer while the fallback acts.
- **`jev:` config block**: `enabled` (default `false`), `mode`, `model`,
  `threshold`, `timeout_ms`, `api_key_env` (default `TYPESAFE_API_KEY`),
  `base_url`, and per-kind `decisions.<kind>` overrides that can also carry
  a feature's own settings. Kinds are registered in `core/jev_kinds.ts`.
  `spf doctor` validates the block and warns when it is enabled without a
  key.
- **Trace**: each decision made while Jev is enabled is recorded as one
  `log`/`jev_decision` event. `findRecordedDecision()` lets a replay or
  estimate reuse it without calling Jev again. `run.jev` is wired to the
  run's trace.
- With no `jev:` block, runs behave exactly as before: no call and no trace
  event. See `docs/jev.md`.
- **Replay and edges**: a replayed decision reuses the recorded answer and
  judges it again under today's policy and `permitted`, so a replay cannot
  act on a choice the caller no longer permits. `enabled: false` or a kind
  set to `off` wins over any replay. `isValidOptionSet()`/`optionSetProblem()`
  let a feature check a run-time option set before calling `decide()`. An
  empty `jev.decisions:` in YAML now means `{}`.

### Added — Jev decision kinds

<!-- One bullet per kind (feature ticket under epic #102), alphabetical by kind. -->

- **`loop_control`** (#105): after each failed, non-final round of
  `fixLoop`/`reviseLoop`, Jev chooses `continue | escalate_tier |
  stop_blocked` (fallback `continue`, today's loop). The configured `max`
  stays a hard ceiling. `stop_blocked` ends the loop not accepted.
  `escalate_tier` moves only the repairing role up one `tiering.tiers` rung,
  once per loop, never above `jev.decisions.loop_control.max_tier` (unset
  disables escalation; never for a `reviseLoop` whose reviewer is its
  builder), and is undone when the loop exits, `agent_map` entry included.
  Decision keys (`fix:test_1`, `fix#2:test_1`, ...) are unique within a run,
  a replay driver can reuse recorded decisions via `setLoopControlReplay`,
  the state sent to Jev is bounded, and `spf doctor` warns on a misplaced
  `jev.loop:` block. New `src/chains/loop_control.ts`; `tiering.usable` is
  now exported so the escalation check applies the same rung rule.
- **`risk_tier`** (#104): Jev can classify a run's tiering risk
  (`low | standard | high`) once in `startRun`. The fallback is the existing
  chain-weight + prompt-length heuristic. It is only asked when tiering is
  enabled. The pure `resolveTiering` takes the decision as data. The
  `tiering` trace event carries a `jev` summary. `jev.decisions.risk_tier`
  adds `max_risk` (a ceiling on escalation driven by Jev) and
  `max_prompt_chars`. `spf estimate` says where its risk came from, and
  `--replay-risk <adw_id>` reuses a recorded decision without calling Jev.
  A run resumed under the same `adw_id` and chain replays its own decision
  instead of asking again. When the kind is live, the head of the prompt
  (up to `max_prompt_chars`) is sent to Jev; `max_prompt_chars: 0` sends
  only the chain name and the heuristic's signals.

### Changed — OpenTelemetry: real SDK encoder, process-scoped metrics, outbound propagation

- **`core/otel.ts`**: the hand-rolled OTLP/HTTP-JSON span encoder is
  replaced with the real `@opentelemetry/sdk-trace-base` (`ReadableSpan`) +
  `@opentelemetry/exporter-trace-otlp-http` (`OTLPTraceExporter`) pipeline.
  The public API, the deterministic sha256 trace/span-id scheme, the
  attribute allowlist, the bounded queue, and the per-run lifecycle are all
  unchanged. Two verified wire-shape differences from the old encoder (see
  `otel.ts`'s header for the full list): `intValue` is now a JSON number,
  not a stringified one, and a root span's `parentSpanId` is omitted
  entirely rather than spelled out as `""`.
- **`core/otel_metrics.ts`** (new): a process-scoped OTel metrics pipeline
  (`@opentelemetry/sdk-metrics` + `exporter-metrics-otlp-http`), gated on
  the same `observability.otel.endpoint` as traces, plus a new
  `observability.otel.metrics` flag (default `true`) to opt out of metrics
  specifically. Five instruments: `spf.tokens`, `spf.cost_usd`,
  `spf.phase.duration`, `spf.gate.result`, `spf.agent.calls` — wired from the
  same `recordPhase`/`recordGate`/`closeAgentCall` seams the span exporter
  already used. The old "dropped spans as a resource attribute" hack is
  gone (a `Resource` is immutable per exporter instance in the real SDK);
  dropped-span/dropped-event counts now ride as real counters instead, when
  metrics are configured.
- **`core/otel_propagation.ts`** (new): outbound `traceparent`/`x-request-id`
  propagation for `coding_agent: flue`, via a real (if minimal) global
  `BasicTracerProvider` + `@opentelemetry/instrumentation-http`/`-undici` +
  a `CompositePropagator` (W3C TraceContext + a custom `x-request-id`
  propagator). Best-effort by design and documented as such — reaches any
  provider whose Node SDK issues requests through `http`/`undici`.
  **Update (#80):** flue's spans now JOIN SPF's deterministic trace instead
  of forming a separate one — via the instrumentation's per-span
  `resolveRootContext` option, backed by a session-id -> traceparent map
  `agent_flue.ts` registers around each run (`ctx.id` is flue's documented
  stable instance id, which SPF mints). This is per-span rather than a
  dispatch-time context wrap because flue's node runtime executes all
  submissions in ONE process-lifetime claim loop whose async context is
  captured once — a context wrap would silently mis-attribute every agent
  after the first into the first agent's trace (verified against
  `@flue/runtime`'s dist). Flue spans inherit the sha256 trace id per
  session, and the provider requests' wire `traceparent` carries it too —
  parity with the `claude_code` path. Unmapped sessions (backlog restarts,
  post-settlement stragglers) degrade to the old separate-trace behavior,
  never mis-attributed; the internal `executionContext.traceCarrier`
  escape hatch stays unused (not on the public dispatch surface).
  `installFluePropagation` also no longer latches `installed` before its
  fallible registrations, so a constructor-time failure is retried on the
  next call instead of permanently disabling the process.
- **`agent_cc.ts`**: `TRACEPARENT`/`ANTHROPIC_CUSTOM_HEADERS` are injected at
  the single `spawn()` choke point for `coding_agent: claude_code`, when
  `observability.otel` is configured — a real, verified guarantee (unlike
  the `flue` path above). `ANTHROPIC_CUSTOM_HEADERS`'s format (newline-
  separated `Name: Value` pairs) is verified against Claude Code's own docs
  (https://code.claude.com/docs/en/env-vars).
- **`agent_opencode.ts`**: outbound trace-context propagation for
  `coding_agent: opencode`, when `observability.otel` is configured —
  `TRACEPARENT` on the subprocess env (parity with `claude_code`;
  unverified whether the opencode CLI reads it) plus static
  `traceparent`/`x-request-id` provider headers
  (`provider.<id>.options.headers`, opencode's documented config surface)
  in the temp `opencode.json` this module already writes. Static is correct
  because one `opencode run` subprocess is exactly one agent call. A
  caller-provided `OPENCODE_CONFIG` is now MERGED into the temp config
  (SPF's own blocks win on conflict) instead of replaced outright —
  closing a regression class where enabling OTel or a `tools:` list on an
  already-configured workflow silently dropped the operator's provider
  routing/credentials config. Caveats (documented in the module's doc
  comment): a bare model id with no `provider/` prefix skips the headers,
  and a repo's own `opencode.json` merges at higher precedence and can
  override them.
- **`spf.lora_adapter`** span attribute (new): resolved from an explicit
  `agents[].lora_adapter` config override, else parsed from the model id
  (`provider/base:adapter`, or this org's `provider/adapter-name` `-lora-`
  served-model convention) — see `otel.ts`'s `loraAdapterFor()`.
- **`gen_ai.usage.cache_read.input_tokens`** (new): the semantic-convention
  twin of the existing `spf.tokens.cache_read` attribute, for the vLLM/
  OpenAI-compatible `usage.prompt_tokens_details.cached_tokens` pass-through
  (already end-to-end via `@earendil-works/pi-ai`'s OpenAI-completions
  adapter; requires the upstream vLLM server to run with
  `--enable-prompt-tokens-details`, off by default).
- **`observability.otel.allow_env`** (new, default `false`): when `true` AND
  the block is ALREADY active (`endpoint` set), the standard
  `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_HEADERS` env vars may
  SUPPLEMENT it — never activate it from nothing, and config always wins on
  conflict. `observability.otel`'s EXPLICIT CONFIG ONLY invariant is
  otherwise unchanged.
- New dependencies (all exact-pinned, versions current as of this change):
  `@opentelemetry/api`, `@opentelemetry/core`, `@opentelemetry/resources`,
  `@opentelemetry/semantic-conventions`, `@opentelemetry/sdk-trace-base`,
  `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/otlp-transformer`
  (used directly, for `JsonTraceSerializer` — see `otel.ts`'s `pendingJson`),
  `@opentelemetry/sdk-metrics`, `@opentelemetry/exporter-metrics-otlp-http`,
  `@opentelemetry/instrumentation`, `@opentelemetry/instrumentation-http`,
  `@opentelemetry/instrumentation-undici`, `@opentelemetry/context-async-hooks`,
  `@flue/opentelemetry`.
- `.npmrc` (new, then REMOVED again — see the **Update (#81)** below):
  `legacy-peer-deps=true` — `@flue/opentelemetry@2.0.4` publishes a
  `peerDependencies` entry of `@flue/runtime: "workspace:^"`, an
  unrewritten workspace-protocol range that breaks plain `npm ci`/
  `npm install` with `EUNSUPPORTEDPROTOCOL` otherwise.
  **Update (#81):** `@flue/opentelemetry@2.0.5` (shipped 2026-09-11)
  rewrites the peer range properly (`@flue/runtime: "^2.0.5"`), so both
  flue packages are bumped to exact-pinned `2.0.5` and the `.npmrc`
  workaround is deleted — plain `npm ci` with npm's default peer
  resolution is the verified acceptance path. `@flue/runtime`'s public
  types (`dist/index.d.mts`) are byte-identical between 2.0.3 and 2.0.5,
  and 2.0.5's `builtin-providers` chunk still carries the process-lifetime
  `claimLoop()` the flue trace-unification design (#80) is built around —
  so no code change rides along with the bump.

Not part of this change (explicit owner decision): no Briefs-specific model
provider, and no `BRIEFS_*` env var — this was OTel-extension work only.

### Added — watch: `<prefix>:feedback` revision loop for the build lane

- **`core/issues/provider.ts`**: a new `WatchState` value, `feedback` — the
  build lane's own human-in-the-loop label, modeled on the refine lane's
  `needs-feedback`/`continue-refinement` pair but sourcing corrections from
  **PR comments**, not issue comments. A new optional
  `CodeHostProvider.listPrComments(pr)` seam (`PrComment[]`, oldest-first),
  implemented for both `github_provider.ts` (merging issue comments, inline
  review comments, and review verdicts into one thread, paginated up to 500
  comments) and `bitbucket_provider.ts` (its first paginated endpoint). A new
  `WatchMarker.revision` field (`{rounds, since}`) tracks how many times an
  issue has been pushed and when, both for prompt-splitting and for the
  branch-naming fix below.
- **`core/watch.ts`**: `claimFeedback` (new) claims `feedback -> working` and
  reruns the issue via `runIssueSingle(deps, issue, {revision: true})`. If
  the recorded PR is still open, it rebuilds from that PR's own branch head
  and pushes onto it in place — same PR, a new commit, no new PR number. If
  the PR was closed/declined, it opens a fresh `-rN`-suffixed branch and a
  new PR whose body notes it supersedes the old one. `buildIssuePrompt` (new,
  exported, pure) folds the PR's comment thread into the prompt, splitting
  "corrections to address" from "earlier review discussion" on
  `WatchMarker.revision.since` — the same truncation/omission-count rule as
  the refine lane's `buildSpecPrompt`. Wired into `tick()` right before
  `claimNewWork`, sharing the build lane's own `concurrency` budget rather
  than a separate one.
- **Fixes a live bug**: relabeling a `blocked` issue (a declined PR) back to
  `ready` used to always rebuild on the SAME un-suffixed branch name, which
  the remote still held commits under from the earlier push — a guaranteed
  `git push -u` non-fast-forward rejection. `branchNameFor(issue, round)`
  now suffixes `-rN` whenever `runIssueSingle` sees a prior push recorded in
  the marker, whether or not the reclaim goes through `feedback`.
- **`core/notify/channel.ts`**: a new `NotifyKind`, `pr_updated`, fired at
  `notice` level (the same `attention`-scope bucket as `pr_opened`) when a
  revision lands on an existing PR instead of opening a new one.
- Labels: `feedback` added to both providers' `STATES` (seeded by
  `spf watch init` — re-run it after upgrading). Deliberately NOT added to
  `JiraStatusMapSchema`/`GithubStatusMapSchema` — same reasoning as
  `needs-feedback`: board-visible states only.
