<template>
  <AskDialog v-if="current" :key="key" :d="current" />
</template>

<script setup>
import { ref, watch, defineComponent, h, nextTick } from 'vue';
import { current, settle } from '../dialog.js';
import { useDialog } from '../composables/useDialog.js';

// A fresh dialog each time, so focus handling (useDialog) runs per question.
const key = ref(0);
watch(current, () => { key.value++; });

const AskDialog = defineComponent({
  props: { d: { type: Object, required: true } },
  setup(props) {
    const d = props.d;
    const text = ref(d.input?.value || '');
    const cancel = () => settle(d.input || d.choices ? null : false);
    const { dialogEl } = useDialog(cancel);
    const inputEl = ref(null);
    if (d.input) nextTick(() => requestAnimationFrame(() => inputEl.value?.focus()));
    const tooShort = () => d.input && text.value.trim().length < (d.input.minLength || 0);
    const ok = () => {
      if (d.input) { if (!tooShort()) settle(text.value.trim()); return; }
      settle(true);
    };

    return () => h('div', { class: 'ask-overlay', onClick: (e) => { if (e.target === e.currentTarget) cancel(); } }, [
      h('div', { ref: dialogEl, class: 'ask', role: 'dialog', 'aria-modal': 'true', 'aria-label': d.title }, [
        h('div', { class: 'ask-title' }, d.title),
        d.message ? h('p', { class: 'ask-body' }, d.message) : null,
        d.details?.length ? h('ul', { class: 'ask-details' }, d.details.map(x => h('li', x))) : null,
        d.input ? h('input', {
          ref: inputEl, class: 'ask-input', type: d.input.type || 'text', value: text.value,
          placeholder: d.input.placeholder || '', autocomplete: d.input.type === 'password' ? 'new-password' : 'off',
          onInput: (e) => { text.value = e.target.value; },
          onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); ok(); } },
        }) : null,
        h('div', { class: 'ask-actions' }, d.choices
          ? [
            h('button', { class: 'btn-ghost', onClick: cancel }, d.cancelLabel),
            ...d.choices.map(c => h('button', {
              class: c.danger ? 'btn-danger' : c.primary ? 'btn-primary' : 'btn-ghost',
              onClick: () => settle(c.value),
            }, c.label)),
          ]
          : [
            h('button', { class: 'btn-ghost', onClick: cancel }, d.cancelLabel),
            h('button', {
              class: d.danger ? 'btn-danger' : 'btn-primary',
              disabled: tooShort(), onClick: ok,
            }, d.confirmLabel),
          ]),
      ]),
    ]);
  },
});
</script>

<style>
.ask-overlay {
  position: fixed; inset: 0; z-index: 450; padding: 16px;
  background: rgba(0, 0, 0, .7);
  display: flex; align-items: center; justify-content: center;
}
.ask {
  background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  padding: 20px; width: 100%; max-width: 440px;
}
.ask-title { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
.ask-body { font-size: 13px; color: var(--muted); line-height: 1.5; white-space: pre-line; }
.ask-details { margin: 10px 0 0; padding-left: 18px; font-size: 12px; color: var(--muted); line-height: 1.6; }
.ask-input { width: 100%; margin-top: 12px; }
.ask-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 18px; }
</style>
