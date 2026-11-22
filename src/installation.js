import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);
const scryptOptions = { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 };

export function validPassword(password) {
  return typeof password === 'string' && Boolean(password.trim()) && [...password].length >= 12 && Buffer.byteLength(password) <= 256;
}

export function validInstallation(installation) {
  return /^[a-f0-9]{64}$/.test(installation?.token) && /^[a-f0-9]{32}$/.test(installation.salt) &&
    /^[a-f0-9]{64}$/.test(installation.hash);
}

export function installPath(installation) {
  return '/install/' + installation.token;
}

export async function setInstallationPassword(password, installation) {
  const salt = randomBytes(16);
  const hash = await deriveKey(password, salt, 32, scryptOptions);
  return { token: installation?.token ?? randomBytes(32).toString('hex'), salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export async function verifyInstallationPassword(password, installation) {
  if (!validPassword(password)) return false;
  const actual = await deriveKey(password, Buffer.from(installation.salt, 'hex'), 32, scryptOptions);
  return timingSafeEqual(actual, Buffer.from(installation.hash, 'hex'));
}
