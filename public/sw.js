/*
 * The service worker that makes the portal installable.
 *
 * It caches the app's own files and nothing else. Every /api request goes to
 * the network untouched: bills, receipts and balances are never served from a
 * cache, so an installed app can never show a member yesterday's dues as
 * today's. Offline, the shell still opens and says it cannot reach the
 * server, rather than a browser error page.
 */

const CACHE = 'mani-vista-shell-v1';
const SHELL = ['./', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // The books are never cached.
  if (url.pathname.includes('/api/')) return;

  // Pages: the network first, so a new release shows at once; the cached
  // shell only when there is no network.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put('./', copy));
          return response;
        })
        .catch(() => caches.match('./')),
    );
    return;
  }

  // Built files carry a content hash in their name, so a cached copy is
  // always the right one. Everything else (icons, the manifest) is refreshed
  // in the background.
  const hashed = url.pathname.includes('/assets/');
  event.respondWith(
    caches.match(request).then((cached) => {
      const fresh = fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      });
      if (cached && hashed) return cached;
      return cached ? (fresh.catch(() => cached), cached) : fresh;
    }),
  );
});
