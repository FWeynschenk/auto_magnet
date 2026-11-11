'use strict';

const { torrentRef, lowerHash } = require('./torrentref');

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
const media = require('./media');
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

// ─── Subtitle retries ─────────────────────────────────────────────────────────
//
// Subtitles for something that has just come out often appear a day or more
// later. A search that found nothing ('unavailable') is repeated at each of
// these points after the download completed. A point that passed while the
// server was down is caught up once, not once per missed point.

const HOUR = 3600_000;
const CATCH_UP_HOURS = 48;

function retryHours() {
  return String(settings.get('subtitle_retry_hours') ?? '')
    .split(/[\s,]+/).map(Number).filter(h => Number.isFinite(h) && h > 0).sort((a, b) => a - b);
}

/** The last schedule point that has passed, in ms since completion, or null. */
function lastPoint(row, now, hours) {
  const done = Date.parse(row.completed_at);
  if (!Number.isFinite(done)) return null;
  const passed = hours.filter(h => now - done >= h * HOUR);
  return passed.length ? done + passed.at(-1) * HOUR : null;
}

/** Whether a search that found nothing is due to be repeated now. */
function subsRetryDue(row, now = Date.now(), hours = retryHours()) {
  if (row.subs_state !== 'unavailable') return false;
  const point = lastPoint(row, now, hours);
  if (point === null) return false;
  // Catch-up is for a server that was down at the time, not for the back
  // catalogue: an item well past its last point is left alone, so the first
  // run after an upgrade doesn't spend the day's downloads on old searches.
  if (now - point > CATCH_UP_HOURS * HOUR && point === Date.parse(row.completed_at) + hours.at(-1) * HOUR) return false;
  const last = Date.parse(row.subs_checked_at || row.post_processed_at || row.completed_at);
  return !Number.isFinite(last) || last < point;
}

/** Whether any retry is still to come (due now, or scheduled later). */
function subsRetryPending(row, now = Date.now(), hours = retryHours()) {
  if (row.subs_state !== 'unavailable' || hours.length === 0) return false;
  const done = Date.parse(row.completed_at);
  if (!Number.isFinite(done)) return false;
  return now - done < hours.at(-1) * HOUR || subsRetryDue(row, now, hours);
}

/** "in 11h" / "in 3 days" until the next retry, or null when none are left. */
function nextRetryIn(row, now = Date.now(), hours = retryHours()) {
  const done = Date.parse(row.completed_at);
  const next = hours.map(h => done + h * HOUR).find(t => t > now);
  if (!Number.isFinite(next)) return null;
  const h = Math.ceil((next - now) / HOUR);
  return h >= 48 ? `in ${Math.round(h / 24)} days` : `in ${h}h`;
}

