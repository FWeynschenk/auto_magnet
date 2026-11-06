'use strict';

const Transmission = require('transmission');
const { settings } = require('./db');
const { screenFiles } = require('./screen');

// --- Targets ---------------------------------------------------------------
//
// The settings pair `transmission_*` describes the default instance. Additional
// named instances live in `transmission_extra` as JSON, so a show can be routed
// to the machine whose disk it belongs on.
//
// Torrent ids are per-instance and start at 1 everywhere, so anything that
// tracks a torrent has to carry the instance name alongside the id — otherwise
// #3 on one box silently reports the progress of #3 on another.

const DEFAULT_TARGET = 'default';

function defaultTarget() {
  return {
    name: DEFAULT_TARGET,
    host: settings.get('transmission_host') || 'localhost',
    port: parseInt(settings.get('transmission_port') || '9091'),
    user: settings.get('transmission_user') || '',
    pw:   settings.get('transmission_pw')   || '',
  };
}

function extraTargets() {
  let raw;
  try { raw = JSON.parse(settings.get('transmission_extra') || '[]'); }
  catch (_) { return []; }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(t => t && t.name && t.name !== DEFAULT_TARGET && t.host)
    .map(t => ({
      name: String(t.name),
      host: String(t.host),
      port: parseInt(t.port || '9091'),
      user: t.user || '',
      pw:   t.pw   || '',
    }));
}

/** Every configured instance, default first. */
function listTargets() {
  return [defaultTarget(), ...extraTargets()];
}

/** Resolve a stored target name to its config, falling back to the default. */
function resolveTarget(name) {
  if (!name || name === DEFAULT_TARGET) return defaultTarget();
  return extraTargets().find(t => t.name === name) || defaultTarget();
}

function getClient(target) {
  const t = target || defaultTarget();
  return new Transmission({
    host:     t.host,
    port:     t.port,
    username: t.user,
    password: t.pw,
  });
}

/**
 * Add a magnet or URL. Resolves with the torrent plus `duplicate: true` when
 * Transmission already had it.
 *
 * This deliberately bypasses the npm client's addUrl(), which returns
 * `torrent-added` and `torrent-duplicate` indistinguishably. That mattered: a
 * duplicate is *your existing torrent*, and anything that screens and purges
 * what it just "added" would delete a download you already had — data and all.
 */
async function addByUrl(url, downloadDir, paused = false, target = null) {
  const args = await rpc('torrent-add', { filename: url, 'download-dir': downloadDir, paused }, target);
  if (args?.['torrent-duplicate']) return { ...args['torrent-duplicate'], duplicate: true };
  if (args?.['torrent-added'])     return { ...args['torrent-added'],     duplicate: false };
  throw new Error('Transmission did not return torrent info');
}

