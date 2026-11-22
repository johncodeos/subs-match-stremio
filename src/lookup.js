import { fileIdentity, playbackIdentity } from './confirmations.js';
import { cached, fetchJson } from './http.js';
import { bestMatch, parseVideoId, videoFilenames, videoHash } from './match.js';

export const shortlistLimit = 12;

function upstreamStreamUrl(manifestUrl, type, id) {
  const url = new URL(manifestUrl);
  url.pathname = url.pathname.replace(/\/manifest\.json$/, `/stream/${type}/${id}.json`);
  return url;
}

function rankedRows(streams, sets, video, confirmations) {
  const rows = streams.map((stream) => {
    const fileKey = confirmations && fileIdentity(stream, video);
    const confirmed = fileKey && confirmations.get(fileKey);
    const matches = sets.flatMap(({ provider, candidates }) => {
      if (confirmed?.provider === provider.id) {
        return [{ provider, score: 4, release: confirmed.release, selection: confirmed }];
      }
      const match = bestMatch(stream, candidates, video);
      return match ? [{ ...match, provider }] : [];
    }).sort((a, b) => b.score - a.score);
    return { stream, fileKey, matches };
  }).sort((a, b) => (b.matches[0]?.score ?? 0) - (a.matches[0]?.score ?? 0));

  const seen = new Set();
  return rows.filter(({ stream }) => {
    const identity = playbackIdentity(stream);
    if (identity === null) return true;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function subtitleSelection({ subtitle, release, provider, selection }, video) {
  if (selection) return selection;
  if (provider.id === 'subdl') {
    return { provider: provider.id, path: subtitle.path, single: subtitle.single, release, video };
  }
  if (provider.id === 'subsource') {
    return { provider: provider.id, fileId: subtitle.fileId, single: subtitle.single, release, video };
  }
  return { provider: provider.id, fileId: subtitle.fileId, release };
}

function mergeCandidates(set, extra) {
  const entries = new Map();
  for (const candidate of [...set.candidates, ...extra]) {
    const key = JSON.stringify([candidate.fileId ?? candidate.path, candidate.videoHash]);
    const previous = entries.get(key);
    entries.set(key, previous ? { ...previous, releases: [...new Set([...previous.releases, ...candidate.releases])] } : candidate);
  }
  set.candidates = [...entries.values()];
}

function releaseFilename(stream) {
  const value = stream.behaviorHints?.filename ?? stream.filename;
  if (typeof value !== 'string' || /:\/\//.test(value)) return '';
  return videoFilenames(stream)[0]?.slice(0, 240) ?? '';
}

export function diagnosticsName(stream) {
  return releaseFilename(stream) || 'Stream with no filename';
}

export function createLookup({ config, providers, fetcher, confirmations, logger }) {
  const streamsByTitle = cached(
    (type, id) => Promise.allSettled(config.manifestUrls.map((url) => fetchJson(upstreamStreamUrl(url, type, id), fetcher))),
    { ttl: 20_000, capacity: 24 }
  );

  return async (type, id) => {
    const video = parseVideoId(type, id);
    if (!video || !config.manifestUrls?.length || !providers.length) return null;
    const [upstreams, sets] = await Promise.all([
      streamsByTitle(`${type}:${id}`, type, id),
      Promise.all(providers.map(async (provider) => {
        try {
          return { provider, candidates: await provider.search(video), available: true };
        } catch {
          return { provider, candidates: [], available: false };
        }
      }))
    ]);
    const usable = upstreams.filter((result) => result.status === 'fulfilled' && Array.isArray(result.value?.streams));
    const streams = usable.flatMap((result) => result.value.streams).filter((stream) => stream && typeof stream === 'object');
    const upstreamFailures = upstreams.length - usable.length;
    if (upstreamFailures) logger.warn('A stream add-on could not return results.');
    if (sets.some((set) => !set.available)) logger.warn('A subtitle provider could not return results.');

    const hashProvider = sets.find(({ provider, available }) => available && provider.searchHash);
    const hashes = hashProvider ? [...new Set(streams.map(videoHash).filter(Boolean))].slice(0, 2) : [];
    if (hashes.length) {
      const extra = await Promise.allSettled(hashes.map((hash) => hashProvider.provider.searchHash(video, hash)));
      mergeCandidates(hashProvider, extra.filter(({ status }) => status === 'fulfilled').flatMap(({ value }) => value));
    }

    let rows = rankedRows(streams, sets, video, confirmations);
    let searchedMore = false;
    if (streams.length && !rows[0]?.matches.length) {
      const filenames = [...new Set(streams.map(releaseFilename).filter(Boolean))];
      const filename = filenames.find((name) => /\b1080p\b/i.test(name)) ?? filenames[0] ?? '';
      await Promise.all(sets.map(async (set) => {
        if (!set.available || !set.provider.searchMore) return;
        searchedMore = true;
        try {
          mergeCandidates(set, await set.provider.searchMore(video, filename));
        } catch {
          set.extraFailed = true;
        }
      }));
      if (searchedMore) rows = rankedRows(streams, sets, video, confirmations);
    }

    const matchedRows = rows.filter(({ matches }) => matches.length > 0);
    const selected = config.shortlist !== false ? matchedRows.slice(0, shortlistLimit) : rows;
    return { video, rows, selected, matchedRows, upstreamFailures, sets, searchedMore, sourceCount: streams.length };
  };
}

export function emptyResult(report) {
  if (!report.sourceCount) {
    return report.upstreamFailures
      ? { title: 'Stream source unavailable', detail: 'A stream source could not be reached.' }
      : { title: 'No streams available', detail: 'Your stream sources returned no streams.' };
  }
  if (report.upstreamFailures || report.sets.some(({ available, extraFailed }) => !available || extraFailed)) {
    return { title: 'Greek match check incomplete', detail: 'No matches found in the available results. A provider search failed.' };
  }
  if (report.sets.some(({ candidates }) => candidates.length)) {
    return { title: 'No Greek subtitle match', detail: 'Greek subtitles were found for other releases. No available stream matched their release details.' };
  }
  return { title: 'No Greek subtitles found', detail: 'Your subtitle providers returned no usable Greek subtitles for this title.' };
}
