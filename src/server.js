import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createConfigureHandler, createSignupHandler, localOrigin } from './configure.js';
import { openConfirmations, shiftVtt } from './confirmations.js';
import { installPath } from './installation.js';
import { openProbeCache } from './embedded.js';
import { createLookup, emptyResult, subtitleSelection } from './lookup.js';
import { matchLabels, streamMatchDescription } from './match.js';
import { createOpenSubtitles } from './opensubtitles.js';
import { openProfiles } from './profiles.js';
import { fetchPublicMedia, fetchPublicSource } from './public-sources.js';
import { isLive, openSettings } from './settings.js';
import { createSubdlDownload, createSubdlSearch } from './subdl.js';
import { createSubsource } from './subsource.js';
import pkg from '../package.json' with { type: 'json' };

export { readConfig } from './settings.js';

const iconPath = '/addon-icon.png';
const icon = readFileSync(new URL('../assets/addon-icon.png', import.meta.url));

const manifest = {
  id: 'local.stremio.greek-sub-match',
  version: pkg.version,
  name: 'Greek Sub Match',
  description: 'Playable streams ranked by available Greek subtitle release matches.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'tmdb:'],
  catalogs: [],
  behaviorHints: { configurable: true }
};

function renderStream(row, video, trackUrl, matchLabelPosition) {
  const { stream, matches, embedded } = row;
  if (!matches.length && !embedded) return stream;

  const tracks = matches.map((match) => {
    const url = trackUrl(subtitleSelection(match, video));
    const id = 'greek-' + createHash('sha256').update(url).digest('hex').slice(0, 24);
    const label = ['Ελληνικά', match.provider.name, row.fileKey?.slice(0, 8).toUpperCase(), matchLabels[match.score]].filter(Boolean).join(' · ');
    return { id, lang: 'gre', label, url };
  });
  const bestMatch = matches[0];
  // Stremio treats title as an alias for description and rejects streams containing both.
  const { title, ...original } = stream;
  const description = streamMatchDescription(original.description ?? title, bestMatch, matchLabelPosition, embedded);
  const subtitles = Array.isArray(original.subtitles) ? original.subtitles : [];
  return { ...original, description, subtitles: [...subtitles, ...tracks] };
}

function getProviders(config, fetcher) {
  const providers = [];
  if (config.apiKey) {
    const search = createSubdlSearch(config.apiKey, fetcher);
    providers.push({
      id: 'subdl',
      name: 'SubDL',
      search,
      searchMore: (video, filename) => filename ? search(video, filename) : [],
      download: createSubdlDownload(fetcher)
    });
  }
  if (config.openSubtitlesKey) providers.push({
    id: 'opensubtitles',
    name: 'OpenSubtitles',
    ...createOpenSubtitles(config.openSubtitlesKey, fetcher)
  });
  if (config.subsourceKey) providers.push({
    id: 'subsource',
    name: 'SubSource',
    ...createSubsource(config.subsourceKey, fetcher)
  });
  return providers;
}

