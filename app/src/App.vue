<script setup lang="ts">
import { watchEffect } from 'vue'
import { useRoute, hrefFor, phaseCrumb } from './lib/router'
import SessionsList from './components/SessionsList.vue'
import SessionTrace from './components/SessionTrace.vue'

const route = useRoute()

// The artifact follows the route: the sessions list is the printed timetable
// (paper), a session's trace is the departure board. Components bind only to
// semantic tokens (--ground, --fg, --rule, --accent…), which style.css swaps
// on this class.
watchEffect(() => {
  document.body.classList.toggle('board', !!route.value.adwId)
})
</script>

<template>
  <div class="app">
    <header class="masthead">
      <nav class="crumbs">
        <!-- Inline copy of public/logo.svg (the favicon) so the mark renders
             crisply with no fetch; keep the two in sync. The accent strip and
             outline follow the active artifact. -->
        <svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
          <rect class="logo-plate" x="2.5" y="2.5" width="27" height="27" rx="2" />
          <rect class="logo-strip" x="7" y="8" width="18" height="4" />
          <rect class="logo-strip logo-accent" x="7" y="14" width="18" height="4" />
          <rect class="logo-strip" x="7" y="20" width="18" height="4" />
        </svg>
        <a class="brand" :href="hrefFor()">Super Portable Software Factory</a>
        <template v-if="route.adwId">
          <span class="sep">›</span>
          <a class="crumb-id" :href="hrefFor(route.adwId)" :class="{ current: !route.phaseId }">{{
            route.adwId
          }}</a>
        </template>
        <template v-if="route.adwId && route.phaseId">
          <span class="sep">›</span>
          <span class="current">{{ phaseCrumb ?? route.phaseId }}</span>
        </template>
      </nav>
      <span class="live-hint"><span class="live-marker" /> live</span>
    </header>
    <main>
      <SessionsList v-if="!route.adwId" />
      <SessionTrace v-else :key="route.adwId" :adw-id="route.adwId" :phase-id="route.phaseId" />
    </main>
  </div>
</template>

<style scoped>
.masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 28px 14px;
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--ground);
}

/* The printed masthead rule: thick-and-thin double line under the wordmark.
   On the board the header takes the board's single hairline instead. */
.masthead::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  border-bottom: 4px double var(--ink);
}

body.board .masthead::after {
  border-bottom: 1px solid var(--rule);
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 17px;
  flex: 1 1 0;
  min-width: 0;
}

.logo {
  width: 26px;
  height: 26px;
  flex: none;
}

.logo-plate {
  fill: var(--face);
  stroke: var(--fg);
  stroke-width: 1.5;
}

.logo-strip {
  fill: var(--fg);
}

.logo-accent {
  fill: var(--accent);
}

.brand {
  color: var(--fg);
  font-weight: 700;
  letter-spacing: 0.02em;
  white-space: nowrap;
  text-decoration: none;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sep {
  color: var(--faint);
  flex: none;
}

.crumbs a {
  color: var(--dim);
}

.crumbs a:hover {
  color: var(--fg);
}

.crumb-id {
  font-family: var(--mono);
  font-size: 16px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crumbs .current {
  color: var(--fg);
}

.live-hint {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--mono);
  font-size: 16px;
  color: var(--live);
  white-space: nowrap;
}

/* Paper annotates live state in ballpoint, and it stays still. The board
   blinks — that is what boards do. */
.live-marker {
  width: 9px;
  height: 9px;
  background: var(--live);
}

body.board .live-marker {
  border-radius: 50%;
  animation: pulse 1.8s ease-in-out infinite;
}

@media (max-width: 980px) {
  .masthead {
    padding: 14px 16px 12px;
  }
}
</style>
