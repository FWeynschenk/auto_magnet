'use strict';

// Downloads pause before the download disk fills, and carry on with room.

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');

freshDb();
const { settings } = require('../server/db');
const tx = require('../server/transmission');
const guard = require('../server/diskguard');

const GB = 1e9;

function fakeClient(freeGb) {
  const c = {
    free: freeGb * GB, active: [11, 12], stopped: [], started: [], asked: [],
    freeSpace: async (dir) => { c.asked.push(dir); return c.free; },
    activeDownloads: async () => c.active,
    stopTorrents: async (ids) => { c.stopped.push(...ids); },
    startTorrents: async (ids) => { c.started.push(...ids); },
  };
  return c;
}

test('below the reserve: running downloads pause and grabbing waits; with room again they resume', async () => {
  settings.set('movie_path', '/HDD0/Shared/Movies');
  settings.set('shows_path', '/HDD0/Shared/Series');
  settings.set('download_min_free_gb', '30');
  const target = tx.listTargets()[0];
  const c = fakeClient(100);

  await guard.checkTarget(target, { client: c });
  assert.deepEqual(c.asked, ['/HDD0/Shared/Movies', '/HDD0/Shared/Series'], 'both download folders measured');
  assert.equal(guard.isLow(''), false);

  c.free = 12 * GB;
  await guard.checkTarget(target, { client: c });
  assert.equal(guard.isLow(''), true);
  assert.equal(guard.isLow('no-such-instance'), true, 'an unknown instance name means the default one');
  assert.deepEqual(c.stopped, [11, 12]);
  assert.deepEqual(JSON.parse(settings.get('diskguard_paused')), { default: [11, 12] }, 'remembered across restarts');

  // Still low: nothing paused twice. Just above the reserve: not yet (margin).
  c.free = 33 * GB;
  await guard.checkTarget(target, { client: c });
  assert.equal(guard.isLow(''), true);
  assert.deepEqual(c.stopped, [11, 12]);

  c.free = 40 * GB;
  await guard.checkTarget(target, { client: c });
  assert.equal(guard.isLow(''), false);
  assert.deepEqual(c.started, [11, 12], 'exactly the ones it paused');
  assert.equal(settings.get('diskguard_paused'), '{}');
});

test('0 turns it off; an unreachable Transmission keeps the last state', async () => {
  const target = tx.listTargets()[0];
  settings.set('download_min_free_gb', '0');
  const c = fakeClient(1);
  await guard.checkTarget(target, { client: c });
  assert.equal(guard.isLow(''), false);
  assert.deepEqual(c.stopped, []);

  settings.set('download_min_free_gb', '30');
  await guard.checkTarget(target, { client: c });
  assert.equal(guard.isLow(''), true);
  const broken = { ...c, freeSpace: async () => { throw new Error('ECONNREFUSED'); } };
  const s = await guard.checkTarget(target, { client: broken });
  assert.equal(s.low, true);
  assert.equal(s.error, 'ECONNREFUSED');
  assert.equal(guard.status()[0].name, 'default');
});
