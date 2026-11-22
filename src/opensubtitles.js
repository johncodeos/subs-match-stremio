import { cached, fetchBytes, fetchJson } from './http.js';
import { episodeMatches, parseEpisode } from './match.js';
import { toWebVtt } from './subdl.js';

const apiRoot = new URL('https://api.opensubtitles.com/api/v1/');
import pkg from '../package.json' with { type: 'json' };

const userAgent = `GreekSubMatch v${pkg.version}`;

function trustedUrl(url) {
  return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
    (url.hostname === 'opensubtitles.com' || url.hostname.endsWith('.opensubtitles.com'));
}

async function fetchOfficial(url, options, fetcher, allow) {
  let address = new URL(url);
  for (let redirects = 0; redirects < 4; redirects += 1) {
    if (!allow(address)) throw new Error('Unexpected OpenSubtitles endpoint');
    const response = await fetcher(address, { ...options, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const target = response.headers.get('location');
    await response.body?.cancel();
    if (!target) break;
    address = new URL(target, address);
  }
  throw new Error('OpenSubtitles redirect could not be resolved');
}

function candidates(data, video, idKey, id, hash) {
  return data.flatMap((item) => {
    const attributes = item?.attributes;
    if (attributes?.language !== 'el' || attributes.foreign_parts_only || attributes.files?.length !== 1) return [];
    const feature = attributes.feature_details;
    if (feature?.[idKey] && Number(feature[idKey]) !== id) return [];
    if (video.type === 'series' &&
        (feature?.season_number == null || Number(feature.season_number) !== video.season ||
         Number(feature.episode_number) !== video.episode)) return [];

    const file = attributes.files[0];
    const fileId = Number(file?.file_id);
    if (!Number.isSafeInteger(fileId) || fileId < 1) return [];
    const releases = [attributes.release, file.file_name]
      .filter((name) => typeof name === 'string' && name.trim())
      .map((name) => name.trim().slice(0, 500));
    const videoHash = attributes.moviehash_match === true ? hash : undefined;
    if (!releases.length && !videoHash) return [];
    if (video.type === 'series' && releases.some((name) => {
      const episode = parseEpisode(name);
      return episode && !episodeMatches(episode, video);
    })) return [];

    return [{ fileId, releases: releases.length ? releases : ['OpenSubtitles file match'], videoHash, hearingImpaired: attributes.hearing_impaired }];
  }).sort((a, b) => Number(Boolean(a.hearingImpaired)) - Number(Boolean(b.hearingImpaired)));
}

export function createOpenSubtitles(apiKey, fetcher = fetch) {
  const headers = { 'Api-Key': apiKey, 'User-Agent': userAgent, Accept: 'application/json' };
  const authFetch = (request = {}) => (url, options) =>
    fetchOfficial(url, { ...options, ...request, headers: { ...headers, ...request.headers } }, fetcher,
      (address) => address.origin === apiRoot.origin && !address.username && !address.password &&
        address.pathname.startsWith('/api/v1/'));

  const search = cached(async (video, { page, filename, hash }) => {
    const url = new URL('subtitles', apiRoot);
    const series = video.type === 'series';
    const idKey = series ? 'parent_' + video.idField : video.idField;
    const id = Number(video.titleId.replace(/^tt/, ''));
    url.search = new URLSearchParams({
      [idKey]: String(id), languages: 'el', type: series ? 'episode' : 'movie', foreign_parts_only: 'exclude'
    });
    if (series) {
      url.searchParams.set('season_number', String(video.season));
      url.searchParams.set('episode_number', String(video.episode));
    }
    if (page) url.searchParams.set('page', String(page));
    if (filename) url.searchParams.set('query', filename.toLowerCase());
    if (hash) {
      url.searchParams.set('moviehash', hash);
      url.searchParams.set('moviehash_match', 'only');
    }
    url.searchParams.sort();
    const result = await fetchJson(url, authFetch(), { timeout: page || filename || hash ? 2200 : 6500 });
    if (!Array.isArray(result.data)) throw new Error('OpenSubtitles search failed');
    return { entries: candidates(result.data, video, idKey, id, hash), pages: Number(result.total_pages) };
  });

  const lookup = (video, filters = {}) => search(JSON.stringify([video, filters]), video, filters);

  const download = cached(async (fileId) => {
    if (!Number.isSafeInteger(fileId) || fileId < 1) throw new Error('Invalid OpenSubtitles file');
    const result = await fetchJson(new URL('download', apiRoot), authFetch({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId, sub_format: 'srt' })
    }));
    if (typeof result.link !== 'string') throw new Error('OpenSubtitles download failed');
    const bytes = await fetchBytes(new URL(result.link), {
      limit: 1024 * 1024,
      fetcher: (url, options) => fetchOfficial(url, options, fetcher, trustedUrl)
    });
    return toWebVtt(bytes);
  }, { capacity: 48 });

  return {
    search: async (video) => (await lookup(video)).entries,
    async searchMore(video, filename) {
      const first = await lookup(video);
      if (first.pages > 1) return (await lookup(video, { page: 2 })).entries;
      return filename ? (await lookup(video, { filename })).entries : [];
    },
    searchHash: async (video, hash) => (await lookup(video, { hash })).entries.filter((result) => result.videoHash === hash),
    download: (_key, { fileId }) => download(fileId, fileId)
  };
}
