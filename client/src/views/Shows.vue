<template>
  <div>
    <div class="view-header">
      <h1>Shows</h1>
      <div class="header-actions">
        <button
          v-if="hasFailed"
          class="btn-ghost btn-sm"
          :disabled="retrying"
          @click="retryFailed"
        >{{ retrying ? 'Retrying…' : '↺ Retry Failed' }}</button>
        <div class="filter-btns">
          <button class="btn-ghost btn-sm" :class="{ active: filterActive === '' }" @click="filterActive = ''">All</button>
          <button class="btn-ghost btn-sm" :class="{ active: filterActive === '1' }" @click="filterActive = '1'">Active</button>
          <button class="btn-ghost btn-sm" :class="{ active: filterActive === '0' }" @click="filterActive = '0'">Paused</button>
        </div>
        <button class="btn-primary" @click="showAdd = true">+ Add Show</button>
      </div>
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>

    <div v-else-if="displayList.length === 0" class="empty-state">
      <div class="empty-icon">📺</div>
      <p>{{ list.length === 0 ? 'No shows yet. Add one to get started.' : 'No shows match the current filter.' }}</p>
    </div>

    <div v-else class="cards-grid">
      <ShowCard
        v-for="s in displayList"
        :key="s.id"
        :show="s"
        @remove="remove"
        @update="update"
        @preview="openPreview"
        @redo-episode="redoEpisode"
        @skip-episode="skipEpisode"
        @stats="statsItem = $event"
      />
    </div>

    <AddDialog
      v-if="showAdd"
      type="tv"
      @close="showAdd = false"
      @added="onAdded"
    />

    <PreviewDialog
      v-if="previewItem"
      :item="previewItem.show"
      :season="previewItem.season"
      :episode="previewItem.episode"
      :episode-id="previewItem.episode_id || null"
      @close="previewItem = null"
      @grabbed="reload"
    />

    <StatsDialog
      v-if="statsItem"
      :item="statsItem"
      @close="statsItem = null"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { shows as api } from '../api.js';
import ShowCard    from '../components/ShowCard.vue';
import AddDialog   from '../components/AddDialog.vue';
import PreviewDialog from '../components/PreviewDialog.vue';
import StatsDialog  from '../components/StatsDialog.vue';

const list         = ref([]);
const loading      = ref(true);
const showAdd      = ref(false);
const previewItem  = ref(null);
const statsItem    = ref(null);
const filterActive = ref('');
const retrying     = ref(false);
let pollTimer      = null;
let initialDone    = false;

const hasFailed = computed(() =>
  list.value.some(s => (s.episodes || []).some(e => e.status === 'failed'))
);

const displayList = computed(() => {
  if (filterActive.value === '') return list.value;
  const val = filterActive.value === '1' ? 1 : 0;
  return list.value.filter(s => s.active === val);
});

async function reload() {
  loading.value = true;
  try { list.value = await api.list(); } finally { loading.value = false; initialDone = true; }
}

async function silentReload() {
  try {
    // Build a flat map of episode statuses for notification diff
    const prev = new Map();
    for (const s of list.value) {
      for (const e of (s.episodes || [])) prev.set(e.id, e.status);
    }

    list.value = await api.list();

    if (initialDone && 'Notification' in window && Notification.permission === 'granted') {
      for (const s of list.value) {
        for (const e of (s.episodes || [])) {
          if (e.status === 'done' && prev.get(e.id) === 'downloading') {
            const epStr = `S${String(e.season).padStart(2,'0')}E${String(e.episode).padStart(2,'0')}`;
            new Notification('Episode downloaded', { body: `${s.title} ${epStr}`, icon: s.poster_url || undefined });
          }
        }
      }
    }
  } catch (_) {}
}

async function remove(id) {
  await api.remove(id);
  list.value = list.value.filter(s => s.id !== id);
}

async function update(id, data) {
  const updated = await api.update(id, data);
  const idx = list.value.findIndex(s => s.id === id);
  if (idx !== -1) list.value[idx] = updated;
}

function onAdded(show) { list.value.unshift(show); }

function openPreview(show, epStr, episodeId) {
  const match = epStr?.match(/S(\d+)E(\d+)/i);
  previewItem.value = {
    show:       { ...show, type: 'tv' },
    season:     match ? parseInt(match[1]) : null,
    episode:    match ? parseInt(match[2]) : null,
    episode_id: episodeId || null,
  };
}

async function redoEpisode(show, episode) {
  await api.redoEpisode(show.id, episode.id);
  list.value = await api.list();
  previewItem.value = {
    show:       { ...show, type: 'tv' },
    season:     episode.season,
    episode:    episode.episode,
    episode_id: episode.id,
  };
}

async function skipEpisode(show, episode) {
  await api.skipEpisode(show.id, episode.id);
  await silentReload();
}

async function retryFailed() {
  retrying.value = true;
  try { await api.retryFailed(); await silentReload(); } finally { retrying.value = false; }
}

onMounted(() => {
  reload();
  pollTimer = setInterval(silentReload, 30000);
});
onUnmounted(() => clearInterval(pollTimer));
</script>

<style scoped>
.view-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 20px; gap: 12px; flex-wrap: wrap;
}
h1 { font-size: 22px; font-weight: 700; }

.header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.filter-btns { display: flex; gap: 4px; }
.filter-btns .btn-ghost { padding: 4px 10px; }
.filter-btns .btn-ghost.active { border-color: var(--accent); color: var(--accent); }

.state-msg { color: var(--muted); padding: 40px 0; text-align: center; }

.empty-state { text-align: center; padding: 60px 0; color: var(--muted); }
.empty-icon  { font-size: 48px; margin-bottom: 12px; }

.cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(480px, 1fr));
  gap: 12px;
}
</style>
