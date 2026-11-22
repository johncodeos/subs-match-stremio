import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openConfirmations } from '../src/confirmations.js';
import { createAddon } from '../src/server.js';
import { openProfiles } from '../src/profiles.js';
import { publicSourceAddress } from '../src/public-sources.js';
import { openSettings, readConfig } from '../src/settings.js';

  // Use the same Host header as an HTTPS reverse proxy while exercising HTTP on loopback.
function hostRequest(origin, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body?.toString();
    const request = httpRequest(origin + path, { method, headers: {
      Host: 'addon.example', ...headers,
      ...(payload ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) } : {})
    } }, async (response) => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers }));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
    request.end(payload);
  });
}

test('local settings are saved privately, applied in place, and survive a restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'greek-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, '.settings.json');
  const env = { SUBDL_API_KEY: 'legacy-subdl-secret' };
  const settings = await openSettings(env, file);
  const fetcher = async (url) => {
    if (url.host === 'example.com') return Response.json({ streams: [{
      url: 'https://example.com/test.mp4', name: 'Demo', description: 'Movie release\n4.56 GB',
      behaviorHints: { filename: 'Movie.1080p-YTS.AG.mp4' }
    }, {
      url: 'https://example.com/alternate.mp4', description: 'Alternate release\n1.84 GB',
      behaviorHints: { filename: 'Movie.1080p.WEBRip-YTS.AG.mp4' }
    }] });
    assert.equal(url.host, 'api.opensubtitles.com');
    return Response.json({ data: [{ attributes: {
      language: 'el', release: 'Movie.1080p-YTS.AG', files: [{ file_id: 42 }], feature_details: { imdb_id: 1234567 }
    } }] });
  };
  const server = createAddon(settings.get(), { settings, fetcher });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const manifest = async () => (await fetch(origin + '/manifest.json')).json();
  const before = await manifest();
  assert.equal(before.behaviorHints.configurable, true);
  const page = await fetch(origin + '/configure');
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
  assert.equal(page.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(page.headers.get('Referrer-Policy'), 'same-origin');
  assert.match(page.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /<h1>Greek Sub Match<\/h1>/);
  assert.match(html, /<img src="\/addon-icon\.png"/);
  assert.match(page.headers.get('Content-Security-Policy'), /img-src 'self'/);
  assert.match(html, /OpenSubtitles API key/);
  assert.match(html, /Addons → Installed/);
  assert.match(html, /https:\/\/example\.com\/manifest\.json/);
  assert.match(html, /<textarea id="STREAM_ADDON_MANIFEST" name="STREAM_ADDON_MANIFEST" rows="3" wrap="soft"/);
  assert.match(html, /<textarea id="STREAM_ADDON_MANIFEST_2" name="STREAM_ADDON_MANIFEST_2" rows="3" wrap="soft"/);
  assert.doesNotMatch(html, /aria-controls="STREAM_ADDON_MANIFEST(?:_2)?"/);
  assert.match(html, /<input id="SUBSOURCE_API_KEY" name="SUBSOURCE_API_KEY" type="password"/);
  assert.match(html, /Greek shortlist/);
  assert.match(html, /<option value="end" selected>End<\/option>/);
  assert.match(html, /Stream preview/);
  assert.match(html, /Stream sources <span class="required-mark" aria-hidden="true">\*<\/span>/);
  assert.match(html, /Subtitle providers <span class="required-mark" aria-hidden="true">\*<\/span>/);
  assert.doesNotMatch(html, /Clear a field and save/);
  assert.match(html, /data-saved="true" placeholder="••••••••••••"/);
  assert.match(html, /aria-label="Show SubDL API key"/);
  assert.doesNotMatch(html, /legacy-subdl-secret|type="checkbox"/);
  assert.match(page.headers.get('Content-Security-Policy'), /script-src 'self'; connect-src 'self'/);
  const script = await fetch(origin + '/configure/fields.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('Content-Type'), /^text\/javascript/);
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const post = (body, sender = origin, csrfValue = csrf, path = '/configure') => fetch(origin + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { Origin: sender },
    body: new URLSearchParams({ ...body, csrf: csrfValue })
  });

  const reveal = (field, sender, csrfValue) => post({ field }, sender, csrfValue, '/configure/reveal');
  assert.equal((await fetch(origin + '/configure/reveal')).status, 405);
  assert.equal((await reveal('SUBDL_API_KEY', 'https://external.example')).status, 403);
  assert.equal((await reveal('SUBDL_API_KEY', origin, 'bad-token')).status, 403);
  assert.equal((await reveal('constructor')).status, 400);
  assert.equal((await reveal('STREAM_ADDON_MANIFEST')).status, 400);
  const revealed = await reveal('SUBDL_API_KEY');
  assert.equal(revealed.headers.get('Cache-Control'), 'no-store');
  assert.equal(revealed.headers.get('Access-Control-Allow-Origin'), null);
  assert.deepEqual(await revealed.json(), { value: 'legacy-subdl-secret' });

  const credentials = {
    STREAM_ADDON_MANIFEST: 'stremio://example.com/private-manifest-token/manifest.json',
    OPENSUBTITLES_API_KEY: 'new-open-secret',
    SUBSOURCE_API_KEY: 'new-source-secret',
    STREAM_LIST: 'all',
    EXACT_MATCH_POSITION: 'start',
    clear_SUBDL_API_KEY: '1'
  };
  assert.equal((await post(credentials, 'https://external.example')).status, 403);
  assert.equal((await post(credentials, origin, 'bad-token')).status, 403);
  const invalid = await post({ STREAM_ADDON_MANIFEST: 'https://example.com/no-manifest' });
  assert.equal(invalid.status, 400);
  assert.match(await invalid.text(), /ending in \/manifest.json/);
  const missingStream = await post({});
  assert.equal(missingStream.status, 400);
  assert.match(await missingStream.text(), /Add at least one stream add-on link/);
  const missingKey = await post({ STREAM_ADDON_MANIFEST: 'https://example.com/manifest.json', clear_SUBDL_API_KEY: '1' });
  assert.equal(missingKey.status, 400);
  assert.match(await missingKey.text(), /Add at least one subtitle API key/);
  await assert.rejects(stat(file), { code: 'ENOENT' });

  const saved = await post(credentials);
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get('Location'), '/configure?saved=1');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await (await fetch(origin + '/health.json')).json()).mode, 'live');
  assert.deepEqual(await manifest(), before);

  const after = await (await fetch(origin + saved.headers.get('Location'))).text();
  assert.match(after, /Settings saved/);
  assert.match(after, /Live mode/);
  assert.match(after, /<option value="start" selected>Start<\/option>/);
  assert.match(after, />🇬🇷 Exact match\nExample Movie \(2026\) · 2160p WEB-DL\n4\.56 GB<\/pre>/);
  assert.doesNotMatch(after, /🇬🇷 Greek subtitles · Likely/);
  assert.equal((await openSettings(env, file)).get().subsourceKey, 'new-source-secret');
  assert.deepEqual(await (await reveal('SUBSOURCE_API_KEY')).json(), { value: 'new-source-secret' });
  assert.match(after, /https:\/\/example\.com\/private-manifest-token\/manifest\.json<\/textarea>/);
  assert.doesNotMatch(after, /new-open-secret|new-source-secret|legacy-subdl-secret/);
  assert.equal((await post({ SUBSOURCE_API_KEY: '' })).status, 303);
  assert.deepEqual(await (await reveal('SUBSOURCE_API_KEY')).json(), { value: 'new-source-secret' });
  assert.equal((await post({ clear_SUBSOURCE_API_KEY: '1' })).status, 303);
  assert.deepEqual(await (await reveal('SUBSOURCE_API_KEY')).json(), { value: '' });
  const { streams } = await (await fetch(origin + '/stream/movie/tt1234567.json')).json();
  assert.match(streams[0].subtitles[0].label, /OpenSubtitles/);
  assert.equal(streams[0].description, '🇬🇷 Exact match\nMovie release\n4.56 GB');
  assert.equal(streams[1].description, '🇬🇷 Greek subtitles · Likely · YTS WEBRip\nAlternate release\n1.84 GB');
  assert.equal((await post({ EXACT_MATCH_POSITION: 'invalid' })).status, 400);
  assert.equal((await post({ EXACT_MATCH_POSITION: 'after-first-line' })).status, 303);
  const updated = await (await fetch(origin + '/stream/movie/tt1234567.json')).json();
  assert.equal(updated.streams[0].description, 'Movie release\n🇬🇷 Exact match\n4.56 GB');
  assert.equal(updated.streams[1].description, 'Alternate release\n🇬🇷 Greek subtitles · Likely · YTS WEBRip\n1.84 GB');
  const reopened = (await openSettings(env, file)).get();
  assert.equal(reopened.openSubtitlesKey, 'new-open-secret');
  assert.equal(reopened.subsourceKey, '');
  assert.equal(reopened.apiKey, '');
  assert.equal(reopened.shortlist, false);
  assert.equal(reopened.matchLabelPosition, 'after-first-line');
  assert.equal(reopened.manifestUrls[0].href, 'https://example.com/private-manifest-token/manifest.json');

  assert.equal((await post({ SUBDL_API_KEY: '' })).status, 303);
  assert.equal(settings.get().openSubtitlesKey, 'new-open-secret');
  const removingLastStream = await post({ clear_STREAM_ADDON_MANIFEST: '1' });
  assert.equal(removingLastStream.status, 400);
  assert.match(await removingLastStream.text(), /Add at least one stream add-on link/);
  assert.equal(settings.get().manifestUrls.length, 1);
  const removingLastKey = await post({ clear_OPENSUBTITLES_API_KEY: '1' });
  assert.equal(removingLastKey.status, 400);
  assert.match(await removingLastKey.text(), /Add at least one subtitle API key/);
  assert.equal(settings.get().openSubtitlesKey, 'new-open-secret');
  assert.equal((await post({ clear_STREAM_ADDON_MANIFEST: '1', STREAM_ADDON_MANIFEST_2: 'https://example.com/manifest.json' })).status, 303);
  assert.equal(settings.get().settings.STREAM_ADDON_MANIFEST, '');
  assert.equal((await (await fetch(origin + '/health.json')).json()).mode, 'live');
});

