<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="dialog">

      <!-- Header -->
      <div class="dlg-header">
        <img v-if="show.poster_url" :src="show.poster_url" class="poster" alt="" />
        <div v-else class="poster poster-ph">📺</div>
        <div class="header-info">
          <div class="show-title">{{ show.title }}</div>
          <div class="badges">
            <span class="badge" :class="show.active ? 'badge-active' : 'badge-paused'">
              {{ show.active ? 'Active' : 'Paused' }}
            </span>
            <span class="badge badge-quality">{{ show.quality }}</span>
            <span class="badge badge-mode">{{ show.mode }}</span>
          </div>
          <!-- Summary counts -->
          <div class="ep-counts">
            <span v-if="counts.done"        class="count count-done">{{ counts.done }} done</span>
            <span v-if="counts.downloading" class="count count-dl">{{ counts.downloading }} downloading</span>
            <span v-if="counts.pending"     class="count count-pending">{{ counts.pending }} pending</span>
            <span v-if="counts.failed"      class="count count-failed">{{ counts.failed }} failed</span>
            <span v-if="counts.upcoming"    class="count count-upcoming">{{ counts.upcoming }} upcoming</span>
          </div>
        </div>
        <div class="header-btns">
          <button
            class="btn-ghost btn-xs refresh-btn"
            :disabled="refreshing"
            :title="refreshMsg || 'Re-fetch episode data from TMDB'"
            @click="$emit('refresh-tmdb')"
          >
            <span :class="{ spinning: refreshing }">↻</span>
            {{ refreshing ? 'Refreshing…' : 'Refresh TMDB' }}
          </button>
          <span v-if="refreshMsg" class="refresh-msg">{{ refreshMsg }}</span>
          <button class="close-btn" @click="$emit('close')">✕</button>
        </div>
      </div>

      <!-- Episode list -->
      <div class="ep-body">
        <div v-if="seasons.length === 0" class="empty-msg">No episodes tracked yet.</div>

        <template v-for="season in seasons" :key="season.num">
          <div class="season-heading">Season {{ season.num }}</div>

          <div
            v-for="ep in season.episodes"
            :key="ep.id"
            class="ep-row"
            :class="ep.status"
          >
            <!-- Status bubble -->
            <span class="ep-dot" :class="ep.status" />

            <!-- Episode label -->
            <span class="ep-id">S{{ pad(ep.season) }}E{{ pad(ep.episode) }}</span>

            <!-- Air date -->
            <span class="ep-date">{{ ep.air_date ? formatDate(ep.air_date) : '' }}</span>

            <!-- Status badge -->
            <span class="ep-status-badge" :class="ep.status">{{ ep.status }}</span>

            <!-- Progress bar (downloading only) -->
            <div v-if="ep.status === 'downloading'" class="ep-progress">
              <div class="progress-bar">
                <div class="progress-fill" :style="{ width: (ep.progress || 0) + '%' }" />
              </div>
              <span class="progress-pct">{{ ep.progress || 0 }}%</span>
            </div>
            <div v-else class="ep-progress" />

            <!-- Actions -->
            <div class="ep-actions">
              <button
                v-if="ep.status !== 'upcoming' && ep.status !== 'skipped'"
                class="btn-ghost btn-xs"
                :disabled="busy === ep.id"
                @click="redo(ep)"
              >Redo</button>
              <button
                v-if="ep.status === 'pending' || ep.status === 'failed'"
                class="btn-ghost btn-xs btn-skip"
                :disabled="busy === ep.id"
                @click="skip(ep)"
              >Skip</button>
              <button
                v-if="ep.status === 'skipped'"
                class="btn-ghost btn-xs"
                :disabled="busy === ep.id"
                @click="redo(ep)"
              >Restore</button>
            </div>
          </div>
        </template>

        <!-- Add episode manually -->
        <div class="add-ep-section">
          <div class="add-ep-heading">Add episode manually</div>
          <div class="add-ep-form">
            <label class="add-ep-label">Season
              <input v-model.number="manualSeason" type="number" min="1" class="add-ep-input" placeholder="1" />
            </label>
            <label class="add-ep-label">Episode
              <input v-model.number="manualEpisode" type="number" min="1" class="add-ep-input" placeholder="1" />
            </label>
            <label class="add-ep-label">Air date <span class="add-ep-optional">(optional)</span>
              <input v-model="manualAirDate" type="date" class="add-ep-input add-ep-date" />
            </label>
            <button
              class="btn-ghost btn-xs add-ep-btn"
              :disabled="!manualSeason || !manualEpisode || addingEp"
              @click="submitAddEpisode"
            >{{ addingEp ? 'Adding…' : '+ Add' }}</button>
          </div>
          <div v-if="addEpError" class="add-ep-error">{{ addEpError }}</div>
        </div>
      </div>

    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  show:       Object,
  refreshing: { type: Boolean, default: false },
  refreshMsg: { type: String, default: '' },
});
const emit = defineEmits(['close', 'redo-episode', 'skip-episode', 'refresh-tmdb', 'add-episode']);

