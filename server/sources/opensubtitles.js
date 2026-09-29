'use strict';

// OpenSubtitles REST API client (api.opensubtitles.com/api/v1).
//
// The rules this is written against, from OpenSubtitles' getting-started docs
// and OpenAPI spec:
//   * An Api-Key header on every request — it identifies the *application*
//     (a "consumer") — and a User-Agent of "<app> v<version>".
//   * A user login (JWT) is optional. Without one a consumer may download 5
//     subtitles per IP per 24h; a logged-in user gets their own allowance (20 on
//     a free account). Searching is not counted, only downloads.
//   * 5 requests per second per IP on the free consumer tier.
//   * /login: 1 per second, 10 per minute, 30 per hour. A 401 means stop —
//     retrying bad credentials is what that limit exists to punish.
//   * The JWT lasts 24h. An expired one comes back as an error, not silently.
//   * Download counters reset at midnight UTC.
//
// Everything goes through request(), which paces calls, waits out a 429, and
// renews a stale login once. The daily budget is tracked, and persisted, so
// that once it is spent nothing more is sent — not even searches — until the
// reset. That matters because the scheduler retries pending subtitles every
// run; without the gate each run would spend requests to learn the same thing.

const fs = require('fs');
const { settings } = require('../db');

const DEFAULT_BASE = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT   = 'auto_magnet v2';

const MIN_GAP_MS      = 260;           // ≤ 4 requests/second, under the limit of 5
const LOGIN_GAP_MS    = 60_000;        // at most one login a minute, whatever happens
const MAX_429_RETRIES = 2;

let session        = null;   // { token, base, at }
let lastLoginAt    = 0;
let loginBlockedUntil = 0;
let nextSlotAt     = 0;      // when the next request may start
let queue          = Promise.resolve();

// ─── configuration ────────────────────────────────────────────────────────────

/** A key is required; the login is optional and only raises the daily limit. */
function configured() {
  return !!settings.get('opensubtitles_api_key');
}

function hasLogin() {
  return !!(settings.get('opensubtitles_username') && settings.get('opensubtitles_password'));
}

// ─── daily download budget ────────────────────────────────────────────────────
//
// Kept in the settings table rather than in memory, so a restart doesn't cost
// a round of wasted searches to rediscover that the quota is spent.

function nextMidnightUtc() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

function exhaustedUntil() {
  return Number(settings.get('opensubtitles_exhausted_until') || 0);
}

function markExhausted(resetUtc) {
  const at = Number.isFinite(Date.parse(resetUtc)) ? Date.parse(resetUtc) : nextMidnightUtc();
  settings.set('opensubtitles_exhausted_until', String(at));
}

/** True while today's downloads are used up. Callers check before searching. */
function quotaExhausted() {
  return Date.now() < exhaustedUntil();
}

/** When the budget comes back, for log messages. */
function quotaResetsAt() {
  return new Date(exhaustedUntil() || nextMidnightUtc());
}

// ─── transport ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Wait for a free slot. Serialised, so concurrent callers share the pace. */
function takeSlot() {
  const turn = queue.then(async () => {
    const wait = nextSlotAt - Date.now();
    if (wait > 0) await sleep(wait);
    nextSlotAt = Date.now() + MIN_GAP_MS;
  });
  queue = turn.catch(() => {});
  return turn;
}

/** Seconds the server asked us to wait, from whichever header it sent. */
function retryAfterMs(res) {
  const s = Number(res.headers.get('retry-after') ?? res.headers.get('ratelimit-reset') ?? 1);
  return Math.min(Math.max(Number.isFinite(s) ? s : 1, 1), 30) * 1000;
}

/**
 * One API call, paced and retried.
 * @param {Object} opts  { method, body, auth: send the JWT if we have one }
 */
