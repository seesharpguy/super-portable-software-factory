# Refine Task

## Variables

### prompt

{{prompt}}

### previous_envelope

{{previous_envelope}}

### context_handoff_dir

{{context_handoff_dir}}

## Task

Decompose the product spec in `prompt` into a feature/story-or-bug tree, following every rule in your system instructions (vertical slices, the `blocked_by` DAG, expand/migrate/contract for wide refactors, no "Blocked by"/"Parent" text of your own).

1. Explore the codebase only as far as you need to ground the decomposition in what actually exists.
2. Write your working notes to `<context_handoff_dir>/refine_plan.md`.
3. Emit your `Report` JSON, declaring that one file in `artifacts`.

## Report

Respond with ONLY valid JSON matching `RefineOutput` — no prose before or after:

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
  ]
}
```

Rules on the shape (enforced by a gate — a violation sends this back to you as a correction, not a silent acceptance):

- `key` is your own local id for this run, unique within `issues` — never a real tracker id.
- A node is a **container** (`kind: "epic"` or `"feature"`) exactly when some other node names it in `parent`; every other node is a **leaf** (`kind: "story"`, `"bug"`, or `"task"`) and must not be a container. At least one leaf is required.
- `parent` is another node's `key`, or `""` for a top-level feature/epic.
- `blocked_by` is a list of other nodes' `key`s — real dependencies only, and no cycles (through `parent` or `blocked_by`, or both together).
- `body` is `## What to build` then `## Acceptance criteria` only — no "Blocked by" or "Parent" section; those are rendered for you once every node has a real issue number.
