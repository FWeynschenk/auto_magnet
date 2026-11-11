'use strict';

// Smoke S01E03 played Dexter: New Blood. Its search asked the indexers by
// Smoke's ID; one ignored the ID, sent back the most-seeded S01E03 releases,
// and tagged each with the ID it was asked for. An ID match skipped every
// name check, so "Dexter.New.Blood.S01E03.Smoke.Signals" was grabbed — for
// nearly every episode, each one another show's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshDb, tmpdir } = require('./helpers');

freshDb();
const { db, settings, episodes } = require('../server/db');
const selector = require('../server/selector');
const media = require('../server/media');

const lib = tmpdir();
const SHOWS = path.join(lib, 'Series');
settings.set('shows_path', SHOWS);
settings.set('movie_path', path.join(lib, 'Movies'));
settings.set('web_prepare', 'demand');

const SMOKE = 'tt30000001';
const want = { title: 'Smoke', season: 1, episode: 3, imdbId: SMOKE, firstAirYear: 2025, countries: ['US'] };
const rel = (title, o = {}) => ({ title, magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`, seeders: 50, size: 2e9, ...o });

test('an ID the indexer echoes back never outranks a name that is another show', () => {
  const r = selector.evaluate([
    rel('Dexter.New.Blood.S01E03.Smoke.Signals.1080p.AMZN.WEBRip.DDP5.1.x264-NTb[rarbg]', { imdb_id: SMOKE, seeders: 900 }),
    rel('Smoke.S01E03.1080p.WEB.h264-GRP', { seeders: 20 }),
  ], { type: 'show', want });
  assert.deepEqual(r.accepted.map(x => x.title), ['Smoke.S01E03.1080p.WEB.h264-GRP']);
  const why = r.rejected.find(x => /Dexter/.test(x.title))._reason;
  assert.match(why, /names another show — "dexter new blood"/);
  assert.match(why, /carries this show's ID/);
});

test('an ID still helps a release whose name agrees with it', () => {
  const r = selector.evaluate([rel('Smoke.S01E03.1080p.WEB', { imdb_id: SMOKE })], { type: 'show', want });
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0]._idMatch, true);
});

// ─── The library ─────────────────────────────────────────────────────────────

function file(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); return p; }
const DEXTER_HASH = 'd1'.repeat(20), WRONG_HASH = 'e2'.repeat(20);
const probe = JSON.stringify({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' }], format: { format_name: 'mov,mp4' } });

db.prepare("INSERT INTO shows (id, tmdb_id, title) VALUES (1, 100, 'Smoke'), (2, 200, 'Dexter: New Blood')").run();
// Dexter's own episode, downloaded properly, in Dexter's folder.
const dexterFile = file(`${SHOWS}/Dexter - New Blood/Dexter.New.Blood.S01E03.Smoke.Signals.1080p.mkv`);
db.prepare(`INSERT INTO episodes (id, show_id, season, episode, status, torrent_id, torrent_hash, torrent_origin, completed_at)
  VALUES (20, 2, 1, 3, 'done', 4, ?, 'added', '2026-10-01')`).run(DEXTER_HASH);
media.rows.upsert('episode', 20, { path: dexterFile, size: 1, plan: 'direct', plan_reason: 'x', probe, item_key: 'episode:tmdb200:1:3' });

test('a release already downloaded for another show is never grabbed again for this one', () => {
  const { otherOwner } = require('../server/pipeline');
  const magnet = `magnet:?xt=urn:btih:${DEXTER_HASH}`;
  assert.equal(otherOwner(magnet, { type: 'show', tmdbId: 100 }), 'Dexter: New Blood S01E03');
  assert.equal(otherOwner(magnet, { type: 'show', tmdbId: 200 }), null, 'its own show may (a pack)');
});

test('another library show\'s release is not this show\'s, even saved in this show\'s folder', () => {
  const { fileBelongsTo, namedOtherShow } = require('../server/identity');
  const smoke3 = media.itemFor('episode', 0) || { kind: 'episode', show: { id: 1, tmdb_id: 100, title: 'Smoke' }, row: { season: 1, episode: 3 } };
  const p = `${SHOWS}/Smoke/Dexter.New.Blood.S01E03.Smoke.Signals.1080p.mkv`;
  assert.equal(fileBelongsTo(smoke3, p, [SHOWS]), 'no');
  assert.equal(namedOtherShow(smoke3, p, [SHOWS]), 'Dexter: New Blood');
  assert.equal(fileBelongsTo(smoke3, `${SHOWS}/Smoke/Smoke.S01E03.1080p.mkv`, [SHOWS]), 'yes');
});

test('repair replaces the wrong grab — and leaves Dexter\'s episode exactly as it was', async () => {
  // Smoke S01E03: auto_magnet downloaded Dexter's release into Smoke's folder for it.
  const strayFile = file(`${SHOWS}/Smoke/Dexter.New.Blood.S01E03.Smoke.Signals.1080p.mkv`);
  const wrongMagnet = `magnet:?xt=urn:btih:${WRONG_HASH}`;
  db.prepare(`INSERT INTO episodes (id, show_id, season, episode, status, magnet, torrent_id, torrent_hash, torrent_origin, release_title, completed_at)
    VALUES (10, 1, 1, 3, 'done', ?, 9, ?, 'added', 'Dexter.New.Blood.S01E03.Smoke.Signals.1080p', '2026-11-01')`).run(wrongMagnet, WRONG_HASH);
  media.rows.upsert('episode', 10, { path: strayFile, size: 1, plan: 'direct', plan_reason: 'x', probe, item_key: 'episode:tmdb100:1:3' });

  const purged = [];
  const fakeTx = {
    resolveTarget: (n) => ({ name: n || 'default' }),
    listTorrents: async () => [
      { id: 9, hashString: WRONG_HASH, name: 'Dexter.New.Blood.S01E03.Smoke.Signals.1080p', downloadDir: `${SHOWS}/Smoke`, percentDone: 1,
        files: [{ name: 'Dexter.New.Blood.S01E03.Smoke.Signals.1080p.mkv', length: 1 }] },
      { id: 4, hashString: DEXTER_HASH, name: 'Dexter.New.Blood.S01E03.Smoke.Signals.1080p', downloadDir: `${SHOWS}/Dexter - New Blood`, percentDone: 1,
        files: [{ name: 'Dexter.New.Blood.S01E03.Smoke.Signals.1080p.mkv', length: 1 }] },
    ],
    getTorrentInfo: async () => null,
    purgeTorrent: async (ref) => { purged.push(ref); if (ref === WRONG_HASH) fs.rmSync(strayFile, { force: true }); },
    setFilesUnwanted: async () => { throw new Error('nothing should be dropped from a torrent here'); },
  };
  const r = await require('../server/relink').repairLibrary({ tx: fakeTx });
  assert.equal(r.replaced, 1);
  assert.deepEqual(purged, [WRONG_HASH], 'only the stray copy in Smoke\'s folder');

  const smoke = episodes.byId(10);
  assert.equal(smoke.status, 'pending', 'looked for again');
  assert.match(smoke.last_error, /another show's release/);
  assert.ok(JSON.parse(smoke.rejected_releases).some(x => x.magnet === wrongMagnet), 'that release never again');
  assert.equal(media.rows.get('episode', 10), undefined);

  const dexter = episodes.byId(20);
  assert.equal(dexter.status, 'done');
  assert.equal(dexter.torrent_hash, DEXTER_HASH);
  assert.equal(media.rows.get('episode', 20).path, dexterFile);
  assert.ok(fs.existsSync(dexterFile), 'Dexter\'s file untouched');
});

test('Redo on an item whose link points at another item\'s file never deletes that file', async () => {
  // Smoke S01E04 wrongly recorded with Dexter's own file.
  db.prepare(`INSERT INTO episodes (id, show_id, season, episode, status, torrent_id, torrent_hash, torrent_origin, completed_at)
    VALUES (11, 1, 1, 4, 'done', 4, ?, 'duplicate', '2026-11-02')`).run(DEXTER_HASH);
  db.prepare('INSERT OR REPLACE INTO media_files (kind, item_id, path, size, plan, web_state) VALUES (?, ?, ?, 1, ?, ?)')
    .run('episode', 11, dexterFile, 'direct', 'none');
  const calls = [];
  const fakeTx = {
    resolveTarget: (n) => n, getTorrentInfo: async () => { calls.push('info'); return null; },
    purgeTorrent: async () => calls.push('purge'), setFilesUnwanted: async () => calls.push('unwanted'),
  };
  const r = await require('../server/deletion').removeDownload('episode', 11, { tx: fakeTx });
  assert.match(r.original, /Dexter: New Blood S01E03's — left in place/);
  assert.deepEqual(calls.filter(c => c !== 'info'), []);
  assert.ok(fs.existsSync(dexterFile));
  assert.equal(media.rows.get('episode', 20).path, dexterFile, 'Dexter keeps its record');
});
