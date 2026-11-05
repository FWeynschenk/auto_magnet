'use strict';

const express = require('express');
const router  = express.Router();
const auth    = require('../auth');
const { users, sessions, publicUser } = auth;

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
};

// Mounted before the API guard, so each route that needs a user checks itself.
function signedIn(req, res, next) { auth.requireUser(req, res, next); }

/** What the login page needs to know before anyone has signed in. */
router.get('/status', wrap((req) => {
  const who = auth.identify(req);
  return {
    setupRequired: users.count() === 0,
    setupNeedsToken: users.count() === 0 && !!auth.LEGACY_TOKEN,
    user: who ? publicUser(who.user) : null,
  };
}));

/**
 * The first account. Only possible while there are none, and — when the
 * server has AMAGNET_TOKEN — only for someone who knows it, so an
 * unconfigured server on a shared network can't be claimed by whoever finds
 * it first.
 */
router.post('/setup', wrap((req, res) => {
  if (users.count() > 0) throw Object.assign(new Error('Already set up'), { status: 409 });
  if (!auth.sameOrigin(req)) throw Object.assign(new Error('Cross-origin request refused'), { status: 403 });
  const { username, password, token } = req.body || {};
  if (auth.LEGACY_TOKEN && token !== auth.LEGACY_TOKEN) {
    throw Object.assign(new Error('Enter the server\'s AMAGNET_TOKEN to create the first account'), { status: 403 });
  }
  const user = users.create({ username, password, role: 'admin' });
  const t = sessions.create(user.id, req.get('User-Agent'));
  auth.setSessionCookie(req, res, t);
  return { user: publicUser(user) };
}));

router.post('/login', wrap((req, res) => {
  const { username, password, client } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw Object.assign(new Error('Username and password required'), { status: 400 });
  }
  const key = auth.throttleKey(req, username);
  const wait = auth.throttled(key);
  if (wait) {
    res.set('Retry-After', String(wait));
    throw Object.assign(new Error(`Too many attempts — try again in ${wait}s`), { status: 429 });
  }
  const user = users.byName(username);
  // Hash even for an unknown name, so the response time doesn't reveal which
  // usernames exist.
  const ok = auth.verifyPassword(password, user?.password_hash || auth.hashPassword('x'));
  if (!user || !ok) {
    auth.recordFailure(key);
    throw Object.assign(new Error('Wrong username or password'), { status: 401 });
  }
  auth.failures.delete(key);
  const label = client ? `${String(client).slice(0, 40)} — ${req.get('User-Agent') || ''}` : req.get('User-Agent');
  const token = sessions.create(user.id, label);
  // Apps keep the token themselves; the browser gets it only as an HttpOnly
  // cookie, out of reach of page scripts.
  if (client) return { user: publicUser(user), token };
  auth.setSessionCookie(req, res, token);
  return { user: publicUser(user) };
}));

router.post('/logout', signedIn, wrap((req, res) => {
  if (req.auth.tokenHash) sessions.revokeHash(req.auth.tokenHash);
  auth.clearSessionCookie(res);
  return { ok: true };
}));

router.get('/me', signedIn, wrap((req) => publicUser(req.user)));

router.put('/me/password', signedIn, wrap((req) => {
  if (req.user.legacy) throw Object.assign(new Error('The API token has no password'), { status: 400 });
  const { current, password } = req.body || {};
  if (!auth.verifyPassword(current, users.byId(req.user.id).password_hash)) {
    throw Object.assign(new Error('Current password is wrong'), { status: 403 });
  }
  users.setPassword(req.user.id, password);
  // Every other device has to sign in again; this one stays signed in.
  for (const s of sessions.forUser(req.user.id)) {
    if (s.token_hash !== req.auth.tokenHash) sessions.revokeHash(s.token_hash);
  }
  return { ok: true };
}));

router.get('/me/sessions', signedIn, wrap((req) =>
  sessions.forUser(req.user.id).map(s => ({
    id: s.token_hash.slice(0, 12), label: s.label, created_at: s.created_at,
    last_seen_at: s.last_seen_at, current: s.token_hash === req.auth.tokenHash,
  }))
));

router.delete('/me/sessions/:id', signedIn, wrap((req) => {
  const s = sessions.forUser(req.user.id).find(x => x.token_hash.startsWith(req.params.id) && req.params.id.length >= 12);
  if (!s) throw Object.assign(new Error('No such session'), { status: 404 });
  sessions.revokeHash(s.token_hash);
  return { ok: true };
}));

// ─── User management (admin) ─────────────────────────────────────────────────

const admin = [signedIn, auth.requireAdmin];

router.get('/users', admin, wrap(() => users.all().map(publicUser)));

router.post('/users', admin, wrap((req) => {
  const { username, password, role } = req.body || {};
  return publicUser(users.create({ username, password, role: role || 'viewer' }));
}));

router.put('/users/:id', admin, wrap((req) => {
  const id = Number(req.params.id);
  if (!users.byId(id)) throw Object.assign(new Error('No such user'), { status: 404 });
  const { role, password } = req.body || {};
  if (role) users.setRole(id, role);
  if (password) {
    users.setPassword(id, password);
    sessions.revokeUser(id);
  }
  return publicUser(users.byId(id));
}));

router.delete('/users/:id', admin, wrap((req) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw Object.assign(new Error('You can\'t delete your own account'), { status: 409 });
  if (!users.byId(id)) throw Object.assign(new Error('No such user'), { status: 404 });
  users.remove(id);
  return { ok: true };
}));

module.exports = router;
