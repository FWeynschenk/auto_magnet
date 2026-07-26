'use strict';

const { settings, seasonCache } = require('./db');

const BASE = 'https://api.themoviedb.org/3';
const IMG_BASE = 'https://image.tmdb.org/t/p/w500';

function apiKey() {
  return settings.get('tmdb_api_key') || process.env.TMDB_API_KEY;
}

async function searchMulti(query) {
  const url = `${BASE}/search/multi?api_key=${apiKey()}&query=${encodeURIComponent(query)}&include_adult=false`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || [])
    .filter(r => r.media_type === 'movie' || r.media_type === 'tv')
    .slice(0, 8)
    .map(r => ({
      tmdb_id:   r.id,
      type:      r.media_type,
      title:     r.title || r.name,
      year:      (r.release_date || r.first_air_date || '').slice(0, 4),
      poster_url: r.poster_path ? IMG_BASE + r.poster_path : null,
      overview:  r.overview,
    }));
}

async function getMovieDetails(tmdbId) {
  const url = `${BASE}/movie/${tmdbId}?api_key=${apiKey()}&append_to_response=external_ids`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const r = await res.json();
  return {
    tmdb_id:   r.id,
    imdb_id:   r.imdb_id || r.external_ids?.imdb_id || null,
    title:     r.title,
    year:      parseInt((r.release_date || '').slice(0, 4)) || null,
    poster_url: r.poster_path ? IMG_BASE + r.poster_path : null,
    overview:  r.overview,
  };
}

async function getTvDetails(tmdbId) {
  const url = `${BASE}/tv/${tmdbId}?api_key=${apiKey()}&append_to_response=external_ids`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const r = await res.json();
  return {
    tmdb_id:          r.id,
    imdb_id:          r.external_ids?.imdb_id || null,
    title:            r.name,
    poster_url:       r.poster_path ? IMG_BASE + r.poster_path : null,
    overview:         r.overview,
    number_of_seasons: r.number_of_seasons,
    show_status:      r.status, // 'Ended', 'Returning Series', etc.
    seasons:          (r.seasons || []).map(s => ({
      season_number: s.season_number,
      episode_count: s.episode_count,
    })),
  };
}

/**
 * A season is immutable once it is fully in the past: every episode has an air
 * date and the last one aired more than IMMUTABLE_AFTER_DAYS ago. Such a season
 * is cached forever, which is where nearly all the API savings come from.
 */
const IMMUTABLE_AFTER_DAYS = 14;

function isSeasonFinished(season) {
  const eps = season?.episodes || [];
  if (eps.length === 0) return false;
  if (eps.some(e => !e.air_date)) return false;
  const last = eps.reduce((max, e) => (e.air_date > max ? e.air_date : max), '');
  const cutoff = Date.now() - IMMUTABLE_AFTER_DAYS * 24 * 3600 * 1000;
  return new Date(last + 'T23:59:59Z').getTime() < cutoff;
}

/**
 * Season details, served from the persistent cache when possible.
 * Returns null when the season does not exist — that negative result is cached
 * too (with a TTL) so probing past the end of a series isn't a request per run.
 */
async function getSeasonDetails(tmdbId, seasonNumber) {
  const cached = seasonCache.get(tmdbId, seasonNumber);
  if (seasonCache.isFresh(cached)) {
    return cached.payload ? JSON.parse(cached.payload) : null;
  }

  const url = `${BASE}/tv/${tmdbId}/season/${seasonNumber}?api_key=${apiKey()}`;
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    // Network failure: fall back to a stale cache entry rather than losing data
    if (cached) return cached.payload ? JSON.parse(cached.payload) : null;
    throw err;
  }

  if (res.status === 404) {
    seasonCache.set(tmdbId, seasonNumber, null, false);
    return null;
  }
  if (!res.ok) {
    if (cached) return cached.payload ? JSON.parse(cached.payload) : null;
    return null;
  }

  const r = await res.json();
  const season = {
    season_number:   r.season_number,
    season_air_date: r.air_date || null,   // season premiere date (fallback when episode dates are missing)
    episode_count:   (r.episodes || []).length,
    episodes: (r.episodes || []).map(e => ({
      episode_number: e.episode_number,
      name:           e.name,
      air_date:       e.air_date || null,
    })),
  };

  seasonCache.set(tmdbId, seasonNumber, season, isSeasonFinished(season));
  return season;
}

/**
 * Fetch the digital/streaming release date for a movie from TMDB.
 * Returns an ISO date string "YYYY-MM-DD" or null.
 * type=4 is Digital, type=3 is Theatrical (fallback).
 */
async function getMovieReleaseDates(tmdbId, region = 'US') {
  try {
    const url = `${BASE}/movie/${tmdbId}/release_dates?api_key=${apiKey()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const regionData = (data.results || []).find(r => r.iso_3166_1 === region);
    if (!regionData) return null;
    const dates = regionData.release_dates || [];
    const digital    = dates.find(d => d.type === 4);
    const theatrical = dates.find(d => d.type === 3);
    const pick = digital || theatrical;
    return pick ? pick.release_date.slice(0, 10) : null;
  } catch (_) {
    return null;
  }
}

module.exports = { searchMulti, getMovieDetails, getTvDetails, getSeasonDetails, getMovieReleaseDates };
