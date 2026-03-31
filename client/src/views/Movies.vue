<template>
  <div>
    <div class="view-header">
      <h1>Movies</h1>
      <button class="btn-primary" @click="showAdd = true">+ Add Movie</button>
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>

    <div v-else-if="list.length === 0" class="empty-state">
      <div class="empty-icon">🎬</div>
      <p>No movies yet. Add one to get started.</p>
    </div>

    <div v-else class="cards-grid">
      <MovieCard
        v-for="m in list"
        :key="m.id"
        :movie="m"
        @remove="remove"
        @update="update"
        @preview="openPreview"
        @redo="redo"
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
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { movies as api } from '../api.js';
import MovieCard    from '../components/MovieCard.vue';
import AddDialog    from '../components/AddDialog.vue';
import PreviewDialog from '../components/PreviewDialog.vue';

const list        = ref([]);
const loading     = ref(true);
const showAdd     = ref(false);
const previewItem = ref(null);
let pollTimer     = null;

async function reload() {
  loading.value = true;
  try { list.value = await api.list(); } finally { loading.value = false; }
}

async function silentReload() {
  try { list.value = await api.list(); } catch (_) {}
}

async function remove(id) {
  await api.remove(id);
  list.value = list.value.filter(m => m.id !== id);
}

async function update(id, data) {
  const updated = await api.update(id, data);
  const idx = list.value.findIndex(m => m.id === id);
  if (idx !== -1) list.value[idx] = updated;
}

function onAdded(movie) {
  list.value.unshift(movie);
}

function openPreview(movie) {
  previewItem.value = { ...movie, type: 'movie' };
}

async function redo(movie) {
  const updated = await api.redo(movie.id);
  const idx = list.value.findIndex(m => m.id === movie.id);
  if (idx !== -1) list.value[idx] = updated;
  previewItem.value = { ...updated, type: 'movie' };
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
  margin-bottom: 20px;
}
h1 { font-size: 22px; font-weight: 700; }

.state-msg { color: var(--muted); padding: 40px 0; text-align: center; }

.empty-state { text-align: center; padding: 60px 0; color: var(--muted); }
.empty-icon  { font-size: 48px; margin-bottom: 12px; }

.cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 12px;
}
</style>
