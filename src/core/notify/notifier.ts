/**
 * Filter, fan-out, and lifecycle for outbound notifications. A notification
 * must never be able to break a run: `send()` never throws and never
 * blocks — it fires the request and tracks it in a pending set, and a
 * failure is swallowed after logging one line (the URL itself never
 * appears in that line, or anywhere else — see `resolveNotifier` below).
 *
 * `resolveNotifier` returns `null` when notifications are off or no
 * channel resolved, so every call site uses the same `notifier?.send(...)`
 * shape as an optional dependency, not a conditional branch.
 */
import type { NotifyEvent, NotificationChannel } from "./channel.ts";
import type { NotificationsConfig, NotifyScope, SFConfig } from "../data_types.ts";
import { SlackChannel } from "./slack_channel.ts";
import { TeamsChannel } from "./teams_channel.ts";
import { WebhookChannel } from "./webhook_channel.ts";

/** Exported so `spf doctor` and the init interview can name the same key without duplicating this table. */
export const DEFAULT_NOTIFY_ENV_KEY: Record<string, string> = {
  slack: "SLACK_WEBHOOK_URL",
  teams: "TEAMS_WEBHOOK_URL",
  webhook: "SPF_WEBHOOK_URL",
};

/**
 * `off` sends nothing; `errors` only `level: "error"`; `attention` also
 * lets `level: "notice"` through; `all` sends everything.
 */
function scopeAllows(scope: NotifyScope, level: "info" | "notice" | "error"): boolean {
  if (scope === "off") return false;
  if (scope === "all") return true;
  if (scope === "attention") return level === "error" || level === "notice";
  return level === "error";
}

export class Notifier {
  private pending = new Set<Promise<void>>();

  constructor(
    private readonly channels: Array<{ channel: NotificationChannel; scope: NotifyScope }>,
    private readonly timeoutMs: number,
    private readonly dryRun: boolean,
    private readonly log: (message: string) => void = (m) => console.error(m),
    // See `NotificationsConfigSchema.project`'s doc comment — empty disables
    // tagging entirely, so a single-repo setup's outbound JSON is unchanged.
    private readonly project: string = "",
  ) {}

  /** Sync, fire-and-forget — every call site is sync and must stay that way. */
  send(rawEvent: NotifyEvent): void {
    const event = this.project ? tagEvent(rawEvent, this.project) : rawEvent;
    for (const { channel, scope } of this.channels) {
      if (!scopeAllows(scope, event.level)) continue;
      if (this.dryRun) {
        this.log(`spf: would notify (${channel.label}): ${event.title}`);
        continue;
      }
      const task = channel.send(event, this.timeoutMs).catch((error) => {
        this.log(`spf: ${channel.label} notification failed: ${(error as Error).message}`);
      });
      this.pending.add(task);
      task.finally(() => this.pending.delete(task));
    }
  }

  /** Await every in-flight send — call before process exit so a slow webhook isn't dropped mid-flight. */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  /**
   * Bounded drain: race `flush()` against `budgetMs`, never throwing. Mirrors
   * `otel.ts`'s `OtelExporter.drain()` discipline — for the signal handler in
   * `session.ts`, which is racing a hard ^C deadline shorter than any single
   * channel's own `AbortSignal.timeout(timeoutMs)`, so a webhook to an
   * unreachable host cannot hold the process open past `budgetMs`.
   */
  async drain(budgetMs: number): Promise<void> {
    let deadline: NodeJS.Timeout | null = null;
    const budget = new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, budgetMs);
      deadline.unref?.();
    });
    try {
      await Promise.race([this.flush(), budget]);
    } catch {
      // unreachable in practice — every send() task is pre-caught into the log
      // line above, so flush() never rejects — but a drain that can throw
      // would break the shutdown path it exists to protect.
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }
}

/**
 * Prefixes `event.title` with `[project]` and adds a `repo` field, so a
 * webhook shared by several `spf watch` instances reads clearly even
 * collapsed to one line (Slack's notification/thread-list view only shows
 * `title`, never `fields`). Skips the field when one's already there
 * (`watch_started`/`watch_stopped` already carry their own `repo` field —
 * see `cli/commands/watch.ts`) rather than emit a duplicate key with the
 * same value.
 */
function tagEvent(event: NotifyEvent, project: string): NotifyEvent {
  const hasRepo = event.fields.some(([key]) => key === "repo");
  return {
    ...event,
    title: `[${project}] ${event.title}`,
    fields: hasRepo ? event.fields : [["repo", project], ...event.fields],
  };
}

function makeChannel(kind: string, url: string, name: string): NotificationChannel | null {
  switch (kind) {
    case "slack":
      return new SlackChannel(url, name);
    case "teams":
      return new TeamsChannel(url, name);
    case "webhook":
      return new WebhookChannel(url, name);
    default:
      return null;
  }
}

// Every live Notifier this process created — so the CLI's shutdown path can
// flush all of them without threading a handle through every call site,
// matching agent_flue.shutdown()/agent_cc.shutdown()'s module-level shape.
const LIVE: Notifier[] = [];

/**
 * Build a `Notifier` from `cfg.notifications`, or `null` if it's off or no
 * channel resolved. A channel whose env var isn't set is skipped with one
 * warning naming the missing key — never a hard failure, since a broken
 * notification setup shouldn't stop the work it's supposed to report on.
 */
export function resolveNotifier(cfg: SFConfig, opts: { dryRun?: boolean; log?: (message: string) => void } = {}): Notifier | null {
  const nc: NotificationsConfig = cfg.notifications;
  if (nc.events === "off" || nc.channels.length === 0) return null;
  const log = opts.log ?? ((m: string) => console.error(m));

  const resolved: Array<{ channel: NotificationChannel; scope: NotifyScope }> = [];
  for (const entry of nc.channels) {
    const envKey = entry.webhook_url_env || DEFAULT_NOTIFY_ENV_KEY[entry.kind];
    const url = process.env[envKey];
    if (!url) {
      log(`spf: notifications.channels[kind=${entry.kind}] is configured but ${envKey} is not set — skipping this channel`);
      continue;
    }
    const channel = makeChannel(entry.kind, url, entry.name);
    if (!channel) continue;
    resolved.push({ channel, scope: entry.events ?? nc.events });
  }
  if (resolved.length === 0) return null;

  // See `NotificationsConfigSchema.project`'s doc comment: an explicit
  // `notifications.project` wins; otherwise fall back to `watch.repo`
  // (present whenever `spf watch` is what's sending — the common case for a
  // shared webhook), and empty (a one-off `spf run` with no watch.repo set)
  // disables tagging, same as today.
  const project = nc.project.trim() || cfg.watch.repo.trim();

  const notifier = new Notifier(resolved, nc.timeout_ms, Boolean(opts.dryRun), log, project);
  LIVE.push(notifier);
  return notifier;
}

/** Await every Notifier this process has created — call once, from the CLI's shutdown path. */
export async function flushAll(): Promise<void> {
  await Promise.all(LIVE.map((n) => n.flush()));
}

/**
 * Bounded drain of every Notifier this process created, under one shared
 * budget — the signal-handler twin of `flushAll()`. Called from
 * `session.ts`'s SIGTERM/SIGINT handler, alongside `otel.flushAll()`, so a
 * killed run's in-flight Slack/Teams/webhook sends get the same
 * timeout-and-swallow chance the otel drain already had. Never throws.
 */
export async function drainAll(budgetMs: number): Promise<void> {
  await Promise.all(LIVE.map((n) => n.drain(budgetMs)));
}
