'use strict';

// The watchable library: where each finished item is on disk, what a browser
// needs done to it before it can play, and the queue that does it.
//
// Three outcomes per file (the "plan"):
//
//   direct     MP4 with H.264 video and AAC/MP3 audio — served as it is, with
//              range requests, to the browser and the Android app alike.
//   remux      The video is fine but the wrapper or audio isn't (MKV, AC-3,
//              DTS, TrueHD, a first audio track that is commentary). The video
//              is copied untouched and only the audio is converted — minutes,
//              not hours, and no quality loss.
//   transcode  The video itself can't play in a browser: HEVC, 10-bit, HDR,
//              MPEG-4 Part 2, VC-1. Re-encoded to 8-bit H.264, on the GPU
//              through VAAPI when there is one.
//
// Remux and transcode write HLS (fMP4 segments) into a folder of their own.
// The original file is never modified — Transmission keeps seeding it — and
// because the playlist grows as segments are written, playback can start
// while the encode is still running.
//
// Layout of a web version:
//   master.m3u8        written by us: one video stream, every audio track as
//                      an alternative rendition the players can switch to
//   v/index.m3u8       the video, its init segment and segments
//   a0/, a1/, …        one folder per audio track; a0 is the default
// Web versions made before audio tracks were kept are a single index.m3u8 at
// the top, video and one audio track together. They still play.
//
// Once a torrent has seeded enough, cleanup.js may remove the original and
// keep only the web version (original_removed_at). From then on the web
// version is the only copy: nothing here may delete or rebuild it.

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const { db, movies, episodes, shows, settings, seasonCache, DB_PATH } = require('./db');
const { mapPath, sanitizeFolderName } = require('./paths');
const subText = require('./subtitle-text');
const log = require('./log');

const FFMPEG  = process.env.FFMPEG_PATH  || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const WEB_ROOT = process.env.WEB_PATH || path.join(path.dirname(path.resolve(DB_PATH)), 'web');
const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';
const SEGMENT_SECONDS = 6;

const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|wmv|webm|mpg|mpeg|m2ts|ts)$/i;
const SUB_EXT   = /\.(srt|vtt|ass|ssa)$/i;
const SAMPLE_RE = /(?:^|[/\\._-])sample(?:[/\\._-]|$)/i;
const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

// ─── Rows ─────────────────────────────────────────────────────────────────────

const rows = {
  get: (kind, id) => db.prepare('SELECT * FROM media_files WHERE kind = ? AND item_id = ?').get(kind, id),
  all: () => db.prepare('SELECT * FROM media_files').all(),
  upsert(kind, id, data) {
    const cols = Object.keys(data);
    db.prepare(`
      INSERT INTO media_files (kind, item_id, ${cols.join(', ')}, updated_at)
      VALUES (?, ?, ${cols.map(() => '?').join(', ')}, datetime('now'))
      ON CONFLICT (kind, item_id) DO UPDATE SET
        ${cols.map(c => `${c} = excluded.${c}`).join(', ')}, updated_at = datetime('now')
    `).run(kind, id, ...cols.map(c => data[c]));
    return rows.get(kind, id);
  },
  update(kind, id, data) {
    const cols = Object.keys(data);
    db.prepare(`UPDATE media_files SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = datetime('now')
                WHERE kind = ? AND item_id = ?`).run(...cols.map(c => data[c]), kind, id);
  },
  remove: (kind, id) => db.prepare('DELETE FROM media_files WHERE kind = ? AND item_id = ?').run(kind, id),
  /** Queued jobs someone is waiting for (they pressed play), most urgent first. */
  queuedDemand: () => db.prepare(
    "SELECT * FROM media_files WHERE web_state = 'queued' AND web_priority >= ? ORDER BY web_priority DESC, updated_at"
  ).all(DEMAND_PRIORITY),
  /** Queued jobs for a lane, 'remux' or 'transcode', in the order to try them. */
  queuedIn: (plan) => db.prepare(
    "SELECT * FROM media_files WHERE web_state = 'queued' AND plan = ? ORDER BY web_priority DESC, updated_at"
  ).all(plan),
  /** Rows marked as requested, to expire those nobody is waiting for any more. */
  prioritised: () => db.prepare('SELECT kind, item_id, web_priority FROM media_files WHERE web_priority > 0').all(),
  queue: () => db.prepare(
    "SELECT kind, item_id, web_state, web_progress, web_priority, plan FROM media_files WHERE web_state IN ('queued','encoding') ORDER BY web_state DESC, web_priority DESC, updated_at"
  ).all(),
};

const KINDS = new Set(['movie', 'episode']);

/**
 * Priority at and above which a job is "on demand": someone opened the item or
 * pressed play. Those start at once instead of waiting their turn.
 */
const DEMAND_PRIORITY = 10;
/** At most this many on-demand jobs at once (several people, several files). */
const MAX_DEMAND = 3;
/**
 * "Wanted soon" — the next episode of what someone is watching, or a download
 * someone asked for. Ahead of other background work, but it doesn't stop
 * anything to get there and doesn't use the room kept for on-demand work.
 */
const SOON_PRIORITY = 5;

/**
 * A request only counts while someone is still there. Players say so all the
 * time — the waiting screen polls, a playing HLS stream reloads its playlist —
 * so a request nobody has touched for this long is dropped back to ordinary
 * background work. Without this, a film opened and abandoned would keep the
 * machine busy, and the reserve used, until it finished — and come back as
 * urgent after every restart.
 */
const DEMAND_TTL_MS = 10 * 60_000;
const SOON_TTL_MS = 60 * 60_000;
const wantedAt = new Map();   // "kind:id" → last time someone was waiting for it

/** Someone is (still) waiting for this item. */
function touch(kind, id) {
  wantedAt.set(`${kind}:${id}`, Date.now());
}

function stillWanted(kind, id, ttl, now = Date.now()) {
  const t = wantedAt.get(`${kind}:${id}`);
  return !!t && now - t < ttl;
}

/** The library item behind a (kind, id), with what the Watch pages show. */
function itemFor(kind, id) {
  if (kind === 'movie') {
    const m = movies.byId(id);
    return m && { kind, id: m.id, row: m, title: m.title, year: m.year, poster_url: m.poster_url, status: m.status };
  }
  if (kind === 'episode') {
    const e = episodes.byId(id);
    if (!e) return null;
    const s = shows.byId(e.show_id);
    if (!s) return null;
    const meta = episodeMeta(s.tmdb_id, e.season, e.episode);
    return {
      kind, id: e.id, row: e, show: s, status: e.status,
      title: meta?.name || `Episode ${e.episode}`,
      show_title: s.title, season: e.season, episode: e.episode,
      poster_url: s.poster_url, still_url: meta?.still_path ? `https://image.tmdb.org/t/p/w500${meta.still_path}` : null,
      overview: meta?.overview || null, air_date: e.air_date,
    };
  }
  return null;
}

/** Name, overview and still for an episode, from the TMDB season cache. */
function episodeMeta(tmdbId, season, episode) {
  const row = seasonCache.get(tmdbId, season);
  if (!row?.payload) return null;
  try {
    return (JSON.parse(row.payload).episodes || []).find(x => x.episode_number === episode) || null;
  } catch (_) {
    return null;
  }
}

// ─── Probing and the plan ─────────────────────────────────────────────────────

function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
      { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`ffprobe could not read the file: ${String(err.message).split('\n')[0]}`));
        try {
          const j = JSON.parse(stdout);
          resolve({ streams: j.streams || [], format: j.format || {} });
        } catch (_) { reject(new Error('ffprobe returned output that could not be parsed')); }
      });
  });
}

const AD_TITLE_RE = /(?:^|[^a-z])(?:AD|DVS|audio[\s._-]?desc(?:ription|ribed)?|descri(?:bed|ptive)|commentary)(?:[^a-z]|$)/i;
const LANGS = {
  en: ['en', 'eng'], nl: ['nl', 'nld', 'dut'], de: ['de', 'deu', 'ger'], fr: ['fr', 'fra', 'fre'],
  es: ['es', 'spa'], it: ['it', 'ita'], pt: ['pt', 'por'], sv: ['sv', 'swe'], da: ['da', 'dan'],
  no: ['no', 'nor', 'nob', 'nno'], fi: ['fi', 'fin'], pl: ['pl', 'pol'], ja: ['ja', 'jpn'],
};
const LANG_NAMES = {
  en: 'English', nl: 'Dutch', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
  sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish', pl: 'Polish', ja: 'Japanese',
};

/** ISO 639-1 code for whatever tag ffprobe or a filename uses, or null. */
function normLang(tag) {
  if (!tag) return null;
  const t = String(tag).toLowerCase();
  for (const [code, alts] of Object.entries(LANGS)) {
    if (alts.includes(t) || LANG_NAMES[code].toLowerCase() === t) return code;
  }
  return null;
}

