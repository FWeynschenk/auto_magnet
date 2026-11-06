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
  settings.set('web_reserve_gb', '0');
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

// ─── Room kept for on-demand work ─────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpdir } = require('./helpers');

const probe = JSON.stringify({ streams: [{ index: 0, codec_type: 'video', codec_name: 'hevc', height: 1080 }], format: {} });

/** A media row whose "source" is a FIFO: ffmpeg opens it and waits, so the job runs until killed. */
function hangingJob(id, plan = 'transcode') {
  const dir = tmpdir();
  const fifo = path.join(dir, `src-${id}.mkv`);
  execFileSync('mkfifo', [fifo]);
  media.rows.upsert('movie', id, { path: fifo, size: 1e9, duration: 3600, plan, plan_reason: 'HEVC video', probe });
  return fifo;
}

test('background work stops short of the reserve; what someone asks for may use it', async () => {
  settings.set('web_encoder', 'x264');
  settings.set('web_min_free_gb', '0');
  settings.set('web_reserve_gb', String(1e9));   // more than any disk has
  media.rows.upsert('movie', 80, { path: '/gone/bg.mkv', size: 1, plan: 'remux', plan_reason: 'MKV container', probe });
  media.enqueue('movie', 80);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(media.rows.get('movie', 80).web_state, 'queued', 'background job waits');
  const s = media.spaceStatus();
  assert.equal(s.backgroundPaused, true);
  assert.equal(s.paused, false, 'on-demand work is not paused');
  const w = media.waitingFor(media.rows.get('movie', 80));
  assert.equal(w.reason, 'space');
  assert.ok(w.need > w.free);

  // The same item, opened by someone: it may use the reserve, so it starts.
  media.enqueue('movie', 80, { priority: media.DEMAND_PRIORITY });
  assert.equal(await until(() => media.rows.get('movie', 80).web_state === 'failed'), true, 'started on demand');
  settings.set('web_reserve_gb', '0');
});

test('when nothing fits, the player is told it is the disk, with the numbers', () => {
  settings.set('web_min_free_gb', String(1e9));
  media.rows.upsert('movie', 81, { path: '/gone/x.mkv', size: 1, plan: 'remux', plan_reason: 'MKV container', probe,
    web_state: 'queued', web_priority: media.DEMAND_PRIORITY });
  const w = media.waitingFor(media.rows.get('movie', 81));
  assert.equal(w.reason, 'space');
  assert.equal(w.min, 1e9 * 1e9);
  assert.equal(media.spaceStatus().paused, true);
  settings.set('web_min_free_gb', '0');
  media.spaceOk('demand');
});

test('opening an item starts it at once, pausing background work in its lane', async () => {
  settings.set('web_min_free_gb', '0');
  settings.set('web_reserve_gb', '0');
  hangingJob(90);
  media.enqueue('movie', 90);   // background
  assert.equal(await until(() => media.rows.get('movie', 90).web_state === 'encoding'), true, 'background job running');

  // Something someone is waiting for, in the same lane.
  hangingJob(91);
  media.enqueue('movie', 91, { priority: media.DEMAND_PRIORITY });
  assert.equal(media.rows.get('movie', 91).web_state, 'encoding', 'started immediately, not queued');
  assert.equal(media.rows.get('movie', 90).web_state, 'queued', 'background job put back in the queue');

  // A second request doesn't wait for the first either.
  hangingJob(92);
  media.enqueue('movie', 92, { priority: media.DEMAND_PRIORITY });
  assert.equal(media.rows.get('movie', 92).web_state, 'encoding', 'runs alongside the first request');

  // Requests done: the background job carries on by itself.
  media.removeWebVersion('movie', 91);
  media.rows.update('movie', 91, { web_state: 'none' });
  media.removeWebVersion('movie', 92);
  media.rows.update('movie', 92, { web_state: 'none' });
  assert.equal(await until(() => media.rows.get('movie', 90).web_state === 'encoding'), true, 'background job restarted');
  media.removeWebVersion('movie', 90);
  media.rows.update('movie', 90, { web_state: 'none' });
});

test('an item opened while it is already converting in the background is promoted, not restarted', async () => {
  hangingJob(93);
  media.enqueue('movie', 93);
  assert.equal(await until(() => media.rows.get('movie', 93).web_state === 'encoding'), true);
  media.enqueue('movie', 93, { priority: media.DEMAND_PRIORITY });
  const r = media.rows.get('movie', 93);
  assert.equal(r.web_state, 'encoding');
  assert.equal(r.web_priority, media.DEMAND_PRIORITY);
  media.removeWebVersion('movie', 93);
  media.rows.update('movie', 93, { web_state: 'none' });
});
