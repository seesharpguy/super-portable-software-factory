// In-browser semantic search over session traces, using Chrome's experimental
// Semantic Embedder API when available and degrading to plain substring
// matching otherwise — for browsers without the API, for a running session
// (its text is still changing), and for anything below the similarity floor.
// See semantic-embedder-global.d.ts for the API shape.
import type { SessionDetail, SessionSummary } from './types'
import type { SemanticEmbedderInstance, SemanticEmbedderStatic } from './semantic-embedder-global'
import { fetchSession } from './api'
import { getVector, hashText, putVector } from './vector-cache'

// Below this cosine similarity a "semantic" match isn't worth surfacing on its
// own — the substring pass still catches anything actually relevant.
const SIMILARITY_FLOOR = 0.5

let embedderPromise: Promise<SemanticEmbedderInstance | null> | null = null
// Latched true the first time create()/embed() throws — this unshipped API is
// still changing, and one failure shouldn't be retried every keystroke.
let disabled = false

function embedderCtor(): SemanticEmbedderStatic | null {
  const ctor = self.SemanticEmbedder
  // Feature-detect the actual methods, not just the namespace — same caution
  // as webmcp.ts takes with document.modelContext.
  if (!ctor || typeof ctor.availability !== 'function' || typeof ctor.create !== 'function') return null
  return ctor
}

export async function isSemanticSearchAvailable(): Promise<boolean> {
  if (disabled) return false
  const ctor = embedderCtor()
  if (!ctor) return false
  try {
    return (await ctor.availability()) !== 'unavailable'
  } catch {
    return false
  }
}

/**
 * Lazily creates the embedder singleton — never eagerly. create() likely
 * needs the same user-activation gesture Chrome's other Built-in AI APIs
 * require, so this must only be reached from a search-box focus/input
 * handler, never from mount or the 500ms poll tick.
 */
function getEmbedder(): Promise<SemanticEmbedderInstance | null> {
  if (disabled) return Promise.resolve(null)
  if (embedderPromise) return embedderPromise
  embedderPromise = (async () => {
    const ctor = embedderCtor()
    if (!ctor) return null
    try {
      if ((await ctor.availability()) === 'unavailable') return null
      return await ctor.create()
    } catch {
      disabled = true
      return null
    }
  })()
  return embedderPromise
}

async function embedText(text: string): Promise<Float32Array | null> {
  const embedder = await getEmbedder()
  if (!embedder) return null
  try {
    const result = await embedder.embed(text)
    return result.embeddings[0]?.values ?? null
  } catch {
    // A failure here means the API is unreliable in this session — stop
    // trying it at all rather than fail on every subsequent keystroke.
    disabled = true
    embedderPromise = null
    return null
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/** The text a session gets embedded from: its request plus every phase's name/description/error. */
export function buildSessionSearchText(detail: SessionDetail): string {
  const lines = [detail.session.request ?? '']
  for (const phase of detail.phases) {
    if (phase.name) lines.push(phase.name)
    if (phase.description) lines.push(phase.description)
    if (phase.error) lines.push(phase.error)
  }
  return lines.filter(Boolean).join('\n')
}

function substringMatch(query: string, s: SessionSummary): boolean {
  const q = query.toLowerCase()
  return (
    (s.request ?? '').toLowerCase().includes(q) ||
    (s.adw_name ?? '').toLowerCase().includes(q) ||
    s.adw_id.toLowerCase().includes(q)
  )
}

/**
 * Vector for one CLOSED session, from cache when its text hasn't changed
 * since caching, else fetched/built/embedded/cached fresh. Null for a still-
 * running session (its text isn't final) or on any failure — either way the
 * caller falls back to substring matching for it.
 */
async function vectorForSession(s: SessionSummary): Promise<Float32Array | null> {
  if (!s.ended_at) return null
  try {
    const detail = await fetchSession(s.adw_id)
    const text = buildSessionSearchText(detail)
    if (!text.trim()) return null
    const textHash = hashText(text)
    const cached = await getVector(s.adw_id)
    if (cached && cached.textHash === textHash) return cached.vector
    const vector = await embedText(text)
    if (!vector) return null
    await putVector(s.adw_id, vector, textHash)
    return vector
  } catch {
    return null
  }
}

/**
 * Ranks sessions against `query`, returning adw_ids most-relevant first.
 * Semantic similarity covers closed sessions (fetching/embedding/caching each
 * as needed), unioned with a plain case-insensitive substring match against
 * request/adw_name/adw_id — which is how a running session, and anything
 * under the similarity floor, still surface instead of disappearing. Falls
 * back to substring-only when the Semantic Embedder API is unavailable or
 * fails outright.
 */
export async function rankSessions(query: string, sessions: SessionSummary[]): Promise<string[]> {
  const q = query.trim()
  if (!q) return sessions.map((s) => s.adw_id)

  const substringHits = new Set(sessions.filter((s) => substringMatch(q, s)).map((s) => s.adw_id))

  const queryVector = await embedText(q)
  if (!queryVector) {
    return sessions.filter((s) => substringHits.has(s.adw_id)).map((s) => s.adw_id)
  }

  const scored: { adw_id: string; score: number }[] = []
  await Promise.all(
    sessions.map(async (s) => {
      const vector = await vectorForSession(s)
      if (vector) scored.push({ adw_id: s.adw_id, score: cosineSimilarity(queryVector, vector) })
    }),
  )

  const bySimilarity = scored
    .filter((r) => r.score >= SIMILARITY_FLOOR)
    .toSorted((a, b) => b.score - a.score)
    .map((r) => r.adw_id)

  const seen = new Set(bySimilarity)
  const substringOnly = sessions
    .filter((s) => substringHits.has(s.adw_id) && !seen.has(s.adw_id))
    .map((s) => s.adw_id)

  return [...bySimilarity, ...substringOnly]
}
