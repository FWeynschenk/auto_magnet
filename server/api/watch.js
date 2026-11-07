'use strict';

// Everything a player needs: what can be watched, how to play it, its
// subtitles, and where each user left off. Open to every signed-in user,
// viewers included; the few routes that change the library are admin-only.

const fs      = require('fs');
const path    = require('path');
const express = require('express');
const router  = express.Router();

const { db, shows, episodes, movies } = require('../db');
const media    = require('../media');
const prefs = require('../prefs');
const thumbs = require('../thumbs');
const progress = require('../progress');
const subsync  = require('../subsync');
const { requireAdmin } = require('../auth');
const log = require('../log');

const wrap = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.message });
  }
};

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function params(req) {
  const kind = req.params.kind;
  const id = Number(req.params.id);
  if (!media.KINDS.has(kind) || !Number.isInteger(id) || id <= 0) throw bad('Bad item');
  return { kind, id };
}

const base = (kind, id) => `/api/watch/items/${kind}/${id}`;

function progressOf(p) {
  return p ? { position: p.position, duration: p.duration, watched: !!p.watched, updated_at: p.updated_at } : null;
}

/** What a card in a listing shows. Cheap: no disk access. */
function summary(item, prog) {
  const m = media.rows.get(item.kind, item.id);
  const out = {
    kind: item.kind, id: item.id, title: item.title, poster_url: item.poster_url,
    duration: m?.duration || prog?.duration || null,
    plan: m?.plan || null, web_state: m?.web_state || null,
    progress: progressOf(prog),
  };
  if (item.kind === 'movie') out.year = item.year;
  else Object.assign(out, {
    show_id: item.show.id, show_title: item.show_title, season: item.season, episode: item.episode,
    still_url: item.still_url, air_date: item.air_date,
  });
  return out;
}

const progFor = (req) => (req.user.legacy ? new Map() : progress.forUser(req.user.id));

// ─── Browsing ─────────────────────────────────────────────────────────────────

router.get('/home', wrap((req) => {
  const prog = progFor(req);
  const toItem = (kind, id) => media.itemFor(kind, id);
  const cont = req.user.legacy ? [] : progress.inProgress(req.user.id, 20)
    .map(p => toItem(p.kind, p.item_id)).filter(i => i && i.status === 'done')
    .map(i => summary(i, prog.get(`${i.kind}:${i.id}`)));
  const next = req.user.legacy ? [] : progress.nextUp(req.user.id, 20)
    .map(e => toItem('episode', e.id)).filter(Boolean)
    .map(i => summary(i, prog.get(`episode:${i.id}`)));
  const recent = db.prepare(`
    SELECT 'movie' AS kind, id, COALESCE(completed_at, updated_at) AS at FROM movies WHERE status = 'done'
    UNION ALL
    SELECT 'episode' AS kind, id, COALESCE(completed_at, added_at) AS at FROM episodes WHERE status = 'done'
    ORDER BY at DESC LIMIT 24
  `).all().map(r => toItem(r.kind, r.id)).filter(Boolean).map(i => summary(i, prog.get(`${i.kind}:${i.id}`)));
  return { continue: cont, nextUp: next, recent };
}));

router.get('/movies', wrap((req) => {
  const prog = progFor(req);
  return db.prepare("SELECT id FROM movies WHERE status = 'done' ORDER BY title COLLATE NOCASE").all()
    .map(r => media.itemFor('movie', r.id)).filter(Boolean)
    .map(i => summary(i, prog.get(`movie:${i.id}`)));
}));

router.get('/shows', wrap((req) => {
  const uid = req.user.legacy ? -1 : req.user.id;
  return db.prepare(`
    SELECT s.id, s.title, s.poster_url,
           COUNT(e.id) AS available,
           SUM(CASE WHEN p.watched = 1 THEN 1 ELSE 0 END) AS watched,
           MAX(COALESCE(e.completed_at, e.added_at)) AS latest
    FROM shows s JOIN episodes e ON e.show_id = s.id AND e.status = 'done'
    LEFT JOIN playback_progress p ON p.user_id = ? AND p.kind = 'episode' AND p.item_id = e.id
    GROUP BY s.id ORDER BY s.title COLLATE NOCASE
  `).all(uid).map(s => ({ ...s, unwatched: s.available - (s.watched || 0) }));
}));

