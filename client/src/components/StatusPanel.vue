<template>
  <section class="status">
    <div class="head">
      <h2>Status</h2>
      <span v-if="r" class="muted small">checked {{ ago(r.at) }}</span>
      <button class="btn-ghost btn-sm" :disabled="busy" @click="refresh">{{ busy ? 'Checking…' : 'Check again' }}</button>
    </div>
    <div v-if="!r && busy" class="muted">Checking every disk and service…</div>
    <div v-else-if="err" class="err">{{ err }}</div>

    <template v-if="r">
      <h3>Disks</h3>
      <div v-for="d in r.disks" :key="d.label" class="disk" :class="{ low: d.low }">
        <div class="row">
          <span class="name">{{ d.label }}</span>
          <span class="free">
            <template v-if="d.free != null">{{ size(d.free) }} free<template v-if="d.size"> of {{ size(d.size) }}</template></template>
            <template v-else>—</template>
          </span>
        </div>
        <div v-if="d.size && d.free != null" class="bar" :title="`${pct(d)}% used`">
          <div class="used" :style="{ width: `${pct(d)}%` }" />
          <div v-if="d.min" class="mark" :style="{ left: `${Math.max(0, 100 - (d.min / d.size) * 100)}%` }" title="Keep free" />
        </div>
        <div class="muted small">
          {{ d.path || '' }}
          <template v-if="d.min"> · keeping {{ size(d.min) }} free</template>
          <span v-if="d.low" class="warn"> · {{ lowText(d) }}</span>
          <span v-if="d.note"> · {{ d.note }}</span>
        </div>
      </div>

      <h3>Services</h3>
      <div v-for="s in r.services" :key="s.name" class="svc">
        <span class="dot" :class="s.ok ? (s.warn ? 'w' : 'ok') : 'bad'" />
        <span class="name">{{ s.name }}</span>
        <span class="muted small detail">{{ s.detail }}</span>
      </div>

      <h3>Work</h3>
      <div class="svc">
        <span class="dot" :class="r.scheduler.disabled ? 'w' : 'ok'" />
        <span class="name">Scheduler</span>
        <span class="muted small detail">{{ schedulerText }}</span>
      </div>
      <div class="svc">
        <span class="dot ok" />
        <span class="name">Web versions</span>
        <span class="muted small detail">{{ r.queue.converting }} being made, {{ r.queue.waiting }} waiting</span>
      </div>
      <div class="svc">
        <span class="dot" :class="r.backup.error ? 'bad' : (backupOld ? 'w' : 'ok')" />
        <span class="name">Database backup</span>
        <span class="muted small detail">
          {{ backupText }}
          <span v-if="r.backup.error" class="err"> · {{ r.backup.error }}</span>
        </span>
        <button class="btn-ghost btn-sm" :disabled="backingUp" @click="backupNow">{{ backingUp ? 'Backing up…' : 'Back up now' }}</button>
      </div>

      <h3>Library check</h3>
      <div class="svc">
        <span class="dot" :class="!lib ? 'w' : libProblems ? 'w' : 'ok'" />
        <span class="name">Last check</span>
        <span class="muted small detail">
          <template v-if="lib">{{ ago(lib.at) }}, {{ libProblems ? `${libProblems} thing(s) to put right` : 'all in order' }}<template
            v-if="lib.unreachable?.length"> · couldn't ask {{ lib.unreachable.join(', ') }}</template></template>
          <template v-else>not run yet — it runs once a week</template>
        </span>
        <button class="btn-ghost btn-sm" :disabled="!!libBusy" @click="checkLibrary">{{ libBusy === 'check' ? 'Checking…' : 'Check now' }}</button>
      </div>
      <template v-if="lib">
        <div v-for="g in libGroups" :key="g.key" class="lib-group">
          <div class="lib-head">
            <span class="name">{{ g.label }} ({{ lib[g.key].length }})</span>
            <span class="muted small">{{ g.what }}</span>
            <button v-if="g.fix" class="btn-ghost btn-sm" :disabled="!!libBusy" @click="fixLibrary(g)">
              {{ libBusy === g.key ? 'Working…' : g.fix }}</button>
          </div>
          <ul class="lib-list">
            <li v-for="x in lib[g.key].slice(0, 12)" :key="x.kind ? x.kind + x.id : x.dir">
              {{ x.title || x.dir }}<span v-if="x.bytes" class="muted"> · {{ size(x.bytes) }}</span>
            </li>
            <li v-if="lib[g.key].length > 12" class="muted">and {{ lib[g.key].length - 12 }} more</li>
          </ul>
        </div>
      </template>
    </template>
  </section>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { health } from '../api.js';
import { notifyError, notifySuccess } from '../toast.js';

