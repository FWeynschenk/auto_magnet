'use strict';

// Web versions pause rather than fill the disk, and carry on once there is room.

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');

freshDb();
const { settings } = require('../server/db');
const media = require('../server/media');

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() > end) return v;
    await new Promise(r => setTimeout(r, 20));
  }
};

test('free space is read from the disk holding the web versions', () => {
  const free = media.freeBytes();
  assert.ok(free > 0, `got ${free}`);
  const later = media.freeBytes(require('path').join(media.WEB_ROOT, 'not', 'made', 'yet'));
  assert.ok(Math.abs(later - free) < 1e9, 'its nearest existing parent');
});

test('below the minimum the queue pauses; with room again it carries on', async () => {
  settings.set('web_prepare', 'complete');
  settings.set('web_min_free_gb', String(1e9));   // more than any disk has
  assert.equal(media.spaceOk(), false);
  const s = media.spaceStatus();
  assert.equal(s.paused, true);
  assert.ok(s.min > s.free);

  // A job whose source is gone fails at once — if it is started at all.
  media.rows.upsert('movie', 77, { path: '/gone/film.mkv', size: 1, plan: 'remux', plan_reason: 'MKV container',
    probe: JSON.stringify({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }], format: {} }) });
  media.enqueue('movie', 77);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(media.rows.get('movie', 77).web_state, 'queued', 'not started while paused');

  settings.set('web_min_free_gb', '0');   // off
  assert.equal(media.spaceOk(), true);
  assert.equal(media.spaceStatus().paused, false);
  media.enqueue('movie', 77);
  assert.equal(await until(() => media.rows.get('movie', 77).web_state === 'failed'), true, 'started once there is room');
});

test('junk in the setting falls back to 20 GB', () => {
  settings.set('web_min_free_gb', 'lots');
  assert.equal(media.spaceStatus().min, 20e9);
  settings.set('web_min_free_gb', '0');
});
