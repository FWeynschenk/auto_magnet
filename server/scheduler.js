'use strict';

const { movies, shows, episodes, settings } = require('./db');
const { addTorrent, getTorrentProgress, removeTorrent, progressKey } = require('./transmission');
const { getSeasonDetails, getTvDetails } = require('./tmdb');
const { findCandidates } = require('./pipeline');
const log = require('./log');

// --- Constants ---

const STALE_DOWNLOAD_HOURS = 24;
const MAX_EPISODES_PER_RUN = 15;   // max episodes to grab per show per scheduler run
const MAX_SEASON_SCAN      = 60;   // hard ceiling when walking seasons
const RUN_DEADLINE_MINUTES = 45;   // stop starting new work past this point in a run

// --- Air date check ---

/**
 * Returns true if the content has aired (past the configurable buffer).
 * Treats missing air_date as "available" so content without metadata isn't skipped.
 */
function hasAired(airDate) {
  if (!airDate) return true;
  const bufferHours = Math.max(0, parseInt(settings.get('air_date_buffer_hours') || '2'));
  // Use end-of-day UTC on the air date as the base time
  const base = new Date(airDate + 'T23:59:00Z').getTime();
  return base + bufferHours * 3600 * 1000 <= Date.now();
}

/**
 * Smarter aired check: if any later episode in the same season has a confirmed past
 * air date, all preceding episodes are also considered aired — even if TMDB hasn't
 * populated their individual dates yet.
 */
function effectivelyAired(epNumber, seasonEpisodes) {
  const latestConfirmed = (seasonEpisodes || [])
    .filter(e => e.air_date && hasAired(e.air_date))
    .reduce((max, e) => Math.max(max, e.episode_number), 0);
  if (epNumber <= latestConfirmed) return true;

  const ep = (seasonEpisodes || []).find(e => e.episode_number === epNumber);
  return hasAired(ep?.air_date ?? null);
}

// --- Episode sync ---
//
// TMDB is the authority on which episodes exist. Sync mirrors that into the
// episodes table and owns the aired/unaired decision; the grab phase then just
// works through whatever is 'pending'. Nothing here ever invents an episode
// number, which is what used to cause searches for seasons that don't exist.

/** Statuses sync must never overwrite — they represent work already done. */
const SYNC_PROTECTED = new Set(['downloading', 'done', 'failed', 'skipped']);

/**
 * Upsert every episode TMDB knows about, from the show's configured start point
 * to the end of the series. Returns { added, updated, seasons }.
 */
async function syncEpisodes(show, fetchSeason) {
  const startSeason  = show.start_season  || 1;
  const startEpisode = show.start_episode || 1;

  const existing = new Map(
    episodes.forShow(show.id).map(e => [`${e.season}x${e.episode}`, e])
  );

  let added = 0, updated = 0, seasonsSeen = 0;

  // Walk seasons until one doesn't exist. Look one past the last real season so a
  // freshly announced next season is picked up; negative lookups are cached.
  const lastKnown = show.number_of_seasons || null;
  const ceiling   = lastKnown
    ? Math.min(lastKnown + 1, startSeason + MAX_SEASON_SCAN)
    : startSeason + MAX_SEASON_SCAN;

  for (let s = startSeason; s <= ceiling; s++) {
    const season = await fetchSeason(s);
    if (!season || season.episode_count === 0) {
      // Season doesn't exist — stop, unless we haven't seen any season yet and
      // are still within a small probe window (handles odd numbering).
      if (seasonsSeen > 0) break;
      if (s >= startSeason + 2) break;
      continue;
    }
    seasonsSeen++;

    for (const ep of season.episodes) {
      if (s === startSeason && ep.episode_number < startEpisode) continue;

      const key  = `${s}x${ep.episode_number}`;
      const row  = existing.get(key);
      const airs = ep.air_date || null;
      const aired = effectivelyAired(ep.episode_number, season.episodes);

      if (!row) {
        episodes.insert({
          show_id:  show.id,
          season:   s,
          episode:  ep.episode_number,
          status:   aired ? 'pending' : 'upcoming',
          magnet:   null,
          torrent_id: null,
          air_date: airs,
        });
        added++;
        continue;
      }

      if (SYNC_PROTECTED.has(row.status)) {
        // Only keep the air date honest; never resurrect finished work
        if (row.air_date !== airs) { episodes.update(row.id, { air_date: airs }); updated++; }
        continue;
      }

      const changes = {};
      if (row.air_date !== airs) changes.air_date = airs;
      if (row.status === 'upcoming' && aired) changes.status = 'pending';
      if (row.status === 'pending' && !aired) changes.status = 'upcoming';
      if (Object.keys(changes).length > 0) { episodes.update(row.id, changes); updated++; }
    }
  }

  return { added, updated, seasons: seasonsSeen };
}

