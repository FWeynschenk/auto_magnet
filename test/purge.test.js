'use strict';

// Removing a torrent with its data deletes the files here, for good, when this
// process can see them: the Transmission desktop apps put them in the trash.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshDb, tmpdir } = require('./helpers');

freshDb();
const tx = require('../server/transmission');

function file(p, bytes = 10) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes)); return p; }

/** A Transmission that answers from `torrent`, and records what it was asked. */
function fakeRpc(torrent, session = {}) {
  const calls = [];
  const call = async (method, args) => {
    calls.push({ method, args });
    if (method === 'torrent-get') return { torrents: torrent ? [torrent] : [] };
    if (method === 'session-get') return session;
    return {};
  };
  return { call, calls };
}

test('a pack in its own folder: files and folder deleted here, Transmission only forgets it', async () => {
  const root = tmpdir();
  const dl = path.join(root, 'Series', 'Show');
  const a = file(path.join(dl, 'Show.S01.1080p', 'Show.S01E01.mkv'));
  const b = file(path.join(dl, 'Show.S01.1080p', 'Sample', 'sample.mkv'));
  file(path.join(dl, 'Show.S01.1080p', '.DS_Store'));
  const keep = file(path.join(dl, 'Other.S01E01.mkv'));   // someone else's, beside it
  const { call, calls } = fakeRpc({ id: 3, downloadDir: dl, haveValid: 20, files: [
    { name: 'Show.S01.1080p/Show.S01E01.mkv' }, { name: 'Show.S01.1080p/Sample/sample.mkv' }, { name: 'Show.S01.1080p/Show.S01E02.mkv' },
  ] });
  const r = await tx.purgeTorrent(3, null, { call });
  assert.equal(r.deletedHere, true);
  assert.deepEqual(calls.find(c => c.method === 'torrent-remove').args, { ids: [3], 'delete-local-data': false });
  assert.ok(!fs.existsSync(a) && !fs.existsSync(b));
  assert.ok(!fs.existsSync(path.join(dl, 'Show.S01.1080p')), 'its folder goes, junk and all');
  assert.ok(fs.existsSync(keep) && fs.existsSync(dl), 'nothing else, and not the show folder');
});

test('partway: .part files and the incomplete folder are found too', async () => {
  const root = tmpdir();
  const dl = path.join(root, 'Movies');
  const inc = path.join(root, 'incomplete');
  fs.mkdirSync(dl, { recursive: true });
  const p = file(path.join(inc, 'Film.2026.mkv.part'));
  const { call } = fakeRpc({ id: 4, downloadDir: dl, haveValid: 10, files: [{ name: 'Film.2026.mkv' }] },
    { 'incomplete-dir-enabled': true, 'incomplete-dir': inc });
  assert.equal((await tx.purgeTorrent(4, null, { call })).deletedHere, true);
  assert.ok(!fs.existsSync(p));
  assert.ok(fs.existsSync(inc), 'the incomplete folder itself stays');
});

test("files this process can't see: Transmission deletes them, as before", async () => {
  // Its folder isn't here (Transmission on another machine).
  let f = fakeRpc({ id: 5, downloadDir: '/nowhere/Movies', haveValid: 10, files: [{ name: 'Film.mkv' }] });
  assert.equal((await tx.purgeTorrent(5, null, f)).deletedHere, false);
  assert.deepEqual(f.calls.find(c => c.method === 'torrent-remove').args, { ids: [5], 'delete-local-data': true });
  // Its folder is here, but none of what it downloaded is: not the same disk.
  const dl = tmpdir();
  f = fakeRpc({ id: 6, downloadDir: dl, haveValid: 10, files: [{ name: 'Film.mkv' }] });
  assert.equal((await tx.purgeTorrent(6, null, f)).deletedHere, false);
  // A name climbing out of its folder is never followed.
  f = fakeRpc({ id: 7, downloadDir: dl, haveValid: 10, files: [{ name: '../escape.mkv' }] });
  assert.equal((await tx.purgeTorrent(7, null, f)).deletedHere, false);
});

test('a path map is followed, as for playing', async () => {
  const root = tmpdir();
  const v = file(path.join(root, 'Movies', 'Film.mkv'));
  const plan = tx.localPurgePlan({ downloadDir: '/srv/media/Movies', haveValid: 10, files: [{ name: 'Film.mkv' }] }, {},
    { mapPath: (p) => p.replace('/srv/media', root) });
  assert.deepEqual(plan.files, [v]);
});
