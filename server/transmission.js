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

  // .torrent URL — download the file on this server (has Docker-internal access),
  // then send as metainfo base64 so Transmission doesn't need to reach that URL.
  const resp = await fetch(magnetOrUrl, { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`Failed to download torrent file: HTTP ${resp.status}`);
  const base64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
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

module.exports = { addTorrent, getTorrents, testConnection };
