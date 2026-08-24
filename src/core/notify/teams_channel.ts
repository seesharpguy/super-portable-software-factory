/**
 * Microsoft Teams via a Power Automate "Workflows" webhook, posting an
 * Adaptive Card. This is the ONLY supported path: the legacy Office 365
 * connector webhook (a bare `MessageCard`/`@type` POST straight to a
 * channel-configured URL) has been retired by Microsoft. Set up: in the
 * target channel, add a Workflows webhook template (naming has shifted
 * between Microsoft revisions — search for one along the lines of "Post to
 * a channel when a webhook request is received") and copy the generated URL.
 * https://support.microsoft.com/en-us/office/post-a-workflow-when-a-webhook-request-is-received-in-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498
 */
import type { NotificationChannel, NotifyEvent } from "./channel.ts";

export class TeamsChannel implements NotificationChannel {
  readonly label: string;

  constructor(
    private readonly webhookUrl: string,
    name: string = "",
  ) {
    this.label = name ? `teams (${name})` : "teams";
  }

  async send(event: NotifyEvent, timeoutMs: number): Promise<void> {
    const color = event.level === "error" ? "attention" : event.level === "notice" ? "warning" : "good";
    const facts = event.fields.map(([title, value]) => ({ title, value }));
    const card = {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [
        { type: "TextBlock", text: event.title, weight: "bolder", size: "medium", color, wrap: true },
        ...(event.detail ? [{ type: "TextBlock", text: event.detail.slice(0, 2900), wrap: true }] : []),
        ...(facts.length > 0 ? [{ type: "FactSet", facts }] : []),
      ],
      ...(event.url
        ? { actions: [{ type: "Action.OpenUrl", title: "Open", url: event.url }] }
        : {}),
    };
    const body = {
      type: "message",
      attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: card }],
    };
    const response = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`teams webhook -> ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
    }
  }
}
