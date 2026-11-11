'use strict';

const { torrentRef, lowerHash } = require('./torrentref');

// Everything between "handed to Transmission" and "trusted": recording content
// screen verdicts, and the sweeps that finish any screening a grab-time watcher
// didn't.
//
// Verdicts arrive late by design — a magnet's file list only exists once peers
// have supplied it — so the three places that learn one (the manual grab, the
// scheduler, and the sweeps) all record it through here and treat it the same.

const { movies, episodes, settings } = require('./db');
const { screenFiles } = require('./screen');
const tx  = require('./transmission');
const log = require('./log');

const DEFAULT = 'default';

const storeFor = (kind) => (kind === 'movie' ? movies : episodes);

function parseList(json) {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}

/**
 * Rows currently downloading this torrent on this instance. Ids restart at 1
 * on every Transmission, so the instance has to match as well as the id.
 */
function rowsForTorrent(targetName, torrent) {
  const want = targetName || DEFAULT;
  // By hash: Transmission renumbers its torrents when it restarts, so an id
  // alone can name another download. Rows recorded before hashes were kept
  // can still only be found by id.
  const t = typeof torrent === 'object' && torrent !== null ? torrent : { id: torrent };
  const hash = lowerHash(t.hash || t.hashString);
  const refs = [hash, t.id].filter(v => v !== null && v !== undefined);
  const out = [], seen = new Set();
  for (const ref of refs) {
    for (const m of movies.byTorrent(ref)) {
      if ((m.transmission_target || DEFAULT) === want && !seen.has(`m${m.id}`)) { seen.add(`m${m.id}`); out.push({ kind: 'movie', id: m.id, row: m }); }
    }
    for (const e of episodes.byTorrent(ref)) {
      if ((e.show_target || DEFAULT) === want && !seen.has(`e${e.id}`)) { seen.add(`e${e.id}`); out.push({ kind: 'episode', id: e.id, row: e }); }
    }
  }
  return out;
}

/**
 * Record a verdict against every row holding the torrent.
 *
 *   pass     screened_at set; any warnings kept on the card
 *   fail     back to pending with that magnet excluded, so the next run tries
 *            the next candidate; the reason stays on the card
 *   pending  a note that it is waiting in quarantine
 */
function recordVerdict(rows, verdict, { label = 'Blocked by content screen' } = {}) {
  const now = new Date().toISOString();

  for (const { kind, id, row } of rows) {
    const store = storeFor(kind);

    if (verdict.pending) {
      store.update(id, {
        last_error: 'In quarantine — waiting for its file list before it is allowed to download',
      });
      continue;
    }

    if (!verdict.ok) {
      const tried = parseList(row.tried_magnets);
      if (row.magnet) tried.push(row.magnet);
      store.update(id, {
        status: 'pending', magnet: null, torrent_id: null, torrent_hash: null, progress: 0,
        tried_magnets: JSON.stringify(tried), download_started_at: null, screened_at: null,
        completed_at: null, post_processed_at: null, subs_state: null,
        last_error: `${label}: ${verdict.reason}`,
      });
      log.warn(`${label.toLowerCase()}: ${verdict.reason}`, { type: kind, id });
      continue;
    }

    const note = verdict.warnings?.length ? verdict.warnings.join('; ') : null;
    store.update(id, { screened_at: now, last_error: note });
    log.info(`contents verified${note ? ` — ${note}` : ''}`, { type: kind, id });
  }
}

/**
 * Row fields that follow a successful add, whichever route it took. Only a
 * verified add counts as checked; a quarantined one gets its screened_at when
 * the verdict lands, and a duplicate is somebody else's torrent entirely.
 */
function afterAdd(result) {
  const torrent_origin = result.duplicate ? 'duplicate' : 'added';
  if (result.verified) {
    return {
      torrent_origin,
      screened_at: new Date().toISOString(),
      last_error:  result.warnings?.length ? result.warnings.join('; ') : null,
    };
  }
  if (result.quarantined) {
    return {
      torrent_origin,
      screened_at: null,
      last_error:  'In quarantine — waiting for its file list before it is allowed to download',
    };
  }
  if (result.duplicate) {
    return { torrent_origin, screened_at: null, last_error: 'Already in Transmission — left exactly as it was' };
  }
  return { torrent_origin, screened_at: null, last_error: null };
}

/** The `onVerdict` every caller of addTorrent passes for a quarantined add. */
function verdictHandler(targetName) {
  return (verdict, torrent) => {
    try {
      recordVerdict(rowsForTorrent(targetName, torrent), verdict);
    } catch (err) {
      console.error('[quarantine] recording verdict failed:', err.message);
    }
  };
}

