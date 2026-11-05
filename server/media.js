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
  nextQueued: () => db.prepare(
    "SELECT * FROM media_files WHERE web_state = 'queued' ORDER BY web_priority DESC, updated_at LIMIT 1"
  ).get(),
  queue: () => db.prepare(
    "SELECT kind, item_id, web_state, web_progress, web_priority, plan FROM media_files WHERE web_state IN ('queued','encoding') ORDER BY web_state DESC, web_priority DESC, updated_at"
  ).all(),
};

const KINDS = new Set(['movie', 'episode']);

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

/**
 * The audio track to play: not commentary or audio description, in the
 * preferred language if there is one, the default-flagged one otherwise.
 */
function chooseAudio(streams, wanted = wantedLanguages()) {
  const audio = streams.filter(s => s.codec_type === 'audio');
  if (audio.length === 0) return null;
  const plain = audio.filter(a => !(a.disposition?.visual_impaired || a.disposition?.comment
    || a.disposition?.descriptions || AD_TITLE_RE.test(a.tags?.title || '')));
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
 * @returns {{ plan: 'direct'|'remux'|'transcode'|'unplayable', reason: string }}
 */
function planFor({ streams, format }, wanted) {
  const video = mainVideo(streams);
  if (!video) return { plan: 'unplayable', reason: 'no video stream' };
  const audios = streams.filter(s => s.codec_type === 'audio');
  const audio = chooseAudio(streams, wanted);

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

  if (isMp4 && audioOk && audioFirst) return { plan: 'direct', reason: 'plays as it is' };
  const reasons = [];
  if (!isMp4) reasons.push(`${container.split(',')[0] === 'matroska' ? 'MKV' : container.split(',')[0] || 'unknown'} container`);
  if (!audioOk) reasons.push(`${String(audio.codec_name).toUpperCase()} audio`);
  else if (!audioFirst) reasons.push('preferred audio isn\'t the first track');
  return { plan: 'remux', reason: reasons.join(', ') };
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
    original_removed_at: null, subs_snapshot: null,
  });
  if (plan === 'remux' || plan === 'transcode') {
    if (settings.get('web_prepare') !== 'demand') enqueue(kind, id);
  }
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
  if (current && current.kind === kind && current.id === id) current.proc.kill('SIGKILL');
  fs.rmSync(webDir(kind, id), { recursive: true, force: true });
  fs.rmSync(subsDir(kind, id), { recursive: true, force: true });
}

function enqueue(kind, id, { priority = 0 } = {}) {
  const r = rows.get(kind, id);
  if (!r || !['remux', 'transcode'].includes(r.plan)) return r;
  if (r.web_state === 'ready' || r.web_state === 'encoding') return r;
  rows.update(kind, id, { web_state: 'queued', web_priority: Math.max(priority, r.web_priority || 0), web_error: null });
  setImmediate(pump);
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
 * ffmpeg arguments for one web version. Pure, so the decisions in it can be
 * tested without running an encode.
 */
function buildEncodeArgs({ input, info, plan, encoder, maxHeight = 1080, wanted }) {
  const video = mainVideo(info.streams);
  const audio = audioRenditions(info.streams, wanted);
  const args = ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats'];
  const transcode = plan === 'transcode';

  if (transcode && encoder === 'vaapi') {
    args.push('-init_hw_device', `vaapi=va:${VAAPI_DEVICE}`, '-filter_hw_device', 'va');
  }
  args.push('-i', path.resolve(input), '-map', `0:${video.index}`);
  for (const a of audio) args.push('-map', `0:${a.stream}`);
  args.push('-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn', '-max_muxing_queue_size', '4096');

  let outHeight = video.height || 1080;
  if (!transcode) {
    args.push('-c:v', 'copy');
  } else {
    const filters = [];
    if (video.height && video.height > maxHeight) {
      filters.push(`scale=-2:${maxHeight}`);
      outHeight = maxHeight;
    }
    if (isHdr(video)) {
      // Tone-map HDR to SDR; without it, HDR shown as SDR looks washed out.
      filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709',
        'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
    }
    const kf = `expr:gte(t,n_forced*${SEGMENT_SECONDS})`;
    if (encoder === 'vaapi') {
      filters.push('format=nv12', 'hwupload');
      const br = bitrateFor(outHeight);
      args.push('-vf', filters.join(','), '-c:v', 'h264_vaapi', '-profile:v', 'high',
        '-rc_mode', 'VBR', '-b:v', String(br), '-maxrate', String(Math.round(br * 1.5)),
        '-force_key_frames', kf);
    } else {
      filters.push('format=yuv420p');
      args.push('-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
        '-profile:v', 'high', '-maxrate', String(Math.round(bitrateFor(outHeight) * 1.5)),
        '-bufsize', String(bitrateFor(outHeight) * 2), '-force_key_frames', kf);
    }
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
function webBandwidth({ plan, info, size, duration, maxHeight = 1080 }) {
  if (plan === 'transcode') {
    const h = Math.min(mainVideo(info.streams)?.height || 1080, maxHeight);
    return Math.round(bitrateFor(h) * 1.5);
  }
  const v = Number(mainVideo(info.streams)?.bit_rate);
  if (v > 0) return Math.round(v * 1.5);
  return size && duration ? Math.round((size * 8 / duration) * 1.5) : 12_000_000;
}

let current = null;   // { kind, id, proc }
let pumping = false;

/** Run queued encodes one at a time. */
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const job = rows.nextQueued();
      if (!job) break;
      await encode(job);
    }
  } finally {
    pumping = false;
  }
}

