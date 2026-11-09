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
          {{ deleting ? 'Working…' : 'Fix or delete…' }}</button>
        <div v-if="delMenu" class="del-menu" role="menu">
          <div v-if="item.release" class="del-release" :title="item.release">From {{ item.release }}</div>
          <button role="menuitem" @click="wrongVideo">
            Wrong video — find another<span>Another show or episode, or a bad copy: it's deleted, never picked again, and another is found</span>
          </button>
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
        v-show="pb && !fatal && (playing || pb.mode === 'file' || pb.mode === 'hls')"
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
      <button v-if="showSkip" class="skip-intro" @click="skipIntro">Skip intro ▸</button>
      <button v-else-if="showSkipCredits" class="skip-intro" @click="skipCredits">Skip credits ▸</button>
      <ScrubBar v-if="playing" :video="video" :thumbs-url="`/api/watch/items/${props.kind}/${props.id}/thumbs.json`" :marks="introMarks" />

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
        <select v-model.number="audioIdx" @change="onAudioPick">
          <option v-for="t in audioTracks" :key="t.idx" :value="t.idx">{{ t.name }}</option>
        </select>
      </label>

      <label class="sub-pick">Subtitles
        <select v-model="subId" @change="onSubMenu">
          <option value="">Off</option>
          <option v-for="s in item.subtitles" :key="s.id" :value="s.id" :disabled="!s.available">
            {{ s.label }}{{ s.available ? '' : ' — not supported' }}
          </option>
        </select>
      </label>

      <!-- Subtitle look, per device: a phone, a laptop and a TV want different sizes. -->
      <div v-if="subId" class="cue-style">
        <button class="btn-ghost btn-sm" :aria-expanded="styleOpen" title="Subtitle size and background" @click="styleOpen = !styleOpen">Aa</button>
        <div v-if="styleOpen" class="cue-menu" role="dialog" aria-label="Subtitle look">
          <div class="cue-row">
            <span class="small">Size</span>
            <button v-for="(v, k) in CUE_SIZES" :key="k" class="btn-ghost btn-sm" :class="{ on: cue.size === k }" @click="cue.size = k">{{ v.label }}</button>
          </div>
          <div class="cue-row">
            <span class="small">Background</span>
            <button v-for="(v, k) in CUE_BGS" :key="k" class="btn-ghost btn-sm" :class="{ on: cue.bg === k }" @click="cue.bg = k">{{ v.label }}</button>
          </div>
        </div>
      </div>

      <div v-if="subId" class="offset">
        <span class="small">Timing</span>
        <button class="btn-ghost btn-sm" title="Subtitles earlier (Z)" @click="nudge(-250)">−¼s</button>
        <span class="off-val" :class="{ changed: offset !== 0 }">{{ offset > 0 ? '+' : '' }}{{ (offset / 1000).toFixed(2) }}s</span>
        <button class="btn-ghost btn-sm" title="Subtitles later (X)" @click="nudge(250)">+¼s</button>
        <template v-if="currentSub?.editable">
          <!-- All three wait on one another: each rewrites the same file. The
               one running says so, so it's clear what the others wait for. -->
          <button v-if="offset !== 0 || subBusy === 'save'" class="btn-ghost btn-sm" :disabled="!!subBusy" @click="saveOffset">
            {{ subBusy === 'save' ? 'Saving…' : 'Save to file' }}</button>
          <button class="btn-ghost btn-sm" :disabled="!!subBusy" :title="subBusy && subBusy !== 'sync' ? 'Waiting for the other change to this file' : 'Align to the audio — takes a little while'" @click="autoSync">
            {{ subBusy === 'sync' ? `Syncing… ${busyFor}s` : 'Auto-sync' }}</button>
          <button class="btn-ghost btn-sm" :disabled="!!subBusy" title="Undo every saved change to this file" @click="restore">
            {{ subBusy === 'restore' ? 'Restoring…' : 'Restore' }}</button>
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
import { ask, current as asking } from '../dialog.js';
import { ref, computed, onMounted, onBeforeUnmount, watch as watchRef, nextTick } from 'vue';
import ScrubBar from '../components/ScrubBar.vue';
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

