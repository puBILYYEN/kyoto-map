// 京都行程景點地圖 — Service Worker
//
// 目的：在日本沒訊號時，整個網站仍然打得開。
//
// 策略分兩種：
//   1. 自己的檔案（html/css/js/data）→ 網路優先，3.5 秒沒回應就用快取
//      （規劃行程時有網路，要拿到最新資料；在日本沒訊號時，用快取照樣開）
//   2. 地圖函式庫與圖磚 → 快取優先
//      （網址有版號、內容不會變，抓過一次就不必再抓，省流量也省漫遊費）
//
// 導遊的 API 請求一律不快取，離線時就是不能用，這符合預期。

const VERSION = 'v32';
const STATIC_CACHE = `kyoto-static-${VERSION}`;
const TILE_CACHE = 'kyoto-tiles';
const TILE_LIMIT = 600;          // 圖磚最多留幾張，避免把手機空間吃光
const NETWORK_TIMEOUT = 3500;

// 網站的核心檔案，安裝時就先抓下來
const CORE = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './data.js',
  './kyoto-border.js',
  './manifest.json',
  './vendor/maplibre-gl.css',
  './vendor/maplibre-gl.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      // 個別 add，任何一個失敗都不要讓整個安裝失敗
      .then(cache => Promise.all(CORE.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('kyoto-static-') && k !== STATIC_CACHE)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// 網路優先，逾時或失敗就退回快取
async function networkFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT);
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    // 連快取都沒有的話，導覽請求至少回首頁
    if (request.mode === 'navigate') {
      const home = await cache.match('./index.html');
      if (home) return home;
    }
    throw err;
  }
}

// 快取優先，沒有才去抓
async function cacheFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response && (response.ok || response.type === 'opaque')) {
    cache.put(request, response.clone());
    if (limit) trimCache(cacheName, limit);
  }
  return response;
}

// 超過上限就從最舊的開始刪
async function trimCache(cacheName, limit) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  for (const key of keys.slice(0, keys.length - limit)) await cache.delete(key);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 導遊的 API 一律走網路，不快取（快取住的答案沒有意義）
  if (url.pathname === '/ask' || url.pathname === '/healthz') return;

  // 地圖圖磚與樣式：快取優先，並限制數量
  if (url.hostname.endsWith('openfreemap.org')) {
    event.respondWith(cacheFirst(request, TILE_CACHE, TILE_LIMIT).catch(() => Response.error()));
    return;
  }

  // 地圖函式庫放在自己的 vendor/，內容不會變，快取優先（省下每次的網路往返）
  if (url.origin === self.location.origin && url.pathname.includes('/vendor/')) {
    event.respondWith(cacheFirst(request, STATIC_CACHE).catch(() => Response.error()));
    return;
  }

  // 自己的其他檔案：網路優先，離線時退回快取
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  }
});
