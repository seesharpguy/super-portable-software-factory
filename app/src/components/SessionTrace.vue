<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watchEffect } from 'vue'
import type {
  AgentSession,
  AgentStartPayload,
  Envelope,
  EventRow,
  GateResult,
  Phase,
  PhaseKind,
  Session,
  SessionUsage,
} from '../lib/types'
import { Bot, SquareTerminal, UserRound } from 'lucide-vue-next'
import { fetchEnvelopes, fetchEvents, fetchGates, fetchSession } from '../lib/api'
import { axisTicks, fmtDate, payloadOk, ts } from '../lib/format'
import { modelIcon, modelName } from '../lib/models'
import { parseAgentStart } from '../lib/events'
import { navigate, phaseCrumb } from '../lib/router'
import StatusChip from './StatusChip.vue'
import StatChip from './StatChip.vue'
import PhaseDetail from './PhaseDetail.vue'
import SessionSummary from './SessionSummary.vue'
import SessionQaPanel from './SessionQaPanel.vue'

const props = defineProps<{ adwId: string; phaseId: string | null }>()

const session = ref<Session | null>(null)
const phases = ref<Phase[]>([])
const agents = ref<AgentSession[]>([])
const usage = ref<SessionUsage>({ read: 0, written: 0 })
const events = ref<EventRow[]>([])
const envelopes = ref<Envelope[]>([])
const gates = ref<GateResult[]>([])
const apiError = ref<string | null>(null)
const loaded = ref(false)
const nowMs = ref(Date.now())

let cursor = 0
let inflight = false
let timer: ReturnType<typeof setInterval> | undefined

const SIDE_TABLE_TYPES = new Set(['gate_pass', 'gate_fail', 'handoff', 'agent_end', 'phase_end', 'error'])

