'use strict';

// Aligning a subtitle file to the audio it belongs with.
//
// A subtitle fetched by IMDb id and episode number was timed against *some*
// release of that episode — often one with a different intro length, an
// extra studio logo, or a different frame rate. The text is right; the clock
// is off by a constant, or drifts steadily.
//
// Both are fixed the way ffsubsync does it:
//
//   1. Speech signal: the audio is decoded to mono, band-limited to the
//      voice range, and reduced to one loudness value per 10 ms.
//   2. Subtitle signal: 1 wherever a cue is on screen, 0 elsewhere.
//   3. Cross-correlate the two (by FFT, so a two-hour film takes seconds) and
//      take the lag where they agree best. Repeat with the subtitle's clock
//      stretched by the usual frame-rate mismatches (23.976 ↔ 24 ↔ 25 fps)
//      and keep the best of all.
//
// The result is only applied when the peak clearly stands out from the rest of
// the correlation; a subtitle that matches nothing is left as it was.

const fs = require('fs');
const { spawn } = require('child_process');
const subText = require('./subtitle-text');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const RATE = 100;                    // signal samples per second (10 ms)
const SAMPLE_RATE = 8000;
const FRAME = SAMPLE_RATE / RATE;    // audio samples per signal sample
const RATIOS = [1, 25 / 23.976, 23.976 / 25, 24 / 23.976, 23.976 / 24, 25 / 24, 24 / 25];

// ─── Signals ──────────────────────────────────────────────────────────────────

/**
 * Loudness in the voice band, one value per 10 ms, as a Float32Array.
 * @param {string} file
 * @param {object} [o]
 * @param {number} [o.streamIndex]  absolute ffprobe index of the audio stream
 */
function speechEnergy(file, { streamIndex = null, timeoutMs = 15 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', file,
      '-map', streamIndex == null ? '0:a:0' : `0:${streamIndex}`, '-vn', '-sn',
      '-af', 'highpass=f=250,lowpass=f=3200', '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-f', 's16le', 'pipe:1'];
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    const out = [];
    let acc = 0, n = 0, carry = null, stderr = '';
    proc.stdout.on('data', (chunk) => {
      let buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const even = buf.length - (buf.length % 2);
      carry = even < buf.length ? buf.subarray(even) : null;
      for (let i = 0; i < even; i += 2) {
        const v = buf.readInt16LE(i) / 32768;
        acc += v * v;
        if (++n === FRAME) { out.push(acc / FRAME); acc = 0; n = 0; }
      }
    });
    proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`audio extraction failed: ${stderr.trim().split('\n').pop() || code}`));
      const e = new Float32Array(out.length);
      for (let i = 0; i < out.length; i++) e[i] = Math.log10(out[i] + 1e-10);
      resolve(e);
    });
  });
}

/**
 * Speech likelihood from loudness: smoothed, then scaled so the quiet floor
 * is 0 and loud passages saturate at 1. Robust to overall volume.
 */
function speechSignal(energy) {
  const n = energy.length;
  const sm = new Float32Array(n);
  const W = 5; // ±50 ms
  let sum = 0;
  for (let i = 0; i < Math.min(n, W); i++) sum += energy[i];
  for (let i = 0; i < n; i++) {
    if (i + W < n) sum += energy[i + W];
    if (i - W - 1 >= 0) sum -= energy[i - W - 1];
    const lo = Math.max(0, i - W), hi = Math.min(n - 1, i + W);
    sm[i] = sum / (hi - lo + 1);
  }
  const sorted = Float32Array.from(sm).sort();
  const floor = sorted[Math.floor(n * 0.2)] ?? 0;
  const top = sorted[Math.floor(n * 0.95)] ?? 1;
  const span = Math.max(1e-6, top - floor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.min(1, Math.max(0, (sm[i] - floor) / span));
  return out;
}

/** 1 while a cue is showing, sampled at RATE, after stretching by `ratio`. */
function cueSignal(cues, length, ratio = 1) {
  const s = new Float32Array(length);
  for (const c of cues) {
    const a = Math.max(0, Math.floor((c.start * ratio) / 1000 * RATE));
    const b = Math.min(length, Math.ceil((c.end * ratio) / 1000 * RATE));
    for (let i = a; i < b; i++) s[i] = 1;
  }
  return s;
}

// ─── FFT cross-correlation ───────────────────────────────────────────────────

function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k + half], ai = im[i + k + half];
        const tr = ar * cr - ai * ci, ti = ar * ci + ai * cr;
        re[i + k + half] = re[i + k] - tr; im[i + k + half] = im[i + k] - ti;
        re[i + k] += tr; im[i + k] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

const centered = (x) => {
  let m = 0;
  for (let i = 0; i < x.length; i++) m += x[i];
  m /= x.length || 1;
  return (i) => x[i] - m;
};

/**
 * Correlation of `a` (audio) with `b` (subtitles) at every lag in
 * [-maxLag, maxLag]. Positive lag = the subtitles must move later.
 * `aSpec` is a's precomputed spectrum, reused across stretch ratios.
 */
function spectrum(a, n) {
  const re = new Float64Array(n), im = new Float64Array(n);
  const ca = centered(a);
  for (let i = 0; i < a.length; i++) re[i] = ca(i);
  fft(re, im);
  return { re, im };
}

