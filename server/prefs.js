'use strict';

// Which audio and subtitle language each account gets.
//
// Picking Dutch subtitles, or the English audio track of a film whose default
// is dubbed, used to last one episode. Now:
//
//   - each account can list its own languages (audio, subtitles), in order;
//     empty means the server's (Settings → Subtitle languages);
//   - and what someone picks in a player is remembered for that show (or that
//     film), by language — track ids differ per file, languages don't — and
//     wins over the lists next time. Turning subtitles off is remembered too.

const { db, settings } = require('./db');

db.exec(`
  CREATE TABLE IF NOT EXISTS track_choices (
    user_id    INTEGER NOT NULL,
    scope      TEXT    NOT NULL,          -- 'show:12' or 'movie:34'
    audio_lang TEXT,
    sub_lang   TEXT,
    sub_off    INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, scope)
  );
`);
for (const sql of ['ALTER TABLE users ADD COLUMN audio_langs TEXT', 'ALTER TABLE users ADD COLUMN sub_langs TEXT']) {
  try { db.exec(sql); } catch (_) {}
}

const LANG = /^[a-z]{2,3}$/;

/** "en, NL ,xx-yy" → ['en', 'nl']; junk dropped. */
function parseLangs(s) {
  return String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(x => LANG.test(x));
}

const serverLangs = () => parseLangs(settings.get('subtitle_languages') || 'en');

/** The account's own lists, or the server's where it has none. */
function langsFor(user) {
  const row = user?.id ? db.prepare('SELECT audio_langs, sub_langs FROM users WHERE id = ?').get(user.id) : null;
  const audio = parseLangs(row?.audio_langs);
  const sub = parseLangs(row?.sub_langs);
  return { audio: audio.length ? audio : serverLangs(), sub: sub.length ? sub : serverLangs(), own: { audio, sub } };
}

function setLangs(userId, { audio, sub }) {
  db.prepare('UPDATE users SET audio_langs = ?, sub_langs = ? WHERE id = ?')
    .run(parseLangs(audio).join(',') || null, parseLangs(sub).join(',') || null, userId);
  return langsFor({ id: userId });
}

/** The scope a choice is remembered for: a whole show, or one film. */
function scopeFor(item) {
  return item.kind === 'episode' ? `show:${item.show.id}` : `movie:${item.id}`;
}

function choice(userId, scope) {
  if (!userId) return null;
  return db.prepare('SELECT audio_lang, sub_lang, sub_off FROM track_choices WHERE user_id = ? AND scope = ?').get(userId, scope) || null;
}

/** Remember what someone picked. Only the fields given change. */
function remember(userId, scope, { audio_lang, sub_lang, sub_off } = {}) {
  if (!userId) return null;
  const now = choice(userId, scope) || { audio_lang: null, sub_lang: null, sub_off: 0 };
  const next = {
    audio_lang: audio_lang === undefined ? now.audio_lang : (LANG.test(audio_lang || '') ? audio_lang : null),
    sub_lang: sub_lang === undefined ? now.sub_lang : (LANG.test(sub_lang || '') ? sub_lang : null),
    sub_off: sub_off === undefined ? now.sub_off : (sub_off ? 1 : 0),
  };
  if (sub_lang) next.sub_off = 0;   // picking a language turns subtitles back on
  db.prepare(`
    INSERT INTO track_choices (user_id, scope, audio_lang, sub_lang, sub_off) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, scope) DO UPDATE SET audio_lang = excluded.audio_lang, sub_lang = excluded.sub_lang,
      sub_off = excluded.sub_off, updated_at = datetime('now')
  `).run(userId, scope, next.audio_lang, next.sub_lang, next.sub_off);
  return next;
}

/**
 * Subtitles with `default` set for this person, and the audio languages to
 * try in order. A remembered choice first, then the account's lists.
 */
function forPlayer(user, item, subtitles) {
  const langs = langsFor(user);
  const c = choice(user?.id, scopeFor(item));
  const audio = [...new Set([c?.audio_lang, ...langs.audio].filter(Boolean))];
  let pick = null;
  if (!c?.sub_off) {
    const order = [...new Set([c?.sub_lang, ...langs.sub].filter(Boolean))];
    pick = order.map(l => subtitles.find(s => s.available && !s.forced && s.lang === l)).find(Boolean) || null;
  }
  return {
    subtitles: subtitles.map(s => ({ ...s, default: s === pick })),
    audio,
    remembered: c ? { audio: c.audio_lang, sub: c.sub_off ? 'off' : c.sub_lang } : null,
  };
}

module.exports = { parseLangs, langsFor, setLangs, scopeFor, choice, remember, forPlayer };
