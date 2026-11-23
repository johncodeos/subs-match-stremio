import { readFileSync } from 'node:fs';
import { cached } from './http.js';
import { languageCodes, languages } from './languages.js';
import { writePrivateJson } from './settings.js';

const headLimit = 64 * 1024;
const tailLimit = 512 * 1024;
const probeTimeout = 2000;
const definitiveTtl = 7 * 24 * 60 * 60 * 1000;

const subtitleHandlers = new Set(['text', 'sbtl', 'subp', 'wvtt', 'stpp', 'c608', 'c708']);
const subtitleCodecs = new Set(['tx3g', 'text', 'wvtt', 'stpp', 'stxt', 'c608', 'c708']);

const extension = /\.(?:mp4|mkv|avi|m4v|mov|webm)$/i;
const subsContext = new RegExp(
  ['sub', ...Object.values(languages).map((profile) => profile.subsWords).filter(Boolean)].join('|'), 'i');
const dubContext = new RegExp(
  `\\b(?:dub\\w*|(?:dual|multi)[ ._-]?audio|${Object.values(languages).map((profile) => profile.dubWords).filter(Boolean).join('|')})\\b`, 'i');

function trackLanguages(track) {
  const codes = `${track.lang ?? ''} ${track.ietf ?? ''}`.toLowerCase().split(/[-_\s]+/).filter(Boolean);
  const name = track.name ?? '';
  return languageCodes.filter((code) => {
    const profile = languages[code];
    return codes.some((token) => profile.trackCodes.test(token)) || profile.trackName.test(name);
  });
}

function readVint(buf, pos, keepMarker) {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
  if (length > 8 || pos + length > buf.length) return null;
  let value = keepMarker ? first : (first & (0xff >> length));
  for (let i = 1; i < length; i++) value = value * 256 + buf[pos + i];
  return { value, size: length, unknown: !keepMarker && value === 2 ** (7 * length) - 1 };
}

const MKV = {
  Segment: 0x18538067, Tracks: 0x1654ae6b, TrackEntry: 0xae,
  TrackType: 0x83, Name: 0x536e, Language: 0x22b59c, LanguageIETF: 0x22b59d
};

function parseMkvEntries(buf, start, end, tracks) {
  let pos = start;
  while (pos < end) {
    const id = readVint(buf, pos, true);
    if (!id) return;
    const size = readVint(buf, pos + id.size, false);
    if (!size || size.unknown) return;
    const from = pos + id.size + size.size;
    const to = Math.min(from + size.value, end);
    if (id.value === MKV.TrackEntry) {
      const track = {};
      let fieldPos = from;
      while (fieldPos < to) {
        const field = readVint(buf, fieldPos, true);
        if (!field) break;
        const fieldSize = readVint(buf, fieldPos + field.size, false);
        if (!fieldSize || fieldSize.unknown) break;
        const valueStart = fieldPos + field.size + fieldSize.size;
        const valueEnd = Math.min(valueStart + fieldSize.value, to);
        const value = buf.subarray(valueStart, valueEnd);
        if (field.value === MKV.TrackType) track.type = value[0];
        else if (field.value === MKV.Language) track.lang = value.toString('latin1');
        else if (field.value === MKV.LanguageIETF) track.ietf = value.toString('latin1');
        else if (field.value === MKV.Name) track.name = value.toString('utf8');
        fieldPos = valueStart + fieldSize.value;
      }
      if (track.type === 0x11) tracks.push(track);
    }
    pos = from + size.value;
  }
}

function inspectMkv(buf) {
  const tracks = [];
  let pos = 0;
  let end = buf.length;
  let found = false;
  while (pos < end) {
    const id = readVint(buf, pos, true);
    if (!id) break;
    const size = readVint(buf, pos + id.size, false);
    if (!size) break;
    const from = pos + id.size + size.size;
    const to = size.unknown ? end : Math.min(from + size.value, end);
    if (id.value === MKV.Segment) {
      pos = from;
      end = to;
      continue;
    }
    if (id.value === MKV.Tracks) {
      found = true;
      parseMkvEntries(buf, from, to, tracks);
    }
    if (size.unknown) break;
    pos = from + size.value;
  }
  return found ? tracks : null;
}

