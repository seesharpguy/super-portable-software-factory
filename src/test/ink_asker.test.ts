/**
 * `createInkAsker()` (`cli/ui/ink_asker.tsx`) — the Ink-backed `Asker`
 * implementation `spf init` reaches for when `inkAvailable()` says so.
 * Unlike `runInterview()`, which is tested entirely through the `Asker`
 * interface (`fake_asker.ts`) and never touches a concrete implementation,
 * this file drives the concrete implementation itself: it mounts a real
 * Ink instance against a fake TTY pair (`fake_tty.ts`) and sends real
 * keystrokes, because that is the only way to catch bugs in the rendering
 * and input-handling code the interface tests can't see. Two real bugs
 * were caught this way before this suite existed to pin them down:
 *   1. `TextInput` (uncontrolled) silently concatenating a rejected answer
 *      onto the next one instead of clearing — see the `key`-remount
 *      comment in `TextPromptView`.
 *   2. `@inkjs/ui`'s `Select` never firing `onChange` for the single most
 *      common interaction (accept the already-highlighted default via a
 *      bare Enter, no arrow key first) — see `SelectPromptView`'s header
 *      comment. `select: enter with no movement...` below is the direct
 *      regression test.
 * A THIRD bug only showed up over a real pty, not the fake streams here:
 * mounting a fresh Ink instance per question toggled raw mode off then on
 * between every question, and a keystroke landing in that gap could be
 * echoed to the screen instead of consumed, or lost outright. The fix
 * (one persistent Ink instance for the whole interview) is why "full
 * sequential interview" below drives several real prompts back to back
 * through the SAME asker — a single-prompt-per-test case can't exercise
 * the inter-question boundary where that bug lived.
 *
 * The readline `createAsker()` (`cli/ask.ts`) has never had a direct test
 * of its own — every existing test drives it through the `Asker` interface
 * — so this is also the first test of a concrete `Asker` at all. Every
 * case here mirrors a contract `interview.test.ts`/`signoff.test.ts` pins
 * against the interface, checked here against the real implementation
 * instead of a fake.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createInkAsker } from "../cli/ui/ink_asker.js";
import { InterviewAborted } from "../cli/ask.js";
import { FakeStdin, FakeStdout, KEY } from "./fake_tty.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A fake TTY pair has no real I/O handle, and `createInkAsker`'s own
// timers (the `confirm` timeout) are deliberately `.unref()`'d — between
// two `await sleep(...)` calls, the event loop can briefly hold zero
// active handles at all. Node's test runner reads that as "the process is
// about to exit" and force-cancels every still-pending test in the file,
// even ones with a real keystroke on the way (confirmed empirically: every
// test after the first few failed with "Promise resolution is still
// pending but the event loop has already resolved" until this was added).
// One ordinary ref'd interval for the file's duration keeps the loop
// non-empty so that heuristic never fires.
let keepAlive: ReturnType<typeof setInterval>;
before(() => {
  keepAlive = setInterval(() => {}, 1000);
});
after(() => {
  clearInterval(keepAlive);
});

/**
 * One fresh fake TTY pair + asker per test, torn down (`asker.close()`,
 * same as `initCommand` does on every path) once the test's callback
 * returns — mirrors a fresh `spf init` process each time, and keeps one
 * test's mounted instance from bleeding into the next. The casts are the
 * same shape of trust `ink-testing-library`'s own fakes take: neither fake
 * implements the full `ReadStream`/`WriteStream` surface, only the handful
 * of members Ink's `App.js`/`ink.js` actually call (see `fake_tty.ts`'s
 * header comment).
 */
async function withAsker(
  run: (h: { stdin: FakeStdin; stdout: FakeStdout; asker: ReturnType<typeof createInkAsker> }) => Promise<void>,
): Promise<void> {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const asker = createInkAsker({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  });
  try {
    await run({ stdin, stdout, asker });
  } finally {
    asker.close();
  }
}

// ── text ─────────────────────────────────────────────────────────────────

test("text: typed value + enter resolves to what was typed", () =>
  withAsker(async ({ stdin, asker }) => {
    const pending = asker.text("Name");
    await sleep(30);
    stdin.send("river");
    await sleep(30);
    stdin.send(KEY.enter);
    assert.equal(await pending, "river");
  }));

test("text: blank + enter resolves to the default", () =>
  withAsker(async ({ stdin, asker }) => {
    const pending = asker.text("Name", { default: "bob" });
    await sleep(30);
    stdin.send(KEY.enter);
    assert.equal(await pending, "bob");
  }));

test("text: a rejected answer does not bleed into the retry — regression for the TextInput concatenation bug", () =>
  withAsker(async ({ stdin, asker }) => {
    const pending = asker.text("Age", { validate: (v) => (v === "bad" ? "not a real age" : null) });
    await sleep(30);
    stdin.send("bad");
    await sleep(30);
    stdin.send(KEY.enter); // rejected — must not leave "bad" sitting in the box
    await sleep(30);
    stdin.send("good");
    await sleep(30);
    stdin.send(KEY.enter);
    assert.equal(await pending, "good");
  }));

// ── select ───────────────────────────────────────────────────────────────

