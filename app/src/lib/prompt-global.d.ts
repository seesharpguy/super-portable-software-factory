// Ambient declaration for Chrome's on-device Prompt API (self.LanguageModel)
// — not in Chrome's shipped TS DOM lib yet. Typed only to the surface
// prompt-qa.ts calls; see developer.chrome.com/docs/ai/prompt-api.
// Deliberately does NOT import SummarizerMonitor from summarizer-global —
// the two APIs' downloadprogress events are structurally identical today,
// but this API's typing shouldn't silently change shape if Summarizer's ever
// does, so LanguageModelMonitor is declared standalone below.

interface LanguageModelInitialPrompt {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface LanguageModelExpectedInput {
  type: 'text'
  languages?: string[]
}

interface LanguageModelAvailabilityOptions {
  expectedInputs?: LanguageModelExpectedInput[]
}

/** Progress reporter passed to a create() call's `monitor` option. See
 * summarizer-global.d.ts's SummarizerMonitor — same shape, kept as a
 * separate declaration on purpose (see note above). */
interface LanguageModelMonitor {
  addEventListener(
    type: 'downloadprogress',
    listener: (event: { loaded: number }) => void,
  ): void
}

interface LanguageModelCreateOptions {
  initialPrompts?: LanguageModelInitialPrompt[]
  /** Called synchronously from create() with a monitor to attach a
   * 'downloadprogress' listener to — the model may need to download. */
  monitor?: (monitor: LanguageModelMonitor) => void
  signal?: AbortSignal
}

interface LanguageModelPromptOptions {
  signal?: AbortSignal
}

/**
 * Declared standalone rather than `extends EventTarget` — the real object
 * *is* an EventTarget, but re-narrowing `addEventListener`'s listener type on
 * top of DOM's own overloads doesn't typecheck (TS2430); this only types the
 * surface prompt-qa.ts actually calls.
 */
interface LanguageModelSession {
  /** Tokens currently held in context, and the model's window ceiling. */
  readonly contextUsage?: number
  readonly contextWindow?: number
  prompt(input: string, options?: LanguageModelPromptOptions): Promise<string>
  promptStreaming(input: string, options?: LanguageModelPromptOptions): ReadableStream<string>
  /** Adds messages to the session's context without prompting a response.
   * Unlike create(), append() isn't gated on user activation — the way to add
   * context after the fact (e.g. a condensed summary that took too long to
   * compute before create() without spending the gesture's activation
   * window) without needing another gesture. */
  append(prompts: LanguageModelInitialPrompt[], options?: LanguageModelPromptOptions): Promise<void>
  destroy(): void
  /** Fired when the session silently dropped earlier turns to fit the context
   * window — the one signal a caller has that trace data was left out. */
  addEventListener(type: 'contextoverflow', listener: () => void): void
  removeEventListener(type: 'contextoverflow', listener: () => void): void
}

interface LanguageModelStatic {
  /** Resolves to 'unavailable', or a string meaning some flavor of usable
   * (may require a create()-triggered download) — never hardcode the set. */
  availability: (options?: LanguageModelAvailabilityOptions) => Promise<string>
  create: (options?: LanguageModelCreateOptions) => Promise<LanguageModelSession>
}

declare global {
  interface Window {
    /** Present only in browsers shipping the Prompt API (feature-detect before use). */
    LanguageModel?: LanguageModelStatic
  }
}

export type {
  LanguageModelCreateOptions,
  LanguageModelInitialPrompt,
  LanguageModelMonitor,
  LanguageModelSession,
  LanguageModelStatic,
}
