import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createEmbeddedProbe, embeddedGreekTracks, filenameGreekHint, openProbeCache, readContainer
} from '../src/embedded.js';

function vint(value) {
  const bytes = [];
  do { bytes.unshift(value & 0x7f); value >>>= 7; } while (value);
  bytes[0] |= 0x80 >> (bytes.length - 1);
  return Buffer.from(bytes);
}

function el(idBytes, payload) {
  return Buffer.concat([idBytes, vint(payload.length), payload]);
}

const ID = {
  ebml: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  segment: Buffer.from([0x18, 0x53, 0x80, 0x67]),
  tracks: Buffer.from([0x16, 0x54, 0xae, 0x6b]),
  entry: Buffer.from([0xae]),
  type: Buffer.from([0x83]),
  lang: Buffer.from([0x22, 0xb5, 0x9c]),
  ietf: Buffer.from([0x22, 0xb5, 0x9d]),
  name: Buffer.from([0x53, 0x6e])
};

function mkvTrack(type, lang, name) {
  const parts = [el(ID.type, Buffer.from([type]))];
  if (lang) parts.push(el(ID.lang, Buffer.from(lang)));
  if (name) parts.push(el(ID.name, Buffer.from(name)));
  return el(ID.entry, Buffer.concat(parts));
}

function mkv(...tracks) {
  return Buffer.concat([
    el(ID.ebml, Buffer.from([0x01])),
    el(ID.segment, el(ID.tracks, Buffer.concat(tracks)))
  ]);
}

function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function mp4Trak(lang, handler, name = '') {
  const mdhd = Buffer.alloc(24);
  const packed = [...lang].reduce((bits, character) => (bits << 5) | (character.charCodeAt(0) - 0x60), 0);
  mdhd.writeUInt16BE(packed, 20);
  const hdlr = Buffer.alloc(25 + Buffer.byteLength(name));
  hdlr.write(handler, 8, 'latin1');
  hdlr.write(name, 24, 'utf8');
  return box('trak', box('mdia', Buffer.concat([box('mdhd', mdhd), box('hdlr', hdlr)])));
}

function mp4(...tracks) {
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.alloc(4)]));
  return Buffer.concat([ftyp, box('moov', Buffer.concat(tracks))]);
}

test('reads Greek subtitle tracks out of Matroska metadata', () => {
  assert.equal(embeddedGreekTracks(mkv(
    mkvTrack(0x02, 'jpn'), mkvTrack(0x11, 'gre'), mkvTrack(0x11, 'eng')
  )), true);
  assert.equal(embeddedGreekTracks(mkv(mkvTrack(0x11, 'eng'))), false);
  assert.equal(embeddedGreekTracks(mkv(mkvTrack(0x11, undefined, 'Ελληνικά'))), true);
  assert.equal(embeddedGreekTracks(mkv(mkvTrack(0x11, 'el'))), true);
  assert.equal(embeddedGreekTracks(mkv(mkvTrack(0x11, 'und'))), false);
  assert.equal(embeddedGreekTracks(Buffer.from('{"streams":[]}')), null);
});

test('reads Greek subtitle tracks out of MP4 metadata', () => {
  assert.equal(embeddedGreekTracks(mp4(
    mp4Trak('jpn', 'vide'), mp4Trak('gre', 'sbtl', 'Greek'), mp4Trak('eng', 'soun')
  )), true);
  assert.equal(embeddedGreekTracks(mp4(mp4Trak('eng', 'sbtl'))), false);
  assert.equal(embeddedGreekTracks(mp4(mp4Trak('eng', 'text', 'Ελληνικά'))), true);
});

test('release names flag embedded Greek subs without probing the file', () => {
  assert.equal(filenameGreekHint({ title: 'Forrest Gump (with Greek subs)' }), true);
  assert.equal(filenameGreekHint({ filename: 'Movie.2024.1080p.WEB-DL.GRE.mkv' }), true);
  assert.equal(filenameGreekHint({ filename: 'Movie.2024.1080p.WEB-DL.GR.mkv' }), true);
  assert.equal(filenameGreekHint({ description: 'Movie release\n🌐 Multi Subs|🇬🇷' }), true);
  assert.equal(filenameGreekHint({ filename: 'Movie.2024.Greek.Subs.mkv' }), true);
  assert.equal(filenameGreekHint({ filename: 'Show.S02E03.1080p.YTS.AG.mp4' }), false);
  assert.equal(filenameGreekHint({ title: 'El.origen.2010.WEB-DL.1080p-Dual-Lat' }), false);
  assert.equal(filenameGreekHint({ filename: 'Matrix.1999.1080p.ΕλληνικήΜεταγλώττιση.DubbedGreek' }), false);
  assert.equal(filenameGreekHint({ filename: 'Movie.2024.1080p.Multi-Subs.mkv' }), false);
});

