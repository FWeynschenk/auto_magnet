'use strict';

const { settings } = require('./db');
const { screenFiles, EXECUTABLE_RE } = require('./screen');

// ─── Hard-reject lists ────────────────────────────────────────────────────────

/**
 * Executable extension appearing in a *title*. Anchored to an extension boundary:
 * an unanchored substring check rejects "The.Batman" (.bat), "Series.Complete"
 * (.com) and every indexer that prefixes titles with its own domain.
 * The real defence is file-list screening in screen.js — this only catches the
 * rare release that advertises a payload in its name.
 */
const MALWARE_TITLE_RE = EXECUTABLE_RE;

/**
 * CAM / pre-release sources that are always rejected.
 * TS and CAM use separator context ([.\-_[\s]) to avoid false positives
 * in regular title words like "CAMDEN" or "ITS".
 */
const LOW_QUALITY_SOURCES = [
  /\bTELESYNC\b/i,
  /\bHDTS\b/i,
  /\bHDCAM\b/i,
  /\bCAMRIP\b/i,
  /\bDVDSCR(?:EENER)?\b/i,
  /\bSCREENER\b/i,
  /(?:^|[.\-_[\s])TS(?:[.\-_\]\s]|$)/i,  // .TS. / [TS] etc — TELESYNC shorthand
  /(?:^|[.\-_[\s])CAM(?:[.\-_\]\s]|$)/i, // .CAM. / [CAM] etc
  /(?:^|[.\-_[\s])R5(?:[.\-_\]\s]|$)/i,  // .R5. — Russian DVD pre-release
];

/**
 * Foreign-language tokens that indicate a non-English dub/sub release.
 * Penalised rather than hard-blocked so a foreign user can still get results.
 */
const FOREIGN_LANG_RE =
  /\b(?:FRENCH|GERMAN|DEUTSCH|SPANISH|HINDI|ITALIAN|PORTUGUESE|DUTCH|VOSTFR|TRUEFRENCH|ARABIC|TURKISH|RUSSIAN|KOREAN|CHINESE|JAPANESE)\b/i;

// ─── Quality detection ────────────────────────────────────────────────────────

const QUALITY_PATTERNS = [
  { pattern: /2160p|4k\b|uhd\b/i, label: '2160p', bonus: 40 },
  { pattern: /1080p/i,             label: '1080p', bonus: 30 },
  { pattern: /720p/i,              label: '720p',  bonus: 10 },
];

// ─── Source-type scoring ──────────────────────────────────────────────────────