/**
 * Finish screening everything still in quarantine.
 *
 * Runs at startup and at the start of every scheduler run, so a restart
 * mid-screen — or a magnet whose metadata took hours — is never left in limbo.
 * The label lives in Transmission, not in this process, which is what makes
 * that restart-safe.
 */
async function sweepQuarantine() {
  const held = await tx.listQuarantined();
  if (held.length === 0) return { checked: 0 };

  const holdHours = Math.max(1, parseInt(settings.get('quarantine_hold_hours') || '24'));
  const tally = { released: 0, blocked: 0, expired: 0, waiting: 0 };

  for (const t of held) {
    const target = tx.resolveTarget(t.target);
    const rows   = rowsForTorrent(t.target, t);
    const ref    = t.hash || t.id;
    const isShow = rows.some(r => r.kind === 'episode');
    // allowPacks only relaxes the "this looks like a pack" rules, never the
    // safety ones, so relaxing it for shows here costs nothing.
    const opts = { type: isShow ? 'show' : 'movie', allowPacks: isShow, target };

    let verdict;
    try {
      verdict = await tx.screenOnce(ref, opts);
    } catch (err) {
      console.warn(`[quarantine] #${t.id} on "${t.target}": ${err.message}`);
      continue;
    }

    if (verdict.pending) {
      const ageHours = (Date.now() / 1000 - t.addedDate) / 3600;
      if (ageHours < holdHours) { tally.waiting++; continue; }
      // Nothing has supplied a file list in all this time: nobody is seeding it.
      try { await tx.purgeTorrent(ref, target); } catch (_) {}
      verdict = { ok: false, reason: `no file list after ${holdHours}h — nothing is seeding it` };
      tally.expired++;
    } else if (verdict.ok) {
      tally.released++;
    } else {
      tally.blocked++;
    }
    recordVerdict(rows, verdict);
  }

  if (tally.released || tally.blocked || tally.expired) {
    log.info(
      `quarantine sweep: ${tally.released} released, ${tally.blocked} blocked, ` +
      `${tally.expired} expired, ${tally.waiting} still waiting`,
    );
  }
  return { checked: held.length, ...tally };
}

/**
 * Screen torrents we track as downloading that were never checked: every
 * magnet grabbed before the quarantine existed, plus any grab that turned out
 * to be a duplicate of something already in Transmission.
 *
 * A failure here *stops* the torrent and flags the item — it never deletes.
 * These may be partly or wholly downloaded, possibly started by hand, and a
 * pause can be undone where a purge cannot.
 */
async function sweepUnscreened() {
  const tracked = [
    ...movies.unscreened().map(r => ({ kind: 'movie',   id: r.id, row: r, target: r.transmission_target || DEFAULT })),
    ...episodes.unscreened().map(r => ({ kind: 'episode', id: r.id, row: r, target: r.show_target || DEFAULT })),
  ];
  if (tracked.length === 0) return;

  // One screen per torrent — a season pack is many rows but one download.
  const groups = new Map();
  for (const t of tracked) {
    const ref = torrentRef(t.row);
    const key = `${t.target}:${ref}`;
    if (!groups.has(key)) groups.set(key, { target: t.target, torrentId: ref, rows: [] });
    groups.get(key).rows.push(t);
  }

  // Anything labelled is the quarantine sweep's job.
  const labelled = new Set((await tx.listQuarantined()).flatMap(q => [`${q.target}:${q.id}`, `${q.target}:${q.hash}`]));

  for (const [key, { target: targetName, torrentId, rows }] of groups) {
    if (labelled.has(key)) continue;

    const target = tx.resolveTarget(targetName);
    let files;
    try { files = await tx.getTorrentFiles(torrentId, target); } catch (_) { continue; }
    if (!files) continue; // no metadata yet, or gone — try again next run

    const isShow  = rows.some(r => r.kind === 'episode');
    const verdict = screenFiles(files, { type: isShow ? 'show' : 'movie', allowPacks: isShow });
    const now     = new Date().toISOString();

    if (verdict.ok) {
      for (const r of rows) storeFor(r.kind).update(r.id, { screened_at: now });
      continue;
    }

    try { await tx.stopTorrent(torrentId, target); } catch (_) {}
    for (const r of rows) {
      storeFor(r.kind).update(r.id, {
        // Marked checked so a torrent you deliberately resume isn't stopped again.
        screened_at: now,
        last_error: `Failed the content screen and was stopped (not deleted): ${verdict.reason}`,
      });
      log.warn(`stopped an unscreened download: ${verdict.reason}`, { type: r.kind, id: r.id });
    }
  }
}

module.exports = { afterAdd, recordVerdict, verdictHandler, rowsForTorrent, sweepQuarantine, sweepUnscreened };
