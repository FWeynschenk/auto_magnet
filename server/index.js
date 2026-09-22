'use strict';

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.AMAGNET_PORT || 62201;
const HOST = process.env.AMAGNET_BIND || '0.0.0.0';

// The dashboard is a same-origin SPA, so it needs no cross-origin access at all.
// Previously `cors()` allowed every origin, which — with no authentication — meant
// any website you visited could POST to this API and push arbitrary magnets into
// your Transmission. Set AMAGNET_CORS_ORIGIN only if you front the API elsewhere.
const corsOrigin = process.env.AMAGNET_CORS_ORIGIN;
if (corsOrigin) {
  app.use(cors({ origin: corsOrigin.split(',').map(s => s.trim()).filter(Boolean) }));
}

app.use(express.json());

// Optional shared-secret auth. Set AMAGNET_TOKEN to require it; when unset the
// API stays open (unchanged behaviour for existing LAN-only installs).
const TOKEN = process.env.AMAGNET_TOKEN;
if (TOKEN) {
  app.use('/api', (req, res, next) => {
    const provided = req.get('X-Auth-Token')
      || (req.get('Authorization') || '').replace(/^Bearer\s+/i, '')
      || req.query.token;
    if (provided === TOKEN) return next();
    res.set('WWW-Authenticate', 'Bearer');
    res.status(401).json({ error: 'Unauthorized' });
  });
  console.log('auto_magnet: API token auth enabled');
} else {
  console.warn('auto_magnet: no AMAGNET_TOKEN set — API is unauthenticated');
}

// API routes
app.use('/api/movies',   require('./api/movies'));
app.use('/api/shows',    require('./api/shows'));
app.use('/api/search',   require('./api/search'));
app.use('/api/settings', require('./api/settings'));
app.use('/api/timeline', require('./api/timeline'));
app.use('/api/log',      require('./api/log'));

app.get('/api/status', async (_req, res) => {
  const { testConnection } = require('./transmission');
  res.json(await testConnection());
});

// Development kill switch.
//
// A server booted against a database seeded with auto-mode items will grab them
// — that is the whole point of it — and it grabs them into whatever Transmission
// and download paths the settings name. When those settings came from a real
// .env, a "demo" run downloads real episodes to a real NAS. Set this for any
// throwaway or test boot and nothing can reach Transmission automatically.
const SCHEDULER_DISABLED = process.env.AMAGNET_NO_SCHEDULER === '1';

app.post('/api/scheduler/run', (_req, res) => {
  // The manual trigger has to honour the flag too, or the UI walks straight
  // around it with one click.
  if (SCHEDULER_DISABLED) {
    return res.status(503).json({ error: 'Scheduler disabled (AMAGNET_NO_SCHEDULER=1)' });
  }
  res.json({ started: true });
  require('./scheduler').run().catch(err => {
    console.error('[scheduler] manual run error:', err.message);
  });
});

// Unmatched API routes must return JSON, not the SPA shell — otherwise a client
// bug surfaces as "unexpected token <" instead of a clean 404.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// JSON error handler for API routes
app.use('/api', (err, _req, res, _next) => {
  console.error('[api] unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

// Serve Vue SPA (production build)
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`auto_magnet v2 on ${HOST}:${PORT}`);
  if (SCHEDULER_DISABLED) {
    console.warn('auto_magnet: AMAGNET_NO_SCHEDULER=1 — scheduler is OFF, nothing will be grabbed');
    return;
  }
  require('./scheduler').start();
});
