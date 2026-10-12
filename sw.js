// Service worker: makes the app installable and usable offline.
// App files are fetched fresh when online and served from cache when not,
// so edits you publish show up on the next load. Live data (VATSIM, METAR,
// SimBrief) always goes straight to the network.

const CACHE = 'qfa100-ops-v18';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/store.js',
  'js/config.js',
  'js/api.js',
  'js/ui.js',
  'js/ops.js',
  'js/autoroster.js',
  'js/mel.js',
  'js/data/checklists.js',
  'js/data/schedule.js',
  'js/data/airports.json',
  'js/data/mel.json',
  'js/views/dash.js',
  'js/views/checklists.js',
  'js/views/schedule.js',
  'js/views/roster.js',
  'js/views/admin.js',
  'js/views/availability.js',
  'js/views/login.js',
  'js/views/techlog.js',
  'js/views/airports.js',
  'js/views/brief.js',
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
    // 'no-cache' makes the browser check with the server every time, so a
    // changed file is never held back by the browser's own cache.
    fetch(request, { cache: 'no-cache' })
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
