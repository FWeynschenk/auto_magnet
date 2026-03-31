'use strict';

const express = require('express');
const router  = express.Router();
const { movies } = require('../db');
const { getMovieDetails } = require('../tmdb');

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
    const result = movies.insert({ tmdb_id: tid, imdb_id, title, year, poster_url, quality, mode });
    res.status(201).json(movies.byId(result.lastInsertRowid));
  } catch (err) {
    if (err.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Movie already added' });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  const allowed = ['quality', 'mode', 'status'];
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

module.exports = router;
