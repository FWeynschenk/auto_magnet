'use strict';

const { settings } = require('../db');

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
    return (Array.isArray(data) ? data : [])
      .map(item => ({
        source:       'prowlarr',
        title:        item.title,
        seeders:      item.seeders ?? 0,
        size:         item.size ?? 0,
        magnet:       item.magnetUrl || buildMagnet(item.infoHash, item.title),
        download_url: item.downloadUrl || null,
        info_hash:    item.infoHash || null,
        published_at: item.publishDate || null,
      }))
      .filter(r => r.magnet || r.download_url);
  } catch (err) {
    console.error('[prowlarr] search error:', err.message);
    return [];
  }
}

function buildMagnet(hash, title) {
  if (!hash) return null;
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}`;
}

module.exports = { search };
