'use strict';

const TRACKERS = [
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80',
  'udp://tracker.coppersurfer.tk:6969',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://p4p.arenabg.com:1337',
  'udp://tracker.leechers-paradise.org:6969',
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

const { cached } = require('../search-cache');

async function search(query, quality = '1080p', { refresh = false } = {}) {
  // Quality is deliberately not sent to YTS: filtering server-side means a
  // 1080p-preferring user never sees the 2160p release that also exists, and the
  // selector scores quality far better than a hard API filter does.
  const url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=20`;

  return cached(`yts:${query.toLowerCase()}`, async () => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.status !== 'ok' || !data.data?.movies) return [];

    const results = [];
    for (const movie of data.data.movies) {
      for (const torrent of movie.torrents || []) {
        const magnet = `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(movie.title_long)}${TRACKERS}`;
        results.push({
          source:       'yts',
          indexer:      'YTS',
          // The codec and type belong in the title so the selector can score them
          // — YTS x265 web-rips and bluray rips are very different downloads.
          title:        `${movie.title_long} [${torrent.quality}] [${torrent.type || 'bluray'}] [${torrent.video_codec || 'x264'}] [YTS]`,
          seeders:      torrent.seeds ?? 0,
          leechers:     torrent.peers ?? 0,
          size:         torrent.size_bytes ?? 0,
          quality:      torrent.quality,
          year:         movie.year ?? null,
          magnet,
          info_hash:    torrent.hash ? String(torrent.hash).toLowerCase() : null,
          published_at: torrent.date_uploaded || null,
        });
      }
    }
    return results;
  } catch (err) {
    console.error('[yts] search error:', err.message);
    return [];
  }
  }, { refresh });
}

module.exports = { search };
