'use strict';

// Shared fixtures. Each test file runs in its own process (node --test), so a
// file sets DB_PATH to a fresh temp database before requiring any server code.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

function tmpdir(prefix = 'amagnet-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Point the server's database at a throwaway file. Call before requiring server code. */
function freshDb() {
  const dir = tmpdir();
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.WEB_PATH = path.join(dir, 'web');
  return dir;
}

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
}

const SRT = '1\n00:00:01,000 --> 00:00:03,000\nHello there\n\n2\n00:00:05,000 --> 00:00:08,000\nSecond line\n';

/**
 * A small library on disk, one file per plan:
 *   Movies/Direct.Film.2020/…mp4   H.264 + AAC in MP4      → direct
 *   Movies/Remux.Film.2021/…mkv    H.264 + AC-3 + SRT, MKV → remux
 *   Series/Hevc Show/…S01E02…mkv   10-bit H.264            → transcode (+ sidecar .en.srt)
 */
function makeLibrary(root, { seconds = 12 } = {}) {
  const movies = path.join(root, 'Movies'), series = path.join(root, 'Series', 'Hevc Show');
  fs.mkdirSync(path.join(movies, 'Direct.Film.2020'), { recursive: true });
  fs.mkdirSync(path.join(movies, 'Remux.Film.2021'), { recursive: true });
  fs.mkdirSync(series, { recursive: true });
  const srt = path.join(root, 's.srt');
  fs.writeFileSync(srt, SRT);
  const v = ['-f', 'lavfi', '-i', `testsrc2=d=${seconds}:s=320x240:r=24`, '-f', 'lavfi', '-i', `sine=f=440:d=${seconds}`];
  ffmpeg([...v, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    path.join(movies, 'Direct.Film.2020', 'Direct.Film.2020.1080p.mp4')]);
  ffmpeg([...v, '-i', srt, '-map', '0', '-map', '1', '-map', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'ac3', '-c:s', 'srt', '-metadata:s:a:0', 'language=eng', '-metadata:s:s:0', 'language=eng',
    path.join(movies, 'Remux.Film.2021', 'Remux.Film.2021.mkv')]);
  const ep = path.join(series, 'Hevc.Show.S01E02.1080p.mkv');
  ffmpeg([...v, '-c:v', 'libx264', '-profile:v', 'high10', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', ep]);
  fs.writeFileSync(path.join(series, 'Hevc.Show.S01E02.1080p.en.srt'), SRT);
  return { movies: path.join(root, 'Movies'), series: path.join(root, 'Series'), episode: ep };
}

/** Deterministic pseudo-random numbers, so signal tests are repeatable. */
function rng(seed = 7) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

/** 16-bit mono WAV from a Float sample function. */
function writeWav(file, seconds, sampleRate, sample) {
  const n = seconds * sampleRate;
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample(i) * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

module.exports = { tmpdir, freshDb, hasFfmpeg, ffmpeg, makeLibrary, rng, writeWav, SRT };
