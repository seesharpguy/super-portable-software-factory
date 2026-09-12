import { test } from "node:test";
import assert from "node:assert/strict";
import { adfToMarkdown, markdownToAdf } from "../core/issues/markdown_adf.js";

/** Round-trips through the module twice — `markdownToAdf(adfToMarkdown(markdownToAdf(md)))` — and asserts the SECOND ADF equals the first, i.e. convergence, which is the only round-trip guarantee this module promises (byte-for-byte match against the original `md` is explicitly not required). */
function assertConverges(md: string): unknown {
  const first = markdownToAdf(md);
  const second = markdownToAdf(adfToMarkdown(first));
  assert.deepEqual(second, first, `did not converge after one round trip for: ${JSON.stringify(md)}`);
  return first;
}

// ── backward compatibility with jira_provider.ts's existing toAdf() ───────

test("markdownToAdf: a plain string with zero markdown syntax produces the same minimal shape as jira_provider.ts's toAdf()", () => {
  const adf = markdownToAdf("Hello world");
  assert.deepEqual(adf, {
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }],
  });
});

// ── headings ────────────────────────────────────────────────────────────

test("markdownToAdf: ATX headings level 1 through 6", () => {
  for (let level = 1; level <= 6; level++) {
    const adf = markdownToAdf(`${"#".repeat(level)} Title`) as { content: unknown[] };
    assert.deepEqual(adf.content, [{ type: "heading", attrs: { level }, content: [{ type: "text", text: "Title" }] }]);
  }
});

test("markdownToAdf: a 7th '#' is out of the supported range and falls through to a literal paragraph", () => {
  const adf = markdownToAdf("####### not a heading") as { content: unknown[] };
  assert.deepEqual(adf.content, [{ type: "paragraph", content: [{ type: "text", text: "####### not a heading" }] }]);
});

test("adfToMarkdown: renders a heading node back to ATX form", () => {
  const md = adfToMarkdown({ type: "doc", version: 1, content: [{ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Hi" }] }] });
  assert.equal(md, "### Hi");
});

// ── bold / italic / strikethrough / inline code ────────────────────────────

test("markdownToAdf: bold via ** and __ both produce a strong mark", () => {
  for (const md of ["**bold**", "__bold__"]) {
    const adf = markdownToAdf(md) as { content: Array<{ content: unknown[] }> };
    assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: "bold", marks: [{ type: "strong" }] }]);
  }
});

test("markdownToAdf: italic via * and _ both produce an em mark", () => {
  for (const md of ["*italic*", "_italic_"]) {
    const adf = markdownToAdf(md) as { content: Array<{ content: unknown[] }> };
    assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: "italic", marks: [{ type: "em" }] }]);
  }
});

test("markdownToAdf: strikethrough via ~~ produces a strike mark (not 'strikethrough' — that's not the real ADF type name)", () => {
  const adf = markdownToAdf("~~gone~~") as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: "gone", marks: [{ type: "strike" }] }]);
});

test("markdownToAdf: inline code produces a code mark", () => {
  const adf = markdownToAdf("`code`") as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: "code", marks: [{ type: "code" }] }]);
});

test("markdownToAdf: bold and italic combined carry both marks, always in canonical order [strong, em]", () => {
  const adf = markdownToAdf("**_both_**") as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: "both", marks: [{ type: "strong" }, { type: "em" }] }]);
});

test("markdownToAdf: an unterminated ** falls through to literal text rather than crashing", () => {
  const adf = markdownToAdf("**never closed") as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: "**never closed" }]);
});

// ── fenced code blocks ─────────────────────────────────────────────────────

test("markdownToAdf: a fenced code block with a language tag", () => {
  const adf = markdownToAdf("```js\nconst x = 1;\n```") as { content: unknown[] };
  assert.deepEqual(adf.content, [{ type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: "const x = 1;" }] }]);
});

test("markdownToAdf: a fenced code block with no language omits attrs entirely", () => {
  const adf = markdownToAdf("```\nplain\n```") as { content: unknown[] };
  assert.deepEqual(adf.content, [{ type: "codeBlock", content: [{ type: "text", text: "plain" }] }]);
});

test("markdownToAdf: marks are never applied inside a fenced code block, even if it looks like markdown", () => {
  const adf = markdownToAdf("```\n**not bold**\n```") as { content: unknown[] };
  assert.deepEqual(adf.content, [{ type: "codeBlock", content: [{ type: "text", text: "**not bold**" }] }]);
});

test("markdownToAdf: an unterminated fence falls through to a literal paragraph for that line only, and parsing continues", () => {
  const adf = markdownToAdf("```js\nafter") as { content: unknown[] };
  assert.deepEqual(adf.content, [
    { type: "paragraph", content: [{ type: "text", text: "```js" }] },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ]);
});

