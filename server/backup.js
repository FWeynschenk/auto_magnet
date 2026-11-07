'use strict';

// A copy of the database every day, keeping the last week.
//
// Everything auto_magnet knows — what is tracked, what was downloaded and
// checked, accounts, watch progress, settings — is in one SQLite file. A full
// disk or a bad write can leave it unreadable, so once a day it is copied with
// `VACUUM INTO`: a consistent snapshot taken while the server keeps running,
// compacted, never a half-written file. BACKUP_PATH puts the copies on another
// disk; by default they sit in `backups/` beside the database.

const fs = require('fs');
const path = require('path');
const { db, DB_PATH } = require('./db');
const log = require('./log');

const KEEP = 7;
const DAY_MS = 24 * 3600 * 1000;
const CHECK_MS = 3600 * 1000;
const NAME = /^auto_magnet-(\d{4}-\d{2}-\d{2})\.db$/;

const dir = () => process.env.BACKUP_PATH || path.join(path.dirname(path.resolve(DB_PATH)), 'backups');

let lastError = null;

/** Backups on disk, newest first: [{ file, date, bytes, at }]. */
function list() {
  let names = [];
  try { names = fs.readdirSync(dir()); } catch (_) { return []; }
  return names.filter(n => NAME.test(n)).map(n => {
    const file = path.join(dir(), n);
    let st = null;
    try { st = fs.statSync(file); } catch (_) {}
    return { file, date: NAME.exec(n)[1], bytes: st?.size ?? 0, at: st ? st.mtime.toISOString() : null };
  }).sort((a, b) => b.date.localeCompare(a.date));
}

/** Take today's backup now (replacing one already taken today), then prune. */
function backupNow() {
  fs.mkdirSync(dir(), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const out = path.join(dir(), `auto_magnet-${date}.db`);
  const tmp = `${out}.tmp`;
  fs.rmSync(tmp, { force: true });
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    fs.renameSync(tmp, out);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  for (const old of list().slice(KEEP)) fs.rmSync(old.file, { force: true });
  lastError = null;
  return { file: out, bytes: fs.statSync(out).size };
}

/** Back up if the newest copy is a day old or more. */
function maybeBackup() {
  const newest = list()[0];
  if (newest?.at && Date.now() - Date.parse(newest.at) < DAY_MS) return null;
  try {
    const r = backupNow();
    log.info(`database backed up (${(r.bytes / 1e6).toFixed(1)} MB) to ${r.file}`);
    return r;
  } catch (err) {
    lastError = err.message;
    log.warn(`database backup failed: ${err.message}`);
    return null;
  }
}

function status() {
  const all = list();
  return { dir: dir(), count: all.length, newest: all[0] || null, keep: KEEP, error: lastError };
}

function start() {
  setTimeout(maybeBackup, 60_000).unref();   // not in the middle of startup
  setInterval(maybeBackup, CHECK_MS).unref();
}

module.exports = { start, backupNow, maybeBackup, list, status, dir };
