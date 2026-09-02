// Ambient declaration for Chrome's on-device Summarizer API (self.Summarizer)
// — not in Chrome's shipped TS DOM lib yet. Typed only to the surface
// summarizer.ts calls; see developer.chrome.com/docs/ai/summarizer-api.

/** Progress reporter passed to a create() call's `monitor` option. */
interface SummarizerMonitor extends EventTarget {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: { loaded: number }) => void,
  ): void
}

interface SummarizerCreateOptions {
  type?: 'key-points' | 'tldr' | 'teaser' | 'headline'
  format?: 'markdown' | 'plain-text'
  length?: 'short' | 'medium' | 'long'
  /** Free-text hint about the corpus, e.g. "an automated coding run's phases." */
  sharedContext?: string
  /** Called synchronously from create() with a monitor to attach a
   * 'downloadprogress' listener to — the model may need to download. */
  monitor?: (monitor: SummarizerMonitor) => void
  signal?: AbortSignal
}

interface SummarizerSummarizeOptions {
  context?: string
  signal?: AbortSignal
}

interface SummarizerInstance {
  summarize(input: string, options?: SummarizerSummarizeOptions): Promise<string>
  summarizeStreaming(input: string, options?: SummarizerSummarizeOptions): ReadableStream<string>
  destroy?: () => void
}

interface SummarizerStatic {
  /** Resolves to 'unavailable', or a string meaning some flavor of usable
   * (may require a create()-triggered download) — never hardcode the set. */
  availability: () => Promise<string>
  create: (options?: SummarizerCreateOptions) => Promise<SummarizerInstance>
}

declare global {
  interface Window {
    /** Present only in browsers shipping the Summarizer API (feature-detect before use). */
    Summarizer?: SummarizerStatic
  }
}

export type { SummarizerCreateOptions, SummarizerInstance, SummarizerMonitor, SummarizerStatic }
