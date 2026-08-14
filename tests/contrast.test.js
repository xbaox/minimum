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
  ['chain', 3],    // линия цепочки — нетекстовый элемент, ≥3 в обеих темах (задача 15)
  ['dot', 3],
  ['control-border', 3]
];

/* Правила, обязанные использовать контрастную переменную: трек выключенного
   тумблера, рамка полей форм и рамка инпута карточки повышения. Имя
   переменной извлекается из правила — контраст проверяется по ней в обеих
   темах против --bg и против --surface (поля лежат и на карточках). */
const SWITCH_VAR = (CSS.match(/\.switch span\s*\{[^}]*background:\s*var\(--([\w-]+)\)/) || [])[1];
const FIELD_VAR = (CSS.match(/\.field input[^{]*\{[^}]*border:\s*1px solid var\(--([\w-]+)\)/) || [])[1];
/* [^{]* вместо \s*: правило поля числа стало списком селекторов —
   его делят карточка повышения и строка упражнения (задача 16D) */
const RAISE_VAR = (CSS.match(/\.raise-line \.num[^{]*\{[^}]*border:\s*1px solid var\(--([\w-]+)\)/) || [])[1];

test('контраст: трек тумблера, рамка поля и raise-инпут привязаны к переменным', () => {
  assert.ok(SWITCH_VAR, 'у .switch span фон из переменной');
  assert.ok(FIELD_VAR, 'у .field input рамка из переменной');
  assert.ok(RAISE_VAR, 'у .raise-line .num рамка из переменной');
  // select в .field — под тем же правилом рамки, что и input
  const fieldSelectors = (CSS.match(/([^{}]*\.field input[^{]*)\{[^}]*border:\s*1px solid var\(/) || [])[1] || '';
  assert.match(fieldSelectors, /\.field select/, 'рамка .field select задаётся тем же правилом');
});

for (const [theme, vars] of Object.entries(THEMES)) {
  test(`контраст (${theme}): контролы ≥3 против --bg и против --surface`, () => {
    for (const name of [SWITCH_VAR, FIELD_VAR, RAISE_VAR]) {
      assert.ok(vars[name], `--${name} определён в теме ${theme}`);
      for (const bgName of ['bg', 'surface']) {
        assert.ok(vars[bgName], `--${bgName} определён в теме ${theme}`);
        const c = contrast(vars[name], vars[bgName]);
        assert.ok(c >= 3, `--${name} ${vars[name]} на --${bgName} ${vars[bgName]}: ${c.toFixed(2)}:1 < 3:1`);
      }
    }
  });
}

/* Задача 16, фаза A: тон цепочки поярче прежнего в обеих темах. Прежние
   значения зафиксированы здесь же — тест ловит откат к ним и требует, чтобы
   новый тон был светлее (в тёмной теме — ярче на фоне, в светлой — насыщеннее
   и светлее прежнего); порог ≥3:1 проверяется ниже общим списком. */
const CHAIN_WAS = { light: '#9c5a44', dark: '#d29684' };

test('цепочка: тон отличается от прежнего и светлее его в обеих темах', () => {
  for (const [theme, vars] of Object.entries(THEMES)) {
    const was = CHAIN_WAS[theme];
    assert.ok(vars.chain, `--chain определён в теме ${theme}`);
    assert.notEqual(vars.chain.toLowerCase(), was, `--chain в теме ${theme} остался прежним`);
    assert.ok(luminance(vars.chain) > luminance(was),
      `--chain ${vars.chain} не светлее прежнего ${was} (тема ${theme})`);
  }
});

/* Задача 19, B.4.3: мерить ОБА фона.
   До этого текстовые токены проверялись только против --bg. Карточки
   .pcard на --surface появились в задаче 17 и в покрытие не попали —
   через эту дыру и прошёл --faint 4,36:1 в тёмной теме (аудит, находка 9).
   Фон у текста в приложении ровно два: --bg (экран) и --surface
   (карточки «Прогресса», заметок, форм), поэтому меряем против обоих. */
const BACKGROUNDS = ['bg', 'surface'];
const TEXT_TOKENS = ['fg', 'muted', 'faint', 'accent'];      // порог 4.5:1
const NONTEXT_TOKENS = ['dot', 'control-border', 'chain'];   // порог 3:1

for (const [theme, vars] of Object.entries(THEMES)) {
  test(`контраст (${theme}): текстовые токены ≥4.5 против --bg И против --surface`, () => {
    for (const bgName of BACKGROUNDS) assert.ok(vars[bgName], `--${bgName} определён в теме ${theme}`);
    for (const name of TEXT_TOKENS) {
      assert.ok(vars[name], `--${name} определён в теме ${theme}`);
      for (const bgName of BACKGROUNDS) {
        const c = contrast(vars[name], vars[bgName]);
        assert.ok(c >= 4.5,
          `--${name} ${vars[name]} на --${bgName} ${vars[bgName]} (${theme}): ${c.toFixed(2)}:1 < 4.5:1`);
      }
    }
    // текст на акценте — третий фон, он же единственный у primary-кнопки
    const onAcc = contrast(vars['on-accent'], vars.accent);
    assert.ok(onAcc >= 4.5, `--on-accent на --accent (${theme}): ${onAcc.toFixed(2)}:1 < 4.5:1`);
  });

  test(`контраст (${theme}): нетекстовые токены ≥3 против --bg И против --surface`, () => {
    for (const name of NONTEXT_TOKENS) {
      assert.ok(vars[name], `--${name} определён в теме ${theme}`);
      for (const bgName of BACKGROUNDS) {
        const c = contrast(vars[name], vars[bgName]);
        assert.ok(c >= 3,
          `--${name} ${vars[name]} на --${bgName} ${vars[bgName]} (${theme}): ${c.toFixed(2)}:1 < 3:1`);
      }
    }
  });

  test(`контраст (${theme}): тихая иерархия вторичного текста на обоих фонах`, () => {
    for (const bgName of BACKGROUNDS) {
      assert.ok(contrast(vars.fg, vars[bgName]) > contrast(vars.muted, vars[bgName]),
        `fg заметнее muted на --${bgName}`);
      assert.ok(contrast(vars.muted, vars[bgName]) >= contrast(vars.faint, vars[bgName]),
        `muted не тише faint на --${bgName}`);
    }
  });
}

/* Пустая ячейка «Цепи дней» отличается от неотрисованной только обводкой —
   это несущий информацию нетекстовый элемент, а не разделитель, и порог
   3:1 к нему применим (задача 19, B.4.2; --line давал 1,17:1). */
test('цепь дней: обводка пустой ячейки — контрастная переменная, ≥3:1 на обоих фонах', () => {
  const v = (CSS.match(/\.cdays i\s*\{[^}]*border-color:\s*var\(--([\w-]+)\)/) || [])[1];
  assert.ok(v, 'обводка .cdays i задаётся переменной');
  assert.notEqual(v, 'line', 'обводка пустой ячейки не должна быть тоном разделителей');
  for (const [theme, vars] of Object.entries(THEMES)) {
    for (const bgName of BACKGROUNDS) {
      const c = contrast(vars[v], vars[bgName]);
      assert.ok(c >= 3, `--${v} на --${bgName} (${theme}): ${c.toFixed(2)}:1 < 3:1`);
    }
  }
});
