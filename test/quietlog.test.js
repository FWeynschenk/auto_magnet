'use strict';

// A search that keeps coming up empty is logged once, then summed up per run.

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');

freshDb();
process.env.AMAGNET_NO_SCHEDULER = '1';
const { db, settings } = require('../server/db');
// No indexers: every search finds nothing. Stubbed before the scheduler loads it.
const pipeline = require('../server/pipeline');
pipeline.findCandidates = async () => ({ accepted: [], rejected: [] });
settings.set('transmission_host', '127.0.0.1');
settings.set('transmission_port', '9');
const scheduler = require('../server/scheduler');

const count = (re) => db.prepare('SELECT message FROM scheduler_log').all().filter(r => re.test(r.message)).length;

test('three empty runs: one warning, one search line, a summary each run', async () => {
  db.prepare("INSERT INTO movies (id, title, year, status, mode) VALUES (5, 'Not Out Yet', 2026, 'pending', 'auto')").run();
  for (let i = 0; i < 3; i++) await scheduler.run();
  assert.equal(count(/^no usable result for "Not Out Yet"/), 1);
  assert.equal(count(/^searching for "Not Out Yet"/), 1);
  assert.equal(count(/^still no usable release for 1 item\(s\): "Not Out Yet"$/), 3);
  assert.equal(db.prepare('SELECT status FROM movies WHERE id = 5').get().status, 'pending', 'still looking, not failed');
});
