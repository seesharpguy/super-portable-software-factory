// In-browser semantic search over session traces, using Chrome's experimental
// Semantic Embedder API when available and degrading to plain substring
// matching otherwise — for browsers without the API, for a running session
// (its text is still changing), and for anything below the similarity floor.
// See semantic-embedder-global.d.ts for the API shape.
import type { SessionSummary } from './types'
import type { SemanticEmbedderInstance, SemanticEmbedderStatic } from './semantic-embedder-global'
import { getVector, hashText, pruneVectors, putVector } from './vector-cache'

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
    // 'downloadable'/'downloading' mean no model exists yet — only
    // 'available' means a search can actually run semantically right now.
    return (await ctor.availability()) === 'available'
  } catch {
    return false
  }
}

/** True once the Semantic Embedder API has failed and been latched off for
 * this page load — lets the UI stop claiming semantic search is active. */
export function isSemanticSearchDisabled(): boolean {
  return disabled
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
  // A length mismatch means the cached vector predates a model/dimension
  // change — never index past the shorter array (that's how a stale vector
  // silently produced NaN/garbage scores instead of a clean non-match).
  if (a.length !== b.length) return 0
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

/** The text a session gets embedded from: its request plus every phase's
 * name/description/error — all of it already present on SessionSummary, so
 * this never needs a detail fetch. */
export function buildSessionSearchText(session: Pick<SessionSummary, 'request' | 'phases'>): string {
  const lines = [session.request ?? '']
  for (const phase of session.phases) {
    if (phase.name) lines.push(phase.name)
    if (phase.description) lines.push(phase.description)
    if (phase.error) lines.push(phase.error)
  }
  return lines.filter(Boolean).join('\n')
}

/** Substring fallback — checks the same fields buildSessionSearchText reads
 * (request/adw_name/adw_id plus every phase's name/description/error), since
 * this is the only path a running session (or a browser without the
 * Semantic Embedder API) can ever be found through. */
function substringMatch(query: string, s: SessionSummary): boolean {
  const q = query.toLowerCase()
  if ((s.request ?? '').toLowerCase().includes(q)) return true
  if ((s.adw_name ?? '').toLowerCase().includes(q)) return true
  if (s.adw_id.toLowerCase().includes(q)) return true
  return s.phases.some(
    (p) =>
      (p.name ?? '').toLowerCase().includes(q) ||
      (p.description ?? '').toLowerCase().includes(q) ||
      (p.error ?? '').toLowerCase().includes(q),
  )
}

/**
 * Vector for one CLOSED session, from cache when its text hasn't changed
 * since caching, else built/embedded/cached fresh — all from the summary
 * already on hand, never a per-session detail fetch (see SessionSummary,
 * which carries the same phases the detail endpoint would return). Null for
 * a still-running session (its text isn't final) or on any failure — either
 * way the caller falls back to substring matching for it.
 */
async function vectorForSession(s: SessionSummary): Promise<Float32Array | null> {
  if (!s.ended_at) return null
  try {
    const text = buildSessionSearchText(s)
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
 * Semantic similarity covers closed sessions (embedding/caching each as
 * needed), unioned with a plain case-insensitive substring match against
 * request/adw_name/adw_id/phase text — which is how a running session, and
 * anything under the similarity floor, still surface instead of
 * disappearing. Falls back to substring-only when the Semantic Embedder API
 * is unavailable or fails outright.
 */
export async function rankSessions(query: string, sessions: SessionSummary[]): Promise<string[]> {
  const q = query.trim()
  if (!q) return sessions.map((s) => s.adw_id)

  // Best-effort, fire-and-forget: drop any cached vector for a session no
  // longer in the live list (archived, aged out) so the store doesn't grow
  // forever.
  void pruneVectors(new Set(sessions.map((s) => s.adw_id)))

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