const r = ref(null);
const lib = ref(null);
const libBusy = ref('');
const LIB_GROUPS = [
  { key: 'missing', label: 'Files missing', what: 'downloaded, but not on disk any more', fix: 'Download again' },
  { key: 'stuck', label: 'Downloads gone', what: '"downloading", but Transmission no longer has them', fix: 'Download again' },
  { key: 'brokenWeb', label: 'Broken web versions', what: "marked ready, but can't be played", fix: 'Make again' },
  { key: 'orphans', label: 'Leftover folders', what: 'web versions and thumbnails of items no longer in the library', fix: 'Delete them' },
  { key: 'notSeeding', label: 'No longer seeding', what: 'removed from Transmission by hand? Nothing to fix', fix: null },
];
const libGroups = computed(() => (lib.value ? LIB_GROUPS.filter(g => lib.value[g.key]?.length) : []));
const libProblems = computed(() => (lib.value
  ? ['missing', 'stuck', 'brokenWeb', 'orphans'].reduce((a, k) => a + (lib.value[k]?.length || 0), 0) : 0));

async function checkLibrary() {
  libBusy.value = 'check';
  try { lib.value = await health.checkLibrary(); } catch (e) { notifyError(e.message); }
  finally { libBusy.value = ''; }
}

async function fixLibrary(g) {
  const n = lib.value[g.key].length;
  if (!window.confirm(`${g.fix}: ${g.label.toLowerCase()} (${n})?`)) return;
  libBusy.value = g.key;
  try {
    const out = await health.fixLibrary(g.key);
    lib.value = out.report;
    notifySuccess(`Done: ${out.fixed}`);
  } catch (e) { notifyError(e.message); }
  finally { libBusy.value = ''; }
}
const err = ref('');
const busy = ref(false);
const backingUp = ref(false);
const now = ref(Date.now());
let timer = null;
let tick = null;

const size = (b) => (b >= 1e12 ? `${(b / 1e12).toFixed(2)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
const pct = (d) => Math.min(100, Math.round((1 - d.free / d.size) * 100));
const lowText = (d) => (d.label.startsWith('Downloads') ? 'downloads paused, nothing new grabbed'
  : d.label === 'Web versions' ? 'background web versions paused' : 'nearly full');

function ago(iso) {
  const s = Math.max(0, Math.round((now.value - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
function until(iso) {
  const m = Math.round((Date.parse(iso) - now.value) / 60000);
  return m <= 0 ? 'any moment' : m < 60 ? `in ${m} min` : `in ${Math.round(m / 60)} h`;
}

const schedulerText = computed(() => {
  const s = r.value.scheduler;
  if (s.disabled) return 'switched off (AMAGNET_NO_SCHEDULER)';
  if (s.running) return 'running now';
  const last = s.lastFinishedAt ? `last run ${ago(s.lastFinishedAt)} (${s.lastSecs}s)` : 'not run yet';
  return s.nextAt ? `${last}, next ${until(s.nextAt)}` : last;
});

const backupText = computed(() => {
  const b = r.value.backup;
  if (!b.newest) return 'none yet — one is made each day';
  return `last ${ago(b.newest.at)} (${size(b.newest.bytes)}), ${b.count} of ${b.keep} kept in ${b.dir}`;
});

const backupOld = computed(() => !r.value?.backup.newest || now.value - Date.parse(r.value.backup.newest.at) > 2 * 864e5);

async function refresh() {
  busy.value = true;
  err.value = '';
  try { r.value = { ...(await health.report()), at: new Date().toISOString() }; }
  catch (e) { err.value = e.message; }
  finally { busy.value = false; }
}

async function backupNow() {
  backingUp.value = true;
  try {
    const b = await health.backup();
    notifySuccess(`Backed up (${size(b.bytes)})`);
    await refresh();
  } catch (e) { notifyError(e.message); }
  finally { backingUp.value = false; }
}

onMounted(() => {
  refresh();
  health.library().then((l) => { lib.value = l; }, () => {});
  timer = setInterval(refresh, 60_000);
  tick = setInterval(() => { now.value = Date.now(); }, 15_000);
});
onUnmounted(() => { clearInterval(timer); clearInterval(tick); });
</script>

<style scoped>
.status { max-width: 640px; }
.head { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
.head h2 { font-size: 15px; font-weight: 600; flex: 1; }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 20px 0 8px; font-weight: 600; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.err { color: var(--red); }
.warn { color: var(--yellow); }
.disk { padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 8px; }
.disk.low { border-color: var(--yellow); }
.disk .row { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
.disk .name { font-weight: 600; }
.disk .free { font-variant-numeric: tabular-nums; }
.disk .small { overflow-wrap: anywhere; margin-top: 4px; }
.bar { position: relative; height: 6px; background: var(--border); border-radius: 3px; margin-top: 6px; }
.used { height: 100%; background: var(--accent); border-radius: 3px; }
.disk.low .used { background: var(--yellow); }
.mark { position: absolute; top: -3px; width: 2px; height: 12px; background: var(--text); opacity: .6; }
.svc { display: flex; align-items: center; gap: 10px; padding: 6px 0; font-size: 13px; flex-wrap: wrap; }
.svc .name { font-weight: 500; min-width: 120px; }
.svc .detail { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dot.ok { background: var(--green); }
.dot.w { background: var(--yellow); }
.dot.bad { background: var(--red); }
.lib-group { margin: 6px 0 10px 18px; font-size: 13px; }
.lib-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.lib-head .name { font-weight: 500; }
.lib-head .small { flex: 1; min-width: 0; }
.lib-list { margin: 4px 0 0 16px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
</style>
