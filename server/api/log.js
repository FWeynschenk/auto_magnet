'use strict';

const express = require('express');
const router  = express.Router();
const { logs, db } = require('../db');

/**
 * What each entry is about, by name: "Silo S04E02", "Dune: Part Two (2024)".
 * With the episode's show, so the dashboard can filter by a whole show.
 */
function withNames(rows) {
  const want = (t) => [...new Set(rows.filter(r => r.entity_type === t && r.entity_id).map(r => r.entity_id))];
  const q = (sql, ids) => (ids.length ? db.prepare(sql.replace('?', ids.map(() => '?').join(','))).all(...ids) : []);
  const movies = new Map(q('SELECT id, title, year FROM movies WHERE id IN (?)', want('movie')).map(m => [m.id, m]));
  const shows = new Map(q('SELECT id, title FROM shows WHERE id IN (?)', want('show')).map(s => [s.id, s]));
  const eps = new Map(q(`SELECT e.id, e.season, e.episode, e.show_id, s.title FROM episodes e JOIN shows s ON s.id = e.show_id
    WHERE e.id IN (?)`, want('episode')).map(e => [e.id, e]));
  const pad = (n) => String(n).padStart(2, '0');
  return rows.map((r) => {
    if (r.entity_type === 'movie' && movies.has(r.entity_id)) {
      const m = movies.get(r.entity_id);
      return { ...r, label: `${m.title}${m.year ? ` (${m.year})` : ''}` };
    }
    if (r.entity_type === 'show' && shows.has(r.entity_id)) return { ...r, label: shows.get(r.entity_id).title, show_id: r.entity_id };
    if (r.entity_type === 'episode' && eps.has(r.entity_id)) {
      const e = eps.get(r.entity_id);
      return { ...r, label: `${e.title} S${pad(e.season)}E${pad(e.episode)}`, show_id: e.show_id, show_label: e.title };
    }
    return r;
  });
}

const LEVELS = new Set(['info', 'warn', 'error']);
const TYPES  = new Set(['movie', 'show', 'episode']);

router.get('/', (req, res) => {
  const { limit, level, entity_type, entity_id, show_id } = req.query;
  res.json(withNames(logs.recent({
    limit,
    // Unknown filter values are dropped rather than passed through, so a typo
    // returns everything instead of nothing.
    level:      LEVELS.has(level)      ? level      : null,
    entityType: TYPES.has(entity_type) ? entity_type : null,
    entityId:   entity_id && /^\d+$/.test(entity_id) ? entity_id : null,
    showId:     show_id && /^\d+$/.test(show_id) ? show_id : null,
  })));
});

router.delete('/', (_req, res) => {
  logs.clear();
  res.sendStatus(204);
});

module.exports = router;
