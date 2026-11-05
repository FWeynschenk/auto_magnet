<template>
  <div class="login-wrap">
    <form class="login-card" @submit.prevent="submit">
      <div class="brand">⚡ auto_magnet</div>
      <h1>{{ setupRequired ? 'Create the admin account' : 'Sign in' }}</h1>
      <p v-if="setupRequired" class="note">
        This is the first account. It can manage downloads, settings and other users.
      </p>

      <label>Username
        <input v-model="username" type="text" autocomplete="username" autocapitalize="off" required autofocus />
      </label>
      <label>Password
        <input v-model="password" type="password" :autocomplete="setupRequired ? 'new-password' : 'current-password'" required />
      </label>
      <label v-if="setupRequired">Repeat password
        <input v-model="password2" type="password" autocomplete="new-password" required />
      </label>
      <label v-if="setupRequired && setupNeedsToken">Server token
        <input v-model="token" type="password" placeholder="the AMAGNET_TOKEN value from .env" required />
      </label>

      <div v-if="error" class="error">{{ error }}</div>
      <button type="submit" class="btn-primary" :disabled="busy">
        {{ busy ? '…' : (setupRequired ? 'Create account' : 'Sign in') }}
      </button>
    </form>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { auth } from '../api.js';
import { loadSession, setupRequired, setupNeedsToken, user } from '../session.js';

const router = useRouter();
const route = useRoute();
const username = ref('');
const password = ref('');
const password2 = ref('');
const token = ref('');
const error = ref('');
const busy = ref(false);

onMounted(async () => {
  await loadSession(true);
  if (user.value) go();
});

function go() {
  const next = typeof route.query.next === 'string' && route.query.next.startsWith('/') ? route.query.next : '/';
  router.replace(next);
}

async function submit() {
  error.value = '';
  if (setupRequired.value && password.value !== password2.value) {
    error.value = 'The passwords don\'t match';
    return;
  }
  busy.value = true;
  try {
    if (setupRequired.value) {
      await auth.setup({ username: username.value, password: password.value, token: token.value || undefined });
    } else {
      await auth.login({ username: username.value, password: password.value });
    }
    await loadSession(true);
    go();
  } catch (err) {
    error.value = err.message;
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
.login-card {
  width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 14px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 28px;
}
.brand { color: var(--accent); font-weight: 700; letter-spacing: .5px; }
h1 { font-size: 20px; }
.note { font-size: 13px; color: var(--muted); }
label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--muted); font-weight: 500; }
input {
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text); padding: 9px 12px; font-size: 14px; outline: none;
}
input:focus { border-color: var(--accent); }
button { padding: 10px; font-size: 14px; }
.error { color: var(--red); font-size: 13px; }
</style>
