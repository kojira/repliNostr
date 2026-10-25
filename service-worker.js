/// <reference lib="webworker" />
// @ts-check

const CACHE_NAME = 'nostr-client-v2';
const BASE_URL = self.location.pathname.includes('/repliNostr/') ? '/repliNostr/' : '/';

console.log('[SW] Initializing with:', {
    CACHE_NAME,
    BASE_URL,
    location: self.location.href
});

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
    const isCacheable = (
        request.url.startsWith('http') &&
        !request.url.startsWith('chrome-extension:') &&
        request.method === 'GET'
    );
    console.log('[SW] Checking if cacheable:', {
        url: request.url,
        method: request.method,
        isCacheable
    });
    return isCacheable;
}

// 画像ファイルかどうかを判定
function isImageRequest(url) {
    return url.match(/\.(png|jpg|jpeg|gif|webp|ico|svg)$/i);
}

// ナビゲーションリクエストの処理
function isNavigationRequest(request) {
    const isNavigation = request.mode === 'navigate' && request.method === 'GET';
    console.log('[SW] Checking if navigation:', {
        url: request.url,
        mode: request.mode,
        method: request.method,
        isNavigation
    });
    return isNavigation;
}

// リソースのネットワークファーストフェッチ
async function fetchWithNetworkFirst(request) {
    console.log('[SW] Network first fetch:', {
        url: request.url,
        mode: request.mode
    });

    if (!isCacheableRequest(request)) {
        console.log('[SW] Skipping non-cacheable request:', request.url);
        return fetch(request);
    }

    try {
        const response = await fetch(request);
        console.log('[SW] Network response:', {
            url: request.url,
            status: response.status,
            ok: response.ok
        });

        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
            return response;
        }

        // 404エラーの場合、index.htmlを返す
        if (response.status === 404 && isNavigationRequest(request)) {
            console.log('[SW] 404 response, falling back to index.html');
            const indexResponse = await caches.match(BASE_URL + 'index.html');
            if (indexResponse) {
                return indexResponse;
            }
        }

        throw new Error(`Network response was not ok: ${response.status}`);
    } catch (error) {
        console.log('[SW] Network fetch failed:', {
            url: request.url,
            error: error.message
        });

        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            console.log('[SW] Returning cached response:', request.url);
            return cachedResponse;
        }

        // ナビゲーションリクエストの場合、index.htmlにフォールバック
        if (isNavigationRequest(request)) {
            console.log('[SW] Navigation request, falling back to index.html');
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
    console.log('[SW] Cache first fetch:', request.url);

    if (!isCacheableRequest(request)) {
        return fetch(request);
    }

    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
        console.log('[SW] Returning cached response:', request.url);
        return cachedResponse;
    }

    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, response.clone());
            console.log('[SW] Cached new response:', request.url);
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
        console.log('[SW] Fetch event:', {
            url,
            mode: event.request.mode,
            method: event.request.method
        });

        // chrome-extension関連のリクエストはスキップ
        if (!isCacheableRequest(event.request)) {
            console.log('[SW] Skipping non-cacheable request:', url);
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
                const stringPatterns = STATIC_PATTERNS.filter(pattern => typeof pattern === 'string');
                console.log('[SW] Caching static files:', stringPatterns);
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
                        .map((cacheName) => {
                            console.log('[SW] Deleting old cache:', cacheName);
                            return caches.delete(cacheName);
                        })
                );
            }),
            // 新しいService Workerをすぐにアクティベート
            self.clients.claim()
        ])
    );
});