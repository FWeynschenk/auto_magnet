'use strict';

// Deleting by hand: a web version alone, or everything — with a stand-in for
// Transmission, so what is asked of it can be checked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshDb, tmpdir } = require('./helpers');

freshDb();
const { db, settings, movies, episodes } = require('../server/db');
const media = require('../server/media');
const { deleteWebVersion, deleteEverything } = require('../server/deletion');

const lib = tmpdir();
const MOVIES = path.join(lib, 'Movies'), SHOWS = path.join(lib, 'Series');
settings.set('movie_path', MOVIES);
settings.set('shows_path', SHOWS);

function file(p, bytes = 1000) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

/** A finished web version on disk, as the encoder leaves it. */
function webVersion(kind, id, bytes = 5000) {
  file(path.join(media.webDir(kind, id), 'master.m3u8'), 100);
  file(path.join(media.webDir(kind, id), 'v', 'seg_00000.m4s'), bytes);
}

/** Records what deletion asks Transmission to do. */
function fakeTx(torrents = {}, { down = false } = {}) {
  const calls = [];
  return {
    calls,
    resolveTarget: (name) => name,
    async getTorrentInfo(id) {
      if (down) throw new Error('connect ECONNREFUSED');
      return torrents[id] || null;
    },
    async purgeTorrent(id) {
      calls.push(['purge', id]);
      // Transmission deletes the torrent's files itself.
      const t = torrents[id];
      for (const f of t.files) fs.rmSync(path.join(t.downloadDir, f.name), { force: true });
    },
    async setFilesUnwanted(id, indexes) { calls.push(['unwanted', id, indexes]); },
  };
}

const row = (kind, id, p, extra = {}) => media.rows.upsert(kind, id, {
  path: p, size: fs.statSync(p).size, plan: 'remux', plan_reason: 'MKV container', web_state: 'ready', ...extra,
});

test('deleting a web version keeps the original; it is made again when next opened', () => {
  const p = file(path.join(MOVIES, 'Kept.2020', 'Kept.2020.mkv'));
  db.prepare("INSERT INTO movies (id, title, year, status) VALUES (1, 'Kept', 2020, 'done')").run();
  row('movie', 1, p);
  webVersion('movie', 1);
  const r = deleteWebVersion('movie', 1);
  assert.ok(r.freed >= 5000);
  assert.ok(!fs.existsSync(media.webDir('movie', 1)));
  assert.ok(fs.existsSync(p), 'original untouched');
  assert.equal(media.rows.get('movie', 1).web_state, 'none');
  assert.equal(movies.byId(1).status, 'done');
});

test('a web version that is the only copy left is not deleted on its own', () => {
  const p = path.join(MOVIES, 'Seeded', 'Seeded.mkv');
  db.prepare("INSERT INTO movies (id, title, status) VALUES (2, 'Seeded', 'done')").run();
  media.rows.upsert('movie', 2, { path: p, size: 1, plan: 'remux', web_state: 'ready', original_removed_at: '2026-11-01' });
  webVersion('movie', 2);
  assert.throws(() => deleteWebVersion('movie', 2), (e) => e.status === 409 && /only copy/.test(e.message));
  assert.ok(fs.existsSync(media.webDir('movie', 2)));
});

test('a torrent that is only this film is removed with its files, subtitles and web version', async () => {
  const dir = path.join(MOVIES, 'Gone.2021');
  const p = file(path.join(dir, 'Gone.2021.mkv'), 4000);
  file(path.join(dir, 'Gone.2021.nfo'), 10);
  const srt = file(path.join(dir, 'Gone.2021.en.srt'), 10);
  db.prepare("INSERT INTO movies (id, title, year, status, torrent_id, torrent_origin) VALUES (3, 'Gone', 2021, 'done', 7, 'added')").run();
  row('movie', 3, p);
  webVersion('movie', 3);
  const tx = fakeTx({ 7: { downloadDir: MOVIES, files: [{ name: 'Gone.2021/Gone.2021.mkv' }, { name: 'Gone.2021/Gone.2021.nfo' }] } });

  const r = await deleteEverything('movie', 3, { tx });
  assert.deepEqual(tx.calls, [['purge', 7]]);
  assert.match(r.original, /torrent removed/);
  assert.ok(r.freed >= 4000 + 5000);
  assert.ok(!fs.existsSync(srt), 'fetched subtitle removed too');
  assert.ok(!fs.existsSync(dir), 'empty release folder removed');
  assert.ok(!fs.existsSync(media.webDir('movie', 3)));
  assert.equal(media.rows.get('movie', 3), undefined);
  assert.equal(movies.byId(3).status, 'deleted', 'never grabbed again');
});

