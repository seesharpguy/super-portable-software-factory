/**
 * Ink-backed implementation of the `Asker` interface (`cli/ask.ts`) — a
 * drop-in replacement for `createAsker()`'s readline prompts, used only
 * when `inkAvailable()` says raw-mode stdin is there to drive it.
 * `runInterview()` (`cli/interview.ts`) never sees this file: it only ever
 * imports the `Asker` type, so it is byte-for-byte unchanged by this
 * module existing, and every `createFakeAsker`-driven test still exercises
 * it exactly as before.
 *
 * This file is reached only through a dynamic `import()` (see
 * `commands/init.ts`) so the ~150-300ms cost of loading `ink`+`react` is
 * never paid on a non-interactive run.
 *
 * ONE Ink instance is mounted lazily on the first prompt and kept alive for
 * the whole interview, torn down only in `close()`. An earlier version
 * mounted a fresh instance per question instead — that toggled raw mode
 * off (on unmount) and back on (on the next mount) between every single
 * question, and empirically, over a real pty, a keystroke landing in that
 * gap got echoed to the screen instead of consumed, and could be lost or
 * misrouted entirely (arrow-key-then-Enter on the second question the
 * default readline-vs-Ink smoke test tried was the one that caught it —
 * the model select accepted the arrow move but the following Enter never
 * registered). Keeping raw mode continuously enabled for the interview's
 * entire lifetime removes the gap outright, and is also just the correct
 * Ink pattern for a multi-step wizard: finished questions accumulate in an
 * `<Static>` list (rendered once, never touched again — exactly the
 * "leaves the final frame in scrollback" transcript this asker owes
 * `runInterview()`) while the current question lives in one live slot
 * below it, both children of the SAME root, updated by `rerender()`.
 *
 * `exitOnCtrlC: false`: `spf watch` and `core/session.ts` own SIGINT/
 * SIGTERM handling, and Ink's default Ctrl-C behavior would call
 * `process.exit()` out from under both. Ctrl-C (and Ctrl-D, treated the
 * same way the readline asker treats EOF) is instead caught once, at the
 * root, and turned into the same `InterviewAborted` the readline asker
 * throws — `initCommand` catches it and exits 130, writing nothing.
 */
import { useRef, useState, type ReactElement } from "react";
import { render, Static, Box, Text, useInput } from "ink";
import { ConfirmInput, PasswordInput, TextInput } from "@inkjs/ui";
import type { Asker, SelectChoice } from "../ask.ts";
import { InterviewAborted, maskForPrompt } from "../ask.ts";
import { paint } from "../../core/console.ts";

/**
 * The real `stdin`/`stdout` pair the interview reads/writes — defaults to
 * the process's own. `src/test/ink_asker.test.ts` passes a fake TTY pair
 * instead (`node --test` has neither a real terminal nor raw-mode
 * support), the same seam Ink's own render options already expose; this
 * is not new surface, just threaded through so a test can reach it.
 */
export interface RenderStreams {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}

/** One finished line for the `<Static>` history — a heading, a note, or a completed question rendered in its answered form. */
interface HistoryLine {
  key: number;
  node: ReactElement;
}

/** What `createInkAsker()`'s imperative methods use to drive the one persistent root: append a finished line, or replace the live prompt slot. Populated by `InterviewRoot` on every render (a plain mutable holder, not React state — same bridge pattern `useImperativeHandle` formalizes, just without the ref machinery this doesn't need). */
interface Handle {
  pushHistory(node: ReactElement): void;
  setPrompt(node: ReactElement | null): void;
}

function InterviewRoot(props: { handleRef: { current: Handle | null }; onAbort: () => void }): ReactElement {
  const [history, setHistory] = useState<HistoryLine[]>([]);
  const [prompt, setPrompt] = useState<ReactElement | null>(null);
  // A ref, not `useState` — two `pushHistory` calls can happen back to back
  // synchronously (e.g. `heading()` immediately followed by `note()`, exactly
  // how `runInterview()` opens each section) with no re-render in between to
  // flush a `nextKey` state update, so both would read the same stale value
  // and mint duplicate keys. A ref's mutation is immediate or it wouldn't be
  // safe as a counter at all.
  const keyRef = useRef(0);

  props.handleRef.current = {
    pushHistory(node) {
      const key = keyRef.current++;
      setHistory((h) => [...h, { key, node }]);
    },
    setPrompt,
  };

  useInput((input, key) => {
    if (key.ctrl && (input === "c" || input === "d")) props.onAbort();
  });

  return (
    <Box flexDirection="column">
      <Static items={history}>{(line) => <Box key={line.key}>{line.node}</Box>}</Static>
      {prompt}
    </Box>
  );
}

