<script setup lang="ts">
import { Check, Circle, LoaderCircle, X } from 'lucide-vue-next'

defineProps<{ status: string }>()

const ICONS: Record<string, unknown> = {
  success: Check,
  fail: X,
  running: LoaderCircle,
  queued: Circle,
}
</script>

<template>
  <span class="chip" :class="status">
    <component :is="ICONS[status] ?? Circle" class="chip-icon" :size="16" :stroke-width="2.5" />
    <!-- Keyed so a status change re-mounts the word — on the board that plays
         the split-flap. Vue remounts on key change; the paper lists never
         render this chip, so the flap only ever plays in board grammar. -->
    <span class="chip-label" :key="status">{{ status }}</span>
  </span>
</template>

<style scoped>
/* A square timetable cell, not a pill. Signal colors come from the semantic
   tokens, so the same markup reads as print ink on paper and as lamp-lit
   verdict on the board. */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 2px 10px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: transparent;
  font-size: 16px;
  font-weight: 600;
  color: var(--dim);
  white-space: nowrap;
}

.chip-icon {
  flex: none;
}

.chip-label {
  display: inline-block;
  transform-origin: 50% 65%;
}

body.board .chip-label {
  animation: flap-in 260ms cubic-bezier(0.2, 0.7, 0.3, 1);
}

.chip.success {
  color: var(--pass);
  border-color: var(--pass);
}

.chip.fail {
  color: var(--fail);
  border-color: var(--fail);
}

.chip.running {
  color: var(--live);
  border-color: var(--live);
}

body.board .chip.running .chip-icon {
  animation: spin 1.1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.chip.queued {
  color: var(--faint);
  border-style: dashed;
}
</style>
