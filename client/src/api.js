const BASE = '/api';

// Set when the server runs with AMAGNET_TOKEN. Stored client-side so the SPA can
// authenticate against a locked-down API.
const TOKEN_KEY = 'amagnet_token';
export const setToken = (t) => t
  ? localStorage.setItem(TOKEN_KEY, t)
  : localStorage.removeItem(TOKEN_KEY);
export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';

let onUnauthorized = null;
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function req(method, path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers['X-Auth-Token'] = token;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;
  if (res.status === 401 && !path.startsWith('/auth/')) {
    // Session expired or revoked: back to the sign-in page, keeping the
    // current page so it can return there.
    onUnauthorized?.();
    throw new Error('Signed out — please sign in again');
  }

  // A non-JSON body means something upstream returned HTML; surface it readably
  let data;
  try {
    data = await res.json();
  } catch (_) {
    throw new Error(`HTTP ${res.status} — unexpected non-JSON response`);
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const movies = {
  list:        ()           => req('GET',    '/movies'),
  add:         (body)       => req('POST',   '/movies', body),
  update:      (id, body)   => req('PUT',    `/movies/${id}`, body),
  remove:      (id)         => req('DELETE', `/movies/${id}`),
  redo:        (id)         => req('POST',   `/movies/${id}/redo`),
  retryFailed: ()           => req('POST',   '/movies/retry-failed'),
};

export const shows = {
  list:         ()                    => req('GET',    '/shows'),
  add:          (body)                => req('POST',   '/shows', body),
  update:       (id, body)            => req('PUT',    `/shows/${id}`, body),
  remove:       (id)                  => req('DELETE', `/shows/${id}`),
  episodes:     (id)                  => req('GET',    `/shows/${id}/episodes`),
  redoEpisode:  (showId, epId)        => req('POST',   `/shows/${showId}/episodes/${epId}/redo`),
  skipEpisode:  (showId, epId)        => req('POST',   `/shows/${showId}/episodes/${epId}/skip`),
  retryFailed:  ()                    => req('POST',   '/shows/retry-failed'),
  refreshTmdb:  (id)                  => req('POST',   `/shows/${id}/refresh-tmdb`),
  addEpisode:   (id, body)            => req('POST',   `/shows/${id}/episodes/manual`, body),
};

export const search = {
  tmdb:    (q)     => req('GET',  `/search/tmdb?q=${encodeURIComponent(q)}`),
  preview: (body)  => req('POST', '/search/preview', body),
  grab:    (body)  => req('POST', '/search/grab',    body),
};

export const settings = {
  get:     ()     => req('GET',  '/settings'),
  save:    (body) => req('PUT',  '/settings', body),
  status:  ()     => req('GET',  '/settings/status'),
  targets: ()     => req('GET',  '/settings/targets'),
};

export const scheduler = {
  run: () => req('POST', '/scheduler/run'),
};

export const timeline = {
  get: () => req('GET', '/timeline'),
};

export const library = {
  folders:   ()               => req('GET',  '/library/folders'),
  fixFolder: (from, target)   => req('POST', '/library/folders/fix', { from, target }),
};

export const activity = {
  list: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v != null)
    ).toString();
    return req('GET', `/log${qs ? `?${qs}` : ''}`);
  },
  clear: () => req('DELETE', '/log'),
};

export const auth = {
  status:         ()               => req('GET',    '/auth/status'),
  setup:          (body)           => req('POST',   '/auth/setup', body),
  login:          (body)           => req('POST',   '/auth/login', body),
  logout:         ()               => req('POST',   '/auth/logout'),
  changePassword: (current, password) => req('PUT', '/auth/me/password', { current, password }),
  sessions:       ()               => req('GET',    '/auth/me/sessions'),
  revokeSession:  (id)             => req('DELETE', `/auth/me/sessions/${id}`),
  users:          ()               => req('GET',    '/auth/users'),
  createUser:     (body)           => req('POST',   '/auth/users', body),
  updateUser:     (id, body)       => req('PUT',    `/auth/users/${id}`, body),
  removeUser:     (id)             => req('DELETE', `/auth/users/${id}`),
};

const item = (kind, id) => `/watch/items/${kind}/${id}`;

export const watch = {
  home:        ()                 => req('GET',  '/watch/home'),
  movies:      ()                 => req('GET',  '/watch/movies'),
  shows:       ()                 => req('GET',  '/watch/shows'),
  show:        (id)               => req('GET',  `/watch/shows/${id}`),
  item:        (kind, id)         => req('GET',  item(kind, id)),
  playback:    (kind, id)         => req('GET',  `${item(kind, id)}/playback`),
  prepare:     (kind, id)         => req('POST', `${item(kind, id)}/prepare`),
  reencode:    (kind, id)         => req('POST', `${item(kind, id)}/reencode`),
  deleteWeb:   (kind, id)         => req('DELETE', `${item(kind, id)}/web`),
  deleteAll:   (kind, id)         => req('DELETE', item(kind, id)),
  progress:    (kind, id, body)   => req('PUT',  `/watch/progress/${kind}/${id}`, body),
  setWatched:  (kind, id, watched) => req('POST', `/watch/progress/${kind}/${id}/watched`, { watched }),
  showWatched: (showId, season, watched) => req('POST', `/watch/shows/${showId}/watched`, { season, watched }),
  syncSub:     (kind, id, sub)    => req('POST', `${item(kind, id)}/subtitles/${sub}/sync`),
  shiftSub:    (kind, id, sub, offsetMs) => req('POST', `${item(kind, id)}/subtitles/${sub}/shift`, { offsetMs }),
  restoreSub:  (kind, id, sub)    => req('POST', `${item(kind, id)}/subtitles/${sub}/restore`),
  adminStatus: ()                 => req('GET',  '/watch/admin/status'),
  scan:        ()                 => req('POST', '/watch/admin/scan'),
  clear:       ()                 => req('POST', '/watch/admin/clear'),
};
