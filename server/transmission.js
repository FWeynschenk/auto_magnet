'use strict';

const Transmission = require('transmission');
const { settings } = require('./db');
const { screenFiles } = require('./screen');

// --- Targets ---------------------------------------------------------------
//
// The settings pair `transmission_*` describes the default instance. Additional
// named instances live in `transmission_extra` as JSON, so a show can be routed
// to the machine whose disk it belongs on.
//
// Torrent ids are per-instance and start at 1 everywhere, so anything that
// tracks a torrent has to carry the instance name alongside the id — otherwise
// #3 on one box silently reports the progress of #3 on another.

const DEFAULT_TARGET = 'default';

function defaultTarget() {
  return {
    name: DEFAULT_TARGET,
    host: settings.get('transmission_host') || 'localhost',
    port: parseInt(settings.get('transmission_port') || '9091'),
    user: settings.get('transmission_user') || '',
    pw:   settings.get('transmission_pw')   || '',
  };
}

function extraTargets() {
  let raw;
  try { raw = JSON.parse(settings.get('transmission_extra') || '[]'); }
  catch (_) { return []; }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(t => t && t.name && t.name !== DEFAULT_TARGET && t.host)
    .map(t => ({
      name: String(t.name),
      host: String(t.host),
      port: parseInt(t.port || '9091'),
      user: t.user || '',
      pw:   t.pw   || '',
    }));
}

/** Every configured instance, default first. */
function listTargets() {
  return [defaultTarget(), ...extraTargets()];
}

/** Resolve a stored target name to its config, falling back to the default. */
function resolveTarget(name) {
  if (!name || name === DEFAULT_TARGET) return defaultTarget();
  return extraTargets().find(t => t.name === name) || defaultTarget();
}

function getClient(target) {
  const t = target || defaultTarget();
  return new Transmission({
    host:     t.host,
    port:     t.port,
    username: t.user,
    password: t.pw,
  });
}

function addByUrl(url, downloadDir, paused = false, target = null) {
  return new Promise((resolve, reject) => {
    getClient(target).addUrl(url, { 'download-dir': downloadDir, paused }, (err, arg) => {
      if (err) reject(err);
      else resolve(arg);
    });
  });
}

