'use strict';

// Learning how releases write a show's name.
//
// The strict rule (selector.extraShowWords) turns down a release whose name
// has words the show's doesn't: "Silo.Stories.S02E01" is not *Silo*. That is
// right most of the time — but some shows are released under a longer or
// different name than TMDB's ("Law.and.Order.SVU"), and then strict finds
// nothing, ever. So, step by step:
//
//   1. Strict first. Only the show's own words (and its own year/country).
//   2. An episode still has nothing after a few runs, and releases were turned
//      down only for their name: each such name is looked up on TMDB. If a
//      *different* show is called that, it stays turned down for good
//      ("other"). If no show is, it is learned as another way of writing this
//      show ("variant") and the search runs again.
//   3. A grab made that way carries a note to check it. Marking it the wrong
//      video un-learns the name (verdict "other", for good).
//   4. A release picked by hand teaches its name too: someone looked.

const { shows } = require('./db');
const selector = require('./selector');
const log = require('./log');

/** Strict runs an episode has come up empty before names get looked up. */
const RELAX_AFTER_RUNS = 3;

function parse(show) {
  try { const v = JSON.parse(show?.name_variants || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
}

/** Names accepted for this show besides its own, normalized. */
function accepted(show) {
  return Object.entries(parse(show)).filter(([, v]) => v.verdict === 'variant').map(([k]) => k);
}

function save(show, map) {
  shows.update(show.id, { name_variants: JSON.stringify(map) });
}

/** Without a year or country tag, for comparing with TMDB names. */
function bare(part) {
  return part.split(' ').filter(w => !/^(?:19|20)\d{2}$/.test(w) && !['us', 'uk', 'au', 'nz', 'ca', 'usa', 'gb'].includes(w)).join(' ');
}

/**
 * Look up the names a strict search turned down; learn the ones no other show
 * has. Returns how many were learned.
 */
async function learnFrom(show, rejected, { tmdb = require('./tmdb') } = {}) {
  const parts = [...new Set((rejected || [])
    .filter(r => /^names another show/.test(r._reason || ''))
    .map(r => selector.showPartOf(r.title))
    .filter(Boolean))];
  if (!parts.length) return 0;
  const map = parse(show);
  let learned = 0;
  for (const part of parts) {
    if (map[part]) continue;   // decided already, either way
    let results;
    try { results = await tmdb.searchTv(part); } catch (err) {
      log.warn(`could not check "${part}" on TMDB: ${err.message}`, { type: 'show', id: show.id });
      continue;
    }
    const norm = (s) => selector.normalizeTitle(s);
    const other = results.find(r => r.tmdb_id !== show.tmdb_id
      && [norm(r.name), norm(r.original_name)].some(n => n && (n === part || n === bare(part))));
    if (other) {
      map[part] = { verdict: 'other', how: 'tmdb', other: `${other.name}${other.year ? ` (${other.year})` : ''}`, at: new Date().toISOString() };
      log.info(`"${part}" is another show on TMDB (${map[part].other}) — releases named so stay turned down for "${show.title}"`, { type: 'show', id: show.id });
    } else {
      map[part] = { verdict: 'variant', how: 'tmdb', at: new Date().toISOString() };
      learned++;
      log.warn(`no show called "${part}" on TMDB — trying it as another way of writing "${show.title}"; a download found so is marked for checking`, { type: 'show', id: show.id });
    }
  }
  save(show, map);
  return learned;
}

/** A release picked by hand: its way of writing the name is right for this show. */
function learnPicked(show, releaseTitle) {
  const part = selector.showPartOf(releaseTitle);
  if (!part) return false;
  const extra = selector.extraShowWords(releaseTitle, {
    title: show.title, originalTitle: show.original_title, firstAirYear: show.first_air_year,
    countries: String(show.origin_country || '').split(',').filter(Boolean), variants: [],
  });
  if (!extra.length) return false;
  const map = parse(show);
  map[part] = { verdict: 'variant', how: 'picked', at: new Date().toISOString() };
  save(show, map);
  log.info(`"${part}" picked by hand — now accepted as a way of writing "${show.title}"`, { type: 'show', id: show.id });
  return true;
}

/** A download found under a learned name was the wrong video: never that name again. */
function unlearn(show, releaseTitle) {
  const part = selector.showPartOf(releaseTitle);
  const map = parse(show);
  if (!part || map[part]?.verdict !== 'variant') return false;
  map[part] = { verdict: 'other', how: 'wrong', at: new Date().toISOString() };
  save(show, map);
  log.info(`"${part}" turned out to be the wrong show — releases named so stay turned down for "${show.title}"`, { type: 'show', id: show.id });
  return true;
}

/** Whether a release only passed because of a name learned from TMDB (not picked by hand). */
function looselyMatched(show, releaseTitle) {
  const part = selector.showPartOf(releaseTitle);
  return !!part && parse(show)[part]?.verdict === 'variant' && parse(show)[part]?.how === 'tmdb';
}

module.exports = { RELAX_AFTER_RUNS, accepted, learnFrom, learnPicked, unlearn, looselyMatched, parse };
