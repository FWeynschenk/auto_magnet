'use strict';

// HEVC web versions, through the real ffmpeg: a copy for HEVC sources, x265
// for the rest. Both must come out as hvc1, the form browsers play.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshDb, tmpdir, ffmpeg, hasFfmpeg } = require('./helpers');

freshDb();
const { settings } = require('../server/db');
const media = require('../server/media');

const until = async (fn, ms = 120_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v || Date.now() > end) return v;
    await new Promise(r => setTimeout(r, 200));
  }
};

const hasX265 = hasFfmpeg && (() => {
  try { return require('child_process').execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString().includes('libx265'); }
  catch (_) { return false; }
})();

/** The four-character code of the video sample entry in an init segment. */
function sampleEntry(file) {
  const buf = fs.readFileSync(file);
  for (const tag of ['hvc1', 'hev1', 'avc1']) if (buf.includes(Buffer.from(tag))) return tag;
  return null;
}

test('a 10-bit HEVC MKV is copied as hvc1, and an MPEG-4 file is converted to HEVC', { skip: !hasX265 && 'ffmpeg with libx265 not installed' }, async () => {
  settings.set('web_codec', 'hevc');
  settings.set('web_encoder', 'x264');   // the CPU: no GPU here
  settings.set('web_min_free_gb', '0');
  settings.set('web_reserve_gb', '0');
  settings.set('web_prepare', 'complete');
  const dir = tmpdir();
  const hevc = path.join(dir, 'Show.S01E01.x265.10bit.mkv');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=4', '-f', 'lavfi', '-i', 'sine=d=4',
    '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error',
    '-c:a', 'ac3', hevc]);
  const old = path.join(dir, 'Old.Film.avi.mkv');
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=4', '-f', 'lavfi', '-i', 'sine=d=4',
    '-c:v', 'mpeg4', '-c:a', 'aac', old]);

  await media.record('episode', 1, hevc);
  await media.record('movie', 1, old);
  assert.equal(media.rows.get('episode', 1).plan, 'remux', 'HEVC: a copy');
  assert.equal(media.rows.get('movie', 1).plan, 'transcode');
  media.enqueue('episode', 1);
  media.enqueue('movie', 1);

  for (const [kind, codec] of [['episode', 'hevc10'], ['movie', 'hevc']]) {
    const r = await until(() => ['ready', 'failed'].includes(media.rows.get(kind, 1).web_state) && media.rows.get(kind, 1));
    assert.equal(r.web_state, 'ready', r.web_error || '');
    assert.equal(r.web_codec, codec);
    const vdir = path.join(media.webDir(kind, 1), 'v');
    const init = fs.readdirSync(vdir).find(n => /^init(_\d+)?\.mp4$/.test(n));
    assert.equal(sampleEntry(path.join(vdir, init)), 'hvc1');
  }
  settings.set('web_codec', 'h264');
});
