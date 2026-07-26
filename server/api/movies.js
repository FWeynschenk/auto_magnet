'use strict';

const express = require('express');
const router  = express.Router();
const { movies } = require('../db');
const { getMovieDetails, getMovieReleaseDates } = require('../tmdb');
const { run: runScheduler } = require('../scheduler');

router.get('/', (_req, res) => {
  res.json(movies.all());
});

router.post('/', async (req, res) => {
  const { tmdb_id, quality = '1080p', mode = 'auto' } = req.body;
  if (!tmdb_id) return res.status(400).json({ error: 'tmdb_id required' });

  try {
    const details = await getMovieDetails(tmdb_id);
    if (!details) return res.status(404).json({ error: 'Movie not found on TMDB' });

    const { tmdb_id: tid, imdb_id, title, year, poster_url } = details;

    // Fetch streaming/digital release date for the configured region
    const { settings } = require('../db');
    const region      = settings.get('tmdb_region') || 'US';
    const release_date = await getMovieReleaseDates(tid, region);

    const result = movies.insert({ tmdb_id: tid, imdb_id, title, year, poster_url, quality, mode, release_date });
    res.status(201).json(movies.byId(result.lastInsertRowid));
  } catch (err) {
    if (err.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Movie already added' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  const allowed = ['quality', 'mode', 'status', 'release_date'];
  const data = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );
  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No valid fields' });
  movies.update(req.params.id, data);
  res.json(movies.byId(req.params.id));
});

router.delete('/:id', (req, res) => {
  movies.remove(req.params.id);
  res.sendStatus(204);
});

// Reset a movie so it can be re-grabbed
router.post('/:id/redo', (req, res) => {
  const movie = movies.byId(req.params.id);
  if (!movie) return res.status(404).json({ error: 'Movie not found' });
  // tried_magnets must be cleared too — otherwise the selector still excludes every
  // previously attempted torrent and the redo fails instantly with no candidates.
  movies.update(req.params.id, {
    status: 'pending', magnet: null, torrent_id: null,
    results_cache: null, progress: 0, tried_magnets: null, download_started_at: null,
  });
  runScheduler().catch(() => {});
  res.json(movies.byId(req.params.id));
});

// Reset all failed movies to pending and kick the scheduler
router.post('/retry-failed', (req, res) => {
  const failed = movies.all().filter(m => m.status === 'failed');
  for (const m of failed) {
    movies.update(m.id, {
      status: 'pending', magnet: null, torrent_id: null,
      results_cache: null, progress: 0, tried_magnets: null, download_started_at: null,
    });
  }
  if (failed.length > 0) runScheduler().catch(() => {});
  res.json({ reset: failed.length });
});

module.exports = router;
