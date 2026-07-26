'use strict';

// Content screening for torrents.
//
// The torrent *title* tells you almost nothing about safety — nobody shipping
// malware names their release "Movie.exe". What matters is the file list. This
// module screens the actual contents, and is used from two places:
//   * search time, when we hold the .torrent bytes and can parse the file list
//   * add time, for magnet-only results, where Transmission fetches the metadata
//     for us and we inspect before letting the download start
//
// Every rejection returns a human-readable reason so it can be logged and shown.

const { settings } = require('./db');

// Executable / script payloads. Anchored to an extension boundary so that
// "The.Batman" does not match ".bat" and "Series.Complete" does not match ".com".
const EXECUTABLE_RE =
  /\.(exe|bat|cmd|scr|msi|pif|vbs|vbe|js|jse|wsf|wsh|ps1|psm1|lnk|url|com|dll|jar|apk|app|dmg|pkg|deb|rpm|sh|bash|reg|hta|cpl|msc|inf|iso|img)(?=[\s.\-_\])}]|$)/i;

const VIDEO_RE   = /\.(mkv|mp4|avi|m4v|mov|wmv|flv|webm|mpg|mpeg|m2ts|ts|vob|ogm|divx|rmvb)(?=[\s.\-_\])}]|$)/i;
const ARCHIVE_RE = /\.(rar|zip|7z|tar|gz|bz2|r\d{2}|z\d{2}|part\d+)(?=[\s.\-_\])}]|$)/i;
const SUBS_RE    = /\.(srt|sub|idx|ass|ssa|sup|vtt|nfo|txt|jpg|jpeg|png|sfv|md5)(?=[\s.\-_\])}]|$)/i;

// Text files whose name suggests an archive password — a long-standing pattern
// for getting a user to hand-extract a payload past automated scanning.
const PASSWORD_HINT_RE = /(?:^|[\/\s._-])(?:password|passwort|pass|senha|contrase|how[\s._-]*to|instruction|readme|leia[\s._-]*me|unlock)/i;

/** Fraction of total bytes the main video file must account for. */
const MIN_VIDEO_RATIO = 0.5;

function ext(path) {
  const m = String(path).match(/\.[A-Za-z0-9]{1,6}$/);
  return m ? m[0].toLowerCase() : '';
}

function basename(path) {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

/** True when a filename has a video extension immediately before another one. */
function isDoubleExtension(path) {
  return /\.(mkv|mp4|avi|m4v|mov|wmv|webm|mpg|mpeg)\.[A-Za-z0-9]{1,6}$/i.test(path);
}

/**
 * Screen a parsed file list.
 *
 * @param {Array}  files  [{ path, length }]
 * @param {Object} opts
 * @param {string} opts.type  'movie' | 'show'
 * @returns {{ ok: boolean, reason?: string }}
 */
function screenFiles(files, { type = 'movie' } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: true }; // nothing to judge — other filters still apply
  }

  const named = files.filter(f => f.path);

  // 1. Any executable or script payload is an immediate reject.
  for (const f of named) {
    if (EXECUTABLE_RE.test(basename(f.path))) {
      return { ok: false, reason: `contains executable file "${basename(f.path)}"` };
    }
  }

  // 2. Video file masquerading with a second extension (Movie.mp4.exe style).
  for (const f of named) {
    if (isDoubleExtension(f.path)) {
      return { ok: false, reason: `double extension on "${basename(f.path)}"` };
    }
  }

  // 3. Archive plus a password/instructions text file — a hand-extract dropper.
  const archives = named.filter(f => ARCHIVE_RE.test(f.path));
  if (archives.length > 0) {
    const hint = named.find(f => /\.(txt|nfo|url|html?)$/i.test(f.path) && PASSWORD_HINT_RE.test(f.path));
    if (hint) {
      return { ok: false, reason: `archive paired with "${basename(hint.path)}"` };
    }
  }

  // 4. The payload should actually be video. Skip when sizes are unknown.
  const total = named.reduce((s, f) => s + (f.length || 0), 0);
  if (total > 0) {
    const videos = named.filter(f => VIDEO_RE.test(f.path));
    if (videos.length === 0) {
      // No video at all. Archives are legitimate for some scene releases, so only
      // reject when there is neither video nor archive content.
      if (archives.length === 0) {
        return { ok: false, reason: 'contains no video or archive files' };
      }
    } else {
      const videoBytes = videos.reduce((s, f) => s + (f.length || 0), 0);
      const ratio = videoBytes / total;
      if (ratio < MIN_VIDEO_RATIO && archives.length === 0) {
        return {
          ok: false,
          reason: `video is only ${Math.round(ratio * 100)}% of total size`,
        };
      }

      // A "1080p movie" whose largest video file is tiny is a fake or a dropper.
      const largest = Math.max(...videos.map(f => f.length || 0));
      const minBytes = parseInt(settings.get('min_size_mb') || '200') * 1024 * 1024;
      const floor = type === 'movie' ? minBytes : Math.min(minBytes, 50 * 1024 * 1024);
      if (largest > 0 && largest < floor) {
        return {
          ok: false,
          reason: `largest video file is only ${Math.round(largest / 1024 / 1024)} MB`,
        };
      }
    }
  }

  // 5. Suspicious file count: a single-episode grab shipping dozens of videos is
  //    a mislabelled pack, not the episode that was asked for.
  if (type === 'show') {
    const videoCount = named.filter(f => VIDEO_RE.test(f.path) && (f.length || 0) > 50 * 1024 * 1024).length;
    if (videoCount > 3) {
      return { ok: false, reason: `looks like a pack (${videoCount} video files)` };
    }
  }

  return { ok: true };
}

module.exports = { screenFiles, EXECUTABLE_RE, VIDEO_RE, ARCHIVE_RE };
