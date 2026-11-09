import { ref } from 'vue';

// In-app replacement for window.confirm / window.prompt: never the browser's own
// dialogs. One dialog at a time; DialogHost (in App.vue) draws it.
//
//   if (!(await ask({ title: 'Delete it?', message: '…', confirmLabel: 'Delete' }))) return;
//   const reason = await ask({ title: '…', input: { placeholder: '…' } });   // string, or null
//   const which = await ask({ title: '…', choices: [{ label, value }, …] }); // value, or null

export const current = ref(null);

export function ask(opts) {
  // A dialog can't show over an element in fullscreen (the video): leave it first.
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  if (current.value) current.value.resolve(null);
  return new Promise((resolve) => {
    current.value = {
      title: 'Are you sure?', message: '', details: [], confirmLabel: 'Confirm', cancelLabel: 'Cancel',
      danger: true, ...opts, resolve,
    };
  });
}

export function settle(value) {
  const c = current.value;
  current.value = null;
  c?.resolve(value);
}
