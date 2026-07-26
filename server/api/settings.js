'use strict';

const express = require('express');
const router  = express.Router();
const { settings } = require('../db');
const { testConnection } = require('../transmission');

const ALLOWED_KEYS = [
  'transmission_host', 'transmission_port', 'transmission_user', 'transmission_pw',
  'movie_path', 'shows_path',
  'prowlarr_host', 'prowlarr_port', 'prowlarr_api_key',
  'tmdb_api_key',
  'min_seeds', 'default_quality',
  'scheduler_interval_mins', 'min_size_mb', 'max_size_gb',
  'air_date_buffer_hours', 'tmdb_region',
  'preferred_movie_groups', 'preferred_show_groups', 'quality_strict',
  'blocked_tags', 'trusted_only',
];

router.get('/', (_req, res) => {
  const all = settings.all();
  // Mask sensitive fields before sending to client
  const safe = { ...all };
  if (safe.transmission_pw)  safe.transmission_pw  = safe.transmission_pw  ? '••••••••' : '';
  if (safe.prowlarr_api_key) safe.prowlarr_api_key = safe.prowlarr_api_key ? '••••••••' : '';
  if (safe.tmdb_api_key)     safe.tmdb_api_key     = safe.tmdb_api_key     ? '••••••••' : '';
  res.json(safe);
});

router.put('/', (req, res) => {
  const data = Object.fromEntries(
    Object.entries(req.body)
      .filter(([k, v]) => ALLOWED_KEYS.includes(k) && v !== '••••••••')
  );
  settings.setMany(data);
  res.json({ success: true });
});

router.get('/status', async (_req, res) => {
  res.json(await testConnection());
});

module.exports = router;
