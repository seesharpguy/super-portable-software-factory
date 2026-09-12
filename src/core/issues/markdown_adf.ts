/**
 * A hand-rolled Markdown <-> Atlassian Document Format (ADF) converter for
 * Jira comment/description bodies — deliberately NOT built on a markdown
 * parsing library. This project has zero markdown dependencies today and
 * that's a deliberate choice (see `package.json`): `jira_provider.ts`'s own
 * `toAdf`/`adfToText` pair is the existing precedent (one paragraph of
 * plain text, nothing richer), and this module is the same philosophy
 * extended to a small, explicitly-bounded Markdown subset, not a general
 * CommonMark implementation.
 *
 * SUPPORTED (confirmed scope, see the module's originating task — do not
 * silently grow this list): ATX headings (`#`..`######`), bold
 * (`**x**`/`__x__`), italic (`*x*`/`_x_`), strikethrough (`~~x~~`), inline
 * code (`` `x` ``), fenced code blocks with optional language, bullet
 * (`-`/`*`/`+`) and ordered (`1.`) lists with ONE level of nesting,
 * blockquotes (consecutive `>` lines as one block), horizontal rules
 * (`---`/`***`/`___` alone on a line), links (`[text](url)`), paragraphs
 * separated by blank lines, and hard line breaks (a line ending in two-plus
 * trailing spaces, or a lone trailing backslash).
 *
 * OUT OF SCOPE (tables, images, @mentions, raw HTML, nested blockquotes-in-
 * lists, >1 level of list nesting): never crashes and never corrupts
 * structure on these — `markdownToAdf` falls through to literal text in a
 * plain paragraph (matching `toAdf`'s existing behavior for "everything"
 * before this module existed), and `adfToMarkdown` degrades any node/mark
 * type it doesn't recognize to its nested text content. `markdownToAdf`
 * must NEVER throw on any input string — a malformed fence, an unmatched
 * `**`, an empty link target, all degrade to literal text rather than
 * erroring, because this runs unattended inside `spf watch`.
 *
 * ADF node/mark shapes below are taken from Atlassian's published document
 * structure (developer.atlassian.com/cloud/jira/platform/apis/document/
 * structure/), not guessed — in particular the strikethrough mark's real
 * type name is `"strike"`, NOT `"strikethrough"` (an easy guess to get
 * wrong), and ADF text nodes must never carry an empty `text` string (the
 * schema requires non-empty), which is why every text-emitting path here
 * checks for empty content before emitting a node instead of always
 * emitting one unconditionally the way `jira_provider.ts`'s `toAdf` does
 * for its single fixed paragraph.
 */

type AdfNode = Record<string, unknown>;
type AdfMark = { type: string; attrs?: Record<string, unknown> };

/**
 * Canonical mark order, used both when building a text node's `marks`
 * array (so two equivalent inputs always produce byte-identical mark
 * ordering — load-bearing for round-trip stability, since
 * `assert.deepEqual`-style comparison and re-parsing both depend on a
 * single canonical shape rather than "any order that happens to result
 * from parse order") and when reading one back. `code` sits last because
 * `renderTextNode` (below) treats it as exclusive of the others — see that
 * function's own comment.
 */
const MARK_ORDER = ["link", "strong", "em", "strike", "code"] as const;

function addMark(marks: readonly AdfMark[], mark: AdfMark): AdfMark[] {
  if (marks.some((m) => m.type === mark.type)) return [...marks]; // already applied (e.g. `**a**` nested inside another `**...**`) — don't duplicate
  const next = [...marks, mark];
  return next.sort((a, b) => MARK_ORDER.indexOf(a.type as (typeof MARK_ORDER)[number]) - MARK_ORDER.indexOf(b.type as (typeof MARK_ORDER)[number]));
}