function TextPromptView(props: {
  label: string;
  defaultValue?: string;
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void;
}): ReactElement {
  const [error, setError] = useState<string | null>(null);
  // `TextInput` is uncontrolled — `defaultValue` only seeds its FIRST value,
  // so a rejected submit otherwise leaves the rejected text sitting in the
  // box and whatever's typed next appends onto it instead of replacing it.
  // Changing `key` forces React to unmount and remount a fresh instance
  // (starting empty again) on every rejection, which is the standard way
  // to "reset" an uncontrolled component.
  const [attempt, setAttempt] = useState(0);
  return (
    <Box flexDirection="column">
      <Box>
        <Text>{props.label}</Text>
        {props.defaultValue ? <Text dimColor> [{props.defaultValue}]</Text> : null}
        <Text>: </Text>
        <TextInput
          key={attempt}
          defaultValue={props.defaultValue}
          onSubmit={(value) => {
            const resolved = value || props.defaultValue || "";
            const problem = props.validate?.(resolved) ?? null;
            if (problem) {
              setError(problem);
              setAttempt((n) => n + 1);
              return;
            }
            props.onSubmit(resolved);
          }}
        />
      </Box>
      {error ? <Text color="red">  {error}</Text> : null}
    </Box>
  );
}

/**
 * Hand-rolled instead of `@inkjs/ui`'s `Select` — that component's
 * `onChange` only fires when its internal `value` differs from
 * `previousValue` (`use-select-state.js`'s reducer + effect), and accepting
 * the already-highlighted default via an immediate Enter, with no arrow
 * key pressed first, never changes that value. That's the single most
 * common interaction with any select prompt (take the default), so the
 * bug isn't an edge case: every `select()` call whose first keypress is
 * Enter would hang forever. Confirmed empirically before writing this —
 * the same prompt resolves instantly the moment an arrow key precedes
 * Enter. `ConfirmInput`/`TextInput`/`PasswordInput` call their callbacks
 * unconditionally from their own input handlers and don't share this bug,
 * so they're untouched.
 */
function SelectPromptView<T extends string>(props: {
  label: string;
  choices: SelectChoice<T>[];
  dflt: T;
  onSubmit: (value: T) => void;
}): ReactElement {
  const dfltIndex = props.choices.findIndex((c) => c.value === props.dflt);
  const [index, setIndex] = useState(dfltIndex === -1 ? 0 : dfltIndex);
  useInput((_input, key) => {
    if (key.downArrow) setIndex((i) => Math.min(props.choices.length - 1, i + 1));
    if (key.upArrow) setIndex((i) => Math.max(0, i - 1));
    if (key.return) props.onSubmit(props.choices[index]!.value);
  });
  return (
    <Box flexDirection="column">
      <Text>{props.label}</Text>
      {props.choices.map((c, i) => {
        const focused = i === index;
        const hint = c.hint ? paint("dim", ` — ${c.hint}`) : "";
        return (
          <Text key={c.value} color={focused ? "cyan" : undefined}>
            {focused ? "❯ " : "  "}
            {c.label ?? c.value}
            {hint}
          </Text>
        );
      })}
    </Box>
  );
}

function ConfirmPromptView(props: { label: string; dflt: boolean; onSubmit: (value: boolean) => void }): ReactElement {
  return (
    <Box>
      <Text>{props.label} </Text>
      <ConfirmInput defaultChoice={props.dflt ? "confirm" : "cancel"} onConfirm={() => props.onSubmit(true)} onCancel={() => props.onSubmit(false)} />
    </Box>
  );
}

function SecretPromptView(props: { label: string; current?: string; onSubmit: (value: string) => void }): ReactElement {
  return (
    <Box>
      <Text>{props.label}</Text>
      {props.current ? <Text dimColor> [keep current: {maskForPrompt(props.current)}]</Text> : null}
      <Text>: </Text>
      <PasswordInput onSubmit={props.onSubmit} />
    </Box>
  );
}

