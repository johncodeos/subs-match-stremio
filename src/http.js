export async function fetchBytes(url, { limit, timeout = 6500, fetcher = fetch } = {}) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);

  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > limit) throw new Error('Response exceeded size limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function fetchJson(url, fetcher, options = {}) {
  return JSON.parse(await fetchBytes(url, { limit: 2 * 1024 * 1024, fetcher, ...options }));
}

export function cached(load, { ttl = 10 * 60_000, capacity = 160 } = {}) {
  const entries = new Map();
  return (key, ...args) => {
    const current = entries.get(key);
    if (current && current.expires > Date.now()) return current.result;
    entries.delete(key);
    const entry = {
      expires: Infinity,
      result: Promise.resolve().then(() => load(...args))
    };
    entries.set(key, entry);
    if (entries.size > capacity) entries.delete(entries.keys().next().value);
    entry.result.then(
      () => { entry.expires = Date.now() + ttl; },
      () => { if (entries.get(key) === entry) entries.delete(key); }
    );
    return entry.result;
  };
}