/** Refresh cached TMDB metadata on the show row (season count, ended/returning). */
async function syncShowMeta(show) {
  const details = await getTvDetails(show.tmdb_id);
  if (!details) return show;

  const changes = {};
  if (details.number_of_seasons !== show.number_of_seasons) {
    changes.number_of_seasons = details.number_of_seasons;
  }
  if (details.show_status && details.show_status !== show.show_status) {
    changes.show_status = details.show_status;
  }
  if (details.imdb_id && !show.imdb_id) changes.imdb_id = details.imdb_id;

  if (Object.keys(changes).length > 0) {
    shows.update(show.id, changes);
    return { ...show, ...changes };
  }
  return show;
}

// --- Transmission sync ---

/** Episodes don't carry an instance of their own — they follow their show. */
const _showTargetCache = new Map();
function episodeTarget(ep) {
  if (!_showTargetCache.has(ep.show_id)) {
    _showTargetCache.set(ep.show_id, shows.byId(ep.show_id)?.transmission_target || null);
  }
  return _showTargetCache.get(ep.show_id);
}

function isStale(startedAt) {
  if (!startedAt) return false;
  return Date.now() - new Date(startedAt).getTime() > STALE_DOWNLOAD_HOURS * 3600 * 1000;
}

async function syncDownloading() {
  _showTargetCache.clear();
  try {
    const progressMap = await getTorrentProgress();
    if (progressMap.size === 0) return;

    for (const movie of movies.downloading()) {
      const t = progressMap.get(progressKey(movie.transmission_target, movie.torrent_id));
      if (!t) continue;
      if (t.done) {
        // Clear last_error too: a completed download makes the previous
        // rejection history, not a standing warning on the card.
        movies.update(movie.id, { status: 'done', progress: 100, last_error: null });
        log.info(`"${movie.title}" download complete`, { type: 'movie', id: movie.id });
      } else {
        if (t.progress !== movie.progress) movies.update(movie.id, { progress: t.progress });
        if (isStale(movie.download_started_at)) {
          log.warn(`"${movie.title}" stalled for ${STALE_DOWNLOAD_HOURS}h — retrying with the next candidate`, { type: 'movie', id: movie.id });
          const tried = JSON.parse(movie.tried_magnets || '[]');
          if (movie.magnet) tried.push(movie.magnet);
          movies.update(movie.id, {
            status: 'pending', magnet: null, torrent_id: null,
            progress: 0, tried_magnets: JSON.stringify(tried), download_started_at: null,
          });
          try { await removeTorrent(movie.torrent_id, movie.transmission_target); } catch (_) {}
        }
      }
    }

    for (const ep of episodes.downloading()) {
      const t = progressMap.get(progressKey(episodeTarget(ep), ep.torrent_id));
      if (!t) continue;
      if (t.done) {
        episodes.update(ep.id, { status: 'done', progress: 100, last_error: null });
        log.info(`${epLabel(ep.season, ep.episode)} download complete`, { type: 'episode', id: ep.id });
      } else {
        if (t.progress !== ep.progress) episodes.update(ep.id, { progress: t.progress });
        if (isStale(ep.download_started_at)) {
          log.warn(`${epLabel(ep.season, ep.episode)} stalled for ${STALE_DOWNLOAD_HOURS}h — retrying`, { type: 'episode', id: ep.id });
          const tried = JSON.parse(ep.tried_magnets || '[]');
          if (ep.magnet) tried.push(ep.magnet);
          episodes.update(ep.id, {
            status: 'pending', magnet: null, torrent_id: null,
            progress: 0, tried_magnets: JSON.stringify(tried), download_started_at: null,
          });
          try { await removeTorrent(ep.torrent_id, episodeTarget(ep)); } catch (_) {}
        }
      }
    }
  } catch (err) {
    log.error(`Transmission sync failed: ${err.message}`);
  }
}

// --- Movies ---

