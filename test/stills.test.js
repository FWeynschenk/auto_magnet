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
  const tries = thumbs.stillArgs('/v.mkv', '/o.jpg', { duration: 2700, stream: 2 });
  const [a] = tries;
  assert.equal(a[a.indexOf('-ss') + 1], '900');
  assert.ok(a.includes('-skip_frame'));
  assert.equal(a[a.indexOf('-map') + 1], '0:2', 'the probed video stream, not just the first');
  assert.ok(!a.join(' ').includes('tonemap'));
  assert.ok(!tries[1].includes('-skip_frame') && tries[1].includes('-ss'), 'then any frame there');
  assert.ok(!tries[2].includes('-ss'), 'then the first frame');
  assert.match(thumbs.stillArgs('/v.mkv', '/o.jpg', { duration: 2700, hdr: true })[0].join(' '), /tonemap=tonemap=hable/);
});

const until = async (fn, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 100)); }
  return false;
};

test('the picture is made once, served from disk after, and goes with the file', async () => {
  await media.record('episode', 1, file);
  const t0 = Date.now();
  assert.equal(thumbs.still('episode', 1), null, 'not made yet: answered at once');
  assert.ok(Date.now() - t0 < 200, 'without waiting for ffmpeg');
  assert.ok(await until(() => thumbs.stillAt('episode', 1) > 0), 'made in the background');
  const p = thumbs.still('episode', 1);
  assert.ok(p && fs.statSync(p).size > 1000, 'a JPEG came out');
  const head = fs.readFileSync(p).subarray(0, 2);
  assert.deepEqual([...head], [0xff, 0xd8]);
  const at = thumbs.stillAt('episode', 1);
  assert.equal(thumbs.still('episode', 1), p, 'the same file the second time');
  assert.equal(thumbs.stillAt('episode', 1), at, 'not made again');

  // Another file recorded for the episode: the old picture is gone.
  const other = path.join(lib.series, 'Hevc Show', 'Hevc.Show.S01E01.repack.mp4');
  fs.copyFileSync(file, other);
  fs.appendFileSync(other, Buffer.alloc(16));
  await media.record('episode', 1, other);
  assert.ok(!fs.existsSync(p), 'a changed file drops its picture');
});

test('a frame comes out of an HEVC 10-bit MKV with AC-3 audio, the usual release', async () => {
  const { execFileSync } = require('child_process');
  const mkv = path.join(lib.series, 'Hevc Show', 'Hevc.Show.S01E03.mkv');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=24000/1001:d=90', '-f', 'lavfi', '-i', 'sine=d=90',
    '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error:keyint=240:open-gop=1', '-c:a', 'ac3', mkv]);
  db.prepare("INSERT INTO episodes (id, show_id, season, episode, status) VALUES (3, 1, 1, 3, 'done')").run();
  await media.record('episode', 3, mkv);
  const p = await thumbs._makeStill('episode', 3);
  assert.ok(p && fs.statSync(p).size > 1000);
});

test('no file, no picture — and no error', async () => {
  db.prepare("INSERT INTO episodes (id, show_id, season, episode, status) VALUES (2, 1, 1, 2, 'done')").run();
  assert.equal(thumbs.still('episode', 2), null);
});
