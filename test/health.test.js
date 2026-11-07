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
