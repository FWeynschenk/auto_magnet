const BASE = '/api';

// Set when the server runs with AMAGNET_TOKEN. Stored client-side so the SPA can
// authenticate against a locked-down API.
const TOKEN_KEY = 'amagnet_token';
export const setToken = (t) => t
  ? localStorage.setItem(TOKEN_KEY, t)
  : localStorage.removeItem(TOKEN_KEY);
export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';

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
  if (res.status === 401) throw new Error('Unauthorized — check the API token in Settings');

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
  get:    ()     => req('GET',  '/settings'),
  save:   (body) => req('PUT',  '/settings', body),
  status: ()     => req('GET',  '/settings/status'),
};

export const scheduler = {
  run: () => req('POST', '/scheduler/run'),
};

export const timeline = {
  get: () => req('GET', '/timeline'),
};