/** Raw RPC call, reusing the 409 session-id handshake. */
async function rpc(method, args, target = null) {
  const t    = target || defaultTarget();
  const host = t.host;
  const port = t.port;
  const user = t.user;
  const pass = t.pw;

  const rpcUrl  = `http://${host}:${port}/transmission/rpc`;
  const headers = { 'Content-Type': 'application/json' };
  if (user) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${user}:${pass || ''}`).toString('base64');
  }
  const body = JSON.stringify({ method, arguments: args });

  let r = await fetch(rpcUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) });
  if (r.status === 409) {
    headers['X-Transmission-Session-Id'] = r.headers.get('X-Transmission-Session-Id') || '';
    r = await fetch(rpcUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) });
  }
  const json = await r.json();
  if (json.result !== 'success') throw new Error(json.result || 'Transmission RPC error');
  return json.arguments;
}

/** File list for a torrent, or null while metadata is still being fetched. */
async function getTorrentFiles(id, target = null) {
  const args = await rpc('torrent-get', { ids: [id], fields: ['id', 'files', 'metadataPercentComplete'] }, target);
  const t = args?.torrents?.[0];
  if (!t) return null;
  if (typeof t.metadataPercentComplete === 'number' && t.metadataPercentComplete < 1) return null;
  if (!Array.isArray(t.files) || t.files.length === 0) return null;
  return t.files.map(f => ({ path: f.name, length: f.length }));
}

/** Every torrent on one instance, with just the fields asked for. */
async function listTorrents(fields, target = null) {
  const args = await rpc('torrent-get', { fields: ['id', ...fields] }, target);
  return args?.torrents || [];
}

/**
 * Point a torrent at a new folder. With move=true Transmission relocates the
 * data itself — a rename when it stays on the same disk — and keeps seeding.
 */
async function setTorrentLocation(id, location, { move = true, target = null } = {}) {
  await rpc('torrent-set-location', { ids: [id], location, move }, target);
}

/** Where a torrent lives and what is in it, or null if Transmission no longer has it. */
async function getTorrentInfo(id, target = null) {
  const args = await rpc('torrent-get', {
    ids: [id], fields: ['id', 'name', 'downloadDir', 'files', 'percentDone'],
  }, target);
  const t = args?.torrents?.[0];
  if (!t) return null;
  return {
    id: t.id, name: t.name, downloadDir: t.downloadDir, percentDone: t.percentDone,
    files: (t.files || []).map(f => ({ name: f.name, length: f.length })),
  };
}

/** How much a torrent has seeded: its upload ratio and time spent seeding. */
async function getSeedInfo(id, target = null) {
  const args = await rpc('torrent-get', {
    ids: [id], fields: ['id', 'name', 'downloadDir', 'files', 'percentDone', 'uploadRatio', 'secondsSeeding', 'doneDate'],
  }, target);
  const t = args?.torrents?.[0];
  if (!t) return null;
  return {
    id: t.id, name: t.name, downloadDir: t.downloadDir, percentDone: t.percentDone,
    // Transmission reports -1 (no data) and -2 (infinite: nothing downloaded) as ratios.
    uploadRatio: t.uploadRatio === -2 ? Infinity : Math.max(0, Number(t.uploadRatio) || 0),
    secondsSeeding: Number(t.secondsSeeding) || 0,
    files: (t.files || []).map(f => ({ name: f.name, length: f.length })),
  };
}

/**
 * Stop wanting some of a torrent's files (by index in its file list), so
 * Transmission neither downloads nor checks them again. The rest keep seeding.
 */
async function setFilesUnwanted(id, indexes, target = null) {
  await rpc('torrent-set', { ids: [id], 'files-unwanted': indexes }, target);
}

async function startTorrent(id, target = null) { await rpc('torrent-start',  { ids: [id] }, target); }
async function stopTorrent(id, target = null)  { await rpc('torrent-stop',   { ids: [id] }, target); }
async function purgeTorrent(id, target = null) { await rpc('torrent-remove', { ids: [id], 'delete-local-data': true }, target); }

function screenedError(reason) {
  const err = new Error(`rejected by content screen: ${reason}`);
  err.screened = true;
  return err;
}

// --- Quarantine --------------------------------------------------------------
//
// A magnet carries no file list. The only way to learn what is inside is to let
// Transmission fetch the metadata from peers — and Transmission only talks to
// peers while a torrent is *running*. The previous design added magnets paused
// and waited for a file list that could therefore never arrive: every magnet
// timed out and was started unscreened. That is how full-size .exe and .scr
// payloads reached the disk.
//
// So a magnet now runs from the start, but throttled to a trickle and labelled.
// The throttle is the quarantine: metadata (tens of kilobytes) gets through,
// payload effectively doesn't. Only a passing screen lifts it. Nothing is ever
// released on a timer — a torrent still unresolved after the grab-time watch
// stays quarantined, and sweepQuarantine() finishes the job on a later run.

const QUARANTINE_LABEL = 'amagnet-quarantine';
const QUARANTINE_KBPS  = 4;        // plenty for metadata, useless for payload
// How long the grab-time watcher polls before handing over to the sweep.
// Overridable so the timeout path — the one that used to release unscreened
// torrents — can be tested without waiting two minutes.
const WATCH_MS = Number(process.env.AMAGNET_QUARANTINE_WATCH_MS) || 120_000;

async function quarantine(id, target) {
  await rpc('torrent-set', {
    ids: [id],
    downloadLimited: true,
    downloadLimit:   QUARANTINE_KBPS,
    labels:          [QUARANTINE_LABEL],
  }, target);
}

async function release(id, target) {
  await rpc('torrent-set', { ids: [id], downloadLimited: false, labels: [] }, target);
  await startTorrent(id, target);
}

/**
 * One screening attempt on a quarantined torrent. Resolves `{ pending: true }`
 * while metadata is still missing; otherwise the verdict, having already
 * released or purged the torrent to match it.
 */
async function screenOnce(id, { type = 'movie', allowPacks = false, target = null } = {}) {
  const files = await getTorrentFiles(id, target);
  if (!files) return { pending: true };

  const verdict = screenFiles(files, { type, allowPacks });
  if (!verdict.ok) {
    console.warn(`[transmission] purging torrent #${id} — ${verdict.reason}`);
    await purgeTorrent(id, target);
    return verdict;
  }
  await release(id, target);
  return verdict;
}

