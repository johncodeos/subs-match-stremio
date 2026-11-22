import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAddon, readConfig } from '../src/server.js';

const video = '/stream/series/tt1234567:2:3.json';
const apiManifest = new URL('https://streams.example/config%3Dprivate/manifest.json?token=private');
const source = {
  url: 'https://streams.example/video.mp4',
  name: 'Source 1080p',
  description: 'Original stream details',
  behaviorHints: { filename: 'Show.S02E03.1080p.YTS.AG.mp4', videoSize: 999 },
  subtitles: [{ id: 'legacy', url: 'https://streams.example/track.vtt', lang: 'eng' }]
};
const unmatched = { ...source, url: 'https://streams.example/alternate.mp4', behaviorHints: { filename: 'Show.S02E03.1080p.Bluray-SPARKS.mp4' } };

async function listen(t, config, dependencies) {
  const server = createAddon({ shortlist: false, ...config, publicUrl: 'http://127.0.0.1' }, dependencies);
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return (path) => fetch(origin + path);
}

test('manifest exposes Configure and only declares movie and series streams', async (t) => {
  const get = await listen(t, {});
  const manifest = await get('/manifest.json');
  assert.equal(manifest.headers.get('Access-Control-Allow-Origin'), '*');
  const descriptor = await manifest.json();
  assert.deepEqual(descriptor.resources, ['stream']);
  assert.deepEqual(descriptor.types, ['movie', 'series']);
  assert.deepEqual(descriptor.catalogs, []);
  assert.equal(descriptor.behaviorHints.configurable, true);
  assert.equal(descriptor.logo, 'http://127.0.0.1/addon-icon.png');
  const icon = await get(new URL(descriptor.logo).pathname);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('Content-Type'), 'image/png');
  assert.equal(Buffer.from(await icon.arrayBuffer()).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual(await (await get('/stream/movie/tt1234567.json')).json(), { streams: [] });
  assert.equal((await get('/demo.vtt')).status, 404);
});

test('live mode requests the right episode, ranks it and delivers a signed caption URL', async (t) => {
  const { description, ...sourceFields } = source;
  const legacySource = { ...sourceFields, title: description };
  const seen = [];
  const fetcher = async (url) => {
    seen.push(url);
    if (url.host === 'streams.example') return Response.json({ streams: [unmatched, legacySource] });
    if (url.host === 'api.subdl.com') return Response.json({
      status: true, results: [{ imdb_id: 'tt1234567' }], subtitles: [{
        release_name: '1080p - 720p YTS.AG',
        unpack_files: [{ season: 2, episode: 3, name: 'Show.S02E03.1080p.YTS.AG.srt', language: 'EL', url: '/subtitle/123/file' }]
      }]
    });
    assert.equal(url.href, 'https://dl.subdl.com/subtitle/123/file');
    return new Response('1\n00:00:01,000 --> 00:00:03,500\nΕλληνικά\n');
  };
  const get = await listen(t, { manifestUrls: [apiManifest], apiKey: 'example-key' }, { fetcher });
  const [response, repeated] = await Promise.all([get(video), get(video)]);
  const { streams } = await response.json();
  assert.equal((await repeated.json()).streams.length, 2);
  assert.equal(seen.filter((url) => url.host === 'api.subdl.com').length, 1);
  const upstream = seen.find((url) => url.host === 'streams.example');
  assert.equal(upstream.pathname, '/config%3Dprivate' + video);
  assert.equal(upstream.searchParams.get('token'), 'private');
  const query = seen.find((url) => url.host === 'api.subdl.com').searchParams;
  assert.equal(query.get('season_number'), '2');
  assert.equal(query.get('episode_number'), '3');
  assert.equal(query.get('languages'), 'EL');
  assert.equal(streams[0].description, 'Original stream details\n🇬🇷 Exact match');
  assert.equal(Object.hasOwn(streams[0], 'title'), false);
  assert.deepEqual(streams[1], unmatched);
  assert.deepEqual(streams[0].behaviorHints, source.behaviorHints);
  assert.equal(streams[0].subtitles[0].id, 'legacy');
  const track = new URL(streams[0].subtitles[1].url).pathname;
  const captions = await get(track);
  assert.match(captions.headers.get('Content-Type'), /^text\/vtt/);
  assert.match(await captions.text(), /WEBVTT[\s\S]+Ελληνικά/);
  assert.equal((await get(track.replace(/(^\/track\/)./, '$1_'))).status, 404);
});

