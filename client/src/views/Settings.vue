<template>
  <div>
    <div class="view-header">
      <h1>Settings</h1>
      <span v-if="status === null" class="tx-indicator">● Checking Transmission…</span>
      <span v-else class="tx-indicator" :class="status.connected ? 'ok' : 'err'">
        ● {{ status.connected ? 'Transmission connected' : 'Transmission unreachable' }}
      </span>
    </div>

    <div class="tabbar">
      <nav class="tabs" role="tablist" aria-label="Settings sections">
        <button v-for="t in TABS" :key="t.id" type="button" role="tab" class="tab"
          :class="{ active: tab === t.id }" :aria-selected="tab === t.id" @click="setTab(t.id)">
          {{ t.label }}<span v-if="dirty.has(t.id)" class="dirty-dot" title="Unsaved changes" />
        </button>
      </nav>
      <div class="find">
        <input v-model="query" type="search" placeholder="Find a setting…" aria-label="Find a setting"
          @keydown.enter.prevent="hits[0] && go(hits[0])" @keydown.esc="query = ''" />
        <div v-if="query.trim()" class="hits" role="listbox">
          <button v-for="h in hits" :key="h.key" type="button" class="hit" @click="go(h)">
            {{ h.text }}<span class="muted"> — {{ tabLabel(h.tab) }}{{ h.section && h.section !== h.text ? ` · ${h.section}` : '' }}</span>
          </button>
          <div v-if="!hits.length" class="hit none">Nothing matches “{{ query.trim() }}”</div>
        </div>
      </div>
    </div>

    <StatusPanel v-if="tab === 'status'" />

    <div v-if="loading && tab !== 'status'" class="state-msg">Loading…</div>

    <form v-else v-show="tab !== 'status'" ref="formEl" @submit.prevent="save" @input="touch" @change="touch" class="settings-form">

      <section v-show="tab === 'transmission'" data-tab="transmission">
        <h2>Transmission</h2>
        <div class="fields">
          <label>Host
            <input v-model="form.transmission_host" type="text" placeholder="192.168.0.102" />
          </label>
          <label>Port
            <input v-model="form.transmission_port" type="text" placeholder="9091" />
          </label>
          <label>Username
            <input v-model="form.transmission_user" type="text" />
          </label>
          <label>Password
            <input v-model="form.transmission_pw" type="password" placeholder="leave blank to keep current" />
          </label>
        </div>
      </section>

      <section v-show="tab === 'transmission'" data-tab="transmission">
        <h2>Extra Transmission instances</h2>
        <p class="section-note">
          Optional. Give each one a name, then pick it per movie or show with “Download to”.
          Items with nothing chosen use the default instance above.
        </p>
        <div v-if="instances.length > 0" class="instance-list">
          <div v-for="(inst, i) in instances" :key="i" class="instance-row">
            <input v-model="inst.name" type="text" placeholder="Name (e.g. nas)" aria-label="Instance name" />
            <input v-model="inst.host" type="text" placeholder="Host or IP" aria-label="Instance host" />
            <input v-model="inst.port" type="text" placeholder="9091" class="port-input" aria-label="Instance port" />
            <input v-model="inst.user" type="text" placeholder="user" aria-label="Instance username" />
            <input v-model="inst.pw" type="password" placeholder="password" aria-label="Instance password" />
            <button type="button" class="btn-danger btn-sm" @click="instances.splice(i, 1)">✕</button>
          </div>
        </div>
        <button type="button" class="btn-ghost btn-sm add-instance" @click="addInstance">+ Add instance</button>

        <div v-if="status?.instances?.length > 1" class="instance-status">
          <span v-for="inst in status.instances" :key="inst.name" :class="inst.connected ? 'ok' : 'err'">
            ● {{ inst.name }}
          </span>
        </div>
      </section>

      <section v-show="tab === 'library'" data-tab="library">
        <h2>Download Paths</h2>
        <div class="fields">
          <label>Movies directory
            <input v-model="form.movie_path" type="text" placeholder="/HDD0/Shared/Movies" />
          </label>
          <label>Shows directory
            <input v-model="form.shows_path" type="text" placeholder="/HDD0/Shared/Series" />
          </label>
          <label>Keep free for downloads (GB)
            <span class="hint">below this, downloads pause and nothing new is grabbed; 0 = off</span>
            <input v-model.number="form.download_min_free_gb" type="number" min="0" step="5" />
          </label>
        </div>
      </section>

      <section v-show="tab === 'search'" data-tab="search">
        <h2>Prowlarr</h2>
        <div class="fields">
          <label>Host
            <input v-model="form.prowlarr_host" type="text" placeholder="localhost" />
          </label>
          <label>Port
            <input v-model="form.prowlarr_port" type="text" placeholder="9696" />
          </label>
          <label>API Key
            <input v-model="form.prowlarr_api_key" type="password" placeholder="leave blank to keep current" />
          </label>
        </div>
      </section>

      <section v-show="tab === 'search'" data-tab="search">
        <h2>TMDB</h2>
        <div class="fields">
          <label>API Key
            <input v-model="form.tmdb_api_key" type="password" placeholder="leave blank to keep current" />
          </label>
          <label>Region <span class="hint">(for release dates, e.g. US, GB, NL)</span>
            <input v-model="form.tmdb_region" type="text" placeholder="US" maxlength="2" style="text-transform:uppercase" />
          </label>
        </div>
      </section>

      <section v-show="tab === 'transmission'" data-tab="transmission">
        <h2>Scheduler</h2>
        <div class="fields">
          <label>Check interval (minutes) <span class="hint">min 5</span>
            <input v-model.number="form.scheduler_interval_mins" type="number" min="5" max="1440" />
          </label>
          <label>Air date buffer (hours) <span class="hint">wait this long after air date before searching (recommended: 4+)</span>
            <input v-model.number="form.air_date_buffer_hours" type="number" min="0" max="48" />
          </label>
        </div>
      </section>

      <section v-show="tab === 'search'" data-tab="search">
        <h2>Search</h2>
        <div class="fields">
          <label>Minimum seeders
            <input v-model.number="form.min_seeds" type="number" min="0" max="999" />
          </label>
          <label>Default quality
            <select v-model="form.default_quality">
              <option value="2160p">4K (2160p)</option>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
              <option value="any">Best available</option>
            </select>
          </label>
          <label>Min file size (MB)
            <input v-model.number="form.min_size_mb" type="number" min="0" />
          </label>
          <label>Max file size (GB)
            <input v-model.number="form.max_size_gb" type="number" min="1" />
          </label>
          <label class="span2">Preferred movie groups <span class="hint">comma-separated, e.g. yts,yify</span>
            <input v-model="form.preferred_movie_groups" type="text" placeholder="yts,yify" />
          </label>
          <label class="span2">Preferred show groups <span class="hint">comma-separated, e.g. eztv,tgx,ettv,rartv</span>
            <input v-model="form.preferred_show_groups" type="text" placeholder="eztv,tgx,ettv,rartv" />
          </label>
          <label class="span2">Blocked tags <span class="hint">comma-separated tokens always rejected, e.g. EXTENDED,DC (CAM/TELESYNC blocked by default)</span>
            <input v-model="form.blocked_tags" type="text" placeholder="EXTENDED,DC,DUBBED" />
          </label>
          <label class="check-label span2">
            <input v-model="qualityStrictBool" type="checkbox" class="checkbox" />
            Strict quality mode — only grab results that exactly match preferred quality
          </label>
          <label class="check-label span2">
            <input v-model="trustedOnlyBool" type="checkbox" class="checkbox" />
            Trusted groups only — reject releases not from the groups listed above
          </label>
          <label>Reuse results for (minutes) <span class="hint">how long a search stays instant on reopen; 0 disables</span>
            <input v-model.number="form.search_cache_mins" type="number" min="0" max="720" />
          </label>
          <label>Title match strictness <span class="hint">share of the title's words a release must contain (0.7 = 70%)</span>
            <input v-model.number="form.title_match_min" type="number" min="0" max="1" step="0.05" />
          </label>
        </div>
      </section>

      <section v-show="tab === 'library'" data-tab="library">
        <h2>After a download finishes</h2>
        <p class="section-note">
          The finished file is opened and its streams checked: a file with no video, no audio,
          or nothing but an audio-description track is unusable. If it has no subtitles in your
          language, they are fetched from OpenSubtitles and saved beside it as
          <code>&lt;video&gt;.en.srt</code>. Needs <code>ffprobe</code> and the media folder
          mounted into the container — see the README.
        </p>
        <div class="fields">
          <label class="check-label span2">
            <input v-model="postprocessBool" type="checkbox" class="checkbox" />
            Check finished downloads
          </label>
          <label>When a file is unusable
            <select v-model="form.postprocess_action">
              <option value="replace">Replace it — delete and grab the next candidate</option>
              <option value="flag">Keep it — just say why on the card</option>
            </select>
            <span class="hint">packs, and torrents that were already in Transmission, are only ever flagged</span>
          </label>
          <label>Subtitle languages
            <input v-model="form.subtitle_languages" type="text" placeholder="en" />
            <span class="hint">2-letter codes, comma-separated; the first is the one fetched</span>
          </label>
          <label>Search again for missing subtitles
            <input v-model="form.subtitle_retry_hours" type="text" placeholder="12,24,36,120,240" />
            <span class="hint">hours after the download; new releases often get subtitles a day or more later</span>
          </label>
          <label>OpenSubtitles API key
            <input v-model="form.opensubtitles_api_key" type="password" placeholder="leave blank to keep current" />
            <span class="hint">create one under “API consumers” on opensubtitles.com</span>
          </label>
          <label>OpenSubtitles username
            <input v-model="form.opensubtitles_username" type="text" autocomplete="off" />
            <span class="hint">optional — raises downloads from 5 to 20 a day</span>
          </label>
          <label>OpenSubtitles password
            <input v-model="form.opensubtitles_password" type="password" placeholder="leave blank to keep current" autocomplete="new-password" />
          </label>
          <label>Media path mapping
            <input v-model="form.media_path_map" type="text" placeholder="/HDD0/Shared=>/media" />
            <span class="hint">only if this container sees the files under a different path than Transmission does</span>
          </label>
        </div>
      </section>

      <section v-show="tab === 'search'" data-tab="search">
        <h2>Safety</h2>
        <p class="section-note">
          Releases are checked against their real file list before anything downloads.
          Anything carrying an executable, a crack/keygen folder, a password-protected archive,
          or a video file that is suspiciously small for its claimed quality is rejected outright.
          A magnet has no file list until peers supply one, so it waits in quarantine — running,
          but throttled to a trickle and labelled <code>amagnet-quarantine</code> in
          Transmission — and only a passing check lets it download.
        </p>
        <div class="fields">
          <label class="check-label span2">
            <input v-model="allowDiscImagesBool" type="checkbox" class="checkbox" />
            Allow disc images (.iso/.img) — off by default, since a disc image hides its own contents
          </label>
          <label>Quarantine hold (hours)
            <span class="hint">how long a magnet may wait for its file list before it is given up on and removed</span>
            <input v-model.number="form.quarantine_hold_hours" type="number" min="1" max="336" />
          </label>
        </div>
      </section>

      <section v-show="tab === 'library'" data-tab="library">
        <h2>Show folders</h2>
        <p class="section-note">
          Shows are saved in a folder named after the show, made safe for Windows — a colon
          becomes a dash, so “Avatar: Seven Havens” goes in “Avatar - Seven Havens”. Over the
          share, a name Windows can't show appears scrambled, like <code>A9VK1B~E</code>.
          This finds older folders like that, and shows split across two folders whose names
          differ only in case, and moves them. Transmission moves the torrent data itself, so
          it keeps seeding; other files follow; nothing is ever overwritten.
        </p>
        <button type="button" class="btn-ghost btn-sm" :disabled="folderChecking" @click="checkFolders">
          {{ folderChecking ? 'Checking…' : 'Check show folders' }}
        </button>

        <div v-if="folderPlan" class="folder-plan">
          <p v-if="folderPlan.length === 0" class="folder-ok">Every show folder is where it should be.</p>
          <div v-for="f in folderPlan" :key="f.target + f.from" class="folder-fix">
            <div class="ff-head">
              <div class="ff-paths">
                <code>{{ leaf(f.from) }}</code> <span class="ff-arrow">→</span> <code>{{ leaf(f.to) }}</code>
              </div>
              <button
                v-if="!f.result"
                type="button"
                class="btn-primary btn-sm"
                :disabled="folderMoving !== null"
                @click="fixFolder(f)"
              >{{ folderMoving === f.from ? 'Moving…' : 'Move' }}</button>
            </div>
            <div class="ff-meta">
              {{ f.reason }} · {{ f.moves.length }} torrent{{ f.moves.length === 1 ? '' : 's' }} to move
              <template v-if="f.merge"> · merges into an existing folder</template>
              <template v-if="f.conflicts.length"> · {{ f.conflicts.length }} already there, left in place</template>
              <template v-if="!f.reachable"> · other files can't follow (folder not mounted)</template>
            </div>
            <div v-if="f.result" class="ff-result" :class="{ partial: f.result.stillMoving.length }">
              <template v-if="f.result.stillMoving.length">
                Transmission is still moving {{ f.result.stillMoving.length }} torrent(s) — check again in a minute,
                then move it again to bring the remaining files across.
              </template>
              <template v-else>
                Moved {{ f.result.torrentsMoved }} torrent(s) and {{ f.result.filesMoved.length }} other item(s).
                <template v-if="f.result.filesKept.length || f.result.torrentsSkipped">
                  Left in place because the destination already has them:
                  {{ [...f.result.filesKept].join(', ') || `${f.result.torrentsSkipped} torrent(s)` }}.
                </template>
                {{ f.result.oldFolderRemoved ? 'Old folder removed.' : 'Old folder kept — it still has files in it.' }}
              </template>
            </div>
          </div>
          <p v-if="folderPlan.length" class="hint ff-hint">
            A media server watching this folder will pick up a moved show on its next scan. Moving
            one show and checking it there first is the cautious way.
          </p>
        </div>
      </section>

      <section v-show="tab === 'playback'" data-tab="playback">
        <h2>Playback</h2>
        <p class="section-note">
          Files a browser can't play are repackaged (MKV, AC-3/DTS audio — fast, video untouched) or
          converted (HEVC, 10-bit, HDR) into a separate web version. The original keeps seeding.
        </p>
        <div class="fields">
          <label>Prepare web versions
            <select v-model="form.web_prepare">
              <option value="complete">As soon as a download is checked</option>
              <option value="demand">Only when someone presses play</option>
            </select>
          </label>
          <label>Encoder
            <select v-model="form.web_encoder">
              <option value="auto">Automatic (GPU if available)</option>
              <option value="vaapi">GPU — VAAPI (AMD / Intel)</option>
              <option value="x264">CPU — libx264</option>
            </select>
          </label>
          <label>Converted video height
            <select v-model="form.web_max_height">
              <option value="720">720p</option>
              <option value="1080">1080p</option>
              <option value="2160">2160p (keep 4K)</option>
            </select>
          </label>
          <label>Keep free (GB)
            <span class="hint">web versions stop below this; 0 = off</span>
            <input v-model.number="form.web_min_free_gb" type="number" min="0" step="5" />
          </label>
          <label>Room for on-demand (GB)
            <span class="hint">preparing ahead stops this much earlier, so pressing play still has space</span>
            <input v-model.number="form.web_reserve_gb" type="number" min="0" step="5" />
          </label>
          <label class="check-label span2">
            <input v-model="autosyncBool" type="checkbox" class="checkbox" />
            Align fetched subtitles to the audio when they weren't matched to the exact file
          </label>
          <label class="span2">Remove originals after seeding
            <span class="hint">frees the disk twice over: the web version stays and is what every player uses</span>
            <select v-model="form.seed_cleanup">
              <option value="off">Never — keep originals</option>
              <option value="remux">Repackaged items only (same video, nothing re-encoded)</option>
              <option value="all">Repackaged and converted items</option>
            </select>
          </label>
          <template v-if="form.seed_cleanup && form.seed_cleanup !== 'off'">
            <label>Once the upload ratio reaches
              <input v-model.number="form.seed_cleanup_ratio" type="number" min="0.1" step="0.1" />
            </label>
            <label>Or after seeding for <span class="hint">days, 0 = ratio only</span>
              <input v-model.number="form.seed_cleanup_days" type="number" min="0" />
            </label>
            <p class="section-note span2">
              The whole torrent goes — files, folder and Transmission entry — but only when every video in it
              has a finished web version. Files that play as they are, and torrents that were already in
              Transmission, are never removed. Media servers and network shares lose the original too, and
              "Converted" items keep only the converted quality (at most the height chosen above).
            </p>
          </template>
        </div>
      </section>

      <section v-show="tab === 'accounts'" data-tab="accounts">
        <h2>API token</h2>
        <div class="fields">
          <label class="span2">Token <span class="hint">only for scripts — the server's AMAGNET_TOKEN. Signing in replaces it in the browser.</span>
            <input v-model="apiToken" type="password" placeholder="leave blank" />
          </label>
        </div>
      </section>

      <section v-show="tab === 'accounts'" data-tab="accounts">
        <h2>Notifications</h2>
        <div class="notif-row">
          <div>
            <div class="notif-title">Browser notifications</div>
            <div class="notif-sub">{{ notifStatusText }}</div>
          </div>
          <button
            v-if="notifPermission === 'default'"
            type="button"
            class="btn-ghost btn-sm"
            @click="enableNotifications"
          >Enable</button>
        </div>
      </section>

      <div v-if="saved" class="saved-msg">Settings saved.</div>
      <div v-if="saveError" class="error-msg">{{ saveError }}</div>

      <div class="form-footer">
        <button type="submit" class="btn-primary" :disabled="saving">
          {{ saving ? 'Saving…' : 'Save Settings' }}
        </button>
        <span v-if="dirty.size" class="unsaved">Unsaved changes in {{ [...dirty].map(tabLabel).join(', ') }}</span>
      </div>
    </form>

    <PlaybackPanel v-if="tab === 'playback'" />
    <UsersPanel v-if="tab === 'accounts'" />

    <div v-if="tab === 'transmission'" class="run-section">
      <div class="run-header">
        <div>
          <div class="run-title">Scheduler</div>
          <div class="run-sub">Runs automatically every {{ form.scheduler_interval_mins || 60 }} minutes. Trigger a manual run below.</div>
        </div>
        <button class="btn-primary" :disabled="running" @click="runNow">
          {{ running ? 'Running…' : '▶ Run Now' }}
        </button>
      </div>
      <div v-if="runMsg" class="saved-msg">{{ runMsg }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router';
import { settings as api, scheduler, library, getToken, setToken } from '../api.js';
import { notifyError, notifySuccess } from '../toast.js';
import PlaybackPanel from '../components/PlaybackPanel.vue';
import StatusPanel from '../components/StatusPanel.vue';
import UsersPanel from '../components/UsersPanel.vue';

const apiToken = ref(getToken());

const supportsNotifications = 'Notification' in window;
const notifPermission = ref(supportsNotifications ? Notification.permission : 'unsupported');

const notifStatusText = computed(() => ({
  granted:     'Enabled — you will be notified when downloads finish.',
  denied:      'Blocked. Re-enable it in your browser’s site settings.',
  default:     'Not enabled yet.',
  unsupported: 'This browser does not support notifications.',
}[notifPermission.value]));

async function enableNotifications() {
  if (!supportsNotifications) return;
  // Must be called from a user gesture, which is why this lives here and not on load
  notifPermission.value = await Notification.requestPermission();
  if (notifPermission.value === 'granted') notifySuccess('Notifications enabled');
}

const form      = ref({});
const loading   = ref(true);
const saving    = ref(false);
const saved     = ref(false);
const saveError = ref('');
const status    = ref(null);   // null while Transmission is being asked

// One section at a time: the page had grown to a long scroll. The tab is in
// the address (?tab=…), so a reload or a shared link opens the same one.
const TABS = [
  { id: 'status',       label: 'Status' },
  { id: 'transmission', label: 'Transmission' },
  { id: 'library',      label: 'Library' },
  { id: 'search',       label: 'Searching' },
  { id: 'playback',     label: 'Playback' },
  { id: 'accounts',     label: 'Accounts' },
];
const route  = useRoute();
const router = useRouter();
const tab = computed(() => (TABS.some(t => t.id === route.query.tab) ? route.query.tab : 'status'));
function setTab(id) { return router.replace({ query: { ...route.query, tab: id } }); }
const tabLabel = (id) => TABS.find(t => t.id === id)?.label || id;

// ─── Unsaved changes ─────────────────────────────────────────────────────────
// One Save covers every tab, so a change made on one tab and forgotten there
// would otherwise be lost silently — or saved by surprise from another tab.
// The tab that was showing when a field changed is marked until saved.
const dirty = ref(new Set());
function touch(e) {
  if (e?.target?.closest?.('.find')) return;
  if (!dirty.value.has(tab.value)) dirty.value = new Set([...dirty.value, tab.value]);
}
const leaveMessage = 'There are unsaved settings. Leave without saving them?';
function onBeforeUnload(e) { if (dirty.value.size) { e.preventDefault(); e.returnValue = leaveMessage; } }
onBeforeRouteLeave(() => (dirty.value.size ? window.confirm(leaveMessage) : true));
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));

