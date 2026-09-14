'use strict';
/* Смоук service worker: sw.js исполняется через vm с мок-scope
   (self/caches/fetch/Request/Response) — без jsdom и без реального SW-окружения. */

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

/* Запрос с режимом HTTP-кэша: установка качает ASSETS запросами
   cache: 'reload', а не голыми строками (Р3/рецензия) */
class FakeRequest {
  constructor(url, init = {}) {
    this.url = url;
    this.cache = init.cache ?? 'default';
  }
}

/* Свежий vm-контекст с мок-scope; поведение сети и кэша задаётся снаружи */
function bootSW({ cacheMatch = async () => undefined, netFetch, cacheKeys = [] } = {}) {
  const listeners = {};
  const puts = [];
  // вызовы жизненного цикла — для тестов задачи Р3: когда воркер
  // вытесняет прежний (skipWaiting), забирает страницы (claim) и что чистит
  const calls = { skipWaiting: 0, claim: 0, opened: [], added: [], deleted: [], order: [] };
  const ctx = {
    console,
    URL,
    Response: FakeResponse,
    Request: FakeRequest,
    location: { origin: 'https://example.org' },
    fetch: netFetch || (async () => { throw new Error('offline'); }),
    caches: {
      match: cacheMatch,
      open: async name => {
        calls.opened.push(name);
        return {
          put: async (req, res) => puts.push({ url: req.url, res }),
          // строка — голый URL (режим кэша default), запрос — его url и режим
          addAll: async list => {
            calls.added.push([...list].map(r => (typeof r === 'string' ? { url: r, cache: 'default' } : { url: r.url, cache: r.cache })));
            calls.order.push('addAll');
          }
        };
      },
      keys: async () => [...cacheKeys],
      delete: async k => { calls.deleted.push(k); calls.order.push('delete'); return true; }
    },
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: () => { calls.skipWaiting++; calls.order.push('skipWaiting'); return Promise.resolve(); },
      clients: { claim: () => { calls.claim++; calls.order.push('claim'); return Promise.resolve(); } }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(SW, ctx);
  const assets = vm.runInContext('ASSETS', ctx); // лексические const видны следующему скрипту контекста
  return { listeners, puts, assets, ctx, calls };
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
   значится — это невыпущенная версия; её имя обязано быть следующим по
   счёту, а запись о ней добавляется в releases.json в релизном коммите.

   Алгоритм отпечатка живёт в tools/deploy-hash.mjs (задача 22, п. 9.4):
   прежде он был продублирован здесь и в tools/release-lock.mjs дословно,
   и две копии могли разойтись молча. Модуль ESM, тест CommonJS — грузится
   динамическим import() в async-тесте.

   Задача 22, п. 9 закрывает три способа обезоружить замок:
   имя версии вне последовательности (9.3), удаление записи из
   releases.json (9.1) и прогон release-lock.mjs без подъёма VERSION (9.2,
   в самом инструменте). */

const { execFileSync } = require('node:child_process');

const LOCK_PATH = path.join(ROOT, 'tests', 'releases.json');
const readReleases = () => JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));

const swVersion = () => (fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8')
  .match(/const VERSION = '([^']+)'/) || [])[1];

const hashMod = () => import('../tools/deploy-hash.mjs');

