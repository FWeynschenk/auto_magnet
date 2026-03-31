const BASE = '/api';

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const movies = {
  list:   ()           => req('GET',    '/movies'),
  add:    (body)       => req('POST',   '/movies', body),
  update: (id, body)   => req('PUT',    `/movies/${id}`, body),
  remove: (id)         => req('DELETE', `/movies/${id}`),
};

export const shows = {
  list:     ()         => req('GET',    '/shows'),
  add:      (body)     => req('POST',   '/shows', body),
  update:   (id, body) => req('PUT',    `/shows/${id}`, body),
  remove:   (id)       => req('DELETE', `/shows/${id}`),
  episodes: (id)       => req('GET',    `/shows/${id}/episodes`),
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
