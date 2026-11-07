'use strict';

// Removing originals after seeding: the rules (pure), then a real run against
// generated media with a stand-in for Transmission.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshDb, hasFfmpeg, makeLibrary } = require('./helpers');

const dir = freshDb();
const { db, settings } = require('../server/db');
const media = require('../server/media');
const cleanup = require('../server/cleanup');

// ─── Rules ───────────────────────────────────────────────────────────────────

const pol = { plans: ['remux'], ratio: 2, days: 0 };
const opts = { toLocal: (p) => p, check: (r) => (r.web_state === 'ready' ? null : { reason: 'has no finished web version' }) };
const torrent = (o = {}) => ({
  id: 7, name: 'T', downloadDir: '/lib', percentDone: 1, uploadRatio: 2.4, secondsSeeding: 3600,
  files: [{ name: 'Film/Film.mkv', length: 1e9 }, { name: 'Film/Film.nfo', length: 100 }], ...o,
});
const row = (o = {}) => ({
  kind: 'movie', item_id: 1, path: path.resolve('/lib/Film/Film.mkv'), plan: 'remux', web_state: 'ready',
  torrent_origin: 'added', ...o,
});

test('a finished torrent past the ratio, with a ready web version, may go', () => {
  const d = cleanup.decide(torrent(), [row()], pol, opts);
  assert.equal(d.ok, true);
  assert.equal(d.rows.length, 1);
  assert.match(d.reason, /ratio 2\.40/);
});

test('an episode deleted from a pack does not keep the rest of the pack from going', () => {
  const pack = torrent({ files: [
    { name: 'Show/Show.S01E01.mkv', length: 1e9, wanted: false },   // deleted by hand, dropped from the torrent
    { name: 'Show/Show.S01E02.mkv', length: 1e9 },
  ] });
  const e2 = row({ kind: 'episode', item_id: 2, path: path.resolve('/lib/Show/Show.S01E02.mkv') });
  const d = cleanup.decide(pack, [e2], pol, opts);
  assert.equal(d.ok, true, d.reason);
  assert.deepEqual(d.rows.map(r => r.item_id), [2]);
  // Still wanted but not in the library: that one does hold it back.
  const kept = torrent({ files: [{ name: 'Show/Show.S01E01.mkv', length: 1e9 }, { name: 'Show/Show.S01E02.mkv', length: 1e9 }] });
  assert.equal(cleanup.decide(kept, [e2], pol, opts).ok, false);
});

test('below the ratio it stays — unless the day limit has passed', () => {
  assert.equal(cleanup.decide(torrent({ uploadRatio: 1.2 }), [row()], pol, opts).ok, false);
  const t = torrent({ uploadRatio: 0.3, secondsSeeding: 15 * 86400 });
  assert.equal(cleanup.decide(t, [row()], { ...pol, days: 14 }, opts).ok, true);
  assert.equal(cleanup.decide(t, [row()], { ...pol, days: 30 }, opts).ok, false);
});

test('unfinished, missing or pre-existing torrents are never removed', () => {
  assert.equal(cleanup.decide(null, [row()], pol, opts).ok, false);
  assert.equal(cleanup.decide(torrent({ percentDone: 0.9 }), [row()], pol, opts).ok, false);
  assert.equal(cleanup.decide(torrent(), [row({ torrent_origin: 'duplicate' })], pol, opts).ok, false);
});

test('the plan must be one the setting allows; direct play never is', () => {
  assert.equal(cleanup.decide(torrent(), [row({ plan: 'transcode' })], pol, opts).ok, false);
  assert.equal(cleanup.decide(torrent(), [row({ plan: 'transcode' })], { ...pol, plans: ['remux', 'transcode'] }, opts).ok, true);
  assert.equal(cleanup.decide(torrent(), [row({ plan: 'direct' })], { ...pol, plans: ['remux', 'transcode'] }, opts).ok, false);
});

test('the web version must be finished', () => {
  assert.equal(cleanup.decide(torrent(), [row({ web_state: 'encoding' })], pol, opts).ok, false);
  assert.equal(cleanup.decide(torrent(), [row()], pol, { ...opts, check: () => ({ reason: 'x' }) }).ok, false);
});

