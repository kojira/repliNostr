/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = 'nostr-client-v1';
const BASE_URL = '/repliNostr/';

// Prepend base URL to paths
const STATIC_ASSETS = [
  BASE_URL,
  `${BASE_URL}index.html`,
  `${BASE_URL}src/main.tsx`,
  `${BASE_URL}src/index.css`
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
          // Store with correct base path
          const url = new URL(event.request.url);
          const cacheKey = url.pathname.startsWith(BASE_URL) 
            ? event.request 
            : new Request(`${BASE_URL}${url.pathname.slice(1)}`);
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