function rangedFetcher(file) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url: url.href, options });
    const range = options.headers.Range;
    const suffix = range.startsWith('bytes=-');
    const [startText, endText] = suffix ? ['', range.slice(7)] : range.slice(6).split('-');
    const size = file.length;
    const start = suffix ? Math.max(0, size - Number(endText)) : Number(startText);
    const end = suffix ? size - 1 : Math.min(Number(endText), size - 1);
    if (start >= size) return new Response(null, { status: 416 });
    return new Response(file.subarray(start, end + 1), {
      status: 206, headers: { 'content-range': `bytes ${start}-${end}/${size}` }
    });
  };
  return { fetcher, calls };
}

test('probes the file once per URL and reads its subtitle languages', async () => {
  const { fetcher, calls } = rangedFetcher(mkv(mkvTrack(0x11, 'gre')));
  const probe = createEmbeddedProbe({ fetcher });
  const stream = { url: 'https://files.example/movie.mkv' };
  assert.equal(await probe(stream), true);
  assert.equal(await probe({ url: 'https://files.example/movie.mkv' }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Range, 'bytes=0-65535');
  assert.equal(await probe({}), undefined);
  assert.equal(await probe({ url: 'https://files.example/list.m3u8' }), undefined);
});

test('probes MP4 files whose moov sits at the end', async () => {
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), Buffer.alloc(4)]));
  const mdatHeader = Buffer.alloc(8);
  mdatHeader.writeUInt32BE(8 + 5_000_000, 0);
  mdatHeader.write('mdat', 4, 'latin1');
  const head = Buffer.concat([ftyp, mdatHeader, Buffer.alloc(64)]);
  const tail = box('moov', mp4Trak('gre', 'sbtl'));
  const { fetcher, calls } = rangedFetcher(Buffer.concat([head, Buffer.alloc(5_000_000), tail]));
  const probe = createEmbeddedProbe({ fetcher });
  assert.equal(await probe({ url: 'https://files.example/movie.mp4' }), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.headers.Range, 'bytes=-524288');
});

test('probing a host that fails or serves no container leaves the answer unknown', async () => {
  const probe = createEmbeddedProbe({ fetcher: async () => new Response('not a media file') });
  assert.equal(await probe({ url: 'https://files.example/movie.mkv' }), undefined);
  const failing = createEmbeddedProbe({ fetcher: async () => new Response(null, { status: 403 }) });
  assert.equal(await failing({ url: 'https://files.example/movie.mkv' }), undefined);
});

test('a failed probe is retried instead of cached as unknown', async () => {
  let failures = 0;
  const probe = createEmbeddedProbe({ fetcher: async () => {
    failures += 1;
    if (failures === 1) throw new Error('transient network error');
    return new Response(mkv(mkvTrack(0x11, 'gre')), { status: 200 });
  } });
  const stream = { url: 'https://files.example/movie.mkv' };
  assert.equal(await probe(stream), undefined);
  assert.equal(await probe(stream), true);
  assert.equal(failures, 2);
});

test('readContainer reports what it could not identify', () => {
  assert.equal(readContainer(Buffer.alloc(0)).known, false);
  assert.equal(readContainer(mkv(mkvTrack(0x11, 'gre'))).tracks.length, 1);
});

test('probe answers survive a restart through the on-disk cache', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'greek-probe-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, '.probe-cache.json');
  const { fetcher, calls } = rangedFetcher(mkv(mkvTrack(0x11, 'gre')));
  const probe = createEmbeddedProbe({ fetcher, cache: openProbeCache(file) });
  assert.equal(await probe({ url: 'https://files.example/movie.mkv' }), true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved['https://files.example/movie.mkv'].value, true);

  const restarted = createEmbeddedProbe({ fetcher, cache: openProbeCache(file) });
  assert.equal(await restarted({ url: 'https://files.example/movie.mkv' }), true);
  assert.equal(calls.length, 1);
});
