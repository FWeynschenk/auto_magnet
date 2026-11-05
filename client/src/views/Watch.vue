<template>
  <div>
    <div class="view-header">
      <h1>Watch</h1>
      <div class="tabs" role="tablist">
        <RouterLink to="/watch" :class="{ on: tab === 'home' }">Home</RouterLink>
        <RouterLink to="/watch/movies" :class="{ on: tab === 'movies' }">Movies</RouterLink>
        <RouterLink to="/watch/shows" :class="{ on: tab === 'shows' }">Shows</RouterLink>
      </div>
      <input v-if="tab !== 'home'" v-model="filter" type="search" class="ctrl-search" placeholder="Filter…" aria-label="Filter by title" />
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>
    <div v-else-if="error" class="state-msg err">{{ error }}</div>

    <template v-else-if="tab === 'home'">
      <section v-if="home.continue.length">
        <h2>Continue watching</h2>
        <div class="row wide-row"><WatchCard v-for="i in home.continue" :key="key(i)" :item="i" wide /></div>
      </section>
      <section v-if="home.nextUp.length">
        <h2>Next up</h2>
        <div class="row wide-row"><WatchCard v-for="i in home.nextUp" :key="key(i)" :item="i" wide /></div>
      </section>
      <section v-if="home.recent.length">
        <h2>Recently added</h2>
        <div class="row"><WatchCard v-for="i in home.recent" :key="key(i)" :item="i" /></div>
      </section>
      <div v-if="!home.continue.length && !home.nextUp.length && !home.recent.length" class="empty-state">
        <div class="empty-icon">🍿</div>
        <p>Nothing has finished downloading yet.</p>
      </div>
    </template>

    <template v-else>
      <div v-if="filtered.length === 0" class="empty-state"><p>{{ list.length ? 'Nothing matches the filter.' : 'Nothing here yet.' }}</p></div>
      <div v-else class="grid">
        <WatchCard v-for="i in filtered" :key="i.id" :item="i" :show="tab === 'shows'" />
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch as watchRef } from 'vue';
import { watch } from '../api.js';
import WatchCard from '../components/WatchCard.vue';

const props = defineProps({ tab: { type: String, default: 'home' } });

const loading = ref(true);
const error = ref('');
const home = ref({ continue: [], nextUp: [], recent: [] });
const list = ref([]);
const filter = ref('');

const key = (i) => `${i.kind}:${i.id}`;
const filtered = computed(() => {
  const f = filter.value.trim().toLowerCase();
  return f ? list.value.filter(i => i.title.toLowerCase().includes(f)) : list.value;
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    if (props.tab === 'home') home.value = await watch.home();
    else list.value = props.tab === 'movies' ? await watch.movies() : await watch.shows();
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

watchRef(() => props.tab, () => { filter.value = ''; load(); }, { immediate: true });
</script>

<style scoped>
.view-header { display: flex; align-items: center; gap: 20px; margin-bottom: 20px; flex-wrap: wrap; }
.view-header h1 { font-size: 22px; }
.tabs { display: flex; gap: 4px; }
.tabs a { padding: 6px 14px; border-radius: var(--radius); color: var(--muted); font-weight: 500; }
.tabs a.on, .tabs a:hover { color: var(--text); background: var(--surface); }
.ctrl-search {
  margin-left: auto; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text); padding: 6px 12px; font-size: 13px; outline: none; min-width: 200px;
}
section { margin-bottom: 28px; }
h2 { font-size: 15px; margin-bottom: 12px; color: var(--muted); font-weight: 600; }
.row { display: grid; grid-auto-flow: column; grid-auto-columns: 150px; gap: 14px; overflow-x: auto; padding-bottom: 6px; }
.wide-row { grid-auto-columns: 260px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 18px 14px; }
.state-msg { color: var(--muted); padding: 40px 0; text-align: center; }
.state-msg.err { color: var(--red); }
.empty-state { text-align: center; color: var(--muted); padding: 60px 0; }
.empty-icon { font-size: 40px; margin-bottom: 10px; }
@media (max-width: 640px) {
  .ctrl-search { margin-left: 0; width: 100%; min-width: 0; }
  .row { grid-auto-columns: 120px; }
  .wide-row { grid-auto-columns: 220px; }
  .grid { grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); }
}
</style>