router.get('/shows/:id', wrap((req) => {
  const show = shows.byId(Number(req.params.id));
  if (!show) throw bad('Not found', 404);
  const prog = progFor(req);
  const seasons = new Map();
  for (const e of episodes.forShow(show.id)) {
    if (!['done', 'downloading', 'upcoming', 'pending', 'deleted'].includes(e.status)) continue;
    const item = media.itemFor('episode', e.id);
    if (!item) continue;
    if (!seasons.has(e.season)) seasons.set(e.season, []);
    seasons.get(e.season).push({ ...summary(item, prog.get(`episode:${e.id}`)), status: e.status, overview: item.overview });
  }
  return {
    show: { id: show.id, title: show.title, poster_url: show.poster_url, show_status: show.show_status },
    seasons: [...seasons].map(([season, eps]) => ({ season, episodes: eps })),
  };
}));

// ─── One item ─────────────────────────────────────────────────────────────────

/**
 * Someone is waiting on the player for this item: start (or keep) its web
 * version as an on-demand job. A no-op for files that play as they are.
 */
function wantNow(kind, id, m) {
  if (m && ['none', 'queued', 'encoding'].includes(m.web_state) && ['remux', 'transcode'].includes(m.plan)) {
    return media.enqueue(kind, id, { priority: media.DEMAND_PRIORITY });
  }
  return m;
}

/** How to play it right now, from its media row. */
function playback(kind, id, m) {
  if (!m) return { mode: 'unavailable', error: 'not indexed' };
  if (m.plan === 'unplayable') return { mode: 'unavailable', error: m.plan_reason };
  const file = { url: `${base(kind, id)}/file`, size: m.size };
  if (m.plan === 'direct') return { mode: 'file', url: file.url, download: { type: 'file', ...file }, reason: m.plan_reason };
  const hls = `${base(kind, id)}/hls/${media.hlsEntry(kind, id)}`;
  const info = { plan: m.plan, reason: m.plan_reason, state: m.web_state, progress: m.web_progress, encoder: m.web_encoder,
    original: !m.original_removed_at, codec: m.web_codec || 'h264' };
  if (m.web_state === 'ready') return { mode: 'hls', url: hls, complete: true, download: { type: 'hls', url: hls }, ...info };
  // An MP4 that only needs a web version for its other audio tracks plays as
  // it is meanwhile — all of it, at once, rather than as far as the remux got.
  if (media.playsAsIs(m)) return { mode: 'file', url: file.url, download: { type: 'file', ...file }, ...info };
  // Stopped partway (disk filling up, or a failure) after playback began: the
  // part already made still plays, and the player says why it ends early.
  if (m.web_state === 'encoding' && media.hlsPlayable(kind, id)) return { mode: 'hls', url: hls, complete: false, ...info };
  // Someone is looking at a waiting item: if there is room by now (space
  // freed, a setting lowered), start it rather than wait for the next check.
  if (m.web_state === 'queued') {
    media.pump();
    m = media.rows.get(kind, id) || m;
    if (m.web_state === 'encoding') return { mode: 'preparing', ...info, state: 'encoding', progress: 0, error: null, waiting: null };
  }
  return { mode: 'preparing', ...info, error: m.web_error || null, waiting: media.waitingFor(m) };
}

