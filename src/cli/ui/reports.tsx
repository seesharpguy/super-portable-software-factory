/**
 * Shared Ink renderers for the CLI's one-shot, non-interactive reports
 * (`doctor`, `sessions`, `phases`, `list`, `fanout`'s summary table). Unlike
 * `ink_asker.tsx`, nothing here ever calls `useInput` — no component reads
 * from stdin — so none of these ever engage raw mode (Ink only toggles it
 * from inside `useInput`'s own effect). A one-shot mount-render-unmount is
 * therefore safe here in a way it wasn't for the interview: there's no
 * question of a keystroke landing in a raw-mode gap, because raw mode never
 * turns on at all.
 *
 * Every caller stays responsible for its own `--json` branch and its own
 * `isInteractive()`/non-TTY fallback — this module only renders what it's
 * given, on a real terminal. A CI log or a piped `spf sessions` never
 * imports this file at all (see each command's call site), so nothing here
 * needs to reproduce the exact plain-text formatting the non-TTY path keeps
 * using unchanged.
 */
import type { ReactElement } from "react";
import { render, Box, Text } from "ink";

/**
 * Mounts, waits for the frame to actually flush, then unmounts — the frame
 * it just wrote stays in scrollback exactly like `console.log` output
 * would.
 *
 * A long, line-wrapping tree (doctor's ~25-line checklist reliably does
 * this) makes Ink emit an initial paint, then a corrective full
 * `clear-screen + clear-scrollback + home` repaint once it recalculates the
 * content's true height — the raw byte stream this writes really does
 * contain the whole tree twice, which reads as a bug if you inspect it
 * with `grep`/`wc` the way a naive capture would. It isn't one: replayed
 * through an actual terminal emulator (verified with `pyte`, not just
 * eyeballed), the erase sequence takes effect exactly as a real terminal
 * would apply it, and only the corrected repaint remains on screen —
 * confirmed for both `render()`'s default mode and `incrementalRendering:
 * true` (neither changes the outcome; this file uses the default).
 * `waitUntilRenderFlush()` before `unmount()` is still worth keeping: it's
 * the correct way to let that settle before tearing the instance down,
 * even though skipping it turned out not to be the duplicate's actual
 * cause.
 */
async function paint(node: ReactElement): Promise<void> {
  // `interactive: true` overrides Ink's own `stdout.isTTY`/`is-in-ci`
  // auto-detection — every caller here already reached this file only
  // after its own `isInteractive()` check passed (which itself checks
  // `!process.env["CI"]`), so Ink's redundant CI detection can only ever
  // disagree by mistake. See `ink_asker.tsx`'s identical `render()` call
  // for where disagreeing actually broke something (a CI-run test hung).
  const app = render(node, { patchConsole: false, interactive: true });
  await app.waitUntilRenderFlush();
  app.unmount();
}

export type CheckIcon = "ok" | "fail" | "warn" | "info";

export interface CheckLine {
  icon: CheckIcon;
  name: string;
  detail: string;
}

const ICON_GLYPH: Record<CheckIcon, string> = { ok: "✓", fail: "✗", warn: "⚠", info: "ℹ" };
const ICON_COLOR: Record<CheckIcon, string> = { ok: "green", fail: "red", warn: "yellow", info: "cyan" };

/** `spf doctor`'s check list — same one line per check as the plain-text path, just with the icon colored instead of a bare glyph. */
export async function renderChecklist(lines: CheckLine[], footer: { ok: boolean; message: string }): Promise<void> {
  await paint(
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i}>
          <Text color={ICON_COLOR[line.icon]}>{ICON_GLYPH[line.icon]}</Text> {line.name}: {line.detail}
        </Text>
      ))}
      <Text> </Text>
      <Text color={footer.ok ? "green" : "red"}>{footer.message}</Text>
    </Box>,
  );
}

/**
 * A column-aligned table from pre-formatted string cells — callers still own
 * field selection/truncation (same as the `.padEnd()` code this replaces);
 * this only owns column width and alignment, via Ink's own box layout
 * instead of hand-computed pad strings. `rowColor(i)` colors an entire row
 * (e.g. red for a failed phase) — `undefined` leaves the terminal default.
 */
export async function renderTable(rows: string[][], opts?: { rowColor?: (rowIndex: number) => string | undefined }): Promise<void> {
  if (rows.length === 0) return;
  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: colCount }, (_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
  await paint(
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Box key={i}>
          {row.map((cell, c) => {
            const isLast = c === row.length - 1;
            return (
              <Box key={c} width={isLast ? undefined : widths[c]} marginRight={isLast ? 0 : 2}>
                <Text color={opts?.rowColor?.(i)}>{cell}</Text>
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>,
  );
}

export interface ChainListEntry {
  name: string;
  phases: string;
  describe: string;
  agentsLine: string;
  repoLabel?: string;
}

/** `spf list` — one styled block per chain (bold name, dimmed description) instead of the plain-text path's hand-padded columns. */
export async function renderChainList(entries: ChainListEntry[], footer: string[]): Promise<void> {
  await paint(
    <Box flexDirection="column">
      {entries.map((entry, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          <Text>
            <Text bold color="cyan">{entry.name}</Text> {entry.phases}
          </Text>
          <Text dimColor>  {entry.describe}</Text>
          <Text dimColor>  {entry.agentsLine}</Text>
          {entry.repoLabel ? <Text dimColor>  (repo: {entry.repoLabel})</Text> : null}
        </Box>
      ))}
      {footer.map((line, i) => (
        <Text key={i}>{line}</Text>
      ))}
    </Box>,
  );
}
