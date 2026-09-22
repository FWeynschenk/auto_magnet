<template>
  <div>
    <div class="view-header">
      <h1>Activity</h1>
      <div class="header-actions">
        <input
          v-model="search"
          type="search"
          class="ctrl-search"
          placeholder="Filter messages…"
          aria-label="Filter log messages"
        />
        <select v-model="level" class="ctrl-select" aria-label="Filter by level">
          <option value="">All levels</option>
          <option value="info">Info</option>
          <option value="warn">Warnings</option>
          <option value="error">Errors</option>
        </select>
        <select v-model="entityType" class="ctrl-select" aria-label="Filter by item type">
          <option value="">Everything</option>
          <option value="movie">Movies</option>
          <option value="show">Shows</option>
          <option value="episode">Episodes</option>
        </select>
        <button class="btn-ghost btn-sm" :disabled="loading" @click="reload">
          {{ loading ? '…' : '↻ Refresh' }}
        </button>
        <button class="btn-danger btn-sm" :disabled="rows.length === 0" @click="confirmClear = true">
          Clear
        </button>
      </div>
    </div>

    <div v-if="loading && rows.length === 0" class="state-msg">Loading…</div>

    <div v-else-if="visible.length === 0" class="empty-state">
      <div class="empty-icon">📋</div>
      <p>{{ rows.length === 0 ? 'Nothing logged yet. The next scheduler run will fill this in.' : 'No entries match the current filter.' }}</p>
    </div>

    <div v-else class="log-list">
      <div v-for="row in visible" :key="row.id" class="log-row" :class="row.level">
        <span class="log-time" :title="row.run_at">{{ formatTime(row.run_at) }}</span>
        <span class="log-level" :class="row.level">{{ row.level }}</span>
        <span v-if="row.entity_type" class="log-entity">{{ row.entity_type }}</span>
        <span v-else class="log-entity" />
        <span class="log-msg">{{ row.message }}</span>
      </div>
    </div>

    <p v-if="rows.length > 0" class="retention-note">
      Entries older than 30 days are removed automatically.
    </p>

    <ConfirmDialog
      v-if="confirmClear"
      title="Clear the activity log?"
      message="Every logged entry will be deleted."
      :details="['This only affects the log — no downloads or tracked items are changed']"
      confirm-label="Clear log"
      @cancel="confirmClear = false"
      @confirm="clearLog"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { activity as api } from '../api.js';
import { guard, notifySuccess } from '../toast.js';
import { usePolling } from '../composables/usePolling.js';
import ConfirmDialog from '../components/ConfirmDialog.vue';

const rows         = ref([]);
const loading      = ref(true);
const search       = ref('');
const level        = ref('');
const entityType   = ref('');
const confirmClear = ref(false);

const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter(r => r.message.toLowerCase().includes(q));
});

async function reload() {
  loading.value = true;
  try {
    const data = await guard(
      () => api.list({ level: level.value, entity_type: entityType.value, limit: 500 }),
      'Could not load the activity log',
    );
    if (data) rows.value = data;
  } finally {
    loading.value = false;
  }
}

// Level and type are filtered server-side; the text box is client-side so it
// stays responsive as you type.
watch([level, entityType], reload);

async function silentReload() {
  try {
    rows.value = await api.list({ level: level.value, entity_type: entityType.value, limit: 500 });
  } catch (_) { /* transient poll failure — the next tick retries */ }
}

async function clearLog() {
  confirmClear.value = false;
  const ok = await guard(() => api.clear(), 'Could not clear the log');
  if (ok === undefined) return;
  rows.value = [];
  notifySuccess('Activity log cleared');
}

/** SQLite writes 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker. */
function formatTime(raw) {
  if (!raw) return '';
  const d = new Date(raw.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return raw;
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
.ctrl-search { width: 180px; }
.ctrl-select:focus, .ctrl-search:focus { border-color: var(--accent); }

.state-msg { color: var(--muted); padding: 40px 0; text-align: center; }
.empty-state { text-align: center; padding: 60px 0; color: var(--muted); }
.empty-icon  { font-size: 48px; margin-bottom: 12px; }

.log-list {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}

.log-row {
  display: grid;
  grid-template-columns: 90px 54px 70px 1fr;
  gap: 10px;
  align-items: baseline;
  padding: 6px 12px;
  font-size: 12.5px;
  border-bottom: 1px solid var(--border);
}
.log-row:last-child { border-bottom: none; }
.log-row:hover { background: rgba(255,255,255,.03); }
.log-row.warn  { background: rgba(245,158,11,.05); }
.log-row.error { background: rgba(239,68,68,.07); }

.log-time   { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.log-level  {
  font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px;
  padding: 1px 6px; border-radius: 99px; text-align: center;
}
.log-level.info  { background: var(--border); color: var(--muted); }
.log-level.warn  { background: #78350f; color: #fde68a; }
.log-level.error { background: #7f1d1d; color: #fecaca; }
.log-entity { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .3px; }
.log-msg    { word-break: break-word; }

.retention-note { margin-top: 10px; font-size: 11px; color: var(--muted); }

@media (max-width: 640px) {
  .view-header { flex-direction: column; align-items: stretch; }
  .header-actions { justify-content: flex-start; }
  .ctrl-search { width: 100%; }
  .log-row { grid-template-columns: 70px 50px 1fr; }
  .log-entity { display: none; }
}
</style>
