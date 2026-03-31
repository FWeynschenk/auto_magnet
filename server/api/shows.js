'use strict';

const express = require('express');
const router  = express.Router();
const { shows, episodes } = require('../db');
const { getTvDetails } = require('../tmdb');

router.get('/', (_req, res) => {
  const allShows = shows.all();
  res.json(allShows.map(show => ({
    ...show,
    episodes: episodes.forShow(show.id),
  })));
});

router.post('/', async (req, res) => {
  const { tmdb_id, quality = '1080p', mode = 'auto' } = req.body;
  if (!tmdb_id) return res.status(400).json({ error: 'tmdb_id required' });

  try {
    const details = await getTvDetails(tmdb_id);
    if (!details) return res.status(404).json({ error: 'Show not found on TMDB' });

    const result = shows.insert({ ...details, quality, mode });
    const show   = shows.byId(result.lastInsertRowid);
    res.status(201).json({ ...show, episodes: [] });
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

module.exports = router;