function makeText(text: string, marks: readonly AdfMark[]): AdfNode | null {
  if (text.length === 0) return null; // ADF text nodes must be non-empty — silently drop, never emit `{type:"text",text:""}`
  const node: AdfNode = { type: "text", text };
  if (marks.length > 0) node["marks"] = marks.map((m) => (m.attrs ? { type: m.type, attrs: m.attrs } : { type: m.type }));
  return node;
}

/**
 * CommonMark-style "flanking delimiter run" rules for a single `*`/`_`
 * character, applied at the character immediately before/after it. Without
 * these, ANY `*`/`_` paired with the next occurrence of the same character
 * regardless of context — which is what let a bare multiplication `*`
 * between spaces (`2 * 3`) and a `snake_case`/`file_path.ts` identifier's
 * underscores get silently paired up and italicized across unrelated words.
 * `_` additionally can't open/close when it's flanking on BOTH sides
 * without adjacent punctuation (the "intraword underscore" rule — real
 * Markdown never treats `foo_bar_baz` as emphasis); `*` has no such
 * restriction, matching CommonMark's own intraword-`*emphasis*` allowance.
 */
function isWsBoundary(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}
function isPunctBoundary(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{P}\p{S}]/u.test(ch);
}
function isLeftFlanking(before: string | undefined, after: string | undefined): boolean {
  if (isWsBoundary(after)) return false;
  if (!isPunctBoundary(after)) return true;
  return isWsBoundary(before) || isPunctBoundary(before);
}
function isRightFlanking(before: string | undefined, after: string | undefined): boolean {
  if (isWsBoundary(before)) return false;
  if (!isPunctBoundary(before)) return true;
  return isWsBoundary(after) || isPunctBoundary(after);
}
function canOpenEmphasis(ch: "*" | "_", before: string | undefined, after: string | undefined): boolean {
  if (!isLeftFlanking(before, after)) return false;
  if (ch === "*") return true;
  return !isRightFlanking(before, after) || isPunctBoundary(before);
}
function canCloseEmphasis(ch: "*" | "_", before: string | undefined, after: string | undefined): boolean {
  if (!isRightFlanking(before, after)) return false;
  if (ch === "*") return true;
  return !isLeftFlanking(before, after) || isPunctBoundary(after);
}

/**
 * Characters a `\`-prefixed occurrence should parse as a plain literal
 * character rather than markup (standard Markdown backslash-escaping —
 * e.g. `\*not italic\*`). Two groups share this one set:
 *  - INLINE delimiters this module's tokenizer treats specially inside a
 *    line (`` ` * _ ~ [ ] ( ) ``), for input Markdown source that wants a
 *    literal one of these;
 *  - BLOCK-start markers (`- + # > .`) that only matter at column 0 of a
 *    line — `escapeParagraphLine` (this module's render side) uses these
 *    to stop a rendered paragraph line from being reparsed as a
 *    fence/rule/heading/blockquote/list; see that function's comment.
 * `adfToMarkdown` deliberately does NOT escape the first (inline) group on
 * the way out for plain text — see `renderTextNode`'s comment on why.
 */
const ESCAPABLE_INLINE_CHARS = new Set(["\\", "`", "*", "_", "~", "[", "]", "(", ")", "-", "+", "#", ">", "."]);

/**
 * The inline tokenizer. Recursive-descent over the raw string: each
 * delimiter (code span, link, bold, italic, strike) is resolved by
 * scanning forward for its matching close and, if found, recursing on the
 * inner text with the new mark added — which is what lets `**a *b* c**`
 * nest italic inside bold correctly (the inner recursive call sees the
 * accumulated `[strong]` marks list). If no matching close exists (an
 * unterminated `**`, a `[` with no `](url)`), the opening characters fall
 * through to plain buffered text — the same "degrade to literal, never
 * throw" rule the module comment describes, applied at the character
 * level instead of the block level.
 *
 * Bold-vs-italic precedence: `**`/`__` are checked (via `startsWith`)
 * BEFORE the single-char `*`/`_` case, so `**x**` is never misread as two
 * adjacent unmatched italics. Images (`![alt](url)`) are deliberately
 * excluded from link detection by checking the character before `[` isn't
 * `!` — without that check an image would silently become a LINK (a
 * structural corruption, not a safe literal fallback); with it, the whole
 * `![alt](url)` run falls through untouched as literal text, per the
 * out-of-scope contract above.
 *
 * `\u0000` is a private sentinel `buildParagraphSource` uses to mark a
 * hard line break's position — chosen because real Markdown input can't
 * contain a literal NUL, so it can never collide with real content.
 */