test('sw: VERSION — следующий по счёту, отпечаток выпущенной версии сходится', async () => {
  const { deployHash, versionNumber, maxReleaseNumber, nextVersionName } = await hashMod();
  const version = swVersion();
  assert.ok(version, 'VERSION задан строкой');
  assert.match(version, /^minimum-v\d+$/, 'формат имени версии');

  const releases = readReleases();
  assert.ok(Array.isArray(releases) && releases.length, 'список релизов не пуст');
  const names = releases.map(r => r.version);
  assert.equal(new Set(names).size, names.length, 'версии в списке уникальны');

  const known = releases.find(r => r.version === version);
  if (known) {
    // выпущенная версия: файлы деплоя обязаны совпадать с её отпечатком
    assert.equal(deployHash(ROOT), known.hash,
      `файлы деплоя изменились, а VERSION остался ${version}. Подними VERSION в sw.js ` +
      'и добавь запись в tests/releases.json (node tools/release-lock.mjs).');
    return;
  }

  // невыпущенная версия отпечатка ещё не имеет — сверять нечего, поэтому
  // само имя обязано быть следующим по счёту. «Строго больше» оставляло бы
  // minimum-v999: сверка молча выключена, прод отдаёт старое из cache-first.
  assert.equal(version, nextVersionName(releases),
    `VERSION = ${version}, ожидается ${nextVersionName(releases)}`);
  assert.equal(versionNumber(version), maxReleaseNumber(releases) + 1);
});

/* 9.1: набор выпущенных версий только растёт. Удаление записи снимало
   сверку отпечатка так же тихо, как подмена имени: версия становилась
   «невыпущенной». Сверяемся с предыдущим коммитом через git; git
   недоступен (поверхностный клон, экспорт архивом) — пропуск, но громкий. */
