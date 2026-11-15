'use strict';

// Episode pictures from the video, for episodes TMDB has none for.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshDb, tmpdir, makeLibrary } = require('./helpers');

freshDb();
const { db, settings } = require('../server/db');
const media = require('../server/media');
const thumbs = require('../server/thumbs');

const lib = makeLibrary(tmpdir(), { seconds: 30 });
settings.set('movie_path', lib.movies);
settings.set('shows_path', lib.series);
const file = path.join(lib.series, 'Hevc Show', 'Hevc.Show.S01E01.mp4');
fs.copyFileSync(path.join(lib.movies, 'Direct.Film.2020', 'Direct.Film.2020.1080p.mp4'), file);
db.prepare("INSERT INTO shows (id, tmdb_id, title) VALUES (1, 999, 'Hevc Show')").run();
db.prepare("INSERT INTO episodes (id, show_id, season, episode, status) VALUES (1, 1, 1, 1, 'done')").run();

test('a picture is taken a third of the way in, from keyframes, tone-mapped only for HDR', () => {
  const a = thumbs.stillArgs('/v.mkv', '/o.jpg', { duration: 2700 });
  assert.equal(a[a.indexOf('-ss') + 1], '900');
  assert.ok(a.includes('-skip_frame'));
  assert.ok(!a.join(' ').includes('tonemap'));
  assert.match(thumbs.stillArgs('/v.mkv', '/o.jpg', { duration: 2700, hdr: true }).join(' '), /tonemap=tonemap=hable/);
});

test('the picture is made once, served from disk after, and goes with the file', async () => {
  await media.record('episode', 1, file);
  const p = await thumbs.still('episode', 1);
  assert.ok(p && fs.statSync(p).size > 1000, 'a JPEG came out');
  const head = fs.readFileSync(p).subarray(0, 2);
  assert.deepEqual([...head], [0xff, 0xd8]);
  const at = thumbs.stillAt('episode', 1);
  assert.equal(await thumbs.still('episode', 1), p, 'the same file the second time');
  assert.equal(thumbs.stillAt('episode', 1), at, 'not made again');

  // Another file recorded for the episode: the old picture is gone.
  const other = path.join(lib.series, 'Hevc Show', 'Hevc.Show.S01E01.repack.mp4');
  fs.copyFileSync(file, other);
  fs.appendFileSync(other, Buffer.alloc(16));
  await media.record('episode', 1, other);
  assert.ok(!fs.existsSync(p), 'a changed file drops its picture');
});

test('no file, no picture — and no error', async () => {
  db.prepare("INSERT INTO episodes (id, show_id, season, episode, status) VALUES (2, 1, 1, 2, 'done')").run();
  assert.equal(await thumbs.still('episode', 2), null);
});
