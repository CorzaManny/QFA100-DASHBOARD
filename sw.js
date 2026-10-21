// Service worker: makes the app installable and usable offline.
// App files are fetched fresh when online and served from cache when not,
// so edits you publish show up on the next load. Live data (VATSIM, METAR,
// SimBrief) always goes straight to the network.
//
// Bump CACHE with every release: a changed sw.js is how open copies of the
// app learn there is an update, and they then reload themselves (js/app.js).

const CACHE = 'qfa100-ops-v91';
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
  'js/running.js',
  'js/push.js',
  'js/mel.js',
  'js/map.js',
  'js/install.js',
  'js/opschat.js',
  'js/opscall.js',
  'js/realtime.js',
  'js/vpilot.js',
  'js/tone.js',
  'js/data/checklists.js',
  'js/data/non-normal.js',
  'js/data/schedule.js',
  'js/data/airports.json',
  'js/data/world.json',
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
  'js/views/progress.js',
  'js/views/ops.js',
  'js/views/stream.js',
  'js/views/vpilot.js',
  'icons/qfa100-logo.png',
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

// A notification from the team: the roster, a delay, a report time.
self.addEventListener('push', (event) => {
  let note = { title: 'QFA100 Ops', body: '', url: '#/dashboard' };
  try {
    note = { ...note, ...(event.data ? event.data.json() : {}) };
  } catch {
    // A push with no readable payload still deserves to be shown.
    if (event.data) note.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(note.title, {
      body: note.body,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: note.tag || 'qfa100',
      renotify: true,
      data: { url: note.url },
    }),
  );
});

// Tapping one opens the app at the page it is about, reusing a window that is
// already open rather than starting a second copy.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '#/dashboard', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (client.url.startsWith(self.registration.scope)) {
          client.focus();
          return client.navigate ? client.navigate(target) : undefined;
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
