'use strict';

// One place that turns "I want this film / episode" into a ranked list of
// torrents that are ready to hand straight to Transmission.
//
// The ordering here matters. Resolving a Prowlarr download URL into a magnet
// costs a round trip *per row*, and a broad search returns 50–100 rows. Doing
// that up front meant waiting on ~80 requests to display 10 results, most of
// them for releases that were never going to be shown. So: search, filter,
// score, and only then resolve the handful that can actually win.
//
// Everything this module returns as `accepted` carries a magnet. Callers never
// need to go back to an indexer, which is the whole point — picking a result in
// the UI should add it to Transmission immediately.

const prowlarr = require('./sources/prowlarr');
const yts      = require('./sources/yts');
const eztv     = require('./sources/eztv');
const { evaluate } = require('./selector');
const { screenFiles, VIDEO_RE } = require('./screen');

/** How many rows to resolve magnets for. A little above the display limit so
 *  the list still fills up when some fail to resolve. */
const RESOLVE_HEADROOM = 6;
const RESOLVE_CONCURRENCY = 6;

function epLabel(season, episode) {
  return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

/** Fraction of the expected episodes a pack must actually contain. */
const PACK_COVERAGE = 0.9;

/**
 * Reason a pack's file list falls short of the episodes it is meant to cover,
 * or null. Only meaningful when more than one episode is expected.
 */
function shortfall(files, episodeCount) {
  if (!episodeCount || episodeCount < 2) return null;
  // Count only real episode-sized videos; samples and extras are not episodes.
  const videos = files.filter(f => VIDEO_RE.test(f.path) && (f.length || 0) > 50 * 1024 * 1024);
  if (videos.length === 0) return null;  // archive release — nothing to count
  if (videos.length >= Math.ceil(episodeCount * PACK_COVERAGE)) return null;
  return `contains ${videos.length} episodes, not the ${episodeCount} expected`;
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool(items, n, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length > 0) await fn(queue.shift());
  });
  await Promise.all(workers);
}

/** Fan out to every source that applies to this request. */
async function gather({ type, title, year, imdbId, season, episode, quality, query, pack, refresh }) {
  // A hand-typed query is taken literally and sent only to Prowlarr. YTS and
  // EZTV are keyed on a canonical title and an IMDB id respectively, so they
  // cannot answer "find me exactly this string" — and the whole point of the
  // manual box is to reach releases the canonical name does not find.
  if (query) {
    return prowlarr.search(query, type === 'movie' ? 'movie' : 'show', { refresh });
  }

  if (type === 'movie') {
    const titleAndYear = `${title} ${year || ''}`.trim();
    const [pr, yr] = await Promise.all([
      prowlarr.search(titleAndYear, 'movie', { refresh }),
      yts.search(title, quality, { refresh }),
    ]);
    // A year-qualified search that finds nothing is usually a year the indexers
    // disagree about, not a film that does not exist. Retry without it.
    if (pr.length === 0 && year) {
      const bare = await prowlarr.search(title, 'movie', { refresh });
      return [...bare, ...yr];
    }
    return [...pr, ...yr];
  }

  // Pack search: ask for the season (or the whole run), not an episode. EZTV is
  // skipped because it indexes single episodes, so it can only ever contribute
  // rejects here.
  if (pack === 'series') {
    // Two phrasings cover almost everything: scene releases name a span
    // ("S01-S05"), while repackers say "Complete Series". Results are merged and
    // deduped by infohash, so asking both ways costs one extra cached search.
    const [a, b] = await Promise.all([
      prowlarr.search(`${title} complete series`, 'show', { refresh }),
      prowlarr.search(title, 'show', { refresh }),
    ]);
    return [...a, ...b];
  }
  if (pack && season != null) {
    return prowlarr.search(`${title} S${String(season).padStart(2, '0')}`, 'show', { refresh });
  }

  const label = (season != null && episode != null) ? epLabel(season, episode) : '';
  const [pr, ez] = await Promise.all([
    prowlarr.search(`${title} ${label}`.trim(), 'show', { refresh }),
    eztv.search(imdbId, season, episode, { refresh }),
  ]);
  return [...pr, ...ez];
}

/**
 * Search, rank, and resolve.
 *
 * @returns {{ accepted: Array, rejected: Array, searched_at: string }}
 *   Every accepted row has `.magnet`. Rejected rows carry `._reason`.
 */
async function findCandidates({
  type, title, year = null, imdbId = null,
  season = null, episode = null,
  quality = '1080p', exclude = [], limit = 20, refresh = false,
  query = null, allowPacks = false, pack = false, seasons = null, episodeCount = 1,
}) {
  const raw = await gather({ type, title, year, imdbId, season, episode, quality, query, pack, refresh });

  // A typed query replaces the title check rather than stacking on top of it:
  // the user said what they wanted, so second-guessing the words is exactly the
  // behaviour the manual box exists to escape. Safety and quality filters stay.
  const want    = query ? null : { title, year, season, episode, seasons, episodeCount };
  const packsOk = allowPacks || pack || !!query;
  const { accepted, rejected } = evaluate(raw, {
    preferredQuality: quality, type, want, exclude,
    allowPacks: packsOk,
  });

  const ready    = [];
  const unusable = [];
  let cursor     = 0;

  // Resolve in waves so that rows dropped during resolution are backfilled from
  // the tail rather than leaving a short list.
  while (ready.length < limit && cursor < accepted.length) {
    const batch = accepted.slice(cursor, cursor + limit - ready.length + RESOLVE_HEADROOM);
    cursor += batch.length;

    const needResolve = batch.filter(r => !r.magnet);
    if (needResolve.length > 0) {
      await pool(needResolve, RESOLVE_CONCURRENCY, async (r) => {
        await prowlarr.resolveMagnet(r);
      });
    }

    for (const r of batch) {
      if (!r.magnet) {
        unusable.push({ ...r, _reason: 'no magnet could be resolved from the indexer' });
        continue;
      }
      // Resolution may have produced a real file list. Now that we know what is
      // actually inside, screen it — this is where droppers get caught before
      // anything reaches Transmission.
      if (r.files?.length) {
        const verdict = screenFiles(r.files, { type, allowPacks: packsOk });
        if (!verdict.ok) {
          unusable.push({ ...r, _reason: verdict.reason });
          continue;
        }
        if (verdict.warnings?.length) r._warnings = verdict.warnings;
        r._screened = true;

        // A title can only claim to be complete; a file list can be counted.
        // This is the one place a "Complete Series" that is really seasons 1-3
        // gets caught — and it matters, because the episodes a pack covers are
        // marked as handled and nothing goes back for the ones it missed.
        const short = shortfall(r.files, episodeCount);
        if (short) {
          unusable.push({ ...r, _reason: short });
          continue;
        }
      }
      ready.push(r);
    }
  }

  // Anything past the resolve cursor was never examined; report it as-is so the
  // UI can still show "there were N more results" without implying a verdict.
  const untouched = accepted.slice(cursor).map(r => ({ ...r, _reason: 'not in the top results' }));

  return {
    accepted: ready.slice(0, limit),
    rejected: [...unusable, ...rejected, ...untouched].sort((a, b) => b._score - a._score),
    searched_at: new Date().toISOString(),
  };
}

/** The single best candidate, fully resolved and screened, or null. */
async function findBest(opts) {
  const { accepted } = await findCandidates({ ...opts, limit: 1 });
  return accepted[0] || null;
}

module.exports = { findCandidates, findBest, epLabel };