test('keeps upstream results if SubDL is unavailable', async (t) => {
  const warnings = [];
  const fetcher = async (url) => url.host === 'streams.example'
    ? Response.json({ streams: [source, unmatched] }) : new Response(null, { status: 429 });
  const get = await listen(t, { manifestUrls: [apiManifest], apiKey: 'example-key' }, {
    fetcher, logger: { warn: (message) => warnings.push(message) }
  });
  assert.deepEqual(await (await get(video)).json(), { streams: [source, unmatched] });
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('example-key'));
});

test('delivers the matching episode out of a zipped season pack', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'greek-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file1 = 'Show.S02E02.1080p-YTS.AG.srt';
  const file2 = 'Show.S02E03.1080p-[YTS.AG].srt';
  await writeFile(join(dir, file1), '1\n00:00:01,000 --> 00:00:04,000\nWrong episode\n');
  await writeFile(join(dir, file2), '1\n00:00:01,000 --> 00:00:04,000\nΣωστό επεισόδιο\n');
  execFileSync('/usr/bin/zip', ['-q', 'pack.zip', file1, file2], { cwd: dir });
  const zip = await readFile(join(dir, 'pack.zip'));
  const fetcher = async (url) => {
    if (url.host === 'streams.example') return Response.json({ streams: [source] });
    if (url.host === 'api.subdl.com') return Response.json({
      status: true, subtitles: [{
        season: 2, episode_from: 1, episode_end: 8, full_season: true,
        url: '/subtitle/123-456.zip', releases: ['1080p - 720p YTS.AG'], language: 'EL'
      }]
    });
    return new Response(zip);
  };
  const get = await listen(t, { manifestUrls: [apiManifest], apiKey: 'example-key' }, { fetcher });
  const { streams } = await (await get(video)).json();
  assert.match(await (await get(new URL(streams[0].subtitles[1].url).pathname)).text(), /Σωστό επεισόδιο/);
});

test('a manifest URL is needed from a stream provider and secrets stay in local config', () => {
  assert.equal(readConfig({}).host, '127.0.0.1');
  assert.equal(readConfig({ SUBDL_API_KEY: 'placeholder' }).apiKey, 'placeholder');
  assert.throws(() => readConfig({ STREAM_ADDON_MANIFEST: 'https://example.com/configure' }), /manifest.json/);
});

test('combines configured stream add-ons and tolerates one being unavailable', async (t) => {
  const secondary = new URL('https://backup.example/manifest.json');
  const queried = [];
  const fetcher = async (url) => {
    queried.push(url.host);
    if (url.host === 'streams.example') return new Response(null, { status: 503 });
    if (url.host === 'backup.example') return Response.json({ streams: [unmatched, source] });
    return Response.json({ status: true, subtitles: [{
      season: 2, episode: 3, release_name: '1080p - 720p YTS.AG',
      language: 'Greek', url: '/subtitle/123-456.zip'
    }] });
  };
  const get = await listen(t, { manifestUrls: [apiManifest, secondary], apiKey: 'example-key' }, {
    fetcher, logger: { warn() {} }
  });
  const { streams } = await (await get(video.replaceAll(':', '%3A'))).json();
  assert.deepEqual(new Set(queried), new Set(['streams.example', 'backup.example', 'api.subdl.com']));
  assert.match(streams[0].description, /Likely · YTS/);
  assert.deepEqual(streams[1], unmatched);
});