// ─── Finding a setting ───────────────────────────────────────────────────────
// Read from the form itself — every label and section heading — so a new
// setting is findable without being listed anywhere.
const formEl = ref(null);
const query = ref('');
let index = [];
function buildIndex() {
  index = [];
  for (const sec of formEl.value?.querySelectorAll('section[data-tab]') || []) {
    const section = sec.querySelector('h2')?.textContent.trim() || '';
    index.push({ key: `${sec.dataset.tab}:${section}`, text: section, section, tab: sec.dataset.tab, el: sec });
    sec.querySelectorAll('label').forEach((label, i) => {
      // The label's own words: not the hint under it, nor an option list.
      const own = [...label.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
      const hint = label.querySelector('.hint')?.textContent.trim() || '';
      if (own) index.push({ key: `${sec.dataset.tab}:${section}:${i}`, text: own, hint, section, tab: sec.dataset.tab, el: label });
    });
  }
  for (const t of TABS) index.push({ key: `tab:${t.id}`, text: t.label, section: '', tab: t.id, el: null });
}
const hits = computed(() => {
  const words = query.value.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return index
    .filter(h => words.every(w => `${h.text} ${h.hint || ''} ${h.section}`.toLowerCase().includes(w)))
    .slice(0, 8);
});
async function go(h) {
  query.value = '';
  await setTab(h.tab);   // the tab shows once the route has changed, not before
  await nextTick();
  if (!h.el) return;
  h.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  h.el.classList.add('flash');
  setTimeout(() => h.el.classList.remove('flash'), 1600);
  h.el.querySelector('input, select, textarea')?.focus({ preventScroll: true });
}
watch(formEl, (el) => { if (el) nextTick(buildIndex); });
const running   = ref(false);
const runMsg    = ref('');

// quality_strict is stored as "0"/"1" string — expose as bool for the checkbox
const qualityStrictBool = computed({
  get: () => form.value.quality_strict === '1',
  set: (v) => { form.value.quality_strict = v ? '1' : '0'; },
});

const trustedOnlyBool = computed({
  get: () => form.value.trusted_only === '1',
  set: (v) => { form.value.trusted_only = v ? '1' : '0'; },
});

// Edited as an array, stored as a JSON string — the shape the server wants.
// Show folders that don't match where new downloads go.
const folderPlan     = ref(null);
const folderChecking = ref(false);
const folderMoving   = ref(null);
const leaf = (p) => String(p).split('/').pop();

async function checkFolders() {
  folderChecking.value = true;
  try {
    const plan = await library.folders();
    folderPlan.value = plan.fixes.map(f => ({ ...f, result: null }));
  } catch (err) {
    notifyError(`Could not check folders: ${err.message}`);
  } finally {
    folderChecking.value = false;
  }
}

async function fixFolder(f) {
  folderMoving.value = f.from;
  try {
    f.result = await library.fixFolder(f.from, f.target);
    if (!f.result.stillMoving.length) notifySuccess(`Moved ${leaf(f.from)} → ${leaf(f.to)}`);
  } catch (err) {
    notifyError(`Could not move ${leaf(f.from)}: ${err.message}`);
  } finally {
    folderMoving.value = null;
  }
}

const instances = ref([]);
function addInstance() {
  instances.value.push({ name: '', host: '', port: '9091', user: '', pw: '' });
}

// Stored as '0'/'1' like the other toggles; anything but '0' means on, so an
// install that has never saved this setting counts as enabled.
const autosyncBool = computed({
  get: () => form.value.subtitle_autosync !== '0',
  set: (v) => { form.value.subtitle_autosync = v ? '1' : '0'; },
});
const postprocessBool = computed({
  get: () => form.value.postprocess_enabled !== '0',
  set: (v) => { form.value.postprocess_enabled = v ? '1' : '0'; },
});

const allowDiscImagesBool = computed({
  get: () => form.value.allow_disc_images === '1',
  set: (v) => { form.value.allow_disc_images = v ? '1' : '0'; },
});

onMounted(async () => {
  try {
    // Transmission can take seconds to answer (or time out): the form shows
    // without waiting for it.
    api.status().then((s) => { status.value = s; }, () => { status.value = { connected: false }; });
    form.value = await api.get();
    window.addEventListener('beforeunload', onBeforeUnload);
    try {
      const parsed = JSON.parse(form.value.transmission_extra || '[]');
      instances.value = Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      instances.value = [];
    }
  } finally {
    loading.value = false;
  }
});

async function runNow() {
  running.value = true;
  runMsg.value  = '';
  try {
    await scheduler.run();
    runMsg.value = 'Scheduler started — check back in a moment.';
    setTimeout(() => { runMsg.value = ''; }, 4000);
  } catch (err) {
    notifyError(`Could not start the scheduler: ${err.message}`);
  } finally {
    running.value = false;
  }
}

async function save() {
  saving.value    = true;
  saved.value     = false;
  saveError.value = '';
  try {
    // Stored locally only — the token authenticates this browser, it isn't a server setting
    setToken(apiToken.value.trim());
    const payload = {
      ...form.value,
      transmission_extra: JSON.stringify(
        instances.value.filter(i => i.name.trim() && i.host.trim())
      ),
    };
    await api.save(payload);
    saved.value   = true;
    dirty.value   = new Set();
    api.status().then((s) => { status.value = s; }, () => {});
    setTimeout(() => { saved.value = false; }, 3000);
  } catch (err) {
    saveError.value = err.message;
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.view-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 24px;
}
h1 { font-size: 22px; font-weight: 700; }
.tx-indicator { font-size: 13px; font-weight: 500; }
.tx-indicator.ok  { color: var(--green); }
.tx-indicator.err { color: var(--red); }

.state-msg { color: var(--muted); padding: 40px 0; text-align: center; }

.settings-form { display: flex; flex-direction: column; gap: 32px; max-width: 640px; }

section h2 {
  font-size: 13px; font-weight: 700; text-transform: uppercase;
  letter-spacing: .6px; color: var(--muted);
  margin-bottom: 12px; padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}

.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.span2  { grid-column: span 2; }

.notif-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  flex-wrap: wrap;
}
.notif-title { font-size: 13px; font-weight: 600; color: var(--text); }
.notif-sub   { font-size: 12px; color: var(--muted); margin-top: 2px; }

label {
  display: flex; flex-direction: column; gap: 5px;
  font-size: 13px; color: var(--muted);
}
.hint { font-size: 11px; color: var(--border); margin-left: 4px; }

.check-label { flex-direction: row; align-items: center; gap: 8px; color: var(--text); font-size: 13px; }
.checkbox    { width: 15px; height: 15px; flex-shrink: 0; accent-color: var(--accent); }

input, select {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text);
  padding: 8px 10px; font-size: 14px; outline: none; width: 100%;
}
input:focus, select:focus { border-color: var(--accent); }

