# Changelog

This project doesn't otherwise keep a changelog file (releases are tagged
straight off `main` — see `scripts/tag-release.js`); this file starts with
the OTel SDK migration below because it's large enough, and cuts closely
enough to `observability.otel`'s existing invariants, to be worth a written
record independent of the commit log.

## Unreleased

### Added — `watch.allowed_authors`: an explicit issue-author allowlist, separate from the label gate

- **`core/data_types.ts`** (`WatchConfigSchema.allowed_authors`), **`core/issues/provider.ts`** (`Issue.author`), **`core/watch.ts`** (`authorBlocked`/`rejectDisallowedAuthor`, wired into both `claimNewWork` and `claimSpecs`): on a tracker that accepts public issues, `<prefix>:ready`/`<prefix>:spec-ready` being a label-write-gated action does not mean the ISSUE CONTENT is trusted — anyone can open an issue and write whatever they want in its body, and a collaborator who labels a plausible-looking public issue without catching an embedded instruction hands that body to a coding agent with real Bash/write access as if it were vetted input. `watch.allowed_authors` is a second, independent gate: empty (the default, and every existing config's behavior, unchanged) is unrestricted; a non-empty list refuses any issue whose ORIGINAL author (`Issue.author` — GitHub's `user.login`, Jira's `reporter.displayName`) isn't on it, transitioning straight to `blocked` with an explanation before a worktree, lock, or chain run ever exists for it. See the README's `watch.allowed_authors` section.
- `spf doctor` reports whether this is set.

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
