/* МИНИМУМ — service worker. Cache-first, полный офлайн после первой загрузки.
   При обновлении файлов поднимите VERSION — старый кэш будет удалён.

   VERSION — ЕДИНСТВЕННЫЙ источник номера версии во всём приложении
   (задача Р3). app.js своего номера не держит: «Минимум · v49» в
   «Системе» и «Доступна версия v49» над таб-баром он узнаёт сообщением
   {type: 'version'} у самого воркера. Второй источник разошёлся бы с
   этим молча — ровно та болезнь, от которой заведён замок версии
   (tests/releases.json); release-lock читает эту же строку. */

const VERSION = 'minimum-v50';

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

/* Установка только кладёт файлы в кэш — и ЖДЁТ (задача Р3). До Р3 здесь
   стоял self.skipWaiting(): новый воркер вытеснял старый сразу после
   установки, ожидающего воркера не бывало никогда, и предложить
   обновление было нечем — новая версия молча применялась при следующем
   запуске, а открытая страница до тех пор работала старым кодом поверх
   чужого кэша. Теперь установленный воркер стоит в registration.waiting,
   пока владелец не нажмёт «Обновить».

   Первую установку это не задерживает: активного воркера ещё нет, и
   установленный активируется сам, без skipWaiting.

   Файлы качаются МИМО HTTP-кэша устройства (cache: 'reload', Р3/рецензия).
   GitHub Pages отдаёт всё с Cache-Control: max-age=600, и addAll по голым
   строкам брал ответы из HTTP-кэша, пока они свежи: вторая установка в
   пределах десяти минут (хотфикс сразу за релизом, «Проверить обновления»
   без троттлинга) клала под новый VERSION прежние app.js, styles.css и
   index.html — и «Минимум · v50» показывал номер кода, которого на
   устройстве нет (замер в Chromium). updateViaCache: 'none' в регистрации
   касается только скрипта воркера, а не его ASSETS. Стратегия отдачи
   прежняя — cache-first; меняется лишь то, откуда кэш наполняется. */
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) =>
    c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))));
});

/* Активация: старые кэши чистятся, открытые страницы переходят под новый
   воркер (clients.claim). claim порождает на странице controllerchange,
   и перезагружает она себя ТОЛЬКО если сама взвела «Обновить»
   (ui.updateArmed в app.js): чужой claim — другой вкладки или первой
   установки — страницу не трогает. */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Протокол сообщений страницы (задача Р3). Типов ровно два:

   {type: 'version'} — ответ {version: VERSION} в порт MessageChannel,
   переданный с сообщением. Спрашивают и активный воркер (строка версии
   в «Системе»), и ожидающий (номер в предложении обновления).

   {type: 'skipWaiting'} — ожидающий воркер активируется. Только по
   сообщению, а не при установке: сообщение шлёт страница, когда владелец
   нажал «Обновить», — это и есть явное решение. Сама по себе смена
   версии не должна перезагружать приложение под пальцем: полузаполненная
   форма и открытый разбор пропали бы без спроса.

   Незнакомый тип, пустое сообщение и 'version' без порта игнорируются
   молча: старая страница или чужой скрипт не должны ронять воркер. */
self.addEventListener('message', (e) => {
  const data = e.data;
  const type = data && typeof data === 'object' ? data.type : null;
  if (type === 'version') {
    const port = e.ports && e.ports[0];
    if (port && typeof port.postMessage === 'function') port.postMessage({ version: VERSION });
  } else if (type === 'skipWaiting') {
    self.skipWaiting();
  }
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
