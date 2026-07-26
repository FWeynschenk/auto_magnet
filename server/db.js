'use strict';

require('dotenv').config();
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'auto_magnet.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS movies (
    id          INTEGER PRIMARY KEY,
    tmdb_id     INTEGER UNIQUE,
    imdb_id     TEXT,
    title       TEXT NOT NULL,
    year        INTEGER,
    poster_url  TEXT,
    status      TEXT DEFAULT 'pending',
    quality     TEXT DEFAULT '1080p',
    mode        TEXT DEFAULT 'auto',
    magnet      TEXT,
    torrent_id  INTEGER,
    added_at    TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS shows (
    id          INTEGER PRIMARY KEY,
    tmdb_id     INTEGER UNIQUE,
    imdb_id     TEXT,
    title       TEXT NOT NULL,
    poster_url  TEXT,
    active      INTEGER DEFAULT 1,
    status      TEXT DEFAULT 'active',
    quality     TEXT DEFAULT '1080p',
    mode        TEXT DEFAULT 'auto',
    added_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS episodes (
    id          INTEGER PRIMARY KEY,
    show_id     INTEGER REFERENCES shows(id) ON DELETE CASCADE,
    season      INTEGER NOT NULL,
    episode     INTEGER NOT NULL,
    status      TEXT DEFAULT 'pending',
    magnet      TEXT,
    torrent_id  INTEGER,
    added_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(show_id, season, episode)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Cached TMDB season responses. A season whose episodes have all aired never
  -- changes, so it is stored with immutable = 1 and never re-fetched.
  -- payload IS NULL records a confirmed 404 (season does not exist).
  CREATE TABLE IF NOT EXISTS tmdb_season_cache (
    tmdb_id       INTEGER NOT NULL,
    season_number INTEGER NOT NULL,
    payload       TEXT,
    immutable     INTEGER NOT NULL DEFAULT 0,
    fetched_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tmdb_id, season_number)
  );
`);

// Schema migrations — safe to run on every startup
const migrations = [
  'ALTER TABLE movies   ADD COLUMN results_cache TEXT',
  'ALTER TABLE episodes ADD COLUMN results_cache TEXT',
  'ALTER TABLE shows    ADD COLUMN start_season  INTEGER DEFAULT 1',
  'ALTER TABLE shows    ADD COLUMN start_episode INTEGER DEFAULT 1',
  'ALTER TABLE movies   ADD COLUMN release_date         TEXT',
  'ALTER TABLE movies   ADD COLUMN progress             INTEGER DEFAULT 0',
  'ALTER TABLE episodes ADD COLUMN air_date             TEXT',
  'ALTER TABLE episodes ADD COLUMN progress             INTEGER DEFAULT 0',
  'ALTER TABLE movies   ADD COLUMN download_started_at  TEXT',
  'ALTER TABLE episodes ADD COLUMN download_started_at  TEXT',
  'ALTER TABLE movies   ADD COLUMN tried_magnets        TEXT',
  'ALTER TABLE episodes ADD COLUMN tried_magnets        TEXT',
  // Cached from TMDB so the scheduler knows the season range without an extra
  // API call per run, and can auto-pause shows TMDB reports as finished.
  'ALTER TABLE shows    ADD COLUMN number_of_seasons    INTEGER',
  'ALTER TABLE shows    ADD COLUMN show_status          TEXT',
  'CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status)',
  'CREATE INDEX IF NOT EXISTS idx_episodes_show_status ON episodes(show_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_movies_status   ON movies(status)',
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) {}
}

// Real column sets, read back after migrations. The update() helpers below build
// SQL from object keys, so keys are validated against these to keep a future
// unfiltered caller from turning into SQL injection.
function columnsOf(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
}
const COLUMNS = {
  movies:   columnsOf('movies'),
  shows:    columnsOf('shows'),
  episodes: columnsOf('episodes'),
};

function assertColumns(table, data) {
  const keys = Object.keys(data);
  if (keys.length === 0) throw new Error(`${table}.update called with no fields`);
  for (const k of keys) {
    if (!COLUMNS[table].has(k)) {
      throw new Error(`Refusing to update unknown column "${k}" on ${table}`);
    }
  }
}

// Seed defaults from .env on first run (INSERT OR IGNORE = won't overwrite saved settings)
const defaultSettings = {
  transmission_host: process.env.TRANSMISSION_HOST || 'localhost',
  transmission_port: process.env.TRANSMISSION_PORT || '9091',
  transmission_user: process.env.TRANSMISSION_USER || '',
  transmission_pw:   process.env.TRANSMISSION_PW   || '',
  movie_path:        process.env.MOVIEPATH          || '',
  shows_path:        process.env.SHOWSPATH          || '',
  prowlarr_host:     process.env.PROWLARR_HOST      || 'localhost',
  prowlarr_port:     process.env.PROWLARR_PORT      || '9696',
  prowlarr_api_key:  process.env.PROWLARR_API_KEY   || '',
  tmdb_api_key:      process.env.TMDB_API_KEY       || '',
  min_seeds:                 process.env.MIN_SEEDS          || '10',
  default_quality:           process.env.DEFAULT_QUALITY    || '1080p',
  scheduler_interval_mins:   '60',
  min_size_mb:               '200',
  max_size_gb:               '60',
  air_date_buffer_hours:     '4',
  tmdb_region:               'US',
  preferred_movie_groups:    'yts,yify',
  preferred_show_groups:     'eztv,tgx,ettv,rartv',
  quality_strict:            '0',
  blocked_tags:              '',
  trusted_only:              '0',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaultSettings)) {
  insertSetting.run(key, value);
}

// Helper: convert a plain object { key: val } → { '$key': val } for named params
function p(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [`$${k}`, v]));
}

// --- Query helpers ---

const movies = {
  all: () => db.prepare('SELECT * FROM movies ORDER BY added_at DESC').all(),
  byId: (id) => db.prepare('SELECT * FROM movies WHERE id = ?').get(id),
  pending:     () => db.prepare("SELECT * FROM movies WHERE status IN ('pending', 'failed')").all(),
  downloading: () => db.prepare("SELECT * FROM movies WHERE status = 'downloading' AND torrent_id IS NOT NULL").all(),

  insert: (data) => db.prepare(`
    INSERT INTO movies (tmdb_id, imdb_id, title, year, poster_url, quality, mode, release_date)
    VALUES ($tmdb_id, $imdb_id, $title, $year, $poster_url, $quality, $mode, $release_date)
  `).run(p({ release_date: null, ...data })),

  update: (id, data) => {
    assertColumns('movies', data);
    const fields = Object.keys(data).map(k => `${k} = $${k}`).join(', ');
    db.prepare(`UPDATE movies SET ${fields}, updated_at = datetime('now') WHERE id = $id`)
      .run(p({ ...data, id }));
  },

  remove: (id) => db.prepare('DELETE FROM movies WHERE id = ?').run(id),
};

const shows = {
  all: () => db.prepare('SELECT * FROM shows ORDER BY added_at DESC').all(),
  byId: (id) => db.prepare('SELECT * FROM shows WHERE id = ?').get(id),
  active: () => db.prepare('SELECT * FROM shows WHERE active = 1').all(),

  insert: (data) => db.prepare(`
    INSERT INTO shows (tmdb_id, imdb_id, title, poster_url, quality, mode,
                       start_season, start_episode, number_of_seasons, show_status)
    VALUES ($tmdb_id, $imdb_id, $title, $poster_url, $quality, $mode,
            $start_season, $start_episode, $number_of_seasons, $show_status)
  `).run(p({ start_season: 1, start_episode: 1, number_of_seasons: null, show_status: null, ...data })),

  update: (id, data) => {
    assertColumns('shows', data);
    const fields = Object.keys(data).map(k => `${k} = $${k}`).join(', ');
    db.prepare(`UPDATE shows SET ${fields} WHERE id = $id`).run(p({ ...data, id }));
  },

  remove: (id) => db.prepare('DELETE FROM shows WHERE id = ?').run(id),
};

const episodes = {
  forShow: (showId) =>
    db.prepare('SELECT * FROM episodes WHERE show_id = ? ORDER BY season, episode').all(showId),

  downloading: () => db.prepare("SELECT * FROM episodes WHERE status = 'downloading' AND torrent_id IS NOT NULL").all(),
  failed:      (showId) => db.prepare("SELECT * FROM episodes WHERE show_id = ? AND status = 'failed'").all(showId),

  // Latest episode that has actually been grabbed (excludes 'upcoming' placeholders)
  latest: (showId) =>
    db.prepare("SELECT * FROM episodes WHERE show_id = ? AND status != 'upcoming' ORDER BY season DESC, episode DESC LIMIT 1").get(showId),

  // All upcoming placeholders for a show
  upcoming: (showId) =>
    db.prepare("SELECT * FROM episodes WHERE show_id = ? AND status = 'upcoming' ORDER BY season, episode").all(showId),

  exists: (showId, season, episode) =>
    db.prepare('SELECT id FROM episodes WHERE show_id = ? AND season = ? AND episode = ?').get(showId, season, episode),

  get: (showId, season, episode) =>
    db.prepare('SELECT * FROM episodes WHERE show_id = ? AND season = ? AND episode = ?').get(showId, season, episode),

  byId: (id) =>
    db.prepare('SELECT * FROM episodes WHERE id = ?').get(id),

  insert: (data) => db.prepare(`
    INSERT OR IGNORE INTO episodes (show_id, season, episode, status, magnet, torrent_id, results_cache, air_date)
    VALUES ($show_id, $season, $episode, $status, $magnet, $torrent_id, $results_cache, $air_date)
  `).run(p({ results_cache: null, air_date: null, ...data })),

  remove: (id) => db.prepare('DELETE FROM episodes WHERE id = ?').run(id),

  update: (id, data) => {
    assertColumns('episodes', data);
    const fields = Object.keys(data).map(k => `${k} = $${k}`).join(', ');
    db.prepare(`UPDATE episodes SET ${fields} WHERE id = $id`).run(p({ ...data, id }));
  },

  // The scheduler's work queue. sync() owns the aired/unaired decision, so a row
  // being 'pending' already means it has aired and is ready to grab. 'failed' is
  // deliberately excluded — it stays terminal until Redo or Retry Failed.
  pending: (showId) =>
    db.prepare("SELECT * FROM episodes WHERE show_id = ? AND status = 'pending' ORDER BY season, episode").all(showId),

  // First pending episode only — manual mode queues one approval at a time.
  firstPending: (showId) =>
    db.prepare("SELECT * FROM episodes WHERE show_id = ? AND status = 'pending' ORDER BY season, episode LIMIT 1").get(showId),
};

// --- TMDB season cache ---

const REFRESH_TTL_HOURS = 12;

const seasonCache = {
  get: (tmdbId, season) =>
    db.prepare('SELECT * FROM tmdb_season_cache WHERE tmdb_id = ? AND season_number = ?')
      .get(tmdbId, season),

  set: (tmdbId, season, payload, isImmutable) =>
    db.prepare(`
      INSERT INTO tmdb_season_cache (tmdb_id, season_number, payload, immutable, fetched_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT (tmdb_id, season_number) DO UPDATE SET
        payload    = excluded.payload,
        immutable  = excluded.immutable,
        fetched_at = excluded.fetched_at
    `).run(tmdbId, season, payload === null ? null : JSON.stringify(payload), isImmutable ? 1 : 0),

  /** True when a cached row is still usable: immutable, or fetched within the TTL. */
  isFresh: (row) => {
    if (!row) return false;
    if (row.immutable) return true;
    const age = Date.now() - new Date(row.fetched_at.replace(' ', 'T') + 'Z').getTime();
    return age < REFRESH_TTL_HOURS * 3600 * 1000;
  },

  clear: (tmdbId) =>
    db.prepare('DELETE FROM tmdb_season_cache WHERE tmdb_id = ?').run(tmdbId),
};

const settings = {
  all: () => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  },
  get: (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value,
  set: (key, value) => db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value),
  setMany: (data) => {
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    db.exec('BEGIN');
    try {
      for (const [k, v] of Object.entries(data)) stmt.run(k, v);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },
};

module.exports = { db, movies, shows, episodes, settings, seasonCache };
