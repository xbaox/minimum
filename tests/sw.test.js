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
