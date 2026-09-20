/* Service Worker — 智能播放器 PWA 离线缓存 */
const CACHE = 'smart-player-v2';  // 升级版本号，强制更新
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/db.js',
  './js/app.js',
  './js/hls.min.js',
  './js/flv.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

// 需要排除的 API 路径前缀（不缓存，不拦截，直接走网络）
const API_PATHS = ['/activate', '/verify', '/admin', '/status', '/api/'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 【重要】排除所有授权服务器 API 请求，不拦截，直接走网络
  // 防止 iOS PWA 下 Service Worker 干扰跨域 API 请求导致 "Load failed"
  for (const path of API_PATHS) {
    if (url.pathname.startsWith(path)) return;
  }

  // 排除非 GET 请求（POST 等不缓存）
  if (e.request.method !== 'GET') return;

  // 跨域请求不缓存（视频、图片等外部资源）
  if (url.origin !== self.location.origin) return;

  // 网络优先，失败时回退缓存（离线可用）
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
