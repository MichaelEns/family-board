const CACHE = 'family-board-v1';
const SHELL = [
  '/family-board/',
  '/family-board/index.html',
  '/family-board/styles.css',
  '/family-board/app.js',
  '/family-board/manifest.webmanifest',
  '/family-board/icon.svg',
  '/family-board/icon-192.png',
  '/family-board/icon-512.png'
];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request.mode === 'navigate'
    ? '/family-board/index.html'
    : event.request)));
});