test("adfToMarkdown: renders a codeBlock back to a fenced block", () => {
  const md = adfToMarkdown({ type: "doc", version: 1, content: [{ type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "let x;" }] }] });
  assert.equal(md, "```ts\nlet x;\n```");
});

// ── lists ───────────────────────────────────────────────────────────────

test("markdownToAdf: a bullet list (-, *, + all supported)", () => {
  for (const marker of ["-", "*", "+"]) {
    const adf = markdownToAdf(`${marker} one\n${marker} two`) as { content: unknown[] };
    assert.deepEqual(adf.content, [
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
          { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
        ],
      },
    ]);
  }
});

test("markdownToAdf: an ordered list starting at 1 omits attrs.order", () => {
  const adf = markdownToAdf("1. one\n2. two") as { content: Array<{ attrs?: unknown }> };
  assert.equal(adf.content[0]!.attrs, undefined);
});

test("markdownToAdf: an ordered list starting past 1 carries attrs.order", () => {
  const adf = markdownToAdf("3. three\n4. four") as { content: Array<{ type: string; attrs?: { order?: number } }> };
  assert.equal(adf.content[0]!.type, "orderedList");
  assert.equal(adf.content[0]!.attrs?.order, 3);
});

test("markdownToAdf: one level of nested bullet list under a list item", () => {
  const adf = markdownToAdf("- parent\n  - child") as { content: unknown[] };
  assert.deepEqual(adf.content, [
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "parent" }] },
            { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "child" }] }] }] },
          ],
        },
      ],
    },
  ]);
});

test("adfToMarkdown: renders nested lists back with two-space indentation, and re-parsing recovers the nesting", () => {
  const adf = markdownToAdf("- parent\n  - child");
  const md = adfToMarkdown(adf);
  assert.equal(md, "- parent\n  - child");
  assertConverges(md);
});

// ── blockquote ──────────────────────────────────────────────────────────

test("markdownToAdf: a single-line blockquote", () => {
  const adf = markdownToAdf("> quoted") as { content: unknown[] };
  assert.deepEqual(adf.content, [{ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "quoted" }] }] }]);
});

test("markdownToAdf: consecutive > lines merge into one blockquote", () => {
  const adf = markdownToAdf("> line one\n> line two") as { content: Array<{ type: string; content: unknown[] }> };
  assert.equal(adf.content.length, 1);
  assert.equal(adf.content[0]!.type, "blockquote");
});

// ── horizontal rule ─────────────────────────────────────────────────────

test("markdownToAdf: ---, ***, and ___ alone on a line all produce a rule leaf node", () => {
  for (const md of ["---", "***", "___"]) {
    const adf = markdownToAdf(md) as { content: unknown[] };
    assert.deepEqual(adf.content, [{ type: "rule" }]);
  }
});

// ── links ───────────────────────────────────────────────────────────────

test("markdownToAdf: a link becomes a link mark on a text node, not a distinct node type", () => {
  const adf = markdownToAdf("[spf](https://example.com)") as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: "spf", marks: [{ type: "link", attrs: { href: "https://example.com" } }] }]);
});

test("markdownToAdf: bold text inside a link carries both marks", () => {
  const adf = markdownToAdf("[**bold link**](https://example.com)") as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [
    { type: "text", text: "bold link", marks: [{ type: "link", attrs: { href: "https://example.com" } }, { type: "strong" }] },
  ]);
});

// ── paragraphs, hard breaks, and soft joins ────────────────────────────────

test("markdownToAdf: a blank line separates two paragraphs", () => {
  const adf = markdownToAdf("first\n\nsecond") as { content: unknown[] };
  assert.deepEqual(adf.content, [
    { type: "paragraph", content: [{ type: "text", text: "first" }] },
    { type: "paragraph", content: [{ type: "text", text: "second" }] },
  ]);
});

test("markdownToAdf: consecutive non-blank lines with no break marker join into one paragraph with a space", () => {
  const adf = markdownToAdf("one\ntwo") as { content: unknown[] };
  assert.deepEqual(adf.content, [{ type: "paragraph", content: [{ type: "text", text: "one two" }] }]);
});

test("markdownToAdf: a line ending in two trailing spaces becomes a hardBreak", () => {
  const adf = markdownToAdf("one  \ntwo") as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: "one" }, { type: "hardBreak" }, { type: "text", text: "two" }]);
});

test("markdownToAdf: a line ending in a lone backslash becomes a hardBreak", () => {
  const adf = markdownToAdf("one\\\ntwo") as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: "one" }, { type: "hardBreak" }, { type: "text", text: "two" }]);
});

