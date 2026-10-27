// Bump CACHE when any asset changes.
const CACHE = 'nepalqr-v1';

const ASSETS = [
  '.',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'vendor/jsQR.js',
  'vendor/qrcode.js',
  'lib/index.js',
  'lib/crc.js',
  'lib/tlv.js',
  'lib/tags.js',
  'lib/qr.js',
  'lib/fixture.js',
  'lib/payments.js',
  'lib/alerts.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request)
          .then((res) => {
            if (res.ok && new URL(request.url).origin === self.location.origin) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return res;
          })
          .catch(() => hit)
    )
  );
});
