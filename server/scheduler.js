'use strict';

const { movies, shows, episodes, settings } = require('./db');
const { addTorrent, getTorrentProgress, removeTorrent } = require('./transmission');
const { getSeasonDetails, getTvDetails } = require('./tmdb');
const prowlarr = require('./sources/prowlarr');
const yts      = require('./sources/yts');
const eztv     = require('./sources/eztv');
const { select } = require('./selector');

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

function isStale(startedAt) {
  if (!startedAt) return false;
  return Date.now() - new Date(startedAt).getTime() > STALE_DOWNLOAD_HOURS * 3600 * 1000;
}

async function syncDownloading() {
  try {
    const progressMap = await getTorrentProgress();
    if (progressMap.size === 0) return;

    for (const movie of movies.downloading()) {
      const t = progressMap.get(movie.torrent_id);
      if (!t) continue;
      if (t.done) {
        movies.update(movie.id, { status: 'done', progress: 100 });
        console.log(`[scheduler] movie "${movie.title}" download complete`);
      } else {
        if (t.progress !== movie.progress) movies.update(movie.id, { progress: t.progress });
        if (isStale(movie.download_started_at)) {
          console.log(`[scheduler] movie "${movie.title}" stale after ${STALE_DOWNLOAD_HOURS}h, retrying`);
          const tried = JSON.parse(movie.tried_magnets || '[]');
          if (movie.magnet) tried.push(movie.magnet);
          movies.update(movie.id, {
            status: 'pending', magnet: null, torrent_id: null,
            progress: 0, tried_magnets: JSON.stringify(tried), download_started_at: null,
          });
          try { await removeTorrent(movie.torrent_id); } catch (_) {}
        }
      }
    }

    for (const ep of episodes.downloading()) {
      const t = progressMap.get(ep.torrent_id);
      if (!t) continue;
      if (t.done) {
        episodes.update(ep.id, { status: 'done', progress: 100 });
        console.log(`[scheduler] episode #${ep.id} S${ep.season}E${ep.episode} download complete`);
      } else {
        if (t.progress !== ep.progress) episodes.update(ep.id, { progress: t.progress });
        if (isStale(ep.download_started_at)) {
          console.log(`[scheduler] episode #${ep.id} S${ep.season}E${ep.episode} stale, retrying`);
          const tried = JSON.parse(ep.tried_magnets || '[]');
          if (ep.magnet) tried.push(ep.magnet);
          episodes.update(ep.id, {
            status: 'pending', magnet: null, torrent_id: null,
            progress: 0, tried_magnets: JSON.stringify(tried), download_started_at: null,
          });
          try { await removeTorrent(ep.torrent_id); } catch (_) {}
        }
      }
    }
  } catch (err) {
    console.error('[scheduler] sync error:', err.message);
  }
}

// --- Movies ---

async function runMovies(deadline) {
  for (const movie of movies.pending()) {
    if (Date.now() > deadline) { console.warn('[scheduler] deadline reached, deferring remaining movies'); return; }
    try {
      await processMovie(movie);
    } catch (err) {
      console.error(`[scheduler] movie error "${movie.title}":`, err.message);
      movies.update(movie.id, { status: 'failed' });
    }
  }
}

async function processMovie(movie) {
  if (movie.release_date && !hasAired(movie.release_date)) {
    console.log(`[scheduler] "${movie.title}" not yet released (${movie.release_date}), skipping`);
    return;
  }

  const query   = `${movie.title} ${movie.year || ''}`.trim();
  const quality = movie.quality || settings.get('default_quality') || '1080p';

  if (movie.mode === 'manual') {
    if (movie.results_cache) return; // already searched, awaiting user approval
    console.log(`[scheduler] movie (manual): ${movie.title} — caching preview results`);
    const [prowlarrResults, ytsResults] = await Promise.all([
      prowlarr.search(query, 'movie'),
      yts.search(movie.title, quality),
    ]);
    const top5 = select([...prowlarrResults, ...ytsResults], { preferredQuality: quality, type: 'movie', limit: 5 });
    if (top5.length > 0) {
      movies.update(movie.id, { results_cache: JSON.stringify(top5) });
      console.log(`[scheduler] cached ${top5.length} results for manual movie "${movie.title}"`);
    }
    return;
  }

  console.log(`[scheduler] movie: ${movie.title} (${movie.year || '?'})`);
  const [prowlarrResults, ytsResults] = await Promise.all([
    prowlarr.search(query, 'movie'),
    yts.search(movie.title, quality),
  ]);

  const exclude = JSON.parse(movie.tried_magnets || '[]');
  const winner = select([...prowlarrResults, ...ytsResults], { preferredQuality: quality, type: 'movie', exclude });
  if (!winner) { console.log(`[scheduler] no result for: ${movie.title}`); return; }

  const torrentUrl = winner.magnet || winner.download_url;
  if (!torrentUrl) { console.log(`[scheduler] no magnet/url for: ${movie.title}`); return; }

  let result;
  try {
    result = await addTorrent(torrentUrl, settings.get('movie_path'), {
      screen: { type: 'movie', title: winner.title },
    });
  } catch (err) {
    if (err.screened) {
      // Blocked by content screening — remember it and let the next run try the
      // next-best candidate instead of failing the movie outright.
      const tried = JSON.parse(movie.tried_magnets || '[]');
      tried.push(torrentUrl);
      movies.update(movie.id, { tried_magnets: JSON.stringify(tried), results_cache: null });
      console.warn(`[scheduler] "${movie.title}" candidate blocked: ${err.message}`);
      return;
    }
    throw err;
  }

  movies.update(movie.id, {
    status: 'downloading', magnet: torrentUrl, torrent_id: result.id,
    download_started_at: new Date().toISOString(),
  });
  console.log(`[scheduler] added "${movie.title}" — torrent #${result.id}`);
}

