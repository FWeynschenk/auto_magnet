'use strict';

const { movies, shows, episodes, settings } = require('./db');
const { addTorrent, getTorrentProgress } = require('./transmission');
const { getSeasonDetails }    = require('./tmdb');
const prowlarr = require('./sources/prowlarr');
const yts      = require('./sources/yts');
const eztv     = require('./sources/eztv');
const { select } = require('./selector');

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

// --- Transmission sync ---

async function syncDownloading() {
  try {
    const progressMap = await getTorrentProgress();
    if (progressMap.size === 0) return;

    // Sync movies
    for (const movie of movies.downloading()) {
      const t = progressMap.get(movie.torrent_id);
      if (!t) continue;
      if (t.done) {
        movies.update(movie.id, { status: 'done', progress: 100 });
        console.log(`[scheduler] movie "${movie.title}" download complete`);
      } else if (t.progress !== movie.progress) {
        movies.update(movie.id, { progress: t.progress });
      }
    }

    // Sync episodes
    for (const ep of episodes.downloading()) {
      const t = progressMap.get(ep.torrent_id);
      if (!t) continue;
      if (t.done) {
        episodes.update(ep.id, { status: 'done', progress: 100 });
        console.log(`[scheduler] episode #${ep.id} S${ep.season}E${ep.episode} download complete`);
      } else if (t.progress !== ep.progress) {
        episodes.update(ep.id, { progress: t.progress });
      }
    }
  } catch (err) {
    console.error('[scheduler] sync error:', err.message);
  }
}

// --- Movies ---

async function runMovies() {
  const pending = movies.pending();
  for (const movie of pending) {
    try {
      await processMovie(movie);
    } catch (err) {
      console.error(`[scheduler] movie error "${movie.title}":`, err.message);
      movies.update(movie.id, { status: 'failed' });
    }
  }
}

async function processMovie(movie) {
  // Check release date — skip if not yet available
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

  const winner = select([...prowlarrResults, ...ytsResults], { preferredQuality: quality, type: 'movie' });
  if (!winner) { console.log(`[scheduler] no result for: ${movie.title}`); return; }

  const torrentUrl = winner.magnet || winner.download_url;
  if (!torrentUrl) { console.log(`[scheduler] no magnet/url for: ${movie.title}`); return; }

  const result = await addTorrent(torrentUrl, settings.get('movie_path'));
  movies.update(movie.id, { status: 'downloading', magnet: torrentUrl, torrent_id: result.id });
  console.log(`[scheduler] added "${movie.title}" — torrent #${result.id}`);
}

// --- Shows ---

async function runShows() {
  const active = shows.active();
  for (const show of active) {
    try {
      await processShow(show);
    } catch (err) {
      console.error(`[scheduler] show error "${show.title}":`, err.message);
    }
  }
}

async function processShow(show) {
  const latest = episodes.latest(show.id);
  let nextSeason  = latest ? latest.season  : (show.start_season  || 1);
  let nextEpisode = latest ? latest.episode + 1 : (show.start_episode || 1);

  // Fetch season info from TMDB
  let seasonInfo = null;
  try { seasonInfo = await getSeasonDetails(show.tmdb_id, nextSeason); } catch (_) {}

  if (seasonInfo && nextEpisode > seasonInfo.episode_count) {
    nextSeason  += 1;
    nextEpisode  = 1;
    try { seasonInfo = await getSeasonDetails(show.tmdb_id, nextSeason); } catch (_) {}
    if (!seasonInfo || seasonInfo.episode_count === 0) {
      console.log(`[scheduler] "${show.title}": no S${nextSeason} on TMDB, stopping`);
      return;
    }
  }

  // Already grabbed?
  if (episodes.exists(show.id, nextSeason, nextEpisode)) return;

  // Get air date for this specific episode from TMDB season data
  const epInfo = seasonInfo?.episodes?.find(e => e.episode_number === nextEpisode);
  const airDate = epInfo?.air_date || null;

  // Skip if episode hasn't aired yet
  if (airDate && !hasAired(airDate)) {
    console.log(`[scheduler] "${show.title}" S${nextSeason}E${nextEpisode} airs ${airDate}, skipping`);
    return;
  }

  const epStr = `S${String(nextSeason).padStart(2, '0')}E${String(nextEpisode).padStart(2, '0')}`;
  const quality = show.quality || settings.get('default_quality') || '1080p';

  if (show.mode === 'manual') {
    console.log(`[scheduler] "${show.title}" ${epStr}: caching preview results`);
    const [prowlarrResults, eztvResults] = await Promise.all([
      prowlarr.search(`${show.title} ${epStr}`, 'show'),
      eztv.search(show.imdb_id, nextSeason, nextEpisode),
    ]);
    const top5 = select([...prowlarrResults, ...eztvResults], { preferredQuality: quality, type: 'show', limit: 5 });
    const resultsCache = top5.length > 0 ? JSON.stringify(top5) : null;
    episodes.insert({ show_id: show.id, season: nextSeason, episode: nextEpisode, status: 'pending', magnet: null, torrent_id: null, results_cache: resultsCache, air_date: airDate });
    console.log(`[scheduler] "${show.title}" ${epStr}: awaiting manual approval (cached ${top5.length} results)`);
    return;
  }

  console.log(`[scheduler] show: "${show.title}" ${epStr}`);
  const [prowlarrResults, eztvResults] = await Promise.all([
    prowlarr.search(`${show.title} ${epStr}`, 'show'),
    eztv.search(show.imdb_id, nextSeason, nextEpisode),
  ]);

  const winner = select([...prowlarrResults, ...eztvResults], { preferredQuality: quality, type: 'show' });
  if (!winner) { console.log(`[scheduler] no result for "${show.title}" ${epStr}`); return; }

  const torrentUrl = winner.magnet || winner.download_url;
  if (!torrentUrl) { console.log(`[scheduler] no magnet/url for "${show.title}" ${epStr}`); return; }

  const downloadDir = `${settings.get('shows_path')}/${show.title}`;
  const result = await addTorrent(torrentUrl, downloadDir);
  episodes.insert({ show_id: show.id, season: nextSeason, episode: nextEpisode, status: 'downloading', magnet: torrentUrl, torrent_id: result.id, air_date: airDate });
  console.log(`[scheduler] added "${show.title}" ${epStr} — torrent #${result.id}`);
}

// --- Entry point ---

let _running = false;

async function run() {
  if (_running) { console.log('[scheduler] already running, skipping'); return; }
  _running = true;
  console.log('[scheduler] starting run');
  try {
    await runMovies().catch(err => console.error('[scheduler] movies run error:', err.message));
    await runShows().catch(err  => console.error('[scheduler] shows run error:',  err.message));
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
    await run();
    scheduleNext();
  }, mins * 60 * 1000);
}

function start() {
  run();
  scheduleNext();
}

module.exports = { start, run };
