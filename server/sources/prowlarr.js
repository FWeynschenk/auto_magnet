'use strict';

const { settings } = require('../db');
const { cached }   = require('../search-cache');
const { parseTorrent, buildMagnet } = require('./torrent-meta');

// Category codes: 2000 = Movies, 5000 = TV
//
// search() returns raw rows: each carries a magnet *or* a download URL. Turning a
// download URL into a magnet costs a round trip per row, so that is deliberately
// NOT done here — the pipeline filters and scores first and only resolves the
// handful of rows that can actually win. Resolving 50 rows to show 10 was the
// single biggest source of "why is this taking a minute".
/**
 * @param {string} query
 * @param {string} type        'movie' | 'show' — picks the category
 * @param {Object} [opts]
 * @param {string} [opts.searchType]  Prowlarr search type. 'movie' and
 *   'tvsearch' make it parse {imdbid:…}, {tmdbid:…}, {season:…}, {episode:…}
 *   tokens out of the query and search by ID wherever the indexer supports it.
 *   Indexers that don't simply see the remaining text. Default 'search' is
 *   plain free text, as before.
 */
async function search(query, type = 'movie', { refresh = false, searchType = 'search' } = {}) {
  const host   = settings.get('prowlarr_host') || 'localhost';
  const port   = settings.get('prowlarr_port') || '9696';
  const apiKey = settings.get('prowlarr_api_key');

  if (!apiKey) {
    console.warn('[prowlarr] no API key configured, skipping');
    return [];
  }

  const category = type === 'movie' ? '2000' : '5000';
  const key = `prowlarr:${category}:${searchType}:${query.toLowerCase()}`;

  return cached(key, async () => {
    const url = `http://${host}:${port}/api/v1/search?query=${encodeURIComponent(query)}` +
      `&type=${searchType}&categories=${category}&limit=100`;
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'X-Api-Key': apiKey },
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) {
        console.warn(`[prowlarr] HTTP ${res.status} for "${query}"`);
        return [];
      }
      const data = await res.json();
      const items = (Array.isArray(data) ? data : []).map(item => ({
        source:       'prowlarr',
        indexer:      item.indexer || null,
        title:        item.title,
        seeders:      item.seeders ?? 0,
        leechers:     item.leechers ?? 0,
        size:         item.size ?? 0,
        magnet:       item.magnetUrl || buildMagnet(item.infoHash, item.title),
        download_url: item.downloadUrl || null,
        info_hash:    item.infoHash ? String(item.infoHash).toLowerCase() : null,
        published_at: item.publishDate || null,
        // Supplied only by indexers that know them; 0 means "unknown", never
        // "different". ImdbId arrives as a number — tt0133093 is 133093.
        imdb_id:      item.imdbId || null,
        tmdb_id:      item.tmdbId || null,
        tvdb_id:      item.tvdbId || null,
        // How many people actually took this release — a better signal of a
        // good one than seeders, which only say who is still sharing it.
        grabs:        item.grabs ?? null,
      })).filter(r => r.magnet || r.download_url);

      const withIds = items.filter(r => r.imdb_id || r.tmdb_id || r.tvdb_id).length;
      console.log(
        `[prowlarr] ${searchType} "${query}" → ${items.length} result(s), ${withIds} carrying an ID, ` +
        `in ${Math.round((Date.now() - started) / 1000)}s`,
      );
      return items;
    } catch (err) {
      console.error(`[prowlarr] search error for "${query}":`, err.message);
      return [];
    }
  }, { refresh });
}

/**
 * Turn a download URL into a magnet, in place. Returns true on success.
 *
 * Prowlarr either redirects to a magnet: URI or serves the .torrent bytes —
 * handle both. When we get the bytes we also keep the file list, which lets the
 * content screen judge real contents instead of guessing from the title.
 */
async function resolveMagnet(r) {
  if (r.magnet) return true;
  if (!r.download_url) return false;

  const apiKey  = settings.get('prowlarr_api_key');
  const headers = apiKey ? { 'X-Api-Key': apiKey } : {};
  try {
    let resp = await fetch(r.download_url, {
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(15000),
    });

    const location = resp.headers.get('location') || '';
    if (location.startsWith('magnet:')) {
      r.magnet = location;
      return true;
    }

    // Follow a single non-magnet redirect (may be relative) before reading the body
    if (resp.status >= 300 && resp.status < 400 && location) {
      const next = new URL(location, r.download_url).toString();
      if (next.startsWith('magnet:')) {
        r.magnet = next;
        return true;
      }
      resp = await fetch(next, { headers, signal: AbortSignal.timeout(15000) });
    }

    if (!resp.ok) return false;

    const meta = parseTorrent(Buffer.from(await resp.arrayBuffer()));
    if (!meta) return false;

    r.magnet    = buildMagnet(meta.infoHash, r.title, meta.trackers);
    r.info_hash = meta.infoHash;
    r.files     = meta.files;
    if (!r.size && meta.totalSize) r.size = meta.totalSize;
    return !!r.magnet;
  } catch (_) {
    return false; // unresolvable — the pipeline drops it
  }
}

/**
 * Structured-search tokens for a title. Prowlarr strips these out of the query
 * and passes them as parameters, leaving the title as the free-text fallback.
 */
function idTokens({ imdbId, tmdbId, season, episode }) {
  const t = [];
  if (imdbId)          t.push(`{imdbid:${String(imdbId).startsWith('tt') ? imdbId : 'tt' + String(imdbId).padStart(7, '0')}}`);
  if (tmdbId)          t.push(`{tmdbid:${tmdbId}}`);
  if (season  != null) t.push(`{season:${season}}`);
  if (episode != null) t.push(`{episode:${episode}}`);
  return t.join('');
}

module.exports = { search, resolveMagnet, idTokens };
