'use strict';

// The status view and the database backups behind it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshDb } = require('./helpers');

const dir = freshDb();
const { db, settings } = require('../server/db');
const backup = require('../server/backup');

test('a backup is a working copy of the database, and only the last seven are kept', () => {
  settings.set('movie_path', '/somewhere');
  const r = backup.backupNow();
  assert.ok(fs.existsSync(r.file));
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(r.file, { readOnly: true });
  assert.equal(copy.prepare("SELECT value FROM settings WHERE key = 'movie_path'").get().value, '/somewhere');
  copy.close();

  // Older days, made up: ten in all, seven left.
  for (let i = 1; i <= 9; i++) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    fs.writeFileSync(path.join(backup.dir(), `auto_magnet-${d}.db`), 'x');
  }
  backup.backupNow();
  const left = backup.list();
  assert.equal(left.length, 7);
  assert.equal(left[0].date, new Date().toISOString().slice(0, 10), 'newest first');
  assert.equal(backup.maybeBackup(), null, 'not again within the day');
  assert.equal(backup.status().count, 7);
  assert.ok(backup.dir().startsWith(dir));
});

test('the status report lists every disk and service without waiting long on any', async () => {
  settings.set('prowlarr_host', '127.0.0.1');
  settings.set('prowlarr_port', '9');            // nothing listens: refused at once
  settings.set('prowlarr_api_key', 'x');
  settings.set('transmission_host', '127.0.0.1');
  settings.set('transmission_port', '9');
  const t0 = Date.now();
  const r = await require('../server/health').report();
  assert.ok(Date.now() - t0 < 15_000);
  assert.deepEqual(r.disks.map(d => d.label), ['Downloads', 'Web versions', 'Database']);
  assert.ok(r.disks[2].free > 0);
  const names = r.services.map(s => s.name);
  for (const n of ['Transmission', 'Prowlarr', 'TMDB', 'OpenSubtitles', 'Encoder']) assert.ok(names.includes(n), n);
  assert.equal(r.services.find(s => s.name === 'Prowlarr').ok, false);
  assert.equal(r.backup.count, 7);
  assert.equal(r.scheduler.running, false);
  void db;
});

test('the library check finds what drifted, and puts it right', async () => {
  const media = require('../server/media');
  const check = require('../server/librarycheck');
  db.prepare("INSERT INTO movies (id, title, year, status, torrent_id, torrent_origin) VALUES (61, 'Gone Film', 2020, 'done', 5, 'added'), (62, 'Stuck Film', 2021, 'downloading', 6, 'added')").run();
  media.rows.upsert('movie', 61, { path: path.join(dir, 'not-there.mkv'), size: 1, plan: 'direct', plan_reason: 'x' });
  fs.mkdirSync(path.join(media.WEB_ROOT, 'movie-999', 'v'), { recursive: true });
  fs.writeFileSync(path.join(media.WEB_ROOT, 'movie-999', 'v', 'seg_00000.m4s'), Buffer.alloc(1000));
  const fakeTx = { listTargets: () => [{ name: 'default' }], resolveTarget: () => ({ name: 'default' }), listTorrents: async () => [{ id: 1 }] };

  const r = await check.run({ tx: fakeTx });
  assert.deepEqual(r.missing.map(m => m.id), [61]);
  assert.deepEqual(r.stuck.map(m => m.id), [62]);
  assert.deepEqual(r.notSeeding.map(m => m.id), [61]);
  assert.equal(r.orphans.length, 1);
  assert.ok(r.orphanBytes >= 1000);
  assert.deepEqual(check.last().missing.map(m => m.id), [61], 'kept for the status view');

  const f = await check.fix('orphans');
  assert.equal(f.fixed, 1);
  assert.equal(fs.existsSync(path.join(media.WEB_ROOT, 'movie-999')), false);
});