function wantedLanguages() {
  return (settings.get('subtitle_languages') || 'en').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/** Commentary or audio description: kept, but never the one chosen to play. */
function isExtraAudio(a) {
  return !!(a.disposition?.visual_impaired || a.disposition?.comment
    || a.disposition?.descriptions || AD_TITLE_RE.test(a.tags?.title || ''));
}

/**
 * The audio track to play: not commentary or audio description, in the
 * preferred language if there is one, the default-flagged one otherwise.
 */
function chooseAudio(streams, wanted = wantedLanguages()) {
  const audio = streams.filter(s => s.codec_type === 'audio');
  if (audio.length === 0) return null;
  const plain = audio.filter(a => !isExtraAudio(a));
  const pool = plain.length ? plain : audio;
  const lang = (a) => normLang(a.tags?.language);
  for (const w of wanted) {
    const hit = pool.filter(a => lang(a) === w);
    if (hit.length) return hit.find(a => a.disposition?.default) || hit[0];
  }
  return pool.find(a => a.disposition?.default) || pool[0];
}

/**
 * Every audio track, as the web version carries them: the one chooseAudio()
 * picks first (it is the default), then the rest in file order. Commentary
 * and audio description are kept but never chosen automatically.
 */
function audioRenditions(streams, wanted = wantedLanguages()) {
  const audio = streams.filter(s => s.codec_type === 'audio');
  if (audio.length === 0) return [];
  const chosen = chooseAudio(streams, wanted);
  const used = new Map();
  return [chosen, ...audio.filter(a => a !== chosen)].map((a, i) => {
    const title = String(a.tags?.title || '').replace(/["\r\n]/g, '').trim().slice(0, 48);
    const commentary = !!a.disposition?.comment || /commentary/i.test(title);
    const ad = !commentary && !!(a.disposition?.visual_impaired || a.disposition?.descriptions || AD_TITLE_RE.test(title));
    const code = normLang(a.tags?.language);
    const raw = a.tags?.language && a.tags.language !== 'und' ? String(a.tags.language).replace(/[^A-Za-z-]/g, '') : null;
    let name = LANG_NAMES[code] || raw || 'Unknown';
    if (title && title.toLowerCase() !== name.toLowerCase()) name += ` — ${title}`;
    else if (ad) name += ' — audio description';
    else if (commentary) name += ' — commentary';
    const seen = (used.get(name) || 0) + 1;
    used.set(name, seen);
    if (seen > 1) name += ` (${seen})`;
    return {
      stream: a.index, codec: a.codec_name, channels: a.channels || 2,
      lang: code || raw || null, name, default: i === 0, autoselect: !ad && !commentary, ad,
    };
  });
}

/** The master playlist for a web version. Pure. */
function masterPlaylist({ renditions, bandwidth }) {
  const out = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  renditions.forEach((r, i) => {
    const attrs = ['TYPE=AUDIO', 'GROUP-ID="aud"', `NAME="${r.name}"`];
    if (r.lang) attrs.push(`LANGUAGE="${r.lang}"`);
    attrs.push(`DEFAULT=${r.default ? 'YES' : 'NO'}`, `AUTOSELECT=${r.autoselect || r.default ? 'YES' : 'NO'}`);
    if (r.ad) attrs.push('CHARACTERISTICS="public.accessibility.describes-video"');
    attrs.push(`URI="a${i}/index.m3u8"`);
    out.push(`#EXT-X-MEDIA:${attrs.join(',')}`);
  });
  // BANDWIDTH is the peak of the video plus the audio played with it.
  const bw = Math.round(bandwidth + (renditions.length ? 200_000 : 0));
  out.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw}${renditions.length ? ',AUDIO="aud"' : ''}`, 'v/index.m3u8', '');
  return out.join('\n');
}

function mainVideo(streams) {
  return streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic) || null;
}

const isHdr = (v) => ['smpte2084', 'arib-std-b67'].includes(v?.color_transfer);

/**
 * How this file can be made to play in a browser.
 *
 * An MP4 a browser could play as it is still gets a web version when it has
 * more than one ordinary audio track: a browser only ever plays the first
 * (Safari aside), so a wrongly flagged default — or a second language — could
 * not be reached otherwise. `multiAudio: false` asks the narrower question of
 * whether the file plays as it is, which it does meanwhile.
 * @returns {{ plan: 'direct'|'remux'|'transcode'|'unplayable', reason: string }}
 */
function planFor({ streams, format }, wanted, { multiAudio = true, codec = webCodec(), maxHeight = webMaxHeight() } = {}) {
  const video = mainVideo(streams);
  if (!video) return { plan: 'unplayable', reason: 'no video stream' };
  const audios = streams.filter(s => s.codec_type === 'audio');
  const audio = chooseAudio(streams, wanted);

  // HEVC web versions: an HEVC video that a browser with HEVC support plays
  // (SDR, 4:2:0, 8 or 10-bit, no bigger than the size limit) is copied as it
  // is — no loss, a minute's work instead of an hour's, and no GPU.
  if (codec === 'hevc' && copiesAsHevc(video, maxHeight)) {
    const container = String(format?.format_name || '').split(',')[0];
    const extra = [container === 'matroska' ? 'MKV container' : null,
      audio && !['aac', 'mp3'].includes(audio.codec_name) ? `${String(audio.codec_name).toUpperCase()} audio` : null].filter(Boolean);
    return { plan: 'remux', reason: ['HEVC video kept as it is', ...extra].join(', ') };
  }

  const why = [];
  if (video.codec_name !== 'h264') why.push(`${String(video.codec_name || 'unknown').toUpperCase()} video`);
  else if (!['yuv420p', 'yuvj420p'].includes(video.pix_fmt)) {
    why.push(/10|12/.test(video.pix_fmt || '') ? '10-bit video' : `${video.pix_fmt} video`);
  }
  if (isHdr(video)) why.push('HDR');
  if (why.length) return { plan: 'transcode', reason: why.join(', ') };

  const container = String(format?.format_name || '');
  const isMp4 = /(^|,)(mov|mp4)(,|$)/.test(container);
  const audioOk = !audio || (['aac', 'mp3'].includes(audio.codec_name) && (audio.channels || 2) <= 6);
  const audioFirst = !audio || audio.index === audios[0].index;

  if (isMp4 && audioOk && audioFirst) {
    const ordinary = audios.filter(a => !isExtraAudio(a)).length;
    if (multiAudio && ordinary > 1) {
      return { plan: 'remux', reason: `${ordinary} audio tracks — a browser only plays the first` };
    }
    return { plan: 'direct', reason: 'plays as it is' };
  }
  const reasons = [];
  if (!isMp4) reasons.push(`${container.split(',')[0] === 'matroska' ? 'MKV' : container.split(',')[0] || 'unknown'} container`);
  if (!audioOk) reasons.push(`${String(audio.codec_name).toUpperCase()} audio`);
  else if (!audioFirst) reasons.push('preferred audio isn\'t the first track');
  return { plan: 'remux', reason: reasons.join(', ') };
}

/**
 * Whether a web version is made before anyone asks for it. Conversions are
 * (an hour's work: done ahead, it plays at once). A repackaged copy by default
 * isn't: it's the original's size again, made in a minute, and plays while it
 * is being made — so it's made when someone presses play, and dropped again
 * after a while unwatched (dropUnwatched).
 */
function preparesAhead(plan) {
  if (settings.get('web_prepare') === 'demand') return false;
  if (plan === 'remux') return settings.get('web_remux_ahead') === '1';
  return plan === 'transcode';
}

// ─── Repackaged copies nobody watches ────────────────────────────────────────

const DROP_CHECK_MS = 6 * 3600_000;

/** A web version was opened: its clock restarts. Cheap enough per playlist request. */
function touchWeb(kind, id) {
  db.prepare("UPDATE media_files SET web_last_used = datetime('now') WHERE kind = ? AND item_id = ?").run(kind, id);
}

/**
 * Delete repackaged copies not opened for `web_keep_days` days. Only copies of
 * a file that is still there: one whose original was removed after seeding is
 * the only copy left, and conversions (an hour each to make again) stay.
 */
function dropUnwatched() {
  const days = Number(settings.get('web_keep_days'));
  if (!Number.isFinite(days) || days <= 0 || settings.get('web_remux_ahead') === '1') return { dropped: 0, bytes: 0 };
  const old = db.prepare(`
    SELECT * FROM media_files WHERE plan = 'remux' AND web_state = 'ready' AND original_removed_at IS NULL
      AND COALESCE(web_last_used, updated_at) < datetime('now', ?)
  `).all(`-${Math.floor(days)} days`);
  let dropped = 0, bytes = 0;
  for (const r of old) {
    if (!fs.existsSync(r.path)) continue;           // the copy might be all there is
    if (running.has(jobKey(r.kind, r.item_id))) continue;
    const b = dirBytes(webDir(r.kind, r.item_id));
    removeWebVersion(r.kind, r.item_id);
    rows.update(r.kind, r.item_id, { web_state: 'none', web_progress: 0, web_error: null });
    dropped++; bytes += b;
  }
  if (dropped) log.info(`dropped ${dropped} repackaged cop${dropped === 1 ? 'y' : 'ies'} nobody opened for ${days} days — ${gb(bytes)} freed; each is made again in a minute when played`);
  return { dropped, bytes };
}

/** 'h264' (plays in every browser) or 'hevc' (smaller; HEVC sources copied). */
function webCodec() {
  return settings.get('web_codec') === 'hevc' ? 'hevc' : 'h264';
}

function webMaxHeight() {
  return Number(settings.get('web_max_height')) || 1080;
}

function copiesAsHevc(video, maxHeight) {
  return video?.codec_name === 'hevc' && ['yuv420p', 'yuv420p10le'].includes(video.pix_fmt)
    && !isHdr(video) && (!video.height || video.height <= maxHeight);
}

/** What a web version's video is, for players that must check they can play it. */
function webCodecOf(plan, info, codec) {
  const v = mainVideo(info.streams || []);
  if (plan === 'remux') return v?.codec_name === 'hevc' ? (/10/.test(v.pix_fmt || '') ? 'hevc10' : 'hevc') : 'h264';
  return codec === 'hevc' ? 'hevc' : 'h264';
}

// ─── Finding the file ────────────────────────────────────────────────────────

function videoFilesIn(files) {
  return files.filter(f => VIDEO_EXT.test(f.name) && !SAMPLE_RE.test(f.name));
}

const EP_RE = (s, e) => new RegExp(`(?:S0*${s}[\\s._-]?E0*${e}(?!\\d))|(?:(?<!\\d)${s}x0*${e}(?!\\d))`, 'i');

/** The video file in a torrent that is this row's. */
function pickFile(files, item) {
  const videos = videoFilesIn(files);
  if (videos.length === 0) return null;
  if (item.kind === 'episode' && videos.length > 1) {
    const re = EP_RE(item.row.season, item.row.episode);
    const hit = videos.filter(f => re.test(path.basename(f.name)));
    if (hit.length) return hit.reduce((a, b) => (b.length > a.length ? b : a));
    return null; // a pack without this episode in it — the largest file would be wrong
  }
  return videos.reduce((a, b) => (b.length > a.length ? b : a));
}

/** Bounded recursive listing: [{ name (relative), full, size }]. */
function walk(root, { depth = 3, max = 5000 } = {}) {
  const out = [];
  const go = (dir, rel, d) => {
    if (out.length >= max) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (d > 0) go(full, r, d - 1); }
      else if (e.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch (_) {}
        out.push({ name: r, full, length: size });
      }
      if (out.length >= max) return;
    }
  };
  go(root, '', depth);
  return out;
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Where the file is when Transmission no longer knows: look in the show's
 * folder (any spelling of it) or, for a movie, for a file naming its title
 * and year. Only ever an answer the names agree on.
 */
function searchDisk(item) {
  if (item.kind === 'episode') {
    const root = mapPath(String(settings.get('shows_path') || '').replace(/\/+$/, ''));
    const key = sanitizeFolderName(item.show.title).toLowerCase();
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter(n => sanitizeFolderName(n).toLowerCase() === key); } catch (_) {}
    const re = EP_RE(item.row.season, item.row.episode);
    for (const d of dirs) {
      const hit = videoFilesIn(walk(path.join(root, d))).filter(f => re.test(path.basename(f.name)));
      if (hit.length) return hit.reduce((a, b) => (b.length > a.length ? b : a)).full;
    }
    return null;
  }
  const root = mapPath(String(settings.get('movie_path') || '').replace(/\/+$/, ''));
  const words = norm(item.title).split(' ').filter(Boolean);
  if (!words.length) return null;
  const hits = videoFilesIn(walk(root, { depth: 2 })).filter(f => {
    const n = ` ${norm(f.name)} `;
    return words.every(w => n.includes(` ${w} `)) && (!item.year || n.includes(` ${item.year} `));
  });
  return hits.length ? hits.reduce((a, b) => (b.length > a.length ? b : a)).full : null;
}

async function findPath(item) {
  const row = item.row;
  if (row.torrent_id) {
    try {
      const tx = require('./transmission');
      const target = item.kind === 'movie' ? row.transmission_target : item.show.transmission_target;
      const info = await tx.getTorrentInfo(row.torrent_id, tx.resolveTarget(target));
      const f = info && pickFile(info.files, item);
      if (f) {
        const p = mapPath(path.join(info.downloadDir, f.name));
        if (fs.existsSync(p)) return p;
      }
    } catch (_) { /* Transmission unreachable — fall back to the disk */ }
  }
  return searchDisk(item);
}

/**
 * Record a known file for an item: probe it and work out its plan. Called by
 * post-processing for every new download and by locate() for older ones.
 */
async function record(kind, id, file, { probed = null } = {}) {
  const st = fs.statSync(file);
  const existing = rows.get(kind, id);
  if (existing && existing.path === file && existing.size === st.size && existing.mtime === Math.floor(st.mtimeMs)
      && existing.probe) {
    return existing;
  }
  const info = probed?.format ? probed : await probe(file);
  const { plan, reason } = planFor(info, wantedLanguages());
  const duration = Number(info.format?.duration) || null;
  if (existing) removeWebVersion(kind, id); // the file changed, so its web version is stale
  const row = rows.upsert(kind, id, {
    path: file, size: st.size, mtime: Math.floor(st.mtimeMs), duration,
    probe: JSON.stringify({ streams: info.streams, format: { format_name: info.format?.format_name, duration: info.format?.duration } }),
    plan, plan_reason: reason,
    web_state: 'none', web_progress: 0, web_error: null,
    original_removed_at: null, subs_snapshot: null, web_estimate: null,
  });
  if (preparesAhead(plan)) enqueue(kind, id);
  return row;
}

/**
 * The media row for an item, making one if needed and checking the file is
 * still where it was. Throws with a reason the player can show.
 */
async function locate(kind, id) {
  if (!KINDS.has(kind)) throw Object.assign(new Error('Unknown kind'), { status: 400 });
  const item = itemFor(kind, id);
  if (!item) throw Object.assign(new Error('Not found'), { status: 404 });
  const existing = rows.get(kind, id);
  if (existing?.original_removed_at) {
    if (existing.web_state === 'ready' && hlsPlayable(kind, id)) return existing;
    throw Object.assign(new Error('The original was removed after seeding, and its web version is missing'), { status: 410 });
  }
  if (existing) {
    try {
      const st = fs.statSync(existing.path);
      if (st.size === existing.size) return existing;
    } catch (_) { /* moved or deleted — look again */ }
  }
  if (item.status !== 'done') throw Object.assign(new Error('Not downloaded yet'), { status: 409 });
  const file = await findPath(item);
  if (!file) {
    if (existing) rows.remove(kind, id);
    throw Object.assign(new Error('The file can\'t be found — is the media folder mounted?'), { status: 404 });
  }
  return record(kind, id, file);
}

/**
 * Index finished items that have no media row yet, a few per call, and drop
 * rows (and web versions) for items that no longer exist.
 */
// Items that couldn't be located, and when — so a missing file is looked for
// again once a day rather than on every pass, ahead of everything else.
const lastTried = new Map();

async function indexPass({ limit = 40, retryAfterMs = 24 * 3600_000 } = {}) {
  const orphans = db.prepare(`
    SELECT kind, item_id FROM media_files m
    WHERE (kind = 'movie'   AND NOT EXISTS (SELECT 1 FROM movies   WHERE id = m.item_id))
       OR (kind = 'episode' AND NOT EXISTS (SELECT 1 FROM episodes WHERE id = m.item_id))
  `).all();
  for (const o of orphans) { removeWebVersion(o.kind, o.item_id); rows.remove(o.kind, o.item_id); }

  const now = Date.now();
  const todo = db.prepare(`
    SELECT 'movie' AS kind, id FROM movies m WHERE status = 'done'
      AND NOT EXISTS (SELECT 1 FROM media_files WHERE kind = 'movie' AND item_id = m.id)
    UNION ALL
    SELECT 'episode' AS kind, id FROM episodes e WHERE status = 'done'
      AND NOT EXISTS (SELECT 1 FROM media_files WHERE kind = 'episode' AND item_id = e.id)
  `).all().filter(t => now - (lastTried.get(`${t.kind}:${t.id}`) || 0) > retryAfterMs).slice(0, limit);
  let found = 0;
  for (const t of todo) {
    try { await locate(t.kind, t.id); found++; lastTried.delete(`${t.kind}:${t.id}`); }
    catch (_) { lastTried.set(`${t.kind}:${t.id}`, Date.now()); /* reported when someone tries to play it */ }
  }
  return { checked: todo.length, found, removed: orphans.length };
}

// ─── Web versions ─────────────────────────────────────────────────────────────

const webDir  = (kind, id) => path.join(WEB_ROOT, `${kind}-${id}`);
const subsDir = (kind, id) => path.join(WEB_ROOT, 'subs', `${kind}-${id}`);

function removeWebVersion(kind, id) {
  forgetSize(kind, id);
  const job = running.get(jobKey(kind, id));
  if (job) { job.cancelled = true; job.proc?.kill('SIGKILL'); }
  for (const dir of [webDir(kind, id), subsDir(kind, id)]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // Windows: a folder can't go while a process still runs in it, and the
      // ffmpeg just killed runs in its output folder until it has exited.
      if (!job?.proc || job.proc.exitCode !== null) throw err;
      job.proc.once('close', () => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }, () => {}));
    }
  }
}

/**
 * Ask for a web version. With priority >= DEMAND_PRIORITY it starts right
 * away (see pump), and one already running in the background is promoted, so
 * it may use the disk space kept back for on-demand work.
 */
function enqueue(kind, id, { priority = 0 } = {}) {
  const r = rows.get(kind, id);
  if (!r || !['remux', 'transcode'].includes(r.plan)) return r;
  if (priority >= SOON_PRIORITY) touch(kind, id);
  if (r.web_state === 'ready') return r;
  const p = Math.max(priority, r.web_priority || 0);
  if (r.web_state === 'encoding') {
    const job = running.get(jobKey(kind, id));
    if (job && p >= DEMAND_PRIORITY && !job.demand) {
      job.demand = true;
      rows.update(kind, id, { web_priority: p });
    }
    return rows.get(kind, id);
  }
  rows.update(kind, id, { web_state: 'queued', web_priority: p, web_error: null });
  pump();
  return rows.get(kind, id);
}

let encoderCache = null;

/** 'vaapi' or 'x264', following the setting and what this machine can do. */
async function pickEncoder() {
  const want = settings.get('web_encoder') || 'auto';
  if (want === 'x264') return 'x264';
  if (encoderCache === null) {
    encoderCache = fs.existsSync(VAAPI_DEVICE) && await new Promise(resolve => {
      execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error',
        '-init_hw_device', `vaapi=va:${VAAPI_DEVICE}`, '-filter_hw_device', 'va',
        '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=10',
        '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-f', 'null', '-'],
      { timeout: 30_000 }, (err) => resolve(!err));
    });
    if (!encoderCache && want === 'vaapi') log.warn(`VAAPI encoding is not available on ${VAAPI_DEVICE}; using libx264`);
  }
  return encoderCache ? 'vaapi' : 'x264';
}

function bitrateFor(height) {
  if (height <= 480) return 2_000_000;
  if (height <= 720) return 4_500_000;
  if (height <= 1080) return 8_000_000;
  return 18_000_000;
}

/**
 * Whether the GPU can decode this video too, not just encode the result —
 * HEVC, AV1, VP9 and MPEG-2 in 8 or 10-bit 4:2:0 (AMD since Polaris/RDNA,
 * Intel since Kaby Lake). 10-bit H.264 and 4:2:2/4:4:4 have no hardware
 * decoder anywhere; those are decoded on the CPU and only encoded on the GPU.
 */
function gpuDecodable(video) {
  return !!video?.width && !!video?.height
    && ['hevc', 'av1', 'vp9', 'mpeg2video', 'h264'].includes(video.codec_name)
    && (video.codec_name === 'h264' ? ['yuv420p', 'yuvj420p'] : ['yuv420p', 'yuvj420p', 'yuv420p10le'])
      .includes(video.pix_fmt);
}

/** Width and height to scale to, or null when the video already fits. */
function scaledSize(video, maxHeight) {
  if (!video.height || video.height <= maxHeight || !video.width) return null;
  return { w: Math.round(video.width * maxHeight / video.height / 2) * 2, h: maxHeight };
}

/** HDR → SDR (Hable), on the CPU: zimg, threaded per slice in ffmpeg 5.1. */
const TONEMAP = ['format=gbrpf32le', 'zscale=p=bt709', 'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv'];

/**
 * ffmpeg arguments for one web version. Pure, so the decisions in it can be
 * tested without running an encode.
 *
 * `hwDecode` (VAAPI only) keeps the frames on the GPU from decoder to encoder,
 * scaling there too. Decoding 4K HEVC and scaling it down on the CPU are what
 * make a GPU encode slow otherwise: the encoder waits on them. HDR still comes
 * down to the CPU for tone mapping — at 1080p, after the GPU scaled it.
 */
/**
 * The video encoder's arguments: H.264 or HEVC, on the GPU (VAAPI) or the CPU.
 * HEVC needs about 60% of H.264's bitrate for the same picture, and is
 * tagged hvc1 — the form Safari and Chrome accept in fMP4.
 */
function videoEncoder({ encoder, codec, outHeight }) {
  const br = bitrateFor(outHeight);
  const kf = ['-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`];
  if (codec === 'hevc') {
    const hb = Math.round(br * 0.6);
    return encoder === 'vaapi'
      ? ['-c:v', 'hevc_vaapi', '-profile:v', 'main', '-rc_mode', 'VBR', '-b:v', String(hb),
        '-maxrate', String(Math.round(hb * 1.5)), '-tag:v', 'hvc1', ...kf]
      : ['-c:v', 'libx265', '-preset', 'fast', '-crf', '24', '-x265-params', 'log-level=error',
        '-maxrate', String(Math.round(hb * 1.5)), '-bufsize', String(hb * 2), '-tag:v', 'hvc1', ...kf];
  }
  return encoder === 'vaapi'
    ? ['-c:v', 'h264_vaapi', '-profile:v', 'high', '-rc_mode', 'VBR', '-b:v', String(br),
      '-maxrate', String(Math.round(br * 1.5)), ...kf]
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high',
      '-maxrate', String(Math.round(br * 1.5)), '-bufsize', String(br * 2), ...kf];
}

