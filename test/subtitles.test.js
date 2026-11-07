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
  assert.deepEqual(cues, [{ start: 1000, end: 2000, text: 'Hi', settings: 'align:start' }], 'cue settings kept for writing VTT again');
});

test('SRT → VTT → parse round trip', () => {
  const cues = [{ start: 1234, end: 5678, text: 'a' }, { start: 3600000, end: 3601000, text: 'b' }];
  assert.match(st.toVtt(cues), /^WEBVTT\n\n00:00:01\.234 --> 00:00:05\.678\na\n/);
  assert.deepEqual(st.parse(st.toVtt(cues)), cues);
  assert.deepEqual(st.parse(st.toSrt(cues)), cues);
});

test('ASS position tags become WebVTT placement instead of showing as text', () => {
  assert.deepEqual(st.vttCue('{\\an8}Sign'), { text: 'Sign', settings: 'line:5%' });
  assert.deepEqual(st.vttCue('{\\an7}Top left'), { text: 'Top left', settings: 'line:5% position:5% align:left' });
  assert.deepEqual(st.vttCue('{\\an5}Middle'), { text: 'Middle', settings: 'line:50%,center' });
  assert.deepEqual(st.vttCue('{\\an2}Default'), { text: 'Default', settings: '' });
  assert.deepEqual(st.vttCue('{\\a6}Legacy SSA top'), { text: 'Legacy SSA top', settings: 'line:5%' });
  const vtt = st.toVtt(st.parse('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}Top\n'));
  assert.match(vtt, /00:00:01\.000 --> 00:00:02\.000 line:5%\nTop\n/);
  assert.doesNotMatch(vtt, /\\an8/);
});

test('ASS styling becomes WebVTT tags; other override blocks and comments are dropped', () => {
  assert.equal(st.vttCue('{\\i1}Italic{\\i0} {\\b1}bold{\\b0}').text, '<i>Italic</i> <b>bold</b>');
  assert.equal(st.vttCue('{\\pos(10,20)\\fad(200,200)\\c&H00FFFF&}Moved').text, 'Moved');
  assert.equal(st.vttCue('{Translator note}Hi').text, 'Hi');
  assert.equal(st.vttCue('One\\NTwo\\nThree').text, 'One\nTwo\nThree');
});

test('HTML-ish SRT tags: i/b/u kept, font dropped, stray < & escaped', () => {
  assert.equal(st.vttCue('<font color="#ff0">Yellow</font> <I>it</I>').text, 'Yellow <i>it</i>');
  assert.equal(st.vttCue('a < b && c > d').text, 'a &lt; b &amp;&amp; c &gt; d');
  assert.equal(st.vttCue('R&amp;D').text, 'R&amp;D', 'existing entities left alone');
});

test('a cue that is only a tag is left out rather than shown empty', () => {
  assert.doesNotMatch(st.toVtt([{ start: 0, end: 1000, text: '{\\an8}' }]), /-->/);
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

// ─── Drift a single shift and stretch can't fix ──────────────────────────────

/** Like fixture(), but longer, and the file on disk is wrong by `wrongAt(t)` ms at time t. */
function driftFixture(dir, wrongAt, seconds = 900) {
  const r = rng(29);
  const cues = [];
  for (let t = 5000; t < (seconds - 10) * 1000;) {
    const len = 800 + r() * 3000;
    cues.push({ start: t, end: t + len, text: `line ${cues.length}` });
    t += len + 300 + r() * 4000;
  }
  const sr = 8000;
  const on = new Uint8Array(seconds * sr);
  for (const c of cues) on.fill(1, Math.floor(c.start / 1000 * sr), Math.min(on.length, Math.floor(c.end / 1000 * sr)));
  writeWav(path.join(dir, 'a.wav'), seconds, sr, (i) => (r() - 0.5) * 0.05 + (on[i] ? 0.3 * Math.sin(i * 2 * Math.PI * 500 / sr) : 0));
  fs.writeFileSync(path.join(dir, 'a.srt'), st.toSrt(cues.map(c => ({ ...c, start: c.start - wrongAt(c.start), end: c.end - wrongAt(c.start) }))));
  return cues;
}

/** Share of lines within `ms` of the speech after syncing. */
function within(dir, truth, ms) {
  const fixed = st.parse(fs.readFileSync(path.join(dir, 'a.srt'), 'utf8'));
  const byText = new Map(fixed.map(c => [c.text, c]));
  return truth.filter(c => byText.has(c.text) && Math.abs(byText.get(c.text).start - c.start) <= ms).length / truth.length;
}

for (const [name, wrongAt] of [
  // The subtitles' release had 2.5 s more before the second half (an ad break, a longer scene).
  ['a cut that differs half way through', (t) => (t > 450_000 ? -2500 : 0) + 1200],
  // A speed difference that isn't one of the usual frame rates: 3 s out by the end.
  ['a drift that is no common frame rate', (t) => 800 + t * 0.0034],
]) {
  test(`sync fine-tunes ${name}`, { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = tmpdir();
    const truth = driftFixture(dir, wrongAt);
    const r = await sync.syncFile(path.join(dir, 'a.wav'), path.join(dir, 'a.srt'));
    assert.equal(r.applied, true, r.reason);
    assert.equal(r.refined, true, 'needed more than one shift and stretch');
    const share = within(dir, truth, 200);
    assert.ok(share >= 0.9, `${Math.round(share * 100)}% of lines within 200 ms`);
    assert.match(sync.describe(r), /fine-tuned in \d+ stretches/);
  });
}

test('fine-tuning leaves a plain shift as it was', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tmpdir();
  const truth = driftFixture(dir, () => 3100, 600);
  const r = await sync.syncFile(path.join(dir, 'a.wav'), path.join(dir, 'a.srt'));
  assert.equal(r.applied, true);
  assert.equal(r.refined, false, 'one shift was all it took');
  assert.equal(within(dir, truth, 20), 1);
});

test('duplicate lines drawn at once become one', () => {
  const cues = [
    { start: 1000, end: 3000, text: '{\bord3}Where were you?' },
    { start: 1000, end: 3000, text: 'Where were you?' },
    { start: 2500, end: 4000, text: 'where  were you?' },
    { start: 5000, end: 6000, text: 'Where were you?' },   // said again, later: kept
    { start: 1500, end: 2000, text: 'Something else' },
  ];
  assert.deepEqual(st.dedupe(cues).map(c => [c.start, c.end, c.text]), [
    [1000, 4000, '{\bord3}Where were you?'],
    [1500, 2000, 'Something else'],
    [5000, 6000, 'Where were you?'],
  ]);
});
