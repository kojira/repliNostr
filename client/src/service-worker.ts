/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = 'nostr-client-v1';
const BASE_URL = import.meta.env.VITE_BASE_URL || '/';

// Remove trailing slash if present
const normalizedBaseUrl = BASE_URL.endsWith('/') ? BASE_URL.slice(0, -1) : BASE_URL;

// キャッシュ対象となるパターンを定義
const STATIC_PATTERNS = [
  // HTMLファイル
  normalizedBaseUrl + '/',
  `${normalizedBaseUrl}/index.html`,
  // ビルドされたアセット（動的なファイル名に対応）
  new RegExp(`${normalizedBaseUrl}/assets/index-.*\\.js`),
  new RegExp(`${normalizedBaseUrl}/assets/index-.*\\.css`)
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // 正規表現パターンに一致するURLを探してキャッシュ
      const urls = await Promise.all(
        STATIC_PATTERNS
          .filter(pattern => typeof pattern === 'string')
          .map(url => cache.add(url as string))
      );
      return urls;
    })
  );
});

self.addEventListener('fetch', (event) => {
  // APIリクエストはキャッシュしない
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
          // URLを正規化してキャッシュ
          const url = new URL(event.request.url);
          const cacheKey = new Request(url.pathname + url.search, event.request);
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