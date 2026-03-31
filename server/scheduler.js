'use strict';

const { movies, shows, episodes, settings } = require('./db');
const { addTorrent }    = require('./transmission');
const { getSeasonDetails } = require('./tmdb');
const prowlarr = require('./sources/prowlarr');
const yts      = require('./sources/yts');
const eztv     = require('./sources/eztv');
const { select } = require('./selector');

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
  if (movie.mode === 'manual') return; // user will pick from preview

  console.log(`[scheduler] movie: ${movie.title} (${movie.year || '?'})`);
  const query   = `${movie.title} ${movie.year || ''}`.trim();
  const quality = movie.quality || settings.get('default_quality') || '1080p';

  const [prowlarrResults, ytsResults] = await Promise.all([
    prowlarr.search(query, 'movie'),
    yts.search(movie.title, quality),
  ]);

  const winner = select([...prowlarrResults, ...ytsResults], { preferredQuality: quality, type: 'movie' });

  if (!winner) {
    console.log(`[scheduler] no result for: ${movie.title}`);
    return;
  }

  const torrentUrl = winner.magnet || winner.download_url;
  if (!torrentUrl) { console.log(`[scheduler] no magnet or download_url for: ${movie.title}`); return; }
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
  let nextSeason  = latest ? latest.season  : 1;
  let nextEpisode = latest ? latest.episode + 1 : 1;

  // Ask TMDB if this episode exists in the current season
  let seasonInfo = null;
  try { seasonInfo = await getSeasonDetails(show.tmdb_id, nextSeason); } catch (_) {}

  if (seasonInfo && nextEpisode > seasonInfo.episode_count) {
    // End of season — advance to next
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

  const epStr = `S${String(nextSeason).padStart(2, '0')}E${String(nextEpisode).padStart(2, '0')}`;

  if (show.mode === 'manual') {
    // Insert a pending row — user will approve via PreviewDialog
    episodes.insert({ show_id: show.id, season: nextSeason, episode: nextEpisode, status: 'pending', magnet: null, torrent_id: null });
    console.log(`[scheduler] "${show.title}" ${epStr}: awaiting manual approval`);
    return;
  }

  console.log(`[scheduler] show: "${show.title}" ${epStr}`);
  const quality = show.quality || settings.get('default_quality') || '1080p';

  const [prowlarrResults, eztvResults] = await Promise.all([
    prowlarr.search(`${show.title} ${epStr}`, 'show'),
    eztv.search(show.imdb_id, nextSeason, nextEpisode),
  ]);

  const winner = select([...prowlarrResults, ...eztvResults], { preferredQuality: quality, type: 'show' });

  if (!winner) {
    console.log(`[scheduler] no result for "${show.title}" ${epStr}`);
    return;
  }

  const downloadDir = `${settings.get('shows_path')}/${show.title}`;
  const torrentUrl = winner.magnet || winner.download_url;
  if (!torrentUrl) { console.log(`[scheduler] no magnet or download_url for "${show.title}" ${epStr}`); return; }
  const result = await addTorrent(torrentUrl, downloadDir);
  episodes.insert({
    show_id:    show.id,
    season:     nextSeason,
    episode:    nextEpisode,
    status:     'downloading',
    magnet:     torrentUrl,
    torrent_id: result.id,
  });
  console.log(`[scheduler] added "${show.title}" ${epStr} — torrent #${result.id}`);
}

// --- Entry point ---

async function run() {
  console.log('[scheduler] starting run');
  await runMovies().catch(err => console.error('[scheduler] movies run error:', err.message));
  await runShows().catch(err => console.error('[scheduler] shows run error:', err.message));
  console.log('[scheduler] run complete');
}

function start() {
  run();
  setInterval(run, 60 * 60 * 1000); // every hour
}

module.exports = { start, run };
