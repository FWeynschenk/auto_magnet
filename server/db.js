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
`);

// Schema migrations — safe to run on every startup
const migrations = [
  'ALTER TABLE movies   ADD COLUMN results_cache TEXT',
  'ALTER TABLE episodes ADD COLUMN results_cache TEXT',
  'ALTER TABLE shows    ADD COLUMN start_season  INTEGER DEFAULT 1',
  'ALTER TABLE shows    ADD COLUMN start_episode INTEGER DEFAULT 1',
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) {}
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
  min_seeds:         process.env.MIN_SEEDS          || '10',
  default_quality:   process.env.DEFAULT_QUALITY    || '1080p',
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
  pending: () => db.prepare("SELECT * FROM movies WHERE status IN ('pending', 'failed')").all(),

  insert: (data) => db.prepare(`
    INSERT INTO movies (tmdb_id, imdb_id, title, year, poster_url, quality, mode)
    VALUES ($tmdb_id, $imdb_id, $title, $year, $poster_url, $quality, $mode)
  `).run(p(data)),

  update: (id, data) => {
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
    INSERT INTO shows (tmdb_id, imdb_id, title, poster_url, quality, mode, start_season, start_episode)
    VALUES ($tmdb_id, $imdb_id, $title, $poster_url, $quality, $mode, $start_season, $start_episode)
  `).run(p({ start_season: 1, start_episode: 1, ...data })),

  update: (id, data) => {
    const fields = Object.keys(data).map(k => `${k} = $${k}`).join(', ');
    db.prepare(`UPDATE shows SET ${fields} WHERE id = $id`).run(p({ ...data, id }));
  },

  remove: (id) => db.prepare('DELETE FROM shows WHERE id = ?').run(id),
};

const episodes = {
  forShow: (showId) =>
    db.prepare('SELECT * FROM episodes WHERE show_id = ? ORDER BY season, episode').all(showId),

  latest: (showId) =>
    db.prepare('SELECT * FROM episodes WHERE show_id = ? ORDER BY season DESC, episode DESC LIMIT 1').get(showId),

  exists: (showId, season, episode) =>
    db.prepare('SELECT id FROM episodes WHERE show_id = ? AND season = ? AND episode = ?').get(showId, season, episode),

  get: (showId, season, episode) =>
    db.prepare('SELECT * FROM episodes WHERE show_id = ? AND season = ? AND episode = ?').get(showId, season, episode),

  byId: (id) =>
    db.prepare('SELECT * FROM episodes WHERE id = ?').get(id),

  insert: (data) => db.prepare(`
    INSERT OR IGNORE INTO episodes (show_id, season, episode, status, magnet, torrent_id, results_cache)
    VALUES ($show_id, $season, $episode, $status, $magnet, $torrent_id, $results_cache)
  `).run(p({ results_cache: null, ...data })),

  remove: (id) => db.prepare('DELETE FROM episodes WHERE id = ?').run(id),

  update: (id, data) => {
    const fields = Object.keys(data).map(k => `${k} = $${k}`).join(', ');
    db.prepare(`UPDATE episodes SET ${fields} WHERE id = $id`).run(p({ ...data, id }));
  },
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

module.exports = { db, movies, shows, episodes, settings };
