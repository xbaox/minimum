/* Запись отпечатка выпускаемой версии в tests/releases.json (задача 19, C.1.4).
   Запускать в релизном коммите, после того как VERSION в sw.js поднят:
       node tools/release-lock.mjs
   Тест sw.test.js падает, если файлы деплоя изменились, а VERSION — нет. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'index.html', 'styles.css', 'app.js', 'sw.js', 'manifest.json',
  'icon-180.png', 'icon-192.png', 'icon-512.png',
  'icon-192-maskable.png', 'icon-512-maskable.png'
];

const h = createHash('sha256');
for (const f of [...FILES].sort()) {
  h.update(f); h.update('\0');
  h.update(readFileSync(join(ROOT, f)));
  h.update('\0');
}
const hash = h.digest('hex');
const version = readFileSync(join(ROOT, 'sw.js'), 'utf8').match(/const VERSION = '([^']+)'/)[1];

const lockPath = join(ROOT, 'tests', 'releases.json');
const releases = JSON.parse(readFileSync(lockPath, 'utf8'));
const at = releases.findIndex(r => r.version === version);
if (at >= 0) releases[at].hash = hash;
else releases.push({ version, hash });
writeFileSync(lockPath, JSON.stringify(releases, null, 2) + '\n');
console.log(`${version}: ${hash}`);