function buildEncodeArgs({ input, info, plan, encoder, maxHeight = 1080, wanted, hwDecode = false, codec = 'h264' }) {
  const video = mainVideo(info.streams);
  const audio = audioRenditions(info.streams, wanted);
  const args = ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats'];
  const transcode = plan === 'transcode';
  const gpuDecode = transcode && encoder === 'vaapi' && hwDecode && gpuDecodable(video);

  if (transcode && encoder === 'vaapi') {
    args.push('-init_hw_device', `vaapi=va:${VAAPI_DEVICE}`, '-filter_hw_device', 'va');
  }
  if (gpuDecode) args.push('-hwaccel', 'vaapi', '-hwaccel_device', 'va', '-hwaccel_output_format', 'vaapi');
  args.push('-i', path.resolve(input), '-map', `0:${video.index}`);
  for (const a of audio) args.push('-map', `0:${a.stream}`);
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn', '-max_muxing_queue_size', '4096');

  let outHeight = video.height || 1080;
  if (!transcode) {
    args.push('-c:v', 'copy');
    // A copied HEVC stream as hvc1 (parameter sets in the init segment), the
    // only form Safari and Chrome play from fMP4.
    if (video.codec_name === 'hevc') args.push('-tag:v', 'hvc1');
  } else if (gpuDecode) {
    const size = scaledSize(video, maxHeight);
    if (size) outHeight = size.h;
    const dims = size ? `w=${size.w}:h=${size.h}:` : '';
    const filters = isHdr(video)
      // Downloaded as decoded (p010 for 10-bit); zimg scales on the way into
      // linear light, so the float tone mapping runs at 1080p, not 4K.
      ? ['hwdownload', `format=${/10/.test(video.pix_fmt) ? 'p010le' : 'nv12'}`,
        `zscale=${dims}t=linear:npl=100`, ...TONEMAP, 'format=nv12', 'hwupload']
      : [`scale_vaapi=${dims}format=nv12`];
    args.push('-vf', filters.join(','), ...videoEncoder({ encoder, codec, outHeight }));
  } else {
    const filters = [];
    if (video.height && video.height > maxHeight) {
      filters.push(`scale=-2:${maxHeight}`);
      outHeight = maxHeight;
    }
    if (isHdr(video)) {
      // Tone-map HDR to SDR; without it, HDR shown as SDR looks washed out.
      filters.push('zscale=t=linear:npl=100', ...TONEMAP);
    }
    filters.push(...(encoder === 'vaapi' ? ['format=nv12', 'hwupload'] : ['format=yuv420p']));
    args.push('-vf', filters.join(','), ...videoEncoder({ encoder, codec, outHeight }));
  }

  // Every track becomes stereo AAC (copied when it already is), in its own
  // folder: a0 for the default, a1… for the rest.
  audio.forEach((a, i) => {
    if (a.codec === 'aac' && a.channels <= 2) args.push(`-c:a:${i}`, 'copy');
    else args.push(`-c:a:${i}`, 'aac', `-ac:a:${i}`, '2', `-b:a:${i}`, '192k');
  });
  if (audio.length === 0) args.push('-an');
  const streamMap = [audio.length ? 'v:0,agroup:aud,name:v' : 'v:0,name:v',
    ...audio.map((_, i) => `a:${i},agroup:aud,name:a${i}`)].join(' ');

  args.push('-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    // Relative to outDir, which ffmpeg runs in: given absolute paths, some
    // builds (4.4 on Windows) write the init segments to their own cwd.
    '-hls_segment_filename', '%v/seg_%05d.m4s',
    '-hls_flags', 'independent_segments+temp_file', '-start_number', '0',
    '-var_stream_map', streamMap,
    '%v/index.m3u8');
  return args;
}

