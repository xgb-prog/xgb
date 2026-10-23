/* Service Worker — 青柠漫剧播放器
 * v4.1 修复：核心文件（HTML/JS/CSS）禁止缓存、禁止离线回退
 * 原因：服务器不可达时，离线回退会加载缓存的旧版本页面，
 *       导致用户看到旧界面、激活弹窗不出现（激活逻辑缺失/过旧）
 * 现在：连不上服务器就直接报错提示，绝不静默加载旧版
 */
const CACHE = 'qingning-static-v5';  // 只缓存图标等静态资源
const STATIC_ASSETS = [
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

// 需要排除的 API 路径前缀（不缓存，不拦截，直接走网络）
const API_PATHS = ['/activate', '/verify', '/admin', '/status', '/api/'];

// 核心文件：禁止缓存，始终走网络（保证激活逻辑永远是最新版）
function isCoreFile(pathname) {
  if (pathname === '/' || pathname === '') return true;
  return /\.(html|js|css)$/.test(pathname) || pathname.endsWith('/');
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
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
  for (const path of API_PATHS) {
    if (url.pathname.startsWith(path)) return;
  }

  // 排除非 GET 请求
  if (e.request.method !== 'GET') return;

  // 跨域请求不缓存
  if (url.origin !== self.location.origin) return;

  // 【关键】HTML / JS / CSS 一律走网络，不缓存、不离线回退
  if (isCoreFile(url.pathname)) {
    e.respondWith(fetch(e.request).catch(() => {
      // 网络失败时返回一个明确的错误页，而不是旧缓存
      return new Response(
        '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>无法连接服务器</title><style>body{background:#0b1220;color:#e2e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px}' +
        'div{max-width:360px}h1{font-size:22px;color:#22c55e;margin-bottom:12px}p{font-size:15px;line-height:1.8;color:#94a3b8}</style></head>' +
        '<body><div><h1>无法连接服务器</h1>' +
        '<p>网络连接失败，请检查网络后<br>重新打开本页面。</p></div></body></html>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }));
    return;
  }

  // 仅对图标等静态资源：网络优先，失败回退缓存
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
