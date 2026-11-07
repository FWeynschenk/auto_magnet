'use strict';

// Removing originals once they have seeded enough, keeping only the web
// version. Opt-in: Settings → Playback → "Remove originals after seeding".
//
// A repackaged or converted item is on disk twice: the original, which
// Transmission seeds, and the web version the players use. Once the torrent
// has given back enough, the original has done its job and can go.
//
// A torrent qualifies only when all of this holds:
//   - it has finished, and reached the upload ratio — or, when a day limit is
//     set, has seeded that long;
//   - it wasn't already in Transmission before auto_magnet asked for it
//     (torrent_origin 'duplicate' is the user's own download);
//   - EVERY video file in it is a library item whose web version is complete
//     and whose plan the setting allows. A pack with one episode still
//     converting, or a video in it that nothing tracks, keeps the whole torrent.
// Direct-play files never qualify: there is no second copy to fall back on.
//
// Subtitles are converted to WebVTT and kept with the web version first, since
// sidecar files and embedded tracks go with the original.

const fs   = require('fs');
const path = require('path');

const { db, settings } = require('./db');
const media = require('./media');
const { mapPath } = require('./paths');
const { subsRetryPending } = require('./postprocess');
const log = require('./log');

const PLANS = { off: [], remux: ['remux'], all: ['remux', 'transcode'] };

function policy() {
  const plans = PLANS[settings.get('seed_cleanup')] || [];
  const ratio = Number(settings.get('seed_cleanup_ratio'));
  const days  = Number(settings.get('seed_cleanup_days'));
  return {
    plans,
    ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 2,
    days:  Number.isFinite(days) && days > 0 ? days : 0,
  };
}

/**
 * Why a web version can't yet stand in for its original, or null if it can.
 * `rebuild` marks one that is finished but older than multi-track audio: it
 * holds one audio track of several, and is rebuilt so the rest are kept.
 */
function webIssue(row) {
  // Not made yet: repackaged copies are made when played, so one may never
  // have been. Removing the original needs it, so it is made now.
  if (row.web_state !== 'ready' || !media.hlsComplete(row.kind, row.item_id)) return { reason: 'has no finished web version', prepare: true };
  if (!media.webHasAllAudio(row)) return { reason: 'has a web version without every audio track', rebuild: true };
  return null;
}

const key = (p) => path.resolve(p);

/**
 * Whether a torrent's originals may be removed. Pure apart from the
 * `webIssue` check, so the rules can be tested without Transmission.
 *
 * @param torrent  getSeedInfo() result, or null when Transmission no longer has it
 * @param rows     media rows of the library items downloaded by this torrent
 * @returns {{ ok: boolean, reason: string, rows?: object[], rebuild?: object[] }}
 */
function decide(torrent, rows, pol, { toLocal = mapPath, check = webIssue, subsPending = subsRetryPending } = {}) {
  if (!torrent) return { ok: false, reason: 'no longer in Transmission' };
  if (!(torrent.percentDone >= 1)) return { ok: false, reason: 'still downloading' };
  if (rows.some(r => r.torrent_origin === 'duplicate')) return { ok: false, reason: 'was already in Transmission' };

  const byRatio = torrent.uploadRatio >= pol.ratio;
  const byTime  = pol.days > 0 && torrent.secondsSeeding >= pol.days * 86400;
  if (!byRatio && !byTime) {
    return { ok: false, reason: `ratio ${torrent.uploadRatio.toFixed(2)} of ${pol.ratio}` };
  }

  // Files dropped from the torrent (an episode deleted from a pack) are gone
  // from disk and from the library: they don't hold the rest back.
  const videos = media.videoFilesIn(torrent.files).filter(f => f.wanted !== false);
  if (videos.length === 0) return { ok: false, reason: 'no video files' };
  const byPath = new Map(rows.map(r => [key(r.path), r]));
  const covered = [], rebuild = [], prepare = [];
  for (const f of videos) {
    const r = byPath.get(key(toLocal(path.join(torrent.downloadDir, f.name))));
    if (!r) return { ok: false, reason: `${f.name} isn't in the library` };
    if (r.original_removed_at) continue;
    if (!pol.plans.includes(r.plan)) return { ok: false, reason: `${f.name} plays as ${r.plan}` };
    // A subtitle found on a later try is saved beside the original.
    if (subsPending(r)) return { ok: false, reason: `${f.name} is still waiting for subtitles` };
    const issue = check(r);
    if (issue?.prepare) { prepare.push(r); continue; }
    if (issue && !issue.rebuild) return { ok: false, reason: `${f.name} ${issue.reason}` };
    if (issue) rebuild.push(r);
    covered.push(r);
  }
  if (prepare.length) return { ok: false, reason: 'making the web versions first', prepare, rebuild };
  if (rebuild.length) return { ok: false, reason: 'rebuilding web versions to keep every audio track', rebuild };
  if (covered.length === 0) return { ok: false, reason: 'already removed' };
  return {
    ok: true,
    reason: byRatio ? `ratio ${torrent.uploadRatio === Infinity ? '∞' : torrent.uploadRatio.toFixed(2)}`
      : `seeded ${Math.floor(torrent.secondsSeeding / 86400)} days`,
    rows: covered,
  };
}

