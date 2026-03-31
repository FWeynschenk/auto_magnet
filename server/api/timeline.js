'use strict';

const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

router.get('/', (_req, res) => {
  const past   = "date('now', '-7 days')";
  const future = "date('now', '+60 days')";

  const movieRows = db.prepare(`
    SELECT id, title, poster_url, status, release_date AS date, year, progress
    FROM   movies
    WHERE  release_date IS NOT NULL
      AND  release_date >= ${past}
      AND  release_date <= ${future}
    ORDER BY release_date
  `).all();

  const episodeRows = db.prepare(`
    SELECT e.id, e.season, e.episode, e.status, e.air_date AS date, e.progress,
           s.id AS show_id, s.title, s.poster_url
    FROM   episodes e
    JOIN   shows    s ON s.id = e.show_id
    WHERE  e.air_date IS NOT NULL
      AND  e.air_date >= ${past}
      AND  e.air_date <= ${future}
    ORDER BY e.air_date
  `).all();

  const items = [
    ...movieRows.map(r => ({ type: 'movie',   ...r, subtitle: String(r.year || '') })),
    ...episodeRows.map(r => ({
      type:      'episode',
      id:        r.id,
      show_id:   r.show_id,
      title:     r.title,
      subtitle:  `S${String(r.season).padStart(2,'0')}E${String(r.episode).padStart(2,'0')}`,
      poster_url: r.poster_url,
      status:    r.status,
      date:      r.date,
      progress:  r.progress,
    })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  res.json(items);
});

module.exports = router;
