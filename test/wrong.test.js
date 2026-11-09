'use strict';

// Getting the right video, and putting a wrong one right: show names that
// only start the same, releases marked wrong, replacing a download completely,
// and progress that doesn't wait an hour.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshDb, tmpdir } = require('./helpers');

const dir = freshDb();
delete process.env.AMAGNET_NO_SCHEDULER;   // Transmission is a stand-in below
const { db, settings, episodes } = require('../server/db');
settings.set('min_seeds', '1');

// Transmission stand-in, set before the scheduler takes its functions.
const tx = require('../server/transmission');
let progress = new Map();
tx.getTorrentProgress = async () => progress;
const selector = require('../server/selector');
const media = require('../server/media');
const scheduler = require('../server/scheduler');
const { replaceDownload } = require('../server/replace');

const want = (o = {}) => ({ type: 'show', want: { title: 'Ghosts', season: 1, episode: 2, firstAirYear: 2021, countries: ['US'], ...o } });
const rel = (title, magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}`) => ({ title, magnet, seeders: 50, size: 1e9 });

test('a release naming another show is turned down; this show\'s own year and country are fine', () => {
  const ok = (t, w) => selector.evaluate([rel(t)], want(w)).accepted.length === 1;
  const why = (t, w) => selector.evaluate([rel(t)], want(w)).rejected[0]?._reason;
  assert.ok(ok('Ghosts.S01E02.1080p.WEB.h264-GRP'));
  assert.ok(ok('Ghosts.2021.S01E02.1080p.WEB.h264'), 'its own first-air year');
  assert.ok(ok('Ghosts.US.S01E02.1080p.WEB.h264'), 'its own country');
  assert.match(why('Ghosts.UK.S01E02.1080p.WEB.h264'), /names another show — "uk"/);
  assert.match(why('Ghosts.2019.S01E02.1080p.WEB.h264'), /names another show — "2019"/);
  assert.match(why('Silo.Stories.S02E01.1080p.WEB', { title: 'Silo', season: 2, episode: 1, firstAirYear: 2023 }), /"stories"/);
  assert.match(why('9-1-1.Lone.Star.S01E02.1080p', { title: '9-1-1', countries: ['US'] }), /"lone star"/);
  assert.ok(ok('[TGx] Ghosts S01E02 1080p WEB'), 'a group tag in front is not part of the name');
  assert.ok(ok('Shōgun.S01E02.1080p', { title: 'Shōgun', firstAirYear: 2024 }));
  assert.ok(ok('Shogun.2024.S01E02.1080p', { title: 'Shōgun', firstAirYear: 2024 }), 'accents folded either way');
  assert.ok(ok('Ghosts.UK.S01E02.1080p', { countries: [] }), 'country unknown: not held against it');
});

test('a release marked wrong is never offered again, whatever trackers its magnet carries', () => {
  const hash = 'b'.repeat(40);
  const r = selector.evaluate(
    [rel('Ghosts.S01E02.1080p', `magnet:?xt=urn:btih:${hash.toUpperCase()}&tr=udp://other`)],
    { ...want(), wrong: [`magnet:?xt=urn:btih:${hash}&tr=udp://one`] },
  );
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected[0]._reason, 'marked as the wrong video for this item');
});

test('replacing a wrong download removes everything it left and never picks it again', async () => {
  const lib = tmpdir();
  settings.set('shows_path', lib);
  const showDir = path.join(lib, 'Ghosts');
  fs.mkdirSync(showDir, { recursive: true });
  const file = path.join(showDir, 'Ghosts.UK.S01E02.mkv');
  fs.writeFileSync(file, 'wrong show');
  fs.writeFileSync(file.replace(/\.mkv$/, '.en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nhi\n');

  db.prepare("INSERT INTO shows (id, tmdb_id, title) VALUES (1, 100, 'Ghosts')").run();
  const magnet = `magnet:?xt=urn:btih:${'c'.repeat(40)}`;
  db.prepare(`INSERT INTO episodes (id, show_id, season, episode, status, magnet, torrent_id, torrent_origin, release_title,
    completed_at, post_processed_at, subs_state) VALUES (1, 1, 1, 2, 'done', ?, 9, 'added', 'Ghosts.UK.S01E02.1080p', 'x', 'x', 'done')`).run(magnet);
  const probe = JSON.stringify({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }], format: {} });
  media.rows.upsert('episode', 1, { path: file, size: 10, plan: 'remux', plan_reason: 'x', probe, web_state: 'ready' });
  fs.mkdirSync(path.join(media.webDir('episode', 1), 'v'), { recursive: true });
  fs.writeFileSync(path.join(media.webDir('episode', 1), 'master.m3u8'), '#EXTM3U\n');
  const thumbs = require('../server/thumbs');
  fs.mkdirSync(thumbs.dirFor('episode', 1), { recursive: true });

  const purged = [];
  const fakeTx = {
    resolveTarget: () => null,
    getTorrentInfo: async () => ({ id: 9, downloadDir: showDir, files: [{ name: 'Ghosts.UK.S01E02.mkv', length: 10 }] }),
    purgeTorrent: async (id) => { purged.push(id); fs.rmSync(file, { force: true }); },
    setFilesUnwanted: async () => {},
  };
  const r = await replaceDownload('episode', 1, { reason: 'another show', search: false, tx: fakeTx });
  assert.equal(r.release, 'Ghosts.UK.S01E02.1080p');
  assert.deepEqual(purged, [9], 'its own torrent, with its data');
  assert.equal(fs.existsSync(file.replace(/\.mkv$/, '.en.srt')), false, 'its subtitle beside it');
  assert.equal(media.rows.get('episode', 1), undefined, 'no longer on record: nothing old can play');
  assert.equal(fs.existsSync(media.webDir('episode', 1)), false, 'its web version');
  assert.equal(fs.existsSync(thumbs.dirFor('episode', 1)), false, 'its thumbnails');

  const ep = episodes.byId(1);
  assert.equal(ep.status, 'pending');
  for (const k of ['magnet', 'torrent_id', 'release_title', 'completed_at', 'post_processed_at', 'subs_state']) assert.equal(ep[k], null, k);
  assert.match(ep.last_error, /Replacing the wrong video: another show/);
  assert.equal(JSON.parse(ep.rejected_releases)[0].magnet, magnet);
  assert.deepEqual(scheduler.wrongReleases(ep), [magnet], 'the next search leaves it out');

  // A plain Redo of a failed item later clears what was tried — not what was marked wrong.
  episodes.update(1, { status: 'failed', tried_magnets: JSON.stringify([magnet]) });
  assert.deepEqual(scheduler.wrongReleases(episodes.byId(1)), [magnet]);
});

test('progress is synced every minute, not only in the hourly run', async () => {
  db.prepare("INSERT INTO episodes (id, show_id, season, episode, status, torrent_id, progress) VALUES (2, 1, 1, 3, 'downloading', 12, 0)").run();
  progress = new Map([[tx.progressKey(null, 12), { progress: 100, done: true }]]);
  await scheduler.quickSync();
  const ep = episodes.byId(2);
  assert.equal(ep.status, 'done');
  assert.equal(ep.progress, 100);
  void dir;
});
