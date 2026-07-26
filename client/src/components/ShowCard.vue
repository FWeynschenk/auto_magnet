<template>
  <div class="card" :class="{ compact }">
    <img
      v-if="show.poster_url"
      :src="show.poster_url"
      class="poster clickable"
      alt=""
      loading="lazy"
      @click="$emit('manage', show)"
    />
    <div v-else class="poster poster-placeholder clickable" @click="$emit('manage', show)">📺</div>

    <div class="info">
      <button class="title-btn clickable" @click="$emit('manage', show)">
        <span class="title">{{ show.title }}</span>
      </button>
      <div class="meta">
        <span :class="show.active ? 'active' : 'paused'">{{ show.active ? 'Active' : 'Paused' }}</span>
        <span class="sep">·</span>
        <span>{{ show.quality }}</span>
        <span class="sep">·</span>
        <span>{{ show.mode }}</span>
        <template v-if="show.show_status">
          <span class="sep">·</span>
          <span :class="{ ended: isEnded }">{{ show.show_status }}</span>
        </template>
        <template v-if="downloadingCount > 0">
          <span class="sep">·</span>
          <span class="dl-count">{{ downloadingCount }} downloading</span>
        </template>
        <template v-if="compact && pendingCount > 0">
          <span class="sep">·</span>
          <span class="pending-count">{{ pendingCount }} pending</span>
        </template>
      </div>

      <EpisodeGrid v-if="!compact" :episodes="show.episodes" @select="onSelectEpisode" />

      <div v-if="nextAir" class="next-air">Next: {{ nextAir }}</div>

      <div v-if="pendingEpisode && show.mode === 'manual'" class="preview-hint">
        {{ pendingEpStr }} awaiting approval
      </div>
    </div>

    <div class="actions">
      <button
        v-if="show.mode === 'manual' && pendingEpisode"
        class="btn-primary btn-sm"
        @click="$emit('preview', show, pendingEpStr, pendingEpisode.id)"
      >Browse</button>
      <button class="btn-ghost btn-sm" @click="toggleActive">
        {{ show.active ? 'Pause' : 'Resume' }}
      </button>
      <button class="btn-ghost btn-sm" @click="toggleMode">
        {{ show.mode === 'auto' ? 'Set Manual' : 'Set Auto' }}
      </button>
      <button
        class="btn-danger btn-sm"
        :aria-label="`Remove ${show.title}`"
        @click="$emit('remove', show.id)"
      >{{ compact ? '✕' : 'Remove' }}</button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import EpisodeGrid from './EpisodeGrid.vue';

const props = defineProps({
  show:    Object,
  compact: { type: Boolean, default: false },
});
const emit = defineEmits(['remove', 'update', 'preview', 'manage']);

const pendingEpisode = computed(() =>
  (props.show.episodes || []).find(e => e.status === 'pending') || null
);

const pendingEpStr = computed(() => {
  const ep = pendingEpisode.value;
  if (!ep) return null;
  return `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
});

const downloadingCount = computed(() =>
  (props.show.episodes || []).filter(e => e.status === 'downloading').length
);
const pendingCount = computed(() =>
  (props.show.episodes || []).filter(e => e.status === 'pending').length
);

const isEnded = computed(() =>
  ['Ended', 'Canceled', 'Cancelled'].includes(props.show.show_status)
);

/** Soonest upcoming air date, formatted for display. */
const nextAir = computed(() => {
  const today = new Date().toISOString().slice(0, 10);
  const dates = (props.show.episodes || [])
    .filter(e => e.air_date && e.air_date >= today && e.status !== 'done')
    .sort((a, b) => (a.air_date < b.air_date ? -1 : 1));
  if (dates.length === 0) return null;
  const ep = dates[0];
  const label = `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
  const when = new Date(ep.air_date + 'T00:00:00')
    .toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${label} · ${when}`;
});

function onSelectEpisode() {
  emit('manage', props.show);
}
function toggleActive() {
  emit('update', props.show.id, { active: props.show.active ? 0 : 1 });
}
function toggleMode() {
  emit('update', props.show.id, { mode: props.show.mode === 'auto' ? 'manual' : 'auto' });
}
</script>

<style scoped>
.card {
  display: flex; gap: 14px;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 14px; align-items: flex-start;
  transition: border-color .2s;
}
.card:hover { border-color: var(--accent); }

.poster { width: 72px; height: 108px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
.poster-placeholder {
  display: flex; align-items: center; justify-content: center;
  background: var(--border); font-size: 28px;
}

.info { flex: 1; min-width: 0; }
.clickable { cursor: pointer; }

/* A real button so the title is keyboard reachable, styled to look like text */
.title-btn {
  background: none; border: none; padding: 0; text-align: left;
  color: inherit; font: inherit; display: block; width: 100%;
}
.title-btn:hover { opacity: 1; }
.title-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
.title { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }

.meta { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; margin-top: 4px; flex-wrap: wrap; }
.active        { color: var(--green);  font-weight: 600; }
.paused        { color: var(--yellow); font-weight: 600; }
.ended         { color: var(--muted);  font-style: italic; }
.sep           { color: var(--border); }
.dl-count      { color: var(--yellow); font-weight: 600; }
.pending-count { color: #93c5fd; font-weight: 600; }

.next-air     { margin-top: 6px; font-size: 11px; color: var(--muted); }
.preview-hint { margin-top: 8px; font-size: 12px; color: var(--yellow); }

.actions { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }

/* ── Compact / list row ── */
.card.compact { align-items: center; padding: 8px 12px; gap: 10px; }
.card.compact .poster { width: 32px; height: 48px; }
.card.compact .poster-placeholder { font-size: 16px; }
.card.compact .title { font-size: 14px; }
.card.compact .actions { flex-direction: row; align-items: center; }
.card.compact .next-air { display: none; }

@media (max-width: 560px) {
  .card { flex-wrap: wrap; }
  .actions { flex-direction: row; flex-wrap: wrap; width: 100%; }
}
</style>
