'use strict';

// End to end: a real server process, a seeded database and real media made by
// ffmpeg. Covers accounts and roles, direct play with range requests, a remux
// and a transcode through the encode queue, subtitles, and progress.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { tmpdir, hasFfmpeg, makeLibrary } = require('./helpers');

const skip = !hasFfmpeg && 'ffmpeg not installed';
const dir = tmpdir();
const PORT = 20000 + Math.floor(Math.random() * 20000);
const B = `http://127.0.0.1:${PORT}`;
let srv, out = '';
let cookie = '', token = '';

async function call(method, p, body, { tok, raw, headers = {}, jar = true } = {}) {
  const h = { ...headers };
  if (body) h['Content-Type'] = 'application/json';
  if (tok) h.Authorization = `Bearer ${tok}`;
  else if (jar && cookie) h.Cookie = cookie;
  const r = await fetch(B + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc && !tok && jar) cookie = sc.split(';')[0];
  if (raw) return r;
  let j = null;
  try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}

const probeOf = (file) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt', '-of', 'csv', file]).toString();

const until = async (fn, ms = 120_000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 500));
  }
};

test.before(async () => {
  if (skip) return;
  const lib = makeLibrary(path.join(dir, 'media'));
  const env = { ...process.env, DB_PATH: path.join(dir, 'api.db'), WEB_PATH: path.join(dir, 'web'),
    AMAGNET_PORT: String(PORT), AMAGNET_BIND: '127.0.0.1', AMAGNET_NO_SCHEDULER: '1', AMAGNET_TOKEN: '' };
  // Seed through the server's own schema, in a separate process.
  execFileSync(process.execPath, ['-e', `
    const { db, settings } = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'db'))});
    settings.set('movie_path', ${JSON.stringify(lib.movies)});
    settings.set('shows_path', ${JSON.stringify(lib.series)});
    settings.set('web_encoder', 'x264');
    db.prepare("INSERT INTO movies (id, title, year, status) VALUES (1, 'Direct Film', 2020, 'done'), (2, 'Remux Film', 2021, 'done'), (3, 'Missing Film', 2019, 'done'), (4, 'Dual Audio Film', 2022, 'done')").run();
    db.prepare("INSERT INTO shows (id, tmdb_id, title) VALUES (1, 999, 'Hevc Show')").run();
    db.prepare("INSERT INTO episodes (id, show_id, season, episode, status) VALUES (1, 1, 1, 2, 'done')").run();
  `], { env, stdio: 'ignore' });
  srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', d => { out += d; });
  srv.stderr.on('data', d => { out += d; });
  await until(async () => { try { return (await fetch(B + '/api/auth/status')).ok; } catch (_) { return false; } }, 15_000);
});

test.after(() => { srv?.kill(); });

test('accounts and roles', { skip }, async (t) => {
  await t.test('everything is locked until the first account exists', async () => {
    const r = await call('GET', '/api/movies');
    assert.equal(r.status, 401);
    assert.equal(r.body.setupRequired, true);
  });
  await t.test('setup creates an admin, once', async () => {
    assert.equal((await call('POST', '/api/auth/setup', { username: 'admin', password: 'short' })).status, 400);
    const r = await call('POST', '/api/auth/setup', { username: 'admin', password: 'correct horse' });
    assert.equal(r.body.user.role, 'admin');
    assert.equal((await call('POST', '/api/auth/setup', { username: 'x', password: 'correct horse' }, { jar: false })).status, 409);
  });
  await t.test('admin reaches the downloader API; a cross-origin write with the cookie is refused', async () => {
    assert.equal((await call('GET', '/api/movies')).body.length, 4);
    assert.equal((await call('POST', '/api/movies', {}, { headers: { Origin: 'http://evil.example' } })).status, 403);
  });
  await t.test('viewer signs in as an app and gets a token, not a cookie', async () => {
    assert.equal((await call('POST', '/api/auth/users', { username: 'kid', password: 'viewer pass' })).status, 200);
    assert.equal((await call('POST', '/api/auth/login', { username: 'kid', password: 'nope' }, { jar: false })).status, 401);
    const r = await call('POST', '/api/auth/login', { username: 'KID', password: 'viewer pass', client: 'test' }, { jar: false });
    assert.ok(r.body.token);
    token = r.body.token;
  });
  await t.test('viewer can watch but not manage', async () => {
    assert.equal((await call('GET', '/api/movies', null, { tok: token })).status, 403);
    assert.equal((await call('GET', '/api/watch/admin/status', null, { tok: token })).status, 403);
    assert.equal((await call('GET', '/api/watch/movies', null, { tok: token })).body.length, 4);
  });
});

