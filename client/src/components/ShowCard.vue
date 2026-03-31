<template>
  <div class="card">
    <img v-if="show.poster_url" :src="show.poster_url" class="poster" alt="" />
    <div v-else class="poster poster-placeholder">📺</div>

    <div class="info">
      <div class="title">{{ show.title }}</div>
      <div class="meta">
        <span :class="show.active ? 'active' : 'paused'">{{ show.active ? 'Active' : 'Paused' }}</span>
        <span class="sep">·</span>
        <span>{{ show.quality }}</span>
        <span class="sep">·</span>
        <span>{{ show.mode }}</span>
      </div>

      <EpisodeGrid :episodes="show.episodes" @redo-episode="ep => $emit('redo-episode', show, ep)" />

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
      <button
        class="btn-ghost btn-sm"
        @click="toggleMode"
      >{{ show.mode === 'auto' ? 'Set Manual' : 'Set Auto' }}</button>
      <button class="btn-danger btn-sm" @click="$emit('remove', show.id)">Remove</button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import EpisodeGrid from './EpisodeGrid.vue';

const props = defineProps({ show: Object });
const emit  = defineEmits(['remove', 'update', 'preview', 'redo-episode']);

const pendingEpisode = computed(() => {
  return (props.show.episodes || []).find(e => e.status === 'pending') || null;
});

const pendingEpStr = computed(() => {
  if (!pendingEpisode.value) return null;
  const ep = pendingEpisode.value;
  return `S${String(ep.season).padStart(2, '0')}E${String(ep.episode).padStart(2, '0')}`;
});

function toggleActive() {
  emit('update', props.show.id, { active: props.show.active ? 0 : 1 });
}
function toggleMode() {
  emit('update', props.show.id, { mode: props.show.mode === 'auto' ? 'manual' : 'auto' });
}
</script>

<style scoped>
.card {
  display: flex;
  gap: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  align-items: flex-start;
  transition: border-color .2s;
}
.card:hover { border-color: var(--accent); }

.poster {
  width: 72px;
  height: 108px;
  object-fit: cover;
  border-radius: 4px;
  flex-shrink: 0;
}
.poster-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--border);
  font-size: 28px;
}

.info { flex: 1; min-width: 0; }
.title { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.meta { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; margin-top: 4px; }
.active { color: var(--green); font-weight: 600; }
.paused { color: var(--yellow); font-weight: 600; }
.sep    { color: var(--border); }

.preview-hint { margin-top: 8px; font-size: 12px; color: var(--yellow); }

.actions { display: flex; flex-direction: column; gap: 6px; }
</style>
