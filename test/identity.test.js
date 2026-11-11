'use strict';

// One show playing another's episodes: Transmission renumbers its torrents
// when it restarts, rows followed those numbers, and a renumbered torrent's
// only video — another show's — was recorded as the episode's file. These
// check the name rules, that nothing takes a file on trust any more, and that
// a library already mixed up is put right.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshDb, tmpdir, hasFfmpeg, ffmpeg } = require('./helpers');

freshDb();
const { db, settings, episodes, movies } = require('../server/db');
const tx = require('../server/transmission');
const { fileBelongsTo, itemKey } = require('../server/identity');
const media = require('../server/media');

const lib = tmpdir();
const SHOWS = path.join(lib, 'Series'), MOVIES = path.join(lib, 'Movies');
settings.set('shows_path', SHOWS);
settings.set('movie_path', MOVIES);
settings.set('web_prepare', 'demand');
const R = [SHOWS, MOVIES];

const ep = (title, s, e, extra = {}) => ({ kind: 'episode', show: { id: 1, tmdb_id: 5, title, ...extra }, row: { season: s, episode: e } });
const mv = (title, year) => ({ kind: 'movie', title, year, row: {} });

test('names decide whether a file is an item\'s', () => {
  const cases = [
    [ep('Severance', 2, 3), `${SHOWS}/Severance/Severance.S02E03.1080p.WEB.mkv`, 'yes'],
    [ep('Severance', 2, 3), `${SHOWS}/The Bear/The.Bear.S02E03.1080p.mkv`, 'no'],
    [ep('Severance', 2, 3), `${SHOWS}/Severance/Severance.S02E04.mkv`, 'no'],
    [ep('Severance', 2, 3), `${SHOWS}/Severance/Severance.S02.1080p/Severance.S02E03.mkv`, 'yes'],
    [ep('Severance', 2, 3), `${SHOWS}/Severance/Severance.S02E03.1080p/abc123.mkv`, 'yes'],
    [ep('Severance', 2, 3), `${SHOWS}/Severance/S02E03.mkv`, 'yes'],
    [ep('Severance', 2, 3), '/tmp/x/S02E03.mkv', 'unknown'],
    [ep('Ghosts', 1, 2, { origin_country: 'US', first_air_year: 2021 }), `${SHOWS}/Ghosts/Ghosts.US.S01E02.mkv`, 'yes'],
    // Outside the show's own folder, the release name decides.
    [ep('Ghosts', 1, 2, { origin_country: 'US', first_air_year: 2021 }), '/downloads/Ghosts.UK.S01E02.mkv', 'no'],
    [ep('Ghosts', 1, 2, { origin_country: 'US', first_air_year: 2021 }), '/downloads/Ghosts.US.S01E02.mkv', 'yes'],
    [ep('Silo', 2, 1), '/downloads/Silo.Stories.S02E01.mkv', 'no'],
    // In it, the folder does: names can't tell a wrong grab from a hand-picked
    // spelling, and a file from another show's torrent is in that show's folder.
    [ep('Silo', 2, 1), `${SHOWS}/Silo/Silo.Stories.S02E01.mkv`, 'yes'],
    [mv('Dune', 2021), `${MOVIES}/Dune.2021.2160p/Dune.2021.2160p.mkv`, 'yes'],
    [mv('Dune', 2021), `${MOVIES}/Dune.1984/Dune.1984.mkv`, 'no'],
    [mv('Dune', 2021), `${MOVIES}/Arrival.2016/Arrival.2016.mkv`, 'no'],
    [mv('The Matrix Reloaded', 2003), `${MOVIES}/The.Matrix.1999.mkv`, 'no'],
  ];
  for (const [item, p, want] of cases) assert.equal(fileBelongsTo(item, p, R), want, p);
});

test('real naming isn\'t held against a file that is the item\'s', () => {
  const cases = [
    // A double episode is both episodes.
    [ep('Severance', 1, 2), `${SHOWS}/Severance/Severance.S01E01E02.1080p.mkv`, 'yes'],
    [ep('Severance', 1, 2), `${SHOWS}/Severance/Severance.S01E01-02.1080p.mkv`, 'yes'],
    [ep('Severance', 1, 3), `${SHOWS}/Severance/Severance.S01E01-02.1080p.mkv`, 'no'],
    // A hand-picked release under another spelling, in this show's own folder.
    [ep('Frieren: Beyond Journey\'s End', 1, 5), `${SHOWS}/Frieren - Beyond Journey's End/Sousou.no.Frieren.S01E05.mkv`, 'yes'],
    // The same release in some other folder: its name points elsewhere.
    [ep('Frieren: Beyond Journey\'s End', 1, 5), `${SHOWS}/Other/Sousou.no.Frieren.S01E05.mkv`, 'no'],
    // A film's release name is often shorter than its title.
    [mv('Star Wars: Episode IV - A New Hope', 1977), `${MOVIES}/Star.Wars.1977.1080p/Star.Wars.1977.1080p.mkv`, 'unknown'],
    [mv('Amélie', 2001), `${MOVIES}/Amelie.2001.1080p.mkv`, 'yes'],
    [mv('Some Film', 2020), `${MOVIES}/video.mkv`, 'unknown'],
  ];
  for (const [item, p, want] of cases) assert.equal(fileBelongsTo(item, p, R), want, p);
});

