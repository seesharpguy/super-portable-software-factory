/**
 * Model → provider icon, by contains-check on the model name.
 *
 * Icons are module imports (48x48, resized from the original 490-512px
 * sources — they only ever render at 16-24px) so Vite inlines them as data
 * URIs via assetsInlineLimit instead of five separate HTTP requests. First
 * matching needle wins; unknown models render no icon.
 */
import claudeIcon from '../assets/models/claude.png'
import geminiIcon from '../assets/models/gemini.png'
import kimiIcon from '../assets/models/kimi.png'
import openaiIcon from '../assets/models/openai.png'
import zaiIcon from '../assets/models/zai.png'

const MODEL_ICONS: [needles: string[], icon: string][] = [
  [['claude', 'opus', 'sonnet', 'haiku'], claudeIcon],
  [['gemini'], geminiIcon],
  [['kimi', 'moonshot'], kimiIcon],
  [['gpt', 'openai', 'codex', 'o3', 'o4'], openaiIcon],
  [['glm', 'zai', 'z.ai'], zaiIcon],
]

export function modelIcon(model: string | null | undefined): string | null {
  if (!model) return null
  const m = model.toLowerCase()
  for (const [needles, icon] of MODEL_ICONS) {
    if (needles.some((n) => m.includes(n))) return icon
  }
  return null
}

/** Keep provider-qualified IDs compact while preserving the full ID in titles. */
export function modelName(model: string | null | undefined): string {
  if (!model) return ''
  return model.split('/').filter(Boolean).at(-1) ?? model
}
