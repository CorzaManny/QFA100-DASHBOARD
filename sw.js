// Service worker: makes the app installable and usable offline.
// App files are fetched fresh when online and served from cache when not,
// so edits you publish show up on the next load. Live data (VATSIM, METAR,
// SimBrief) always goes straight to the network.

const CACHE = 'qfa100-ops-v2';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/store.js',
  'js/ui.js',
  'js/ops.js',
  'js/data/checklists.js',
  'js/data/schedule.js',
  'js/data/airports.json',
  'js/views/dash.js',
  'js/views/checklists.js',
  'js/views/schedule.js',
  'js/views/techlog.js',
  'js/views/airports.js',
  'js/views/dispatch.js',
  'js/views/settings.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html'))),
  );
});
