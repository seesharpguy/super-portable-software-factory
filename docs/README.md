# docs

Worked example configs live in [`../assets/templates/`](../assets/templates/)
now, not `docs/examples/` — they moved there so they ship inside the
published npm package and `spf init --template <name>` can write one
directly, rather than being copy-from-GitHub-only reference material. Run
`spf init` with no `--template` to see every packaged template's short
name, or browse the files directly:

- [`../assets/templates/ts.spf.config.yaml`](../assets/templates/ts.spf.config.yaml) (`--template ts`) — a full `quality:` suite (typecheck/lint/build/test), the `claude_code` backend, and commented-out `agents:`/`watch:` overrides. This project's own `.spf/spf.config.yaml` (using the factory on itself) is a real, live instance of the same shape.
- [`../assets/templates/ts-cc.spf.config.yaml`](../assets/templates/ts-cc.spf.config.yaml) (`--template ts-cc`) — `coding_agent: claude_code` redirected at Ollama (local or cloud) via `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`, no spf-side config for the redirect itself.
- [`../assets/templates/ts-flue-openrouter.spf.config.yaml`](../assets/templates/ts-flue-openrouter.spf.config.yaml) (`--template ts-flue-openrouter`) — the default Flue backend, `model:` routed through OpenRouter (`provider/model-id`, `OPENROUTER_API_KEY`).

All three were verified to actually parse against spf's real config schema (`agents.loadConfig()`), not just hand-written to look plausible.

## How provider/model resolution and API keys actually work

**Flue (`coding_agent: flue`, the default):** `model:` is always `provider/model-id` — the string's first segment names the provider, and that segment alone decides which environment variable gets read for credentials. This resolution belongs to Flue's own underlying `pi-ai` library, not to spf. `agents.validate()` (via `agent_flue.ts`'s `resolveModel()`) only checks the STRING SHAPE — does it look like `provider/id` — never that the provider is real or that a key is actually set. A wrong provider name or a missing key only surfaces at the first real dispatch, not at validate time. `spf doctor` has its own small, hand-maintained table of common providers' env-var conventions (`PROVIDER_ENV_KEYS` in `src/cli/commands/doctor.ts`) for an informational check only — `pi-ai`'s real internal provider table isn't exported for spf to read, so this is best-effort, not authoritative.

**Claude Code (`coding_agent: claude_code`):** `model:` is Claude Code's own vocabulary — a bare alias (`sonnet`, `opus`) or a full model name — never `provider/model-id`. `agents.validate()` only checks it's non-empty. Credentials come from however the `claude` CLI itself is authenticated: an `ANTHROPIC_API_KEY` env var, or its own `claude login` OAuth session — `spf doctor` treats a missing key as informational for this backend, since login is a valid alternative. Pointing it at Ollama redirects that whole layer via `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`, which Claude Code's CLI reads itself; `agent_cc.ts` adds no special-casing, it just passes the operator's environment through to the `claude` subprocess unmodified — `spf doctor` doesn't know about this redirect, so confirm those two env vars yourself before a real run.
