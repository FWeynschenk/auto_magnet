<template>
  <div class="overlay" @click.self="$emit('close')">
    <div ref="dialogEl" class="dialog" role="dialog" aria-modal="true" aria-label="Choose torrent">
      <div class="dialog-header">
        <div class="head-text">
          <h2>Choose Torrent</h2>
          <div class="subtitle">{{ item.title }}{{ epLabel }}</div>
        </div>
        <div class="head-actions">
          <span v-if="!loading && freshness" class="freshness" :title="freshnessTitle">{{ freshness }}</span>
          <button
            class="btn-ghost btn-sm"
            :disabled="loading"
            title="Search the indexers again instead of reusing the last result"
            @click="load(true, activeQuery)"
          >{{ loading ? '…' : '↻ Refresh' }}</button>
          <button class="close-btn" aria-label="Close" @click="$emit('close')">✕</button>
        </div>
      </div>

      <div class="toolbar">
        <input
          v-model="queryInput"
          type="search"
          class="query-input"
          placeholder="Search the indexers for something else…"
          aria-label="Custom indexer search"
          @keydown.enter.prevent="runCustomSearch"
          @keydown.stop
        />
        <button class="btn-ghost btn-sm" :disabled="loading || !queryInput.trim()" @click="runCustomSearch">
          Search
        </button>
        <span v-if="activeQuery" class="query-chip">
          custom: “{{ activeQuery }}”
          <button class="chip-x" aria-label="Clear custom search" @click="clearCustomSearch">✕</button>
        </span>
      </div>

      <div v-if="loading" class="skeleton-wrap" aria-busy="true">
        <div class="state-msg">Asking every indexer — this only happens once, the result is reused.</div>
        <div v-for="n in 5" :key="n" class="skeleton-row" />
      </div>

      <div v-else-if="results.length === 0" class="state-msg empty">
        <p>Nothing usable came back.</p>
        <p v-if="rejected.length" class="sub">
          {{ rejected.length }} result{{ rejected.length === 1 ? ' was' : 's were' }} filtered out —
          open “Filtered out” below to see why.
        </p>
        <p v-else-if="activeQuery" class="sub">No indexer had anything for “{{ activeQuery }}”.</p>
        <p v-else class="sub">Try a custom search above, Refresh, or lower the minimum seeders in Settings.</p>
      </div>

      <div v-else class="results-table-wrap">
        <table class="results-table">
          <thead>
            <tr>
              <th class="col-title">Release</th>
              <th class="sortable" @click="sortBy = 'quality'">Quality{{ sortMark('quality') }}</th>
              <th class="sortable num" @click="sortBy = 'seeders'">Seeds{{ sortMark('seeders') }}</th>
              <th class="sortable num" @click="sortBy = 'size'">Size{{ sortMark('size') }}</th>
              <th class="sortable num" @click="sortBy = 'score'">Rank{{ sortMark('score') }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(r, i) in sorted"
              :key="r.magnet || i"
              :class="{ top: sortBy === 'score' && i === 0, selected: i === cursor }"
              @mouseenter="cursor = i"
            >
              <td class="col-title">
                <div class="rel-title" :title="r.title">{{ r.title }}</div>
                <div class="rel-tags">
                  <span class="tag src">{{ r.indexer || r.source }}</span>
                  <span v-if="r._mirrors > 1" class="tag" :title="`Listed by ${r._mirrors} indexers`">
                    ×{{ r._mirrors }}
                  </span>
                  <span v-if="r.file_count" class="tag ok" :title="`${r.file_count} file(s) inspected`">
                    ✓ contents checked
                  </span>
                  <span v-for="w in r._warnings || []" :key="w" class="tag warn" :title="w">⚠ {{ w }}</span>
                </div>
              </td>
              <td><span class="badge quality">{{ r._quality || '?' }}</span></td>
              <td class="seeds num">{{ r.seeders }}</td>
              <td class="size num">{{ formatSize(r.size) }}</td>
              <td class="score num" :title="`Selection score ${r._score}`">{{ r._score }}</td>
              <td class="row-actions">
                <button class="btn-primary btn-sm" :disabled="grabbing !== null" @click="grab(r, i)">
                  {{ grabbing === i ? '…' : 'Grab' }}
                </button>
                <button class="icon-btn" title="Copy magnet link" @click="copyMagnet(r)">⧉</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <details v-if="rejected.length" class="filtered">
        <summary>{{ rejected.length }} filtered out</summary>
        <ul>
          <li v-for="(r, i) in rejected" :key="i">
            <span class="rej-title" :title="r.title">{{ r.title }}</span>
            <span class="rej-reason">{{ r._reason }}</span>
          </li>
        </ul>
      </details>

      <div v-if="error" class="error-msg">{{ error }}</div>
      <div v-else-if="!loading && results.length" class="hint-bar">
        ↑ ↓ to move · Enter to grab · every row here is ready to start immediately
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, computed } from 'vue';
import { search as searchApi } from '../api.js';
import { useDialog } from '../composables/useDialog.js';
import { notifySuccess, notifyError } from '../toast.js';

