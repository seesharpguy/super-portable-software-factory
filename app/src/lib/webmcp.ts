// Exposes this app's read-only data — and its one write action — as WebMCP
// tools, so an agent driving the browser can query a live run without
// scraping the DOM. Mirrors the components' own data layer (api.ts) rather
// than duplicating fetch logic. See developer.chrome.com/docs/ai/webmcp.
import type { Envelope, EventRow, GateResult, Phase, SessionStatus, SessionSummary } from './types'
import type { ModelContextApi, ModelContextTool } from './webmcp-global'
import {
  archiveSession,
  fetchEnvelopes,
  fetchEvents,
  fetchGates,
  fetchSession,
  fetchSessions,
} from './api'
import { ts } from './format'
import { requestConfirm } from './webmcp-confirm'

const STATUSES: SessionStatus[] = ['running', 'success', 'fail']

// Upper bound on events collected by get_phase_detail — a pathological phase
// (or a session pointed at by mistake) shouldn't pull the whole event log
// into one tool response.
const MAX_PHASE_EVENTS = 5000

function errorJson(err: unknown): string {
  return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
}

/** Compact row for list_sessions — full phase/agent detail is get_session_trace's job. */
function summarizeSession(s: SessionSummary) {
  const phases = s.phases ?? []
  const done = phases.filter((p) => p.status === 'success').length
  return {
    adw_id: s.adw_id,
    adw_name: s.adw_name,
    request: s.request,
    status: s.status,
    started_at: s.started_at,
    ended_at: s.ended_at,
    total_cost: s.total_cost,
    total_tokens: s.total_tokens,
    phases: `${done}/${phases.length}`,
  }
}

/** Fields useful for deciding what to look at next — drops nothing cheap, invents nothing. */
function trimPhase(p: Phase) {
  return {
    phase_id: p.phase_id,
    name: p.name,
    kind: p.kind,
    owner: p.owner,
    status: p.status,
    started_at: p.started_at,
    ended_at: p.ended_at,
    error: p.error,
  }
}

/**
 * Resolves `phase_name` to one Phase. phase_id is unique by construction, so
 * it's tried first; a `name` is not unique — chains run back-to-back in one
 * session can produce several phases with the same name — so a name match
 * only auto-resolves when exactly one phase has it. Multiple matches return
 * an error listing candidates so the caller can retry with a phase_id.
 */
function resolvePhase(
  phases: Phase[],
  phaseName: string,
  adwId: string,
): { ok: true; phase: Phase } | { ok: false; error: string } {
  const byId = phases.find((p) => p.phase_id === phaseName)
  if (byId) return { ok: true, phase: byId }

  const byName = phases.filter((p) => p.name === phaseName)
  if (byName.length === 1) return { ok: true, phase: byName[0] }
  if (byName.length > 1) {
    return {
      ok: false,
      error: JSON.stringify({
        error: `ambiguous phase name '${phaseName}' in session ${adwId} — ${byName.length} phases match`,
        candidates: byName.map((p) => ({ phase_id: p.phase_id, seq: p.seq, status: p.status })),
      }),
    }
  }
  return { ok: false, error: JSON.stringify({ error: `no phase named ${phaseName} in session ${adwId}` }) }
}

/** One failed registration (bad shape, duplicate name, an unshipped API
 * changing under us) must not stop the rest from registering, and must never
 * surface as an unhandled promise rejection. */
async function safeRegisterTool(modelContext: ModelContextApi, tool: ModelContextTool): Promise<void> {
  try {
    await modelContext.registerTool(tool)
  } catch (err) {
    console.debug('[webmcp] failed to register tool', tool.name, err)
  }
}

/**
 * Registers this app's WebMCP tools. A no-op (silently) outside browsers that
 * expose a working `document.modelContext` — every other browser's behavior
 * is unchanged. Call once, from main.ts right after mount.
 */
