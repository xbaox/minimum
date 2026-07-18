'use strict';
/* Смоук service worker: sw.js исполняется через vm с мок-scope
   (self/caches/fetch/Response) — без jsdom и без реального SW-окружения. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

class FakeResponse {
  constructor(body, init = {}) {
    this.body = String(body ?? '');
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.statusText = init.statusText || '';
    this.headers = init.headers || {};
  }
  clone() { return new FakeResponse(this.body, { status: this.status, headers: this.headers }); }
}

/* Свежий vm-контекст с мок-scope; поведение сети и кэша задаётся снаружи */
function bootSW({ cacheMatch = async () => undefined, netFetch } = {}) {
  const listeners = {};
  const puts = [];
  const ctx = {
    console,
    URL,
    Response: FakeResponse,
    location: { origin: 'https://example.org' },
    fetch: netFetch || (async () => { throw new Error('offline'); }),
    caches: {
      match: cacheMatch,
      open: async () => ({ put: async (req, res) => puts.push({ url: req.url, res }), addAll: async () => {} }),
      keys: async () => [],
      delete: async () => true
    },
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: () => {},
      clients: { claim: () => {} }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(SW, ctx);
  const assets = vm.runInContext('ASSETS', ctx); // лексические const видны следующему скрипту контекста
  return { listeners, puts, assets, ctx };
}

/* Прогон fetch-события до ответа и завершения фоновых записей */
async function dispatchFetch(listeners, request) {
  const waits = [];
  let responded = null;
  const event = {
    request,
    respondWith: p => { responded = p; },
    waitUntil: p => { waits.push(p); }
  };
  listeners.fetch(event);
  const res = responded === null ? null : await responded;
  await Promise.all(waits);
  return res;
}

test('sw: ASSETS совпадает с фактическим набором файлов деплоя на диске', () => {
  const { assets } = bootSW();
  const expected = [
    './', './index.html', './styles.css', './app.js', './manifest.json',
    './icon-180.png', './icon-192.png', './icon-512.png',
    './icon-192-maskable.png', './icon-512-maskable.png'
  ];
  assert.deepEqual([...assets].sort(), [...expected].sort());
  for (const a of assets) {
    if (a === './') continue;
    assert.equal(fs.existsSync(path.join(ROOT, a)), true, `${a} существует на диске`);
  }
});

test('sw: ok-ответ кэшируется под waitUntil, не-ok — не попадает в кэш', async () => {
  // 200 — кладётся
  const okCase = bootSW({ netFetch: async () => new FakeResponse('x', { status: 200 }) });
  const res1 = await dispatchFetch(okCase.listeners, {
    method: 'GET', url: 'https://example.org/minimum/styles.css', mode: 'no-cors'
  });
  assert.equal(res1.status, 200);
  assert.equal(okCase.puts.length, 1);

  // 404 — не кладётся, но ответ отдан как есть
  const badCase = bootSW({ netFetch: async () => new FakeResponse('нет', { status: 404 }) });
  const res2 = await dispatchFetch(badCase.listeners, {
    method: 'GET', url: 'https://example.org/minimum/app.js', mode: 'no-cors'
  });
  assert.equal(res2.status, 404);
  assert.equal(badCase.puts.length, 0);
});

test('sw: навигация офлайн без кэша — Response 503, не undefined', async () => {
  const { listeners } = bootSW(); // кэш пуст, сеть падает
  const res = await dispatchFetch(listeners, {
    method: 'GET', url: 'https://example.org/minimum/', mode: 'navigate'
  });
  assert.ok(res instanceof FakeResponse, 'respondWith получил Response');
  assert.equal(res.status, 503);
  assert.match(res.body, /Нет соединения и сохранённой копии/);
  assert.match(res.headers['Content-Type'], /charset=utf-8/);
});

test('sw: навигация офлайн с кэшированным index.html — отдаётся копия', async () => {
  const page = new FakeResponse('<html>app</html>', { status: 200 });
  const { listeners } = bootSW({
    cacheMatch: async req => {
      const url = typeof req === 'string' ? req : req.url;
      return url === './index.html' ? page : undefined;
    }
  });
  const res = await dispatchFetch(listeners, {
    method: 'GET', url: 'https://example.org/minimum/', mode: 'navigate'
  });
  assert.equal(res, page);
});

test('sw: не-GET и чужой origin не перехватываются', async () => {
  const { listeners } = bootSW();
  for (const request of [
    { method: 'POST', url: 'https://example.org/x', mode: 'no-cors' },
    { method: 'GET', url: 'https://evil.example.com/x', mode: 'no-cors' }
  ]) {
    const res = await dispatchFetch(listeners, request);
    assert.equal(res, null); // respondWith не вызывался
  }
});
