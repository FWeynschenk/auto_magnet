'use strict';

// Accounts, sessions and the guard in front of the API.
//
// Two roles:
//   admin  — everything the dashboard could always do: add titles, grab
//            torrents, change settings, manage users.
//   viewer — the Watch pages only: browse what has downloaded, play it,
//            keep their own progress. Nothing that reaches Transmission.
//
// A session is a random 256-bit token. The browser carries it in an HttpOnly
// cookie; the Android app sends it as `Authorization: Bearer …`. Only its
// SHA-256 is stored, so the database alone can't be used to log in.
//
// The old shared-secret AMAGNET_TOKEN still works and acts as an admin, so
// scripts written against it keep running.

const crypto = require('crypto');
const { db } = require('./db');

const COOKIE      = 'amagnet_session';
const SESSION_DAYS = 90;              // sliding: every use pushes it out again
const ROLES       = new Set(['admin', 'viewer']);
const LEGACY_TOKEN = process.env.AMAGNET_TOKEN || '';

// ─── Passwords ────────────────────────────────────────────────────────────────

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  let actual;
  try {
    actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  } catch (_) {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters';
  if (pw.length > 256) return 'Password is too long';
  return null;
}

function validateUsername(name) {
  if (typeof name !== 'string') return 'Username required';
  const n = name.trim();
  if (!/^[A-Za-z0-9._-]{2,32}$/.test(n)) return 'Username: 2–32 letters, digits, dot, dash or underscore';
  return null;
}

// ─── Users ────────────────────────────────────────────────────────────────────

const publicUser = (u) => u && ({
  id: u.id, username: u.username, role: u.role,
  created_at: u.created_at, last_login_at: u.last_login_at,
});

const users = {
  count:  () => db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
  all:    () => db.prepare('SELECT * FROM users ORDER BY username').all(),
  byId:   (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
  byName: (name) => db.prepare('SELECT * FROM users WHERE username = ?').get(String(name).trim()),
  admins: () => db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").get().c,

  create({ username, password, role = 'viewer' }) {
    const err = validateUsername(username) || validatePassword(password)
             || (ROLES.has(role) ? null : 'Unknown role');
    if (err) throw Object.assign(new Error(err), { status: 400 });
    if (users.byName(username)) throw Object.assign(new Error('That username is taken'), { status: 409 });
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
    ).run(username.trim(), hashPassword(password), role);
    return users.byId(Number(lastInsertRowid));
  },

  setPassword(id, password) {
    const err = validatePassword(password);
    if (err) throw Object.assign(new Error(err), { status: 400 });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id);
  },

  setRole(id, role) {
    if (!ROLES.has(role)) throw Object.assign(new Error('Unknown role'), { status: 400 });
    const u = users.byId(id);
    if (u?.role === 'admin' && role !== 'admin' && users.admins() <= 1) {
      throw Object.assign(new Error('There must always be at least one admin'), { status: 409 });
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  },

  remove(id) {
    const u = users.byId(id);
    if (u?.role === 'admin' && users.admins() <= 1) {
      throw Object.assign(new Error('There must always be at least one admin'), { status: 409 });
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  },
};

// ─── Sessions ─────────────────────────────────────────────────────────────────

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sqlTime = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const expiry  = () => sqlTime(new Date(Date.now() + SESSION_DAYS * 86400_000));

const sessions = {
  create(userId, label = null) {
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, user_id, label, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(token), userId, label ? String(label).slice(0, 120) : null, expiry());
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
    return token;
  },

  /** The user a token belongs to, or null. Extends the session on use. */
  resolve(token) {
    if (!token) return null;
    const h = sha256(token);
    const row = db.prepare(`
      SELECT s.token_hash, s.last_seen_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')
    `).get(h);
    if (!row) return null;
    // Touch at most once a minute; every stream segment request would
    // otherwise be a database write.
    if (Date.now() - Date.parse(row.last_seen_at.replace(' ', 'T') + 'Z') > 60_000) {
      db.prepare("UPDATE sessions SET last_seen_at = datetime('now'), expires_at = ? WHERE token_hash = ?")
        .run(expiry(), h);
    }
    return { user: row, tokenHash: h };
  },

  revoke: (token) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)),
  revokeHash: (h) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(h),
  revokeUser: (userId) => db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId),
  forUser: (userId) => db.prepare(
    'SELECT token_hash, label, created_at, last_seen_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC'
  ).all(userId),
  prune: () => db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run(),
};

