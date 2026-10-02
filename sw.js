/* MK Driving for Dollars service worker.
 * - App shell: cached so the app opens with no signal.
 * - Map tiles: cached as you view them (capped), so areas you've seen load offline.
 * - Parcel lookups: always live (never cached); the app retries them when signal returns.
 */
const VERSION = 'd4d-v2';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
];
const TILE_CACHE = 'd4d-tiles';
const TILE_HOSTS = ['tile.openstreetmap.org', 'server.arcgisonline.com'];
const MAX_TILES = 2000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION && key !== TILE_CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

let tilePuts = 0;
async function trimTiles() {
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles: cache first, then network.
  if (TILE_HOSTS.includes(url.hostname) && !url.pathname.includes('/query')) {
    e.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type !== 'opaque') {
        cache.put(req, res.clone());
        if (++tilePuts % 200 === 0) trimTiles();
      }
      return res;
    })());
    return;
  }

  // Same-origin app files: network first (so updates land), cache as fallback.
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return (await cache.match(req, { ignoreSearch: true }))
          || (req.mode === 'navigate' ? cache.match('index.html') : Response.error());
      }
    })());
  }
  // Everything else (parcel lookups, Google links) goes straight to the network.
});
