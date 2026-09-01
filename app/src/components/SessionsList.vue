<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import type { SessionSummary } from '../lib/types'
import { fetchSessions } from '../lib/api'
import { ts } from '../lib/format'
import SessionRow from './SessionRow.vue'

const sessions = shallowRef<SessionSummary[]>([])
const apiError = ref<string | null>(null)
const loaded = ref(false)
const nowMs = ref(Date.now())

let timer: ReturnType<typeof setInterval> | undefined
let inflight = false

async function tick() {
  if (inflight) return
  inflight = true
  try {
    sessions.value = await fetchSessions()
    nowMs.value = Date.now()
    apiError.value = null
    loaded.value = true
  } catch (err) {
    apiError.value = err instanceof Error ? err.message : String(err)
  } finally {
    inflight = false
  }
}

onMounted(() => {
  void tick()
  timer = setInterval(() => void tick(), 500)
})

onUnmounted(() => clearInterval(timer))

/** Optimistic removal; an empty id means the write failed, so re-sync instead. */
function onArchived(adwId: string) {
  if (!adwId) {
    void tick()
    return
  }
  sessions.value = sessions.value.filter((s) => s.adw_id !== adwId)
}

const ordered = computed(() =>
  sessions.value.toSorted((a, b) => (ts(b.started_at) || 0) - (ts(a.started_at) || 0)),
)
</script>

<template>
  <div class="sessions">
    <div v-if="apiError" class="error-bar">api unreachable — retrying {{ apiError }}</div>

    <div v-if="ordered.length" class="tt">
      <div class="tt-caption">
        <span class="tt-title">departures</span>
        <span class="dim mono">{{ ordered.length }} recorded</span>
      </div>
      <div class="tt-head" aria-hidden="true">
        <span class="h">departed</span>
        <span class="h">run</span>
        <span class="h">service</span>
        <span class="h">request</span>
        <span class="h">phases</span>
        <span class="h">status</span>
        <span class="h h-num">cost</span>
        <span class="h h-num">runtime</span>
        <span class="h h-num">tokens</span>
        <span class="h" />
      </div>
      <SessionRow
        v-for="s in ordered"
        :key="s.adw_id"
        :session="s"
        :now-ms="nowMs"
        @archived="onArchived"
      />
    </div>
    <div v-else-if="loaded" class="empty-state">no sessions yet — run an ADW to see it here</div>
    <div v-else-if="!apiError" class="empty-state">loading sessions…</div>
  </div>
</template>

<style scoped>
.sessions {
  display: flex;
  flex-direction: column;
}

/* The printed timetable: one shared column template, so the head and every
   row sit on the same grid. */
.tt {
  --tt-columns: 84px 160px minmax(90px, 140px) minmax(0, 1fr) 168px 100px 90px 90px 90px 70px;
  margin: 8px 28px 40px;
}

.tt-caption {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 18px 0 8px;
}

.tt-title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.tt-head {
  display: grid;
  grid-template-columns: var(--tt-columns);
  column-gap: 18px;
  padding: 0 0 6px;
  border-bottom: 1px solid var(--rule);
}

.h {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: lowercase;
  color: var(--faint);
  white-space: nowrap;
}

.h-num {
  text-align: right;
}

@media (max-width: 980px) {
  .tt {
    margin: 8px 16px 40px;
  }

  .tt-head {
    display: none;
  }
}
</style>
