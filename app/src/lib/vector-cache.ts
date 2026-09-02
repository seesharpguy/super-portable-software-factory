// Tiny IndexedDB wrapper caching per-session text embeddings across reloads —
// raw indexedDB API, zero deps. semantic-search.ts is the only caller.
const DB_NAME = 'spf-timetable'
const DB_VERSION = 1
const STORE_NAME = 'session_vectors'

interface StoredVector {
  adw_id: string
  vector: Float32Array
  /** Checksum of the text the vector was computed from — see hashText(). */
  textHash: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

/** Opens (and upgrades) the database once per page load; resolves null if
 * IndexedDB isn't available or open fails, so callers just skip the cache. */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.addEventListener('upgradeneeded', () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'adw_id' })
        }
      })
      req.addEventListener('success', () => resolve(req.result))
      req.addEventListener('error', () => resolve(null))
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

/** Cached vector for a session, or null if nothing's cached (or the cache is unavailable). */
export async function getVector(adwId: string): Promise<StoredVector | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(adwId)
      req.addEventListener('success', () => resolve((req.result as StoredVector | undefined) ?? null))
      req.addEventListener('error', () => resolve(null))
    } catch {
      resolve(null)
    }
  })
}

/** Caches a session's embedding. Float32Array is structured-clone-safe, so it's stored directly. */
export async function putVector(adwId: string, vector: Float32Array, textHash: number): Promise<void> {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const record: StoredVector = { adw_id: adwId, vector, textHash }
      tx.objectStore(STORE_NAME).put(record)
      tx.addEventListener('complete', () => resolve())
      tx.addEventListener('error', () => resolve())
    } catch {
      resolve()
    }
  })
}

// Rolling-multiplier checksum, mod a large prime — good enough to notice "the
// source text changed, recompute the embedding", not a real hash function.
const HASH_PRIME = 1_000_000_007

export function hashText(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) % HASH_PRIME
  }
  return hash
}

export type { StoredVector }
