'use strict';

const express  = require('express');
const router   = express.Router();
const { searchMulti, getMovieDetails, getTvDetails } = require('../tmdb');
const prowlarr = require('../sources/prowlarr');
const yts      = require('../sources/yts');
const eztv     = require('../sources/eztv');
const { select } = require('../selector');
const { settings, movies, shows, episodes } = require('../db');
const { addTorrent } = require('../transmission');

/** Cached scheduler results for a movie/episode, filtered to grabbable rows. */
function cachedResults(movieId, episodeId) {
  const row = movieId   ? movies.byId(movieId)
            : episodeId ? episodes.byId(episodeId)
            : null;
  if (!row?.results_cache) return null;
  try {
    return JSON.parse(row.results_cache).filter(r => r.magnet);
  } catch (_) {
    return null; // malformed cache — fall through to a live search
  }
}

// TMDB type-ahead for the Add dialog
router.get('/tmdb', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  try {
    res.json(await searchMulti(q));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Preview top 5 scored results for a title (used by manual-mode items and preview button)
router.post('/preview', async (req, res) => {
  const { tmdb_id, type, season, episode: ep, quality = '1080p', movie_id, episode_id } = req.body;
  if (!tmdb_id || !type) return res.status(400).json({ error: 'tmdb_id and type required' });

  // Return cached results if available (scheduler pre-searched for manual-mode items).
  // Only rows that carry a magnet are served: anything the user can click must be
  // immediately grabbable, and caches written before magnet-only filtering may still
  // hold download-URL-only rows. If nothing survives, fall through to a live search.
  const cached = cachedResults(movie_id, episode_id);
  if (cached?.length) return res.json(cached);

  try {
    let title, imdbId, year;
    if (type === 'movie') {
      const d = await getMovieDetails(tmdb_id);
      if (!d) return res.status(404).json({ error: 'Not found on TMDB' });
      ({ title, imdb_id: imdbId, year } = d);
    } else {
      const d = await getTvDetails(tmdb_id);
      if (!d) return res.status(404).json({ error: 'Not found on TMDB' });
      ({ title, imdb_id: imdbId } = d);
    }

    let results;
    if (type === 'movie') {
      const [pr, yr] = await Promise.all([
        prowlarr.search(`${title} ${year || ''}`.trim(), 'movie'),
        yts.search(title, quality),
      ]);
      results = [...pr, ...yr];
    } else {
      const epStr = (season && ep)
        ? `S${String(season).padStart(2, '0')}E${String(ep).padStart(2, '0')}`
        : '';
      const [pr, ez] = await Promise.all([
        prowlarr.search(`${title} ${epStr}`.trim(), 'show'),
        eztv.search(imdbId, season, ep),
      ]);
      results = [...pr, ...ez];
    }

    const top = select(results, { preferredQuality: quality, type, limit: 5 });
    res.json(Array.isArray(top) ? top : top ? [top] : []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Grab a specific torrent result (manual-mode confirm)
router.post('/grab', async (req, res) => {
  const { torrent, media_id, media_type, season, episode: ep } = req.body;
  const torrentUrl = torrent?.magnet || torrent?.download_url;
  if (!torrentUrl) return res.status(400).json({ error: 'torrent.magnet or torrent.download_url required' });
  if (!media_id)   return res.status(400).json({ error: 'media_id required' });

  try {
    const startedAt = new Date().toISOString();

    if (media_type === 'movie') {
      const downloadDir = settings.get('movie_path');
      const result = await addTorrent(torrentUrl, downloadDir, {
        screen: { type: 'movie', title: torrent.title },
      });
      // download_started_at is required for stale-download recovery to ever kick in
      movies.update(media_id, {
        status: 'downloading', magnet: torrentUrl, torrent_id: result.id,
        results_cache: null, download_started_at: startedAt,
      });
      res.json({ success: true, torrent_id: result.id });
    } else {
      const show = shows.byId(media_id);
      if (!show) return res.status(404).json({ error: 'Show not found' });
      const downloadDir = `${settings.get('shows_path')}/${show.title}`;
      const result = await addTorrent(torrentUrl, downloadDir, {
        screen: { type: 'show', title: torrent.title },
      });
      const epSeason  = season || 1;
      const epEpisode = ep     || 1;
      const existing  = episodes.get(media_id, epSeason, epEpisode);
      if (existing) {
        episodes.update(existing.id, {
          status: 'downloading', magnet: torrentUrl, torrent_id: result.id,
          results_cache: null, download_started_at: startedAt,
        });
      } else {
        episodes.insert({
          show_id:    media_id,
          season:     epSeason,
          episode:    epEpisode,
          status:     'downloading',
          magnet:     torrentUrl,
          torrent_id: result.id,
        });
        const inserted = episodes.get(media_id, epSeason, epEpisode);
        if (inserted) episodes.update(inserted.id, { download_started_at: startedAt });
      }
      res.json({ success: true, torrent_id: result.id });
    }
  } catch (err) {
    // A content-screen rejection is a client-actionable 422, not a server fault
    if (err.screened) return res.status(422).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
