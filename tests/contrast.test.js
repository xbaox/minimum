'use strict';
/* Контраст палитры: обе темы разбираются из styles.css, коэффициенты
   считаются по формуле WCAG relative luminance.

   Задача 23, п. 2: тест обходит ВСЮ палитру, а не список из семи имён.
   Каждая переменная :root обязана быть отнесена к корзине (BUCKETS);
   токена, которого в корзинах нет, тест не пропускает — добавить цвет,
   не приняв решения о его контрасте, больше нельзя. До этого новый
   токен с контрастом 1,001:1 проходил все двенадцать тестов молча.

   Сборки в проекте нет, поэтому CSS разбирается строкой — но не
   регулярками «до ближайшей скобки»: три известных режима деградации
   (вложенная скобка внутри :root, @media выше :root, переименование
   селектора) закрыты разбором со счётом скобок, см. cssRules(). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

/* ── Разбор CSS ───────────────────────────────────────────────
   Правила верхнего уровня со счётом скобок и вырезанными
   комментариями. At-правила с телом (@media, @supports) отдаются
   вместе со своим содержимым — их разбирают повторным вызовом.
   Порядок правил в файле на результат не влияет: ищем по селектору,
   а не по смещению, поэтому перенос @media выше :root безопасен. */
function stripComments(txt) {
  return txt.replace(/\/\*[\s\S]*?\*\//g, '');
}

function cssRules(txt) {
  const s = stripComments(txt);
  const out = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('{', i);
    if (open < 0) break;
    const selector = s.slice(i, open).trim();
    let depth = 0, j = open, close = -1;
    for (; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') { depth--; if (depth === 0) { close = j; break; } }
    }
    if (close < 0) break; // незакрытая скобка — дальше разбирать нечего
    out.push({ selector, body: s.slice(open + 1, close) });
    i = close + 1;
  }
  return out;
}

/* Объявления правила: имя свойства → значение (последнее выигрывает,
   как в каскаде). Вложенные блоки в теле игнорируются — на верхнем
   уровне :root их нет, а появись они, счётчик скобок уже не собьётся. */
function decls(body) {
  const out = {};
  let depth = 0, buf = '';
  const flush = () => {
    const k = buf.indexOf(':');
    if (k > 0) out[buf.slice(0, k).trim()] = buf.slice(k + 1).trim();
    buf = '';
  };
  for (const ch of body) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth === 0 && ch === ';') flush();
    else if (depth === 0) buf += ch;
  }
  flush();
  return out;
}

const TOP = cssRules(CSS);

/* Правило по точному селектору — из верхнего уровня. Не нашлось —
   падение с именем селектора: переименовали правило, из которого тест
   достаёт имя переменной, значит решение о контрасте потеряно (п. 2.5). */
function ruleBySelector(re, what) {
  const hit = TOP.filter(r => re.test(r.selector) && !r.selector.startsWith('@'));
  assert.ok(hit.length, `правило ${what} (${re}) не найдено в styles.css — ` +
    'если селектор переименован, поправь и тест: он держит решение о контрасте');
  return decls(hit[hit.length - 1].body);
}

/* Переменная из значения свойства: border: 1px solid var(--x) → 'x' */
function varOf(value, what) {
  const m = /var\(--([\w-]+)\)/.exec(value || '');
  assert.ok(m, `${what} задаётся не переменной, а значением: «${value}»`);
  return m[1];
}

/* ── Две темы ─────────────────────────────────────────────────
   Светлая — :root верхнего уровня; тёмная — :root внутри
   @media (prefers-color-scheme: dark), поверх светлой. */
function rootDecls(rules) {
  const hit = rules.filter(r => r.selector.split(',').map(s => s.trim()).includes(':root'));
  assert.ok(hit.length, ':root в разбираемом блоке найден');
  return Object.assign({}, ...hit.map(r => decls(r.body)));
}

const LIGHT_DECLS = rootDecls(TOP);
const darkAt = TOP.find(r => /^@media\b/.test(r.selector) && /prefers-color-scheme:\s*dark/.test(r.selector));
assert.ok(darkAt, 'тёмная тема присутствует');
const DARK_DECLS = Object.assign({}, LIGHT_DECLS, rootDecls(cssRules(darkAt.body)));

/* Только пользовательские свойства; служебные вроде color-scheme не в счёт */
function customProps(d) {
  const out = {};
  for (const [k, v] of Object.entries(d)) if (k.startsWith('--')) out[k.slice(2)] = v;
  return out;
}

const THEMES = { light: customProps(LIGHT_DECLS), dark: customProps(DARK_DECLS) };

