'use strict';

const express = require('express');
const router  = express.Router();
const { logs } = require('../db');

const LEVELS = new Set(['info', 'warn', 'error']);
const TYPES  = new Set(['movie', 'show', 'episode']);

router.get('/', (req, res) => {
  const { limit, level, entity_type, entity_id } = req.query;
  res.json(logs.recent({
    limit,
    // Unknown filter values are dropped rather than passed through, so a typo
    // returns everything instead of nothing.
    level:      LEVELS.has(level)      ? level      : null,
    entityType: TYPES.has(entity_type) ? entity_type : null,
    entityId:   entity_id && /^\d+$/.test(entity_id) ? entity_id : null,
  }));
});

router.delete('/', (_req, res) => {
  logs.clear();
  res.sendStatus(204);
});

module.exports = router;
