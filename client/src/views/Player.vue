<template>
  <div class="player-page" @keydown="onKey" tabindex="-1" ref="page">
    <header class="bar">
      <button class="btn-ghost btn-sm" @click="back">← Back</button>
      <div v-if="item" class="heading">
        <div class="t">{{ item.kind === 'episode' ? item.show_title : item.title }}</div>
        <div v-if="item.kind === 'episode'" class="s">{{ epCode(item) }} · {{ item.title }}</div>
        <div v-else-if="item.year" class="s">{{ item.year }}</div>
      </div>
    </header>

    <div class="stage">
      <div v-if="loading" class="msg">Loading…</div>
      <div v-else-if="fatal" class="msg err">{{ fatal }}</div>

      <div v-else-if="pb?.mode === 'preparing'" class="msg">
        <template v-if="pb.state === 'failed'">
          <div class="err">Couldn't prepare this for the browser.</div>
          <div class="small">{{ pb.error }}</div>
          <button v-if="isAdmin" class="btn-primary" @click="retry">Try again</button>
        </template>
        <template v-else>
          <div>Preparing for your browser…</div>
          <div class="small">{{ pb.plan === 'remux' ? 'Repackaging' : 'Converting' }} — {{ pb.reason }}</div>
          <div class="prog"><div :style="{ width: Math.round((pb.progress || 0) * 100) + '%' }" /></div>
          <div class="small">{{ pb.state === 'queued' ? 'Waiting in the queue' : `${Math.round((pb.progress || 0) * 100)}%` }} · playback starts as soon as the first part is ready</div>
        </template>
      </div>

      <video
        v-show="pb && (pb.mode === 'file' || pb.mode === 'hls')"
        ref="video"
        class="video"
        controls
        playsinline
        preload="metadata"
        :poster="item?.still_url || undefined"
        @timeupdate="onTime"
        @pause="report(true)"
        @ended="onEnded"
        @loadedmetadata="onMeta"
      />

      <div v-if="resumedAt" class="toast-resume">
        Resumed at {{ fmt(resumedAt) }}
        <button class="btn-ghost btn-sm" @click="startOver">Start over</button>
      </div>

      <div v-if="upNext" class="upnext">
        <div class="small">Up next{{ countdown > 0 ? ` in ${countdown}s` : '' }}</div>
        <div class="t">{{ epCode(item.next) }} · {{ item.next.title }}</div>
        <div class="row">
          <button class="btn-primary btn-sm" @click="playNext">Play now</button>
          <button class="btn-ghost btn-sm" @click="cancelNext">Cancel</button>
        </div>
      </div>
    </div>

    <footer v-if="item && pb && (pb.mode === 'file' || pb.mode === 'hls')" class="tools">
      <label v-if="audioTracks.length > 1" class="sub-pick">Audio
        <select v-model.number="audioIdx" @change="selectAudio">
          <option v-for="t in audioTracks" :key="t.idx" :value="t.idx">{{ t.name }}</option>
        </select>
      </label>

      <label class="sub-pick">Subtitles
        <select v-model="subId" @change="selectSub">
          <option value="">Off</option>
          <option v-for="s in item.subtitles" :key="s.id" :value="s.id" :disabled="!s.available">
            {{ s.label }}{{ s.available ? '' : ' — not supported' }}
          </option>
        </select>
      </label>

      <div v-if="subId" class="offset">
        <span class="small">Timing</span>
        <button class="btn-ghost btn-sm" title="Subtitles earlier (Z)" @click="nudge(-250)">−¼s</button>
        <span class="off-val" :class="{ changed: offset !== 0 }">{{ offset > 0 ? '+' : '' }}{{ (offset / 1000).toFixed(2) }}s</span>
        <button class="btn-ghost btn-sm" title="Subtitles later (X)" @click="nudge(250)">+¼s</button>
        <template v-if="currentSub?.editable">
          <button v-if="offset !== 0" class="btn-ghost btn-sm" :disabled="subBusy" @click="saveOffset">Save to file</button>
          <button class="btn-ghost btn-sm" :disabled="subBusy" title="Align to the audio — takes a little while" @click="autoSync">
            {{ subBusy === 'sync' ? 'Syncing…' : 'Auto-sync' }}</button>
          <button class="btn-ghost btn-sm" :disabled="subBusy" title="Undo every saved change to this file" @click="restore">Restore</button>
        </template>
      </div>

      <div class="right">
        <span v-if="pb.mode === 'hls' && !pb.complete" class="small warn">
          Still converting ({{ Math.round((pb.progress || 0) * 100) }}%) — you can watch what's ready
        </span>
        <button v-if="item.next" class="btn-ghost btn-sm" @click="playNext">Next ▸</button>
        <button class="btn-ghost btn-sm" @click="toggleWatched">{{ item.progress?.watched ? 'Mark unwatched' : 'Mark watched' }}</button>
        <a v-if="pb.original !== false" class="btn-ghost btn-sm dl" :href="`/api/watch/items/${kind}/${id}/file?download=1`" title="Download the original file">Download</a>
      </div>
    </footer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch as watchRef, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import Hls from 'hls.js';
