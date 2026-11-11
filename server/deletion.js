'use strict';

const { torrentRef, lowerHash } = require('./torrentref');

// Deleting from the library by hand, to free space or because it has been
// watched. Two levels:
//
//   web version  Only the browser copy. The original stays, keeps seeding, and
//                the web version is made again the next time someone opens it.
//
//   everything   The original, its subtitles, and the web version. The item is
//                marked 'deleted', so the scheduler never grabs it again; Redo
//                brings it back.
//
// Removing the original goes through Transmission wherever it still has the
// torrent, so it neither keeps seeding nor reports missing files:
//   - a torrent that is only this item is removed with its data;
//   - a pack (other episodes, or other videos in it), or a torrent that was
//     already in Transmission before auto_magnet asked for it, keeps going:
//     only this file is dropped from it and deleted, the rest keeps seeding.
// Files are only ever deleted inside the movie and show folders.

const fs   = require('fs');
const path = require('path');

const { db, movies, episodes, settings, isHash } = require('./db');
const media = require('./media');
const { mapPath } = require('./paths');
const log = require('./log');

const key = (p) => path.resolve(p);
const fail = (message, status) => Object.assign(new Error(message), { status });

function libraryRoots() {
  return ['movie_path', 'shows_path']
    .map(k => String(settings.get(k) || '').replace(/\/+$/, ''))
    .filter(Boolean)
    .map(r => key(mapPath(r)));
}

/** Strictly inside the movie or show folder — never one of the folders itself. */
function insideLibrary(p) {
  const k = key(p);
  return libraryRoots().some(r => k.startsWith(r + path.sep));
}

const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

function webBytes(kind, id) {
  return media.dirBytes(media.webDir(kind, id)) + media.dirBytes(media.subsDir(kind, id));
}

/** Delete only the web version. */
function deleteWebVersion(kind, id, { by = null } = {}) {
  const row = media.rows.get(kind, id);
  if (!row) throw fail('There is no web version for this item', 404);
  if (row.original_removed_at) {
    throw fail('The original was removed after seeding, so the web version is the only copy left — delete everything instead', 409);
  }
  const freed = webBytes(kind, id);
  media.removeWebVersion(kind, id);
  media.rows.update(kind, id, { web_state: 'none', web_progress: 0, web_error: null, web_priority: 0 });
  log.info(`web version deleted${by ? ` by ${by}` : ''} — ${gb(freed)} freed; it is made again when someone opens it`, { type: kind, id });
  setImmediate(media.pump);
  return { freed };
}

/**
 * Other library items downloaded by the same torrent: by hash, or — for a
 * torrent known only by the id it had when it was grabbed — by that id among
 * rows that have no hash either.
 */
function sharers(item, ref, target) {
  const byHash = isHash(ref);
  const m = byHash ? 'torrent_hash = ?' : 'torrent_id = ? AND torrent_hash IS NULL';
  const e = byHash ? 'e.torrent_hash = ?' : 'e.torrent_id = ? AND e.torrent_hash IS NULL';
  const v = byHash ? String(ref).toLowerCase() : ref;
  return db.prepare(`
    SELECT 'movie' AS kind, id FROM movies
      WHERE ${m} AND COALESCE(transmission_target, '') = ? AND status IN ('done', 'downloading')
    UNION ALL
    SELECT 'episode' AS kind, e.id FROM episodes e JOIN shows s ON s.id = e.show_id
      WHERE ${e} AND COALESCE(s.transmission_target, '') = ? AND e.status IN ('done', 'downloading')
  `).all(v, target || '', v, target || '')
    .filter(r => !(r.kind === item.kind && r.id === item.id));
}

/** A release folder of its own, now empty: remove it. Never a show folder or a library root. */
function removeEmptyReleaseFolder(file) {
  const root = (k) => key(mapPath(String(settings.get(k) || '').replace(/\/+$/, '')));
  const moviesRoot = root('movie_path'), showsRoot = root('shows_path');
  const dir = key(path.dirname(file));
  // A film's release folder sits in the movie folder; in the show folder, the
  // folders are the shows themselves.
  if (dir === moviesRoot || dir === showsRoot || key(path.dirname(dir)) === showsRoot) return;
  for (const sub of ['Subs', 'subs', 'Subtitles', 'subtitles']) {
    try { fs.rmdirSync(path.join(dir, sub)); } catch (_) {}
  }
  try { fs.rmdirSync(dir); } catch (_) { /* not empty, or already gone */ }
}

/**
 * Delete the original, its subtitles and the web version, and mark the item
 * deleted. Returns { freed, original } where `original` says what happened.
 */
async function deleteEverything(kind, id, { tx = require('./transmission'), by = null } = {}) {
  const item = media.itemFor(kind, id);
  if (!item) throw fail('Not found', 404);
  if (!['done', 'deleted'].includes(item.status)) {
    throw fail(item.status === 'downloading'
      ? 'Still downloading — remove it from the dashboard instead'
      : 'Nothing has been downloaded for this yet', 409);
  }
  const r = await removeDownload(kind, id, { tx });
  (kind === 'movie' ? movies : episodes).update(id, { status: 'deleted' });
  log.info(`deleted from disk${by ? ` by ${by}` : ''} (${r.original}) — ${gb(r.freed)} freed`, { type: kind, id });
  return r;
}

/**
 * Everything one item's download left behind: its torrent (or its file in a
 * pack), the file, subtitles beside it, the web version, seek thumbnails, the
 * intro and audio prints, and the record of the file. The item's own status is
 * the caller's business. Works for a download still running too.
 * Returns { freed, original }.
 */
