<template>
  <div class="timeline-wrap">
    <div class="timeline-header">
      <span class="timeline-title">📅 Release Timeline</span>
      <button class="toggle-btn" :aria-expanded="String(!collapsed)" @click="toggle">
        {{ collapsed ? 'Show' : 'Hide' }}
      </button>
    </div>

    <div v-if="!collapsed" class="timeline-scroll" ref="scrollEl">
      <div v-if="loading" class="tl-empty">Loading…</div>
      <div v-else-if="groups.length === 0" class="tl-empty">No releases in the past 30 days or next 60 days</div>

      <div v-for="group in groups" :key="group.date" class="day-col">
        <div class="day-label" :class="{ today: group.isToday, past: group.isPast }">
          {{ group.label }}
        </div>
        <div class="day-items">
          <div
            v-for="item in group.items"
            :key="item.type + item.id"
            class="tl-item"
            :class="[item.status, item.type]"
            :title="`${item.title} ${item.subtitle ? '· ' + item.subtitle : ''} — ${item.status}`"
          >
            <img v-if="item.poster_url" :src="item.poster_url" class="tl-poster" alt="" />
            <div v-else class="tl-poster tl-poster-ph">{{ item.type === 'movie' ? '🎬' : '📺' }}</div>
            <div class="tl-info">
              <div class="tl-name">{{ item.title }}</div>
              <div class="tl-sub">{{ item.subtitle }}</div>
              <span class="tl-status" :class="item.status">{{ item.status }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue';
import { timeline as api } from '../api.js';
import { usePolling } from '../composables/usePolling.js';

const items     = ref([]);
const loading   = ref(true);
// Persisted like the grid/list preference, so it survives a reload
const collapsed = ref(localStorage.getItem('timeline_collapsed') === '1');
const scrollEl  = ref(null);

function toggle() {
  collapsed.value = !collapsed.value;
  localStorage.setItem('timeline_collapsed', collapsed.value ? '1' : '0');
}

async function load() {
  try { items.value = await api.get(); } catch (_) {}
  loading.value = false;
  // Scroll so "Today" is visible (with a little past context on the left)
  await nextTick();
  const todayEl = scrollEl.value?.querySelector('.day-label.today');
  if (todayEl) {
    const col = todayEl.closest('.day-col');
    if (col) col.scrollIntoView({ inline: 'center', behavior: 'smooth' });
  }
}

const today = new Date().toISOString().slice(0, 10);

const groups = computed(() => {
  const map = {};
  for (const item of items.value) {
    if (!map[item.date]) map[item.date] = [];
    map[item.date].push(item);
  }
  return Object.entries(map)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, dayItems]) => {
      const d       = new Date(date + 'T00:00:00');
      const isToday = date === today;
      const isPast  = date < today;
      const label   = isToday
        ? 'Today'
        : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      return { date, label, isToday, isPast, items: dayItems };
    });
});

usePolling(load, 5 * 60 * 1000);
onMounted(load);
</script>

<style scoped>
.timeline-wrap {
  background: var(--surface);
  border-top: 1px solid var(--border);
  padding: 0 24px;
}

.timeline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
}
.timeline-title { font-size: 13px; font-weight: 600; color: var(--muted); }
.toggle-btn {
  background: none; border: none;
  color: var(--muted); font-size: 12px; padding: 2px 8px;
  cursor: pointer;
}
.toggle-btn:hover { color: var(--text); }

.timeline-scroll {
  display: flex;
  gap: 0;
  overflow-x: auto;
  padding-bottom: 12px;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

.tl-empty { color: var(--muted); font-size: 13px; padding: 12px 0; }

.day-col {
  flex-shrink: 0;
  min-width: 110px;
  border-right: 1px solid var(--border);
  padding: 0 10px 0 0;
  margin-right: 10px;
}
.day-col:last-child { border-right: none; }

.day-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: .5px;
  margin-bottom: 6px;
  padding-bottom: 4px;
  border-bottom: 2px solid var(--border);
}
.day-label.today { color: var(--accent); border-color: var(--accent); }
.day-label.past  { opacity: .5; }

.day-items { display: flex; flex-direction: column; gap: 5px; }

.tl-item {
  display: flex;
  gap: 6px;
  padding: 5px;
  border-radius: 6px;
  background: var(--bg);
  opacity: 1;
  transition: opacity .15s;
}
.tl-item:hover { opacity: .85; }
.tl-item.done    { opacity: .45; }
.tl-item.skipped { opacity: .3; }

.tl-poster {
  width: 30px; height: 44px;
  object-fit: cover; border-radius: 3px; flex-shrink: 0;
}
.tl-poster-ph {
  display: flex; align-items: center; justify-content: center;
  background: var(--border); font-size: 14px;
}

.tl-info { min-width: 0; }
.tl-name { font-size: 11px; font-weight: 600; line-height: 1.2; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 64px; }
.tl-sub  { font-size: 10px; color: var(--muted); margin-top: 1px; }

.tl-status {
  display: inline-block;
  margin-top: 3px;
  padding: 1px 5px;
  border-radius: 99px;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  background: var(--border);
  color: var(--muted);
}
.tl-status.downloading { background: #92400e; color: #fef3c7; }
.tl-status.done        { background: #14532d; color: #bbf7d0; }
.tl-status.failed      { background: #7f1d1d; color: #fecaca; }
.tl-status.pending     { background: #1e3a5f; color: #93c5fd; }
</style>
