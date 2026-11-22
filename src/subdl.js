import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cached, fetchBytes, fetchJson } from './http.js';
import { episodeMatches, parseEpisode, releaseKey } from './match.js';

const unzip = promisify(execFile);
const searchUrl = 'https://api.subdl.com/api/v1/subtitles';
const downloadOrigin = 'https://dl.subdl.com';
const maxSubtitle = 1024 * 1024;
const supportedFile = /\.(?:srt|vtt)$/i;
const greek = /^(?:el|gre|ell|greek)$/i;

function downloadPath(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, downloadOrigin);
    return url.origin === downloadOrigin
      && /^\/subtitle\/[a-z0-9_-]+(?:\.(?:zip|srt|vtt)|\/[a-z0-9_-]+(?:\.(?:srt|vtt))?)$/i.test(url.pathname)
      ? url.pathname : null;
  } catch {
    return null;
  }
}

function releaseNames(row) {
  const additions = Array.isArray(row.releases) ? row.releases : [row.releases];
  return [row.release_name, row.name, ...additions]
    .filter((name) => typeof name === 'string' && name.trim())
    .map((name) => name.trim().slice(0, 500))
    .slice(0, 32);
}

function scopeFor(row, video, names) {
  if (video.type === 'movie') return { allowed: true, single: false };
  const episodes = names.map(parseEpisode).filter(Boolean);
  if (episodes.length && !episodes.some((episode) => episodeMatches(episode, video))) return { allowed: false };

  const season = row.season == null || row.season === '' ? null : Number(row.season);
  const episode = Number(row.episode);
  const from = Number(row.episode_from || episode);
  const end = Number(row.episode_end || episode);
  if (season !== null && season !== video.season) return { allowed: false };
  if (from > 0 && end >= from && (video.episode < from || video.episode > end)) return { allowed: false };
  const namedEpisode = episodes.some((entry) => episodeMatches(entry, video));
  const single = row.full_season !== true && row.full_season !== 1 && row.full_season !== '1'
    && (namedEpisode || (season === video.season && from === video.episode && end === video.episode));
  return { allowed: single || (season === video.season && from > 0 && end >= from), single };
}

export function processSubdlResults(rows, video) {
  const candidates = [];
  for (const row of rows ?? []) {
    if (!row || typeof row !== 'object') continue;
    const direct = [];
    const files = Array.isArray(row.unpack_files) ? row.unpack_files : [];
    for (const file of files) {
      const language = file?.language || file?.lang || row.language || row.lang;
      if (!file || (language && !greek.test(language)) || !supportedFile.test(file.name || `.${file.format}`)) continue;
      const path = downloadPath(file.url);
      const names = releaseNames(file);
      const scope = scopeFor({ ...file, season: file.season ?? row.season }, video, names);
      if (!path || !scope.allowed || (video.type === 'series' && !scope.single)) continue;
      const parentReleases = releaseNames(row).filter((name) => {
        const episode = parseEpisode(name);
        return !episode || episodeMatches(episode, video);
      });
      direct.push({
        path,
        releases: [...new Set([...names, ...parentReleases])],
        single: scope.single,
        hearingImpaired: file.hi ?? row.hi
      });
    }

    if (direct.length) {
      candidates.push(...direct);
      continue;
    }

    const language = row.language || row.lang;
    if (language && !greek.test(language)) continue;
    const path = downloadPath(row.url);
    const names = releaseNames(row);
    const scope = scopeFor(row, video, names);
    if (path && scope.allowed) {
      candidates.push({
        path,
        releases: names.filter((name) => {
          const episode = parseEpisode(name);
          return video.type === 'movie' || !episode || episodeMatches(episode, video);
        }),
        single: scope.single,
        hearingImpaired: row.hi
      });
    }
  }
  return candidates.filter((candidate) => candidate.releases.length).sort(
    (a, b) => Number(Boolean(a.hearingImpaired)) - Number(Boolean(b.hearingImpaired))
  );
}

