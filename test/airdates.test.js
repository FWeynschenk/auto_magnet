'use strict';

// Which episodes count as aired, and so get searched for. TMDB often lists a
// new season's episodes before it dates them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');

freshDb();
const { db, shows, episodes } = require('../server/db');
const { effectivelyAired, syncEpisodes, waitingOn, searchablePending } = require('../server/scheduler');

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

test('a future episode holds back everything after it, later seasons too', async () => {
  db.prepare("INSERT INTO shows (id, tmdb_id, title, quality, active, start_season, start_episode) VALUES (51, 9051, 'Andor', 'any', 1, 2, 1)").run();
  const show = shows.byId(51);
  const seasons = {
    2: { season_number: 2, season_air_date: null, episode_count: 3,
      episodes: [ep(1, day(20)), ep(2, day(-400)), ep(3)] },         // E02's past date is a TMDB slip
    3: { season_number: 3, season_air_date: null, episode_count: 2, episodes: [ep(1), ep(2)] },
  };
  await syncEpisodes(show, async (s) => seasons[s] || null);
  const rows = db.prepare('SELECT season, episode, status FROM episodes WHERE show_id = 51 ORDER BY season, episode').all();
  assert.deepEqual(rows.map(r => `${r.season}x${r.episode} ${r.status}`),
    ['2x1 upcoming', '2x2 upcoming', '2x3 upcoming', '3x1 upcoming', '3x2 upcoming']);
});

test('with no dates, only the first unfound episode is searched', async () => {
  db.prepare("INSERT INTO shows (id, tmdb_id, title, quality, active, start_season, start_episode) VALUES (52, 9052, 'Undated', 'any', 1, 1, 1)").run();
  const show = shows.byId(52);
  const seasons = {
    1: { season_number: 1, season_air_date: null, episode_count: 2, episodes: [ep(1, '2020-01-01'), ep(2, '2020-01-08')] },
    2: { season_number: 2, season_air_date: null, episode_count: 3, episodes: [ep(1), ep(2), ep(3)] },
  };
  await syncEpisodes(show, async (s) => seasons[s] || null);
  const label = (e) => `${e.season}x${e.episode}`;
  // S01 is dated and aired: both searched. S02 has no dates: only E01, since S01E02 isn't found yet.
  assert.deepEqual(searchablePending(show).map(label), ['1x1', '1x2']);

  const row = (s, e) => db.prepare('SELECT * FROM episodes WHERE show_id = 52 AND season = ? AND episode = ?').get(s, e);
  assert.equal(waitingOn(show, row(2, 1)).episode, 2, 'S02E01 waits on S01E02');
  episodes.update(row(1, 2).id, { status: 'done' });
  assert.deepEqual(searchablePending(show).map(label), ['1x1', '2x1']);
  episodes.update(row(2, 1).id, { status: 'downloading' });
  assert.deepEqual(searchablePending(show).map(label), ['1x1', '2x2'], 'found S02E01: now S02E02, not E03');
});
