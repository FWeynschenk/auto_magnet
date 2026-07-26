<template>
  <div>
    <div class="view-header">
      <h1>Shows</h1>
      <div class="header-actions">
        <input
          v-model="search"
          type="search"
          class="ctrl-search"
          placeholder="Filter shows…"
          aria-label="Filter shows by title"
        />
        <button
          v-if="hasFailed"
          class="btn-ghost btn-sm"
          :disabled="retrying"
          @click="retryFailed"
        >{{ retrying ? 'Retrying…' : '↺ Retry Failed' }}</button>
        <select v-model="sortBy" class="ctrl-select" aria-label="Sort shows">
          <option value="added">Recently added</option>
          <option value="title">Title</option>
          <option value="next">Next airing</option>
          <option value="pending">Pending count</option>
        </select>
        <select v-model="filterState" class="ctrl-select" aria-label="Filter shows by state">
          <option value="">All shows</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="downloading">Downloading</option>
          <option value="pending">Has pending</option>
          <option value="failed">Has failed</option>
          <option value="caughtup">Caught up</option>
        </select>
        <button
          class="btn-ghost btn-sm icon-btn"
          :aria-label="viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'"
          :title="viewMode === 'grid' ? 'Switch to list' : 'Switch to grid'"
          @click="toggleView"
        >{{ viewMode === 'grid' ? '☰' : '⊞' }}</button>
        <button class="btn-primary" @click="showAdd = true">+ Add Show</button>
      </div>
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>

    <div v-else-if="displayList.length === 0" class="empty-state">
      <div class="empty-icon">📺</div>
      <p>{{ list.length === 0 ? 'No shows yet. Add one to get started.' : 'No shows match the current filter.' }}</p>
    </div>

    <div v-else :class="viewMode === 'grid' ? 'cards-grid' : 'list-view'">
      <ShowCard
        v-for="s in displayList"
        :key="s.id"
        :show="s"
        :compact="viewMode === 'list'"
        @remove="askRemove"
        @update="update"
        @preview="openPreview"
        @manage="manageShow = $event"
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

    <ShowManageDialog
      v-if="manageShow"
      :show="manageShow"
      :refreshing="refreshing"
      :refresh-msg="refreshMsg"
      :on-add-episode="manageAddEpisode"
      @close="manageShow = null"
      @redo-episode="manageRedo"
      @skip-episode="manageSkip"
      @refresh-tmdb="manageRefreshTmdb"
    />

    <ConfirmDialog
      v-if="pendingRemove"
      title="Remove this show?"
      :message="`“${pendingRemove.title}” will be removed from auto_magnet.`"
      :details="removeDetails"
      confirm-label="Remove show"
      @cancel="pendingRemove = null"
      @confirm="confirmRemove"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { shows as api } from '../api.js';
import { guard, notifySuccess } from '../toast.js';
import { usePolling } from '../composables/usePolling.js';
import ShowCard         from '../components/ShowCard.vue';
import AddDialog        from '../components/AddDialog.vue';
import PreviewDialog    from '../components/PreviewDialog.vue';
import ShowManageDialog from '../components/ShowManageDialog.vue';
import ConfirmDialog    from '../components/ConfirmDialog.vue';

const list          = ref([]);
const loading       = ref(true);
const showAdd       = ref(false);
const previewItem   = ref(null);
const manageShow    = ref(null);
const pendingRemove = ref(null);
const search        = ref('');
const sortBy        = ref(localStorage.getItem('shows_sort')   || 'added');
const filterState   = ref(localStorage.getItem('shows_filter') || '');
const viewMode      = ref(localStorage.getItem('shows_view')   || 'grid');
const retrying      = ref(false);
const refreshing    = ref(false);
const refreshMsg    = ref('');
let refreshMsgTimer = null;
let initialDone     = false;

function toggleView() {
  viewMode.value = viewMode.value === 'grid' ? 'list' : 'grid';
  localStorage.setItem('shows_view', viewMode.value);
}

const hasFailed = computed(() =>
  list.value.some(s => (s.episodes || []).some(e => e.status === 'failed'))
);

