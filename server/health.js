'use strict';

// One view of whether the box is well: every disk that matters and every
// service auto_magnet depends on. Both outages so far (a full media disk, a
// stalled Watch library) were visible days ahead to anyone looking at free
// space — this is where to look.

const fs = require('fs');
const path = require('path');
const { settings, DB_PATH } = require('./db');
const tx = require('./transmission');
const diskguard = require('./diskguard');

const TIMEOUT_MS = 5000;

const withTimeout = (p, ms = TIMEOUT_MS) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms).unref()),
]);

/** Free bytes on the disk holding `dir` (its nearest existing parent). */
function freeAt(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(d)) {
      try { const s = fs.statfsSync(d); return { free: Number(s.bavail) * Number(s.bsize), size: Number(s.blocks) * Number(s.bsize) }; }
      catch (_) { return { free: null, size: null }; }
    }
    if (path.dirname(d) === d) return { free: null, size: null };
  }
}

async function prowlarr() {
  const key = settings.get('prowlarr_api_key');
  if (!key) return { name: 'Prowlarr', ok: false, detail: 'no API key set' };
  const base = `http://${settings.get('prowlarr_host') || 'localhost'}:${settings.get('prowlarr_port') || '9696'}`;
  try {
    const res = await fetch(`${base}/api/v1/health`, { headers: { 'X-Api-Key': key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { name: 'Prowlarr', ok: false, detail: `HTTP ${res.status}` };
    const issues = await res.json().catch(() => []);
    const serious = (Array.isArray(issues) ? issues : []).filter(i => i.type === 'error' || i.type === 'warning');
    return {
      name: 'Prowlarr', ok: true, warn: serious.length > 0,
      detail: serious.length ? serious.map(i => i.message).slice(0, 3).join(' · ') : 'reachable, no issues',
    };
  } catch (err) {
    return { name: 'Prowlarr', ok: false, detail: err.name === 'TimeoutError' ? 'no answer' : err.message };
  }
}

async function tmdb() {
  const key = settings.get('tmdb_api_key') || process.env.TMDB_API_KEY;
  if (!key) return { name: 'TMDB', ok: false, detail: 'no API key set' };
  try {
    const res = await fetch(`https://api.themoviedb.org/3/configuration?api_key=${key}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { name: 'TMDB', ok: res.ok, detail: res.ok ? 'reachable' : res.status === 401 ? 'the API key is refused' : `HTTP ${res.status}` };
  } catch (err) {
    return { name: 'TMDB', ok: false, detail: err.name === 'TimeoutError' ? 'no answer' : err.message };
  }
}

function opensubtitles() {
  const os = require('./sources/opensubtitles');
  if (!os.configured()) return { name: 'OpenSubtitles', ok: false, warn: true, detail: 'not set up — subtitles are only taken from the release' };
  if (os.quotaExhausted()) {
    return { name: 'OpenSubtitles', ok: true, warn: true, detail: `today's downloads are used up, back ${os.quotaResetsAt().toISOString()}` };
  }
  return { name: 'OpenSubtitles', ok: true, detail: os.hasLogin() ? 'signed in' : 'API key only (fewer downloads a day)' };
}

async function report() {
  const media = require('./media');
  const scheduler = require('./scheduler');

  const [conn, prow, tm, encoder] = await Promise.all([
    withTimeout(tx.testConnection()).catch(err => ({ instances: [{ name: 'default', connected: false, error: err.message }] })),
    prowlarr(),
    tmdb(),
    media.pickEncoder().catch(() => 'x264'),
  ]);

  const web = media.spaceStatus();
  const dbDir = path.dirname(path.resolve(DB_PATH));
  const disks = [
    ...diskguard.status().map(d => ({
      label: `Downloads${tx.listTargets().length > 1 ? ` (${d.name})` : ''}`,
      path: d.path || [settings.get('movie_path'), settings.get('shows_path')].filter(Boolean).join(', ') || null,
      free: d.free ?? null, min: d.min, low: !!d.low, note: d.error ? `Transmission: ${d.error}` : (d.free == null ? 'not measured yet' : null),
      checkedAt: d.checkedAt || null,
    })),
    { label: 'Web versions', path: web.path, ...freeAt(web.path), min: web.min, low: !!web.paused },
    { label: 'Database', path: dbDir, ...freeAt(dbDir), min: 1e9, low: (freeAt(dbDir).free ?? Infinity) < 1e9 },
  ];

  const services = [
    ...(conn.instances || []).map(i => ({
      name: `Transmission${(conn.instances || []).length > 1 ? ` (${i.name})` : ''}`, ok: !!i.connected,
      detail: i.connected
        ? `${i.stats?.activeTorrentCount ?? '?'} active of ${i.stats?.torrentCount ?? '?'} torrents`
        : (i.error || 'unreachable'),
    })),
    prow, tm, opensubtitles(),
    { name: 'Encoder', ok: true, detail: encoder === 'vaapi' ? 'GPU (VAAPI)' : 'CPU (libx264)', warn: encoder !== 'vaapi' && settings.get('web_encoder') !== 'x264' },
  ];

  const q = media.queue();
  return {
    disks, services,
    scheduler: scheduler.runInfo(),
    queue: {
      converting: q.filter(r => r.web_state === 'encoding').length,
      waiting: q.filter(r => r.web_state === 'queued').length,
    },
    backup: require('./backup').status(),
  };
}

module.exports = { report, freeAt };
