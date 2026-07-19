/* МИНИМУМ — service worker. Cache-first, полный офлайн после первой загрузки.
   При обновлении файлов поднимите VERSION — старый кэш будет удалён. */

const VERSION = 'minimum-v12-1';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png',
  './icon-192-maskable.png',
  './icon-512-maskable.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const OFFLINE_HTML = '<!doctype html><html lang="ru"><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Минимум</title>' +
  '<p>Нет соединения и сохранённой копии. Откройте приложение онлайн один раз.</p></html>';

async function respond(e) {
  const req = e.request;
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const copy = res.clone();
      e.waitUntil(caches.open(VERSION).then((c) => c.put(req, copy))); // не-ok в кэш не попадает
    }
    return res;
  } catch (err) {
    if (req.mode === 'navigate') {
      const page = await caches.match('./index.html');
      if (page) return page;
      // respondWith никогда не получает undefined
      return new Response(OFFLINE_HTML, {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }
    return new Response('', { status: 503, statusText: 'offline' });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== location.origin) return;
  e.respondWith(respond(e));
});