export async function registerWebMcpTools(): Promise<void> {
  const modelContext = document.modelContext
  // Feature-detect the actual method, not just the namespace object — this is
  // an unshipped, still-changing browser API and the shape may drift.
  if (!modelContext || typeof modelContext.registerTool !== 'function') return

  await safeRegisterTool(modelContext, {
    name: 'list_sessions',
    description: 'List ADW run sessions, optionally filtered by status, chain name, or start time.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: STATUSES, description: 'Keep only sessions with this status.' },
        chain: { type: 'string', description: 'Substring match against the chain name (adw_name).' },
        since: {
          type: 'string',
          description: 'ISO-8601 timestamp; keep sessions started at or after this.',
        },
      },
      required: [],
    },
    annotations: { readOnlyHint: true },
    execute: async (inputs) => {
      try {
        let status: SessionStatus | null = null
        if (typeof inputs.status === 'string') {
          if (!STATUSES.includes(inputs.status as SessionStatus)) {
            return JSON.stringify({ error: `status must be one of ${STATUSES.join(', ')}` })
          }
          status = inputs.status as SessionStatus
        }
        const chain = typeof inputs.chain === 'string' ? inputs.chain.toLowerCase() : null
        let sinceMs: number | null = null
        if (typeof inputs.since === 'string') {
          sinceMs = ts(inputs.since)
          if (!Number.isFinite(sinceMs)) {
            return JSON.stringify({ error: 'since must be a parseable date/timestamp' })
          }
        }
        const sessions = await fetchSessions()
        const filtered = sessions.filter((s) => {
          if (status && s.status !== status) return false
          if (chain && !(s.adw_name ?? '').toLowerCase().includes(chain)) return false
          if (sinceMs != null && (!Number.isFinite(ts(s.started_at)) || ts(s.started_at) < sinceMs)) {
            return false
          }
          return true
        })
        return JSON.stringify(filtered.map(summarizeSession))
      } catch (err) {
        return errorJson(err)
      }
    },
  })

  await safeRegisterTool(modelContext, {
    name: 'get_session_trace',
    description: 'Get one session with its phases, agents, and token/cost usage.',
    inputSchema: {
      type: 'object',
      properties: { adw_id: { type: 'string', description: 'The session id (adw_id).' } },
      required: ['adw_id'],
    },
    annotations: { readOnlyHint: true },
    execute: async (inputs) => {
      const adwId = typeof inputs.adw_id === 'string' ? inputs.adw_id : ''
      try {
        const detail = await fetchSession(adwId)
        return JSON.stringify({
          session: detail.session,
          phases: detail.phases.map(trimPhase),
          agents: detail.agents,
          usage: detail.usage,
        })
      } catch (err) {
        return errorJson(err)
      }
    },
  })

  await safeRegisterTool(modelContext, {
    name: 'get_phase_detail',
    description:
      'Get one phase from a session (matched by phase_id, falling back to name if unambiguous), with its events, output envelopes, and gate results.',
    inputSchema: {
      type: 'object',
      properties: {
        adw_id: { type: 'string', description: 'The session id (adw_id).' },
        phase_name: {
          type: 'string',
          description: 'A phase_id, or a phase name if exactly one phase in the session has it.',
        },
      },
      required: ['adw_id', 'phase_name'],
    },
    annotations: { readOnlyHint: true },
    execute: async (inputs) => {
      const adwId = typeof inputs.adw_id === 'string' ? inputs.adw_id : ''
      const phaseName = typeof inputs.phase_name === 'string' ? inputs.phase_name : ''
      try {
        const detail = await fetchSession(adwId)
        const resolved = resolvePhase(detail.phases, phaseName, adwId)
        if (!resolved.ok) return resolved.error
        const phase = resolved.phase

        // Cursor pagination is inherently sequential — same do/while as SessionTrace.vue's tick().
        const events: EventRow[] = []
        let cursor = 0
        let page
        let truncated = false
        do {
          // oxlint-disable-next-line no-await-in-loop
          page = await fetchEvents(adwId, cursor, 1000)
          cursor = Math.max(cursor, page.cursor)
          events.push(...page.events)
          if (events.length >= MAX_PHASE_EVENTS) {
            truncated = page.has_more
            break
          }
        } while (page.has_more)

        const [envelopes, gates]: [Envelope[], GateResult[]] = await Promise.all([
          fetchEnvelopes(adwId),
          fetchGates(adwId),
        ])

        return JSON.stringify({
          phase: trimPhase(phase),
          truncated,
          events: events
            .filter((e) => e.phase_id === phase.phase_id)
            .toSorted((a, b) => a.rowid - b.rowid),
          envelopes: envelopes
            .filter((e) => e.phase_id === phase.phase_id)
            .toSorted((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0)),
          gates: gates
            .filter((g) => g.phase_id === phase.phase_id)
            .toSorted((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0) || a.id - b.id),
        })
      } catch (err) {
        return errorJson(err)
      }
    },
  })

  await safeRegisterTool(modelContext, {
    name: 'archive_session',
    description: 'Archive a session, removing it from the review list. Asks the user to confirm first.',
    inputSchema: {
      type: 'object',
      properties: { adw_id: { type: 'string', description: 'The session id (adw_id) to archive.' } },
      required: ['adw_id'],
    },
    annotations: { readOnlyHint: false },
    execute: async (inputs, { signal }) => {
      const adwId = typeof inputs.adw_id === 'string' ? inputs.adw_id : ''
      const { ok, reason } = await requestConfirm(
        `Archive session ${adwId}? This removes it from the review list.`,
        signal,
      )
      if (!ok) {
        const error = reason === 'timeout' ? 'confirmation timed out' : 'cancelled by user'
        return JSON.stringify({ error })
      }
      try {
        await archiveSession(adwId)
        return JSON.stringify({ ok: true })
      } catch (err) {
        return errorJson(err)
      }
    },
  })
}