/** Raw RPC call, reusing the 409 session-id handshake. */
async function rpc(method, args, target = null) {
  const t    = target || defaultTarget();
  const host = t.host;
  const port = t.port;
  const user = t.user;
  const pass = t.pw;

  const rpcUrl  = `http://${host}:${port}/transmission/rpc`;
  const headers = { 'Content-Type': 'application/json' };
  if (user) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass || ''}`).toString('base64');
  }
  const body = JSON.stringify({ method, arguments: args });

  let r = await fetch(rpcUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) });
  if (r.status === 409) {
    headers['X-Transmission-Session-Id'] = r.headers.get('X-Transmission-Session-Id') || '';
    r = await fetch(rpcUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) });
  }
  const json = await r.json();
  if (json.result !== 'success') throw new Error(json.result || 'Transmission RPC error');
  return json.arguments;
}

/** File list for a torrent, or null while metadata is still being fetched. */
async function getTorrentFiles(id, target = null) {
  const args = await rpc('torrent-get', { ids: [id], fields: ['id', 'files', 'metadataPercentComplete'] }, target);
  const t = args?.torrents?.[0];
  if (!t) return null;
  if (typeof t.metadataPercentComplete === 'number' && t.metadataPercentComplete < 1) return null;
  if (!Array.isArray(t.files) || t.files.length === 0) return null;
  return t.files.map(f => ({ path: f.name, length: f.length }));
}

async function startTorrent(id, target = null) { await rpc('torrent-start',  { ids: [id] }, target); }
async function purgeTorrent(id, target = null) { await rpc('torrent-remove', { ids: [id], 'delete-local-data': true }, target); }

function screenedError(reason) {
  const err = new Error(`rejected by content screen: ${reason}`);
  err.screened = true;
  return err;
}

/** Default windows for waiting on magnet metadata, in milliseconds. */
const METADATA_WAIT_INLINE     = 30_000;
const METADATA_WAIT_BACKGROUND = 6 * 60_000;

/**
 * Wait for a paused torrent's metadata, screen the real file list, then start
 * or purge it. Resolves with the verdict rather than throwing, so it is safe to
 * run detached.
 */
async function screenPausedTorrent(id, { type = 'movie', waitMs = METADATA_WAIT_INLINE, allowPacks = false, target = null } = {}) {
  try {
    let files = null;
    const deadline = Date.now() + waitMs;
    // Metadata usually lands within seconds; back off after that so a six-minute
    // background wait isn't 180 RPC calls.
    let interval = 1500;
    while (!files && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, interval));
      files = await getTorrentFiles(id, target);
      interval = Math.min(interval * 1.4, 15000);
    }

    if (!files) {
      // Never resolved a file list, so the contents are unknowable. Which way to
      // fail is a judgement call, so it is a setting: 'start' keeps a possibly
      // good torrent (a magnet with no metadata isn't downloading anything
      // anyway), 'block' refuses to run anything that was never verified.
      if (settings.get('unverified_policy') === 'block') {
        console.warn(`[transmission] purging torrent #${id} — metadata never arrived, unverified content blocked`);
        try { await purgeTorrent(id, target); } catch (_) {}
        return { ok: false, reason: 'metadata never arrived — contents could not be verified' };
      }
      console.warn(`[transmission] torrent #${id} metadata timed out; starting unscreened`);
      await startTorrent(id, target);
      return { ok: true, warnings: ['metadata never arrived — started without a content check'] };
    }

    const verdict = screenFiles(files, { type, allowPacks });
    if (!verdict.ok) {
      console.warn(`[transmission] purging torrent #${id} — ${verdict.reason}`);
      try { await purgeTorrent(id, target); } catch (_) {}
      return verdict;
    }

    await startTorrent(id, target);
    return verdict;
  } catch (err) {
    // Screening itself broke — don't leave a paused orphan behind.
    console.error(`[transmission] screening torrent #${id} failed:`, err.message);
    try { await startTorrent(id, target); } catch (_) {}
    return { ok: true, warnings: [`content check failed: ${err.message}`] };
  }
}

/**
 * Add paused, wait for metadata, screen, then start or purge.
 *
 * With `onVerdict` the call returns as soon as Transmission has accepted the
 * torrent and the screening continues in the background. That matters because
 * waiting for magnet metadata takes tens of seconds, and there is no reason for
 * a user who just clicked Grab to sit through it — the torrent is already
 * queued, and if the screen later rejects it the item is purged and flagged.
 */
async function addScreened(url, downloadDir, screen, onVerdict, target = null) {
  const allowPacks = !!screen?.allowPacks;
  const added = await addByUrl(url, downloadDir, true, target);
  const id = added?.id;
  if (!id) throw new Error('Transmission did not return a torrent id');

  if (onVerdict) {
    screenPausedTorrent(id, { type: screen?.type, waitMs: METADATA_WAIT_BACKGROUND, allowPacks, target })
      .then(verdict => onVerdict(verdict, added))
      .catch(err => console.error('[transmission] background screen error:', err.message));
    return { ...added, screening: true };
  }

  const verdict = await screenPausedTorrent(id, { type: screen?.type, allowPacks, target });
  if (!verdict.ok) throw screenedError(verdict.reason);
  return added;
}

