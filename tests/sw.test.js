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

/* Файлы деплоя на диске: всё в корне репозитория, что уезжает пользователю.
   Служебное (тесты, инструменты, конфиги, README, сам sw.js) отсеивается по
   расширению и по явному списку — расширения деплоя в проекте всего четыре:
   html, css, js, json, png. */
const NOT_DEPLOYED = new Set([
  'sw.js',              // сам себя не кэширует
  'package.json', 'package-lock.json', 'CLAUDE.md', 'README.md', '.gitattributes'
]);
const DEPLOY_EXT = new Set(['.html', '.css', '.js', '.json', '.png']);

function deployFilesOnDisk() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => d.name)
    .filter(n => DEPLOY_EXT.has(path.extname(n)) && !NOT_DEPLOYED.has(n))
    .sort();
}

/* Задача 19, C.3: тест назывался «совпадает с фактическим набором файлов на
   диске», а сверял с захардкоженным списком — забытый в ASSETS файл он не
   ловил (аудит, находка 14). Теперь диск читается по-настоящему. */
test('sw: ASSETS совпадает с фактическим набором файлов деплоя на диске', () => {
  const { assets } = bootSW();
  const onDisk = deployFilesOnDisk();
  const listed = [...assets].filter(a => a !== './').map(a => a.replace(/^\.\//, '')).sort();

  const forgotten = onDisk.filter(f => !listed.includes(f));
  assert.deepEqual(forgotten, [],
    `файлы деплоя есть на диске, но не перечислены в ASSETS: ${forgotten.join(', ')}`);
  const phantom = listed.filter(f => !onDisk.includes(f));
  assert.deepEqual(phantom, [],
    `в ASSETS перечислено то, чего на диске нет: ${phantom.join(', ')}`);

  assert.ok(assets.includes('./'), 'корень кэшируется отдельной записью — навигация офлайн');
  assert.equal(new Set(assets).size, assets.length, 'без дублей');
  for (const a of listed) {
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

/* ── Задача 19, C.1.4: VERSION обязан подниматься вместе с деплоем ──
   «Изменил любой файл деплоя → подними VERSION в sw.js» — правило из
   CLAUDE.md, которое не проверял никто: мутация «VERSION не поднят»
   пережила всю батарею аудита. Проверяем без обращения к git (в CI
   бывает поверхностный клон): tests/releases.json хранит отпечаток
   выпущенных версий. Файлы деплоя изменились, а VERSION остался прежним —
   отпечаток не сойдётся и тест упадёт. VERSION поднят и в списке ещё не
   значится — это невыпущенная версия, она проходит; запись о ней
   добавляется в releases.json в релизном коммите. */

const crypto = require('node:crypto');

const DEPLOY_FILES = [
  'index.html', 'styles.css', 'app.js', 'sw.js', 'manifest.json',
  'icon-180.png', 'icon-192.png', 'icon-512.png',
  'icon-192-maskable.png', 'icon-512-maskable.png'
];

function deployHash() {
  const h = crypto.createHash('sha256');
  for (const f of [...DEPLOY_FILES].sort()) {
    h.update(f); h.update('\0');
    h.update(fs.readFileSync(path.join(ROOT, f)));
    h.update('\0');
  }
  return h.digest('hex');
}

const swVersion = () => (fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8')
  .match(/const VERSION = '([^']+)'/) || [])[1];

test('sw: VERSION поднят относительно предыдущего релиза', () => {
  const version = swVersion();
  assert.ok(version, 'VERSION задан строкой');
  assert.match(version, /^minimum-v\d+$/, 'формат имени версии');

  const releases = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'releases.json'), 'utf8'));
  assert.ok(Array.isArray(releases) && releases.length, 'список релизов не пуст');
  const names = releases.map(r => r.version);
  assert.equal(new Set(names).size, names.length, 'версии в списке уникальны');

  const known = releases.find(r => r.version === version);
  if (!known) return; // невыпущенная версия: правило соблюдено, отпечатка ещё нет

  assert.equal(deployHash(), known.hash,
    `файлы деплоя изменились, а VERSION остался ${version}. Подними VERSION в sw.js ` +
    'и добавь запись в tests/releases.json (см. tools/release-lock.mjs).');
});

test('sw: список ASSETS покрывает все файлы отпечатка, кроме самого sw.js', () => {
  const { assets } = bootSW();
  const listed = new Set([...assets].map(a => a.replace(/^\.\//, '')));
  for (const f of DEPLOY_FILES) {
    if (f === 'sw.js') continue;
    assert.ok(listed.has(f), `${f} входит в отпечаток релиза, но не в ASSETS`);
  }
});
