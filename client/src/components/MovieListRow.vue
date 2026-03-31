<template>
  <div class="row">
    <span class="status-dot" :class="statusClass" :title="movie.status" />

    <div class="title-col">
      <span class="title">{{ movie.title }}</span>
      <span class="year">{{ movie.year }}</span>
    </div>

    <span class="badge quality">{{ movie.quality }}</span>
    <span class="badge" :class="statusClass">{{ movie.status }}</span>

    <div v-if="movie.status === 'downloading'" class="progress-wrap">
      <div class="progress-bar">
        <div class="progress-fill" :style="{ width: (movie.progress || 0) + '%' }" />
      </div>
      <span class="pct">{{ movie.progress || 0 }}%</span>
    </div>
    <div v-else class="progress-wrap" />

    <div class="actions">
      <button
        v-if="movie.mode === 'manual' && movie.status === 'pending'"
        class="btn-primary btn-sm"
        @click="$emit('preview', movie)"
      >Browse</button>
      <button
        v-if="movie.status === 'done' || movie.status === 'downloading' || movie.status === 'failed' || (movie.mode === 'auto' && movie.status === 'pending')"
        class="btn-ghost btn-sm"
        @click="$emit('redo', movie)"
      >Redo</button>
      <button class="btn-danger btn-sm" @click="$emit('remove', movie.id)">✕</button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({ movie: Object });
defineEmits(['remove', 'update', 'preview', 'redo']);

const statusClass = computed(() => ({
  pending:     'status-pending',
  searching:   'status-searching',
  downloading: 'status-downloading',
  done:        'status-done',
  failed:      'status-failed',
}[props.movie.status] || 'status-pending'));
</script>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 9px 12px;
  transition: border-color .15s;
}
.row:hover { border-color: var(--accent); }

.status-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.status-dot.status-pending     { background: var(--muted); }
.status-dot.status-downloading { background: var(--yellow); }
.status-dot.status-done        { background: var(--green); }
.status-dot.status-failed      { background: var(--red); }

.title-col { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; overflow: hidden; }
.title { font-weight: 500; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.year  { color: var(--muted); font-size: 12px; flex-shrink: 0; }

.badge {
  padding: 1px 7px; border-radius: 99px; font-size: 11px;
  font-weight: 600; text-transform: uppercase; white-space: nowrap;
  background: var(--border); color: var(--muted);
}
.status-pending     { background: #374151; color: var(--muted); }
.status-downloading { background: #92400e; color: #fef3c7; }
.status-done        { background: #14532d; color: #bbf7d0; }
.status-failed      { background: #7f1d1d; color: #fecaca; }
.quality { background: #1e1b4b; color: var(--accent-h); }

.progress-wrap { display: flex; align-items: center; gap: 5px; width: 120px; flex-shrink: 0; }
.progress-bar  { flex: 1; height: 4px; background: var(--border); border-radius: 99px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 99px; transition: width .5s; }
.pct { font-size: 11px; color: var(--muted); width: 28px; }

.actions { display: flex; gap: 5px; flex-shrink: 0; }
</style>