const props = defineProps({
  item:       Object,   // { tmdb_id, title, type, quality, id } for movie / show
  season:     { type: Number, default: null },
  episode:    { type: Number, default: null },
  episodeId:  { type: Number, default: null },  // episode DB id — used to load cached results
});
const emit = defineEmits(['close', 'grabbed']);

const { dialogEl } = useDialog(() => emit('close'));

const results   = ref([]);
const rejected  = ref([]);
const loading   = ref(true);
const grabbing  = ref(null);
const error     = ref('');
const cursor    = ref(0);
const sortBy    = ref('score');
const cacheAge  = ref(null);
const fromCache = ref(false);
const queryInput  = ref('');
const activeQuery = ref('');

const epLabel = computed(() => {
  if (props.season && props.episode) {
    return ` · S${String(props.season).padStart(2, '0')}E${String(props.episode).padStart(2, '0')}`;
  }
  return '';
});

// Saying the list is reused, and how old it is, is what makes reuse read as
// speed rather than staleness — and puts Refresh right next to the claim.
const freshness = computed(() => {
  if (activeQuery.value) return 'custom search';
  if (!fromCache.value) return 'fresh results';
  if (cacheAge.value == null) return 'reused results';
  const mins = Math.round(cacheAge.value / 60000);
  return mins < 1 ? 'reused · just now' : `reused · ${mins}m old`;
});
const freshnessTitle = computed(() => {
  if (activeQuery.value) return 'Results for the words you typed, not the TMDB title.';
  return fromCache.value
    ? 'From the last search for this item. Refresh queries the indexers again.'
    : 'Searched the indexers just now.';
});

const QUALITY_ORDER = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1 };
const qualityRank = (r) => QUALITY_ORDER[r._quality] || 0;
const sortMark = (key) => (sortBy.value === key ? ' ▾' : '');

const sorted = computed(() => {
  const list = [...results.value];
  switch (sortBy.value) {
    case 'seeders': return list.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
    case 'size':    return list.sort((a, b) => (b.size || 0) - (a.size || 0));
    case 'quality': return list.sort((a, b) => qualityRank(b) - qualityRank(a));
    default:        return list.sort((a, b) => (b._score || 0) - (a._score || 0));
  }
});

async function load(refresh = false, query = '') {
  loading.value = true;
  error.value   = '';
  try {
    const isMovie = (props.item.type || 'movie') === 'movie';
    const data = await searchApi.preview({
      tmdb_id:    props.item.tmdb_id,
      type:       props.item.type || 'movie',
      quality:    props.item.quality || '1080p',
      season:     props.season,
      episode:    props.episode,
      movie_id:   isMovie ? props.item.id : undefined,
      episode_id: props.episodeId || undefined,
      refresh,
      query:      query || undefined,
    });
    results.value    = data.results  || [];
    rejected.value   = data.rejected || [];
    fromCache.value  = !!data.cached;
    cacheAge.value   = data.cache_age_ms ?? null;
    activeQuery.value = data.query || '';
    cursor.value     = 0;
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function runCustomSearch() {
  const q = queryInput.value.trim();
  if (q) load(false, q);
}

function clearCustomSearch() {
  queryInput.value  = '';
  activeQuery.value = '';
  load();
}

async function grab(torrent, index) {
  grabbing.value = index;
  error.value    = '';
  try {
    const res = await searchApi.grab({
      torrent,
      media_id:   props.item.id,
      media_type: props.item.type || 'movie',
      season:     props.season,
      episode:    props.episode,
    });
    notifySuccess(res?.screening
      ? 'Added to Transmission — verifying contents in the background'
      : 'Added to Transmission');
    emit('grabbed');
    emit('close');
  } catch (err) {
    error.value    = err.message;
    grabbing.value = null;
  }
}

async function copyMagnet(r) {
  try {
    await navigator.clipboard.writeText(r.magnet);
    notifySuccess('Magnet link copied');
  } catch (_) {
    notifyError('Could not copy to clipboard');
  }
}

function onKey(e) {
  if (loading.value || sorted.value.length === 0) return;
  // The custom-search box owns the keyboard while it is focused.
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === 'ArrowDown') {
    cursor.value = Math.min(cursor.value + 1, sorted.value.length - 1);
    e.preventDefault();
  } else if (e.key === 'ArrowUp') {
    cursor.value = Math.max(cursor.value - 1, 0);
    e.preventDefault();
  } else if (e.key === 'Enter' && grabbing.value === null) {
    grab(sorted.value[cursor.value], cursor.value);
    e.preventDefault();
  }
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
  return bytes + ' B';
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  load();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
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
  width: 940px;
  max-width: 95vw;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dialog-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 13px;
  border-bottom: 1px solid var(--border);
}
.dialog-header h2 { font-size: 16px; font-weight: 600; }
.head-text { min-width: 0; }
.subtitle { font-size: 13px; color: var(--muted); margin-top: 3px; }
.head-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.freshness { font-size: 11px; color: var(--muted); white-space: nowrap; }
.close-btn { background: none; color: var(--muted); font-size: 16px; padding: 4px 8px; }

.toolbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 10px 18px;
  border-bottom: 1px solid var(--border);
}
.query-input {
  flex: 1; min-width: 180px;
  background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text);
  padding: 5px 9px; font-size: 12px; outline: none;
}
.query-input:focus { border-color: var(--accent); }
.query-chip {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--accent-h);
  background: #1e1b4b; border-radius: 99px; padding: 3px 8px;
}
.chip-x { background: none; color: inherit; padding: 0 2px; font-size: 11px; }