async function encode(job, opts = {}) {
  const { kind, item_id: id } = job;
  const outDir = webDir(kind, id);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  let info;
  try { info = JSON.parse(job.probe); } catch (_) { info = null; }
  if (!info || !fs.existsSync(job.path)) {
    rows.update(kind, id, { web_state: 'failed', web_error: 'source file is missing' });
    return;
  }
  const encoder = job.plan === 'transcode' ? (opts.encoder || await pickEncoder()) : 'copy';
  const maxHeight = Number(settings.get('web_max_height')) || 1080;
  const wanted = wantedLanguages();
  const args = buildEncodeArgs({ input: job.path, info, plan: job.plan, encoder, maxHeight, wanted });
  // Written before ffmpeg starts: a player that opens it while the encode
  // runs finds the playlists it names filling up.
  fs.writeFileSync(path.join(outDir, 'master.m3u8'), masterPlaylist({
    renditions: audioRenditions(info.streams, wanted),
    bandwidth: webBandwidth({ plan: job.plan, info, size: job.size, duration: job.duration, maxHeight }),
  }));
  rows.update(kind, id, { web_state: 'encoding', web_progress: 0, web_error: null, web_encoder: encoder });
  const started = Date.now();
  const label = `${kind} #${id}`;

  const result = await new Promise((resolve) => {
    const proc = spawn(FFMPEG, args, { cwd: outDir, stdio: ['ignore', 'pipe', 'pipe'] });
    current = { kind, id, proc };
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
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
    proc.on('close', (code, signal) => resolve(code === 0 ? { ok: true }
      : { ok: false, error: signal ? `stopped (${signal})` : (stderr.trim().split('\n').pop() || `ffmpeg exited ${code}`) }));
  });
  current = null;

  // Removed, re-recorded or cleared while it ran: whatever is there now wins.
  const now = rows.get(kind, id);
  if (!now || now.path !== job.path || now.web_state !== 'encoding') {
    if (!now || now.web_state === 'none') fs.rmSync(outDir, { recursive: true, force: true });
    return;
  }
  if (result.ok) {
    rows.update(kind, id, { web_state: 'ready', web_progress: 1 });
    prewarmSubtitles(rows.get(kind, id)).catch(() => {});
    log.info(`web version ready (${job.plan}, ${encoder}) in ${Math.round((Date.now() - started) / 1000)}s`, { type: kind, id });
  } else {
    // A VAAPI failure on one odd file shouldn't need a settings change: retry
    // it once on the CPU.
    if (encoder === 'vaapi') {
      log.warn(`GPU encode failed (${result.error}); retrying on the CPU`, { type: kind, id });
      rows.update(kind, id, { web_state: 'queued' });
      await encode(rows.get(kind, id), { encoder: 'x264' });
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
  setImmediate(pump);
  // Index what finished before playback existed, a batch at a time, so the
  // back catalogue becomes watchable without anyone pressing a button.
  const tick = () => indexPass().catch(err => console.error('[media] index pass failed:', err.message));
  setTimeout(tick, 30_000).unref();
  setInterval(tick, 30 * 60_000).unref();
}

/** Total bytes in the web-version folder. */
function cacheSize() {
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
  go(WEB_ROOT);
  return total;
}

/**
 * Delete every web version that can be rebuilt. One whose original was removed
 * after seeding is the only copy left, so it stays.
 */
function clearWebVersions() {
  if (current) current.proc.kill('SIGKILL');
  for (const r of rows.all()) if (!r.original_removed_at) removeWebVersion(r.kind, r.item_id);
  db.prepare("UPDATE media_files SET web_state = 'none', web_progress = 0, web_error = NULL WHERE original_removed_at IS NULL").run();
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
  const out = path.join(dir, `${subId}.${version}.vtt`);
  if (fs.existsSync(out)) return out;
  for (const n of fs.readdirSync(dir)) {
    if (n.startsWith(`${subId}.`) && n.endsWith('.vtt')) fs.rmSync(path.join(dir, n), { force: true });
  }

  const tmp = `${out}.${process.pid}.tmp`;
  if (sub.source === 'file' && ['srt', 'vtt'].includes(sub.format)) {
    const cues = subText.parse(subText.decode(fs.readFileSync(sub.file)));
    fs.writeFileSync(tmp, subText.toVtt(cues));
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
  record, locate, indexPass, enqueue, startWorker, buildEncodeArgs, pickEncoder, webDir,
  hlsPlayable, hlsEntry, hlsComplete, webHasAllAudio, audioRenditions, masterPlaylist, webBandwidth, cacheSize, clearWebVersions, removeWebVersion, listSubtitles, vttFor, prewarmSubtitles, cachedVtt,
  videoFilesIn, subsDir,
  normLang, langFromName, wantedLanguages, searchDisk, queue: () => rows.queue(),
};