function* mp4Boxes(buf, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = Number(buf.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header) return;
    yield { type, start: pos, from: pos + header, to: Math.min(pos + size, end), resume: pos + size };
    pos += size;
  }
}

function readLanguage(buf, box) {
  const version = buf[box.from];
  const offset = box.from + (version === 1 ? 32 : 20);
  if (offset + 2 > box.to) return '';
  const bits = buf.readUInt16BE(offset);
  return [0, 1, 2].map((index) => String.fromCharCode(((bits >> (10 - 5 * index)) & 0x1f) + 0x60)).join('');
}

function readTrak(buf, start, end) {
  const track = { codecs: [] };
  for (const box of mp4Boxes(buf, start, end)) {
    if (box.type === 'mdia') {
      for (const child of mp4Boxes(buf, box.from, box.to)) {
        if (child.type === 'hdlr') {
          if (child.to - child.from >= 12) track.type = buf.toString('latin1', child.from + 8, child.from + 12);
          if (child.to - child.from > 24) {
            track.name = buf.subarray(child.from + 24, child.to).toString('utf8').replace(/\0+$/, '');
          }
        } else if (child.type === 'mdhd') {
          track.lang = readLanguage(buf, child);
        } else if (child.type === 'minf') {
          for (const minf of mp4Boxes(buf, child.from, child.to)) {
            if (minf.type !== 'stbl') continue;
            for (const stbl of mp4Boxes(buf, minf.from, minf.to)) {
              if (stbl.type !== 'stsd') continue;
              let pos = stbl.from + 8;
              while (pos + 8 <= stbl.to) {
                const size = buf.readUInt32BE(pos);
                if (size < 8) break;
                track.codecs.push(buf.toString('latin1', pos + 4, pos + 8));
                pos += size;
              }
            }
          }
        }
      }
    } else if (box.type === 'udta') {
      for (const child of mp4Boxes(buf, box.from, box.to)) {
        if (child.type === 'name') {
          track.name ||= buf.subarray(child.from, child.to).toString('utf8').replace(/\0+$/, '');
        }
      }
    }
  }
  track.subtitle = subtitleHandlers.has(track.type) || track.codecs.some((codec) => subtitleCodecs.has(codec));
  return track;
}

function readMoov(buf, start, end) {
  const tracks = [];
  for (const box of mp4Boxes(buf, start, end)) {
    if (box.type !== 'trak') continue;
    if (box.resume > end) return null;
    tracks.push(readTrak(buf, box.from, box.to));
  }
  return tracks;
}

function inspectMp4(buf) {
  const tracks = [];
  let moov = false;
  let moovStart = null;
  for (const box of mp4Boxes(buf, 0, buf.length)) {
    if (box.resume > buf.length) {
      if (box.type === 'moov') moovStart = box.start;
      continue;
    }
    if (box.type === 'moov') {
      const parsed = readMoov(buf, box.from, box.to);
      if (parsed) {
        moov = true;
        tracks.push(...parsed);
      }
    }
  }
  return { tracks, known: moov, moovStart, needsTail: !moov };
}

function findMoov(buf) {
  for (let index = buf.indexOf('moov'); index !== -1; index = buf.indexOf('moov', index + 1)) {
    const start = index - 4;
    if (start < 0) continue;
    let size = buf.readUInt32BE(start);
    let header = 8;
    if (size === 1) {
      if (index + 8 > buf.length) continue;
      size = Number(buf.readBigUInt64BE(index + 4));
      header = 16;
    }
    if (size < header || start + size > buf.length) continue;
    return readMoov(buf, start + header, start + size);
  }
  return null;
}

const mp4Types = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'styp', 'pnot', 'uuid', 'junk']);

export function readContainer(buf) {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) {
    const tracks = inspectMkv(buf);
    return { tracks: tracks ?? [], known: tracks !== null, isSubtitle: () => true };
  }
  const size = buf.length >= 8 ? buf.readUInt32BE(0) : 0;
  const type = buf.length >= 8 ? buf.toString('latin1', 4, 8) : '';
  if ((size >= 8 || size === 1) && mp4Types.has(type)) {
    return { ...inspectMp4(buf), isSubtitle: (track) => track.subtitle };
  }
  return { tracks: [], known: false, needsTail: false, moovStart: null, isSubtitle: () => false };
}