const busy         = ref(null);
const manualSeason  = ref(null);
const manualEpisode = ref(null);
const manualAirDate = ref('');
const addingEp      = ref(false);
const addEpError    = ref('');

const seasons = computed(() => {
  const map = {};
  for (const ep of (props.show.episodes || [])) {
    if (!map[ep.season]) map[ep.season] = [];
    map[ep.season].push(ep);
  }
  return Object.entries(map)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([num, episodes]) => ({
      num: Number(num),
      episodes: episodes.slice().sort((a, b) => a.episode - b.episode),
    }));
});

const counts = computed(() => {
  const eps = props.show.episodes || [];
  return {
    done:        eps.filter(e => e.status === 'done').length,
    downloading: eps.filter(e => e.status === 'downloading').length,
    pending:     eps.filter(e => e.status === 'pending').length,
    failed:      eps.filter(e => e.status === 'failed').length,
    upcoming:    eps.filter(e => e.status === 'upcoming').length,
  };
});

function pad(n) { return String(n).padStart(2, '0'); }

function formatDate(d) {
  if (!d) return '';
  return new Date(d + 'T00:00:00').toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

async function redo(ep) {
  busy.value = ep.id;
  try { emit('redo-episode', ep); } finally { busy.value = null; }
}

async function skip(ep) {
  busy.value = ep.id;
  try { emit('skip-episode', ep); } finally { busy.value = null; }
}

async function submitAddEpisode() {
  if (!manualSeason.value || !manualEpisode.value) return;
  addingEp.value = true;
  addEpError.value = '';
  try {
    await emit('add-episode', {
      season:   manualSeason.value,
      episode:  manualEpisode.value,
      air_date: manualAirDate.value || undefined,
    });
    manualSeason.value  = null;
    manualEpisode.value = null;
    manualAirDate.value = '';
  } catch (err) {
    addEpError.value = err.message || 'Failed to add episode';
  } finally {
    addingEp.value = false;
  }
}
</script>

<style scoped>
.overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,.6); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  z-index: 200; padding: 20px;
}

.dialog {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: 10px; width: 100%; max-width: 620px;
  max-height: 82vh; display: flex; flex-direction: column;
  overflow: hidden;
}

