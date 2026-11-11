'use strict';

// Is this file really this item's?
//
// Every link from a library item to a file on disk passes through here. The
// link used to be taken on trust — "torrent 57's only video is this episode" —
// and torrent 57 is only a number Transmission hands out for the session: it
// renumbers its torrents on every restart, so after a reboot 57 can be another
// show altogether. The episode was then recorded as that show's file, and
// played it ever after.
//
// The answer here comes from the names, the same way a person would check:
//
//   episode  the file (or its folder) carries this season and episode, and
//            the show's name as the release writes it — before the S01E02
//            marker — is this show's, by the same rules the selector uses to
//            pick releases (own words, own year/country, learned variants).
//            The show folder it was downloaded into counts too.
//   movie    a file or folder name with the film's title, and its year when
//            the name carries one.
//
// Three answers: 'yes', 'no' (the names point elsewhere), and 'unknown' (names
// that say nothing either way, like "S01E02.mkv" in a folder called "tmp").
// Picking a file from a torrent wants 'yes' — or 'unknown' when the torrent is
// known by its hash and so certainly the item's own. Repairing the library
// only ever drops a 'no'.

const path = require('path');
const { normalizeTitle, titleMatchRatio, showPartOf, extraShowWords } = require('./selector');
const { sanitizeFolderName } = require('./paths');

const EP_RE = (s, e) => new RegExp(`(?:S0*${s}[\\s._-]?E0*${e}(?!\\d))|(?:(?<!\\d)${s}x0*${e}(?!\\d))`, 'i');
const ANY_EP_RE = /(?:S\d{1,2}[\s._-]?E\d{1,3})|(?:(?<!\d)\d{1,2}x\d{2,3}(?!\d))/i;
// S01E02, and the double/multi-episode forms S01E01E02, S01E01-E02, S01E01-02.
// A "-720p" after the marker is a resolution, not an episode.
const EP_RUN_RE = /S(\d{1,2})[\s._-]?E(\d{1,3})((?:[\s._]?(?:-E?|E)\d{1,3}(?![\dp]))*)/gi;

/** Whether a name carries this season and episode, alone or within a multi-episode run. */
function namesEpisode(name, s, e) {
  if (EP_RE(s, e).test(name)) return true;
  for (const m of String(name).matchAll(EP_RUN_RE)) {
    if (Number(m[1]) !== Number(s)) continue;
    const nums = [Number(m[2]), ...(m[3].match(/\d{1,3}/g) || []).map(Number)];
    const lo = Math.min(...nums), hi = Math.max(...nums);
    if (hi - lo <= 5 && e >= lo && e <= hi) return true;
  }
  return false;
}
const stripExt = (n) => n.replace(/\.[A-Za-z0-9]{2,4}$/, '');

function wantFor(show) {
  let variants = [];
  try { variants = require('./shownames').accepted(show); } catch (_) {}
  return {
    title: show.title,
    originalTitle: show.original_title || null,
    firstAirYear: show.first_air_year || null,
    countries: String(show.origin_country || '').split(',').filter(Boolean),
    variants,
  };
}

/**
 * What one name says about the show: 'yes', 'no' or null (nothing).
 * A release name ("Show.Name.S01E02…") is judged on the part before its
 * marker; a plain folder name ("Show Name") as a whole.
 */
function nameSaysShow(name, show, want = wantFor(show)) {
  const part = showPartOf(name);
  if (part) {
    if (want.variants.includes(part)) return 'yes';
    if (extraShowWords(name, want).length) return 'no';
    const ratio = Math.max(titleMatchRatio(part, want.title), want.originalTitle ? titleMatchRatio(part, want.originalTitle) : 0);
    return ratio >= 0.6 ? 'yes' : 'no';
  }
  // No episode marker: a folder named after the show, the way downloads are filed.
  const n = normalizeTitle(name);
  if (!n) return null;
  if (sanitizeFolderName(name).toLowerCase() === sanitizeFolderName(show.title).toLowerCase()) return 'yes';
  if (n === normalizeTitle(show.title) || (want.originalTitle && n === normalizeTitle(want.originalTitle))) return 'yes';
  return null;
}