export function embeddedSubtitleTracks(buf) {
  const { tracks, known, isSubtitle } = readContainer(buf);
  if (!known) return null;
  return [...new Set(tracks.filter(isSubtitle).flatMap(trackLanguages))];
}

export function filenameLanguageHints(stream) {
  const values = [stream?.behaviorHints?.filename, stream?.filename, stream?.name, stream?.title, stream?.description]
    .filter((value) => typeof value === 'string');
  const firstLines = values.map((value) => value.split(/\r?\n/)[0].replace(extension, ''));
  const text = values.join('\n');
  return languageCodes.filter((code) => {
    const profile = languages[code];
    const explicit = profile.explicit.test(text) || firstLines.some((line) => profile.trailing.test(line));
    const flagged = profile.flags.some((flag) => text.includes(flag)) && subsContext.test(text);
    if (!explicit && !flagged) return false;
    if (dubContext.test(text) && !subsContext.test(text)) return false;
    return true;
  });
}

async function fetchRange(url, fetcher, range, limit, headers, requirePartial) {
  const response = await fetcher(new URL(url), {
    headers: { ...headers, Range: range },
    signal: AbortSignal.timeout(probeTimeout)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const partial = response.status === 206 || Boolean(response.headers.get('content-range'));
  if (requirePartial && !partial) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.byteLength;
      if (length >= limit) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, length).subarray(0, limit);
}

export function openProbeCache(file) {
  let entries = {};
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) entries = saved;
  } catch { /* start empty */ }
  let timer = null;
  return {
    get(url) {
      const entry = entries[url];
      return entry && entry.expires > Date.now() ? entry.value : undefined;
    },
    set(url, value) {
      entries[url] = { value, expires: Date.now() + definitiveTtl };
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        writePrivateJson(file, entries).catch(() => {});
      }, 200);
    }
  };
}

export function createEmbeddedProbe({ fetcher = fetch, head = headLimit, tail = tailLimit, cache } = {}) {
  // Resolves the embedded subtitle languages when the container is readable and undefined otherwise.
  // Network failures reject so they are retried instead of cached as "unknown".
  const load = async (stream) => {
    const url = typeof stream?.url === 'string' ? stream.url : '';
    if (!/^https?:\/\//i.test(url) || /\.m3u8(\?|$)/i.test(url)) return undefined;
    const headers = stream.behaviorHints?.proxyHeaders?.request;
    const first = await fetchRange(url, fetcher, `bytes=0-${head - 1}`, head, headers, false);
    let { tracks, known, needsTail, moovStart, isSubtitle } = readContainer(first);
    if (!known && moovStart != null) {
      const part = await fetchRange(url, fetcher, `bytes=${moovStart}-${moovStart + tail - 1}`, tail, headers, true);
      if (part) {
        const more = readContainer(part);
        if (more.known) ({ tracks, known, isSubtitle } = more);
      }
    }
    if (!known && needsTail) {
      const last = await fetchRange(url, fetcher, `bytes=-${tail}`, tail, headers, true);
      const parsed = last && findMoov(last);
      if (parsed) ({ tracks, known, isSubtitle } = { tracks: parsed, known: true, isSubtitle: (track) => track.subtitle });
    }
    const result = known ? [...new Set(tracks.filter(isSubtitle).flatMap(trackLanguages))] : undefined;
    if (cache && Array.isArray(result)) cache.set(url, result);
    return result;
  };
  const cachedLoad = cached(load, { ttl: 10 * 60_000, capacity: 200 });
  return (stream) => {
    const url = typeof stream?.url === 'string' ? stream.url : '';
    if (!url) return Promise.resolve(undefined);
    const saved = cache?.get(url);
    if (Array.isArray(saved)) return Promise.resolve(saved);
    return cachedLoad(url, stream).catch(() => undefined);
  };
}
