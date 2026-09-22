'use strict';

const { settings } = require('./db');
const { screenFiles, EXECUTABLE_RE } = require('./screen');

// ─── Hard-reject lists ────────────────────────────────────────────────────────

/**
 * Executable extension advertised in a *title*. screen.js keeps this list
 * deliberately narrow — a title has no reliable final extension, so anything
 * ambiguous ("...RARBG.com", "The.Batman") would fire on ordinary releases.
 * The real defence is file-list screening; this only catches the rare release
 * that names its payload outright.
 */
const MALWARE_TITLE_RE = EXECUTABLE_RE;

/**
 * Titles that announce a password-protected or "extract me" payload. A film
 * never needs one; a dropper always does.
 */
const PASSWORD_TITLE_RE = /\b(?:password[\s._-]*protected|pass[\s._-]*:|winrar[\s._-]*password)\b/i;

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
  /\bWORKPRINT\b/i,
  /\bPREDVD\b/i,
  /(?:^|[.\-_[\s])TS(?:[.\-_\]\s]|$)/i,  // .TS. / [TS] etc — TELESYNC shorthand
  /(?:^|[.\-_[\s])CAM(?:[.\-_\]\s]|$)/i, // .CAM. / [CAM] etc
  /(?:^|[.\-_[\s])R5(?:[.\-_\]\s]|$)/i,  // .R5. — Russian DVD pre-release
];

/**
 * Foreign-language tokens that indicate a non-English dub/sub release.
 * Penalised rather than hard-blocked so a foreign user can still get results.
 */
const FOREIGN_LANG_RE =
  /\b(?:FRENCH|GERMAN|DEUTSCH|SPANISH|HINDI|ITALIAN|PORTUGUESE|DUTCH|VOSTFR|TRUEFRENCH|ARABIC|TURKISH|RUSSIAN|KOREAN|CHINESE|JAPANESE|POLISH|CZECH|HUNGARIAN|THAI|TAMIL|TELUGU|NORDIC|SWEDISH|DANISH)\b/i;

// ─── Quality detection ────────────────────────────────────────────────────────

const QUALITY_PATTERNS = [
  { pattern: /2160p|\b4k\b|\buhd\b/i, label: '2160p', bonus: 40 },
  { pattern: /1080p/i,                label: '1080p', bonus: 30 },
  { pattern: /720p/i,                 label: '720p',  bonus: 10 },
  { pattern: /\b(?:480p|576p|sd)\b/i, label: '480p',  bonus: -10 },
];

// ─── Source-type scoring ──────────────────────────────────────────────────────

const SOURCE_BONUSES = [
  { pattern: /\bREMUX\b/i,                   bonus: 28 },
  { pattern: /\bWEB[-.]?DL\b/i,              bonus: 25 },
  { pattern: /\b(?:BLURAY|BDR(?:IP)?|BRRIP)\b/i, bonus: 18 },
  { pattern: /\bWEBRIP\b/i,                  bonus: 15 },
  { pattern: /\bHDTV\b/i,                    bonus:  5 },
  // DVDRip: 0 — baseline
];

const CODEC_BONUSES = [
  { pattern: /\b(?:x265|h[\s.]?265|hevc)\b/i, bonus:  8 },
  { pattern: /\bav1\b/i,                       bonus:  8 },
  { pattern: /\b(?:x264|h[\s.]?264|avc)\b/i,   bonus:  2 },
  { pattern: /\b(?:xvid|divx)\b/i,             bonus: -25 },
];

const AUDIO_BONUS_RE = /\b(?:ATMOS|TRUEHD|DTS[-.]?HD|DTS[-.]?X|DDP?[\s.]?5[\s.]?1|EAC3)\b/i;

/**
 * Minimum plausible bytes for a claimed quality. A "2160p" 300 MB file is a
 * fake, an upscale, or a dropper — never the thing that was asked for. Floors
 * are deliberately generous: the goal is to catch lies, not to be picky.
 */
const SIZE_FLOORS = {
  movie: { '2160p': 2.0e9, '1080p': 550e6, '720p': 280e6, '480p': 0, unknown: 0 },
  show:  { '2160p': 600e6, '1080p': 180e6, '720p':  90e6, '480p': 0, unknown: 0 },
};

/** Above this, a single "episode" is really a pack or a mislabelled disc. */
const EPISODE_SIZE_CEILING = 30e9;

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

