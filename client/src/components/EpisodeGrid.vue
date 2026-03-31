<template>
  <div class="episode-grid">
    <template v-for="season in seasons" :key="season.num">
      <div class="season-row">
        <span class="season-label">S{{ String(season.num).padStart(2, '0') }}</span>
        <div class="ep-bubbles">
          <span
            v-for="ep in season.episodes"
            :key="ep.episode"
            class="ep-bubble clickable"
            :class="ep.status"
            :title="`S${String(season.num).padStart(2,'0')}E${String(ep.episode).padStart(2,'0')} — ${ep.status}${ep.air_date ? ' · ' + ep.air_date : ''} · click to redo · shift+click to skip`"
            @click="handleClick(ep, $event)"
          >
            <template v-if="ep.status === 'downloading' && ep.progress > 0">
              {{ ep.progress }}
            </template>
            <template v-else>
              {{ String(ep.episode).padStart(2, '0') }}
            </template>
          </span>
        </div>
      </div>
    </template>
    <div v-if="seasons.length === 0" class="empty">No episodes yet</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({ episodes: Array });
const emit  = defineEmits(['redo-episode', 'skip-episode']);

const seasons = computed(() => {
  const map = {};
  for (const ep of (props.episodes || [])) {
    if (!map[ep.season]) map[ep.season] = [];
    map[ep.season].push(ep);
  }
  return Object.entries(map)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([num, episodes]) => ({ num: Number(num), episodes: episodes.sort((a, b) => a.episode - b.episode) }));
});

function handleClick(ep, event) {
  if (event.shiftKey) {
    emit('skip-episode', ep);
  } else {
    emit('redo-episode', ep);
  }
}
</script>

<style scoped>
.episode-grid { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }

.season-row { display: flex; align-items: center; gap: 8px; }

.season-label { font-size: 11px; font-weight: 700; color: var(--muted); width: 28px; flex-shrink: 0; }

.ep-bubbles { display: flex; flex-wrap: wrap; gap: 3px; }

.ep-bubble {
  width: 26px; height: 20px; border-radius: 4px;
  font-size: 10px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
  background: var(--border); color: var(--muted);
  cursor: default;
}
.ep-bubble.clickable  { cursor: pointer; }
.ep-bubble.clickable:hover { filter: brightness(1.4); }

.ep-bubble.done        { background: #14532d; color: #86efac; }
.ep-bubble.downloading { background: #92400e; color: #fde68a; }
.ep-bubble.pending     { background: #1e3a5f; color: #93c5fd; }
.ep-bubble.failed      { background: #7f1d1d; color: #fca5a5; }
.ep-bubble.skipped     { background: #1f2937; color: #6b7280; }

.empty { font-size: 12px; color: var(--muted); }
</style>
