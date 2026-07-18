'use strict';
/* Контраст палитры: обе темы парсятся из styles.css, коэффициенты
   считаются по формуле WCAG relative luminance. Пороги задачи 5:
   --muted ≥4.5, --faint ≥4.5, --dot ≥3, --control-border ≥3 — против --bg своей темы. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

function parseVars(txt) {
  const vars = {};
  for (const [, name, hex] of txt.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    if (!(name in vars)) vars[name] = hex;
  }
  return vars;
}

const darkIdx = CSS.indexOf('@media (prefers-color-scheme: dark)');
assert.ok(darkIdx > 0, 'тёмная тема присутствует');
const darkEnd = CSS.indexOf('}', CSS.indexOf('}', darkIdx) + 1); // конец :root, затем конец @media
const THEMES = {
  light: parseVars(CSS.slice(0, darkIdx)),
  dark: parseVars(CSS.slice(darkIdx, darkEnd + 1))
};

function luminance(hex) {
  const c = [1, 3, 5].map(i => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const THRESHOLDS = [
  ['muted', 4.5],
  ['faint', 4.5],
  ['dot', 3],
  ['control-border', 3]
];

/* Правила, обязанные использовать контрастную переменную: трек выключенного
   тумблера и рамка полей форм. Имя переменной извлекается из правила —
   контраст проверяется по ней в обеих темах. */
const SWITCH_VAR = (CSS.match(/\.switch span\s*\{[^}]*background:\s*var\(--([\w-]+)\)/) || [])[1];
const FIELD_VAR = (CSS.match(/\.field input[^{]*\{[^}]*border:\s*1px solid var\(--([\w-]+)\)/) || [])[1];

test('контраст: трек тумблера и рамка поля привязаны к переменным', () => {
  assert.ok(SWITCH_VAR, 'у .switch span фон из переменной');
  assert.ok(FIELD_VAR, 'у .field input рамка из переменной');
  // select в .field — под тем же правилом рамки, что и input
  const fieldSelectors = (CSS.match(/([^{}]*\.field input[^{]*)\{[^}]*border:\s*1px solid var\(/) || [])[1] || '';
  assert.match(fieldSelectors, /\.field select/, 'рамка .field select задаётся тем же правилом');
});

for (const [theme, vars] of Object.entries(THEMES)) {
  test(`контраст (${theme}): трек тумблера и рамка поля ≥3 против --bg`, () => {
    for (const name of [SWITCH_VAR, FIELD_VAR]) {
      assert.ok(vars[name], `--${name} определён в теме ${theme}`);
      const c = contrast(vars[name], vars.bg);
      assert.ok(c >= 3, `--${name} ${vars[name]} на ${vars.bg}: ${c.toFixed(2)}:1 < 3:1`);
    }
  });
}

for (const [theme, vars] of Object.entries(THEMES)) {
  test(`контраст (${theme}): muted/faint ≥4.5, dot/control-border ≥3 против --bg`, () => {
    assert.ok(vars.bg, '--bg определён');
    for (const [name, min] of THRESHOLDS) {
      assert.ok(vars[name], `--${name} определён в теме ${theme}`);
      const c = contrast(vars[name], vars.bg);
      assert.ok(c >= min, `--${name} ${vars[name]} на ${vars.bg}: ${c.toFixed(2)}:1 < ${min}:1`);
    }
    // тихая иерархия по светлоте сохранена: fg контрастнее muted, muted не тише faint
    assert.ok(contrast(vars.fg, vars.bg) > contrast(vars.muted, vars.bg), 'fg заметнее muted');
    assert.ok(contrast(vars.muted, vars.bg) >= contrast(vars.faint, vars.bg), 'muted не тише faint');
  });
}
