<template>
  <div class="card">
    <img v-if="movie.poster_url" :src="movie.poster_url" class="poster" alt="" />
    <div v-else class="poster poster-placeholder">🎬</div>

    <div class="info">
      <div class="title">{{ movie.title }}</div>
      <div class="meta">{{ movie.year }}</div>

      <div class="badges">
        <span class="badge" :class="statusClass">{{ movie.status }}</span>
        <span class="badge quality">{{ movie.quality }}</span>
        <span class="badge mode">{{ movie.mode }}</span>
      </div>

      <div v-if="movie.status === 'pending' && movie.mode === 'manual'" class="preview-hint">
        Awaiting approval
      </div>
    </div>

    <div class="actions">
      <button
        v-if="movie.mode === 'manual' && (movie.status === 'pending' || movie.status === 'failed')"
        class="btn-primary btn-sm"
        @click="$emit('preview', movie)"
      >Browse</button>
      <button
        class="btn-ghost btn-sm"
        @click="toggleMode"
      >{{ movie.mode === 'auto' ? 'Set Manual' : 'Set Auto' }}</button>
      <button class="btn-danger btn-sm" @click="$emit('remove', movie.id)">Remove</button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({ movie: Object });
const emit  = defineEmits(['remove', 'update', 'preview']);

const statusClass = computed(() => ({
  pending:     'status-pending',
  searching:   'status-searching',
  downloading: 'status-downloading',
  done:        'status-done',
  failed:      'status-failed',
}[props.movie.status] || 'status-pending'));

function toggleMode() {
  emit('update', props.movie.id, { mode: props.movie.mode === 'auto' ? 'manual' : 'auto' });
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
.meta  { color: var(--muted); font-size: 12px; margin-top: 2px; }

.badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.badge {
  padding: 2px 8px;
  border-radius: 99px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .4px;
  background: var(--border);
  color: var(--muted);
}
.status-pending     { background: #374151; color: var(--muted); }
.status-searching   { background: #1d4ed8; color: #fff; }
.status-downloading { background: #92400e; color: #fef3c7; }
.status-done        { background: #14532d; color: #bbf7d0; }
.status-failed      { background: #7f1d1d; color: #fecaca; }
.quality { background: #1e1b4b; color: var(--accent-h); }
.mode    { background: #0c4a6e; color: #7dd3fc; }

.preview-hint { margin-top: 6px; font-size: 12px; color: var(--yellow); }

.actions { display: flex; flex-direction: column; gap: 6px; }
</style>
