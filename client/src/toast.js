import { ref } from 'vue';

// Minimal app-wide notification store. Previously a failed remove/update/redo
// produced an unhandled rejection and, to the user, a button that did nothing.

export const toasts = ref([]);
let nextId = 1;

export function pushToast(message, type = 'error', ttl = 6000) {
  const id = nextId++;
  toasts.value.push({ id, message, type });
  if (ttl > 0) setTimeout(() => dismissToast(id), ttl);
  return id;
}

export function dismissToast(id) {
  toasts.value = toasts.value.filter(t => t.id !== id);
}

export const notifyError   = (msg) => pushToast(msg, 'error');
export const notifySuccess = (msg) => pushToast(msg, 'success', 3500);

/**
 * Run an async action, surfacing any failure as a toast instead of an unhandled
 * rejection. Returns the resolved value, or undefined when it failed.
 */
export async function guard(fn, context) {
  try {
    return await fn();
  } catch (err) {
    notifyError(context ? `${context}: ${err.message}` : err.message);
    return undefined;
  }
}
