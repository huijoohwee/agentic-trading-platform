const buildId = '__BUILD_ID__';
const digests = '__DIGESTS__';
const prefix = 'trading-fixture-shell:' + self.registration.scope + ':';
const cacheName = prefix + buildId;
const url = name => new URL(name, self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName);
    for (const [path, expected] of Object.entries(digests)) {
      const response = await fetch(url(path), { cache: 'reload', redirect: 'error' });
      if (!response.ok) throw new Error('Offline asset unavailable: ' + path);
      const hash = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
      const actual = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
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
  if (!Object.hasOwn(digests, name)) return;
  event.respondWith((async () => {
    const response = await (await caches.open(cacheName)).match(url(name));
    return response || new Response('Cached asset missing. Reconnect and repair the offline shell.', { status: 503 });
  })());
});
