# Refine Task

## Variables

### prompt

{{prompt}}

`prompt` may include a `## Discussion on the spec issue` section — the spec issue's own comment thread, if it has one. On a first pass this is whatever discussion already existed before the spec was labeled ready; on a resumed pass (after you raised questions and a human answered) it's split into "Answers to your open questions (round N)" and "Earlier discussion." Treat the answers section as authoritative — see your system instructions on resuming.

`prompt` may also include a `## Priority` section, when the spec issue itself carries a priority label. Treat that as a **ceiling** for every node you produce — see your system instructions on priority. Its absence means no ceiling, not "assume p2."

### previous_envelope

{{previous_envelope}}

A scout's findings — an **index of where things live**, not an outline of what to build. Each entry names a file and the user-facing surface it participates in. Read them, then read the files yourself; a finding is a pointer, never a unit of work.

The findings are file-shaped because filesystems are. Your leaves are behavior-shaped. **If a leaf you are about to emit maps one-to-one onto a single finding, you have transcribed the index instead of decomposing the spec** — go back to the outcome sentence and find the behavior that file serves. Six findings routinely collapse into one leaf; that is the normal ratio, not a shortcut.

### context_handoff_dir

{{context_handoff_dir}}

## Task

Decompose the product spec in `prompt` into a feature/story-or-bug tree, following every rule in your system instructions (grounding, ask-don't-decide, the slice test, sizing and the budget, quality as a column not a row, the `blocked_by` DAG, expand/migrate/contract for wide refactors, no "Blocked by"/"Parent" text of your own).

1. Read the scout's findings in `previous_envelope`, then explore the codebase yourself as far as you need to ground the decomposition in what actually exists.
2. Decide which of three outcomes this round is: an unambiguous decomposition, material ambiguity to escalate, or a spec too large to build as one spec. These are mutually exclusive — see the three Report shapes below.
3. Before writing any `body`: count your leaves against the budget in your system instructions, and run "Before you emit." Over budget with no human answer already in the thread means Shape 3 (`split`), never Shape 1 with a shrunk-to-fit tree.
4. Write your working notes to `<context_handoff_dir>/refine_plan.md`.
5. Emit your `Report` JSON, declaring that one file in `artifacts`.

## Report

Respond with ONLY valid JSON matching `RefineOutput` — no prose before or after. Exactly one of `issues` / `questions` / `split` is non-empty; a gate rejects a Report that populates more than one.

**Shape 1 — the decomposition is unambiguous and fits: emit `issues`, leave `questions` and `split` empty.**

```json
{
  "status": "success",
  "summary": "<one sentence: how many leaves (= how many pull requests a human will review), how many containers, and the shape of the dependency chain>",
  "artifacts": ["<context_handoff_dir>/refine_plan.md"],
  "notes_for_next_agent": "<anything the publish step or a human reviewer should know>",
  "issues": [
    {
      "key": "F1",
      "kind": "feature",
      "title": "<feature title>",
      "user_outcome": "",
      "body": "## What to build\n\n<end-to-end behavior this feature covers>\n\n## Acceptance criteria\n\n- [ ] <criterion>",
      "parent": "",
      "blocked_by": [],
      "priority": "p1"
    },
    {
      "key": "S1",
      "kind": "story",
      "title": "<leaf title>",
      "user_outcome": "After this lands, <actor> can <observable thing> that they could not before.",
      "body": "## What to build\n\n<end-to-end behavior from the user's perspective>\n\n## Acceptance criteria\n\n- [ ] <criterion>\n- [ ] <behavior> is covered by tests added or updated in this slice\n- [ ] Manual check: <one-minute walkthrough>",
      "parent": "F1",
      "blocked_by": [],
      "priority": "p1"
    },
    {
      "key": "S2",
      "kind": "bug",
      "title": "<leaf title>",
      "user_outcome": "After this lands, <actor> can <observable thing> that they could not before.",
      "body": "## What to build\n\n<the fix, described end-to-end>\n\n## Acceptance criteria\n\n- [ ] <criterion>\n- [ ] <behavior> is covered by tests added or updated in this slice\n- [ ] Manual check: <one-minute walkthrough>",
      "parent": "F1",
      "blocked_by": ["S1"],
      "priority": "p2"
    }
  ],
  "questions": [],
  "split": []
}
```

**Shape 2 — something material is ambiguous: emit `questions`, leave `issues` and `split` empty.**

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
  ],
  "split": []
}
```

**Shape 3 — the spec honestly needs more slices than the budget allows: emit `split`, leave `issues` and `questions` empty.**

```json
{
  "status": "success",
  "summary": "<one sentence: splitting into N specs, and why>",
  "artifacts": ["<context_handoff_dir>/refine_plan.md"],
  "notes_for_next_agent": "<anything the split-execution step or a human reviewer should know>",
  "issues": [],
  "questions": [],
  "split": [
    {
      "title": "<a standalone spec's title>",
      "body": "<a complete spec, in the same shape as the one you were given — problem, proposed outcome, scope — for THIS slice of the original>",
      "rationale": "<why this is a coherent, independently shippable spec on its own, not a phase of the other proposed specs, and roughly how many leaves you expect it to decompose into>"
    },
    {
      "title": "<another standalone spec's title>",
      "body": "<...>",
      "rationale": "<...>"
    }
  ]
}
```

Rules on the shape (enforced by a gate — a violation sends this back to you as a correction, not a silent acceptance):

- `issues`, `questions`, and `split` are mutually exclusive: exactly one may be non-empty. Escalating (`questions`) or proposing a split (`split`) both mean publishing nothing this round.
- `key` is your own local id for this run, unique within `issues` — never a real tracker id.
- A node is a **container** (`kind: "epic"` or `"feature"`) exactly when some other node names it in `parent`; every other node is a **leaf** (`kind: "story"`, `"bug"`, or `"task"`) and must not be a container. At least one leaf is required. A container with exactly one child is rejected — a container exists to group two or more leaves, or it does not exist.
- `parent` is another node's `key`, or `""` for a top-level feature/epic.
- `blocked_by` is a list of other nodes' `key`s — real dependencies only, and no cycles (through `parent` or `blocked_by`, or both together).
- `user_outcome` is required on every leaf: one sentence, in the shape from "The slice test" in your system instructions. Optional (and normally left blank) on a container.
- `body` is `## What to build` then `## Acceptance criteria` only — no "Blocked by" or "Parent" section, and no `## Outcome`/user-outcome text either; `user_outcome` is its own field, and both are rendered for you once every node has a real issue number.
- `priority` is one of `p0`|`p1`|`p2`|`p3`, defaulting to `p2` if you omit it. No node may be more urgent than its parent, and no node may exceed the spec's priority where the `## Priority` section states one — a violation is clamped, not sent back as a correction, so state the priority you actually mean.
- `questions[].id` is your own local id for this round, unique within `questions` — stable enough that, on a resumed run, an answer in the thread can be matched back to the question it answers.
- `split` requires **2 or more** entries — a "split" into one is not a split, it's the same spec renamed. Each entry's `title`/`body`/`rationale` must be non-blank, and `rationale` should state your expected leaf count for that spec (it should fit the same budget on its own).