export function createInkAsker(streams: RenderStreams = {}): Asker {
  // Mirrors `createAsker()`'s own `aborted` flag: once a Ctrl-C/Ctrl-D fires,
  // every later call throws immediately instead of showing a prompt that
  // would just get torn down again.
  let aborted = false;
  // Whichever prompt is currently live — `InterviewRoot`'s single Ctrl-C/
  // Ctrl-D handler rejects THIS, whatever it is, since only one prompt is
  // ever showing at a time.
  let currentReject: ((error: unknown) => void) | null = null;

  let app: ReturnType<typeof render> | undefined;
  const handleRef: { current: Handle | null } = { current: null };

  function handle(): Handle {
    if (!app) {
      app = render(
        <InterviewRoot
          handleRef={handleRef}
          onAbort={() => {
            aborted = true;
            currentReject?.(new InterviewAborted());
          }}
        />,
        // `interactive: true` overrides Ink's own auto-detection
        // (`stdout.isTTY` + the `is-in-ci` package) rather than relying on
        // it: the caller here is `commands/init.ts`, which only ever
        // reaches this file after `inkAvailable()` has ALREADY confirmed a
        // real interactive terminal — that check is the one source of
        // truth, and Ink's own CI detection is redundant at best. At
        // worst it actively lies: GitHub Actions sets `CI=true`
        // unconditionally, and `node --test` running there is exactly
        // where this file's own test suite (`ink_asker.test.ts`) drives a
        // real Ink instance against a fake TTY that reports `isTTY: true`
        // — Ink's non-interactive mode then writes NOTHING incrementally
        // (only the final frame, at unmount), so `stdout.frames` never
        // grows and every keystroke-driven test hangs until its own
        // timeout. Confirmed by reproducing the exact CI failure locally
        // with `CI=1 node --test ...` before this fix, and confirming it
        // disappears after.
        { ...streams, exitOnCtrlC: false, patchConsole: false, interactive: true },
      );
    }
    // `InterviewRoot` populates this synchronously during its first render,
    // which `render()` above has already forced to happen by the time it
    // returns.
    return handleRef.current!;
  }

  async function guarded<T>(run: (h: Handle) => Promise<T>): Promise<T> {
    if (aborted) throw new InterviewAborted();
    try {
      return await run(handle());
    } catch (error) {
      if (error instanceof InterviewAborted) aborted = true;
      throw error;
    } finally {
      currentReject = null;
    }
  }

  return {
    text(label, opts) {
      return guarded(
        (h) =>
          new Promise<string>((resolve, reject) => {
            currentReject = reject;
            h.setPrompt(
              <TextPromptView
                label={label}
                defaultValue={opts?.default}
                validate={opts?.validate}
                onSubmit={(value) => {
                  h.setPrompt(null);
                  h.pushHistory(<Text>{label}: {value}</Text>);
                  resolve(value);
                }}
              />,
            );
          }),
      );
    },

    select<T extends string>(label: string, choices: SelectChoice<T>[], dflt: T): Promise<T> {
      return guarded(
        (h) =>
          new Promise<T>((resolve, reject) => {
            currentReject = reject;
            h.setPrompt(
              <SelectPromptView
                label={label}
                choices={choices}
                dflt={dflt}
                onSubmit={(value) => {
                  const chosen = choices.find((c) => c.value === value);
                  h.setPrompt(null);
                  h.pushHistory(
                    <Text>
                      {label} <Text color="cyan">❯ {chosen?.label ?? value}</Text>
                    </Text>,
                  );
                  resolve(value);
                }}
              />,
            );
          }),
      );
    },

    confirm(label, dflt, opts) {
      return guarded(
        (h) =>
          new Promise<boolean>((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            currentReject = reject;

            const finish = (value: boolean, note?: string) => {
              if (settled) return;
              settled = true;
              if (timer) clearTimeout(timer);
              h.setPrompt(null);
              h.pushHistory(
                <Text>
                  {label} {value ? "yes" : "no"}
                  {note ? <Text color="yellow"> ({note})</Text> : null}
                </Text>,
              );
              resolve(value);
            };

            if (opts?.timeoutMs !== undefined) {
              timer = setTimeout(() => finish(dflt, `timed out — using default (${dflt ? "yes" : "no"})`), opts.timeoutMs);
              timer.unref?.();
            }

            h.setPrompt(<ConfirmPromptView label={label} dflt={dflt} onSubmit={(value) => finish(value)} />);
          }),
      );
    },

    secret(label, opts) {
      return guarded(
        (h) =>
          new Promise<string>((resolve, reject) => {
            currentReject = reject;
            h.setPrompt(
              <SecretPromptView
                label={label}
                current={opts?.current}
                onSubmit={(value) => {
                  h.setPrompt(null);
                  h.pushHistory(<Text>{label}: {value ? maskForPrompt(value) : "(unchanged)"}</Text>);
                  resolve(value);
                }}
              />,
            );
          }),
      );
    },

    note(text) {
      if (aborted) return;
      handle().pushHistory(<Text dimColor>  {text}</Text>);
    },

    heading(text) {
      if (aborted) return;
      handle().pushHistory(<Text bold color="cyan">── {text} ──</Text>);
    },

    close() {
      app?.unmount();
    },
  };
}
