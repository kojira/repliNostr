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

// Asset URL rewrite function
function rewriteAssetUrl(url) {
  const urlObj = new URL(url);

  // GitHub Pages環境でないなら書き換えない
  if (!self.location.pathname.includes('/repliNostr/')) {
    return url;
  }

  // アセットパスの書き換え
  if (urlObj.pathname.startsWith('/assets/')) {
    return urlObj.origin + BASE_URL + 'assets/' + urlObj.pathname.split('/assets/')[1];
  }

  // その他のパスの書き換え
  if (!urlObj.pathname.startsWith(BASE_URL)) {
    return urlObj.origin + BASE_URL + urlObj.pathname.replace(/^\//, '');
  }

  return url;
}

self.addEventListener('fetch', (event) => {
  try {
    const url = event.request.url;
    console.log('[SW] Fetching:', url);

    // アセットのリクエストを処理
    if (url.includes('/assets/')) {
      event.respondWith(
        fetch(rewriteAssetUrl(url))
          .catch(error => {
            console.error('[SW] Failed to fetch:', error);
            return caches.match(event.request);
          })
      );
      return;
    }

    // 他のリクエストを処理
    event.respondWith(
      caches.match(event.request)
        .then(async (response) => {
          if (response) {
            console.log('[SW] Serving from cache:', url);
            return response;
          }

          try {
            const fetchResponse = await fetch(event.request);
            if (!fetchResponse || fetchResponse.status !== 200) {
              return fetchResponse;
            }

            const responseToCache = fetchResponse.clone();
            const cache = await caches.open(CACHE_NAME);
            await cache.put(event.request, responseToCache);
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
        const urls = STATIC_PATTERNS
          .filter(pattern => typeof pattern === 'string')
          .map(url => cache.add(url));

        await Promise.all(urls);
        console.log('[SW] Initial caching complete');
      } catch (error) {
        console.error('[SW] Installation failed:', error);
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
          .map((cacheName) => caches.delete(cacheName))
      );
    })
  );
});