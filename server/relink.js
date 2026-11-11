'use strict';

const { torrentRef, lowerHash } = require('./torrentref');

// Putting items back on their own files and torrents.
//
// Rows used to follow their torrent by Transmission's id, which is only good
// until Transmission restarts: it numbers torrents 1, 2, 3… in load order every
// time, so once torrents have come and gone, a restart shifts the numbers and a
// stored "57" is a different torrent. A download then "completed" when some
// other torrent did, and post-processing recorded that torrent's video — often
// another show's — as the episode's file. The episode played the other show
// from then on.
//
// New grabs keep the torrent's info hash, which never changes. This module
// repairs what the ids already got wrong, and finds the right torrent again
// whenever an id turns out to point elsewhere:
//
//   1. A recorded file that isn't its item's (identity.fileBelongsTo says
//      'no', or another item's key) is dropped, with its web version,
//      thumbnails and intro; subtitles fetched for it beside someone else's
//      video are moved aside; and the item is pointed at its own torrent —
//      found among every torrent by its files' names — or its file on disk.
//   2. Rows still followed by id get their hash: from the torrent with that
//      id if its files name the item, else from whichever torrent does.
//
// Nothing here deletes a torrent or a video.

const fs   = require('fs');
const path = require('path');

const { db, movies, episodes } = require('./db');
const media = require('./media');
const { itemKey } = require('./identity');
const log = require('./log');

const storeFor = (kind) => (kind === 'movie' ? movies : episodes);
const targetOf = (item) => (item.kind === 'movie' ? item.row.transmission_target : item.show.transmission_target);

function label(item) {
  return item.kind === 'episode'
    ? `${item.show_title} S${String(item.season).padStart(2, '0')}E${String(item.episode).padStart(2, '0')}`
    : item.title;
}

/** Every torrent on an instance, with its files — fetched once per pass. */
async function listing(tx, targetName, cache) {
  const target = tx.resolveTarget(targetName);
  if (cache.has(target.name)) return cache.get(target.name);
  const list = (await tx.listTorrents(['hashString', 'name', 'downloadDir', 'files', 'percentDone', 'wanted'], target))
    .map(t => ({
      id: t.id, hash: lowerHash(t.hashString), name: t.name, downloadDir: t.downloadDir, percentDone: t.percentDone || 0,
      files: (t.files || []).map((f, i) => ({
        name: f.name, length: f.length,
        wanted: !(Array.isArray(t.wanted) && (t.wanted[i] === 0 || t.wanted[i] === false)),
      })),
    }));
  cache.set(target.name, list);
  return list;
}

/** The torrent whose files name this item, and the file — finished ones first. */
function findIn(item, torrents) {
  const hits = [];
  for (const t of torrents) {
    const f = media.pickFile(t.files.filter(x => x.wanted !== false), item, { dir: t.downloadDir });
    if (f) hits.push({ t, f });
  }
  hits.sort((a, b) => (b.t.percentDone - a.t.percentDone) || (b.f.length - a.f.length));
  return hits[0] || null;
}

/**
 * Point an item at its own torrent: found among every torrent on its instance
 * by its files' names. Without one, a finished item may still have its file
 * on disk (the torrent removed after seeding); otherwise it says so on its
 * card. Returns { found, how }.
 */
