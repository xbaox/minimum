'use strict';
/* Иконки: валидная PNG-сигнатура и размеры из IHDR — парсинг без зависимостей. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ICONS = [
  ['icon-180.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-192-maskable.png', 192],
  ['icon-512-maskable.png', 512]
];

for (const [name, size] of ICONS) {
  test(`иконка ${name}: PNG-сигнатура и размер ${size}x${size} из IHDR`, () => {
    const buf = fs.readFileSync(path.join(ROOT, name));
    assert.equal(buf.subarray(0, 8).equals(PNG_SIG), true, 'сигнатура PNG');
    // первый чанк — IHDR: длина 13, тип на смещении 12, ширина/высота — 16/20
    assert.equal(buf.readUInt32BE(8), 13, 'длина IHDR');
    assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(buf.readUInt32BE(16), size, 'ширина');
    assert.equal(buf.readUInt32BE(20), size, 'высота');
    assert.equal(buf[24], 8, 'битность');
  });
}