/** An unusable download: replace it where that is safe, flag it where it isn't. */
async function handleUnusable(group, entry, reason, target) {
  const canReplace = settings.get('postprocess_action') !== 'flag'
                  && group.rows.length === 1
                  && entry.row.torrent_origin === 'added';

  if (canReplace) {
    try { await tx.purgeTorrent(torrentRef(entry.row), target); } catch (_) {}
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
    const subsync = require('./subsync');
    const r = await subsync.syncFile(videoPath, subPath, { streamIndex: audio?.index ?? null });
    log.info(r.applied ? `subtitles aligned to the audio: ${subsync.describe(r)}` : `subtitles not re-timed: ${r.reason}`,
      { type: entry.kind, id: entry.id });
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
/**
 * One pass at a time. The minute progress sync and the hourly run can both
 * ask; two passes at once would check the same download twice — two subtitle
 * downloads from the day's quota, two writers to the same .srt. A second caller
 * joins the pass already running.
 */
let passInFlight = null;
function postProcessCompleted(opts = {}) {
  passInFlight ??= postProcessPass(opts).finally(() => { passInFlight = null; });
  return passInFlight;
}

// Someone opened an item that has no subtitles yet: look again now, rather than
// at the next scheduled retry. Subtitles for a new episode often appear within
// hours of it airing — after the first search, before the next. At most once
// per ASK_AGAIN_MS per item; searches are free, only downloads count against
// the day's quota.
const ASK_AGAIN_MS = 15 * 60_000;
const askedNow = new Set();

/** Returns true when a search was started. */
function searchSubsNow(kind, id, row) {
  if (!row || row.subs_state !== 'unavailable' || !row.post_processed_at) return false;
  if (!subtitles.configured() || subtitles.quotaExhausted()) return false;
  const last = Date.parse(row.subs_checked_at || row.post_processed_at);
  if (Number.isFinite(last) && Date.now() - last < ASK_AGAIN_MS) return false;
  askedNow.add(`${kind}:${id}`);
  // A pass already running didn't pick this one up: run another after it.
  (passInFlight || Promise.resolve()).catch(() => {})
    .then(() => postProcessCompleted())
    .catch(err => log.warn(`subtitle search on open failed: ${err.message}`, { type: kind, id }))
    .finally(() => askedNow.delete(`${kind}:${id}`));
  return true;
}

async function postProcessPass({ limit = 25 } = {}) {
  if (settings.get('postprocess_enabled') === '0') return;
  const wanted = wantedLanguages();

  // Searches that found nothing come back only when their retry is due.
  const now0 = Date.now(), hours = retryHours();
  const due = [
    ...movies.needingPostProcess().map(r => ({ kind: 'movie',   id: r.id, row: r, target: r.transmission_target || DEFAULT })),
    ...episodes.needingPostProcess().map(r => ({ kind: 'episode', id: r.id, row: r, target: r.show_target || DEFAULT })),
  ].filter(d => d.row.subs_state !== 'unavailable' || !d.row.post_processed_at
      || askedNow.has(`${d.kind}:${d.id}`) || subsRetryDue(d.row, now0, hours))
    .sort((a, b) => askedNow.has(`${b.kind}:${b.id}`) - askedNow.has(`${a.kind}:${a.id}`))   // asked for first
    .slice(0, limit);
  if (due.length === 0) return;

  const groups = new Map();
  for (const d of due) {
    // By hash where known: an id may have been handed to another torrent
    // since (Transmission renumbers its torrents when it restarts).
    const ref = torrentRef(d.row);
    const key = `${d.target}:${ref}`;
    if (!groups.has(key)) groups.set(key, { target: d.target, torrentId: ref, rows: [] });
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
        // Removed from Transmission since — nothing left to check. A retry
        // counts as made, so it isn't attempted again every pass.
        store.update(entry.id, { post_processed_at: now, subs_state: entry.row.subs_state || 'missing', subs_checked_at: now });
        continue;
      }

      const item = media.itemFor(entry.kind, entry.id);
      const file = item && media.pickFile(info.files, item, { dir: info.downloadDir, trusted: !!entry.row.torrent_hash });
      if (!file) {
        if (media.videoFilesIn(info.files).length === 0) {
          await handleUnusable(group, entry, 'the torrent contains no video file', target);
          continue;
        }
        // Videos, but none of them this item's: this isn't its torrent — an
        // id Transmission gave to another torrent after a restart. Never
        // judge (or delete) that torrent; find the item's own.
        await require('./relink').relinkItem(entry.kind, entry.id, { reason: `torrent ${group.torrentId} turned out to be "${info.name}"` });
        continue;
      }
      // Recorded before hashes were kept, and its torrent's files name it:
      // follow it by hash from now on.
      if (!entry.row.torrent_hash && info.hash) store.update(entry.id, { torrent_hash: info.hash, torrent_id: info.id });

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
      const retry = entry.row.subs_state === 'unavailable';
      const onOpen = askedNow.has(`${entry.kind}:${entry.id}`);
      const state = await fetchSubtitles(entry, local, info, wanted);
      const update = { subs_state: state, subs_checked_at: new Date().toISOString() };
      const next = state === 'unavailable' ? nextRetryIn(entry.row) : null;
      if (state === 'unavailable') {
        update.last_error = `No ${LANG_NAMES[wanted[0]] || wanted[0]} subtitles found on OpenSubtitles`
          + (next ? ` — trying again ${next}` : '');
      }
      store.update(entry.id, update);
      if (retry && state === 'fetched') log.info(`subtitles found on a later try${onOpen ? ' (looked again when it was opened)' : ''}`, { type: entry.kind, id: entry.id });
      else if (onOpen && state === 'unavailable') { /* looked again on opening: nothing yet, nothing to say */ }
      else if (retry && state === 'unavailable') {
        log.info(`subtitle retry: still none${next ? `, trying again ${next}` : ' — no more retries'}`, { type: entry.kind, id: entry.id });
      }
    }
  }
}

module.exports = {
  postProcessCompleted, assess, probe, pickFile, hasSidecarSubs, mapPath,
  subsRetryDue, subsRetryPending, nextRetryIn, retryHours, searchSubsNow,
};