// Send .torrent file bytes as base64 via Transmission RPC directly.
// The transmission npm package doesn't expose the metainfo field, so we
// call the RPC ourselves. Needed when download_url is on the Docker-internal
// network that Transmission (on a different host) can't reach.
async function addByBase64(base64, downloadDir, target = null) {
  const t        = target || defaultTarget();
  const host     = t.host;
  const port     = t.port;
  const user     = t.user;
  const pass     = t.pw;

  const rpcUrl = `http://${host}:${port}/transmission/rpc`;
  const authHeader = user
    ? 'Basic ' + Buffer.from(`${user}:${pass || ''}`).toString('base64')
    : null;

  const baseHeaders = { 'Content-Type': 'application/json' };
  if (authHeader) baseHeaders['Authorization'] = authHeader;

  const body = JSON.stringify({
    method:    'torrent-add',
    arguments: { metainfo: base64, 'download-dir': downloadDir },
  });

  // Transmission requires X-Transmission-Session-Id; fetch it on first 409
  let r = await fetch(rpcUrl, { method: 'POST', headers: baseHeaders, body });
  if (r.status === 409) {
    const sessionId = r.headers.get('X-Transmission-Session-Id') || '';
    r = await fetch(rpcUrl, {
      method:  'POST',
      headers: { ...baseHeaders, 'X-Transmission-Session-Id': sessionId },
      body,
    });
  }

  const json = await r.json();
  if (json.result !== 'success') throw new Error(json.result || 'Transmission RPC error');
  const added = json.arguments?.['torrent-added'] || json.arguments?.['torrent-duplicate'];
  if (!added) throw new Error('Transmission did not return torrent info');
  return added;
}

/**
 * Add a magnet or .torrent URL to Transmission.
 *
 * @param {Object}   opts
 * @param {Object}   [opts.screen]     { type } — enables content screening
 * @param {Array}    [opts.files]      known file list; screens instantly, no waiting
 * @param {Function} [opts.onVerdict]  return immediately and screen in the background
 */