.instance-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.instance-row {
  display: grid;
  grid-template-columns: 1fr 1.4fr 70px 1fr 1fr auto;
  gap: 6px;
}
.instance-row input {
  background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text);
  padding: 5px 8px; font-size: 12px; outline: none; min-width: 0;
}
.instance-row input:focus { border-color: var(--accent); }
.add-instance { margin-top: 2px; }
.instance-status { display: flex; gap: 12px; margin-top: 10px; font-size: 11px; }
.instance-status .ok  { color: var(--green); }
.instance-status .err { color: var(--red); }

@media (max-width: 720px) {
  .instance-row { grid-template-columns: 1fr 1fr auto; }
}

.folder-plan { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.folder-ok   { font-size: 12px; color: var(--green); }
.folder-fix  { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; }
.ff-head     { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ff-paths    { font-size: 13px; overflow-wrap: anywhere; }
.ff-arrow    { color: var(--muted); margin: 0 4px; }
.ff-meta     { font-size: 11px; color: var(--muted); margin-top: 4px; }
.ff-result   { font-size: 12px; color: var(--green); margin-top: 6px; }
.ff-result.partial { color: var(--yellow); }
.ff-hint     { font-size: 11px; color: var(--muted); }

.section-note {
  color: var(--muted); font-size: 12px; margin: -4px 0 12px; max-width: 70ch; line-height: 1.5;
}
.saved-msg { color: var(--green); font-size: 13px; }
.error-msg { color: var(--red);   font-size: 13px; }

/* Always in reach, whichever tab and however far down. */
.unsaved { margin-left: 12px; font-size: 12px; color: var(--yellow); }
.dirty-dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--yellow); margin-left: 6px; vertical-align: middle;
}
.tabbar { display: flex; align-items: flex-end; gap: 8px; max-width: 720px; margin: -8px 0 24px; border-bottom: 1px solid var(--border); }
.tabbar .tabs { margin: 0; border-bottom: none; flex: 1; min-width: 0; }
.find { position: relative; padding-bottom: 6px; flex: none; }
.find input {
  width: 150px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text); padding: 5px 8px; font-size: 12px; outline: none;
}
.find input:focus { border-color: var(--accent); }
.hits {
  position: absolute; right: 0; top: calc(100% - 2px); z-index: 5; width: 320px; max-width: 80vw;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .35); padding: 4px;
}
.hit {
  display: block; width: 100%; text-align: left; background: none; border: none; color: var(--text);
  font: inherit; font-size: 13px; padding: 6px 8px; border-radius: 4px; cursor: pointer;
}
.hit:hover { background: var(--border); }
.hit .muted { color: var(--muted); font-size: 12px; }
.hit.none { color: var(--muted); cursor: default; }
:deep(.flash) { animation: flash 1.6s ease-out; border-radius: 4px; }
@keyframes flash { 0%, 40% { background: color-mix(in srgb, var(--accent) 25%, transparent); } 100% { background: transparent; } }
@media (max-width: 640px) {
  .tabbar { flex-direction: column-reverse; align-items: stretch; }
  .find input { width: 100%; }
}
.form-footer {
  position: sticky; bottom: 0; z-index: 2;
  padding: 10px 0; background: var(--bg);
  border-top: 1px solid var(--border);
}

.tabs {
  display: flex; gap: 4px; margin: -8px 0 24px; max-width: 640px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto; scrollbar-width: none;
}
.tabs::-webkit-scrollbar { display: none; }
.tab {
  background: none; border: none; border-bottom: 2px solid transparent;
  color: var(--muted); font: inherit; font-size: 13px; font-weight: 500;
  padding: 8px 10px; margin-bottom: -1px; cursor: pointer; white-space: nowrap;
}
.tab:hover { color: var(--text); }
.tab.active { color: var(--text); border-bottom-color: var(--accent); }

.run-section {
  margin-top: 32px; max-width: 640px;
  padding: 16px 20px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
}
.run-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.run-title  { font-weight: 600; font-size: 14px; }
.run-sub    { color: var(--muted); font-size: 12px; margin-top: 3px; }

/* The two-column field grid was applied at every width and overflowed phones */
@media (max-width: 640px) {
  .fields { grid-template-columns: 1fr; }
  .span2  { grid-column: span 1; }
  .view-header { flex-direction: column; align-items: flex-start; gap: 6px; }
  .run-section { padding: 14px; }
}
</style>