test('item keys are names, not row ids', () => {
  assert.equal(itemKey(ep('Severance', 2, 3)), 'episode:tmdb5:2:3');
  assert.equal(itemKey({ kind: 'movie', title: 'Dune', year: 2021, row: { tmdb_id: 438631 } }), 'movie:tmdb438631');
});

test('a torrent\'s only video is not taken for an episode unless it names it', () => {
  const item = ep('Severance', 2, 3);
  const bear = [{ name: 'The.Bear.S02E03.1080p.mkv', length: 1e9 }];
  assert.equal(media.pickFile(bear, item, { dir: `${SHOWS}/The Bear` }), null);
  const own = [{ name: 'Severance.S02E03.1080p.mkv', length: 1e9 }];
  assert.equal(media.pickFile(own, item, { dir: `${SHOWS}/Severance` }).name, own[0].name);
  // In a pack, never "the largest file" when this episode isn't in it.
  const pack = [{ name: 'Severance.S02E01.mkv', length: 9e9 }, { name: 'Severance.S02E02.mkv', length: 1e9 }];
  assert.equal(media.pickFile(pack, item, { dir: `${SHOWS}/Severance` }), null);
  // Known by hash (certainly its torrent): a name that says nothing is fine.
  const bare = [{ name: 'video.mkv', length: 1e9 }];
  assert.equal(media.pickFile(bare, item, { dir: '/tmp/x' }), null);
  assert.equal(media.pickFile(bare, item, { dir: '/tmp/x', trusted: true }).name, 'video.mkv');
});

// ─── The library, already mixed up ───────────────────────────────────────────

function file(p, bytes = 10) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes));
  return p;
}

