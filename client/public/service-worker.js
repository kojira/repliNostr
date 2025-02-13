/// <reference lib="webworker" />
// @ts-check

const CACHE_NAME = 'nostr-client-v1';
const BASE_URL = self.location.pathname.includes('/repliNostr/') ? '/repliNostr/' : '/';

// Define cache patterns and asset URLs
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

// Asset URL rewrite function - handles both development and production
function rewriteAssetUrl(url) {
  const urlObj = new URL(url);

  // Do not rewrite URLs in development
  if (!self.location.pathname.includes('/repliNostr/')) {
    return url;
  }

  // Handle /assets/ paths
  if (urlObj.pathname.startsWith('/assets/')) {
    const newPath = BASE_URL + 'assets/' + urlObj.pathname.split('/assets/')[1];
    return urlObj.origin + newPath;
  }

  // Handle direct paths
  if (!urlObj.pathname.startsWith(BASE_URL)) {
    return urlObj.origin + BASE_URL + urlObj.pathname.replace(/^\//, '');
  }

  return url;
}

self.addEventListener('fetch', (event) => {
  try {
    const url = event.request.url;
    console.log('[SW] Fetching:', url);

    // Rewrite asset URLs
    if (url.includes('/assets/')) {
      event.respondWith(
        fetch(rewriteAssetUrl(url))
          .then(response => {
            if (!response || response.status !== 200) {
              console.error(`[SW] Failed to fetch: ${url}, trying cache`);
              return caches.match(event.request);
            }
            return response;
          })
          .catch(error => {
            console.error('[SW] Failed to fetch:', error);
            return caches.match(event.request);
          })
      );
      return;
    }

    // Handle other requests
    event.respondWith(
      caches.match(event.request).then(async (response) => {
        if (response) {
          console.log('[SW] Serving from cache:', url);
          return response;
        }

        try {
          const fetchResponse = await fetch(event.request);
          if (!fetchResponse || fetchResponse.status !== 200 || fetchResponse.type !== 'basic') {
            return fetchResponse;
          }

          const responseToCache = fetchResponse.clone();
          const cache = await caches.open(CACHE_NAME);

          // Store with proper base path
          const urlObj = new URL(event.request.url);
          const cacheKey = urlObj.pathname.startsWith(BASE_URL) 
            ? urlObj.pathname 
            : BASE_URL + urlObj.pathname.replace(/^\//, '');

          await cache.put(new Request(cacheKey), responseToCache);
          console.log('[SW] Cached new resource:', url);
          return fetchResponse;
        } catch (error) {
          console.error('[SW] Fetch error:', error);
          throw error;
        }
      })
    );
  } catch (error) {
    console.error('[SW] General error:', error);
  }
});

self.addEventListener('install', (event) => {
  console.log('[SW] Installing Service Worker');
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      try {
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