export function createSubdlSearch(apiKey, fetcher = fetch) {
  const search = cached(async (video, filename) => {
    const url = new URL(searchUrl);
    url.search = new URLSearchParams({
      api_key: apiKey,
      [video.idField]: video.titleId,
      type: video.type === 'series' ? 'tv' : 'movie',
      languages: 'EL',
      releases: '1',
      unpack: '1',
      subs_per_page: '30',
      client: 'custom_integration'
    });
    if (video.type === 'series') {
      url.searchParams.set('season_number', String(video.season));
      url.searchParams.set('episode_number', String(video.episode));
    }
    if (filename) url.searchParams.set('file_name', filename);
    const data = await fetchJson(url, fetcher, { timeout: filename ? 2200 : 6500 });
    if (data.status !== true || !Array.isArray(data.subtitles)) {
      if (typeof data.error === 'string' && /no (?:subtitles|results|films?|movies?|tv shows?)(?: (?:were )?found)?/i.test(data.error)) {
        return [];
      }
      throw new Error('SubDL search failed');
    }
    const returnedId = data.results?.[0]?.[video.idField];
    if (returnedId && String(returnedId) !== video.titleId) return [];
    return processSubdlResults(data.subtitles, video);
  });
  return (video, filename = '') => search(JSON.stringify([video, filename]), video, filename);
}

async function unpackSubtitle(bytes, selection) {
  const directory = await mkdtemp(join(tmpdir(), 'stremio-greek-'));
  try {
    const path = join(directory, 'subtitle.zip');
    await writeFile(path, bytes);
    const options = { timeout: 3000, maxBuffer: maxSubtitle, encoding: 'buffer' };
    const { stdout: listing } = await unzip('/usr/bin/unzip', ['-Z1', path], options);
    const files = listing.toString().split(/\r?\n/).filter((file) =>
      supportedFile.test(file) && !/(?:^|\/)__MACOSX\/|(?:^|\/)\._/.test(file));
    let eligible = files;
    if (selection.video.type === 'series') {
      const exactEpisodes = files.filter((file) => episodeMatches(parseEpisode(file), selection.video));
      eligible = exactEpisodes.length ? exactEpisodes
        : selection.single ? files.filter((file) => !parseEpisode(file)) : [];
    }

    const release = releaseKey(selection.release);
    const exactFiles = eligible.filter((file) => releaseKey(file.split(/[\\/]/).at(-1)) === release);
    if (exactFiles.length === 1) eligible = exactFiles;
    if (eligible.length !== 1 || files.filter((file) => file === eligible[0]).length !== 1) {
      throw new Error('No unambiguous subtitle file in archive');
    }
    const escapedFile = eligible[0].replace(/[\\[\]*?]/g, '\\$&');
    const { stdout } = await unzip('/usr/bin/unzip', ['-p', path, escapedFile], options);
    return stdout;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export function toWebVtt(bytes) {
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le').decode(bytes);
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be').decode(bytes);
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('windows-1253').decode(bytes);
    }
  }
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const timing = /^(\d{2,}:\d{2}:\d{2})[,.](\d{3})[ \t]+-->[ \t]+(\d{2,}:\d{2}:\d{2})[,.](\d{3})(?:[ \t]+[^\n]*)?$/gm;
  if (/^WEBVTT(?:[ \t]|\n)/.test(text)) {
    if (!/^(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}[ \t]+-->[ \t]+(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}/m.test(text)) {
      throw new Error('Subtitle has no timed cues');
    }
    return text + '\n';
  }
  if (!timing.test(text)) throw new Error('Subtitle has no timed cues');
  return 'WEBVTT\n\n' + text.replace(timing, '$1.$2 --> $3.$4') + '\n';
}

export async function downloadedSubtitle(bytes, selection) {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) return toWebVtt(await unpackSubtitle(bytes, selection));
  if (bytes.length > maxSubtitle) throw new Error('Subtitle exceeded size limit');
  return toWebVtt(bytes);
}

export function createSubdlDownload(fetcher = fetch) {
  return cached(async (selection) => {
    const path = downloadPath(selection.path);
    if (!path) throw new Error('Invalid subtitle path');
    const bytes = await fetchBytes(new URL(path, downloadOrigin), { limit: 8 * 1024 * 1024, fetcher });
    return downloadedSubtitle(bytes, selection);
  }, { capacity: 48 });
}
