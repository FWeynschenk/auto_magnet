'use strict';

// Repeating a subtitle search that found nothing: the schedule, then the real
// post-processing pass with Transmission and OpenSubtitles stood in for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshDb } = require('./helpers');

const dir = freshDb();
const { db, movies, settings } = require('../server/db');
const pp = require('../server/postprocess');
const tx = require('../server/transmission');
const subtitles = require('../server/sources/opensubtitles');

const H = 3600_000;
const HOURS = [12, 24, 36, 120, 240];
const at = (h) => new Date(T0 + h * H).toISOString();
const T0 = Date.parse('2026-11-01T00:00:00Z');
const row = (o = {}) => ({ subs_state: 'unavailable', completed_at: at(0), post_processed_at: at(0.1), subs_checked_at: at(0.1), ...o });

test('a retry is due at each point, once', () => {
  assert.equal(pp.subsRetryDue(row(), T0 + 11 * H, HOURS), false);
  assert.equal(pp.subsRetryDue(row(), T0 + 12 * H, HOURS), true);
  assert.equal(pp.subsRetryDue(row({ subs_checked_at: at(12.2) }), T0 + 20 * H, HOURS), false, 'done for this point');
  assert.equal(pp.subsRetryDue(row({ subs_checked_at: at(12.2) }), T0 + 24 * H, HOURS), true);
  assert.equal(pp.subsRetryDue(row({ subs_checked_at: at(36.5) }), T0 + 100 * H, HOURS), false);
  assert.equal(pp.subsRetryDue(row({ subs_checked_at: at(36.5) }), T0 + 121 * H, HOURS), true);
  assert.equal(pp.subsRetryDue(row({ subs_checked_at: at(240.5) }), T0 + 500 * H, HOURS), false, 'no points left');
});

test('missed points are caught up once, not once each', () => {
  // Down from hour 10 to hour 40: one retry for 12, 24 and 36 together.
  assert.equal(pp.subsRetryDue(row(), T0 + 40 * H, HOURS), true);
  assert.equal(pp.subsRetryDue(row({ subs_checked_at: at(40) }), T0 + 41 * H, HOURS), false);
});

test('old items are not retried after an upgrade', () => {
  // Searched once at completion a month ago, before retries existed.
  const old = row({ subs_checked_at: null });
  assert.equal(pp.subsRetryDue(old, T0 + 30 * 24 * H, HOURS), false);
  assert.equal(pp.subsRetryDue(old, T0 + 250 * H, HOURS), true, 'but a missed last point within two days is');
});

test('only searches that found nothing are retried', () => {
  for (const s of ['fetched', 'present', 'missing', 'pending', null]) {
    assert.equal(pp.subsRetryDue(row({ subs_state: s }), T0 + 13 * H, HOURS), false, s);
  }
});

test('pending until the last point, and the next one is named', () => {
  assert.equal(pp.subsRetryPending(row(), T0 + 200 * H, HOURS), true);
  assert.equal(pp.subsRetryPending(row({ subs_checked_at: at(240.1) }), T0 + 241 * H, HOURS), false);
  assert.equal(pp.subsRetryPending(row(), T0 + 241 * H, HOURS), true, 'the 240h retry itself is still due');
  assert.equal(pp.nextRetryIn(row(), T0 + 1 * H, HOURS), 'in 11h');
  assert.equal(pp.nextRetryIn(row(), T0 + 40 * H, HOURS), 'in 3 days');
  assert.equal(pp.nextRetryIn(row(), T0 + 241 * H, HOURS), null);
});

test('the schedule comes from settings and tolerates junk', () => {
  settings.set('subtitle_retry_hours', '48, 6,x,-1');
  assert.deepEqual(pp.retryHours(), [6, 48]);
  settings.set('subtitle_retry_hours', '');
  assert.deepEqual(pp.retryHours(), []);
  assert.equal(pp.subsRetryPending(row(), T0 + H, []), false, 'empty: no retries at all');
  settings.set('subtitle_retry_hours', HOURS.join(','));
});

// ─── The pass ────────────────────────────────────────────────────────────────

test('the pass searches again when due, and saves what it finds', async () => {
  const lib = path.join(dir, 'Movies', 'New.Film.2026');
  fs.mkdirSync(lib, { recursive: true });
  const video = path.join(lib, 'New.Film.2026.mkv');
  fs.writeFileSync(video, Buffer.alloc(256 * 1024));
  settings.set('subtitle_autosync', '0');
  const ago = (h) => new Date(Date.now() - h * H).toISOString();
  db.prepare(`INSERT INTO movies (id, title, year, imdb_id, status, torrent_id, torrent_origin, completed_at,
    post_processed_at, subs_state, subs_checked_at) VALUES (5, 'New Film', 2026, 'tt1', 'done', 9, 'added', ?, ?, 'unavailable', ?)`)
    .run(ago(13), ago(12.9), ago(12.9));

  let searches = 0, found = null;
  tx.getTorrentInfo = async () => ({ id: 9, name: 'New.Film.2026', downloadDir: path.join(dir, 'Movies'), percentDone: 1,
    files: [{ name: 'New.Film.2026/New.Film.2026.mkv', length: 256 * 1024 }] });
  subtitles.configured = () => true;
  subtitles.quotaExhausted = () => false;
  subtitles.findBest = async () => { searches++; return found; };
  subtitles.download = async (_item, dest) => { fs.writeFileSync(dest, '1\n00:00:01,000 --> 00:00:02,000\nHi\n'); return { remaining: 4 }; };

  // 13h after completion, last searched before the 12h point: due.
  await pp.postProcessCompleted();
  assert.equal(searches, 1);
  let m = movies.byId(5);
  assert.equal(m.subs_state, 'unavailable');
  assert.match(m.last_error, /trying again in 11h/);

  // Not again until the 24h point.
  await pp.postProcessCompleted();
  assert.equal(searches, 1);

  // At 25h it is there.
  db.prepare('UPDATE movies SET completed_at = ?, subs_checked_at = ? WHERE id = 5').run(ago(25), ago(12));
  found = { item: {}, matchedBy: 'imdb' };
  await pp.postProcessCompleted();
  assert.equal(searches, 2);
  m = movies.byId(5);
  assert.equal(m.subs_state, 'fetched');
  assert.equal(m.last_error, null);
  assert.ok(fs.existsSync(path.join(lib, 'New.Film.2026.en.srt')));

  await pp.postProcessCompleted();
  assert.equal(searches, 2, 'found: no more retries');
});
