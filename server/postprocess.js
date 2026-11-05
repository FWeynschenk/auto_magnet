'use strict';

// After a download completes: check what is actually inside the file, and
// make sure it has subtitles in the language you want.
//
// Screening judges file *names*. This reads the streams, which is the only way
// to catch what a name can't reveal — an audio track that is nothing but audio
// description, or a "video" with no video in it — and to know whether English
// subtitles are embedded before going to fetch some.
//
// Only downloads that complete after this code exists are touched (see
// completed_at). Deleting anything is limited to torrents auto_magnet added
// itself, one item each; everything else is flagged and left alone.

const fs   = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { movies, episodes, settings } = require('./db');
const tx  = require('./transmission');
const subtitles = require('./sources/opensubtitles');
const { recordVerdict } = require('./quarantine');
const log = require('./log');
const { mapPath } = require('./paths');

const FFPROBE   = process.env.FFPROBE_PATH || 'ffprobe';
const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|wmv|webm|mpg|mpeg|m2ts|ts)$/i;
const SUB_EXT   = /\.(srt|ass|ssa|vtt|sub)$/i;
const DEFAULT   = 'default';

// Same markers as the title rule in the selector, applied to a stream's title
// tag. Deliberately narrow: "SoundHandler", a common MP4 handler name, must not
// read as "AD".
const AD_TITLE_RE =
  /(?:^|[^a-z])(?:AD|DVS|audio[\s._-]?desc(?:ription|ribed)?|descri(?:bed|ptive)|visually[\s._-]impaired)(?:[^a-z]|$)/i;

// ffprobe reports ISO 639-2 codes; settings use the 2-letter ones.
const LANG_CODES = {
  en: ['en', 'eng'], nl: ['nl', 'nld', 'dut'], de: ['de', 'deu', 'ger'], fr: ['fr', 'fra', 'fre'],
  es: ['es', 'spa'], it: ['it', 'ita'], pt: ['pt', 'por'], sv: ['sv', 'swe'], da: ['da', 'dan'],
  no: ['no', 'nor', 'nob', 'nno'], fi: ['fi', 'fin'], pl: ['pl', 'pol'], ja: ['ja', 'jpn'],
};
const LANG_NAMES = {
  en: 'english', nl: 'dutch', de: 'german', fr: 'french', es: 'spanish', it: 'italian',
  pt: 'portuguese', sv: 'swedish', da: 'danish', no: 'norwegian', fi: 'finnish', pl: 'polish', ja: 'japanese',
};

function wantedLanguages() {
  return (settings.get('subtitle_languages') || 'en')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function langMatches(tag, wanted) {
  if (!tag) return false;
  const t = String(tag).toLowerCase();
  return wanted.some(w => (LANG_CODES[w] || [w]).includes(t));
}

/** A filename that names one of the wanted languages as a token. */
function nameHasLanguage(name, wanted) {
  return wanted.some(w => [...(LANG_CODES[w] || [w]), LANG_NAMES[w]].filter(Boolean)
    .some(code => new RegExp(`(?:^|[._\\s\\-\\[(])${code}(?:[._\\s\\-\\])]|$)`, 'i').test(name)));
}

// ─── Probing ──────────────────────────────────────────────────────────────────

function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', file],
      { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`ffprobe could not read the file: ${String(err.message).split('\n')[0]}`));
        try { resolve(JSON.parse(stdout).streams || []); }
        catch (_) { reject(new Error('ffprobe returned output that could not be parsed')); }
      });
  });
}

function isAudioDescription(stream) {
  const d = stream.disposition || {};
  const title = stream.tags?.title || '';
  return d.visual_impaired === 1 || d.descriptions === 1 || AD_TITLE_RE.test(title);
}

/**
 * Judge a probed file.
 * @returns {{ ok: boolean, reason?: string, embeddedSubs?: boolean }}
 */
