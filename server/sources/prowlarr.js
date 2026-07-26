'use strict';

const { settings } = require('../db');
const { parseTorrent, buildMagnet } = require('./torrent-meta');

// Category codes: 2000 = Movies, 5000 = TV
async function search(query, type = 'movie') {
  const host   = settings.get('prowlarr_host') || 'localhost';
  const port   = settings.get('prowlarr_port') || '9696';
  const apiKey = settings.get('prowlarr_api_key');

  if (!apiKey) {
    console.warn('[prowlarr] no API key configured, skipping');
    return [];
  }

  const category = type === 'movie' ? '2000' : '5000';
  const url = `http://${host}:${port}/api/v1/search?query=${encodeURIComponent(query)}&categories=${category}&limit=50`;

  try {
    const res = await fetch(url, {
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) {
      console.warn(`[prowlarr] HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const items = (Array.isArray(data) ? data : []).map(item => ({
      source:       'prowlarr',
      title:        item.title,
      seeders:      item.seeders ?? 0,
      size:         item.size ?? 0,
      magnet:       item.magnetUrl || buildMagnet(item.infoHash, item.title),
      download_url: item.downloadUrl || null,
      info_hash:    item.infoHash || null,
      published_at: item.publishDate || null,
    }));

    // A result without a magnet can't be grabbed reliably, so resolve every
    // download-URL-only result to a magnet now and drop whatever won't resolve.
    // Doing it here rather than at grab time means the list the user sees only
    // ever contains torrents that are actually grabbable.
    await Promise.all(items
      .filter(r => !r.magnet && r.download_url)
      .map(r => resolveMagnet(r, apiKey))
    );

    const grabbable = items.filter(r => r.magnet);
    const dropped   = items.length - grabbable.length;
    if (dropped > 0) {
      console.log(`[prowlarr] dropped ${dropped}/${items.length} result(s) with no resolvable magnet`);
    }
    return grabbable;
  } catch (err) {
    console.error('[prowlarr] search error:', err.message);
    return [];
  }
}

/**
 * Turn a download URL into a magnet, in place.
 * Prowlarr either redirects to a magnet: URI or serves the .torrent bytes —
 * handle both, since anything left without a magnet gets dropped.
 */
async function resolveMagnet(r, apiKey) {
  const headers = { 'X-Api-Key': apiKey };
  try {
    let resp = await fetch(r.download_url, {
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(15000),
    });

    const location = resp.headers.get('location') || '';
    if (location.startsWith('magnet:')) {
      r.magnet = location;
      return;
    }

    // Follow a single non-magnet redirect (may be relative) before reading the body
    if (resp.status >= 300 && resp.status < 400 && location) {
      const next = new URL(location, r.download_url).toString();
      if (next.startsWith('magnet:')) {
        r.magnet = next;
        return;
      }
      resp = await fetch(next, { headers, signal: AbortSignal.timeout(15000) });
    }

    if (!resp.ok) return;

    const meta = parseTorrent(Buffer.from(await resp.arrayBuffer()));
    if (meta) {
      r.magnet    = buildMagnet(meta.infoHash, r.title, meta.trackers);
      r.info_hash = meta.infoHash;
      // Carry the file list through so the selector can screen real contents
      // rather than guessing from the title.
      r.files     = meta.files;
      if (!r.size && meta.totalSize) r.size = meta.totalSize;
    }
  } catch (_) {
    // Unresolvable — search() drops it from the result list
  }
}

module.exports = { search };