async function removeDownload(kind, id, { tx = require('./transmission') } = {}) {
  const item = media.itemFor(kind, id);
  if (!item) throw fail('Not found', 404);

  // Still downloading: the torrent goes (or this file is dropped from a pack);
  // there is no finished file or web version yet.
  if (item.status === 'downloading' && (item.row.torrent_hash || item.row.torrent_id)) {
    const original = await dropRunningTorrent(item, tx);
    const freedWeb = forgetFile(kind, id);
    return { freed: freedWeb, original };
  }

  let row = media.rows.get(kind, id);
  if (!row && item.status === 'done') {
    try { row = await media.locate(kind, id); } catch (_) { /* nothing on disk to find */ }
  }

  let original = 'not on disk';
  let freedOriginal = 0;
  if (row && !row.original_removed_at && fs.existsSync(row.path)) {
    const torrentId = torrentRef(item.row);
    const target = kind === 'movie' ? item.row.transmission_target : item.show.transmission_target;
    let info = null;
    if (torrentId) {
      try {
        info = await tx.getTorrentInfo(torrentId, tx.resolveTarget(target));
      } catch (err) {
        // Deleting under a torrent Transmission still has would leave it
        // reporting missing files and trying to download them again.
        throw fail(`Transmission can't be reached to remove the torrent first (${err.message}) — try again once it is`, 503);
      }
    }
    // Before the video goes: subtitles beside it are found by its name.
    const sidecars = media.listSubtitles(row).filter(s => s.source === 'file').map(s => s.file);
    const index = info ? info.files.findIndex(f => key(mapPath(path.join(info.downloadDir, f.name))) === key(row.path)) : -1;
    // The whole torrent goes when nothing else in it is still wanted: a single
    // film, or the last episode left of a pack whose others were deleted.
    const othersWanted = info ? media.videoFilesIn(info.files)
      .filter(f => f.name !== info.files[index]?.name && f.wanted !== false).length : 0;
    const onlyThis = info && index >= 0 && sharers(item, torrentId, target).length === 0
      && othersWanted === 0 && item.row.torrent_origin !== 'duplicate';

    if (onlyThis) {
      await tx.purgeTorrent(torrentId, tx.resolveTarget(target));
      original = 'torrent removed with its files';
    } else {
      if (!insideLibrary(row.path)) {
        throw fail(`Not deleting ${row.path}: it is outside the movie and show folders`, 409);
      }
      if (info && index >= 0) {
        await tx.setFilesUnwanted(torrentId, [index], tx.resolveTarget(target));
        original = 'file removed from its torrent; the rest keeps seeding';
      } else {
        original = 'file removed';
      }
      fs.rmSync(row.path, { force: true });
    }
    freedOriginal = row.size || 0;
    for (const f of sidecars) {
      if (!insideLibrary(f)) continue;
      fs.rmSync(f, { force: true });
      fs.rmSync(`${f}.bak`, { force: true });
    }
    removeEmptyReleaseFolder(row.path);
  } else if (row?.original_removed_at) {
    original = 'already removed after seeding';
  }

  const freedWeb = forgetFile(kind, id);
  setImmediate(media.pump);
  return { freed: freedOriginal + freedWeb, original };
}

/** The web version, thumbnails, intro, prints and the record of the file. Returns bytes freed. */
function forgetFile(kind, id) {
  const freed = webBytes(kind, id);
  media.removeWebVersion(kind, id);
  require('./thumbs').remove(kind, id);
  require('./intro').forget(kind, id);
  if (media.rows.get(kind, id)) media.rows.remove(kind, id);
  return freed;
}

/**
 * A download that hasn't finished: remove the torrent with its data when it is
 * only this item's, else drop this item's file from it. A torrent that was in
 * Transmission before auto_magnet asked for it is someone else's: left alone.
 */
async function dropRunningTorrent(item, tx) {
  const torrentId = torrentRef(item.row);
  const target = item.kind === 'movie' ? item.row.transmission_target : item.show.transmission_target;
  if (item.row.torrent_origin === 'duplicate') return 'torrent was already in Transmission — left as it was';
  let info = null;
  try { info = await tx.getTorrentInfo(torrentId, tx.resolveTarget(target)); } catch (err) {
    throw fail(`Transmission can't be reached to remove the torrent first (${err.message}) — try again once it is`, 503);
  }
  if (!info) return 'torrent no longer in Transmission';
  // Known only by an id: after a Transmission restart that id can be another
  // download entirely. Only touch it when its files name this item.
  if (!item.row.torrent_hash && media.videoFilesIn(info.files).length
      && !media.pickFile(info.files, item, { dir: info.downloadDir })) {
    return `torrent ${torrentId} is now "${info.name}", not this item's — left as it was`;
  }
  if (sharers(item, torrentId, target).length === 0) {
    await tx.purgeTorrent(torrentId, tx.resolveTarget(target));
    return 'torrent removed with its files';
  }
  const f = media.pickFile(info.files, item, { dir: info.downloadDir, trusted: !!item.row.torrent_hash });
  const index = f ? info.files.indexOf(f) : -1;
  if (index >= 0) {
    await tx.setFilesUnwanted(torrentId, [index], tx.resolveTarget(target));
    const p = mapPath(path.join(info.downloadDir, f.name));
    if (insideLibrary(p)) fs.rmSync(p, { force: true });
    return 'file dropped from its pack; the rest keeps downloading';
  }
  return 'shared torrent left as it was';
}

module.exports = { deleteWebVersion, deleteEverything, removeDownload, insideLibrary, sharers, forgetFile, removeEmptyReleaseFolder };