function correlate(aSpec, b, maxLag) {
  const n = aSpec.re.length;
  const re = new Float64Array(n), im = new Float64Array(n);
  const cb = centered(b);
  for (let i = 0; i < b.length; i++) re[i] = cb(i);
  fft(re, im);
  // A · conj(B)
  for (let i = 0; i < n; i++) {
    const r = aSpec.re[i] * re[i] + aSpec.im[i] * im[i];
    const j = aSpec.im[i] * re[i] - aSpec.re[i] * im[i];
    re[i] = r; im[i] = j;
  }
  fft(re, im, true);
  const lags = new Float64Array(2 * maxLag + 1);
  for (let lag = -maxLag; lag <= maxLag; lag++) lags[lag + maxLag] = re[(lag + n) % n];
  return lags;
}

function peakOf(lags) {
  let best = 0;
  for (let i = 1; i < lags.length; i++) if (lags[i] > lags[best]) best = i;
  let mean = 0;
  for (const v of lags) mean += v;
  mean /= lags.length;
  let sd = 0;
  for (const v of lags) sd += (v - mean) ** 2;
  sd = Math.sqrt(sd / lags.length) || 1e-9;
  return { index: best, value: lags[best], z: (lags[best] - mean) / sd };
}

/**
 * The shift and stretch that best line cues up with speech.
 * @returns {{ offsetMs, ratio, confidence, improvement }}
 */
function align(speech, cues, { maxOffsetSec = 600 } = {}) {
  const maxLag = Math.min(Math.floor(maxOffsetSec * RATE), speech.length);
  const lastCue = cues.reduce((m, c) => Math.max(m, c.end), 0);
  const len = Math.max(speech.length, Math.ceil(lastCue / 1000 * RATE * Math.max(...RATIOS)) + 1);
  let n = 1;
  while (n < len + maxLag + 1) n <<= 1;
  const aSpec = spectrum(speech, n);

  let best = null, baseline = null;
  for (const ratio of RATIOS) {
    const lags = correlate(aSpec, cueSignal(cues, len, ratio), maxLag);
    const p = peakOf(lags);
    if (ratio === 1) baseline = lags[maxLag];
    if (!best || p.value > best.value) best = { ...p, ratio, lag: p.index - maxLag };
  }
  return {
    offsetMs: Math.round(best.lag * (1000 / RATE)),
    ratio: best.ratio,
    confidence: best.z,
    improvement: baseline > 0 ? best.value / baseline : Infinity,
  };
}

// ─── Files ────────────────────────────────────────────────────────────────────

/** z-score the correlation peak must reach before a result is trusted. */
const MIN_CONFIDENCE = 4;

/**
 * Align `subtitlePath` to `videoPath` and rewrite it if the result is
 * trustworthy and actually changes something. The first rewrite keeps the
 * original beside it as `<name>.bak`, which no player picks up.
 */
async function syncFile(videoPath, subtitlePath, { streamIndex = null, write = true } = {}) {
  const original = subText.decode(fs.readFileSync(subtitlePath));
  const cues = subText.parse(original);
  if (cues.length < 10) return { applied: false, reason: 'too few cues to align' };

  const speech = speechSignal(await speechEnergy(videoPath, { streamIndex }));
  if (speech.length < RATE * 60) return { applied: false, reason: 'audio too short to align' };
  const r = align(speech, cues);

  const unchanged = Math.abs(r.offsetMs) < 100 && r.ratio === 1;
  if (r.confidence < MIN_CONFIDENCE) {
    return { applied: false, reason: `no clear match (confidence ${r.confidence.toFixed(1)})`, ...r };
  }
  if (unchanged) return { applied: false, reason: 'already in sync', ...r };
  if (write) {
    const bak = `${subtitlePath}.bak`;
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, original);
    const st = fs.statSync(subtitlePath);
    fs.writeFileSync(subtitlePath, subText.toSrt(subText.transform(cues, r)));
    try { fs.chownSync(subtitlePath, st.uid, st.gid); } catch (_) {}
  }
  return { applied: true, ...r };
}

/** Shift an SRT file by a fixed amount, e.g. the offset chosen in the player. */
function shiftFile(subtitlePath, offsetMs) {
  const original = subText.decode(fs.readFileSync(subtitlePath));
  const bak = `${subtitlePath}.bak`;
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, original);
  const st = fs.statSync(subtitlePath);
  fs.writeFileSync(subtitlePath, subText.toSrt(subText.transform(subText.parse(original), { offsetMs })));
  try { fs.chownSync(subtitlePath, st.uid, st.gid); } catch (_) {}
}

/** Put back the file as it was before the first sync or shift. */
function restoreFile(subtitlePath) {
  const bak = `${subtitlePath}.bak`;
  if (!fs.existsSync(bak)) return false;
  fs.copyFileSync(bak, subtitlePath);
  fs.rmSync(bak);
  return true;
}

module.exports = {
  syncFile, shiftFile, restoreFile, align, speechSignal, speechEnergy, cueSignal, fft,
  RATE, MIN_CONFIDENCE, RATIOS,
};
