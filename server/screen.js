'use strict';

// Content screening for torrents.
//
// The torrent *title* tells you almost nothing about safety — nobody shipping
// malware names their release "Movie.exe". What matters is the file list. This
// module screens the actual contents, and is used from three places:
//   * search time, when we hold the .torrent bytes and can parse the file list
//   * add time, for magnet-only results, where Transmission fetches the metadata
//     for us and we inspect before letting the download start
//   * re-screen time, in the background, once a magnet's metadata finally lands
//
// Every rejection returns a human-readable reason so it can be logged, stored on
// the item, and shown in the UI.

const { settings } = require('./db');

// Real executable / script payloads. Nothing legitimate in a movie or TV
// release is ever one of these.
//
// Files are judged on their *final* extension, not on a substring match. A
// pattern that fires anywhere in the name rejects "RARBG.com.url" (.com) and
// "The.Batman.mkv" (.bat) — release spam and ordinary films — which is how an
// over-eager malware filter ends up blocking everything.
const EXECUTABLE_EXTS = new Set([
  'exe', 'bat', 'cmd', 'scr', 'msi', 'msix', 'appx', 'pif', 'com', 'cpl', 'msc',
  'vbs', 'vbe', 'vb', 'js', 'jse', 'wsf', 'wsc', 'wsh', 'ps1', 'psm1', 'ps1xml',
  'sct', 'hta', 'chm', 'lnk', 'scf', 'dll', 'ocx', 'sys', 'drv', 'inf', 'reg',
  'jar', 'apk', 'app', 'dmg', 'pkg', 'deb', 'rpm', 'run', 'sh', 'bash', 'zsh',
  'settingcontent-ms', 'appref-ms', 'desktopthemepackfile', 'gadget',
]);

/**
 * Executable extension in a *title*. Titles have no reliable final extension,
 * so only unambiguous ones are listed here — a release named "...RARBG.com"
 * must not be mistaken for a DOS executable. File-list screening is the real
 * defence; this only catches the rare release that advertises its payload.
 */
const EXECUTABLE_RE =
  /\.(exe|msi|msix|scr|bat|cmd|pif|vbs|vbe|jse|wsf|hta|lnk|jar|apk|dmg|pkg|apk)(?=[\s.\-_\])}]|$)/i;

// Disc images. Legitimate for a full BluRay/DVD rip, but also an easy wrapper
// for an executable payload, so they are gated behind a setting.
const DISC_EXTS = new Set(['iso', 'img', 'nrg', 'mdf', 'cue', 'bin']);

// Link / shortcut files. Ubiquitous release spam ("RARBG.com.url"), so these are
// noise rather than payload — judged by context below, not blocked outright.
const LINKFILE_EXTS = new Set(['url', 'website', 'webloc']);

const VIDEO_RE   = /\.(mkv|mp4|avi|m4v|mov|wmv|flv|webm|mpg|mpeg|m2ts|ts|vob|ogm|divx|rmvb)(?=[\s.\-_\])}]|$)/i;
// zipx, xz, zst and friends matter: a 1.2 GB .zipx posing as a Rings of Power
// episode sat undetected because the list stopped at the common formats.
const ARCHIVE_RE = /\.(rar|zipx?|7z|tar|t?gz|bz2|t?xz|zst|lz|lzh|lzma|cab|arj|ace|r\d{2}|z\d{2}|part\d+)(?=[\s.\-_\])}]|$)/i;

// Formats that describe a release: text, subtitles, images, checksums. Any of
// them measured in hundreds of megabytes is not what its extension claims.
const SIDECAR_RE = /\.(txt|nfo|srt|sub|idx|ass|ssa|vtt|jpe?g|png|gif|bmp|sfv|md5|sha1|sha256|xml|url|html?)(?=[\s.\-_\])}]|$)/i;
const SIDECAR_MAX_BYTES = 50 * 1024 * 1024;

// Text files whose name suggests an archive password — a long-standing pattern
// for getting a user to hand-extract a payload past automated scanning.
const PASSWORD_HINT_RE = /(?:^|[\/\s._-])(?:password|passwort|pass|senha|contrase|how[\s._-]*to|instruction|readme|leia[\s._-]*me|unlock|decrypt)/i;

