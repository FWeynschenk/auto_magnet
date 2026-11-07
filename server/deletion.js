'use strict';

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

const { db, movies, episodes, settings } = require('./db');
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

/** Other library items downloaded by the same torrent. */
function sharers(item, torrentId, target) {
  return db.prepare(`
    SELECT 'movie' AS kind, id FROM movies
      WHERE torrent_id = ? AND COALESCE(transmission_target, '') = ? AND status IN ('done', 'downloading')
    UNION ALL
    SELECT 'episode' AS kind, e.id FROM episodes e JOIN shows s ON s.id = e.show_id
      WHERE e.torrent_id = ? AND COALESCE(s.transmission_target, '') = ? AND e.status IN ('done', 'downloading')
  `).all(torrentId, target || '', torrentId, target || '')
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

  let row = media.rows.get(kind, id);
  if (!row && item.status === 'done') {
    try { row = await media.locate(kind, id); } catch (_) { /* nothing on disk to find */ }
  }

  let original = 'not on disk';
  let freedOriginal = 0;
  if (row && !row.original_removed_at && fs.existsSync(row.path)) {
    const torrentId = item.row.torrent_id;
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

  const freedWeb = webBytes(kind, id);
  media.removeWebVersion(kind, id);
  require('./thumbs').remove(kind, id);
  require('./intro').forget(kind, id);
  if (row) media.rows.remove(kind, id);
  (kind === 'movie' ? movies : episodes).update(id, { status: 'deleted' });

  const freed = freedOriginal + freedWeb;
  log.info(`deleted from disk${by ? ` by ${by}` : ''} (${original}) — ${gb(freed)} freed`, { type: kind, id });
  setImmediate(media.pump);
  return { freed, original };
}

module.exports = { deleteWebVersion, deleteEverything, insideLibrary };
