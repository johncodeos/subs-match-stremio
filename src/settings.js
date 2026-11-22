import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { installPath, setInstallationPassword, validInstallation, validPassword } from './installation.js';
import { publicSourceUrl } from './public-sources.js';

export const fields = {
  STREAM_ADDON_MANIFEST: 'Stream add-on link',
  STREAM_ADDON_MANIFEST_2: 'Second stream add-on link (optional)',
  SUBDL_API_KEY: 'SubDL API key',
  OPENSUBTITLES_API_KEY: 'OpenSubtitles API key',
  SUBSOURCE_API_KEY: 'SubSource API key'
};

export const matchLabelPositions = {
  start: 'Start',
  'after-first-line': 'After the first line',
  end: 'End'
};

export const setupRequirements = {
  streams: 'Add at least one stream add-on link.',
  providers: 'Add at least one subtitle API key.'
};

export class InvalidSettings extends Error {}

export async function writePrivateJson(file, value) {
  const temp = join(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

export function readConfig(env) {
  const settings = {};
  const manifestUrls = [];
  for (const [key, label] of Object.entries(fields)) {
    const value = env[key];
    if (value != null && typeof value !== 'string') throw new InvalidSettings(`${label} must be text.`);
    settings[key] = value?.trim() ?? '';
  }

  for (const key of ['STREAM_ADDON_MANIFEST', 'STREAM_ADDON_MANIFEST_2']) {
    if (!settings[key]) continue;
    try {
      const url = new URL(settings[key].replace(/^stremio:\/\//i, 'https://'));
      if (settings[key].length > 4096 || !['http:', 'https:'].includes(url.protocol) ||
          url.username || url.password || !url.pathname.endsWith('/manifest.json')) throw new Error();
      url.hash = '';
      settings[key] = url.href;
      if (!manifestUrls.some((item) => item.href === url.href)) manifestUrls.push(url);
    } catch {
      throw new InvalidSettings(`${fields[key]} must be an HTTP(S) or stremio:// URL ending in /manifest.json.`);
    }
  }

  for (const key of ['SUBDL_API_KEY', 'OPENSUBTITLES_API_KEY', 'SUBSOURCE_API_KEY']) {
    if (settings[key] && !/^[!-~]{1,256}$/.test(settings[key])) {
      throw new InvalidSettings(`${fields[key]} must be a single value without spaces.`);
    }
  }

  settings.STREAM_LIST = env.STREAM_LIST || 'shortlist';
  if (!['shortlist', 'all'].includes(settings.STREAM_LIST)) {
    throw new InvalidSettings('Choose either the Greek shortlist or all streams.');
  }

  // Keep the existing key so saved preferences also apply to likely matches.
  settings.EXACT_MATCH_POSITION = env.EXACT_MATCH_POSITION || 'end';
  if (!Object.hasOwn(matchLabelPositions, settings.EXACT_MATCH_POSITION)) {
    throw new InvalidSettings('Choose where the match label appears.');
  }

  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 7331);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');

  let publicUrl;
  try {
    const url = new URL(env.PUBLIC_URL || `http://127.0.0.1:${port}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    publicUrl = url.href.replace(/\/+$/, '');
  } catch {
    throw new Error('PUBLIC_URL must be an HTTP(S) base URL.');
  }
  if (manifestUrls.some((url) => url.href.split('?')[0] === publicUrl + '/manifest.json')) {
    throw new InvalidSettings('Use the source add-on’s manifest URL in the stream settings.');
  }

  const apiKey = settings.SUBDL_API_KEY;
  const openSubtitlesKey = settings.OPENSUBTITLES_API_KEY;
  const subsourceKey = settings.SUBSOURCE_API_KEY;
  return {
    settings, manifestUrls, apiKey, openSubtitlesKey, subsourceKey, publicUrl, host, port,
    shortlist: settings.STREAM_LIST === 'shortlist', matchLabelPosition: settings.EXACT_MATCH_POSITION
  };
}

export async function openSettings(env, file, { shared = false, requireExisting = false, registrationToken } = {}) {
  let saved = {};
  try {
    saved = JSON.parse(await readFile(file, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid settings file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not read the local settings file.');
    if (requireExisting) return null;
  }

  const merged = { ...env };
  for (const key of [...Object.keys(fields), 'STREAM_LIST', 'EXACT_MATCH_POSITION']) if (Object.hasOwn(saved, key)) merged[key] = saved[key];
  if (saved.installation != null && !validInstallation(saved.installation)) throw new Error('Invalid installation settings.');
  let current = { ...readConfig(merged), installation: saved.installation };
  let pending = Promise.resolve();
  return {
    get: () => current,
    save(patch, { password = '', authenticatedHash } = {}) {
      const update = pending.then(async () => {
        const next = readConfig({ ...env, ...current.settings, ...patch });
        if (!isLive(next)) {
          const missing = [];
          if (!next.manifestUrls.length) missing.push(setupRequirements.streams);
          if (!hasSubtitleKey(next)) missing.push(setupRequirements.providers);
          throw new InvalidSettings(missing.join(' '));
        }
        if (authenticatedHash && current.installation?.hash !== authenticatedHash) {
          throw new InvalidSettings('Your password changed. Unlock Configure and try again.');
        }
        if (password && !validPassword(password)) {
          throw new InvalidSettings('Use a configuration password of at least 12 characters and at most 256 bytes.');
        }
        if (password || current.installation) {
          const publicAddress = new URL(next.publicUrl);
          if (publicAddress.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(publicAddress.hostname)) {
            throw new InvalidSettings('Set PUBLIC_URL to the add-on’s HTTPS address before enabling a private installation.');
          }
        }
        if (shared && next.manifestUrls.some((url) => !publicSourceUrl(url) || url.hostname === new URL(next.publicUrl).hostname)) {
          throw new InvalidSettings('Use a public HTTPS stream source on a different hostname.');
        }
        const installation = current.installation ?? (registrationToken ? { token: registrationToken } : undefined);
        next.installation = password ? await setInstallationPassword(password, installation) : current.installation;
        if (next.installation && next.manifestUrls.some((url) => url.href.split('?')[0] === next.publicUrl + installPath(next.installation) + '/manifest.json')) {
          throw new InvalidSettings('Use the source add-on’s manifest URL in the stream settings.');
        }
        await writePrivateJson(file, { ...next.settings, installation: next.installation });
        current = next;
        return next;
      });
      pending = update.catch(() => {});
      return update;
    }
  };
}

function hasSubtitleKey(config) {
  return Boolean(config.apiKey || config.openSubtitlesKey || config.subsourceKey);
}

export function isLive(config) {
  return Boolean(config.manifestUrls?.length) && hasSubtitleKey(config);
}
