'use strict';

// OpenSubtitles REST API client (api.opensubtitles.com/api/v1).
//
// What the API requires, from its published OpenAPI spec:
//   * an Api-Key header on every request, and a User-Agent of "<app> v<version>"
//   * a login token as well for /download — the Api-Key alone is not enough
//   * /login is rate limited (1/s, 10/min, 30/hour), and a 401 means stop:
//     retrying bad credentials is exactly what the limit exists to punish
//   * after login, further requests go to the base_url it returns
//
// The download quota isn't a documented constant; every /download response
// reports `remaining` and `reset_time`, so the live figure is what gets used.

const fs     = require('fs');
const { settings } = require('../db');

const DEFAULT_BASE = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT   = 'auto_magnet v2';

let session = null;          // { token, base, at }
let loginBlockedUntil = 0;   // back off after a failed login
let quotaExhaustedUntil = 0; // back off after running out of downloads

function configured() {
  return !!(settings.get('opensubtitles_api_key')
         && settings.get('opensubtitles_username')
         && settings.get('opensubtitles_password'));
}

function headers(extra = {}) {
  return {
    'Api-Key':      settings.get('opensubtitles_api_key'),
    'User-Agent':   USER_AGENT,
    'Content-Type': 'application/json',
    Accept:         'application/json',
    ...extra,
  };
}

/** A login token, cached for the day. Refuses to retry a rejected login. */
async function login() {
  // Tokens last 24h; renew a little early.
  if (session && Date.now() - session.at < 23 * 3600 * 1000) return session;
  if (Date.now() < loginBlockedUntil) throw new Error('OpenSubtitles login is backing off after a failure');

  const res = await fetch(`${DEFAULT_BASE}/login`, {
    method:  'POST',
    headers: headers(),
    body:    JSON.stringify({
      username: settings.get('opensubtitles_username'),
      password: settings.get('opensubtitles_password'),
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (res.status === 401) {
    // Wrong credentials. The API asks clients to stop, so stop for a day
    // rather than tripping its hourly limit on every scheduler run.
    loginBlockedUntil = Date.now() + 24 * 3600 * 1000;
    throw new Error('OpenSubtitles rejected the username or password');
  }
  if (!res.ok) {
    loginBlockedUntil = Date.now() + 15 * 60 * 1000;
    throw new Error(`OpenSubtitles login failed: HTTP ${res.status}`);
  }

  const body = await res.json();
  const base = body.base_url ? `https://${String(body.base_url).replace(/^https?:\/\//, '')}/api/v1` : DEFAULT_BASE;
  session = { token: body.token, base, at: Date.now() };
  return session;
}

/** Query string with keys sorted, as the API recommends for cache hits. */
function qs(params) {
  return Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]).toLowerCase())}`)
    .join('&');
}

async function searchOnce(params) {
  const base = session?.base || DEFAULT_BASE;
  const res = await fetch(`${base}/subtitles?${qs(params)}`, {
    headers: headers(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
    signal:  AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`OpenSubtitles search failed: HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.data) ? body.data : [];
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
 * A moviehash match first — that subtitle was timed against this exact file.
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
    if (imdb)     id.parent_imdb_id = imdb;
    else if (q.tmdbId) id.parent_tmdb_id = q.tmdbId;
    id.season_number  = q.season;
    id.episode_number = q.episode;
    id.type = 'episode';
  } else {
    if (imdb)     id.imdb_id = imdb;
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

/**
 * Download one subtitle to `destPath`. Resolves { remaining } on success.
 * Throws with `quota: true` when the daily allowance is spent.
 */
async function download(item, destPath) {
  if (Date.now() < quotaExhaustedUntil) {
    const err = new Error('OpenSubtitles download quota is used up');
    err.quota = true;
    throw err;
  }
  const s = await login();
  const fileId = item.attributes.files[0].file_id;

  const res = await fetch(`${s.base}/download`, {
    method:  'POST',
    headers: headers({ Authorization: `Bearer ${s.token}` }),
    body:    JSON.stringify({ file_id: fileId }),
    signal:  AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));

  // The spec documents only the 200 response, so quota exhaustion is detected
  // from what *is* documented — the `remaining` count — plus the message text,
  // rather than from a guessed status code.
  if ((typeof body.remaining === 'number' && body.remaining < 0)
      || (!res.ok && /quota|limit|exceed|allowed/i.test(body.message || ''))) {
    const reset = body.reset_time_utc ? Date.parse(body.reset_time_utc) : NaN;
    quotaExhaustedUntil = Number.isFinite(reset) ? reset : Date.now() + 6 * 3600 * 1000;
    const err = new Error(`OpenSubtitles download quota is used up${body.reset_time ? ` (resets in ${body.reset_time})` : ''}`);
    err.quota = true;
    throw err;
  }
  if (!res.ok || !body.link) throw new Error(`OpenSubtitles download failed: ${body.message || `HTTP ${res.status}`}`);

  // The link is temporary; fetch it now. The API always serves UTF-8.
  const file = await fetch(body.link, { signal: AbortSignal.timeout(30000) });
  if (!file.ok) throw new Error(`subtitle file fetch failed: HTTP ${file.status}`);
  const text = await file.text();
  if (!text.trim()) throw new Error('subtitle file was empty');

  fs.writeFileSync(destPath, text, 'utf8');
  if (typeof body.remaining === 'number' && body.remaining <= 0) {
    const reset = body.reset_time_utc ? Date.parse(body.reset_time_utc) : NaN;
    quotaExhaustedUntil = Number.isFinite(reset) ? reset : Date.now() + 6 * 3600 * 1000;
  }
  return { remaining: body.remaining, resetTime: body.reset_time };
}

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

module.exports = { configured, findBest, download, movieHash };
