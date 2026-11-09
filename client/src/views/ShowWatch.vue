<template>
  <div>
    <RouterLink to="/watch/shows" class="back">← Shows</RouterLink>
    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="state-msg err">{{ error }}</div>
    <template v-else>
      <div class="head">
        <img v-if="data.show.poster_url" :src="data.show.poster_url" alt="" class="poster" />
        <div>
          <h1>{{ data.show.title }}</h1>
          <div class="muted">{{ availableCount }} episode{{ availableCount === 1 ? '' : 's' }} available
            <template v-if="data.show.show_status"> · {{ data.show.show_status }}</template></div>
          <RouterLink v-if="resume" :to="`/play/episode/${resume.id}`" class="btn-primary play-btn">
            ▶ {{ resume.progress?.position ? 'Resume' : 'Play' }} {{ ep(resume) }}
          </RouterLink>
        </div>
      </div>

      <div class="season-tabs">
        <button v-for="s in data.seasons" :key="s.season" class="btn-ghost btn-sm" :class="{ on: s.season === season }"
          @click="season = s.season">Season {{ s.season }}</button>
        <button v-if="current && current.episodes.some(e => e.status === 'done')" class="btn-ghost btn-sm mark" @click="markSeason">
          Mark season {{ seasonWatched ? 'unwatched' : 'watched' }}
        </button>
      </div>

      <ol v-if="current" class="eps">
        <li v-for="e in current.episodes" :key="e.id" :class="{ off: e.status !== 'done' }">
          <component :is="e.status === 'done' ? 'RouterLink' : 'div'" :to="`/play/episode/${e.id}`" class="ep">
            <div class="still">
              <img v-if="e.still_url" :src="e.still_url" alt="" loading="lazy" />
              <div v-if="pct(e) > 0 && !e.progress?.watched" class="bar"><div :style="{ width: pct(e) + '%' }" /></div>
            </div>
            <div class="ep-meta">
              <div class="ep-title">{{ e.episode }}. {{ e.title }}</div>
              <div class="muted small">
                <template v-if="e.status !== 'done'">{{ statusText(e) }}</template>
                <template v-else-if="e.duration">{{ Math.round(e.duration / 60) }} min</template>
              </div>
              <div v-if="e.overview" class="overview">{{ e.overview }}</div>
            </div>
          </component>
          <button v-if="e.status === 'done'" class="tick" :class="{ on: e.progress?.watched }"
            :aria-label="e.progress?.watched ? 'Mark unwatched' : 'Mark watched'"
            :title="e.progress?.watched ? 'Watched — click to unmark' : 'Mark watched'"
            @click="toggle(e)">✓</button>
          <button v-if="isAdmin && e.status === 'done'" class="trash" :disabled="deletingId === e.id"
            :aria-label="`Delete episode ${e.episode} from disk`" title="Delete from disk"
            @click="removeEp(e)">🗑</button>
        </li>
      </ol>
    </template>
  </div>
</template>

<script setup>
import { ask } from '../dialog.js';
import { ref, computed, onMounted } from 'vue';
import { watch } from '../api.js';
import { notifyError, notifySuccess } from '../toast.js';
import { isAdmin } from '../session.js';

const props = defineProps({ id: { type: String, required: true } });
const data = ref(null);
const loading = ref(true);
const error = ref('');
const season = ref(null);

