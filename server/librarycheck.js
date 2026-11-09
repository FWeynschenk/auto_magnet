'use strict';

// A look over the whole library, once a week (and on request), for what has
// drifted out of step with the disk and Transmission:
//
//   missing      downloaded, but the file isn't there any more
//   stuck        "downloading", but Transmission no longer has the torrent
//   notSeeding   downloaded by auto_magnet, but the torrent is gone from
//                Transmission (removed by hand?) — nothing to fix, worth knowing
//   brokenWeb    a web version marked ready that can't be played
//   orphans      web version / thumbnail folders of items no longer in the
//                library, taking space for nothing
//
// The report is kept, and shown in Settings → Status with a fix for each kind.

const fs = require('fs');
const path = require('path');
const { db, settings } = require('./db');
const media = require('./media');
const log = require('./log');

const KEY = 'library_check';
const WEEK_MS = 7 * 24 * 3600_000;

function last() {
  try { return JSON.parse(settings.get(KEY) || 'null'); } catch (_) { return null; }
}

function label(kind, id) {
  const it = media.itemFor(kind, id);
  if (!it) return `${kind} #${id}`;
  return kind === 'episode'
    ? `${it.show_title} S${String(it.season).padStart(2, '0')}E${String(it.episode).padStart(2, '0')}`
    : `${it.title}${it.row.year ? ` (${it.row.year})` : ''}`;
}

/** Torrent ids per Transmission instance, or null for an instance that couldn't be asked. */
async function torrentIds(tx) {
  const out = new Map();
  for (const t of tx.listTargets()) {
    try { out.set(t.name, new Set((await tx.listTorrents([], t)).map(x => x.id))); } catch (_) { out.set(t.name, null); }
  }
  return out;
}

async function run({ tx = require('./transmission') } = {}) {
  const started = Date.now();
  const ids = await torrentIds(tx);
  const has = (target, id) => {
    const set = ids.get(tx.resolveTarget(target).name);
    return set ? set.has(id) : null;   // null: couldn't tell
  };

  const items = db.prepare(`
    SELECT 'movie' AS kind, id, status, torrent_id, torrent_origin, transmission_target AS target FROM movies
      WHERE status IN ('done', 'downloading')
    UNION ALL
    SELECT 'episode' AS kind, e.id, e.status, e.torrent_id, e.torrent_origin, s.transmission_target AS target
      FROM episodes e JOIN shows s ON s.id = e.show_id WHERE e.status IN ('done', 'downloading')
  `).all();

  const missing = [], stuck = [], notSeeding = [], brokenWeb = [];
  for (const it of items) {
    const row = media.rows.get(it.kind, it.id);
    if (it.status === 'downloading') {
      if (it.torrent_id && has(it.target, it.torrent_id) === false) stuck.push({ kind: it.kind, id: it.id, title: label(it.kind, it.id) });
      continue;
    }
    if (row && !row.original_removed_at && !fs.existsSync(row.path)) {
      missing.push({ kind: it.kind, id: it.id, title: label(it.kind, it.id), path: row.path });
    }
    if (it.torrent_id && it.torrent_origin !== 'duplicate' && !row?.original_removed_at && has(it.target, it.torrent_id) === false) {
      notSeeding.push({ kind: it.kind, id: it.id, title: label(it.kind, it.id) });
    }
    if (row?.web_state === 'ready' && !media.hlsPlayable(it.kind, it.id)) {
      brokenWeb.push({ kind: it.kind, id: it.id, title: label(it.kind, it.id) });
    }
  }

  // Folders left behind by items no longer in the library.
  const orphans = [];
  const known = (kind, id) => !!media.rows.get(kind, id);
  const scan = (dir, what) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const n of names) {
      const m = /^(movie|episode)-(\d+)$/.exec(n);
      if (!m || known(m[1], Number(m[2]))) continue;
      const full = path.join(dir, n);
      orphans.push({ what, dir: full, bytes: media.dirBytes(full) });
    }
  };
  scan(media.WEB_ROOT, 'web version');
  scan(path.join(media.WEB_ROOT, 'thumbs'), 'thumbnails');
  scan(path.join(media.WEB_ROOT, 'subs'), 'subtitles');

  const report = {
    at: new Date().toISOString(), secs: Math.round((Date.now() - started) / 1000),
    unreachable: [...ids.entries()].filter(([, v]) => v === null).map(([k]) => k),
    missing, stuck, notSeeding, brokenWeb,
    orphans, orphanBytes: orphans.reduce((a, o) => a + o.bytes, 0),
  };
  settings.set(KEY, JSON.stringify(report));
  const problems = missing.length + stuck.length + brokenWeb.length + orphans.length;
  log[problems ? 'warn' : 'info'](`library check: ${problems ? [
    missing.length && `${missing.length} file(s) missing`, stuck.length && `${stuck.length} download(s) gone from Transmission`,
    brokenWeb.length && `${brokenWeb.length} broken web version(s)`, orphans.length && `${orphans.length} leftover folder(s)`,
  ].filter(Boolean).join(', ') : 'all in order'}${notSeeding.length ? `; ${notSeeding.length} no longer seeding` : ''} — see Settings → Status`);
  return report;
}

/**
 * Put one kind of problem right:
 *   missing, stuck  download again (the item is replaced; the release isn't marked wrong)
 *   brokenWeb       make the web version again
 *   orphans         delete the leftover folders
 */
async function fix(kind, { by = null } = {}) {
  const r = last();
  if (!r) throw Object.assign(new Error('Run the library check first'), { status: 409 });
  let done = 0;
  if (kind === 'missing' || kind === 'stuck') {
    const { replaceDownload } = require('./replace');
    for (const it of r[kind]) {
      try {
        await replaceDownload(it.kind, it.id, {
          reason: kind === 'missing' ? 'the file was missing' : 'the torrent was gone from Transmission', wrong: false, search: false, by,
        });
        done++;
      } catch (err) { log.warn(`library fix failed: ${err.message}`, { type: it.kind, id: it.id }); }
    }
    if (done) setImmediate(() => require('./scheduler').run().catch(() => {}));
  } else if (kind === 'brokenWeb') {
    for (const it of r.brokenWeb) {
      media.removeWebVersion(it.kind, it.id);
      media.rows.update(it.kind, it.id, { web_state: 'none', web_progress: 0, web_error: null });
      media.enqueue(it.kind, it.id);
      done++;
    }
  } else if (kind === 'orphans') {
    for (const o of r.orphans) {
      if (!path.resolve(o.dir).startsWith(path.resolve(media.WEB_ROOT) + path.sep)) continue;   // only ever inside WEB_ROOT
      fs.rmSync(o.dir, { recursive: true, force: true });
      done++;
    }
  } else {
    throw Object.assign(new Error('Unknown fix'), { status: 400 });
  }
  log.info(`library check: fixed ${done} (${kind})${by ? ` — by ${by}` : ''}`);
  // The report is out of date now: check again.
  const next = await run();
  return { fixed: done, report: next };
}

function start() {
  const tick = () => {
    const r = last();
    if (r && Date.now() - Date.parse(r.at) < WEEK_MS) return;
    run().catch(err => console.error('[library] check failed:', err.message));
  };
  setTimeout(tick, 10 * 60_000).unref();
  setInterval(tick, 6 * 3600_000).unref();
}

module.exports = { run, fix, last, start };