function isTrustedGroup(result, type) {
  const groups = getTrustedGroups(type);
  if (groups.includes(result.source)) return true;
  const lower = (result.title || '').toLowerCase();
  return groups.some(g => lower.includes(`[${g}]`) || lower.includes(`-${g}`));
}

/** Returns true if title looks like a full-season pack (S01 but no E01). */
function isSeasonPack(title) {
  return /\bS\d{1,2}\b/i.test(title) && !/\bE\d{1,2}\b/i.test(title);
}

/**
 * Releases that bundle more than one season: "Complete Series", "S01-S05",
 * "Seasons 1 to 3", or a bare list like "S01 S02 S03". For a show that finished
 * years ago this is usually the only thing anyone still seeds.
 */
const COMPLETE_RE = /\b(?:complete|full)\b[\s._-]*(?:series|collection|seasons?|show|set)?\b/i;
// Release titles use dots and underscores as spaces ("Seasons.1-9"), so the
// padding classes must allow them — but must not include the dash itself, or it
// gets eaten before the alternation that needs it.
const SEASON_SPAN_RES = [
  /\bS(\d{1,2})[\s._]*[-–~][\s._]*S?(\d{1,2})\b/i,                     // S01-S05 / S01-05
  /\bseasons?[\s._]*(\d{1,2})[\s._]*(?:[-–~]|to)[\s._]*(\d{1,2})\b/i,  // Seasons 1-9 / Season 1 to 5
];

/**
 * Seasons a title claims to contain, or null when it names none.
 * A span ("S01-S05") is expanded; a list ("S01 S02") is collected as-is.
 */
