'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { tmpdir, hasFfmpeg, rng, writeWav } = require('./helpers');
const st = require('../server/subtitle-text');
const sync = require('../server/subsync');

test('parses SRT with BOM, CRLF, missing indexes and blank lines in text', () => {
  const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nOne\r\n\r\n00:00:03,000 --> 00:00:04,000\r\nTwo\r\nlines\r\n\r\n3\r\n00:01:05,25 --> 00:01:06,000\r\nThree\r\n';
  const cues = st.parse(srt);
  assert.equal(cues.length, 3);
  assert.deepEqual(cues.map(c => c.start), [1000, 3000, 65250]);
  assert.equal(cues[1].text, 'Two\nlines');
  assert.equal(cues[0].text, 'One', 'the next cue\'s index is not part of this cue\'s text');
});

test('parses VTT with header, cue settings and short timestamps', () => {
  const cues = st.parse('WEBVTT\n\nNOTE hi\n\n00:01.000 --> 00:02.000 align:start\nHi\n');
  assert.deepEqual(cues, [{ start: 1000, end: 2000, text: 'Hi' }]);
});

test('SRT → VTT → parse round trip', () => {
  const cues = [{ start: 1234, end: 5678, text: 'a' }, { start: 3600000, end: 3601000, text: 'b' }];
  assert.match(st.toVtt(cues), /^WEBVTT\n\n00:00:01\.234 --> 00:00:05\.678\na\n/);
  assert.deepEqual(st.parse(st.toVtt(cues)), cues);
  assert.deepEqual(st.parse(st.toSrt(cues)), cues);
});

test('transform shifts, stretches and drops cues pushed before zero', () => {
  const cues = [{ start: 500, end: 900, text: 'gone' }, { start: 2000, end: 3000, text: 'kept' }];
  assert.deepEqual(st.transform(cues, { offsetMs: -1000 }), [{ start: 1000, end: 2000, text: 'kept' }]);
  assert.deepEqual(st.transform([cues[1]], { ratio: 2, offsetMs: 100 }), [{ start: 4100, end: 6100, text: 'kept' }]);
});

test('decodes Windows-1252 subtitles that are not valid UTF-8', () => {
  assert.equal(st.decode(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'café');
  assert.equal(st.decode(Buffer.from('café', 'utf8')), 'café');
});

// ─── Sync against audio ──────────────────────────────────────────────────────

/** Voice-band tone bursts where the "true" cues are, noise elsewhere. */
function fixture(dir, { offset, ratio }) {
  const r = rng(11);
  const cues = [];
  for (let t = 5000; t < 290_000;) {
    const len = 800 + r() * 3000;
    cues.push({ start: t, end: t + len, text: `line ${cues.length}` });
    t += len + 300 + r() * 4000;
  }
  const sr = 8000;
  const on = new Uint8Array(300 * sr);
  for (const c of cues) on.fill(1, Math.floor(c.start / 1000 * sr), Math.min(on.length, Math.floor(c.end / 1000 * sr)));
  writeWav(path.join(dir, 'a.wav'), 300, sr, (i) => (r() - 0.5) * 0.05 + (on[i] ? 0.3 * Math.sin(i * 2 * Math.PI * 500 / sr) : 0));
  // The file on disk is wrong by the inverse of (ratio, offset).
  const wrong = cues.map(c => ({ ...c, start: (c.start - offset) / ratio, end: (c.end - offset) / ratio }));
  fs.writeFileSync(path.join(dir, 'a.srt'), st.toSrt(wrong));
  return cues;
}

for (const [name, offset, ratio] of [
  ['a constant delay', 3700, 1],
  ['subtitles running early', -12340, 1],
  ['a 23.976 → 25 fps mismatch plus a delay', 2000, 25 / 23.976],
]) {
  test(`sync recovers ${name}`, { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = tmpdir();
    const truth = fixture(dir, { offset, ratio });
    const r = await sync.syncFile(path.join(dir, 'a.wav'), path.join(dir, 'a.srt'));
    assert.equal(r.applied, true, r.reason);
    assert.ok(r.confidence >= sync.MIN_CONFIDENCE);
    const fixed = st.parse(fs.readFileSync(path.join(dir, 'a.srt'), 'utf8'));
    const worst = Math.max(...fixed.map((c, i) => Math.abs(c.start - truth[i].start)));
    assert.ok(worst <= 20, `cues within 20 ms of the speech (worst ${worst} ms)`);
    assert.ok(fs.existsSync(path.join(dir, 'a.srt.bak')), 'original kept as .bak');
    assert.equal(sync.restoreFile(path.join(dir, 'a.srt')), true);
  });
}

test('sync leaves an aligned file alone', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tmpdir();
  fixture(dir, { offset: 0, ratio: 1 });
  const before = fs.readFileSync(path.join(dir, 'a.srt'), 'utf8');
  const r = await sync.syncFile(path.join(dir, 'a.wav'), path.join(dir, 'a.srt'));
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'already in sync');
  assert.equal(fs.readFileSync(path.join(dir, 'a.srt'), 'utf8'), before);
});

test('sync refuses to guess when the subtitles match nothing in the audio', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tmpdir();
  const r = rng(3);
  writeWav(path.join(dir, 'a.wav'), 120, 8000, () => (r() - 0.5) * 0.1); // noise only
  const cues = Array.from({ length: 40 }, (_, i) => ({ start: 2000 + i * 2500, end: 3000 + i * 2500, text: 'x' }));
  fs.writeFileSync(path.join(dir, 'a.srt'), st.toSrt(cues));
  const res = await sync.syncFile(path.join(dir, 'a.wav'), path.join(dir, 'a.srt'));
  assert.equal(res.applied, false);
});
