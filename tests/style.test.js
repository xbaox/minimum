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

const lum = hex => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('в CSS нет text-overflow: ellipsis — тексты владельца не обрезаются', () => {
  assert.doesNotMatch(CSS, /text-overflow\s*:\s*ellipsis/i);
  assert.doesNotMatch(CSS, /line-clamp/i);
  for (const f of ['app.js', 'index.html']) assert.doesNotMatch(readFileSync(new URL('../' + f, import.meta.url), 'utf8'), /ellipsis/i);
});

test('текст ≥ 4.5:1 на фоне и поверхности в обеих темах', () => {
  for (const [name, t] of [['светлая', light], ['тёмная', dark]]) {
    for (const fg of ['text', 'text-2', 'accent', 'danger'])
      for (const bg of ['bg', 'surface']) {
        const r = contrast(t[fg], t[bg]);
        assert.ok(r >= 4.5, `${name}: ${fg} на ${bg} = ${r.toFixed(2)}`);
      }
    assert.ok(contrast(t['on-accent'], t.accent) >= 4.5, `${name}: on-accent`);
    assert.ok(contrast(t.bg, t.text) >= 4.5, `${name}: инверсная полоса`);
  }
});

test('галочка на заливке пункта — белая или почти чёрная, контраст ≥ 3:1', () => {
  for (const t of [light, dark])
    for (const c of COLORS) {
      assert.ok(t['c-' + c] && t['on-' + c], 'нет токена ' + c);
      assert.ok(['#FFFFFF', '#11141A'].includes(t['on-' + c].toUpperCase()), c);
      const r = contrast(t['c-' + c], t['on-' + c]);
      assert.ok(r >= 3, `${c}: ${r.toFixed(2)}`);
    }
});

test('вне :root нет сырых цветов, px и длительностей', () => {
  const rules = noComments.replace(/:root\s*\{[\s\S]*?\n\s*\}/g, '');
  const raw = rules.match(/#[0-9a-f]{3,8}\b|\b\d*\.?\d+(px|ms|s|rem|em)\b|rgba?\(|hsla?\(/gi);
  assert.equal(raw, null, 'сырые значения: ' + raw);
});

test('поля ввода ≥ 16 px, цели касания ≥ 44 px, строки ≥ 56 px', () => {
  assert.ok(parseInt(light['fs-3']) >= 16);
  assert.ok(parseInt(light.tap) >= 44);
  assert.ok(parseInt(light['row-h']) >= 56);
  assert.match(CSS, /\.input\s*\{[^}]*font-size:\s*var\(--fs-3\)/);
  assert.match(CSS, /\.row\s*\{[^}]*min-height:\s*var\(--row-h\)/);
});
