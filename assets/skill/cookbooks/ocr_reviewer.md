# Using `alibaba/open-code-review` as reviewer evidence

Opt-in, repo-level, docs-only: nothing in the packaged reviewer prompt
mentions `open-code-review` ("ocr"), and nothing ships that runs it. This
cookbook is for a repo that wants its *own* reviewer to shell out to ocr and
fold its findings in — a second opinion the reviewer reads as evidence, never
a second decision-maker.

**The rule this whole cookbook exists to protect: the reviewer agent stays
the sole producer of `ReviewOutput`.** `ocr review`/`ocr scan` is a bash
command whose stdout the reviewer reads, the same as `git diff` — nothing
new gates a commit, because the reviewer's own `approved`/`findings`/
`blocking` is still the only envelope anything downstream ever consumes. If
you want that packaged-prompt wording, see the one line
`assets/prompts/reviewer/system.md` already carries: "except tools whose
output is the product ... which you read as evidence, never as a verdict."

You wire this in with a repo-local prompt override, not a fork of `spf`
itself — `.spf/prompt_engineering/<agent>/` resolves before the packaged
default (see `core/paths.ts`'s `resolvePromptRef`: repo root, then
`.spf/<ref>`, then `.spf/prompt_engineering/<ref>`, then the packaged asset —
first hit wins). Copy `reviewer/system.md` into
`.spf/prompt_engineering/reviewer/system.md`, add the ocr instructions, and
every chain that names `reviewer` picks it up with no code change.

## (a) Credentials — set `env_allowlist` before you add ocr

The reviewer's `bash` tool does not run in a sandbox; it inherits whatever
environment this agent's request carries. Today, unless you configure
otherwise, that is the FULL operator environment — every key in the shell
`spf` was launched from, plus anything loaded from the repo's `.env`
(`AgentConfigSchema.env_allowlist`, `core/agents.ts`'s `agentEnv()`: unset
means "don't filter at all"). That is fine for a reviewer that only ever
runs `git diff`/`grep`/`bun test`. It stops being fine the moment `bash` can
also run `ocr`, because ocr is a THIRD-PARTY BINARY THAT INVOKES ITS OWN LLM
— it can send anything reachable in that environment (your `ANTHROPIC_API_KEY`,
`GITHUB_TOKEN`, cloud credentials, database URLs in `.env`) to wherever its
own model call goes, and nothing in `spf` observes that call to say otherwise.

Before pointing the reviewer's prompt at ocr, give that agent an explicit
allowlist so its `bash` tool — and therefore ocr — only ever sees what ocr
itself actually needs, plus the baseline `PATH`/`HOME`/`USER`/`LANG`/`TERM`/
`TMPDIR` every backend keeps regardless.

**What `env_allowlist` actually scopes depends on the reviewer's backend.**
On `coding_agent: claude_code`, it is the environment of the WHOLE `claude`
subprocess, not just its `bash` tool (`core/agent_cc.ts`'s `spawn(cmd,
fullArgs, { cwd, env: request.env ?? operatorEnv() })`) — so an allowlist
scoped only to ocr's own keys strips `ANTHROPIC_API_KEY` from the `claude`
CLI itself, and the reviewer stops authenticating (unless it relies on
`claude login`, since `HOME` is in the baseline and that flow's credentials
live under it). A `claude_code` reviewer must therefore also keep its own
backend credential in the list. On the default `flue` backend it is safe as
written below, because `request.env` there only reaches the tool sandbox
(`local({cwd, env})` in `core/agent_flue.ts`) — Flue's own provider
credentials are read from the parent's `process.env` regardless of this
list.

```yaml
# .spf/spf.config.yaml — patches the packaged "reviewer" entry by name
agents:
  - name: reviewer
    env_allowlist:
      - OCR_API_KEY        # whatever credential ocr's own model call needs
      - OCR_BASE_URL        # if ocr talks to a self-hosted or proxied endpoint
