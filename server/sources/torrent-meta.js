'use strict';

const crypto = require('crypto');

// Minimal bencode support — just enough to derive an infohash and tracker list
// from raw .torrent bytes. The infohash is the SHA1 of the *raw* bytes of the
// `info` dictionary, so a plain decoder isn't enough: we track byte ranges for
// the top-level keys and hash the original slice.

/** Advance past one bencoded element starting at i. Returns -1 on malformed input. */
function skipElement(buf, i) {
  const c = buf[i];
  if (c === 0x69) {                     // i<int>e
    const e = buf.indexOf(0x65, i);
    return e === -1 ? -1 : e + 1;
  }
  if (c === 0x6c || c === 0x64) {       // l...e  /  d...e
    i++;
    while (i < buf.length && buf[i] !== 0x65) {
      i = skipElement(buf, i);
      if (i === -1) return -1;
    }
    return i < buf.length ? i + 1 : -1;
  }
  const colon = buf.indexOf(0x3a, i);   // <len>:<bytes>
  if (colon === -1) return -1;
  const len = parseInt(buf.toString('latin1', i, colon), 10);
  if (!Number.isInteger(len) || len < 0) return -1;
  return colon + 1 + len;
}

function readString(buf, i) {
  const colon = buf.indexOf(0x3a, i);
  if (colon === -1) return null;
  const len = parseInt(buf.toString('latin1', i, colon), 10);
  if (!Number.isInteger(len) || len < 0) return null;
  return { value: buf.toString('utf8', colon + 1, colon + 1 + len), next: colon + 1 + len };
}

/** Map each top-level dictionary key to the [start, end) byte range of its value. */
function topLevelRanges(buf) {
  if (buf[0] !== 0x64) return null;     // not a dict — not a torrent
  const out = {};
  let i = 1;
  while (i < buf.length && buf[i] !== 0x65) {
    const key = readString(buf, i);
    if (!key) return null;
    const end = skipElement(buf, key.next);
    if (end === -1) return null;
    out[key.value] = [key.next, end];
    i = end;
  }
  return out;
}

/** Pull every bencoded string out of a byte range — used for announce-list. */
function collectStrings(buf, start, end) {
  const found = [];
  let i = start;
  while (i < end) {
    const c = buf[i];
    if (c === 0x6c || c === 0x64 || c === 0x65) { i++; continue; }
    if (c === 0x69) {
      const e = buf.indexOf(0x65, i);
      if (e === -1) break;
      i = e + 1;
      continue;
    }
    const s = readString(buf, i);
    if (!s) break;
    found.push(s.value);
    i = s.next;
  }
  return found;
}

/**
 * Extract the file list from an `info` dictionary byte range.
 * Single-file torrents carry `name` + `length`; multi-file carry `files`, a list
 * of dicts with `path` (a list of path components) and `length`.
 * Returns [{ path, length }].
 */
function parseFileList(buf, infoStart, infoEnd) {
  const info = buf.subarray(infoStart, infoEnd);
  const ranges = topLevelRanges(info);
  if (!ranges) return [];

  const name = ranges.name ? readString(info, ranges.name[0])?.value : null;

  // Single-file torrent
  if (!ranges.files) {
    if (!ranges.length) return name ? [{ path: name, length: 0 }] : [];
    const lenEnd = info.indexOf(0x65, ranges.length[0]);
    const length = lenEnd === -1 ? 0 : parseInt(info.toString('latin1', ranges.length[0] + 1, lenEnd), 10);
    return [{ path: name || '', length: Number.isFinite(length) ? length : 0 }];
  }

  // Multi-file: walk the list, reading each entry dict
  const files = [];
  const [ls, le] = ranges.files;
  let i = ls + 1; // step past the opening 'l'
  while (i < le && info[i] !== 0x65) {
    const entryEnd = skipElement(info, i);
    if (entryEnd === -1) break;
    const entry = info.subarray(i, entryEnd);
    const er = topLevelRanges(entry);
    if (er) {
      let length = 0;
      if (er.length) {
        const e = entry.indexOf(0x65, er.length[0]);
        const n = e === -1 ? NaN : parseInt(entry.toString('latin1', er.length[0] + 1, e), 10);
        if (Number.isFinite(n)) length = n;
      }
      const parts = er.path ? collectStrings(entry, er.path[0], er.path[1]) : [];
      files.push({ path: parts.join('/'), length });
    }
    i = entryEnd;
  }
  return files;
}

/**
 * Derive { infoHash, trackers, files, totalSize } from raw .torrent bytes.
 * Returns null if the buffer isn't a parseable torrent.
 */
function parseTorrent(buf) {
  let ranges;
  try { ranges = topLevelRanges(buf); } catch (_) { return null; }
  if (!ranges?.info) return null;

  const [infoStart, infoEnd] = ranges.info;
  const infoHash = crypto.createHash('sha1')
    .update(buf.subarray(infoStart, infoEnd))
    .digest('hex');

  const trackers = [];
  if (ranges.announce) {
    const a = readString(buf, ranges.announce[0]);
    if (a?.value) trackers.push(a.value);
  }
  if (ranges['announce-list']) {
    const [start, end] = ranges['announce-list'];
    for (const t of collectStrings(buf, start, end)) {
      if (/^(?:udp|https?):\/\//i.test(t) && !trackers.includes(t)) trackers.push(t);
    }
  }

  let files = [];
  try { files = parseFileList(buf, infoStart, infoEnd); } catch (_) { files = []; }
  const totalSize = files.reduce((sum, f) => sum + (f.length || 0), 0);

  return { infoHash, trackers, files, totalSize };
}

function buildMagnet(hash, title, trackers = []) {
  if (!hash) return null;
  const tr = trackers.map(t => `&tr=${encodeURIComponent(t)}`).join('');
  return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title || '')}${tr}`;
}

module.exports = { parseTorrent, buildMagnet };
