import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';

const reserved = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) reserved.addSubnet(address, prefix, 'ipv4');
reserved.addAddress('168.63.129.16', 'ipv4');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  reserved.addSubnet(address, prefix, 'ipv6');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function publicSourceUrl(url) {
  const hostname = url.hostname.replace(/^[\[]|[\]]$/g, '');
  return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
    !isIP(hostname) && hostname.includes('.') && !hostname.replace(/\.$/, '').endsWith('.localhost');
}

export function publicSourceAddress({ address, family }) {
  if (family === 4) return !reserved.check(address, 'ipv4');
  return family === 6 && globalV6.check(address, 'ipv6') && !reserved.check(address, 'ipv6');
}

async function requestPublic(url, { signal, headers }) {
  if (!publicSourceUrl(url)) throw new Error('Shared stream sources require a public HTTPS hostname.');
  const addresses = await lookup(url.hostname, { all: true });
  signal?.throwIfAborted();
  if (!addresses.length || addresses.some((address) => !publicSourceAddress(address))) {
    throw new Error('Stream source did not resolve to a public address.');
  }
  const destination = addresses.find(({ family }) => family === 4) ?? addresses[0];
  return new Promise((resolve, reject) => {
    // Keep TLS verification on the original hostname while pinning the validated DNS result.
    const outgoing = request(url, {
      agent: false, signal, family: destination.family, headers,
      lookup: (_hostname, _options, callback) => callback(null, destination.address, destination.family)
    }, resolve);
    outgoing.once('error', reject);
    outgoing.end();
  });
}

function sourceResponse(incoming) {
  const headers = {};
  if (incoming.headers['content-range']) headers['content-range'] = incoming.headers['content-range'];
  return new Response(Readable.toWeb(incoming), { status: incoming.statusCode, headers });
}

export async function fetchPublicSource(url, { signal } = {}) {
  const incoming = await requestPublic(url, { signal });
  if (incoming.statusCode === 200) return sourceResponse(incoming);
  incoming.destroy();
  throw new Error(`Stream source HTTP ${incoming.statusCode}`);
}

const mediaHeaderNames = ['range', 'referer', 'origin', 'user-agent', 'authorization', 'cookie'];
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const mediaRedirectLimit = 4;

export async function fetchPublicMedia(url, { signal, headers } = {}, send = requestPublic) {
  const originalHeaders = new Headers(headers);
  let requestHeaders = Object.fromEntries(mediaHeaderNames.flatMap((name) =>
    originalHeaders.has(name) ? [[name, originalHeaders.get(name)]] : []));
  if (!requestHeaders.range) throw new Error('Media probes require a byte range.');

  for (let redirects = 0; ; redirects += 1) {
    const incoming = await send(url, { signal, headers: requestHeaders });
    const { statusCode, headers: { location } } = incoming;
    if (statusCode === 200 || statusCode === 206) return sourceResponse(incoming);
    incoming.destroy();
    if (!redirectStatuses.has(statusCode) || !location || redirects === mediaRedirectLimit) {
      throw new Error(`Media probe HTTP ${statusCode}`);
    }
    const next = new URL(location, url);
    // A CDN redirect needs the byte range, but not credentials from the original host.
    if (next.origin !== url.origin) requestHeaders = { range: requestHeaders.range };
    url = next;
  }
}
