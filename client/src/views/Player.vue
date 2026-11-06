<template>
  <div class="player-page" @keydown="onKey" tabindex="-1" ref="page">
    <header class="bar">
      <button class="btn-ghost btn-sm" @click="back">← Back</button>
      <div v-if="item" class="heading">
        <div class="t">{{ item.kind === 'episode' ? item.show_title : item.title }}</div>
        <div v-if="item.kind === 'episode'" class="s">{{ epCode(item) }} · {{ item.title }}</div>
        <div v-else-if="item.year" class="s">{{ item.year }}</div>
      </div>
      <div v-if="item && isAdmin" class="del">
        <button class="btn-ghost btn-sm" :disabled="deleting" aria-haspopup="menu" :aria-expanded="delMenu" @click="delMenu = !delMenu">
          {{ deleting ? 'Deleting…' : 'Delete…' }}</button>
        <div v-if="delMenu" class="del-menu" role="menu">
          <button v-if="pb && pb.plan && pb.plan !== 'direct' && pb.original !== false" role="menuitem" @click="deleteWeb">
            Delete web version<span>The original stays and keeps seeding; it's made again when next played</span>
          </button>
          <button role="menuitem" class="danger" @click="deleteAll">
            Delete from disk<span>The original, its subtitles and the web version. It won't be downloaded again</span>
          </button>
        </div>
      </div>
    </header>

    <div class="stage">
      <div v-if="loading" class="msg">Loading…</div>
      <div v-else-if="fatal" class="msg err">{{ fatal }}</div>

      <div v-else-if="pb?.mode === 'preparing' && !playing" class="msg">
        <template v-if="pb.state === 'failed'">
          <div class="err">Couldn't prepare this for the browser.</div>
          <div class="small">{{ pb.error }}</div>
          <button v-if="isAdmin" class="btn-primary" @click="retry">Try again</button>
          <div v-else class="small">An admin can try again from this page.</div>
        </template>
        <template v-else-if="pb.waiting?.reason === 'space'">
          <div class="err">The disk is nearly full, so this can't be prepared right now.</div>
          <div class="small">{{ gbText(pb.waiting.free) }} free — converting needs at least {{ gbText(pb.waiting.need) }} free.</div>
          <div v-if="isAdmin" class="small">
            Delete web versions or watched items in <RouterLink to="/settings">Settings → Watch library</RouterLink>,
            or lower <em>Keep free</em>. It starts by itself once there is room.
          </div>
          <div v-else class="small">Ask an admin to free some space. It starts by itself once there is room.</div>
        </template>
        <template v-else>
          <div>Preparing for your browser…</div>
          <div class="small">{{ pb.plan === 'remux' ? 'Repackaging' : 'Converting' }} — {{ pb.reason }}</div>
          <div class="prog"><div :style="{ width: Math.round((pb.progress || 0) * 100) + '%' }" /></div>
          <div class="small">{{ statusLine }}</div>
        </template>
        <div v-if="pollTrouble" class="small warn">Can't reach the server — still trying…</div>
      </div>

      <div v-if="notice" class="notice" role="status">{{ notice }}</div>

      <video
        v-show="pb && (playing || pb.mode === 'file' || pb.mode === 'hls')"
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

    <footer v-if="item && pb && (playing || pb.mode === 'file' || pb.mode === 'hls')" class="tools">
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
// Something is attached to the video element. A conversion that stops partway
// must not swap the video for the "preparing" screen while it plays.
const playing = ref(false);
const pollTrouble = ref(false);
const delMenu = ref(false);
const deleting = ref(false);

let hls = null;
let pollTimer = null;
let nextTimer = null;
let lastReported = -1;
let lastReportAt = 0;
let attachedUrl = null;
let subVersion = Date.now();

const currentSub = computed(() => item.value?.subtitles.find(s => s.id === subId.value) || null);

const gbText = (b) => (b == null ? '?' : `${(b / 1e9).toFixed(1)} GB`);
const sizeText = (b) => (b >= 1e9 ? gbText(b) : `${Math.max(1, Math.round((b || 0) / 1e6))} MB`);

/** What the waiting screen says under the progress bar. */
const statusLine = computed(() => {
  const p = pb.value;
  if (!p) return '';
  if (p.state === 'queued') {
    const n = p.waiting?.running || 0;
    return n ? `Waiting for ${n} other conversion${n === 1 ? '' : 's'} someone asked for` : 'Starting…';
  }
  return `${Math.round((p.progress || 0) * 100)}% · playback starts as soon as the first part is ready`;
});