test('an episode from a season pack: only its file goes, the pack keeps seeding', async () => {
  const dir = path.join(SHOWS, 'Show', 'Show.S01.1080p');
  const e1 = file(path.join(dir, 'Show.S01E01.mkv'));
  const e2 = file(path.join(dir, 'Show.S01E02.mkv'));
  const sub = file(path.join(dir, 'Show.S01E01.en.srt'), 10);
  db.prepare("INSERT INTO shows (id, tmdb_id, title) VALUES (1, 5, 'Show')").run();
  db.prepare(`INSERT INTO episodes (id, show_id, season, episode, status, torrent_id, torrent_origin)
              VALUES (1, 1, 1, 1, 'done', 9, 'added'), (2, 1, 1, 2, 'done', 9, 'added')`).run();
  row('episode', 1, e1);
  row('episode', 2, e2);
  const tx = fakeTx({ 9: { downloadDir: path.join(SHOWS, 'Show'),
    files: [{ name: 'Show.S01.1080p/Show.S01E01.mkv' }, { name: 'Show.S01.1080p/Show.S01E02.mkv' }] } });

  const r = await deleteEverything('episode', 1, { tx });
  assert.deepEqual(tx.calls, [['unwanted', 9, [0]]], 'only its file, by index; no purge');
  assert.match(r.original, /rest keeps seeding/);
  assert.ok(!fs.existsSync(e1));
  assert.ok(!fs.existsSync(sub));
  assert.ok(fs.existsSync(e2), 'the other episode stays');
  assert.equal(episodes.byId(1).status, 'deleted');
  assert.equal(episodes.byId(2).status, 'done');
});

test('deleting the last episode left of a pack removes the whole torrent', async () => {
  const dir = path.join(SHOWS, 'Show', 'Show.S02.1080p');
  file(path.join(dir, 'Show.S02E01.mkv'));   // still on disk from before, but dropped from the torrent
  const e2 = file(path.join(dir, 'Show.S02E02.mkv'));
  db.prepare(`INSERT INTO episodes (id, show_id, season, episode, status, torrent_id, torrent_origin)
              VALUES (3, 1, 2, 1, 'deleted', 13, 'added'), (4, 1, 2, 2, 'done', 13, 'added')`).run();
  row('episode', 4, e2);
  const tx = fakeTx({ 13: { downloadDir: path.join(SHOWS, 'Show'), files: [
    { name: 'Show.S02.1080p/Show.S02E01.mkv', wanted: false },
    { name: 'Show.S02.1080p/Show.S02E02.mkv', wanted: true },
  ] } });
  const r = await deleteEverything('episode', 4, { tx });
  assert.deepEqual(tx.calls, [['purge', 13]], 'nothing else in it is wanted: the torrent goes');
  assert.match(r.original, /torrent removed/);
  assert.equal(episodes.byId(4).status, 'deleted');
});

test('a torrent that was already in Transmission is never removed, only this file', async () => {
  const p = file(path.join(MOVIES, 'Theirs', 'Theirs.mkv'));
  db.prepare("INSERT INTO movies (id, title, status, torrent_id, torrent_origin) VALUES (4, 'Theirs', 'done', 11, 'duplicate')").run();
  row('movie', 4, p);
  const tx = fakeTx({ 11: { downloadDir: MOVIES, files: [{ name: 'Theirs/Theirs.mkv' }] } });
  await deleteEverything('movie', 4, { tx });
  assert.deepEqual(tx.calls, [['unwanted', 11, [0]]]);
  assert.ok(!fs.existsSync(p));
});

test('no torrent any more: the file is deleted directly', async () => {
  const p = file(path.join(MOVIES, 'Old', 'Old.mkv'));
  db.prepare("INSERT INTO movies (id, title, status) VALUES (5, 'Old', 'done')").run();
  row('movie', 5, p);
  const r = await deleteEverything('movie', 5, { tx: fakeTx() });
  assert.equal(r.original, 'file removed');
  assert.ok(!fs.existsSync(p));
});

test('nothing outside the movie and show folders is ever deleted', async () => {
  const p = file(path.join(tmpdir(), 'Elsewhere.mkv'));
  db.prepare("INSERT INTO movies (id, title, status) VALUES (6, 'Elsewhere', 'done')").run();
  row('movie', 6, p);
  await assert.rejects(deleteEverything('movie', 6, { tx: fakeTx() }), (e) => e.status === 409 && /outside/.test(e.message));
  assert.ok(fs.existsSync(p));
  assert.equal(movies.byId(6).status, 'done', 'left as it was');
});

test('Transmission unreachable: nothing is deleted, and it says why', async () => {
  const p = file(path.join(MOVIES, 'Later', 'Later.mkv'));
  db.prepare("INSERT INTO movies (id, title, status, torrent_id, torrent_origin) VALUES (7, 'Later', 'done', 12, 'added')").run();
  row('movie', 7, p);
  webVersion('movie', 7);
  await assert.rejects(deleteEverything('movie', 7, { tx: fakeTx({}, { down: true }) }), (e) => e.status === 503);
  assert.ok(fs.existsSync(p));
  assert.ok(fs.existsSync(media.webDir('movie', 7)));
  assert.equal(movies.byId(7).status, 'done');
});

test('something still downloading is not deleted from here', async () => {
  db.prepare("INSERT INTO movies (id, title, status) VALUES (8, 'Busy', 'downloading')").run();
  await assert.rejects(deleteEverything('movie', 8, { tx: fakeTx() }), (e) => e.status === 409 && /Still downloading/.test(e.message));
});

test('the largest web versions are listed for freeing space by hand', () => {
  webVersion('movie', 1, 9000);
  const list = media.largestWebVersions();
  assert.equal(list[0].kind, 'movie');
  assert.equal(list[0].id, 1);
  assert.ok(list[0].bytes >= 9000);
  assert.equal(list.find(w => w.id === 2).onlyCopy, true);
});
