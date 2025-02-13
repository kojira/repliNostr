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

// 画像ファイルかどうかを判定
function isImageRequest(url) {
  return url.match(/\.(png|jpg|jpeg|gif|webp|ico|svg)$/i);
}

// リソースのネットワークファーストフェッチ
async function fetchWithNetworkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
      return response;
    }

    // 404エラーの場合、index.htmlを返す
    if (response.status === 404 && request.mode === 'navigate') {
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
    if (request.mode === 'navigate') {
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

// ナビゲーションリクエストの処理
function isNavigationRequest(request) {
  return request.mode === 'navigate' && request.method === 'GET';
}

self.addEventListener('fetch', (event) => {
  try {
    const url = event.request.url;
    console.log('[SW] Fetching:', url);


    // 画像リクエストの処理
    if (isImageRequest(url)) {
      event.respondWith(fetchWithCacheFirst(event.request));
      return;
    }

    // アセットのリクエストを処理
    if (url.includes('/assets/')) {
      event.respondWith(
        fetchWithCacheFirst(new Request(rewriteAssetUrl(url)))
      );
      return;
    }

    // その他のリクエストを処理（ナビゲーションリクエストを含む）
    event.respondWith(
      fetchWithNetworkFirst(event.request)
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