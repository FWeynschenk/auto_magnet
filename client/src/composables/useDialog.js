import { onMounted, onUnmounted, ref } from 'vue';

/**
 * Shared modal behaviour: Escape to close, focus moved into the dialog on open,
 * focus trapped inside it while open, and focus restored to the trigger on close.
 *
 * Usage:
 *   const { dialogEl } = useDialog(() => emit('close'));
 *   <div class="dialog" ref="dialogEl" role="dialog" aria-modal="true">
 */
export function useDialog(onClose) {
  const dialogEl = ref(null);
  let previouslyFocused = null;

  const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function focusable() {
    if (!dialogEl.value) return [];
    return Array.from(dialogEl.value.querySelectorAll(FOCUSABLE))
      .filter(el => el.offsetParent !== null);
  }

  function onKeydown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose?.();
      return;
    }
    if (e.key !== 'Tab') return;

    const items = focusable();
    if (items.length === 0) return;
    const first = items[0];
    const last  = items[items.length - 1];

    // Wrap focus so Tab can't escape the modal into the page behind it
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  onMounted(() => {
    previouslyFocused = document.activeElement;
    document.addEventListener('keydown', onKeydown, true);
    // Prevent the page behind the modal from scrolling
    document.body.style.overflow = 'hidden';
    // Move focus in, preferring the first real control over the close button
    requestAnimationFrame(() => {
      const items = focusable();
      const target = items.find(el => !el.classList.contains('close-btn')) || items[0];
      target?.focus();
    });
  });

  onUnmounted(() => {
    document.removeEventListener('keydown', onKeydown, true);
    document.body.style.overflow = '';
    previouslyFocused?.focus?.();
  });

  return { dialogEl };
}
