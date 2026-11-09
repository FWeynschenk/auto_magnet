'use strict';

// Opening an item without subtitles looks for them again, at most every 15 minutes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');

freshDb();
const os = require('../server/sources/opensubtitles');
os.configured = () => true;
os.quotaExhausted = () => false;
const { searchSubsNow } = require('../server/postprocess');

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();

test('looks again when none were found, not more than every 15 minutes', () => {
  const row = { subs_state: 'unavailable', post_processed_at: ago(600), subs_checked_at: ago(60) };
  assert.equal(searchSubsNow('episode', 1, row), true);
  assert.equal(searchSubsNow('episode', 1, { ...row, subs_checked_at: ago(5) }), false, 'checked 5 min ago');
});

test('leaves alone what has subtitles, or was never checked', () => {
  assert.equal(searchSubsNow('episode', 2, { subs_state: 'fetched', post_processed_at: ago(600) }), false);
  assert.equal(searchSubsNow('episode', 3, { subs_state: 'present', post_processed_at: ago(600) }), false);
  assert.equal(searchSubsNow('episode', 4, { subs_state: 'unavailable', post_processed_at: null }), false, 'the first check runs anyway');
});

test('not while today\'s downloads are used up', () => {
  os.quotaExhausted = () => true;
  assert.equal(searchSubsNow('episode', 5, { subs_state: 'unavailable', post_processed_at: ago(600), subs_checked_at: ago(60) }), false);
  os.quotaExhausted = () => false;
});