/** Finished items with a torrent, with their media rows, grouped per torrent. */
function torrentGroups() {
  const items = db.prepare(`
    SELECT 'movie' AS kind, m.id, m.torrent_id, m.torrent_origin, m.transmission_target AS target,
           m.completed_at, m.post_processed_at, m.subs_state, m.subs_checked_at
      FROM movies m WHERE m.status = 'done' AND m.torrent_id IS NOT NULL
    UNION ALL
    SELECT 'episode' AS kind, e.id, e.torrent_id, e.torrent_origin, s.transmission_target AS target,
           e.completed_at, e.post_processed_at, e.subs_state, e.subs_checked_at
      FROM episodes e JOIN shows s ON s.id = e.show_id WHERE e.status = 'done' AND e.torrent_id IS NOT NULL
  `).all();
  const groups = new Map();
  for (const it of items) {
    const row = media.rows.get(it.kind, it.id);
    if (!row) continue;
    const k = `${it.target || ''}:${it.torrent_id}`;
    if (!groups.has(k)) groups.set(k, { target: it.target || null, torrentId: it.torrent_id, rows: [] });
    groups.get(k).rows.push({
      ...row, torrent_origin: it.torrent_origin, completed_at: it.completed_at,
      post_processed_at: it.post_processed_at, subs_state: it.subs_state, subs_checked_at: it.subs_checked_at,
    });
  }
  return [...groups.values()];
}

/** Convert and keep every subtitle a player can show; returns what was kept. */
async function keepSubtitles(row) {
  const kept = [], files = [];
  for (const s of media.listSubtitles(row)) {
    if (s.source === 'file') files.push(s.file);
    if (!s.available) continue;
    try {
      await media.vttFor(row, s.id);
      const { file, stream, ...rest } = s;
      kept.push(rest);
    } catch (err) {
      log.warn(`subtitle ${s.label} not kept: ${err.message}`, { type: row.kind, id: row.item_id });
    }
  }
  return { kept, files };
}

/** Remove one torrent's originals. Returns true if it went. */
async function removeOriginals(group, torrent, decision, tx) {
  const now = new Date().toISOString();
  const sidecars = [];
  // Mark first: should the process stop between the purge and the mark, the
  // player must not go looking for the original and drop the row as missing.
  for (const r of decision.rows) {
    const { kept, files } = await keepSubtitles(r);
    sidecars.push(...files);
    media.rows.update(r.kind, r.item_id, { original_removed_at: now, subs_snapshot: JSON.stringify(kept) });
  }
  try {
    await tx.purgeTorrent(torrent.id, tx.resolveTarget(group.target));
  } catch (err) {
    for (const r of decision.rows) media.rows.update(r.kind, r.item_id, { original_removed_at: null, subs_snapshot: null });
    log.warn(`could not remove the seeded torrent: ${err.message}`, { type: decision.rows[0].kind, id: decision.rows[0].item_id });
    return false;
  }

  // Transmission deletes the torrent's own files; subtitles fetched or
  // re-timed later sit beside them and would otherwise be left behind.
  for (const f of sidecars) {
    fs.rmSync(f, { force: true });
    fs.rmSync(`${f}.bak`, { force: true });
  }
  const root = (k) => key(mapPath(String(settings.get(k) || '').replace(/\/+$/, '')));
  const moviesRoot = root('movie_path'), showsRoot = root('shows_path');
  for (const r of decision.rows) {
    const dir = key(path.dirname(r.path));
    // Only a release folder of its own; never a show folder or a library root.
    if (dir === moviesRoot || dir === showsRoot || key(path.dirname(dir)) === showsRoot) continue;
    try { fs.rmdirSync(dir); } catch (_) { /* not empty, or already gone */ }
  }

  const freed = decision.rows.reduce((a, r) => a + (r.size || 0), 0);
  for (const r of decision.rows) {
    log.info(`original removed after seeding (${decision.reason}); the web version stays`, { type: r.kind, id: r.item_id });
  }
  log.info(`seed cleanup: removed "${torrent.name}" — ${(freed / 1e9).toFixed(1)} GB freed`);
  return true;
}

/** Remove every original that qualifies. Run at the end of each scheduler pass. */
async function sweepSeeded({ tx = require('./transmission') } = {}) {
  const pol = policy();
  if (pol.plans.length === 0) return { removed: 0 };
  let removed = 0;
  for (const group of torrentGroups()) {
    // Only ask Transmission about torrents that could possibly qualify.
    if (!group.rows.some(r => !r.original_removed_at && pol.plans.includes(r.plan))) continue;
    let torrent;
    try { torrent = await tx.getSeedInfo(group.torrentId, tx.resolveTarget(group.target)); } catch (_) { continue; }
    const decision = decide(torrent, group.rows, pol);
    if (decision.prepare) {
      // Seeded enough: make the web versions it needs, in the background; a
      // later run removes the original once they're done.
      for (const r of decision.prepare) {
        if (!['queued', 'encoding'].includes(r.web_state)) media.enqueue(r.kind, r.item_id);
      }
      continue;
    }
    if (decision.rebuild?.length) {
      // Seeded enough, but a web version predates multi-track audio. Rebuild
      // it now; a later run removes the original once it is done.
      for (const r of decision.rebuild) {
        media.removeWebVersion(r.kind, r.item_id);
        media.rows.update(r.kind, r.item_id, { web_state: 'none', web_progress: 0, web_error: null });
        media.enqueue(r.kind, r.item_id);
        log.info('web version rebuilt to keep every audio track before the original is removed', { type: r.kind, id: r.item_id });
      }
      continue;
    }
    if (!decision.ok) continue;
    if (await removeOriginals(group, torrent, decision, tx)) removed++;
  }
  return { removed };
}

module.exports = { sweepSeeded, decide, policy, webIssue };
