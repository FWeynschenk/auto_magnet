<template>
  <!-- A timeline under the video that shows where a drag will land. The
       browser's own controls can't show previews, so this sits beside them. -->
  <div
    v-if="duration > 0"
    ref="bar"
    class="scrub"
    role="slider"
    aria-label="Seek"
    :aria-valuemin="0"
    :aria-valuemax="Math.round(duration)"
    :aria-valuenow="Math.round(current)"
    :aria-valuetext="fmt(current)"
    tabindex="-1"
    @pointermove="onMove"
    @pointerleave="hover = null"
    @pointerdown="onDown"
  >
    <div class="track">
      <div class="buffered" :style="{ width: `${pct(buffered)}%` }" />
      <div class="played" :style="{ width: `${pct(current)}%` }" />
      <div v-for="(m, i) in marks" :key="i" class="mark" :style="{ left: `${pct(m.start)}%`, width: `${pct(m.end) - pct(m.start)}%` }" :title="m.label" />
    </div>
    <div v-if="hover !== null" class="tip" :style="{ left: `${tipLeft}px` }">
      <div v-if="thumb" class="thumb" :style="thumb" />
      <div class="time">{{ fmt(hover) }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';

const props = defineProps({
  video: { type: Object, default: null },      // the <video> element
  thumbsUrl: { type: String, default: '' },     // …/thumbs.json
  marks: { type: Array, default: () => [] },    // [{ start, end, label }] e.g. the intro
});

const bar = ref(null);
const duration = ref(0);
const current = ref(0);
const buffered = ref(0);
const hover = ref(null);
const hoverX = ref(0);
const index = ref(null);
let dragging = false;
let retry = null;

const pct = (t) => (duration.value ? Math.max(0, Math.min(100, (t / duration.value) * 100)) : 0);
const fmt = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};

const tipLeft = computed(() => {
  const w = bar.value?.clientWidth || 0;
  const half = (index.value?.w || 60) / 2 + 6;
  return Math.max(half, Math.min(w - half, hoverX.value));
});

const thumb = computed(() => {
  const ix = index.value;
  if (!ix || hover.value === null) return null;
  const i = Math.min(ix.count - 1, Math.max(0, Math.floor(hover.value / ix.interval)));
  const per = ix.cols * ix.rows;
  const sheet = Math.floor(i / per) + 1;
  const cell = i % per;
  return {
    width: `${ix.w}px`, height: `${ix.h}px`,
    backgroundImage: `url(${ix.url}${sheet}.jpg${ix.v ? `?v=${ix.v}` : ''})`,
    backgroundPosition: `-${(cell % ix.cols) * ix.w}px -${Math.floor(cell / ix.cols) * ix.h}px`,
    backgroundSize: `${ix.cols * ix.w}px ${ix.rows * ix.h}px`,
  };
});

function timeAt(e) {
  // Measured on the track, inside the bar's padding; the tip is placed in the bar.
  const tr = bar.value.querySelector('.track').getBoundingClientRect();
  const br = bar.value.getBoundingClientRect();
  const x = Math.max(0, Math.min(tr.width, e.clientX - tr.left));
  hoverX.value = x + (tr.left - br.left);
  return (x / tr.width) * duration.value;
}
function onMove(e) {
  hover.value = timeAt(e);
  if (dragging) props.video.currentTime = hover.value;
}
function onDown(e) {
  if (!props.video) return;
  dragging = true;
  bar.value.setPointerCapture?.(e.pointerId);
  props.video.currentTime = timeAt(e);
  const up = () => { dragging = false; window.removeEventListener('pointerup', up); };
  window.addEventListener('pointerup', up);
}

function sync() {
  const v = props.video;
  if (!v) return;
  duration.value = Number.isFinite(v.duration) ? v.duration : 0;
  current.value = v.currentTime || 0;
  const b = v.buffered;
  buffered.value = b?.length ? b.end(b.length - 1) : 0;
}

async function loadIndex(tries = 0) {
  clearTimeout(retry);
  index.value = null;
  if (!props.thumbsUrl) return;
  try {
    const r = await fetch(props.thumbsUrl, { credentials: 'same-origin' });
    const j = r.ok ? await r.json() : null;
    if (j && !j.pending) { index.value = j; return; }
  } catch (_) { /* no previews; the bar still seeks */ }
  // Being made: look again a little later, for a while.
  if (tries < 12) retry = setTimeout(() => loadIndex(tries + 1), 20_000);
}

const EVENTS = ['timeupdate', 'durationchange', 'progress', 'loadedmetadata', 'seeked'];
function bind(v, on) { for (const e of EVENTS) v?.[on ? 'addEventListener' : 'removeEventListener'](e, sync); }

watch(() => props.video, (v, old) => { bind(old, false); bind(v, true); sync(); });
watch(() => props.thumbsUrl, () => loadIndex());
onMounted(() => { bind(props.video, true); sync(); loadIndex(); });
onBeforeUnmount(() => { bind(props.video, false); clearTimeout(retry); });
</script>

<style scoped>
.scrub { position: relative; align-self: stretch; padding: 8px 12px; cursor: pointer; touch-action: none; user-select: none; }
.track { position: relative; height: 5px; background: var(--border); border-radius: 3px; overflow: hidden; transition: height .1s; }
.scrub:hover .track { height: 8px; }
.buffered { position: absolute; inset: 0 auto 0 0; background: color-mix(in srgb, var(--text) 25%, transparent); }
.played { position: absolute; inset: 0 auto 0 0; background: var(--accent); }
.mark { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--yellow) 70%, transparent); }
.tip {
  position: absolute; bottom: calc(100% + 2px); transform: translateX(-50%); pointer-events: none; z-index: 4;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
}
.thumb { border: 2px solid var(--text); border-radius: 4px; background-color: #000; background-repeat: no-repeat; box-shadow: 0 4px 16px rgba(0, 0, 0, .5); }
.time { background: rgba(0, 0, 0, .8); color: #fff; font-size: 12px; padding: 2px 6px; border-radius: 3px; font-variant-numeric: tabular-nums; }
</style>
