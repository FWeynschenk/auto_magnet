'use strict';

const Transmission = require('transmission');
const { settings } = require('./db');

function getClient() {
  return new Transmission({
    host:     settings.get('transmission_host') || 'localhost',
    port:     parseInt(settings.get('transmission_port') || '9091'),
    username: settings.get('transmission_user'),
    password: settings.get('transmission_pw'),
  });
}

function addByUrl(url, downloadDir) {
  return new Promise((resolve, reject) => {
    getClient().addUrl(url, { 'download-dir': downloadDir }, (err, arg) => {
      if (err) reject(err);
      else resolve(arg);
    });
  });
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

async function addTorrent(magnetOrUrl, downloadDir) {
  if (!magnetOrUrl) throw new Error('no magnet or download URL provided');

  if (magnetOrUrl.startsWith('magnet:')) {
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
  const base64 = Buffer.from(await bodyResp.arrayBuffer()).toString('base64');
  return addByBase64(base64, downloadDir);
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

module.exports = { addTorrent, getTorrents, getTorrentProgress, testConnection };
