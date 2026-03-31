<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="dialog">
      <div class="dialog-header">
        <h2>Add {{ type === 'movie' ? 'Movie' : 'Show' }}</h2>
        <button class="close-btn" @click="$emit('close')">✕</button>
      </div>

      <!-- Search -->
      <div class="search-row">
        <input
          ref="inputEl"
          v-model="query"
          type="text"
          :placeholder="`Search ${type === 'movie' ? 'movies' : 'TV shows'}…`"
          class="search-input"
          @input="onInput"
        />
      </div>

      <!-- Results -->
      <div v-if="loading" class="state-msg">Searching…</div>
      <div v-else-if="results.length === 0 && query.length >= 2" class="state-msg">No results</div>

      <div class="results-list" v-if="!selected && results.length">
        <div
          v-for="r in results"
          :key="r.tmdb_id"
          class="result-item"
          @click="selectResult(r)"
        >
          <img v-if="r.poster_url" :src="r.poster_url" class="r-poster" />
          <div v-else class="r-poster r-poster-ph">{{ type === 'movie' ? '🎬' : '📺' }}</div>
          <div class="r-info">
            <div class="r-title">{{ r.title }}</div>
            <div class="r-meta">{{ r.year }} · {{ r.type }}</div>
            <div class="r-overview">{{ r.overview?.slice(0, 100) }}{{ r.overview?.length > 100 ? '…' : '' }}</div>
          </div>
        </div>
      </div>

      <!-- Selected — configure options -->
      <div v-if="selected" class="selected-panel">
        <div class="selected-header">
          <img v-if="selected.poster_url" :src="selected.poster_url" class="sel-poster" />
          <div class="sel-info">
            <div class="sel-title">{{ selected.title }}</div>
            <div class="sel-meta">{{ selected.year }}</div>
          </div>
          <button class="btn-ghost btn-sm" @click="selected = null">Change</button>
        </div>

        <div class="options">
          <label>Quality
            <select v-model="quality">
              <option value="2160p">4K (2160p)</option>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
              <option value="any">Best available</option>
            </select>
          </label>
          <label>Mode
            <select v-model="mode">
              <option value="auto">Auto (pick best automatically)</option>
              <option value="manual">Manual (I'll choose the torrent)</option>
            </select>
          </label>
          <div v-if="type === 'tv'" class="start-row">
            <label>Start season
              <input v-model.number="startSeason" type="number" min="1" class="num-input" />
            </label>
            <label>Start episode
              <input v-model.number="startEpisode" type="number" min="1" class="num-input" />
            </label>
          </div>
        </div>

        <div v-if="error" class="error-msg">{{ error }}</div>

        <div class="dialog-footer">
          <button class="btn-ghost" @click="$emit('close')">Cancel</button>
          <button class="btn-primary" :disabled="adding" @click="add">
            {{ adding ? 'Adding…' : 'Add' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { search as searchApi, movies as moviesApi, shows as showsApi } from '../api.js';

const props = defineProps({ type: { type: String, default: 'movie' } });
const emit  = defineEmits(['close', 'added']);

const query    = ref('');
const results  = ref([]);
const selected = ref(null);
const loading  = ref(false);
const quality      = ref('1080p');
const mode         = ref('auto');
const startSeason  = ref(1);
const startEpisode = ref(1);
const adding       = ref(false);
const error    = ref('');
const inputEl  = ref(null);

let debounceTimer;

onMounted(() => inputEl.value?.focus());

function onInput() {
  clearTimeout(debounceTimer);
  if (query.value.length < 2) { results.value = []; return; }
  debounceTimer = setTimeout(doSearch, 350);
}

async function doSearch() {
  loading.value = true;
  try {
    const all = await searchApi.tmdb(query.value);
    results.value = all.filter(r => r.type === props.type);
  } catch (_) {
    results.value = [];
  } finally {
    loading.value = false;
  }
}

function selectResult(r) {
  selected.value = r;
}

async function add() {
  if (!selected.value) return;
  adding.value = true;
  error.value  = '';
  try {
    const api = props.type === 'movie' ? moviesApi : showsApi;
    const body = { tmdb_id: selected.value.tmdb_id, quality: quality.value, mode: mode.value };
    if (props.type === 'tv') { body.start_season = startSeason.value; body.start_episode = startEpisode.value; }
    const result = await api.add(body);
    emit('added', result);
    emit('close');
  } catch (err) {
    error.value = err.message;
  } finally {
    adding.value = false;
  }
}
</script>

<style scoped>
.overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,.7);
  display: flex; align-items: center; justify-content: center;
  z-index: 200;
}
.dialog {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  width: 520px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dialog-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border);
}
.dialog-header h2 { font-size: 16px; font-weight: 600; }
.close-btn { background: none; color: var(--muted); font-size: 16px; padding: 4px 8px; }

.search-row { padding: 14px 20px; }
.search-input {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  padding: 9px 12px;
  font-size: 14px;
  outline: none;
}
.search-input:focus { border-color: var(--accent); }

.state-msg { padding: 8px 20px 14px; color: var(--muted); font-size: 13px; }

.results-list { overflow-y: auto; max-height: 340px; padding: 0 12px 12px; }
.result-item {
  display: flex; gap: 12px;
  padding: 10px;
  border-radius: var(--radius);
  cursor: pointer;
  transition: background .15s;
}
.result-item:hover { background: var(--border); }

.r-poster {
  width: 46px; height: 70px;
  object-fit: cover; border-radius: 4px; flex-shrink: 0;
}
.r-poster-ph {
  display: flex; align-items: center; justify-content: center;
  background: var(--bg); font-size: 22px;
}
.r-title    { font-weight: 600; font-size: 14px; }
.r-meta     { color: var(--muted); font-size: 12px; margin-top: 2px; }
.r-overview { color: var(--muted); font-size: 12px; margin-top: 4px; line-height: 1.4; }

.selected-panel { padding: 16px 20px; }
.selected-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.sel-poster { width: 46px; height: 70px; object-fit: cover; border-radius: 4px; }
.sel-title  { font-weight: 600; font-size: 15px; }
.sel-meta   { color: var(--muted); font-size: 13px; }

.options { display: flex; flex-direction: column; gap: 12px; }
.options label { display: flex; flex-direction: column; gap: 5px; font-size: 13px; color: var(--muted); }
.start-row { display: flex; gap: 12px; }
.start-row label { flex: 1; }
.num-input {
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text); padding: 8px 10px; font-size: 14px; outline: none; width: 100%;
}
.num-input:focus { border-color: var(--accent); }
.options select {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  padding: 8px 10px;
  font-size: 14px;
  outline: none;
}
.options select:focus { border-color: var(--accent); }

.error-msg { margin-top: 10px; color: var(--red); font-size: 13px; }

.dialog-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
</style>