async function runMovies(deadline) {
  for (const movie of movies.pending()) {
    if (Date.now() > deadline) { log.warn('run deadline reached — deferring the remaining movies'); return; }
    try {
      await processMovie(movie);
    } catch (err) {
      log.error(`movie "${movie.title}" failed: ${err.message}`, { type: 'movie', id: movie.id });
      movies.update(movie.id, { status: 'failed', last_error: err.message });
    }
  }
}

function parseList(json) {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v : []; }
  catch (_) { return []; }
}

async function processMovie(movie) {
  if (movie.release_date && !hasAired(movie.release_date)) {
    log.info(`"${movie.title}" not yet released (${movie.release_date}), skipping`, { type: 'movie', id: movie.id });
    return;
  }

  const quality = movie.quality || settings.get('default_quality') || '1080p';
  const search  = {
    type: 'movie', title: movie.title, year: movie.year, imdbId: movie.imdb_id,
    quality, exclude: parseList(movie.tried_magnets),
  };

  if (movie.mode === 'manual') {
    if (movie.results_cache) return; // already searched, awaiting user approval
    log.info(`"${movie.title}" (manual): searching for candidates`, { type: 'movie', id: movie.id });
    const { accepted } = await findCandidates({ ...search, limit: 20 });
    if (accepted.length > 0) {
      movies.update(movie.id, {
        results_cache: JSON.stringify(accepted),
        results_cached_at: new Date().toISOString(),
      });
      log.info(`"${movie.title}": ${accepted.length} candidate(s) awaiting your approval`, { type: 'movie', id: movie.id });
    }
    return;
  }

  log.info(`searching for "${movie.title}" (${movie.year || '?'})`, { type: 'movie', id: movie.id });
  const { accepted } = await findCandidates({ ...search, limit: 1 });
  const winner = accepted[0];
  if (!winner) {
    log.warn(`no usable result for "${movie.title}"`, { type: 'movie', id: movie.id });
    return;
  }

  const torrentUrl = winner.magnet;
  let result;
  try {
    result = await addTorrent(torrentUrl, settings.get('movie_path'), {
      screen: { type: 'movie', title: winner.title },
      files:  winner.files,
      target: movie.transmission_target,
    });
  } catch (err) {
    if (err.screened) {
      // Blocked by content screening — remember it and let the next run try the
      // next-best candidate instead of failing the movie outright.
      const tried = parseList(movie.tried_magnets);
      tried.push(torrentUrl);
      movies.update(movie.id, {
        tried_magnets: JSON.stringify(tried), results_cache: null,
        last_error: `Blocked by content screen: ${err.message}`,
      });
      log.warn(`"${movie.title}" candidate blocked: ${err.message}`, { type: 'movie', id: movie.id });
      return;
    }
    throw err;
  }

  movies.update(movie.id, {
    status: 'downloading', magnet: torrentUrl, torrent_id: result.id,
    last_error: null, download_started_at: new Date().toISOString(),
  });
  log.info(`added "${movie.title}" — ${winner.title} (${winner._quality}, ${winner.seeders} seeds)`, { type: 'movie', id: movie.id });
}

// --- Shows ---

async function runShows(deadline) {
  for (const show of shows.active()) {
    if (Date.now() > deadline) { log.warn('run deadline reached — deferring the remaining shows'); return; }
    try {
      await processShow(show, deadline);
    } catch (err) {
      log.error(`show "${show.title}" failed: ${err.message}`, { type: 'show', id: show.id });
    }
  }
}

/** Per-run memo so a show's seasons are fetched at most once per run. */
function makeSeasonFetcher(tmdbId) {
  const cache = new Map();
  return async (s) => {
    if (cache.has(s)) return cache.get(s);
    let info = null;
    try { info = await getSeasonDetails(tmdbId, s); } catch (_) {}
    cache.set(s, info);
    return info;
  };
}

