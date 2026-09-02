// Wraps Chrome's on-device Prompt API (window.LanguageModel) for
// SessionQaPanel.vue — free-form Q&A over one session's own trace, entirely
// on-device. Mirrors summarizer.ts's shape: feature-detect the unshipped
// API, degrade silently when it's absent, let the caller own error/loading
// UI. See developer.chrome.com/docs/ai/prompt-api.
//
// Read-only by construction: the session is seeded with plain trace text as
// a system prompt and answers with plain text — no tools, no function
// calling, nothing resembling it is wired in here, so there is no mechanism
// by which a question (or a model's answer) could reach archive_session or
// any other mutation. Do not import webmcp.ts from this file.
import { buildSessionSummaryInput, generateSummary } from './summarizer'
import type { SummarizerMonitor } from './summarizer-global'
import type { SessionDetail } from './types'

/** Cheap to call anytime; combined with availability() below to decide
 * whether SessionQaPanel.vue renders anything at all. */
function isPromptApiNamespacePresent(): boolean {
  return 'LanguageModel' in self
}

/**
 * Feature-detects the Prompt API and checks it can actually run here — a
 * browser that ships the namespace but reports 'unavailable' (no on-device
 * model, disabled flag, etc.) should look exactly like one that never
 * shipped it.
 */
export async function isPromptApiAvailable(): Promise<boolean> {
  if (!isPromptApiNamespacePresent()) return false
  try {
    const availability = await self.LanguageModel!.availability({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
    })
    return availability !== 'unavailable'
  } catch {
    return false
  }
}

/** The parts of a SessionDetail the Q&A context is built from — callers
 * needn't have fetched usage/agents just to ask a question. */
type SessionQaInput = Pick<SessionDetail, 'session' | 'phases'>

export type SessionQaContextMode = 'full' | 'condensed' | 'truncated'

export interface SessionQaContext {
  /** The text seeded into the Q&A session's system prompt. */
  text: string
  /**
   * 'full': every phase, verbatim — nothing left out.
   * 'condensed': the raw trace was too large, so the on-device Summarizer's
   * key-points version was used instead — the caller MUST tell the user this
   * happened, per the "must not silently truncate" requirement.
   * 'truncated': condensing itself failed (Summarizer unavailable or
   * erroring), so the raw trace was hard-cut instead — also MUST be surfaced.
   */
  mode: SessionQaContextMode
}

// Above this, don't hand the raw phase list to the Prompt API's system
// prompt whole — condense it first. A "few thousand characters" per the
// issue: generous enough that an ordinary run (tens of phases) goes through
// untouched, but bounds how much of a very long run's raw text gets seeded.
const MAX_RAW_CONTEXT_CHARS = 6_000

function hardTruncate(text: string): string {
  if (text.length <= MAX_RAW_CONTEXT_CHARS) return text
  const omitted = text.length - MAX_RAW_CONTEXT_CHARS
  return `${text.slice(0, MAX_RAW_CONTEXT_CHARS)}\n…(truncated — ${omitted} more character(s) of this trace omitted)`
}

/**
 * Builds the system-prompt context text for one session: the request,
 * overall status, and every phase in run order. Reuses
 * buildSessionSummaryInput's untruncated `full` text (summarizer.ts) rather
 * than re-describing phases here.
 *
 * When that text is small enough, it's used as-is ('full'). When it's not,
 * generateSummary (summarizer.ts) condenses it to key points ('condensed')
 * instead of silently feeding the model less of the run than a user might
 * expect. If condensing itself fails (Summarizer unavailable, erroring, or
 * needing a download that isn't triggerable from this call site), the raw
 * text is hard-truncated with a visible marker ('truncated') — the trace is
 * never quietly cut with no indication.
 */
export async function buildSessionContext(detail: SessionQaInput): Promise<SessionQaContext> {
  const { full } = buildSessionSummaryInput(detail)
  if (full.length <= MAX_RAW_CONTEXT_CHARS) return { text: full, mode: 'full' }
  try {
    const summary = await generateSummary(full)
    return { text: summary, mode: 'condensed' }
  } catch {
    return { text: hardTruncate(full), mode: 'truncated' }
  }
}

export interface SessionQaSession {
  ask(question: string): Promise<string>
  destroy(): void
}

/**
 * Creates a session-scoped Q&A session and returns a small wrapper over it.
 * Must be called from inside a user-gesture handler (or its synchronous
 * continuation) — Chrome's create() requires user activation, same as
 * Summarizer.create(). `monitor` surfaces model-download progress exactly
 * like summarizer.ts's `generateSummary`; `onContextOverflow` fires if the
 * session ever silently drops earlier turns to fit its context window, so
 * the caller can show a visible note instead of letting that pass unnoticed.
 */
export async function createSessionQaSession(
  adwId: string,
  contextText: string,
  monitor?: (m: SummarizerMonitor) => void,
  onContextOverflow?: () => void,
): Promise<SessionQaSession> {
  const languageModel = self.LanguageModel
  if (!languageModel) throw new Error('Prompt API not available')
  const session = await languageModel.create({
    initialPrompts: [
      {
        role: 'system',
        content: `You are analyzing a CI/agent run trace (session ${adwId}) from an automated software engineering pipeline. Answer questions using only the trace data below; say so plainly if it doesn't cover what's asked. Be concise.\n\n${contextText}`,
      },
    ],
    monitor,
  })
  if (onContextOverflow) session.addEventListener('contextoverflow', onContextOverflow)
  return {
    ask: (question: string) => session.prompt(question),
    destroy: () => session.destroy(),
  }
}