/** Peak bits per second of a web version's video, for the master playlist. */
function webBandwidth({ plan, info, size, duration, maxHeight = 1080, codec = 'h264' }) {
  if (plan === 'transcode') {
    const h = Math.min(mainVideo(info.streams)?.height || 1080, maxHeight);
    return Math.round(bitrateFor(h) * (codec === 'hevc' ? 0.6 : 1) * 1.5);
  }
  const v = Number(mainVideo(info.streams)?.bit_rate);
  if (v > 0) return Math.round(v * 1.5);
  return size && duration ? Math.round((size * 8 / duration) * 1.5) : 12_000_000;
}

// ─── Free space ──────────────────────────────────────────────────────────────

const GB = 1e9;   // as the dashboard shows sizes
const SPACE_RECHECK_MS = 60_000;
/** While an encode runs, free space is checked this often. */
const SPACE_WATCH_MS = 30_000;

/** Bytes free to this process on the disk holding `dir`; null when it can't be read. */
function freeBytes(dir = WEB_ROOT) {
  // The folder may not exist yet: the disk it will be on is its nearest parent that does.
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(d)) {
      try {
        const s = fs.statfsSync(d);
        return Number(s.bavail) * Number(s.bsize);
      } catch (_) { return null; }
    }
    if (path.dirname(d) === d) return null;
  }
}