function parseInlineWithMarks(text: string, marks: readonly AdfMark[]): AdfNode[] {
  const nodes: AdfNode[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    const node = makeText(buf, marks);
    if (node) nodes.push(node);
    buf = "";
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\u0000") {
      flush();
      nodes.push({ type: "hardBreak" });
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length && ESCAPABLE_INLINE_CHARS.has(text[i + 1]!)) {
      // A backslash-escaped metacharacter in the INPUT: consume both and
      // emit the next char as plain literal content, never as a delimiter.
      // Must be checked before every delimiter branch so e.g. `\*` can
      // never be misread as an opening `*`.
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      if (close !== -1) {
        flush();
        const code = text.slice(i + 1, close);
        const node = makeText(code, addMark(marks, { type: "code" }));
        if (node) nodes.push(node);
        i = close + 1;
        continue;
      }
    }
    if (ch === "[" && text[i - 1] !== "!") {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        // An empty `href` (`[docs]()`) is NOT a valid ADF link mark — Jira's
        // ADF validator requires a non-empty URL and would 400 the whole
        // request, unlike every other malformed construct here, which
        // degrades to literal text. So an empty (or whitespace-only) target
        // falls through to literal text too, same as an unmatched bracket.
        if (closeParen !== -1 && text.slice(closeBracket + 2, closeParen).trim().length > 0) {
          flush();
          const linkText = text.slice(i + 1, closeBracket);
          const href = text.slice(closeBracket + 2, closeParen);
          nodes.push(...parseInlineWithMarks(linkText, addMark(marks, { type: "link", attrs: { href } })));
          i = closeParen + 1;
          continue;
        }
      }
    }
    if (text.startsWith("**", i) || text.startsWith("__", i)) {
      const delim = text.slice(i, i + 2);
      const close = text.indexOf(delim, i + 2);
      if (close !== -1) {
        flush();
        nodes.push(...parseInlineWithMarks(text.slice(i + 2, close), addMark(marks, { type: "strong" })));
        i = close + 2;
        continue;
      }
    }
    if (text.startsWith("~~", i)) {
      const close = text.indexOf("~~", i + 2);
      if (close !== -1) {
        flush();
        nodes.push(...parseInlineWithMarks(text.slice(i + 2, close), addMark(marks, { type: "strike" })));
        i = close + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      const openBefore = i > 0 ? text[i - 1] : undefined;
      const openAfter = i + 1 < text.length ? text[i + 1] : undefined;
      if (canOpenEmphasis(ch, openBefore, openAfter)) {
        // Scan forward for the NEAREST same-character delimiter that is
        // itself flanking-valid to close (not just "the next occurrence of
        // the char", which is what let `*`/`_` pair across unrelated words
        // — see `canOpenEmphasis`/`canCloseEmphasis` above).
        let close = -1;
        for (let j = i + 1; j < text.length; j++) {
          if (text[j] !== ch) continue;
          if (j <= i + 1) continue; // no empty-content emphasis
          const closeBefore = text[j - 1];
          const closeAfter = j + 1 < text.length ? text[j + 1] : undefined;
          if (canCloseEmphasis(ch, closeBefore, closeAfter)) {
            close = j;
            break;
          }
        }
        if (close !== -1) {
          flush();
          nodes.push(...parseInlineWithMarks(text.slice(i + 1, close), addMark(marks, { type: "em" })));
          i = close + 1;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return nodes;
}

/**
 * Strips a hard-break marker from one raw line — either a trailing
 * backslash or two-or-more trailing spaces — and reports whether one was
 * found. A trailing `\\` (escaped backslash, i.e. a literal backslash the
 * author meant to keep) is deliberately NOT treated as a break: only an
 * ODD-length run of trailing backslashes ends in an unescaped one.
 */
function stripHardBreakMarker(line: string): { content: string; hardBreak: boolean } {
  const backslashes = /\\+$/.exec(line);
  if (backslashes && backslashes[0].length % 2 === 1) {
    return { content: line.slice(0, -1), hardBreak: true };
  }
  const spacesMatch = / {2,}$/.exec(line);
  if (spacesMatch) {
    return { content: line.slice(0, line.length - spacesMatch[0].length), hardBreak: true };
  }
  return { content: line, hardBreak: false };
}

/**
 * Two adjacent lines that both look like pipe-delimited table rows must
 * NOT be soft-joined with a space — tables are out-of-scope syntax (module
 * comment), and this module's contract for out-of-scope constructs is that
 * they "never corrupt structure", not that they get flattened. A real
 * (un-blank-line-separated) Markdown table fed through the old plain-space
 * join collapsed `"| a | b |\n| - | - |\n| 1 | 2 |"` into one line —
 * destroying it in both the Jira description AND the `Issue.body` later
 * read back for the agent prompt — regressing the OLD `toAdf`/`adfToText`
 * pair's verbatim round-trip for exactly this content. Preserving each row
 * on its own visual line (via the same hardBreak sentinel a real hard
 * break uses) is the best this constrained subset can do without adding a
 * real ADF table node, but it keeps the rows intact and readable instead of
 * mashing them together. Ordinary hard-wrapped prose (no `|`) is
 * deliberately unaffected — soft-joining that IS correct Markdown
 * behavior, tested elsewhere in this module.
 */
function looksLikeTableRow(line: string): boolean {
  return line.includes("|");
}

/**
 * Joins a paragraph's raw lines into one source string for
 * `parseInlineWithMarks`, inserting the `\u0000` hard-break sentinel where
 * a line ended with a break marker (or where both it and the next line look
 * like table rows — see `looksLikeTableRow`), or a plain space otherwise —
 * "otherwise consecutive non-blank lines join as one paragraph, matching
 * how Markdown actually works" (a soft line break renders as a space, not
 * a newline).
 */
function buildParagraphSource(lines: readonly string[]): string {
  const parts: string[] = [];
  lines.forEach((line, idx) => {
    const { content, hardBreak } = stripHardBreakMarker(line);
    parts.push(content);
    if (idx < lines.length - 1) {
      const preserveLine = hardBreak || (looksLikeTableRow(content) && looksLikeTableRow(lines[idx + 1]!));
      parts.push(preserveLine ? "\u0000" : " ");
    }
  });
  return parts.join("");
}

function makeParagraph(lines: readonly string[]): AdfNode {
  return { type: "paragraph", content: parseInlineWithMarks(buildParagraphSource(lines), []) };
}

/**
 * A paragraph whose text is NOT run through `parseInlineWithMarks` at
 * all — for fallback cases where a line must render as truly literal text
 * rather than "safe but still markdown-interpreted" text. Needed because a
 * malformed construct can itself contain characters (odd backtick counts,
 * in particular — an unterminated ` ``` ` fence line has three backticks,
 * an odd number that the inline code-span scanner would otherwise pair up
 * wrongly, e.g. into an empty code span plus a stray literal backtick)
 * that the normal inline scanner would reinterpret rather than preserve.
 */
function literalParagraph(line: string): AdfNode {
  const node = makeText(line, []);
  return { type: "paragraph", content: node ? [node] : [] };
}

function makeHeading(level: number, text: string): AdfNode {
  return { type: "heading", attrs: { level }, content: parseInlineWithMarks(text, []) };
}

function makeCodeBlock(code: string, language: string | undefined): AdfNode {
  const node: AdfNode = { type: "codeBlock" };
  if (language) node["attrs"] = { language };
  if (code.length > 0) node["content"] = [{ type: "text", text: code }];
  return node;
}

function makeBlockquote(lines: readonly string[]): AdfNode {
  return { type: "blockquote", content: [makeParagraph(lines)] };
}

function matchBullet(line: string): { indent: number; text: string } | null {
  const m = /^( *)([-*+]) +(.*)$/.exec(line);
  return m ? { indent: m[1]!.length, text: m[3]! } : null;
}

function matchOrdered(line: string): { indent: number; text: string; start: number } | null {
  const m = /^( *)(\d+)\. +(.*)$/.exec(line);
  return m ? { indent: m[1]!.length, text: m[3]!, start: parseInt(m[2]!, 10) } : null;
}

function isFenceOpen(line: string): boolean {
  return /^```(\S*)\s*$/.test(line);
}

function isRule(line: string): boolean {
  return /^(-{3,}|\*{3,}|_{3,})$/.test(line.trim());
}

function isHeading(line: string): boolean {
  return /^#{1,6}(\s|$)/.test(line);
}

/** Whether `line` starts a new (non-paragraph) block — used to stop paragraph-line accumulation before it swallows the next heading/list/etc. */
function isBlockStart(line: string): boolean {
  if (isFenceOpen(line)) return true;
  if (isRule(line)) return true;
  if (isHeading(line)) return true;
  if (/^>/.test(line)) return true;
  const b = matchBullet(line);
  if (b && b.indent === 0) return true;
  const o = matchOrdered(line);
  if (o && o.indent === 0) return true;
  return false;
}

/** Finds the closing ` ``` ` line at or after `from`; returns -1 (never throws/loops) if the fence is never closed. */
function findFenceClose(lines: readonly string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === "```") return i;
  }
  return -1;
}

/**
 * Parses one list (bullet or ordered) starting at `lines[start]`, whose
 * marker sits at `indent` columns. Supports exactly ONE level of nesting:
 * immediately after an item's own line, if the next line is a list marker
 * (either kind) indented deeper than `indent`, it's parsed as one nested
 * list and attached as the item's second content block — a further-nested
 * marker inside THAT recursive call would need an even deeper indent than
 * the nested list's own base, which nothing here ever requests, so nesting
 * naturally bottoms out at one level rather than needing an explicit depth
 * check.
 */
function parseList(lines: readonly string[], start: number, indent: number): { node: AdfNode; nextIndex: number } {
  const ordered = matchOrdered(lines[start]!) !== null && matchBullet(lines[start]!) === null;
  const items: AdfNode[] = [];
  let i = start;
  let orderStart: number | undefined;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") break; // v1 simplification: a blank line ends the list rather than starting a "loose" list
    const match = ordered ? matchOrdered(line) : matchBullet(line);
    if (!match || match.indent !== indent) break;
    if (ordered && orderStart === undefined) orderStart = matchOrdered(line)?.start;
    i++;
    const itemContent: AdfNode[] = [makeParagraph([match.text])];
    if (i < lines.length) {
      const nestedBullet = matchBullet(lines[i]!);
      const nestedOrdered = matchOrdered(lines[i]!);
      const nested = nestedBullet ?? nestedOrdered;
      if (nested && nested.indent > indent) {
        const sub = parseList(lines, i, nested.indent);
        itemContent.push(sub.node);
        i = sub.nextIndex;
      }
    }
    items.push({ type: "listItem", content: itemContent });
  }
  const node: AdfNode = ordered
    ? { type: "orderedList", ...(orderStart !== undefined && orderStart !== 1 ? { attrs: { order: orderStart } } : {}), content: items }
    : { type: "bulletList", content: items };
  return { node, nextIndex: i };
}

function parseBlocks(lines: readonly string[]): AdfNode[] {
  const nodes: AdfNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }

    if (isFenceOpen(line)) {
      const closeIdx = findFenceClose(lines, i + 1);
      if (closeIdx !== -1) {
        const lang = /^```(\S*)/.exec(line)![1];
        nodes.push(makeCodeBlock(lines.slice(i + 1, closeIdx).join("\n"), lang || undefined));
        i = closeIdx + 1;
        continue;
      }
      // Unterminated fence — fall back to literal text for just this line, not the whole rest of the document.
      nodes.push(literalParagraph(line));
      i++;
      continue;
    }

    if (isRule(line)) {
      nodes.push({ type: "rule" });
      i++;
      continue;
    }

    const headingMatch = /^(#{1,6})(?:\s+(.*))?$/.exec(line);
    if (headingMatch) {
      nodes.push(makeHeading(headingMatch[1]!.length, (headingMatch[2] ?? "").trim()));
      i++;
      continue;
    }

    if (/^>/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ""));
        i++;
      }
      nodes.push(makeBlockquote(quoteLines));
      continue;
    }

    const bullet = matchBullet(line);
    const ordered = matchOrdered(line);
    if ((bullet && bullet.indent === 0) || (ordered && ordered.indent === 0)) {
      const { node, nextIndex } = parseList(lines, i, 0);
      nodes.push(node);
      i = nextIndex;
      continue;
    }

    const paraLines: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== "" && !isBlockStart(lines[i]!)) {
      paraLines.push(lines[i]!);
      i++;
    }
    nodes.push(makeParagraph(paraLines));
  }
  return nodes;
}

/**
 * Parses the constrained Markdown subset (module comment) into an ADF
 * document node. Never throws: every unrecognized or malformed construct
 * degrades to literal text inside a plain paragraph rather than raising,
 * because this feeds `spf watch`'s unattended comment/description writes.
 */
export function markdownToAdf(text: string): unknown {
  const lines = text.split(/\r\n|\r|\n/);
  const content = parseBlocks(lines);
  return { type: "doc", version: 1, content: content.length > 0 ? content : [{ type: "paragraph", content: [] }] };
}

function renderFallbackText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (n.type === "text" && typeof n.text === "string") return n.text;
  if (Array.isArray(n.content)) return n.content.map(renderFallbackText).join("");
  return "";
}

/**
 * Renders one text node with its marks back to Markdown. `code` is treated
 * as exclusive of the other marks — real Jira/CommonMark editors don't let
 * you combine inline code with bold/italic/strike/link either, so a text
 * node built with `code` alongside another mark (reachable only via a hand-
 * built ADF doc, never via this module's own `markdownToAdf`) renders as
 * just the code span; that's a deliberate, documented lossy edge, not a
 * bug — `adfToMarkdown(markdownToAdf(x))` re-parsed a second time still
 * converges, which is the only round-trip guarantee this module promises.
 *
 * `em` renders as `_..._` instead of `*...*` specifically when `strong` is
 * ALSO present: rendering both with `*` would emit an ambiguous triple-run
 * (`***text***`), which the recursive-descent parser above cannot reliably
 * re-split back into nested strong+em (a classic CommonMark delimiter-
 * ambiguity case) — breaking the round-trip convergence guarantee. `_` is
 * safe here specifically because it's nested inside strong's own `**`
 * delimiters, so there's no surrounding word-adjacency for the intraword-
 * underscore rule to reject; a standalone `em` (no `strong`) keeps using
 * `*` so intraword emphasis (`foo*bar*baz`) still round-trips.
 *
 * Deliberately does NOT backslash-escape stray `*`/`_`/`` ` ``/`~`/`[`
 * bytes in plain (unmarked) text: `adfToMarkdown` is this codebase's ONE
 * ADF-to-text implementation (see `jira_provider.ts`'s module comment),
 * shared with `findMarkerComment`/`readMarker`'s `[spf-watch-marker]` JSON
 * payload, which is read back via a direct regex + `JSON.parse` on this
 * function's output — never re-fed through `markdownToAdf`. Escaping here
 * would inject literal backslashes into that JSON's underscores/brackets
 * and corrupt it. The flanking-delimiter rules in `parseInlineWithMarks`
 * already keep ordinary stray metacharacters in prose from being misread
 * as markup on re-parse, without needing that.
 */
function renderTextNode(text: string, marksRaw: readonly unknown[]): string {
  const marks = marksRaw.filter((m): m is AdfMark => Boolean(m) && typeof m === "object" && typeof (m as { type?: unknown }).type === "string");
  const has = (t: string) => marks.some((m) => m.type === t);
  if (has("code")) return `\`${text}\``;
  let out = text;
  if (has("strike")) out = `~~${out}~~`;
  if (has("em")) out = has("strong") ? `_${out}_` : `*${out}*`;
  if (has("strong")) out = `**${out}**`;
  const link = marks.find((m) => m.type === "link");
  if (link) {
    const href = typeof link.attrs?.["href"] === "string" ? (link.attrs["href"] as string) : "";
    out = `[${out}](${href})`;
  }
  return out;
}

function renderInline(nodes: readonly unknown[]): string {
  let out = "";
  for (const raw of nodes) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as { type?: unknown; text?: unknown; marks?: unknown };
    if (node.type === "text" && typeof node.text === "string") {
      out += renderTextNode(node.text, Array.isArray(node.marks) ? node.marks : []);
    } else if (node.type === "hardBreak") {
      out += "  \n"; // trailing two spaces + newline — what `stripHardBreakMarker` recognizes on re-parse
    } else {
      out += renderFallbackText(node);
    }
  }
  return out;
}

function renderCodeBlock(node: { attrs?: unknown; content?: unknown }): string {
  const language = typeof (node.attrs as { language?: unknown } | undefined)?.language === "string" ? (node.attrs as { language: string }).language : "";
  const codeNodes = Array.isArray(node.content) ? node.content : [];
  const code = codeNodes.map((n) => (n && typeof n === "object" && typeof (n as { text?: unknown }).text === "string" ? (n as { text: string }).text : "")).join("");
  return "```" + language + "\n" + code + "\n```";
}

function renderList(node: { attrs?: unknown; content?: unknown; type?: unknown }, indent: string): string {
  const ordered = node.type === "orderedList";
  const items = Array.isArray(node.content) ? node.content : [];
  const orderStart = ordered && typeof (node.attrs as { order?: unknown } | undefined)?.order === "number" ? (node.attrs as { order: number }).order : 1;
  return items
    .map((rawItem, idx) => {
      if (!rawItem || typeof rawItem !== "object") return "";
      const item = rawItem as { content?: unknown };
      const blocks = Array.isArray(item.content) ? item.content : [];
      const paragraph = blocks.find((b): b is { type: string; content?: unknown } => Boolean(b) && typeof b === "object" && (b as { type?: unknown }).type === "paragraph");
      const nestedList = blocks.find(
        (b): b is { type: string; attrs?: unknown; content?: unknown } => Boolean(b) && typeof b === "object" && ((b as { type?: unknown }).type === "bulletList" || (b as { type?: unknown }).type === "orderedList"),
      );
      const text = paragraph ? renderInline(Array.isArray(paragraph.content) ? paragraph.content : []) : renderFallbackText(item);
      const marker = ordered ? `${orderStart + idx}. ` : "- ";
      let line = indent + marker + text;
      if (nestedList) line += "\n" + renderList(nestedList, indent + "  ");
      return line;
    })
    .join("\n");
}

function renderBlockquote(node: { content?: unknown }): string {
  const blocks = Array.isArray(node.content) ? node.content : [];
  const lines: string[] = [];
  for (const raw of blocks) {
    const text =
      raw && typeof raw === "object" && (raw as { type?: unknown }).type === "paragraph"
        ? renderInline(Array.isArray((raw as { content?: unknown }).content) ? ((raw as { content?: unknown }).content as unknown[]) : [])
        : renderFallbackText(raw);
    for (const l of text.split("\n")) lines.push(`> ${l}`);
  }
  return lines.join("\n");
}

function clampHeadingLevel(level: unknown): number {
  const n = typeof level === "number" ? Math.trunc(level) : 1;
  return Math.min(6, Math.max(1, n || 1));
}

/** Whether `line`, if `parseBlocks` scanned it fresh, would start a fence/rule/heading/blockquote/list rather than plain paragraph text — see `escapeParagraphLine`, the only caller. */
function looksLikeBlockStart(line: string): boolean {
  return isFenceOpen(line) || isRule(line) || isHeading(line) || /^>/.test(line) || matchBullet(line) !== null || matchOrdered(line) !== null;
}

/**
 * Guards one line of a RENDERED paragraph against being misread as a
 * different block type on the next `markdownToAdf` pass. `parseBlocks`
 * treats ANY line of an in-progress paragraph — not just a block's first —
 * that matches a fence/rule/heading/blockquote/list pattern as ending
 * paragraph accumulation right there (see its continuation-line `while`
 * loop). That means two lines that were never a list in the source — a
 * bare `-` alone on one line, soft-joined with the next line's text into
 * one rendered `"- word"` line — silently become a real bulletList the
 * next time this text is parsed, which is exactly the kind of "out-of-
 * scope constructs never corrupt structure" violation this module's own
 * doc comment rules out. Escaping just the line's first character is
 * enough to defeat every one of those patterns, all of which anchor a
 * specific character at column 0; `ESCAPABLE_INLINE_CHARS` is what lets
 * `markdownToAdf` unescape it back to the original literal character.
 */
function escapeParagraphLine(line: string): string {
  return looksLikeBlockStart(line) ? `\\${line}` : line;
}

function renderBlock(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const node = raw as { type?: unknown; attrs?: unknown; content?: unknown };
  switch (node.type) {
    case "paragraph":
      return renderInline(Array.isArray(node.content) ? node.content : [])
        .split("\n")
        .map(escapeParagraphLine)
        .join("\n");
    case "heading": {
      const level = clampHeadingLevel((node.attrs as { level?: unknown } | undefined)?.level);
      const text = renderInline(Array.isArray(node.content) ? node.content : []);
      return text ? `${"#".repeat(level)} ${text}` : "#".repeat(level);
    }
    case "codeBlock":
      return renderCodeBlock(node);
    case "bulletList":
    case "orderedList":
      return renderList(node, "");
    case "blockquote":
      return renderBlockquote(node);
    case "rule":
      return "---";
    default: {
      const fallback = renderFallbackText(node);
      return fallback.length > 0 ? fallback : undefined;
    }
  }
}

/**
 * The inverse of `markdownToAdf`: renders an ADF document back into the
 * same Markdown subset. NOT required to byte-match the original input
 * (canonical forms are fine — e.g. always `-` for bullets even if the
 * source used `*`), only to be semantically recognizable and to converge
 * after one more round trip through `markdownToAdf`. Handles ADF built by
 * this module OR hand-built elsewhere (e.g. Jira's own rich-text editor):
 * any node or mark type it doesn't recognize degrades to its nested text
 * content via `renderFallbackText` rather than throwing or dropping it.
 */
export function adfToMarkdown(adf: unknown): string {
  if (!adf || typeof adf !== "object") return "";
  const doc = adf as { content?: unknown };
  const content = Array.isArray(doc.content) ? doc.content : [];
  return content
    .map((n) => renderBlock(n))
    .filter((s): s is string => s !== undefined)
    .join("\n\n");
}
