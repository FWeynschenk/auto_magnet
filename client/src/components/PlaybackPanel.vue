<template>
  <section class="panel">
    <div class="panel-head">
      <h2>Watch library</h2>
      <button class="btn-ghost btn-sm" :disabled="busy" @click="refresh">Refresh</button>
    </div>
    <div v-if="!st" class="muted">Loading…</div>
    <template v-else>
      <div class="stats">
        <div><span class="k">Encoder</span> {{ st.encoder === 'vaapi' ? 'GPU (VAAPI)' : 'CPU (libx264)' }}</div>
        <div><span class="k">Web versions</span> {{ size(st.cacheBytes) }} <span class="muted">in {{ st.webRoot }}</span></div>
        <div><span class="k">Plays as is</span> {{ count('direct') }}</div>
        <div><span class="k">Repackaged</span> {{ count('remux', 'ready') }} / {{ count('remux') }}</div>
        <div><span class="k">Converted</span> {{ count('transcode', 'ready') }} / {{ count('transcode') }}</div>
        <div v-if="st.unindexed"><span class="k">Not yet indexed</span> {{ st.unindexed }}</div>
        <div v-if="st.originalsRemoved"><span class="k">Originals removed after seeding</span> {{ st.originalsRemoved }}</div>
        <div v-if="st.space && st.space.free != null">
          <span class="k">Free space</span> {{ size(st.space.free) }}
          <span v-if="st.space.min || st.space.reserve" class="muted">
            · keeping {{ size(st.space.min) }} free<template v-if="st.space.reserve">, plus {{ size(st.space.reserve) }} for what someone presses play on</template>
          </span>
        </div>
      </div>

      <p v-if="st.space?.paused" class="paused">
        <strong>Web versions are paused, even for what someone presses play on:</strong> only {{ size(st.space.free) }}
        is free where they are kept, under the {{ size(st.space.min) }} set in Settings. They carry on by themselves
        once there is room — delete something below, lower <em>Keep free</em>, or turn on <em>Remove originals after seeding</em>.
      </p>
      <p v-else-if="st.space?.backgroundPaused" class="paused">
        <strong>Preparing ahead is paused</strong> to keep {{ size(st.space.min + st.space.reserve) }} free
        ({{ size(st.space.free) }} free now). Anything someone presses play on is still prepared, using the room kept for it.
      </p>

      <div v-if="st.queue.length" class="queue">
        <div class="k">Queue</div>
        <div v-for="q in st.queue" :key="q.kind + q.item_id" class="q">
          <span class="qt">{{ q.title }}</span>
          <span v-if="q.web_priority >= 10" class="tag">requested</span>
          <span class="muted">{{ q.plan }}</span>
          <span v-if="q.web_state === 'encoding'" class="pct">{{ Math.round(q.web_progress * 100) }}%</span>
          <span v-else class="muted">queued</span>
        </div>
      </div>

      <div v-if="st.failed.length" class="queue">
        <div class="k err">Failed</div>
        <div v-for="f in st.failed" :key="f.kind + f.item_id" class="q">
          <span class="qt">{{ f.title }}</span>
          <span class="muted small">{{ f.web_error }}</span>
          <button class="btn-ghost btn-sm" @click="retry(f)">Retry</button>
        </div>
      </div>

      <div v-if="st.largest?.length" class="queue">
        <div class="k">Largest web versions</div>
        <div v-for="w in st.largest" :key="w.kind + w.id" class="q">
          <span class="qt">{{ w.title }}</span>
          <span class="muted">{{ size(w.bytes) }}</span>
          <button class="btn-ghost btn-sm danger" :disabled="!!busy"
            :title="w.onlyCopy ? 'The original was removed after seeding; this deletes the item from disk' : 'The original stays; the web version is made again when next played'"
            @click="remove(w)">{{ w.onlyCopy ? 'Delete item' : 'Delete' }}</button>
        </div>
      </div>

      <div class="actions">
        <button class="btn-ghost btn-sm" :disabled="busy" @click="scan">{{ busy === 'scan' ? 'Scanning…' : 'Scan library now' }}</button>
        <button class="btn-ghost btn-sm danger" :disabled="busy" @click="clear">Delete all web versions</button>
      </div>
      <p class="muted small">
        Originals are never changed — web versions live in their own folder, so torrents keep seeding.
        Deleted web versions are rebuilt when needed. Web versions whose original was removed after seeding
        are the only copy, so "Delete all" keeps them.
      </p>
    </template>
  </section>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { watch } from '../api.js';
import { notifyError, notifySuccess } from '../toast.js';

const st = ref(null);
const busy = ref('');
let timer = null;

const size = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const count = (plan, state) => (st.value?.counts || [])
  .filter(c => c.plan === plan && (!state || c.web_state === state)).reduce((a, c) => a + c.n, 0);

async function refresh() {
  try { st.value = await watch.adminStatus(); } catch (err) { notifyError(err.message); }
}

async function scan() {
  busy.value = 'scan';
  try {
    const r = await watch.scan();
    notifySuccess(`Checked ${r.checked}, found ${r.found}${r.removed ? `, removed ${r.removed} stale` : ''}`);
    await refresh();
  } catch (err) { notifyError(err.message); }
  finally { busy.value = ''; }
}

async function clear() {
  if (!window.confirm('Delete every web version? They are rebuilt the next time each item is played (or straight away, if preparing on completion).')) return;
  busy.value = 'clear';
  try { await watch.clear(); await refresh(); } catch (err) { notifyError(err.message); }
  finally { busy.value = ''; }
}

async function remove(w) {
  const msg = w.onlyCopy
    ? `"${w.title}" has no original any more — deleting its web version deletes it from disk, and it won't be downloaded again. Delete it?`
    : `Delete the web version of "${w.title}"? The original stays; it's made again the next time it's played.`;
  if (!window.confirm(msg)) return;
  busy.value = 'delete';
  try {
    const r = w.onlyCopy ? await watch.deleteAll(w.kind, w.id) : await watch.deleteWeb(w.kind, w.id);
    notifySuccess(`${size(r.freed)} freed`);
    await refresh();
  } catch (err) { notifyError(err.message); }
  finally { busy.value = ''; }
}

async function retry(f) {
  try { await watch.reencode(f.kind, f.item_id); await refresh(); } catch (err) { notifyError(err.message); }
}

onMounted(() => { refresh(); timer = setInterval(() => { if (st.value?.queue.length) refresh(); }, 5000); });
onUnmounted(() => clearInterval(timer));
</script>

<style scoped>
.panel { max-width: 640px; margin-top: 32px; }
.panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
h2 { font-size: 15px; font-weight: 600; }
.stats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; font-size: 13px; }
.k { color: var(--muted); font-size: 12px; margin-right: 6px; }
.muted { color: var(--muted); }
.small { font-size: 11px; }
.err { color: var(--red); }
.queue { margin-top: 14px; display: flex; flex-direction: column; gap: 4px; }
.q { display: flex; gap: 10px; align-items: center; font-size: 13px; }
.qt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pct { color: var(--accent); font-variant-numeric: tabular-nums; }
.actions { display: flex; gap: 8px; margin: 14px 0 8px; }
.danger { color: var(--red); }
.tag { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--accent); border: 1px solid var(--accent); border-radius: 4px; padding: 0 5px; }
.paused { margin-top: 12px; padding: 8px 10px; font-size: 13px; line-height: 1.45;
  border-left: 3px solid var(--yellow); background: color-mix(in srgb, var(--yellow) 10%, transparent); border-radius: 4px; }
@media (max-width: 640px) { .stats { grid-template-columns: 1fr; } }
</style>
