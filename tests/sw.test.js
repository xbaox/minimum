process.env.TZ = 'America/Toronto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const SRC = readFileSync(new URL('sw.js', ROOT), 'utf8');
const SCOPE = 'https://xbaox.github.io/minimum/';

function loadSW(cacheNames = [], { online = false } = {}) {
  const handlers = {};
  const calls = { skipWaiting: 0, claim: 0, deleted: [], added: [] };
  const store = new Map(cacheNames.map(n => [n, new Map()]));
  const cacheObj = name => ({
    addAll: async reqs => { calls.added.push(...reqs); for (const r of reqs) store.get(name).set(new URL(r.url, SCOPE).href, 'cached:' + r.url); },
    put: async (req, res) => { store.get(name).set(new URL(req.url, SCOPE).href, res.body); },
    match: async (req, opts) => {
      let url = new URL(typeof req === 'string' ? req : req.url, SCOPE);
      if (opts?.ignoreSearch) url.search = '';
      return store.get(name).get(url.href);
    },
  });
  const ctx = {
    self: {
      addEventListener: (t, f) => { handlers[t] = f; },
      skipWaiting: () => { calls.skipWaiting++; return Promise.resolve(); },
      clients: { claim: async () => { calls.claim++; } },
      registration: { scope: SCOPE },
    },
    caches: {
      open: async n => { if (!store.has(n)) store.set(n, new Map()); return cacheObj(n); },
      keys: async () => [...store.keys()],
      delete: async n => { calls.deleted.push(n); return store.delete(n); },
    },
    Request: class { constructor(url, init) { this.url = url; this.cache = init?.cache; } },
    fetch: async req => {
      if (!online) throw new TypeError('offline');
      const res = { ok: true, body: 'net:' + req.url };
      return { ...res, clone: () => res };
    },
    URL,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC + '\n;self.__t = { VERSION, ASSETS };', ctx);
  const fire = (type, ev) => {
    const waits = [];
    handlers[type]({ waitUntil: p => waits.push(p), respondWith: p => waits.push(p), ...ev });
    return Promise.all(waits);
  };
  return { ...ctx.self.__t, calls, store, fire, ctx };
}

test('VERSION — minimum-vN и больше 50', () => {
  const { VERSION } = loadSW();
  const m = VERSION.match(/^minimum-(v\d+)$/);
  assert.ok(m, VERSION);
  assert.ok(+m[1].slice(1) > 50);
});

test('version отвечает {version} в порт', async () => {
  const { fire, VERSION } = loadSW();
  const got = [];
  await fire('message', { data: { type: 'version' }, ports: [{ postMessage: m => got.push(m) }] });
  assert.deepEqual(JSON.parse(JSON.stringify(got)), [{ version: VERSION }]);
});

test('skipWaiting по сообщению, install его не вызывает', async () => {
  const sw = loadSW();
  await sw.fire('install', {});
  assert.equal(sw.calls.skipWaiting, 0);
  assert.equal(sw.calls.added.length, sw.ASSETS.length);
  assert.ok(sw.calls.added.every(r => r.cache === 'reload'));
  await sw.fire('message', { data: { type: 'skipWaiting' }, ports: [] });
  assert.equal(sw.calls.skipWaiting, 1);
  await sw.fire('message', { data: null, ports: [] }); // мусор не роняет
});

test('activate удаляет только свои старые кэши и забирает клиентов', async () => {
  const neighbours = ['english-summer-v1', 'shell-v2.8.1', 'fonts-v1'];
  const sw = loadSW(['minimum-v50', 'minimum-v49', ...neighbours]);
  await sw.fire('install', {});
  await sw.fire('activate', {});
  assert.deepEqual(sw.calls.deleted.sort(), ['minimum-v49', 'minimum-v50']);
  assert.deepEqual([...sw.store.keys()].sort(), [...neighbours, sw.VERSION].sort());
  assert.equal(sw.calls.claim, 1);
});

test('ASSETS покрывает все файлы деплоя, и все они существуют', () => {
  const { ASSETS } = loadSW();
  const deploy = readdirSync(ROOT)
    .filter(f => /\.(html|css|js|json|png)$/.test(f) && !['package.json', 'package-lock.json', 'sw.js'].includes(f))
    .map(f => './' + f);
  for (const f of deploy) assert.ok(ASSETS.includes(f), 'нет в ASSETS: ' + f);
  for (const f of ASSETS) if (f !== './') assert.ok(deploy.includes(f), 'нет файла: ' + f);
  assert.ok(ASSETS.includes('./'));
});

test('cache-first, навигация без сети — index.html, чужой путь не трогаем', async () => {
  const sw = loadSW();
  await sw.fire('install', {});
  const respond = async req => { let r; sw.fire('fetch', { request: req, respondWith: p => { r = p; } }); return r; };
  const get = (url, mode = 'no-cors') => ({ url, method: 'GET', mode });
  assert.equal(await respond(get(SCOPE + 'app.js')), 'cached:./app.js');
  assert.equal(await respond(get(SCOPE + '?utm=1', 'navigate')), 'cached:./');
  assert.equal(await respond(get(SCOPE + 'nope', 'navigate')), 'cached:./index.html');
  await assert.rejects(respond(get(SCOPE + 'nope.js')));
  assert.equal(await respond(get('https://xbaox.github.io/oborot/app.js')), undefined);
  assert.equal(await respond({ ...get(SCOPE + 'app.js'), method: 'POST' }), undefined);
});

test('кэш стёрли соседи — промахи докладываются обратно, офлайн возвращается', async () => {
  const sw = loadSW([], { online: true });
  const respond = req => new Promise(ok => {
    const waits = [];
    sw.fire('fetch', { request: req, waitUntil: p => waits.push(p), respondWith: p => p.then(r => Promise.all(waits).then(() => ok(r))) });
  });
  const res = await respond({ url: SCOPE + 'app.js', method: 'GET', mode: 'no-cors' });
  assert.equal(res.body, 'net:' + SCOPE + 'app.js');
  assert.equal(sw.store.get(sw.VERSION).get(SCOPE + 'app.js'), 'net:' + SCOPE + 'app.js');
  await respond({ url: SCOPE, method: 'GET', mode: 'navigate' });
  assert.equal(sw.calls.added.length, sw.ASSETS.length); // навигация без кэша перекладывает всё
  assert.ok(sw.store.get(sw.VERSION).get(SCOPE + 'index.html'));
});
