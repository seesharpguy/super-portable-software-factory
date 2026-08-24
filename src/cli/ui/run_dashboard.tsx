/**
 * A live TTY view for `spf <chain>` / `spf run <chain>` — the phase-by-phase
 * transcript `core/console.ts` already prints, in a `<Static>` history
 * exactly as it always read, plus one live line below it: the currently
 * running phase, an elapsed timer, and spend so far (against a ceiling,
 * when `defaults.max_run_cost`/`max_run_tokens` configure one).
 *
 * Reached only through a dynamic `import()` from `cli/commands/run.ts`, and
 * only when `isInteractive()` — a CI log or a piped `spf <chain>` never
 * imports this file, and `core/console.ts`'s default `sink`
 * (`console.log`) and `observer` (`null`) reproduce today's plain-line
 * behavior exactly. `RunObserver`'s hooks are deliberately the only signal
 * this reads — never a re-parse of the printed lines themselves (see its
 * doc comment in `core/console.ts`).
 *
 * One persistent Ink instance for the whole run, same reasoning as
 * `ink_asker.tsx`: nothing here calls `useInput`, so raw mode never
 * engages and there's no per-line mount/unmount race to worry about — but
 * `simple_sdlc.ts`'s human sign-off prompt DOES call `useInput` (through
 * `createInkAsker()`/`createAsker()`) mid-run, and two live Ink instances
 * cannot share one stdout. `pause()`/`resume()` exist for exactly that
 * handoff — `cli/commands/run.ts` calls `pause()` before the chain can
 * reach a sign-off prompt... except it can't know when that will happen
 * either, so instead this dashboard is paused/resumed by the same
 * `unattended`/interactive gate `decideSignoff` already uses: see
 * `run.ts`'s comment at its mount site.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { render, Static, Box, Text } from "ink";
import type { Phase } from "../../core/data_types.ts";
import type { RunObserver } from "../../core/console.ts";

interface HistoryLine {
  key: number;
  text: string;
}

interface LivePhase {
  name: string;
  kind: string;
  owner: string;
  startedAtMs: number;
}

interface DashboardHandle {
  pushHistory(text: string): void;
  setLivePhase(phase: LivePhase | null): void;
  setUsage(tokens: number, cost: number): void;
}

function formatUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function Elapsed({ sinceMs }: { sinceMs: number }): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.max(0, (now - sinceMs) / 1000);
  return <Text dimColor>{seconds.toFixed(0)}s</Text>;
}

function DashboardRoot(props: {
  maxCost?: number;
  maxTokens?: number;
  handleRef: { current: DashboardHandle | null };
  initialLive: LivePhase | null;
  initialUsage: { tokens: number; cost: number };
}): ReactElement {
  const [history, setHistory] = useState<HistoryLine[]>([]);
  const [live, setLive] = useState<LivePhase | null>(props.initialLive);
  const [usage, setUsage] = useState(props.initialUsage);
  const keyRef = useRef(0); // see ink_asker.tsx's identical comment — a ref, not state, so two pushes in one tick never collide

  props.handleRef.current = {
    pushHistory(text) {
      const key = keyRef.current++;
      setHistory((h) => [...h, { key, text }]);
    },
    setLivePhase: setLive,
    setUsage: (tokens, cost) => setUsage({ tokens, cost }),
  };

  const overCost = props.maxCost !== undefined && usage.cost >= props.maxCost * 0.8;
  const overTokens = props.maxTokens !== undefined && usage.tokens >= props.maxTokens * 0.8;

  return (
    <Box flexDirection="column">
      <Static items={history}>{(line) => <Text key={line.key}>{line.text}</Text>}</Static>
      {live ? (
        <Box>
          <Text color="magenta">▸ running: </Text>
          <Text bold>{live.name}</Text>
          <Text dimColor> ({live.kind} · {live.owner}) </Text>
          <Elapsed sinceMs={live.startedAtMs} />
        </Box>
      ) : null}
      <Box>
        <Text dimColor>
          spend: {usage.tokens.toLocaleString()} tokens · {formatUsd(usage.cost)}
          {props.maxCost !== undefined ? ` / ${formatUsd(props.maxCost)}` : ""}
          {props.maxTokens !== undefined ? ` (of ${props.maxTokens.toLocaleString()} tokens)` : ""}
        </Text>
        {overCost || overTokens ? <Text color="yellow"> — approaching ceiling</Text> : null}
      </Box>
    </Box>
  );
}

export interface RunDashboard {
  sink: (line: string) => void;
  observer: RunObserver;
  /** Detaches the live phase/spend slot and stops the elapsed-time ticker, then tears the Ink instance down entirely — call around a nested prompt (the sign-off gate) that needs the terminal to itself. Awaits the pending frame flush first: unmounting before Ink's initial commit for a fresh/updated tree has actually flushed can drop the whole accumulated `<Static>` history instead of leaving it in scrollback (confirmed empirically — the exact failure mode `reports.tsx`'s `paint()` guards against, just worse here: nothing printed at all instead of printing twice). */
  pause(): Promise<void>;
  /** Re-attaches after `pause()`. */
  resume(): void;
  /** Tears the Ink instance down. Call exactly once, when the run finishes (success or error) — same "call this in both the try and the catch" discipline `asker.close()` already follows in `commands/init.ts`. Same flush-before-unmount reasoning as `pause()`. */
  close(): Promise<void>;
}