async function processShow(show, deadline = Infinity) {
  const fetchSeason = makeSeasonFetcher(show.tmdb_id);

  let current = show;
  try { current = await syncShowMeta(show); } catch (_) {}

  try {
    const { added, updated } = await syncEpisodes(current, fetchSeason);
    if (added || updated) {
      log.info(`"${current.title}": synced ${added} new, ${updated} updated episode(s)`, { type: 'show', id: current.id });
    }
  } catch (err) {
    log.error(`"${current.title}" TMDB sync failed: ${err.message}`, { type: 'show', id: current.id });
  }

  // Auto-pause finished shows with nothing left outstanding
  if (['Ended', 'Canceled', 'Cancelled'].includes(current.show_status)) {
    const outstanding = episodes.pending(current.id).length
                      + episodes.upcoming(current.id).length
                      + episodes.failed(current.id).length
                      + episodes.downloading().filter(e => e.show_id === current.id).length;
    if (outstanding === 0) {
      shows.update(current.id, { active: 0 });
      log.info(`"${current.title}" is ${current.show_status} and fully grabbed — pausing`, { type: 'show', id: current.id });
      return;
    }
  }

  if (current.mode === 'manual') {
    await cacheManualPreview(current);
    return;
  }

  let grabbed = 0;

  // Packs first, biggest unit down. For a show that finished years ago the whole
  // run is often one well-seeded torrent while the individual episodes have long
  // since died — so trying series, then season, then episode is not just fewer
  // requests, it is frequently the difference between getting it and not.
  // Anything a pack doesn't cover falls through to the per-episode loop.
  if (current.prefer_season_pack) {
    try {
      if (await grabSeriesPack(current)) grabbed++;
    } catch (err) {
      log.error(`"${current.title}" series pack pass failed: ${err.message}`, { type: 'show', id: current.id });
    }
    try {
      grabbed += await grabSeasonPacks(current, deadline);
    } catch (err) {
      log.error(`"${current.title}" season pack pass failed: ${err.message}`, { type: 'show', id: current.id });
    }
  }

  for (const ep of episodes.pending(current.id)) {
    if (grabbed >= MAX_EPISODES_PER_RUN) {
      log.info(`"${current.title}": hit the per-run cap of ${MAX_EPISODES_PER_RUN}, continuing next run`, { type: 'show', id: current.id });
      break;
    }
    if (Date.now() > deadline) { log.warn(`run deadline reached during "${current.title}"`, { type: 'show', id: current.id }); break; }
    try {
      if (await grabEpisode(current, ep)) grabbed++;
    } catch (err) {
      log.error(`"${current.title}" ${epLabel(ep.season, ep.episode)} failed: ${err.message}`, { type: 'episode', id: ep.id });
      episodes.update(ep.id, { status: 'failed', last_error: err.message });
    }
  }
}

