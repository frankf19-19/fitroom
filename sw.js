/* 試穿吧 TryOn — Service Worker：讓網站像 App 一樣秒開，離線也能開到外殼。
   策略：index.html 走「先網路、3 秒沒回就用快取」（確保拿到新版）；同站靜態檔與字型走「先快取」；
   商品圖與 API 不快取（永遠最新、也不佔空間）。 */
const SHELL = 'tryon-shell-v1';
const STATIC = ['./', './index.html', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png',
  './demo/f-before.webp?v=20261106', './demo/f-after.webp?v=20261106', './demo/m-before.webp?v=20261106', './demo/m-after.webp?v=20261106'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(STATIC).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

function networkFirst(req, ms) {
  return new Promise(resolve => {
    let done = false;
    const t = setTimeout(async () => { if (done) return; const c = await caches.match(req, { ignoreSearch: true }); if (c) { done = true; resolve(c); } }, ms);
    fetch(req).then(async r => {
      if (done) { if (r.ok) (await caches.open(SHELL)).put(req, r.clone()); return; }
      done = true; clearTimeout(t);
      if (r.ok) (await caches.open(SHELL)).put(req, r.clone());
      resolve(r);
    }).catch(async () => { if (done) return; done = true; clearTimeout(t); resolve((await caches.match(req, { ignoreSearch: true })) || Response.error()); });
  });
}
async function cacheFirst(req) {
  const c = await caches.match(req); if (c) return c;
  const r = await fetch(req); if (r.ok || r.type === 'opaque') (await caches.open(SHELL)).put(req, r.clone()); return r;
}

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  // 導覽／主頁：先網路，3 秒沒回或離線就用快取
  if (req.mode === 'navigate' || (u.origin === location.origin && /\/index\.html$/.test(u.pathname))) { e.respondWith(networkFirst(req, 3000)); return; }
  // 同站靜態檔（圖示、示範圖、manifest、sw 以外）：先快取
  if (u.origin === location.origin && /\.(webp|jpg|png|svg|json|woff2?)$/.test(u.pathname)) { e.respondWith(cacheFirst(req)); return; }
  // 字型與 Supabase 用戶端：先快取
  if (/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname) || u.hostname === 'cdn.jsdelivr.net') { e.respondWith(cacheFirst(req)); return; }
  // 其他（API、商品圖、合成結果）：不經快取
});