// ─── Login throttling ────────────────────────────────────────────────────────
// After five wrong passwords for an address+name pair, each further attempt
// must wait, doubling up to fifteen minutes. In memory: a restart forgets it,
// which is fine for a LAN service and costs no writes.

const failures = new Map();

function throttleKey(req, username) {
  return `${req.ip}|${String(username || '').toLowerCase()}`;
}

function throttled(key) {
  const f = failures.get(key);
  if (!f || f.count < 5) return 0;
  const wait = Math.min(15 * 60_000, 1000 * 2 ** (f.count - 5)) - (Date.now() - f.last);
  return wait > 0 ? Math.ceil(wait / 1000) : 0;
}

function recordFailure(key) {
  const f = failures.get(key) || { count: 0, last: 0 };
  f.count += 1; f.last = Date.now();
  failures.set(key, f);
  if (failures.size > 10_000) failures.delete(failures.keys().next().value);
}

// ─── Request handling ─────────────────────────────────────────────────────────

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  res.append('Set-Cookie', [
    `${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86400}`, secure ? 'Secure' : null,
  ].filter(Boolean).join('; '));
}

function clearSessionCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function bearer(req) {
  const h = req.get('Authorization') || '';
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : null;
}

const LEGACY_USER = Object.freeze({ id: 0, username: 'api-token', role: 'admin', legacy: true });

/** Who is making this request: { user, via, token } or null. */
function identify(req) {
  const b = bearer(req);
  const headerToken = req.get('X-Auth-Token');
  if (LEGACY_TOKEN && (b === LEGACY_TOKEN || headerToken === LEGACY_TOKEN || req.query.token === LEGACY_TOKEN)) {
    return { user: LEGACY_USER, via: 'legacy' };
  }
  if (b) {
    const s = sessions.resolve(b);
    return s ? { user: s.user, via: 'bearer', tokenHash: s.tokenHash } : null;
  }
  const c = readCookie(req, COOKIE);
  if (c) {
    const s = sessions.resolve(c);
    return s ? { user: s.user, via: 'cookie', tokenHash: s.tokenHash } : null;
  }
  return null;
}

/**
 * A cookie is sent by the browser whatever page started the request, so a
 * state-changing call authenticated only by the cookie must come from this
 * origin. SameSite=Lax already stops other *sites*; this also stops other
 * ports on the same host (Prowlarr, Transmission's web UI) — they are the
 * same "site" to a browser.
 */
function sameOrigin(req) {
  const origin = req.get('Origin');
  if (!origin) return true; // not a browser cross-origin request
  try {
    return new URL(origin).host === req.get('Host');
  } catch (_) {
    return false;
  }
}

/** Every /api route except /api/auth/* goes through this. */
function requireUser(req, res, next) {
  const who = identify(req);
  if (!who) {
    return res.status(401).json({
      error: users.count() === 0 ? 'Setup required' : 'Not logged in',
      setupRequired: users.count() === 0,
    });
  }
  if (who.via === 'cookie' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req)) {
    return res.status(403).json({ error: 'Cross-origin request refused' });
  }
  req.user = who.user;
  req.auth = who;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Admins only' });
}

module.exports = {
  users, sessions, publicUser, identify, requireUser, requireAdmin, sameOrigin,
  setSessionCookie, clearSessionCookie, hashPassword, verifyPassword,
  throttleKey, throttled, recordFailure, failures, LEGACY_TOKEN, COOKIE,
};
