import { ref, computed } from 'vue';
import { auth } from './api.js';

// Who is signed in, shared by the router guard, the nav bar and the views.
export const user = ref(null);
export const setupRequired = ref(false);
export const setupNeedsToken = ref(false);
export const isAdmin = computed(() => user.value?.role === 'admin');

let loaded = null;

/** Ask the server once per page load (or again with force). */
export function loadSession(force = false) {
  if (loaded && !force) return loaded;
  loaded = auth.status().then(s => {
    user.value = s.user;
    setupRequired.value = s.setupRequired;
    setupNeedsToken.value = s.setupNeedsToken;
    return s;
  }).catch(() => {
    user.value = null;
    return { user: null };
  });
  return loaded;
}

export async function signOut() {
  try { await auth.logout(); } catch (_) {}
  user.value = null;
  loaded = null;
}
