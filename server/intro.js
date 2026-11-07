'use strict';

// Finding a show's intro, so the players can offer "Skip intro".
//
// The opening of a show sounds the same in every episode of a season, while
// the cold open before it differs. So the first minutes of two episodes are
// fingerprinted (Chromaprint, through ffmpeg: one 32-bit value per ~0.124 s
// of audio) and the longest stretch they share is the intro — wherever it
// sits in each. The same approach as Jellyfin's intro skipper.
//
//   1. Candidate alignments: every fingerprint value of episode A is indexed;
//      each identical value in B votes for the shift between them.
//   2. For the best-voted shifts, walk both prints side by side and find the
//      longest run where the values differ in only a few bits, bridging the
//      odd bad frame.
//   3. A run between MIN_SECS and MAX_SECS is an intro.
//
// Each episode is compared with its neighbour in the season. Prints are kept
// in the database, so each episode's audio is read once. Nothing found is
// remembered too, and tried again only when another episode of the season
// arrives.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const log = require('./log');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const SECS_PER_POINT = 4096 / 3 / 11025;   // Chromaprint's step: 0.1238 s
const SCAN_SECS = 600;          // the first ten minutes (or the first third, if shorter)
const MIN_SECS = 12;
const MAX_SECS = 150;
const MAX_BIT_ERRORS = 6;       // of 32: the same audio, re-encoded
const MAX_GAP = 4;              // bad points bridged inside a run (~0.5 s)
const TOP_SHIFTS = 8;
// Each print value is made from a little audio either side of it, so the edges
// of a match blur by a second or so — in practice the run stops a little
// before the intro does, which is the safe side: a moment of intro left, never
// a moment of the episode skipped. (A test whose 'episode' audio was steady
// tones seemed to show the opposite; tones that similar fingerprint alike.)
const END_TRIM = 0;

db.exec(`
  CREATE TABLE IF NOT EXISTS audio_prints (
    kind     TEXT    NOT NULL,
    item_id  INTEGER NOT NULL,
    secs     REAL    NOT NULL,
    data     BLOB    NOT NULL,
    PRIMARY KEY (kind, item_id)
  );
  CREATE TABLE IF NOT EXISTS intros (
    kind        TEXT    NOT NULL,
    item_id     INTEGER NOT NULL,
    start       REAL,               -- null: looked, found none
    end         REAL,
    siblings    INTEGER NOT NULL DEFAULT 0,   -- episodes of the season there were when it looked
    detected_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (kind, item_id)
  );
`);

// ─── Fingerprints ─────────────────────────────────────────────────────────────

/** Raw Chromaprint values for the first `secs` of an audio stream, as a Uint32Array. */
function fingerprint(file, { secs = SCAN_SECS, map = '0:a:0' } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-t', String(secs), '-i', file,
      '-map', map, '-vn', '-sn', '-dn', '-ac', '1', '-f', 'chromaprint', '-fp_format', 'raw', 'pipe:1'];
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 5 * 60_000);
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `ffmpeg exited ${code}`));
      const buf = Buffer.concat(chunks);
      const out = new Uint32Array(Math.floor(buf.length / 4));
      for (let i = 0; i < out.length; i++) out[i] = buf.readUInt32LE(i * 4);
      resolve(out);
    });
  });
}

function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * The longest stretch two prints share: { a: [start, end], b: [start, end] }
 * in seconds, or null. Pure, so it can be tested on made-up prints.
 */
function sharedStretch(A, B, { minSecs = MIN_SECS, maxSecs = MAX_SECS } = {}) {
  if (!A.length || !B.length) return null;
  // 1. Votes for shifts (j - i) from identical values.
  const where = new Map();
  for (let i = 0; i < A.length; i++) {
    const list = where.get(A[i]);
    if (list) { if (list.length < 8) list.push(i); } else where.set(A[i], [i]);
  }
  const votes = new Map();
  for (let j = 0; j < B.length; j++) {
    const list = where.get(B[j]);
    if (!list) continue;
    for (const i of list) votes.set(j - i, (votes.get(j - i) || 0) + 1);
  }
  // Neighbouring shifts are the same alignment, give or take a point.
  const shifts = [...votes.entries()].sort((x, y) => y[1] - x[1]).slice(0, TOP_SHIFTS * 3).map(([s]) => s);
  const tried = new Set();
  let best = null;
  for (const s0 of shifts) {
    for (const s of [s0 - 1, s0, s0 + 1]) {
      if (tried.has(s)) continue;
      tried.add(s);
      // 2. Walk the overlap; a run allows MAX_GAP bad points in a row.
      const i0 = Math.max(0, -s), i1 = Math.min(A.length, B.length - s);
      let runStart = -1, lastGood = -1;
      for (let i = i0; i <= i1; i++) {
        const good = i < i1 && popcount(A[i] ^ B[i + s]) <= MAX_BIT_ERRORS;
        if (good) {
          if (runStart < 0) runStart = i;
          lastGood = i;
        } else if (runStart >= 0 && (i - lastGood > MAX_GAP || i === i1)) {
          const len = lastGood - runStart + 1;
          if (!best || len > best.len) best = { len, i: runStart, j: runStart + s };
          runStart = -1;
        }
      }
    }
    if (tried.size >= TOP_SHIFTS * 3) break;
  }
  if (!best) return null;
  const secs = best.len * SECS_PER_POINT;
  if (secs < minSecs || secs > maxSecs) return null;
  const at = (n) => Math.round(n * SECS_PER_POINT * 10) / 10;
  const end = (n) => Math.max(at(n) - END_TRIM, 0);
  return { a: [at(best.i), end(best.i + best.len)], b: [at(best.j), end(best.j + best.len)] };
}

