<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { Phase, Session } from '../lib/types'
import { Sparkles } from 'lucide-vue-next'
import {
  buildSessionSummaryInput,
  checkAvailability,
  generateSummary,
  getCachedSummary,
  isSummarizerNamespacePresent,
  setCachedSummary,
  summaryCacheKey,
} from '../lib/summarizer'
import { renderMarkdown } from '../lib/markdown'
import DetailSection from './DetailSection.vue'

const props = defineProps<{ adwId: string; session: Session; phases: Phase[] }>()

type State = 'idle' | 'generating' | 'ready' | 'error'

// Gated on availability(), not just the namespace check — a browser that
// ships Summarizer but can't actually run it (no on-device model, etc.)
// should look exactly like one that never shipped it: no visual trace.
const visible = ref(false)
const open = ref(true)
const state = ref<State>('idle')
const html = ref('')
const downloadPct = ref<number | null>(null)
const errorMessage = ref<string | null>(null)
// The key the currently-shown summary was generated for — not a ref, since
// nothing needs to render off it directly (see `stale` below).
let shownKey: string | null = null
// Lets a component unmount (navigating away mid-generation) cancel the
// in-flight create()/summarize() instead of leaving the on-device model
// running for a view nobody's looking at.
let abortController: AbortController | null = null

onMounted(async () => {
  if (!isSummarizerNamespacePresent()) return
  try {
    visible.value = (await checkAvailability()) !== 'unavailable'
  } catch {
    visible.value = false
  }
})

onUnmounted(() => {
  abortController?.abort()
})

// null while the card isn't shown (no API, or availability() said no) — SessionTrace
// hands in fresh session/phases objects every 500ms tick, so without this
// gate the input text and its hash would get rebuilt on every tick for a
// feature that's invisible or, in Chrome, not yet opened.
const summaryText = computed(() =>
  visible.value ? buildSessionSummaryInput({ session: props.session, phases: props.phases }) : null,
)

const cacheKey = computed(() =>
  summaryText.value ? summaryCacheKey(props.adwId, summaryText.value.full) : null,
)

// A summary already generated for this exact session content (e.g. the trace
// was left and revisited) shows immediately, with no regeneration. When the
// session moves on to a new key, the last summary just stays put — `stale`
// below is the only hint anything changed; regenerating is the user's call.
watch(
  cacheKey,
  (key) => {
    if (key == null || key === shownKey || state.value === 'generating') return
    const cached = getCachedSummary(key)
    if (cached) {
      html.value = renderMarkdown(cached)
      shownKey = key
      state.value = 'ready'
    }
  },
  { immediate: true },
)

const stale = computed(() => state.value === 'ready' && cacheKey.value !== shownKey)

/**
 * Fired directly from the "generate"/"regenerate" click — must stay the
 * synchronous continuation of that click, since Summarizer.create() requires
 * user activation and nothing here awaits anything before it.
 */
async function generate() {
  const key = cacheKey.value
  const text = summaryText.value?.input
  if (key == null || text == null) return
  state.value = 'generating'
  downloadPct.value = null
  errorMessage.value = null
  abortController = new AbortController()
  try {
    const summary = await generateSummary(
      text,
      (m) => {
        m.addEventListener('downloadprogress', (e) => {
          downloadPct.value = Math.round(e.loaded * 100)
        })
      },
      abortController.signal,
    )
    setCachedSummary(key, summary)
    html.value = renderMarkdown(summary)
    shownKey = key
    state.value = 'ready'
  } catch (err) {
    state.value = 'error'
    errorMessage.value = err instanceof Error ? err.message : String(err)
  } finally {
    downloadPct.value = null
    abortController = null
  }
}
</script>

<template>
  <section v-if="visible" class="summary-card">
    <DetailSection title="summary" :icon="Sparkles" :open="open" @toggle="open = !open">
      <div v-if="state === 'idle'" class="sum-row">
        <button class="sum-btn" type="button" @click="generate">generate summary</button>
        <span class="dim">on-device key points — nothing leaves the browser</span>
      </div>

      <div v-else-if="state === 'generating'" class="sum-row">
        <span class="dim">{{
          downloadPct != null ? `downloading model… ${downloadPct}%` : 'generating summary…'
        }}</span>
      </div>

      <template v-else-if="state === 'ready'">
        <!-- Safe: renderMarkdown escapes ALL input before emitting its own tags. -->
        <div class="md" v-html="html" />
        <div class="sum-row">
          <button class="sum-btn" type="button" @click="generate">regenerate</button>
          <span v-if="stale" class="dim">session has moved on since this summary</span>
        </div>
      </template>

      <div v-else class="sum-row">
        <span class="dim" :title="errorMessage ?? undefined">summary unavailable</span>
        <button class="sum-btn" type="button" @click="generate">try again</button>
      </div>
    </DetailSection>
  </section>
</template>

<style scoped>
/* Same material as the waterfall board: hairline frame, face fill, an inset
   header — a small board of its own, not a generic panel. The disclosure
   itself (chevron, icon, uppercase title, toggle) is DetailSection's; only
   this outer frame and the inset header band are specific to this card. */
.summary-card {
  margin: 20px 28px 0;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--face);
  overflow: hidden;
}

.summary-card :deep(.dsec) {
  margin-bottom: 0;
}

.summary-card :deep(.dsec-head) {
  padding: 10px 16px;
  background: var(--inset);
}

.summary-card :deep(.dsec-head:hover) {
  background: var(--inset);
}

.summary-card :deep(.dsec-body) {
  padding: 14px 16px;
}

.sum-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 16px;
}

.sum-btn {
  padding: 5px 14px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: none;
  color: var(--dim);
  font-family: var(--mono);
  font-size: 16px;
  cursor: pointer;
}

.sum-btn:hover,
.sum-btn:focus-visible {
  color: var(--fg);
  border-color: var(--accent);
}

.md {
  margin-bottom: 12px;
}
</style>
