/**
 * A local "factory board" channel for [herdr](https://herdr.dev), the terminal
 * multiplexer for coding agents. Where Slack/Teams/webhook push a message
 * somewhere else, this one drives herdr's socket API so the herdr sidebar
 * shows what `spf watch` is doing: one pane per claimed issue, tailing that
 * run's trace, with its state (`working` / `blocked` / `idle`) reported the
 * same way herdr's own built-in agent integrations report theirs.
 *
 * Display only, on purpose. Nothing here reads herdr back to decide anything,
 * and no agent ever touches the socket: the chain still owns sequencing,
 * retries, and acceptance. herdr is the glass, not the brain.
 *
 * Only resolves when spf itself is running inside a herdr pane
 * (`HERDR_ENV=1` plus `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`, which herdr
 * injects into every pane) — issue panes are split off spf's own pane, so
 * there has to be one. Outside herdr, `resolveNotifier` skips this channel
 * with one warning, the same as a webhook channel whose env var is unset.
 *
 * Wire format (herdr API protocol 17): one newline-terminated JSON request
 * `{id, method, params}` per Unix-socket connection, one JSON line back —
 * `{id, result}` or `{id, error: {code, message}}`.
 */
import net from "node:net";
import type { NotificationChannel, NotifyEvent } from "./channel.ts";

/** The `source` herdr records as owning the state spf reports. */
export const HERDR_SOURCE = "spf";
const AGENT = "spf";

export interface HerdrEnv {
  socketPath: string;
  paneId: string;
}

/** The herdr pane spf is running in, or `null` when it isn't running inside herdr. */
export function herdrEnvFrom(env: NodeJS.ProcessEnv = process.env): HerdrEnv | null {
  const socketPath = (env.HERDR_SOCKET_PATH || "").trim();
  const paneId = (env.HERDR_PANE_ID || "").trim();
  if (env.HERDR_ENV !== "1" || !socketPath || !paneId) return null;
  return { socketPath, paneId };
}

/** One request over herdr's socket. Rejects on an API error, a dropped connection, or `timeoutMs`. */
export function herdrRequest(socketPath: string, method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = `${HERDR_SOURCE}:${Date.now()}:${Math.floor(Math.random() * 1_000_000)}`;
    const client = net.createConnection(socketPath, () => {
      client.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    let buffer = "";
    const fail = (error: Error) => {
      client.destroy();
      reject(error);
    };
    client.setTimeout(timeoutMs, () => fail(new Error(`herdr ${method} timed out after ${timeoutMs}ms`)));
    client.on("error", (error) => fail(new Error(`herdr ${method}: ${error.message}`)));
    client.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      client.destroy();
      let response: { result?: Record<string, unknown>; error?: { message?: string } };
      try {
        response = JSON.parse(buffer.slice(0, newline));
      } catch {
        reject(new Error(`herdr ${method}: unparseable response`));
        return;
      }
      if (response.error) reject(new Error(`herdr ${method}: ${response.error.message ?? "error"}`));
      else resolve(response.result ?? {});
    });
    client.on("end", () => fail(new Error(`herdr ${method}: connection closed before a response`)));
  });
}

// Module-level, not per-instance: `spf watch` resolves one notifier for the
// daemon and `session.ts` resolves another for every chain run it dispatches,
// all in the same process. The claim event arrives on the daemon's channel and
// the phase events on the run's, so the run -> pane map and the request queue
// (a pane must exist before anything reports on it) have to be shared.
const PANES = new Map<string, string>();
let queue: Promise<void> = Promise.resolve();
let seq = Date.now() * 1000;
let watchActive = false;

/** Test-only: forget every pane and the watch flag between cases. */
export function resetHerdrState(): void {
  PANES.clear();
  queue = Promise.resolve();
  watchActive = false;
}

// Issue ids come from the tracker and end up typed into a shell in the pane, so
// only ids that are plainly safe get a trace tail (GitHub's numbers, Jira's
// PROJ-12). Anything else still gets a pane and state — just no tail.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

