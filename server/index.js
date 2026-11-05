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

// Behind a reverse proxy (Caddy, nginx) set AMAGNET_TRUST_PROXY=1 so client
// addresses — used to throttle password guessing — and https are read from
// the proxy's headers instead of being the proxy's own.
if (process.env.AMAGNET_TRUST_PROXY === '1') app.set('trust proxy', true);

const auth = require('./auth');

// Accounts. /api/auth/* handles its own access (login has to work signed out);
// every other API route needs a signed-in user, and everything that can reach
// Transmission or change settings needs an admin.
app.use('/api/auth', require('./api/auth'));
app.use('/api', auth.requireUser);
app.use('/api/watch', require('./api/watch'));

const admin = auth.requireAdmin;
app.use('/api/movies',   admin, require('./api/movies'));
app.use('/api/shows',    admin, require('./api/shows'));
app.use('/api/search',   admin, require('./api/search'));
app.use('/api/settings', admin, require('./api/settings'));
app.use('/api/timeline', admin, require('./api/timeline'));
app.use('/api/log',      admin, require('./api/log'));
app.use('/api/library',  admin, require('./api/library'));

app.get('/api/status', admin, async (_req, res) => {
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

app.post('/api/scheduler/run', admin, (_req, res) => {
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
  if (auth.users.count() === 0) {
    console.warn('auto_magnet: no accounts yet — open the dashboard to create the admin account');
  }
  auth.sessions.prune();
  // Encoding web versions is local work and never touches Transmission, so it
  // runs even with the scheduler switched off.
  require('./media').startWorker();
  if (SCHEDULER_DISABLED) {
    console.warn('auto_magnet: AMAGNET_NO_SCHEDULER=1 — scheduler is OFF, nothing will be grabbed');
    return;
  }
  require('./scheduler').start();
});
