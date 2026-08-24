/**
 * A minimal fake TTY stdin/stdout pair for driving `createInkAsker()`
 * (`cli/ui/ink_asker.tsx`) headlessly under `node --test`, which has
 * neither a real terminal nor raw-mode support.
 *
 * `ink-testing-library` solves the same problem for `ink`'s own `render()`,
 * but it always calls that `render()` with its own hardcoded options —
 * there's no way to point it at `createInkAsker()`'s internal render calls
 * against `process.stdin`/`process.stdout`. This mirrors its `Stdin`/
 * `Stdout` fakes closely (same EventEmitter shape, same members Ink's
 * `App.js`/`ink.js` actually call: `isTTY`, `setRawMode`, `ref`/`unref`,
 * `read`, `setEncoding`, and a `write` that Ink can call with a flush
 * callback) but additionally honors that callback — ink-testing-library's
 * own fake silently drops it, which is harmless there only because nothing
 * in this repo calls `waitUntilRenderFlush()`.
 */
import { EventEmitter } from "node:events";

export class FakeStdin extends EventEmitter {
  isTTY = true;
  private pending: string | null = null;

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}

  read(): string | null {
    const data = this.pending;
    this.pending = null;
    return data;
  }

  /** Feed one keypress/paste as Ink itself would deliver it — a raw string, already ANSI-escaped for special keys (e.g. `"\x1B[B"` for down-arrow, `"\r"` for enter, `"\x03"` for Ctrl-C). */
  send(data: string): void {
    this.pending = data;
    this.emit("readable");
    this.emit("data", data);
  }
}

export class FakeStdout extends EventEmitter {
  // Ink's own interactive-mode detection is `stdin.isTTY && stdout.isTTY`
  // (`ink.js`) — leaving this unset (as `ink-testing-library`'s own fake
  // does) was empirically reproducible as a hang across sequential real
  // `render()` calls sharing a process, so both fakes set it explicitly.
  isTTY = true;
  columns = 100;
  rows = 24;
  frames: string[] = [];

  write(data: string, callback?: () => void): boolean {
    this.frames.push(data);
    callback?.();
    return true;
  }

  /**
   * The most recent write Ink made — analogous to `ink-testing-library`'s
   * `lastFrame()`, minus the ANSI it never strips either. NOT a reliable
   * "did the screen content change" signal on its own: Ink writes a
   * repaint as several separate `write()` calls, and the LAST one for
   * almost every commit is a fixed synchronized-output-end marker
   * (`\x1b[?2026l`) — this returns that same marker back to back across
   * completely different renders. A test that needs to know whether a NEW
   * commit has happened since some earlier point should compare
   * `frames.length` instead (see `ink_asker.test.ts`'s `waitForReady`).
   */
  lastFrame(): string | undefined {
    return this.frames.at(-1);
  }
}

export const KEY = {
  up: "\x1B[A",
  down: "\x1B[B",
  enter: "\r",
  ctrlC: "\x03",
  ctrlD: "\x04",
};
