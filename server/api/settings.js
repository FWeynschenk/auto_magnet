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
  'search_cache_mins', 'allow_disc_images', 'title_match_min', 'unverified_policy',
  'transmission_extra',
];

const MASK = '••••••••';

function parseInstances(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

router.get('/', (_req, res) => {
  const all = settings.all();
  // Mask sensitive fields before sending to client
  const safe = { ...all };
  if (safe.transmission_pw)  safe.transmission_pw  = safe.transmission_pw  ? MASK : '';
  if (safe.prowlarr_api_key) safe.prowlarr_api_key = safe.prowlarr_api_key ? MASK : '';
  if (safe.tmdb_api_key)     safe.tmdb_api_key     = safe.tmdb_api_key     ? MASK : '';
  // Extra instances carry their own passwords, which must be masked the same
  // way — they are as sensitive as the default instance's.
  safe.transmission_extra = JSON.stringify(
    parseInstances(all.transmission_extra).map(t => ({ ...t, pw: t.pw ? MASK : '' }))
  );
  res.json(safe);
});

/** Instance names only — what the per-item "Download to" pickers need. */
router.get('/targets', (_req, res) => {
  const { listTargets } = require('../transmission');
  res.json(listTargets().map(t => ({ name: t.name, host: t.host, port: t.port })));
});

router.put('/', (req, res) => {
  const data = Object.fromEntries(
    Object.entries(req.body)
      .filter(([k, v]) => ALLOWED_KEYS.includes(k) && v !== MASK)
  );

  // A masked password means "unchanged", so restore the stored value by name
  // rather than writing the mask into the config.
  if (typeof data.transmission_extra === 'string') {
    const existing = new Map(
      parseInstances(settings.get('transmission_extra')).map(t => [t.name, t.pw || ''])
    );
    const merged = parseInstances(data.transmission_extra)
      .filter(t => t && t.name && t.host)
      .map(t => ({
        name: String(t.name).trim(),
        host: String(t.host).trim(),
        port: String(t.port || '9091').trim(),
        user: t.user || '',
        pw:   t.pw === MASK ? (existing.get(t.name) || '') : (t.pw || ''),
      }));
    data.transmission_extra = JSON.stringify(merged);
  }

  settings.setMany(data);
  res.json({ success: true });
});

router.get('/status', async (_req, res) => {
  res.json(await testConnection());
});

module.exports = router;