test('uses the TMDB title and episode ID passed by AIOMetadata', async (t) => {
  const fetcher = async (url) => {
    if (url.host === 'streams.example') {
      assert.match(url.pathname, /\/stream\/series\/tmdb:54321:2:3\.json$/);
      return Response.json({ streams: [source] });
    }
    assert.equal(url.searchParams.get('tmdb_id'), '54321');
    assert.equal(url.searchParams.get('imdb_id'), null);
    assert.equal(url.searchParams.get('season_number'), '2');
    assert.equal(url.searchParams.get('episode_number'), '3');
    return Response.json({ status: true, results: [{ tmdb_id: 54321 }], subtitles: [{
      season: 2, episode: 3, release_name: '1080p - 720p YTS.AG',
      language: 'EL', url: '/subtitle/123-456.zip'
    }] });
  };
  const get = await listen(t, { manifestUrls: [apiManifest], apiKey: 'example-key' }, { fetcher });
  const manifest = await (await get('/manifest.json')).json();
  assert.ok(manifest.idPrefixes.includes('tmdb:'));
  const { streams } = await (await get('/stream/series/tmdb:54321:2:3.json')).json();
  assert.match(streams[0].description, /Likely · YTS/);
});

test('OpenSubtitles works on its own and uses its download API with no credential sent to the file host', async (t) => {
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push({ url, options });
    if (url.host === 'streams.example') return Response.json({ streams: [unmatched, source] });
    if (url.pathname.endsWith('/subtitles')) return Response.json({ data: [{
      attributes: {
        language: 'el', release: '1080p - 720p YTS.AG',
        feature_details: { parent_imdb_id: 1234567, season_number: 2, episode_number: 3 },
        files: [{ file_id: 41, file_name: 'Show.S02E03.1080p.YTS.AG.srt' }]
      }
    }, {
      attributes: {
        language: 'el', release: 'Show.S02E03.1080p.Bluray-SPARKS',
        feature_details: { parent_imdb_id: 1234567, season_number: 2, episode_number: 4 },
        files: [{ file_id: 42, file_name: 'Show.S02E03.1080p.Bluray-SPARKS.srt' }]
      }
    }] });
    if (url.pathname.endsWith('/download')) return Response.json({ link: 'https://www.opensubtitles.com/download/subfile/show.srt' });
    assert.equal(url.host, 'www.opensubtitles.com');
    return new Response('1\n00:00:01,000 --> 00:00:03,000\nΕλληνικά από OpenSubtitles\n');
  };
  const get = await listen(t, { manifestUrls: [apiManifest], openSubtitlesKey: 'open-key' }, { fetcher });
  const { streams } = await (await get(video)).json();
  assert.match(streams[0].description, /(?:^|\n)🇬🇷 Exact match$/);
  assert.deepEqual(streams[1], unmatched);
  const track = streams[0].subtitles[1];
  assert.match(track.label, /OpenSubtitles/);
  assert.match(await (await get(new URL(track.url).pathname)).text(), /Ελληνικά από OpenSubtitles/);
  const search = seen.find(({ url }) => url.pathname.endsWith('/subtitles'));
  assert.equal(search.url.searchParams.get('parent_imdb_id'), '1234567');
  assert.equal(search.url.searchParams.get('episode_number'), '3');
  assert.equal(search.url.searchParams.get('languages'), 'el');
  assert.equal(search.options.headers['Api-Key'], 'open-key');
  const download = seen.find(({ url }) => url.pathname === '/api/v1/download');
  assert.equal(download.options.method, 'POST');
  assert.deepEqual(JSON.parse(download.options.body), { file_id: 41, sub_format: 'srt' });
  const fileRequest = seen.find(({ url }) => url.host === 'www.opensubtitles.com');
  assert.ok(!fileRequest.options.headers?.['Api-Key']);
});

test('keeps an OpenSubtitles match if SubDL is down', async (t) => {
  const fetcher = async (url) => {
    if (url.host === 'streams.example') return Response.json({ streams: [source] });
    if (url.host === 'api.subdl.com') return new Response(null, { status: 429 });
    return Response.json({ data: [{
      attributes: {
        language: 'el', release: '1080p YTS.AG',
        feature_details: { parent_imdb_id: 1234567, season_number: 2, episode_number: 3 },
        files: [{ file_id: 41 }]
      }
    }] });
  };
  const get = await listen(t, {
    manifestUrls: [apiManifest], apiKey: 'test-subdl', openSubtitlesKey: 'test-opensubtitles'
  }, { fetcher, logger: { warn() {} } });
  const { streams } = await (await get(video)).json();
  assert.match(streams[0].description, /Likely · YTS/);
  assert.match(streams[0].subtitles[1].label, /OpenSubtitles/);
});

