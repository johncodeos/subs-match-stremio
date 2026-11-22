import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { videoHash } from './match.js';
import { InvalidSettings, writePrivateJson } from './settings.js';

export function playbackIdentity(stream) {
  if (typeof stream.url === 'string' && stream.url) {
    return JSON.stringify(['url', stream.url, stream.behaviorHints?.proxyHeaders]);
  }
  if (typeof stream.infoHash === 'string' && Number.isInteger(stream.fileIdx)) {
    return JSON.stringify(['torrent', stream.infoHash.toLowerCase(), stream.fileIdx]);
  }
  if (typeof stream.ytId === 'string' && stream.ytId) return JSON.stringify(['youtube', stream.ytId]);
  return null;
}

export function fileIdentity(stream, video) {
  const hints = stream.behaviorHints ?? {};
  const hash = videoHash(stream);
  const path = playbackIdentity(stream);
  const file = hash ? ['hash', hash]
    : hints.filename && Number.isSafeInteger(hints.videoSize) && hints.videoSize > 0
      ? ['filename', hints.filename, hints.videoSize]
      : path;
  // Include the item ID so a multi-file playback endpoint cannot reuse timing across episodes.
  return file && createHash('sha256').update(JSON.stringify([video, file])).digest('hex');
}

export function parseOffset(value) {
  const text = value?.trim() || '0';
  if (!/^-?\d+(?:\.\d{1,3})?$/.test(text) || Math.abs(Number(text)) > 600) {
    throw new InvalidSettings('Enter a delay in seconds between -600 and 600.');
  }
  return Math.round(Number(text) * 1000);
}

export async function openConfirmations(file) {
  let entries;
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid timing file');
    entries = new Map(Object.entries(data));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not read confirmed subtitle timings.');
    entries = new Map();
  }

  let pending = Promise.resolve();
  return {
    get: (key) => key && entries.get(key),
    save(key, selection) {
      const update = pending.then(async () => {
        const next = new Map(entries);
        if (selection) next.set(key, selection);
        else next.delete(key);
        await writePrivateJson(file, Object.fromEntries(next));
        entries = next;
      });
      pending = update.catch(() => {});
      return update;
    }
  };
}

function timestamp(ms) {
  const parts = [Math.floor(ms / 3_600_000), Math.floor(ms / 60_000) % 60, Math.floor(ms / 1000) % 60];
  return parts.map((value) => String(value).padStart(2, '0')).join(':') + '.' + String(ms % 1000).padStart(3, '0');
}

function milliseconds(value) {
  const [time, millis] = value.split('.');
  return time.split(':').reduce((total, part) => total * 60 + Number(part), 0) * 1000 + Number(millis);
}

export function shiftVtt(content, offsetMs = 0) {
  if (!offsetMs) return content;
  const timing = /^(?:((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})[ \t]+-->[ \t]+((?:\d{2,}:)?\d{2}:\d{2}\.\d{3}))(.*)$/m;
  return content.trimEnd().split(/\n\n+/).flatMap((block) => {
    const first = block.split('\n', 1)[0];
    if (/^(?:WEBVTT|STYLE|REGION|NOTE)(?:[ \t]|$)/.test(first)) return [block];
    const cue = block.match(timing);
    if (!cue) return [block];
    const start = Math.max(0, milliseconds(cue[1]) + offsetMs);
    const end = milliseconds(cue[2]) + offsetMs;
    return end > start ? [block.replace(timing, `${timestamp(start)} --> ${timestamp(end)}${cue[3]}`)] : [];
  }).join('\n\n') + '\n';
}
