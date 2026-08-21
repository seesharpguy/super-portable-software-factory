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
  confirm(label: string, dflt: boolean): Promise<boolean>;
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

    async confirm(label, dflt) {
      const hint = dflt ? "Y/n" : "y/N";
      const answer = (await raw(`${label} ${paint("dim", `[${hint}]`)}: `)).toLowerCase();
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

function maskForPrompt(value: string): string {
  if (value.length <= 4) return "•".repeat(value.length);
  return `${"•".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}