async function request(path, { method = 'GET', body, auth = true } = {}, attempt = 0) {
  await takeSlot();

  const base = session?.base || DEFAULT_BASE;
  const headers = {
    'Api-Key':    settings.get('opensubtitles_api_key'),
    'User-Agent': USER_AGENT,
    Accept:       'application/json',
  };
  if (body)                  headers['Content-Type'] = 'application/json';
  if (auth && session?.token) headers.Authorization  = `Bearer ${session.token}`;

  const res = await fetch(`${base}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  // The server says how much of this second is left; honour it rather than
  // finding out with a 429.
  if (res.headers.get('x-ratelimit-remaining-second') === '0') {
    nextSlotAt = Math.max(nextSlotAt, Date.now() + retryAfterMs(res));
  }

  if (res.status === 429) {
    if (attempt >= MAX_429_RETRIES) throw new Error('OpenSubtitles is rate limiting — will retry next run');
    nextSlotAt = Date.now() + retryAfterMs(res);
    return request(path, { method, body, auth }, attempt + 1);
  }

  const data = await res.json().catch(() => ({}));

  // A stale token is reported as an error rather than a clean 401 (the docs
  // mention a 500 saying "invalid"). Renew once and retry; never loop.
  const tokenProblem = res.status === 401 || (res.status >= 500 && /invalid|token|expired/i.test(data.message || ''));
  if (auth && session?.token && tokenProblem && attempt === 0) {
    session = null;
    await login();
    return request(path, { method, body, auth }, 1);
  }

  return { res, data };
}

// ─── login ────────────────────────────────────────────────────────────────────

/**
 * Log in if credentials are set and there isn't a live session. Resolves with
 * the session, or null when running on the key alone.
 */
let loginInFlight = null;

async function login() {
  if (!hasLogin()) return null;
  if (session && Date.now() - session.at < 23 * 3600 * 1000) return session;
  // Callers arriving while a login is under way share it rather than each
  // starting their own — or, worse, tripping the once-a-minute guard below.
  if (loginInFlight) return loginInFlight;
  loginInFlight = doLogin().finally(() => { loginInFlight = null; });
  return loginInFlight;
}

async function doLogin() {
  if (Date.now() < loginBlockedUntil) {
    throw new Error('OpenSubtitles login is backing off after a failure');
  }
  if (Date.now() - lastLoginAt < LOGIN_GAP_MS) {
    throw new Error('OpenSubtitles login was attempted less than a minute ago');
  }
  lastLoginAt = Date.now();

  const { res, data } = await request('/login', {
    method: 'POST', auth: false,
    body: {
      username: settings.get('opensubtitles_username'),
      password: settings.get('opensubtitles_password'),
    },
  });

  if (res.status === 401) {
    // Wrong credentials. Stop for a day rather than tripping the hourly login
    // limit on every scheduler run.
    loginBlockedUntil = Date.now() + 24 * 3600 * 1000;
    throw new Error('OpenSubtitles rejected the username or password');
  }
  if (!res.ok || !data.token) {
    loginBlockedUntil = Date.now() + 15 * 60 * 1000;
    throw new Error(`OpenSubtitles login failed: ${data.message || `HTTP ${res.status}`}`);
  }

  const host = data.base_url ? String(data.base_url).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
  session = { token: data.token, base: host ? `https://${host}/api/v1` : DEFAULT_BASE, at: Date.now() };

  // The login response already carries the user's allowance.
  const left = data.user?.remaining_downloads ?? data.user?.allowed_downloads;
  if (typeof left === 'number' && left <= 0) markExhausted(null);
  return session;
}

// ─── search ───────────────────────────────────────────────────────────────────

/** Query string with keys sorted and values lowercased, as the API asks. */
function qs(params) {
  return Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]).toLowerCase())}`)
    .join('&');
}

async function searchOnce(params) {
  const { res, data } = await request(`/subtitles?${qs(params)}`);
  if (!res.ok) throw new Error(`OpenSubtitles search failed: ${data.message || `HTTP ${res.status}`}`);
  return Array.isArray(data.data) ? data.data : [];
}

/** Subtitles that can be used as-is for one video file. */
function usable(item) {
  const a = item.attributes || {};
  return (a.files?.length === 1)           // multi-CD sets are for split files
      && !a.foreign_parts_only             // forced subs cover foreign dialogue only
      && !a.machine_translated
      && !a.ai_translated;
}

function releaseSimilarity(subRelease, torrentName) {
  const toks = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1));
  const a = toks(subRelease), b = toks(torrentName);
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  return hit / Math.max(a.size, b.size);
}

/**
 * Best subtitle for a file, or null.
 *
 * A file-hash match first — that subtitle was timed against this exact file.
 * Otherwise by IMDb/TMDB id, preferring one whose release name resembles the
 * torrent's (same group and source usually means the same cut and timing),
 * then trusted uploaders, then popularity.
 *
 * @param {Object} q  { hash, imdbId, tmdbId, season, episode, language, torrentName }
 */
async function findBest(q) {
  await login();

  const id = {};
  const imdb = q.imdbId ? String(q.imdbId).replace(/^tt/i, '').replace(/^0+/, '') : null;
  if (q.season != null && q.episode != null) {
    if (imdb)          id.parent_imdb_id = imdb;
    else if (q.tmdbId) id.parent_tmdb_id = q.tmdbId;
    id.season_number  = q.season;
    id.episode_number = q.episode;
    id.type = 'episode';
  } else {
    if (imdb)          id.imdb_id = imdb;
    else if (q.tmdbId) id.tmdb_id = q.tmdbId;
    id.type = 'movie';
  }
  const common = { languages: q.language, machine_translated: 'exclude', ai_translated: 'exclude' };

  if (q.hash) {
    const exact = (await searchOnce({ ...common, ...id, moviehash: q.hash, moviehash_match: 'only' })).filter(usable);
    if (exact.length > 0) return { item: exact[0], matchedBy: 'file hash' };
  }

  const byId = (await searchOnce({ ...common, ...id })).filter(usable);
  if (byId.length === 0) return null;

  byId.sort((x, y) => {
    const ax = x.attributes, ay = y.attributes;
    return (releaseSimilarity(ay.release, q.torrentName) - releaseSimilarity(ax.release, q.torrentName))
        || ((ay.from_trusted ? 1 : 0) - (ax.from_trusted ? 1 : 0))
        || ((ax.hearing_impaired ? 1 : 0) - (ay.hearing_impaired ? 1 : 0))
        || ((ay.download_count || 0) - (ax.download_count || 0));
  });
  return { item: byId[0], matchedBy: 'title id' };
}

// ─── download ─────────────────────────────────────────────────────────────────

function quotaError(message) {
  const err = new Error(message);
  err.quota = true;
  return err;
}

/**
 * Download one subtitle to `destPath`. Resolves { remaining } on success.
 * Throws with `quota: true` when today's allowance is spent.
 */
async function download(item, destPath) {
  if (quotaExhausted()) throw quotaError('OpenSubtitles downloads for today are used up');
  await login();

  const { res, data } = await request('/download', {
    method: 'POST',
    body: { file_id: item.attributes.files[0].file_id },
  });

  // Only the 200 response is documented, so a spent quota is recognised from
  // what is: the `remaining` count, and the wording of the refusal.
  if ((typeof data.remaining === 'number' && data.remaining < 0)
      || (!res.ok && /quota|limit|exceed|allowed|downloaded/i.test(data.message || ''))) {
    markExhausted(data.reset_time_utc);
    throw quotaError(`OpenSubtitles downloads for today are used up${data.reset_time ? ` (resets in ${data.reset_time})` : ''}`);
  }
  if (!res.ok || !data.link) {
    throw new Error(`OpenSubtitles download failed: ${data.message || `HTTP ${res.status}`}`);
  }

  // The link is temporary and served from their file host, not the API, so it
  // is fetched directly rather than through the paced API queue. Always UTF-8.
  const file = await fetch(data.link, { signal: AbortSignal.timeout(30_000) });
  if (!file.ok) throw new Error(`subtitle file fetch failed: HTTP ${file.status}`);
  const text = await file.text();
  if (!text.trim()) throw new Error('subtitle file was empty');
  fs.writeFileSync(destPath, text, 'utf8');

  // That was the last one for today: stop before the next search, not after.
  if (typeof data.remaining === 'number' && data.remaining <= 0) markExhausted(data.reset_time_utc);
  return { remaining: data.remaining, resetTime: data.reset_time };
}

// ─── file hash ────────────────────────────────────────────────────────────────

/**
 * The OpenSubtitles file hash: the file size plus the sum of the first and
 * last 64 KB read as little-endian unsigned 64-bit integers, wrapping at 2^64,
 * as 16 hex digits. Lets the API find subtitles timed to this exact file.
 */
function movieHash(path) {
  const CHUNK = 64 * 1024;
  const size  = fs.statSync(path).size;
  if (size < CHUNK * 2) return null;

  const fd = fs.openSync(path, 'r');
  try {
    const buf  = Buffer.alloc(CHUNK);
    const mask = (1n << 64n) - 1n;
    let hash   = BigInt(size);
    for (const offset of [0, size - CHUNK]) {
      fs.readSync(fd, buf, 0, CHUNK, offset);
      for (let i = 0; i < CHUNK; i += 8) hash = (hash + buf.readBigUInt64LE(i)) & mask;
    }
    return hash.toString(16).padStart(16, '0');
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  configured, hasLogin, quotaExhausted, quotaResetsAt,
  findBest, download, movieHash,
};
