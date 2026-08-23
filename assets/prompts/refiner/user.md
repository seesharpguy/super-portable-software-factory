# Refine Task

## Variables

### prompt

{{prompt}}

`prompt` may include a `## Discussion on the spec issue` section — the spec issue's own comment thread, if it has one. On a first pass this is whatever discussion already existed before the spec was labeled ready; on a resumed pass (after you raised questions and a human answered) it's split into "Answers to your open questions (round N)" and "Earlier discussion." Treat the answers section as authoritative — see your system instructions on resuming.

### previous_envelope

{{previous_envelope}}

A scout's findings — the subsystems this spec touches, one entry per file with a note on what's there. Read them, then read the files yourself; a scout finding is a pointer, not a substitute for grounding your own decomposition in the actual code.

### context_handoff_dir

{{context_handoff_dir}}

## Task

Decompose the product spec in `prompt` into a feature/story-or-bug tree, following every rule in your system instructions (grounding, ask-don't-decide, vertical slices, the `blocked_by` DAG, expand/migrate/contract for wide refactors, no "Blocked by"/"Parent" text of your own).

1. Read the scout's findings in `previous_envelope`, then explore the codebase yourself as far as you need to ground the decomposition in what actually exists.
2. Decide whether you can decompose the whole spec now, or whether something in it is genuinely ambiguous (see "Ask, don't decide"). These are mutually exclusive outcomes for this round — see the two Report shapes below.
3. Write your working notes to `<context_handoff_dir>/refine_plan.md`.
4. Emit your `Report` JSON, declaring that one file in `artifacts`.

## Report

Respond with ONLY valid JSON matching `RefineOutput` — no prose before or after. Exactly one of `issues` / `questions` is non-empty; the gate rejects a Report that populates both.

**Shape 1 — the decomposition is unambiguous: emit `issues`, leave `questions` empty.**

```json
{
  "status": "success",
  "summary": "<one sentence: how many features and how many leaves, and the shape of the dependency chain>",
  "artifacts": ["<context_handoff_dir>/refine_plan.md"],
  "notes_for_next_agent": "<anything the publish step or a human reviewer should know>",
  "issues": [
    {
      "key": "F1",
      "kind": "feature",
      "title": "<feature title>",
      "body": "## What to build\n\n<end-to-end behavior this feature covers>\n\n## Acceptance criteria\n\n- [ ] <criterion>",
      "parent": "",
      "blocked_by": []
    },
    {
      "key": "S1",
      "kind": "story",
      "title": "<leaf title>",
      "body": "## What to build\n\n<end-to-end behavior from the user's perspective>\n\n## Acceptance criteria\n\n- [ ] <criterion>\n- [ ] <criterion>",
      "parent": "F1",
      "blocked_by": []
    },
    {
      "key": "S2",
      "kind": "bug",
      "title": "<leaf title>",
      "body": "## What to build\n\n<the fix, described end-to-end>\n\n## Acceptance criteria\n\n- [ ] <criterion>",
      "parent": "F1",
      "blocked_by": ["S1"]
    }
  ],
  "questions": []
}
```

**Shape 2 — something material is ambiguous: emit `questions`, leave `issues` empty.**

```json
{
  "status": "success",
  "summary": "<one sentence: how many questions, and what they're about>",
  "artifacts": ["<context_handoff_dir>/refine_plan.md"],
  "notes_for_next_agent": "<anything a human answering these should know>",
  "issues": [],
  "questions": [
    {
      "id": "Q1",
      "question": "<the question, precise enough to answer in a word or two>",
      "why_it_matters": "<what goes wrong if this is guessed instead of decided>",
      "options": ["<plausible answer>", "<another plausible answer>"],
      "recommendation": "<your own best guess, if you have one>",
      "evidence": ["<file or symbol that framed this question>"]
    }
  ]
}
```

Rules on the shape (enforced by a gate — a violation sends this back to you as a correction, not a silent acceptance):

- `issues` and `questions` are mutually exclusive: a non-empty `questions` requires an empty `issues`, and vice versa. Escalating means publishing nothing this round.
- `key` is your own local id for this run, unique within `issues` — never a real tracker id.
- A node is a **container** (`kind: "epic"` or `"feature"`) exactly when some other node names it in `parent`; every other node is a **leaf** (`kind: "story"`, `"bug"`, or `"task"`) and must not be a container. At least one leaf is required.
- `parent` is another node's `key`, or `""` for a top-level feature/epic.
- `blocked_by` is a list of other nodes' `key`s — real dependencies only, and no cycles (through `parent` or `blocked_by`, or both together).
- `body` is `## What to build` then `## Acceptance criteria` only — no "Blocked by" or "Parent" section; those are rendered for you once every node has a real issue number.
- `questions[].id` is your own local id for this round, unique within `questions` — stable enough that, on a resumed run, an answer in the thread can be matched back to the question it answers.
