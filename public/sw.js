const CACHE = 'ea-bridge-v1';
const ASSETS = ['/', '/styles.css', '/app.js', '/manifest.json'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).catch(() => {}));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
      return res;
    }).catch(() => cached))
  );
});
