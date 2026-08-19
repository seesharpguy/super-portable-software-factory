/**
 * Claude Code interface — STUB in v1. The factory is Pi-only for now.
 *
 * The config schema accepts `coding_agent: claude_code` so nothing breaks at the
 * schema level, but selecting it raises until v2 implements this interface
 * (`claude -p --output-format stream-json --resume <session_id>`).
 */

export function run(..._args: unknown[]): never {
  throw new Error(
    "coding_agent 'claude_code' is not implemented in v1 — SF v1 runs the " +
      "Pi coding agent only. Set coding_agent: pi (or omit it) in sf.config.yaml.",
  );
}