async function tick() {
  if (inflight) return
  inflight = true
  try {
    const detail = await fetchSession(props.adwId)
    session.value = detail.session
    phases.value = detail.phases.toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    agents.value = detail.agents
    usage.value = detail.usage

    const fresh: EventRow[] = []
    let page
    do {
      // Cursor pagination is inherently sequential: each request needs the previous cursor.
      // oxlint-disable-next-line no-await-in-loop
      page = await fetchEvents(props.adwId, cursor, 1000)
      cursor = Math.max(cursor, page.cursor)
      fresh.push(...page.events)
    } while (page.has_more)
    if (fresh.length) events.value = [...events.value, ...fresh]

    // Envelopes and gates only gain rows around phase/agent boundaries — refetch
    // on those events instead of every tick.
    if (!loaded.value || fresh.some((e) => e.type !== null && SIDE_TABLE_TYPES.has(e.type))) {
      const [env, g] = await Promise.all([fetchEnvelopes(props.adwId), fetchGates(props.adwId)])
      envelopes.value = env
      gates.value = g
    }

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

onUnmounted(() => {
  clearInterval(timer)
  phaseCrumb.value = null
})

const selectedPhase = computed(
  () => phases.value.find((p) => p.phase_id === props.phaseId) ?? null,
)

watchEffect(() => {
  phaseCrumb.value = selectedPhase.value?.name ?? null
})

// ── Lanes ────────────────────────────────────────────────────────────────────
// Lanes are tracks: identified by number and name, never by color. Hue on the
// board means state (amber live, red failed), not actor.

const KIND_ICONS = { engineer: UserRound, code: SquareTerminal, agent: Bot }

interface Lane {
  id: string
  track: string
  label: string
  /** Model driving this lane's agent — rendered with its provider icon. */
  model: string | null
  /** Context-window occupancy, or null while unknown (running / old db). */
  context: LaneContext | null
  metaLines: string[]
  kind: PhaseKind
  phases: Phase[]
}

interface LaneContext {
  used: number
  window: number
  /** 0–100, uncapped by the floor applied to the bar's width. */
  pct: number
}

/** Occupancy for an agent lane. Null unless BOTH numbers are real — a bar
 *  against an unknown ceiling would be decoration, not data. */
function laneContext(info: AgentSession | undefined): LaneContext | null {
  const used = info?.context_tokens ?? 0
  const window = info?.context_window ?? 0
  if (!used || !window) return null
  return { used, window, pct: Math.min(100, (used / window) * 100) }
}

/** Sub-1% occupancy is common and real; round it away and the bar reads empty. */
function contextLabel(ctx: LaneContext): string {
  return ctx.pct < 1 ? `${ctx.pct.toFixed(1)}%` : `${Math.round(ctx.pct)}%`
}

/** Keep a non-zero fill visible — the exact numbers ride in the label and title. */
function contextFill(ctx: LaneContext): string {
  return `scaleX(${Math.max(ctx.pct, 2) / 100})`
}

function laneRunning(lane: Lane): boolean {
  return lane.phases.some((p) => p.status === 'running')
}

const NUM = new Intl.NumberFormat('en-US')

// A live agent's model/thinking arrive on its agent_start event before any
// agent_sessions row exists; attribute each start to its phase's owner.
const ownerStart = computed<Record<string, AgentStartPayload>>(() => {
  const ownerByPhase = new Map<string, string | null>(
    phases.value.map((p) => [p.phase_id, p.owner]),
  )
  const meta: Record<string, AgentStartPayload> = {}
  for (const e of events.value) {
    if (e.type !== 'agent_start') continue
    const owner = (e.phase_id ? ownerByPhase.get(e.phase_id) : null) ?? e.name
    if (!owner || meta[owner]) continue
    const payload = parseAgentStart(e)
    if (payload) meta[owner] = payload
  }
  return meta
})

const lanes = computed<Lane[]>(() => {
  const ph = phases.value
  const agentOwners: string[] = []
  for (const p of ph) {
    if (p.kind === 'agent' && p.owner && !agentOwners.includes(p.owner)) agentOwners.push(p.owner)
  }
  const codePhases = ph.filter((p) => p.kind === 'code')
  const out: Lane[] = [
    {
      id: 'engineer',
      track: '',
      label: session.value?.engineer ?? 'engineer',
      model: null,
      context: null,
      metaLines: ['engineer'],
      kind: 'engineer' as const,
      phases: ph.filter((p) => p.kind === 'engineer'),
    },
  ]
  if (codePhases.length) {
    out.push({
      id: 'code',
      track: '',
      label: 'code',
      model: null,
      context: null,
      metaLines: ['workspace'],
      kind: 'code' as const,
      phases: codePhases,
    })
  }
  for (const owner of agentOwners) {
    const info = agents.value.find((a) => a.agent === owner)
    const start = ownerStart.value[owner]
    out.push({
      id: `agent:${owner}`,
      track: '',
      label: owner,
      // The model is the lane's whole story; thinking level lives in the
      // phase detail's agent config section.
      model: info?.model ?? start?.model ?? null,
      context: laneContext(info),
      metaLines: [],
      kind: 'agent' as const,
      phases: ph.filter((p) => p.kind === 'agent' && p.owner === owner),
    })
  }
  // Track numbers 01.. stay stable for the session's life.
  out.forEach((lane, i) => {
    lane.track = String(i + 1).padStart(2, '0')
  })
  return out
})

// ── Timeline geometry ────────────────────────────────────────────────────────

const range = computed(() => {
  let t0 = Infinity
  let t1 = -Infinity
  const s = session.value
  const sStart = ts(s?.started_at)
  const sEnd = ts(s?.ended_at)
  if (Number.isFinite(sStart)) t0 = Math.min(t0, sStart)
  if (Number.isFinite(sEnd)) t1 = Math.max(t1, sEnd)
  for (const p of phases.value) {
    const a = ts(p.started_at)
    const b = ts(p.ended_at)
    if (Number.isFinite(a)) {
      t0 = Math.min(t0, a)
      t1 = Math.max(t1, a)
    }
    if (Number.isFinite(b)) t1 = Math.max(t1, b)
  }
  if (s?.status === 'running') t1 = Math.max(t1, nowMs.value)
  if (!Number.isFinite(t0)) {
    t0 = nowMs.value
    t1 = t0 + 1000
  }
  if (t1 - t0 < 1000) t1 = t0 + 1000
  return { t0, t1, span: t1 - t0 }
})

// The engineer's request opens the run and owns the start of the timeline: it
// gets an exclusive leading zone, and every later phase maps into the rest —
// nothing can render on top of it.
// Wide enough that the request block carries its full name at desktop widths
// — anything narrower amputates the word ("re…"), and amputation is noise.
const REQ_ZONE_PCT = 24

const requestPhase = computed(
  () => phases.value.find((p) => p.kind === 'engineer' && p.started_at) ?? null,
)

const zonePct = computed(() => (requestPhase.value ? REQ_ZONE_PCT : 0))

/**
 * Where the post-request timeline begins, in ms.
 *
 * The earliest non-engineer phase start, not the request phase's end: a later
 * ADW joining the session pushes the request row's ended_at forward, which
 * would otherwise throw every already-finished phase behind the origin.
 */
const originMs = computed(() => {
  const { t0 } = range.value
  const req = requestPhase.value
  if (!req) return t0
  let earliest = Infinity
  for (const p of phases.value) {
    if (p.kind === 'engineer') continue
    const s = ts(p.started_at)
    if (Number.isFinite(s)) earliest = Math.min(earliest, s)
  }
  if (Number.isFinite(earliest)) return Math.max(earliest, t0)
  const end = ts(req.ended_at ?? req.started_at)
  return Number.isFinite(end) ? Math.max(end, t0) : t0
})

const postSpan = computed(() => Math.max(range.value.t1 - originMs.value, 1000))

const ticks = computed(() => {
  const zone = zonePct.value
  return axisTicks(postSpan.value, 7).map((t) => ({
    pct: zone + (t.pct * (100 - zone)) / 100,
    label: t.label,
  }))
})

/**
 * Adjusted layout for every timed phase, in track-%.
 *
 * Phases are sequential by doctrine, and the render must say so: when a
 * near-zero phase (a git commit) is widened to a readable floor, every later
 * block shifts right by the same amount instead of being overlapped, and the
 * whole layout is normalized back into the track. Blocks may squeeze a hair;
 * they never stack.
 */
const MIN_BLOCK_PCT = 3.5

const blockLayout = computed<Record<string, { left: number; width: number }>>(() => {
  const zone = zonePct.value
  const avail = 100 - zone - 0.4 // hair of right margin
  const t0 = originMs.value
  const span = postSpan.value
  const reqId = requestPhase.value?.phase_id

  const timed = phases.value
    .filter((p) => p.phase_id !== reqId && Number.isFinite(ts(p.started_at)))
    .map((p) => {
      const start = ts(p.started_at)
      let end = ts(p.ended_at)
      if (!Number.isFinite(end)) end = p.status === 'running' ? nowMs.value : start
      return {
        id: p.phase_id,
        start,
        left: ((start - t0) / span) * avail,
        width: ((Math.max(end, start) - start) / span) * avail,
      }
    })
    .toSorted((a, b) => a.start - b.start)

  let shift = 0
  let prevEdge = 0
  const rows: { id: string; left: number; width: number }[] = []
  for (const b of timed) {
    let left = b.left + shift
    if (left < prevEdge) {
      shift += prevEdge - left
      left = prevEdge
    }
    const width = Math.max(b.width, MIN_BLOCK_PCT)
    shift += width - b.width
    prevEdge = left + width
    rows.push({ id: b.id, left, width })
  }

  const scale = avail / Math.max(prevEdge, avail)
  const out: Record<string, { left: number; width: number }> = {}
  for (const r of rows) out[r.id] = { left: zone + r.left * scale, width: r.width * scale }
  return out
})

function blockGeom(p: Phase): { left: string; width: string } | null {
  // The request block fills its reserved zone, nothing else ever enters it.
  if (p.phase_id === requestPhase.value?.phase_id && zonePct.value > 0) {
    return { left: '0.4%', width: `${zonePct.value - 0.8}%` }
  }
  const geom = blockLayout.value[p.phase_id]
  if (!geom) return null
  return { left: `${geom.left}%`, width: `${geom.width}%` }
}

/** Geometry only — color is status, carried by classes. */
function blockStyle(p: Phase): Record<string, string> | undefined {
  const geom = blockGeom(p)
  if (!geom) return undefined
  return { left: geom.left, width: geom.width }
}

function blockDurationMs(p: Phase): number {
  const start = ts(p.started_at)
  if (!Number.isFinite(start)) return NaN
  const end = p.status === 'running' ? nowMs.value : ts(p.ended_at)
  if (!Number.isFinite(end)) return NaN
  return end - start
}

const STATUS_GLYPH: Record<string, string> = {
  success: '✓',
  fail: '✗',
  running: '●',
  queued: '○',
}

// Tool-call tick marks inside a phase block, positioned within the block's own span.
interface ToolTick {
  t: number
  ok: boolean
}

const toolTicks = computed(() => {
  const map: Record<string, ToolTick[]> = {}
  for (const e of events.value) {
    if (e.type !== 'tool_call' || !e.phase_id) continue
    map[e.phase_id] ??= []
    map[e.phase_id]?.push({ t: ts(e.started_at), ok: payloadOk(e.payload_json) })
  }
  return map
})

function ticksFor(p: Phase): { x: number; ok: boolean }[] {
  const start = ts(p.started_at)
  if (!Number.isFinite(start)) return []
  let end = ts(p.ended_at)
  if (!Number.isFinite(end)) end = p.status === 'running' ? nowMs.value : start
  const width = Math.max(end - start, 1)
  return (toolTicks.value[p.phase_id] ?? [])
    .filter((mark) => Number.isFinite(mark.t))
    .map((mark) => ({
      x: Math.min(Math.max(((mark.t - start) / width) * 100, 1), 99),
      ok: mark.ok,
    }))
}

const queuedByLane = computed(() => {
  const map: Record<string, Phase[]> = {}
  for (const lane of lanes.value) {
    map[lane.id] = lane.phases.filter((p) => !p.started_at)
  }
  return map
})

const sessionDurationMs = computed(() => {
  const s = session.value
  if (!s) return NaN
  const start = ts(s.started_at)
  if (!Number.isFinite(start)) return NaN
  const end = s.status === 'running' ? nowMs.value : ts(s.ended_at)
  return (Number.isFinite(end) ? end : nowMs.value) - start
})

function selectPhase(p: Phase) {
  navigate(props.adwId, p.phase_id === props.phaseId ? null : p.phase_id)
}
</script>

<template>
  <div class="trace">
    <div v-if="apiError" class="error-bar">api unreachable — retrying {{ apiError }}</div>

    <div v-if="session" class="run-strip">
      <span class="request" :title="session.request ?? ''">{{ session.request }}</span>
      <StatusChip :status="session.status ?? 'fail'" />
      <span class="dim mono">departed {{ fmtDate(session.started_at) }}</span>
      <span class="run-stats">
        <StatChip kind="cost" :value="session.total_cost" />
        <StatChip kind="runtime" :value="sessionDurationMs" />
        <StatChip kind="tokens" :value="session.total_tokens" />
        <StatChip kind="read" :value="usage.read" />
        <StatChip kind="written" :value="usage.written" />
      </span>
    </div>

    <SessionSummary v-if="session" :adw-id="adwId" :session="session" :phases="phases" />

    <div v-if="phases.length" class="waterfall">
      <div class="row axis-row">
        <div class="label" />
        <div class="track">
          <span v-if="zonePct" class="zone-head" :style="{ width: `${zonePct}%` }">request</span>
          <span
            v-for="(t, i) in ticks"
            :key="i"
            class="axis-label"
            :style="{ left: `${t.pct}%` }"
            >{{ t.label }}</span
          >
        </div>
      </div>

      <div v-for="lane in lanes" :key="lane.id" class="row lane" :class="`kind-${lane.kind}`">
        <div class="label">
          <span class="lane-name">
            <span class="tno mono">{{ lane.track }}</span>
            <component :is="KIND_ICONS[lane.kind]" class="lane-icon" :size="19" :stroke-width="2" />
            {{ lane.label }}
          </span>
          <span v-if="lane.model" class="lane-meta lane-model" :title="lane.model">
            <img v-if="modelIcon(lane.model)" class="model-icon" :src="modelIcon(lane.model)!" alt="" />
            {{ modelName(lane.model) }}
          </span>
          <span
            v-if="lane.context"
            class="lane-ctx"
            :title="`${NUM.format(lane.context.used)} / ${NUM.format(lane.context.window)} tokens used · ${NUM.format(lane.context.window - lane.context.used)} remaining`"
          >
            <span class="ctx-head">
              <span class="ctx-label">Context</span>
              <span class="ctx-pct">{{ contextLabel(lane.context) }}</span>
            </span>
            <span class="ctx-bar">
              <span
                class="ctx-fill"
                :class="{ live: laneRunning(lane) }"
                :style="{ width: contextFill(lane.context) }"
              />
            </span>
          </span>
          <span v-for="(line, i) in lane.metaLines" :key="i" class="lane-meta">{{ line }}</span>
        </div>
        <div class="track">
          <span v-if="zonePct" class="zone-divider" :style="{ left: `${zonePct}%` }" />
          <span v-for="(t, i) in ticks" :key="i" class="gridline" :style="{ left: `${t.pct}%` }" />
          <template v-for="p in lane.phases" :key="p.phase_id">
            <button
              v-if="blockGeom(p)"
              class="block"
              :class="[p.status, { selected: p.phase_id === phaseId }]"
              :style="blockStyle(p)"
              :title="`${p.name} — ${p.status}${p.description ? `\n${p.description}` : ''}`"
              @click="selectPhase(p)"
            >
              <span class="b-top">
                <!-- The glyph is keyed on status: when the poll flips it, the
                     remount plays the split-flap. -->
                <span class="flap b-status" :class="p.status" :key="p.status ?? ''">{{
                  STATUS_GLYPH[p.status ?? ''] ?? '○'
                }}</span>
                <span class="b-name">{{ p.name }}</span>
                <StatChip
                  v-if="Number.isFinite(blockDurationMs(p))"
                  class="b-dur"
                  kind="runtime"
                  compact
                  :value="blockDurationMs(p)"
                />
              </span>
              <span class="b-desc">{{ p.description }}</span>
              <span
                v-for="(tick, i) in ticksFor(p)"
                :key="i"
                class="tool-tick"
                :class="{ err: !tick.ok }"
                :style="{ left: `${tick.x}%` }"
              />
            </button>
          </template>
          <button
            v-for="(p, i) in queuedByLane[lane.id]"
            :key="p.phase_id"
            class="block queued"
            :class="{ selected: p.phase_id === phaseId }"
            :style="{ right: `${10 + i * 5}px`, width: '170px' }"
            :title="`${p.name} — queued`"
            @click="selectPhase(p)"
          >
            <span class="b-top">
              <span class="flap b-status queued">○</span>
              <span class="b-name">{{ p.name }}</span>
            </span>
            <span class="b-desc">queued</span>
          </button>
        </div>
      </div>
    </div>
    <div v-else-if="loaded" class="empty-state">no phases recorded for this session</div>
    <div v-else-if="!apiError" class="empty-state">loading trace…</div>

    <SessionQaPanel v-if="session" :adw-id="adwId" :session="session" :phases="phases" />

    <PhaseDetail
      v-if="selectedPhase"
      :phase="selectedPhase"
      :events="events"
      :envelopes="envelopes"
      :gates="gates"
      @close="navigate(props.adwId)"
    />
  </div>
</template>

<style scoped>
.trace {
  padding: 0 0 40px;
}

/* The board's header strip: the route this run is taking. */
.run-strip {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--rule);
  flex-wrap: wrap;
}

.run-strip .request {
  font-size: 17px;
  font-weight: 600;
  color: var(--fg);
  max-width: 52ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-stats {
  display: inline-flex;
  gap: 10px;
  flex-wrap: wrap;
}

/* The board itself: squared corners, hairline frame, one material. */
.waterfall {
  margin: 20px 28px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--face);
  overflow: hidden;
}

.row {
  display: grid;
  grid-template-columns: 250px 1fr;
}

.axis-row {
  border-bottom: 1px solid var(--rule);
  background: var(--inset);
}

.axis-row .track {
  height: 38px;
  overflow: hidden;
}

.zone-head {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--amber);
  border-right: 1px solid var(--rule);
}

