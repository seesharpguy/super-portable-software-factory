# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Software engineers who install `spf` (`@gr8ful/spf` on npm) against a repo they own or work in. Two equally core usage modes, not a primary/secondary split:

- **Interactive:** an engineer runs `spf` chains (e.g. `spf scout`, a plan/build/test chain) directly against their working repo, watching phases execute and reviewing agent output as it happens — often via `spf ui`, the live trace visualizer.
- **Unattended:** `spf watch` polls a tracker (GitHub/Jira/Bitbucket) for issues labeled ready, runs a configured chain per issue in an isolated git worktree, opens a PR, and tracks it through merge — with Slack/Teams/webhook notifications standing in for a human watching live. The trace UI is where a human catches up after the fact and signs off on what ran.

## Product Purpose

SPF gives repeatable structure to "agents-plus-code" workflows. Instead of handing a coding agent the whole SDLC and hoping, SPF moves sequencing, retries, and acceptance criteria into deterministic TypeScript ("chains"), and confines agents to bounded, named phases inside that structure. Every event streams into SQLite as it happens, so a run is inspectable while live and auditable after. Success means: the same chain run twice behaves the same way, a failure can be attributed to a specific phase, and a correction is cheap because the run is still alive rather than a cold restart.

## Positioning

**"Agent proposes, code disposes."** The mechanism competitors don't share: code — not a prompt, not agent judgment — owns sequencing, retries, and the definition of "done" (quality gates). Agents own only the reading-and-deciding work inside one bounded phase; anything with a known, mechanical invocation (`npm test`, `tsc --noEmit`) runs as a `kind: "code"` phase, never burns an agent's context rediscovering a command a subprocess already knows. `spf` ships with zero repo setup required — no framework stamped into your repo, no separate agent binary — and works with any of three coding-agent backends (Flue, a locally installed Claude Code CLI, or a locally installed OpenCode CLI), so the same chain script isn't locked to one vendor's model.

> *Same models. Same prompts. The difference is who owns the loop.*

## Operating Context

- Installed globally (`npm i -g @gr8ful/spf`) or run from a local clone via `npm link`; invoked from inside the target repo (`cd your-repo && spf ...`).
- Configured per-repo via `.spf/spf.config.yaml` (agent roster, quality gates, chains); `spf init` seeds it interactively or from a packaged template.
- `spf doctor` is the standing diagnostic — resolves every path, validates the roster and quality suites, and surfaces silent-failure causes (missing provider key, a quality check whose binary isn't on `PATH`, a stale `protected_files` pattern) before a run is attempted.
- Runs execute inside git worktrees for isolation; agents' write access is bounded per-agent (`writes:`) and enforced post-hoc by diffing the repo before/after a call — not just declared.
- Trace data lands in a per-repo SQLite db (`spf.db` by default under `.spf/data`), read live by `spf ui` (a Vue SPA served by a Hono/node:sqlite backend) while the WAL-mode db is still being written to by the running chain.
- A session's review lifecycle ends with a human archiving it in the trace UI ("I looked at this run") — currently a manual UI action, not yet tied to CI/CD merge events.

## Capabilities and Constraints

- Requires Node ≥ 22.19.0.
- Three coding-agent backends: `flue` (default, provider/model-id strings like `google/gemini-3.6-flash`), `claude_code` (drives a locally installed Claude Code CLI; also reachable through Ollama via `ANTHROPIC_BASE_URL`), and `opencode` (drives a locally installed OpenCode CLI via `opencode-ai`; provider/model-id vocabulary like flue).
- Chains are TypeScript; phases are typed `kind: "engineer" | "code" | "agent"`. Agent output crosses phase boundaries only as typed JSON envelopes.
- `spf watch` currently dispatches exactly one configured chain (`watch.chain`) per claimed issue, plus one refine chain for spec decomposition — no per-issue/per-label chain routing yet (open design direction, not yet built).
- The trace visualizer is explicitly read-only observability except for one write: archiving a session (a review-state flag, not run state).
- Six starter agents ship by default: `planner`, `builder`, `scout` (read-only recon), `refiner`, `reviewer`, `documenter` — config-driven, not hardcoded; a chain names agents by role, never by model.

## Brand Commitments

Name and wordmark only: "Super Portable Software Factory" / `spf`. No formal palette, typography, or visual system established yet — the per-agent lane colors in `spf.config.yaml` (e.g. `#a78bfa`) are functional (distinguishing agents in the trace waterfall), not brand color.

## Evidence on Hand

- README.md and README2.md document the product philosophy, config shape, and CLI surface in detail — treat as authoritative product copy, not marketing to be replaced.
- `assets/templates/` holds real, filled-in starter configs (e.g. `ts-flue-ollama.spf.config.yaml`) usable as literal examples/evidence in future UI or docs work.
- No customer testimonials, case studies, press, or usage metrics exist. Future work must not fabricate them.
- MIT licensed, public GitHub repo (`seesharpguy/super-portable-software-factory`), published on npm as `@gr8ful/spf`.

## Product Principles

1. **Code owns the loop; agents own bounded decisions inside it.** Never let a design decision blur that line — e.g. don't move a mechanical check into an agent's judgment for convenience.
2. **The trace is the product's trust mechanism.** Anything that makes a run's history harder to inspect, attribute, or audit works against the core value proposition.
3. **Zero-setup by default, fully configurable when asked.** New surfaces should work against any repo with no stamped-in scaffolding, while still respecting `.spf/spf.config.yaml` when present.
4. **Public-facing, cold-start friendly.** This ships to strangers via npm — docs, UI copy, and onboarding should not assume the reader already knows SPF's vocabulary (ADW, envelope, gate, phase).
5. **Read-only unless explicitly a review action.** The trace UI's one write (archive) is a deliberate, narrow exception — new UI capabilities should default to observability, not control.

## Accessibility & Inclusion

No product-specific accessibility requirement has been established yet.