test('sw: набор релизов только растёт относительно предыдущего коммита', () => {
  let prevRaw;
  try {
    prevRaw = execFileSync('git', ['show', 'HEAD:tests/releases.json'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    console.warn('sw: git недоступен — монотонность набора релизов не проверена');
    return;
  }
  const prev = JSON.parse(prevRaw).map(r => r.version);
  const now = new Set(readReleases().map(r => r.version));
  const lost = prev.filter(v => !now.has(v));
  assert.deepEqual(lost, [],
    `версии пропали из tests/releases.json: ${lost.join(', ')}. Набор релизов только растёт.`);
});

test('sw: список ASSETS покрывает все файлы отпечатка, кроме самого sw.js', async () => {
  const { DEPLOY_FILES } = await hashMod();
  const { assets } = bootSW();
  const listed = new Set([...assets].map(a => a.replace(/^\.\//, '')));
  for (const f of DEPLOY_FILES) {
    if (f === 'sw.js') continue;
    assert.ok(listed.has(f), `${f} входит в отпечаток релиза, но не в ASSETS`);
  }
});

/* ── Задача 22, п. 9: замок версии закрыт с четырёх сторон ─────
   Проверка идёт в изолированной копии дерева во временном каталоге:
   живое дерево не мутируется, releases.json не переписывается.
   Дочерний прогон помечается LOCK_SANDBOX — иначе он завёл бы свою
   песочницу и рекурсия не кончилась бы. */

const os = require('node:os');
const nodeCrypto = require('node:crypto');
const SANDBOX = process.env.LOCK_SANDBOX === '1';

test('замок: общий модуль даёт тот же отпечаток, что прежние две реализации', async () => {
  const { deployHash, DEPLOY_FILES } = await import('../tools/deploy-hash.mjs');

  // дословная прежняя реализация (sw.test.js и release-lock.mjs до задачи 22)
  const legacy = () => {
    const h = nodeCrypto.createHash('sha256');
    for (const f of [...DEPLOY_FILES].sort()) {
      h.update(f); h.update('\0');
      h.update(fs.readFileSync(path.join(ROOT, f)));
      h.update('\0');
    }
    return h.digest('hex');
  };
  assert.equal(deployHash(ROOT), legacy(), 'алгоритм не изменился при выносе в модуль');

  // алгоритм живёт в одном месте: копий createHash в тесте и инструменте нет
  const tool = fs.readFileSync(path.join(ROOT, 'tools', 'release-lock.mjs'), 'utf8');
  assert.doesNotMatch(tool, /createHash/, 'инструмент считает отпечаток модулем');
  const self = fs.readFileSync(__filename, 'utf8').split('прежние две реализации')[0];
  assert.doesNotMatch(self, /createHash/, 'и тест тоже — кроме эталона выше');
});

test('замок: номер версии сравнивается числом, а не строкой', async () => {
  const { versionNumber, maxReleaseNumber, nextVersionName } = await import('../tools/deploy-hash.mjs');

  assert.equal(versionNumber('minimum-v31'), 31);
  assert.equal(versionNumber('minimum-v9'), 9);
  assert.equal(versionNumber('minimum-v31a'), null, 'имя вне формата');
  assert.equal(versionNumber(''), null);
  assert.equal(versionNumber(undefined), null);

  const list = [{ version: 'minimum-v9' }, { version: 'minimum-v10' }];
  assert.equal(maxReleaseNumber(list), 10, 'v10 больше v9 — не лексикографически');
  assert.equal(nextVersionName(list), 'minimum-v11');
  assert.equal(nextVersionName([]), 'minimum-v1');
  assert.equal(nextVersionName([{ version: 'мусор' }]), 'minimum-v1');
});

/* Изолированная копия дерева: только то, что нужно замку. Внутри —
   свой git-репозиторий: без него монотонность набора не проверить. */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimum-lock-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.mkdirSync(path.join(dir, 'tools'));
  const copy = rel => fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  for (const f of deployFilesOnDisk()) copy(f);
  copy('sw.js');
  copy(path.join('tests', 'sw.test.js'));
  copy(path.join('tests', 'releases.json'));
  copy(path.join('tools', 'deploy-hash.mjs'));
  copy(path.join('tools', 'release-lock.mjs'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  return dir;
}

/* Окружение дочернего прогона: LOCK_SANDBOX гасит рекурсию, а
   NODE_TEST_CONTEXT снимается — унаследованный, он заставляет вложенный
   node --test считать себя частью внешнего прогона и возвращать 0
   независимо от результата (полдня на выяснение). */
const childEnv = () => {
  const env = { ...process.env, LOCK_SANDBOX: '1' };
  delete env.NODE_TEST_CONTEXT;
  return env;
};
const spawn = (dir, args) =>
  require('node:child_process').spawnSync(process.execPath, args,
    { cwd: dir, env: childEnv(), stdio: 'ignore' }).status;

const lockStatus = dir => spawn(dir, ['--test', 'tests/sw.test.js']);
const toolStatus = dir => spawn(dir, ['tools/release-lock.mjs']);
const setVersion = (dir, name) => {
  const p = path.join(dir, 'sw.js');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
    .replace(/const VERSION = '[^']+'/, `const VERSION = '${name}'`));
};
const readLock = dir => JSON.parse(fs.readFileSync(path.join(dir, 'tests', 'releases.json'), 'utf8'));
const writeLock = (dir, v) =>
  fs.writeFileSync(path.join(dir, 'tests', 'releases.json'), JSON.stringify(v, null, 2) + '\n');

test('замок: четыре способа обезоружить дают код 1, честный релиз проходит', { skip: SANDBOX }, () => {
  let dir;
  try { dir = sandbox(); } catch (e) {
    console.warn('замок: песочница не создана (нет git?) — проверка пропущена:', e.message);
    return;
  }
  const base = readLock(dir);
  const next = 'minimum-v' + (Math.max(...base.map(r => +r.version.slice(9))) + 1);

  // контроль: нетронутое дерево замок проходит
  assert.equal(lockStatus(dir), 0, 'исходное дерево зелёное');

  // 1. незнакомое имя вбок — сверка отпечатка молча выключалась
  setVersion(dir, 'minimum-v9');
  assert.equal(lockStatus(dir), 1, 'имя ниже выпущенных');

  // 2. прыжок вперёд — тоже незнакомое имя, и тоже без отпечатка
  setVersion(dir, 'minimum-v999');
  assert.equal(lockStatus(dir), 1, 'прыжок через номера');
  setVersion(dir, next);

  // 3. удаление записи из releases.json. Убираем не последнюю, а среднюю:
  // максимум не меняется, правило «следующий по счёту» ничего не замечает —
  // ловит только монотонность набора (9.1), ради неё она и заведена.
  writeLock(dir, base.filter((_, i) => i !== base.length - 2));
  assert.equal(lockStatus(dir), 1, 'набор релизов сократился');
  writeLock(dir, base);
  assert.equal(lockStatus(dir), 0, 'вернули — снова зелено');

  // 4. прогон инструмента без подъёма VERSION: переподписывал старое имя
  setVersion(dir, base[base.length - 1].version);
  assert.equal(toolStatus(dir), 1, 'release-lock отказывается переписывать выпущенную версию');
  assert.deepEqual(readLock(dir), base, 'файл замка не тронут');

  // честный релиз: правка файла деплоя + следующий VERSION + release-lock
  setVersion(dir, next);
  fs.appendFileSync(path.join(dir, 'app.js'), '\n/* правка релиза */\n');
  assert.equal(lockStatus(dir), 0, 'невыпущенная версия со следующим номером проходит');
  assert.equal(toolStatus(dir), 0, 'отпечаток записан');
  assert.equal(readLock(dir).length, base.length + 1);
  assert.equal(lockStatus(dir), 0, 'релиз зафиксирован, замок зелёный');

  // и сразу после релиза правка файла деплоя снова роняет тест
  fs.appendFileSync(path.join(dir, 'app.js'), '\n/* после релиза */\n');
  assert.equal(lockStatus(dir), 1, 'изменение после релиза без подъёма VERSION');

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── Задача Р3, п. 1: протокол сообщений и жизненный цикл ─────
   Новая версия предлагается, а не применяется: установка только кладёт
   файлы в кэш и ЖДЁТ, skipWaiting — по сообщению страницы, которое она
   шлёт по тапу «Обновить». Номер версии страница спрашивает у воркера:
   второго источника версии в app.js нет. Объекты из vm-контекста —
   чужого realm, поэтому ответы сравниваются через JSON, а не deepEqual
   (у них другой Object.prototype). */

const json = v => JSON.parse(JSON.stringify(v));

async function swMessage(listeners, data, ports) {
  const waits = [];
  listeners.message({ data, ports, waitUntil: p => waits.push(p) });
  await Promise.all(waits);
}

test('Р3/1: {type: "version"} — ответ {version: VERSION} в порт MessageChannel', async () => {
  const { listeners, ctx, calls } = bootSW();
  assert.equal(typeof listeners.message, 'function', 'обработчик message есть');
  const got = [];
  await swMessage(listeners, { type: 'version' }, [{ postMessage: m => got.push(m) }]);
  assert.deepEqual(json(got), [{ version: vm.runInContext('VERSION', ctx) }]);
  assert.equal(got[0].version, swVersion(), 'номер — та самая строка VERSION, что читает замок');
  assert.equal(calls.skipWaiting, 0, 'вопрос о версии воркер не активирует');
});

test('Р3/1: незнакомый тип, пустое сообщение, «version» без порта — без ошибок и без ответа', async () => {
  const { listeners, calls } = bootSW();
  const got = [];
  const port = { postMessage: m => got.push(m) };
  for (const data of [{ type: 'reload' }, { type: 'VERSION' }, { type: 'skipwaiting' }, {}, null, undefined,
    'version', 'skipWaiting', 42, ['version']]) {
    assert.doesNotThrow(() => listeners.message({ data, ports: [port] }), JSON.stringify(data) ?? 'undefined');
  }
  assert.doesNotThrow(() => listeners.message({ data: { type: 'version' }, ports: [] }), 'пустой список портов');
  assert.doesNotThrow(() => listeners.message({ data: { type: 'version' } }), 'портов нет вовсе');
  assert.doesNotThrow(() => listeners.message({ data: { type: 'version' }, ports: [{}] }), 'порт без postMessage');
  assert.deepEqual(got, [], 'ответа нет никому');
  assert.equal(calls.skipWaiting, 0, 'и строка «skipWaiting» вместо объекта воркер не активирует');
});

test('Р3/1: установка кладёт ASSETS в кэш VERSION и ЖДЁТ; skipWaiting — только по сообщению', async () => {
  const { listeners, ctx, calls, assets } = bootSW();
  const V = vm.runInContext('VERSION', ctx);
  const waits = [];
  listeners.install({ waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  assert.equal(waits.length, 1, 'установка под waitUntil');
  assert.deepEqual(calls.opened, [V]);
  assert.deepEqual(calls.added.map(list => list.map(r => r.url)), [[...assets]], 'стратегия кэша прежняя: весь ASSETS');
  assert.equal(calls.skipWaiting, 0,
    'установка не вытесняет активный воркер — иначе ожидающего не бывает, и предложить обновление нечем');
  // и в самом обработчике вызова нет (комментарии не в счёт)
  const install = SW.slice(SW.indexOf("addEventListener('install'"), SW.indexOf("addEventListener('activate'"))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(install, /skipWaiting/);

  await swMessage(listeners, { type: 'skipWaiting' });
  assert.equal(calls.skipWaiting, 1, 'сообщение страницы активирует ожидающий');
  assert.equal(calls.claim, 0, 'claim — дело активации, а не сообщения');
});

test('Р3/1: активация — чистит чужие кэши, затем забирает страницы (clients.claim)', async () => {
  const V = swVersion();
  const { listeners, calls } = bootSW({ cacheKeys: ['minimum-v47', V, 'minimum-v48', 'чужой'] });
  const waits = [];
  listeners.activate({ waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  assert.deepEqual([...calls.deleted].sort(), ['minimum-v47', 'minimum-v48', 'чужой'].sort(), 'свой кэш цел, прочие сняты');
  assert.equal(calls.claim, 1, 'открытые страницы переходят под новый воркер');
  assert.equal(calls.order.at(-1), 'claim', 'claim — после чистки');
  assert.equal(calls.skipWaiting, 0);
});

test('Р3/1: app.js регистрирует воркер с updateViaCache: "none" ровно в одном месте; номера версии в app.js нет', () => {
  const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(APP, /\.register\('\.\/sw\.js', \{ updateViaCache: 'none' \}\)/,
    'скрипт воркера — мимо HTTP-кэша: иначе прежний sw.js из кэша прятал бы новую версию');
  assert.equal((APP.match(/\.register\(/g) || []).length, 1, 'регистрация одна');
  // единственный источник номера — VERSION в sw.js: строкового литерала версии в app.js нет
  assert.doesNotMatch(APP, /['"`]minimum-v\d+/, 'второго источника версии нет');
  assert.doesNotMatch(APP, /location\.reload\(\)[\s\S]*location\.reload\(\)/, 'перезагрузка зовётся из одного места');
});

/* Р3/рецензия: GitHub Pages отдаёт файлы с max-age=600, и addAll по голым
   строкам брал их из HTTP-кэша устройства, пока свежи. Вторая установка в
   пределах десяти минут (хотфикс за релизом) клала под новый VERSION
   прежние app.js, styles.css и index.html, а «Минимум · v50» называл код,
   которого на устройстве нет (замер в Chromium: кэш minimum-v50 с app.js
   v49). Скрипт воркера мимо кэша уже идёт (updateViaCache), ASSETS — нет. */
test('Р3/рецензия: установка качает ASSETS мимо HTTP-кэша — каждый запрос cache: "reload", ни одной голой строки', async () => {
  const { listeners, calls, assets } = bootSW();
  const waits = [];
  listeners.install({ waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  assert.equal(calls.added.length, 1, 'addAll один');
  const got = calls.added[0];
  assert.deepEqual(got.map(r => r.url), [...assets], 'те же адреса и тот же порядок');
  assert.deepEqual(got.map(r => r.cache), [...assets].map(() => 'reload'),
    'режим default взял бы свежий по max-age ответ прежней версии');
});
