<template>
  <div>
    <div class="view-header">
      <h1>Movies</h1>
      <div class="header-actions">
        <input
          v-model="search"
          type="search"
          class="ctrl-search"
          placeholder="Filter movies…"
          aria-label="Filter movies by title"
        />
        <button
          v-if="hasFailed"
          class="btn-ghost btn-sm"
          :disabled="retrying"
          @click="retryFailed"
        >{{ retrying ? 'Retrying…' : '↺ Retry Failed' }}</button>
        <select v-model="sortBy" class="ctrl-select" aria-label="Sort movies">
          <option value="added">Recently added</option>
          <option value="title">Title</option>
          <option value="year">Year</option>
          <option value="status">Status</option>
        </select>
        <select v-model="filterStatus" class="ctrl-select" aria-label="Filter movies by status">
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="downloading">Downloading</option>
          <option value="done">Done</option>
          <option value="failed">Failed</option>
        </select>
        <button
          class="btn-ghost btn-sm icon-btn"
          :aria-label="viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'"
          :title="viewMode === 'grid' ? 'Switch to list' : 'Switch to grid'"
          @click="toggleView"
        >{{ viewMode === 'grid' ? '☰' : '⊞' }}</button>
        <button class="btn-primary" @click="showAdd = true">+ Add Movie</button>
      </div>
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>

    <div v-else-if="displayList.length === 0" class="empty-state">
      <div class="empty-icon">🎬</div>
      <p>{{ list.length === 0 ? 'No movies yet. Add one to get started.' : 'No movies match the current filter.' }}</p>
    </div>

    <div v-else-if="viewMode === 'grid'" class="cards-grid">
      <MovieCard
        v-for="m in displayList"
        :key="m.id"
        :movie="m"
        @remove="askRemove"
        @update="update"
        @preview="openPreview"
        @redo="redo"
        @stats="statsItem = $event"
      />
    </div>

    <div v-else class="list-view">
      <MovieListRow
        v-for="m in displayList"
        :key="m.id"
        :movie="m"
        @remove="askRemove"
        @update="update"
        @preview="openPreview"
        @redo="redo"
        @stats="statsItem = $event"
      />
    </div>

    <AddDialog
      v-if="showAdd"
      type="movie"
      @close="showAdd = false"
      @added="onAdded"
    />

    <PreviewDialog
      v-if="previewItem"
      :item="previewItem"
      @close="previewItem = null"
      @grabbed="reload"
    />

    <StatsDialog
      v-if="statsItem"
      :item="statsItem"
      @close="statsItem = null"
    />

    <ConfirmDialog
      v-if="pendingRemove"
      title="Remove this movie?"
      :message="`“${pendingRemove.title}” will be removed from auto_magnet.`"
      :details="['Files already downloaded are not deleted from disk']"
      confirm-label="Remove movie"
      @cancel="pendingRemove = null"
      @confirm="confirmRemove"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { movies as api } from '../api.js';
import { guard, notifySuccess } from '../toast.js';
import { usePolling } from '../composables/usePolling.js';
import MovieCard     from '../components/MovieCard.vue';
import MovieListRow  from '../components/MovieListRow.vue';
import AddDialog     from '../components/AddDialog.vue';
import PreviewDialog from '../components/PreviewDialog.vue';
import StatsDialog   from '../components/StatsDialog.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';

const list          = ref([]);
const loading       = ref(true);
const showAdd       = ref(false);
const previewItem   = ref(null);
const statsItem     = ref(null);
const pendingRemove = ref(null);
const search        = ref('');
const sortBy        = ref(localStorage.getItem('movies_sort')   || 'added');
const filterStatus  = ref(localStorage.getItem('movies_filter') || '');
const retrying      = ref(false);
let initialDone     = false;

const viewMode = ref(localStorage.getItem('movies_view') || 'grid');
function toggleView() {
  viewMode.value = viewMode.value === 'grid' ? 'list' : 'grid';
  localStorage.setItem('movies_view', viewMode.value);
}

watch([sortBy, filterStatus], () => {
  localStorage.setItem('movies_sort', sortBy.value);
  localStorage.setItem('movies_filter', filterStatus.value);
});

const hasFailed = computed(() => list.value.some(m => m.status === 'failed'));

const displayList = computed(() => {
  let items = [...list.value];
  const q = search.value.trim().toLowerCase();
  if (q) items = items.filter(m => m.title.toLowerCase().includes(q));
  if (filterStatus.value) items = items.filter(m => m.status === filterStatus.value);
  switch (sortBy.value) {
    case 'title':  items.sort((a, b) => a.title.localeCompare(b.title)); break;
    case 'year':   items.sort((a, b) => (b.year || 0) - (a.year || 0)); break;
    case 'status': items.sort((a, b) => a.status.localeCompare(b.status)); break;
    // 'added' = default order from API (added_at DESC)
  }
  return items;
});

async function reload() {
  loading.value = true;
  try {
    const data = await guard(() => api.list(), 'Failed to load movies');
    if (data) list.value = data;
  } finally {
    loading.value = false;
    initialDone = true;
  }
}

async function silentReload() {
  try {
    const prev = new Map(list.value.map(m => [m.id, m.status]));
    list.value  = await api.list();
    if (initialDone && 'Notification' in window && Notification.permission === 'granted') {
      for (const m of list.value) {
        if (m.status === 'done' && prev.get(m.id) === 'downloading') {
          new Notification('Download complete', { body: m.title, icon: m.poster_url || undefined });
        }
      }
    }
  } catch (_) { /* transient poll failure — the next tick retries */ }
}

function askRemove(id) {
  pendingRemove.value = list.value.find(m => m.id === id) || null;
}

async function confirmRemove() {
  const movie = pendingRemove.value;
  pendingRemove.value = null;
  if (!movie) return;
  const ok = await guard(() => api.remove(movie.id), `Could not remove “${movie.title}”`);
  if (ok !== undefined) {
    list.value = list.value.filter(m => m.id !== movie.id);
    notifySuccess(`Removed “${movie.title}”`);
  }
}

async function update(id, data) {
  const updated = await guard(() => api.update(id, data), 'Could not update movie');
  if (!updated) return;
  const idx = list.value.findIndex(m => m.id === id);
  if (idx !== -1) list.value[idx] = updated;
}

function onAdded(movie) {
  list.value.unshift(movie);
  notifySuccess(`Added “${movie.title}”`);
}

function openPreview(movie) {
  previewItem.value = { ...movie, type: 'movie' };
}

async function redo(movie) {
  const updated = await guard(() => api.redo(movie.id), 'Redo failed');
  if (!updated) return;
  const idx = list.value.findIndex(m => m.id === movie.id);
  if (idx !== -1) list.value[idx] = updated;
  if (updated.mode === 'manual') previewItem.value = { ...updated, type: 'movie' };
}

async function retryFailed() {
  retrying.value = true;
  try {
    const res = await guard(() => api.retryFailed(), 'Retry failed');
    if (res) notifySuccess(`${res.reset} movie(s) queued for retry`);
    await silentReload();
  } finally {
    retrying.value = false;
  }
}

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
