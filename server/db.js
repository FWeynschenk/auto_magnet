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
  -- What the scheduler and manual grabs actually did, so "why didn't this
  -- download?" has an answer that outlives the process's stdout.
  CREATE TABLE IF NOT EXISTS scheduler_log (
    id          INTEGER PRIMARY KEY,
    run_at      TEXT NOT NULL DEFAULT (datetime('now')),
    level       TEXT NOT NULL DEFAULT 'info',
    entity_type TEXT,
    entity_id   INTEGER,
    message     TEXT NOT NULL
  );

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
  // When the candidate list was built. The UI shows its age, and a stale cache
  // is refreshed instead of being served silently.
  'ALTER TABLE movies   ADD COLUMN results_cached_at    TEXT',
  'ALTER TABLE episodes ADD COLUMN results_cached_at    TEXT',
  // Why the last attempt failed — content screen verdict, indexer error, etc.
  // Screening now finishes after the grab request returns, so this is the only
  // way the outcome ever reaches the user.
  'ALTER TABLE movies   ADD COLUMN last_error           TEXT',
  'ALTER TABLE episodes ADD COLUMN last_error           TEXT',
  'CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status)',
  'CREATE INDEX IF NOT EXISTS idx_episodes_show_status ON episodes(show_id, status)',
  'CREATE INDEX IF NOT EXISTS idx_movies_status   ON movies(status)',
  'CREATE INDEX IF NOT EXISTS idx_log_run_at ON scheduler_log(run_at DESC)',
  // Opt-in: grab a whole season in one torrent instead of episode by episode.
  'ALTER TABLE shows    ADD COLUMN prefer_season_pack INTEGER DEFAULT 0',
  // Which Transmission instance this item downloads to, by name. NULL = default.
  'ALTER TABLE movies   ADD COLUMN transmission_target TEXT',
  'ALTER TABLE shows    ADD COLUMN transmission_target TEXT',
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
  // How long a source search stays reusable. Keeps the Choose Torrent dialog
  // instant on reopen instead of re-querying every indexer.
  search_cache_mins:         '20',
  // Disc images (.iso/.img) hide their own contents from the file screen.
  allow_disc_images:         '0',
  // Minimum share of the requested title's words a release must contain.
  title_match_min:           '0.7',
  // What to do with a magnet whose metadata never arrives, so its contents
  // cannot be screened: 'start' it anyway, or 'block' and purge it.
  unverified_policy:         'start',
  // Extra named Transmission instances, as JSON: [{ name, host, port, user, pw }].
  // The transmission_* keys above describe the default one.
  transmission_extra:        '[]',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaultSettings)) {
  insertSetting.run(key, value);
}

/**
 * Drop server-only bulk from a row before it goes over the wire.
 *
 * `results_cache` holds up to 20 scored candidates, each with a parsed file
 * list. The list endpoints are polled every 30 seconds by both views and no
 * client code reads the field — the Choose Torrent dialog fetches it through
 * /api/search/preview instead.
 */
function publicRow(row) {
  if (!row) return row;
  const { results_cache, ...rest } = row;
  return rest;
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
    INSERT INTO movies (tmdb_id, imdb_id, title, year, poster_url, quality, mode,
                        release_date, transmission_target)
    VALUES ($tmdb_id, $imdb_id, $title, $year, $poster_url, $quality, $mode,
            $release_date, $transmission_target)
  `).run(p({ release_date: null, transmission_target: null, ...data })),

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
                       start_season, start_episode, number_of_seasons, show_status,
                       prefer_season_pack, transmission_target)
    VALUES ($tmdb_id, $imdb_id, $title, $poster_url, $quality, $mode,
            $start_season, $start_episode, $number_of_seasons, $show_status,
            $prefer_season_pack, $transmission_target)
  `).run(p({
    start_season: 1, start_episode: 1, number_of_seasons: null, show_status: null,
    prefer_season_pack: 0, transmission_target: null, ...data,
  })),

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

  forSeason: (showId, season) =>
    db.prepare('SELECT * FROM episodes WHERE show_id = ? AND season = ? ORDER BY episode')
      .all(showId, season),

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

// --- Activity log ---

const logs = {
  add: (level, entityType, entityId, message) =>
    db.prepare(`
      INSERT INTO scheduler_log (level, entity_type, entity_id, message)
      VALUES (?, ?, ?, ?)
    `).run(level, entityType, entityId, message),

  /**
   * Most recent entries, newest first. Filters are optional and bound as
   * parameters — never interpolated — so a crafted query string cannot reach
   * the SQL.
   */
  recent: ({ limit = 200, level = null, entityType = null, entityId = null } = {}) => {
    const where = [];
    const args  = [];
    if (level)      { where.push('level = ?');       args.push(level); }
    if (entityType) { where.push('entity_type = ?'); args.push(entityType); }
    if (entityId)   { where.push('entity_id = ?');   args.push(Number(entityId)); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    args.push(Math.min(Math.max(Number(limit) || 200, 1), 1000));
    return db.prepare(`
      SELECT * FROM scheduler_log ${clause} ORDER BY id DESC LIMIT ?
    `).all(...args);
  },

  prune: (days = 30) =>
    db.prepare(`DELETE FROM scheduler_log WHERE run_at < datetime('now', ?)`)
      .run(`-${Math.max(1, Number(days) || 30)} days`),

  clear: () => db.prepare('DELETE FROM scheduler_log').run(),

  count: () => db.prepare('SELECT COUNT(*) AS c FROM scheduler_log').get().c,
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

module.exports = { db, movies, shows, episodes, settings, seasonCache, logs, publicRow };