router.get('/items/:kind/:id', wrap(async (req) => {
  const { kind, id } = params(req);
  const item = media.itemFor(kind, id);
  if (!item) throw bad('Not found', 404);
  const prog = req.user.legacy ? null : progress.get(req.user.id, kind, id);

  let m = null, error = null;
  try {
    m = await media.locate(kind, id);
    // Only a player asks with ?play=1. A details page (the Android app's, or
    // anything browsing) reads the same item without starting a conversion.
    if (req.query.play) m = wantNow(kind, id, m);
  } catch (err) {
    error = err.message;
  }

  let next = null;
  if (kind === 'episode') {
    const n = db.prepare(`
      SELECT id FROM episodes WHERE show_id = ? AND status = 'done'
        AND (season > ? OR (season = ? AND episode > ?))
      ORDER BY season, episode LIMIT 1
    `).get(item.show.id, item.season, item.season, item.episode);
    const ni = n && media.itemFor('episode', n.id);
    if (ni) next = summary(ni, req.user.legacy ? null : progress.get(req.user.id, 'episode', ni.id));
  }

  // Defaults for this person: what they picked for this show last time, then
  // their own language lists.
  const tracks = prefs.forPlayer(req.user, item, m ? media.listSubtitles(m).map(({ file, stream, ...s }) => ({
    ...s, url: s.available ? `${base(kind, id)}/subtitles/${s.id}.vtt` : null,
  })) : []);
  return {
    ...summary(item, prog),
    overview: item.overview || null,
    playback: m ? playback(kind, id, m) : { mode: 'unavailable', error },
    subtitles: tracks.subtitles,
    audio_langs: tracks.audio,
    remembered: tracks.remembered,
    intro: require('../intro').introOf(kind, id),
    original: m ? originalInfo(kind, id, m) : null,
    next,
  };
}));

/**
 * What someone picked in a player, remembered for the whole show (or film):
 * { audio_lang?, sub_lang?, sub_off? }. Only the fields sent change.
 */
router.post('/items/:kind/:id/choice', wrap((req) => {
  if (req.user.legacy) return { ok: false };
  const { kind, id } = params(req);
  const item = media.itemFor(kind, id);
  if (!item) throw bad('Not found', 404);
  const b = req.body || {};
  const pick = {};
  for (const k of ['audio_lang', 'sub_lang', 'sub_off']) if (k in b) pick[k] = b[k];
  return { ok: true, ...prefs.remember(req.user.id, prefs.scopeFor(item), pick) };
}));

/**
 * What the original file holds, for a player that may be able to play it
 * itself (the Android app, on a phone that decodes HEVC and AC-3): then it
 * needn't wait for — or cause — a conversion at all. Null once removed.
 */
function originalInfo(kind, id, m) {
  if (m.original_removed_at || !m.probe) return null;
  let info;
  try { info = JSON.parse(m.probe); } catch (_) { return null; }
  const v = media.mainVideo(info.streams || []);
  if (!v) return null;
  const audio = media.audioRenditions(info.streams || [], media.wantedLanguages());
  const byIndex = new Map((info.streams || []).map(s => [s.index, s]));
  return {
    url: `${base(kind, id)}/file`,
    container: String(info.format?.format_name || '').split(',')[0] || null,
    size: m.size || null,
    video: {
      codec: v.codec_name, profile: v.profile || null, pix_fmt: v.pix_fmt || null,
      width: v.width || null, height: v.height || null,
      hdr: ['smpte2084', 'arib-std-b67'].includes(v.color_transfer) ? v.color_transfer : null,
    },
    audio: audio.map(a => ({ codec: byIndex.get(a.stream)?.codec_name || a.codec, channels: a.channels, lang: a.lang, name: a.name, extra: !a.autoselect })),
  };
}

/** Lightweight poll for the "preparing" screen. */
// Polled by a player that is waiting. Being polled is what keeps a request
// alive: it starts the conversion if it hasn't (older apps open the item
// without ?play=1 and then poll here), and a request nobody polls any more
// expires back to background work.
router.get('/items/:kind/:id/playback', wrap((req) => {
  const { kind, id } = params(req);
  return playback(kind, id, wantNow(kind, id, media.rows.get(kind, id)));
}));

// Ask for a web version ahead of time. { soon: true } for the next episode or a
// download — ahead of other background work, without stopping anything;
// otherwise as if someone pressed play.
router.post('/items/:kind/:id/prepare', wrap(async (req) => {
  const { kind, id } = params(req);
  await media.locate(kind, id);
  const priority = req.body?.soon ? media.SOON_PRIORITY : media.DEMAND_PRIORITY;
  return playback(kind, id, media.enqueue(kind, id, { priority }));
}));

// ─── Streaming ────────────────────────────────────────────────────────────────