// ─── Episodes ─────────────────────────────────────────────────────────────────

async function printOf(row) {
  const kept = db.prepare('SELECT data FROM audio_prints WHERE kind = ? AND item_id = ?').get(row.kind, row.item_id);
  if (kept) {
    const b = Buffer.from(kept.data);
    return new Uint32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
  }
  const media = require('./media');
  let src = null, map = '0:a:0';
  if (row.path && !row.original_removed_at && fs.existsSync(row.path)) {
    src = row.path;
    try {
      const a = media.chooseAudio(JSON.parse(row.probe).streams);
      if (a) map = `0:${a.index}`;
    } catch (_) {}
  } else {
    const a0 = path.join(media.webDir(row.kind, row.item_id), 'a0', 'index.m3u8');
    const v = path.join(media.webDir(row.kind, row.item_id), 'v', 'index.m3u8');
    src = fs.existsSync(a0) ? a0 : fs.existsSync(v) ? v : null;
  }
  if (!src) return null;
  const secs = Math.min(SCAN_SECS, row.duration ? row.duration / 3 : SCAN_SECS);
  const fp = await fingerprint(src, { secs, map });
  db.prepare('INSERT OR REPLACE INTO audio_prints (kind, item_id, secs, data) VALUES (?, ?, ?, ?)')
    .run(row.kind, row.item_id, secs, Buffer.from(fp.buffer, fp.byteOffset, fp.byteLength));
  return fp;
}

/** Episodes of the same season that have a file, in order: [{ id, episode, row }]. */
function seasonOf(episodeId) {
  const ep = db.prepare('SELECT show_id, season FROM episodes WHERE id = ?').get(episodeId);
  if (!ep) return [];
  return db.prepare(`
    SELECT e.id, e.episode, m.* FROM episodes e JOIN media_files m ON m.kind = 'episode' AND m.item_id = e.id
    WHERE e.show_id = ? AND e.season = ? AND e.status = 'done' ORDER BY e.episode
  `).all(ep.show_id, ep.season);
}

function save(id, found, siblings) {
  db.prepare('INSERT OR REPLACE INTO intros (kind, item_id, start, end, siblings) VALUES (?, ?, ?, ?, ?)')
    .run('episode', id, found ? found[0] : null, found ? found[1] : null, siblings);
}

/**
 * Look for this episode's intro by comparing it with the next episode of the
 * season (or the previous). Saves what it finds for both.
 */
async function detect(episodeId) {
  const season = seasonOf(episodeId);
  const k = season.findIndex(r => r.id === episodeId);
  if (k < 0 || season.length < 2) return null;
  const me = await printOf(season[k]);
  if (!me) return null;
  for (const other of [season[k + 1], season[k - 1], season[k + 2], season[k - 2]].filter(Boolean)) {
    const them = await printOf(other);
    if (!them) continue;
    const r = sharedStretch(me, them);
    if (!r) continue;
    save(episodeId, r.a, season.length);
    const known = db.prepare("SELECT start FROM intros WHERE kind = 'episode' AND item_id = ?").get(other.id);
    if (!known || known.start === null) save(other.id, r.b, season.length);
    return { start: r.a[0], end: r.a[1] };
  }
  save(episodeId, null, season.length);
  return null;
}

/** The intro of an episode, if one was found: { start, end }. */
function introOf(kind, id) {
  if (kind !== 'episode') return null;
  const r = db.prepare("SELECT start, end FROM intros WHERE kind = 'episode' AND item_id = ?").get(id);
  return r && r.start !== null ? { start: r.start, end: r.end } : null;
}

/**
 * A batch of episodes still to look at: never looked, or nothing found while
 * the season had fewer episodes than it does now. Oldest first.
 */
async function pass({ limit = 12 } = {}) {
  const todo = db.prepare(`
    SELECT e.id FROM episodes e
      JOIN media_files m ON m.kind = 'episode' AND m.item_id = e.id
      LEFT JOIN intros i ON i.kind = 'episode' AND i.item_id = e.id
    WHERE e.status = 'done'
      AND (i.item_id IS NULL OR (i.start IS NULL AND i.siblings < (
        SELECT COUNT(*) FROM episodes s JOIN media_files sm ON sm.kind = 'episode' AND sm.item_id = s.id
        WHERE s.show_id = e.show_id AND s.season = e.season AND s.status = 'done')))
      AND (SELECT COUNT(*) FROM episodes s JOIN media_files sm ON sm.kind = 'episode' AND sm.item_id = s.id
           WHERE s.show_id = e.show_id AND s.season = e.season AND s.status = 'done') >= 2
    ORDER BY e.id LIMIT ?
  `).all(limit);
  let found = 0;
  for (const { id } of todo) {
    if (introOf('episode', id)) continue;   // found meanwhile, comparing a neighbour
    try { if (await detect(id)) found++; } catch (err) { log.warn(`intro detection failed: ${err.message}`, { type: 'episode', id }); }
  }
  if (found) log.info(`found the intro in ${found} episode(s)`);
  return { checked: todo.length, found };
}

function forget(kind, id) {
  db.prepare('DELETE FROM audio_prints WHERE kind = ? AND item_id = ?').run(kind, id);
  db.prepare('DELETE FROM intros WHERE kind = ? AND item_id = ?').run(kind, id);
}

let timer = null;
function start() {
  const tick = () => pass().catch(err => console.error('[intro] pass failed:', err.message));
  setTimeout(tick, 3 * 60_000).unref();
  timer = setInterval(tick, 20 * 60_000);
  timer.unref();
}

module.exports = { start, pass, detect, introOf, forget, sharedStretch, fingerprint, SECS_PER_POINT };
