/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = 'nostr-client-v1';
const BASE_URL = '/repliNostr/';  // GitHub Pages base path

// キャッシュ対象となるパターンを定義
const STATIC_PATTERNS = [
  // HTMLファイル
  BASE_URL,
  `${BASE_URL}index.html`,
  // ビルドされたアセット（動的なファイル名に対応）
  new RegExp(`${BASE_URL}assets/.*\\.js`),
  new RegExp(`${BASE_URL}assets/.*\\.css`)
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
          const url = new URL(event.request.url);
          // GitHub Pagesのベースパスを考慮
          const pathname = url.pathname.startsWith(BASE_URL) 
            ? url.pathname 
            : BASE_URL + url.pathname.replace(/^\//, '');
          const cacheKey = new Request(pathname + url.search, event.request);
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