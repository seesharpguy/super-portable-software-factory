/**
 * A live status line for `spf watch` — the exact same log lines
 * `WatchDeps.log()` already prints (the daemon banner, each tick's
 * claim/finish lines), in a `<Static>` history, plus one live line below
 * it: how many issues are in flight, how many are being refined, and a
 * countdown to the next poll.
 *
 * `core/watch.ts` is untouched — this only ever swaps `cli/commands/
 * watch.ts`'s own `WatchDeps.log` callback and reads `WatchRunState`'s
 * public `.size` after each `tick()` returns, exactly the seam the plan
 * called for ("no core changes"). `notify` keeps going to the real
 * `Notifier` unchanged (Slack/Teams/webhook delivery has nothing to do
 * with terminal rendering); this only ALSO mirrors a one-line summary of
 * each event into the same log history, for visibility.
 *
 * One persistent Ink instance for the whole `spf watch` invocation — same
 * shape as `run_dashboard.tsx`/`fanout_dashboard.tsx`. `spf watch`'s own
 * SIGINT handling exits immediately on a second Ctrl-C (`process.exit(130)`
 * in `commands/watch.ts`'s `stop()`), so `unmountNow()` exists here for the
 * same best-effort, no-flush-wait reason `fanout_dashboard.tsx`'s does.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { render, Static, Box, Text } from "ink";
import type { NotifyEvent } from "../../core/notify/channel.ts";

interface HistoryLine {
  key: number;
  text: string;
}

interface Handle {
  pushLog(text: string): void;
  setCounts(inflight: number, refining: number): void;
  setNextPollAt(deadlineMs: number | null): void;
}

function Countdown({ deadlineMs }: { deadlineMs: number }): ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, Math.round((deadlineMs - now) / 1000));
  return <Text dimColor>next poll in {remaining}s</Text>;
}

function WatchRoot(props: {
  repo: string;
  labelPrefix: string;
  chain: string;
  concurrency: number;
  refineChain?: string;
  refineConcurrency?: number;
  dryRun: boolean;
  handleRef: { current: Handle | null };
}): ReactElement {
  const [log, setLog] = useState<HistoryLine[]>([]);
  const [counts, setCounts] = useState({ inflight: 0, refining: 0 });
  const [nextPollAt, setNextPollAt] = useState<number | null>(null);
  const keyRef = useRef(0); // a ref, not state — see ink_asker.tsx's identical comment on why two pushes in one tick must not collide

  props.handleRef.current = {
    pushLog(text) {
      const key = keyRef.current++;
      setLog((prev) => [...prev, { key, text }]);
    },
    setCounts: (inflight, refining) => setCounts({ inflight, refining }),
    setNextPollAt,
  };

  return (
    <Box flexDirection="column">
      <Static items={log}>{(line) => <Text key={line.key}>{line.text}</Text>}</Static>
      <Box>
        <Text>
          {props.repo} <Text dimColor>label "{props.labelPrefix}:*" · chain "{props.chain}" · concurrency {props.concurrency}</Text>
          {props.refineChain ? (
            <Text dimColor>
              {" "}
              · refine "{props.refineChain}" concurrency {props.refineConcurrency}
            </Text>
          ) : null}
          {props.dryRun ? <Text color="yellow"> (dry run)</Text> : null}
        </Text>
      </Box>
      <Box>
        <Text>
          <Text color={counts.inflight > 0 ? "cyan" : undefined}>{counts.inflight} in flight</Text>
          {counts.refining > 0 ? <Text color="magenta">, {counts.refining} refining</Text> : null}
          {" · "}
        </Text>
        {nextPollAt !== null ? <Countdown deadlineMs={nextPollAt} /> : <Text dimColor>ticking…</Text>}
      </Box>
    </Box>
  );
}

export interface WatchDashboard {
  log: (message: string) => void;
  /** Mirrors a one-line summary into the same log history — delivery to the real `Notifier` is unaffected; call this alongside it, never instead of it. */
  mirrorNotify: (event: NotifyEvent) => void;
  setCounts: (inflight: number, refining: number) => void;
  /** `null` while a tick is running or the daemon is draining — clears the countdown instead of showing a stale or negative one. */
  setNextPollAt: (deadlineMs: number | null) => void;
  /** Tears the Ink instance down. Call once, in the same `finally` `commands/watch.ts` already releases its lockfile in. */
  close(): Promise<void>;
  /** Synchronous, no flush-wait — for `stop()`'s second-Ctrl-C `process.exit(130)` path, same reasoning as `fanout_dashboard.tsx`'s `unmountNow()`. */
  unmountNow(): void;
}

export function mountWatchDashboard(opts: {
  repo: string;
  labelPrefix: string;
  chain: string;
  concurrency: number;
  refineChain?: string;
  refineConcurrency?: number;
  dryRun: boolean;
}): WatchDashboard {
  const handleRef: { current: Handle | null } = { current: null };
  const app = render(
    <WatchRoot
      repo={opts.repo}
      labelPrefix={opts.labelPrefix}
      chain={opts.chain}
      concurrency={opts.concurrency}
      refineChain={opts.refineChain}
      refineConcurrency={opts.refineConcurrency}
      dryRun={opts.dryRun}
      handleRef={handleRef}
    />,
    { patchConsole: false },
  );

  return {
    log(message) {
      handleRef.current?.pushLog(message);
    },
    mirrorNotify(event) {
      handleRef.current?.pushLog(`[notify] ${event.title}${event.detail ? ` — ${event.detail}` : ""}`);
    },
    setCounts(inflight, refining) {
      handleRef.current?.setCounts(inflight, refining);
    },
    setNextPollAt(deadlineMs) {
      handleRef.current?.setNextPollAt(deadlineMs);
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