import { watch } from '../api.js';
import { isAdmin } from '../session.js';
import { notifyError, notifySuccess } from '../toast.js';

const props = defineProps({ kind: { type: String, required: true }, id: { type: String, required: true } });
const router = useRouter();

const video = ref(null);
const page = ref(null);
const item = ref(null);
const pb = ref(null);
const loading = ref(true);
const fatal = ref('');
const resumedAt = ref(0);
const upNext = ref(false);
const countdown = ref(0);
const subId = ref('');
const offset = ref(0);
const subBusy = ref('');
const audioTracks = ref([]);   // [{ idx, name }]
const audioIdx = ref(0);

let hls = null;
let pollTimer = null;
let nextTimer = null;
let lastReported = -1;
let lastReportAt = 0;
let attachedUrl = null;
let subVersion = Date.now();

const currentSub = computed(() => item.value?.subtitles.find(s => s.id === subId.value) || null);

const epCode = (i) => `S${String(i.season).padStart(2, '0')}E${String(i.episode).padStart(2, '0')}`;
const fmt = (s) => {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
};

// ─── Loading ─────────────────────────────────────────────────────────────────

async function load() {
  teardown();
  loading.value = true;
  fatal.value = '';
  upNext.value = false;
  resumedAt.value = 0;
  offset.value = 0;
  try {
    item.value = await watch.item(props.kind, props.id);
  } catch (err) {
    fatal.value = err.message;
    loading.value = false;
    return;
  }
  pb.value = item.value.playback;
  loading.value = false;
  if (pb.value.mode === 'unavailable') { fatal.value = pb.value.error || 'This can\'t be played'; return; }
  const def = item.value.subtitles.find(s => s.default);
  subId.value = def ? def.id : '';
  await nextTick();
  if (pb.value.mode === 'preparing') startPolling();
  else attach();
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const p = await watch.playback(props.kind, props.id);
      const wasPlayable = pb.value?.mode === 'hls' || pb.value?.mode === 'file';
      pb.value = p;
      if (!wasPlayable && (p.mode === 'hls' || p.mode === 'file')) attach();
      if (p.mode === 'hls' && p.complete) clearInterval(pollTimer);
      if (p.mode === 'preparing' && p.state === 'failed') clearInterval(pollTimer);
    } catch (_) {}
  }, 2000);
}

function resumePoint() {
  const p = item.value.progress;
  return p && !p.watched && p.position > 30 ? p.position : 0;
}

function attach() {
  const v = video.value;
  if (!v || attachedUrl === pb.value.url) return;
  attachedUrl = pb.value.url;
  const start = resumePoint();
  resumedAt.value = start;
  if (start) setTimeout(() => { resumedAt.value = 0; }, 8000);

  if (pb.value.mode === 'hls') {
    if (!pb.value.complete) startPolling();
    if (Hls.isSupported()) {
      hls = new Hls({ startPosition: start || 0, maxBufferLength: 60 });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else fatal.value = `Playback failed: ${data.details}`;
      });
      // Every audio track of the file is an alternative rendition.
      const syncAudio = () => {
        audioTracks.value = hls.audioTracks.map((t, idx) => ({ idx, name: t.name || t.lang || `Track ${idx + 1}` }));
        audioIdx.value = hls.audioTrack;
      };
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, syncAudio);
      hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, syncAudio);
      hls.loadSource(pb.value.url);
      hls.attachMedia(v);
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = pb.value.url; // Safari plays HLS natively
      v.addEventListener('loadedmetadata', syncNativeAudio, { once: true });
      if (start) v.addEventListener('loadedmetadata', () => { v.currentTime = start; }, { once: true });
    } else {
      fatal.value = 'This browser can\'t play HLS';
      return;
    }
  } else {
    v.src = pb.value.url;
    if (start) v.addEventListener('loadedmetadata', () => { v.currentTime = start; }, { once: true });
  }
  buildTracks();
  v.play().catch(() => { /* autoplay blocked — the user presses play */ });
  page.value?.focus();
}

