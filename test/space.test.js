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

const pipes = [];
test.after(() => { for (const p of pipes) p.close(); });

/**
 * A media row whose "source" is a FIFO: ffmpeg opens it and waits, so the job
 * runs until killed. On Windows a real named pipe — Git Bash's `mkfifo` makes
 * an imitation that a native ffmpeg reads as an empty file and gives up on.
 */
function hangingJob(id, plan = 'transcode') {
  let fifo;
  if (process.platform === 'win32') {
    const B = '\\';
    fifo = `${B}${B}.${B}pipe${B}amagnet-test-${process.pid}-${id}`;
    pipes.push(require('net').createServer(() => {}).listen(fifo));
  } else {
    fifo = path.join(tmpdir(), `src-${id}.mkv`);
    execFileSync('mkfifo', [fifo]);
  }
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

// ─── Size estimates: no start, fill, stop, start again ────────────────────────

test('estimates: a repackage is about the original; a conversion is bitrate × length', () => {
  settings.set('web_max_height', '1080');
  const remux = { plan: 'remux', size: 30e9, duration: 7200, probe };
  assert.equal(media.estimateBytes(remux), 30e9);
  const conv = { plan: 'transcode', size: 60e9, duration: 3600, probe: JSON.stringify({
    streams: [{ index: 0, codec_type: 'video', codec_name: 'hevc', height: 2160 }, { index: 1, codec_type: 'audio', codec_name: 'eac3' }], format: {} }) };
  const est = media.estimateBytes(conv);
  assert.ok(est > 3e9 && est < 5e9, `4K scaled to 1080p for an hour ≈ 3.7 GB, got ${(est / 1e9).toFixed(1)}`);
  assert.equal(media.estimateBytes({ ...remux, web_estimate: 45e9 }), 45e9, 'a learned size wins');
});

test('a job too big for the space left does not start; the player gets its size', () => {
  settings.set('web_min_free_gb', '0');
  settings.set('web_reserve_gb', '0');
  const free = media.freeBytes();
  media.rows.upsert('movie', 100, { path: '/gone/huge.mkv', size: free * 2, plan: 'remux', plan_reason: 'MKV container', probe,
    web_state: 'none', web_priority: 0, web_estimate: null });
  media.enqueue('movie', 100, { priority: media.DEMAND_PRIORITY });
  const r = media.rows.get('movie', 100);
  assert.equal(r.web_state, 'queued', 'not started: it would fill the disk');
  const w = media.waitingFor(r);
  assert.equal(w.reason, 'space');
  assert.equal(w.estimate, free * 2);
  assert.ok(w.need >= free * 2);
  media.rows.update('movie', 100, { web_state: 'none', web_priority: 0 });
});

test('a big job waiting for room does not hold up a small one behind it', async () => {
  settings.set('web_min_free_gb', '0');
  settings.set('web_reserve_gb', '0');
  const free = media.freeBytes();
  media.rows.upsert('movie', 101, { path: '/gone/big.mkv', size: free * 2, plan: 'remux', plan_reason: 'MKV container', probe,
    web_state: 'none', web_priority: 0 });
  media.rows.upsert('movie', 102, { path: '/gone/small.mkv', size: 1e6, plan: 'remux', plan_reason: 'MKV container', probe,
    web_state: 'none', web_priority: 0 });
  media.enqueue('movie', 101);
  media.enqueue('movie', 102);
  assert.equal(await until(() => media.rows.get('movie', 102).web_state === 'failed'), true, 'small one ran (and failed: no source)');
  assert.equal(media.rows.get('movie', 101).web_state, 'queued', 'big one still waits');
  media.rows.update('movie', 101, { web_state: 'none' });
});

test('after running out of room, the size it really needs is learned', () => {
  const row = { plan: 'remux', size: 10e9, web_progress: 0.25 };
  assert.equal(media.learnEstimate(row, 5e9), Math.round(5e9 / 0.25 * 1.1), 'scaled up from how far it got');
  assert.equal(media.learnEstimate({ ...row, web_progress: 0 }, 1e9), Math.round(Math.max(15e9, 4e9)), 'no progress yet: a generous guess');
  assert.equal(media.learnEstimate({ ...row, web_progress: 0.9 }, 1e9), 10e9, 'never below the estimate it had');
});

// ─── Requests expire ──────────────────────────────────────────────────────────

test('a request nobody is waiting for any more becomes background work', () => {
  settings.set('web_min_free_gb', String(1e9));   // keep it queued
  media.rows.upsert('movie', 110, { path: '/gone/a.mkv', size: 1, plan: 'remux', plan_reason: 'MKV container', probe,
    web_state: 'none', web_priority: 0 });
  media.enqueue('movie', 110, { priority: media.DEMAND_PRIORITY });
  media.expireRequests();
  assert.equal(media.rows.get('movie', 110).web_priority, media.DEMAND_PRIORITY, 'still wanted just now');
  media.expireRequests(Date.now() + media.DEMAND_TTL_MS + 1000);
  assert.equal(media.rows.get('movie', 110).web_priority, 0, 'dropped after the timeout');

  media.enqueue('movie', 110, { priority: media.SOON_PRIORITY });
  media.expireRequests(Date.now() + media.DEMAND_TTL_MS + 1000);
  assert.equal(media.rows.get('movie', 110).web_priority, media.SOON_PRIORITY, '"soon" lasts longer');
  media.expireRequests(Date.now() + media.SOON_TTL_MS + 1000);
  assert.equal(media.rows.get('movie', 110).web_priority, 0);
  media.rows.update('movie', 110, { web_state: 'none' });
  settings.set('web_min_free_gb', '0');
});

test('a running request nobody watches keeps going, but as background work', async () => {
  settings.set('web_min_free_gb', '0');
  settings.set('web_reserve_gb', '0');
  hangingJob(111);
  media.enqueue('movie', 111, { priority: media.DEMAND_PRIORITY });
  assert.equal(media.rows.get('movie', 111).web_state, 'encoding');
  media.expireRequests(Date.now() + media.DEMAND_TTL_MS + 1000);
  assert.equal(media.rows.get('movie', 111).web_priority, 0);
  // So a real request in its lane now pauses it.
  hangingJob(112);
  media.enqueue('movie', 112, { priority: media.DEMAND_PRIORITY });
  assert.equal(media.rows.get('movie', 111).web_state, 'queued', 'paused for the new request');
  assert.equal(media.rows.get('movie', 112).web_state, 'encoding');
  for (const id of [111, 112]) { media.removeWebVersion('movie', id); media.rows.update('movie', id, { web_state: 'none' }); }
});

test('a job being stopped is never put back in the queue by a request arriving meanwhile', async () => {
  settings.set('web_min_free_gb', '0');
  settings.set('web_reserve_gb', '0');
  hangingJob(120);
  media.enqueue('movie', 120);
  assert.equal(await until(() => media.rows.get('movie', 120).web_state === 'encoding'), true);
  await new Promise(r => setTimeout(r, 100));   // its ffmpeg is running
  // Deleted, and — before its process has exited — someone presses play on
  // something else in the same lane.
  media.removeWebVersion('movie', 120);
  media.rows.update('movie', 120, { web_state: 'none' });
  hangingJob(121);
  media.enqueue('movie', 121, { priority: media.DEMAND_PRIORITY });
  assert.equal(media.rows.get('movie', 120).web_state, 'none', 'stays deleted');
  await new Promise(r => setTimeout(r, 300));
  assert.equal(media.rows.get('movie', 120).web_state, 'none', 'not started again once its process exits');
  media.removeWebVersion('movie', 121);
  media.rows.update('movie', 121, { web_state: 'none' });
});