const removeDetails = computed(() => {
  const s = pendingRemove.value;
  if (!s) return [];
  const eps = s.episodes || [];
  const done = eps.filter(e => e.status === 'done').length;
  const out = [`${eps.length} tracked episode${eps.length === 1 ? '' : 's'} will be forgotten`];
  if (done) out.push(`${done} already downloaded — files on disk are not touched`);
  return out;
});

function countBy(show, status) {
  return (show.episodes || []).filter(e => e.status === status).length;
}

/** Earliest future air date across a show's episodes, or null. */
function nextAirDate(show) {
  const today = new Date().toISOString().slice(0, 10);
  const dates = (show.episodes || [])
    .filter(e => e.air_date && e.air_date >= today && e.status !== 'done')
    .map(e => e.air_date)
    .sort();
  return dates[0] || null;
}

const displayList = computed(() => {
  let items = [...list.value];

  const q = search.value.trim().toLowerCase();
  if (q) items = items.filter(s => s.title.toLowerCase().includes(q));

  switch (filterState.value) {
    case 'active':      items = items.filter(s => s.active === 1); break;
    case 'paused':      items = items.filter(s => s.active === 0); break;
    case 'downloading': items = items.filter(s => countBy(s, 'downloading') > 0); break;
    case 'pending':     items = items.filter(s => countBy(s, 'pending') > 0); break;
    case 'failed':      items = items.filter(s => countBy(s, 'failed') > 0); break;
    case 'caughtup':    items = items.filter(s =>
                          countBy(s, 'pending') === 0 &&
                          countBy(s, 'downloading') === 0 &&
                          countBy(s, 'failed') === 0); break;
  }

  switch (sortBy.value) {
    case 'title':
      items.sort((a, b) => a.title.localeCompare(b.title));
      break;
    case 'next':
      // Shows with an upcoming episode first, soonest first; the rest after.
      items.sort((a, b) => {
        const da = nextAirDate(a), dbb = nextAirDate(b);
        if (da && dbb) return da < dbb ? -1 : da > dbb ? 1 : 0;
        if (da) return -1;
        if (dbb) return 1;
        return a.title.localeCompare(b.title);
      });
      break;
    case 'pending':
      items.sort((a, b) => countBy(b, 'pending') - countBy(a, 'pending'));
      break;
    // 'added' = default order from API (added_at DESC)
  }
  return items;
});

function persist() {
  localStorage.setItem('shows_sort', sortBy.value);
  localStorage.setItem('shows_filter', filterState.value);
}

async function reload() {
  loading.value = true;
  try {
    const data = await guard(() => api.list(), 'Failed to load shows');
    if (data) list.value = data;
  } finally {
    loading.value = false;
    initialDone = true;
  }
}