function teardown() {
  report(true);
  clearInterval(pollTimer);
  clearInterval(nextTimer);
  if (hls) { hls.destroy(); hls = null; }
  attachedUrl = null;
  audioTracks.value = [];
  const v = video.value;
  if (v) {
    v.removeAttribute('src');
    for (const t of [...v.querySelectorAll('track')]) t.remove();
    v.load();
  }
}

// ─── Audio tracks ────────────────────────────────────────────────────────────

/** Safari's own HLS player exposes the renditions as video.audioTracks. */
function syncNativeAudio() {
  const list = video.value?.audioTracks;
  if (!list || list.length < 2) return;
  audioTracks.value = [...list].map((t, idx) => ({ idx, name: t.label || t.language || `Track ${idx + 1}` }));
  audioIdx.value = Math.max(0, [...list].findIndex(t => t.enabled));
}

function selectAudio() {
  if (hls) { hls.audioTrack = audioIdx.value; return; }
  const list = video.value?.audioTracks;
  if (list) [...list].forEach((t, i) => { t.enabled = i === audioIdx.value; });
}

// ─── Subtitles ───────────────────────────────────────────────────────────────

const originals = new WeakMap();

function buildTracks() {
  const v = video.value;
  for (const t of [...v.querySelectorAll('track')]) t.remove();
  for (const s of item.value.subtitles.filter(x => x.available)) {
    const el = document.createElement('track');
    el.kind = 'subtitles';
    el.label = s.label;
    if (s.lang) el.srclang = s.lang;
    el.src = `${s.url}?v=${subVersion}`;
    el.dataset.id = s.id;
    el.addEventListener('load', () => applyOffset());
    v.appendChild(el);
  }
  selectSub();
}

function selectSub() {
  const v = video.value;
  if (!v) return;
  const els = [...v.querySelectorAll('track')];
  for (const el of els) el.track.mode = el.dataset.id === subId.value ? 'showing' : 'disabled';
  offset.value = 0;
  applyOffset();
}

/** Shift every cue of the showing track by the current offset, in place. */
function applyOffset() {
  const el = [...(video.value?.querySelectorAll('track') || [])].find(t => t.dataset.id === subId.value);
  const cues = el?.track?.cues;
  if (!cues) return;
  const d = offset.value / 1000;
  for (const cue of cues) {
    if (!originals.has(cue)) originals.set(cue, [cue.startTime, cue.endTime]);
    const [s, e] = originals.get(cue);
    cue.startTime = Math.max(0, s + d);
    cue.endTime = Math.max(0.001, e + d);
  }
}

function nudge(ms) {
  offset.value += ms;
  applyOffset();
}

function reloadTracks() {
  subVersion = Date.now();
  const keep = subId.value;
  buildTracks();
  subId.value = keep;
  selectSub();
}

async function saveOffset() {
  subBusy.value = 'save';
  try {
    await watch.shiftSub(props.kind, props.id, subId.value, offset.value);
    notifySuccess(`Saved: subtitles ${offset.value > 0 ? 'later' : 'earlier'} by ${Math.abs(offset.value / 1000).toFixed(2)}s`);
    reloadTracks();
  } catch (err) { notifyError(err.message); }
  finally { subBusy.value = ''; }
}

async function autoSync() {
  subBusy.value = 'sync';
  try {
    const r = await watch.syncSub(props.kind, props.id, subId.value);
    if (r.applied) {
      notifySuccess(`Synced: moved ${(r.offsetMs / 1000).toFixed(2)}s${r.ratio !== 1 ? `, frame-rate corrected` : ''}`);
      reloadTracks();
    } else {
      notifySuccess(`Left as is: ${r.reason}`);
    }
  } catch (err) { notifyError(err.message); }
  finally { subBusy.value = ''; }
}

async function restore() {
  subBusy.value = 'restore';
  try {
    const r = await watch.restoreSub(props.kind, props.id, subId.value);
    notifySuccess(r.restored ? 'Original timing restored' : 'Nothing to restore — this file was never changed');
    if (r.restored) reloadTracks();
  } catch (err) { notifyError(err.message); }
  finally { subBusy.value = ''; }
}

// ─── Progress ────────────────────────────────────────────────────────────────

function onMeta() { applyOffset(); }

function onTime() {
  if (Date.now() - lastReportAt > 10_000) report(false);
}