test('an original waiting for a subtitle retry stays, so the subtitle has somewhere to go', () => {
  assert.equal(cleanup.decide(torrent(), [row()], pol, { ...opts, subsPending: () => true }).ok, false);
  assert.equal(cleanup.decide(torrent(), [row()], pol, { ...opts, subsPending: () => false }).ok, true);
});

test('a web version missing audio tracks is rebuilt first, not removed', () => {
  const rebuild = { ...opts, check: () => ({ reason: 'x', rebuild: true }) };
  const d = cleanup.decide(torrent(), [row()], pol, rebuild);
  assert.equal(d.ok, false);
  assert.equal(d.rebuild.length, 1);
  assert.equal(cleanup.decide(torrent({ uploadRatio: 1 }), [row()], pol, rebuild).rebuild, undefined,
    'not before the ratio is reached');
});

test('a pack stays until every video in it is covered, and an untracked video keeps it', () => {
  const files = [1, 2, 3].map(e => ({ name: `Show.S01/Show.S01E0${e}.mkv`, length: 1e9 }))
    .concat({ name: 'Show.S01/Sample/show.sample.mkv', length: 1e7 });
  const ep = (e, o = {}) => row({ kind: 'episode', item_id: e, path: path.resolve(`/lib/Show.S01/Show.S01E0${e}.mkv`), ...o });
  const t = torrent({ files });
  assert.equal(cleanup.decide(t, [ep(1), ep(2), ep(3)], pol, opts).ok, true, 'the sample is ignored');
  assert.equal(cleanup.decide(t, [ep(1), ep(2), ep(3, { web_state: 'queued' })], pol, opts).ok, false);
  assert.equal(cleanup.decide(t, [ep(1), ep(2)], pol, opts).ok, false, 'episode 3 is not in the library');
});

// ─── A real run ──────────────────────────────────────────────────────────────

const until = async (fn, ms = 120_000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 200));
  }
};

test('removes the original and keeps playback and subtitles working', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const lib = makeLibrary(path.join(dir, 'media'));
  settings.set('movie_path', lib.movies);
  settings.set('shows_path', lib.series);
  settings.set('web_encoder', 'x264');
  settings.set('web_min_free_gb', '0');
  settings.set('web_reserve_gb', '0');
  db.prepare("INSERT INTO movies (id, title, year, status, torrent_id, torrent_origin) VALUES (2, 'Remux Film', 2021, 'done', 41, 'added')").run();
  db.prepare("INSERT INTO shows (id, tmdb_id, title) VALUES (1, 999, 'Hevc Show')").run();
  db.prepare("INSERT INTO episodes (id, show_id, season, episode, status, torrent_id, torrent_origin) VALUES (1, 1, 1, 2, 'done', 42, 'added')").run();

  const movieFile = path.join(lib.movies, 'Remux.Film.2021', 'Remux.Film.2021.mkv');
  const sidecar = lib.episode.replace(/\.mkv$/, '.en.srt');
  settings.set('web_remux_ahead', '0');   // the default: repackaged copies only when needed
  await media.record('movie', 2, movieFile);
  await media.record('episode', 1, lib.episode);
  await until(() => media.rows.get('episode', 1).web_state === 'ready');
  assert.equal(media.rows.get('movie', 2).web_state, 'none', 'no repackaged copy made ahead of time');

  const purged = [];
  const fakeTx = {
    resolveTarget: () => null,
    getSeedInfo: async (id) => (id === 41
      ? { id, name: 'Remux.Film.2021', downloadDir: lib.movies, percentDone: 1, uploadRatio: 2.5, secondsSeeding: 1,
          files: [{ name: 'Remux.Film.2021/Remux.Film.2021.mkv', length: 1 }] }
      : { id, name: 'Hevc.Show.S01E02', downloadDir: path.join(lib.series, 'Hevc Show'), percentDone: 1, uploadRatio: 3, secondsSeeding: 1,
          files: [{ name: 'Hevc.Show.S01E02.1080p.mkv', length: 1 }] }),
    // What Transmission does with delete-local-data: the torrent's own files go.
    purgeTorrent: async (id) => {
      purged.push(id);
      if (id === 41) fs.rmSync(movieFile);
      else fs.rmSync(lib.episode);
    },
  };

  settings.set('seed_cleanup', 'off');
  assert.deepEqual(await cleanup.sweepSeeded({ tx: fakeTx }), { removed: 0 }, 'off by default');

  settings.set('seed_cleanup', 'remux');
  // Seeded enough, but no copy yet: the sweep has it made, and removes nothing.
  assert.deepEqual(await cleanup.sweepSeeded({ tx: fakeTx }), { removed: 0 });
  assert.ok(['queued', 'encoding', 'ready'].includes(media.rows.get('movie', 2).web_state), 'the copy is being made');
  await until(() => media.rows.get('movie', 2).web_state === 'ready');
  assert.deepEqual(await cleanup.sweepSeeded({ tx: fakeTx }), { removed: 1 });
  assert.deepEqual(purged, [41], 'only the repackaged movie; the converted episode needs "all"');

  // The movie: gone from disk, release folder removed, still playable.
  assert.equal(fs.existsSync(path.dirname(movieFile)), false);
  const m = await media.locate('movie', 2);
  assert.ok(m.original_removed_at);
  const subs = media.listSubtitles(m);
  assert.equal(subs.length, 1, 'the embedded English track is kept');
  assert.equal(subs[0].editable, false);
  assert.match(fs.readFileSync(await media.vttFor(m, subs[0].id), 'utf8'), /Hello there/);

  // "Delete all web versions" keeps the only copy left.
  media.clearWebVersions();
  assert.equal(media.rows.get('movie', 2).web_state, 'ready');
  assert.equal(media.hlsPlayable('movie', 2), true);
  assert.equal(media.rows.get('episode', 1).web_state, 'none', 'a rebuildable one is cleared');

  // Converted items, once allowed and rebuilt.
  media.enqueue('episode', 1);
  await until(() => media.rows.get('episode', 1).web_state === 'ready');
  settings.set('seed_cleanup', 'all');
  assert.deepEqual(await cleanup.sweepSeeded({ tx: fakeTx }), { removed: 1 });
  assert.equal(fs.existsSync(sidecar), false, 'the sidecar subtitle goes with it');
  assert.equal(fs.existsSync(path.dirname(lib.episode)), true, 'the show folder is never removed');
  const e = await media.locate('episode', 1);
  const es = media.listSubtitles(e);
  assert.equal(es.length, 1);
  assert.match(fs.readFileSync(await media.vttFor(e, es[0].id), 'utf8'), /Second line/);

  // Nothing left to do; a second pass is a no-op.
  assert.deepEqual(await cleanup.sweepSeeded({ tx: fakeTx }), { removed: 0 });
  assert.deepEqual(purged, [41, 42]);
});