/** The folders above a file that may still say something: at most three, never a library root or above. */
function folders(filePath, roots) {
  const out = [];
  let d = path.dirname(filePath);
  for (let i = 0; i < 3 && d && d !== path.dirname(d); i++) {
    if (roots.some(r => path.resolve(r) === path.resolve(d))) break;
    out.push(path.basename(d));
    d = path.dirname(d);
  }
  return out;
}

function episodeBelongs(item, filePath, roots) {
  const base = stripExt(path.basename(filePath));
  const dirs = folders(filePath, roots);
  const { season, episode } = item.row;
  // The episode marker: in the file name, or — for an obfuscated file inside
  // a release folder — in that folder's name. A different marker is a no.
  if (!namesEpisode(base, season, episode)) {
    if (ANY_EP_RE.test(base)) return 'no';
    if (!dirs[0] || !namesEpisode(dirs[0], season, episode)) return 'unknown';
  }
  // Inside this show's own folder — where auto_magnet files its downloads —
  // it is this show's, however the release spelled the name (a hand-picked
  // anime or foreign title). The mix-ups this guards against had the file in
  // the *other* show's folder.
  const showFolder = sanitizeFolderName(item.show.title).toLowerCase();
  if (dirs.some(d => sanitizeFolderName(d).toLowerCase() === showFolder)) return 'yes';
  const want = wantFor(item.show);
  let yes = false;
  for (const name of [base, ...dirs]) {
    const said = nameSaysShow(name, item.show, want);
    if (said === 'no') return 'no';
    if (said === 'yes') yes = true;
  }
  return yes ? 'yes' : 'unknown';
}

function yearsIn(name, title) {
  const own = new Set((normalizeTitle(title).match(/\b(?:19|20)\d{2}\b/g) || []));
  return (normalizeTitle(name).match(/\b(?:19|20)\d{2}\b/g) || []).filter(y => !own.has(y)).map(Number);
}

/**
 * Films are named loosely ("Star.Wars.1977" for "Star Wars: Episode IV – A
 * New Hope"), so a short title alone never counts against a file. What does:
 * a year that isn't this film's (Dune 1984 for Dune 2021, The Matrix 1999
 * for Reloaded), or a release-style name sharing none of its words.
 */
function movieBelongs(item, filePath, roots) {
  const titles = [item.title, item.row?.original_title].filter(Boolean);
  const names = [stripExt(path.basename(filePath)), ...folders(filePath, roots)];
  let yes = false, no = false;
  for (const name of names) {
    const ratio = Math.max(...titles.map(t => titleMatchRatio(name, t)));
    const years = yearsIn(name, item.title);
    const yearOk = !item.year || !years.length || years.some(y => Math.abs(y - item.year) <= 1);
    if (ratio >= 0.8 && yearOk) yes = true;
    else if (years.length && (!yearOk || ratio === 0)) no = true;
  }
  return yes ? 'yes' : no ? 'no' : 'unknown';
}

/**
 * Whether `filePath` is this item's file.
 * @param item   media.itemFor() result
 * @param roots  library roots, so the movie and show folders themselves don't count as names
 * @returns {'yes'|'no'|'unknown'}
 */
function fileBelongsTo(item, filePath, roots = []) {
  if (!item || !filePath) return 'unknown';
  return item.kind === 'episode' ? episodeBelongs(item, filePath, roots) : movieBelongs(item, filePath, roots);
}

/**
 * A stable name for the item a file was recorded for. Database ids can be
 * handed out again once a show is removed; this can't — so a file recorded
 * for one episode can never be read back as another's.
 */
function itemKey(item) {
  if (!item) return null;
  if (item.kind === 'episode') {
    const s = item.show;
    return `episode:${s.tmdb_id ? `tmdb${s.tmdb_id}` : `show${s.id}:${normalizeTitle(s.title)}`}:${item.row.season}:${item.row.episode}`;
  }
  return `movie:${item.row.tmdb_id ? `tmdb${item.row.tmdb_id}` : `${normalizeTitle(item.title)}:${item.year || ''}`}`;
}

module.exports = { fileBelongsTo, itemKey, nameSaysShow, namesEpisode, EP_RE };