// A real (tiny) video, for the files a test then plays.
let sample = null;
function video(p) {
  if (!sample) {
    sample = path.join(tmpdir(), 'sample.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=d=1:s=160x120:r=10', '-f', 'lavfi', '-i', 'sine=d=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sample]);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.copyFileSync(sample, p);
  return p;
}
const needsFfmpeg = { skip: !hasFfmpeg && 'ffmpeg not installed' };
const probe = JSON.stringify({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' }], format: { format_name: 'mov,mp4' } });

db.prepare("INSERT INTO shows (id, tmdb_id, title) VALUES (1, 5, 'Severance'), (2, 6, 'The Bear')").run();

test('repair: an episode linked to another show\'s file is put back on its own torrent', needsFfmpeg, async () => {
  const bearFile = file(`${SHOWS}/The Bear/The.Bear.S02E03.1080p.mkv`);
  const ownFile = video(`${SHOWS}/Severance/Severance.S02E03.1080p.mkv`);
  // The wrongly fetched subtitles, beside The Bear's video.
  const srt = file(bearFile.replace(/\.mkv$/, '.en.srt'));
  db.prepare(`INSERT INTO episodes (id, show_id, season, episode, status, torrent_id, completed_at, post_processed_at, subs_state)
    VALUES (10, 1, 2, 3, 'done', 57, '2026-11-01', '2026-11-01', 'fetched'),
           (11, 2, 2, 3, 'done', 60, '2026-11-01', '2026-11-01', 'present')`).run();
  // Severance S02E03 was recorded as The Bear's file; The Bear's own row too.
  media.rows.upsert('episode', 10, { path: bearFile, size: 10, plan: 'direct', plan_reason: 'x', probe });
  media.rows.upsert('episode', 11, { path: bearFile, size: 10, plan: 'direct', plan_reason: 'x', probe, item_key: 'episode:tmdb6:2:3' });

  const fakeTx = {
    resolveTarget: (n) => ({ name: n || 'default' }),
    listTorrents: async () => [
      { id: 57, hashString: 'aa'.repeat(20), name: 'The.Bear.S02E03.1080p', downloadDir: `${SHOWS}/The Bear`, percentDone: 1,
        files: [{ name: 'The.Bear.S02E03.1080p.mkv', length: 10 }] },
      { id: 12, hashString: 'bb'.repeat(20), name: 'Severance.S02E03.1080p', downloadDir: `${SHOWS}/Severance`, percentDone: 1,
        files: [{ name: 'Severance.S02E03.1080p.mkv', length: 10 }] },
    ],
  };
  const r = await require('../server/relink').repairLibrary({ tx: fakeTx });
  assert.equal(r.dropped, 1, 'Severance\'s wrong link dropped');
  assert.equal(r.relinked, 1);

  const sev = episodes.byId(10);
  assert.equal(sev.torrent_hash, 'bb'.repeat(20), 'follows its own torrent by hash');
  assert.equal(sev.torrent_id, 12);
  assert.equal(sev.post_processed_at, null, 'its checks run again, on its own file');
  assert.equal(media.rows.get('episode', 10), undefined);
  // The Bear keeps its file; the subtitles fetched for Severance beside it are moved aside.
  assert.equal(media.rows.get('episode', 11)?.path, undefined, 'its web version, carrying them, is redone');
  assert.ok(!fs.existsSync(srt) && fs.existsSync(`${srt}.mixed-up.bak`));
  assert.equal(episodes.byId(11).subs_state, 'pending', 'The Bear fetches its own subtitles');

  // Playing Severance now finds Severance.
  const located = await media.locate('episode', 10);
  assert.equal(located.path, ownFile);
  assert.equal(located.item_key, 'episode:tmdb5:2:3');
});

test('a reused row id never inherits the old item\'s file', needsFfmpeg, async () => {
  // Episode 20 was another show's; its file record stayed. A new episode now has id 20.
  const old = file(`${SHOWS}/The Bear/The.Bear.S01E01.mkv`);
  const mine = video(`${SHOWS}/Severance/Severance.S01E01.mkv`);
  db.prepare("INSERT INTO episodes (id, show_id, season, episode, status) VALUES (20, 1, 1, 1, 'done')").run();
  media.rows.upsert('episode', 20, { path: old, size: 10, plan: 'direct', plan_reason: 'x', probe, item_key: 'episode:tmdb6:1:1' });
  const r = await media.locate('episode', 20);
  assert.equal(r.path, mine);
});

test('post-processing never judges — or deletes — a torrent that turned out to be another show\'s', async () => {
  file(`${SHOWS}/The Bear/The.Bear.S04E01.mkv`);
  db.prepare(`INSERT INTO episodes (id, show_id, season, episode, status, torrent_id, torrent_origin, completed_at)
    VALUES (30, 1, 1, 9, 'done', 88, 'added', '2026-11-10')`).run();
  const purged = [];
  const saved = { info: tx.getTorrentInfo, purge: tx.purgeTorrent, list: tx.listTorrents };
  tx.getTorrentInfo = async () => ({ id: 88, hash: 'cc'.repeat(20), name: 'The.Bear.S04E01', downloadDir: `${SHOWS}/The Bear`, percentDone: 1,
    files: [{ name: 'The.Bear.S04E01.mkv', length: 10 }] });
  tx.purgeTorrent = async (ref) => { purged.push(ref); };
  tx.listTorrents = async () => [];
  try {
    await require('../server/postprocess').postProcessCompleted();
  } finally {
    Object.assign(tx, { getTorrentInfo: saved.info, purgeTorrent: saved.purge, listTorrents: saved.list });
  }
  assert.deepEqual(purged, [], 'The Bear\'s download is left alone');
  assert.equal(media.rows.get('episode', 30), undefined, 'and not recorded as Severance S01E09');
  assert.match(episodes.byId(30).last_error, /Lost track of its download/);
});

test('removing a show takes what the library made from its episodes with it', async () => {
  const f = file(`${SHOWS}/Gone Show/Gone.Show.S01E01.mkv`);
  db.prepare("INSERT INTO shows (id, tmdb_id, title) VALUES (9, 99, 'Gone Show')").run();
  db.prepare("INSERT INTO episodes (id, show_id, season, episode, status) VALUES (40, 9, 1, 1, 'done')").run();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'u', 'x')").run();
  media.rows.upsert('episode', 40, { path: f, size: 10, plan: 'direct', plan_reason: 'x', probe });
  db.prepare("INSERT INTO playback_progress (user_id, kind, item_id, position, updated_at) VALUES (1, 'episode', 40, 100, '2026-11-01')").run();
  const router = require('../server/api/shows');
  const layer = router.stack.find(l => l.route?.path === '/:id' && l.route.methods.delete);
  await new Promise((resolve) => layer.route.stack[0].handle({ params: { id: '9' } }, { sendStatus: resolve }));
  assert.equal(media.rows.get('episode', 40), undefined);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM playback_progress WHERE item_id = 40").get().n, 0);
  assert.ok(fs.existsSync(f), 'the video file itself stays');
  void movies;
});