test('repackaged copies nobody opened for a while are dropped; the only copy, and conversions, stay', () => {
  const { db } = require('../server/db');
  const fsx = require('fs');
  const pathx = require('path');
  settings.set('web_keep_days', '14');
  settings.set('web_remux_ahead', '0');
  const src = pathx.join(dir, 'still-here.mkv');
  fsx.writeFileSync(src, 'x');
  const old = "datetime('now', '-30 days')";
  for (const [id, plan, removed] of [[501, 'remux', null], [502, 'remux', 'x'], [503, 'transcode', null], [504, 'remux', null]]) {
    media.rows.upsert('movie', id, { path: src, size: 1, plan, plan_reason: 'x', web_state: 'ready', original_removed_at: removed });
    fsx.mkdirSync(media.webDir('movie', id), { recursive: true });
    fsx.writeFileSync(pathx.join(media.webDir('movie', id), 'master.m3u8'), '#EXTM3U\n');
    db.prepare(`UPDATE media_files SET web_last_used = ${id === 504 ? "datetime('now', '-2 days')" : old} WHERE kind = 'movie' AND item_id = ?`).run(id);
  }
  const r = media.dropUnwatched();
  assert.equal(r.dropped, 1);
  assert.equal(media.rows.get('movie', 501).web_state, 'none', 'unwatched for 30 days: dropped');
  assert.equal(fsx.existsSync(media.webDir('movie', 501)), false);
  assert.equal(media.rows.get('movie', 502).web_state, 'ready', 'the only copy left stays');
  assert.equal(media.rows.get('movie', 503).web_state, 'ready', 'a conversion stays');
  assert.equal(media.rows.get('movie', 504).web_state, 'ready', 'watched two days ago stays');
  media.touchWeb('movie', 504);
  settings.set('web_keep_days', '0');
  assert.equal(media.dropUnwatched().dropped, 0, '0 keeps them all');
});