/** Poll a quarantined torrent for a while. Resolves pending if it stays unresolved. */
async function watchQuarantined(id, opts = {}) {
  const deadline = Date.now() + (opts.waitMs ?? WATCH_MS);
  let interval = 1500;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const v = await screenOnce(id, opts);
      if (!v.pending) return v;
    } catch (err) {
      // A transient RPC failure is not a verdict. It stays quarantined, and
      // the sweep picks it up — the old code *started* it here, unscreened.
      console.warn(`[transmission] screening torrent #${id} hiccupped: ${err.message}`);
    }
    interval = Math.min(interval * 1.4, 10_000);
  }
  return { pending: true };
}

/**
 * Add a magnet into quarantine and screen it in the background.
 *
 * Returns as soon as Transmission has it. `onVerdict` receives the outcome —
 * pass, fail, or `{ pending: true }` if the metadata hadn't arrived by the end
 * of the watch, in which case the torrent stays throttled for the sweep.
 *
 * A duplicate is left exactly as it is. It is a torrent you already had, and
 * quarantining or purging it would act on your existing download.
 */
async function addQuarantined(url, downloadDir, screen, onVerdict, target = null) {
  // Added paused so the throttle and label are in place before it ever runs:
  // there is no moment at which it downloads at full speed.
  const added = await addByUrl(url, downloadDir, true, target);
  if (added.duplicate) return added;

  await quarantine(added.id, target);
  await startTorrent(added.id, target);

  watchQuarantined(added.id, { type: screen?.type, allowPacks: !!screen?.allowPacks, target })
    .then(v => onVerdict?.(v, added))
    .catch(err => console.error('[transmission] quarantine watch error:', err.message));

  return { ...added, quarantined: true };
}

/**
 * Every torrent currently in quarantine, across all instances.
 * Used by the sweep, and survives restarts because the label lives in
 * Transmission rather than in this process.
 */
async function listQuarantined() {
  const out = [];
  await Promise.all(listTargets().map(async (target) => {
    try {
      const args = await withTimeout(
        rpc('torrent-get', { fields: ['id', 'name', 'labels', 'addedDate', 'metadataPercentComplete'] }, target),
        PROBE_TIMEOUT_MS * 3, null,
      );
      for (const t of args?.torrents || []) {
        if ((t.labels || []).includes(QUARANTINE_LABEL)) out.push({ ...t, target: target.name });
      }
    } catch (err) {
      console.warn(`[transmission] "${target.name}" unreachable during quarantine sweep: ${err.message}`);
    }
  }));
  return out;
}

// Send .torrent file bytes as base64 via Transmission RPC directly.
// The transmission npm package doesn't expose the metainfo field, so we
// call the RPC ourselves. Needed when download_url is on the Docker-internal
// network that Transmission (on a different host) can't reach.
async function addByBase64(base64, downloadDir, target = null, { paused = false } = {}) {
  const args = await rpc('torrent-add', { metainfo: base64, 'download-dir': downloadDir, paused }, target);
  if (args?.['torrent-duplicate']) return { ...args['torrent-duplicate'], duplicate: true };
  if (args?.['torrent-added'])     return { ...args['torrent-added'],     duplicate: false };
  throw new Error('Transmission did not return torrent info');
}

