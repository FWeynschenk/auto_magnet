<template>
  <!-- The player's own controls, over the bottom of the video. They replace
       the browser's: with both, Space reached the video twice — the browser
       toggled play and the page's shortcut toggled it back. -->
  <div class="controls" :class="{ big: fullscreen }" @click.stop @dblclick.stop>
    <ScrubBar :video="video" :thumbs-url="thumbsUrl" :marks="marks" />
    <div class="row">
      <button class="ic" :aria-label="paused ? 'Play (Space)' : 'Pause (Space)'" :title="paused ? 'Play (Space)' : 'Pause (Space)'"
        @mousedown.prevent @click="toggle">
        <svg v-if="paused" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
        <svg v-else viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
      </button>
      <button class="ic" aria-label="Back 10 seconds (←)" title="Back 10 s (←)" @mousedown.prevent @click="skip(-10)">
        <svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" /><text x="12" y="16.5" text-anchor="middle">10</text></svg>
      </button>
      <button class="ic" aria-label="Forward 10 seconds (→)" title="Forward 10 s (→)" @mousedown.prevent @click="skip(10)">
        <svg viewBox="0 0 24 24"><path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z" /><text x="12" y="16.5" text-anchor="middle">10</text></svg>
      </button>
      <div class="vol" @mousedown.prevent>
        <button class="ic" :aria-label="muted ? 'Unmute (M)' : 'Mute (M)'" :title="muted ? 'Unmute (M)' : 'Mute (M)'" @click="toggleMute">
          <svg v-if="muted || volume === 0" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z" /></svg>
          <svg v-else viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" /></svg>
        </button>
        <input class="vol-slider" type="range" min="0" max="1" step="0.05" :value="muted ? 0 : volume" aria-label="Volume"
          @input="setVolume(Number($event.target.value))" @keydown.stop />
      </div>
      <span class="time">{{ fmt(current) }} <span class="dim">/ {{ fmt(duration) }}</span></span>

      <span class="spacer" />

      <button v-if="hasNext" class="ic" aria-label="Next episode (N)" title="Next episode (N)" @mousedown.prevent @click="$emit('next')">
        <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6zm10-12h2v12h-2z" /></svg>
      </button>
      <button v-if="subsAvailable" class="ic" :class="{ on: subsOn }" :aria-pressed="subsOn" :aria-label="subsOn ? 'Subtitles off (C)' : 'Subtitles on (C)'"
        :title="subsOn ? 'Subtitles off (C)' : 'Subtitles on (C)'" @mousedown.prevent @click="$emit('subs')">
        <svg viewBox="0 0 24 24"><path d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1z" /></svg>
      </button>
      <button v-if="pipOk" class="ic" aria-label="Picture in picture" title="Picture in picture" @mousedown.prevent @click="togglePip">
        <svg viewBox="0 0 24 24"><path d="M19 7h-8v6h8zm2-4H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H3V5h18z" /></svg>
      </button>
      <button class="ic" :aria-label="fullscreen ? 'Exit full screen (F)' : 'Full screen (F)'" :title="fullscreen ? 'Exit full screen (F)' : 'Full screen (F)'"
        @mousedown.prevent @click="$emit('fullscreen')">
        <svg v-if="fullscreen" viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z" /></svg>
        <svg v-else viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z" /></svg>
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import ScrubBar from './ScrubBar.vue';

const props = defineProps({
  video: { type: Object, default: null },
  thumbsUrl: { type: String, default: '' },
  marks: { type: Array, default: () => [] },
  fullscreen: { type: Boolean, default: false },
  subsAvailable: { type: Boolean, default: false },
  subsOn: { type: Boolean, default: false },
  hasNext: { type: Boolean, default: false },
});
defineEmits(['fullscreen', 'subs', 'next']);

const paused = ref(true);
const current = ref(0);
const duration = ref(0);
const volume = ref(1);
const muted = ref(false);
const pipOk = typeof document !== 'undefined' && !!document.pictureInPictureEnabled;

const fmt = (s) => {
  if (!Number.isFinite(s)) return '0:00';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};

function sync() {
  const v = props.video;
  if (!v) return;
  paused.value = v.paused;
  current.value = v.currentTime || 0;
  duration.value = Number.isFinite(v.duration) ? v.duration : 0;
  volume.value = v.volume;
  muted.value = v.muted;
}

function toggle() {
  const v = props.video;
  if (!v) return;
  if (v.paused) v.play().catch(() => {}); else v.pause();
}
function skip(s) {
  const v = props.video;
  if (v) v.currentTime = Math.max(0, Math.min((v.duration || Infinity) - 0.5, v.currentTime + s));
}
function setVolume(x) {
  const v = props.video;
  if (!v) return;
  v.volume = Math.max(0, Math.min(1, x));
  v.muted = v.volume === 0;
}
function toggleMute() {
  const v = props.video;
  if (!v) return;
  v.muted = !v.muted;
  if (!v.muted && v.volume === 0) v.volume = 0.5;
}
async function togglePip() {
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await props.video?.requestPictureInPicture();
  } catch (_) { /* not allowed here */ }
}

const EVENTS = ['play', 'pause', 'timeupdate', 'durationchange', 'loadedmetadata', 'volumechange', 'seeked', 'ended'];
function bind(v, on) { for (const e of EVENTS) v?.[on ? 'addEventListener' : 'removeEventListener'](e, sync); }
watch(() => props.video, (v, old) => { bind(old, false); bind(v, true); sync(); });
onMounted(() => { bind(props.video, true); sync(); });
onBeforeUnmount(() => bind(props.video, false));

defineExpose({ toggle, skip, toggleMute, setVolume });
</script>

<style scoped>
.controls {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 3;
  padding: 28px 8px 6px;
  background: linear-gradient(to top, rgba(0, 0, 0, .85), rgba(0, 0, 0, .45) 60%, transparent);
  transition: opacity .2s;
}
.row { display: flex; align-items: center; gap: 2px; padding: 0 4px; }
.ic {
  background: transparent; border: 0; padding: 6px; border-radius: 6px; color: #fff;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
}
.ic:hover { background: rgba(255, 255, 255, .14); opacity: 1; }
.ic:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.ic svg { width: 24px; height: 24px; fill: currentColor; }
.ic svg text { font-size: 7px; font-weight: 700; fill: currentColor; font-family: system-ui, sans-serif; }
.ic.on { color: var(--accent); }
.vol { display: flex; align-items: center; }
.vol-slider { width: 0; opacity: 0; transition: width .15s, opacity .15s; accent-color: #fff; margin: 0; }
.vol:hover .vol-slider, .vol:focus-within .vol-slider { width: 80px; opacity: 1; margin: 0 6px 0 2px; }
.time { color: #fff; font-size: 13px; font-variant-numeric: tabular-nums; margin-left: 8px; white-space: nowrap; }
.dim { color: rgba(255, 255, 255, .65); }
.spacer { flex: 1; }
/* Full screen is usually a big screen seen from further away: bigger targets. */
.big { padding: 36px 16px 12px; }
.big .row { gap: 6px; }
.big .ic { padding: 9px; }
.big .ic svg { width: 32px; height: 32px; }
.big .time { font-size: 16px; margin-left: 12px; }
.big :deep(.track) { height: 7px; }
.big :deep(.scrub:hover .track) { height: 11px; }
@media (max-width: 640px) {
  .ic { padding: 5px; }
  .ic svg { width: 22px; height: 22px; }
  .vol-slider { display: none; }
}
</style>