// --- Shows ---

async function runShows(deadline) {
  for (const show of shows.active()) {
    if (Date.now() > deadline) { console.warn('[scheduler] deadline reached, deferring remaining shows'); return; }
    try {
      await processShow(show, deadline);
    } catch (err) {
      console.error(`[scheduler] show error "${show.title}":`, err.message);
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
      console.log(`[scheduler] "${current.title}": synced ${added} new, ${updated} updated`);
    }
  } catch (err) {
    console.error(`[scheduler] "${current.title}" sync failed:`, err.message);
  }

  // Auto-pause finished shows with nothing left outstanding
  if (['Ended', 'Canceled', 'Cancelled'].includes(current.show_status)) {
    const outstanding = episodes.pending(current.id).length
                      + episodes.upcoming(current.id).length
                      + episodes.failed(current.id).length
                      + episodes.downloading().filter(e => e.show_id === current.id).length;
    if (outstanding === 0) {
      shows.update(current.id, { active: 0 });
      console.log(`[scheduler] "${current.title}" is ${current.show_status} and fully grabbed — pausing`);
      return;
    }
  }

  if (current.mode === 'manual') {
    await cacheManualPreview(current);
    return;
  }

  let grabbed = 0;
  for (const ep of episodes.pending(current.id)) {
    if (grabbed >= MAX_EPISODES_PER_RUN) {
      console.log(`[scheduler] "${current.title}": hit per-run cap (${MAX_EPISODES_PER_RUN}), continuing next run`);
      break;
    }
    if (Date.now() > deadline) { console.warn(`[scheduler] deadline reached during "${current.title}"`); break; }
    try {
      if (await grabEpisode(current, ep)) grabbed++;
    } catch (err) {
      console.error(`[scheduler] "${current.title}" S${ep.season}E${ep.episode} failed:`, err.message);
      episodes.update(ep.id, { status: 'failed' });
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

  const label   = epLabel(ep.season, ep.episode);
  const quality = show.quality || settings.get('default_quality') || '1080p';
  console.log(`[scheduler] "${show.title}" ${label}: caching preview results`);

  const [prowlarrResults, eztvResults] = await Promise.all([
    prowlarr.search(`${show.title} ${label}`, 'show'),
    eztv.search(show.imdb_id, ep.season, ep.episode),
  ]);
  const top5 = select([...prowlarrResults, ...eztvResults], { preferredQuality: quality, type: 'show', limit: 5 });
  if (top5.length === 0) {
    console.log(`[scheduler] "${show.title}" ${label}: no candidates found`);
    return;
  }
  episodes.update(ep.id, { results_cache: JSON.stringify(top5) });
  console.log(`[scheduler] "${show.title}" ${label}: awaiting manual approval (${top5.length} candidates)`);
}

/** Search for and grab one already-aired pending episode. Returns true on success. */
async function grabEpisode(show, ep) {
  const label   = epLabel(ep.season, ep.episode);
  const quality = show.quality || settings.get('default_quality') || '1080p';

  console.log(`[scheduler] show: "${show.title}" ${label}`);
  const [prowlarrResults, eztvResults] = await Promise.all([
    prowlarr.search(`${show.title} ${label}`, 'show'),
    eztv.search(show.imdb_id, ep.season, ep.episode),
  ]);

  const exclude = JSON.parse(ep.tried_magnets || '[]');
  const winner  = select([...prowlarrResults, ...eztvResults], { preferredQuality: quality, type: 'show', exclude });
  if (!winner) { console.log(`[scheduler] no result for "${show.title}" ${label}`); return false; }

  const torrentUrl = winner.magnet || winner.download_url;
  if (!torrentUrl) { console.log(`[scheduler] no magnet/url for "${show.title}" ${label}`); return false; }

  const downloadDir = `${settings.get('shows_path')}/${show.title}`;
  let result;
  try {
    result = await addTorrent(torrentUrl, downloadDir, {
      screen: { type: 'show', title: winner.title },
    });
  } catch (err) {
    if (err.screened) {
      // Blocked by content screening — remember it and stay pending so the next
      // run picks the next-best candidate.
      const tried = JSON.parse(ep.tried_magnets || '[]');
      tried.push(torrentUrl);
      episodes.update(ep.id, { tried_magnets: JSON.stringify(tried), results_cache: null });
      console.warn(`[scheduler] "${show.title}" ${label} candidate blocked: ${err.message}`);
      return false;
    }
    throw err;
  }

  episodes.update(ep.id, {
    status: 'downloading', magnet: torrentUrl, torrent_id: result.id,
    results_cache: null, download_started_at: new Date().toISOString(),
  });
  console.log(`[scheduler] added "${show.title}" ${label} — torrent #${result.id}`);
  return true;
}

// --- Entry point ---

let _running = false;

async function run() {
  if (_running) { console.log('[scheduler] already running, skipping'); return; }
  _running = true;
  const deadline = Date.now() + RUN_DEADLINE_MINUTES * 60 * 1000;
  console.log('[scheduler] starting run');
  try {
    await runMovies(deadline).catch(err => console.error('[scheduler] movies run error:', err.message));
    await runShows(deadline).catch(err  => console.error('[scheduler] shows run error:',  err.message));
    await syncDownloading();
  } finally {
    _running = false;
  }
  console.log('[scheduler] run complete');
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