.state-msg { padding: 20px; color: var(--muted); text-align: center; font-size: 13px; }
.state-msg.empty { padding: 40px 20px; }
.state-msg .sub { margin-top: 8px; font-size: 12px; }

.skeleton-wrap { padding: 0 16px 16px; }
.skeleton-row {
  height: 38px; margin-top: 8px; border-radius: 6px;
  background: linear-gradient(90deg, var(--border) 25%, #4b5563 50%, var(--border) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.4s linear infinite;
}
@keyframes shimmer { to { background-position: -200% 0; } }

.results-table-wrap { overflow-y: auto; padding: 8px 14px; flex: 1; }

.results-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.results-table th {
  text-align: left; color: var(--muted); font-weight: 600;
  padding: 6px 10px; border-bottom: 1px solid var(--border);
  white-space: nowrap;
  position: sticky; top: 0; background: var(--surface); z-index: 1;
}
.results-table th.sortable { cursor: pointer; user-select: none; }
.results-table th.sortable:hover { color: var(--text); }
.results-table th.num, .results-table td.num { text-align: right; }
.results-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
.results-table tr.top td { background: rgba(99,102,241,.07); }
.results-table tr.selected td { background: rgba(99,102,241,.16); }
.results-table tr:last-child td { border-bottom: none; }

.col-title { max-width: 430px; }
.rel-title {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
}
.rel-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
.tag {
  font-size: 10px; padding: 1px 6px; border-radius: 99px;
  background: var(--border); color: var(--muted);
}
.tag.src  { text-transform: uppercase; letter-spacing: .3px; }
.tag.ok   { background: #14532d; color: #bbf7d0; }
.tag.warn { background: #78350f; color: #fde68a; }

.seeds { color: var(--green); font-weight: 600; }
.size  { color: var(--muted); white-space: nowrap; }
.score { color: var(--muted); font-variant-numeric: tabular-nums; }

.row-actions { display: flex; gap: 4px; justify-content: flex-end; white-space: nowrap; }
.icon-btn { background: transparent; color: var(--muted); border: 1px solid var(--border); padding: 3px 8px; }
.icon-btn:hover { color: var(--text); }

.badge { padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
.badge.quality { background: #1e1b4b; color: var(--accent-h); }

.filtered { border-top: 1px solid var(--border); padding: 8px 18px; font-size: 12px; }
.filtered summary { cursor: pointer; color: var(--muted); }
.filtered ul { margin-top: 8px; max-height: 190px; overflow-y: auto; list-style: none; }
.filtered li {
  display: flex; gap: 10px; justify-content: space-between;
  padding: 3px 0; color: var(--muted);
}
.rej-title  { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; font-size: 11px; }
.rej-reason { color: var(--yellow); flex-shrink: 0; font-size: 11px; }

.error-msg { padding: 10px 18px; color: var(--red); font-size: 13px; border-top: 1px solid var(--border); }
.hint-bar  { padding: 8px 18px; color: var(--muted); font-size: 11px; border-top: 1px solid var(--border); }

@media (max-width: 640px) {
  .dialog { max-height: 92vh; }
  .results-table th:nth-child(5), .results-table td:nth-child(5) { display: none; }
  .col-title { max-width: 180px; }
}
</style>
