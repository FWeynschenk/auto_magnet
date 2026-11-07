'use strict';

// Each account's languages, and what it picked last time for a show.

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');

freshDb();
const { db, settings } = require('../server/db');
const prefs = require('../server/prefs');

settings.set('subtitle_languages', 'en');
db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1, 'ann', 'x'), (2, 'bob', 'x')").run();
const ann = { id: 1 }, bob = { id: 2 };
const ep = { kind: 'episode', id: 7, show: { id: 3 } };
const ep2 = { kind: 'episode', id: 8, show: { id: 3 } };
const film = { kind: 'movie', id: 9 };
const subs = [
  { id: 'a', lang: 'en', available: true },
  { id: 'b', lang: 'nl', available: true },
  { id: 'c', lang: 'nl', available: true, forced: true },
  { id: 'd', lang: 'de', available: false },
];
const def = (r) => r.subtitles.find(s => s.default)?.id ?? null;

test('without anything set, the server languages decide', () => {
  const r = prefs.forPlayer(ann, ep, subs);
  assert.equal(def(r), 'a');
  assert.deepEqual(r.audio, ['en']);
  assert.equal(r.remembered, null);
});

test("an account's own languages win over the server's, for that account only", () => {
  prefs.setLangs(1, { audio: 'en, ja', sub: 'nl,EN,xx-yy' });
  assert.deepEqual(prefs.langsFor(ann).own, { audio: ['en', 'ja'], sub: ['nl', 'en'] });
  assert.equal(def(prefs.forPlayer(ann, ep, subs)), 'b', 'Dutch, and not the forced-only track');
  assert.equal(def(prefs.forPlayer(bob, ep, subs)), 'a');
});

test('a pick is remembered for the whole show, by language; off is remembered too', () => {
  prefs.remember(2, prefs.scopeFor(ep), { sub_lang: 'nl', audio_lang: 'ja' });
  const r = prefs.forPlayer(bob, ep2, subs);
  assert.equal(def(r), 'b', 'next episode, same language');
  assert.deepEqual(r.audio, ['ja', 'en']);
  assert.deepEqual(r.remembered, { audio: 'ja', sub: 'nl' });

  prefs.remember(2, prefs.scopeFor(ep), { sub_off: true });
  assert.equal(def(prefs.forPlayer(bob, ep2, subs)), null);
  assert.deepEqual(prefs.forPlayer(bob, ep2, subs).audio, ['ja', 'en'], 'audio untouched by a subtitle change');

  prefs.remember(2, prefs.scopeFor(ep), { sub_lang: 'en' });
  assert.equal(def(prefs.forPlayer(bob, ep2, subs)), 'a', 'choosing a language turns them back on');
  assert.equal(def(prefs.forPlayer(bob, film, subs)), 'a', 'a film is its own scope');
  assert.equal(def(prefs.forPlayer(ann, ep2, subs)), 'b', "one account's pick isn't another's");
});

test('a remembered language that this file lacks falls back to the lists', () => {
  prefs.remember(2, prefs.scopeFor(film), { sub_lang: 'fr' });
  assert.equal(def(prefs.forPlayer(bob, film, subs)), 'a');
  assert.equal(prefs.remember(null, 'movie:1', { sub_lang: 'en' }), null, 'the API token remembers nothing');
});
