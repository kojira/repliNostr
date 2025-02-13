/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = 'nostr-client-v1';
const BASE_URL = '/repliNostr/';  // GitHub Pages base path

// Define cache patterns
const STATIC_PATTERNS = [
  // HTML files
  BASE_URL,
  `${BASE_URL}index.html`,
  // Built assets (dynamic file names)
  new RegExp(`^${BASE_URL}assets/.*\\.js`),
  new RegExp(`^${BASE_URL}assets/.*\\.css`),
  // Manifest file
  `${BASE_URL}manifest.json`,
  // Icons
  `${BASE_URL}icon-192x192.png`,
  `${BASE_URL}icon-512x512.png`
];

self.addEventListener('install', (event) => {
  console.log('[SW] Installing Service Worker');
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      try {
        // Cache static patterns
        const urls = await Promise.all(
          STATIC_PATTERNS
            .filter(pattern => typeof pattern === 'string')
            .map(url => {
              console.log('[SW] Caching:', url);
              return cache.add(url).catch(err => {
                console.error(`[SW] Failed to cache ${url}:`, err);
              });
            })
        );
        console.log('[SW] Initial caching complete');
        return urls;
      } catch (error) {
        console.error('[SW] Installation failed:', error);
        throw error;
      }
    })
  );
});

self.addEventListener('fetch', (event) => {
  // Skip API requests
  if (event.request.url.includes('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(async (response) => {
      if (response) {
        console.log('[SW] Serving from cache:', event.request.url);
        return response;
      }

      try {
        const fetchResponse = await fetch(event.request);
        if (!fetchResponse || fetchResponse.status !== 200 || fetchResponse.type !== 'basic') {
          return fetchResponse;
        }

        const responseToCache = fetchResponse.clone();
        const cache = await caches.open(CACHE_NAME);
        const url = new URL(event.request.url);
        // Consider GitHub Pages base path for cache key
        const pathname = url.pathname.startsWith(BASE_URL) 
          ? url.pathname 
          : BASE_URL + url.pathname.replace(/^\//, '');

        console.log('[SW] Caching new resource:', pathname);
        await cache.put(new Request(pathname), responseToCache);

        return fetchResponse;
      } catch (error) {
        console.error('[SW] Fetch error:', error);
        throw error;
      }
    })
  );
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating Service Worker');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_NAME)
          .map((cacheName) => {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          })
      );
    })
  );
});

export {};