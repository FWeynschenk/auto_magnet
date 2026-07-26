<template>
  <div class="overlay" @click.self="$emit('cancel')">
    <div
      ref="dialogEl"
      class="dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
    >
      <div class="c-title">{{ title }}</div>
      <p class="c-body">{{ message }}</p>
      <ul v-if="details.length" class="c-details">
        <li v-for="d in details" :key="d">{{ d }}</li>
      </ul>
      <div class="c-actions">
        <button class="btn-ghost" @click="$emit('cancel')">{{ cancelLabel }}</button>
        <button :class="danger ? 'btn-danger' : 'btn-primary'" @click="$emit('confirm')">
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useDialog } from '../composables/useDialog.js';

const props = defineProps({
  title:        { type: String,  default: 'Are you sure?' },
  message:      { type: String,  default: '' },
  details:      { type: Array,   default: () => [] },
  confirmLabel: { type: String,  default: 'Confirm' },
  cancelLabel:  { type: String,  default: 'Cancel' },
  danger:       { type: Boolean, default: true },
});
const emit = defineEmits(['confirm', 'cancel']);

const { dialogEl } = useDialog(() => emit('cancel'));
</script>

<style scoped>
.overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, .7);
  display: flex; align-items: center; justify-content: center;
  z-index: 400; padding: 16px;
}
.dialog {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  width: 100%;
  max-width: 420px;
}
.c-title { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
.c-body  { font-size: 13px; color: var(--muted); line-height: 1.5; }
.c-details {
  margin: 10px 0 0; padding-left: 18px;
  font-size: 12px; color: var(--muted); line-height: 1.6;
}
.c-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
</style>
