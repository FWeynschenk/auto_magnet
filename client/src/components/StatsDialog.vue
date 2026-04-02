<template>
  <div class="overlay" @click.self="$emit('close')">
    <div class="dialog">
      <div class="dialog-header">
        <img v-if="item.poster_url" :src="item.poster_url" class="dlg-poster" alt="" />
        <div v-else class="dlg-poster dlg-poster-ph">{{ isMovie ? '🎬' : '📺' }}</div>
        <div class="dlg-title-block">
          <div class="dlg-title">{{ item.title }}</div>
          <div class="dlg-sub" v-if="isMovie && item.year">{{ item.year }}</div>
          <div class="badges">
            <span class="badge" :class="statusClass">{{ item.status }}</span>
            <span class="badge quality">{{ item.quality }}</span>
            <span class="badge mode">{{ item.mode }}</span>
          </div>
        </div>
        <button class="close-btn" @click="$emit('close')">✕</button>
      </div>

      <div class="stats-body">

        <!-- ── Movie stats ── -->
        <template v-if="isMovie">
          <div class="stat-grid">
            <div class="stat">
              <div class="stat-label">Added</div>
              <div class="stat-value">{{ formatDate(item.added_at) }}</div>
            </div>
            <div class="stat" v-if="item.release_date">
              <div class="stat-label">Release date</div>
              <div class="stat-value">{{ formatDate(item.release_date) }}</div>
            </div>
            <div class="stat" v-if="item.download_started_at">
              <div class="stat-label">Download started</div>
              <div class="stat-value">{{ formatDate(item.download_started_at) }}</div>
            </div>
            <div class="stat" v-if="retriesCount > 0">
              <div class="stat-label">Retries</div>
              <div class="stat-value">{{ retriesCount }}</div>
            </div>
          </div>

          <div v-if="item.status === 'downloading'" class="progress-section">
            <div class="section-label">Download progress</div>
            <div class="progress-row">
              <div class="progress-bar">
                <div class="progress-fill" :style="{ width: (item.progress || 0) + '%' }" />
              </div>
              <span class="progress-pct">{{ item.progress || 0 }}%</span>
            </div>
          </div>

          <div v-if="item.magnet" class="magnet-section">
            <div class="section-label">Current torrent</div>
            <div class="magnet-text">{{ truncateMagnet(item.magnet) }}</div>
          </div>

          <div v-if="retriesCount > 0" class="tried-section">
            <div class="section-label">Previously tried ({{ retriesCount }})</div>
            <div v-for="(m, i) in triedList" :key="i" class="magnet-text faded">{{ truncateMagnet(m) }}</div>
          </div>
        </template>

        <!-- ── Show stats ── -->
        <template v-else>
          <div class="stat-grid">
            <div class="stat">
              <div class="stat-label">Added</div>
              <div class="stat-value">{{ formatDate(item.added_at) }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">Episodes tracked</div>
              <div class="stat-value">{{ epStats.total }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">Downloaded</div>
              <div class="stat-value stat-green">{{ epStats.done }}</div>
            </div>
            <div class="stat" v-if="epStats.downloading > 0">
              <div class="stat-label">Downloading</div>
              <div class="stat-value stat-yellow">{{ epStats.downloading }}</div>
            </div>
            <div class="stat" v-if="epStats.failed > 0">
              <div class="stat-label">Failed</div>
              <div class="stat-value stat-red">{{ epStats.failed }}</div>
            </div>
            <div class="stat" v-if="epStats.upcoming > 0">
              <div class="stat-label">Upcoming</div>
              <div class="stat-value stat-muted">{{ epStats.upcoming }}</div>
            </div>
          </div>

          <!-- Active downloads with progress -->
          <div v-if="dlEpisodes.length > 0" class="progress-section">
            <div class="section-label">Active downloads</div>
            <div v-for="ep in dlEpisodes" :key="ep.id" class="ep-dl-row">
              <span class="ep-label">S{{ pad(ep.season) }}E{{ pad(ep.episode) }}</span>
              <div class="progress-bar">
                <div class="progress-fill" :style="{ width: (ep.progress || 0) + '%' }" />
              </div>
              <span class="progress-pct">{{ ep.progress || 0 }}%</span>
              <span v-if="ep.download_started_at" class="ep-since">since {{ formatDate(ep.download_started_at) }}</span>
            </div>
          </div>

          <!-- Failed episodes -->
          <div v-if="failedEpisodes.length > 0" class="failed-section">
            <div class="section-label">Failed</div>
            <div v-for="ep in failedEpisodes" :key="ep.id" class="ep-fail-row">
              <span class="ep-label">S{{ pad(ep.season) }}E{{ pad(ep.episode) }}</span>
              <span class="ep-retries" v-if="ep.tried_magnets">{{ JSON.parse(ep.tried_magnets).length }} tried</span>
            </div>
          </div>
        </template>

      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({ item: Object });
defineEmits(['close']);

const isMovie = computed(() => !('episodes' in props.item));

const statusClass = computed(() => ({
  pending:     'status-pending',
  downloading: 'status-downloading',
  done:        'status-done',
  failed:      'status-failed',
  active:      'status-done',
  ended:       'status-pending',
}[props.item.status] || 'status-pending'));

const triedList  = computed(() => JSON.parse(props.item.tried_magnets || '[]'));
const retriesCount = computed(() => triedList.value.length);

const epStats = computed(() => {
  const eps = props.item.episodes || [];
  return {
    total:       eps.filter(e => e.status !== 'upcoming').length,
    done:        eps.filter(e => e.status === 'done').length,
    downloading: eps.filter(e => e.status === 'downloading').length,
    failed:      eps.filter(e => e.status === 'failed').length,
    upcoming:    eps.filter(e => e.status === 'upcoming').length,
  };
});

const dlEpisodes = computed(() =>
  (props.item.episodes || []).filter(e => e.status === 'downloading')
);
const failedEpisodes = computed(() =>
  (props.item.episodes || []).filter(e => e.status === 'failed')
);

function pad(n) { return String(n).padStart(2, '0'); }

function formatDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function truncateMagnet(m) {
  if (!m) return '—';
  if (m.startsWith('magnet:')) {
    const dn = m.match(/dn=([^&]+)/)?.[1];
    return dn ? decodeURIComponent(dn).slice(0, 60) : m.slice(0, 60) + '…';
  }
  return m.slice(0, 60) + (m.length > 60 ? '…' : '');
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
  border-radius: 10px; width: 100%; max-width: 540px;
  max-height: 80vh; overflow-y: auto;
}

.dialog-header {
  display: flex; align-items: flex-start; gap: 14px;
  padding: 18px 18px 14px;
  border-bottom: 1px solid var(--border);
  position: relative;
}

.dlg-poster {
  width: 56px; height: 84px;
  object-fit: cover; border-radius: 4px; flex-shrink: 0;
}
.dlg-poster-ph {
  display: flex; align-items: center; justify-content: center;
  background: var(--border); font-size: 22px;
}

.dlg-title-block { flex: 1; min-width: 0; }
.dlg-title { font-weight: 700; font-size: 16px; line-height: 1.2; }
.dlg-sub   { color: var(--muted); font-size: 13px; margin-top: 3px; }
.badges    { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }

.badge {
  padding: 2px 8px; border-radius: 99px;
  font-size: 10px; font-weight: 600; text-transform: uppercase;
  background: var(--border); color: var(--muted);
}
.status-pending     { background: #374151; color: var(--muted); }
.status-downloading { background: #92400e; color: #fef3c7; }
.status-done        { background: #14532d; color: #bbf7d0; }
.status-failed      { background: #7f1d1d; color: #fecaca; }
.quality { background: #1e1b4b; color: var(--accent-h); }
.mode    { background: #0c4a6e; color: #7dd3fc; }

.close-btn {
  position: absolute; top: 14px; right: 14px;
  background: none; border: none; color: var(--muted);
  font-size: 14px; cursor: pointer; padding: 4px 6px;
}
.close-btn:hover { color: var(--text); }

.stats-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 18px; }

.stat-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px;
}
.stat { display: flex; flex-direction: column; gap: 3px; }
.stat-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .4px; }
.stat-value { font-size: 14px; font-weight: 600; }
.stat-green  { color: var(--green); }
.stat-yellow { color: var(--yellow); }
.stat-red    { color: var(--red); }
.stat-muted  { color: var(--muted); }

.section-label {
  font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: .5px; color: var(--muted); margin-bottom: 8px;
}

.progress-row {
  display: flex; align-items: center; gap: 8px;
}
.progress-bar  { flex: 1; height: 6px; background: var(--border); border-radius: 99px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 99px; transition: width .5s; }
.progress-pct  { font-size: 12px; color: var(--muted); width: 32px; flex-shrink: 0; }

.ep-dl-row {
  display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
}
.ep-label { font-size: 12px; font-weight: 600; flex-shrink: 0; width: 56px; }
.ep-since { font-size: 11px; color: var(--muted); flex-shrink: 0; }

.ep-fail-row {
  display: flex; align-items: center; gap: 8px; margin-bottom: 4px; font-size: 12px;
}
.ep-retries { color: var(--muted); font-size: 11px; }

.magnet-text {
  font-family: monospace; font-size: 11px; color: var(--muted);
  word-break: break-all; line-height: 1.4;
}
.magnet-text.faded { opacity: .6; }
</style>
