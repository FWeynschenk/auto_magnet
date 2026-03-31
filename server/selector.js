'use strict';

const { settings } = require('./db');

const MALWARE_EXTS = ['.exe', '.bat', '.cmd', '.scr', '.msi', '.pif', '.vbs', '.ps1', '.com'];
const VIDEO_EXTS   = ['.mkv', '.mp4', '.avi', '.m4v', '.mov', '.wmv'];

const QUALITY_PATTERNS = [
  { pattern: /2160p|4k\b|uhd\b/i, label: '2160p', bonus: 40 },
  { pattern: /1080p/i,             label: '1080p', bonus: 30 },
  { pattern: /720p/i,              label: '720p',  bonus: 10 },
];

const TRUSTED_MOVIE_GROUPS = ['yts', 'yify'];
const TRUSTED_SHOW_GROUPS  = ['eztv', 'tgx', 'ettv', 'rartv'];

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
  if (result.source === 'yts' || result.source === 'eztv') return true;
  const lower = result.title.toLowerCase();
  const groups = type === 'movie' ? TRUSTED_MOVIE_GROUPS : TRUSTED_SHOW_GROUPS;
  return groups.some(g => lower.includes(`[${g}]`) || lower.includes(`-${g}`));
}

function passesHardFilters(result, minSeeds) {
  if (result.seeders < minSeeds) return false;
  // Size checks only when size is provided and non-zero
  if (result.size > 0) {
    if (result.size < 200 * 1024 * 1024)     return false; // < 200 MB
    if (result.size > 60 * 1024 * 1024 * 1024) return false; // > 60 GB
  }
  if (hasMalware(result.title)) return false;
  return true;
}

function scoreResult(result, preferredQuality, type) {
  const q = result.quality ? { label: result.quality, bonus: QUALITY_PATTERNS.find(p => p.label === result.quality)?.bonus || 0 } : detectQuality(result.title);
  let s = result.seeders * 2;
  s += q.bonus;
  if (preferredQuality && q.label === preferredQuality) s += 50;
  if (isTrustedGroup(result, type)) s += 20;
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
  const minSeeds = parseInt(settings.get('min_seeds') || '10');

  const scored = results
    .filter(r => passesHardFilters(r, minSeeds))
    .map(r => ({ ...r, _score: scoreResult(r, preferredQuality, type), _quality: detectQuality(r.title).label }))
    .sort((a, b) => b._score - a._score);

  if (limit === 1) return scored[0] || null;
  return scored.slice(0, limit);
}

module.exports = { select, detectQuality };
