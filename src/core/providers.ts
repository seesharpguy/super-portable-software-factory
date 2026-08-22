/**
 * Common Flue providers' env var conventions — public knowledge (pi-ai's own
 * resolution table is internal, unexported, and not something to reach into
 * for this). Missing from this table just means "unknown provider, skipped
 * the key check" — never a false failure.
 *
 * Shared by `spf doctor` (checks whichever key the configured model's
 * provider prefix implies) and the `spf init` interview (asks for the key up
 * front, keyed off the provider the user picked) — one table, so the two
 * can never drift apart on what a provider needs.
 */
export const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  groq: ["GROQ_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  xai: ["XAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  together: ["TOGETHER_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  // Keyless: a local server, not a hosted API — nothing to check for or
  // prompt for. An empty array here means "known provider, needs no key",
  // never "unknown provider" (that's a missing table entry, not `[]`).
  ollama: [],
};
