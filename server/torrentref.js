'use strict';

// How a library row names its torrent to Transmission. Pure, so anything can
// use it without loading the RPC client (and tests can pass their own).
//
// Transmission's numeric torrent id is only valid until Transmission restarts:
// it numbers torrents 1, 2, 3… in load order every time, so after torrents have
// come and gone a stored id can name a different download. The info hash never
// changes, and Transmission accepts it anywhere it takes an id.

/** A 40-hex info hash, lowercased — or null. */
const lowerHash = (h) => (typeof h === 'string' && /^[0-9a-f]{40}$/i.test(h) ? h.toLowerCase() : null);

/**
 * What to hand Transmission for a row's torrent: its hash when known, else
 * the session id it was recorded with (rows from before hashes were kept;
 * the library repair fills those in).
 */
function torrentRef(row) {
  return row?.torrent_hash || row?.torrent_id || null;
}

module.exports = { lowerHash, torrentRef };