/* ── Header ── */
.dlg-header {
  display: flex; align-items: flex-start; gap: 14px;
  padding: 18px 18px 14px;
  border-bottom: 1px solid var(--border);
  position: relative; flex-shrink: 0;
}
.poster {
  width: 56px; height: 84px;
  object-fit: cover; border-radius: 4px; flex-shrink: 0;
}
.poster-ph {
  display: flex; align-items: center; justify-content: center;
  background: var(--border); font-size: 22px; border-radius: 4px;
}
.header-info { flex: 1; min-width: 0; }
.show-title  { font-weight: 700; font-size: 16px; line-height: 1.2; }
.badges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.badge {
  padding: 2px 8px; border-radius: 99px;
  font-size: 10px; font-weight: 600; text-transform: uppercase;
  background: var(--border); color: var(--muted);
}
.badge-active  { background: #14532d; color: #bbf7d0; }
.badge-paused  { background: #374151; color: var(--muted); }
.badge-quality { background: #1e1b4b; color: var(--accent-h); }
.badge-mode    { background: #0c4a6e; color: #7dd3fc; }

.ep-counts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.count { font-size: 11px; font-weight: 600; }
.count-done     { color: var(--green); }
.count-dl       { color: var(--yellow); }
.count-pending  { color: #93c5fd; }
.count-failed   { color: var(--red); }
.count-upcoming { color: #818cf8; }

.header-btns {
  display: flex; flex-direction: column; align-items: flex-end; gap: 4px;
  flex-shrink: 0;
}

.refresh-btn {
  display: flex; align-items: center; gap: 4px;
  font-size: 11px; padding: 3px 8px;
  white-space: nowrap;
}
.refresh-btn .spinning { display: inline-block; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.refresh-msg {
  font-size: 10px; color: var(--green);
  max-width: 120px; text-align: right; line-height: 1.3;
}

.close-btn {
  background: none; border: none; color: var(--muted);
  font-size: 14px; cursor: pointer; padding: 4px 6px;
}
.close-btn:hover { color: var(--text); }

/* ── Episode list ── */
.ep-body {
  overflow-y: auto; padding: 12px 18px 18px;
  display: flex; flex-direction: column; gap: 2px;
}

.empty-msg { color: var(--muted); font-size: 13px; padding: 12px 0; }

.season-heading {
  font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: .5px; color: var(--muted);
  margin-top: 14px; margin-bottom: 4px;
}
.season-heading:first-child { margin-top: 4px; }

.ep-row {
  display: flex; align-items: center; gap: 10px;
  padding: 5px 8px; border-radius: 6px;
  transition: background .1s;
}
.ep-row:hover { background: rgba(255,255,255,.04); }

.ep-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.ep-dot.done        { background: var(--green); }
.ep-dot.downloading { background: var(--yellow); }
.ep-dot.pending     { background: #93c5fd; }
.ep-dot.failed      { background: var(--red); }
.ep-dot.skipped     { background: #4b5563; }
.ep-dot.upcoming    { background: #818cf8; }

.ep-id   { font-size: 12px; font-weight: 700; flex-shrink: 0; width: 56px; font-family: monospace; }
.ep-date { font-size: 11px; color: var(--muted); flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.ep-status-badge {
  font-size: 10px; font-weight: 600; text-transform: uppercase;
  padding: 1px 7px; border-radius: 99px; flex-shrink: 0;
  background: var(--border); color: var(--muted);
}
.ep-status-badge.done        { background: #14532d; color: #86efac; }
.ep-status-badge.downloading { background: #92400e; color: #fde68a; }
.ep-status-badge.pending     { background: #1e3a5f; color: #93c5fd; }
.ep-status-badge.failed      { background: #7f1d1d; color: #fca5a5; }
.ep-status-badge.skipped     { background: #1f2937; color: #6b7280; }
.ep-status-badge.upcoming    { background: #1e1b4b; color: #818cf8; }

.ep-progress {
  display: flex; align-items: center; gap: 5px;
  width: 90px; flex-shrink: 0;
}
.progress-bar  { flex: 1; height: 4px; background: var(--border); border-radius: 99px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 99px; transition: width .5s; }
.progress-pct  { font-size: 10px; color: var(--muted); width: 26px; flex-shrink: 0; }

.ep-actions { display: flex; gap: 4px; flex-shrink: 0; }

.btn-xs {
  padding: 2px 8px; font-size: 11px; border-radius: 4px;
  background: none; border: 1px solid var(--border); color: var(--muted);
  cursor: pointer; transition: border-color .15s, color .15s;
}
.btn-xs:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.btn-xs:disabled { opacity: .4; cursor: default; }
.btn-skip:hover:not(:disabled) { border-color: var(--yellow); color: var(--yellow); }

/* ── Add episode section ── */
.add-ep-section {
  margin-top: 18px; padding-top: 14px;
  border-top: 1px solid var(--border);
}
.add-ep-heading {
  font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: .5px; color: var(--muted); margin-bottom: 8px;
}
.add-ep-form {
  display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap;
}
.add-ep-label {
  display: flex; flex-direction: column; gap: 3px;
  font-size: 10px; color: var(--muted); font-weight: 600; text-transform: uppercase;
}
.add-ep-optional { font-weight: 400; text-transform: none; }
.add-ep-input {
  background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
  color: var(--text); padding: 4px 7px; font-size: 12px;
  width: 60px; outline: none;
}
.add-ep-input:focus { border-color: var(--accent); }
.add-ep-date { width: 120px; }
.add-ep-btn {
  align-self: flex-end; padding: 4px 12px; font-size: 12px;
}
.add-ep-btn:hover:not(:disabled) { border-color: var(--green); color: var(--green); }
.add-ep-error {
  margin-top: 6px; font-size: 11px; color: var(--red);
}
</style>
