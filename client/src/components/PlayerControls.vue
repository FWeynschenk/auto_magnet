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
      <div class="vol">
        <button class="ic" :aria-label="muted ? 'Unmute (M)' : 'Mute (M)'" :title="muted ? 'Unmute (M)' : 'Mute (M)'" @mousedown.prevent @click="toggleMute">
          <svg v-if="muted || volume === 0" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z" /></svg>
          <svg v-else viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" /></svg>
        </button>
        <input class="vol-slider" type="range" min="0" max="1" step="0.05" :value="muted ? 0 : volume" aria-label="Volume"
          @input="setVolume(Number($event.target.value))" @keydown.stop @pointerup="$event.target.blur()" />
        <!-- The slider takes the mouse as it is (a held-back mousedown, as the
             buttons have, is a slider that can't be dragged), and lets go of
             focus once the mouse is up, so Space and the arrows are the
             player's again. -->
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
      <span class="crop-wrap">
        <button class="ic" :class="{ on: crop !== 'fit' || loudness !== 'off' }" aria-haspopup="menu" :aria-expanded="cropOpen"
          :aria-label="`Picture and sound: ${CROP_LABEL[crop]}, ${LOUD_LABEL[loudness]}`"
          :title="`Picture: ${CROP_LABEL[crop]} (R) · Sound: ${LOUD_LABEL[loudness]}`"
          @mousedown.prevent @click="cropOpen = !cropOpen">
          <svg viewBox="0 0 24 24"><path d="M3 17v2h6v-2zM3 5v2h10V5zm10 16v-2h8v-2h-8v-2h-2v6zM7 9v2H3v2h4v2h2V9zm14 4v-2H11v2zm-6-4h2V7h4V5h-4V3h-2z" /></svg>
        </button>
        <div v-if="cropOpen" ref="cropMenu" class="crop-menu" role="menu" aria-label="Picture and sound">
          <div class="crop-head">Picture <span>R</span></div>
          <button v-for="m in CROP_MODES" :key="m" role="menuitemradio" :aria-checked="crop === m" :class="{ sel: crop === m }"
            @mousedown.prevent @click="pick(m)">
            <span class="tick">{{ crop === m ? '✓' : '' }}</span>
            <span class="lbl">{{ CROP_LABEL[m] }}<small>{{ CROP_HINT[m] }}</small></span>
          </button>
          <div class="crop-head">Sound</div>
          <button v-for="m in LOUD_MODES" :key="m" role="menuitemradio" :aria-checked="loudness === m" :class="{ sel: loudness === m }"
            @mousedown.prevent @click="pickLoud(m)">
            <span class="tick">{{ loudness === m ? '✓' : '' }}</span>
            <span class="lbl">{{ LOUD_LABEL[m] }}<small>{{ LOUD_HINT[m] }}</small></span>
          </button>
        </div>
      </span>
      <button v-if="pipOk" class="ic pip" aria-label="Picture in picture" title="Picture in picture" @mousedown.prevent @click="togglePip">
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
  crop: { type: String, default: 'fit' },
  loudness: { type: String, default: 'off' },
});
const emit = defineEmits(['fullscreen', 'subs', 'next', 'crop', 'loudness']);

// How loud and quiet scenes compare: as the film has it, or closer together.
const LOUD_MODES = ['off', 'even', 'night'];
const LOUD_LABEL = { off: 'As made', even: 'Even out', night: 'Night' };
const LOUD_HINT = {
  off: 'Loud scenes as loud as the film makes them',
  even: 'Loud scenes turned down, quiet speech up',
  night: 'Loud and quiet close together — for low volume or a sleeping house',
};
function pickLoud(m) { cropOpen.value = false; emit('loudness', m); }

// How the picture fills the screen. Chosen in the player, remembered by it.
const CROP_MODES = ['fit', 'fill', 'zoom', 'stretch'];
const CROP_LABEL = { fit: 'Fit', fill: 'Fill screen', zoom: 'Zoom', stretch: 'Stretch' };
const CROP_HINT = {
  fit: 'The whole picture; black bars where its shape isn\'t the screen\'s',
  fill: 'No black bars: the edges that don\'t fit are cut off',
  zoom: 'For black bars that are part of the picture itself',
  stretch: 'No black bars, nothing cut off — the picture is pulled out of shape',
};
const cropOpen = ref(false);
const cropMenu = ref(null);
function pick(m) { cropOpen.value = false; emit('crop', m); }
// A click anywhere else closes the menu — on the click, not the press, so the
// player can still see the menu was open and not take that click as a pause.
function onDocDown(e) {
  if (cropOpen.value && !e.target.closest?.('.crop-wrap')) cropOpen.value = false;
}

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
onMounted(() => { bind(props.video, true); sync(); document.addEventListener('click', onDocDown, true); });
onBeforeUnmount(() => { bind(props.video, false); document.removeEventListener('click', onDocDown, true); });

defineExpose({ toggle, skip, toggleMute, setVolume, closeMenus: () => { cropOpen.value = false; } });
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
.crop-wrap { position: relative; display: inline-flex; }
.crop-menu {
  position: absolute; right: 0; bottom: calc(100% + 10px); z-index: 5; width: 280px;
  background: rgba(20, 20, 24, .96); border: 1px solid rgba(255, 255, 255, .15); border-radius: 8px;
  padding: 4px; display: flex; flex-direction: column; box-shadow: 0 8px 24px rgba(0, 0, 0, .5);
}
.crop-head { color: rgba(255, 255, 255, .6); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; padding: 6px 10px 4px; display: flex; justify-content: space-between; }
.crop-head span { text-transform: none; letter-spacing: 0; border: 1px solid rgba(255, 255, 255, .3); border-radius: 3px; padding: 0 4px; }
.crop-head:not(:first-child) { border-top: 1px solid rgba(255, 255, 255, .12); margin-top: 4px; padding-top: 8px; }
.crop-menu { max-height: calc(100vh - 120px); overflow-y: auto; }
.crop-menu button {
  background: transparent; border: 0; color: #fff; text-align: left; cursor: pointer;
  display: flex; gap: 8px; align-items: flex-start; padding: 7px 10px; border-radius: 6px; font-size: 14px;
}
.crop-menu button:hover { background: rgba(255, 255, 255, .12); opacity: 1; }
.crop-menu .tick { width: 14px; flex-shrink: 0; color: var(--accent); }
.crop-menu .lbl { display: flex; flex-direction: column; gap: 2px; }
.crop-menu small { color: rgba(255, 255, 255, .6); font-size: 12px; line-height: 1.3; font-weight: 400; }
.crop-menu .sel .lbl { font-weight: 600; }
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
/* A phone's width holds all but one: picture-in-picture, the one a phone
   offers by itself when the app is left. */
@media (max-width: 480px) {
  .pip { display: none; }
  .row { gap: 0; }
}
</style>