function minFreeBytes() {
  const n = Number(settings.get('web_min_free_gb'));
  return (Number.isFinite(n) && n >= 0 ? n : 20) * GB;
}

/**
 * Space kept back, on top of "Keep free", for what someone asks to watch.
 * Background work (preparing everything as it downloads) stops at the edge of
 * it, so pressing play on something that still needs converting finds room.
 */
function reserveBytes() {
  const n = Number(settings.get('web_reserve_gb'));
  return (Number.isFinite(n) && n >= 0 ? n : 50) * GB;
}

/** Free space a job needs to start: on-demand may use the reserve, background may not. */
const startFloor = (demand) => minFreeBytes() + (demand ? 0 : reserveBytes());
/**
 * A running job stops below this. Lower than the start floor, so a job that
 * started doesn't stop at once over a few megabytes: halfway into the margin.
 */
const stopFloor = (demand) => (demand ? minFreeBytes() / 2 : minFreeBytes() + reserveBytes() / 2);

const gb = (b) => `${(b / GB).toFixed(1)} GB`;

// Paused for space, per kind of work: { free, need, since } or null.
const lowSpace = { background: null, demand: null };

/**
 * Whether there is room to start a job of this kind. A pause is logged once,
 * and work carries on by itself once there is room again.
 */
function spaceOk(mode = 'background', free = freeBytes()) {
  const need = startFloor(mode === 'demand');
  if (free === null || need === 0 || free >= need) {
    if (lowSpace[mode]) {
      log.info(`${free === null ? 'free space unknown' : `${gb(free)} free`} on ${WEB_ROOT} again; ${mode === 'demand' ? 'requested' : 'background'} web versions continue`);
      lowSpace[mode] = null;
      setImmediate(pump);
    }
    return true;
  }
  if (!lowSpace[mode]) {
    lowSpace[mode] = { free, need, since: new Date().toISOString() };
    log.warn(mode === 'demand'
      ? `only ${gb(free)} free on ${WEB_ROOT} (keeping ${gb(minFreeBytes())} free): even requested web versions are paused`
      : `${gb(free)} free on ${WEB_ROOT}: background web versions pause to keep ${gb(need)} free (${gb(reserveBytes())} of it for what someone asks to watch)`);
  }
  lowSpace[mode].free = free;
  return false;
}

/** For the Watch library panel. */
function spaceStatus() {
  const free = freeBytes();
  // As things stand now, not as when a job last started.
  spaceOk('background', free);
  spaceOk('demand', free);
  return {
    path: WEB_ROOT, free, min: minFreeBytes(), reserve: reserveBytes(),
    paused: !!lowSpace.demand, backgroundPaused: !!lowSpace.background,
    since: (lowSpace.demand || lowSpace.background)?.since || null,
  };
}

/**
 * Bytes a web version will take. A repackage is about the size of the
 * original (video copied, audio re-encoded); a conversion is its bitrate times
 * its length. Once a job has run out of room, what it actually wrote by then
 * (scaled to the whole) replaces the guess, so the same file can't start,
 * fill the disk and be stopped again in a loop.
 */
function estimateBytes(row) {
  if (row.web_estimate > 0) return row.web_estimate;
  if (row.plan === 'remux') return row.size || 0;
  let info = null;
  try { info = JSON.parse(row.probe); } catch (_) {}
  const video = info && mainVideo(info.streams);
  if (!video || !row.duration) return row.size || 0;
  const h = Math.min(video.height || 1080, Number(settings.get('web_max_height')) || 1080);
  const audio = info ? audioRenditions(info.streams, wantedLanguages()).length || 1 : 1;
  return Math.round((bitrateFor(h) + audio * 192_000) * row.duration / 8);
}

/**
 * After running out of room: how big the whole thing really is, from what it
 * wrote and how far it got. Never smaller than the estimate it had.
 */
function learnEstimate(row, written) {
  const done = Math.min(1, Math.max(0, row.web_progress || 0));
  const seen = done > 0.02 ? written / done * 1.1 : Math.max(estimateBytes(row) * 1.5, written * 4);
  return Math.round(Math.max(estimateBytes(row), seen));
}

/** Bytes the jobs already running are still going to write. */
function bytesStillToWrite() {
  let total = 0;
  for (const j of running.values()) {
    const r = rows.get(j.kind, j.id);
    if (r) total += estimateBytes(r) * Math.max(0, 1 - (r.web_progress || 0));
  }
  return total;
}

/**
 * Whether a job can start now and finish without being stopped for space:
 * free space at least its start floor, and enough left after it — and after
 * what running jobs still have to write — to stay above its stop floor.
 * @returns {null | { reason: 'space', free, need, estimate, min }}
 */
function roomFor(row, demand, free = freeBytes()) {
  if (free === null) return null;
  const estimate = estimateBytes(row);
  const toFinish = stopFloor(demand) + estimate + bytesStillToWrite();
  const need = Math.max(startFloor(demand), toFinish);
  if (need > 0 && free < need) return { reason: 'space', free, need, estimate, min: minFreeBytes() };
  return null;
}

/**
 * Why a queued web version hasn't started, for the player: not enough space
 * (with how much it needs), or every slot taken. null when it isn't waiting.
 */
function waitingFor(row) {
  if (!row || row.web_state !== 'queued') return null;
  const demand = (row.web_priority || 0) >= DEMAND_PRIORITY;
  const short = roomFor(row, demand);
  if (short) return short;
  const busy = [...running.values()].filter(j => (demand ? j.demand : j.lane === row.plan));
  return { reason: 'busy', running: busy.length };
}

/**
 * Scheduling.
 *
 * Background work runs in two lanes, one job each: repackaging (a copy,
 * mostly disk) and converting (GPU or CPU, an hour or more a film). Separate,
 * so a long conversion queue never holds up files that need only a minute.
 *
 * On-demand work — someone is waiting on the player — doesn't queue behind
 * either: it starts at once (up to MAX_DEMAND together), and a background job
 * in its lane is stopped and put back in the queue to start again afterwards.
 * "Soon" work (the next episode, a download) goes first among the background
 * jobs. A job that won't fit is skipped, so a smaller one behind it can go.
 */
const LANES = ['remux', 'transcode'];
const running = new Map();   // "kind:id" → { kind, id, lane, demand, proc, cancelled }
const jobKey = (kind, id) => `${kind}:${id}`;

/** After this many GPU decode failures in a row, decode on the CPU until restart. */
const GPU_DECODE_GIVE_UP = 3;
let gpuDecodeFailures = 0;

function startJob(job, demand) {
  const lane = job.plan;
  const key = jobKey(job.kind, job.item_id);
  // Marked before anything asynchronous, so the next pump can't start it twice.
  running.set(key, { kind: job.kind, id: job.item_id, lane, demand, proc: null, cancelled: false });
  rows.update(job.kind, job.item_id, { web_state: 'encoding', web_progress: 0, web_error: null, web_estimate: estimateBytes(job) });
  if (demand) {
    for (const [k, other] of running) {
      // Already being stopped (deleted, cleared, paused): leave it be. Its
      // process may take a moment to exit, and putting it back in the queue
      // here would bring back something that was just removed.
      if (k === key || other.demand || other.cancelled || other.lane !== lane) continue;
      log.info(`paused to prepare something someone is waiting for; it starts again afterwards`, { type: other.kind, id: other.id });
      other.cancelled = true;
      rows.update(other.kind, other.id, { web_state: 'queued', web_progress: 0 });
      other.proc?.kill('SIGKILL');
    }
  }
  encode(job, { lane, demand })
    .catch(err => {
      log.error(`web version crashed: ${err.message}`, { type: job.kind, id: job.item_id });
      try { rows.update(job.kind, job.item_id, { web_state: 'failed', web_error: err.message.slice(0, 500) }); } catch (_) {}
    })
    .finally(() => {
      if (running.get(key)?.lane === lane) running.delete(key);
      setImmediate(pump);
    });
}

/** Requests nobody is waiting for any more become ordinary background work. */
function expireRequests(now = Date.now()) {
  for (const r of rows.prioritised()) {
    const ttl = r.web_priority >= DEMAND_PRIORITY ? DEMAND_TTL_MS : SOON_TTL_MS;
    if (stillWanted(r.kind, r.item_id, ttl, now)) continue;
    rows.update(r.kind, r.item_id, { web_priority: 0 });
    const job = running.get(jobKey(r.kind, r.item_id));
    if (job) job.demand = false;   // keeps going, but as background work
  }
}

