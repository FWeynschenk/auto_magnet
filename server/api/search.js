'use strict';

const express  = require('express');
const router   = express.Router();
const { searchMulti, getMovieDetails, getTvDetails } = require('../tmdb');
const { findCandidates } = require('../pipeline');
const { remember, recall } = require('../search-cache');
const { settings, movies, shows, episodes } = require('../db');
const { addTorrent } = require('../transmission');
const { showDir } = require('../paths');
const { afterAdd, verdictHandler } = require('../quarantine');
const log = require('../log');

/** How long a stored candidate list is served without re-searching. */
function cacheTtlMs() {
  const mins = parseInt(settings.get('search_cache_mins') || '20');
  return Math.max(0, Number.isFinite(mins) ? mins : 20) * 60 * 1000;
}

function itemRow(movieId, episodeId) {
  if (movieId)   return { kind: 'movie',   row: movies.byId(movieId),     store: movies,   id: movieId };
  if (episodeId) return { kind: 'episode', row: episodes.byId(episodeId), store: episodes, id: episodeId };
  return null;
}

/** Parsed candidate list for an item, or null when absent/stale/malformed. */
function readCache(target, { ignoreAge = false } = {}) {
  const row = target?.row;
  if (!row?.results_cache) return null;

  let parsed;
  try { parsed = JSON.parse(row.results_cache); } catch (_) { return null; }
  if (!Array.isArray(parsed)) return null;

  // Anything the user can click must be immediately grabbable. Caches written
  // before the magnet-always guarantee may still hold download-URL-only rows.
  const usable = parsed.filter(r => r?.magnet);
  if (usable.length === 0) return null;

  const at = row.results_cached_at ? Date.parse(row.results_cached_at) : NaN;
  const age = Number.isFinite(at) ? Date.now() - at : null;
  if (!ignoreAge && age !== null && age > cacheTtlMs()) return null;
  // A cache with no timestamp predates this field; serve it but mark it unknown.
  return { results: usable, age };
}

function writeCache(target, results) {
  if (!target?.row) return;
  target.store.update(target.id, {
    results_cache:     JSON.stringify(results),
    results_cached_at: new Date().toISOString(),
  });
}

/**
 * Remember a candidate's file list so a later grab can screen it without going
 * back to any indexer. Keyed by infohash (falling back to the magnet) rather
 * than by item, so it works for hand-typed searches too, which deliberately
 * never touch the item's own cache.
 */
function registerFiles(rows) {
  for (const r of rows) {
    if (!r.files?.length) continue;
    const key = r.info_hash ? `files:${String(r.info_hash).toLowerCase()}` : `files:${r.magnet}`;
    remember(key, r.files);
  }
}

function recallFiles(torrent) {
  const hash = torrent.info_hash ? String(torrent.info_hash).toLowerCase() : null;
  return (hash && recall(`files:${hash}`)) || recall(`files:${torrent.magnet}`) || null;
}

/**
 * Strip the file list before sending to the client. It is only needed
 * server-side (for screening at grab time) and can run to hundreds of entries.
 */
function forClient(r) {
  const { files, ...rest } = r;
  return { ...rest, file_count: files?.length || 0 };
}