.axis-label {
  position: absolute;
  bottom: 6px;
  transform: translateX(-50%);
  font-family: var(--mono);
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  color: var(--dim);
  white-space: nowrap;
}

.label {
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  border-right: 1px solid var(--rule);
  overflow: hidden;
  white-space: nowrap;
}

.lane-name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 17px;
  font-weight: 700;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The track number is the lane's identity — attribution by position and name,
   the way a board works, instead of by hue. */
.tno {
  flex: none;
  width: 26px;
  color: var(--faint);
  font-size: 16px;
}

.lane-icon {
  flex: none;
  color: var(--dim);
}

.lane-meta {
  font-family: var(--mono);
  font-size: 16px;
  color: var(--dim);
  overflow: hidden;
  text-overflow: ellipsis;
}

.lane-model {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.model-icon {
  width: 16px;
  height: 16px;
  flex: none;
  object-fit: contain;
}

/* Context occupancy — label row over a thin track, under the model. */
.lane-ctx {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 2px;
  max-width: 190px;
}

.ctx-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.ctx-label {
  font-size: 16px;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--faint);
}

.ctx-pct {
  font-family: var(--mono);
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  color: var(--dim);
}

.ctx-bar {
  height: 6px;
  background: var(--inset);
  border: 1px solid var(--rule-soft);
  overflow: hidden;
}

