<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Phase, Session, SessionDetail } from '../lib/types'
import { MessageCircleQuestion } from 'lucide-vue-next'
import {
  buildSessionContext,
  createSessionQaSession,
  isPromptApiAvailable,
} from '../lib/prompt-qa'
import type { SessionQaContextMode, SessionQaSession } from '../lib/prompt-qa'
import DetailSection from './DetailSection.vue'

const props = defineProps<{ adwId: string; session: Session; phases: Phase[] }>()

interface ChatMessage {
  id: number
  role: 'user' | 'assistant' | 'error'
  text: string
}

// Gated on availability(), not just the namespace check — same reasoning as
// SessionSummary.vue: a browser that ships LanguageModel but can't actually
// run it should look exactly like one that never shipped it.
const visible = ref(false)
const open = ref(true)
const question = ref('')
const messages = ref<ChatMessage[]>([])
const answering = ref(false)
const downloadPct = ref<number | null>(null)
// Set once, the first time context is built for this (session-scoped) panel
// — the trace doesn't change shape mid-conversation the way it does for
// SessionSummary's regenerate button, so there's nothing to go stale here.
const contextMode = ref<SessionQaContextMode | null>(null)
// True once the model has reported dropping earlier turns to fit its context
// window — sticky for the life of the panel, not just the triggering turn.
const contextOverflowed = ref(false)

let nextId = 0
let qaSession: SessionQaSession | null = null
// De-dupes concurrent create() calls; in practice `answering` already
// prevents concurrent submits, but this keeps ensureSession safe on its own.
let creating: Promise<SessionQaSession> | null = null

onMounted(async () => {
  try {
    visible.value = await isPromptApiAvailable()
  } catch {
    visible.value = false
  }
})

onUnmounted(() => {
  qaSession?.destroy()
})

function pushMessage(role: ChatMessage['role'], text: string): ChatMessage {
  const msg = { id: ++nextId, role, text }
  messages.value.push(msg)
  return msg
}

/**
 * Lazily creates the on-device session, seeded with this session's trace as
 * context. Only ever called from inside submit()'s own gesture — Chrome's
 * LanguageModel.create() requires user activation, same as
 * Summarizer.create() (see summarizer.ts, prompt-qa.ts). Cached for the
 * panel's lifetime so the trace context is sent once, not re-seeded per
 * question.
 */
async function ensureSession(): Promise<SessionQaSession> {
  if (qaSession) return qaSession
  if (creating) return creating
  creating = (async () => {
    const detail: Pick<SessionDetail, 'session' | 'phases'> = {
      session: props.session,
      phases: props.phases,
    }
    const context = await buildSessionContext(detail)
    contextMode.value = context.mode
    const created = await createSessionQaSession(
      props.adwId,
      context.text,
      (m) => {
        m.addEventListener('downloadprogress', (e) => {
          downloadPct.value = Math.round(e.loaded * 100)
        })
      },
      () => {
        contextOverflowed.value = true
      },
    )
    qaSession = created
    return created
  })()
  try {
    return await creating
  } finally {
    creating = null
    downloadPct.value = null
  }
}

async function submit() {
  const text = question.value.trim()
  if (!text || answering.value) return
  question.value = ''
  pushMessage('user', text)
  answering.value = true
  const pending = pushMessage('assistant', '')
  try {
    const session = await ensureSession()
    pending.text = await session.ask(text)
  } catch (err) {
    messages.value = messages.value.filter((m) => m.id !== pending.id)
    pushMessage('error', err instanceof Error ? err.message : String(err))
  } finally {
    answering.value = false
  }
}

const contextNote = computed(() => {
  if (contextMode.value === 'condensed') {
    return 'using a condensed summary of this run as context — the full trace was too large to fit'
  }
  if (contextMode.value === 'truncated') {
    return "this run's trace was truncated to fit as context — some phase data was left out"
  }
  return null
})

const roleLabel: Record<ChatMessage['role'], string> = {
  user: 'you',
  assistant: 'model',
  error: 'error',
}
</script>

<template>
  <section v-if="visible" class="qa-card">
    <DetailSection title="ask" :icon="MessageCircleQuestion" :open="open" @toggle="open = !open">
      <div v-if="contextNote" class="qa-note">{{ contextNote }}</div>
      <div v-if="contextOverflowed" class="qa-note qa-note-warn">
        the model dropped earlier turns to fit its context window — its answers may no longer reflect the whole conversation
      </div>

      <div class="qa-thread">
        <p v-if="!messages.length" class="dim qa-empty">
          ask a question about this run — answered on-device, nothing leaves the browser
        </p>
        <div v-for="m in messages" :key="m.id" class="qa-msg" :class="`qa-role-${m.role}`">
          <span class="qa-role dim">{{ roleLabel[m.role] }}</span>
          <span v-if="m.role === 'assistant' && !m.text && answering" class="dim">thinking…</span>
          <span v-else class="qa-text">{{ m.text }}</span>
        </div>
        <div v-if="downloadPct != null" class="dim qa-note">downloading model… {{ downloadPct }}%</div>
      </div>

      <form class="qa-input-row" @submit.prevent="submit">
        <input
          v-model="question"
          class="qa-input"
          type="text"
          placeholder="ask about this run…"
          :disabled="answering"
        />
        <button class="qa-btn" type="submit" :disabled="answering || !question.trim()">ask</button>
      </form>
    </DetailSection>
  </section>
</template>

<style scoped>
/* Same material as SessionSummary's card: hairline frame, face fill, an
   inset header — a small board of its own. */
.qa-card {
  margin: 20px 28px 0;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--face);
  overflow: hidden;
}

.qa-card :deep(.dsec) {
  margin-bottom: 0;
}

.qa-card :deep(.dsec-head) {
  padding: 10px 16px;
  background: var(--inset);
}

.qa-card :deep(.dsec-head:hover) {
  background: var(--inset);
}

.qa-card :deep(.dsec-body) {
  padding: 14px 16px;
}

.qa-note {
  margin-bottom: 10px;
  font-size: 16px;
  color: var(--dim);
}

.qa-note-warn {
  color: var(--amber);
}

.qa-thread {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 360px;
  overflow-y: auto;
  margin-bottom: 12px;
}

.qa-empty {
  font-size: 16px;
}

.qa-msg {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
  border: 1px solid var(--rule-soft);
  border-radius: var(--radius);
  background: var(--inset);
}

.qa-role-user {
  align-self: flex-end;
  max-width: 85%;
  background: none;
}

.qa-role-assistant {
  max-width: 85%;
}

.qa-role-error {
  border-color: var(--fail);
}

.qa-role {
  font-size: 16px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.qa-text {
  font-size: 17px;
  color: var(--fg);
  white-space: pre-wrap;
}

.qa-role-error .qa-text {
  color: var(--fail);
}

.qa-input-row {
  display: flex;
  gap: 8px;
}

.qa-input {
  flex: 1 1 auto;
  padding: 7px 12px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--ground);
  color: var(--fg);
  font-family: var(--mono);
  font-size: 16px;
}

.qa-input:focus-visible {
  outline: none;
  border-color: var(--accent);
}

.qa-btn {
  padding: 5px 14px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: none;
  color: var(--dim);
  font-family: var(--mono);
  font-size: 16px;
  cursor: pointer;
}

.qa-btn:hover:not(:disabled),
.qa-btn:focus-visible:not(:disabled) {
  color: var(--fg);
  border-color: var(--accent);
}

.qa-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