// TMDB type-ahead for the Add dialog
router.get('/tmdb', async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  try {
    res.json(await searchMulti(q));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ranked, ready-to-grab candidates for a title.
//
// Served from the item's stored candidate list when one is fresh, so reopening
// the dialog — or opening it just after the scheduler ran — costs nothing.
router.post('/preview', async (req, res) => {
  const {
    tmdb_id, type, season, episode: ep,
    quality = '1080p', movie_id, episode_id,
    refresh = false, limit = 20, query,
  } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });

  const target  = itemRow(movie_id, episode_id);
  const custom  = typeof query === 'string' ? query.trim() : '';
  const maxRows = Math.min(Number(limit) || 20, 50);

  // A hand-typed search is an escape hatch, not the item's canonical list: it
  // neither reads nor overwrites the stored candidates, so clearing the box
  // puts the automatic list back instantly.
  if (custom) {
    try {
      const { accepted, rejected } = await findCandidates({
        type, query: custom, quality, limit: maxRows, refresh,
      });
      registerFiles(accepted);
      return res.json({
        results:  accepted.map(forClient),
        rejected: rejected.slice(0, 40).map(forClient),
        cached:   false,
        cache_age_ms: 0,
        query:    custom,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (!tmdb_id) return res.status(400).json({ error: 'tmdb_id required' });

  if (!refresh) {
    const cached = readCache(target);
    if (cached) {
      registerFiles(cached.results);
      return res.json({
        results:   cached.results.map(forClient),
        rejected:  [],
        cached:    true,
        cache_age_ms: cached.age,
      });
    }
  }

  try {
    let title, imdbId, year = null, identity = {};
    if (type === 'movie') {
      const d = await getMovieDetails(tmdb_id);
      if (!d) return res.status(404).json({ error: 'Not found on TMDB' });
      ({ title, imdb_id: imdbId, year } = d);
    } else {
      const d = await getTvDetails(tmdb_id);
      if (!d) return res.status(404).json({ error: 'Not found on TMDB' });
      ({ title, imdb_id: imdbId } = d);
      const tracked = shows.all().find(s => Number(s.tmdb_id) === Number(tmdb_id));
      identity = {
        firstAirYear: d.first_air_year || null,
        countries: String(d.origin_country || '').split(',').filter(Boolean),
        originalTitle: d.original_title || null,
        variants: tracked ? require('../shownames').accepted(tracked) : [],
      };
    }

    const exclude = (() => {
      try { return JSON.parse(target?.row?.tried_magnets || '[]'); } catch (_) { return []; }
    })();

    // Marked wrong for this item: shown among the filtered, never offered.
    const wrong = (() => {
      try { return JSON.parse(target?.row?.rejected_releases || '[]').map(r => r.magnet).filter(Boolean); } catch (_) { return []; }
    })();
    const { accepted, rejected } = await findCandidates({
      type, title, year, imdbId, tmdbId: tmdb_id,
      season: season ?? null, episode: ep ?? null,
      quality, exclude, wrong, limit: maxRows, refresh, ...identity,
    });

    // Persist so the next open — and the grab itself — need no further searching.
    if (accepted.length > 0) writeCache(target, accepted);
    registerFiles(accepted);

    res.json({
      results:  accepted.map(forClient),
      rejected: rejected.slice(0, 40).map(forClient),
      cached:   false,
      cache_age_ms: 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Look up the server-side file list for a torrent the client is handing back. */
function knownFiles(target, torrent) {
  const cached = readCache(target, { ignoreAge: true });
  if (!cached) return null;
  const hash = torrent.info_hash ? String(torrent.info_hash).toLowerCase() : null;
  const match = cached.results.find(r =>
    (hash && String(r.info_hash || '').toLowerCase() === hash) || r.magnet === torrent.magnet);
  return match?.files?.length ? match.files : null;
}

// Grab a specific torrent result (manual-mode confirm).
//
// This responds as soon as Transmission has the torrent. When the contents are
// already known the content screen runs inline and costs nothing; when only a
// magnet is available, screening continues in the background and the item is
// flagged (and the torrent purged) if it turns out to be junk. Either way the
// user is never made to wait on an indexer or on magnet metadata.
router.post('/grab', async (req, res) => {
  const { torrent, media_id, media_type, season, episode: ep } = req.body;
  const torrentUrl = torrent?.magnet || torrent?.download_url;
  if (!torrentUrl) return res.status(400).json({ error: 'torrent.magnet or torrent.download_url required' });
  if (!media_id)   return res.status(400).json({ error: 'media_id required' });

  const isMovie = media_type === 'movie';

  try {
    const startedAt = new Date().toISOString();

    let target, downloadDir, screenType, txTarget = null;
    if (isMovie) {
      target      = itemRow(media_id, null);
      if (!target.row) return res.status(404).json({ error: 'Movie not found' });
      downloadDir = settings.get('movie_path');
      screenType  = 'movie';
      txTarget    = target.row.transmission_target;
    } else {
      const show = shows.byId(media_id);
      if (!show) return res.status(404).json({ error: 'Show not found' });
      const epSeason  = season || 1;
      const epEpisode = ep     || 1;
      let row = episodes.get(media_id, epSeason, epEpisode);
      if (!row) {
        episodes.insert({ show_id: media_id, season: epSeason, episode: epEpisode, status: 'pending' });
        row = episodes.get(media_id, epSeason, epEpisode);
      }
      target      = { kind: 'episode', row, store: episodes, id: row.id };
      downloadDir = showDir(show);
      screenType  = 'show';
      txTarget    = show.transmission_target;
    }

    const files = torrent.files?.length
      ? torrent.files
      : (knownFiles(target, torrent) || recallFiles(torrent));

    if (require('../diskguard').isLow(txTarget)) {
      return res.status(409).json({ error: 'The download disk is nearly full — downloads are paused until there is room (Settings → Library → Keep free for downloads)' });
    }
    // Picking a release for something already downloaded (or downloading)
    // replaces that download: its file, web version and the rest go first,
    // so nothing of the old one can play or mix into the new one.
    const current = target.store.byId(target.id);
    if (current && ['done', 'downloading'].includes(current.status) && current.magnet !== torrentUrl) {
      await require('../replace').replaceDownload(target.kind, Number(target.id), {
        reason: 'another release picked by hand', wrong: false, search: false, by: req.user?.username,
      });
    }
    const result = await addTorrent(torrentUrl, downloadDir, {
      // A hand-picked row may well be a pack the user chose on purpose, so the
      // single-episode file-count rule must not second-guess them here.
      screen: { type: screenType, title: torrent.title, allowPacks: true },
      files,
      target: txTarget,
      // Same verdict handling as the scheduler: a failed screen puts the item
      // back to pending with the magnet excluded, rather than the dead-end
      // 'failed' this endpoint used to leave it in.
      onVerdict: verdictHandler(txTarget),
    });

    target.store.update(target.id, {
      status: 'downloading', magnet: torrentUrl, torrent_id: result.id, release_title: torrent.title || null,
      results_cache: null, results_cached_at: null,
      download_started_at: startedAt,
      ...afterAdd(result),
    });

    log.info(
      `grabbed by hand: ${torrent.title || torrentUrl.slice(0, 60)}`,
      { type: target.kind, id: target.id },
    );
    // Someone looked: the way this release writes the show's name is right.
    if (target.kind === 'episode' && torrent.title) {
      const sh = shows.byId(target.row.show_id);
      if (sh) require('../shownames').learnPicked(sh, torrent.title);
    }
    // Its progress now, not at the next hourly run: a torrent Transmission
    // already had may well be complete.
    setTimeout(() => require('../scheduler').quickSync().catch(() => {}), 3000);

    res.json({
      success:     true,
      torrent_id:  result.id,
      // True when it is held throttled until its file list has been checked.
      quarantined: !!result.quarantined,
      duplicate:   !!result.duplicate,
    });
  } catch (err) {
    // A content-screen rejection is a client-actionable 422, not a server fault
    if (err.screened) {
      log.warn(`grab blocked: ${err.message}`, { type: isMovie ? 'movie' : 'episode', id: media_id });
      return res.status(422).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