// The original file, with range requests — for direct play, and for the
// Android app's download of a file that needs no conversion.
router.get('/items/:kind/:id/file', wrap(async (req, res) => {
  const { kind, id } = params(req);
  const m = await media.locate(kind, id);
  if (m.original_removed_at) throw bad('The original was removed after seeding; only the web version is left', 410);
  if (req.query.download) {
    res.attachment(path.basename(m.path));
  }
  await new Promise((resolve) => {
    res.sendFile(m.path, { dotfiles: 'allow', acceptRanges: true, cacheControl: false, lastModified: true }, (err) => {
      if (err && !res.headersSent) res.status(err.statusCode || 500).json({ error: 'Could not read the file' });
      resolve();
    });
  });
}));

const HLS_NAME = /^(master\.m3u8|index\.m3u8|init(_\d+)?\.mp4|seg_\d{5}\.m4s)$/;
// The video's folder and one per audio track (see media.js).
const HLS_DIR = /^(v|a\d{1,2})$/;

const sendHls = wrap(async (req, res) => {
  const { kind, id } = params(req);
  const { dir, name } = req.params;
  if (!HLS_NAME.test(name) || (dir !== undefined && !HLS_DIR.test(dir))) throw bad('Not found', 404);
  const file = path.join(media.webDir(kind, id), ...(dir ? [dir] : []), name);
  if (!fs.existsSync(file)) throw bad('Not ready', 404);
  if (name.endsWith('.m3u8')) {
    // A player reloads the playlist while the encode is still growing it:
    // someone is watching, so the request stays alive.
    const m = media.rows.get(kind, id);
    if (m?.web_state === 'encoding') wantNow(kind, id, m);
    // Watched: a repackaged copy's clock restarts.
    if (name === 'master.m3u8' || (!dir && name === 'index.m3u8')) media.touchWeb(kind, id);
    res.type('application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-cache');
  } else {
    res.type('video/mp4');
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
  }
  await new Promise((resolve) => res.sendFile(file, { cacheControl: false }, () => resolve()));
});
router.get('/items/:kind/:id/hls/:name', sendHls);
router.get('/items/:kind/:id/hls/:dir/:name', sendHls);

// ─── Seek thumbnails ─────────────────────────────────────────────────────────

/**
 * The thumbnail index, or { pending: true } while it is being made — asking
 * starts it, so the back catalogue gets them as it is watched.
 */
router.get('/items/:kind/:id/thumbs.json', wrap(async (req) => {
  const { kind, id } = params(req);
  const ix = thumbs.index(kind, id);
  if (ix) return { ...ix, url: `${base(kind, id)}/thumbs/` };
  if (media.rows.get(kind, id)) thumbs.ensure(kind, id);
  return { pending: true };
}));

router.get('/items/:kind/:id/thumbs/:n.jpg', wrap(async (req, res) => {
  const { kind, id } = params(req);
  const n = Number(req.params.n);
  if (!Number.isInteger(n) || n < 1 || n > 999) throw bad('Not found', 404);
  const file = thumbs.sheetFile(kind, id, n);
  if (!fs.existsSync(file)) throw bad('Not found', 404);
  res.type('image/jpeg');
  res.set('Cache-Control', 'private, max-age=86400');
  await new Promise((resolve) => res.sendFile(file, { cacheControl: false }, () => resolve()));
}));

// ─── Subtitles ────────────────────────────────────────────────────────────────

router.get('/items/:kind/:id/subtitles', wrap(async (req) => {
  const { kind, id } = params(req);
  const m = await media.locate(kind, id);
  return media.listSubtitles(m).map(({ file, stream, ...s }) => ({
    ...s, url: s.available ? `${base(kind, id)}/subtitles/${s.id}.vtt` : null,
  }));
}));

