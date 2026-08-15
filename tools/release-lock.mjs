/* Запись отпечатка выпускаемой версии в tests/releases.json (задача 19, C.1.4).
   Запускать в релизном коммите, после того как VERSION в sw.js поднят:
       node tools/release-lock.mjs
   Тест sw.test.js падает, если файлы деплоя изменились, а VERSION — нет.

   Переписать хеш уже записанной версии инструмент отказывается (задача 22,
   п. 9.2): прогон на прежнем VERSION молча переподписывал изменённые файлы
   старым именем — замок снимался в одну команду, и тесты оставались
   зелёными. Алгоритм отпечатка живёт в tools/deploy-hash.mjs. */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployHash, nextVersionName } from './deploy-hash.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const hash = deployHash(ROOT);
const version = readFileSync(join(ROOT, 'sw.js'), 'utf8').match(/const VERSION = '([^']+)'/)[1];

const lockPath = join(ROOT, 'tests', 'releases.json');
const releases = JSON.parse(readFileSync(lockPath, 'utf8'));

if (releases.some(r => r.version === version)) {
  console.error(`${version} уже выпущена — подними VERSION в sw.js. ` +
    `Ожидается ${nextVersionName(releases)}.`);
  process.exit(1);
}

releases.push({ version, hash });
writeFileSync(lockPath, JSON.stringify(releases, null, 2) + '\n');
console.log(`${version}: ${hash}`);
