import { onMounted, onUnmounted } from 'vue';

/**
 * Interval polling that pauses while the tab is hidden, and refreshes once
 * immediately on becoming visible again so the view isn't stale on return.
 *
 * Four independent always-on timers previously ran regardless of visibility.
 */
export function usePolling(fn, intervalMs) {
  let timer = null;

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') fn();
    }, intervalMs);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function onVisibility() {
    if (document.visibilityState === 'visible') {
      fn();      // catch up right away
      start();
    } else {
      stop();    // don't poll a tab nobody is looking at
    }
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState === 'visible') start();
  });

  onUnmounted(() => {
    document.removeEventListener('visibilitychange', onVisibility);
    stop();
  });

  return { start, stop };
}
