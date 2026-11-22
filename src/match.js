const resolutionPattern = /\b(?:4320|2160|1440|1080|720|576|480)p\b|\b4k\b/gi;
const sourcePattern = /\b(?:web[ ._-]*(?:dl|rip)|bluray|blu[ ._-]ray|bdremux|b[dr]rip|hdtv|dvd[ ._-]*rip|dvdscr|(?:hd)?cam(?:[ ._-]*rip)?|telesync|hd[ ._-]*ts|telecine|hd[ ._-]*tc)\b/i;
const cutPattern = /\b(?:extended(?:[ ._-]+cut)?|theatrical(?:[ ._-]+cut)?|director'?s?[ ._-]+cut|unrated|final[ ._-]+cut)\b/i;
const ytsPattern = /(?:^|[\s.\[\]_-])(?:yify|yts(?:[.-](?:ag|mx|am|lt|gg|bz))?)(?=$|[\s.\[\]_-])/i;

const releaseGroupList = /\b[a-z][a-z0-9]{1,19}(?:\s*&\s*[a-z][a-z0-9]{1,19})+\b/gi;
const candidateDescriptions = new WeakMap();

const nonGroup = /^(?:dl|rip|ray|web(?:dl|rip)?|bluray|bdremux|b[dr]rip|hdtv|h26[45]|x26[45]|hevc|avc|av1|aac|atmos|dts|remux|hdr|dv|imax|greek|english|multi|cam(?:rip)?|telesync)$/i;

export function parseVideoId(type, id) {
  const match = type === 'movie'
    ? /^(tt\d{7,12}|tmdb:\d{1,10})$/.exec(id)
    : type === 'series' && /^(tt\d{7,12}|tmdb:\d{1,10}):(\d{1,3}):(\d{1,4})$/.exec(id);
  if (!match) return null;
  const [, titleId, season, episode] = match;
  const tmdb = titleId.startsWith('tmdb:');
  return {
    type,
    idField: tmdb ? 'tmdb_id' : 'imdb_id',
    titleId: tmdb ? titleId.slice('tmdb:'.length) : titleId,
    season: Number(season ?? 0),
    episode: Number(episode ?? 0)
  };
}

export function parseEpisode(text = '') {
  const match = /\b(?:s(\d{1,3})[. _-]*e(\d{1,4})(?!\d)|([0-9]{1,2})x(\d{1,4})(?!\d))/i.exec(text);
  if (!match) return null;
  const tail = text.slice(match.index + match[0].length);
  const season = Number(match[1] ?? match[3]);
  const episode = Number(match[2] ?? match[4]);
  const additional = [...tail.matchAll(/\bs(\d{1,3})[. _-]*e(\d{1,4})/gi)]
    .some((other) => Number(other[1]) !== season || Number(other[2]) !== episode);
  const multi = /^(?:[. _-]*e\d|\s*[-–]\s*\d{1,3}(?=$|[. _-]))/i.test(tail) || additional;
  return { season, episode, multi };
}

export function episodeMatches(episode, video) {
  return episode && !episode.multi && episode.season === video.season && episode.episode === video.episode;
}

function releaseStem(value) {
  const filename = value.trim();
  return filename.replace(/\.(?:mp4|mkv|avi|m4v|mov|srt|vtt|ass|ssa|zip)$/i, '')
    .replace(/[\s._-]+(?:[\[(]?(?:greek|gre|ell|el|gr)[\])]?)$/i, '');
}

export function releaseKey(value) {
  return releaseStem(value).toLowerCase().replace(/[^\p{L}\d]+/gu, ' ').trim();
}

function describe(value = '') {
  const name = releaseStem(value);
  const resolutionText = name.replace(/\b(4320|2160|1440|1080|720|576|480)(?=\s*[/,+–-]\s*(?:4320|2160|1440|1080|720|576|480)(?:p|\b))/gi, '$1p');
  const canonical = releaseKey(value);
  const resolutions = new Set(Array.from(resolutionText.matchAll(resolutionPattern), (result) =>
    result[0].toLowerCase() === '4k' ? '2160p' : result[0].toLowerCase()));
  const source = name.match(sourcePattern)?.[0].toLowerCase().replace(/[^a-z]/g, '');
  const cut = name.match(cutPattern)?.[0].toLowerCase().replace(/[^a-z]/g, '').replace(/cut$/, '');
  const fps = name.match(/(?:\b(\d{2}(?:\.\d+)?)\s*fps\b|\bfps[ :=]+(\d{2}(?:\.\d+)?))/i);
  const trailingGroup = name.match(/-[\[(]?([a-z][a-z0-9]{0,19})[\])]?\s*$/i)?.[1]
    ?? name.match(/\[([a-z][a-z0-9]{1,19})\]\s*$/i)?.[1]
    ?? name.match(/\b(?:\d{3,4}p|4k|bluray|web[ ._-]*(?:dl|rip)|hdtv|x26[45]|hevc)[. _]+([a-z][a-z0-9]{1,19})\s*$/i)?.[1];
  const groups = new Set();
  if (ytsPattern.test(name)) groups.add('yts');
  else if ((source || resolutions.size) && trailingGroup && !nonGroup.test(trailingGroup)) {
    groups.add(trailingGroup.toLowerCase());
  }
  if (source || resolutions.size) {
    for (const [list] of name.matchAll(releaseGroupList)) {
      for (const group of list.toLowerCase().split(/\s*&\s*/)) {
        if (!nonGroup.test(group)) groups.add(group === 'yify' ? 'yts' : group);
      }
    }
  }
  const firstQualifier = canonical.search(/\b(?:4320p|2160p|1440p|1080p|720p|576p|480p|4k|web|webdl|webrip|bluray|hdtv|brrip|bdrip|dvdrip)\b/);
  const hasTitle = firstQualifier > 0 && /\p{L}/u.test(canonical.slice(0, firstQualifier));
  return { canonical, resolutions, source, cut, fps: Number(fps?.[1] ?? fps?.[2]), groups, hasTitle };
}

export function videoFilenames(stream) {
  const hint = stream.behaviorHints?.filename;
  for (const value of [hint, stream.filename]) {
    if (typeof value === 'string' && value.trim()) return [value.trim().split(/[\\/]/).at(-1)];
  }
  const values = [stream.description ?? stream.title, stream.name];
  const lines = values.filter((value) => typeof value === 'string').flatMap((value) => value.split(/\r?\n/));
  return [...lines, lines.join(' ')].slice(-12).map((line) => line.slice(0, 700));
}

function compatible(video, subtitle) {
  if (video.cut !== subtitle.cut && (video.cut || subtitle.cut)) return false;
  if (video.source && subtitle.source && video.source !== subtitle.source) return false;
  if (Math.abs(video.fps - subtitle.fps) > 0.05) return false;
  return !video.resolutions.size || !subtitle.resolutions.size
    || [...video.resolutions].some((resolution) => subtitle.resolutions.has(resolution));
}

function releaseEvidence(video, subtitle) {
  if (!compatible(video, subtitle)) return null;
  const sharedResolution = [...video.resolutions].some((resolution) => subtitle.resolutions.has(resolution));
  if (video.hasTitle && video.canonical === subtitle.canonical) return { score: 2 };
  const sharedGroup = [...video.groups].find((group) => subtitle.groups.has(group));
  if (sharedGroup && (sharedResolution || (video.source && video.source === subtitle.source))) {
    return { score: 1, group: sharedGroup, source: subtitle.source ?? video.source };
  }
  return null;
}

function releaseAlternatives(name) {
  const parts = name.split(/\s+[|/]\s+|[;\n]+|\s+\b(?:or|and)\b\s+/i).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return [name];
  const alternatives = parts.map(describe);
  return alternatives.every(({ groups, source, resolutions }) =>
    (groups.size && (source || resolutions.size)) || (source && resolutions.size))
    ? parts : [name];
}

function describeCandidate(subtitle) {
  if (!candidateDescriptions.has(subtitle)) {
    candidateDescriptions.set(subtitle, subtitle.releases.flatMap((release) =>
      releaseAlternatives(release).map((option) => ({ release, description: describe(option) }))));
  }
  return candidateDescriptions.get(subtitle);
}

export function videoHash(stream) {
  const value = stream.behaviorHints?.videoHash;
  return typeof value === 'string' && /^[a-f0-9]{16}$/i.test(value) ? value.toLowerCase() : undefined;
}

export function bestMatch(stream, subtitles, video) {
  const filenames = videoFilenames(stream);
  if (video.type === 'series' && filenames.some((name) => {
    const episode = parseEpisode(name);
    return episode && !episodeMatches(episode, video);
  })) return null;

  const releases = filenames.map(describe);
  const context = releases.at(-1);
  let best = null;
  const hash = videoHash(stream);
  for (const subtitle of subtitles) {
    if (subtitle.videoHash) {
      if (hash === subtitle.videoHash) return { subtitle, score: 3, release: subtitle.releases[0] };
      continue;
    }
    for (const { release, description } of describeCandidate(subtitle)) {
      if (context && !compatible(context, description)) continue;
      for (const variant of releases) {
        const evidence = releaseEvidence(variant, description);
        if (evidence && evidence.score > (best?.score ?? 0)) best = { subtitle, release, ...evidence };
      }
    }
  }
  return best;
}

export const matchLabels = {
  1: 'Likely release match',
  2: 'Exact release name',
  3: 'Video hash match',
  4: 'Confirmed timing'
};

const sourceLabels = {
  bluray: 'BluRay', webdl: 'WEB-DL', webrip: 'WEBRip', bdremux: 'BDRemux', bdrip: 'BDRip',
  brrip: 'BRRip', hdtv: 'HDTV', dvdrip: 'DVDRip', telesync: 'TELESYNC'
};

export function matchReason(match) {
  if (!match.group) return matchLabels[match.score];
  return ['Likely', [match.group.toUpperCase(), sourceLabels[match.source]].filter(Boolean).join(' ')].join(' · ');
}

export function streamMatchDescription(details, match, position, embedded = false) {
  const parts = [];
  if (embedded) parts.push('Embedded');
  if (match) parts.push(match.score === 2 ? 'Exact match' : embedded ? matchReason(match) : `Greek subtitles · ${matchReason(match)}`);
  if (!parts.length) return details;
  const label = `🇬🇷 ${parts.join(' · ')}`;
  if (match && match.score > 2) return [label, details].filter(Boolean).join('\n');

  const text = String(details ?? '').trimEnd();
  const lines = text ? text.split(/\r?\n/) : [];
  const positions = { start: 0, 'after-first-line': 1, end: lines.length };
  lines.splice(positions[position] ?? lines.length, 0, label);
  return lines.join('\n');
}
