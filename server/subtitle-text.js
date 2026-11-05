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

function toVtt(cues) {
  return 'WEBVTT\n\n' + cues.map(c =>
    `${formatTime(c.start, '.')} --> ${formatTime(c.end, '.')}\n${c.text.replace(/\n\n+/g, '\n')}\n`).join('\n');
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

module.exports = { parse, toSrt, toVtt, transform, parseTime, formatTime, decode };
