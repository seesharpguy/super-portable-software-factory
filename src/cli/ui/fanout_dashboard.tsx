/**
 * A live results table for `spf fanout` — the same columns
 * `cli/commands/fanout.ts`'s `printTable()` prints once at the end, updated
 * row by row as each attempt settles instead. Reached only through a
 * dynamic `import()` and only when `isInteractive()`; non-TTY keeps the
 * exact one-shot `printTable()` path, byte for byte (`fanout_cli.test.ts`
 * runs with no TTY, so it never touches this file).
 *
 * One persistent Ink instance for the whole `runBestOf()` call — same shape
 * as `run_dashboard.tsx`: a `<Static>` history for `deps.log()`'s own
 * lines (the "chain X x3 off main" opener, an "attempt N skipped" line —
 * `cli/commands/fanout.ts` routes these here instead of straight to
 * `console.log` specifically so nothing writes to stdout outside Ink while
 * this is mounted; interleaving a raw `console.log` with an active Ink
 * live region corrupts the redraw) plus a LIVE section below it — here,
 * the whole results table, not one line, since every row can still change
 * until the very last attempt settles and there's no "this phase is done"
 * moment to freeze one into history the way `run_dashboard.tsx` does per
 * phase. Nothing here calls `useInput`, so raw mode never engages.
 */
import { useState, useRef, type ReactElement } from "react";
import { render, Static, Box, Text } from "ink";
import * as agents from "../../core/agents.ts";
import { attemptAdwId, attemptBranch, type FanoutAttempt } from "../../core/fanout.ts";

interface HistoryLine {
  key: number;
  text: string;
}

interface Handle {
  setAttempt(attempt: FanoutAttempt): void;
  pushLog(text: string): void;
}

/** `null` = still running — nothing has settled yet for this index. */
type RowState = FanoutAttempt | null;

function statusLabel(row: RowState): string {
  if (!row) return "running…";
  return row.status;
}

function gatesLabel(row: RowState): string {
  if (!row || row.status === "skipped") return "-";
  return `${row.gate_passes}p/${row.gate_failures}f`;
}

function timeLabel(row: RowState): string {
  if (!row || row.status === "skipped") return "-";
  const seconds = row.wall_ms / 1000;
  return seconds < 90 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

function rowColor(row: RowState): string | undefined {
  if (!row) return "dim";
  if (row.status === "success") return "green";
  if (row.status === "fail" || row.status === "error") return "red";
  return undefined;
}

function FanoutRoot(props: {
  n: number;
  chainName: string;
  baseBranch: string;
  baseAdwId: string;
  handleRef: { current: Handle | null };
}): ReactElement {
  const [rows, setRows] = useState<Map<number, FanoutAttempt>>(new Map());
  const [log, setLog] = useState<HistoryLine[]>([]);
  const keyRef = useRef(0); // a ref, not state — see ink_asker.tsx's identical comment on why two pushes in one tick must not collide

  props.handleRef.current = {
    setAttempt(attempt) {
      setRows((prev) => {
        const next = new Map(prev);
        next.set(attempt.index, attempt);
        return next;
      });
    },
    pushLog(text) {
      const key = keyRef.current++;
      setLog((prev) => [...prev, { key, text }]);
    },
  };

  const indices = Array.from({ length: props.n }, (_, i) => i + 1);
  const widths = {
    adw: Math.max(6, ...indices.map((i) => attemptAdwId(props.baseAdwId, i).length)),
    branch: Math.max(6, ...indices.map((i) => attemptBranch(props.baseAdwId, i).length)),
  };

  return (
    <Box flexDirection="column">
      <Static items={log}>{(line) => <Text key={line.key}>{line.text}</Text>}</Static>
      <Text>
        fanout {props.chainName} — {props.n} attempt(s), base {props.baseBranch}
      </Text>
      <Box>
        <Box width={3}>
          <Text dimColor>#</Text>
        </Box>
        <Box width={widths.adw} marginRight={2}>
          <Text dimColor>adw_id</Text>
        </Box>
        <Box width={widths.branch} marginRight={2}>
          <Text dimColor>branch</Text>
        </Box>
        <Box width={9}>
          <Text dimColor>status</Text>
        </Box>
        <Box width={9}>
          <Text dimColor>gates</Text>
        </Box>
        <Box width={10}>
          <Text dimColor>cost</Text>
        </Box>
        <Text dimColor>time</Text>
      </Box>
      {indices.map((i) => {
        const row = rows.get(i) ?? null;
        const color = rowColor(row);
        return (
          <Box key={i}>
            <Box width={3}>
              <Text color={color}>{i}</Text>
            </Box>
            <Box width={widths.adw} marginRight={2}>
              <Text color={color}>{attemptAdwId(props.baseAdwId, i)}</Text>
            </Box>
            <Box width={widths.branch} marginRight={2}>
              <Text color={color}>{attemptBranch(props.baseAdwId, i)}</Text>
            </Box>
            <Box width={9}>
              <Text color={color}>{statusLabel(row)}</Text>
            </Box>
            <Box width={9}>
              <Text color={color}>{gatesLabel(row)}</Text>
            </Box>
            <Box width={10}>
              <Text color={color}>{row ? agents.formatUsd(row.cost) : "-"}</Text>
            </Box>
            <Text color={color}>{timeLabel(row)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export interface FanoutDashboard {
  onAttempt: (attempt: FanoutAttempt) => void;
  /** Routes `FanoutDeps.log()` here instead of `console.log` while this is mounted — see the module header for why a raw console write can't share the terminal with an active Ink instance. */
  log: (message: string) => void;
  /** Tears the Ink instance down. Call exactly once, after `runBestOf()` settles — the plain-text winner/basis lines after it are unaffected; only the redundant header + final table are skipped when a dashboard was used (see `cli/commands/fanout.ts`'s call site). */
  close(): Promise<void>;
  /**
   * Synchronous, no flush-wait — for a signal handler, which stays
   * synchronous by design and gets cut off by `process.exit()` immediately
   * after: an `await` here would never get a chance to resume. Only
   * restores terminal state (cursor visibility) on a best-effort basis; the
   * final frame may not have caught up to the last attempt yet.
   */
  unmountNow(): void;
}

export function mountFanoutDashboard(opts: { n: number; chainName: string; baseBranch: string; baseAdwId: string }): FanoutDashboard {
  const handleRef: { current: Handle | null } = { current: null };
  const app = render(
    <FanoutRoot n={opts.n} chainName={opts.chainName} baseBranch={opts.baseBranch} baseAdwId={opts.baseAdwId} handleRef={handleRef} />,
    // `interactive: true` overrides Ink's own CI auto-detection — see
    // `ink_asker.tsx`'s identical `render()` call for why: the caller
    // (`commands/fanout.ts`) only reaches this file after its own
    // `isInteractive()` check has already passed.
    { patchConsole: false, interactive: true },
  );

  return {
    onAttempt(attempt) {
      handleRef.current?.setAttempt(attempt);
    },
    log(message) {
      handleRef.current?.pushLog(message);
    },
    async close() {
      await app.waitUntilRenderFlush();
      app.unmount();
    },
    unmountNow() {
      app.unmount();
    },
  };
}
