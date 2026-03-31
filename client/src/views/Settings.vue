<template>
  <div>
    <div class="view-header">
      <h1>Settings</h1>
      <span class="tx-indicator" :class="status.connected ? 'ok' : 'err'">
        ● {{ status.connected ? 'Transmission connected' : 'Transmission unreachable' }}
      </span>
    </div>

    <div v-if="loading" class="state-msg">Loading…</div>

    <form v-else @submit.prevent="save" class="settings-form">

      <section>
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

      <section>
        <h2>Download Paths</h2>
        <div class="fields">
          <label>Movies directory
            <input v-model="form.movie_path" type="text" placeholder="/HDD0/Shared/Movies" />
          </label>
          <label>Shows directory
            <input v-model="form.shows_path" type="text" placeholder="/HDD0/Shared/Series" />
          </label>
        </div>
      </section>

      <section>
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

      <section>
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

      <section>
        <h2>Scheduler</h2>
        <div class="fields">
          <label>Check interval (minutes) <span class="hint">min 5</span>
            <input v-model.number="form.scheduler_interval_mins" type="number" min="5" max="1440" />
          </label>
          <label>Air date buffer (hours) <span class="hint">wait this long after air date before searching</span>
            <input v-model.number="form.air_date_buffer_hours" type="number" min="0" max="48" />
          </label>
        </div>
      </section>

      <section>
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
          <label class="check-label span2">
            <input v-model="qualityStrictBool" type="checkbox" class="checkbox" />
            Strict quality mode — only grab results that exactly match preferred quality
          </label>
        </div>
      </section>

      <div v-if="saved" class="saved-msg">Settings saved.</div>
      <div v-if="saveError" class="error-msg">{{ saveError }}</div>

      <div class="form-footer">
        <button type="submit" class="btn-primary" :disabled="saving">
          {{ saving ? 'Saving…' : 'Save Settings' }}
        </button>
      </div>
    </form>

    <div class="run-section">
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
import { ref, computed, onMounted } from 'vue';
import { settings as api, scheduler } from '../api.js';

const form      = ref({});
const loading   = ref(true);
const saving    = ref(false);
const saved     = ref(false);
const saveError = ref('');
const status    = ref({ connected: false });
const running   = ref(false);
const runMsg    = ref('');

// quality_strict is stored as "0"/"1" string — expose as bool for the checkbox
const qualityStrictBool = computed({
  get: () => form.value.quality_strict === '1',
  set: (v) => { form.value.quality_strict = v ? '1' : '0'; },
});

onMounted(async () => {
  try {
    [form.value, status.value] = await Promise.all([api.get(), api.status()]);
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
  } finally {
    running.value = false;
  }
}

async function save() {
  saving.value    = true;
  saved.value     = false;
  saveError.value = '';
  try {
    await api.save(form.value);
    saved.value   = true;
    status.value  = await api.status();
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

.saved-msg { color: var(--green); font-size: 13px; }
.error-msg { color: var(--red);   font-size: 13px; }

.form-footer { padding-top: 4px; }

.run-section {
  margin-top: 32px; max-width: 640px;
  padding: 16px 20px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
}
.run-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.run-title  { font-weight: 600; font-size: 14px; }
.run-sub    { color: var(--muted); font-size: 12px; margin-top: 3px; }
</style>
