'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb } = require('./helpers');

freshDb();
const media = require('../server/media');
const progress = require('../server/progress');
const { db } = require('../server/db');

const v = (o = {}) => ({ index: 0, codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', height: 1080, ...o });
const a = (o = {}) => ({ index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, ...o });
const mp4 = { format_name: 'mov,mp4,m4a,3gp,3g2,mj2' };
const mkv = { format_name: 'matroska,webm' };

// ─── Plan ────────────────────────────────────────────────────────────────────

test('MP4 with H.264 and AAC plays directly', () => {
  assert.equal(media.planFor({ streams: [v(), a()], format: mp4 }).plan, 'direct');
});

test('MKV, or audio a browser can\'t decode, is remuxed — video untouched', () => {
  assert.deepEqual(media.planFor({ streams: [v(), a()], format: mkv }), { plan: 'remux', reason: 'MKV container' });
  assert.equal(media.planFor({ streams: [v(), a({ codec_name: 'dts' })], format: mp4 }).reason, 'DTS audio');
  assert.equal(media.planFor({ streams: [v(), a({ codec_name: 'eac3' })], format: mkv }).plan, 'remux');
});

test('a preferred audio track that isn\'t first needs a remux, even in MP4', () => {
  const streams = [v(), a({ index: 1, tags: { language: 'ger' }, disposition: { default: 1 } }), a({ index: 2, tags: { language: 'eng' } })];
  const r = media.planFor({ streams, format: mp4 }, ['en']);
  assert.equal(r.plan, 'remux');
  assert.match(r.reason, /first track/);
});

test('an MP4 with several ordinary audio tracks gets a web version, but plays as it is meanwhile', () => {
  const two = { streams: [v(), a({ index: 1, tags: { language: 'eng' } }), a({ index: 2, tags: { language: 'dut' } })], format: mp4 };
  const r = media.planFor(two, ['en']);
  assert.equal(r.plan, 'remux');
  assert.match(r.reason, /2 audio tracks/);
  assert.equal(media.planFor(two, ['en'], { multiAudio: false }).plan, 'direct');
  // Commentary or audio description alone doesn't justify a second copy.
  const extra = { streams: [v(), a({ index: 1 }), a({ index: 2, tags: { title: 'Commentary' } }), a({ index: 3, disposition: { visual_impaired: 1 } })], format: mp4 };
  assert.equal(media.planFor(extra, ['en']).plan, 'direct');
});

test('files planned as direct before that rule are re-planned from the stored probe', () => {
  const { settings } = require('../server/db');
  settings.set('web_prepare', 'demand'); // re-plan only; don't start encoding nonexistent files
  const probe = (streams) => JSON.stringify({ streams, format: mp4 });
  media.rows.upsert('movie', 901, { path: '/x/two.mp4', size: 1, plan: 'direct', plan_reason: 'plays as it is',
    probe: probe([v(), a({ index: 1, tags: { language: 'eng' } }), a({ index: 2, tags: { language: 'fre' } })]) });
  media.rows.upsert('movie', 902, { path: '/x/one.mp4', size: 1, plan: 'direct', plan_reason: 'plays as it is', probe: probe([v(), a()]) });
  assert.equal(media.replanStored(), 1);
  const two = media.rows.get('movie', 901);
  assert.equal(two.plan, 'remux');
  assert.equal(media.playsAsIs(two), true, 'still served as it is until the web version is ready');
  assert.equal(media.rows.get('movie', 902).plan, 'direct');
  assert.equal(media.replanStored(), 0, 'once');
  assert.equal(media.playsAsIs({ ...two, original_removed_at: 'x' }), false);
  assert.equal(media.playsAsIs({ ...two, probe: probe([v({ codec_name: 'hevc' }), a()]), plan: 'transcode' }), false);
  settings.set('web_prepare', 'complete');
});

test('HEVC, 10-bit and HDR are transcoded', () => {
  assert.match(media.planFor({ streams: [v({ codec_name: 'hevc' }), a()], format: mkv }).reason, /HEVC/);
  assert.equal(media.planFor({ streams: [v({ pix_fmt: 'yuv420p10le' }), a()], format: mp4 }).reason, '10-bit video');
  assert.match(media.planFor({ streams: [v({ color_transfer: 'smpte2084' }), a()], format: mp4 }).reason, /HDR/);
});

test('a file without video is unplayable; cover art is not video', () => {
  assert.equal(media.planFor({ streams: [a()], format: mp4 }).plan, 'unplayable');
  assert.equal(media.planFor({ streams: [v({ disposition: { attached_pic: 1 } }), a()], format: mp4 }).plan, 'unplayable');
});

test('audio choice skips commentary and audio description and prefers the wanted language', () => {
  const streams = [
    a({ index: 1, tags: { language: 'eng', title: 'Director\'s Commentary' } }),
    a({ index: 2, tags: { language: 'eng' }, disposition: { visual_impaired: 1 } }),
    a({ index: 3, tags: { language: 'fre' }, disposition: { default: 1 } }),
    a({ index: 4, tags: { language: 'eng' } }),
  ];
  assert.equal(media.chooseAudio(streams, ['en']).index, 4);
  assert.equal(media.chooseAudio(streams, ['nl']).index, 3, 'no Dutch: falls back to the default track');
});

// ─── Encode arguments ────────────────────────────────────────────────────────

const args = (o) => media.buildEncodeArgs({ input: '/in.mkv', maxHeight: 1080, wanted: ['en'], ...o });

test('remux copies the video and converts only the audio', () => {
  const x = args({ plan: 'remux', encoder: 'copy', info: { streams: [v(), a({ codec_name: 'ac3', channels: 6 })] } });
  assert.deepEqual(x.slice(x.indexOf('-c:v'), x.indexOf('-c:v') + 2), ['-c:v', 'copy']);
  assert.deepEqual(x.slice(x.indexOf('-c:a:0'), x.indexOf('-c:a:0') + 6), ['-c:a:0', 'aac', '-ac:a:0', '2', '-b:a:0', '192k']);
  assert.ok(!x.includes('-vf'));
  assert.equal(x.at(-1), '%v/index.m3u8', 'relative: ffmpeg runs in the output folder');
  assert.ok(x.includes('event') && x.includes('fmp4'), 'growing fMP4 HLS playlist');
});

test('stereo AAC is copied rather than re-encoded', () => {
  const x = args({ plan: 'remux', encoder: 'copy', info: { streams: [v(), a()] } });
  assert.deepEqual(x.slice(x.indexOf('-c:a:0'), x.indexOf('-c:a:0') + 2), ['-c:a:0', 'copy']);
});

test('every audio track is mapped, the preferred one first, each in its own rendition', () => {
  const streams = [v(),
    a({ index: 1, codec_name: 'ac3', channels: 6, tags: { language: 'ger' }, disposition: { default: 1 } }),
    a({ index: 2, tags: { language: 'eng' } }),
    a({ index: 3, tags: { language: 'eng', title: 'Director\'s Commentary' } })];
  const x = args({ plan: 'remux', encoder: 'copy', info: { streams } });
  const maps = x.flatMap((s, i) => (s === '-map' ? [x[i + 1]] : []));
  assert.deepEqual(maps, ['0:0', '0:2', '0:1', '0:3']);
  assert.equal(x[x.indexOf('-var_stream_map') + 1],
    'v:0,agroup:aud,name:v a:0,agroup:aud,name:a0 a:1,agroup:aud,name:a1 a:2,agroup:aud,name:a2');
  assert.deepEqual(x.slice(x.indexOf('-c:a:1'), x.indexOf('-c:a:1') + 2), ['-c:a:1', 'aac'], 'the 5.1 AC-3 becomes AAC');
  assert.deepEqual(x.slice(x.indexOf('-c:a:0'), x.indexOf('-c:a:0') + 2), ['-c:a:0', 'copy']);
});

test('the master playlist names each track and marks the default', () => {
  const r = media.audioRenditions([v(),
    a({ index: 1, tags: { language: 'eng' } }),
    a({ index: 2, tags: { language: 'dut' } }),
    a({ index: 3, tags: { language: 'eng' }, disposition: { visual_impaired: 1 } }),
    a({ index: 4, tags: { language: 'eng', title: 'Commentary "with" cast' } }),
    a({ index: 5, tags: { language: 'dut' } })], ['en']);
  assert.deepEqual(r.map(x => x.name),
    ['English', 'Dutch', 'English — audio description', 'English — Commentary with cast', 'Dutch (2)']);
  const m = media.masterPlaylist({ renditions: r, bandwidth: 8_000_000 });
  const lines = m.split('\n');
  assert.match(lines[3], /^#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="a0\/index\.m3u8"$/);
  assert.match(lines[5], /DEFAULT=NO,AUTOSELECT=NO,CHARACTERISTICS="public\.accessibility\.describes-video",URI="a2/);
  assert.match(lines[6], /AUTOSELECT=NO,URI="a3/, 'commentary is never picked automatically');
  assert.ok(m.includes('#EXT-X-STREAM-INF:BANDWIDTH=8200000,AUDIO="aud"\nv/index.m3u8'));
  assert.ok(!media.masterPlaylist({ renditions: [], bandwidth: 1 }).includes('AUDIO='), 'a silent file has no audio group');
});

test('4K HEVC is scaled down and encoded on the GPU', () => {
  const x = args({ plan: 'transcode', encoder: 'vaapi', info: { streams: [v({ codec_name: 'hevc', height: 2160 }), a()] } });
  assert.ok(x.includes('h264_vaapi'));
  assert.ok(x.indexOf('-init_hw_device') < x.indexOf('-i'), 'device set up before the input');
  assert.match(x[x.indexOf('-vf') + 1], /^scale=-2:1080,format=nv12,hwupload$/);
});

test('with GPU decoding, frames stay on the GPU from decoder to encoder', () => {
  const uhd = v({ codec_name: 'hevc', pix_fmt: 'yuv420p10le', width: 3840, height: 2160 });
  const x = args({ plan: 'transcode', encoder: 'vaapi', hwDecode: true, info: { streams: [uhd, a()] } });
  const at = (s) => x.indexOf(s);
  assert.ok(at('-init_hw_device') < at('-hwaccel') && at('-hwaccel') < at('-i'), 'device, then decoder, then input');
  assert.deepEqual(x.slice(at('-hwaccel'), at('-hwaccel') + 6),
    ['-hwaccel', 'vaapi', '-hwaccel_device', 'va', '-hwaccel_output_format', 'vaapi']);
  assert.equal(x[at('-vf') + 1], 'scale_vaapi=w=1920:h=1080:format=nv12', 'scaled and made 8-bit on the GPU');
  assert.ok(x.includes('h264_vaapi'));

  const hd = args({ plan: 'transcode', encoder: 'vaapi', hwDecode: true,
    info: { streams: [v({ codec_name: 'hevc', width: 1920, height: 1080 }), a()] } });
  assert.equal(hd[hd.indexOf('-vf') + 1], 'scale_vaapi=format=nv12', 'no resize when it fits');

  // A 2.39:1 film keeps its shape, with an even width.
  const scope = args({ plan: 'transcode', encoder: 'vaapi', hwDecode: true,
    info: { streams: [v({ codec_name: 'av1', width: 3840, height: 1606 }), a()] } });
  assert.equal(scope[scope.indexOf('-vf') + 1], 'scale_vaapi=w=2582:h=1080:format=nv12');
});

test('GPU-decoded HDR comes down to the CPU once, for tone mapping at 1080p', () => {
  const hdr = v({ codec_name: 'hevc', pix_fmt: 'yuv420p10le', width: 3840, height: 2160, color_transfer: 'smpte2084' });
  const x = args({ plan: 'transcode', encoder: 'vaapi', hwDecode: true, info: { streams: [hdr, a()] } });
  assert.equal(x[x.indexOf('-vf') + 1], 'hwdownload,format=p010le,zscale=w=1920:h=1080:t=linear:npl=100,'
    + 'format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=nv12,hwupload');
});

test('what the GPU cannot decode is decoded on the CPU, and only encoded on the GPU', () => {
  const hi10 = v({ codec_name: 'h264', pix_fmt: 'yuv420p10le', width: 1920 });
  assert.equal(media.gpuDecodable(hi10), false, 'no hardware decodes 10-bit H.264');
  assert.equal(media.gpuDecodable(v({ codec_name: 'hevc', pix_fmt: 'yuv422p10le', width: 1920 })), false);
  assert.equal(media.gpuDecodable(v({ codec_name: 'hevc' })), false, 'width unknown: cannot size the scaler');
  assert.equal(media.gpuDecodable(v({ codec_name: 'hevc', pix_fmt: 'yuv420p10le', width: 1920 })), true);
  const x = args({ plan: 'transcode', encoder: 'vaapi', hwDecode: true, info: { streams: [hi10, a()] } });
  assert.ok(!x.includes('-hwaccel'));
  assert.equal(x[x.indexOf('-vf') + 1], 'format=nv12,hwupload');
  const cpu = args({ plan: 'transcode', encoder: 'x264', hwDecode: true,
    info: { streams: [v({ codec_name: 'hevc', width: 1920 }), a()] } });
  assert.ok(!cpu.includes('-hwaccel') && cpu.includes('libx264'), 'libx264 never decodes on the GPU');
});

test('HDR is tone-mapped; CPU path uses libx264 with forced keyframes per segment', () => {
  const x = args({ plan: 'transcode', encoder: 'x264', info: { streams: [v({ codec_name: 'hevc', color_transfer: 'smpte2084' }), a()] } });
  assert.ok(x.includes('libx264'));
  assert.match(x[x.indexOf('-vf') + 1], /tonemap=tonemap=hable/);
  assert.match(x[x.indexOf('-force_key_frames') + 1], /n_forced\*6/);
});

test('subtitle-only and silent files map only what exists', () => {
  const x = args({ plan: 'transcode', encoder: 'x264', info: { streams: [v({ codec_name: 'mpeg4' })] } });
  assert.ok(x.includes('-an'));
  assert.equal(x.filter(s => s === '-map').length, 1);
  assert.equal(x[x.indexOf('-var_stream_map') + 1], 'v:0,name:v');
});

test('a first fragment written into the init segment is moved back into segment 0', () => {
  const fs = require('fs');
  const path = require('path');
  const box = (type, n = 8) => { const b = Buffer.alloc(n); b.writeUInt32BE(n); b.write(type, 4, 'latin1'); return b; };
  const dirV = path.join(media.webDir('movie', 77), 'v');
  fs.mkdirSync(dirV, { recursive: true });
  fs.writeFileSync(path.join(media.webDir('movie', 77), 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv/index.m3u8\n');
  fs.writeFileSync(path.join(dirV, 'index.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init_0.mp4"\n#EXTINF:6,\nseg_00000.m4s\n#EXT-X-ENDLIST\n');
  const tail = Buffer.concat([box('sidx', 20), box('moof', 30), box('mdat', 100)]);
  fs.writeFileSync(path.join(dirV, 'init_0.mp4'), Buffer.concat([box('ftyp', 16), box('moov', 40), tail]));
  fs.writeFileSync(path.join(dirV, 'seg_00000.m4s'), box('styp', 24));

  assert.equal(media.repairInitSegments('movie', 77), 1);
  const types = (f) => media.mp4Boxes(fs.readFileSync(path.join(dirV, f))).map(b => b.type);
  assert.deepEqual(types('init_0.mp4'), ['ftyp', 'moov']);
  assert.deepEqual(types('seg_00000.m4s'), ['styp', 'sidx', 'moof', 'mdat']);
  assert.equal(media.repairInitSegments('movie', 77), 0, 'a correct one is left alone');
});

test('language from subtitle filenames', () => {
  assert.equal(media.langFromName('Show.S01E02.en.srt'), 'en');
  assert.equal(media.langFromName('2_English.srt'), 'en');
  assert.equal(media.langFromName('Film.2020.NL.forced.srt'), 'nl');
  assert.equal(media.langFromName('Film.2020.srt'), null);
});

// ─── Progress ────────────────────────────────────────────────────────────────

db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'u', 'x', 'viewer'), (2, 'v', 'x', 'viewer')").run();
db.prepare("INSERT INTO shows (id, tmdb_id, title) VALUES (1, 1, 'S')").run();
db.prepare(`INSERT INTO episodes (id, show_id, season, episode, status) VALUES
  (1, 1, 1, 1, 'done'), (2, 1, 1, 2, 'done'), (3, 1, 1, 3, 'pending'), (4, 1, 2, 1, 'done')`).run();

test('a position is kept; a few seconds in is not a resume point', () => {
  assert.equal(progress.report(1, 'episode', 1, { position: 10, duration: 3000 }).position, 0);
  const r = progress.report(1, 'episode', 1, { position: 600, duration: 3000 });
  assert.equal(r.position, 600);
  assert.equal(r.watched, 0);
});

test('a report older than the stored one never overwrites it', () => {
  const r = progress.report(1, 'episode', 1, { position: 100, duration: 3000, at: Date.now() - 3600_000 });
  assert.equal(r.position, 600);
});

test('near the end counts as watched and resets the resume point', () => {
  const r = progress.report(1, 'episode', 1, { position: 2950, duration: 3000 });
  assert.equal(r.watched, 1);
  assert.equal(r.position, 0);
});

test('a clock set in the future can\'t freeze the row', () => {
  progress.report(2, 'episode', 2, { position: 500, duration: 3000, at: Date.now() + 365 * 86400_000 });
  assert.equal(progress.report(2, 'episode', 2, { position: 900, duration: 3000, at: Date.now() + 120_000 }).position, 900);
});

test('next up is the next downloaded episode after the last one finished', () => {
  progress.report(1, 'episode', 1, { position: 2990, duration: 3000 });
  assert.deepEqual(progress.nextUp(1).map(e => e.id), [2]);
  progress.setWatched(1, 'episode', 2, true);
  assert.deepEqual(progress.nextUp(1).map(e => e.id), [4], 'skips the episode that is not downloaded');
  assert.deepEqual(progress.nextUp(2).map(e => e.id), [], 'per user');
});

test('half-watched items are in "continue watching", finished ones are not', () => {
  progress.report(2, 'episode', 4, { position: 700, duration: 3000 });
  assert.deepEqual(progress.inProgress(2).map(r => r.item_id).sort(), [2, 4]);
  assert.deepEqual(progress.inProgress(1).map(r => r.item_id), []);
});