.ctx-fill {
  display: block;
  width: 100%;
  height: 100%;
  background: var(--faint);
  transform-origin: left center;
  transition: transform 300ms ease;
}

/* Amber fills only while the lane is live. */
.ctx-fill.live {
  background: var(--amber);
}

.lane {
  border-bottom: 1px solid var(--rule-soft);
}

.lane:last-child {
  border-bottom: none;
}

.track {
  position: relative;
  height: 118px;
  overflow: hidden;
}

.zone-divider {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--rule);
}

.gridline {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px dashed rgba(239, 232, 212, 0.08);
}

/* A phase strip: square bay, hairline frame, bone lettering. Hue belongs to
   the state — amber live, red failed — never to the lane. */
.block {
  position: absolute;
  top: 13px;
  height: 92px;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 4px;
  padding: 10px 12px 16px;
  border-radius: var(--radius);
  border: 1px solid var(--rule);
  background: var(--face);
  font-size: 16px;
  color: var(--fg);
  cursor: pointer;
  overflow: hidden;
  white-space: nowrap;
  text-align: left;
  transition:
    border-color 120ms ease,
    background 120ms ease;
}

.block:hover {
  border-color: var(--dim);
  background: #242119;
}

.b-top {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.flap {
  display: inline-block;
  transform-origin: 50% 65%;
  animation: flap-in 280ms cubic-bezier(0.2, 0.7, 0.3, 1), ;
}

.b-status {
  flex: none;
  font-size: 16px;
  /* Baseline alignment makes glyphs kiss the name — the padding is the flap. */
  padding-right: 8px;
}

.b-status.success {
  color: var(--pass);
}

.b-status.fail {
  color: var(--fail);
}

.b-status.running {
  color: var(--amber);
  animation:
    flap-in 280ms cubic-bezier(0.2, 0.7, 0.3, 1),
    pulse 1.6s ease-in-out 340ms infinite;
}

.b-status.queued {
  color: var(--faint);
}

.block .b-name {
  font-size: 17px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
}

.block .b-dur {
  margin-left: auto;
  flex: none;
}

.block .b-desc {
  color: var(--dim);
  font-size: 16px;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.block.running {
  border-color: var(--amber);
}

.block.running .b-name {
  color: var(--amber);
}

.block.fail {
  border-color: var(--fail);
}

.block.queued {
  background: transparent;
  border-style: dashed;
  color: var(--dim);
}

.block.selected {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.tool-tick {
  position: absolute;
  bottom: 4px;
  width: 3px;
  height: 9px;
  background: var(--faint);
  border-radius: 0;
}

.tool-tick.err {
  background: var(--fail);
}

/* On narrow glass the board pans instead of compressing — a wide board keeps
   its whole track width and the viewer scrolls it, like walking down the wall. */
@media (max-width: 980px) {
  .run-strip {
    padding: 12px 16px;
  }

  .waterfall {
    margin: 16px;
    overflow-x: auto;
  }

  .waterfall .row {
    min-width: 700px;
  }
}
</style>