function write(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

export function createAddon(initial, {
  fetcher = fetch, publicSourceFetcher = fetchPublicSource, publicProbeFetcher = fetchPublicMedia,
  logger = console, settings, confirmations, profiles, probe, cache
} = {}) {
  const { publicUrl } = initial;
  const secret = randomBytes(32);
  const sign = (purpose, data) => createHmac('sha256', secret).update(purpose + ':' + data).digest('base64url');
  const encode = (purpose, payload) => {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${data}.${sign(purpose, data)}`;
  };
  const decode = (purpose, token) => {
    const parts = /^([A-Za-z0-9_-]{1,3400})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!parts || !timingSafeEqual(Buffer.from(parts[2]), Buffer.from(sign(purpose, parts[1])))) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url'));
  };

  function createContext(sourceSettings, timing, token = '') {
    let runtime;
    let requestCount = 0;
    let resetsAt = 0;
    const sourceFetcher = token ? publicSourceFetcher : fetcher;
    const probeFetcher = token ? publicProbeFetcher : fetcher;
    function getRuntime() {
      const config = sourceSettings?.get() ?? initial;
      if (runtime?.config !== config) {
        const providers = getProviders(config, fetcher);
        const lookup = createLookup({
          config, providers, confirmations: timing, fetcher: sourceFetcher, probeFetcher, logger, probe, cache
        });
        runtime = { config, providers, lookup };
      }
      return runtime;
    }
    const purpose = 'confirmation' + token;
    const configure = createConfigureHandler(sourceSettings, logger, {
      lookup: (type, id) => getRuntime().lookup(type, id),
      confirmations: timing,
      token: (item) => encode(purpose, item),
      readToken: (signed) => decode(purpose, signed)
    });
    return {
      getRuntime, configure,
      allowStream() {
        if (!token) return true;
        const now = Date.now();
        if (now >= resetsAt) {
          resetsAt = now + 60_000;
          requestCount = 0;
        }
        requestCount += 1;
        return requestCount <= 60;
      }
    };
  }

  const owner = createContext(settings, confirmations);
  const contexts = new WeakMap();
  const register = (profile) => {
    if (!contexts.has(profile)) {
      contexts.set(profile, createContext(profile.settings, profile.confirmations, profile.settings.get().installation.token));
    }
    return contexts.get(profile);
  };
  const publicAddress = new URL(publicUrl);
  const signup = profiles && createSignupHandler(profiles, register, logger);

  return createServer(async (req, res) => {
    let url, path;
    try {
      url = new URL(req.url, publicUrl);
      path = decodeURIComponent(url.pathname);
    } catch {
      return write(res, 400, { error: 'Invalid URL' });
    }

    const publicSignup = signup && req.headers.host === publicAddress.host;
    if (publicSignup && ['/configure', '/configure/fields.js'].includes(path)) return signup(req, res, path);
    if (publicSignup && path === iconPath && req.method === 'GET') return write(res, 200, icon, 'image/png');
    if (publicSignup && path === '/' && req.method === 'GET') {
      res.writeHead(302, { Location: publicUrl + '/configure', 'Cache-Control': 'no-store' });
      return res.end();
    }

    let prefix = '';
    let context = owner;
    const installation = settings?.get().installation;
    if (path.startsWith('/install/')) {
      const route = /^\/install\/([a-f0-9]{64})(\/.*)$/.exec(path);
      if (!route) return write(res, 404, { error: 'Route not found' });
      if (installation && timingSafeEqual(Buffer.from(route[1]), Buffer.from(installation.token))) {
        prefix = installPath(installation);
      } else {
        try {
          const profile = await profiles?.get(route[1]);
          if (!profile) return write(res, 404, { error: 'Route not found' });
          context = register(profile);
          prefix = installPath(profile.settings.get().installation);
        } catch {
          logger.warn('Could not load an installation.');
          return write(res, 500, { error: 'The installation could not be loaded' });
        }
      }
      path = route[2];
    } else if ((installation || signup) && !localOrigin(req)) {
      return write(res, 404, { error: 'Route not found' });
    }

    const baseUrl = publicUrl + prefix;
    const trackPurpose = 'track' + prefix;
    if (['/configure', '/configure/check', '/configure/fields.js', '/configure/reveal', '/configure/logout'].includes(path)) {
      url.pathname = path;
      return context.configure.handle(req, res, url, prefix ? new URL(baseUrl) : null);
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }
    if (req.method !== 'GET') return write(res, 405, { error: 'Use GET' });

    const { config, providers, lookup } = context.getRuntime();
    const live = isLive(config);

    if (path === '/manifest.json') return write(res, 200, { ...manifest, logo: baseUrl + iconPath });
    if (path === iconPath) return write(res, 200, icon, 'image/png');
    if (path === '/health.json') return write(res, 200, { mode: live ? 'live' : 'setup' });
    if (path === '/') {
      res.writeHead(302, { Location: prefix ? `${baseUrl}/configure` : '/configure', 'Cache-Control': 'no-store' });
      return res.end();
    }

    try {
      const track = /^\/track\/([^/]+)\.vtt$/.exec(path);
      if (track) {
        const selection = decode(trackPurpose, track[1]);
        if (!selection) return write(res, 404, { error: 'Subtitle link expired' });
        const provider = providers.find(({ id }) => id === selection.provider);
        if (!provider) return write(res, 404, { error: 'Subtitle provider is unavailable' });
        const key = JSON.stringify([selection.path, selection.single, selection.release, selection.video, selection.fileId]);
        const content = await provider.download(key, selection);
        return write(res, 200, shiftVtt(content, selection.offsetMs), 'text/vtt; charset=utf-8');
      }

      const request = /^\/stream\/(movie|series)\/([^/]+)\.json$/.exec(path);
      if (!request) return write(res, 404, { error: 'Route not found' });
      if (!context.allowStream()) return write(res, 429, { error: 'Too many stream requests' });
      const [, type, id] = request;
      const report = live && await lookup(type, id);
      if (!report) return write(res, 200, { streams: [] });
      const trackUrl = (selection) => `${baseUrl}/track/${encode(trackPurpose, selection)}.vtt`;
      const streams = report.selected.map((row) => renderStream(row, report.video, trackUrl, config.matchLabelPosition));
      if (!streams.length && config.shortlist !== false) {
        const { title } = emptyResult(report);
        const query = new URLSearchParams({ id });
        // Stremio hides add-on groups that have zero entries. Keep the message as an external link.
        streams.push({
          name: 'Greek Sub Match',
          description: title + '\nCheck this title for details.',
          externalUrl: `${baseUrl}/configure/check?${query}`
        });
      }
      return write(res, 200, { streams });
    } catch {
      logger.warn('Greek Sub Match could not serve the requested resource.');
      return write(res, 502, { error: 'The requested resource could not be loaded' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const file = fileURLToPath(new URL('../.settings.json', import.meta.url));
    const settings = await openSettings(process.env, file);
    const config = settings.get();
    const confirmations = await openConfirmations(fileURLToPath(new URL('../.confirmations.json', import.meta.url)));
    const profiles = process.env.PUBLIC_SIGNUP === '1'
      ? await openProfiles(config, fileURLToPath(new URL('../.installations/', import.meta.url))) : null;
    const cache = openProbeCache(fileURLToPath(new URL('../.probe-cache.json', import.meta.url)));
    const server = createAddon(config, { settings, confirmations, profiles, cache });
    server.on('error', ({ code }) => {
      console.error(`Could not listen on ${config.host}:${config.port} (${code}).`);
      process.exitCode = 1;
    });
    server.listen(config.port, config.host, () => {
      console.log(`Greek Sub Match (${isLive(config) ? 'live' : 'setup needed'})`);
      console.log(`Stremio manifest: ${config.publicUrl}/manifest.json`);
      console.log(`Configure: ${config.publicUrl}/configure`);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