/* ── Корзины (задача 23, п. 2.2) ──────────────────────────────
   Каждый токен :root обязан лежать ровно в одной. Отнесение — решение,
   а не наблюдение: его принимают руками и здесь же записывают.

   TEXT     — цвет текста, ≥4.5:1 к каждому перечисленному фону
   NONTEXT  — несущий смысл нецветной элемент (обводка, маркер), ≥3:1
   NEUTRAL  — фон, разделитель или нецветовой токен: порога нет,
              но решение принято явно, а не по умолчанию.

   Прежний мёртвый массив THRESHOLDS убран: он дублировал бы эти три
   таблицы третьим списком, ни разу не прочитанным (п. 2.4). */
const TEXT = {
  fg: ['bg', 'surface'],
  muted: ['bg', 'surface'],
  faint: ['bg', 'surface'],
  accent: ['bg', 'surface'],   // акцент несёт и текст («День закрыт»), и активность
  'on-accent': ['accent']      // текст primary-кнопки — на своём единственном фоне
};

const NONTEXT = {
  dot: ['bg', 'surface'],             // маркер пропуска
  'control-border': ['bg', 'surface'],// обводка чекбокса и пустой ячейки цепи
  chain: ['bg', 'surface']            // линия и обводка кругов блока
};

const NEUTRAL = {
  bg: 'фон экрана',
  surface: 'фон карточки',
  line: 'разделитель — тише текста намеренно',
  'line-strong': 'разделитель заметнее, но всё ещё не носитель смысла',
  'accent-weak': 'полупрозрачная заливка акцентом — фон, не носитель',
  tabbar: 'полупрозрачный фон таб-бара',
  'shadow-lift': 'тень (не цвет плоскости)',
  'shadow-knob': 'тень головки тумблера',
  radius: 'радиус', 'radius-md': 'радиус', 'radius-sm': 'радиус',
  'text-base': 'кегль', 'text-sm': 'кегль', 'text-xs': 'кегль',
  'gap-section': 'ритм', 'gap-block': 'ритм'
};

const BUCKETED = new Set([...Object.keys(TEXT), ...Object.keys(NONTEXT), ...Object.keys(NEUTRAL)]);

/* ── Контраст ─────────────────────────────────────────────── */
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

/* Цвет токена как #rrggbb — или null, если это не сплошной цвет
   (rgba, тень, длина). Корзина обязана совпадать с этим: измеримый
   цвет в NEUTRAL законен (фон), а вот TEXT/NONTEXT без цвета — нет. */
function hexOf(value) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(value).trim());
  if (m) return '#' + m[1];
  const s = /^#([0-9a-fA-F]{3})$/.exec(String(value).trim());
  return s ? '#' + [...s[1]].map(c => c + c).join('') : null;
}

/* ── п. 2.3: ни один токен не проходит мимо решения ────────── */
test('палитра: каждый токен :root отнесён к корзине', () => {
  for (const [theme, vars] of Object.entries(THEMES)) {
    for (const name of Object.keys(vars)) {
      assert.ok(BUCKETED.has(name),
        `новый токен --${name}: отнеси его к корзине в tests/contrast.test.js — ` +
        'TEXT (≥4.5:1), NONTEXT (≥3:1) или NEUTRAL (фон/служебный, порога нет). ' +
        `Тема ${theme}, значение ${vars[name]}.`);
    }
  }
});

test('палитра: корзины не описывают того, чего в :root нет', () => {
  // список корзин не должен ветшать вслед за удалённым токеном
  for (const name of BUCKETED) {
    assert.ok(name in THEMES.light || name in THEMES.dark,
      `--${name} есть в корзинах, но не в :root — убери из tests/contrast.test.js`);
  }
});

/* ── Пороги по корзинам ───────────────────────────────────── */
for (const [theme, vars] of Object.entries(THEMES)) {
  test(`контраст (${theme}): текстовые токены ≥4.5:1 на каждом своём фоне`, () => {
    for (const [name, bgs] of Object.entries(TEXT)) {
      const fg = hexOf(vars[name]);
      assert.ok(fg, `--${name} определён сплошным цветом в теме ${theme}`);
      for (const bgName of bgs) {
        const bg = hexOf(vars[bgName]);
        assert.ok(bg, `--${bgName} определён сплошным цветом в теме ${theme}`);
        const c = contrast(fg, bg);
        assert.ok(c >= 4.5,
          `--${name} ${fg} на --${bgName} ${bg} (${theme}): ${c.toFixed(2)}:1 < 4.5:1`);
      }
    }
  });

  test(`контраст (${theme}): нетекстовые токены ≥3:1 на каждом своём фоне`, () => {
    for (const [name, bgs] of Object.entries(NONTEXT)) {
      const fg = hexOf(vars[name]);
      assert.ok(fg, `--${name} определён сплошным цветом в теме ${theme}`);
      for (const bgName of bgs) {
        const bg = hexOf(vars[bgName]);
        const c = contrast(fg, bg);
        assert.ok(c >= 3,
          `--${name} ${fg} на --${bgName} ${bg} (${theme}): ${c.toFixed(2)}:1 < 3:1`);
      }
    }
  });

  test(`контраст (${theme}): тихая иерархия вторичного текста на обоих фонах`, () => {
    for (const bgName of ['bg', 'surface']) {
      const bg = hexOf(vars[bgName]);
      assert.ok(contrast(hexOf(vars.fg), bg) > contrast(hexOf(vars.muted), bg),
        `fg заметнее muted на --${bgName}`);
      assert.ok(contrast(hexOf(vars.muted), bg) >= contrast(hexOf(vars.faint), bg),
        `muted не тише faint на --${bgName}`);
    }
  });
}

