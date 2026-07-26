<template>
  <div class="toast-host" role="status" aria-live="polite">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="t.type"
      >
        <span class="toast-icon">{{ t.type === 'success' ? '✓' : '!' }}</span>
        <span class="toast-msg">{{ t.message }}</span>
        <button class="toast-close" aria-label="Dismiss" @click="dismissToast(t.id)">✕</button>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup>
import { toasts, dismissToast } from '../toast.js';
</script>

<style scoped>
.toast-host {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 500;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(420px, calc(100vw - 32px));
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--surface);
  box-shadow: 0 6px 20px rgba(0, 0, 0, .4);
  font-size: 13px;
  pointer-events: auto;
}
.toast.error   { border-color: var(--red); }
.toast.success { border-color: var(--green); }

.toast-icon {
  flex-shrink: 0;
  width: 18px; height: 18px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700;
}
.toast.error   .toast-icon { background: var(--red);   color: #fff; }
.toast.success .toast-icon { background: var(--green); color: #052e16; }

.toast-msg { flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 1.4; }

.toast-close {
  background: none; border: none; color: var(--muted);
  font-size: 12px; padding: 0 2px; flex-shrink: 0; cursor: pointer;
}
.toast-close:hover { color: var(--text); }

.toast-enter-active, .toast-leave-active { transition: opacity .2s, transform .2s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(12px); }
</style>
