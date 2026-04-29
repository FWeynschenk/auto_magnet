'use strict';

const express = require('express');
const router  = express.Router();
const { shows, episodes } = require('../db');
const { getTvDetails, getSeasonDetails } = require('../tmdb');
const { run: runScheduler, hasAired, effectivelyAired } = require('../scheduler');

router.get('/', (_req, res) => {
  const allShows = shows.all();
  res.json(allShows.map(show => ({
    ...show,
    episodes: episodes.forShow(show.id),
  })));
});

router.post('/', async (req, res) => {
  const { tmdb_id, quality = '1080p', mode = 'auto', start_season = 1, start_episode = 1 } = req.body;
  if (!tmdb_id) return res.status(400).json({ error: 'tmdb_id required' });

  try {
    const details = await getTvDetails(tmdb_id);
    if (!details) return res.status(404).json({ error: 'Show not found on TMDB' });

    const { tmdb_id: tid, imdb_id, title, poster_url } = details;
    const result = shows.insert({ tmdb_id: tid, imdb_id, title, poster_url, quality, mode, start_season, start_episode });
    const show   = shows.byId(result.lastInsertRowid);
    res.status(201).json({ ...show, episodes: [] });
    // Populate upcoming timeline placeholders without blocking the response
    runScheduler().catch(() => {});
  } catch (err) {
    if (err.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Show already added' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  const allowed = ['quality', 'mode', 'active', 'status'];
  const data = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No valid fields' });
  shows.update(req.params.id, data);
  const show = shows.byId(req.params.id);
  res.json({ ...show, episodes: episodes.forShow(req.params.id) });
});

router.delete('/:id', (req, res) => {
  shows.remove(req.params.id);
  res.sendStatus(204);
});

router.get('/:id/episodes', (req, res) => {
  res.json(episodes.forShow(req.params.id));
});

// Re-fetch all season data from TMDB: update air dates, upgrade upcoming→pending, insert missing episodes
router.post('/:id/refresh-tmdb', async (req, res) => {
  const show = shows.byId(req.params.id);
  if (!show) return res.status(404).json({ error: 'Show not found' });

  try {
    const existingEps = episodes.forShow(show.id);
    const existingSeasons = [...new Set(existingEps.map(e => e.season))].sort((a, b) => a - b);
    const startSeason = show.start_season || 1;
    const maxExisting = existingSeasons.length > 0 ? Math.max(...existingSeasons) : startSeason;

    // Build the set of seasons to refresh: all existing + up to 2 ahead of the max
    const toFetch = new Set(existingSeasons);
    for (let s = startSeason; s <= maxExisting + 2; s++) toFetch.add(s);

    let updated = 0, added = 0;

    for (const s of [...toFetch].sort((a, b) => a - b)) {
      const seasonInfo = await getSeasonDetails(show.tmdb_id, s);
      if (!seasonInfo?.episodes?.length) continue;

      for (const epData of seasonInfo.episodes) {
        // Respect the configured start point
        if (s < startSeason) continue;
        if (s === startSeason && epData.episode_number < (show.start_episode || 1)) continue;

        const existingEp = existingEps.find(e => e.season === s && e.episode === epData.episode_number);

        if (existingEp) {
          const changes = {};
          if (existingEp.air_date !== epData.air_date) changes.air_date = epData.air_date;
          // Upgrade 'upcoming' rows to 'pending' if the episode has now aired
          if (existingEp.status === 'upcoming' &&
              effectivelyAired(epData.episode_number, seasonInfo.episodes)) {
            changes.status = 'pending';
          }
          if (Object.keys(changes).length > 0) {
            episodes.update(existingEp.id, changes);
            updated++;
          }
        } else {
          const aired = effectivelyAired(epData.episode_number, seasonInfo.episodes);
          const result = episodes.insert({
            show_id:    show.id,
            season:     s,
            episode:    epData.episode_number,
            status:     aired ? 'pending' : 'upcoming',
            air_date:   epData.air_date || null,
          });
          if (result.changes > 0) added++;
        }
      }
    }

    if (added > 0 || updated > 0) runScheduler().catch(() => {});

    const updatedShow = { ...shows.byId(show.id), episodes: episodes.forShow(show.id) };
    res.json({ updated, added, show: updatedShow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually insert a specific episode as pending (for when TMDB is missing data)
router.post('/:id/episodes/manual', (req, res) => {
  const show = shows.byId(req.params.id);
  if (!show) return res.status(404).json({ error: 'Show not found' });

  const season  = parseInt(req.body.season);
  const episode = parseInt(req.body.episode);
  if (!season || !episode || season < 1 || episode < 1) {
    return res.status(400).json({ error: 'Valid season and episode numbers required' });
  }

  const existing = episodes.get(show.id, season, episode);
  if (existing) {
    return res.status(409).json({ error: `S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')} already exists`, episode: existing });
  }

  episodes.insert({
    show_id:    show.id,
    season,
    episode,
    status:     'pending',
    air_date:   req.body.air_date || null,
  });

  const inserted = episodes.get(show.id, season, episode);
  runScheduler().catch(() => {});
  res.status(201).json(inserted);
});

// Reset an episode so it can be re-grabbed
router.post('/:id/episodes/:epId/redo', (req, res) => {
  const ep = episodes.byId(req.params.epId);
  if (!ep || String(ep.show_id) !== String(req.params.id)) {
    return res.status(404).json({ error: 'Episode not found' });
  }
  episodes.update(ep.id, { status: 'pending', magnet: null, torrent_id: null, results_cache: null, progress: 0 });
  res.json(episodes.byId(ep.id));
});

// Skip an episode so the scheduler advances past it
router.post('/:id/episodes/:epId/skip', (req, res) => {
  const ep = episodes.byId(req.params.epId);
  if (!ep || String(ep.show_id) !== String(req.params.id)) {
    return res.status(404).json({ error: 'Episode not found' });
  }
  episodes.update(ep.id, { status: 'skipped' });
  res.json(episodes.byId(ep.id));
});

// Reset all failed episodes across all shows to pending
router.post('/retry-failed', (req, res) => {
  const allShows   = shows.all();
  let resetCount   = 0;
  for (const show of allShows) {
    const failed = episodes.failed(show.id);
    for (const ep of failed) {
      episodes.update(ep.id, { status: 'pending', results_cache: null, progress: 0 });
      resetCount++;
    }
  }
  if (resetCount > 0) runScheduler().catch(() => {});
  res.json({ reset: resetCount });
});

module.exports = router;