test('shortlists 12 matches and collapses identical playback URLs', async (t) => {
  const matched = Array.from({ length: 13 }, (_, index) => ({
    ...source, url: `https://streams.example/movie-${index}.mp4`
  }));
  const fetcher = async (url) => {
    if (url.host === 'streams.example') return Response.json({ streams: [unmatched, matched[0], ...matched] });
    return Response.json({ status: true, subtitles: [{
      season: 2, episode: 3, release_name: '1080p - 720p YTS.AG', language: 'EL', url: '/subtitle/123-456.zip'
    }] });
  };
  const get = await listen(t, { manifestUrls: [apiManifest], apiKey: 'test-key', shortlist: true }, { fetcher });
  const { streams } = await (await get(video)).json();
  assert.equal(streams.length, 12);
  assert.equal(new Set(streams.map((stream) => stream.url)).size, 12);
  assert.ok(streams.every((stream) => /Likely · YTS/.test(stream.description)));
});

test('checks another OpenSubtitles results page when the first page yields no match', async (t) => {
  const pages = [];
  const fetcher = async (url) => {
    if (url.host === 'streams.example') return Response.json({ streams: [source] });
    const page = url.searchParams.get('page');
    pages.push(page);
    return Response.json({ total_pages: 2, data: page === '2' ? [{ attributes: {
      language: 'el', release: 'Show.S02E03.1080p.YTS.AG',
      feature_details: { season_number: 2, episode_number: 3 }, files: [{ file_id: 77 }]
    } }] : [] });
  };
  const get = await listen(t, { manifestUrls: [apiManifest], openSubtitlesKey: 'test-key' }, { fetcher });
  const { streams } = await (await get(video)).json();
  assert.deepEqual(pages, [null, '2']);
  assert.match(streams[0].description, /(?:^|\n)🇬🇷 Exact match$/);
});

test('labels only provider-verified matching video hashes', async (t) => {
  const hash = '1234567890abcdef';
  const first = { ...source, behaviorHints: { videoHash: hash } };
  const fetcher = async (url) => {
    if (url.host === 'streams.example') return Response.json({ streams: [unmatched, first] });
    const searchedHash = url.searchParams.get('moviehash');
    if (!searchedHash) return Response.json({ data: [] });
    assert.equal(searchedHash, hash);
    const feature_details = { season_number: 2, episode_number: 3 };
    return Response.json({ data: [
      { attributes: { language: 'el', feature_details, moviehash_match: false, files: [{ file_id: 81 }] } },
      { attributes: { language: 'el', feature_details, moviehash_match: true, files: [{ file_id: 82 }] } }
    ] });
  };
  const get = await listen(t, { manifestUrls: [apiManifest], openSubtitlesKey: 'test-key' }, { fetcher });
  const { streams } = await (await get(video)).json();
  assert.match(streams[0].description, /Video hash match/);
  assert.deepEqual(streams[1], unmatched);
  const selection = JSON.parse(Buffer.from(new URL(streams[0].subtitles[1].url).pathname.split('/').at(-1).split('.')[0], 'base64url'));
  assert.equal(selection.fileId, 82);
});

test('the Greek shortlist shows a title-check link when releases do not match', async (t) => {
  const fetcher = async (url) => {
    if (url.host === 'streams.example') return Response.json({ streams: [unmatched] });
    return Response.json({ data: [{
      attributes: {
        language: 'el', release: '720p WEB-DL YTS',
        feature_details: { season_number: 2, episode_number: 3 }, files: [{ file_id: 77 }]
      }
    }] });
  };
  const get = await listen(t, { manifestUrls: [apiManifest], openSubtitlesKey: 'test-key', shortlist: true }, { fetcher });
  const { streams } = await (await get(video)).json();
  assert.deepEqual(streams, [{
    name: 'Greek Sub Match',
    description: 'No Greek subtitle match\nCheck this title for details.',
    externalUrl: 'http://127.0.0.1/configure/check?id=tt1234567%3A2%3A3'
  }]);
});

