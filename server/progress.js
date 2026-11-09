'use strict';

// Per-user resume points and watched state.
//
// Every write carries the moment the position was reached (`at`). A phone that
// watched three episodes on a plane uploads them when it reconnects; if the
// same user has since watched further on the TV, the newer one stays.

const { db } = require('./db');

/** Within this many seconds of the end, or past this share, counts as watched. */
const END_SECONDS = 120;
const END_SHARE = 0.92;
/** Below this, it's someone pressing play by accident — no resume point. */
const MIN_RESUME = 30;

function isFinished(position, duration, creditsAt = null) {
  // The end credits were found: reaching them is the end of the episode.
  if (creditsAt && position >= creditsAt - 5) return true;
  if (!duration || duration <= 0) return false;
  return position >= duration * END_SHARE || duration - position <= Math.min(END_SECONDS, duration * 0.1);
}

const toSql = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 23);

function get(userId, kind, id) {
  return db.prepare('SELECT * FROM playback_progress WHERE user_id = ? AND kind = ? AND item_id = ?')
    .get(userId, kind, id) || null;
}

/** Map of "kind:id" → progress row, for a whole listing at once. */
function forUser(userId) {
  const m = new Map();
  for (const r of db.prepare('SELECT * FROM playback_progress WHERE user_id = ?').all(userId)) {
    m.set(`${r.kind}:${r.item_id}`, r);
  }
  return m;
}

/**
 * Record a position. Returns the stored row, which is the existing one when
 * the incoming report is older than what is already there.
 */
function report(userId, kind, id, { position, duration = null, at = Date.now(), watched = null, creditsAt = null }) {
  const pos = Math.max(0, Number(position) || 0);
  const dur = Number(duration) > 0 ? Number(duration) : null;
  const when = Number.isFinite(Date.parse(at)) ? Date.parse(at) : Number(at) || Date.now();
  // A clock far in the future (a phone set wrong) must not freeze the row.
  const stamp = toSql(Math.min(when, Date.now() + 60_000));

  const prev = get(userId, kind, id);
  if (prev && prev.updated_at > stamp) return prev;

  const finished = isFinished(pos, dur, creditsAt);
  const done = watched === null ? (finished || (prev?.watched && pos < MIN_RESUME) ? 1 : 0) : (watched ? 1 : 0);
  // Finished: the resume point goes back to the start for a rewatch.
  const keep = done && finished ? 0 : (pos < MIN_RESUME ? 0 : pos);
  db.prepare(`
    INSERT INTO playback_progress (user_id, kind, item_id, position, duration, watched, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, kind, item_id) DO UPDATE SET
      position = excluded.position, duration = COALESCE(excluded.duration, duration),
      watched = excluded.watched, updated_at = excluded.updated_at
  `).run(userId, kind, id, keep, dur, done, stamp);
  return get(userId, kind, id);
}

function setWatched(userId, kind, id, watched) {
  const prev = get(userId, kind, id);
  return report(userId, kind, id, { position: watched ? 0 : (prev?.position || 0), duration: prev?.duration, watched });
}

/** Mark many at once (a whole season). */
function setWatchedMany(userId, items, watched) {
  db.exec('BEGIN');
  try {
    for (const { kind, id } of items) setWatched(userId, kind, id, watched);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Started but not finished, most recent first. */
function inProgress(userId, limit = 20) {
  return db.prepare(`
    SELECT * FROM playback_progress WHERE user_id = ? AND watched = 0 AND position >= ?
    ORDER BY updated_at DESC LIMIT ?
  `).all(userId, MIN_RESUME, limit);
}

/**
 * For each show this user has watched something of, the first downloaded
 * episode after the last one they finished — unless they're midway through
 * that one already (then it is in "continue watching" instead).
 */
function nextUp(userId, limit = 20) {
  return db.prepare(`
    WITH last AS (
      SELECT e.show_id, MAX(e.season * 10000 + e.episode) AS pos, MAX(p.updated_at) AS at
      FROM playback_progress p JOIN episodes e ON e.id = p.item_id
      WHERE p.user_id = ? AND p.kind = 'episode' AND p.watched = 1
      GROUP BY e.show_id
    )
    SELECT e.*, last.at AS last_watched_at FROM last
    JOIN episodes e ON e.id = (
      SELECT x.id FROM episodes x
      WHERE x.show_id = last.show_id AND x.status = 'done' AND x.season * 10000 + x.episode > last.pos
      ORDER BY x.season, x.episode LIMIT 1
    )
    LEFT JOIN playback_progress p ON p.user_id = ? AND p.kind = 'episode' AND p.item_id = e.id
    WHERE p.item_id IS NULL OR (p.watched = 0 AND p.position < ?)
    ORDER BY last.at DESC LIMIT ?
  `).all(userId, userId, MIN_RESUME, limit);
}

module.exports = { get, forUser, report, setWatched, setWatchedMany, inProgress, nextUp, isFinished, MIN_RESUME };
