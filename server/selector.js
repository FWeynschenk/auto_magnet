'use strict';

const { settings } = require('./db');

const MALWARE_EXTS = ['.exe', '.bat', '.cmd', '.scr', '.msi', '.pif', '.vbs', '.ps1', '.com'];

const QUALITY_PATTERNS = [
  { pattern: /2160p|4k\b|uhd\b/i, label: '2160p', bonus: 40 },
  { pattern: /1080p/i,             label: '1080p', bonus: 30 },
  { pattern: /720p/i,              label: '720p',  bonus: 10 },
];

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
  const lower = title.toLowerCase();
  return MALWARE_EXTS.some(ext => lower.includes(ext));
}

function isTrustedGroup(result, type) {
  const groups = getTrustedGroups(type);
  // Source name matches (e.g. source === 'yts')
  if (groups.includes(result.source)) return true;
  // Group tag in title (e.g. [ETTV] or -rartv)
  const lower = result.title.toLowerCase();
  return groups.some(g => lower.includes(`[${g}]`) || lower.includes(`-${g}`));
}

function passesHardFilters(result, minSeeds) {
  if (result.seeders < minSeeds) return false;
  if (result.size > 0) {
    const minBytes = parseInt(settings.get('min_size_mb') || '200') * 1024 * 1024;
    const maxBytes = parseInt(settings.get('max_size_gb') || '60')  * 1024 * 1024 * 1024;
    if (result.size < minBytes) return false;
    if (result.size > maxBytes) return false;
  }
  if (hasMalware(result.title)) return false;
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
  result._quality = q.label;
  return s;
}

/**
 * Select the best torrent(s) from a merged list of results.
 *
 * @param {Array}  results
 * @param {Object} opts
 * @param {string} opts.preferredQuality  '2160p' | '1080p' | '720p' | 'any'
 * @param {string} opts.type              'movie' | 'show'
 * @param {number} opts.limit             1 = return single winner, N = return top N array
 */
function select(results, { preferredQuality = '1080p', type = 'movie', limit = 1 } = {}) {
  const minSeeds   = parseInt(settings.get('min_seeds') || '10');
  const strict     = settings.get('quality_strict') === '1';

  let scored = results
    .filter(r => passesHardFilters(r, minSeeds))
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
