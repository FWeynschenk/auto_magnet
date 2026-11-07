'use strict';

// Finding the intro two episodes share, wherever it sits in each.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { freshDb, tmpdir, ffmpeg, hasFfmpeg } = require('./helpers');

freshDb();
const { db } = require('../server/db');
const media = require('../server/media');
const intro = require('../server/intro');

// "Music": a melody that changes every half second, the same in every episode.
const THEME = "aevalsrc='0.4*sin(2*PI*(220+55*mod(floor(t*2)*7,13))*t)+0.2*sin(2*PI*(440+30*mod(floor(t*4)*5,11))*t)':s=44100:d=40";
// Each episode's own sound: a wobbling tone of its own (plain noise prints alike in every episode).
const other = (seed, secs) => `aevalsrc='0.3*sin(2*PI*(${150 + seed * 37}+${80 + seed * 13}*sin(t*${(0.7 + seed * 0.31).toFixed(2)}))*t)+0.05*(random(${seed})-0.5)':s=44100:d=${secs}`;

/** An episode: `before` s of its own sound, the 40 s theme, then 60 s more of its own. */
function episode(dir, name, seed, before) {
  const file = path.join(dir, `${name}.mka`);
  ffmpeg(['-f', 'lavfi', '-i', other(seed, before), '-f', 'lavfi', '-i', THEME, '-f', 'lavfi', '-i', other(seed + 100, 60),
    '-filter_complex', '[0:a]aresample=44100[a];[1:a]aresample=44100[b];[2:a]aresample=44100[c];[a][b][c]concat=n=3:v=0:a=1[o]',
    '-map', '[o]', '-c:a', 'aac', '-b:a', '128k', file]);
  return file;
}

test('the shared stretch of two made-up prints is found, with each one\'s position', () => {
  const rnd = (n, seed) => { let x = seed; return Uint32Array.from({ length: n }, () => (x = (x * 1103515245 + 12345) >>> 0)); };
  const theme = rnd(300, 1);                      // ~37 s
  const A = Uint32Array.from([...rnd(100, 2), ...theme, ...rnd(200, 3)]);
  const B = Uint32Array.from([...rnd(400, 4), ...theme.map((v, i) => (i % 40 === 0 ? v ^ 0xff0000ff : v ^ (i % 3))), ...rnd(50, 5)]);
  const r = intro.sharedStretch(A, B);
  assert.ok(r, 'found');
  assert.ok(Math.abs(r.a[0] - 100 * intro.SECS_PER_POINT) < 0.5, `A starts at ${r.a[0]}`);
  assert.ok(Math.abs(r.b[0] - 400 * intro.SECS_PER_POINT) < 0.5, `B starts at ${r.b[0]}`);
  assert.ok(r.a[1] - r.a[0] > 33, 'a bad point now and then is bridged (and 2 s trimmed off the end)');
  assert.equal(intro.sharedStretch(rnd(500, 7), rnd(500, 8)), null, 'nothing shared, nothing found');
});

test('two episodes with the theme at different points: each one\'s intro is found', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tmpdir();
  const f1 = episode(dir, 'e1', 1, 25);
  const f2 = episode(dir, 'e2', 2, 70);
  db.prepare("INSERT INTO shows (id, tmdb_id, title) VALUES (1, 1, 'Show')").run();
  db.prepare("INSERT INTO episodes (id, show_id, season, episode, status) VALUES (1, 1, 1, 1, 'done'), (2, 1, 1, 2, 'done')").run();
  const probe = JSON.stringify({ streams: [{ index: 0, codec_type: 'audio', codec_name: 'aac', channels: 1 }], format: {} });
  // Said to be 10 minutes long, so the scanned first third covers the whole short file.
  media.rows.upsert('episode', 1, { path: f1, size: 1, duration: 600, plan: 'direct', plan_reason: 'x', probe });
  media.rows.upsert('episode', 2, { path: f2, size: 1, duration: 600, plan: 'direct', plan_reason: 'x', probe });

  const r = await intro.pass();
  assert.equal(r.found, 1, 'one comparison finds both');
  const i1 = intro.introOf('episode', 1), i2 = intro.introOf('episode', 2);
  assert.ok(Math.abs(i1.start - 25) < 1.5 && Math.abs(i1.end - 65) < 1.5, `episode 1: ${JSON.stringify(i1)}`);
  assert.ok(Math.abs(i2.start - 70) < 1.5 && Math.abs(i2.end - 110) < 1.5, `episode 2: ${JSON.stringify(i2)}`);
  assert.deepEqual(await intro.pass(), { checked: 0, found: 0 }, 'not looked at again');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audio_prints').get().n, 2, 'prints kept');
});
