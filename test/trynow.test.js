'use strict';

// Try now: an episode out today, but still "upcoming" by the dates (days,
// not times — counted as aired from just before midnight UTC), searched for
// at once from its page.

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');

freshDb();
const { db, settings, episodes } = require('../server/db');
settings.set('shows_path', '/tmp/amagnet-trynow');

// Stand-ins, before the scheduler loads them: one indexer answer, and a
// Transmission that takes anything.
const pipeline = require('../server/pipeline');
let searches = 0;
let offer = [];
pipeline.findCandidates = async () => { searches++; await new Promise(r => setTimeout(r, 50)); return { accepted: offer, rejected: [] }; };
const tx = require('../server/transmission');
const added = [];
tx.addTorrent = async (magnet) => { added.push(magnet); return { id: 7, hashString: 'ab'.repeat(20), name: 'x' }; };
const quarantine = require('../server/quarantine');
quarantine.afterAdd = () => ({});
quarantine.verdictHandler = () => () => {};
const scheduler = require('../server/scheduler');

const today = new Date().toISOString().slice(0, 10);
db.prepare("INSERT INTO shows (id, tmdb_id, title) VALUES (1, 10, 'Same Day')").run();
db.prepare("INSERT INTO episodes (id, show_id, season, episode, status, air_date) VALUES (1, 1, 1, 4, 'upcoming', ?), (2, 1, 1, 3, 'done', '2026-01-01')").run(today);

test('nothing out yet: says so, and the episode stays as it was', async () => {
  const r = await scheduler.searchNow(1);
  assert.equal(r.found, false);
  assert.match(r.message, /Nothing out yet for S01E04/);
  assert.equal(episodes.byId(1).status, 'upcoming');
  assert.equal(added.length, 0);
});

test('out already: grabbed at once, air date or not', async () => {
  offer = [{ title: 'Same.Day.S01E04.1080p.WEB.h264-GRP', magnet: `magnet:?xt=urn:btih:${'cd'.repeat(20)}`, seeders: 40, _quality: '1080p' }];
  const r = await scheduler.searchNow(1);
  assert.equal(r.found, true);
  assert.equal(r.release, 'Same.Day.S01E04.1080p.WEB.h264-GRP');
  const ep = episodes.byId(1);
  assert.equal(ep.status, 'downloading');
  assert.equal(ep.torrent_hash, 'ab'.repeat(20));
  assert.equal(added.length, 1);
});

test('found already, or being searched for: never grabbed twice', async () => {
  await assert.rejects(scheduler.searchNow(1), /isn't waiting for a release \(it is downloading\)/);
  await assert.rejects(scheduler.searchNow(2), /it is done/);
  db.prepare("INSERT INTO episodes (id, show_id, season, episode, status) VALUES (3, 1, 1, 5, 'pending')").run();
  offer = [{ title: 'Same.Day.S01E05.1080p.WEB.h264-GRP', magnet: `magnet:?xt=urn:btih:${'ef'.repeat(20)}`, seeders: 40, _quality: '1080p' }];
  const [a, b] = await Promise.all([scheduler.searchNow(3), scheduler.searchNow(3)]);
  assert.equal([a, b].filter(r => r.found).length, 1, 'one grab');
  assert.match([a, b].find(r => !r.found).message, /being searched for right now/);
  assert.equal(added.filter(m => m.includes('ef'.repeat(20))).length, 1);
});