test("adfToMarkdown: a hardBreak renders as trailing double-space + newline, and re-parsing recovers it", () => {
  const adf = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "one" }, { type: "hardBreak" }, { type: "text", text: "two" }] }] };
  const md = adfToMarkdown(adf);
  assert.equal(md, "one  \ntwo");
  assert.deepEqual(markdownToAdf(md), adf);
});

// ── a mix of several constructs in one document ────────────────────────────

test("markdownToAdf: a document mixing heading, paragraph with marks, a list, and a code block", () => {
  const md = ["# Title", "", "Some **bold** and *italic* text.", "", "- one", "- two", "", "```js", "ok();", "```"].join("\n");
  const adf = markdownToAdf(md) as { content: unknown[] };
  assert.deepEqual(adf.content, [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Some " },
        { type: "text", text: "bold", marks: [{ type: "strong" }] },
        { type: "text", text: " and " },
        { type: "text", text: "italic", marks: [{ type: "em" }] },
        { type: "text", text: " text." },
      ],
    },
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }] },
      ],
    },
    { type: "codeBlock", attrs: { language: "js" }, content: [{ type: "text", text: "ok();" }] },
  ]);
  assertConverges(md);
});

// ── round-trip stability ────────────────────────────────────────────────

test("round-trip: markdownToAdf(adfToMarkdown(markdownToAdf(x))) converges for every supported construct", () => {
  const samples = [
    "# Heading",
    "**bold** *italic* ~~strike~~ `code`",
    "[a link](https://example.com)",
    "- a\n- b\n  - nested",
    "1. a\n2. b",
    "> quoted line",
    "---",
    "para one\n\npara two",
    "line one  \nline two",
    "```py\nprint(1)\n```",
  ];
  for (const md of samples) assertConverges(md);
});

test("adfToMarkdown: an unrecognized node type degrades to its nested text content instead of throwing", () => {
  const md = adfToMarkdown({
    type: "doc",
    version: 1,
    content: [{ type: "mediaSingle", content: [{ type: "media", content: [{ type: "text", text: "fallback text" }] }] }],
  });
  assert.equal(md, "fallback text");
});

test("adfToMarkdown: an unrecognized mark type is ignored rather than throwing, plain text still renders", () => {
  const md = adfToMarkdown({
    type: "doc",
    version: 1,
    content: [{ type: "paragraph", content: [{ type: "text", text: "hello", marks: [{ type: "subsup", attrs: { type: "sub" } }] }] }],
  });
  assert.equal(md, "hello");
});

test("adfToMarkdown: garbage input (not an object, missing content) never throws", () => {
  assert.doesNotThrow(() => adfToMarkdown(null));
  assert.doesNotThrow(() => adfToMarkdown(undefined));
  assert.doesNotThrow(() => adfToMarkdown("not an adf doc"));
  assert.doesNotThrow(() => adfToMarkdown({}));
  assert.equal(adfToMarkdown({}), "");
});

// ── out-of-scope syntax: never crash, fall back to literal text ───────────

test("markdownToAdf: a table falls through to literal paragraph text, never crashes", () => {
  // Blank-line-separated so each row is its own paragraph to check independently — table syntax
  // has no dedicated block detection, so consecutive un-separated rows would otherwise legitimately
  // soft-join into one paragraph, same as any other run of plain text lines (see the "paragraphs,
  // hard breaks, and soft joins" tests above).
  const md = "| a | b |\n\n| - | - |\n\n| 1 | 2 |";
  assert.doesNotThrow(() => markdownToAdf(md));
  const adf = markdownToAdf(md) as { content: Array<{ type: string; content: unknown[] }> };
  assert.equal(adf.content.length, 3);
  for (const block of adf.content) assert.equal(block.type, "paragraph");
  const rows = ["| a | b |", "| - | - |", "| 1 | 2 |"];
  adf.content.forEach((block, idx) => {
    assert.deepEqual(block.content, [{ type: "text", text: rows[idx] }]);
  });
});

test("markdownToAdf: an image falls through to literal text rather than becoming a link, never crashes", () => {
  const md = "![alt text](https://example.com/pic.png)";
  assert.doesNotThrow(() => markdownToAdf(md));
  const adf = markdownToAdf(md) as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: md }]);
});

test("markdownToAdf: an @mention falls through to literal text, never crashes", () => {
  const md = "cc @someone please review";
  assert.doesNotThrow(() => markdownToAdf(md));
  const adf = markdownToAdf(md) as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: md }]);
});

test("markdownToAdf: raw HTML falls through to literal text, never crashes", () => {
  const md = "some <b>bold</b> and a <script>alert(1)</script> tag";
  assert.doesNotThrow(() => markdownToAdf(md));
  const adf = markdownToAdf(md) as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: md }]);
});