test('playback', { skip }, async (t) => {
  await t.test('MP4/H.264/AAC plays directly with range requests', async () => {
    const r = await call('GET', '/api/watch/items/movie/1', null, { tok: token });
    assert.equal(r.body.playback.mode, 'file');
    const f = await call('GET', r.body.playback.url, null, { tok: token, raw: true, headers: { Range: 'bytes=0-99' } });
    assert.equal(f.status, 206);
    assert.equal((await f.arrayBuffer()).byteLength, 100);
  });
  await t.test('a missing file says so', async () => {
    const r = await call('GET', '/api/watch/items/movie/3', null, { tok: token });
    assert.equal(r.body.playback.mode, 'unavailable');
    assert.match(r.body.playback.error, /can't be found/);
  });
  await t.test('MKV + AC-3 is remuxed and 10-bit is transcoded, to HLS', async () => {
    const remux = await call('GET', '/api/watch/items/movie/2', null, { tok: token });
    assert.equal(remux.body.playback.plan, 'remux');
    const tc = await call('GET', '/api/watch/items/episode/1', null, { tok: token });
    assert.equal(tc.body.playback.plan, 'transcode');
    for (const p of ['/api/watch/items/movie/2/playback', '/api/watch/items/episode/1/playback']) {
      const pb = await until(async () => {
        const b = (await call('GET', p, null, { tok: token })).body;
        if (b.state === 'failed') throw new Error(b.error);
        return b.mode === 'hls' && b.complete ? b : null;
      });
      assert.match(pb.url, /\/hls\/master\.m3u8$/);
      const master = await (await call('GET', pb.url, null, { tok: token, raw: true })).text();
      assert.match(master, /#EXT-X-STREAM-INF:BANDWIDTH=\d+,AUDIO="aud"\nv\/index\.m3u8/);
      for (const rel of ['v/index.m3u8', 'a0/index.m3u8']) {
        const pl = await (await call('GET', pb.url.replace('master.m3u8', rel), null, { tok: token, raw: true })).text();
        assert.match(pl, /#EXT-X-ENDLIST/, rel);
      }
    }
    // Init segments describe the tracks only; the media is in the segments
    // (Media3 fails otherwise — see repairInitSegments).
    for (const item of ['movie-2', 'episode-1']) {
      for (const sub of fs.readdirSync(path.join(dir, 'web', item)).filter(n => /^(v|a\d+)$/.test(n))) {
        const files = fs.readdirSync(path.join(dir, 'web', item, sub));
        const init = files.find(n => /^init/.test(n));
        const types = (f) => require('../server/media').mp4Boxes(fs.readFileSync(path.join(dir, 'web', item, sub, f))).map(b => b.type);
        assert.deepEqual(types(init), ['ftyp', 'moov'], `${item}/${sub}/${init}`);
        assert.ok(types('seg_00000.m4s').includes('moof'), `${item}/${sub}/seg_00000.m4s has media`);
      }
    }
    assert.match(probeOf(path.join(dir, 'web', 'episode-1', 'v', 'index.m3u8')), /h264,yuv420p\b/);
    assert.match(probeOf(path.join(dir, 'web', 'episode-1', 'a0', 'index.m3u8')), /aac/);
  });
  await t.test('every audio track is kept, the preferred one first', async () => {
    const pb = (await call('GET', '/api/watch/items/movie/2/playback', null, { tok: token })).body;
    const master = await (await call('GET', pb.url, null, { tok: token, raw: true })).text();
    const lines = master.split('\n').filter(l => l.startsWith('#EXT-X-MEDIA:'));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /NAME="English",LANGUAGE="en",DEFAULT=YES.*URI="a0\/index\.m3u8"/);
    assert.match(lines[1], /NAME="Dutch",LANGUAGE="nl",DEFAULT=NO.*URI="a1\/index\.m3u8"/);
    const a1 = await call('GET', pb.url.replace('master.m3u8', 'a1/index.m3u8'), null, { tok: token, raw: true });
    assert.match(await a1.text(), /#EXT-X-ENDLIST/);
    assert.match(probeOf(path.join(dir, 'web', 'movie-2', 'a1', 'index.m3u8')), /aac/);
  });
  await t.test('an MP4 with two audio tracks plays at once, then switches to a web version with both', async () => {
    const first = await call('GET', '/api/watch/items/movie/4', null, { tok: token });
    assert.equal(first.body.playback.plan, 'remux');
    assert.match(first.body.playback.reason, /2 audio tracks/);
    assert.notEqual(first.body.playback.mode, 'preparing', 'never waits: the MP4 itself plays meanwhile');
    const pb = await until(async () => {
      const b = (await call('GET', '/api/watch/items/movie/4/playback', null, { tok: token })).body;
      return b.mode === 'hls' && b.complete ? b : null;
    });
    const master = await (await call('GET', pb.url, null, { tok: token, raw: true })).text();
    assert.equal(master.split('\n').filter(l => l.startsWith('#EXT-X-MEDIA:')).length, 2);
  });
  await t.test('HLS file names are whitelisted', async () => {
    for (const p of ['..%2F..%2Fapi.db', 'x/index.m3u8', '..%2F..%2Fweb/index.m3u8', 'v/..%2F..%2F..%2Fapi.db']) {
      const r = await call('GET', `/api/watch/items/episode/1/hls/${p}`, null, { tok: token, raw: true });
      assert.equal(r.status, 404, p);
    }
  });
  await t.test('the original stays untouched', async () => {
    assert.ok(fs.existsSync(path.join(dir, 'media', 'Movies', 'Remux.Film.2021', 'Remux.Film.2021.mkv')));
    assert.ok(!fs.readdirSync(path.join(dir, 'media', 'Movies', 'Remux.Film.2021')).some(n => /m3u8|m4s/.test(n)));
  });
});

test('subtitles', { skip }, async (t) => {
  let side;
  await t.test('embedded text track converts to WebVTT', async () => {
    const subs = (await call('GET', '/api/watch/items/movie/2/subtitles', null, { tok: token })).body;
    const emb = subs.find(s => s.source === 'embedded');
    const vtt = await (await call('GET', emb.url, null, { tok: token, raw: true })).text();
    assert.match(vtt, /^WEBVTT/);
    assert.match(vtt, /Hello there/);
  });
  await t.test('sidecar English .srt is found and is the default', async () => {
    const subs = (await call('GET', '/api/watch/items/episode/1/subtitles', null, { tok: token })).body;
    side = subs.find(s => s.source === 'file');
    assert.equal(side.lang, 'en');
    assert.equal(side.default, true);
    assert.equal(side.editable, true);
    assert.equal(side.file, undefined, 'server paths are not sent to clients');
  });
  await t.test('a saved offset rewrites the file, and restore undoes it', async () => {
    assert.equal((await call('POST', `/api/watch/items/episode/1/subtitles/${side.id}/shift`, { offsetMs: 1500 }, { tok: token })).status, 200);
    assert.match(await (await call('GET', side.url, null, { tok: token, raw: true })).text(), /00:00:02\.500 --> 00:00:04\.500/);
    assert.equal((await call('POST', `/api/watch/items/episode/1/subtitles/${side.id}/restore`, null, { tok: token })).body.restored, true);
    assert.match(await (await call('GET', side.url, null, { tok: token, raw: true })).text(), /00:00:01\.000 --> 00:00:03\.000/);
  });
});

test('progress', { skip }, async (t) => {
  await t.test('saved, and an older report is ignored', async () => {
    assert.equal((await call('PUT', '/api/watch/progress/movie/1', { position: 300, duration: 6000 }, { tok: token })).body.position, 300);
    const r = await call('PUT', '/api/watch/progress/movie/1', { position: 100, duration: 6000, at: Date.now() - 3600_000 }, { tok: token });
    assert.equal(r.body.position, 300);
  });
  await t.test('shows up in continue watching for that user only', async () => {
    assert.deepEqual((await call('GET', '/api/watch/home', null, { tok: token })).body.continue.map(i => i.id), [1]);
    assert.deepEqual((await call('GET', '/api/watch/home')).body.continue, []);
  });
  await t.test('offline batch upload returns the merged state', async () => {
    const r = await call('POST', '/api/watch/progress/sync', {
      items: [{ kind: 'movie', id: 2, position: 500, duration: 7000, at: Date.now() }, { kind: 'movie', id: 999, position: 1, at: Date.now() }],
    }, { tok: token });
    assert.deepEqual(r.body.map(x => x.id).sort(), [1, 2]);
  });
  await t.test('signing out ends the session', async () => {
    await call('POST', '/api/auth/logout', null, { tok: token });
    assert.equal((await call('GET', '/api/watch/home', null, { tok: token })).status, 401);
  });
});

test.after(() => { if (process.exitCode) console.log(out.slice(-3000)); });
