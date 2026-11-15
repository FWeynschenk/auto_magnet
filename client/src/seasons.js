// The season each show was last at, in this browser: picked on the show's
// page or played. The show's page opens on it.

const KEY = 'amagnet_season';

function all() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { return {}; }
}

export function lastSeason(showId) {
  const s = all()[showId];
  return Number.isInteger(s) ? s : null;
}

export function rememberSeason(showId, season) {
  if (!showId || !Number.isInteger(season)) return;
  const map = all();
  map[showId] = season;
  try { localStorage.setItem(KEY, JSON.stringify(map)); } catch (_) {}
}
