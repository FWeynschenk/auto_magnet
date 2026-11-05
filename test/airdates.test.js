'use strict';

// Which episodes count as aired, and so get searched for. TMDB often lists a
// new season's episodes before it dates them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');

freshDb();
const { db, shows, episodes } = require('../server/db');
const { effectivelyAired, syncEpisodes } = require('../server/scheduler');

const DAY = 24 * 3600 * 1000;
const day = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const ep = (n, air_date = null) => ({ episode_number: n, air_date });

test('undated episodes after a future premiere are not aired', () => {
  const s4 = [ep(1, day(240)), ep(2), ep(3), ep(4), ep(5), ep(6)];
  for (let n = 1; n <= 6; n++) assert.equal(effectivelyAired(n, s4), false, `E0${n}`);
});

test('undated episodes follow the last dated one weekly', () => {
  const airing = [ep(1, day(-8)), ep(2, day(-1)), ep(3), ep(4), ep(5)];
  assert.equal(effectivelyAired(2, airing), true);
  assert.equal(effectivelyAired(3, airing), false, 'next week');
  assert.equal(effectivelyAired(5, airing), false);
});

test('a gap in an old season still counts as aired', () => {
  const old = [ep(1, '2015-03-01'), ep(2, '2015-03-08'), ep(3), ep(4, '2015-03-22'), ep(5)];
  assert.equal(effectivelyAired(3, old), true, 'a later episode aired');
  assert.equal(effectivelyAired(5, old), true, 'a week after E04, years ago');
});

test('the season premiere date stands in when no episode is dated', () => {
  const eps = [ep(1), ep(2), ep(3)];
  assert.equal(effectivelyAired(1, eps, day(30)), false);
  assert.equal(effectivelyAired(3, eps, '2019-01-01'), true);
  assert.equal(effectivelyAired(3, eps, null), true, 'nothing dated at all: available, as before');
});

test('sync moves undated episodes of an unaired season from pending to upcoming', async () => {
  db.prepare("INSERT INTO shows (id, tmdb_id, title, quality, active, start_season, start_episode) VALUES (50, 9050, 'Silo', 'any', 1, 4, 1)").run();
  const show = shows.byId(50);
  for (let n = 2; n <= 6; n++) episodes.insert({ show_id: 50, season: 4, episode: n, status: 'pending' });
  const season = { season_number: 4, season_air_date: day(240), episode_count: 6,
    episodes: [ep(1, day(240)), ep(2), ep(3), ep(4), ep(5), ep(6)] };
  await syncEpisodes(show, async (s) => (s === 4 ? season : null));
  const rows = db.prepare('SELECT episode, status FROM episodes WHERE show_id = 50 ORDER BY episode').all();
  assert.deepEqual(rows.map(r => r.status), Array(6).fill('upcoming'));
});
