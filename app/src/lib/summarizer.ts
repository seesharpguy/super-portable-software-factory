// Wraps Chrome's on-device Summarizer API for SessionSummary.vue — a run's
// phase list, turned into a short TL;DR without leaving the browser. Mirrors
// webmcp.ts's shape: feature-detect the unshipped API, degrade silently when
// it's absent, let the caller own error/loading UI. See
// developer.chrome.com/docs/ai/summarizer-api.
import type { Phase, SessionDetail } from './types'
import type { SummarizerMonitor } from './summarizer-global'

/** The parts of a SessionDetail the summary input is built from — callers
 * needn't have fetched usage/agents just to summarize. */
type SessionSummaryInput = Pick<SessionDetail, 'session' | 'phases'>

/** Cheap, safe to call anytime (no promise, no user gesture needed) — decides
 * whether SessionSummary.vue renders anything at all. */
export function isSummarizerNamespacePresent(): boolean {
  return 'Summarizer' in self
}

/**
 * Surfaces whatever string Chrome's Summarizer.availability() gives, e.g.
 * 'unavailable' | 'downloadable' | 'available'. Deliberately not typed as an
 * exhaustive enum — the shipped set has moved during origin trials. Callers
 * should treat 'unavailable' as "don't offer this" and anything else as
 * usable (create() may still need to download the model first).
 */
export async function checkAvailability(): Promise<string> {
  if (!isSummarizerNamespacePresent()) return 'unavailable'
  return self.Summarizer!.availability()
}

// A very long session (hundreds of phases) shouldn't blow up the prompt —
// this is a simple length cap, not real chunking/map-reduce.
const MAX_INPUT_CHARS = 12_000

function describePhase(p: Phase): string {
  const bits = [`${p.name ?? p.phase_id} [${p.status ?? 'queued'}]`]
  if (p.description) bits.push(p.description)
  if (p.error) bits.push(`error: ${p.error}`)
  return `- ${bits.join(' — ')}`
}

/** `buildSessionSummaryInput`'s result: `input` is what gets sent to the
 * model (capped); `full` is the untruncated text, kept only for hashing so a
 * cache key still changes once a session's content outgrows the cap. */
export interface SessionSummaryText {
  input: string
  full: string
}

/** Builds the text to summarize: the request, overall status, then every
 * phase in run order. `input` is bounded so a huge session still produces
 * one prompt — when it doesn't fit, the *newest* phases are kept (dropping
 * from the front) since those are what "what happened" needs most. */
export function buildSessionSummaryInput({
  session,
  phases,
}: SessionSummaryInput): SessionSummaryText {
  const header = [`Request: ${session.request ?? '(none)'}`, `Status: ${session.status ?? 'unknown'}`, '']
  const describedLines = phases.toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map(describePhase)
  const full = [...header, ...describedLines].join('\n')
  if (full.length <= MAX_INPUT_CHARS) return { input: full, full }

  const budget = MAX_INPUT_CHARS - header.join('\n').length
  const kept: string[] = []
  let used = 0
  for (let i = describedLines.length - 1; i >= 0; i--) {
    const line = describedLines[i]
    const cost = line.length + 1
    if (used + cost > budget && kept.length > 0) break
    kept.push(line)
    used += cost
  }
  kept.reverse()
  const omitted = describedLines.length - kept.length
  const input = [...header, ...kept, `…(${omitted} earlier phase(s) omitted)`].join('\n')
  return { input, full }
}

/**
 * Creates a Summarizer and summarizes `text`. Must be called from inside a
 * user-gesture handler (or its synchronous continuation) — Chrome's create()
 * requires user activation and otherwise likely rejects. Errors propagate;
 * only the caller knows what UI state to fall back to. Pass `signal` to let
 * a caller cancel a model download or an in-flight summarize, e.g. on unmount.
 */
export async function generateSummary(
  text: string,
  monitor?: (m: SummarizerMonitor) => void,
  signal?: AbortSignal,
): Promise<string> {
  const summarizer = await self.Summarizer!.create({
    type: 'key-points',
    format: 'markdown',
    length: 'short',
    sharedContext: 'An automated coding agent run, reported phase by phase.',
    monitor,
    signal,
  })
  try {
    return await summarizer.summarize(text, { signal })
  } finally {
    summarizer.destroy?.()
  }
}

// ── Cache ────────────────────────────────────────────────────────────────────
// In-memory only (a module-level Map, not IndexedDB) — the ask is just to
// skip regenerating on every 500ms poll tick, not to persist across reloads.

/** Sum char codes with a rolling multiplier, mod a large prime — good enough
 * to key a cache, not a real hash. */
const HASH_PRIME = 1_000_000_007

function hashText(text: string): number {
  let h = 0
  let mult = 31
  for (let i = 0; i < text.length; i++) {
    h = (h + text.charCodeAt(i) * mult) % HASH_PRIME
    mult = (mult * 31) % HASH_PRIME
  }
  return h
}

/** Cache key for one session's summary input at a point in time — changes
 * whenever the session's request/status/phases change. Hash the `full` text
 * from `buildSessionSummaryInput`, not `input` — otherwise a session past the
 * cap hashes identically forever and the key stops changing. */
export function summaryCacheKey(adwId: string, text: string): string {
  return `${adwId}:${hashText(text)}`
}

const cache = new Map<string, string>()

export function getCachedSummary(key: string): string | undefined {
  return cache.get(key)
}

export function setCachedSummary(key: string, summary: string): void {
  cache.set(key, summary)
}
