/**
 * The vocabulary a `NotificationChannel` speaks, and the seam itself —
 * mirrors `core/issues/provider.ts`'s shape (an interface per concern,
 * one small implementation module per backend).
 *
 * `NotifyKind` is a curated set of milestones, deliberately not the raw
 * tracer event stream (`Tracer.event()` — see `core/tracer.ts`): a single
 * chain run emits hundreds of `tool_call`/`log` events, which would need
 * batching/rate-limiting to be a usable Slack message and would cut against
 * the tracer's own "no push transport" design. `level` is the ENTIRE filter
 * predicate a `Notifier` applies — no separate per-kind severity table to
 * keep in sync with this list.
 */

export type NotifyKind =
  | "run_started"
  | "run_finished"
  | "run_failed"
  | "phase_failed"
  | "phase_retry"
  | "watch_started"
  | "watch_stopped"
  | "watch_error"
  | "issue_claimed"
  | "pr_opened"
  | "issue_done"
  | "issue_blocked"
  | "spec_refined"
  | "spec_needs_feedback"
  | "feature_done"
  | "spec_done";

export interface NotifyEvent {
  kind: NotifyKind;
  /** "error" sends under both `events: errors` and `events: all`; "info" only under `all`. */
  level: "info" | "error";
  /** One line, e.g. "run failed — plan-build-test". */
  title: string;
  /** The error text / PR body / block detail, if any. */
  detail?: string;
  /** Ordered label/value pairs — adw_id, chain, phase, tokens, cost, issue, pr, repo, ... */
  fields: Array<[string, string]>;
  /** A PR or issue link, when there is one. */
  url?: string;
}

export interface NotificationChannel {
  /** For warning lines — "slack", "teams (ops-bus)". */
  readonly label: string;
  send(event: NotifyEvent, timeoutMs: number): Promise<void>;
}
