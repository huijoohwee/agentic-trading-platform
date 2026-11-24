const buildId = '__BUILD_ID__';
const fileMapHash = '__FILE_MAP_HASH__';
const paths = new Set('__ASSET_PATHS__');
const prefix = 'trading-fixture-shell:' + self.registration.scope + ':';
const cacheName = prefix + buildId;
const url = name => new URL(name, self.registration.scope).href;
async function hash(bytes) {
  const value = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const manifest = await fetch(url('asset-manifest.json'), { cache: 'reload', redirect: 'error' });
    if (!manifest.ok) throw new Error('Offline manifest unavailable');
    const { id, files: digests } = await manifest.json();
    delete digests['sw.js']; // The worker pins the assets it installs in Cache Storage.
    if (id !== buildId || await hash(new TextEncoder().encode(JSON.stringify(digests))) !== fileMapHash) {
      throw new Error('Offline manifest integrity failure');
    }
    const cache = await caches.open(cacheName);
    for (const [path, expected] of Object.entries(digests)) {
      const response = await fetch(url(path), { cache: 'reload', redirect: 'error' });
      if (!response.ok) throw new Error('Offline asset unavailable: ' + path);
      const actual = await hash(await response.clone().arrayBuffer());
      if (actual !== expected) throw new Error('Offline integrity failure: ' + path);
      await cache.put(url(path), response);
    }
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(prefix) && key !== cacheName) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const address = new URL(event.request.url);
  address.hash = ''; // Document fragments identify locations in the same sealed asset.
  if (event.request.method !== 'GET' || !address.href.startsWith(self.registration.scope)) return;
  const path = address.href.slice(self.registration.scope.length);
  const name = path === '' ? 'index.html' : path;
  if (!paths.has(name)) return;
  event.respondWith((async () => {
    const response = await (await caches.open(cacheName)).match(url(name));
    return response || new Response('Cached asset missing. Reconnect and repair the offline shell.', { status: 503 });
  })());
});
