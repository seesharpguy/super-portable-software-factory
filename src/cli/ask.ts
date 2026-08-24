/**
 * Zero-dependency interactive prompt primitives for `spf init`'s interview.
 *
 * No prompting library exists anywhere in this repo, and the project keeps a
 * deliberately thin dependency list (`@flue/runtime`, `hono`, `valibot`,
 * `yaml`) — this builds directly on `node:readline/promises` rather than
 * adding one. `Asker` is an interface, not a class, so a test can supply a
 * scripted fake instead of driving a real TTY — the same seam this repo
 * already uses for `IssueProvider`/`CodeHostProvider` (see
 * `src/test/watch.test.ts`'s `FakeProvider`).
 */
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { paint } from "../core/console.ts";

export interface SelectChoice<T extends string> {
  value: T;
  label?: string; // defaults to `value`
  hint?: string;
}

export interface Asker {
  text(label: string, opts?: { default?: string; validate?: (value: string) => string | null }): Promise<string>;
  select<T extends string>(label: string, choices: SelectChoice<T>[], dflt: T): Promise<T>;
  /**
   * `opts.timeoutMs`, when given (including `0`, for "don't wait at all" —
   * checked with `!== undefined`, never truthiness), bounds the wait: expiry
   * resolves with `dflt` (never with `true` — a caller that wants "expiry
   * means not approved" passes `dflt: false`, same as any other unanswered
   * prompt) and prints a `timed out — using default (yes|no)` line, phrased
   * from `dflt` itself, so the transcript never contradicts what was
   * returned. Absent -> unbounded, unchanged from before this option existed
   * (the only caller today that needs it is `simple_sdlc.ts`'s sign-off
   * prompt — see `review.signoff_timeout_seconds`).
   */
  confirm(label: string, dflt: boolean, opts?: { timeoutMs?: number }): Promise<boolean>;
  /** Echo-suppressed. `current` (if any) is shown masked; an empty answer keeps it and resolves to `""`. */
  secret(label: string, opts?: { current?: string }): Promise<string>;
  note(text: string): void;
  heading(text: string): void;
  close(): void;
}

/** `stdin.isTTY` is what actually matters (the interview reads it) — `stdout.isTTY` alone, this repo's only prior TTY check (`src/ui/server/serve.ts:88`), would let a piped-in `spf init` hang waiting on input that will never arrive. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && !process.env["CI"];
}

/**
 * Whether `cli/ui/ink_asker.tsx`'s Ink-backed `Asker` can run instead of this
 * file's plain readline one. Ink hard-requires raw-mode stdin — confirmed by
 * testing: rendering an Ink app against a non-raw-mode-capable stdin throws
 * before anything is drawn. `isInteractive()` already implies raw mode is
 * available in every real case (a TTY stdin always exposes `setRawMode`);
 * the extra `typeof` check is cheap insurance against whatever exotic
 * terminal doesn't, so a caller falls back to `createAsker()` instead of
 * crashing.
 */
export function inkAvailable(): boolean {
  return isInteractive() && typeof process.stdin.setRawMode === "function";
}

/** Thrown when the user interrupts (Ctrl-C) or stdin closes (EOF) mid-interview. `initCommand` catches this and exits 130, writing nothing. */
export class InterviewAborted extends Error {
  constructor() {
    super("interview interrupted");
  }
}

class MutableWritable extends Writable {
  muted = false;
  _write(chunk: unknown, _encoding: string, callback: (error?: Error | null) => void): void {
    if (!this.muted) process.stdout.write(chunk as Buffer);
    callback();
  }
}

/** Sentinel distinguishing "the timer fired" from any real answer, including "". */
const TIMED_OUT = Symbol("timed-out");

/**
 * Race `promise` against a `ms` timer. On expiry resolves `TIMED_OUT` and
 * lets `promise` keep running unobserved — `readline`'s `question()` has no
 * cancel, so the only alternatives are leaving it pending (harmless: nothing
 * is still awaiting its result once this returns) or never bounding the
 * wait at all, which is exactly what `review.signoff_timeout_seconds` exists
 * to rule out. `.unref()` so a pending prompt with a live timer never keeps
 * the process alive on its own.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createAsker(): Asker {
  const muteableOut = new MutableWritable();
  const rl = createInterface({ input: process.stdin, output: muteableOut, terminal: true });
  let aborted = false;
  rl.on("SIGINT", () => {
    aborted = true;
    rl.close();
  });

  async function raw(prompt: string): Promise<string> {
    if (aborted) throw new InterviewAborted();
    try {
      const answer = await rl.question(prompt);
      return answer.trim();
    } catch {
      // readline rejects `question()` if the interface is closed underneath it (EOF/SIGINT mid-prompt).
      throw new InterviewAborted();
    }
  }

  return {
    async text(label, opts) {
      const suffix = opts?.default ? paint("dim", ` [${opts.default}]`) : "";
      while (true) {
        const answer = await raw(`${label}${suffix}: `);
        const value = answer || opts?.default || "";
        const problem = opts?.validate?.(value);
        if (problem) {
          console.log(paint("red", `  ${problem}`));
          continue;
        }
        return value;
      }
    },

    async select<T extends string>(label: string, choices: SelectChoice<T>[], dflt: T): Promise<T> {
      console.log(label);
      for (const c of choices) {
        const marker = c.value === dflt ? paint("bold", "*") : " ";
        const hint = c.hint ? paint("dim", ` — ${c.hint}`) : "";
        console.log(`  ${marker} ${c.label ?? c.value}${hint}`);
      }
      const valid = new Set<string>(choices.map((c) => c.value));
      while (true) {
        const answer = await raw(paint("dim", `choose [${dflt}]: `));
        if (!answer) return dflt;
        if (valid.has(answer)) return answer as T;
        console.log(paint("red", `  not one of: ${[...valid].join(", ")}`));
      }
    },

    async confirm(label, dflt, opts) {
      const hint = dflt ? "Y/n" : "y/N";
      const pending = raw(`${label} ${paint("dim", `[${hint}]`)}: `);
      const result = opts?.timeoutMs !== undefined ? await withTimeout(pending, opts.timeoutMs) : await pending;
      if (result === TIMED_OUT) {
        console.log(paint("yellow", `  timed out — using default (${dflt ? "yes" : "no"})`));
        return dflt;
      }
      const answer = result.toLowerCase();
      if (!answer) return dflt;
      return answer === "y" || answer === "yes";
    },

    async secret(label, opts) {
      const maskedCurrent = opts?.current ? paint("dim", ` [keep current: ${maskForPrompt(opts.current)}]`) : "";
      // The "  > " marker is written unmuted, before muting starts — otherwise
      // it vanishes along with the (correctly) suppressed keystroke echo,
      // and an empty line reads as a hang rather than a waiting prompt.
      console.log(`${label}${maskedCurrent}`);
      process.stdout.write("  > ");
      muteableOut.muted = true;
      let answer: string;
      try {
        answer = await raw("");
      } finally {
        muteableOut.muted = false;
        process.stdout.write("\n"); // the newline the muted output swallowed
      }
      return answer;
    },

    note(text) {
      console.log(paint("dim", `  ${text}`));
    },

    heading(text) {
      console.log("");
      console.log(paint("bold cyan", `── ${text} ──`));
    },

    close() {
      rl.close();
    },
  };
}

/** Exported for `cli/ui/ink_asker.tsx`'s secret prompt, which renders the same "keep current" line and must mask it identically. */
export function maskForPrompt(value: string): string {
  if (value.length <= 4) return "•".repeat(value.length);
  return `${"•".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}
