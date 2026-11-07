'use strict';

// Thumbnails for seeking: one frame every INTERVAL seconds, tiled into sprite
// sheets, so dragging along the timeline shows where it will land.
//
// Cheap on purpose: ffmpeg decodes keyframes only (-skip_frame nokey), which
// for a 4K HEVC film is a few hundred frames rather than a few hundred
// thousand, and every frame is scaled to 160 px wide. A two-hour film is eight
// sheets of about half a megabyte. They are made after a web version is ready
// (or for a file that plays as it is, the first time a player asks), one at a
// time, and kept next to the web versions.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const log = require('./log');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const INTERVAL = 10;          // seconds between thumbnails
const W = 160;
const COLS = 10;
const ROWS = 10;              // 100 thumbnails, 1,000 s, per sheet
const VERSION = 2;            // bump to redo every set (2: counted from the frames made)

let WEB_ROOT = null;
const root = () => (WEB_ROOT ??= require('./media').WEB_ROOT);
const dirFor = (kind, id) => path.join(root(), 'thumbs', `${kind}-${id}`);
const indexFile = (kind, id) => path.join(dirFor(kind, id), 'index.json');

const queue = [];
let busy = false;

/** The index, if a full set exists: { interval, cols, rows, w, h, count, sheets }. */
function index(kind, id) {
  try {
    const ix = JSON.parse(fs.readFileSync(indexFile(kind, id), 'utf8'));
    return ix.version === VERSION ? ix : null;
  } catch (_) { return null; }
}

function sheetFile(kind, id, n) {
  return path.join(dirFor(kind, id), `sheet_${String(n).padStart(3, '0')}.jpg`);
}

/** What to read frames from: the original, or the web version once the original is gone. */
function sourceOf(row) {
  if (row.path && !row.original_removed_at && fs.existsSync(row.path)) return row.path;
  const media = require('./media');
  const master = path.join(media.webDir(row.kind, row.item_id), 'v', 'index.m3u8');
  return fs.existsSync(master) ? master : null;
}

/** Queue a set for this item unless one exists or is on its way. */
function ensure(kind, id) {
  if (index(kind, id) || queue.some(j => j.kind === kind && j.id === id)) return;
  queue.push({ kind, id });
  setImmediate(pump);
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue[0];
      try { await make(job.kind, job.id); } catch (err) {
        log.warn(`seek thumbnails failed: ${err.message}`, { type: job.kind, id: job.id });
      }
      queue.shift();
    }
  } finally { busy = false; }
}

async function make(kind, id) {
  const media = require('./media');
  const row = media.rows.get(kind, id);
  if (!row) return;
  const src = sourceOf(row);
  if (!src) return;
  // Thumbnails are small, but never the thing that fills a disk.
  const free = media.freeBytes();
  if (free !== null && free < 2e9) return;

  let info = null;
  try { info = JSON.parse(row.probe); } catch (_) {}
  // A clip shorter than two steps has nothing to preview (and gives no frames).
  const length = row.duration || Number(info?.format?.duration) || 0;
  if (length && length < INTERVAL * 2) return;
  const v = info && media.mainVideo(info.streams || []);
  const h = v?.width && v?.height ? Math.max(2, Math.round((W * v.height / v.width) / 2) * 2) : 90;

  const dir = dirFor(kind, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Two passes: the frames one by one — so how many there really are is known
  // (reading keyframes only, the stretch after the last one has none) — then
  // tiled into sheets from those small images, which takes no time.
  const run = (args) => new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited ${code}`))));
  });
  const frames = path.join(dir, 'frames');
  fs.mkdirSync(frames);
  await run(['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-skip_frame', 'nokey', '-i', src,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', `fps=1/${INTERVAL},scale=${W}:${h}`, '-vsync', 'vfr', '-q:v', '5',
    path.join(frames, 'f_%05d.jpg')]);
  const count = fs.readdirSync(frames).filter(n => /^f_\d{5}\.jpg$/.test(n)).length;
  if (!count) throw new Error('no frames came out');
  await run(['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-framerate', '1', '-i', path.join(frames, 'f_%05d.jpg'),
    '-vf', `tile=${COLS}x${ROWS}`, '-q:v', '6', path.join(dir, 'sheet_%03d.jpg')]);
  fs.rmSync(frames, { recursive: true, force: true });
  const sheets = fs.readdirSync(dir).filter(n => /^sheet_\d{3}\.jpg$/.test(n)).length;
  if (sheets !== Math.ceil(count / (COLS * ROWS))) throw new Error(`expected ${Math.ceil(count / (COLS * ROWS))} sheet(s), got ${sheets}`);
  fs.writeFileSync(indexFile(kind, id), JSON.stringify({ version: VERSION, interval: INTERVAL, cols: COLS, rows: ROWS, w: W, h, count, sheets }));
}

function remove(kind, id) {
  fs.rmSync(dirFor(kind, id), { recursive: true, force: true });
}

module.exports = { ensure, index, sheetFile, remove, dirFor, INTERVAL, _make: make };
