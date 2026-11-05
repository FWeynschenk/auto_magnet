'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');

freshDb();
const media = require('../server/media');
const progress = require('../server/progress');
const { db } = require('../server/db');

const v = (o = {}) => ({ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', height: 1080, ...o });
const a = (o = {}) => ({ index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, ...o });
const mp4 = { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' };
const mkv = { format_name: 'matroska,webm' };

// ─── Plan ────────────────────────────────────────────────────────────────────

test('MP4 with H.264 and AAC plays directly', () => {
  assert.equal(media.planFor({ streams: [v(), a()], format: mp4 }).plan, 'direct');
});

test('MKV, or audio a browser can\'t decode, is remuxed — video untouched', () => {
  assert.deepEqual(media.planFor({ streams: [v(), a()], format: mkv }), { plan: 'remux', reason: 'MKV container' });
  assert.equal(media.planFor({ streams: [v(), a({ codec_name: 'dts' })], format: mp4 }).reason, 'DTS audio');
  assert.equal(media.planFor({ streams: [v(), a({ codec_name: 'eac3' })], format: mkv }).plan, 'remux');
});

test('a preferred audio track that isn\'t first needs a remux, even in MP4', () => {
  const streams = [v(), a({ index: 1, tags: { language: 'ger' }, disposition: { default: 1 } }), a({ index: 2, tags: { language: 'eng' } })];
  const r = media.planFor({ streams, format: mp4 }, ['en']);
  assert.equal(r.plan, 'remux');
  assert.match(r.reason, /first track/);
});

test('HEVC, 10-bit and HDR are transcoded', () => {
  assert.match(media.planFor({ streams: [v({ codec_name: 'hevc' }), a()], format: mkv }).reason, /HEVC/);
  assert.equal(media.planFor({ streams: [v({ pix_fmt: 'yuv420p10le' }), a()], format: mp4 }).reason, '10-bit video');
  assert.match(media.planFor({ streams: [v({ color_transfer: 'smpte2084' }), a()], format: mp4 }).reason, /HDR/);
});

test('a file without video is unplayable; cover art is not video', () => {
  assert.equal(media.planFor({ streams: [a()], format: mp4 }).plan, 'unplayable');
  assert.equal(media.planFor({ streams: [v({ disposition: { attached_pic: 1 } }), a()], format: mp4 }).plan, 'unplayable');
});

test('audio choice skips commentary and audio description and prefers the wanted language', () => {
  const streams = [
    a({ index: 1, tags: { language: 'eng', title: 'Director\'s Commentary' } }),
    a({ index: 2, tags: { language: 'eng' }, disposition: { visual_impaired: 1 } }),
    a({ index: 3, tags: { language: 'fre' }, disposition: { default: 1 } }),
    a({ index: 4, tags: { language: 'eng' } }),
  ];
  assert.equal(media.chooseAudio(streams, ['en']).index, 4);
  assert.equal(media.chooseAudio(streams, ['nl']).index, 3, 'no Dutch: falls back to the default track');
});

// ─── Encode arguments ────────────────────────────────────────────────────────

const args = (o) => media.buildEncodeArgs({ input: '/in.mkv', outDir: '/out', maxHeight: 1080, wanted: ['en'], ...o });

test('remux copies the video and converts only the audio', () => {
  const x = args({ plan: 'remux', encoder: 'copy', info: { streams: [v(), a({ codec_name: 'ac3', channels: 6 })] } });
  assert.deepEqual(x.slice(x.indexOf('-c:v'), x.indexOf('-c:v') + 2), ['-c:v', 'copy']);
  assert.ok(x.includes('aac') && x.includes('-ac'));
  assert.ok(!x.includes('-vf'));
  assert.equal(x.at(-1), '/out/index.m3u8');
  assert.ok(x.includes('event') && x.includes('fmp4'), 'growing fMP4 HLS playlist');
});

test('stereo AAC is copied rather than re-encoded', () => {
  const x = args({ plan: 'remux', encoder: 'copy', info: { streams: [v(), a()] } });
  assert.deepEqual(x.slice(x.indexOf('-c:a'), x.indexOf('-c:a') + 2), ['-c:a', 'copy']);
});

test('4K HEVC is scaled down and encoded on the GPU', () => {
  const x = args({ plan: 'transcode', encoder: 'vaapi', info: { streams: [v({ codec_name: 'hevc', height: 2160 }), a()] } });
  assert.ok(x.includes('h264_vaapi'));
  assert.ok(x.indexOf('-init_hw_device') < x.indexOf('-i'), 'device set up before the input');
  assert.match(x[x.indexOf('-vf') + 1], /^scale=-2:1080,format=nv12,hwupload$/);
});

test('HDR is tone-mapped; CPU path uses libx264 with forced keyframes per segment', () => {
  const x = args({ plan: 'transcode', encoder: 'x264', info: { streams: [v({ codec_name: 'hevc', color_transfer: 'smpte2084' }), a()] } });
  assert.ok(x.includes('libx264'));
  assert.match(x[x.indexOf('-vf') + 1], /tonemap=tonemap=hable/);
  assert.match(x[x.indexOf('-force_key_frames') + 1], /n_forced\*6/);
});

test('subtitle-only and silent files map only what exists', () => {
  const x = args({ plan: 'transcode', encoder: 'x264', info: { streams: [v({ codec_name: 'mpeg4' })] } });
  assert.ok(x.includes('-an'));
  assert.equal(x.filter(s => s === '-map').length, 1);
});

test('language from subtitle filenames', () => {
  assert.equal(media.langFromName('Show.S01E02.en.srt'), 'en');
  assert.equal(media.langFromName('2_English.srt'), 'en');
  assert.equal(media.langFromName('Film.2020.NL.forced.srt'), 'nl');
  assert.equal(media.langFromName('Film.2020.srt'), null);
});

// ─── Progress ────────────────────────────────────────────────────────────────

db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'u', 'x', 'viewer'), (2, 'v', 'x', 'viewer')").run();
db.prepare("INSERT INTO shows (id, tmdb_id, title) VALUES (1, 1, 'S')").run();
db.prepare(`INSERT INTO episodes (id, show_id, season, episode, status) VALUES
  (1, 1, 1, 1, 'done'), (2, 1, 1, 2, 'done'), (3, 1, 1, 3, 'pending'), (4, 1, 2, 1, 'done')`).run();

test('a position is kept; a few seconds in is not a resume point', () => {
  assert.equal(progress.report(1, 'episode', 1, { position: 10, duration: 3000 }).position, 0);
  const r = progress.report(1, 'episode', 1, { position: 600, duration: 3000 });
  assert.equal(r.position, 600);
  assert.equal(r.watched, 0);
});

test('a report older than the stored one never overwrites it', () => {
  const r = progress.report(1, 'episode', 1, { position: 100, duration: 3000, at: Date.now() - 3600_000 });
  assert.equal(r.position, 600);
});

test('near the end counts as watched and resets the resume point', () => {
  const r = progress.report(1, 'episode', 1, { position: 2950, duration: 3000 });
  assert.equal(r.watched, 1);
  assert.equal(r.position, 0);
});

test('a clock set in the future can\'t freeze the row', () => {
  progress.report(2, 'episode', 2, { position: 500, duration: 3000, at: Date.now() + 365 * 86400_000 });
  assert.equal(progress.report(2, 'episode', 2, { position: 900, duration: 3000, at: Date.now() + 120_000 }).position, 900);
});

test('next up is the next downloaded episode after the last one finished', () => {
  progress.report(1, 'episode', 1, { position: 2990, duration: 3000 });
  assert.deepEqual(progress.nextUp(1).map(e => e.id), [2]);
  progress.setWatched(1, 'episode', 2, true);
  assert.deepEqual(progress.nextUp(1).map(e => e.id), [4], 'skips the episode that is not downloaded');
  assert.deepEqual(progress.nextUp(2).map(e => e.id), [], 'per user');
});

test('half-watched items are in "continue watching", finished ones are not', () => {
  progress.report(2, 'episode', 4, { position: 700, duration: 3000 });
  assert.deepEqual(progress.inProgress(2).map(r => r.item_id).sort(), [2, 4]);
  assert.deepEqual(progress.inProgress(1).map(r => r.item_id), []);
});
