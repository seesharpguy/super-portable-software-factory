import { ref } from 'vue'

interface ConfirmRequest {
  /** Stable identity so a click can be matched to the request it was rendered
   * for, even after a second request has replaced `pendingConfirm`. */
  id: number
  message: string
  resolve: (ok: boolean) => void
}

export type { ConfirmRequest }

/** Single-slot broker: WebMcpConfirm.vue renders whatever is pending here. */
export const pendingConfirm = ref<ConfirmRequest | null>(null)

let nextId = 0

/** An unanswered confirmation auto-dismisses after this long — a stale prompt
 * must not sit forever waiting for a click that may no longer matter. */
const CONFIRM_TIMEOUT_MS = 60_000

type ConfirmReason = 'timeout' | 'aborted'

/**
 * Ask the user to confirm a write action triggered by a WebMCP tool. Only one
 * confirmation is ever live — a second request cancels the first (rather than
 * queuing behind it) so nothing can hang forever waiting on a stale prompt.
 *
 * `signal`, when given, is the abort signal from the tool call's execute
 * context: if the agent's call is already abandoned (client timeout, retry,
 * navigation) the confirmation resolves false immediately, or as soon as the
 * signal aborts while pending — otherwise a real action could still fire for
 * a caller nobody is waiting on anymore.
 */
export function requestConfirm(
  message: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; reason?: ConfirmReason }> {
  pendingConfirm.value?.resolve(false)

  if (signal?.aborted) return Promise.resolve({ ok: false, reason: 'aborted' })

  return new Promise((resolve) => {
    let req: ConfirmRequest
    const settle = (ok: boolean, reason?: ConfirmReason) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // Another request may already have replaced ours (superseded) — only
      // clear the slot if it's still pointing at this request.
      if (pendingConfirm.value === req) pendingConfirm.value = null
      resolve({ ok, reason })
    }
    const onAbort = () => settle(false, 'aborted')
    const timer = setTimeout(() => settle(false, 'timeout'), CONFIRM_TIMEOUT_MS)
    req = { id: ++nextId, message, resolve: (ok) => settle(ok) }
    signal?.addEventListener('abort', onAbort)
    pendingConfirm.value = req
  })
}
