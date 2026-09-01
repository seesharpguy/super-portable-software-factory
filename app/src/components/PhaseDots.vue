<script setup lang="ts">
import { computed } from 'vue'
import type { Phase } from '../lib/types'

// Tuned to the timetable's 130px phases column: at ~20px/dot plus the "N/M"
// label already printed beside it, six is what the row can carry before a
// long run would spill dots into the status column next door.
const props = withDefaults(defineProps<{ phases: Phase[]; max?: number }>(), { max: 6 })

const ordered = computed(() => props.phases.toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0)))

// Remark codes in a printed timetable: done, running, waiting, failed.
const glyph: Record<string, string> = {
  success: '●',
  running: '◐',
  queued: '○',
  fail: '✗',
}

/**
 * A run past `max` phases prints a bounded strip, not a wall of dots — but
 * never at the cost of hiding a failure. Every failed phase always shows;
 * remaining slots fill from the front (earliest first, matching reading
 * order), and whatever still doesn't fit collapses into a mono "+N" so the
 * exact count survives even when the glyphs don't.
 */
const shown = computed(() => {
  const list = ordered.value
  if (list.length <= props.max) return { visible: list, hidden: 0 }
  const failed = list.filter((p) => p.status === 'fail')
  const rest = list.filter((p) => p.status !== 'fail')
  const restBudget = Math.max(0, props.max - failed.length)
  const visible = [...failed, ...rest.slice(0, restBudget)].toSorted(
    (a, b) => (a.seq ?? 0) - (b.seq ?? 0),
  )
  const visibleIds = new Set(visible.map((p) => p.phase_id))
  return { visible, hidden: list.length - visibleIds.size }
})
</script>

<template>
  <span class="dots">
    <span
      v-for="p in shown.visible"
      :key="p.phase_id"
      class="d"
      :class="p.status"
      :title="`${p.name} — ${p.status}`"
      >{{ glyph[p.status ?? ''] ?? '○' }}</span
    >
    <span v-if="shown.hidden" class="d-more mono" :title="`${shown.hidden} more phase${shown.hidden === 1 ? '' : 's'}`"
      >+{{ shown.hidden }}</span
    >
    <span v-if="!ordered.length" class="faint">—</span>
  </span>
</template>

<style scoped>
.dots {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 16px;
  letter-spacing: 0;
}

.d-more {
  color: var(--faint);
  font-size: 16px;
}

.d.success {
  color: var(--pass);
}

.d.fail {
  color: var(--fail);
}

.d.running {
  color: var(--live);
}

/* Only the board blinks; a running mark on the paper is a static ballpoint
   annotation. */
body.board .d.running {
  animation: pulse 1.2s ease-in-out infinite;
}

.d.queued {
  color: var(--faint);
}
</style>
