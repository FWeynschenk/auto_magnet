'use strict';

const Transmission = require('transmission');
const { settings } = require('./db');
const { screenFiles } = require('./screen');

function getClient() {
  return new Transmission({
    host:     settings.get('transmission_host') || 'localhost',
    port:     parseInt(settings.get('transmission_port') || '9091'),
    username: settings.get('transmission_user'),
    password: settings.get('transmission_pw'),
  });
}

function addByUrl(url, downloadDir, paused = false) {
  return new Promise((resolve, reject) => {
    getClient().addUrl(url, { 'download-dir': downloadDir, paused }, (err, arg) => {
      if (err) reject(err);
      else resolve(arg);
    });
  });
}

/** Raw RPC call, reusing the 409 session-id handshake. */
async function rpc(method, args) {
  const host = settings.get('transmission_host') || 'localhost';
  const port = parseInt(settings.get('transmission_port') || '9091');
  const user = settings.get('transmission_user');
  const pass = settings.get('transmission_pw');

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
async function getTorrentFiles(id) {
  const args = await rpc('torrent-get', { ids: [id], fields: ['id', 'files', 'metadataPercentComplete'] });
  const t = args?.torrents?.[0];
  if (!t) return null;
  if (typeof t.metadataPercentComplete === 'number' && t.metadataPercentComplete < 1) return null;
  if (!Array.isArray(t.files) || t.files.length === 0) return null;
  return t.files.map(f => ({ path: f.name, length: f.length }));
}

async function startTorrent(id)  { await rpc('torrent-start',  { ids: [id] }); }
async function purgeTorrent(id)  { await rpc('torrent-remove', { ids: [id], 'delete-local-data': true }); }

/**
 * Add paused, wait for metadata, screen the real file list, then start or purge.
 * This is how magnet-only results (EZTV, YTS, Prowlarr magnetUrl) get the same
 * content screening as results we resolved from .torrent bytes ourselves.
 */
async function addScreened(url, downloadDir, screen) {
  const added = await addByUrl(url, downloadDir, true);
  const id = added?.id;
  if (!id) throw new Error('Transmission did not return a torrent id');

  try {
    let files = null;
    // Magnet metadata usually lands in a few seconds; give it ~30s.
    for (let attempt = 0; attempt < 15 && !files; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      files = await getTorrentFiles(id);
    }

    if (!files) {
      // Never resolved a file list — let it run rather than discarding a good torrent.
      console.warn(`[transmission] torrent #${id} metadata timed out; starting unscreened`);
      await startTorrent(id);
      return added;
    }

    const verdict = screenFiles(files, { type: screen?.type || 'movie' });
    if (!verdict.ok) {
      console.warn(`[transmission] purging torrent #${id} — ${verdict.reason}`);
      await purgeTorrent(id);
      const err = new Error(`rejected by content screen: ${verdict.reason}`);
      err.screened = true;
      throw err;
    }

    await startTorrent(id);
    return added;
  } catch (err) {
    if (!err.screened) {
      // Screening itself broke — don't leave a paused orphan behind.
      try { await startTorrent(id); } catch (_) {}
    }
    throw err;
  }
}

// Send .torrent file bytes as base64 via Transmission RPC directly.
// The transmission npm package doesn't expose the metainfo field, so we
// call the RPC ourselves. Needed when download_url is on the Docker-internal
// network that Transmission (on a different host) can't reach.
async function addByBase64(base64, downloadDir) {
  const host     = settings.get('transmission_host') || 'localhost';
  const port     = parseInt(settings.get('transmission_port') || '9091');
  const user     = settings.get('transmission_user');
  const pass     = settings.get('transmission_pw');

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

async function addTorrent(magnetOrUrl, downloadDir, opts = {}) {
  if (!magnetOrUrl) throw new Error('no magnet or download URL provided');

  if (magnetOrUrl.startsWith('magnet:')) {
    // A magnet carries no file list, so screen it via Transmission before it runs.
    if (opts.screen) return addScreened(magnetOrUrl, downloadDir, opts.screen);
    return addByUrl(magnetOrUrl, downloadDir);
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
    return addByUrl(location, downloadDir);
  }

  // Follow non-magnet redirects or read the body directly
  const target = (resp.status >= 300 && resp.status < 400 && location) ? location : null;
  let bodyResp = resp;
  if (target) {
    try {
      bodyResp = await fetch(target, { signal: AbortSignal.timeout(30000) });
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
      const verdict = screenFiles(meta.files, { type: opts.screen.type || 'movie' });
      if (!verdict.ok) {
        const err = new Error(`rejected by content screen: ${verdict.reason}`);
        err.screened = true;
        throw err;
      }
    }
  }

  return addByBase64(bytes.toString('base64'), downloadDir);
}

function getTorrents() {
  return new Promise((resolve, reject) => {
    getClient().get((err, arg) => {
      if (err) reject(err);
      else resolve(arg.torrents || []);
    });
  });
}

function testConnection() {
  return new Promise((resolve) => {
    try {
      getClient().sessionStats((err, arg) => {
        if (err) resolve({ connected: false, error: err.message });
        else resolve({ connected: true, stats: arg });
      });
    } catch (err) {
      resolve({ connected: false, error: err.message });
    }
  });
}

/**
 * Poll Transmission for all active torrents and return a Map of
 * torrentId → { progress: 0-100, done: boolean }
 */
async function getTorrentProgress() {
  try {
    const torrents = await getTorrents();
    const map = new Map();
    for (const t of torrents) {
      map.set(t.id, {
        progress: Math.round((t.percentDone || 0) * 100),
        done:     (t.percentDone || 0) >= 1,
      });
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

function removeTorrent(id) {
  return new Promise((resolve, reject) => {
    getClient().remove([id], false, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

module.exports = {
  addTorrent, getTorrents, getTorrentProgress, testConnection, removeTorrent,
  getTorrentFiles, startTorrent, purgeTorrent,
};
