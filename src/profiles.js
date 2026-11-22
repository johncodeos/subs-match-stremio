import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openConfirmations } from './confirmations.js';
import { InvalidSettings, openSettings, readConfig } from './settings.js';

const tokenPattern = /^[a-f0-9]{64}$/;
const capacity = 200;

export async function openProfiles(config, directory) {
  const address = new URL(config.publicUrl);
  if (address.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) {
    throw new Error('Shared signup requires an HTTPS PUBLIC_URL.');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const env = { PUBLIC_URL: config.publicUrl, HOST: config.host, PORT: config.port };
  const tokens = new Set((await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => name.slice(0, -5)));
  const cache = new Map();
  let pending = Promise.resolve();
  const settingsFile = (token) => join(directory, `${token}.json`);
  const confirmationsFile = (token) => join(directory, `${token}.timing.json`);

  function get(token) {
    if (!tokenPattern.test(token) || !tokens.has(token)) return null;
    if (!cache.has(token)) {
      const load = (async () => {
        const settings = await openSettings(env, settingsFile(token), { shared: true, requireExisting: true });
        if (settings?.get().installation?.token !== token) return null;
        return { settings, confirmations: await openConfirmations(confirmationsFile(token)) };
      })();
      cache.set(token, load);
      load.then((profile) => { if (!profile) cache.delete(token); }, () => cache.delete(token));
    }
    return cache.get(token);
  }

  return {
    blank: readConfig(env),
    get,
    create(patch, password) {
      const registration = pending.then(async () => {
        if (tokens.size >= capacity) {
          throw new InvalidSettings('This server has reached its installation limit.');
        }
        const token = randomBytes(32).toString('hex');
        const settings = await openSettings(env, settingsFile(token), { shared: true, registrationToken: token });
        await settings.save(patch, { password });
        tokens.add(token);
        return get(token);
      });
      pending = registration.catch(() => {});
      return registration;
    }
  };
}