// ─── Subtitle look ───────────────────────────────────────────────────────────
// Kept per browser (it's about this screen, not the account), and applied as a
// ::cue rule — the one way to style the browser's own subtitle rendering.
const CUE_SIZES = { s: { label: 'S', pct: 80 }, m: { label: 'M', pct: 100 }, l: { label: 'L', pct: 130 }, xl: { label: 'XL', pct: 165 } };
const CUE_BGS = {
  none:   { label: 'None',   css: 'background: transparent; text-shadow: 0 0 3px #000, 0 0 3px #000, 1px 1px 2px #000;' },
  shaded: { label: 'Shaded', css: 'background: rgba(0, 0, 0, .55);' },
  solid:  { label: 'Solid',  css: 'background: rgba(0, 0, 0, .9);' },
};
const CUE_KEY = 'amagnet_cue_style';
const cue = ref((() => {
  try {
    const v = JSON.parse(localStorage.getItem(CUE_KEY) || '{}');
    return { size: CUE_SIZES[v.size] ? v.size : 'm', bg: CUE_BGS[v.bg] ? v.bg : 'shaded' };
  } catch (_) { return { size: 'm', bg: 'shaded' }; }
})());
const styleOpen = ref(false);
let cueStyleEl = null;
function applyCueStyle() {
  if (!cueStyleEl) {
    cueStyleEl = document.createElement('style');
    document.head.appendChild(cueStyleEl);
  }
  cueStyleEl.textContent = `.player-page video::cue { font-size: ${CUE_SIZES[cue.value.size].pct}%; ${CUE_BGS[cue.value.bg].css} }`;
  try { localStorage.setItem(CUE_KEY, JSON.stringify(cue.value)); } catch (_) {}
}
watchRef(cue, applyCueStyle, { deep: true, immediate: true });
// Seconds the running subtitle action has taken, shown while Auto-sync works.
const busyFor = ref(0);
let busyTimer = null;
watchRef(subBusy, (b) => {
  clearInterval(busyTimer);
  busyFor.value = 0;
  if (b) busyTimer = setInterval(() => { busyFor.value++; }, 1000);
});
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
  if (item.value.subs_searching) watchForSubs();
}

