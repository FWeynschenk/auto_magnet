'use strict';

const express = require('express');
const router  = express.Router();
const { shows, episodes } = require('../db');
const { getTvDetails } = require('../tmdb');
const { run: runScheduler } = require('../scheduler');

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
