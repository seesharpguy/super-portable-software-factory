---
name: Super Portable Software Factory (SPF)
description: Runs read like a printed timetable; live traces behave like a departure board.
colors:
  # paper scale (sessions list)
  paper-cream: "#f6f3ec"
  paper-raised: "#fcfaf4"
  paper-sunk: "#ede8db"
  ink: "#211e14"
  ink-dim: "#5f5948"
  ink-faint: "#76705e"
  paper-rule: "#d8d2c0"
  paper-rule-soft: "#e6e1d0"
  # board scale (session trace)
  board-black: "#141311"
  board-raised: "#1e1c17"
  board-sunk: "#0c0b09"
  bone: "#efe8d4"
  bone-dim: "#96907c"
  bone-faint: "#857f6a"
  board-rule: "#37342b"
  board-rule-soft: "#2a2820"
  # accents — one per artifact, and they don't travel
  timetable-red: "#da291c"
  ballpoint: "#2545a8"
  board-amber: "#e8b64a"
  # signals — print-ink variants on paper, bright originals on the board
  pass-paper: "#1e7a3c"
  fail-paper: "#b3261e"
  pass-board: "#4ade80"
  fail-board: "#ff6f67"
typography:
  display:
    fontFamily: "Overpass, system-ui, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.2
  headline:
    fontFamily: "Overpass, system-ui, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "Overpass, system-ui, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Overpass, system-ui, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    letterSpacing: "0.06em"
  data:
    fontFamily: "'Overpass Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "16px"
    fontWeight: 400
    fontFeature: "'tnum'"
rounded:
  cell: "2px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "28px"
components:
  status-cell:
    textColor: "{colors.board-amber}"
    rounded: "{rounded.cell}"
    padding: "3px 10px"
  tag-stub:
    textColor: "{colors.bone}"
    rounded: "{rounded.cell}"
    padding: "2px 10px"
  phase-bay:
    textColor: "{colors.bone}"
    rounded: "{rounded.cell}"
    padding: "10px 12px"
---

# Design System: Super Portable Software Factory (SPF)

## Overview

**Creative North Star: "The Timetable."**

SPF's observability UI is railway operations made screen. It draws two artifacts from that world, split by what the engineer is doing:

- **The paper timetable** (light): the sessions list — the printed schedule you scan after the fact to catch up, review, and sign off. Ink on warm paper, tabular columns, hairline rules, one red accent carried the way Swiss Federal Railways carries red. Ballpoint blue appears only where live state has annotated the record.
- **The departure board** (dark): the live session trace — the board you watch while a run is in flight. Near-black ground, bone-white text, board amber as the single accent. Track numbers identify lanes; squared bays carry each phase; motion exists only on state change.

The world replaces the previous system wholesale — deep-space navy, gradient text, neon glows, aurora backdrop, glass blur. That recipe is this system's recorded anti-reference: the generic AI-tool look the trace exists to outrun. Product truth is load-bearing: the trace is the trust mechanism ("agent proposes, code disposes" made legible), the UI is read-only observability except the archive sign-off, and readability outranks expression (Operate mode).

**Key Characteristics:**
- One paper surface, one board surface — each owns its accent, and the accents never cross over.
- Depth from hairline rules and tabular alignment; no shadows, no glow, no blur, no gradients.
- Color is signal: green/red are verdicts, amber is board-live; everything else is ink or bone.
- The board flips on state change; the paper never moves at all.

## Colors

The palette is two restrained neutral scales, one accent each, and a quarantined pair of signal hues — color that is not signal or wayfinding does not exist here.