router.get('/items/:kind/:id/subtitles/:sub.vtt', wrap(async (req, res) => {
  const { kind, id } = params(req);
  const m = await media.locate(kind, id);
  const file = await media.vttFor(m, req.params.sub);
  res.type('text/vtt; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  // ?offset=ms: shifted on the way out. A player that can't move cues itself
  // (the Android app) reloads the track with this to nudge the timing live.
  const offset = Number(req.query.offset);
  if (Number.isFinite(offset) && offset !== 0 && Math.abs(offset) <= 3600_000) {
    const st = require('../subtitle-text');
    return res.send(st.toVtt(st.transform(st.parse(fs.readFileSync(file, 'utf8')), { offsetMs: Math.round(offset) })));
  }
  await new Promise((resolve) => res.sendFile(file, { cacheControl: false }, () => resolve()));
}));

async function editableSub(req) {
  const { kind, id } = params(req);
  const m = await media.locate(kind, id);
  const sub = media.listSubtitles(m).find(s => s.id === req.params.sub);
  if (!sub) throw bad('No such subtitle', 404);
  if (!sub.editable) throw bad('Only .srt files beside the video can be re-timed; the offset still applies in the player');
  return { m, sub, kind, id };
}

/** Align a subtitle file to the audio. Takes a while: it reads the whole soundtrack. */
router.post('/items/:kind/:id/subtitles/:sub/sync', wrap(async (req) => {
  const { m, sub, kind, id } = await editableSub(req);
  let info = null;
  try { info = JSON.parse(m.probe); } catch (_) {}
  const audio = info && media.chooseAudio(info.streams);
  const r = await subsync.syncFile(m.path, sub.file, { streamIndex: audio?.index ?? null });
  log.info(`subtitle sync by ${req.user.username}: ${subsync.describe(r)} — ${path.basename(sub.file)}`, { type: kind, id });
  return r;
}));

router.post('/items/:kind/:id/subtitles/:sub/shift', wrap(async (req) => {
  const offsetMs = Number(req.body?.offsetMs);
  if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) > 3600_000) throw bad('offsetMs must be a number of milliseconds');
  const { sub, kind, id } = await editableSub(req);
  subsync.shiftFile(sub.file, Math.round(offsetMs));
  log.info(`subtitle shifted ${(offsetMs / 1000).toFixed(2)}s by ${req.user.username}: ${path.basename(sub.file)}`, { type: kind, id });
  return { ok: true };
}));

router.post('/items/:kind/:id/subtitles/:sub/restore', wrap(async (req) => {
  const { sub } = await editableSub(req);
  return { restored: subsync.restoreFile(sub.file) };
}));

// ─── Progress ─────────────────────────────────────────────────────────────────

function noLegacy(req) {
  if (req.user.legacy) throw bad('Progress needs a user account — sign in instead of using the API token', 400);
}

router.get('/progress', wrap((req) => {
  noLegacy(req);
  return db.prepare('SELECT kind, item_id AS id, position, duration, watched, updated_at FROM playback_progress WHERE user_id = ?')
    .all(req.user.id).map(r => ({ ...r, watched: !!r.watched }));
}));

const putProgress = wrap((req) => {
  noLegacy(req);
  const { kind, id } = params(req);
  const { position, duration, at } = req.body || {};
  if (!Number.isFinite(Number(position))) throw bad('position required');
  return progressOf(progress.report(req.user.id, kind, id, { position, duration, at: at ?? Date.now() }));
});
router.put('/progress/:kind/:id', putProgress);
// navigator.sendBeacon can only POST — it is how the player saves the
// position when the tab is closed.
router.post('/progress/:kind/:id', putProgress);

router.post('/progress/:kind/:id/watched', wrap((req) => {
  noLegacy(req);
  const { kind, id } = params(req);
  return progressOf(progress.setWatched(req.user.id, kind, id, req.body?.watched !== false));
}));

router.post('/shows/:id/watched', wrap((req) => {
  noLegacy(req);
  const showId = Number(req.params.id);
  const season = req.body?.season == null ? null : Number(req.body.season);
  const eps = episodes.forShow(showId).filter(e => e.status === 'done' && (season === null || e.season === season));
  progress.setWatchedMany(req.user.id, eps.map(e => ({ kind: 'episode', id: e.id })), req.body?.watched !== false);
  return { updated: eps.length };
}));

/**
 * Batch upload from a client that has been offline. Each report keeps its own
 * timestamp, so older ones never overwrite newer ones. Returns everything the
 * server has for this user so the client can merge the other way.
 */