const SPEC_KINDS = new Set<NotifyEvent["kind"]>(["spec_refined", "spec_needs_feedback", "spec_split_proposed", "spec_done"]);
const RUN_KINDS = new Set<NotifyEvent["kind"]>(["run_started", "run_finished", "run_failed", "phase_failed", "phase_retry"]);

function field(event: NotifyEvent, key: string): string {
  return event.fields.find(([k]) => k === key)?.[1] ?? "";
}

/** `issue-42` / `spec-42` — the same adw_id `spf watch` gives that issue's single-lane run. */
function runKeyFor(event: NotifyEvent): string | null {
  const issue = field(event, "issue");
  if (!issue) return null;
  const isSpec = SPEC_KINDS.has(event.kind) || /^\[[^\]]*\] spec |^spec /.test(event.title);
  return `${isSpec ? "spec" : "issue"}-${issue}`;
}

/** The registered run whose adw_id this is — `issue-42`, or a fan-out attempt like `issue-42-2` / `issue-42-r1-3`. */
function paneKeyForAdw(adwId: string): string | null {
  for (const key of PANES.keys()) {
    if (adwId === key || adwId.startsWith(`${key}-`)) return key;
  }
  return null;
}

function firstLine(text: string | undefined, max = 120): string {
  const line = (text || "").split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export class HerdrChannel implements NotificationChannel {
  readonly label: string;

  constructor(
    private readonly env: HerdrEnv,
    private readonly opts: {
      /** Where issue panes open, and where `spf events` resolves the trace db. */
      cwd: string;
    },
    name: string = "",
  ) {
    this.label = name ? `herdr (${name})` : "herdr";
  }

  send(event: NotifyEvent, timeoutMs: number): Promise<void> {
    const task = queue.then(() => this.handle(event, timeoutMs));
    queue = task.catch(() => undefined);
    return task;
  }

  private call(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    return herdrRequest(this.env.socketPath, method, params, timeoutMs);
  }

  private report(paneId: string, state: "idle" | "working" | "blocked", message: string, timeoutMs: number) {
    return this.call("pane.report_agent", { pane_id: paneId, source: HERDR_SOURCE, agent: AGENT, state, message: message || null, seq: ++seq }, timeoutMs);
  }

  private retitle(paneId: string, title: string, stateLabels: Record<string, string>, timeoutMs: number) {
    return this.call("pane.report_metadata", { pane_id: paneId, source: HERDR_SOURCE, title, state_labels: stateLabels, seq: ++seq }, timeoutMs);
  }

  private toast(event: NotifyEvent, timeoutMs: number) {
    return this.call("notification.show", { title: event.title, body: firstLine(event.detail, 300) || null, sound: "request" }, timeoutMs);
  }

  private async handle(event: NotifyEvent, timeoutMs: number): Promise<void> {
    if (RUN_KINDS.has(event.kind)) return this.handleRun(event, timeoutMs);

    switch (event.kind) {
      case "watch_started":
        watchActive = true;
        await this.report(this.env.paneId, "idle", "watching", timeoutMs);
        await this.retitle(this.env.paneId, "spf watch", { idle: "watching" }, timeoutMs);
        return;
      case "watch_stopped":
        watchActive = false;
        await this.call("pane.release_agent", { pane_id: this.env.paneId, source: HERDR_SOURCE, agent: AGENT, seq: ++seq }, timeoutMs);
        return;
      case "watch_error":
        await this.toast(event, timeoutMs);
        return;
      case "issue_claimed":
        return this.claim(event, timeoutMs);
    }

    const key = runKeyFor(event);
    const paneId = key ? PANES.get(key) : undefined;
    const issue = field(event, "issue");
    const title = field(event, "title");

    switch (event.kind) {
      case "pr_opened":
      case "pr_updated":
        if (paneId) {
          await this.report(paneId, "idle", `PR ${field(event, "pr")} in review`.trim(), timeoutMs);
          await this.retitle(paneId, `${issue} ${title}`.trim(), { idle: "in review" }, timeoutMs);
        }
        return;
      case "spec_refined":
        if (paneId) {
          await this.report(paneId, "idle", "refined", timeoutMs);
          await this.retitle(paneId, `${issue} ${title}`.trim(), { idle: "refined" }, timeoutMs);
        }
        return;
      case "issue_blocked":
      case "spec_needs_feedback":
      case "spec_split_proposed":
        if (paneId) await this.report(paneId, "blocked", firstLine(event.detail) || event.title, timeoutMs);
        await this.toast(event, timeoutMs);
        return;
      case "issue_done":
      case "spec_done":
        if (key && paneId) {
          PANES.delete(key);
          await this.call("pane.close", { pane_id: paneId }, timeoutMs);
        }
        return;
      default:
        // feature_done and anything newer: nothing to show on a pane; a
        // notice/error still deserves a toast.
        if (event.level !== "info") await this.toast(event, timeoutMs);
    }
  }

  /** Open (or, for a revision re-claim, reuse) the issue's pane. The trace tail starts on the run's own `run_started` — see `handleRun`. */
  private async claim(event: NotifyEvent, timeoutMs: number): Promise<void> {
    const key = runKeyFor(event);
    if (!key) return;
    const issue = field(event, "issue");
    let paneId = PANES.get(key);
    if (paneId) {
      // A `<prefix>:feedback` revision reruns the same adw_id; the old pane
      // may have been closed by hand since, so fall through to a fresh one.
      const alive = await this.call("pane.get", { pane_id: paneId }, timeoutMs).then(() => true, () => false);
      if (!alive) paneId = undefined;
    }
    if (!paneId) {
      const split = await this.call("pane.split", { direction: "right", target_pane_id: this.env.paneId, cwd: this.opts.cwd, focus: false }, timeoutMs);
      paneId = (split.pane as { pane_id?: string } | undefined)?.pane_id;
      if (!paneId) throw new Error("herdr pane.split returned no pane_id");
      PANES.set(key, paneId);
      await this.call("pane.rename", { pane_id: paneId, label: firstLine(`${issue} ${field(event, "title")}`, 40) }, timeoutMs);
    }
    await this.report(paneId, "working", field(event, "chain"), timeoutMs);
  }

  /**
   * Run/phase milestones. Inside `spf watch` they belong to the claimed issue
   * whose adw_id they carry; a one-off attended run (`spf build ...` typed
   * into a herdr pane) reports on spf's own pane instead. Under watch, a run
   * event that matches no issue pane is dropped rather than repainting the
   * daemon's own pane.
   */
  private async handleRun(event: NotifyEvent, timeoutMs: number): Promise<void> {
    const adwId = field(event, "adw_id");
    const key = paneKeyForAdw(adwId);
    if (key) {
      const paneId = PANES.get(key)!;
      // Tail from here, not from the claim: by run_started the trace db exists
      // (a fresh repo has none at claim time) and this run's session is
      // `running` (a revision's previous session is already finished, which
      // `--follow` would print and exit on). Only the single lane's run, whose
      // adw_id IS the key — a fan-out attempt (`issue-42-2`) shares the pane
      // with its siblings, so there's no one run to tail.
      if (event.kind === "run_started" && adwId === key && SAFE_ID.test(key)) {
        await this.call("pane.send_text", { pane_id: paneId, text: `spf events ${key} --follow\n` }, timeoutMs);
      }
      // run_finished / run_failed are followed by the watch lane's own
      // pr_opened / issue_blocked, which carry the real outcome.
      if (event.kind === "run_started" || event.kind === "phase_retry" || event.kind === "phase_failed") {
        await this.report(paneId, "working", event.title, timeoutMs);
      }
      return;
    }
    if (watchActive) return;
    const own = this.env.paneId;
    switch (event.kind) {
      case "run_started":
      case "phase_retry":
      case "phase_failed":
        await this.report(own, "working", event.title, timeoutMs);
        return;
      case "run_finished":
        await this.report(own, "idle", event.title, timeoutMs);
        await this.retitle(own, event.title, { idle: "done" }, timeoutMs);
        return;
      case "run_failed":
        await this.report(own, "idle", event.title, timeoutMs);
        await this.retitle(own, event.title, { idle: "failed" }, timeoutMs);
        await this.toast(event, timeoutMs);
        return;
    }
  }
}
