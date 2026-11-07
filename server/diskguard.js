'use strict';

// Keeping the download disk from filling up.
//
// Web versions keep their own reserve (media.js, "Keep free"), but downloads
// are Transmission's: on 2026-11-06 they filled the media disk on their own,
// and with it went the database writes of everything sharing it. So every
// couple of minutes each Transmission instance is asked how much room is left
// where it downloads to. Below the reserve:
//
//   - nothing new is grabbed for that instance (searches and grabs wait), and
//   - its running downloads are paused — exactly those, remembered across
//     restarts, so that torrents someone paused by hand stay paused.
//
// Once there is room again (the reserve plus a margin, so it doesn't flap),
// the paused downloads are started again and grabbing carries on.

const tx = require('./transmission');
const { settings } = require('./db');
const log = require('./log');

const GB = 1e9;
const CHECK_MS = 2 * 60_000;
/** Resume only this far above the reserve, so a download finishing doesn't flap it. */
const MARGIN = 5 * GB;
const PAUSED_KEY = 'diskguard_paused';

/** name → { low, free, min, path, since, checkedAt, error } */
const state = new Map();

function minFree() {
  const n = Number(settings.get('download_min_free_gb'));
  return (Number.isFinite(n) && n >= 0 ? n : 30) * GB;
}

const gb = (b) => `${(b / GB).toFixed(1)} GB`;

/** Download folders as Transmission sees them; each is checked, the fullest counts. */
function downloadDirs() {
  return [...new Set([settings.get('movie_path'), settings.get('shows_path')].filter(Boolean))];
}

function pausedByUs() {
  try { const v = JSON.parse(settings.get(PAUSED_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; }
  catch (_) { return {}; }
}
function setPausedByUs(name, ids) {
  const all = pausedByUs();
  if (ids.length) all[name] = ids; else delete all[name];
  settings.set(PAUSED_KEY, JSON.stringify(all));
}

/** One instance: measure, then pause or resume as needed. */
async function checkTarget(target, { client = tx } = {}) {
  const min = minFree();
  const prev = state.get(target.name) || { low: false };
  let free = null, where = null;
  try {
    for (const dir of downloadDirs()) {
      const f = await client.freeSpace(dir, target);
      if (f !== null && (free === null || f < free)) { free = f; where = dir; }
    }
  } catch (err) {
    // Unreachable: keep what we knew. Nothing can download meanwhile anyway.
    state.set(target.name, { ...prev, error: err.message, checkedAt: new Date().toISOString() });
    return state.get(target.name);
  }
  const s = { ...prev, free, min, path: where, error: null, checkedAt: new Date().toISOString() };

  if (min > 0 && free !== null && free < min && !prev.low) {
    s.low = true;
    s.since = new Date().toISOString();
    let paused = [];
    try {
      paused = await client.activeDownloads(target);
      await client.stopTorrents(paused, target);
    } catch (err) {
      log.warn(`could not pause downloads on "${target.name}": ${err.message}`);
    }
    setPausedByUs(target.name, [...new Set([...(pausedByUs()[target.name] || []), ...paused])]);
    log.warn(`only ${gb(free)} free where "${target.name}" downloads (${where}; keeping ${gb(min)} free): `
      + `${paused.length ? `paused ${paused.length} download(s) and ` : ''}not grabbing anything new until there is room`);
  } else if (prev.low && (min === 0 || free === null || free >= min + MARGIN)) {
    s.low = false;
    s.since = null;
    const ids = pausedByUs()[target.name] || [];
    try {
      await client.startTorrents(ids, target);
      setPausedByUs(target.name, []);
    } catch (err) {
      log.warn(`could not resume downloads on "${target.name}": ${err.message}`);
    }
    log.info(`${free === null ? 'room' : `${gb(free)} free`} where "${target.name}" downloads again: `
      + `${ids.length ? `resumed ${ids.length} download(s); ` : ''}grabbing carries on`);
  }
  state.set(target.name, s);
  return s;
}

async function check(opts) {
  for (const t of tx.listTargets()) await checkTarget(t, opts);
}

/** Whether grabbing for this instance (a stored target name; empty = default) must wait. */
function isLow(targetName) {
  const name = tx.resolveTarget(targetName).name;
  return !!state.get(name)?.low;
}

/** For the status view: one entry per instance. */
function status() {
  return tx.listTargets().map(t => ({ name: t.name, ...(state.get(t.name) || { low: false, free: null }), min: minFree() }));
}

let timer = null;
function start() {
  // A restart while paused: the paused list is still in the settings, and the
  // first check (low again, or room again) carries on from there.
  for (const name of Object.keys(pausedByUs())) state.set(name, { low: true, since: null });
  const tick = () => check().catch(err => console.error('[diskguard] check failed:', err.message));
  tick();
  timer = setInterval(tick, CHECK_MS);
  timer.unref();
}

module.exports = { start, check, checkTarget, isLow, status, minFree, _state: state };