test('title check remembers and removes a user-confirmed offset for the exact playback file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'greek-timing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    STREAM_ADDON_MANIFEST: 'https://streams.example/manifest.json',
    OPENSUBTITLES_API_KEY: 'example-open-key'
  };
  const settings = await openSettings(env, join(directory, '.settings.json'));
  const file = join(directory, '.confirmations.json');
  let confirmations = await openConfirmations(file);
  const publicUrl = 'http://127.0.0.1';
  const state = { returnKnownVanity: true, downloadCalls: 0, firstRow: 'https://streams.example/play/one' };
  const fetcher = async (url) => {
    if (url.host === 'streams.example') return Response.json({ streams: [
      { url: state.firstRow, behaviorHints: { filename: 'Movie.1080p.BluRay-YTS.AG.mp4' } },
      { url: 'https://streams.example/play/two', behaviorHints: { filename: 'Movie.720p.BluRay-YTS.AG.mp4' } }
    ] });
    if (url.pathname.endsWith('/subtitles')) return Response.json({ data: state.returnKnownVanity ? [{
      attributes: { language: 'el', release: '1080p - 720p BluRay YTS.AG', files: [{ file_id: 34 }] }
    }] : [] });
    if (url.pathname.endsWith('/download')) {
      state.downloadCalls += 1;
      return Response.json({ link: 'https://www.opensubtitles.com/download/example.srt' });
    }
    return new Response('1\n00:00:02,000 --> 00:00:04,000\nΕλληνικά\n');
  };
  const listeners = [];
  async function listen() {
    const server = createAddon({ ...settings.get(), publicUrl }, { settings, confirmations, fetcher });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    listeners.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }
  t.after(() => Promise.all(listeners.map((server) => new Promise((resolve) => server.close(resolve)))));
  let origin = await listen();
  const detail = '/configure/check?id=tt1234567';
  const view = () => fetch(origin + detail).then((response) => response.text());
  const getStreams = () => fetch(origin + '/stream/movie/tt1234567.json').then((response) => response.json());
  async function submit(form, action, offset) {
    const csrf = form.match(/name="csrf" value="([^"]+)"/)[1];
    const token = form.match(/name="token" value="([^"]+)"/)[1];
    return fetch(origin + '/configure/check', {
      method: 'POST', headers: { Origin: origin }, redirect: 'manual',
      body: new URLSearchParams({ csrf, token, action, offset })
    });
  }

  const initial = await view();
  assert.match(initial, /Likely · YTS BluRay/);
  assert.doesNotMatch(initial, /example-open-key|streams\.example\/play/);
  const invalid = await submit(initial, 'confirm', '9999');
  assert.equal(invalid.status, 400);
  const saved = await submit(initial, 'confirm', '1.25');
  assert.equal(saved.status, 303);
  assert.match(await (await fetch(origin + saved.headers.get('Location'))).text(), /Confirmed timing saved/);
  let { streams } = await getStreams();
  assert.match(streams[0].description, /Confirmed timing/);
  assert.doesNotMatch(streams[1].description, /Confirmed timing/);

  const trackPath = new URL(streams[0].subtitles.at(-1).url).pathname;
  const caption = await (await fetch(origin + trackPath)).text();
  assert.match(caption, /00:00:03\.250 --> 00:00:05\.250/);
  assert.equal(state.downloadCalls, 1);

  confirmations = await openConfirmations(file);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  state.returnKnownVanity = false;
  origin = await listen();
  ({ streams } = await getStreams());
  assert.equal(streams.length, 1);
  assert.match(streams[0].description, /Confirmed timing/);

  const removed = await submit(await view(), 'remove', '1.25');
  assert.equal(removed.status, 303);
  assert.match(await (await fetch(origin + removed.headers.get('Location'))).text(), /Timing confirmation removed/);
  ({ streams } = await getStreams());
  assert.equal(streams.length, 1);
  assert.match(streams[0].description, /No Greek subtitles found/);
  assert.equal(streams[0].externalUrl, publicUrl + '/configure/check?id=tt1234567');
  assert.equal(streams[0].url, undefined);
});