/** Send the position. On leaving the page, by beacon so it survives the unload. */
function report(force, { beacon = false } = {}) {
  const v = video.value;
  if (!v || !item.value || !attachedUrl) return;
  const pos = v.currentTime;
  const duration = Number.isFinite(v.duration) && pb.value?.complete !== false ? v.duration : (item.value.duration || null);
  if (!pos || (!force && Math.abs(pos - lastReported) < 5)) return;
  lastReported = pos;
  lastReportAt = Date.now();
  const body = { position: pos, duration, at: Date.now() };
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon(`/api/watch/progress/${props.kind}/${props.id}`,
      new Blob([JSON.stringify(body)], { type: 'application/json' }));
    return;
  }
  watch.progress(props.kind, props.id, body).then(p => { if (item.value) item.value.progress = p; }).catch(() => {});
}

function onEnded() {
  report(true);
  if (!item.value?.next) return;
  upNext.value = true;
  countdown.value = 10;
  clearInterval(nextTimer);
  nextTimer = setInterval(() => {
    if (--countdown.value <= 0) { clearInterval(nextTimer); playNext(); }
  }, 1000);
}

function cancelNext() { clearInterval(nextTimer); upNext.value = false; }

function playNext() {
  if (!item.value?.next) return;
  router.replace(`/play/episode/${item.value.next.id}`);
}

function startOver() {
  video.value.currentTime = 0;
  resumedAt.value = 0;
}

async function toggleWatched() {
  try {
    item.value.progress = await watch.setWatched(props.kind, props.id, !item.value.progress?.watched);
  } catch (err) { notifyError(err.message); }
}

async function retry() {
  try {
    pb.value = await watch.reencode(props.kind, props.id);
    startPolling();
  } catch (err) { notifyError(err.message); }
}

function back() {
  if (window.history.length > 1) router.back();
  else router.push(props.kind === 'episode' && item.value ? `/watch/show/${item.value.show_id}` : '/watch');
}

// ─── Keys ────────────────────────────────────────────────────────────────────

function onKey(e) {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const v = video.value;
  if (!v) return;
  const k = e.key;
  if (k === ' ' || k === 'k') { v.paused ? v.play() : v.pause(); }
  else if (k === 'ArrowLeft' || k === 'j') v.currentTime = Math.max(0, v.currentTime - 10);
  else if (k === 'ArrowRight' || k === 'l') v.currentTime += 10;
  else if (k === 'f') (document.fullscreenElement ? document.exitFullscreen() : v.requestFullscreen?.());
  else if (k === 'z') nudge(-250);
  else if (k === 'x') nudge(250);
  else if (k === 'n') playNext();
  else if (k === 'a' && audioTracks.value.length > 1) {
    audioIdx.value = (audioIdx.value + 1) % audioTracks.value.length;
    selectAudio();
    notifySuccess(`Audio: ${audioTracks.value[audioIdx.value].name}`);
  }
  else return;
  e.preventDefault();
}

const onHide = () => report(true, { beacon: true });

onMounted(() => {
  window.addEventListener('pagehide', onHide);
  load();
});
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', onHide);
  teardown();
});
watchRef(() => [props.kind, props.id], load);
</script>

<style scoped>
.player-page { min-height: 100vh; display: flex; flex-direction: column; background: #000; outline: none; }
.bar { display: flex; align-items: center; gap: 14px; padding: 10px 16px; background: var(--bg); }
.heading { min-width: 0; }
.heading .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.heading .s { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stage { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; }
.video { width: 100%; max-height: calc(100vh - 120px); background: #000; }
.msg { color: var(--text); text-align: center; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 40px 16px; }
.msg .small, .small { font-size: 12px; color: var(--muted); }
.err { color: var(--red); }
.warn { color: var(--yellow); }
.prog { width: 280px; max-width: 80vw; height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
.prog div { height: 100%; background: var(--accent); transition: width .5s; }
.toast-resume {
  position: absolute; top: 14px; left: 14px; background: rgba(17, 24, 39, .9); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 6px 10px; font-size: 13px; display: flex; gap: 10px; align-items: center;
}
.upnext {
  position: absolute; right: 18px; bottom: 70px; background: rgba(17, 24, 39, .95); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; max-width: 320px;
}
.upnext .t { font-weight: 600; }
.upnext .row { display: flex; gap: 8px; }
.tools {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; padding: 10px 16px;
  background: var(--bg); border-top: 1px solid var(--border);
}
.sub-pick { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
.sub-pick select {
  background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 5px 8px; font-size: 13px; max-width: 260px;
}
.offset { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.off-val { font-variant-numeric: tabular-nums; min-width: 52px; text-align: center; font-size: 13px; }
.off-val.changed { color: var(--yellow); }
.right { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dl { display: inline-flex; align-items: center; border-radius: var(--radius); }
@media (max-width: 640px) {
  .right { margin-left: 0; }
  .video { max-height: 60vh; }
}
</style>
