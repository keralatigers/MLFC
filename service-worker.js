/* MLFC Service Worker
 * - Caches static assets for offline/instant load
 * - Does NOT cache API responses (we cache API data in localStorage/sessionStorage in JS)
 */

const CACHE_NAME = "mlfc-static-v2";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.json",
  "./src/app.js",
  "./src/router.js",
  "./src/config.js",
  "./src/prefetch.js",
  "./src/api/client.js",
  "./src/api/endpoints.js",
  "./src/pages/match.js",
  "./src/pages/register.js",
  "./src/pages/leaderboard.js",
  "./src/pages/admin.js",
  "./src/pages/captain.js",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/maskable-512.png"

];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))))
    )
  );
  self.clients.claim();
});

// Cache-first for same-origin static requests
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Only handle same-origin (your GitHub Pages files)
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
