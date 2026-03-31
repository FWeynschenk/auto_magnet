<template>
  <div id="shell">
    <nav class="navbar">
      <span class="nav-brand">⚡ auto_magnet</span>
      <div class="nav-links">
        <RouterLink to="/movies">Movies</RouterLink>
        <RouterLink to="/shows">Shows</RouterLink>
        <RouterLink to="/settings">Settings</RouterLink>
      </div>
      <span class="tx-status" :class="txStatus.connected ? 'ok' : 'err'">
        ● {{ txStatus.connected ? 'Transmission' : 'No Transmission' }}
      </span>
    </nav>

    <main>
      <RouterView />
    </main>

    <TimelineStrip />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { settings } from './api.js';
import TimelineStrip from './components/TimelineStrip.vue';

const txStatus = ref({ connected: false });

async function checkStatus() {
  try { txStatus.value = await settings.status(); } catch (_) {}
}

onMounted(() => {
  checkStatus();
  setInterval(checkStatus, 30000);

  // Request browser notification permission on first load
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
});
</script>

<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:       #111827;
  --surface:  #1f2937;
  --border:   #374151;
  --text:     #f9fafb;
  --muted:    #9ca3af;
  --accent:   #6366f1;
  --accent-h: #818cf8;
  --green:    #22c55e;
  --yellow:   #f59e0b;
  --red:      #ef4444;
  --blue:     #3b82f6;
  --radius:   8px;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  line-height: 1.5;
}

a { color: inherit; text-decoration: none; }

button {
  cursor: pointer; border: none; border-radius: var(--radius);
  padding: 6px 14px; font-size: 13px; font-weight: 500;
  transition: opacity .15s;
}
button:hover   { opacity: .85; }
button:disabled { opacity: .4; cursor: default; }

.btn-primary { background: var(--accent); color: #fff; }
.btn-ghost   { background: transparent; color: var(--muted); border: 1px solid var(--border); }
.btn-danger  { background: var(--red); color: #fff; }
.btn-sm      { padding: 4px 10px; font-size: 12px; }
</style>

<style scoped>
#shell { display: flex; flex-direction: column; min-height: 100vh; }

.navbar {
  display: flex; align-items: center; gap: 24px;
  padding: 0 24px; height: 56px;
  background: var(--surface); border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 100;
}

.nav-brand { font-weight: 700; font-size: 16px; color: var(--accent); letter-spacing: .5px; }

.nav-links { display: flex; gap: 4px; }
.nav-links a {
  padding: 6px 14px; border-radius: var(--radius);
  color: var(--muted); font-weight: 500;
  transition: color .15s, background .15s;
}
.nav-links a:hover              { color: var(--text); background: var(--border); }
.nav-links a.router-link-active { color: var(--accent); }

.tx-status { margin-left: auto; font-size: 12px; font-weight: 500; }
.tx-status.ok  { color: var(--green); }
.tx-status.err { color: var(--red); }

main { flex: 1; padding: 24px; max-width: 1400px; margin: 0 auto; width: 100%; }
</style>
