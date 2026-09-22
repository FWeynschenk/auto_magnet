'use strict';

const { cached } = require('../search-cache');

async function search(imdbId, season, episode, { refresh = false } = {}) {
  if (!imdbId) return [];

  // EZTV needs the numeric IMDB ID (strip 'tt' prefix)
  const numericId = String(imdbId).replace(/^tt/i, '');

  // The whole show is fetched and cached once, then filtered per episode in
  // memory — grabbing a back catalogue used to hit EZTV once per episode.
  const all = await cached(`eztv:${numericId}`, async () => {
    const url = `https://eztv.re/api/get-torrents?imdb_id=${numericId}&limit=100`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return [];
      const data = await res.json();
      if (!data.torrents) return [];

      return data.torrents.map(t => ({
        source:       'eztv',
        title:        t.title,
        seeders:      Number(t.seeds) || 0,
        size:         t.size_bytes ? parseInt(t.size_bytes) : 0,
        magnet:       t.magnet_url,
        // EZTV hands back season/episode as strings, so these must be coerced.
        // Comparing "3" !== 3 used to discard every single result.
        info_hash:    t.hash ? String(t.hash).toLowerCase() : null,
        season:       Number(t.season),
        episode:      Number(t.episode),
        published_at: t.date_released_unix
          ? new Date(t.date_released_unix * 1000).toISOString()
          : null,
      })).filter(r => r.magnet);
    } catch (err) {
      console.error('[eztv] search error:', err.message);
      return [];
    }
  }, { refresh });

  return all.filter(t => {
    if (season  != null && t.season  !== Number(season))  return false;
    if (episode != null && t.episode !== Number(episode)) return false;
    return true;
  });
}

module.exports = { search };