test("select: enter with no movement resolves to the default — regression for @inkjs/ui's Select never firing onChange here", () =>
  withAsker(async ({ stdin, asker }) => {
    const pending = asker.select("Pick one", [{ value: "a" }, { value: "b" }, { value: "c" }], "a");
    await sleep(30);
    stdin.send(KEY.enter);
    assert.equal(await pending, "a");
  }));

test("select: arrow-down then enter resolves to the highlighted choice, not the default", () =>
  withAsker(async ({ stdin, asker }) => {
    const pending = asker.select("Pick one", [{ value: "a" }, { value: "b" }, { value: "c" }], "a");
    await sleep(30);
    stdin.send(KEY.down);
    await sleep(30);
    stdin.send(KEY.enter);
    assert.equal(await pending, "b");
  }));

// ── confirm ──────────────────────────────────────────────────────────────

test("confirm: enter with no input resolves to the default", () =>
  withAsker(async ({ stdin, asker }) => {
    const pending = asker.confirm("Proceed?", true);
    await sleep(30);
    stdin.send(KEY.enter);
    assert.equal(await pending, true);
  }));

test("confirm: an explicit 'n' overrides a true default", () =>
  withAsker(async ({ stdin, asker }) => {
    const pending = asker.confirm("Proceed?", true);
    await sleep(30);
    stdin.send("n");
    assert.equal(await pending, false);
  }));

test("confirm: timeoutMs expires to the default, never to true regardless of default — same contract signoff.test.ts pins against the interface", () =>
  withAsker(async ({ asker }) => {
    const started = Date.now();
    const result = await asker.confirm("Approve and commit?", false, { timeoutMs: 100 });
    assert.equal(result, false);
    assert.ok(Date.now() - started < 2000, "must not wait past the timeout");
  }));

// ── secret ───────────────────────────────────────────────────────────────

test('secret: a blank submit resolves to "" — the caller\'s signal to keep the existing value', () =>
  withAsker(async ({ stdin, asker }) => {
    const pending = asker.secret("API key", { current: "sk-abcdef1234" });
    await sleep(30);
    stdin.send(KEY.enter);
    assert.equal(await pending, "");
  }));

test("secret: a typed value resolves to that value", () =>
  withAsker(async ({ stdin, asker }) => {
    const pending = asker.secret("API key");
    await sleep(30);
    stdin.send("sk-new-value");
    await sleep(30);
    stdin.send(KEY.enter);
    assert.equal(await pending, "sk-new-value");
  }));

// ── Ctrl-C / Ctrl-D ──────────────────────────────────────────────────────

test("ctrl-c mid-prompt rejects with InterviewAborted", () =>
  withAsker(async ({ stdin, asker }) => {
    const pending = asker.text("Name");
    await sleep(30);
    stdin.send(KEY.ctrlC);
    await assert.rejects(pending, InterviewAborted);
  }));

test("ctrl-d (EOF) is treated the same as ctrl-c", () =>
  withAsker(async ({ stdin, asker }) => {
    const pending = asker.confirm("Proceed?", false);
    await sleep(30);
    stdin.send(KEY.ctrlD);
    await assert.rejects(pending, InterviewAborted);
  }));

test("once aborted, every later call on the same asker rejects immediately without showing a new prompt", () =>
  withAsker(async ({ stdin, asker }) => {
    await assert.rejects(async () => {
      const pending = asker.text("Name");
      await sleep(30);
      stdin.send(KEY.ctrlC);
      await pending;
    }, InterviewAborted);

    await assert.rejects(asker.confirm("Another?", true), InterviewAborted);
    await assert.rejects(asker.select("Pick", [{ value: "a" }], "a"), InterviewAborted);
    await assert.rejects(asker.secret("Token"), InterviewAborted);
  }));

// ── a full sequential interview, one asker, one mount ───────────────────

test("full sequential interview: heading, note, text, select (bare enter), select (arrow+enter), confirm, and secret all resolve in order on ONE persistent instance", () =>
  withAsker(async ({ stdin, asker }) => {
    asker.heading("Coding agent");
    asker.note("this mirrors runInterview()'s own call shape, not just one prompt in isolation");

    const backend = asker.select(
      "Which backend runs each agent?",
      [
        { value: "claude_code", label: "claude_code" },
        { value: "flue", label: "flue" },
      ],
      "claude_code",
    );
    await sleep(30);
    stdin.send(KEY.enter); // accept the default with no arrow movement — the exact case that hung over a real pty pre-fix
    assert.equal(await backend, "claude_code");

    const launchCommand = asker.text("Launch command", { default: "claude" });
    await sleep(30);
    stdin.send(KEY.enter);
    assert.equal(await launchCommand, "claude");

    const model = asker.select(
      "Model",
      [
        { value: "sonnet", label: "sonnet" },
        { value: "opus", label: "opus" },
        { value: "haiku", label: "haiku" },
      ],
      "sonnet",
    );
    await sleep(30);
    stdin.send(KEY.down); // this arrow-then-enter step is exactly where the real bug's Enter got lost
    await sleep(30);
    stdin.send(KEY.enter);
    assert.equal(await model, "opus");

    const proceed = asker.confirm("Proceed?", true);
    await sleep(30);
    stdin.send(KEY.enter);
    assert.equal(await proceed, true);

    const token = asker.secret("API key", { current: "sk-old" });
    await sleep(30);
    stdin.send("sk-new");
    await sleep(30);
    stdin.send(KEY.enter);
    assert.equal(await token, "sk-new");
  }));