function pump() {
  expireRequests();
  const space = { demand: spaceOk('demand'), background: spaceOk('background') };
  // What someone is waiting for first, however busy the lanes are.
  for (const job of rows.queuedDemand()) {
    if ([...running.values()].filter(j => j.demand).length >= MAX_DEMAND) break;
    if (!space.demand) break;
    if (roomFor(job, true)) continue;   // too big for the space left; the player says so
    startJob(job, true);
  }
  // Then background work, one job per lane, never alongside on-demand work in
  // the same lane.
  for (const lane of LANES) {
    if ([...running.values()].some(j => j.lane === lane)) continue;
    for (const job of rows.queuedIn(lane)) {
      const demand = (job.web_priority || 0) >= DEMAND_PRIORITY;
      if (!(demand ? space.demand : space.background)) continue;
      if (roomFor(job, demand)) continue;
      startJob(job, demand);
      break;
    }
  }
}

async function encode(job, opts = {}) {
  const lane = opts.lane || job.plan;
  const { kind, item_id: id } = job;
  // Set by startJob; it carries whether someone is waiting (which can change
  // while it runs) and whether it was stopped to make way for such a job.
  const entry = running.get(jobKey(kind, id)) || { demand: !!opts.demand };
  const stillWanted = () => !entry.cancelled && rows.get(kind, id)?.web_state === 'encoding';
  const outDir = webDir(kind, id);
  forgetSize(kind, id);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  let info;
  try { info = JSON.parse(job.probe); } catch (_) { info = null; }
  if (!info || !fs.existsSync(job.path)) {
    rows.update(kind, id, { web_state: 'failed', web_error: 'source file is missing' });
    return;
  }
  const encoder = job.plan === 'transcode' ? (opts.encoder || await pickEncoder()) : 'copy';
  if (!stillWanted()) return;
  const maxHeight = Number(settings.get('web_max_height')) || 1080;
  const wanted = wantedLanguages();
  const hwDecode = encoder === 'vaapi' && (opts.hwDecode ?? gpuDecodeFailures < GPU_DECODE_GIVE_UP)
    && gpuDecodable(mainVideo(info.streams));
  const codec = webCodec();
  const args = buildEncodeArgs({ input: job.path, info, plan: job.plan, encoder, maxHeight, wanted, hwDecode, codec });
  // Written before ffmpeg starts: a player that opens it while the encode
  // runs finds the playlists it names filling up.
  fs.writeFileSync(path.join(outDir, 'master.m3u8'), masterPlaylist({
    renditions: audioRenditions(info.streams, wanted),
    bandwidth: webBandwidth({ plan: job.plan, info, size: job.size, duration: job.duration, maxHeight, codec }),
  }));
  rows.update(kind, id, { web_state: 'encoding', web_progress: 0, web_error: null, web_encoder: encoder,
    web_gen: (Number(job.web_gen) || 0) + 1,
    web_codec: webCodecOf(job.plan, info, codec) });
  const started = Date.now();
  const label = `${kind} #${id}`;

  const result = await new Promise((resolve) => {
    const proc = spawn(FFMPEG, args, { cwd: outDir, stdio: ['ignore', 'pipe', 'pipe'] });
    entry.proc = proc;
    if (entry.cancelled) proc.kill('SIGKILL');
    let stderr = '';
    let lastWrite = 0;
    proc.stdout.on('data', (chunk) => {
      const m = /out_time_(?:us|ms)=(\d+)/g;
      let hit, last = null;
      while ((hit = m.exec(String(chunk)))) last = Number(hit[1]);
      if (last !== null && job.duration && Date.now() - lastWrite > 2000) {
        lastWrite = Date.now();
        rows.update(kind, id, { web_progress: Math.min(0.999, last / 1e6 / job.duration) });
      }
    });
    proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
    // Started with room to spare, but a 4K film writes gigabytes, and
    // downloads share the disk. Background work stops before it eats into the
    // room kept for on-demand work; on-demand work halfway into "Keep free".
    let outOfSpace = false;
    const watch = setInterval(() => {
      const free = freeBytes();
      const floor = stopFloor(entry.demand);
      if (free !== null && floor > 0 && free < floor) { outOfSpace = true; proc.kill('SIGKILL'); }
    }, SPACE_WATCH_MS);
    watch.unref?.();
    const done = (r) => {
      clearInterval(watch);
      resolve(outOfSpace ? { ok: false, outOfSpace: true, error: 'disk nearly full' } : r);
    };
    proc.on('error', (err) => done({ ok: false, error: err.message }));
    proc.on('close', (code, signal) => done(code === 0 ? { ok: true }
      : { ok: false, error: signal ? `stopped (${signal})` : (stderr.trim().split('\n').pop() || `ffmpeg exited ${code}`) }));
  });

  // Removed, re-recorded, cleared, or stopped to make way while it ran:
  // whatever is there now wins.
  const now = rows.get(kind, id);
  if (!now || now.path !== job.path || now.web_state !== 'encoding') {
    if (!now || now.web_state === 'none') fs.rmSync(outDir, { recursive: true, force: true });
    return;
  }
  // Out of space, or ffmpeg failing because the disk already is: not this
  // file's fault. Back in the queue to start over, and pause.
  if (!result.ok && (result.outOfSpace || /No space left|ENOSPC/i.test(result.error))) {
    // How big it really is: what it wrote, scaled up by how far it got. Kept,
    // so it isn't started again until that much room exists.
    const learned = learnEstimate(now, dirBytes(outDir));
    fs.rmSync(outDir, { recursive: true, force: true });
    rows.update(kind, id, { web_state: 'queued', web_progress: 0, web_estimate: learned });
    const mode = entry.demand ? 'demand' : 'background';
    log.warn(entry.demand
      ? `web version stopped: the disk holding ${WEB_ROOT} is nearly full; it starts over once there is room`
      : `background web version stopped to keep room for what someone asks to watch; it starts over once there is space`,
    { type: kind, id });
    spaceOk(mode, Math.min(freeBytes() ?? 0, startFloor(entry.demand) - 1));
    return;
  }
  if (result.ok) {
    try { repairInitSegments(kind, id); } catch (err) { log.warn(`init segment check failed: ${err.message}`, { type: kind, id }); }
    rows.update(kind, id, { web_state: 'ready', web_progress: 1 });
    prewarmSubtitles(rows.get(kind, id)).catch(() => {});
    require('./thumbs').ensure(kind, id);
    if (hwDecode) gpuDecodeFailures = 0;
    const secs = (Date.now() - started) / 1000;
    const how = encoder === 'vaapi' ? `GPU${hwDecode ? '' : ', decoded on the CPU'}` : encoder;
    const speed = job.duration ? `, ${(job.duration / secs).toFixed(1)}× real time` : '';
    log.info(`web version ready (${job.plan}, ${how}) in ${Math.round(secs)}s${speed}`, { type: kind, id });
  } else {
    // A GPU failure on one odd file shouldn't need a settings change: retry it
    // decoding on the CPU, then entirely on the CPU.
    if (hwDecode) {
      if (++gpuDecodeFailures === GPU_DECODE_GIVE_UP) {
        log.warn(`GPU decoding failed ${GPU_DECODE_GIVE_UP} times in a row; decoding on the CPU until the server restarts`);
      }
      log.warn(`GPU decode failed (${result.error}); retrying with the CPU decoding`, { type: kind, id });
      rows.update(kind, id, { web_state: 'queued' });
      rows.update(kind, id, { web_state: 'encoding' });
      await encode(rows.get(kind, id), { ...opts, lane, encoder: 'vaapi', hwDecode: false });
      return;
    }
    if (encoder === 'vaapi') {
      log.warn(`GPU encode failed (${result.error}); retrying on the CPU`, { type: kind, id });
      rows.update(kind, id, { web_state: 'queued' });
      rows.update(kind, id, { web_state: 'encoding' });
      await encode(rows.get(kind, id), { ...opts, lane, encoder: 'x264' });
      return;
    }
    rows.update(kind, id, { web_state: 'failed', web_error: result.error.slice(0, 500) });
    log.warn(`web version failed for ${label}: ${result.error}`, { type: kind, id });
  }
}

/** On startup: an encode that was running when the process stopped starts over. */
function startWorker() {
  fs.mkdirSync(WEB_ROOT, { recursive: true });
  db.prepare("UPDATE media_files SET web_state = 'queued', web_progress = 0 WHERE web_state = 'encoding'").run();
  try {
    const n = replanStored();
    if (n) log.info(`${n} file(s) planned again under the current rules (several audio tracks, the web video codec)`);
  } catch (err) { console.error('[media] re-plan failed:', err.message); }
  setImmediate(pump);
  // Copies made before web_last_used existed start their clock now, rather
  // than all looking a month old at once.
  db.prepare("UPDATE media_files SET web_last_used = datetime('now') WHERE web_last_used IS NULL AND web_state = 'ready'").run();
  setTimeout(() => { try { dropUnwatched(); } catch (err) { console.error('[media] drop pass failed:', err.message); } }, 5 * 60_000).unref();
  setInterval(() => { try { dropUnwatched(); } catch (err) { console.error('[media] drop pass failed:', err.message); } }, DROP_CHECK_MS).unref();
  // Paused for space: look again now and then, and carry on once there is room.
  setInterval(pump, SPACE_RECHECK_MS).unref();
  // Index what finished before playback existed, a batch at a time, so the
  // back catalogue becomes watchable without anyone pressing a button.
  const tick = () => indexPass().catch(err => console.error('[media] index pass failed:', err.message));
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 30 * 60_000).unref();
  // Web versions made before the init-segment repair existed.
  setTimeout(() => {
    let fixed = 0;
    for (const r of rows.all().filter(x => x.web_state === 'ready')) {
      try { fixed += repairInitSegments(r.kind, r.item_id); } catch (_) {}
    }
    if (fixed) log.info(`repaired ${fixed} web version init segment(s) for the Android player`);
  }, 10_000).unref();
}

