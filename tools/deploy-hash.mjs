/* Отпечаток релиза: список файлов деплоя и алгоритм хеша — одним местом.
   Прежде он был продублирован дословно в tests/sw.test.js и в
   tools/release-lock.mjs (задача 22, п. 9.4): две копии одного алгоритма
   расходятся молча, и замок версии перестаёт что-либо значить, оставаясь
   зелёным. Модуль .mjs, потому что release-lock.mjs — ESM; sw.test.js
   (CommonJS) грузит его динамическим import() в async-тесте. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* Всё, что уезжает пользователю. sw.js входит в отпечаток, хотя сам себя
   не кэширует: его VERSION и есть предмет проверки. */
export const DEPLOY_FILES = [
  'index.html', 'styles.css', 'app.js', 'sw.js', 'manifest.json',
  'icon-180.png', 'icon-192.png', 'icon-512.png',
  'icon-192-maskable.png', 'icon-512-maskable.png'
];

/* sha256 по именам и содержимому в устойчивом порядке; \0 между полями,
   чтобы склейка «имя+содержимое» не сходилась у разных наборов. */
export function deployHash(root) {
  const h = createHash('sha256');
  for (const f of [...DEPLOY_FILES].sort()) {
    h.update(f); h.update('\0');
    h.update(readFileSync(join(root, f)));
    h.update('\0');
  }
  return h.digest('hex');
}

/* Имя версии — строго minimum-v{целое}; номер сравнивается числом, не
   строкой (иначе v9 оказался бы больше v10). null — имя вне формата. */
export function versionNumber(name) {
  const m = /^minimum-v(\d+)$/.exec(String(name || ''));
  return m ? Number(m[1]) : null;
}

/* Наибольший выпущенный номер; список пуст — null */
export function maxReleaseNumber(releases) {
  let max = null;
  for (const r of releases) {
    const n = versionNumber(r && r.version);
    if (n !== null && (max === null || n > max)) max = n;
  }
  return max;
}

/* Ожидаемое имя следующего релиза: строго следующий по счёту.
   Не «строго больше»: прыжок вперёд (minimum-v999) отпечатка не имеет,
   сверка молча выключается, а прод продолжает отдавать старый app.js из
   cache-first — и добраться до такого имени можно обычной опечаткой
   (решение архитектора, задача 22, п. 9.3). */
export function nextVersionName(releases) {
  const max = maxReleaseNumber(releases);
  return 'minimum-v' + (max === null ? 1 : max + 1);
}