test('creates a private install link and unlocks its saved settings with a password', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'greek-install-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, '.settings.json');
  const env = { PUBLIC_URL: 'https://addon.example', STREAM_ADDON_MANIFEST: 'https://streams.example/manifest.json', SUBDL_API_KEY: 'fixture-provider-secret' };
  const settings = await openSettings(env, file);
  const fetcher = async (url) => {
    if (url.hostname === 'streams.example') return Response.json({ streams: [{
      url: 'https://streams.example/video.mp4', behaviorHints: { filename: 'Movie.2160p.WEB-DL-GRP.mkv' }
    }] });
    if (url.hostname === 'api.subdl.com') return Response.json({ status: true, subtitles: [{
      release_name: 'Movie.2160p.WEB-DL-GRP', language: 'EL', url: '/subtitle/subsource-test.srt'
    }] });
    assert.equal(url.hostname, 'dl.subdl.com');
    return new Response('1\n00:00:01,000 --> 00:00:02,000\nΕλληνικά\n');
  };
  const server = createAddon(settings.get(), { settings, fetcher });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const csrfFrom = (html) => html.match(/name="csrf" value="([^"]+)"/)[1];
  const local = (path, options = {}) => fetch(origin + path, options);
  const remote = (path, options) => hostRequest(origin, path, options);
  const post = (request, path, form, options = {}) => request(path, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: request === local ? origin : env.PUBLIC_URL, ...options.headers },
    body: new URLSearchParams(form)
  });

  const firstPage = await (await local('/configure')).text();
  const setupCsrf = csrfFrom(firstPage);
  const password = 'first-fixture-password';
  const shortPassword = await post(local, '/configure', { csrf: setupCsrf, install_password: 'short' });
  assert.equal(shortPassword.status, 400);
  assert.equal((await post(local, '/configure', { csrf: setupCsrf, install_password: password })).status, 303);
  const saved = await readFile(file, 'utf8');
  assert.ok(!saved.includes(password));
  assert.match(JSON.parse(saved).installation.hash, /^[a-f0-9]{64}$/);
  const link = new URL((await (await local('/configure')).text()).match(/id="install-manifest" value="([^"]+)"/)[1]);
  assert.match(link.pathname, /^\/install\/[a-f0-9]{64}\/manifest\.json$/);
  assert.equal(link.origin, env.PUBLIC_URL);
  assert.ok(!link.href.includes(env.SUBDL_API_KEY));
  assert.ok((await (await local('/configure')).text()).includes(link.href.replace('https://', 'stremio://')));

  const configure = link.pathname.replace('/manifest.json', '/configure');
  const remoteManifest = await (await remote(link.pathname)).json();
  assert.equal(remoteManifest.behaviorHints.configurable, true);
  assert.equal(remoteManifest.logo, link.href.replace('/manifest.json', '/addon-icon.png'));
  assert.equal((await remote('/manifest.json')).status, 404);
  assert.equal((await remote('/configure')).status, 404);
  assert.equal((await local('/manifest.json')).status, 200);
  assert.equal((await remote(`/install/${'f'.repeat(64)}/manifest.json`)).status, 404);

  const streamPath = link.pathname.replace('/manifest.json', '/stream/movie/tt1234567.json');
  const { streams } = await (await remote(streamPath)).json();
  const track = new URL(streams[0].subtitles[0].url);
  assert.ok(track.pathname.startsWith(link.pathname.replace('/manifest.json', '/track/')));
  const caption = await remote(track.pathname);
  assert.equal(caption.status, 200);
  assert.match(await caption.text(), /^WEBVTT/);

  const locked = await (await remote(configure)).text();
  assert.match(locked, /Unlock Configure/);
  assert.doesNotMatch(locked, /streams\.example|fixture-provider-secret|configure-settings/);
  assert.equal((await post(remote, `${configure}/reveal`, { csrf: setupCsrf, field: 'SUBDL_API_KEY' })).status, 403);
  const login = (value, options) => post(remote, configure, {
    csrf: csrfFrom(locked), login: '1', unlock_password: value
  }, options);
  assert.equal((await login(password, { headers: { Origin: 'https://external.example' } })).status, 403);
  assert.equal((await login('incorrect-test-password')).status, 401);
  const authenticated = await login(password);
  assert.equal(authenticated.status, 303);
  const cookie = authenticated.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict; Secure/);
  assert.ok(cookie.includes(`Path=${configure};`));
  const headers = { Cookie: cookie.split(';')[0] };
  const editor = await (await remote(configure, { headers })).text();
  assert.match(editor, /https:\/\/streams\.example\/manifest\.json/);
  assert.doesNotMatch(editor, /fixture-provider-secret/);
  assert.ok(editor.includes(`action="${configure}"`));
  const csrf = csrfFrom(editor);
  const revealed = await post(remote, `${configure}/reveal`, { csrf, field: 'SUBDL_API_KEY' }, { headers });
  assert.deepEqual(await revealed.json(), { value: env.SUBDL_API_KEY });
  const edit = await post(remote, configure, { csrf, STREAM_LIST: 'all' }, { headers });
  assert.equal(edit.status, 303);
  assert.equal((await openSettings(env, file)).get().shortlist, false);
  const exit = await post(remote, `${configure}/logout`, { csrf }, { headers });
  assert.equal(exit.status, 303);
  assert.match(await (await remote(configure, { headers })).text(), /Unlock Configure/);

  const nextPassword = 'replacement-fixture-password';
  assert.equal((await post(local, '/configure', { csrf: setupCsrf, install_password: nextPassword })).status, 303);
  assert.equal((await openSettings(env, file)).get().installation.token, JSON.parse(saved).installation.token);
  assert.equal((await login(password)).status, 401);
  assert.equal((await login(nextPassword)).status, 303);
  for (let i = 0; i < 5; i++) assert.equal((await login('incorrect')).status, 401);
  assert.equal((await login(nextPassword)).status, 429);
});