function claimedSeasons(title) {
  for (const re of SEASON_SPAN_RES) {
    const m = re.exec(title);
    if (!m) continue;
    const lo = Math.min(Number(m[1]), Number(m[2]));
    const hi = Math.max(Number(m[1]), Number(m[2]));
    if (hi - lo > 40) return null; // not a season span, probably a year or a resolution
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }
  const listed = [...title.matchAll(/\bS(\d{1,2})\b/gi)].map(m => Number(m[1]));
  const unique = [...new Set(listed)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : null;
}

function isSeriesPack(title) {
  if (/\bS\d{1,2}E\d{1,3}\b/i.test(title)) return false; // a single episode, whatever else it says
  if (SEASON_SPAN_RES.some(re => re.test(title))) return true;
  if (COMPLETE_RE.test(title)) return true;
  return (claimedSeasons(title) || []).length > 1;
}

/** Returns true if title bundles multiple episodes (S01E01E02 or S01E01-E02). */
function isMultiEpisode(title) {
  return /S\d{1,2}E\d{1,2}[-_+]?E\d{1,2}/i.test(title);
}

/** Returns the user-defined blocked tag a title matches, or null. */
function blockedTag(title) {
  const raw = settings.get('blocked_tags') || '';
  const tags = raw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  const lower = title.toLowerCase();
  return tags.find(tag => lower.includes(tag)) || null;
}

function firstBonus(list, title) {
  for (const entry of list) {
    if (entry.pattern.test(title)) return entry.bonus;
  }
  return 0;
}

// ─── Title / episode matching ─────────────────────────────────────────────────
//
// Nothing upstream guarantees a result is even the right film. Indexers fuzzy
// match, and Prowlarr merges whatever every one of them decided was close
// enough — which is how a search for one title ends up grabbing a different
// movie with the same first word. These checks are the difference between
// "the top-seeded thing" and "the thing you asked for".

function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Fraction of the wanted title's tokens that appear in the release title. */
function titleMatchRatio(releaseTitle, wantedTitle) {
  const want = normalizeTitle(wantedTitle).split(' ').filter(Boolean);
  if (want.length === 0) return 1;
  const have = new Set(normalizeTitle(releaseTitle).split(' ').filter(Boolean));
  const hits = want.filter(t => have.has(t)).length;
  return hits / want.length;
}

/** 4-digit year-like tokens in a release title, excluding ones from the title itself. */
function releaseYears(releaseTitle, wantedTitle) {
  const own = new Set(normalizeTitle(wantedTitle).split(' ').filter(t => /^\d{4}$/.test(t)));
  return (normalizeTitle(releaseTitle).match(/\b(?:19|20)\d{2}\b/g) || [])
    .filter(y => !own.has(y))
    .map(Number);
}

const SXXEYY_RE = /\bS(\d{1,2})[\s._-]?E(\d{1,3})\b/i;

/** A season number with no episode after it — "S01", not "S01E04". */
const SEASON_ONLY_RE = /\bS(\d{1,2})\b/i;

/**
 * Does this release plausibly match what was asked for?
 * Returns null when it does, or a human-readable reason when it does not.
 */
function mismatchReason(result, { type, want }) {
  if (!want?.title) return null;

  const minRatio = parseFloat(settings.get('title_match_min') || '0.7');
  const ratio    = titleMatchRatio(result.title, want.title);
  if (ratio < minRatio) {
    return `title match ${Math.round(ratio * 100)}% — looks like a different release`;
  }

  if (type === 'movie' && want.year) {
    const years = releaseYears(result.title, want.title);
    // Only judge when the release actually states a year; many do not.
    if (years.length > 0 && !years.some(y => Math.abs(y - want.year) <= 1)) {
      return `year ${years.join('/')} does not match ${want.year}`;
    }
  }

  // Series-pack search: a set of seasons is wanted in one torrent. The release
  // has to actually contain all of them — a "Complete Series" that turns out to
  // be seasons 1-3 of a five-season show leaves a hole nothing else will fill,
  // because the episodes it did cover are marked as handled.
  if (type === 'show' && Array.isArray(want.seasons) && want.seasons.length > 0) {
    if (!isSeriesPack(result.title)) return 'is not a multi-season pack';
    const has = claimedSeasons(result.title);
    if (has) {
      const missing = want.seasons.filter(s => !has.includes(Number(s)));
      if (missing.length > 0) {
        return `does not cover season${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`;
      }
    } else if (!COMPLETE_RE.test(result.title)) {
      // No seasons named and it doesn't claim to be complete — unverifiable.
      return 'does not say which seasons it contains';
    }
    return null;
  }

  // Pack search: season given, episode deliberately not. The release has to
  // name this season and only this season — "S02" must not satisfy "S01", and a
  // single episode must not satisfy a request for the whole run.
  if (type === 'show' && want.season != null && want.episode == null) {
    if (!isSeasonPack(result.title)) return 'is not a season pack';
    const m = SEASON_ONLY_RE.exec(result.title);
    if (!m) return 'no season number in title';
    if (Number(m[1]) !== Number(want.season)) {
      return `is season ${Number(m[1])}, not season ${want.season}`;
    }
    return null;
  }

  if (type === 'show' && want.season != null && want.episode != null) {
    const m = SXXEYY_RE.exec(result.title);
    if (m) {
      const s = Number(m[1]), e = Number(m[2]);
      if (s !== Number(want.season) || e !== Number(want.episode)) {
        return `is S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}, not the requested episode`;
      }
    } else if (result.season != null && result.episode != null) {
      // Source-supplied numbering (EZTV) when the title carries none
      if (Number(result.season) !== Number(want.season) || Number(result.episode) !== Number(want.episode)) {
        return 'episode numbering does not match';
      }
    } else if (ratio < 0.95) {
      // No episode marker anywhere and only a loose title match — too risky
      return 'no episode number in title';
    }
  }

  return null;
}

// ─── Core filter ──────────────────────────────────────────────────────────────

/** Returns null when the result is acceptable, or the reason it was rejected. */
function rejectionReason(result, { minSeeds, type, want, allowPacks = false }) {
  const title = result.title || '';

  if (!title) return 'no title';
  if ((result.seeders ?? 0) < minSeeds) {
    return `${result.seeders ?? 0} seeder(s), below the minimum of ${minSeeds}`;
  }

  // Size limits are per *episode*. A pack covering 60 episodes is legitimately
  // 60 times the size of one, so judging its total against a single-item cap
  // would reject every complete series there is — the size that matters is what
  // it works out to per episode.
  const covers = Math.max(1, Number(want?.episodeCount) || 1);
  const perItem = (result.size || 0) / covers;

  if (result.size > 0) {
    const minBytes = parseInt(settings.get('min_size_mb') || '200') * 1024 * 1024;
    const maxBytes = parseInt(settings.get('max_size_gb') || '60')  * 1024 * 1024 * 1024;
    if (perItem < minBytes) {
      return covers > 1
        ? `${Math.round(perItem / 1e6)} MB per episode is too small`
        : `only ${Math.round(result.size / 1e6)} MB`;
    }
    if (perItem > maxBytes) {
      return covers > 1
        ? `${(perItem / 1e9).toFixed(1)} GB per episode exceeds the size cap`
        : `${(result.size / 1e9).toFixed(1)} GB exceeds the size cap`;
    }
  }

  if (MALWARE_TITLE_RE.test(title))  return 'executable extension in the title';
  if (PASSWORD_TITLE_RE.test(title)) return 'advertises a password-protected archive';

  const lowQuality = LOW_QUALITY_SOURCES.find(re => re.test(title));
  if (lowQuality) return 'cam / telesync / screener source';

  const tag = blockedTag(title);
  if (tag) return `matches your blocked tag "${tag}"`;

  // For show episode grabs, reject season packs and multi-episode bundles.
  // allowPacks lifts this for a deliberate pack search or a hand-typed query,
  // where the user can see exactly what they are picking.
  if (type === 'show' && !allowPacks) {
    if (isSeasonPack(title))   return 'is a season pack, not a single episode';
    if (isMultiEpisode(title)) return 'bundles multiple episodes';
    if (result.size > EPISODE_SIZE_CEILING) {
      return `${(result.size / 1e9).toFixed(1)} GB is too large for one episode`;
    }
  }

  // Claimed quality has to be physically plausible for the file size — again
  // per episode, so a 200 GB "complete series" is judged on what that leaves
  // for each of its episodes rather than on the headline number.
  const quality = result.quality || detectQuality(title).label;
  const floor   = SIZE_FLOORS[type === 'movie' ? 'movie' : 'show'][quality] ?? 0;
  if (floor > 0 && result.size > 0 && perItem < floor) {
    return covers > 1
      ? `${Math.round(perItem / 1e6)} MB per episode is impossibly small for ${quality}`
      : `${Math.round(result.size / 1e6)} MB is impossibly small for ${quality}`;
  }

  const mismatch = mismatchReason(result, { type, want });
  if (mismatch) return mismatch;

  // Optional hard gate: only accept known release groups. Off by default, since
  // otherwise the trusted-group bonus is just a nudge a high-seed unknown can beat.
  if (settings.get('trusted_only') === '1' && !isTrustedGroup(result, type)) {
    return 'not from a trusted release group';
  }

  // When the source gave us a file list (resolved from .torrent bytes), screen the
  // real contents. This is the check that actually catches droppers.
  if (result.files?.length) {
    const verdict = screenFiles(result.files, { type });
    if (!verdict.ok) return verdict.reason;
    if (verdict.warnings?.length) result._warnings = verdict.warnings;
  }

  return null;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

/** Past this many seeders, more makes no practical difference to a download. */
const SEED_SATURATION = 1000;

/** Resolution ladder, used to score how far a result sits from what was asked. */
const QUALITY_TIERS = { '2160p': 3, '1080p': 2, '720p': 1, '480p': 0, unknown: 1 };

/**
 * How well a result's resolution fits the request. An exact match wins
 * outright; neighbouring tiers stay in play so a 1080p request still surfaces
 * the 2160p release when nothing else is around, and a 480p rip does not.
 */
function qualityFit(label, preferred) {
  if (!preferred || preferred === 'any') return 0;
  const want = QUALITY_TIERS[preferred];
  const have = QUALITY_TIERS[label];
  if (want === undefined || have === undefined) return 0;
  return 50 - 22 * Math.abs(have - want);
}

function scoreResult(result, preferredQuality, type, want) {
  const title = result.title || '';
  const q = result.quality
    ? { label: result.quality, bonus: QUALITY_PATTERNS.find(p => p.label === result.quality)?.bonus || 0 }
    : detectQuality(title);

  // Seeders are log-scaled and capped on purpose. Linear scaling let a 4000-seed
  // 720p rip bury a 60-seed 1080p WEB-DL, which is the opposite of what anyone
  // wants: past a few dozen seeds the download is fast either way, so the
  // marginal seed is worth far less than the marginal quality tier. The hard
  // min-seeds filter already removes torrents that would never finish.
  let s = Math.log2(Math.min(result.seeders ?? 0, SEED_SATURATION) + 1) * 10;

  s += q.bonus;
  s += qualityFit(q.label, preferredQuality);
  if (isTrustedGroup(result, type)) s += 20;

  s += firstBonus(SOURCE_BONUSES, title);
  s += firstBonus(CODEC_BONUSES,  title);
  if (AUDIO_BONUS_RE.test(title)) s += 6;
  if (/\b(?:HDR(?:10\+?)?|DV\b|DOVI|DOLBY\.?VISION)\b/i.test(title)) s += 10;
  if (/\b(?:PROPER|REPACK|REAL\.PROPER)\b/i.test(title)) s += 15;
  if (FOREIGN_LANG_RE.test(title)) s -= 30;

  // An exact title match beats a merely plausible one.
  if (want?.title) s += (titleMatchRatio(title, want.title) - 0.7) * 40;

  // Prefer results we can hand to Transmission with no further round trip.
  if (result.magnet) s += 15;
  // A parsed file list means the contents were verified, not assumed.
  if (result.files?.length) s += 10;

  result._quality = q.label;
  return Math.round(s);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Collapse duplicate releases mirrored across indexers into one row. */
function dedupe(results) {
  const byKey = new Map();
  for (const r of results) {
    const key = r.info_hash
      ? `h:${String(r.info_hash).toLowerCase()}`
      : `t:${normalizeTitle(r.title)}|${r.size || 0}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...r, _mirrors: 1 });
      continue;
    }
    // Keep the richer row, but carry across the best numbers from either.
    const merged = (r.files?.length && !existing.files?.length) ? { ...r } : existing;
    merged.seeders   = Math.max(existing.seeders || 0, r.seeders || 0);
    merged.size      = existing.size || r.size || 0;
    merged.magnet    = existing.magnet || r.magnet || null;
    merged.files     = existing.files?.length ? existing.files : r.files;
    merged.info_hash = existing.info_hash || r.info_hash || null;
    merged._mirrors  = (existing._mirrors || 1) + 1;
    byKey.set(key, merged);
  }
  return [...byKey.values()];
}

/**
 * Score and partition a result list.
 *
 * @param {Array}  results
 * @param {Object} opts
 * @param {string} opts.preferredQuality  '2160p' | '1080p' | '720p' | 'any'
 * @param {string} opts.type              'movie' | 'show'
 * @param {Object} opts.want              { title, year, season, episode } — what was asked for
 * @param {Array}  opts.exclude           magnets/URLs already tried
 * @returns {{ accepted: Array, rejected: Array }}  both sorted best-first
 */
function evaluate(results, {
  preferredQuality = '1080p', type = 'movie', want = null,
  exclude = [], allowPacks = false,
} = {}) {
  const minSeeds = parseInt(settings.get('min_seeds') || '10');
  const strict   = settings.get('quality_strict') === '1';

  const accepted = [];
  const rejected = [];

  for (const raw of dedupe(results)) {
    const url = raw.magnet || raw.download_url || '';
    if (exclude.length > 0 && url && exclude.includes(url)) {
      rejected.push({ ...raw, _reason: 'already tried for this item' });
      continue;
    }

    const r = { ...raw };
    const reason = rejectionReason(r, { minSeeds, type, want, allowPacks });
    r._score   = scoreResult(r, preferredQuality, type, want);
    r._quality = r._quality || detectQuality(r.title || '').label;

    if (reason) rejected.push({ ...r, _reason: reason });
    else accepted.push(r);
  }

  accepted.sort((a, b) => b._score - a._score);
  rejected.sort((a, b) => b._score - a._score);

  // In strict mode, only keep results matching the preferred quality (unless 'any')
  if (strict && preferredQuality && preferredQuality !== 'any') {
    const exact = accepted.filter(r => r._quality === preferredQuality);
    if (exact.length > 0) return { accepted: exact, rejected };
  }

  return { accepted, rejected };
}

/**
 * Select the best torrent(s). Thin wrapper over evaluate() kept for callers that
 * only care about the winners.
 *
 * @param {number} opts.limit  1 = return a single winner, N = return top N
 */
function select(results, { limit = 1, ...opts } = {}) {
  const { accepted } = evaluate(results, opts);
  if (limit === 1) return accepted[0] || null;
  return accepted.slice(0, limit);
}

module.exports = {
  select, evaluate, dedupe, detectQuality,
  normalizeTitle, titleMatchRatio,
  isSeasonPack, isSeriesPack, claimedSeasons,
};