const ep = (e) => `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;
const pct = (e) => (e.progress && (e.progress.duration || e.duration) ? (e.progress.position / (e.progress.duration || e.duration)) * 100 : 0);
const statusText = (e) => ({ downloading: 'Downloading…', upcoming: e.air_date ? `Airs ${e.air_date}` : 'Upcoming', pending: 'Waiting for a release', deleted: 'Deleted from disk' }[e.status] || e.status);

const current = computed(() => data.value?.seasons.find(s => s.season === season.value));
const done = computed(() => (data.value?.seasons || []).flatMap(s => s.episodes).filter(e => e.status === 'done'));
const availableCount = computed(() => done.value.length);
const seasonWatched = computed(() => current.value?.episodes.filter(e => e.status === 'done').every(e => e.progress?.watched));
// Where to pick up: something half-watched, else the first unwatched episode.
const resume = computed(() => done.value.find(e => e.progress?.position > 0 && !e.progress.watched)
  || done.value.find(e => !e.progress?.watched) || null);

async function load() {
  try {
    data.value = await watch.show(props.id);
    if (season.value === null) {
      season.value = resume.value?.season ?? data.value.seasons.find(s => s.episodes.some(e => e.status === 'done'))?.season
        ?? data.value.seasons[0]?.season ?? null;
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

const deletingId = ref(null);

async function removeEp(e) {
  const code = `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;
  if (!(await ask({ title: `Delete ${code} "${e.title}" from disk?`, confirmLabel: 'Delete from disk',
    message: "The file, its subtitles and its web version are removed, and it won't be downloaded again. (Redo in Shows brings it back.)" }))) return;
  deletingId.value = e.id;
  try {
    const r = await watch.deleteAll('episode', e.id);
    notifySuccess(`${code} deleted — ${r.freed >= 1e9 ? `${(r.freed / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(r.freed / 1e6))} MB`} freed`);
    await load();
  } catch (err) { notifyError(err.message); }
  finally { deletingId.value = null; }
}

async function toggle(e) {
  try {
    e.progress = await watch.setWatched('episode', e.id, !e.progress?.watched);
  } catch (err) { notifyError(err.message); }
}

async function markSeason() {
  try {
    await watch.showWatched(Number(props.id), season.value, !seasonWatched.value);
    await load();
  } catch (err) { notifyError(err.message); }
}

onMounted(load);
</script>

<style scoped>
.back { color: var(--muted); font-size: 13px; display: inline-block; margin-bottom: 14px; }
.head { display: flex; gap: 20px; align-items: flex-end; margin-bottom: 20px; }
.poster { width: 120px; border-radius: var(--radius); border: 1px solid var(--border); }
h1 { font-size: 24px; margin-bottom: 4px; }
.muted { color: var(--muted); font-size: 13px; }
.small { font-size: 12px; }
.play-btn { display: inline-block; margin-top: 12px; padding: 8px 18px; border-radius: var(--radius); color: #fff; font-weight: 600; }
.season-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.season-tabs .on { color: var(--text); border-color: var(--accent); }
.season-tabs .mark { margin-left: auto; }
.eps { list-style: none; display: flex; flex-direction: column; gap: 10px; }
.eps li { display: flex; align-items: center; gap: 10px; }
.eps li.off { opacity: .55; }
.ep { flex: 1; display: flex; gap: 14px; padding: 8px; border-radius: var(--radius); min-width: 0; }
a.ep:hover { background: var(--surface); }
.still { position: relative; width: 180px; flex-shrink: 0; aspect-ratio: 16/9; background: var(--surface); border-radius: 6px; overflow: hidden; }
.still img { width: 100%; height: 100%; object-fit: cover; }
.bar { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: rgba(0,0,0,.5); }
.bar div { height: 100%; background: var(--accent); }
.ep-meta { min-width: 0; }
.ep-title { font-weight: 600; }
.overview { font-size: 12px; color: var(--muted); margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tick { background: transparent; border: 1px solid var(--border); color: var(--muted); border-radius: 999px; width: 30px; height: 30px; padding: 0; flex-shrink: 0; }
.tick.on { background: var(--green); border-color: var(--green); color: #fff; }
.trash { background: transparent; border: 1px solid var(--border); border-radius: 999px; width: 30px; height: 30px; padding: 0; flex-shrink: 0; font-size: 13px; opacity: .6; }
.trash:hover { opacity: 1; border-color: var(--red); }
.state-msg { color: var(--muted); padding: 40px 0; text-align: center; }
.state-msg.err { color: var(--red); }
@media (max-width: 640px) {
  .still { width: 120px; }
  .poster { width: 80px; }
  .overview { display: none; }
}
</style>