test("markdownToAdf: never throws across a battery of adversarial inputs", () => {
  const inputs = ["", "\n\n\n", "**", "***", "```", "> ", "- ", "1. ", "[", "](", "`", "~~", "#".repeat(50), "\\", "  ", "a".repeat(5000)];
  for (const input of inputs) {
    assert.doesNotThrow(() => markdownToAdf(input), `threw on ${JSON.stringify(input)}`);
  }
});

// ── emphasis flanking rules: intraword underscores and bare asterisks ─────

test("markdownToAdf: a snake_case identifier's underscore is never mistaken for emphasis, even when a second underscore appears later in the same text", () => {
  const md = "Fixed in markdown_adf.ts and jira_provider.ts";
  const adf = markdownToAdf(md) as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: md }]);
});

test("markdownToAdf: a file path's underscores survive untouched", () => {
  const md = "- the asked_at and answered_at timestamps";
  const adf = markdownToAdf(md) as { content: Array<{ type: string; content: Array<{ type: string; content: unknown[] }> }> };
  assert.equal(adf.content[0]!.type, "bulletList");
  assert.deepEqual(adf.content[0]!.content[0]!.content, [{ type: "paragraph", content: [{ type: "text", text: "the asked_at and answered_at timestamps" }] }]);
});

test("markdownToAdf: a bare multiplication '*' flanked by spaces on both sides is never read as emphasis", () => {
  const adf = markdownToAdf("2 * 3 is *six*") as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: "2 * 3 is " }, { type: "text", text: "six", marks: [{ type: "em" }] }]);
});

test("markdownToAdf: an underscore flanked by spaces on both sides (`_ _`) stays literal instead of becoming an empty-content em", () => {
  const adf = markdownToAdf("_ _") as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: "_ _" }]);
});

test("markdownToAdf: intraword *emphasis* (no surrounding whitespace) still works for asterisks", () => {
  const adf = markdownToAdf("foo*bar*baz") as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: "foo" }, { type: "text", text: "bar", marks: [{ type: "em" }] }, { type: "text", text: "baz" }]);
});

// ── round-trip convergence: combined strong+em, and block-start collisions ─

test("round-trip: strong+em combined on one text node converges (avoids the ambiguous '***text***' triple-run)", () => {
  const md = "**_both_**";
  assertConverges(md);
  const md2 = adfToMarkdown(markdownToAdf(md));
  assert.equal(md2, "**_both_**");
});

test("round-trip: a bare list-marker character alone on its own line, soft-joined with the next line, does not turn into a real list on re-parse", () => {
  const md = "-\nword";
  const first = markdownToAdf(md) as { content: Array<{ type: string }> };
  assert.equal(first.content[0]!.type, "paragraph");
  assertConverges(md);
});

test("round-trip: the finding's own reported convergence counterexamples now converge", () => {
  assertConverges("a * b and _em_");
  assertConverges("_ _");
});

// ── link mark: an empty href degrades to literal text (finding: invalid ADF) ─

test("markdownToAdf: an empty link target [text]() falls through to literal text instead of an invalid empty href", () => {
  const md = "see [docs]() now";
  const adf = markdownToAdf(md) as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [{ type: "text", text: md }]);
});

test("markdownToAdf: a relative/schemeless link target still produces a real link mark (only emptiness degrades)", () => {
  const adf = markdownToAdf("see [the file](src/core/issues/markdown_adf.ts) now") as { content: Array<{ content: unknown[] }> };
  assert.deepEqual(adf.content[0]!.content, [
    { type: "text", text: "see " },
    { type: "text", text: "the file", marks: [{ type: "link", attrs: { href: "src/core/issues/markdown_adf.ts" } }] },
    { type: "text", text: " now" },
  ]);
});

// ── tables: rows preserved as separate lines instead of flattened ─────────

test("markdownToAdf: a real (un-blank-line-separated) Markdown table keeps each row on its own line via hardBreak, instead of collapsing into one squashed line", () => {
  const md = "| a | b |\n| - | - |\n| 1 | 2 |";
  const adf = markdownToAdf(md) as { content: Array<{ type: string; content: unknown[] }> };
  assert.equal(adf.content.length, 1);
  assert.equal(adf.content[0]!.type, "paragraph");
  assert.deepEqual(adf.content[0]!.content, [
    { type: "text", text: "| a | b |" },
    { type: "hardBreak" },
    { type: "text", text: "| - | - |" },
    { type: "hardBreak" },
    { type: "text", text: "| 1 | 2 |" },
  ]);
  const rendered = adfToMarkdown(adf);
  assert.match(rendered, /\| a \| b \|/);
  assert.match(rendered, /\| - \| - \|/);
  assert.match(rendered, /\| 1 \| 2 \|/);
  assertConverges(md);
});
