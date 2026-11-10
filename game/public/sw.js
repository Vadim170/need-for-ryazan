// Service worker: кэш ассетов игры в браузере игрока (тайлы мира, модели, текстуры, звук, код).
// Регистрируется из src/core/offline-cache.ts как /sw.js?v=<версия релиза>; в dev не используется.
//
// Стратегия — cache-first с перепроверкой после релиза:
//   - ответ из кэша той же версии отдаётся сразу, без сети;
//   - ответ из кэша прошлой версии перепроверяется условным запросом (If-None-Match / If-Modified-Since):
//     304 — файл не менялся, берём из кэша (скачиваются только изменившиеся файлы); 200 — кладём новый;
//   - нет сети — отдаём что есть в кэше.
// index.html — network-first (чтобы новый релиз подхватывался сразу), при офлайне — из кэша.

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'nfr-assets';
const VER_HEADER = 'x-nfr-ver';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname === '/sw.js') return;
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(networkFirst(e));
    return;
  }
  e.respondWith(cacheFirst(e));
});

/** Копия ответа для кэша: тело уже распаковано браузером, поэтому content-encoding/length не храним. */
async function toCached(res, body) {
  const headers = new Headers(res.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.set(VER_HEADER, VERSION);
  return new Response(body ?? await res.blob(), { status: 200, headers });
}

/** Записать в кэш в фоне, не задерживая ответ игре. */
function store(e, cache, key, res) {
  if (!res.ok || res.type !== 'basic') return;
  e.waitUntil(toCached(res).then((r) => cache.put(key, r)).catch(() => { /* квота кончилась — работаем без кэша */ }));
}

async function cacheFirst(e) {
  const req = e.request;
  const cache = await caches.open(CACHE);
  const key = req.url;
  const hit = await cache.match(key);
  if (hit && hit.headers.get(VER_HEADER) === VERSION) return hit;
  try {
    const headers = new Headers();
    if (hit) {
      const etag = hit.headers.get('etag');
      const lm = hit.headers.get('last-modified');
      if (etag) headers.set('If-None-Match', etag);
      if (lm) headers.set('If-Modified-Since', lm);
    }
    const res = await fetch(key, { headers, cache: 'no-store', credentials: 'same-origin' });
    if (res.status === 304 && hit) {
      const fresh = await toCached(hit, await hit.blob());
      e.waitUntil(cache.put(key, fresh.clone()).catch(() => {}));
      return fresh;
    }
    if (res.ok) { store(e, cache, key, res.clone()); return res; }
    return hit || res;
  } catch (err) {
    if (hit) return hit;
    throw err;
  }
}

async function networkFirst(e) {
  const cache = await caches.open(CACHE);
  const key = new URL('/index.html', self.location.origin).href;
  try {
    const res = await fetch(e.request);
    store(e, cache, key, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}
