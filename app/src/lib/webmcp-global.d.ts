// Ambient declaration for Chrome's WebMCP API (document.modelContext) — not in
// Chrome's shipped TS DOM lib yet. Typed only to the surface webmcp.ts calls;
// see developer.chrome.com/docs/ai/webmcp for the full API.

interface ModelContextToolAnnotations {
  /** True for a pure read; omit or false for a tool with a side effect. */
  readOnlyHint?: boolean
}

interface ModelContextToolExecuteContext {
  signal: AbortSignal
}

interface ModelContextTool {
  /** Unique identifier the agent calls the tool by. */
  name: string
  description: string
  /** JSON Schema for `inputs` — kept loose since we only author it, never introspect it. */
  inputSchema: Record<string, unknown>
  /** Must resolve to a string; JSON results are stringified by the tool itself. */
  execute: (inputs: Record<string, unknown>, context: ModelContextToolExecuteContext) => Promise<string>
  annotations?: ModelContextToolAnnotations
}

interface ModelContextRegisterOptions {
  /** Lets a caller unregister the tool later without breaking an in-flight call. */
  signal?: AbortSignal
}

interface ModelContextApi {
  registerTool: (tool: ModelContextTool, options?: ModelContextRegisterOptions) => Promise<void>
}

declare global {
  interface Document {
    /** Present only in browsers shipping WebMCP (feature-detect before use). */
    modelContext?: ModelContextApi
  }
}

export type { ModelContextApi, ModelContextTool, ModelContextToolAnnotations }
