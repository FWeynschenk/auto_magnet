'use strict';

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
  status: 'pending', magnet: null, torrent_id: null, torrent_origin: null, release_title: null,
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

module.exports = { replaceDownload, RESET };
