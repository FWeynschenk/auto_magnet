'use strict';

const { settings } = require('./db');

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

async function getSeasonDetails(tmdbId, seasonNumber) {
  const url = `${BASE}/tv/${tmdbId}/season/${seasonNumber}?api_key=${apiKey()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const r = await res.json();
  return {
    season_number: r.season_number,
    episode_count: (r.episodes || []).length,
    episodes: (r.episodes || []).map(e => ({
      episode_number: e.episode_number,
      name:           e.name,
      air_date:       e.air_date,
    })),
  };
}

module.exports = { searchMulti, getMovieDetails, getTvDetails, getSeasonDetails };
