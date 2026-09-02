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

/** Builds the text to summarize: the request, overall status, then every
 * phase in run order. Bounded so a huge session still produces one prompt. */
export function buildSessionSummaryInput({ session, phases }: SessionSummaryInput): string {
  const lines = [
    `Request: ${session.request ?? '(none)'}`,
    `Status: ${session.status ?? 'unknown'}`,
    '',
    ...phases.toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map(describePhase),
  ]
  const text = lines.join('\n')
  return text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS)}\n…(truncated)` : text
}

/**
 * Creates a Summarizer and summarizes `text`. Must be called from inside a
 * user-gesture handler (or its synchronous continuation) — Chrome's create()
 * requires user activation and otherwise likely rejects. Errors propagate;
 * only the caller knows what UI state to fall back to.
 */
export async function generateSummary(
  text: string,
  monitor?: (m: SummarizerMonitor) => void,
): Promise<string> {
  const summarizer = await self.Summarizer!.create({
    type: 'key-points',
    format: 'markdown',
    length: 'short',
    sharedContext: 'An automated coding agent run, reported phase by phase.',
    monitor,
  })
  try {
    return await summarizer.summarize(text)
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
 * whenever the session's request/status/phases change. */
export function summaryCacheKey(adwId: string, input: string): string {
  return `${adwId}:${hashText(input)}`
}

const cache = new Map<string, string>()

export function getCachedSummary(key: string): string | undefined {
  return cache.get(key)
}

export function setCachedSummary(key: string, summary: string): void {
  cache.set(key, summary)
}
