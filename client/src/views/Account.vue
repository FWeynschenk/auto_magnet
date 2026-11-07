<template>
  <div class="account">
    <h1>Your account</h1>

    <section>
      <h2>Languages</h2>
      <p class="note">
        Which audio track and subtitles you get when you start something, first match wins.
        Leave a list empty to use the server's ({{ server.join(', ') || 'en' }}).
        What you pick in the player is remembered for that show or film, and wins over these.
      </p>
      <form class="fields" @submit.prevent="save">
        <label>Audio
          <input v-model="audio" type="text" placeholder="e.g. en, ja" autocomplete="off" />
          <span class="hint">two-letter codes: en, nl, de, fr, ja…</span>
        </label>
        <label>Subtitles
          <input v-model="sub" type="text" placeholder="e.g. nl, en" autocomplete="off" />
          <span class="hint">subtitles only show when one of these is available</span>
        </label>
        <div class="row">
          <button class="btn-primary btn-sm" type="submit" :disabled="saving">{{ saving ? 'Saving…' : 'Save' }}</button>
        </div>
      </form>
    </section>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { auth } from '../api.js';
import { notifyError, notifySuccess } from '../toast.js';

const audio = ref('');
const sub = ref('');
const server = ref([]);
const saving = ref(false);

function show(l) {
  audio.value = l.audio.join(', ');
  sub.value = l.sub.join(', ');
  server.value = l.server || [];
}

onMounted(async () => {
  try { show(await auth.languages()); } catch (err) { notifyError(err.message); }
});

async function save() {
  saving.value = true;
  try {
    show(await auth.setLanguages({ audio: audio.value, sub: sub.value }));
    notifySuccess('Languages saved');
  } catch (err) { notifyError(err.message); }
  finally { saving.value = false; }
}
</script>

<style scoped>
.account { max-width: 640px; }
h1 { font-size: 22px; font-weight: 700; margin-bottom: 24px; }
h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: 8px; }
.note { color: var(--muted); font-size: 12px; line-height: 1.5; margin-bottom: 14px; max-width: 70ch; }
.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 16px; }
label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
input {
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text); padding: 7px 10px; font-size: 13px; outline: none;
}
input:focus { border-color: var(--accent); }
.hint { color: var(--muted); font-size: 11px; }
.row { grid-column: 1 / -1; }
@media (max-width: 640px) { .fields { grid-template-columns: 1fr; } }
</style>
