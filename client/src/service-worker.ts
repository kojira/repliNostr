/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = 'nostr-client-v1';
const BASE_URL = import.meta.env.VITE_BASE_URL || '/';

// Remove trailing slash if present
const normalizedBaseUrl = BASE_URL.endsWith('/') ? BASE_URL.slice(0, -1) : BASE_URL;

// Prepend base URL to paths
const STATIC_ASSETS = [
  normalizedBaseUrl + '/',
  `${normalizedBaseUrl}/index.html`,
  `${normalizedBaseUrl}/assets/index.js`,
  `${normalizedBaseUrl}/assets/index.css`
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

self.addEventListener('fetch', (event) => {
  // Skip caching for API requests
  if (event.request.url.includes('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) {
        return response;
      }

      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          // Normalize the URL before caching
          const url = new URL(event.request.url);
          const cacheKey = new Request(url.pathname, event.request);
          cache.put(cacheKey, responseToCache);
        });

        return response;
      });
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName))
      );
    })
  );
});

export {};