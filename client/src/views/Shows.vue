<template>
  <div>
    <div class="view-header">
      <h1>Shows</h1>
      <button class="btn-primary" @click="showAdd = true">+ Add Show</button>
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>

    <div v-else-if="list.length === 0" class="empty-state">
      <div class="empty-icon">📺</div>
      <p>No shows yet. Add one to get started.</p>
    </div>

    <div v-else class="cards-grid">
      <ShowCard
        v-for="s in list"
        :key="s.id"
        :show="s"
        @remove="remove"
        @update="update"
        @preview="openPreview"
        @redo-episode="redoEpisode"
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
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { shows as api } from '../api.js';
import ShowCard     from '../components/ShowCard.vue';
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
  list.value = list.value.filter(s => s.id !== id);
}

async function update(id, data) {
  const updated = await api.update(id, data);
  const idx = list.value.findIndex(s => s.id === id);
  if (idx !== -1) list.value[idx] = updated;
}

function onAdded(show) {
  list.value.unshift(show);
}

// show = ShowCard's show object, epStr = 'S01E03', episodeId = db id
function openPreview(show, epStr, episodeId) {
  const match = epStr?.match(/S(\d+)E(\d+)/i);
  previewItem.value = {
    show:       { ...show, type: 'tv' },
    season:     match ? parseInt(match[1]) : null,
    episode:    match ? parseInt(match[2]) : null,
    episode_id: episodeId || null,
  };
}

// episode redo: reset episode then open PreviewDialog for manual selection
async function redoEpisode(show, episode) {
  await api.redoEpisode(show.id, episode.id);
  // refresh that show's episode list
  const updated = await api.list();
  list.value = updated;
  // open preview dialog for this episode
  previewItem.value = {
    show: { ...show, type: 'tv' },
    season:  episode.season,
    episode: episode.episode,
    episode_id: episode.id,
  };
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
  grid-template-columns: repeat(auto-fill, minmax(480px, 1fr));
  gap: 12px;
}
</style>
