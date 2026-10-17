'use strict';

// Tidying show folders that already exist on disk.
//
// Two problems, one cause — the folder was the raw TMDB title:
//   * a title with a character Windows forbids (a colon, mostly) produced a
//     folder Samba shows to Windows under a stand-in like "A9VK1B~E";
//   * older downloads used lowercase folder names, newer ones the title as-is,
//     so some shows live in two folders that differ only in case.
//
// New downloads now go to paths.showDir(). This finds the folders that don't
// match it and moves them there — but only when asked, one folder at a time,
// and conservatively:
//
//   * torrent data is moved by Transmission itself (torrent-set-location), so
//     it keeps seeding and keeps track of where its files are;
//   * everything Transmission doesn't own — fetched subtitles, files added by
//     hand, old downloads already removed from Transmission — follows after;
//   * nothing is ever overwritten: anything already present at the destination
//     is left where it is and reported;
//   * the old folder is removed only if it ends up empty;
//   * the plan is recomputed for every request, so only a folder it found
//     itself can be moved — never a path supplied by the browser.

const fs   = require('fs');
const path = require('path');
const { shows, settings } = require('./db');
const tx   = require('./transmission');
const { sanitizeFolderName, mapPath } = require('./paths');
const log  = require('./log');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const trim  = (p) => String(p || '').replace(/\/+$/, '');

/** The form two folder names share when they belong to the same show. */
const showKey = (name) => sanitizeFolderName(name).toLowerCase();

/** The file or folder a torrent occupies at the top of its download folder. */
function topLevel(t) {
  const first = t.files?.[0]?.name || t.name || '';
  return first.split('/')[0];
}

function listLocal(dir) {
  try { return fs.readdirSync(mapPath(dir)); } catch (_) { return null; }
}

/**
 * Every tracked show folder that isn't where new downloads now go.
 * @returns {{ root, fixes: Array<{ target, show, from, to, reason, merge, moves, conflicts, reachable }> }}
 */
async function planFolderFixes() {
  const root = trim(settings.get('shows_path'));
  if (!root) return { root, fixes: [] };

  const byKey = new Map(shows.all().map(s => [showKey(s.title), s]));
  const fixes = [];

  for (const target of tx.listTargets()) {
    let torrents;
    try {
      torrents = await tx.listTorrents(['name', 'downloadDir', 'files'], target);
    } catch (_) {
      continue; // instance unreachable — nothing to plan for it
    }

    // Folders directly inside the shows root, with the torrents in each.
    const dirs = new Map();
    for (const t of torrents) {
      const d = trim(t.downloadDir);
      if (path.posix.dirname(d) !== root) continue;
      if (!dirs.has(d)) dirs.set(d, []);
      dirs.get(d).push(t);
    }

    for (const [from, list] of dirs) {
      const leaf = path.posix.basename(from);
      const show = byKey.get(showKey(leaf));
      if (!show) continue;                       // not a show auto_magnet tracks

      const to = `${root}/${sanitizeFolderName(show.title)}`;
      if (from === to) continue;                 // already where it belongs

      // Whatever already occupies the destination, compared without case —
      // the share is used from Windows, where "Ep1.mkv" and "ep1.mkv" collide.
      const local = listLocal(to);
      const taken = new Set([
        ...(dirs.get(to) || []).map(t => topLevel(t)),
        ...(local || []),
      ].map(n => n.toLowerCase()));

      const moves = [], conflicts = [];
      for (const t of list) {
        const item = topLevel(t);
        (taken.has(item.toLowerCase()) ? conflicts : moves).push({ id: t.id, name: t.name, item });
      }

      fixes.push({
        target: target.name,
        show:   show.title,
        from, to,
        reason: reasonFor(leaf),
        merge:  dirs.has(to) || local !== null,
        moves, conflicts,
        // Leftover files can only follow if this process can see the folder.
        reachable: listLocal(from) !== null,
      });
    }
  }

  // Folders Transmission no longer knows about — old downloads whose torrents
  // were removed — are only visible on disk. Without this they would stay
  // split from where new episodes go. Only possible where the media folder is
  // mounted; elsewhere there is simply nothing extra to find.
  const planned = new Set(fixes.map(f => f.from));
  for (const leaf of listLocal(root) || []) {
    const from = `${root}/${leaf}`;
    if (planned.has(from)) continue;
    try { if (!fs.statSync(mapPath(from)).isDirectory()) continue; } catch (_) { continue; }
    const show = byKey.get(showKey(leaf));
    if (!show) continue;
    const to = `${root}/${sanitizeFolderName(show.title)}`;
    if (from === to) continue;
    fixes.push({
      target: tx.listTargets()[0].name,
      show: show.title, from, to,
      reason: reasonFor(leaf),
      merge: listLocal(to) !== null,
      moves: [], conflicts: [],
      reachable: true,
    });
  }

  return { root, fixes };
}

