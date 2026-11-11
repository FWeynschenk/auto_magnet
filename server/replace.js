'use strict';

const { torrentRef, lowerHash } = require('./torrentref');

// Putting a wrong download right.
//
// A release can be the wrong thing: a show with a similar name, a mislabelled
// episode, a bad encode. Redo used to only reset the item's status, so:
//   - the old file stayed on record and kept playing until the new one came,
//   - its web version, thumbnails, intro and subtitles stayed too, and a
//     browser mixed the old web version's cached pieces into the new one,
//   - and the list of tried releases was cleared, so the same wrong release
//     was often picked again ("already in Transmission").
//
// Replacing now removes everything the old download left (its torrent or its
// file in a pack, the file, subtitles beside it, web version, thumbnails,
// intro), remembers the release as wrong for this item so it is never picked
// again, resets the item's download and check fields, and searches again.

const { movies, episodes } = require('./db');
const media = require('./media');
const deletion = require('./deletion');
const log = require('./log');

const fail = (message, status) => Object.assign(new Error(message), { status });

function parseList(json) {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}

/** Everything about a download that the next one must start without. */
const RESET = {
  status: 'pending', magnet: null, torrent_id: null, torrent_hash: null, torrent_origin: null, release_title: null,
  progress: 0, results_cache: null, results_cached_at: null, download_started_at: null,
  completed_at: null, post_processed_at: null, screened_at: null,
  subs_state: null, subs_match: null, subs_checked_at: null,
};

/**
 * Remove an item's download and look for another.
 *
 * @param {object} o
 * @param {string}  o.reason  why, for the log and the item's note
 * @param {boolean} o.wrong   remember the release as the wrong video (never picked again)
 * @param {boolean} o.search  start a search now (false when a release is being hand-picked)
 * @returns {{ removed: string|null, release: string|null }}
 */
async function replaceDownload(kind, id, { reason = 'wrong video', wrong = true, search = true, by = null, tx } = {}) {
  const item = media.itemFor(kind, id);
  if (!item) throw fail('Not found', 404);
  const row = item.row;
  const store = kind === 'movie' ? movies : episodes;

  let removed = null;
  if (['done', 'downloading'].includes(row.status) || media.rows.get(kind, id)) {
    removed = (await deletion.removeDownload(kind, id, tx ? { tx } : {})).original;
  }

  // Found under a name learned from TMDB, and wrong after all: never that name again.
  if (wrong && kind === 'episode' && row.release_title) require('./shownames').unlearn(item.show, row.release_title);
  const rejected = parseList(row.rejected_releases);
  if (wrong && row.magnet && !rejected.some(r => r.magnet === row.magnet)) {
    rejected.push({ magnet: row.magnet, title: row.release_title || null, reason, at: new Date().toISOString(), by });
  }
  // Releases tried before stay excluded too, unless the item had run out of
  // them (failed): then a fresh look is the point.
  const tried = row.status === 'failed' ? [] : parseList(row.tried_magnets);
  if (row.magnet && !tried.includes(row.magnet)) tried.push(row.magnet);

  store.update(id, {
    ...RESET,
    tried_magnets: JSON.stringify(tried),
    rejected_releases: JSON.stringify(rejected),
    last_error: wrong ? `Replacing the wrong video: ${reason}` : null,
  });
  const release = row.release_title || null;
  log.info(`${wrong ? 'wrong video' : 'download'} replaced${by ? ` by ${by}` : ''}`
    + `${release ? ` — "${release}"` : ''} (${reason})${removed ? `; ${removed}` : ''}`
    + `${search ? '; looking for another' : ''}`, { type: kind, id });

  if (search) setImmediate(() => require('./scheduler').run().catch(() => {}));
  return { removed, release };
}

/**
 * The items a download shares its torrent with (a season or series pack),
 * this one included: [{ kind, id }]. Just this one for a single release.
 */