/** Shown over the video when the conversion behind it stops partway. */
const notice = computed(() => {
  const p = pb.value;
  if (!playing.value || !p || p.mode !== 'preparing') return '';
  if (p.state === 'failed') return `Converting stopped: ${p.error || 'unknown error'}. Playback ends where it got to.`;
  if (p.waiting?.reason === 'space') {
    return `Converting stopped: the disk is nearly full (${gbText(p.waiting.free)} free). Playback ends where it got to; it starts again once there is room.`;
  }
  return '';
});

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
    item.value = await watch.item(props.kind, props.id, { play: true });
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
  let misses = 0;
  pollTimer = setInterval(async () => {
    try {
      const p = await watch.playback(props.kind, props.id);
      misses = 0;
      pollTrouble.value = false;
      pb.value = p;
      if (!playing.value && (p.mode === 'hls' || p.mode === 'file')) attach();
      if (p.mode === 'hls' && p.complete) clearInterval(pollTimer);
      if (p.mode === 'preparing' && p.state === 'failed') clearInterval(pollTimer);
    } catch (_) {
      // Three misses in a row (six seconds) is no longer a blip.
      if (++misses >= 3) pollTrouble.value = true;
    }
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
  playing.value = true;
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
  playing.value = false;
  pollTrouble.value = false;
  delMenu.value = false;
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
  prepareNext();
}

let nextRequested = null;

/**
 * Four-fifths of the way through an episode, ask for the next one to be
 * prepared, so it is ready (or well on its way) when this one ends. Asked
 * once per episode; the server ignores it for files that play as they are.
 */
function prepareNext() {
  const v = video.value, next = item.value?.next;
  if (!v || !next || nextRequested === next.id) return;
  const d = Number.isFinite(v.duration) && pb.value?.complete !== false ? v.duration : item.value.duration;
  if (!d || v.currentTime / d < 0.8) return;
  nextRequested = next.id;
  watch.prepare(next.kind || 'episode', next.id, { soon: true }).catch(() => { nextRequested = null; });
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

async function deleteWeb() {
  delMenu.value = false;
  if (!window.confirm('Delete the web version? The original stays and keeps seeding; the web version is made again the next time this is played.')) return;
  deleting.value = true;
  try {
    const r = await watch.deleteWeb(props.kind, props.id);
    notifySuccess(`Web version deleted — ${sizeText(r.freed)} freed`);
    back();
  } catch (err) { notifyError(err.message); }
  finally { deleting.value = false; }
}

async function deleteAll() {
  delMenu.value = false;
  const name = item.value.kind === 'episode' ? `${item.value.show_title} ${epCode(item.value)}` : item.value.title;
  if (!window.confirm(`Delete "${name}" from disk?\n\nThe original file, its subtitles and the web version are removed, and it won't be downloaded again. (Redo in Movies or Shows brings it back.)`)) return;
  deleting.value = true;
  try {
    const r = await watch.deleteAll(props.kind, props.id);
    notifySuccess(`Deleted — ${sizeText(r.freed)} freed`);
    teardown();
    back();
  } catch (err) { notifyError(err.message); }
  finally { deleting.value = false; }
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
  if (e.key === 'Escape' && delMenu.value) { delMenu.value = false; return; }
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
// The delete menu closes on a click anywhere else.
const onDocClick = (e) => { if (delMenu.value && !e.target.closest?.('.del')) delMenu.value = false; };

onMounted(() => {
  window.addEventListener('pagehide', onHide);
  document.addEventListener('click', onDocClick);
  load();
});
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', onHide);
  document.removeEventListener('click', onDocClick);
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
.notice {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2; max-width: min(640px, calc(100% - 32px));
  background: rgba(127, 29, 29, .92); border: 1px solid var(--red); color: #fff;
  border-radius: var(--radius); padding: 8px 12px; font-size: 13px; text-align: center;
}
.del { margin-left: auto; position: relative; }
.del-menu {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 10; width: 300px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  display: flex; flex-direction: column; padding: 4px; box-shadow: 0 8px 24px rgba(0, 0, 0, .4);
}
.del-menu button {
  background: transparent; color: var(--text); text-align: left; padding: 8px 10px;
  display: flex; flex-direction: column; gap: 2px; border-radius: 6px;
}
.del-menu button:hover { background: var(--border); opacity: 1; }
.del-menu button span { font-size: 11px; color: var(--muted); font-weight: 400; }
.del-menu button.danger { color: var(--red); }
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
