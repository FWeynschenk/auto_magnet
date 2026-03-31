<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="dialog">
      <div class="dialog-header">
        <div>
          <h2>Choose Torrent</h2>
          <div class="subtitle">{{ item.title }}{{ epLabel }}</div>
        </div>
        <button class="close-btn" @click="$emit('close')">✕</button>
      </div>

      <div v-if="loading" class="state-msg">Searching sources…</div>
      <div v-else-if="results.length === 0" class="state-msg">No results found</div>

      <div v-else class="results-table-wrap">
        <table class="results-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Quality</th>
              <th>Seeds</th>
              <th>Size</th>
              <th>Source</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in results" :key="i" :class="{ top: i === 0 }">
              <td class="col-title" :title="r.title">{{ truncate(r.title, 55) }}</td>
              <td><span class="badge quality">{{ r._quality || '?' }}</span></td>
              <td class="seeds">{{ r.seeders }}</td>
              <td class="size">{{ formatSize(r.size) }}</td>
              <td><span class="badge source">{{ r.source }}</span></td>
              <td>
                <button class="btn-primary btn-sm" :disabled="grabbing === i" @click="grab(r, i)">
                  {{ grabbing === i ? '…' : 'Grab' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="error" class="error-msg">{{ error }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import { search as searchApi } from '../api.js';

const props = defineProps({
  item:       Object,   // { tmdb_id, title, type, quality, id } for movie / show
  season:     { type: Number, default: null },
  episode:    { type: Number, default: null },
  episodeId:  { type: Number, default: null },  // episode DB id — used to load cached results
});
const emit = defineEmits(['close', 'grabbed']);

const results  = ref([]);
const loading  = ref(true);
const grabbing = ref(null);
const error    = ref('');

const epLabel = computed(() => {
  if (props.season && props.episode) {
    return ` · S${String(props.season).padStart(2,'0')}E${String(props.episode).padStart(2,'0')}`;
  }
  return '';
});

onMounted(async () => {
  try {
    const isMovie = (props.item.type || 'movie') === 'movie';
    results.value = await searchApi.preview({
      tmdb_id:    props.item.tmdb_id,
      type:       props.item.type || 'movie',
      quality:    props.item.quality || '1080p',
      season:     props.season,
      episode:    props.episode,
      movie_id:   isMovie ? props.item.id : undefined,
      episode_id: props.episodeId || undefined,
    });
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
});

async function grab(torrent, index) {
  grabbing.value = index;
  error.value    = '';
  try {
    await searchApi.grab({
      torrent,
      media_id:   props.item.id,
      media_type: props.item.type || 'movie',
      season:     props.season,
      episode:    props.episode,
    });
    emit('grabbed');
    emit('close');
  } catch (err) {
    error.value    = err.message;
    grabbing.value = null;
  }
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
  return bytes + ' B';
}

function truncate(str, n) {
  return str?.length > n ? str.slice(0, n) + '…' : str;
}
</script>

<style scoped>
.overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,.75);
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
}
.dialog {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  width: 820px;
  max-width: 95vw;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dialog-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border);
}
.dialog-header h2 { font-size: 16px; font-weight: 600; }
.subtitle { font-size: 13px; color: var(--muted); margin-top: 3px; }
.close-btn { background: none; color: var(--muted); font-size: 16px; padding: 4px 8px; }

.state-msg { padding: 24px 20px; color: var(--muted); text-align: center; }

.results-table-wrap { overflow-y: auto; padding: 12px 16px; }

.results-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.results-table th {
  text-align: left;
  color: var(--muted);
  font-weight: 600;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.results-table td { padding: 9px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.results-table tr.top td { background: rgba(99,102,241,.06); }
.results-table tr:last-child td { border-bottom: none; }
.results-table tr:hover td { background: rgba(255,255,255,.03); }

.col-title { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.seeds { color: var(--green); font-weight: 600; }
.size  { color: var(--muted); white-space: nowrap; }

.badge {
  padding: 2px 8px;
  border-radius: 99px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}
.badge.quality { background: #1e1b4b; color: var(--accent-h); }
.badge.source  { background: var(--border); color: var(--muted); }

.error-msg { padding: 10px 20px; color: var(--red); font-size: 13px; }
</style>
