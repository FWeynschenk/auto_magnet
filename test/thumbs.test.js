'use strict';

// Seek thumbnails: sprite sheets from keyframes, indexed for the player.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshDb, tmpdir, ffmpeg, hasFfmpeg } = require('./helpers');

freshDb();
const media = require('../server/media');
const thumbs = require('../server/thumbs');

test('a 25-minute video gets two sheets: one full, one partly', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tmpdir();
  const file = path.join(dir, 'long.mp4');
  // 1,500 s at 2 fps, a keyframe every 5 s: small and quick to make.
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=2:duration=1500', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-g', '10', '-pix_fmt', 'yuv420p', file]);
  const probe = JSON.stringify({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 320, height: 180 }], format: { duration: '1500' } });
  media.rows.upsert('movie', 1, { path: file, size: fs.statSync(file).size, duration: 1500, plan: 'direct', plan_reason: 'plays as it is', probe });

  await thumbs._make('movie', 1);
  const ix = thumbs.index('movie', 1);
  assert.equal(ix.sheets, 2);
  assert.equal(ix.count, 150, 'one per 10 s');
  assert.deepEqual([ix.w, ix.h, ix.cols, ix.rows, ix.interval], [160, 90, 10, 10, 10]);
  assert.ok(fs.statSync(thumbs.sheetFile('movie', 1, 2)).size > 1000, 'the partial last sheet is there too');

  thumbs.remove('movie', 1);
  assert.equal(thumbs.index('movie', 1), null);
});
