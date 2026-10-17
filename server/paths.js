'use strict';

// Where things go on disk.
//
// A show's folder used to be its TMDB title verbatim. Linux accepts almost any
// character in a name, so that worked on the server — but the library is shared
// over Samba, and Windows forbids  \ / : * ? " < > |  in a name and drops
// trailing dots and spaces. Samba shows such a folder to Windows clients under a
// generated stand-in like "A9VK1B~E" — which is what "Avatar: Seven Havens"
// looked like. Every show folder is now made safe for both.

const { settings } = require('./db');

// Names Windows reserves for devices; a folder called "Con" cannot be opened.
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * A folder name that Linux, Windows and Samba all show as-is.
 *
 *   "Avatar: Seven Havens"  → "Avatar - Seven Havens"   (as Sonarr's "smart" replace)
 *   "Re:Zero"               → "Re-Zero"
 *   "Love/Hate"             → "Love-Hate"                 (a slash would make a subfolder)
 *   'The "Real" Story'      → "The 'Real' Story"
 *   "What If...?"           → "What If"                   (Windows drops trailing dots)
 */
function sanitizeFolderName(name) {
  let s = String(name ?? '').normalize('NFC');
  s = s.replace(/\s*:\s+/g, ' - ')        // "Title: Subtitle"
       .replace(/:/g, '-')                 // "Re:Zero"
       .replace(/[\\/]/g, '-')
       .replace(/"/g, "'")
       .replace(/[*?<>|]/g, '')
       .replace(/[\u0000-\u001f\u007f]/g, '')
       .replace(/\s+/g, ' ')
       .trim()
       .replace(/[. ]+$/, '');
  if (!s || /^\.+$/.test(s)) s = 'Untitled';
  if (RESERVED.test(s)) s += '_';
  return s;
}

/** Where a show's episodes are downloaded to. */
function showDir(show) {
  return `${settings.get('shows_path')}/${sanitizeFolderName(show.title)}`;
}

/** Translate a path as Transmission reports it into one this process can open. */
function mapPath(p) {
  for (const pair of (settings.get('media_path_map') || '').split(';')) {
    const [from, to] = pair.split('=>').map(s => s && s.trim());
    // A whole-segment match only: "/HDD0/Shared" must not rewrite "/HDD0/SharedOther".
    if (from && to && (p === from || p.startsWith(from.replace(/\/+$/, '') + '/'))) {
      return to.replace(/\/+$/, '') + p.slice(from.replace(/\/+$/, '').length);
    }
  }
  return p;
}

module.exports = { sanitizeFolderName, showDir, mapPath };