### Primary
- **Board Amber** (#e8b64a): the live mark of the departure board — running phase borders, the pulsing glyph, the `REQUEST` zone header, selected outlines, focus rings in trace view. 10:1 on board-black.
- **Timetable Red** (#da291c): the paper's wayfinding accent — the middle stripe of the station-code mark, the archive action on hover, focus rings in list view. SBB/DB signage lineage; never fills, always thin.
- **Ballpoint** (#2545a8): the hand annotating the record — italic running status word on paper, the `live` marker in the paper masthead, links. 7.6:1 on paper-cream.

### Neutral
- **Paper Cream** (#f6f3ec) / **Paper Raised** (#fcfaf4) / **Paper Sunk** (#ede8db): the list's ground, row-hover face, and wells.
- **Ink** (#211e14) / **Ink Dim** (#5f5948, 6.2:1) / **Ink Faint** (#76705e, ~4.5:1 — the meta-text floor): the paper's type. Nearly black-green; never pure black, which would lie about the print.
- **Paper Rule** (#d8d2c0) / **Paper Rule Soft** (#e6e1d0): the printed hairlines.
- **Board Black** (#141311) / **Board Raised** (#1e1c17) / **Board Sunk** (#0c0b09): the trace's ground, bay faces, and the axis strip.
- **Bone** (#efe8d4, 15:1) / **Bone Dim** (#96907c, 6.1:1) / **Bone Faint** (#857f6a, ~4.9:1): the board's type — pale letterpress on Bakelite, not white phosphor.
- **Board Rule** (#37342b) / **Board Rule Soft** (#2a2820): the board's hairlines.

### Signal
- **Pass Green** (#1e7a3c on paper / #4ade80 on board): a recorded success — status words, remark glyphs, gate and check marks.
- **Fail Red** (#b3261e on paper / #ff6f67 on board): a recorded failure — same vocabulary, always the louder half of a scan line.

The bright board variants only survive contrast on the dark ground; paper prints them as darker inks. Never reuse a signal hue as decoration, and never soften one ("greenish") — a washed signal reads as a maybe.

### Named Rules
**The Accents Don't Travel Rule.** Red and ballpoint live on paper; amber lives on the board. A red element inside the trace is a failure, not a flourish; an amber tint on the list is a stain. New accents require a new artifact, not a new hue on this palette.

**The Color Is Signal Rule.** Outside each surface's one accent, hue only ever means data state — green passed, red failed, amber live. Event types, agents, and lanes get no colors of their own; they get names, numbers, and words. The moment a color answers "which one" instead of "what happened," the build is off-system.

## Typography

**Body & Display Font:** Overpass (system-ui → Helvetica Neue → Arial)
**Data Font:** Overpass Mono (ui-monospace → SF Mono → Menlo → Consolas)
Both self-hosted, latin woff2, weights 400/600/700 (mono: 400/700).

**Character:** Overpass is signage in the Interstate/Red Hat lineage — engineered plainness with open apertures, the face of a printed public document. Overpass Mono is its ledger companion: tabular by default, set only where the reader counts.

### Hierarchy
- **Display** (700, 20px, 1.2): section announcements that anchor a viewport — "departures", the phase name in a detail head.
- **Headline** (700, 17px): phase names on bays, run-strip request text, panel titles. The strongest recurring line in the app.
- **Body** (400, 16px, 1.5): everything the engineer reads — row cells, descriptions, section copy. Wraps, so measures stay in their columns.
- **Label** (600, 16px, tracked 0.06–0.08em): uppercase column heads and section titles on the board; lowercase tracked heads on paper. Never colored except dim/faint.
- **Data** (Overpass Mono 400/700, 16px, `tnum`): ids, clocks, durations, costs, token counts, track numbers, code, payload blocks. Right-aligned in numeric columns; 700 only when the value is an identity (the run id).

### Named Rules
**The Data Voice Rule.** Mono is for code, data, and measurement — never prose, never buttons' body copy, never a "techy" costume. A sentence wearing mono is a misprint.

**The Floor Is Sixteen Rule.** Nothing renders below 16px, anywhere. Density comes from hairlines, alignment, and tabular numerals — never from shrinking the type. A design that needs 13px needs a different layout.

## Layout

Two fixed grammars, one per artifact, both built on the same masthead.

**The masthead** is sticky: the station-code mark (a squared plate with three strips, middle stripe in the surface accent), the wordmark with breadcrumbs, then the `live` indicator. A 4px double ink rule closes the paper masthead; the board takes a single hairline.

**The paper timetable** is one grid template (`--tt-columns`) shared by the header and every row: departed clock / run id / service / request / phase count + remark glyphs / status word / cost / runtime / tokens, with numbers right-aligned in the data voice. Rows separate on hairline rules only — no cards, no gaps. Section padding sits at 28px page margins, 8–18px within rows.

**The departure board** is a board: a run strip (request, status word, totals), then a bordered board panel of track lanes — a 250px label column (track number, name, model, context meter) against a track. The engineer's request owns an exclusive opening zone (24% of the track), and every later phase maps into the rest; the axis divides into readable steps in the data voice. Phase bays shift laterally rather than overlap — blocks may squeeze a hair, they never stack.

**Responsive:** at ≤980px the paper folds to a stacked three-column row with a mono meta line; the board pans — `.waterfall` scrolls horizontally at a 700px floor rather than compressing illegibly — and the detail folio stacks to one column at ≤1100px.

### Named Rules
**The Request Is the Origin Rule.** Every trace begins with what the human asked, and the board reserves it an exclusive zone nothing else may enter. Phase bays map into the remaining track; a layout that lets a phase squat on the request's ground has inverted the trust model the trace exists to show.

**The Board Pans Rule.** Below the 980px fold a wide board keeps its full track width and scrolls, the way you read a wall-mounted board by walking along it. Never shrink a board into columns too narrow to read.

**The Number Names, Not Amputates Rule.** A reserved zone or column must be wide enough to carry its content's full identity — the request block always reads "request", never "re…". If truncation is noise, widen the structure; ellipsis is reserved for genuinely unbounded text (requests, descriptions).

## Elevation & Depth

This system has **no shadows at all** — no ambient, no hover, no glow, no blur. Depth is read from hairline structure and tonal layering within each scale: ground, raised face, sunk inset, soft rule, hard rule. State adds a 2px outline (selected) or a signal border (running, failed), never a lift.

The one exception the world itself owns: a status change on the board flips — a short rotateX settle (280ms) that is material behavior, not decoration. Under `prefers-reduced-motion` every animation in the app is removed.

### Named Rules
**The Hairline Rule.** Structure is drawn with 1px rules, 1px gaps, weight, and alignment — nothing else. Reach for a shadow, a blur, or a gradient and you have left the system; reach for a thicker rule, a tone step, or whitespace and you have not.

## Shapes

Everything is a printed cell or a board bay: corners at a hair's radius (2px), borders at 1px. Pills, pills-half, hero blob, and rounded-card geometry do not exist. The two round forms in the whole system are the board's pulsing `live` dot (a lamp, which is round in the world) and the phase remark glyphs — and glyphs are type, not shapes.

Buttons, chips, tags, gates, prompt panels, and the board frame all share the same 2px cell. Squaring is the signature: if something looks hand-placed and soft-edged, it is off-system.

## Components

### Buttons
There is no filled primary button; actions are typographic or single-glyph icons — never both on the same control.
- **Shape:** square cell (2px) with a 1px rule border, or no border at all.
- **Action words** (close, rendered/raw toggles): data-voice or plain text, faint at rest, accent underline or accent on hover (padding 2px 12px).
- **Action icons** (per-row archive): a bare Lucide glyph (2px stroke, faint at rest), no visible border until hover, when it takes a 1px rule border and the surface accent color — same hover language as an action word, spent on a glyph instead of an underline so it survives at row scale without adding a word to every line.
- **Disabled/loading:** the poll surface — an "api unreachable — retrying" bar in the fail signal, inline, no spinner theater.

### Chips — status cells
- **Style:** transparent square cell (2px, 1px border in the surface rule) carrying a state word in the data voice: success/fail/running/queued at 600 weight.
- **State:** on the board the label is re-mounted when the poll flips status, so the change plays as a split-flap settle; the running glyph pulses, board-only.

### Chips — stat cells
- **Style:** hairline-bordered square cell: a line icon in faint plus a tabular mono value. The `compact` variant drops the border to sit inside bays and ledgers. Icons are Lucide in one 1.5–2px stroke — glyphs and emoji are never icons.

### Departure row (paper, list item)
- **Style:** a baseline-aligned grid row on `--tt-columns`, border-bottom hairline, whole row is the link. Status word printed in signal ink — running in italic ballpoint. The phases cell prints the exact done/total count in the data voice plus a bounded strip of remark glyphs (max 4–6, tuned to the column); a run with more phases than the strip can carry collapses the overflow into a mono "+N" rather than stretching the column — but any failed phase always keeps its glyph, even past that cap, so a red mark is never buried in the count.
- **State:** hover raises the row one tonal step (paper-raised); the archive icon sits right, faint at rest, reddening under a hovered cursor.

### Phase bay (board, card)
- **Style:** 92px-tall squared bay (2px, 1px border) on the track: status glyph, name (700), duration chip, description, tool ticks along the lower edge.
- **State:** running takes the amber border and amber name; failed takes the fail border; queued is dashed-and-transparent; selected gets a 2px amber outline. Hue is the state, never the lane.

### Track lane label
- **Style:** 250px column: mono track number (01, 02…) in faint, line icon, lane name in bone 700, then model and a hairline context-occupancy meter — a 6px bar filling via scaleX, amber only while the lane is live.

### Tag stub
- **Style:** square bordered cell (2px, soft rule, inset ground) with a faint key and a bone value — used in detail heads, gate lines, output lines. 16px, baseline-aligned.

### Gate row
- **Style:** square inset cell (2px) whose verdict lives on a tinted hairline: passing gates keep the plain rule; failing gates take the 1px fail-colored border, with ✓/✗ marks and violations listed in the fail signal. Checks expand underneath on a hairline.

### Detail folio & sections
- **Style:** the phase detail is a board-material folio (squared, hairline frame) of collapsible sections: mono chevron ▸/▾, uppercase tracked label, hairline header — closed by default so the engineer opens exactly what they need. The events column is one continuous mono ledger: time, type, the exact call, its cost.

### Masthead / navigation
- **Style:** sticky bar, station-code svg mark plus wordmark; breadcrumbs (wordmark › run id › phase name) truncate with ellipsis on narrow glass rather than wrapping. The `live` indicator: a static square ballpoint pip on paper, a round pulsing amber lamp on the board.

## Do's and Don'ts

### Do:
- **Do** let semantic tokens do the traveling: components bind to `--ground/--face/--inset/--fg/--dim/--faint/--rule/--rule-soft/--accent/--live/--pass/--fail`, and `body.board` swaps the whole surface — components never reference raw hues.
- **Do** right-align numbers in columns, keep them tabular, and give every duration/cost/token figure the data voice.
- **Do** identify lanes by track number and name; attribute by position, never by hue.
- **Do** draw structure with 1px rules in `--rule` / `--rule-soft`, and separate hover states by one tonal step (`--face`/`-raised`).
- **Do** theme the browser surfaces you did not draw: selection colors, scrollbars, focus rings, caret — they all carry the surface's signal.

### Don't:
- **Don't** add shadows, glow, gradients, blur, or translucency overlays — the Hairline Rule covers everything a shadow would have claimed.
- **Don't** animate the paper. Nothing on the sessions list pulses, slides, or fades; live annotation is a still ballpoint mark. Motion belongs to the board, and only on state change.
- **Don't** carry an accent across artifacts: no red on the board, no amber on the paper — the two surfaces' accents are quarantined per world.
- **Don't** assign colors to agents, event types, or lanes; hue is reserved for status and signals, full stop.
- **Don't** set any text below 16px, use mono for prose, or reach for pills and big radii — these were the tells of the retired system.