function packOf(kind, id) {
  const item = media.itemFor(kind, id);
  const ref = item && (item.row.torrent_hash || item.row.torrent_id);
  if (!ref) return item ? [{ kind, id }] : [];
  const target = kind === 'movie' ? item.row.transmission_target : item.show.transmission_target;
  return [{ kind, id: Number(id) }, ...deletion.sharers(item, ref, target)];
}

/**
 * A whole pack was wrong (the wrong show's season, a mislabelled set): every
 * episode it downloaded is replaced at once, and the torrent goes with all its
 * data — rather than one Wrong video per episode, each dropping one file. A
 * torrent that was in Transmission before auto_magnet asked for it is left
 * as it was, its files with it; only the library forgets them.
 */
async function replacePack(kind, id, { reason = 'wrong pack', by = null, tx = require('./transmission') } = {}) {
  const item = media.itemFor(kind, id);
  if (!item) throw fail('Not found', 404);
  const members = packOf(kind, id).map(m => media.itemFor(m.kind, m.id)).filter(Boolean);
  if (members.length < 2) return { ...(await replaceDownload(kind, id, { reason, wrong: true, by, tx })), count: 1 };

  const target = kind === 'movie' ? item.row.transmission_target : item.show.transmission_target;
  const ours = item.row.torrent_origin !== 'duplicate';
  // Subtitles beside each file are found by its name: collect them before anything goes.
  const sidecars = members.flatMap((m) => {
    const r = media.rows.get(m.kind, m.id);
    return r && !r.original_removed_at ? media.listSubtitles(r).filter(s => s.source === 'file').map(s => s.file) : [];
  });
  const files = members.map(m => media.rows.get(m.kind, m.id)?.path).filter(Boolean);
  if (ours) {
    const ref = torrentRef(item.row);
    try {
      // Known only by an id, it must still be this pack: after a Transmission
      // restart the id can belong to another download.
      if (!item.row.torrent_hash) {
        const info = await tx.getTorrentInfo(ref, tx.resolveTarget(target));
        if (info && !media.pickFile(info.files, item, { dir: info.downloadDir })) {
          throw fail(`torrent ${ref} is now "${info.name}", not this pack — nothing removed`, 409);
        }
      }
      await tx.purgeTorrent(ref, tx.resolveTarget(target));
    } catch (err) {
      if (err.status) throw err;
      throw fail(`Transmission can't be reached to remove the pack (${err.message}) — try again once it is`, 503);
    }
    for (const f of sidecars) {
      if (!deletion.insideLibrary(f)) continue;
      require('fs').rmSync(f, { force: true });
      require('fs').rmSync(`${f}.bak`, { force: true });
    }
    for (const f of files) deletion.removeEmptyReleaseFolder(f);
  }

  let release = null;
  for (const m of members) {
    const row = m.row;
    release ??= row.release_title || null;
    deletion.forgetFile(m.kind, m.id);
    if (m.kind === 'episode' && row.release_title) require('./shownames').unlearn(m.show, row.release_title);
    const rejected = parseList(row.rejected_releases);
    if (row.magnet && !rejected.some(r => r.magnet === row.magnet)) {
      rejected.push({ magnet: row.magnet, title: row.release_title || null, reason, at: new Date().toISOString(), by });
    }
    const tried = parseList(row.tried_magnets);
    if (row.magnet && !tried.includes(row.magnet)) tried.push(row.magnet);
    (m.kind === 'movie' ? movies : episodes).update(m.id, {
      ...RESET, tried_magnets: JSON.stringify(tried), rejected_releases: JSON.stringify(rejected),
      last_error: `Replacing the wrong pack: ${reason}`,
    });
  }
  log.info(`wrong pack replaced${by ? ` by ${by}` : ''}${release ? ` — "${release}"` : ''} (${reason}): `
    + `${members.length} items; ${ours ? 'torrent removed with its files' : 'torrent was already in Transmission — left as it was'}; looking for others`,
  { type: kind, id });
  setImmediate(() => require('./scheduler').run().catch(() => {}));
  return { removed: ours ? 'torrent removed with its files' : 'left in Transmission', release, count: members.length };
}

module.exports = { replaceDownload, replacePack, packOf, RESET };