test('public Configure creates separate installations with independent settings and sessions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'greek-profiles-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = 'https://addon.example';
  const initial = readConfig({ PUBLIC_URL: base });
  const ownerSettings = await openSettings({ PUBLIC_URL: base,
    STREAM_ADDON_MANIFEST: 'https://owner.example/manifest.json', SUBDL_API_KEY: 'owner-fixture-key' }, join(directory, '.settings.json'));
  const files = join(directory, 'profiles');
  const profiles = await openProfiles(initial, files);
  const sources = [];
  const keys = [];
  const server = createAddon(initial, { settings: ownerSettings, profiles,
    publicSourceFetcher: async (url) => {
      if (url.pathname.endsWith('.json')) sources.push(url.hostname);
      return Response.json({ streams: [{ url: `https://${url.hostname}/video.mp4`,
        behaviorHints: { filename: 'Example.Movie.2160p.WEB-DL-GRP.mkv' } }] });
    },
    fetcher: async (url) => {
      assert.equal(url.hostname, 'api.subdl.com');
      keys.push(url.searchParams.get('api_key'));
      return Response.json({ status: true, subtitles: [{
        release_name: 'Example.Movie.2160p.WEB-DL-GRP', language: 'EL', url: '/subtitle/example.srt'
      }] });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const remote = (path, options) => hostRequest(origin, path, options);
  const csrfFrom = (page) => page.match(/name="csrf" value="([^"]+)"/)[1];
  const post = (path, form, cookie) => remote(path, {
    method: 'POST', headers: { Origin: base, ...(cookie ? { Cookie: cookie } : {}) }, body: new URLSearchParams(form)
  });
  const publicPage = await (await remote('/configure')).text();
  assert.match(publicPage, /Create install link/);
  assert.doesNotMatch(publicPage, /owner\.example|owner-fixture-key/);
  assert.match(await (await fetch(origin + '/configure')).text(), /https:\/\/owner\.example/);
  assert.equal((await remote('/manifest.json')).status, 404);
  const signup = (source, key, password) => post('/configure', { csrf: csrfFrom(publicPage),
    STREAM_ADDON_MANIFEST: source, SUBDL_API_KEY: key, install_password: password });
  assert.equal((await signup('http://example.com/manifest.json', 'fixture-test', 'test-account-password')).status, 400);
  assert.equal((await signup('https://127.0.0.1/manifest.json', 'fixture-test', 'test-account-password')).status, 400);
  assert.equal(publicSourceAddress({ address: '10.1.2.3', family: 4 }), false);
  assert.equal(publicSourceAddress({ address: '::1', family: 6 }), false);
  assert.equal(publicSourceAddress({ address: '192.168.1.1', family: 4 }), false);
  assert.equal(publicSourceAddress({ address: '2606:4700:4700::1111', family: 6 }), true);

  async function register(name) {
    const password = `${name}-distinct-fixture-password`;
    const key = `${name}-fixture-key`;
    const response = await signup(`https://${name}.example/manifest.json`, key, password);
    assert.equal(response.status, 303);
    const location = new URL(response.headers.get('location'), base);
    assert.equal(location.hash, '#install-addon');
    assert.ok(!location.href.includes(key) && !location.href.includes(password));
    const token = location.pathname.split('/')[2];
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const editor = await (await remote(location.pathname, { headers: { Cookie: cookie } })).text();
    assert.match(editor, /Install in Stremio/);
    assert.ok(editor.includes(`https://${name}.example/manifest.json`));
    assert.ok(!editor.includes(key));
    return { token, configure: location.pathname, cookie, key, password, csrf: csrfFrom(editor) };
  }
  const a = await register('first');
  const b = await register('second');
  assert.notEqual(a.token, b.token);
  const locked = await (await remote(b.configure, { headers: { Cookie: a.cookie } })).text();
  assert.match(locked, /Unlock Configure/);
  assert.doesNotMatch(locked, /first\.example|second\.example/);
  const reveal = (installation) => post(`${installation.configure}/reveal`, {
    csrf: installation.csrf, field: 'SUBDL_API_KEY'
  }, installation.cookie);
  assert.deepEqual(await (await reveal(a)).json(), { value: a.key });
  assert.deepEqual(await (await reveal(b)).json(), { value: b.key });
  assert.equal((await reveal({ ...b, cookie: a.cookie })).status, 403);
  const unlock = (installation, password) => post(installation.configure, {
    login: '1', csrf: csrfFrom(locked), unlock_password: password
  });
  assert.equal((await unlock(b, a.password)).status, 401);
  assert.equal((await unlock(b, b.password)).status, 303);
  assert.equal((await post(b.configure, { csrf: b.csrf, STREAM_LIST: 'all' }, b.cookie)).status, 303);

  const restored = await openProfiles(initial, files);
  assert.equal((await restored.get(a.token)).settings.get().shortlist, true);
  assert.equal((await restored.get(b.token)).settings.get().shortlist, false);
  assert.equal((await restored.get(a.token)).settings.get().apiKey, a.key);
  assert.equal((await restored.get(b.token)).settings.get().apiKey, b.key);
  for (const [name, installation] of [['first', a], ['second', b]]) {
    const stream = await remote(`/install/${installation.token}/stream/movie/tt1234567.json`);
    const { streams } = await stream.json();
    assert.equal(streams[0].url, `https://${name}.example/video.mp4`);
    assert.ok(new URL(streams[0].subtitles[0].url).pathname.startsWith(`/install/${installation.token}/track/`));
  }
  assert.deepEqual(sources, ['first.example', 'second.example']);
  assert.deepEqual(keys, [a.key, b.key]);
});