// Directory names that only ever appear around cracked software, never around a
// film. A "movie" release shipping a Crack/ folder is a software dropper.
const SUSPICIOUS_DIR_RE =
  /(?:^|[\/\\])(?:crack|keygen|kegen|patch(?:er)?|activat(?:or|ion)|serial|licen[cs]e|setup|install(?:er)?|loader|reg(?:istry)?fix)(?:[\/\\]|$)/i;

/** Fraction of total bytes the main video file must account for. */
const MIN_VIDEO_RATIO = 0.5;

/** Below this, a stray file is release spam rather than a payload. */
const NOISE_BYTES = 64 * 1024;

function basename(path) {
  const parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

/** Final extension of a path, lowercased, without the dot. */
function ext(path) {
  const m = basename(path).match(/\.([A-Za-z0-9-]{1,24})$/);
  return m ? m[1].toLowerCase() : '';
}

const isExecutable = (path) => EXECUTABLE_EXTS.has(ext(path));
const isDisc       = (path) => DISC_EXTS.has(ext(path));
const isLinkFile   = (path) => LINKFILE_EXTS.has(ext(path));

function dirname(path) {
  const parts = String(path).split(/[\\/]/);
  parts.pop();
  return parts.join('/');
}

/** True when a filename has a video extension immediately before another one. */
function isDoubleExtension(path) {
  const m = /\.(mkv|mp4|avi|m4v|mov|wmv|webm|mpg|mpeg)\.([A-Za-z0-9]{1,6})$/i.exec(path);
  // A sidecar describing the video is not a disguise. "Film.mkv.nfo" is how
  // UIndex ships every release, and flagging it rejected them all — including
  // an 11 GB 2160p episode, over a zero-byte text file. Executables named this
  // way are already caught by the extension rule above.
  return !!m && !SIDECAR_EXTS.has(m[2].toLowerCase());
}

/**
 * The only executables allowed through, and only when both the name and the
 * size fit. RARBG shipped a 99-byte RARBG_DO_NOT_MIRROR.exe in every release;
 * rejecting it failed the entire RARBG back catalogue (61 torrents on this box).
 * Matching the name alone would not do — a 1 GB payload can call itself
 * anything — so the size has to be too small to hold one, and known.
 */
const HARMLESS_MARKERS = [/^RARBG_DO_NOT_MIRROR\.exe$/i];
const MARKER_MAX_BYTES = 1024;

function isHarmlessMarker(f) {
  if (f.length === 0) return true;  // an empty file executes nothing
  return typeof f.length === 'number'
      && f.length <= MARKER_MAX_BYTES
      && HARMLESS_MARKERS.some(re => re.test(basename(f.path)));
}

/** Files that describe a video rather than impersonate one. */
const SIDECAR_EXTS = new Set([
  'nfo', 'txt', 'srt', 'sub', 'idx', 'ass', 'ssa', 'vtt', 'sup',
  'jpg', 'jpeg', 'png', 'sfv', 'md5', 'sha1', 'sha256', 'xml', 'torrent',
]);

function reject(reason) {
  return { ok: false, reason };
}

/**
 * Screen a parsed file list.
 *
 * @param {Array}  files  [{ path, length }]
 * @param {Object} opts
 * @param {string} opts.type  'movie' | 'show'
 * @returns {{ ok: boolean, reason?: string, warnings?: string[] }}
 */
function screenFiles(files, { type = 'movie', allowPacks = false } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: true }; // nothing to judge — other filters still apply
  }

  const named    = files.filter(f => f.path);
  const warnings = [];
  const total    = named.reduce((s, f) => s + (f.length || 0), 0);
  const videos   = named.filter(f => VIDEO_RE.test(f.path));
  const archives = named.filter(f => ARCHIVE_RE.test(f.path));
  const discs    = named.filter(f => isDisc(f.path));
  const allowDiscImages = settings.get('allow_disc_images') === '1';

  // 1. Any executable or script payload is an immediate reject. This is the
  //    headline rule: a film never needs to ship a program.
  for (const f of named) {
    if (isExecutable(f.path) && !isHarmlessMarker(f)) {
      return reject(`contains executable file "${basename(f.path)}"`);
    }
  }

  // 2. Disc images, unless explicitly allowed — an .iso hides its own contents.
  if (discs.length > 0 && !allowDiscImages) {
    return reject(`contains disc image "${basename(discs[0].path)}" (enable "allow disc images" to permit)`);
  }

  // 3. Video file masquerading with a second extension (Movie.mp4.exe style).
  for (const f of named) {
    if (isDoubleExtension(f.path)) {
      return reject(`double extension on "${basename(f.path)}"`);
    }
  }

  // 4. Cracked-software folder structure inside what claims to be a film.
  for (const f of named) {
    if (SUSPICIOUS_DIR_RE.test(f.path)) {
      return reject(`contains a "${dirname(f.path) || basename(f.path)}" folder`);
    }
  }

  // 5. Archive plus a password/instructions file — a hand-extract dropper. The
  //    whole point of that pattern is to get the payload past exactly this check.
  if (archives.length > 0) {
    const hint = named.find(f =>
      /\.(txt|nfo|url|html?|rtf|doc|docx)$/i.test(f.path) && PASSWORD_HINT_RE.test(f.path));
    if (hint) {
      return reject(`archive paired with "${basename(hint.path)}"`);
    }
  }

  // 5b. A "text file" of several gigabytes is a renamed payload. This one sat
  //     beside a 3 MB stub .mkv as "Torrent Downloaded From UIndex.org .txt" —
  //     4.3 GB of it. The size ratio rule happened to catch that case, but in a
  //     pack full of real episodes it would have slipped under the ratio.
  for (const f of named) {
    if (SIDECAR_RE.test(basename(f.path)) && (f.length || 0) > SIDECAR_MAX_BYTES) {
      return reject(`"${basename(f.path)}" is ${Math.round(f.length / 1024 / 1024)} MB — too large to be what its extension says`);
    }
  }

  // 6. A link file with no video next to it is pure adware bait.
  if (videos.length === 0 && archives.length === 0 && named.some(f => isLinkFile(f.path))) {
    return reject('contains only link files, no media');
  }

  // 7. The payload should actually be video. Skip when sizes are unknown.
  if (total > 0) {
    if (videos.length === 0) {
      // No video at all. This used to let archive-only releases through with a
      // warning, as a concession to old scene RAR sets. It doesn't hold here:
      // nothing extracts archives, so one delivers nothing playable — and its
      // contents can't be screened. That combination is the dropper pattern; a
      // lone 1.2 GB .zipx posing as a Rings of Power episode was exactly this.
      if (archives.length > 0) {
        return reject(`contains only an archive ("${basename(archives[0].path)}") — nothing playable, and its contents can't be checked`);
      }
      if (discs.length === 0) {
        return reject('contains no video files');
      }
    } else {
      const videoBytes = videos.reduce((s, f) => s + (f.length || 0), 0);
      const ratio = videoBytes / total;
      if (ratio < MIN_VIDEO_RATIO && archives.length === 0) {
        return reject(`video is only ${Math.round(ratio * 100)}% of total size`);
      }

      // A "1080p movie" whose largest video file is tiny is a fake or a dropper.
      const largest  = Math.max(...videos.map(f => f.length || 0));
      const minBytes = parseInt(settings.get('min_size_mb') || '200') * 1024 * 1024;
      const floor    = type === 'movie' ? minBytes : Math.min(minBytes, 50 * 1024 * 1024);
      if (largest > 0 && largest < floor) {
        return reject(`largest video file is only ${Math.round(largest / 1024 / 1024)} MB`);
      }
    }
  }

  // 8. Suspicious file count: a single-episode grab shipping dozens of videos is
  //    a mislabelled pack, not the episode that was asked for. Skipped when a
  //    pack is what was actually being looked for.
  if (type === 'show' && !allowPacks) {
    const videoCount = videos.filter(f => (f.length || 0) > 50 * 1024 * 1024).length;
    if (videoCount > 3) {
      return reject(`looks like a pack (${videoCount} video files)`);
    }
  }

  // 9. Sheer file count — a film is not 400 files. A complete series of a
  //    long-running show legitimately is, so the ceiling lifts for packs.
  const fileCeiling = allowPacks ? 5000 : 300;
  if (named.length > fileCeiling) {
    return reject(`${named.length} files — not a single release`);
  }

  // Non-fatal noise worth surfacing but not worth losing a good release over.
  const spam = named.filter(f => isLinkFile(f.path) && (f.length || 0) <= NOISE_BYTES);
  if (spam.length > 0) warnings.push(`${spam.length} link/spam file(s)`);

  return warnings.length > 0 ? { ok: true, warnings } : { ok: true };
}

module.exports = {
  screenFiles,
  EXECUTABLE_RE, VIDEO_RE, ARCHIVE_RE,
  EXECUTABLE_EXTS, DISC_EXTS, LINKFILE_EXTS,
};