/**
 * Add a magnet or .torrent URL to Transmission.
 *
 * @param {Object}   opts
 * @param {Object}   [opts.screen]     { type } — enables content screening
 * @param {Array}    [opts.files]      known file list; screens instantly, no waiting
 * @param {Function} [opts.onVerdict]  return immediately and screen in the background
 */
/**
 * Add a magnet or .torrent URL to Transmission. Nothing is ever added
 * unscreened: every path either judges a known file list up front or goes
 * through quarantine.
 *
 * Resolves with the Transmission torrent plus:
 *   verified     true when the contents were screened and passed before adding
 *   quarantined  true when it is throttled pending its file list; the verdict
 *                arrives later through `onVerdict` or sweepQuarantine()
 *   duplicate    true when Transmission already had it — left untouched
 *
 * @param {Object}   opts
 * @param {Object}   [opts.screen]     { type, allowPacks }
 * @param {Array}    [opts.files]      known file list; judged instantly
 * @param {string}   [opts.target]     Transmission instance name
 * @param {Function} [opts.onVerdict]  (verdict, torrent) for quarantined adds
 */
async function addTorrent(magnetOrUrl, downloadDir, opts = {}) {
  if (!magnetOrUrl) throw new Error('no magnet or download URL provided');

  // opts.target is a stored instance *name*; an unknown one falls back to the
  // default rather than failing, so deleting an instance never strands items.
  const target = resolveTarget(opts.target);
  const screen = opts.screen || { type: 'movie' };
  const judge  = (files) => screenFiles(files, {
    type: screen.type || 'movie', allowPacks: !!screen.allowPacks,
  });

  // When the search already parsed the .torrent we know the contents, so the
  // verdict is free and instant — no quarantine, no metadata wait.
  if (opts.files?.length) {
    const verdict = judge(opts.files);
    if (!verdict.ok) throw screenedError(verdict.reason);
    const added = await addByUrl(magnetOrUrl, downloadDir, false, target);
    return { ...added, verified: !added.duplicate, warnings: verdict.warnings };
  }

  if (magnetOrUrl.startsWith('magnet:')) {
    return addQuarantined(magnetOrUrl, downloadDir, screen, opts.onVerdict, target);
  }

  // .torrent URL — Prowlarr sometimes redirects these to magnet: URIs.
  // Catch the redirect manually; if it's a magnet use it directly.
  // Otherwise download the .torrent bytes and send as base64 metainfo.
  console.log('[transmission] resolving download URL:', magnetOrUrl.substring(0, 120));
  let resp;
  try {
    resp = await fetch(magnetOrUrl, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new Error(`download URL fetch failed: ${err.cause?.message || err.message}`);
  }

  const location = resp.headers.get('location') || '';
  if (location.startsWith('magnet:')) {
    // This used to go straight to addByUrl — a second way for a magnet to be
    // added with no screening at all.
    console.log('[transmission] redirected to magnet, quarantining');
    return addQuarantined(location, downloadDir, screen, opts.onVerdict, target);
  }

  // Follow non-magnet redirects or read the body directly
  const redirectTo = (resp.status >= 300 && resp.status < 400 && location) ? location : null;
  let bodyResp = resp;
  if (redirectTo) {
    try {
      bodyResp = await fetch(redirectTo, { signal: AbortSignal.timeout(30000) });
    } catch (err) {
      throw new Error(`torrent redirect fetch failed: ${err.cause?.message || err.message}`);
    }
  }
  if (!bodyResp.ok) throw new Error(`Failed to download torrent file: HTTP ${bodyResp.status}`);
  const bytes = Buffer.from(await bodyResp.arrayBuffer());

  // We hold the .torrent, so screen its file list directly — no need to add it
  // to Transmission first.
  const { parseTorrent } = require('./sources/torrent-meta');
  const meta = parseTorrent(bytes);
  if (meta?.files?.length) {
    const verdict = judge(meta.files);
    if (!verdict.ok) throw screenedError(verdict.reason);
    const added = await addByBase64(bytes.toString('base64'), downloadDir, target);
    return { ...added, verified: !added.duplicate, warnings: verdict.warnings };
  }

  // Unparseable bytes. Transmission can read them even though we couldn't, and
  // with the metainfo supplied it has the file list the moment it is added —
  // so add paused, ask it, and judge before anything runs.
  const added = await addByBase64(bytes.toString('base64'), downloadDir, target, { paused: true });
  if (added.duplicate) return added;
  const files = await getTorrentFiles(added.id, target);
  if (!files) {
    await purgeTorrent(added.id, target);
    throw screenedError('file list could not be read from the .torrent');
  }
  const verdict = judge(files);
  if (!verdict.ok) {
    await purgeTorrent(added.id, target);
    throw screenedError(verdict.reason);
  }
  await startTorrent(added.id, target);
  return { ...added, verified: true, warnings: verdict.warnings };
}

function getTorrents(target = null) {
  return new Promise((resolve, reject) => {
    getClient(target).get((err, arg) => {
      if (err) reject(err);
      else resolve(arg?.torrents || []);
    });
  });
}

/**
 * Settle `promise` within `ms`, or resolve to `fallback`.
 *
 * The transmission client has no timeout of its own, so a host that is simply
 * switched off never calls back. With several instances configured that would
 * hang the status endpoint and the scheduler's progress sync indefinitely — one
 * unreachable box must not take the rest down with it.
 */
function withTimeout(promise, ms, fallback) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const PROBE_TIMEOUT_MS = 5000;

function testOne(target) {
  const probe = new Promise((resolve) => {
    try {
      getClient(target).sessionStats((err, arg) => {
        if (err) resolve({ name: target.name, connected: false, error: err.message });
        else resolve({ name: target.name, connected: true, stats: arg });
      });
    } catch (err) {
      resolve({ name: target.name, connected: false, error: err.message });
    }
  });
  return withTimeout(probe, PROBE_TIMEOUT_MS, {
    name: target.name, connected: false, error: 'timed out',
  });
}

/**
 * Status of every configured instance. The top-level `connected` still reports
 * the default one so existing callers (the navbar indicator) keep working.
 */
async function testConnection() {
  const results = await Promise.all(listTargets().map(testOne));
  const primary = results[0] || { connected: false, error: 'no instance configured' };
  return { ...primary, instances: results };
}

/**
 * Poll Transmission for all active torrents and return a Map of
 * torrentId → { progress: 0-100, done: boolean }
 */
async function getTorrentProgress() {
  const map = new Map();
  await Promise.all(listTargets().map(async (target) => {
    try {
      const torrents = await withTimeout(getTorrents(target), PROBE_TIMEOUT_MS * 3, null);
      if (torrents === null) {
        console.warn(`[transmission] "${target.name}" timed out while listing torrents`);
        return;
      }
      for (const t of torrents) {
        // Keyed by instance as well as id: ids restart at 1 on every box, so an
        // id alone would read another machine's torrent as this one's progress.
        map.set(progressKey(target.name, t.id), {
          progress: Math.round((t.percentDone || 0) * 100),
          done:     (t.percentDone || 0) >= 1,
        });
      }
    } catch (err) {
      console.warn(`[transmission] "${target.name}" unreachable: ${err.message}`);
    }
  }));
  return map;
}

/** Map key for getTorrentProgress(). */
function progressKey(targetName, torrentId) {
  return `${targetName || DEFAULT_TARGET}:${torrentId}`;
}

function removeTorrent(id, targetName = null) {
  const target = resolveTarget(targetName);
  return new Promise((resolve, reject) => {
    getClient(target).remove([id], false, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

module.exports = {
  addTorrent, getTorrentProgress, testConnection, removeTorrent,
  getTorrentFiles, getTorrentInfo, getSeedInfo, startTorrent, stopTorrent, purgeTorrent, setFilesUnwanted,
  listTorrents, setTorrentLocation,
  screenOnce, listQuarantined, QUARANTINE_LABEL,
  listTargets, resolveTarget, progressKey,
};
