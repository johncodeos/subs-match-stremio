import { cached, fetchBytes, fetchJson } from './http.js';
import { episodeMatches, parseEpisode } from './match.js';
import { downloadedSubtitle } from './subdl.js';

const apiRoot = new URL('https://api.subsource.net/api/v1/');

function getCandidates(entries, video, movieId) {
  return entries.flatMap((entry) => {
    const fileId = Number(entry?.subtitleId);
    if (!Number.isSafeInteger(fileId) || fileId < 1 || entry.language?.toLowerCase() !== 'greek' ||
        entry.foreignParts || (entry.movieId != null && Number(entry.movieId) !== movieId) ||
        !Array.isArray(entry.releaseInfo)) return [];

    const singleFile = Number(entry.files) === 1;
    const releases = entry.releaseInfo.filter((name) => typeof name === 'string' && name.trim())
      .map((name) => name.trim().slice(0, 500));
    if (video.type === 'movie') return releases.length ? [{ fileId, releases, hearingImpaired: entry.hearingImpaired }] : [];

    const exact = releases.filter((name) => episodeMatches(parseEpisode(name), video));
    const season = releases.filter((name) => {
      if (parseEpisode(name)) return false;
      const listed = /\b(?:season[ ._-]*|s)(\d{1,3})\b/i.exec(name);
      return listed && Number(listed[1]) === video.season;
    });
    if (!exact.length && !season.length) return [];
    return [{ fileId, releases: [...exact, ...season], single: singleFile && exact.length > 0 && !season.length,
      hearingImpaired: entry.hearingImpaired }];
  }).sort((a, b) => Number(Boolean(a.hearingImpaired)) - Number(Boolean(b.hearingImpaired)));
}

export function createSubsource(apiKey, fetcher = fetch) {
  const authFetch = (url, options) => fetcher(url, { ...options, redirect: 'error', headers: { 'X-API-Key': apiKey } });
  const get = async (route, parameters) => {
    const url = new URL(route, apiRoot);
    url.search = new URLSearchParams(parameters);
    const result = await fetchJson(url, authFetch, { timeout: 3500 });
    if (result?.success !== true || !Array.isArray(result.data)) throw new Error('SubSource search failed');
    return result;
  };

  const searchTitle = cached(async (video) => {
    const series = video.type === 'series';
    const parameters = { searchType: 'imdb', imdb: video.titleId, type: series ? 'series' : 'movie' };
    if (series) parameters.season = String(video.season);
    const { data } = await get('movies/search', parameters);
    const ids = new Set(data.filter((entry) => entry?.imdbId === video.titleId &&
      (!series || Number(entry.season) === video.season)).map((entry) => Number(entry.movieId))
      .filter((id) => Number.isSafeInteger(id) && id > 0));
    return ids.size === 1 ? ids.values().next().value : null;
  });

  const search = cached(async (video) => {
    const movieId = await searchTitle(JSON.stringify([video.titleId, video.type, video.season]), video);
    if (!movieId) return [];
    // The API's foreignParts filter also drops older full subtitles with unset metadata.
    const parameters = { movieId: String(movieId), language: 'greek', limit: '100' };
    const first = await get('subtitles', parameters);
    const entries = first.pagination?.pages > 1
      ? [...first.data, ...(await get('subtitles', { ...parameters, page: '2' })).data] : first.data;
    return getCandidates(entries, video, movieId);
  });

  return {
    search: (video) => video.idField === 'imdb_id' ? search(JSON.stringify(video), video) : [],
    download: cached(async (selection) => {
      if (!Number.isSafeInteger(selection.fileId) || selection.fileId < 1) throw new Error('Invalid SubSource file');
      const url = new URL(`subtitles/${selection.fileId}/download`, apiRoot);
      const bytes = await fetchBytes(url, { limit: 8 * 1024 * 1024, fetcher: authFetch });
      return downloadedSubtitle(bytes, selection);
    }, { capacity: 48 })
  };
}
