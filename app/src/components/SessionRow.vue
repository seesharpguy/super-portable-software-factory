<script setup lang="ts">
import { computed } from 'vue'
import type { SessionSummary } from '../lib/types'
import { Archive } from 'lucide-vue-next'
import { archiveSession } from '../lib/api'
import { fmtClock, fmtCost, fmtDuration, fmtTokens, ts } from '../lib/format'
import { hrefFor } from '../lib/router'
import PhaseDots from './PhaseDots.vue'

const props = defineProps<{ session: SessionSummary; nowMs: number }>()
const emit = defineEmits<{ archived: [adwId: string] }>()

// The row is an <a>; the archive button lives inside it, so the click must not
// navigate. Told the parent optimistically — the poll would take up to half a
// second to drop the row, and a triage click should feel instant.
async function archive(event: MouseEvent) {
  event.preventDefault()
  event.stopPropagation()
  emit('archived', props.session.adw_id)
  try {
    await archiveSession(props.session.adw_id)
  } catch {
    emit('archived', '')   // signals the parent to re-sync from the server
  }
}

const running = computed(() => props.session.status === 'running')

const phases = computed(() => props.session.phases ?? [])
const phaseTotal = computed(() => phases.value.length)
const phaseDone = computed(() => phases.value.filter((p) => p.status === 'success').length)

const durationMs = computed(() => {
  const s = props.session
  const start = ts(s.started_at)
  if (!Number.isFinite(start)) return NaN
  const end = running.value ? props.nowMs : ts(s.ended_at)
  return (Number.isFinite(end) ? end : props.nowMs) - start
})

const cost = computed(() => fmtCost(props.session.total_cost))
const runtime = computed(() => fmtDuration(durationMs.value))
const tokens = computed(() => fmtTokens(props.session.total_tokens))

// The folded second line on narrow paper: everything the columns would have
// carried, in one mono remark line.
const metaLine = computed(
  () =>
    `${fmtClock(props.session.started_at)} · ${phaseDone.value}/${phaseTotal.value} phases · ` +
    `${runtime.value} · ${cost.value} · ${tokens.value}`,
)
</script>

<template>
  <a class="row" :class="session.status" :href="hrefFor(session.adw_id)">
    <span class="c departed mono dim" :title="session.started_at ?? ''">{{
      fmtClock(session.started_at)
    }}</span>
    <span class="c run mono">{{ session.adw_id }}</span>
    <span class="c service" :title="session.adw_name ?? ''">{{ session.adw_name ?? '—' }}</span>
    <span class="c request" :title="session.request ?? ''">{{ session.request }}</span>
    <span class="c phases">
      <span class="mono dim">{{ phaseDone }}/{{ phaseTotal }}</span>
      <PhaseDots :phases="phases" :max="4" />
    </span>
    <span class="c status" :class="session.status ?? 'fail'">{{ session.status ?? 'fail' }}</span>
    <span class="c num cost mono">{{ cost }}</span>
    <span class="c num runtime mono">{{ runtime }}</span>
    <span class="c num tokens mono">{{ tokens }}</span>
    <button
      class="act"
      type="button"
      aria-label="Archive — remove this run from review"
      title="Archive — remove this run from review"
      @click="archive"
    >
      <Archive :size="17" :stroke-width="2" />
    </button>
    <span class="meta mono dim">{{ metaLine }}</span>
  </a>
</template>

<style scoped>
/* One departure on the printed timetable: baseline-aligned cells, a hairline
   under each row, numbers in the data voice right-aligned in their columns.
   The column template comes from --tt-columns on .tt (SessionsList) so the
   header stays in lockstep with the rows. */
.row {
  display: grid;
  grid-template-columns: var(--tt-columns);
  align-items: baseline;
  column-gap: 18px;
  padding: 9px 0;
  border-bottom: 1px solid var(--rule-soft);
  color: var(--fg);
  text-decoration: none;
  font-size: 16px;
}

.row:hover {
  background: var(--face);
}

.run {
  font-weight: 700;
}

.service,
.request {
  color: var(--dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.phases {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  overflow: hidden;
  white-space: nowrap;
}

.status {
  font-weight: 600;
  white-space: nowrap;
}

.num {
  text-align: right;
  white-space: nowrap;
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

/* State words are signals, written in their ink. */
.status.success {
  color: var(--pass);
}

.status.fail {
  color: var(--fail);
}

/* A run in flight gets annotated in ballpoint — the paper's only live mark. */
.status.running {
  color: var(--live);
  font-style: italic;
}

.status.queued {
  color: var(--faint);
  font-style: italic;
}

.row.running {
  background: var(--face);
}

.act {
  justify-self: end;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: none;
  color: var(--faint);
  cursor: pointer;
}

.act:hover,
.act:focus-visible {
  border-color: var(--rule);
  color: var(--accent);
}

.meta {
  display: none;
}

/* Narrow paper: the timetable folds — id and status on the first line, the
   request on the second, and one mono remark line carrying everything the
   hidden columns would have. */
@media (max-width: 980px) {
  .row {
    grid-template-columns: 1fr auto auto;
    row-gap: 3px;
    padding: 12px 0;
  }

  .departed,
  .service,
  .phases,
  .num {
    display: none;
  }

  .request {
    grid-column: 1 / -1;
  }

  .meta {
    display: block;
    grid-column: 1 / -1;
    font-size: 16px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
