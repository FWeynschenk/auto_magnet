'use strict';

// Plain-text subtitle formats: SRT and WebVTT. Parsing, writing, and the two
// transforms syncing needs (shift and stretch). Pure functions, no I/O.
//
// Browsers only accept WebVTT in a <track>, so every SRT is converted on the
// way out; everything else (ASS, embedded tracks) goes through ffmpeg.

/** "01:02:03,456" or "02:03.456" → milliseconds, or NaN. */
function parseTime(s) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(String(s).trim());
  if (!m) return NaN;
  const [, h = '0', min, sec, frac] = m;
  return ((Number(h) * 60 + Number(min)) * 60 + Number(sec)) * 1000 + Number(frac.padEnd(3, '0'));
}

function formatTime(ms, sep) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor(t / 60000) % 60;
  const s = Math.floor(t / 1000) % 60;
  const f = t % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`;
}

const TIMING = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)(.*)$/;

/**
 * Cues from SRT or VTT text: [{ start, end, text }] in milliseconds.
 * Tolerant of what real files contain: a BOM, CRLF, missing index numbers,
 * blank lines inside a cue's text, and VTT cue settings after the timing.
 */
function parse(text) {
  const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const cues = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = TIMING.exec(line);
    if (m) {
      const start = parseTime(m[1]), end = parseTime(m[2]);
      if (Number.isFinite(start) && Number.isFinite(end)) {
        if (cur) cues.push(cur);
        cur = { start, end, text: [] };
        // A preceding bare number was this cue's index, not text of the last one.
        const prev = cues[cues.length - 1];
        if (prev && prev.text.length && /^\d+$/.test(prev.text[prev.text.length - 1].trim())) prev.text.pop();
        continue;
      }
    }
    if (!cur) continue; // header (WEBVTT, NOTE, STYLE) or junk before the first cue
    cur.text.push(line);
  }
  if (cur) cues.push(cur);
  return cues
    .map(c => ({ start: c.start, end: c.end, text: c.text.join('\n').replace(/\n+$/, '').replace(/^\n+/, '') }))
    .filter(c => c.text.trim() && c.end > c.start)
    .sort((a, b) => a.start - b.start);
}

function toSrt(cues) {
  return cues.map((c, i) =>
    `${i + 1}\n${formatTime(c.start, ',')} --> ${formatTime(c.end, ',')}\n${c.text}\n`).join('\n');
}

// ─── SRT text → WebVTT cue text ───────────────────────────────────────────────
//
// SRT has no formal markup, but real files carry two kinds: HTML-ish tags
// (<i>, <b>, <font color=…>) and ASS override blocks ({\an8}, {\i1}, {\pos(…)})
// that desktop players such as VLC and mpv understand. A browser knows
// neither ASS nor <font> and prints whatever it doesn't understand, so
// "{\an8}" would show on screen. Each is translated to what WebVTT can say,
// or dropped.

// {\anN}: numpad layout — 7 8 9 top, 4 5 6 middle, 1 2 3 bottom.
const AN = {
  1: ['bottom', 'left'], 2: ['bottom', 'center'], 3: ['bottom', 'right'],
  4: ['middle', 'left'], 5: ['middle', 'center'], 6: ['middle', 'right'],
  7: ['top', 'left'],    8: ['top', 'center'],    9: ['top', 'right'],
};
// Legacy SSA {\aN}: 1-3 bottom, 5-7 top, 9-11 middle.
const SSA_A = { 1: 1, 2: 2, 3: 3, 5: 7, 6: 8, 7: 9, 9: 4, 10: 5, 11: 6 };
const VTT_TAGS = new Set(['i', 'b', 'u']);

/** Cue settings for a placement, '' for the default (bottom centre). */
function placement(an) {
  const [v, h] = AN[an] || AN[2];
  const out = [];
  if (v === 'top') out.push('line:5%');
  else if (v === 'middle') out.push('line:50%,center');
  if (h === 'left') out.push('position:5%', 'align:left');
  else if (h === 'right') out.push('position:95%', 'align:right');
  return out.join(' ');
}

function escapeText(t) {
  return t.replace(/&(?!(?:amp|lt|gt|nbsp|lrm|rlm|#\d+|#x[0-9a-f]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * One cue's SRT text as WebVTT: { text, settings }.
 */
function vttCue(raw) {
  let an = null;
  // ASS override blocks: keep position and i/b/u, drop everything else.
  let text = String(raw).replace(/\{([^}]*)\}/g, (_m, body) => {
    if (!body.includes('\\')) return ''; // "{...}" without a tag: a comment
    let tags = '';
    for (const [, name, arg] of body.matchAll(/\\([a-z]+)([^\\]*)/gi)) {
      const n = name.toLowerCase();
      if (n === 'an' && AN[parseInt(arg, 10)]) an ??= parseInt(arg, 10);
      else if (n === 'a' && SSA_A[parseInt(arg, 10)]) an ??= SSA_A[parseInt(arg, 10)];
      else if (VTT_TAGS.has(n) && /^[01]$/.test(arg.trim())) tags += arg.trim() === '1' ? `<${n}>` : `</${n}>`;
    }
    return tags;
  });
  text = text.replace(/\\N|\\n/g, '\n').replace(/\\h/g, '\u00a0');

  // Tags: <i> <b> <u> survive (normalised), anything else (<font>, <span>) goes.
  let out = '', last = 0;
  for (const m of text.matchAll(/<(\/?)([a-z]+)(?:\s[^<>]*)?>/gi)) {
    out += escapeText(text.slice(last, m.index));
    const name = m[2].toLowerCase();
    if (VTT_TAGS.has(name)) out += `<${m[1]}${name}>`;
    last = m.index + m[0].length;
  }
  out += escapeText(text.slice(last));

  return {
    // A blank line would end the cue early.
    text: out.split('\n').map(l => l.trimEnd()).filter(l => l.trim()).join('\n'),
    settings: an ? placement(an) : '',
  };
}

function toVtt(cues) {
  return 'WEBVTT\n\n' + cues.map(c => ({ c, v: vttCue(c.text) })).filter(({ v }) => v.text).map(({ c, v }) =>
    `${formatTime(c.start, '.')} --> ${formatTime(c.end, '.')}${v.settings ? ` ${v.settings}` : ''}\n${v.text}\n`).join('\n');
}

/**
 * One cue where a file has the same line twice at once. ASS subtitles often
 * draw each line on two layers (one for the outline or shadow), and a release
 * can stack the same dialogue in two styles; converted, both show, one above
 * the other. Overlapping cues with the same text become one, spanning both.
 */
function dedupe(cues) {
  const key = (t) => String(t).replace(/\{[^}]*\}|<[^>]*>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const out = [];
  const open = new Map();   // text → the last cue kept with it
  for (const c of [...cues].sort((a, b) => a.start - b.start)) {
    const k = key(c.text);
    const prev = open.get(k);
    if (prev && c.start < prev.end) {
      prev.end = Math.max(prev.end, c.end);
      continue;
    }
    const kept = { ...c };
    out.push(kept);
    open.set(k, kept);
  }
  return out;
}

/** t → t·ratio + offset, for every cue. Cues pushed before zero are dropped. */
function transform(cues, { offsetMs = 0, ratio = 1 } = {}) {
  return cues
    .map(c => ({ ...c, start: c.start * ratio + offsetMs, end: c.end * ratio + offsetMs }))
    .filter(c => c.end > 0)
    .map(c => ({ ...c, start: Math.max(0, c.start) }));
}

/**
 * Text from a subtitle file's bytes. Most are UTF-8; older ones are often
 * Windows-1252, which isn't valid UTF-8 — decode those as such rather than
 * showing replacement characters.
 */
function decode(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (_) {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

module.exports = { parse, toSrt, toVtt, vttCue, transform, dedupe, parseTime, formatTime, decode };
