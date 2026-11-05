<template>
  <RouterLink :to="to" class="wcard" :class="{ wide }">
    <div class="art">
      <img v-if="image" :src="image" :alt="''" loading="lazy" />
      <div v-else class="art-fallback">{{ initials }}</div>
      <span v-if="item.progress?.watched" class="badge watched" title="Watched">✓</span>
      <span v-else-if="badge" class="badge">{{ badge }}</span>
      <div v-if="pct > 0 && !item.progress?.watched" class="bar"><div :style="{ width: pct + '%' }" /></div>
    </div>
    <div class="meta">
      <div class="title" :title="title">{{ title }}</div>
      <div class="sub">{{ sub }}</div>
    </div>
  </RouterLink>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  item: { type: Object, required: true },
  // Episodes in "next up" read better as a 16:9 still than as the show poster.
  wide: { type: Boolean, default: false },
  // A show tile (from /watch/shows) rather than a playable item.
  show: { type: Boolean, default: false },
});

const ep = (i) => `S${String(i.season).padStart(2, '0')}E${String(i.episode).padStart(2, '0')}`;

const to = computed(() => (props.show ? `/watch/show/${props.item.id}` : `/play/${props.item.kind}/${props.item.id}`));
const image = computed(() => (props.wide && props.item.still_url) || props.item.poster_url || null);
const title = computed(() => (props.show || props.item.kind === 'movie') ? props.item.title : props.item.show_title);
const sub = computed(() => {
  const i = props.item;
  if (props.show) return i.unwatched > 0 ? `${i.unwatched} unwatched` : `${i.available} episode${i.available === 1 ? '' : 's'}`;
  if (i.kind === 'movie') return i.year || '';
  return `${ep(i)} · ${i.title}`;
});
const initials = computed(() => String(title.value || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase());
const pct = computed(() => {
  const p = props.item.progress;
  const d = p?.duration || props.item.duration;
  return p && d ? Math.min(100, (p.position / d) * 100) : 0;
});
const badge = computed(() => (props.show && props.item.unwatched > 0 ? String(props.item.unwatched) : ''));
</script>

<style scoped>
.wcard { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.art {
  position: relative; aspect-ratio: 2 / 3; border-radius: var(--radius); overflow: hidden;
  background: var(--surface); border: 1px solid var(--border);
}
.wide .art { aspect-ratio: 16 / 9; }
.art img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .2s; }
.wcard:hover .art img { transform: scale(1.03); }
.art-fallback { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 28px; color: var(--muted); }
.badge {
  position: absolute; top: 6px; right: 6px; background: var(--accent); color: #fff;
  font-size: 11px; font-weight: 700; border-radius: 999px; min-width: 22px; height: 22px;
  padding: 0 6px; display: flex; align-items: center; justify-content: center;
}
.badge.watched { background: var(--green); }
.bar { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: rgba(0,0,0,.5); }
.bar div { height: 100%; background: var(--accent); }
.title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
