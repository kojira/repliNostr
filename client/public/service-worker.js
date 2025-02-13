/// <reference lib="webworker" />
// @ts-check

const CACHE_NAME = 'nostr-client-v2';
const BASE_URL = self.location.pathname.includes('/repliNostr/') ? '/repliNostr/' : '/';

// Define cache patterns and asset URLs
const STATIC_PATTERNS = [
  // HTML files
  BASE_URL,
  `${BASE_URL}index.html`,
  // Built assets (dynamic file names)
  new RegExp(`^${BASE_URL}assets/.*\\.js`),
  new RegExp(`^${BASE_URL}assets/.*\\.css`),
  // Image files
  `${BASE_URL}icon-192x192.png`,
  `${BASE_URL}icon-512x512.png`,
  // Manifest file
  `${BASE_URL}manifest.json`,
];

// リクエストがキャッシュ可能かどうかをチェック
function isCacheableRequest(request) {
  return (
    request.url.startsWith('http') &&
    !request.url.startsWith('chrome-extension:') &&
    request.method === 'GET'
  );
}

// 画像ファイルかどうかを判定
function isImageRequest(url) {
  return url.match(/\.(png|jpg|jpeg|gif|webp|ico|svg)$/i);
}

// ナビゲーションリクエストの処理
function isNavigationRequest(request) {
  return request.mode === 'navigate' && request.method === 'GET';
}

// リソースのネットワークファーストフェッチ
async function fetchWithNetworkFirst(request) {
  if (!isCacheableRequest(request)) {
    return fetch(request);
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
      return response;
    }

    // 404エラーの場合、index.htmlを返す
    if (response.status === 404 && isNavigationRequest(request)) {
      const indexResponse = await caches.match(BASE_URL + 'index.html');
      if (indexResponse) {
        return indexResponse;
      }
    }

    throw new Error(`Network response was not ok: ${response.status}`);
  } catch (error) {
    console.log('[SW] Network fetch failed, falling back to cache:', error);
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      return cachedResponse;
    }

    // ナビゲーションリクエストの場合、index.htmlにフォールバック
    if (isNavigationRequest(request)) {
      const indexResponse = await caches.match(BASE_URL + 'index.html');
      if (indexResponse) {
        return indexResponse;
      }
    }

    throw error;
  }
}

// リソースのキャッシュファーストフェッチ
async function fetchWithCacheFirst(request) {
  if (!isCacheableRequest(request)) {
    return fetch(request);
  }

  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    console.error('[SW] Cache first fetch failed:', error);
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  try {
    const url = event.request.url;
    console.log('[SW] Fetching:', url);

    // chrome-extension関連のリクエストはスキップ
    if (!isCacheableRequest(event.request)) {
      return;
    }

    // 画像リクエストの処理
    if (isImageRequest(url)) {
      event.respondWith(fetchWithCacheFirst(event.request));
      return;
    }

    // アセットのリクエストを処理
    if (url.includes('/assets/')) {
      event.respondWith(fetchWithCacheFirst(event.request));
      return;
    }

    // その他のリクエストを処理（ナビゲーションリクエストを含む）
    event.respondWith(fetchWithNetworkFirst(event.request));
  } catch (error) {
    console.error('[SW] General error:', error);
  }
});

self.addEventListener('install', (event) => {
  console.log('[SW] Installing Service Worker');
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      try {
        // 文字列パターンのキャッシュ
        const stringPatterns = STATIC_PATTERNS.filter(pattern => typeof pattern === 'string');
        const urlsToCache = stringPatterns.map(url => cache.add(url));

        await Promise.all(urlsToCache);
        console.log('[SW] Initial caching complete');
      } catch (error) {
        console.error('[SW] Installation failed:', error);
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating Service Worker');
  event.waitUntil(
    Promise.all([
      // 古いキャッシュを削除
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((cacheName) => cacheName !== CACHE_NAME)
            .map((cacheName) => caches.delete(cacheName))
        );
      }),
      // 新しいService Workerをすぐにアクティベート
      self.clients.claim()
    ])
  );
});