/** Why a folder is in the plan, in words for the Settings page. */
function reasonFor(leaf) {
  const unshowable = /[\\:*?"<>|]|[. ]$/.test(leaf) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(leaf);
  return unshowable
    ? 'name Windows can\'t show — appears as a scrambled name over the share'
    : 'same show in a second folder whose name differs only in case or spacing';
}

/** Wait until Transmission reports every moved torrent in its new folder. */
async function waitForMoves(ids, to, target, timeoutMs = 5 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = await tx.listTorrents(['downloadDir'], target);
    const pending = now.filter(t => ids.has(t.id) && trim(t.downloadDir) !== to);
    if (pending.length === 0) return [];
    await sleep(1000);
  }
  const now = await tx.listTorrents(['downloadDir'], target);
  return now.filter(t => ids.has(t.id) && trim(t.downloadDir) !== to).map(t => t.id);
}

/**
 * Move one planned folder. `from` and `target` only *select* a fix from a
 * freshly computed plan; they are never used as paths themselves.
 */
async function applyFolderFix({ from, target: targetName = null, moveTimeoutMs }) {
  const { fixes } = await planFolderFixes();
  const fix = fixes.find(f => f.from === from && (!targetName || f.target === targetName));
  if (!fix) throw new Error('That folder has nothing to fix — it may already have been moved');

  const target = tx.resolveTarget(fix.target);
  const result = { from: fix.from, to: fix.to, torrentsMoved: 0, torrentsSkipped: fix.conflicts.length,
                   filesMoved: [], filesKept: [], oldFolderRemoved: false, stillMoving: [] };

  // 1. Torrent data, moved by Transmission so it keeps seeding.
  for (const m of fix.moves) {
    await tx.setTorrentLocation(m.id, fix.to, { move: true, target });
  }
  result.torrentsMoved = fix.moves.length;

  // 2. Don't touch the folder underneath a move that is still in progress.
  if (fix.moves.length > 0) {
    result.stillMoving = await waitForMoves(new Set(fix.moves.map(m => m.id)), fix.to, target, moveTimeoutMs);
    if (result.stillMoving.length > 0) {
      log.warn(`folder move "${fix.from}" → "${fix.to}": Transmission still moving ${result.stillMoving.length} torrent(s); leftovers not touched`);
      return result;
    }
  }

  // 3. Everything Transmission doesn't own follows — never overwriting.
  const fromLocal = mapPath(fix.from);
  const toLocal   = mapPath(fix.to);
  if (fix.reachable && fs.existsSync(fromLocal)) {
    if (!fs.existsSync(toLocal)) {
      fs.mkdirSync(toLocal, { recursive: true });
      // Created by this process, which may run as root; give it the old
      // folder's owner so a Samba user can still manage it.
      try { const st = fs.statSync(fromLocal); fs.chownSync(toLocal, st.uid, st.gid); } catch (_) {}
    }
    const staying = new Set(fix.conflicts.map(c => c.item.toLowerCase()));
    const present = new Set((listLocal(fix.to) || []).map(n => n.toLowerCase()));

    for (const name of fs.readdirSync(fromLocal)) {
      if (staying.has(name.toLowerCase()) || present.has(name.toLowerCase())) {
        result.filesKept.push(name);
        continue;
      }
      fs.renameSync(path.join(fromLocal, name), path.join(toLocal, name));
      result.filesMoved.push(name);
    }

    // 4. Only an empty folder is removed.
    try { fs.rmdirSync(fromLocal); result.oldFolderRemoved = true; } catch (_) {}
  }

  log.info(
    `moved show folder "${path.posix.basename(fix.from)}" → "${path.posix.basename(fix.to)}": ` +
    `${result.torrentsMoved} torrent(s), ${result.filesMoved.length} other item(s)` +
    (result.torrentsSkipped || result.filesKept.length
      ? `; left in place: ${result.torrentsSkipped} torrent(s), ${result.filesKept.length} item(s) already at the destination`
      : '') +
    (result.oldFolderRemoved ? '; old folder removed' : ''),
  );
  return result;
}

module.exports = { planFolderFixes, applyFolderFix };