```

Agent config entries merge by name (`core/agents.ts`'s `mergeAgentLists`) and
patch by field, so this adds `env_allowlist` to the reviewer without having
to repeat its `model`/`prompt_engineering`/`writes`/`tools`. Do this even if
you think the reviewer "doesn't have secrets to leak" — the allowlist is
what makes that true, not an assumption about what happens to be in the
shell today.

## (b) Writes — ocr must not put a file in the repo

The packaged reviewer runs `writes: []` — read-only with respect to the
repo, enforced in code after the call (`core/permissions.ts`), not by asking
the model nicely. That enforcement has no retry path: it is not a gate a
violation can re-prompt its way past. A path ocr drops anywhere in the
working tree becomes a `PermissionBreach`, which `agents.execute()` throws
straight out of the phase — the run aborts, the same session does not get a
chance to fix it, and whatever ocr wrote gets rolled back if it can be
(deleted, if untracked; left alone and reported if it collided with a file
that was already dirty).

Two things to do before wiring ocr in for real, not after the first failed
run teaches you the hard way:

- **Verify ocr's cache/output behavior first**, outside of `spf` — run it
  by hand in a scratch clone and check `git status` afterward. Some
  review/scan tools default to writing a cache directory or a report file
  next to the code they scanned.
- **Point any output ocr can be configured to write at a path outside the
  repo, or under the run's own data directory** — `context_handoff_dir` is
  always writable regardless of `writes: []` (`core/permissions.ts`'s
  `alwaysWritable()`: the session runtime under `defaults.data_dir` is
  granted to every agent, read-only ones included, because it is where an
  agent hands its own report to the next phase, not repo content). The
  reviewer's own prompt template already receives it as `{{context_handoff_dir}}`
  — reuse that instead of a path ocr would put inside the tracked tree.

If ocr has no such flag, prefer piping its output to stdout and letting the
reviewer's bash call capture it that way — no file, nothing to breach.

## (c) Accounting honesty — ocr's spend is invisible to spf

`spf` counts tokens and dollars in exactly one place:
`core/agents.ts`'s `execute()`, around the ONE backend call it makes per
agent turn (Flue or Claude Code), via `run.addUsage()`. That is the
reviewer's own LLM call. `ocr review`/`ocr scan` invoked from inside that
call's `bash` tool is a subprocess the tracer sees as a `tool_call` event —
arguments, an ok/error flag, and captured output (both clipped at 20,000
characters) — not an exit status; a non-zero `ocr` exit usually still comes
back as ordinary successful tool output with the code inside the text, the
same as any other shell command — never as a second `agent_start`/
`agent_end` pair, because it isn't one from `spf`'s point of view: it is a
program the reviewer ran, the same shape as `bun test`. Whatever ocr's own
model call cost, on whatever credential you scoped in (a), is spent and
billed entirely outside `spf`'s usage tracking (`spf sessions`, the `cost`
column, the UI's usage panel — none of them will show it).

Be honest with yourself and whoever reads the trace about what this means:
the session total you see for a `reviewer` phase is a **floor**, not the
full cost of that review, whenever ocr ran. And whether ocr ran at all on a
given run is at the MODEL's discretion — it's an instruction in a prompt,
not a step in a chain, so a reviewer that judges the diff sufficient on its
own is free to never invoke it. If you need to know it ran, ask the prompt
to say so in its own `notes_for_next_agent`, and read the phase's
`tool_call` events for the `ocr` invocation itself — that is the only
record of it that exists.

## (d) `spf doctor` does not check for ocr

Deliberately. `spf doctor` checks binaries it has a specific, packaged
reason to expect: `quality.checks[].argv[0]` (your configured lint/test/build
commands), the `claude` CLI when `coding_agent: claude_code`, provider env
keys for whatever `model:` a roster entry names. None of those surfaces ever
mention ocr, because nothing packaged expects it to exist — it is named only
inside a prompt file YOU wrote, in a place `doctor` has no reason to read. A
missing or broken `ocr` binary therefore fails silently from `doctor`'s point
of view; the reviewer will simply get a failed-command result back from its
own `bash` tool call, the same as any other missing binary, and has to
handle that in its judgment like any other tool failure — never a `spf
doctor` line telling you in advance.

## (e) A worked prompt-override snippet

`.spf/prompt_engineering/reviewer/system.md` — the packaged file, with one
instruction added (keep everything else; this only appends):

```markdown
# Reviewer Agent

## Purpose

Confirm that what was built is what was asked for. This is not testing.

## Instructions

- Your spec is `<context_handoff_dir>/plan.md` when that file exists — the plan is the refined ask. Otherwise the spec is `prompt`, verbatim.
- Judge the code on disk, never the builder's summary of it. Start from `previous_envelope.changed_files`, read them, and use `git diff` for anything the envelope did not mention.
- Break the spec into concrete requirements and rule on each one: met, or not met with the evidence — a `file:line`, or exactly what is missing.
- Not your job: running tests, style opinions, refactors, or anything the request did not ask for. Work the request never asked for is not blocking on its own; work the request DID ask for and is missing always is.
- Change nothing. Findings go back to the builder — that is the only repair path.
- `approved` is true ONLY when every requirement is met and `blocking` is empty. Every blocking item names the specific gap, so the builder can fix it without guessing.
- You inherit the operator's shell environment, filtered to this agent's `env_allowlist` — call tools by bare name (`bun`, `uv`, `git`, `ocr`); never hunt for a binary or fall back to an absolute `/usr/bin/*` path.
- Judge any command you run by its exit status, never by scanning its output for words — except tools whose output is the product, such as `git diff`, or a review tool you were asked to consult, which you read as evidence, never as a verdict.

## One more evidence source: `ocr`

Before writing your findings, run `ocr review --format json` (falls back to
`ocr scan` if `review` is unavailable in this ocr version) against the
files in `previous_envelope.changed_files`, piping its output rather than
writing it to any path in the repo. Treat whatever it reports exactly like a
`git diff` hunk: evidence to weigh, in your own words, against the spec —
never a verdict you pass through. Fold anything it found that maps to a real
requirement into your own `findings`/`blocking`; ignore style opinions it
raises that the spec never asked about. You alone decide `approved` — ocr
has no vote. If `ocr` is not on `PATH` or the command errors, note that in
`notes_for_next_agent` and review from the diff alone; a missing second
opinion is not a blocking finding about the CODE.
```

And the config half, from (a):

```yaml
# .spf/spf.config.yaml
agents:
  - name: reviewer
    env_allowlist:
      - OCR_API_KEY
      - OCR_BASE_URL
```

That's the whole integration: one prompt file, one config patch, zero code.