function assess(streams, wanted) {
  const video = streams.filter(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.filter(s => s.codec_type === 'audio');
  const subs  = streams.filter(s => s.codec_type === 'subtitle');

  if (video.length === 0) return { ok: false, reason: 'the file contains no video' };
  if (audio.length === 0) return { ok: false, reason: 'the file has no audio' };
  if (audio.every(isAudioDescription)) {
    return { ok: false, reason: 'its only audio is audio description (narration for blind viewers)' };
  }

  // A forced track only covers foreign-language dialogue — it isn't subtitles
  // for the film. SDH (hearing impaired) tracks are full subtitles and count.
  const embeddedSubs = subs.some(s => langMatches(s.tags?.language, wanted) && !s.disposition?.forced);
  return { ok: true, embeddedSubs };
}

/**
 * Subtitle files already beside the video.
 *
 * A video dropped straight into a show folder shares it with every other
 * episode, so only files named after this video count there. A video inside
 * its own release folder may also rely on that folder's Subs/ directory.
 */
function hasSidecarSubs(videoPath, showDir, wanted) {
  const dir  = path.dirname(videoPath);
  const stem = path.basename(videoPath).replace(/\.[^.]+$/, '');
  const ownFolder = path.resolve(dir) !== path.resolve(showDir || '');

  const look = [[dir, true]];
  if (ownFolder) for (const sub of ['Subs', 'subs', 'Subtitles', 'subtitles']) look.push([path.join(dir, sub), false]);

  for (const [d, needsStem] of look) {
    let names;
    try { names = fs.readdirSync(d); } catch (_) { continue; }
    for (const n of names) {
      if (!SUB_EXT.test(n)) continue;
      if (needsStem && !n.startsWith(stem)) continue;
      if (nameHasLanguage(n, wanted)) return true;
    }
  }
  return false;
}

// ─── Paths ────────────────────────────────────────────────────────────────────


/** The video file within a torrent that belongs to this row. */
function pickFile(files, row, kind) {
  const videos = files.filter(f => VIDEO_EXT.test(f.name) && !/(?:^|[/\\._-])sample(?:[/\\._-]|$)/i.test(f.name));
  if (videos.length === 0) return null;
  if (kind === 'episode' && videos.length > 1) {
    const s = Number(row.season), e = Number(row.episode);
    const hit = videos.find(f => {
      const m = /S(\d{1,2})[\s._-]?E(\d{1,3})/i.exec(path.basename(f.name))
             || /\b(\d{1,2})x(\d{2,3})\b/.exec(path.basename(f.name));
      return m && Number(m[1]) === s && Number(m[2]) === e;
    });
    if (hit) return hit;
  }
  return videos.reduce((a, b) => (b.length > a.length ? b : a));
}

// ─── The pass ─────────────────────────────────────────────────────────────────

const storeFor = (kind) => (kind === 'movie' ? movies : episodes);

function hoursSince(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 3600000 : Infinity;
}

/** An unusable download: replace it where that is safe, flag it where it isn't. */
async function handleUnusable(group, entry, reason, target) {
  const canReplace = settings.get('postprocess_action') !== 'flag'
                  && group.rows.length === 1
                  && entry.row.torrent_origin === 'added';

  if (canReplace) {
    try { await tx.purgeTorrent(entry.row.torrent_id, target); } catch (_) {}
    recordVerdict([entry], { ok: false, reason }, { label: 'Replaced after the file check' });
    return;
  }

  const why = group.rows.length > 1 ? 'part of a pack'
            : entry.row.torrent_origin !== 'added' ? 'it was already in Transmission'
            : 'set to flag only';
  storeFor(entry.kind).update(entry.id, {
    post_processed_at: new Date().toISOString(),
    last_error: `File check failed: ${reason} — kept, not replaced (${why})`,
  });
  log.warn(`file check failed, kept (${why}): ${reason}`, { type: entry.kind, id: entry.id });
}

/** Fetch subtitles for one verified file. Returns the subs_state to record. */
async function fetchSubtitles(entry, localPath, info, wanted) {
  if (!subtitles.configured()) {
    storeFor(entry.kind).update(entry.id, {
      last_error: 'No subtitles in your language — add an OpenSubtitles API key in Settings to fetch them',
    });
    return 'missing';
  }

  // Today's downloads are spent: send nothing at all, searches included, and
  // say nothing — this runs on every pass until midnight UTC, and one line
  // when the quota ran out is enough.
  if (subtitles.quotaExhausted()) {
    storeFor(entry.kind).update(entry.id, {
      last_error: `Subtitles waiting — today's OpenSubtitles downloads are used up (resets ${subtitles.quotaResetsAt().toISOString().slice(11, 16)} UTC)`,
    });
    return 'pending';
  }

  const row = entry.row;
  const isEp = entry.kind === 'episode';
  let hash = null;
  try { hash = subtitles.movieHash(localPath); } catch (_) { /* unreadable ends — search by id */ }

  let best;
  try {
    best = await subtitles.findBest({
      hash,
      imdbId:  isEp ? row.show_imdb_id : row.imdb_id,
      tmdbId:  isEp ? row.show_tmdb_id : row.tmdb_id,
      season:  isEp ? row.season  : null,
      episode: isEp ? row.episode : null,
      language: wanted[0],
      torrentName: info.name,
    });
  } catch (err) {
    log.warn(`subtitle search failed, will retry: ${err.message}`, { type: entry.kind, id: entry.id });
    return 'pending';
  }

  if (!best) {
    storeFor(entry.kind).update(entry.id, {
      last_error: `No ${LANG_NAMES[wanted[0]] || wanted[0]} subtitles found on OpenSubtitles`,
    });
    return 'unavailable';
  }

  const dest = localPath.replace(/\.[^.]+$/, '') + `.${wanted[0]}.srt`;
  try {
    const { remaining } = await subtitles.download(best.item, dest);
    // Match the video's owner, so a Samba user who can delete the episode can
    // delete its subtitles too.
    try { const st = fs.statSync(localPath); fs.chownSync(dest, st.uid, st.gid); } catch (_) {}
    storeFor(entry.kind).update(entry.id, { last_error: null, subs_match: best.matchedBy || null });
    log.info(
      `subtitles fetched (matched by ${best.matchedBy}): ${path.basename(dest)}` +
      (typeof remaining === 'number' ? ` — ${remaining} download(s) left today` : ''),
      { type: entry.kind, id: entry.id },
    );
    await autoSync(entry, localPath, dest, best.matchedBy);
    return 'fetched';
  } catch (err) {
    if (err.quota) {
      log.warn(`${err.message}; the rest wait until ${subtitles.quotaResetsAt().toISOString().slice(11, 16)} UTC`);
      storeFor(entry.kind).update(entry.id, { last_error: "Subtitles waiting — today's OpenSubtitles downloads are used up" });
    } else {
      log.warn(`subtitle download failed, will retry: ${err.message}`, { type: entry.kind, id: entry.id });
    }
    return 'pending';
  }
}

/**
 * A subtitle matched by file hash was timed against this exact file. One
 * matched any other way was timed against *a* release of it, and is aligned
 * to the audio. Never fatal: an unaligned subtitle is still a subtitle.
 */
async function autoSync(entry, videoPath, subPath, matchedBy) {
  if (matchedBy === 'hash' || settings.get('subtitle_autosync') === '0') return;
  try {
    const { chooseAudio, probe: probeFull } = require('./media');
    const audio = chooseAudio((await probeFull(videoPath)).streams);
    const r = await require('./subsync').syncFile(videoPath, subPath, { streamIndex: audio?.index ?? null });
    log.info(r.applied
      ? `subtitles aligned to the audio: shifted ${(r.offsetMs / 1000).toFixed(2)}s${r.ratio !== 1 ? `, stretched ×${r.ratio.toFixed(4)}` : ''}`
      : `subtitles not re-timed: ${r.reason}`, { type: entry.kind, id: entry.id });
  } catch (err) {
    log.warn(`subtitle sync skipped: ${err.message}`, { type: entry.kind, id: entry.id });
  }
}

/** Make a checked file watchable: record it and queue its web version. */
async function recordForPlayback(entry, localPath) {
  try {
    await require('./media').record(entry.kind, entry.id, localPath);
  } catch (err) {
    log.warn(`could not add to the watch library: ${err.message}`, { type: entry.kind, id: entry.id });
  }
}

/**
 * Check every download that has completed since this feature existed and not
 * yet been checked, and retry any subtitle fetch left pending.
 */
async function postProcessCompleted({ limit = 25 } = {}) {
  if (settings.get('postprocess_enabled') === '0') return;
  const wanted = wantedLanguages();

  const due = [
    ...movies.needingPostProcess().map(r => ({ kind: 'movie',   id: r.id, row: r, target: r.transmission_target || DEFAULT })),
    ...episodes.needingPostProcess().map(r => ({ kind: 'episode', id: r.id, row: r, target: r.show_target || DEFAULT })),
  ].slice(0, limit);
  if (due.length === 0) return;

  const groups = new Map();
  for (const d of due) {
    const key = `${d.target}:${d.row.torrent_id}`;
    if (!groups.has(key)) groups.set(key, { target: d.target, torrentId: d.row.torrent_id, rows: [] });
    groups.get(key).rows.push(d);
  }

  for (const group of groups.values()) {
    const target = tx.resolveTarget(group.target);
    let info;
    try { info = await tx.getTorrentInfo(group.torrentId, target); } catch (_) { continue; }

    for (const entry of group.rows) {
      const store = storeFor(entry.kind);
      const now = new Date().toISOString();

      if (!info) {
        store.update(entry.id, { post_processed_at: now, subs_state: entry.row.subs_state || 'missing' });
        continue; // removed from Transmission since — nothing left to check
      }

      const file = pickFile(info.files, entry.row, entry.kind);
      if (!file) {
        await handleUnusable(group, entry, 'the torrent contains no video file', target);
        continue;
      }

      const local = mapPath(path.join(info.downloadDir, file.name));
      if (!fs.existsSync(local)) {
        // Transmission may still be renaming it from .part. Give it a day,
        // then say plainly why it was skipped rather than retrying forever.
        if (hoursSince(entry.row.completed_at) > 24) {
          store.update(entry.id, {
            post_processed_at: now,
            last_error: 'File check skipped: the file isn\'t reachable from auto_magnet — is the media folder mounted into the container?',
          });
        }
        continue;
      }

      // The probe runs once. A retry that is only about subtitles skips it.
      if (!entry.row.post_processed_at) {
        let verdict;
        try {
          verdict = assess(await probe(local), wanted);
        } catch (err) {
          store.update(entry.id, { post_processed_at: now, last_error: `File check skipped: ${err.message}` });
          continue;
        }
        if (!verdict.ok) {
          await handleUnusable(group, entry, verdict.reason, target);
          continue;
        }
        await recordForPlayback(entry, local);
        if (verdict.embeddedSubs) {
          store.update(entry.id, { post_processed_at: now, subs_state: 'present' });
          continue;
        }
        store.update(entry.id, { post_processed_at: now });
      }

      if (hasSidecarSubs(local, info.downloadDir, wanted)) {
        store.update(entry.id, { subs_state: 'present' });
        continue;
      }
      store.update(entry.id, { subs_state: await fetchSubtitles(entry, local, info, wanted) });
    }
  }
}

module.exports = { postProcessCompleted, assess, probe, pickFile, hasSidecarSubs, mapPath };
