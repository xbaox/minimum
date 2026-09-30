process.env.TZ = 'America/Toronto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COLORS } from '../domain.js';

const CSS = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const noComments = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const tokens = block => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
const light = tokens(noComments.match(/^:root\s*\{([\s\S]*?)\n\}/m)[1]);
const dark = { ...light, ...tokens(noComments.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([\s\S]*?)\}/)[1]) };
const themes = [['светлая', light], ['тёмная', dark]];

const lum = hex => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const mix = (a, b, t) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('');
const need = (t, fg, bg, min, name) => {
  const r = contrast(t[fg] ?? fg, t[bg] ?? bg);
  assert.ok(r >= min, `${name}: ${fg} на ${bg} = ${r.toFixed(2)} < ${min}`);
};

test('в CSS нет text-overflow: ellipsis — тексты владельца не обрезаются', () => {
  assert.doesNotMatch(CSS, /text-overflow\s*:\s*ellipsis/i);
  assert.doesNotMatch(CSS, /line-clamp/i);
  for (const f of ['app.js', 'index.html']) assert.doesNotMatch(readFileSync(new URL('../' + f, import.meta.url), 'utf8'), /ellipsis/i);
});

test('текст ≥ 4.5:1 в обеих темах: экран, листы, плашки', () => {
  for (const [name, t] of themes) {
    for (const fg of ['text', 'text-2', 'accent', 'danger', 'sleep']) for (const bg of ['bg', 'cell']) need(t, fg, bg, 4.5, name);
    need(t, 'accent-soft', 'cell', 4.5, name);
    need(t, 'train-text', 'cell', 4.5, name); // «✓ 2 из 3» у недельного счётчика
    need(t, 'text-2-hero', 'cell', 4.5, name);
    for (const fg of ['text', 'text-2-sheet', 'danger-sheet']) for (const bg of ['sheet', 'cell-2']) need(t, fg, bg, 4.5, name);
    need(t, 'accent', 'sheet', 4.5, name);
    need(t, 'text', 'fill', 4.5, name);
    need(t, 'text', 'fill-2', 4.5, name);
    need(t, 'pill-text', 'pill-bg', 4.5, name);
    need(t, 'strip-text-2', 'strip-bg', 4.5, name);
    need(t, 'bar-text', 'bar-bg', 4.5, name);
    need(t, 'text', 'alert-bg', 4.5, name);
    need(t, 'accent', 'alert-bg', 4.5, name);
    need(t, 'danger-sheet', 'alert-bg', 4.5, name);
    need(t, 'accent', 'tab-line', 1, name); // токен существует
  }
});

test('белый текст на градиентах: кнопка и выбранный чип', () => {
  const t = light;
  const w = '#FFFFFF';
  assert.equal(t['on-grad'].toUpperCase(), w);
  // кнопка «Закрыть неделю»: текст в середине, края — не хуже 4:1
  need(t, w, 'btn-2', 4.5, 'кнопка');
  for (const x of [0.3, 0.7]) need(t, w, x < 0.5 ? mix(t['btn-1'], t['btn-2'], x / 0.5) : mix(t['btn-2'], t['btn-3'], (x - 0.5) / 0.5), 4.5, 'кнопка ' + x);
  need(t, w, 'btn-1', 4, 'кнопка, край');
  need(t, w, 'btn-3', 4, 'кнопка, край');
  // выбранный чип времени: цифры по центру
  need(t, w, mix(t['sel-1'], t['sel-2'], 0.5), 4.5, 'чип');
  need(t, w, 'sel-2', 4, 'чип, край');
});

test('значки: белый на плитке каждого цвета ≥ 3:1, галочка на градиенте ≥ 3:1', () => {
  for (const [name, t] of themes) {
    assert.equal(t['on-tile'].toUpperCase(), '#FFFFFF');
    for (const c of COLORS) {
      assert.ok(t['c-' + c] && t['b-' + c], `${name}: нет токенов ${c}`);
      need(t, 'on-tile', 'c-' + c, 3, name + ' ' + c);
    }
    for (const k of ['check-1', 'check-2', 'check-3']) need(t, 'on-grad', k, 3, name + ' ' + k);
    need(t, 'ring', 'cell', 3, name + ' пустой кружок');
  }
  assert.equal(COLORS.length, 12);
});

test('вне :root нет сырых цветов, px и длительностей', () => {
  const rules = noComments.replace(/:root\s*\{[\s\S]*?\n\s*\}/g, '');
  const raw = rules.match(/#[0-9a-f]{3,8}\b|\b\d*\.?\d+(px|ms|s|rem|em)\b|rgba?\(|hsla?\(/gi);
  assert.equal(raw, null, 'сырые значения: ' + raw);
});

test('поля ввода ≥ 16 px, цели касания ≥ 44 px, строки ≥ 56 px', () => {
  assert.ok(parseInt(light['fs-body']) >= 16);
  assert.ok(parseInt(light.tap) >= 44);
  assert.ok(parseInt(light['row-h']) >= 56);
  assert.ok(parseInt(light['row-s']) >= 44 && parseInt(light['row-t']) >= 44 && parseInt(light['row-m']) >= 44);
  assert.ok(parseInt(light['chip-h']) + 2 * parseInt(light.u4) >= 44, 'чип с невидимой зоной касания');
  for (const cls of ['form-input', 'area', 'one-input', 'chip-input', 'time-input'])
    assert.match(CSS, new RegExp(`\\.${cls}\\s*\\{[^}]*font-size:\\s*var\\(--fs-body\\)`), cls);
  assert.match(CSS, /\.row\s*\{[^}]*min-height:\s*var\(--row-h\)/);
  assert.match(CSS, /\.chip::after\s*\{[^}]*inset:/);
});