// The server is looking for subtitles again (none were found before): pick
// them up if they arrive while this plays.
let subsTimers = [];
let subTouched = false;   // picked or switched off in this player: leave it be
function watchForSubs() {
  subTouched = false;
  const had = new Set(item.value.subtitles.filter(s => s.available).map(s => s.id));
  const forId = `${props.kind}:${props.id}`;
  subsTimers = [20, 60, 120].map(secs => setTimeout(async () => {
    if (`${props.kind}:${props.id}` !== forId || !item.value) return;
    let fresh;
    try { fresh = await watch.item(props.kind, props.id); } catch (_) { return; }
    if (!fresh.subtitles.some(s => s.available && !had.has(s.id))) return;
    subsTimers.forEach(clearTimeout);
    item.value.subtitles = fresh.subtitles;
    // Nothing on yet and not switched off for this show: show the new ones.
    if (!subId.value && !subTouched && !item.value.remembered?.sub_off) subId.value = fresh.subtitles.find(s => s.default)?.id || '';
    if (video.value) buildTracks();
    notifySuccess('Subtitles found');
  }, secs * 1000));
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
    // An HEVC web version (Settings → Playback → Web version video) plays
    // only where the browser decodes HEVC: say so plainly, instead of a black
    // screen or a cryptic media error.
    const codec = pb.value.codec || 'h264';
    if (codec.startsWith('hevc') && !canPlayHevc(codec === 'hevc10', v)) {
      playing.value = false;
      attachedUrl = null;
      fatal.value = `This is HEVC${codec === 'hevc10' ? ' (10-bit)' : ''} video, which this browser can't play. `
        + 'Safari, and Chrome or Edge on a computer with hardware HEVC decoding, can — and so can the Android app.';
      return;
    }
    if (!pb.value.complete) startPolling();
    if (Hls.isSupported()) {
      // enableCEA708Captions: closed captions some WEB releases carry inside
      // the video stream would be a second, unlisted English track — and,
      // turned on, every line twice. The subtitles menu is the one list.
      hls = new Hls({ startPosition: start || 0, maxBufferLength: 60, enableCEA708Captions: false });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else fatal.value = `Playback failed: ${data.details}`;
      });
      // Every audio track of the file is an alternative rendition.
      const syncAudio = () => {
        audioTracks.value = hls.audioTracks.map((t, idx) => ({ idx, lang: t.lang, name: t.name || t.lang || `Track ${idx + 1}` }));
        if (preferAudio()) return;
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

/** Whether this browser decodes HEVC (Main, or Main 10) from fMP4: through MSE, or Safari's own HLS. */
function canPlayHevc(tenBit, v) {
  const type = `video/mp4; codecs="${tenBit ? 'hvc1.2.4.L123.B0' : 'hvc1.1.6.L123.B0'}"`;
  try {
    if (window.MediaSource?.isTypeSupported?.(type)) return true;
    if (window.ManagedMediaSource?.isTypeSupported?.(type)) return true;
  } catch (_) { /* treated as no */ }
  return !!v?.canPlayType?.(type);
}

function teardown() {
  report(true);
  subsTimers.forEach(clearTimeout);
  subsTimers = [];
  clearInterval(pollTimer);
  clearInterval(nextTimer);
  if (hls) { hls.destroy(); hls = null; }
  attachedUrl = null;
  playing.value = false;
  pollTrouble.value = false;
  delMenu.value = false;
  audioTracks.value = [];
  audioPreferred = false;
  creditsReached = false;
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
  audioTracks.value = [...list].map((t, idx) => ({ idx, lang: t.language, name: t.label || t.language || `Track ${idx + 1}` }));
  audioIdx.value = Math.max(0, [...list].findIndex(t => t.enabled));
  preferAudio();
}

function selectAudio() {
  if (hls) { hls.audioTrack = audioIdx.value; return; }
  const list = video.value?.audioTracks;
  if (list) [...list].forEach((t, i) => { t.enabled = i === audioIdx.value; });
}

// The web version's default track is the server's language. This person may
// want another — their own list, or what they picked for this show before —
// so once the tracks are known, switch to the first of theirs it has. Once per
// file: after that, what they pick stands.
let audioPreferred = false;
function preferAudio() {
  if (audioPreferred || audioTracks.value.length < 2) return false;
  audioPreferred = true;
  const want = (item.value?.audio_langs || []).map(l => String(l).toLowerCase());
  const at = want.map(l => audioTracks.value.findIndex(t => String(t.lang || '').toLowerCase() === l)).find(i => i >= 0);
  if (at === undefined || at === audioIdx.value) return false;
  audioIdx.value = at;
  selectAudio();
  return true;
}

/** The menu (or the A key): switch, and remember the language for this show. */
function onAudioPick() {
  selectAudio();
  const lang = audioTracks.value[audioIdx.value]?.lang;
  if (lang) watch.choice(props.kind, props.id, { audio_lang: String(lang).toLowerCase() }).catch(() => {});
}

// ─── Subtitles ───────────────────────────────────────────────────────────────

const originals = new WeakMap();

function buildTracks() {
  const v = video.value;
  ownChoiceUntil = Date.now() + 3000;
  for (const t of [...v.querySelectorAll('track')]) t.remove();
  for (const s of item.value.subtitles.filter(x => x.available)) {
    const el = document.createElement('track');
    el.kind = 'subtitles';
    el.label = s.label;
    if (s.lang) el.srclang = s.lang;
    el.src = `${s.url}?v=${subVersion}`;
    el.dataset.id = s.id;
    el.addEventListener('load', () => {
      // Loading a track is another moment the browser picks one by itself.
      ownChoiceUntil = Math.max(ownChoiceUntil, Date.now() + 1000);
      applyOffset();
    });
    v.appendChild(el);
  }
  selectSub();
}

function selectSub() {
  const v = video.value;
  if (!v) return;
  showOnly(trackFor(subId.value));
  offset.value = 0;
  applyOffset();
}

let shownTrack = null;
// Until then, a track turning on is the browser's doing, not the viewer's.
let ownChoiceUntil = 0;

function trackFor(id) {
  return [...(video.value?.querySelectorAll('track') || [])].find(el => el.dataset.id === id)?.track || null;
}

/** Every text track off but this one: captions in the video stream and the browser's CC menu included. */
function showOnly(track) {
  for (const t of [...(video.value?.textTracks || [])]) {
    const mode = t === track ? 'showing' : 'disabled';
    if (t.mode !== mode) t.mode = mode;
  }
  shownTrack = track;
}

/**
 * At most one subtitle track shows. A second can be turned on behind the
 * menu's back — the browser's CC button, or a track the browser adds itself —
 * and then both show, every line twice. The newest choice wins, and the menu
 * follows it.
 */
function onTextTracksChange() {
  const v = video.value;
  if (!v) return;
  const showing = [...v.textTracks].filter(t => t.mode === 'showing');
  // Tracks just (re)built: the browser picks one by its own language
  // preferences as they arrive. That isn't a choice — the menu's stands.
  if (Date.now() < ownChoiceUntil) {
    const mine = trackFor(subId.value);
    if (showing.length !== (mine ? 1 : 0) || (mine && showing[0] !== mine)) showOnly(mine);
    return;
  }
  if (showing.length === 0) {
    shownTrack = null;
    if (subId.value) subId.value = '';
    return;
  }
  const pick = showing.find(t => t !== shownTrack) || showing[0];
  for (const t of showing) if (t !== pick) t.mode = 'disabled';
  if (pick === shownTrack) return;
  shownTrack = pick;
  const id = [...v.querySelectorAll('track')].find(el => el.track === pick)?.dataset.id || '';
  if (id !== subId.value) {
    subId.value = id;
    offset.value = 0;
    applyOffset();
    rememberSub();   // picked in the browser's own CC menu: a choice like any other
  }
}

function onSubMenu() {
  selectSub();
  rememberSub();
}

/** Remember the subtitle language picked (or Off) for this show. */
function rememberSub() {
  subTouched = true;
  const s = currentSub.value;
  if (!subId.value) watch.choice(props.kind, props.id, { sub_off: true }).catch(() => {});
  else if (s?.lang) watch.choice(props.kind, props.id, { sub_lang: s.lang }).catch(() => {});
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
      notifySuccess(`Synced: moved ${(r.offsetMs / 1000).toFixed(2)}s${r.ratio !== 1 ? ', frame-rate corrected' : ''}`
        + `${r.refined ? `, fine-tuned along the way (up to ${(r.maxCorrectionMs / 1000).toFixed(1)}s)` : ''}`);
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

// ─── Skip intro ──────────────────────────────────────────────────────────────
const now = ref(0);
const intro = computed(() => item.value?.intro || null);
const credits = computed(() => item.value?.credits || null);
const introMarks = computed(() => [
  ...(intro.value ? [{ start: intro.value.start, end: intro.value.end, label: 'Intro' }] : []),
  ...(credits.value ? [{ start: credits.value.start, end: credits.value.end, label: 'Credits' }] : []),
]);
// From its start until a couple of seconds before it ends.
const showSkip = computed(() => !!intro.value && now.value >= intro.value.start && now.value < intro.value.end - 2);
function skipIntro() {
  if (video.value && intro.value) video.value.currentTime = intro.value.end;
}

// ─── End credits ─────────────────────────────────────────────────────────────
// Found by comparing episodes (intro.js). With a next episode, "Up next" starts
// counting down when the credits do, not when the file ends. Without one,
// "Skip credits" — only when something follows them (a scene after the credits).
let creditsReached = false;
// More than a logo after the credits: a scene, so don't move on at the credits.
const sceneAfterCredits = () => {
  const c = credits.value, d = video.value?.duration;
  return !!c && Number.isFinite(d) && d - c.end > 20;
};
const showSkipCredits = computed(() => {
  const c = credits.value;
  return !!c && now.value >= c.start && now.value < c.end - 2 && sceneAfterCredits();
});
function skipCredits() {
  if (video.value && credits.value) video.value.currentTime = credits.value.end;
}
function watchCredits() {
  const c = credits.value;
  if (!c) return;
  if (now.value < c.start - 1) {
    // Went back before the credits: no countdown any more.
    if (creditsReached) { creditsReached = false; if (upNext.value) cancelNext(); }
  } else if (!creditsReached && now.value >= c.start) {
    creditsReached = true;
    if (item.value?.next && !sceneAfterCredits()) startUpNext();
  }
}

function onTime() {
  now.value = video.value?.currentTime || 0;
  watchCredits();
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
  if (!item.value?.next || upNext.value) return;
  startUpNext();
}

function startUpNext() {
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

async function wrongVideo() {
  delMenu.value = false;
  const name = item.value.kind === 'episode' ? `${item.value.show_title} ${epCode(item.value)}` : item.value.title;
  const reason = await ask({
    title: `What's wrong with "${name}"?`, confirmLabel: 'Find another',
    message: 'It is deleted (file, subtitles, web version), this release is never picked for it again, and another is looked for.',
    details: item.value.release ? [item.value.release] : [],
    input: { value: 'another show', placeholder: 'e.g. another show, wrong episode, bad quality' },
  });
  if (reason === null) return;
  // It came in a pack: the whole pack is likely wrong too.
  let pack = false;
  if (item.value.pack_size > 1) {
    const which = await ask({
      title: `It came in a pack of ${item.value.pack_size} episodes`,
      message: 'Replace the whole pack — every episode in it — or only this one?',
      details: item.value.release ? [item.value.release] : [],
      choices: [{ label: 'Only this one', value: 'one' }, { label: 'The whole pack', value: 'pack', danger: true }],
    });
    if (which === null) return;
    pack = which === 'pack';
  }
  deleting.value = true;
  try {
    const r = await watch.wrong(props.kind, props.id, reason.trim() || 'the wrong video', pack);
    notifySuccess(pack ? `Deleted ${r.count} episodes — looking for others.` : 'Deleted — looking for another release. It appears here once it has downloaded.');
    teardown();
    back();
  } catch (err) { notifyError(err.message); }
  finally { deleting.value = false; }
}

async function deleteWeb() {
  delMenu.value = false;
  if (!(await ask({ title: 'Delete the web version?', confirmLabel: 'Delete',
    message: 'The original stays and keeps seeding; the web version is made again the next time this is played.' }))) return;
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
  if (!(await ask({ title: `Delete "${name}" from disk?`, confirmLabel: 'Delete from disk',
    message: "The original file, its subtitles and the web version are removed, and it won't be downloaded again. (Redo in Movies or Shows brings it back.)" }))) return;
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
  if (asking.value || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
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
  else if (k === 's' && showSkip.value) skipIntro();
  else if (k === 's' && showSkipCredits.value) skipCredits();
  else if (k === 'a' && audioTracks.value.length > 1) {
    audioIdx.value = (audioIdx.value + 1) % audioTracks.value.length;
    onAudioPick();
    notifySuccess(`Audio: ${audioTracks.value[audioIdx.value].name}`);
  }
  else return;
  e.preventDefault();
}

const onHide = () => report(true, { beacon: true });
// The delete menu closes on a click anywhere else.
const onDocClick = (e) => {
  if (delMenu.value && !e.target.closest?.('.del')) delMenu.value = false;
  if (styleOpen.value && !e.target.closest?.('.cue-style')) styleOpen.value = false;
};

onMounted(() => {
  window.addEventListener('pagehide', onHide);
  document.addEventListener('click', onDocClick);
  video.value?.textTracks.addEventListener('change', onTextTracksChange);
  load();
});
onBeforeUnmount(() => {
  window.removeEventListener('pagehide', onHide);
  document.removeEventListener('click', onDocClick);
  video.value?.textTracks.removeEventListener('change', onTextTracksChange);
  clearInterval(busyTimer);
  cueStyleEl?.remove();
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
.stage { position: relative; flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 0; }
.video { width: 100%; max-height: calc(100vh - 150px); background: #000; }
.skip-intro {
  position: absolute; right: 24px; bottom: 120px; z-index: 3;
  background: rgba(20, 20, 20, .85); color: #fff; border: 1px solid rgba(255, 255, 255, .5);
  padding: 10px 18px; font-size: 14px; font-weight: 600; border-radius: 6px; cursor: pointer;
}
.skip-intro:hover { background: #fff; color: #000; }
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
.del-release {
  padding: 8px 12px 6px; font-size: 11px; color: var(--muted); font-family: ui-monospace, monospace;
  max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-bottom: 1px solid var(--border);
}
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
.cue-style { position: relative; }
.cue-menu {
  position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 5; display: flex; flex-direction: column; gap: 8px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .4); white-space: nowrap;
}
.cue-row { display: flex; align-items: center; gap: 6px; }
.cue-row .small { width: 76px; color: var(--muted); }
.cue-row .on { color: var(--text); border-color: var(--accent); }
.off-val { font-variant-numeric: tabular-nums; min-width: 52px; text-align: center; font-size: 13px; }
.off-val.changed { color: var(--yellow); }
.right { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dl { display: inline-flex; align-items: center; border-radius: var(--radius); }
@media (max-width: 640px) {
  .right { margin-left: 0; }
  .video { max-height: 60vh; }
}
</style>
