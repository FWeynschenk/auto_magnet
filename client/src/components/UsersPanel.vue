<template>
  <section class="panel">
    <h2>Accounts</h2>
    <p class="muted small">
      Admins manage downloads and settings. Viewers can only watch, and each keeps their own progress.
    </p>

    <div class="users">
      <div v-for="u in users" :key="u.id" class="user">
        <div class="name">{{ u.username }} <span v-if="u.id === user?.id" class="muted small">(you)</span></div>
        <select :value="u.role" :disabled="u.id === user?.id" aria-label="Role" @change="setRole(u, $event.target.value)">
          <option value="viewer">Viewer</option>
          <option value="admin">Admin</option>
        </select>
        <span class="muted small last">{{ u.last_login_at ? `last sign-in ${u.last_login_at.slice(0, 10)}` : 'never signed in' }}</span>
        <button v-if="u.id !== user?.id" class="btn-ghost btn-sm" @click="resetPassword(u)">Set password</button>
        <button v-if="u.id !== user?.id" class="btn-ghost btn-sm danger" @click="remove(u)">Delete</button>
      </div>
    </div>

    <form class="add" @submit.prevent="add">
      <input v-model="nu.username" placeholder="New username" autocomplete="off" aria-label="New username" required />
      <input v-model="nu.password" type="password" placeholder="Password (8+ characters)" autocomplete="new-password" aria-label="Password" required />
      <select v-model="nu.role" aria-label="Role">
        <option value="viewer">Viewer</option>
        <option value="admin">Admin</option>
      </select>
      <button class="btn-primary btn-sm" type="submit">Add</button>
    </form>

    <h2 class="sub-h">Your account</h2>
    <form class="add" @submit.prevent="changePw">
      <input v-model="pw.current" type="password" placeholder="Current password" autocomplete="current-password" aria-label="Current password" required />
      <input v-model="pw.next" type="password" placeholder="New password" autocomplete="new-password" aria-label="New password" required />
      <button class="btn-ghost btn-sm" type="submit">Change password</button>
    </form>

    <div class="sessions">
      <div class="muted small">Signed-in devices</div>
      <div v-for="s in sessions" :key="s.id" class="sess">
        <span class="label" :title="s.label">{{ s.label || 'Unknown device' }}</span>
        <span class="muted small">{{ s.current ? 'this browser' : `seen ${s.last_seen_at.slice(0, 16)}` }}</span>
        <button v-if="!s.current" class="btn-ghost btn-sm" @click="revoke(s)">Sign out</button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ask } from '../dialog.js';
import { ref, onMounted } from 'vue';
import { auth } from '../api.js';
import { user } from '../session.js';
import { notifyError, notifySuccess } from '../toast.js';

const users = ref([]);
const sessions = ref([]);
const nu = ref({ username: '', password: '', role: 'viewer' });
const pw = ref({ current: '', next: '' });

async function load() {
  try {
    [users.value, sessions.value] = await Promise.all([auth.users(), auth.sessions()]);
  } catch (err) { notifyError(err.message); }
}

async function add() {
  try {
    await auth.createUser(nu.value);
    notifySuccess(`Added ${nu.value.username}`);
    nu.value = { username: '', password: '', role: 'viewer' };
    await load();
  } catch (err) { notifyError(err.message); }
}

async function setRole(u, role) {
  try { await auth.updateUser(u.id, { role }); await load(); }
  catch (err) { notifyError(err.message); await load(); }
}

async function resetPassword(u) {
  const p = await ask({ title: `New password for ${u.username}`, confirmLabel: 'Change password', danger: false,
    message: 'At least 8 characters. They will be signed out everywhere.',
    input: { type: 'password', minLength: 8, placeholder: 'New password' } });
  if (!p) return;
  try { await auth.updateUser(u.id, { password: p }); notifySuccess('Password changed'); }
  catch (err) { notifyError(err.message); }
}

async function remove(u) {
  if (!(await ask({ title: `Delete ${u.username}?`, confirmLabel: 'Delete', message: 'Their watch progress is deleted with them.' }))) return;
  try { await auth.removeUser(u.id); await load(); }
  catch (err) { notifyError(err.message); }
}

async function changePw() {
  try {
    await auth.changePassword(pw.value.current, pw.value.next);
    pw.value = { current: '', next: '' };
    notifySuccess('Password changed — other devices have been signed out');
    await load();
  } catch (err) { notifyError(err.message); }
}

async function revoke(s) {
  try { await auth.revokeSession(s.id); await load(); }
  catch (err) { notifyError(err.message); }
}

onMounted(load);
</script>

<style scoped>
.panel { max-width: 640px; margin-top: 32px; }
h2 { font-size: 15px; font-weight: 600; margin-bottom: 6px; }
.sub-h { margin-top: 22px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.danger { color: var(--red); }
.users { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
.user { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.name { font-weight: 600; min-width: 120px; }
.last { flex: 1; }
.add { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
input, select {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text); padding: 6px 10px; font-size: 13px; outline: none;
}
.add input { flex: 1; min-width: 140px; }
input:focus { border-color: var(--accent); }
.sessions { margin-top: 14px; display: flex; flex-direction: column; gap: 4px; }
.sess { display: flex; gap: 10px; align-items: center; font-size: 13px; }
.sess .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
