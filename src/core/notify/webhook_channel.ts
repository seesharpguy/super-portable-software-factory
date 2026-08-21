/**
 * A generic webhook: `POST` the `NotifyEvent` as raw JSON, no vendor shape.
 * Covers Discord/n8n/Zapier/a homegrown receiver with no new channel module
 * each time, and is what `notify.test.ts` posts against a real local
 * `node:http` receiver instead of mocking `fetch`.
 */
import type { NotificationChannel, NotifyEvent } from "./channel.ts";

export class WebhookChannel implements NotificationChannel {
  readonly label: string;

  constructor(
    private readonly url: string,
    name: string = "",
  ) {
    this.label = name ? `webhook (${name})` : "webhook";
  }

  async send(event: NotifyEvent, timeoutMs: number): Promise<void> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`webhook -> ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`);
    }
  }
}