async function silentReload() {
  try {
    const prev = new Map();
    for (const s of list.value) {
      for (const e of (s.episodes || [])) prev.set(e.id, e.status);
    }

    list.value = await api.list();

    if (initialDone && 'Notification' in window && Notification.permission === 'granted') {
      for (const s of list.value) {
        for (const e of (s.episodes || [])) {
          if (e.status === 'done' && prev.get(e.id) === 'downloading') {
            const epStr = `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;
            new Notification('Episode downloaded', { body: `${s.title} ${epStr}`, icon: s.poster_url || undefined });
          }
        }
      }
    }
  } catch (_) { /* transient poll failure — the next tick retries */ }
}

function askRemove(id) {
  pendingRemove.value = list.value.find(s => s.id === id) || null;
}

async function confirmRemove() {
  const show = pendingRemove.value;
  pendingRemove.value = null;
  if (!show) return;
  const ok = await guard(() => api.remove(show.id), `Could not remove “${show.title}”`);
  if (ok !== undefined) {
    list.value = list.value.filter(s => s.id !== show.id);
    notifySuccess(`Removed “${show.title}”`);
  }
}

async function update(id, data) {
  const updated = await guard(() => api.update(id, data), 'Could not update show');
  if (!updated) return;
  const idx = list.value.findIndex(s => s.id === id);
  if (idx !== -1) list.value[idx] = updated;
}

function onAdded(show) {
  list.value.unshift(show);
  const count = (show.episodes || []).length;
  notifySuccess(`Added “${show.title}”${count ? ` — ${count} episodes tracked` : ''}`);
}

async function manageRedo(episode) {
  const show = manageShow.value;
  const ok = await guard(() => api.redoEpisode(show.id, episode.id), 'Redo failed');
  if (ok === undefined) return;
  await silentReload();
  manageShow.value = list.value.find(s => s.id === show.id) || null;
  if (show.mode === 'manual') {
    previewItem.value = {
      show:       { ...show, type: 'tv' },
      season:     episode.season,
      episode:    episode.episode,
      episode_id: episode.id,
    };
  }
}

async function manageSkip(episode) {
  const show = manageShow.value;
  const ok = await guard(() => api.skipEpisode(show.id, episode.id), 'Skip failed');
  if (ok === undefined) return;
  await silentReload();
  manageShow.value = list.value.find(s => s.id === show.id) || null;
}

function openPreview(show, epStr, episodeId) {
  const match = epStr?.match(/S(\d+)E(\d+)/i);
  previewItem.value = {
    show:       { ...show, type: 'tv' },
    season:     match ? parseInt(match[1]) : null,
    episode:    match ? parseInt(match[2]) : null,
    episode_id: episodeId || null,
  };
}

async function retryFailed() {
  retrying.value = true;
  try {
    const res = await guard(() => api.retryFailed(), 'Retry failed');
    if (res) notifySuccess(`${res.reset} episode(s) queued for retry`);
    await silentReload();
  } finally {
    retrying.value = false;
  }
}

async function manageRefreshTmdb() {
  if (!manageShow.value) return;
  const show = manageShow.value;
  refreshing.value = true;
  refreshMsg.value = '';
  clearTimeout(refreshMsgTimer);
  try {
    const result = await api.refreshTmdb(show.id);
    await silentReload();
    manageShow.value = list.value.find(s => s.id === show.id) || null;
    const parts = [];
    if (result.added)   parts.push(`${result.added} added`);
    if (result.updated) parts.push(`${result.updated} updated`);
    refreshMsg.value = parts.length ? parts.join(', ') : 'Up to date';
  } catch (err) {
    refreshMsg.value = err.message || 'Refresh failed';
  } finally {
    refreshing.value = false;
    refreshMsgTimer = setTimeout(() => { refreshMsg.value = ''; }, 4000);
  }
}

/**
 * Returns a promise so the dialog can await it and show its own error state —
 * Vue's emit is synchronous and never propagates rejections on its own.
 */
async function manageAddEpisode({ season, episode, air_date }) {
  if (!manageShow.value) return;
  const show = manageShow.value;
  await api.addEpisode(show.id, { season, episode, air_date });
  await silentReload();
  manageShow.value = list.value.find(s => s.id === show.id) || null;
  notifySuccess(`Added S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`);
}

// Persist control state whenever it changes
watch([sortBy, filterState], persist);

usePolling(silentReload, 30000);
onMounted(reload);
</script>

<style scoped>
.view-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 20px; gap: 12px; flex-wrap: wrap;
}
h1 { font-size: 22px; font-weight: 700; }

.header-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.ctrl-select, .ctrl-search {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text);
  padding: 5px 8px; font-size: 12px; outline: none;
}
.ctrl-select { cursor: pointer; }
.ctrl-search { width: 150px; }
.ctrl-select:focus, .ctrl-search:focus { border-color: var(--accent); }

.icon-btn { font-size: 16px; padding: 4px 10px; }

.state-msg { color: var(--muted); padding: 40px 0; text-align: center; }

.empty-state { text-align: center; padding: 60px 0; color: var(--muted); }
.empty-icon  { font-size: 48px; margin-bottom: 12px; }

/* Matched to the Movies grid so both pages break to the same column count */
.cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 12px;
}
.list-view { display: flex; flex-direction: column; gap: 6px; }

@media (max-width: 640px) {
  .view-header { flex-direction: column; align-items: stretch; }
  .header-actions { justify-content: flex-start; }
  .ctrl-search { width: 100%; }
  .cards-grid { grid-template-columns: 1fr; }
}
</style>
