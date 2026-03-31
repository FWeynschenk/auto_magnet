'use strict';

const TRACKERS = [
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:80',
  'udp://tracker.coppersurfer.tk:6969',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://p4p.arenabg.com:1337',
  'udp://tracker.leechers-paradise.org:6969',
].map(t => `&tr=${encodeURIComponent(t)}`).join('');

async function search(query, quality = '1080p') {
  const qualParam = ['2160p', '1080p', '720p'].includes(quality) ? `&quality=${quality}` : '';
  const url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=10${qualParam}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    if (data.status !== 'ok' || !data.data?.movies) return [];

    const results = [];
    for (const movie of data.data.movies) {
      for (const torrent of movie.torrents) {
        const magnet = `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(movie.title_long)}${TRACKERS}`;
        results.push({
          source:       'yts',
          title:        `${movie.title_long} [${torrent.quality}] [YTS]`,
          seeders:      torrent.seeds ?? 0,
          size:         torrent.size_bytes ?? 0,
          quality:      torrent.quality,
          magnet,
          info_hash:    torrent.hash,
          published_at: torrent.date_uploaded || null,
        });
      }
    }
    return results;
  } catch (err) {
    console.error('[yts] search error:', err.message);
    return [];
  }
}

module.exports = { search };
