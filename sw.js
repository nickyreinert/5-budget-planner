// --- sw.js ---
// Minimal offline app-shell cache: the app itself is entirely client-side
// (localStorage-backed, no backend), so caching the static shell is enough
// to let it load without a network connection after the first visit.
const CACHE_NAME = 'money-money-analyzer-v39';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './favicon.svg',
  './manifest.webmanifest',
  './sample_data.json',
  './src/data.js',
  './src/transactions.js',
  './src/categories.js',
  './src/db.js',
  './src/charts.js',
  './src/overview.js',
  './src/settings.js',
  './src/table.js',
  './src/rules.js',
  './src/week.js',
  './src/recurrence.js',
  './src/budgets.js',
  './src/keypad.js',
  './src/gocardless.js',
  './src/sync.js',
  './src/transfers.js',
  './src/i18n.js',
  './src/csv_config.js',
  './src/footer.js',
  './src/default_rules.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for same-origin app-shell files; everything else (CDN chart.js,
// GitHub-hosted footer.json, ...) goes straight to the network so external
// content is never served stale.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // The HTML shell is network-first: a cache-first reload could otherwise
  // briefly flash the PREVIOUS deploy's markup (this SW instance's own old
  // cache) before the update/activate/claim cycle below finishes and
  // forces a reload onto the new one. Falls back to the cache only when
  // offline, so the app-shell precache still keeps working offline.
  const isAppShellDoc = event.request.mode === 'navigate' || url.pathname.endsWith('/index.html');
  if (isAppShellDoc) {
    event.respondWith(
      fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