async function relinkItem(kind, id, { tx = require('./transmission'), cache = new Map(), reason = null } = {}) {
  const item = media.itemFor(kind, id);
  if (!item) return { found: false, how: 'gone' };
  const store = storeFor(kind);
  const why = reason ? ` — ${reason}` : '';

  let torrents = null;
  try { torrents = await listing(tx, targetOf(item), cache); } catch (_) { /* Transmission unreachable */ }
  const hit = torrents && findIn(item, torrents);
  if (hit) {
    const done = hit.t.percentDone >= 1;
    const changes = { torrent_id: hit.t.id, torrent_hash: hit.t.hash, last_error: null };
    if (['done', 'downloading'].includes(item.row.status)) {
      changes.status = done ? 'done' : 'downloading';
      changes.progress = Math.round(hit.t.percentDone * 100);
      if (done && !item.row.completed_at) changes.completed_at = new Date().toISOString();
    }
    store.update(id, changes);
    log.info(`${label(item)} found its own torrent again: "${hit.t.name}"${why}`, { type: kind, id });
    return { found: true, how: 'torrent' };
  }

  if (item.row.status === 'done') {
    const file = media.searchDisk(item);
    if (file) {
      try {
        await media.record(kind, id, file);
        store.update(id, { last_error: null });
        log.info(`${label(item)} found its own file on disk: ${path.basename(file)}${why}`, { type: kind, id });
        return { found: true, how: 'disk' };
      } catch (_) { /* unreadable — reported below */ }
    }
  }
  if (torrents === null) return { found: false, how: 'unreachable' };
  store.update(id, { last_error: `Lost track of its download${why}, and it isn't in Transmission or on disk — use Redo to download it again` });
  log.warn(`${label(item)}: its own download can't be found${why}`, { type: kind, id });
  return { found: false, how: 'lost' };
}

/**
 * Subtitles fetched for an item that was pointed at someone else's file were
 * saved beside that file, under its name, and the file's real owner then took
 * them for its own. They are moved aside (to .mixed-up.bak, which no player
 * reads) and the owner fetches its own.
 */
function moveAsideWrongSubtitles(row, item) {
  if (item.row.subs_state !== 'fetched') return;
  const stem = row.path.replace(/\.[^.]+$/, '');
  let moved = 0;
  for (const lang of media.wantedLanguages()) {
    const f = `${stem}.${lang}.srt`;
    if (fs.existsSync(f)) { fs.renameSync(f, `${f}.mixed-up.bak`); moved++; }
  }
  if (!moved) return;
  for (const other of media.rows.all().filter(r => r.path === row.path && !(r.kind === row.kind && r.item_id === row.item_id))) {
    storeFor(other.kind).update(other.item_id, { subs_state: 'pending', subs_checked_at: null });
    try { require('./deletion').forgetFile(other.kind, other.item_id); } catch (_) {}   // its web version may carry them
  }
  log.info(`subtitles fetched for ${label(item)} beside ${path.basename(row.path)} moved aside`, { type: row.kind, id: row.item_id });
}

/**
 * The whole library, once at startup and with every library check.
 * @returns {{ dropped, relinked, lost, hashed }}
 */