router.post('/progress/sync', wrap((req) => {
  noLegacy(req);
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 2000) : [];
  for (const it of items) {
    if (!media.KINDS.has(it.kind) || !Number.isInteger(Number(it.id))) continue;
    const exists = it.kind === 'movie' ? movies.byId(Number(it.id)) : episodes.byId(Number(it.id));
    if (!exists) continue;
    progress.report(req.user.id, it.kind, Number(it.id), {
      position: it.position, duration: it.duration, at: it.at ?? it.updated_at, watched: typeof it.watched === 'boolean' ? it.watched : null,
    });
  }
  return db.prepare('SELECT kind, item_id AS id, position, duration, watched, updated_at FROM playback_progress WHERE user_id = ?')
    .all(req.user.id).map(r => ({ ...r, watched: !!r.watched }));
}));

// ─── Library management (admin) ──────────────────────────────────────────────

/** "Show S01E02" or "Film", for the admin lists. */
function titleOf(kind, id) {
  const i = media.itemFor(kind, id);
  if (!i) return '?';
  return i.kind === 'episode' ? `${i.show_title} S${String(i.season).padStart(2, '0')}E${String(i.episode).padStart(2, '0')}` : i.title;
}

router.get('/admin/status', requireAdmin, wrap(async () => {
  const counts = db.prepare('SELECT plan, web_state, COUNT(*) AS n FROM media_files GROUP BY plan, web_state').all();
  const unindexed = db.prepare(`
    SELECT (SELECT COUNT(*) FROM movies m WHERE status = 'done' AND NOT EXISTS (SELECT 1 FROM media_files WHERE kind='movie' AND item_id=m.id))
         + (SELECT COUNT(*) FROM episodes e WHERE status = 'done' AND NOT EXISTS (SELECT 1 FROM media_files WHERE kind='episode' AND item_id=e.id)) AS n
  `).get().n;
  const usage = await media.webUsage();
  return {
    webRoot: media.WEB_ROOT, cacheBytes: usage.total, counts, unindexed,
    encoder: await media.pickEncoder(),
    queue: media.queue().map(q => ({ ...q, title: titleOf(q.kind, q.item_id) })),
    failed: db.prepare("SELECT kind, item_id, web_error FROM media_files WHERE web_state = 'failed' LIMIT 50").all()
      .map(f => ({ ...f, title: titleOf(f.kind, f.item_id) })),
    space: media.spaceStatus(),
    largest: usage.largest.map(w => ({ ...w, title: titleOf(w.kind, w.id) })),
    originalsRemoved: db.prepare('SELECT COUNT(*) AS n FROM media_files WHERE original_removed_at IS NOT NULL').get().n,
  };
}));

let scanning = null;
router.post('/admin/scan', requireAdmin, wrap(async () => {
  if (!scanning) {
    scanning = (async () => {
      let total = { checked: 0, found: 0, removed: 0 };
      for (;;) {
        const r = await media.indexPass({ limit: 50 });
        total = { checked: total.checked + r.checked, found: total.found + r.found, removed: total.removed + r.removed };
        if (r.checked === 0) break;
      }
      return total;
    })().finally(() => { scanning = null; });
  }
  return scanning;
}));

router.post('/admin/clear', requireAdmin, wrap(() => {
  media.clearWebVersions();
  return { ok: true };
}));

// Free space by hand: the web version only (made again when next opened), or
// everything — original, subtitles and web version — marking the item deleted.
router.delete('/items/:kind/:id/web', requireAdmin, wrap((req) => {
  const { kind, id } = params(req);
  return require('../deletion').deleteWebVersion(kind, id, { by: req.user.username });
}));

router.delete('/items/:kind/:id', requireAdmin, wrap(async (req) => {
  const { kind, id } = params(req);
  return require('../deletion').deleteEverything(kind, id, { by: req.user.username });
}));

router.post('/items/:kind/:id/reencode', requireAdmin, wrap(async (req) => {
  const { kind, id } = params(req);
  const m = await media.locate(kind, id);
  if (m.original_removed_at) throw bad('The original was removed after seeding, so there is nothing to re-encode from', 409);
  media.removeWebVersion(kind, id);
  media.rows.update(kind, id, { web_state: 'none', web_progress: 0, web_error: null });
  return playback(kind, id, media.enqueue(kind, id, { priority: media.DEMAND_PRIORITY }));
}));

module.exports = router;