export function mountRunDashboard(opts: { maxCost?: number; maxTokens?: number }): RunDashboard {
  const handleRef: { current: DashboardHandle | null } = { current: null };
  let currentPhase: LivePhase | null = null;
  let currentUsage = { tokens: 0, cost: 0 };
  // `undefined` while paused: Ink refuses a second `render()` on the same
  // stdout while a prior instance is still live (the same restriction
  // `ink_asker.tsx`'s confirm-timeout comment names), and the sign-off
  // prompt's own Ink instance needs the terminal to itself. `pause()`
  // fully unmounts rather than just hiding state; `resume()` mounts a
  // fresh instance seeded with whatever `currentPhase`/`currentUsage`
  // were at the moment of the handoff, so the live line picks up exactly
  // where it left off instead of resetting to "nothing running".
  let app: ReturnType<typeof render> | undefined;

  function mount(): void {
    app = render(
      <DashboardRoot
        maxCost={opts.maxCost}
        maxTokens={opts.maxTokens}
        handleRef={handleRef}
        initialLive={currentPhase}
        initialUsage={currentUsage}
      />,
      // `interactive: true` overrides Ink's own CI auto-detection — see
      // `ink_asker.tsx`'s identical `render()` call for why: the caller
      // (`commands/run.ts`) only reaches this file after its own
      // `isInteractive()` check has already passed.
      { patchConsole: false, interactive: true },
    );
  }
  mount();

  const sink = (line: string) => {
    // Never silently dropped, even while paused: falls back to the exact
    // default `Console` would use on its own (`console.log`) rather than
    // lose the printed half of "one narrative, two destinations" during
    // the handoff window.
    if (!app) {
      console.log(line);
      return;
    }
    handleRef.current?.pushHistory(line);
  };

  const observer: RunObserver = {
    onPhaseStart(phase: Phase) {
      currentPhase = { name: phase.params.name, kind: phase.params.kind, owner: phase.params.owner, startedAtMs: Date.now() };
      // `currentPhase`/`currentUsage` above are updated regardless of `app`
      // so a `resume()` after this always seeds the fresh mount correctly,
      // even if the phase/usage change itself happened while paused.
      if (app) handleRef.current?.setLivePhase(currentPhase);
    },
    onPhaseEnd() {
      currentPhase = null;
      if (app) handleRef.current?.setLivePhase(null);
    },
    onUsage(tokens, cost) {
      currentUsage = { tokens, cost };
      if (app) handleRef.current?.setUsage(tokens, cost);
    },
  };

  async function unmount(): Promise<void> {
    if (!app) return;
    const current = app;
    await current.waitUntilRenderFlush();
    current.unmount();
    app = undefined;
  }

  return {
    sink,
    observer,
    pause: unmount,
    resume() {
      if (!app) mount();
    },
    close: unmount,
  };
}
