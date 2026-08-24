/**
 * Slack Incoming Webhook — a plain `POST` of a Block Kit payload, via native
 * `fetch()` (same no-dependency stance as `core/issues/github_provider.ts`).
 * Set up: Slack app -> Incoming Webhooks -> "Add New Webhook to Workspace".
 * https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
 */
import type { NotificationChannel, NotifyEvent } from "./channel.ts";

export class SlackChannel implements NotificationChannel {
  readonly label: string;

  constructor(
    private readonly webhookUrl: string,
    name: string = "",
  ) {
    this.label = name ? `slack (${name})` : "slack";
  }

  async send(event: NotifyEvent, timeoutMs: number): Promise<void> {
    const emoji = event.level === "error" ? ":x:" : event.level === "notice" ? ":warning:" : ":white_check_mark:";
    const fieldsText = event.fields.map(([k, v]) => `*${k}:* ${v}`).join("  ·  ");
    const body = {
      text: `${emoji} ${event.title}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `${emoji} *${event.title}*` } },
        ...(event.detail ? [{ type: "section", text: { type: "mrkdwn", text: event.detail.slice(0, 2900) } }] : []),
        ...(fieldsText ? [{ type: "context", elements: [{ type: "mrkdwn", text: fieldsText }] }] : []),
        ...(event.url ? [{ type: "section", text: { type: "mrkdwn", text: `<${event.url}|open>` } }] : []),
      ],
    };
    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`slack webhook -> ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
    }
  }
}