function epLabel(season, episode) {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

/**
 * Manual mode: cache candidate results for the single oldest pending episode and
 * stop. Exactly one episode is ever awaiting approval — the queue can't run away.
 */
async function cacheManualPreview(show) {
  const ep = episodes.firstPending(show.id);
  if (!ep || ep.results_cache) return;

  const label = epLabel(ep.season, ep.episode);
  log.info(`"${show.title}" ${label}: searching for candidates`, { type: 'episode', id: ep.id });

  const { accepted } = await findCandidates({
    ...episodeSearch(show, ep), limit: 20,
  });
  if (accepted.length === 0) {
    log.warn(`"${show.title}" ${label}: no candidates found`, { type: 'episode', id: ep.id });
    return;
  }
  episodes.update(ep.id, {
    results_cache: JSON.stringify(accepted),
    results_cached_at: new Date().toISOString(),
  });
  log.info(`"${show.title}" ${label}: ${accepted.length} candidate(s) awaiting your approval`, { type: 'episode', id: ep.id });
}

function episodeSearch(show, ep) {
  return {
    type:    'show',
    title:   show.title,
    imdbId:  show.imdb_id,
    season:  ep.season,
    episode: ep.episode,
    quality: show.quality || settings.get('default_quality') || '1080p',
    exclude: parseList(ep.tried_magnets),
  };
}

/**
 * Seasons that are worth asking for as a single pack.
 *
 * A pack is only safe when the season is both complete and entirely un-grabbed:
 * if anything is already downloading or done the pack would re-fetch it, and if
 * anything is still `upcoming` the season is mid-flight and no complete pack
 * exists yet.
 *
 * `failed` episodes don't block a pack — a season where individual grabs kept
 * failing is exactly when one is most useful — but they are left alone when it
 * lands, because a failed row stays terminal until Redo or Retry Failed.
 */
const PACKABLE_STATUSES = new Set(['pending', 'skipped', 'failed']);

function packableSeasons(show) {
  const pending = episodes.pending(show.id);
  const seasons = [...new Set(pending.map(e => e.season))].sort((a, b) => a - b);

  return seasons.filter(season => {
    const all = episodes.forSeason(show.id, season);
    if (all.filter(e => e.status === 'pending').length < 2) return false; // not worth a pack
    return all.every(e => PACKABLE_STATUSES.has(e.status));
  });
}

/**
 * Mark every episode a pack covers as downloading against the same torrent, so
 * progress and completion are reported for all of them together.
 */
function claimEpisodesForPack(eps, magnet, torrentId) {
  const startedAt = new Date().toISOString();
  for (const ep of eps) {
    episodes.update(ep.id, {
      status: 'downloading', magnet, torrent_id: torrentId,
      results_cache: null, results_cached_at: null, last_error: null,
      download_started_at: startedAt,
    });
  }
}

/** Record a blocked pack against every episode it would have covered. */
function rememberBlockedPack(eps, magnet) {
  for (const ep of eps) {
    const list = parseList(ep.tried_magnets);
    list.push(magnet);
    episodes.update(ep.id, { tried_magnets: JSON.stringify(list) });
  }
}

/**
 * Try to cover the entire show with one torrent.
 *
 * Only attempted when the show has finished airing and every episode of every
 * season is still outstanding — that is, a back catalogue being picked up from
 * scratch, which is exactly the case a "Complete Series" release exists for.
 * A show still in production is skipped: no complete pack exists yet, and one
 * claiming to be complete would be wrong by definition.
 */
async function grabSeriesPack(show) {
  if (!['Ended', 'Canceled', 'Cancelled'].includes(show.show_status)) return false;

  const all = episodes.forShow(show.id);
  if (all.length === 0) return false;
  if (!all.every(e => PACKABLE_STATUSES.has(e.status))) return false;

  const wanted  = all.filter(e => e.status === 'pending');
  const seasons = [...new Set(all.map(e => e.season))].sort((a, b) => a - b);
  if (seasons.length < 2 || wanted.length < 2) return false;  // a season pack covers this better

  const quality = show.quality || settings.get('default_quality') || '1080p';
  const tried   = new Set(all.flatMap(e => parseList(e.tried_magnets)));

  log.info(
    `"${show.title}": ${show.show_status} and nothing grabbed yet — looking for a complete-series pack ` +
    `(${seasons.length} seasons, ${all.length} episodes)`,
    { type: 'show', id: show.id },
  );

  const { accepted } = await findCandidates({
    type: 'show', title: show.title, imdbId: show.imdb_id,
    quality, pack: 'series', seasons, episodeCount: all.length,
    exclude: [...tried], limit: 1,
  });
  const winner = accepted[0];
  if (!winner) {
    log.info(`"${show.title}": no complete-series pack found, trying season packs`, { type: 'show', id: show.id });
    return false;
  }

  const downloadDir = `${settings.get('shows_path')}/${show.title}`;
  let result;
  try {
    result = await addTorrent(winner.magnet, downloadDir, {
      screen: { type: 'show', title: winner.title, allowPacks: true },
      files:  winner.files,
      target: show.transmission_target,
    });
  } catch (err) {
    if (err.screened) {
      rememberBlockedPack(all, winner.magnet);
      log.warn(`"${show.title}" complete-series pack blocked: ${err.message}`, { type: 'show', id: show.id });
      return false;
    }
    throw err;
  }

  claimEpisodesForPack(wanted, winner.magnet, result.id);
  log.info(
    `added "${show.title}" complete series covering ${wanted.length} episode(s) — ${winner.title} ` +
    `(${(winner.size / 1e9).toFixed(1)} GB, ${winner.seeders} seeds)`,
    { type: 'show', id: show.id },
  );
  return true;
}

/** Grab whole-season torrents where one fits. Returns the number of packs added. */
async function grabSeasonPacks(show, deadline = Infinity) {
  const quality = show.quality || settings.get('default_quality') || '1080p';
  let added = 0;

  for (const season of packableSeasons(show)) {
    if (Date.now() > deadline) break;

    const seasonEps = episodes.forSeason(show.id, season).filter(e => e.status === 'pending');
    const label     = `S${String(season).padStart(2, '0')}`;
    const tried     = new Set(seasonEps.flatMap(e => parseList(e.tried_magnets)));

    log.info(`"${show.title}" ${label}: looking for a season pack (${seasonEps.length} episodes)`,
      { type: 'show', id: show.id });

    const { accepted } = await findCandidates({
      type: 'show', title: show.title, imdbId: show.imdb_id,
      season, episode: null, quality, pack: 'season',
      episodeCount: seasonEps.length,
      exclude: [...tried], limit: 1,
    });
    const winner = accepted[0];
    if (!winner) {
      log.info(`"${show.title}" ${label}: no pack found, falling back to single episodes`,
        { type: 'show', id: show.id });
      continue;
    }

    const downloadDir = `${settings.get('shows_path')}/${show.title}`;
    let result;
    try {
      result = await addTorrent(winner.magnet, downloadDir, {
        screen: { type: 'show', title: winner.title, allowPacks: true },
        files:  winner.files,
        target: show.transmission_target,
      });
    } catch (err) {
      if (err.screened) {
        // Remember it against every episode so the next pass tries another pack
        // — or gives up on packs for this season and grabs them one by one.
        rememberBlockedPack(seasonEps, winner.magnet);
        log.warn(`"${show.title}" ${label} pack blocked: ${err.message}`, { type: 'show', id: show.id });
        continue;
      }
      throw err;
    }

    claimEpisodesForPack(seasonEps, winner.magnet, result.id);
    log.info(
      `added "${show.title}" ${label} pack covering ${seasonEps.length} episode(s) — ${winner.title}`,
      { type: 'show', id: show.id },
    );
    added++;
  }

  return added;
}

/** Search for and grab one already-aired pending episode. Returns true on success. */
async function grabEpisode(show, ep) {
  const label = epLabel(ep.season, ep.episode);

  log.info(`searching for "${show.title}" ${label}`, { type: 'episode', id: ep.id });
  const { accepted } = await findCandidates({ ...episodeSearch(show, ep), limit: 1 });
  const winner = accepted[0];
  if (!winner) {
    log.warn(`no usable result for "${show.title}" ${label}`, { type: 'episode', id: ep.id });
    return false;
  }

  const torrentUrl  = winner.magnet;
  const downloadDir = `${settings.get('shows_path')}/${show.title}`;
  let result;
  try {
    result = await addTorrent(torrentUrl, downloadDir, {
      screen: { type: 'show', title: winner.title },
      files:  winner.files,
      target: show.transmission_target,
    });
  } catch (err) {
    if (err.screened) {
      // Blocked by content screening — remember it and stay pending so the next
      // run picks the next-best candidate.
      const tried = parseList(ep.tried_magnets);
      tried.push(torrentUrl);
      episodes.update(ep.id, {
        tried_magnets: JSON.stringify(tried), results_cache: null,
        last_error: `Blocked by content screen: ${err.message}`,
      });
      log.warn(`"${show.title}" ${label} candidate blocked: ${err.message}`, { type: 'episode', id: ep.id });
      return false;
    }
    throw err;
  }

  episodes.update(ep.id, {
    status: 'downloading', magnet: torrentUrl, torrent_id: result.id,
    results_cache: null, last_error: null,
    download_started_at: new Date().toISOString(),
  });
  log.info(`added "${show.title}" ${label} — ${winner.title} (${winner._quality}, ${winner.seeders} seeds)`, { type: 'episode', id: ep.id });
  return true;
}

// --- Entry point ---

let _running = false;

async function run() {
  if (_running) { console.log('[scheduler] already running, skipping'); return; }
  _running = true;
  const startedAt = Date.now();
  const deadline  = startedAt + RUN_DEADLINE_MINUTES * 60 * 1000;
  log.info('run started');
  try {
    await runMovies(deadline).catch(err => log.error(`movies pass failed: ${err.message}`));
    await runShows(deadline).catch(err  => log.error(`shows pass failed: ${err.message}`));
    await syncDownloading();
  } finally {
    _running = false;
  }
  log.info(`run complete in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  log.prune();
}

let _scheduleTimer = null;

function scheduleNext() {
  const mins = Math.max(5, parseInt(settings.get('scheduler_interval_mins') || '60'));
  _scheduleTimer = setTimeout(async () => {
    await run().catch(err => console.error('[scheduler] run error:', err.message));
    scheduleNext();
  }, mins * 60 * 1000);
}

function start() {
  run().catch(err => console.error('[scheduler] initial run error:', err.message));
  scheduleNext();
}

module.exports = {
  start, run, hasAired, effectivelyAired,
  syncEpisodes, syncShowMeta, makeSeasonFetcher,
};
