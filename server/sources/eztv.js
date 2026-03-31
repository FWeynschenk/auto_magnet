'use strict';

async function search(imdbId, season, episode) {
  if (!imdbId) return [];

  // EZTV needs the numeric IMDB ID (strip 'tt' prefix)
  const numericId = String(imdbId).replace(/^tt/i, '');
  const url = `https://eztv.re/api/get-torrents?imdb_id=${numericId}&limit=100`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.torrents) return [];

    return data.torrents
      .filter(t => {
        if (season  !== undefined && t.season  !== season)  return false;
        if (episode !== undefined && t.episode !== episode) return false;
        return true;
      })
      .map(t => ({
        source:       'eztv',
        title:        t.title,
        seeders:      t.seeds ?? 0,
        size:         t.size_bytes ? parseInt(t.size_bytes) : 0,
        magnet:       t.magnet_url,
        info_hash:    t.hash || null,
        season:       t.season,
        episode:      t.episode,
        published_at: t.date_released_unix
          ? new Date(t.date_released_unix * 1000).toISOString()
          : null,
      }))
      .filter(r => r.magnet);
  } catch (err) {
    console.error('[eztv] search error:', err.message);
    return [];
  }
}

module.exports = { search };