const SOURCE_BONUSES = [
  { pattern: /\bWEB[-.]?DL\b/i,              bonus: 25 },
  { pattern: /\bWEBRIP\b/i,                  bonus: 15 },
  { pattern: /\b(?:BLURAY|BDR(?:IP)?)\b/i,  bonus: 10 },
  { pattern: /\bHDTV\b/i,                    bonus:  5 },
  // DVDRip: 0 — baseline
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTrustedGroups(type) {
  const key = type === 'movie' ? 'preferred_movie_groups' : 'preferred_show_groups';
  const raw = settings.get(key) || (type === 'movie' ? 'yts,yify' : 'eztv,tgx,ettv,rartv');
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function detectQuality(title) {
  for (const q of QUALITY_PATTERNS) {
    if (q.pattern.test(title)) return q;
  }
  return { label: 'unknown', bonus: 0 };
}

function hasMalware(title) {
  return MALWARE_TITLE_RE.test(title || '');
}

function isLowQualitySource(title) {
  return LOW_QUALITY_SOURCES.some(re => re.test(title));
}

function isTrustedGroup(result, type) {
  const groups = getTrustedGroups(type);
  if (groups.includes(result.source)) return true;
  const lower = result.title.toLowerCase();
  return groups.some(g => lower.includes(`[${g}]`) || lower.includes(`-${g}`));
}

/** Returns true if title looks like a full-season pack (S01 but no E01). */
function isSeasonPack(title) {
  return /\bS\d{1,2}\b/i.test(title) && !/\bE\d{1,2}\b/i.test(title);
}

/** Returns true if title bundles multiple episodes (S01E01E02 or S01E01-E02). */
function isMultiEpisode(title) {
  return /S\d{1,2}E\d{1,2}[-_+]?E\d{1,2}/i.test(title);
}

/** Returns true if the title contains a user-defined blocked tag. */
function isUserBlocked(title) {
  const raw = settings.get('blocked_tags') || '';
  const tags = raw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const lower = title.toLowerCase();
  return tags.some(tag => lower.includes(tag));
}

function getSourceBonus(title) {
  for (const s of SOURCE_BONUSES) {
    if (s.pattern.test(title)) return s.bonus;
  }
  return 0;
}

function getHdrBonus(title) {
  return /\b(?:HDR(?:10\+?)?|DV\b|DOVI|DOLBY\.?VISION)\b/i.test(title) ? 10 : 0;
}

function getProperBonus(title) {
  return /\b(?:PROPER|REPACK|REAL\.PROPER)\b/i.test(title) ? 15 : 0;
}

function getForeignPenalty(title) {
  return FOREIGN_LANG_RE.test(title) ? -30 : 0;
}

// ─── Core filter / score ──────────────────────────────────────────────────────

function passesHardFilters(result, minSeeds, type) {
  if (result.seeders < minSeeds) return false;
  if (result.size > 0) {
    const minBytes = parseInt(settings.get('min_size_mb') || '200') * 1024 * 1024;
    const maxBytes = parseInt(settings.get('max_size_gb') || '60')  * 1024 * 1024 * 1024;
    if (result.size < minBytes) return false;
    if (result.size > maxBytes) return false;
  }
  if (hasMalware(result.title))        return false;
  if (isLowQualitySource(result.title)) return false;
  if (isUserBlocked(result.title))      return false;
  // For show episode grabs, reject season packs and multi-episode bundles
  if (type === 'show') {
    if (isSeasonPack(result.title))   return false;
    if (isMultiEpisode(result.title)) return false;
  }
  // Optional hard gate: only accept known release groups. Off by default, since
  // otherwise the trusted-group bonus is just a nudge a high-seed unknown can beat.
  if (settings.get('trusted_only') === '1' && !isTrustedGroup(result, type)) return false;
  // When the source gave us a file list (resolved from .torrent bytes), screen the
  // real contents. This is the check that actually catches droppers.
  if (result.files?.length) {
    const verdict = screenFiles(result.files, { type });
    if (!verdict.ok) {
      console.log(`[selector] rejected "${result.title}": ${verdict.reason}`);
      return false;
    }
  }
  return true;
}

function scoreResult(result, preferredQuality, type) {
  const q = result.quality
    ? { label: result.quality, bonus: QUALITY_PATTERNS.find(p => p.label === result.quality)?.bonus || 0 }
    : detectQuality(result.title);

  let s = result.seeders * 2;
  s += q.bonus;
  if (preferredQuality && q.label === preferredQuality) s += 50;
  if (isTrustedGroup(result, type)) s += 20;
  if (result.magnet) s += 150;

  // Source type and encoding bonuses
  s += getSourceBonus(result.title);
  s += getHdrBonus(result.title);
  s += getProperBonus(result.title);
  s += getForeignPenalty(result.title);

  result._quality = q.label;
  return s;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Select the best torrent(s) from a merged list of results.
 *
 * @param {Array}  results
 * @param {Object} opts
 * @param {string} opts.preferredQuality  '2160p' | '1080p' | '720p' | 'any'
 * @param {string} opts.type              'movie' | 'show'
 * @param {number} opts.limit             1 = return single winner, N = return top N array
 */
function select(results, { preferredQuality = '1080p', type = 'movie', limit = 1, exclude = [] } = {}) {
  const minSeeds = parseInt(settings.get('min_seeds') || '10');
  const strict   = settings.get('quality_strict') === '1';

  let scored = results
    .filter(r => {
      // Exclude previously tried magnets/URLs
      if (exclude.length > 0) {
        const url = r.magnet || r.download_url || '';
        if (url && exclude.includes(url)) return false;
      }
      return passesHardFilters(r, minSeeds, type);
    })
    .map(r => ({ ...r, _score: scoreResult(r, preferredQuality, type), _quality: detectQuality(r.title).label }))
    .sort((a, b) => b._score - a._score);

  // In strict mode, only keep results matching the preferred quality (unless 'any')
  if (strict && preferredQuality && preferredQuality !== 'any') {
    const exact = scored.filter(r => r._quality === preferredQuality);
    if (exact.length > 0) scored = exact;
  }

  if (limit === 1) return scored[0] || null;
  return scored.slice(0, limit);
}

module.exports = { select, detectQuality };
