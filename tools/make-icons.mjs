// Генератор иконок «Минимума». Чистый Node, без зависимостей.
// Мотив: тёмная плитка #131417, точка над планкой цвета акцента тёмной темы.
// Запуск: node tools/make-icons.mjs  (пишет PNG в корень проекта)

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const BG = [0x13, 0x14, 0x17]; // тёмная плитка
const FG = [0x8f, 0xbc, 0xaa]; // эвкалипт тёмной темы

/* ── PNG-энкодер: 8-бит RGBA, фильтр 0, один IDAT ──────────── */

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([head, t, data, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // бит на канал
  ihdr[9] = 6;  // цветовой тип: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // фильтр none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ── Рендер мотива с суперсэмплингом 4x ────────────────────── */

function renderIcon(size, scale) {
  const SS = 4; // 4x4 сабсэмпла на пиксель
  const buf = Buffer.alloc(size * size * 4);

  // геометрия в долях стороны, мотив центрирован на (0.5, 0.5)
  const dotR = 0.085 * scale;
  const dotY = 0.5 - 0.13 * scale;
  const barHalf = 0.26 * scale;  // половина длины планки-капсулы
  const barR = 0.032 * scale;    // полутолщина
  const barY = 0.5 + 0.14 * scale;
  const segHalf = barHalf - barR;

  const inside = (px, py) => {
    const ddx = px - 0.5, ddy = py - dotY;
    if (ddx * ddx + ddy * ddy <= dotR * dotR) return true;
    const hx = Math.max(Math.abs(px - 0.5) - segHalf, 0);
    const by = py - barY;
    return hx * hx + by * by <= barR * barR;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inside((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)) cov++;
        }
      }
      const a = cov / (SS * SS);
      const o = (y * size + x) * 4;
      buf[o] = Math.round(BG[0] + (FG[0] - BG[0]) * a);
      buf[o + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * a);
      buf[o + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * a);
      buf[o + 3] = 255; // непрозрачная плитка
    }
  }
  return buf;
}

/* ── Варианты ──────────────────────────────────────────────── */

const VARIANTS = [
  ['icon-180.png', 180, 1.15],          // apple-touch: мотив крупнее
  ['icon-192.png', 192, 0.95],          // any
  ['icon-512.png', 512, 0.95],          // any
  ['icon-192-maskable.png', 192, 0.62], // мотив в центральной безопасной зоне ~66%
  ['icon-512-maskable.png', 512, 0.62]
];

for (const [name, size, scale] of VARIANTS) {
  const png = encodePNG(size, renderIcon(size, scale));
  writeFileSync(join(ROOT, name), png);
  console.log(`${name}: ${size}x${size}, ${png.length} байт`);
}
