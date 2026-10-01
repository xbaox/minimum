// Минимум v2 — service worker. Формат VERSION строго minimum-vN: страница v50 читает номер регуляркой.
const VERSION = 'minimum-v53';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './dom.js',
  './domain.js',
  './store.js',
  './icons.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png',
];

// Без skipWaiting: новая версия ждёт, пока владелец нажмёт «Обновить».
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
});

// Домен общий с другими PWA владельца: удаляем только свои старые кэши.
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('minimum-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

// Протокол понимает и страница v50: version → ответ в порт, skipWaiting → активация.
self.addEventListener('message', e => {
  const type = e.data && e.data.type;
  if (type === 'version') e.ports && e.ports[0] && e.ports[0].postMessage({ version: VERSION });
  else if (type === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.registration.scope)) return;
  const nav = req.mode === 'navigate';
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: nav });
    if (hit) return hit;
    // Промах — кэш могли стереть соседние PWA домена: докладываем, чтобы офлайн вернулся сам.
    if (nav) e.waitUntil(cache.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))).catch(() => {}));
    try {
      const res = await fetch(req);
      if (res.ok && !nav) e.waitUntil(cache.put(req, res.clone()).catch(() => {}));
      return res;
    } catch (err) {
      const page = nav && (await cache.match('./index.html'));
      if (page) return page;
      throw err;
    }
  })());
});
