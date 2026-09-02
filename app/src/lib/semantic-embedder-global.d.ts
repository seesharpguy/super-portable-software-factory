// Ambient declaration for Chrome's proposed Semantic Embedder API — an
// experimental explainer, not in any shipped TS DOM lib. Typed only to the
// surface semantic-search.ts calls; see
// github.com/explainers-by-googlers/semantic-embedder-api.

type SemanticEmbedderAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available'

interface SemanticEmbedResult {
  embeddings: { values: Float32Array }[]
}

interface SemanticEmbedderInstance {
  embed(input: string | string[]): Promise<SemanticEmbedResult>
  destroy(): void
}

interface SemanticEmbedderStatic {
  availability(): Promise<SemanticEmbedderAvailability>
  create(): Promise<SemanticEmbedderInstance>
}

declare global {
  interface Window {
    /** Present only in browsers shipping this explainer (feature-detect before use). */
    SemanticEmbedder?: SemanticEmbedderStatic
  }
}

export type { SemanticEmbedderAvailability, SemanticEmbedderInstance, SemanticEmbedderStatic }