// ─── fMP4 init segments ───────────────────────────────────────────────────────

/** Top-level MP4 boxes: [{ type, start, end }]. */
function mp4Boxes(buf) {
  const out = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    let n = buf.readUInt32BE(i);
    if (n === 1 && i + 16 <= buf.length) n = Number(buf.readBigUInt64BE(i + 8));
    if (n < 8 || i + n > buf.length) break;
    out.push({ type: buf.toString('latin1', i + 4, i + 8), start: i, end: i + n });
    i += n;
  }
  return out;
}

/**
 * Some ffmpeg builds (4.4; trac #9193) put the first fragment — sidx, moof,
 * mdat — into the fMP4 init segment and leave segment 0 a bare styp. hls.js
 * plays that; Media3 (the Android app) fails on it. Move the fragment back
 * where it belongs. sidx offsets are relative to the sidx itself, so moving
 * the boxes together keeps them valid. Returns how many playlists it fixed.
 */
function repairInitSegments(kind, id) {
  let fixed = 0;
  for (const rel of hlsPlaylists(kind, id)) {
    const dir = path.join(webDir(kind, id), path.dirname(rel));
    let pl;
    try { pl = fs.readFileSync(path.join(webDir(kind, id), rel), 'utf8'); } catch (_) { continue; }
    const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(pl);
    const first = pl.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (!map || !first) continue;
    const initPath = path.join(dir, map[1]), segPath = path.join(dir, first);
    let init, seg;
    try { init = fs.readFileSync(initPath); seg = fs.readFileSync(segPath); } catch (_) { continue; }
    const ib = mp4Boxes(init);
    const moov = ib.find(b => b.type === 'moov');
    if (!moov || !ib.some(b => b.type === 'moof')) continue;
    if (mp4Boxes(seg).some(b => b.type === 'moof')) continue; // segment 0 has its own data: leave it
    fs.writeFileSync(`${segPath}.fix`, Buffer.concat([seg, init.subarray(moov.end)]));
    fs.writeFileSync(`${initPath}.fix`, init.subarray(0, moov.end));
    fs.renameSync(`${segPath}.fix`, segPath);
    fs.renameSync(`${initPath}.fix`, initPath);
    fixed++;
  }
  return fixed;
}

/** Bytes under a folder (0 if it doesn't exist). */
function dirBytes(dir) {
  let total = 0;
  const go = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) go(f);
      else try { total += fs.statSync(f).size; } catch (_) {}
    }
  };
  go(dir);
  return total;
}

// ─── How much the web versions take ──────────────────────────────────────────
//
// Counting means a stat for every 6-second segment: tens of thousands of files
// on a spinning disk. Done synchronously on every Settings visit (and every
// 5 s while the queue ran) it held up every other request. Now it is done
// without blocking, and a finished web version — which no longer changes — is
// counted once.

const sizeCache = new Map();   // web version folder name → bytes, once finished
let subsSize = { bytes: 0, at: 0 };
const SUBS_SIZE_TTL_MS = 10 * 60_000;
let usageInFlight = null;

function forgetSize(kind, id) { sizeCache.delete(`${kind}-${id}`); }

/** Bytes under a folder (0 if it doesn't exist), without holding up the server. */
async function dirBytesAsync(dir) {
  let total = 0;
  let ents;
  try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const e of ents) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirBytesAsync(f);
    else try { total += (await fs.promises.stat(f)).size; } catch (_) {}
  }
  return total;
}

/** `{ total, largest }`: all web versions' bytes, and the biggest ones for freeing space by hand. */
function webUsage(limit = 15) {
  usageInFlight ??= (async () => {
    let names = [];
    try { names = await fs.promises.readdir(WEB_ROOT); } catch (_) {}
    const per = [];
    let total = 0;
    for (const n of names) {
      const full = path.join(WEB_ROOT, n);
      const m = /^(movie|episode)-(\d+)$/.exec(n);
      if (!m) {
        if (n === 'subs') {
          if (Date.now() - subsSize.at > SUBS_SIZE_TTL_MS) subsSize = { bytes: await dirBytesAsync(full), at: Date.now() };
          total += subsSize.bytes;
        } else {
          try { total += (await fs.promises.stat(full)).size; } catch (_) {}
        }
        continue;
      }
      const row = rows.get(m[1], Number(m[2]));
      const settled = !row || !['queued', 'encoding'].includes(row.web_state);
      let bytes = settled ? sizeCache.get(n) : undefined;
      if (bytes === undefined) {
        bytes = await dirBytesAsync(full);
        if (settled) sizeCache.set(n, bytes);
      }
      total += bytes;
      per.push({ kind: m[1], id: Number(m[2]), bytes, state: row?.web_state || null, onlyCopy: !!row?.original_removed_at });
    }
    return { total, all: per.sort((a, b) => b.bytes - a.bytes) };
  })().finally(() => { usageInFlight = null; });
  return usageInFlight.then(u => ({ total: u.total, largest: u.all.slice(0, limit) }));
}

/** The biggest web versions, for freeing space by hand. */
async function largestWebVersions(limit = 15) {
  return (await webUsage(limit)).largest;
}

/** Total bytes in the web-version folder. */
async function cacheSize() {
  return (await webUsage()).total;
}

/**
 * Delete every web version that can be rebuilt. One whose original was removed
 * after seeding is the only copy left, so it stays.
 */
function clearWebVersions() {
  for (const job of running.values()) job.proc.kill('SIGKILL');
  for (const r of rows.all()) if (!r.original_removed_at) removeWebVersion(r.kind, r.item_id);
  db.prepare("UPDATE media_files SET web_state = 'none', web_progress = 0, web_error = NULL WHERE original_removed_at IS NULL").run();
}

/**
 * Whether the original itself plays in a browser — true for an MP4 that only
 * needs a web version to make its other audio tracks selectable. Such a file
 * is served as it is until that web version is ready.
 */
function playsAsIs(row) {
  if (!row || row.original_removed_at) return false;
  if (row.plan === 'direct') return true;
  if (row.plan !== 'remux') return false;
  try { return planFor(JSON.parse(row.probe), wantedLanguages(), { multiAudio: false }).plan === 'direct'; } catch (_) { return false; }
}

/**
 * Files planned before a rule changed keep their old plan, because a file is
 * probed only once. Re-plan the ones a newer rule would treat differently —
 * today, MP4s with several audio tracks that were played as they are — from
 * the probe already stored. Returns how many changed.
 */
function replanStored() {
  let changed = 0;
  // Files that play as they are, and anything whose web version isn't made
  // yet: a web version already made keeps working, whatever the rules now say.
  const open = (x) => x.plan === 'direct' || ['none', 'queued', 'failed'].includes(x.web_state);
  for (const r of rows.all().filter(x => x.probe && !x.original_removed_at && open(x))) {
    let info;
    try { info = JSON.parse(r.probe); } catch (_) { continue; }
    const p = planFor(info, wantedLanguages());
    if (p.plan === r.plan) continue;
    const queued = r.web_state === 'queued';
    rows.update(r.kind, r.item_id, { plan: p.plan, plan_reason: p.reason, web_state: 'none', web_progress: 0, web_error: null });
    if (p.plan !== 'direct' && (queued || preparesAhead(p.plan))) enqueue(r.kind, r.item_id);
    changed++;
  }
  return changed;
}

/** The playlist a player opens: master.m3u8, or index.m3u8 for an older web version. */
function hlsEntry(kind, id) {
  return fs.existsSync(path.join(webDir(kind, id), 'master.m3u8')) ? 'master.m3u8' : 'index.m3u8';
}

/** Every media playlist of a web version, as paths relative to its folder. */
function hlsPlaylists(kind, id) {
  if (hlsEntry(kind, id) === 'index.m3u8') return ['index.m3u8'];
  let master = '';
  try { master = fs.readFileSync(path.join(webDir(kind, id), 'master.m3u8'), 'utf8'); } catch (_) { return []; }
  const uris = [...master.matchAll(/URI="([^"]+)"/g)].map(m => m[1]);
  for (const line of master.split('\n')) if (line && !line.startsWith('#')) uris.push(line.trim());
  return uris;
}

const playlistHas = (kind, id, rel, re) => {
  try { return re.test(fs.readFileSync(path.join(webDir(kind, id), rel), 'utf8')); } catch (_) { return false; }
};

