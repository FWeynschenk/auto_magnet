'use strict';

// Short-lived in-memory cache for source searches.
//
// Prowlarr fans every query out to all configured indexers, which routinely
// takes 10–60 seconds. Nothing about a torrent search changes minute to minute,
// so the same query inside the TTL is served from memory. That is what makes
// reopening the Choose Torrent dialog — or opening it right after a scheduler
// run — instant instead of another full round trip.
//
// Concurrent callers for the same key share one in-flight request, so the
// scheduler and a user clicking Preview at the same moment never search twice.

const { settings } = require('./db');

const DEFAULT_TTL_MINUTES = 20;
const MAX_ENTRIES         = 300;

const store    = new Map(); // key -> { at, value }
const inflight = new Map(); // key -> Promise

function ttlMs() {
  const mins = parseInt(settings.get('search_cache_mins') || String(DEFAULT_TTL_MINUTES));
  return Math.max(0, Number.isFinite(mins) ? mins : DEFAULT_TTL_MINUTES) * 60 * 1000;
}

/** Cached value, or undefined when absent or expired. Also returns its age. */
function peek(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  const age = Date.now() - hit.at;
  if (age > ttlMs()) { store.delete(key); return undefined; }
  return { value: hit.value, age };
}

function put(key, value) {
  // Oldest-first eviction; insertion order is Map iteration order.
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { at: Date.now(), value });
}

/**
 * Run `fn` at most once per key within the TTL.
 *
 * @param {string}   key
 * @param {Function} fn        async producer
 * @param {Object}   [opts]
 * @param {boolean}  [opts.refresh]  bypass the cached value (still coalesces)
 */
async function cached(key, fn, { refresh = false } = {}) {
  if (!refresh) {
    const hit = peek(key);
    if (hit) return hit.value;
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const value = await fn();
      put(key, value);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/** Age in ms of a cached key, or null. Used to tell the UI how fresh a list is. */
function ageOf(key) {
  return peek(key)?.age ?? null;
}

function clear(prefix) {
  if (!prefix) { store.clear(); return; }
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** Store an arbitrary value under the same TTL as searches. */
function remember(key, value) { put(key, value); }

/** Read back a remembered value, or undefined once it has expired. */
function recall(key) { return peek(key)?.value; }

function stats() {
  return { entries: store.size, inflight: inflight.size, ttl_ms: ttlMs() };
}

module.exports = { cached, peek, ageOf, clear, stats, remember, recall };