async function repairLibrary({ tx = require('./transmission') } = {}) {
  const cache = new Map();
  const report = { dropped: 0, relinked: 0, lost: 0, hashed: 0, replaced: 0 };
  const wrong = new Map();   // "kind:id" → { item, torrent } — downloads of something else
  const relinked = new Set(); // "kind:id" already back on its own download

  // 1. Every download's torrent, against the item it is for.
  const items = db.prepare(`
    SELECT 'movie' AS kind, id FROM movies
      WHERE status IN ('done', 'downloading') AND (torrent_hash IS NOT NULL OR torrent_id IS NOT NULL)
    UNION ALL
    SELECT 'episode' AS kind, id FROM episodes
      WHERE status IN ('done', 'downloading') AND (torrent_hash IS NOT NULL OR torrent_id IS NOT NULL)
  `).all();
  for (const l of items) {
    const item = media.itemFor(l.kind, l.id);
    if (!item) continue;
    let torrents;
    try { torrents = await listing(tx, targetOf(item), cache); } catch (_) { break; }   // Transmission unreachable: next time
    const byHash = !!item.row.torrent_hash;
    const t = byHash ? torrents.find(x => x.hash === item.row.torrent_hash) : torrents.find(x => x.id === item.row.torrent_id);
    if (!t) {
      // Gone (removed after seeding, or by hand): its file is what matters,
      // checked in step 2. Still downloading, it has lost track of it.
      if (!byHash && item.row.status === 'downloading') {
        const res = await relinkItem(l.kind, l.id, { tx, cache, reason: 'its torrent id is no longer in Transmission' });
        if (res.found) report.relinked++; else if (res.how === 'lost') report.lost++;
      }
      continue;
    }
    const files = t.files.filter(f => f.wanted !== false);
    if (!media.videoFilesIn(files).length) continue;   // no file list yet
    if (media.pickFile(files, item, { dir: t.downloadDir, trusted: byHash })) {
      if (!byHash) { storeFor(l.kind).update(l.id, { torrent_hash: t.hash }); report.hashed++; }
      continue;
    }
    // Nothing in this torrent is the item's. Known only by an id, the id may
    // have been handed to another torrent since: look for the item's own.
    if (!byHash) {
      const res = await relinkItem(l.kind, l.id, { tx, cache,
        reason: `torrent ${item.row.torrent_id} is "${t.name}", which isn't it` });
      if (res.found) { report.relinked++; relinked.add(`${l.kind}:${l.id}`); continue; }
    }
    // Its own download, and it is something else: a wrong grab.
    wrong.set(`${l.kind}:${l.id}`, { item, torrent: t });
  }

  // 2. Recorded files that aren't their item's.
  for (const r of media.rows.all()) {
    const item = media.itemFor(r.kind, r.item_id);
    if (!item) continue;   // orphans: the index pass removes them
    if (media.recordedFor(r, item)) {
      if (!r.item_key) media.rows.update(r.kind, r.item_id, { item_key: itemKey(item) });
      continue;
    }
    report.dropped++;
    moveAsideWrongSubtitles(r, item);
    media.forgetMismatch(r.kind, r.item_id, r, item);
    // Its checks ran on the wrong file: run them again on its own.
    storeFor(r.kind).update(r.item_id, { post_processed_at: null, subs_state: null, subs_checked_at: null });
    if (wrong.has(`${r.kind}:${r.item_id}`) || relinked.has(`${r.kind}:${r.item_id}`)) continue;   // replaced below / done above
    const res = await relinkItem(r.kind, r.item_id, { tx, cache, reason: 'its recorded file was another item\'s' });
    if (res.found) report.relinked++; else if (res.how === 'lost') report.lost++;
  }

  // 3. Wrong grabs: replaced, as Redo would — the release is never picked for
  // the item again, and a new search runs. The stray download goes too, but
  // only when auto_magnet added it for this item and nothing else claims it;
  // a torrent that is really another item's (or was in Transmission already)
  // stays theirs.
  for (const [k, { item, torrent }] of wrong) {
    const [kind, id] = k.split(':');
    const sharedWith = require('./deletion').sharers(item, torrent.hash || torrent.id, targetOf(item));
    if (item.row.torrent_origin === 'added' && sharedWith.length === 0) {
      try { await tx.purgeTorrent(torrent.hash || torrent.id, tx.resolveTarget(targetOf(item))); } catch (_) { /* left for Redo */ }
    }
    try {
      await require('./replace').replaceDownload(kind, Number(id), {
        reason: `it had downloaded "${torrent.name}" — another show's release`, wrong: true, search: false, tx,
      });
      report.replaced++;
    } catch (err) {
      log.warn(`${label(item)}: couldn't replace its wrong download "${torrent.name}": ${err.message}`, { type: kind, id: Number(id) });
    }
  }
  if (report.replaced) setImmediate(() => require('./scheduler').run().catch(() => {}));

  if (Object.values(report).some(Boolean)) {
    log.info(`library repair: ${report.replaced} wrong download(s) replaced, ${report.dropped} wrong file link(s) dropped, `
      + `${report.relinked} item(s) back on their own download, ${report.lost} lost, ${report.hashed} torrent(s) now followed by hash`);
  }
  return report;
}

module.exports = { relinkItem, repairLibrary, findIn };
