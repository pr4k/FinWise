const OFFLINE_CACHE = 'finwise-offline-v1';

self.addEventListener('install', event => {
  event.waitUntil(caches.open(OFFLINE_CACHE).then(cache => cache.add('/offline.html')));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith('finwise-offline-') && key !== OFFLINE_CACHE)
        .map(key => caches.delete(key))
    )),
    self.clients.claim()
  ]));
});

self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  const path = new URL(event.request.url).pathname;
  if (path === '/api' || path.startsWith('/api/') || path.startsWith('/health/')) return;
  event.respondWith(fetch(event.request).catch(() => caches.match('/offline.html')));
});