test('SubSource finds Greek movie releases and serves the selected episode from its own archive', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'greek-subsource-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const movieRelease = 'Movie.2026.2160p.HDR.BluRay-GRP';
  const episodeRelease = 'Show.S02E03.1080p.YTS.AG';
  const episodeName = `${episodeRelease}.srt`;
  const otherName = 'Show.S02E04.1080p.YTS.AG.srt';
  await writeFile(join(directory, episodeName), '1\n00:00:01,000 --> 00:00:03,500\nΕπεισόδιο 3\n');
  await writeFile(join(directory, otherName), '1\n00:00:01,000 --> 00:00:03,500\nΕπεισόδιο 4\n');
  execFileSync('/usr/bin/zip', ['track.zip', otherName, episodeName], { cwd: directory });
  const archive = await readFile(join(directory, 'track.zip'));
  const fetcher = async (url, options) => {
    if (url.host === 'streams.example') {
      const movie = url.pathname.includes('/movie/');
      return Response.json({ streams: movie ? [{ ...source, behaviorHints: { filename: `${movieRelease}.mkv` } }] : [unmatched, source] });
    }
    assert.equal(url.origin, 'https://api.subsource.net');
    assert.equal(options.headers['X-API-Key'], 'local-test-key');
    assert.equal(options.redirect, 'error');
    assert.equal(url.search.includes('local-test-key'), false);
    if (url.pathname.endsWith('/movies/search')) {
      assert.equal(url.searchParams.get('imdb'), 'tt1234567');
      assert.equal(url.searchParams.get('searchType'), 'imdb');
      const series = url.searchParams.get('type') === 'series';
      assert.equal(url.searchParams.get('season'), series ? '2' : null);
      return Response.json({ success: true, data: [{ imdbId: 'tt1234567', movieId: series ? 31 : 30, season: series ? 2 : null }] });
    }
    if (url.pathname.endsWith('/subtitles')) {
      assert.equal(url.searchParams.get('language'), 'greek');
      assert.equal(url.searchParams.has('foreignParts'), false);
      const movieId = Number(url.searchParams.get('movieId'));
      assert.ok([30, 31].includes(movieId));
      if (movieId === 30) return Response.json({ success: true, data: [{ movieId, subtitleId: 41, language: 'greek', releaseInfo: [movieRelease], files: 1 }] });
      return Response.json({ success: true, data: [
        { movieId, subtitleId: 42, language: 'Greek', releaseInfo: [episodeRelease], files: 2 },
        { movieId, subtitleId: 43, language: 'Greek', releaseInfo: ['Show.S02E04.1080p.BluRay-SPARKS'], files: 1 },
        { movieId, subtitleId: 44, language: 'English', releaseInfo: ['Show.S02E03.1080p.BluRay-SPARKS'], files: 1 },
        { movieId, subtitleId: 45, language: 'Greek', foreignParts: true, releaseInfo: ['Show.S02E03.1080p.BluRay-SPARKS'], files: 1 }
      ] });
    }
    assert.equal(url.pathname, '/api/v1/subtitles/42/download');
    return new Response(archive);
  };
  const get = await listen(t, { manifestUrls: [apiManifest], subsourceKey: 'local-test-key' }, { fetcher });
  assert.equal((await (await get('/health.json')).json()).mode, 'live');
  const movie = (await (await get('/stream/movie/tt1234567.json')).json()).streams[0];
  assert.match(movie.description, /(?:^|\n)🇬🇷 Exact match$/);
  const { streams } = await (await get(video)).json();
  assert.equal(streams.length, 2);
  assert.equal(streams[0].url, source.url);
  const track = streams[0].subtitles.find(({ lang }) => lang === 'gre');
  assert.match(track.label, /SubSource/);
  assert.equal(streams[1].subtitles.some(({ lang }) => lang === 'gre'), false);
  const response = await get(new URL(track.url).pathname);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /^text\/vtt/);
  assert.match(await response.text(), /^WEBVTT\s+1\n00:00:01\.000 --> 00:00:03\.500\nΕπεισόδιο 3\s*$/);
});
