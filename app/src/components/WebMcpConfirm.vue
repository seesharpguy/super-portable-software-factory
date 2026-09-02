<script setup lang="ts">
import type { ConfirmRequest } from '../lib/webmcp-confirm'
import { pendingConfirm } from '../lib/webmcp-confirm'

// `req` below is bound by v-for at render time — a plain snapshot, not a live
// read through the ref — so a click always resolves the request the user was
// actually looking at, even if a second request has already replaced
// `pendingConfirm` by the time the click handler runs. Guard against
// resolving a request that's already been superseded or auto-dismissed.
function respond(req: ConfirmRequest, ok: boolean): void {
  if (pendingConfirm.value !== req) return
  req.resolve(ok)
}
</script>

<template>
  <div
    v-for="req in pendingConfirm ? [pendingConfirm] : []"
    :key="req.id"
    class="webmcp-confirm"
    role="alertdialog"
    aria-live="assertive"
  >
    <span class="wc-label">agent request</span>
    <p class="wc-message">{{ req.message }}</p>
    <div class="wc-actions">
      <button class="wc-btn" type="button" @click="respond(req, false)">cancel</button>
      <button class="wc-btn wc-confirm" type="button" @click="respond(req, true)">confirm</button>
    </div>
  </div>
</template>

<style scoped>
/* Same material as the rest of the board/paper: hairline frame, face fill,
   the surface's own accent for the one thing that needs attention — no
   scrim, no centered gray modal. */
.webmcp-confirm {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 1000;
  width: min(360px, calc(100vw - 40px));
  padding: 14px 16px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--face);
}

.wc-label {
  display: block;
  margin-bottom: 8px;
  font-family: var(--mono);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--accent);
}

.wc-message {
  margin: 0 0 14px;
  color: var(--fg);
  font-size: 16px;
  overflow-wrap: anywhere;
}

.wc-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.wc-btn {
  padding: 5px 14px;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: none;
  color: var(--dim);
  font-family: var(--mono);
  font-size: 16px;
  cursor: pointer;
}

.wc-btn:hover,
.wc-btn:focus-visible {
  color: var(--fg);
  border-color: var(--dim);
}

.wc-confirm {
  color: var(--fg);
  border-color: var(--accent);
}

.wc-confirm:hover,
.wc-confirm:focus-visible {
  color: var(--accent);
  border-color: var(--accent);
}

@media (max-width: 980px) {
  .webmcp-confirm {
    right: 12px;
    bottom: 12px;
    left: 12px;
    width: auto;
  }
}
</style>
