'use strict';

// Show names: strict first; after a few empty runs, names turned down are
// looked up on TMDB and learned when no other show has them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');

freshDb();
delete process.env.AMAGNET_NO_SCHEDULER;
const { db, settings, shows, episodes } = require('../server/db');
settings.set('min_seeds', '1');
settings.set('transmission_host', '127.0.0.1');
settings.set('transmission_port', '9');

const selector = require('../server/selector');
const mag = (c) => `magnet:?xt=urn:btih:${c.repeat(40)}`;
// What the indexers have: this show under a longer name ("Andor" on TMDB,
// "Star.Wars.Andor" in releases), and a different show that starts the same.
const RELEASES = [
  { title: 'Star.Wars.Andor.S02E03.1080p.WEB.h264-GRP', magnet: mag('a'), seeders: 80, size: 2e9 },
  { title: 'Andor.Rising.S02E03.1080p.WEB.h264-GRP', magnet: mag('b'), seeders: 90, size: 2e9 },
];
const pipeline = require('../server/pipeline');
pipeline.findCandidates = async (o) => {
  const want = { title: o.title, season: o.season, episode: o.episode, firstAirYear: o.firstAirYear,
    countries: o.countries, originalTitle: o.originalTitle, variants: o.variants };
  return selector.evaluate(RELEASES, { type: o.type, want, exclude: o.exclude, wrong: o.wrong, allowPacks: false });
};
const tmdb = require('../server/tmdb');
const looked = [];
tmdb.searchTv = async (q) => {
  looked.push(q);
  return q === 'andor rising' ? [{ tmdb_id: 777, name: 'Andor Rising', original_name: null, year: 2025 }]
    : q === 'star wars andor' ? [{ tmdb_id: 83867, name: 'Andor', original_name: 'Andor', year: 2022 }] : [];
};
tmdb.getTvDetails = async () => null;
tmdb.getSeasonDetails = async () => null;
const tx = require('../server/transmission');
const added = [];
tx.addTorrent = async (url) => { added.push(url); return { id: 50, duplicate: false, verified: true }; };
const scheduler = require('../server/scheduler');
const shownames = require('../server/shownames');

test('strict for a few runs, then a name no other show has is learned, and the grab is marked for checking', async () => {
  db.prepare(`INSERT INTO shows (id, tmdb_id, title, active, mode, first_air_year, origin_country)
    VALUES (1, 83867, 'Andor', 1, 'auto', 2022, 'US')`).run();
  db.prepare("INSERT INTO episodes (id, show_id, season, episode, status) VALUES (1, 1, 2, 3, 'pending')").run();

  for (let i = 1; i < shownames.RELAX_AFTER_RUNS; i++) {
    await scheduler.run();
    assert.equal(added.length, 0, `run ${i}: strict, nothing grabbed`);
    assert.equal(looked.length, 0, 'not looked up yet');
  }
  await scheduler.run();
  assert.deepEqual(added, [mag('a')], 'the Star Wars Andor release, once its name was learned');
  const v = shownames.parse(shows.byId(1));
  assert.equal(v['star wars andor'].verdict, 'variant', 'TMDB has no other show of that name (only this one)');
  assert.equal(v['andor rising'].verdict, 'other', 'Andor Rising is another show on TMDB');
  const ep = episodes.byId(1);
  assert.equal(ep.status, 'downloading');
  assert.match(ep.last_error, /name learned from TMDB \("star wars andor"\)/);
});

test('marked as the wrong video, a learned name is un-learned for good', async () => {
  const show = shows.byId(1);
  assert.equal(shownames.unlearn(show, 'Star.Wars.Andor.S02E03.1080p.WEB'), true);
  assert.equal(shownames.parse(shows.byId(1))['star wars andor'].verdict, 'other');
  assert.deepEqual(shownames.accepted(shows.byId(1)), []);
});

test('a release picked by hand teaches its way of writing the name', () => {
  const show = shows.byId(1);
  assert.equal(shownames.learnPicked(show, 'Andor.Rising.S02E04.1080p'), true);
  assert.deepEqual(shownames.accepted(shows.byId(1)), ['andor rising']);
  assert.equal(shownames.learnPicked(shows.byId(1), 'Andor.2022.S02E04.1080p'), false, 'its own name needs nothing learned');
});