async function addTorrent(magnetOrUrl, downloadDir, opts = {}) {
  if (!magnetOrUrl) throw new Error('no magnet or download URL provided');

  // opts.target is a stored instance *name*; an unknown one falls back to the
  // default rather than failing, so deleting an instance never strands items.
  const target = resolveTarget(opts.target);

  // When the search already parsed the .torrent we know the contents, so the
  // verdict is free and instant — no paused add, no metadata wait, no polling.
  if (opts.screen && opts.files?.length) {
    const verdict = screenFiles(opts.files, {
      type: opts.screen.type || 'movie',
      allowPacks: !!opts.screen.allowPacks,
    });
    if (!verdict.ok) throw screenedError(verdict.reason);
    const added = await addByUrl(magnetOrUrl, downloadDir, false, target);
    if (opts.onVerdict) opts.onVerdict(verdict, added);
    return added;
  }

  if (magnetOrUrl.startsWith('magnet:')) {
    // A magnet carries no file list, so screen it via Transmission before it runs.
    if (opts.screen) return addScreened(magnetOrUrl, downloadDir, opts.screen, opts.onVerdict, target);
    return addByUrl(magnetOrUrl, downloadDir, false, target);
  }

  // .torrent URL — Prowlarr sometimes redirects these to magnet: URIs.
  // Catch the redirect manually; if it's a magnet use it directly.
  // Otherwise download the .torrent bytes and send as base64 metainfo.
  console.log('[transmission] resolving download URL:', magnetOrUrl.substring(0, 120));
  let resp;
  try {
    resp = await fetch(magnetOrUrl, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new Error(`download URL fetch failed: ${err.cause?.message || err.message}`);
  }

  const location = resp.headers.get('location') || '';
  if (location.startsWith('magnet:')) {
    console.log('[transmission] redirected to magnet, using directly');
    return addByUrl(location, downloadDir, false, target);
  }

  // Follow non-magnet redirects or read the body directly
  const redirectTo = (resp.status >= 300 && resp.status < 400 && location) ? location : null;
  let bodyResp = resp;
  if (redirectTo) {
    try {
      bodyResp = await fetch(redirectTo, { signal: AbortSignal.timeout(30000) });
    } catch (err) {
      throw new Error(`torrent redirect fetch failed: ${err.cause?.message || err.message}`);
    }
  }
  if (!bodyResp.ok) throw new Error(`Failed to download torrent file: HTTP ${bodyResp.status}`);
  const bytes = Buffer.from(await bodyResp.arrayBuffer());

  // We hold the .torrent, so screen its file list directly — no need to add it
  // to Transmission first.
  if (opts.screen) {
    const { parseTorrent } = require('./sources/torrent-meta');
    const meta = parseTorrent(bytes);
    if (meta?.files?.length) {
      const verdict = screenFiles(meta.files, {
        type: opts.screen.type || 'movie',
        allowPacks: !!opts.screen.allowPacks,
      });
      if (!verdict.ok) throw screenedError(verdict.reason);
      if (opts.onVerdict) opts.onVerdict(verdict, null);
    }
  }

  return addByBase64(bytes.toString('base64'), downloadDir, target);
}

function getTorrents(target = null) {
  return new Promise((resolve, reject) => {
    getClient(target).get((err, arg) => {
      if (err) reject(err);
      else resolve(arg?.torrents || []);
    });
  });
}

/**
 * Settle `promise` within `ms`, or resolve to `fallback`.
 *
 * The transmission client has no timeout of its own, so a host that is simply
 * switched off never calls back. With several instances configured that would
 * hang the status endpoint and the scheduler's progress sync indefinitely — one
 * unreachable box must not take the rest down with it.
 */
function withTimeout(promise, ms, fallback) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const PROBE_TIMEOUT_MS = 5000;

function testOne(target) {
  const probe = new Promise((resolve) => {
    try {
      getClient(target).sessionStats((err, arg) => {
        if (err) resolve({ name: target.name, connected: false, error: err.message });
        else resolve({ name: target.name, connected: true, stats: arg });
      });
    } catch (err) {
      resolve({ name: target.name, connected: false, error: err.message });
    }
  });
  return withTimeout(probe, PROBE_TIMEOUT_MS, {
    name: target.name, connected: false, error: 'timed out',
  });
}

/**
 * Status of every configured instance. The top-level `connected` still reports
 * the default one so existing callers (the navbar indicator) keep working.
 */
async function testConnection() {
  const results = await Promise.all(listTargets().map(testOne));
  const primary = results[0] || { connected: false, error: 'no instance configured' };
  return { ...primary, instances: results };
}

/**
 * Poll Transmission for all active torrents and return a Map of
 * torrentId → { progress: 0-100, done: boolean }
 */
async function getTorrentProgress() {
  const map = new Map();
  await Promise.all(listTargets().map(async (target) => {
    try {
      const torrents = await withTimeout(getTorrents(target), PROBE_TIMEOUT_MS * 3, null);
      if (torrents === null) {
        console.warn(`[transmission] "${target.name}" timed out while listing torrents`);
        return;
      }
      for (const t of torrents) {
        // Keyed by instance as well as id: ids restart at 1 on every box, so an
        // id alone would read another machine's torrent as this one's progress.
        map.set(progressKey(target.name, t.id), {
          progress: Math.round((t.percentDone || 0) * 100),
          done:     (t.percentDone || 0) >= 1,
        });
      }
    } catch (err) {
      console.warn(`[transmission] "${target.name}" unreachable: ${err.message}`);
    }
  }));
  return map;
}

/** Map key for getTorrentProgress(). */
function progressKey(targetName, torrentId) {
  return `${targetName || DEFAULT_TARGET}:${torrentId}`;
}

function removeTorrent(id, targetName = null) {
  const target = resolveTarget(targetName);
  return new Promise((resolve, reject) => {
    getClient(target).remove([id], false, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

module.exports = {
  addTorrent, getTorrents, getTorrentProgress, testConnection, removeTorrent,
  getTorrentFiles, startTorrent, purgeTorrent, screenPausedTorrent,
  listTargets, resolveTarget, progressKey, DEFAULT_TARGET,
};