/* ── Привязки правил к переменным ─────────────────────────────
   Правила, обязанные брать цвет из контрастной переменной: трек
   выключенного тумблера, рамка полей форм, рамка инпута карточки
   повышения и обводка пустой ячейки цепи. Имя переменной достаётся
   из самого правила — так проверяется то, что видно на экране, а не
   намерение. Селектор переименован — тест падает с именем селектора
   (ruleBySelector), а не молча берёт undefined (п. 2.5). */
const BOUND = [
  { re: /^\.switch span$/, prop: 'background', what: 'трек тумблера' },
  { re: /(^|,\s*)\.field input\b/, prop: 'border', what: 'рамка поля формы' },
  { re: /(^|,\s*)\.raise-line \.num\b/, prop: 'border', what: 'рамка инпута карточки повышения' },
  { re: /^\.cdays i$/, prop: 'border-color', what: 'обводка пустой ячейки цепи' }
];

test('контраст: правила берут цвет из переменных, а не из значений', () => {
  for (const b of BOUND) {
    const d = ruleBySelector(b.re, b.what);
    const name = varOf(d[b.prop], `${b.what} (${b.prop})`);
    assert.ok(name in NONTEXT || name in TEXT,
      `${b.what} взял --${name} из корзины без порога — это несущий элемент`);
  }
  // select в .field — под тем же правилом рамки, что и input
  const fieldRule = TOP.find(r => /(^|,\s*)\.field input\b/.test(r.selector) && /border:/.test(r.body));
  assert.match(fieldRule.selector, /\.field select/, 'рамка .field select задаётся тем же правилом');
  // обводка пустой ячейки — не тон разделителей (задача 19, B.4.2: --line давал 1,17:1)
  assert.notEqual(varOf(ruleBySelector(/^\.cdays i$/, 'ячейка цепи')['border-color'], 'ячейка'), 'line',
    'обводка пустой ячейки не должна быть тоном разделителей');
});

/* Задача 16, фаза A: тон цепочки поярче прежнего в обеих темах. Прежние
   значения зафиксированы здесь же — тест ловит откат к ним и требует, чтобы
   новый тон был светлее; порог ≥3:1 проверяется корзиной NONTEXT. */
const CHAIN_WAS = { light: '#9c5a44', dark: '#d29684' };

test('цепочка: тон отличается от прежнего и светлее его в обеих темах', () => {
  for (const [theme, vars] of Object.entries(THEMES)) {
    const was = CHAIN_WAS[theme];
    const now = hexOf(vars.chain);
    assert.ok(now, `--chain определён в теме ${theme}`);
    assert.notEqual(now.toLowerCase(), was, `--chain в теме ${theme} остался прежним`);
    assert.ok(luminance(now) > luminance(was),
      `--chain ${now} не светлее прежнего ${was} (тема ${theme})`);
  }
});

/* Задача 22, п. 7.6: 250 мс удержания до захвата успевают вызвать на iOS
   системную лупу и выделение текста — и перетаскивание срывается ещё до
   старта. Правило обязано стоять на самой строке постоянно, а не в
   body.dragging: к моменту, когда класс появится, звать уже поздно. */
test('перетаскивание: лупа и выделение сняты со строки постоянно, не только при захвате', () => {
  const rule = ruleBySelector(/^\.drag-row$/, 'строка перетаскивания');
  assert.equal(rule['-webkit-touch-callout'], 'none');
  assert.equal(rule['-webkit-user-select'], 'none');
  assert.equal(rule['user-select'], 'none');

  // поля открытой формы — исключение: в них выделение нужно
  const inputs = ruleBySelector(/^\.drag-row input, \.drag-row textarea$/, 'поля внутри строки');
  assert.equal(inputs['user-select'], 'auto');
});