/** True once every playlist has at least one segment to play. */
function hlsPlayable(kind, id) {
  const lists = hlsPlaylists(kind, id);
  return lists.length > 0 && lists.every(rel => playlistHas(kind, id, rel, /#EXTINF/));
}

/** True once every playlist is finished — ffmpeg writes ENDLIST only on success. */
function hlsComplete(kind, id) {
  const lists = hlsPlaylists(kind, id);
  return lists.length > 0 && lists.every(rel => playlistHas(kind, id, rel, /#EXT-X-ENDLIST/));
}

/**
 * Whether the web version carries every audio track of the original. An
 * older one has a single track, which is all of them only for a file that
 * had one.
 */
function webHasAllAudio(row) {
  let info = null;
  try { info = JSON.parse(row.probe); } catch (_) {}
  const want = (info?.streams || []).filter(s => s.codec_type === 'audio').length;
  if (hlsEntry(row.kind, row.item_id) === 'index.m3u8') return want <= 1;
  return hlsPlaylists(row.kind, row.item_id).filter(u => /^a\d+\//.test(u)).length === want;
}

// ─── Subtitles ────────────────────────────────────────────────────────────────

/** Language code named in a subtitle filename, if any. */
function langFromName(name) {
  const tokens = path.basename(name).toLowerCase().replace(/\.[^.]+$/, '').split(/[\s._\-\[\]()]+/);
  for (const t of tokens.reverse()) {
    const l = normLang(t);
    if (l) return l;
  }
  return null;
}

const shortId = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

/**
 * Every subtitle a player can show for this file: sidecar files named after
 * the video (or in the release's Subs/ folder) and embedded text tracks.
 * Image-based tracks (PGS, VobSub) can't be turned into text and are listed
 * as unavailable.
 */
function listSubtitles(media) {
  // The original is gone: what was there when it was removed, served from the
  // WebVTT copies kept with the web version. Nothing is editable any more.
  if (media.original_removed_at) {
    try { return JSON.parse(media.subs_snapshot || '[]').map(s => ({ ...s, editable: false })); } catch (_) { return []; }
  }
  const out = [];
  const dir = path.dirname(media.path);
  const stem = path.basename(media.path).replace(/\.[^.]+$/, '');
  const showsRoot = mapPath(String(settings.get('shows_path') || '').replace(/\/+$/, ''));
  const moviesRoot = mapPath(String(settings.get('movie_path') || '').replace(/\/+$/, ''));
  // A release folder of its own can rely on a Subs/ directory; a file sitting
  // straight in a show or movie folder shares it with everything else.
  const ownFolder = ![showsRoot, moviesRoot].includes(path.resolve(dir))
    && path.resolve(path.dirname(dir)) !== path.resolve(showsRoot);

  const files = [];
  try {
    for (const n of fs.readdirSync(dir)) if (SUB_EXT.test(n) && n.startsWith(stem)) files.push(path.join(dir, n));
  } catch (_) {}
  if (ownFolder) {
    for (const sub of ['Subs', 'subs', 'Subtitles', 'subtitles']) {
      for (const f of walk(path.join(dir, sub), { depth: 1, max: 300 })) {
        if (!SUB_EXT.test(f.name)) continue;
        // Packs keep each episode's subtitles in a folder named after it.
        const parts = f.name.split('/');
        if (parts.length > 1 && !parts[0].startsWith(stem)) continue;
        files.push(f.full);
      }
    }
  }
  for (const f of [...new Set(files)].sort()) {
    const lang = langFromName(f);
    const rel = path.relative(dir, f);
    const forced = /forced/i.test(path.basename(f));
    const sdh = /(?:^|[._\s-])(sdh|hi|cc)(?:[._\s-]|$)/i.test(path.basename(f).replace(/\.[^.]+$/, ''));
    out.push({
      id: `f${shortId(rel)}`, source: 'file', file: f, format: path.extname(f).slice(1).toLowerCase(),
      lang, forced, label: `${LANG_NAMES[lang] || lang || 'Unknown'}${sdh ? ' SDH' : ''}${forced ? ' (forced)' : ''}`,
      editable: /\.srt$/i.test(f), available: true,
    });
  }

  let info = null;
  try { info = JSON.parse(media.probe); } catch (_) {}
  for (const s of (info?.streams || []).filter(x => x.codec_type === 'subtitle')) {
    const lang = normLang(s.tags?.language);
    const forced = !!s.disposition?.forced;
    const sdh = !!s.disposition?.hearing_impaired || /sdh/i.test(s.tags?.title || '');
    out.push({
      id: `s${s.index}`, source: 'embedded', stream: s.index, format: s.codec_name, lang, forced,
      label: `${LANG_NAMES[lang] || s.tags?.language || 'Unknown'}${sdh ? ' SDH' : ''}${forced ? ' (forced)' : ''} · embedded`,
      editable: false, available: TEXT_SUB_CODECS.has(s.codec_name),
    });
  }

  // Default: the first full (not forced) track in the first wanted language.
  const wanted = wantedLanguages();
  const def = wanted.map(w => out.find(s => s.available && !s.forced && s.lang === w)).find(Boolean);
  if (def) def.default = true;
  return out;
}

// Bump when the conversion itself changes, so cached results made by the old
// one are redone (2: ASS tags such as {\an8} translated instead of shown;
// 3: a line drawn twice at once — ASS layers — shown once).
const VTT_CONVERTER = 3;

/** Path of a WebVTT version of one subtitle, converting (and caching) it. */
async function vttFor(media, subId) {
  const sub = listSubtitles(media).find(s => s.id === subId);
  if (!sub) throw Object.assign(new Error('No such subtitle'), { status: 404 });
  if (!sub.available) throw Object.assign(new Error('Image-based subtitles can\'t be shown as text'), { status: 415 });
  const dir = subsDir(media.kind, media.item_id);
  if (media.original_removed_at) {
    const kept = cachedVtt(dir, subId);
    if (!kept) throw Object.assign(new Error('This subtitle wasn\'t kept when the original was removed'), { status: 404 });
    return kept;
  }
  fs.mkdirSync(dir, { recursive: true });
  // The cache is named after what it was made from: a subtitle file's
  // content (small, and re-timing it can leave size and timestamp unchanged —
  // file times are only as fine as the kernel's coarse clock), or the video's
  // size and mtime for an embedded track.
  const version = sub.source === 'file'
    ? crypto.createHash('sha1').update(fs.readFileSync(sub.file)).digest('hex').slice(0, 16)
    : (() => { const st = fs.statSync(media.path); return `${st.size}-${Math.floor(st.mtimeMs)}`; })();
  const out = path.join(dir, `${subId}.${version}.c${VTT_CONVERTER}.vtt`);
  if (fs.existsSync(out)) return out;
  for (const n of fs.readdirSync(dir)) {
    if (n.startsWith(`${subId}.`) && n.endsWith('.vtt')) fs.rmSync(path.join(dir, n), { force: true });
  }

  const tmp = `${out}.${process.pid}.tmp`;
  if (sub.source === 'file' && ['srt', 'vtt'].includes(sub.format)) {
    const cues = subText.parse(subText.decode(fs.readFileSync(sub.file)));
    fs.writeFileSync(tmp, subText.toVtt(subText.dedupe(cues)));
  } else {
    const input = sub.source === 'file' ? sub.file : media.path;
    const map = sub.source === 'file' ? '0:s:0' : `0:${sub.stream}`;
    await new Promise((resolve, reject) => {
      execFile(FFMPEG, ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-i', input,
        '-map', map, '-c:s', 'webvtt', '-f', 'webvtt', tmp],
      { timeout: 10 * 60_000 }, (err, _o, stderr) => (err
        ? reject(new Error(`subtitle conversion failed: ${String(stderr || err.message).trim().split('\n').pop()}`))
        : resolve()));
    });
    // ASS (embedded or a file) draws many lines twice, on two layers; ffmpeg
    // converts both. One of each, through the same cue writer as SRT.
    const cues = subText.parse(fs.readFileSync(tmp, 'utf8'));
    if (cues.length) fs.writeFileSync(tmp, subText.toVtt(subText.dedupe(cues)));
  }
  fs.renameSync(tmp, out);
  return out;
}

/** The WebVTT copy of a subtitle already in the cache, whatever version it is. */
function cachedVtt(dir, subId) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  const hit = names.find(n => n.startsWith(`${subId}.`) && n.endsWith('.vtt'));
  return hit ? path.join(dir, hit) : null;
}

/** Convert every text subtitle ahead of time, so the first play doesn't wait. */
async function prewarmSubtitles(media) {
  for (const s of listSubtitles(media).filter(x => x.available)) {
    try { await vttFor(media, s.id); } catch (_) {}
  }
}

module.exports = {
  WEB_ROOT, KINDS, rows, itemFor, episodeMeta, probe, planFor, chooseAudio, mainVideo, pickFile,
  record, locate, indexPass, enqueue, startWorker, waitingFor, DEMAND_PRIORITY, MAX_DEMAND, reserveBytes, pump,
  SOON_PRIORITY, DEMAND_TTL_MS, SOON_TTL_MS, touch, estimateBytes, roomFor, learnEstimate, expireRequests,
  dirBytes, largestWebVersions, webUsage, buildEncodeArgs, pickEncoder, webDir, gpuDecodable, touchWeb, dropUnwatched, preparesAhead, spaceStatus, spaceOk, freeBytes,
  hlsPlayable, hlsEntry, hlsComplete, webHasAllAudio, audioRenditions, masterPlaylist, webBandwidth, cacheSize, clearWebVersions, removeWebVersion, listSubtitles, vttFor, prewarmSubtitles, cachedVtt,
  videoFilesIn, subsDir, mp4Boxes, repairInitSegments,
  normLang, langFromName, playsAsIs, replanStored, isExtraAudio, wantedLanguages, searchDisk, queue: () => rows.queue(),
};
