'use strict';
/* Интерфейсный уровень тестов: рендер и взаимодействие в jsdom.
   app.js исполняется через vm в контексте window (см. CLAUDE.md, «Тесты»):
   в контексте jsdom нет module, поэтому ветка module.exports не срабатывает
   и app.js идёт по браузерному пути. К моменту запуска кода DOMContentLoaded
   в jsdom уже отстрелял, так что init() вызывается вручную ровно один раз. */

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const NS = 'minimum:data';
/* Текущая версия схемы — из самого app.js: утверждения о том, что migrate
   прогнан, не должны переписываться при каждом подъёме схемы */
const SCHEMA_VERSION = +(APP.match(/const SCHEMA_VERSION = (\d+)/) || [])[1];

/* Логический ключ дня — та же формула, что в app.js (граница 04:00) */
function dayKey(date) {
  const d = new Date(date.getTime() - 4 * 3600000);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function daysAgo(n) {
  return dayKey(new Date(Date.now() - n * 86400000));
}

/* Календарная арифметика ключей — та же, что keyToDate/addDays в app.js */
function addKey(k, n) {
  const [y, m, d] = k.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n, 12);
  const p = x => String(x).padStart(2, '0');
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}
function mondayOf(k) {
  const [y, m, d] = k.split('-').map(Number);
  return addKey(k, -((new Date(y, m - 1, d, 12).getDay() + 6) % 7));
}
const curMonday = () => mondayOf(daysAgo(0));
const prevMonday = () => addKey(curMonday(), -7);

/* Отметить пункт в первых n днях календарной недели с понедельником mon */
function fillWeek(days, id, mon, n) {
  for (let i = 0; i < n; i++) {
    const k = addKey(mon, i);
    (days[k] || (days[k] = {}))[id] = true;
  }
  return days;
}

/* ── Константы времени этих тестов (задача 23, п. 1.3) ───────
   app.js читает их из globalThis.MINIMUM_TIMING при загрузке (см.
   timing() в app.js). Здесь они укорочены: 62% прогона уходило в
   фиксированные паузы, и новый DOM-тест обходился дороже, чем стоил.
   Рантайм приложения при этом не меняется ни на миллисекунду — значения
   по умолчанию проверяет отдельный тест домена, который эти подмены
   не видит вовсе (TIMING_DEFAULTS).

   Осторожно с порядком величин: MOTION_MS и DRAG_HOLD должны оставаться
   заметно больше нуля, иначе ожидание «дольше таймаута» перестанет
   отличаться от «сразу» и тест начнёт проходить по случайности. */
const T = {
  MIRROR_PROBE_MS: 50,
  MIRROR_FLUSH_MS: 30,
  DAY_TIMER_SLACK_MS: 5,
  MOTION_MS: 20,
  MOTION_TAIL_MS: 10,
  FLASH_MS: 100,
  DRAG_HOLD: 30,
  DRAG_CLICK_MS: 30
};

/* Уход карточки разбора отложен (motionLeave: класс-триггер + перерисовка
   по fallback-таймауту MOTION_MS + MOTION_TAIL_MS, т.к. jsdom не шлёт
   transitionend). Ждём заведомо дольше таймаута, чтобы дождаться перерисовки. */
const wait = ms => new Promise(r => setTimeout(r, ms));
const settle = () => wait(T.MOTION_MS + T.MOTION_TAIL_MS + 40);

/* app.js взводит таймер границы дня — окна нужно закрывать, иначе
   процесс node --test не завершится из-за живого setTimeout */
const doms = [];
after(() => { for (const d of doms) d.window.close(); });

async function boot({ seed, raw, idb, timing } = {}) {
  const dom = new JSDOM(HTML, {
    url: 'https://example.org/minimum/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  doms.push(dom);
  const { window } = dom;
  if (window.document.readyState !== 'complete') {
    await new Promise(res => window.addEventListener('load', res));
  }
  window.scrollTo = () => {}; // в jsdom не реализовано — глушим шум
  // exportJSON зовёт URL.createObjectURL, которого в jsdom нет: без заглушки
  // клик по «Экспорт» роняет необработанное исключение в окно, и раннер
  // приписывает его тому тесту, который в этот момент идёт, — не тому, что
  // его породил. Заглушка стоит в boot, чтобы это было верно для всех окон.
  window.URL.createObjectURL = () => 'blob:fake';
  window.URL.revokeObjectURL = () => {};
  if (idb) window.indexedDB = idb; // fake-indexeddb: app.js увидит его через window
  if (raw != null) window.localStorage.setItem(NS, raw);
  else if (seed) window.localStorage.setItem(NS, JSON.stringify(seed));
  // константы времени — ДО исполнения app.js: он читает их один раз при
  // загрузке. Правки самого app.js для подмены не требуется (задача 23, п. 1.2)
  window.MINIMUM_TIMING = Object.assign({}, T, timing);
  vm.runInContext(APP, dom.getInternalVMContext());
  assert.equal(typeof window.init, 'function', 'app.js должен определить init() в window');
  await window.init(); // init асинхронный: стартовая проверка зеркала (инвариант 9)
  return { window, document: window.document };
}

/* Сдвиг «сейчас» внутри jsdom-окна: app.js берёт Date из контекста window */
function shiftWindowDate(window, ms) {
  const Real = window.Date;
  window.Date = class extends Real {
    constructor(...args) {
      if (args.length) super(...args);
      else super(Real.now() + ms);
    }
    static now() { return Real.now() + ms; }
  };
}

/* Прямая работа со снапшотом зеркала в fake-IDBFactory (формат app.js) */
function idbPut(idb, value) {
  return new Promise((resolve, reject) => {
    const req = idb.open('minimum', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('mirror');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('mirror', 'readwrite');
      tx.objectStore('mirror').put(value, 'snapshot');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

function idbGet(idb) {
  return new Promise((resolve, reject) => {
    const req = idb.open('minimum', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('mirror');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('mirror', 'readonly');
      const g = tx.objectStore('mirror').get('snapshot');
      g.onsuccess = () => { db.close(); resolve(g.result || null); };
      g.onerror = () => { db.close(); reject(g.error); };
    };
    req.onerror = () => reject(req.error);
  });
}

/* Узнаваемый store для снапшота зеркала */
function mirrorStore() {
  return {
    schemaVersion: 4,
    items: [{
      id: 'r1', name: 'Восстановленный', value: 5, unit: 'повт.', type: 'daily',
      goal: null, note: '', group: '', active: true, addedAt: daysAgo(10), raiseAfter: 0,
      history: [{ date: daysAgo(10), value: 5 }]
    }],
    days: { [daysAgo(1)]: { r1: true } },
    weekLog: [], reviews: [], pendingRaises: [],
    draftOneChange: '', weekStart: daysAgo(2),
    settings: { dayBoundary: 4, hintShownForItemId: null, exportedAt: null, habitSeeded: true }
  };
}

/* Разбор ушёл с таб-бара (задача 16, фаза B): лист открывается баннером
   «Доступен разбор недели» с «Сегодня» либо строкой с «Прогресса».
   Хелпер повторяет путь пользователя — сначала на «Сегодня», затем тап
   по баннеру; если баннера нет, разбор не назрел и тест это увидит. */
function openReview(document) {
  document.querySelector('#tabs button[data-tab="today"]').click();
  const banner = document.querySelector('#scr-today [data-act="goto-review"]');
  assert.ok(banner, 'баннер разбора на «Сегодня»');
  banner.click();
  assert.equal(document.getElementById('scr-review').hidden, false, 'лист разбора открыт');
}

/* Минимальный валидный store с назревшим разбором: календарная эпоха в
   прошлом, две отметки в последней завершённой неделе; migrate достроит */
function dueSeed() {
  const prev = prevMonday();
  return {
    schemaVersion: 5,
    items: [{
      id: 'it1', name: 'Тестовый пункт', value: 10, unit: 'мин', type: 'daily',
      goal: null, note: '', group: '', active: true,
      addedAt: addKey(prev, -14), raiseAfter: 0, history: [{ date: addKey(prev, -14), value: 10 }]
    }],
    days: { [addKey(prev, 1)]: { it1: true }, [addKey(prev, 3)]: { it1: true } },
    weekLog: [], reviews: [], pendingRaises: [],
    draftOneChange: '', weekStart: prev, // историческое поле скользящей эпохи
    settings: { dayBoundary: 4, hintShownForItemId: null, exportedAt: null, calendarSince: addKey(prev, -14) }
  };
}

test('init() отрабатывает: экран «Сегодня» отрисован, остальные скрыты', async () => {
  const { document } = await boot();
  const today = document.getElementById('scr-today');
  assert.equal(today.hidden, false);
  assert.ok(today.innerHTML.length > 0);
  assert.equal(today.querySelectorAll('input[data-act="mark"]').length, 6); // 6 дневных пунктов минимума
  assert.ok(today.querySelector('.weekcount'));                            // недельный счётчик
  assert.match(today.textContent, /Минимум выполняется даже в худший день/);
  for (const id of ['scr-habits', 'scr-progress', 'scr-notes', 'scr-settings', 'scr-review', 'scr-detail']) {
    assert.equal(document.getElementById(id).hidden, true, id);
  }
});

test('вкладки переключают все 5 экранов, каждый рендерится без исключений', async () => {
  const { document } = await boot();
  const tabs = [...document.querySelectorAll('#tabs button')];
  assert.equal(tabs.length, 5);
  // задача 16B: «Разбор» и «Система» ушли с панели, пришли «Прогресс» и «Заметки»
  assert.deepEqual(tabs.map(b => b.dataset.tab), ['today', 'habits', 'progress', 'notes', 'settings']);
  assert.deepEqual(tabs.map(b => b.textContent),
    ['Сегодня', 'Привычки', 'Прогресс', 'Заметки', 'Настройки']);
  const map = {
    today: 'scr-today', habits: 'scr-habits', progress: 'scr-progress',
    notes: 'scr-notes', settings: 'scr-settings'
  };
  const marker = {
    today: /Минимум выполняется/,
    habits: /Не спеши — доверься накопительному эффекту/,
    progress: /В системе/,
    notes: /Новая выписка/,
    settings: /Граница дня/
  };
  for (const b of tabs) {
    b.click();
    const scr = document.getElementById(map[b.dataset.tab]);
    assert.equal(scr.hidden, false, b.dataset.tab);
    assert.match(scr.textContent, marker[b.dataset.tab]);
    assert.equal(b.getAttribute('aria-current'), 'page');
    for (const [tab, sid] of Object.entries(map)) {
      if (tab !== b.dataset.tab) assert.equal(document.getElementById(sid).hidden, true, sid);
    }
    // листы разбора и детали живут поверх вкладок и сейчас закрыты
    assert.equal(document.getElementById('scr-review').hidden, true);
    assert.equal(document.getElementById('scr-detail').hidden, true);
  }
});

test('тап по чекбоксу отмечает пункт, обновляет прогресс и localStorage', async () => {
  const { document, window } = await boot();
  assert.match(document.querySelector('.bar-note').textContent, /0\s*из\s*6/);

  const cb = document.querySelector('input[data-act="mark"]');
  const id = cb.dataset.id;
  cb.click(); // change всплывает до document, экран перерисовывается

  const again = document.querySelector(`input[data-act="mark"][data-id="${id}"]`);
  assert.ok(again);
  assert.equal(again.checked, true);
  assert.match(document.querySelector('.bar-note').textContent, /1\s*из\s*6/);
  assert.match(document.querySelector('.bar i').getAttribute('style'), /width:\s*17%/);

  const saved = JSON.parse(window.localStorage.getItem(NS));
  const marks = Object.values(saved.days)[0];
  assert.equal(marks[id], true);

  again.click(); // повторный тап снимает отметку
  assert.match(document.querySelector('.bar-note').textContent, /0\s*из\s*6/);
  const saved2 = JSON.parse(window.localStorage.getItem(NS));
  assert.deepEqual(saved2.days, {});
});

test('формы редактирования и добавления открываются и закрываются', async () => {
  const { document } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();

  // редактирование первого пункта
  const editBtn = document.querySelector('[data-act="edit-open"]');
  const itemName = editBtn.querySelector('.tname').textContent;
  editBtn.click();
  const eName = document.getElementById('e-name');
  assert.ok(eName, 'форма редактирования открылась');
  assert.equal(eName.value, itemName);
  document.querySelector('[data-act="edit-cancel"]').click();
  assert.equal(document.getElementById('e-name'), null);

  // добавление
  document.querySelector('[data-act="add-open"]').click();
  assert.ok(document.getElementById('f-name'), 'форма добавления открылась');
  assert.ok(document.getElementById('f-type'));
  document.querySelector('[data-act="add-cancel"]').click();
  assert.equal(document.getElementById('f-name'), null);
});

test('назревший разбор: баннер на «Сегодня», сетка недели, закрытие недели', async () => {
  const { document, window } = await boot({ seed: dueSeed() });

  // баннер на главном экране
  const banner = document.querySelector('[data-act="goto-review"]');
  assert.ok(banner, 'баннер «Доступен разбор недели» показан');
  banner.click();
  assert.equal(document.getElementById('scr-review').hidden, false);

  // сетка 7 дней, подписи Пн…Вс, диапазон недели и кнопка закрытия
  assert.ok(document.querySelector('.grid'));
  assert.equal(document.querySelectorAll('.grid i').length, 7); // один пункт × 7 дней
  const heads = [...document.querySelectorAll('.g-head')].map(x => x.textContent).join(' ');
  assert.match(heads, /Пн Вт Ср Чт Пт Сб Вс/);
  assert.match(document.getElementById('scr-review').textContent, /Неделя /);
  const closeBtn = document.querySelector('[data-act="close-week"]');
  assert.ok(closeBtn);

  closeWeekThroughUi(document); // вторым тапом (задача 28.B, п. 6)

  // лист остаётся открытым и показывает состояние ожидания (задача 16B:
  // с таб-бара разбор ушёл, повторно открыть его после закрытия нечем —
  // потому «Неделя закрыта.» и текст ожидания проверяются здесь же)
  const after = document.getElementById('scr-review').textContent;
  assert.match(after, /Неделя закрыта/);
  assert.match(after, /Разбор откроется в понедельник/);
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.reviews.length, 1);
  assert.equal(saved.reviews[0].perItem.it1.count, 2);
  assert.equal(saved.reviews[0].week, prevMonday()); // понедельник разобранной недели
  assert.deepEqual(saved.weekLog, []);
  assert.equal(saved.weekStart, prevMonday()); // историческое поле не тронуто

  // «Готово» возвращает на вкладку, с которой лист открыт; баннер снят
  document.querySelector('[data-act="review-done"]').click();
  assert.equal(document.getElementById('scr-review').hidden, true);
  assert.equal(document.getElementById('scr-today').hidden, false);
  assert.equal(document.querySelector('[data-act="goto-review"]'), null, 'неделя разобрана — баннера нет');
});

test('битый localStorage: сырая строка сохраняется в minimum:data:corrupt', async () => {
  const { document, window } = await boot({ raw: '{битый json' });
  // задача 25, п. 6: сырая строка лежит в обёртке с датой (см. одноимённый
  // тест домена); сама строка сохраняется дословно
  assert.equal(JSON.parse(window.localStorage.getItem('minimum:data:corrupt')).raw, '{битый json');
  assert.ok(JSON.parse(window.localStorage.getItem(NS))); // основной ключ перезаписан валидным дефолтом
  assert.equal(document.querySelectorAll('input[data-act="mark"]').length, 6);
});

test('импорт мусора: migrate чинит, экраны живы, XSS-id не ломает разметку', async () => {
  const { document, window } = await boot();
  const evil = '"><script>window.__xss = 1</scr' + 'ipt><b x="';
  const payload = {
    schemaVersion: 3,
    items: [
      null, 'мусор',
      { id: evil, name: 'Пункт с плохим id', addedAt: daysAgo(3), type: 'daily', active: true },
      { name: 'Без id' }
    ],
    days: { [daysAgo(1)]: 'не объект', [daysAgo(2)]: { [evil]: true } },
    weekLog: [null], reviews: [null], weekStart: 'мусор',
    settings: { dayBoundary: 4, habitSeeded: true }
  };
  let confirmText = '';
  window.confirm = m => { confirmText = m; return true; };
  window.alert = m => { throw new Error('alert при успешном импорте: ' + m); };

  document.querySelector('#tabs button[data-tab="settings"]').click();
  const inp = document.getElementById('import-file');
  const file = new window.File([JSON.stringify(payload)], 'x.json', { type: 'application/json' });
  Object.defineProperty(inp, 'files', { value: [file], configurable: true });
  inp.dispatchEvent(new window.Event('change', { bubbles: true }));
  for (let i = 0; i < 100 && !confirmText; i++) await new Promise(r => setTimeout(r, 10));

  // сводка предпросмотра
  assert.match(confirmText, /пунктов: 2/);
  assert.match(confirmText, /дней с отметками: 1/);
  assert.match(confirmText, /закрытых недель: 0/);
  // тихая строка успеха в «Данных», числительные согласованы
  assert.match(document.getElementById('scr-settings').textContent, /Импортировано: 2 пункта, 1 день/);

  // строка исчезает при следующем действии — даже если оно само не перерисовывает экран
  document.querySelector('[data-act="import"]').click();
  assert.doesNotMatch(document.getElementById('scr-settings').textContent, /Импортировано/);

  // все 5 экранов рендерятся без исключений
  const map = {
    today: 'scr-today', habits: 'scr-habits', progress: 'scr-progress',
    notes: 'scr-notes', settings: 'scr-settings'
  };
  for (const b of document.querySelectorAll('#tabs button')) {
    b.click();
    assert.ok(document.getElementById(map[b.dataset.tab]).innerHTML.length > 0, b.dataset.tab);
  }

  // XSS не материализовался: скрипт не исполнен и не вставлен в экраны
  assert.equal(window.__xss, undefined);
  assert.equal(document.querySelector('main script'), null);

  // пункт с «плохим» id работает: разметка не разорвана, отметка пишется
  document.querySelector('#tabs button[data-tab="today"]').click();
  const cb = [...document.querySelectorAll('input[data-act="mark"]')].find(i => i.dataset.id === evil);
  assert.ok(cb, 'чекбокс пункта с плохим id существует');
  cb.click();
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.days[daysAgo(0)][evil], true);
});

test('вредоносные данные не ломают разбор: имя пункта экранируется, count из reviews не рендерится', async () => {
  const seed = dueSeed();
  // после A.5.2 «Три закрытые недели» считает по days{}, а не по reviews:
  // подстановка из архива до разметки вообще не доходит
  seed.reviews = [{
    closedAt: 1, week: addKey(prevMonday(), -28), keys: [addKey(prevMonday(), -28)],
    perItem: { it1: { name: 'Тестовый пункт', marks: [], count: '<img src=x onerror="window.__x=1">' } },
    trainings: {}, oneChange: '', raises: []
  }];
  // а имя пункта в разметку идёт — оно и должно экранироваться
  seed.items[0].name = '<img src=y onerror="window.__y=1">';
  const { document, window } = await boot({ seed });
  openReview(document);
  const scr = document.getElementById('scr-review');
  assert.ok(scr.innerHTML.length > 0);
  assert.equal(scr.querySelector('img'), null); // разметка не материализовалась
  assert.equal(window.__x, undefined);
  assert.equal(window.__y, undefined);
  assert.match(scr.textContent, /<img src=y/);         // имя показано как текст
  assert.doesNotMatch(scr.textContent, /<img src=x/);  // count из архива не показывается вовсе
});

/* Задача 26, п. 2.2 переписала предмет этого теста. Прежде он закреплял
   «невалид молча сохраняет старое»: форма закрывалась, значение оставалось
   прежним, и всё это под надписью «Сохранено» — приложение говорило
   «сохранено» о том, что выбросило. Теперь непринятое число — отказ:
   форма остаётся открытой, введённое цело, в store не записано ничего.
   Осознанная очистка (пустое поле → value: null) отказом НЕ стала — это
   решение владельца, а не отброшенный ввод (инвариант 5). */
test('правка значения: невалид — отказ без записи, пустое — осознанная очистка без истории', async () => {
  const seed = dueSeed();
  seed.items = [{
    id: 'e1', name: 'Правка', value: 12, unit: 'мин', type: 'daily', goal: null,
    note: '', group: '', active: true, addedAt: daysAgo(10), raiseAfter: 0,
    history: [{ date: daysAgo(10), value: 10 }, { date: daysAgo(3), value: 12 }]
  }, {
    id: 'w1', name: 'Недельный', value: null, unit: '', type: 'weekly', goal: 3,
    note: '', group: '', active: true, addedAt: daysAgo(10), raiseAfter: 0, history: []
  }];
  seed.days = {};
  const { document, window } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const openEdit = name => [...document.querySelectorAll('[data-act="edit-open"]')]
    .find(b => b.querySelector('.tname').textContent === name).click();
  const savedItem = name => JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.name === name);

  assert.match(document.getElementById('scr-settings').textContent, /Планка: 10 → 12/);

  // невалидный ввод — отказ: ни значения, ни истории, ни «Сохранено»,
  // и правка названия в той же форме тоже не записана (всё или ничего)
  openEdit('Правка');
  document.getElementById('e-name').value = 'Другое имя';
  document.getElementById('e-value').value = '1о';
  document.querySelector('[data-act="edit-save"]').click();
  assert.equal(savedItem('Правка').value, 12);
  assert.equal(savedItem('Правка').history.length, 2);
  assert.ok(savedItem('Правка'), 'имя не переписано: отказ ничего не пишет');
  assert.ok(document.getElementById('e-value'), 'форма осталась открытой');
  assert.equal(document.getElementById('e-value').value, '1о', 'введённое цело');
  assert.equal(document.getElementById('e-name').value, 'Другое имя');
  assert.match(document.querySelector('#scr-settings .flash.keep').textContent,
    /Значение не принято: нужно число больше нуля/);
  assert.equal(document.querySelector('#scr-settings .flash:not(.keep)'), null, '«Сохранено» нет');

  // пустое поле — осознанная очистка: значение null, история не растёт, «Планка:» скрыта
  document.getElementById('e-name').value = 'Правка';
  document.getElementById('e-value').value = '';
  document.querySelector('[data-act="edit-save"]').click();
  assert.equal(savedItem('Правка').value, null);
  assert.equal(savedItem('Правка').history.length, 2);
  assert.doesNotMatch(document.getElementById('scr-settings').textContent, /Планка:/);

  // цель weekly: пустое и невалидное поле — отказ, старая цель на месте
  openEdit('Недельный');
  document.getElementById('e-goal').value = '';
  document.querySelector('[data-act="edit-save"]').click();
  assert.equal(savedItem('Недельный').goal, 3);
  assert.ok(document.getElementById('e-goal'), 'форма открыта после отказа');
  document.getElementById('e-goal').value = '0';
  document.querySelector('[data-act="edit-save"]').click();
  assert.equal(savedItem('Недельный').goal, 3);
  document.getElementById('e-goal').value = '5';
  document.querySelector('[data-act="edit-save"]').click();
  assert.equal(savedItem('Недельный').goal, 5);
  assert.equal(document.getElementById('e-goal'), null, 'принятое закрывает форму');
});

test('отметка чекбокса не пересоздаёт узлы — CSS-переходы могут играть', async () => {
  const { document } = await boot();
  const cb = document.querySelector('input[data-act="mark"]');
  const label = cb.closest('label.check');
  const bar = document.querySelector('#scr-today .bar i');
  const note = document.querySelector('#scr-today .bar-note');
  assert.equal(label.classList.contains('on'), false);

  cb.click();

  // ссылки те же — экран не перерисовывался, изменились класс и ширина
  assert.equal(document.contains(label), true);
  assert.equal(document.querySelector('#scr-today .bar i'), bar);
  assert.equal(document.querySelector('#scr-today .bar-note'), note);
  assert.equal(label.classList.contains('on'), true);
  assert.equal(bar.style.width, '17%');
  assert.match(note.textContent, /1\s*из\s*6/);

  cb.click(); // снятие отметки — тоже точечно
  assert.equal(label.classList.contains('on'), false);
  assert.equal(bar.style.width, '0%');
});

test('недельный счётчик обновляется точечно, «отменить последний» появляется и исчезает', async () => {
  const { document } = await boot();
  const plus = document.querySelector('[data-act="train-inc"]');
  const wc = plus.closest('.weekcount');
  const num = wc.querySelector('.wnum b');
  assert.equal(num.textContent, '0');

  // «+» открывает лист тренировки (задача 16D): счёт растёт записью, а
  // возврат с листа — смена вида, то есть полная перерисовка «Сегодня»
  plus.click();
  assert.equal(document.getElementById('scr-train').hidden, false);
  document.querySelector('[data-act="train-save"]').click();
  assert.equal(document.getElementById('scr-today').hidden, false);

  const wc2 = document.querySelector('.weekcount');
  const num2 = wc2.querySelector('.wnum b');
  assert.equal(num2.textContent, '1');
  const undo = wc2.nextElementSibling;
  assert.ok(undo && undo.dataset.act === 'train-undo', 'кнопка отмены появилась');

  // отмена остаётся точечной: узел счётчика тот же
  undo.click();
  assert.equal(wc2.querySelector('.wnum b'), num2);
  assert.equal(num2.textContent, '0');
  assert.notEqual(wc2.nextElementSibling && wc2.nextElementSibling.dataset.act, 'train-undo');
});

test('stale-guard: клик после смены дня не пишет отметку, экран перерисовывается', async () => {
  const { document, window } = await boot();
  const h1before = document.querySelector('#scr-today h1').textContent;
  shiftWindowDate(window, 24 * 3600000);

  document.querySelector('input[data-act="mark"]').click();

  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.deepEqual(saved.days, {}); // отметка не записана ни в какой день
  assert.notEqual(document.querySelector('#scr-today h1').textContent, h1before); // новая дата
  assert.equal(document.querySelector('input[data-act="mark"]').checked, false);
});

test('visibilitychange после смены дня обновляет экран', async () => {
  const { document, window } = await boot();
  const before = document.querySelector('#scr-today h1').textContent;
  shiftWindowDate(window, 24 * 3600000);
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.notEqual(document.querySelector('#scr-today h1').textContent, before);
});

test('фокус после «выше/ниже» возвращается кнопке, на краю — парной', async () => {
  const { document } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  // блок «Подряд» — три пункта: пункту есть куда шагнуть, прежде чем «ниже» погаснет
  const row = [...document.querySelectorAll('#scr-settings .rowwrap')]
    .find(r => r.textContent.includes('Подтягивания + отжимания'));
  const btn = row.querySelector('[data-act="move-down"]');
  const id = btn.dataset.id;

  btn.click();
  assert.equal(document.activeElement.dataset.act, 'move-down');
  assert.equal(document.activeElement.dataset.id, id);

  // догоняем пункт до низа списка — «ниже» станет disabled, фокус уйдёт парной
  for (let i = 0; i < 10; i++) {
    const b = [...document.querySelectorAll('[data-act="move-down"]')].find(x => x.dataset.id === id);
    if (b.disabled) break;
    b.click();
  }
  assert.equal(document.activeElement.dataset.act, 'move-up');
  assert.equal(document.activeElement.dataset.id, id);
});

test('открытая форма переживает перестановку и смену типа — значения и цель сохраняются', async () => {
  const { document, window } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const changeType = v => {
    const sel = document.getElementById('f-type');
    sel.value = v;
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  // форма добавления: смена типа weekly → daily → weekly не сбрасывает цель
  document.querySelector('[data-act="add-open"]').click();
  document.getElementById('f-name').value = 'Чтение';
  document.getElementById('f-value').value = '15';
  changeType('weekly');
  document.getElementById('f-goal').value = '5';
  changeType('daily');
  assert.equal(document.getElementById('f-goal'), null); // поле цели скрыто
  changeType('weekly');
  assert.equal(document.getElementById('f-name').value, 'Чтение');
  assert.equal(document.getElementById('f-value').value, '15');
  assert.equal(document.getElementById('f-goal').value, '5'); // цель не сброшена на 3
  document.querySelector('[data-act="add-cancel"]').click();

  // форма редактирования переживает перестановку соседнего пункта
  const editBtn = document.querySelector('[data-act="edit-open"]');
  const editedId = editBtn.dataset.id;
  editBtn.click();
  document.getElementById('e-name').value = 'Новое имя';
  const otherDown = [...document.querySelectorAll('[data-act="move-down"]')]
    .find(b => !b.disabled && b.dataset.id !== editedId);
  otherDown.click();
  assert.ok(document.getElementById('e-name'), 'форма всё ещё открыта');
  assert.equal(document.getElementById('e-name').value, 'Новое имя');
});

test('фокус-событие окна после смены дня обновляет экран', async () => {
  const { document, window } = await boot();
  const before = document.querySelector('#scr-today h1').textContent;
  shiftWindowDate(window, 24 * 3600000);
  window.dispatchEvent(new window.Event('focus'));
  assert.notEqual(document.querySelector('#scr-today h1').textContent, before);
});

/* ── Задача 23, п. 5: третий триггер инварианта 8 — таймер ────
   visibilitychange и focus покрыты выше; таймер границы дня не
   проверялся вовсе, и оба его отказа проходили молча: не позвал
   syncDay (экран остаётся вчерашним при открытом приложении) и не
   перевзвёлся (первая смена дня работает, вторая уже нет).

   msToNextBoundary подменяется через window: в скрипте объявления
   функций верхнего уровня становятся свойствами глобального объекта,
   и app.js зовёт их через него — та же механика, что у подмены
   matchMedia. Ждать настоящую границу дня, разумеется, нельзя. */
async function armFastTimer(window, everyMs) {
  window.msToNextBoundary = () => everyMs;
  window.armDayTimer();               // перевзвести на короткий срок
}

test('З23/5: таймер границы дня зовёт syncDay и перевзводится на следующую', async () => {
  const { document, window } = await boot();
  const day0 = document.querySelector('#scr-today h1').textContent;
  const tick = 20;
  await armFastTimer(window, tick);

  // первое срабатывание: день сменился — таймер обязан позвать syncDay
  shiftWindowDate(window, 24 * 3600000);
  await wait(tick + T.DAY_TIMER_SLACK_MS + 60);
  const day1 = document.querySelector('#scr-today h1').textContent;
  assert.notEqual(day1, day0, 'таймер позвал syncDay: экран показывает новый день');

  // второе: таймер обязан быть взведён заново — иначе смена дня при
  // открытом приложении сработает ровно один раз за запуск
  shiftWindowDate(window, 48 * 3600000);
  await wait(tick + T.DAY_TIMER_SLACK_MS + 60);
  const day2 = document.querySelector('#scr-today h1').textContent;
  assert.notEqual(day2, day1, 'таймер перевзвёлся: вторая смена дня тоже поймана');
});

test('З23/5: таймер молчит, пока логический день тот же', async () => {
  const { document, window } = await boot();
  const before = document.getElementById('scr-today').innerHTML;
  await armFastTimer(window, 20);
  await wait(20 + T.DAY_TIMER_SLACK_MS + 80); // несколько срабатываний подряд
  assert.equal(document.getElementById('scr-today').innerHTML, before,
    'день не сменился — перерисовки нет (syncDay возвращает false)');
});

test('тумблер активности переключает .off точечно, без перерисовки', async () => {
  const { document, window } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const input = document.querySelector('input[data-act="toggle-active"]');
  const wrap = input.closest('.rowwrap');
  assert.equal(wrap.classList.contains('off'), false);

  input.click();

  assert.equal(document.contains(wrap), true); // узел тот же — экран не перерисовывался
  assert.equal(wrap.classList.contains('off'), true);
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.items.find(i => i.id === input.dataset.id).active, false);

  input.click();
  assert.equal(wrap.classList.contains('off'), false);
});

test('смена границы дня не перерисовывает «Пункты»; сдвиг дня не глушит следующий клик', async () => {
  const { document, window } = await boot();
  // привести «сейчас» к 02:30 — внутри окна 00:00–04:00, где границы 4 и 0 дают разные дни
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 2, 30, 0, 0);
  shiftWindowDate(window, target.getTime() - now.getTime());
  document.dispatchEvent(new window.Event('visibilitychange')); // синхронизировать экран со сдвинутым «сейчас»

  document.querySelector('#tabs button[data-tab="settings"]').click();
  const sel = document.querySelector('select[data-act="boundary"]');
  sel.value = '0';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));

  // экран не перерисован — select тот же узел; настройка сохранена
  assert.equal(document.querySelector('select[data-act="boundary"]'), sel);
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).settings.dayBoundary, 0);

  // граница сдвинула логический день (02:30: вчера → сегодня), но первый же
  // клик применяется, а не глотается stale-guard'ом
  document.querySelector('[data-act="add-open"]').click();
  assert.ok(document.getElementById('f-name'), 'форма открылась с первого клика');
});

test('подпись «вчера — пропуск» закрывается при смене вкладки', async () => {
  const seed = dueSeed();
  seed.weekStart = daysAgo(2);
  // вчера не отмечено, но пункт начат — иначе точки нет вовсе (задача 22, п. 2)
  seed.days = { [addKey(prevMonday(), 1)]: { it1: true } };
  const { document, window } = await boot({ seed });
  const dot = document.querySelector('[data-act="miss-note"]');
  assert.ok(dot, 'точка-маркер есть');
  // задача 26, п. 8.1: узел подписи стоит в разметке всегда (aria-controls
  // обязан указывать на существующий элемент), раскрытость несёт hidden
  assert.equal(document.querySelector('.miss-note').hidden, true, 'до тапа свёрнута');
  dot.click();
  assert.equal(document.querySelector('.miss-note').hidden, false, 'подпись раскрыта');

  document.querySelector('#tabs button[data-tab="progress"]').click();
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.equal(document.querySelector('.miss-note').hidden, true); // missOpen очищен
  assert.ok(document.querySelector('[data-act="miss-note"]')); // сама точка на месте
});

test('скролл наверх — только при фактической смене вкладки', async () => {
  const { document, window } = await boot();
  const calls = [];
  window.scrollTo = (...a) => calls.push(a);

  document.querySelector('#tabs button[data-tab="settings"]').click();
  assert.equal(calls.length, 1); // смена вкладки — скролл

  document.querySelector('#tabs button[data-tab="settings"]').click();
  assert.equal(calls.length, 1); // та же вкладка — позиция не трогается

  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.equal(calls.length, 2);
});

test('импорт при открытой форме: черновик не накатывается на импортированный пункт', async () => {
  const { document, window } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();

  // открыть редактирование первого пункта и оставить несохранённый черновик
  const editBtn = document.querySelector('[data-act="edit-open"]');
  const sameId = editBtn.dataset.id;
  editBtn.click();
  document.getElementById('e-name').value = 'Черновик';

  // импортировать файл, где пункт имеет ТОТ ЖЕ id, но другие значения
  const payload = {
    schemaVersion: 3,
    items: [{ id: sameId, name: 'Импортный', value: 7, unit: 'мин', type: 'daily',
      goal: null, note: '', group: '', active: true, addedAt: daysAgo(5), raiseAfter: 0,
      history: [{ date: daysAgo(5), value: 7 }] }],
    days: {}, weekLog: [], reviews: [], pendingRaises: [],
    draftOneChange: '', weekStart: daysAgo(2), settings: { dayBoundary: 4 }
  };
  window.confirm = () => true;
  window.alert = m => { throw new Error('alert при успешном импорте: ' + m); };
  const inp = document.getElementById('import-file');
  const file = new window.File([JSON.stringify(payload)], 'x.json', { type: 'application/json' });
  Object.defineProperty(inp, 'files', { value: [file], configurable: true });
  inp.dispatchEvent(new window.Event('change', { bubbles: true }));
  for (let i = 0; i < 100 && document.getElementById('e-name'); i++) await new Promise(r => setTimeout(r, 10));

  assert.equal(document.getElementById('e-name'), null); // форма закрыта импортом
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.items[0].name, 'Импортный'); // черновик не затёр импортированное
  assert.match(document.getElementById('scr-settings').textContent, /Импортный/);
});

test('доступность: точка вне label, aria-expanded, имена контролов, aria-live', async () => {
  const seed = dueSeed();
  seed.weekStart = daysAgo(2);
  // вчера не отмечено, но оба пункта начаты — иначе точек нет (задача 22, п. 2)
  seed.days = { [addKey(prevMonday(), 1)]: { it1: true, it2: true } };
  seed.items.push({
    id: 'it2', name: 'Второй пункт', value: null, unit: '', type: 'daily',
    goal: null, note: '', group: '', active: true, addedAt: daysAgo(10),
    raiseAfter: 0, history: []
  });
  const { document } = await boot({ seed });
  const dots = () => [...document.querySelectorAll('[data-act="miss-note"]')];
  assert.equal(dots().length, 2);

  // точка-маркер — сосед label, имя чекбокса больше не содержит «пропуск»
  const dot = dots()[0];
  assert.equal(dot.closest('label'), null, 'точка вне label');
  assert.ok(dot.closest('.rowwrap'), 'точка внутри .rowwrap');
  const label = document.querySelector('label.check');
  assert.doesNotMatch(label.textContent, /пропуск/);

  // aria-expanded переключается, фокус возвращается ИМЕННО нажатой точке (второй)
  const second = dots().find(d => d.dataset.id === 'it2');
  assert.equal(second.getAttribute('aria-expanded'), 'false');
  second.click();
  let after = dots().find(d => d.dataset.id === 'it2');
  assert.equal(after.getAttribute('aria-expanded'), 'true');
  assert.equal(dots().find(d => d.dataset.id === 'it1').getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, after, 'фокус на пересозданной кнопке того же пункта');
  // задача 26, п. 8.1: aria-controls указывает на существующий узел подписи,
  // и раскрытость несёт hidden, а не наличие узла в DOM
  const ctrl = after.getAttribute('aria-controls');
  assert.ok(ctrl, 'у точки есть aria-controls');
  const panel = document.getElementById(ctrl);
  assert.ok(panel, 'aria-controls указывает на существующий узел');
  assert.ok(panel.classList.contains('miss-note'));
  assert.equal(panel.hidden, false, 'раскрыт');
  after.click();
  after = dots().find(d => d.dataset.id === 'it2');
  assert.equal(after.getAttribute('aria-expanded'), 'false');
  assert.equal(document.getElementById(ctrl).hidden, true, 'свёрнут');
  assert.equal(document.activeElement, after);

  // .bar-note: aria-live и переживание точечной отметки тем же узлом
  const note = document.querySelector('.bar-note');
  assert.equal(note.getAttribute('aria-live'), 'polite');
  document.querySelector('input[data-act="mark"]').click();
  assert.equal(document.querySelector('.bar-note'), note, 'узел не пересоздан');
  assert.equal(note.getAttribute('aria-live'), 'polite');
  assert.match(note.textContent, /1\s*из\s*2/);
});

test('доступность: имена тумблера и кнопок недельного счётчика содержат название пункта', async () => {
  const { document } = await boot();

  // «+» (открывает лист записи) и появившийся точечно «отменить последний»
  const plus = document.querySelector('[data-act="train-inc"]');
  assert.match(plus.getAttribute('aria-label'), /записать тренировку: «Тренировка»/);
  plus.click();
  document.querySelector('[data-act="train-save"]').click();
  const undo = document.querySelector('[data-act="train-undo"]');
  assert.match(undo.getAttribute('aria-label'), /Тренировка/);

  // тумблер активности пункта (в редакторе блоков тумблеров больше нет)
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const sw = document.querySelector('.row.item label.switch');
  assert.match(sw.getAttribute('aria-label'), /включён: «Умыться»/);
});

test('доступность: сетка разбора скрыта от AT, счётчики строк — в sr-only', async () => {
  const { document } = await boot({ seed: dueSeed() });
  openReview(document);
  const grid = document.querySelector('.grid');
  assert.ok(grid);
  const hiddenWraps = grid.querySelectorAll(':scope > [aria-hidden="true"]');
  assert.equal(hiddenWraps.length, 2); // шапка чисел + строка кружков одного пункта
  const sr = grid.querySelector('.g-name .sr-only');
  assert.ok(sr);
  assert.match(sr.textContent, /отмечено 2 из 7/);
});

test('ретро-отметка: «отметить» ставит вчера, точка исчезает, фокус на чекбоксе', async () => {
  const seed = dueSeed();
  seed.weekStart = daysAgo(2);
  // вчера не отмечено, но пункт начат — иначе точки нет (задача 22, п. 2)
  seed.days = { [addKey(prevMonday(), 1)]: { it1: true } };
  const { document, window } = await boot({ seed });

  document.querySelector('[data-act="miss-note"]').click();
  const btn = document.querySelector('[data-act="mark-yesterday"]');
  assert.ok(btn, 'кнопка «отметить» в раскрытой подписи');
  assert.equal(btn.closest('label'), null, 'кнопка вне label чекбокса');
  assert.match(btn.getAttribute('aria-label'), /отметить вчера: «Тестовый пункт»/); // имя пункта в имени кнопки

  btn.click();

  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.days[daysAgo(1)].it1, true);            // ровно вчера
  assert.equal(saved.days[daysAgo(0)], undefined);           // сегодня не тронуто
  assert.equal(document.querySelector('[data-act="miss-note"]'), null, 'точка исчезла');
  const cb = [...document.querySelectorAll('input[data-act="mark"]')].find(i => i.dataset.id === 'it1');
  assert.equal(document.activeElement, cb, 'фокус на чекбоксе пункта');
  assert.doesNotMatch(document.querySelector('label.check').textContent, /пропуск/);
});

test('ретро-отметка видна в сетке разбора и входит в count при закрытии', async () => {
  const seed = dueSeed();
  // единственная отметка — до разбираемой недели: пункт начат (точка-маркер
  // требует этого с задачи 22, п. 2), а сетка разбора остаётся пустой
  seed.days = { [addKey(prevMonday(), -7)]: { it1: true } };
  // прошлая неделя уже разобрана — разбор появится после смены недели
  seed.reviews = [{ closedAt: 1, week: prevMonday(), keys: [], perItem: {}, trainings: {}, oneChange: '', raises: [] }];
  const { document, window } = await boot({ seed });

  // «сейчас» — понедельник следующей недели: «вчера» = воскресенье завершённой
  const now = new Date();
  const [y, m, d] = addKey(curMonday(), 7).split('-').map(Number);
  shiftWindowDate(window, new Date(y, m - 1, d, 12).getTime() - now.getTime());
  document.dispatchEvent(new window.Event('visibilitychange'));

  document.querySelector('[data-act="miss-note"]').click();
  document.querySelector('[data-act="mark-yesterday"]').click(); // отметка в воскресенье

  openReview(document);
  assert.match(document.querySelector('.g-name .sr-only').textContent, /отмечено 1 из 7/);
  assert.equal(document.querySelectorAll('.grid i.on').length, 1);

  closeWeekThroughUi(document);
  const saved = JSON.parse(window.localStorage.getItem(NS));
  const r = saved.reviews[saved.reviews.length - 1];
  assert.equal(r.week, curMonday()); // разобрана бывшая текущая неделя
  assert.equal(r.perItem.it1.count, 1); // ретро-отметка в срезе
});

test('разбор показывает счёт тренировок разобранной недели, не текущей', async () => {
  const seed = dueSeed();
  seed.items.push({
    id: 'w1', name: 'Тренировка', value: null, unit: '', type: 'weekly', goal: 3,
    note: '', group: '', active: true, addedAt: addKey(prevMonday(), -14), raiseAfter: 0, history: []
  });
  seed.weekLog = [
    { itemId: 'w1', date: addKey(prevMonday(), 2), ts: 1 }, // в разобранной неделе
    { itemId: 'w1', date: daysAgo(0), ts: 2 }               // в текущей
  ];
  const { document, window } = await boot({ seed });
  assert.match(document.querySelector('.wnum b').textContent, /1/); // «Сегодня» — текущая неделя
  openReview(document);
  assert.match(document.getElementById('scr-review').textContent, /Тренировка: 1 из 3/); // разбираемая неделя
  closeWeekThroughUi(document);
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.reviews[0].trainings.w1.count, 1); // экран и срез согласованы
});

test('смена недели в открытом приложении: счётчик обнуляется, баннер появляется', async () => {
  const seed = dueSeed();
  seed.reviews = [{ closedAt: 1, week: prevMonday(), keys: [], perItem: {}, trainings: {}, oneChange: '', raises: [] }];
  seed.items.push({
    id: 'w1', name: 'Тренировка', value: null, unit: '', type: 'weekly', goal: 3,
    note: '', group: '', active: true, addedAt: addKey(prevMonday(), -14), raiseAfter: 0, history: []
  });
  const { document, window } = await boot({ seed });
  assert.equal(document.querySelector('[data-act="goto-review"]'), null, 'разбор закрыт — баннера нет');

  document.querySelector('[data-act="train-inc"]').click();      // лист тренировки
  document.querySelector('[data-act="train-save"]').click();     // и запись
  assert.equal(document.querySelector('.wnum b').textContent, '1');

  shiftWindowDate(window, 7 * 86400000); // ровно неделя вперёд
  document.dispatchEvent(new window.Event('visibilitychange')); // механизм инварианта 8

  assert.equal(document.querySelector('.wnum b').textContent, '0'); // счётчик обнулился сменой недели
  assert.ok(document.querySelector('[data-act="goto-review"]'), 'баннер разбора появился');
});

test('«Изменение этой недели» в обоих состояниях разбора, с экранированием', async () => {
  const evilChange = '  раньше <script>window.__oc=1</script> ложиться  ';
  const mkReview = (week) => ({
    closedAt: 1, week, keys: [week],
    perItem: {}, trainings: {}, oneChange: evilChange, raises: []
  });

  // состояние ожидания: неделя закрывается прямо в тесте — после 16B это
  // единственный путь к нему (с таб-бара разбор ушёл). Строка берётся из
  // только что записанного среза, то есть из черновика этой недели.
  const wait = dueSeed();
  wait.draftOneChange = evilChange;
  const a = await boot({ seed: wait });
  openReview(a.document);
  closeWeekThroughUi(a.document);
  let scr = a.document.getElementById('scr-review');
  assert.match(scr.textContent, /Разбор откроется/);
  assert.match(scr.textContent, /Изменение этой недели: „раньше <script>window\.__oc=1<\/script> ложиться“/);
  assert.equal(scr.querySelector('script'), null, 'разметка не материализовалась');
  assert.equal(a.window.__oc, undefined);

  // открытый разбор: закрыт лишь давний, последняя завершённая неделя ждёт
  const due = dueSeed();
  due.reviews = [mkReview(addKey(prevMonday(), -28))];
  const b = await boot({ seed: due });
  openReview(b.document);
  scr = b.document.getElementById('scr-review');
  assert.ok(scr.querySelector('.grid'), 'открытый разбор');
  assert.match(scr.textContent, /Изменение этой недели: „раньше <script>window\.__oc=1<\/script> ложиться“/);

  // пустое «одно изменение» — строки нет
  const empty = dueSeed();
  empty.draftOneChange = '   ';
  const c = await boot({ seed: empty });
  openReview(c.document);
  closeWeekThroughUi(c.document);
  assert.doesNotMatch(c.document.getElementById('scr-review').textContent, /Изменение этой недели/);
});

test('«Привычки»: своя планка точечно, «Все отмечены», пороги пассивны, кредо', async () => {
  // программа посева (задача 17) несёт одну ежедневную привычку и параметр «Отбой»;
  // планке нужны две привычки — вторую тест заводит обычной формой
  const { document, window } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  [...document.querySelectorAll('[data-act="add-open"]')].find(b => b.dataset.area === 'habit').click();
  document.getElementById('f-name').value = 'Медитация';
  document.querySelector('[data-act="add-save"]').click();

  document.querySelector('#tabs button[data-tab="habits"]').click();
  const scr = document.getElementById('scr-habits');

  // планка «Сегодня» игнорирует привычки, планка привычек — минимум
  assert.equal(scr.querySelectorAll('input[data-act="mark"]').length, 2);
  assert.match(scr.querySelector('.bar-note').textContent, /сегодня\s*0\s*из\s*2/);

  // точечная отметка: узлы те же, переходы могут играть
  const cb = scr.querySelector('input[data-act="mark"]');
  const label = cb.closest('label.check');
  const bar = scr.querySelector('.bar i');
  const note = scr.querySelector('.bar-note');
  cb.click();
  assert.equal(scr.querySelector('.bar i'), bar, 'узел планки не пересоздан');
  assert.equal(label.classList.contains('on'), true);
  assert.equal(bar.style.width, '50%');
  assert.match(note.textContent, /сегодня\s*1\s*из\s*2/);

  // 100% — спокойное «Все отмечены»
  [...scr.querySelectorAll('input[data-act="mark"]')].find(i => !i.checked).click();
  assert.match(note.textContent, /Все отмечены/);

  // отметки привычек не тронули планку минимума
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.match(document.querySelector('#scr-today .bar-note').textContent, /0\s*из\s*6/);

  // параметры — пассивные строки с порогом; кредо внизу
  document.querySelector('#tabs button[data-tab="habits"]').click();
  assert.match(scr.textContent, /Порог недели/);
  assert.match(scr.textContent, /Отбой · 00:00/);
  assert.equal(scr.querySelector('[data-act="param-step"]'), null, 'на вкладке порог не меняется');
  assert.match(scr.textContent, /Не спеши — доверься накопительному эффекту\./);

  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(Object.values(saved.days[daysAgo(0)]).length, 2); // обе отметки записаны
});

test('«Привычки»: пустая секция — тихая строка, точка и ретро работают у привычки', async () => {
  const seed = dueSeed(); // habitSeeded: soft-блок поставит false, посева нет — привычек нет
  const { document } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="habits"]').click();
  assert.match(document.getElementById('scr-habits').textContent,
    /Привычек пока нет — добавить можно в Настройках → Пункты\./);
});

test('разбор: секции «Минимум» и «Привычки», карточка параметра, готовность', async () => {
  const seed = dueSeed();
  const prev = prevMonday();
  seed.items.push(
    { id: 'h1', name: 'Привычка-1', value: null, unit: '', type: 'daily', area: 'habit',
      goal: null, note: '', group: '', active: true, addedAt: addKey(prev, -14), raiseAfter: 0, history: [] },
    { id: 'pt', name: 'Отбой', value: null, unit: '', type: 'param', area: 'habit',
      pkind: 'time', pvalue: 0, pstep: -15, goal: null, note: '', group: '', active: true,
      addedAt: addKey(prev, -14), raiseAfter: 0, history: [{ date: addKey(prev, -14), value: 0 }] }
  );
  seed.days[addKey(prev, 2)] = { h1: true }; // отметка привычки в разобранной неделе
  // две последние ЗАВЕРШЁННЫЕ календарные недели с идеальной привычкой —
  // строка готовности (A.5.1: считается по days{}, не по reviews)
  fillWeek(seed.days, 'h1', addKey(prev, -7), 7);
  fillWeek(seed.days, 'h1', prev, 7);
  const { document, window } = await boot({ seed });
  openReview(document);
  const scr = document.getElementById('scr-review');

  const h2s = [...scr.querySelectorAll('h2')].map(x => x.textContent);
  assert.ok(h2s.includes('Минимум') && h2s.includes('Привычки'), 'обе секции недели');
  assert.equal(scr.querySelectorAll('.grid').length, 2); // две сетки той же недели
  assert.match(scr.textContent, /Привычки устойчивы 2 недели — можно добавить новую/);

  // карточка параметра: «шаг» меняет порог немедленно и оставляет строку итога
  const card = scr.querySelector('[data-act="param-step"]');
  assert.match(card.textContent, /Шаг: → 23:45/);
  assert.match(scr.textContent, /«Отбой · 00:00» — как прошла неделя\?/);
  card.click();
  await settle(); // карточка уходит с задержкой (движение), затем перерисовка
  assert.equal(scr.querySelector('[data-act="param-step"]'), null, 'карточка сменилась строкой итога');
  assert.match(scr.textContent, /Отбой: 00:00 → 23:45/);
  let saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.items.find(i => i.id === 'pt').pvalue, 1425); // применён немедленно
  assert.deepEqual(saved.paramDecided.pt, { week: prevMonday(), from: 0, to: 1425 }); // решение привязано к неделе

  // порог виден на «Привычках» сразу
  document.querySelector('#tabs button[data-tab="habits"]').click();
  assert.match(document.getElementById('scr-habits').textContent, /Отбой · 23:45/);

  // закрытие пишет params и чистит решения
  openReview(document);
  closeWeekThroughUi(document);
  saved = JSON.parse(window.localStorage.getItem(NS));
  const r = saved.reviews[saved.reviews.length - 1];
  assert.deepEqual(r.params, [{ id: 'pt', from: 0, to: 1425 }]);
  assert.deepEqual(saved.paramDecided, {});
});

test('разбор: «Оставить» фиксирует отказ и порог не меняет', async () => {
  const seed = dueSeed();
  seed.items.push({
    id: 'pt', name: 'Отбой', value: null, unit: '', type: 'param', area: 'habit',
    pkind: 'time', pvalue: 90, pstep: -15, goal: null, note: '', group: '', active: true,
    addedAt: addKey(prevMonday(), -14), raiseAfter: 0, history: []
  });
  const { document, window } = await boot({ seed });
  openReview(document);
  document.querySelector('[data-act="param-keep"]').click();
  await settle(); // отложенный уход карточки
  const scr = document.getElementById('scr-review');
  assert.equal(scr.querySelector('[data-act="param-keep"]'), null);
  assert.match(scr.textContent, /Отбой: 01:30, без шага/);
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.items.find(i => i.id === 'pt').pvalue, 90);
  assert.deepEqual(saved.paramDecided.pt, { week: prevMonday(), from: 90, to: null });
});

test('«Пункты»: две группы, формы обеих областей, параметр добавляется и правится', async () => {
  const { document, window } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const scr = document.getElementById('scr-settings');

  const h2s = [...scr.querySelectorAll('h2')].map(x => x.textContent);
  assert.ok(h2s.includes('Минимум') && h2s.includes('Привычки'));
  const addBtns = [...scr.querySelectorAll('[data-act="add-open"]')];
  assert.deepEqual(addBtns.map(b => b.dataset.area), ['min', 'habit']);

  // форма привычек: тип «привычка» — только название и подпись
  addBtns[1].click();
  assert.ok(document.getElementById('f-name'));
  assert.equal(document.getElementById('f-value'), null, 'без значения в формах привычек');
  const typeSel = document.getElementById('f-type');
  assert.match(typeSel.textContent, /привычка \(ежедневная\)/);

  // тип «параметр»: вид, порог-время, шаг
  typeSel.value = 'param';
  typeSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok(document.getElementById('f-ptime'), 'порог времени — input type=time');
  document.getElementById('f-name').value = 'Подъём';
  document.getElementById('f-ptime').value = '07:30';
  document.getElementById('f-pstep').value = '-10';
  document.querySelector('[data-act="add-save"]').click();

  let saved = JSON.parse(window.localStorage.getItem(NS));
  const p = saved.items.find(i => i.name === 'Подъём');
  assert.equal(p.type, 'param');
  assert.equal(p.area, 'habit');
  assert.equal(p.pkind, 'time');
  assert.equal(p.pvalue, 450); // 07:30
  assert.equal(p.pstep, -10);
  assert.deepEqual(p.history, [{ date: daysAgo(0), value: 450 }]);
  assert.match(scr.textContent, /порог 07:30/);

  // правка порога пишет history по общим правилам
  const editBtn = [...scr.querySelectorAll('[data-act="edit-open"]')].find(b => b.textContent.includes('Подъём'));
  editBtn.click();
  document.getElementById('e-ptime').value = '07:00';
  document.querySelector('[data-act="edit-save"]').click();
  saved = JSON.parse(window.localStorage.getItem(NS));
  const p2 = saved.items.find(i => i.name === 'Подъём');
  assert.equal(p2.pvalue, 420);
  assert.deepEqual(p2.history, [{ date: daysAgo(0), value: 420 }]); // тот же день — замена записи
});

test('edit-форма параметра: вид — muted-строка без селекта, поля своего вида', async () => {
  const seed = dueSeed();
  seed.items.push(
    { id: 'pt', name: 'Отбой', value: null, unit: '', type: 'param', area: 'habit',
      pkind: 'time', pvalue: 0, pstep: -15, goal: null, note: '', group: '', active: true,
      addedAt: daysAgo(10), raiseAfter: 0, history: [] },
    { id: 'pn', name: 'Шаги', value: null, unit: 'шаг.', type: 'param', area: 'habit',
      pkind: 'number', pvalue: 4000, pstep: 500, goal: null, note: '', group: '', active: true,
      addedAt: daysAgo(10), raiseAfter: 0, history: [] }
  );
  const { document, window } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const open = name => [...document.querySelectorAll('[data-act="edit-open"]')]
    .find(b => b.textContent.includes(name)).click();
  const savedPn = () => JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.id === 'pn');

  open('Отбой');
  assert.equal(document.getElementById('e-pkind'), null, 'селекта вида нет');
  assert.match(document.querySelector('#scr-settings .card.form').textContent, /Вид: время/);
  assert.ok(document.getElementById('e-ptime'), 'порог времени правится');
  assert.ok(document.getElementById('e-pstep'));

  open('Шаги');
  assert.equal(document.getElementById('e-pkind'), null);
  assert.match(document.querySelector('#scr-settings .card.form').textContent, /Вид: число/);
  assert.ok(document.getElementById('e-pvalue'), 'числовой порог правится');
  assert.ok(document.getElementById('e-punit'), 'единица правится');

  // save-путь числового параметра: pkind неизменен, порог/единица/шаг правятся
  document.getElementById('e-pvalue').value = '4500';
  document.getElementById('e-punit').value = '  шагов  ';
  document.getElementById('e-pstep').value = '600';
  document.querySelector('[data-act="edit-save"]').click();
  let pn = savedPn();
  assert.equal(pn.pkind, 'number'); // вид сохранением не меняется
  assert.equal(pn.pvalue, 4500);
  assert.equal(pn.unit, 'шагов');   // trim единицы
  assert.equal(pn.pstep, 600);
  assert.deepEqual(pn.history[pn.history.length - 1], { date: daysAgo(0), value: 4500 });

  // невалидный порог — старое значение, вид по-прежнему number
  open('Шаги');
  document.getElementById('e-pvalue').value = '1о';
  document.querySelector('[data-act="edit-save"]').click();
  pn = savedPn();
  assert.equal(pn.pkind, 'number');
  assert.equal(pn.pvalue, 4500);
});

test('разбор: решение чужой недели не гасит карточку параметра', async () => {
  const seed = dueSeed();
  seed.items.push({
    id: 'pt', name: 'Отбой', value: null, unit: '', type: 'param', area: 'habit',
    pkind: 'time', pvalue: 90, pstep: -15, goal: null, note: '', group: '', active: true,
    addedAt: addKey(prevMonday(), -14), raiseAfter: 0, history: []
  });
  // решение прошлого разбора (неделя W−7), который так и не был закрыт
  seed.paramDecided = { pt: { week: addKey(prevMonday(), -7), from: 90, to: null } };
  const { document, window } = await boot({ seed });
  openReview(document);
  const scr = document.getElementById('scr-review');
  assert.ok(scr.querySelector('[data-act="param-step"]'), 'карточка решения показана');
  assert.doesNotMatch(scr.textContent, /без шага/); // итог чужой недели не показан

  // решение этой недели принимается и попадает в срез; чужое — нет
  scr.querySelector('[data-act="param-keep"]').click();
  await settle(); // отложенный уход карточки завершается перерисовкой
  closeWeekThroughUi(document);
  const saved = JSON.parse(window.localStorage.getItem(NS));
  const r = saved.reviews[saved.reviews.length - 1];
  assert.deepEqual(r.params, [{ id: 'pt', from: 90, to: null }]);
  assert.deepEqual(saved.paramDecided, {});
});

/* ── Движение (задача 12) ──────────────────────────────────── */

function paramSeed() {
  const seed = dueSeed();
  seed.items.push({
    id: 'pt', name: 'Отбой', value: null, unit: '', type: 'param', area: 'habit',
    pkind: 'time', pvalue: 90, pstep: -15, goal: null, note: '', group: '', active: true,
    addedAt: addKey(prevMonday(), -14), raiseAfter: 0, history: []
  });
  return seed;
}

test('движение: карточка разбора уходит через класс .leaving, затем удаляется перерисовкой', async () => {
  const { document } = await boot({ seed: paramSeed() });
  openReview(document);
  const scr = document.getElementById('scr-review');
  scr.querySelector('[data-act="param-step"]').click();

  // сразу после тапа: решение применено (данные), но карточка ещё в DOM с классом-триггером
  const leaving = scr.querySelector('.card.param.leaving');
  assert.ok(leaving, 'карточка помечена уходящей');
  assert.equal(leaving.style.maxHeight, '0px', 'высота схлопывается (12.1: max-height → 0)');
  assert.ok(scr.querySelector('[data-act="param-step"]'), 'узел ещё не удалён');

  await settle(); // fallback-таймаут (jsdom не шлёт transitionend) выполняет перерисовку
  assert.equal(scr.querySelector('.card.param'), null, 'узел реально удалён');
  assert.equal(scr.querySelector('[data-act="param-step"]'), null);
  assert.match(scr.textContent, /Отбой: 01:30 → 01:15/); // итоговая строка на месте
});

test('движение: карточка убирается по transitionend (первичный путь браузера), fallback не ломает состояние', async () => {
  const { document, window } = await boot({ seed: paramSeed() });
  openReview(document);
  const scr = document.getElementById('scr-review');
  const card = scr.querySelector('[data-act="param-step"]').closest('.card');
  scr.querySelector('[data-act="param-step"]').click();
  assert.ok(card.classList.contains('leaving'));

  // реальный браузер завершает уход событием transitionend — узел убирается сразу,
  // не дожидаясь fallback-таймаута
  card.dispatchEvent(new window.Event('transitionend'));
  assert.equal(scr.querySelector('[data-act="param-step"]'), null, 'узел убран по transitionend');
  assert.match(scr.textContent, /Отбой: 01:30 → 01:15/);

  // fallback-таймаут затем срабатывает вхолостую (done уже вызван, узел отсоединён) — без сбоев
  await settle();
  assert.equal(scr.querySelector('[data-act="param-step"]'), null);
  assert.match(scr.textContent, /Отбой: 01:30 → 01:15/);
});

test('движение: при reduced-motion карточка уходит немедленно, состояние достижимо без ожидания', async () => {
  const { document, window } = await boot({ seed: paramSeed() });
  window.matchMedia = () => ({ matches: true }); // эмулируем prefers-reduced-motion: reduce
  openReview(document);
  const scr = document.getElementById('scr-review');
  scr.querySelector('[data-act="param-keep"]').click();

  // без ожидания: перерисовка синхронна, класс-триггер не навешивается
  assert.equal(scr.querySelector('.leaving'), null, 'без анимации — без класса-триггера');
  assert.equal(scr.querySelector('[data-act="param-keep"]'), null, 'карточка убрана сразу');
  assert.match(scr.textContent, /Отбой: 01:30, без шага/);
});

test('движение: тихое подтверждение «Сохранено» показывается один раз и гаснет при следующем рендере', async () => {
  const { document } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const addHabit = () => [...document.querySelectorAll('[data-act="add-open"]')].find(b => b.dataset.area === 'habit');
  addHabit().click();
  document.getElementById('f-name').value = 'Растяжка';
  document.querySelector('[data-act="add-save"]').click();

  const flash = document.querySelector('#scr-settings .flash');
  assert.ok(flash, 'подтверждение показано');
  assert.match(flash.textContent, /Сохранено/);
  assert.equal(flash.getAttribute('role'), 'status');

  // следующий рендер (открытие формы) — подтверждения уже нет (разовое)
  [...document.querySelectorAll('[data-act="add-open"]')].find(b => b.dataset.area === 'habit').click();
  assert.equal(document.querySelector('#scr-settings .flash'), null, 'подтверждение разовое');
});

test('движение: reduced-motion в CSS отключает transition и animation полностью', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ''); // убрать комментарии — сверяем только объявления
  const m = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\{([^}]*)\}/);
  assert.ok(m, 'блок prefers-reduced-motion присутствует');
  // transform/scale/translateY доставляются через transition и animation — их
  // отключение гасит и усиленные эффекты 12.1; статичные transform сохраняются
  assert.match(m[1], /transition:\s*none\s*!important/);
  assert.match(m[1], /animation:\s*none\s*!important/);
  assert.doesNotMatch(m[1], /transform:\s*none/); // положение тумблера/галочки не обнуляется
});

test('мёртвый хук: класса on на .rowwrap нет ни в CSS, ни в JS, ни в разметке', async () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const js = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // ни одного селектора .rowwrap...on — гашение названия даёт только .check.on
  assert.doesNotMatch(css, /\.rowwrap[^\s,{]*\.on\b/, 'селектор .rowwrap.on в CSS');
  assert.match(css, /\.check\.on \.tname/, '.check.on .tname — единственный источник гашения');
  // ни шаблона со строкой rowwrap ... on, ни переключения класса на .rowwrap
  assert.doesNotMatch(js, /class="rowwrap[^"]*\bon\b/, 'шаблон rowwrap с классом on');
  assert.doesNotMatch(js, /wrap\.classList\.toggle\('on'/, 'toggle on на узле строки');

  // и в живом DOM: отметка класс на строке не ставит
  const { document } = await boot();
  const cb = document.querySelector('#scr-today input[data-act="mark"]');
  const wrap = cb.closest('.rowwrap');
  cb.click();
  assert.equal(cb.closest('label.check').classList.contains('on'), true, 'label помечен');
  assert.equal(wrap.classList.contains('on'), false, 'строка класса не получает');
});

test('движение 12.1: scale-отклик круга — класс .pop на тап, отсутствует при первичном рендере', async () => {
  const { document } = await boot();
  const cb = document.querySelector('#scr-today input[data-act="mark"]');
  const box = cb.closest('label.check').querySelector('.box');
  assert.equal(box.classList.contains('pop'), false, 'первичный рендер статичен — без .pop');

  cb.click(); // горячий путь: тот же узел, добавляется класс-триггер
  assert.equal(box.classList.contains('pop'), true, 'после тапа — scale-триггер');
  assert.equal(cb.closest('label.check').classList.contains('on'), true, 'отметка поставлена');

  cb.click(); // снятие — тоже отклик (узел не пересоздан)
  assert.equal(box.classList.contains('pop'), true);
  assert.equal(cb.closest('label.check').classList.contains('on'), false);
});

test('движение 12.1: scale-отклик сегодняшней ячейки полосы привычки на тап', async () => {
  const { document } = await boot(); // дефолт: 2 привычки
  document.querySelector('#tabs button[data-tab="habits"]').click();
  const scr = document.getElementById('scr-habits');
  const cell = scr.querySelector('.hstrip i.today');
  assert.equal(cell.classList.contains('pop'), false, 'полоса статична при рендере');
  scr.querySelector('input[data-act="mark"]').click();
  assert.equal(scr.querySelector('.hstrip i.today').classList.contains('pop'), true, 'ячейка получила scale-триггер');
});

test('движение 12.1: при reduced-motion scale-триггер не навешивается, отметка достижима', async () => {
  const { document, window } = await boot();
  window.matchMedia = () => ({ matches: true }); // prefers-reduced-motion: reduce
  const cb = document.querySelector('#scr-today input[data-act="mark"]');
  const box = cb.closest('label.check').querySelector('.box');
  cb.click();
  assert.equal(box.classList.contains('pop'), false, 'без анимации — без класса-триггера');
  assert.equal(cb.closest('label.check').classList.contains('on'), true, 'конечное состояние достижимо');
});

/* Полная и сокращённая дата — теми же формулами, что fmtDay/fmtShort в app.js.
   Задача 13: текст ожидания несёт полный месяц («17 июля»), не «июл..». */
function fmtDayKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
function fmtShortKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d, 12).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

test('тексты ожидания разбора: полная дата понедельника открытия', async () => {
  // ожидание достижимо закрытием недели: лист остаётся открытым (задача 16B)
  const a = await boot({ seed: dueSeed() });
  openReview(a.document);
  closeWeekThroughUi(a.document);
  const textA = a.document.getElementById('scr-review').textContent;
  const monA = addKey(curMonday(), 7);
  assert.ok(textA.includes('Разбор откроется в понедельник, ' + fmtDayKey(monA)), textA);
  assert.doesNotMatch(textA, /\.\./); // без двойной точки «сент..»
  // явная защита формата: сокращённый месяц не используется (в мае формы
  // «мая» совпадают и ловить нечего — вывод корректен в обоих случаях)
  if (fmtShortKey(monA) !== fmtDayKey(monA)) {
    assert.ok(!textA.includes(fmtShortKey(monA)), 'сокращённый месяц («июл.») не используется');
  }

  // переходные дни: calendarSince в будущем — приложение о разборе молчит:
  // ни баннера на «Сегодня», ни открывающей строки на «Прогрессе»
  const trans = dueSeed();
  trans.settings.calendarSince = addKey(curMonday(), 7);
  const b = await boot({ seed: trans });
  assert.equal(b.document.querySelector('[data-act="goto-review"]'), null, 'баннера нет');
  b.document.querySelector('#tabs button[data-tab="progress"]').click();
  const prog = b.document.getElementById('scr-progress');
  assert.equal(prog.querySelector('[data-act="goto-review"]'), null);
  assert.match(prog.textContent, /Следующий разбор — в понедельник/);
});

test('привычка: полоса недели — состояния ячеек, «X из N», тап по полосе игнорируется', async () => {
  const seed = dueSeed();
  seed.items.push({
    id: 'h1', name: 'Привычка', value: null, unit: '', type: 'daily', area: 'habit',
    goal: null, note: '', group: '', active: true, addedAt: addKey(curMonday(), -21),
    raiseAfter: 0, history: []
  });
  seed.days[daysAgo(0)] = Object.assign({}, seed.days[daysAgo(0)], { h1: true }); // сегодня отмечено
  const { document, window } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="habits"]').click();
  const scr = document.getElementById('scr-habits');

  const strip = scr.querySelector('.hstrip');
  assert.ok(strip, 'полоса есть');
  assert.equal(strip.getAttribute('aria-hidden'), 'true'); // счёт недели отдаёт видимый «X из N»
  const cells = [...strip.querySelectorAll('i')];
  assert.equal(cells.length, 7);
  assert.equal([...strip.querySelectorAll('.hd')].map(x => x.textContent).join(' '), 'Пн Вт Ср Чт Пт Сб Вс');

  // индекс сегодняшнего дня в неделе — той же формулой, что mondayOf
  const [y, m, d] = daysAgo(0).split('-').map(Number);
  const idx = (new Date(y, m - 1, d, 12).getDay() + 6) % 7;
  assert.ok(cells[idx].classList.contains('today'), 'сегодняшняя выделена');
  assert.ok(cells[idx].classList.contains('on'), 'сегодня отмечено');
  for (let i = 0; i < 7; i++) {
    assert.equal(cells[i].classList.contains('fut'), i > idx, 'будущие приглушены: ' + i);
  }
  assert.match(scr.querySelector('.hcount').textContent, /^1 из 7$/);

  // тап по ячейке полосы ничего не меняет — полоса пассивна
  cells[0].click();
  cells[idx].click();
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.deepEqual(saved.days[daysAgo(0)], { h1: true });
  assert.match(scr.querySelector('.hcount').textContent, /^1 из 7$/);

  // горячий путь: круг обновляет сегодняшнюю ячейку и «X из N» точечно, без пересоздания полосы
  const cb = [...scr.querySelectorAll('input[data-act="mark"]')].find(i => i.dataset.id === 'h1');
  cb.click(); // снятие сегодняшней отметки
  assert.equal(scr.querySelector('.hstrip'), strip, 'полоса не пересоздана');
  assert.equal(cells[idx].classList.contains('on'), false);
  assert.match(scr.querySelector('.hcount').textContent, /^0 из 7$/);
  assert.match(scr.querySelector('.bar-note').textContent, /сегодня\s*0\s*из\s*1/);
});

test('«Сегодня» не показывает полосу недели, серию и счёт «X из N» (анти-требование)', async () => {
  const seed = dueSeed();
  // min-пункт с полностью отмеченной прошлой неделей — если бы renderToday
  // рендерил привычную разметку, серия и полоса были бы видимы
  for (let i = 0; i < 7; i++) {
    const k = addKey(prevMonday(), i);
    seed.days[k] = Object.assign({}, seed.days[k], { it1: true });
  }
  const { document } = await boot({ seed });
  const scr = document.getElementById('scr-today');
  assert.equal(scr.querySelector('.hweek'), null, 'нет полосы недели');
  assert.equal(scr.querySelector('.hstrip'), null);
  assert.equal(scr.querySelector('.streak'), null, 'нет справки серии');
  assert.equal(scr.querySelector('.hcount'), null, 'нет счёта X из N');
  assert.doesNotMatch(scr.querySelector('.bar-note').textContent, /серия/);
});

test('привычка: «серия M нед» видна при M ≥ 1 и скрыта при нуле; тап сегодня её не трогает', async () => {
  const seed = dueSeed();
  const mkHabit = (id, name) => ({ id, name, value: null, unit: '', type: 'daily', area: 'habit',
    goal: null, note: '', group: '', active: true, addedAt: addKey(prevMonday(), -28), raiseAfter: 0, history: [] });
  seed.items.push(mkHabit('h1', 'С серией'), mkHabit('h2', 'Без серии'));
  for (let i = 0; i < 7; i++) { // прошлая неделя выполнена целиком
    const k = addKey(prevMonday(), i);
    seed.days[k] = Object.assign({}, seed.days[k], { h1: true });
  }
  const { document } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="habits"]').click();
  const scr = document.getElementById('scr-habits');
  const rowOf = name => [...scr.querySelectorAll('.rowwrap')].find(r => r.textContent.includes(name));
  const streakNode = rowOf('С серией').querySelector('.streak');
  assert.match(streakNode.textContent, /серия 1 нед/);
  assert.equal(rowOf('Без серии').querySelector('.streak'), null, 'при нуле скрыта');

  // сегодняшний тап не меняет и не пересоздаёт справку серии (текущая неделя не в серии)
  rowOf('С серией').querySelector('input[data-act="mark"]').click();
  assert.equal(rowOf('С серией').querySelector('.streak'), streakNode);
  assert.match(streakNode.textContent, /серия 1 нед/);
});

test('привычка из формы «Пункты» сразу несёт normPerWeek: 7 (каноническая форма)', async () => {
  const { document, window } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const addHabit = [...document.querySelectorAll('[data-act="add-open"]')].find(b => b.dataset.area === 'habit');
  addHabit.click();
  document.getElementById('f-name').value = 'Медитация';
  document.querySelector('[data-act="add-save"]').click();
  const saved = JSON.parse(window.localStorage.getItem(NS));
  const h = saved.items.find(i => i.name === 'Медитация');
  assert.equal(h.normPerWeek, 7); // поле присутствует в store и в экспорте той же сессии
});

test('привычка: степпер нормы — границы 1 и 7, сохранение', async () => {
  const { document, window } = await boot(); // программа посева: одна ежедневная привычка
  document.querySelector('#tabs button[data-tab="settings"]').click();
  [...document.querySelectorAll('[data-act="edit-open"]')]
    .find(b => b.textContent.includes('Телефон вне кровати')).click();
  const form = () => document.querySelector('#scr-settings .card.form');
  assert.match(form().textContent, /Норма в неделю: 7/);
  assert.equal(document.querySelector('[data-act="norm-inc"]').disabled, true, 'верхняя граница 7');

  for (let i = 0; i < 8; i++) { // вниз до упора — останавливается на 1
    const dec = document.querySelector('[data-act="norm-dec"]');
    if (!dec || dec.disabled) break;
    dec.click();
  }
  assert.match(form().textContent, /Норма в неделю: 1/);
  assert.equal(document.querySelector('[data-act="norm-dec"]').disabled, true, 'нижняя граница 1');
  assert.equal(document.querySelector('[data-act="norm-inc"]').disabled, false);

  document.querySelector('[data-act="norm-inc"]').click(); // 1 → 2
  document.querySelector('[data-act="edit-save"]').click();
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.items.find(i => i.name === 'Телефон вне кровати').normPerWeek, 2);

  // сохранённая норма отражается на полосе «Привычек»: «X из N» с N ≠ 7
  document.querySelector('#tabs button[data-tab="habits"]').click();
  const hrow = [...document.querySelectorAll('#scr-habits .rowwrap')]
    .find(r => r.textContent.includes('Телефон вне кровати'));
  assert.match(hrow.querySelector('.hcount').textContent, /из 2$/);
});

test('разбор: строки привычек — «X из N · серия M нед» либо просто «X из N»', async () => {
  const seed = dueSeed();
  const prev = prevMonday();
  const mkHabit = (id, name, norm) => ({ id, name, value: null, unit: '', type: 'daily', area: 'habit',
    normPerWeek: norm, goal: null, note: '', group: '', active: true, addedAt: addKey(prev, -28), raiseAfter: 0, history: [] });
  seed.items.push(mkHabit('ha', 'Выполненная', 5), mkHabit('hb', 'Прерванная', 7), mkHabit('hc', 'Нулевая', 7));
  const put = (k, id) => { seed.days[k] = Object.assign({}, seed.days[k], { [id]: true }); };
  for (let i = 0; i < 5; i++) { put(addKey(prev, i), 'ha'); put(addKey(prev, i - 7), 'ha'); } // 5 и 5 при норме 5
  for (let i = 0; i < 7; i++) put(addKey(prev, i - 7), 'hb'); // неделя до — полная
  put(addKey(prev, 0), 'hb'); put(addKey(prev, 1), 'hb');     // разбираемая — 2 из 7
  put(addKey(prev, 2), 'hc');                                  // 1 из 7, серии не было
  const { document } = await boot({ seed });
  openReview(document);
  const scr = document.getElementById('scr-review');
  const text = scr.textContent;
  assert.match(text, /Выполненная: 5 из 5 · серия 2 нед/);
  assert.match(text, /Нулевая: 1 из 7/);
  assert.doesNotMatch(text, /Нулевая: 1 из 7 ·/); // без хвоста при нулевой серии до

  // задача 15: строка прерывания серии упразднена вместе с тоном --warn —
  // невыполненная неделя сообщается счётом и молчанием
  assert.match(text, /Прерванная: 2 из 7/);
  assert.doesNotMatch(text, /Прерванная: 2 из 7 ·/);
  assert.doesNotMatch(text, /прервана/);
  assert.equal(scr.querySelector('.broken'), null);
});

test('разбор: готовность к новой привычке при норме < 7', async () => {
  const seed = dueSeed();
  seed.items.push({ id: 'h1', name: 'Пять раз', value: null, unit: '', type: 'daily', area: 'habit',
    normPerWeek: 5, goal: null, note: '', group: '', active: true, addedAt: addKey(prevMonday(), -28), raiseAfter: 0, history: [] });
  // A.5.1: готовность считается по days{} двух последних календарных недель
  fillWeek(seed.days, 'h1', addKey(prevMonday(), -7), 5); // позапрошлая: 5 при норме 5
  fillWeek(seed.days, 'h1', prevMonday(), 6);             // прошлая: 6
  seed.reviews = []; // разборов нет вовсе — на готовность это не влияет
  const { document } = await boot({ seed });
  openReview(document);
  assert.match(document.getElementById('scr-review').textContent, /Привычки устойчивы 2 недели — можно добавить новую/);
});

test('раздел «Данные»: пассивная строка вместо императива', async () => {
  const { document } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const text = document.getElementById('scr-settings').textContent;
  assert.match(text, /Все данные — на этом устройстве/);
  assert.doesNotMatch(text, /Экспортируйте данные/);
});

test('зеркало: save + flush кладут актуальный снапшот в IndexedDB', async () => {
  const idb = new IDBFactory();
  const { document, window } = await boot({ idb });
  const cb = document.querySelector('input[data-act="mark"]');
  cb.click(); // save → дебаунс-план; flush форсирует запись
  await window.flushMirror();
  const snap = await idbGet(idb);
  assert.ok(snap, 'снапшот есть');
  assert.equal(typeof snap.savedAt, 'number');
  assert.equal(snap.schemaVersion, SCHEMA_VERSION);
  const marks = Object.values(JSON.parse(snap.json).days)[0];
  assert.equal(marks[cb.dataset.id], true); // актуальное состояние с отметкой
});

test('пустой localStorage + снапшот в зеркале → тихое восстановление', async () => {
  const idb = new IDBFactory();
  await idbPut(idb, { json: JSON.stringify(mirrorStore()), savedAt: Date.now(), schemaVersion: 4 });
  const { document, window } = await boot({ idb });
  assert.match(document.getElementById('scr-today').textContent, /Восстановленный/);
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].name, 'Восстановленный'); // localStorage восстановлен из зеркала
});

test('битый localStorage + валидное зеркало → corrupt-ключ и восстановление, не дефолт', async () => {
  const idb = new IDBFactory();
  await idbPut(idb, { json: JSON.stringify(mirrorStore()), savedAt: Date.now(), schemaVersion: 4 });
  const { document, window } = await boot({ idb, raw: '{битый json' });
  assert.equal(JSON.parse(window.localStorage.getItem('minimum:data:corrupt')).raw, '{битый json');
  assert.match(document.getElementById('scr-today').textContent, /Восстановленный/);
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items.length, 1); // не дефолтные 7
});

test('пустое зеркало → дефолт в зеркале; непустое дефолтом НЕ затирается', async () => {
  // пустой LS + пустое зеркало: после init (и flush дебаунса) — дефолтный снапшот
  const empty = new IDBFactory();
  const a = await boot({ idb: empty });
  await a.window.flushMirror();
  const defSnap = await idbGet(empty);
  assert.ok(defSnap);
  assert.equal(JSON.parse(defSnap.json).items.length, 9);

  // пустой LS + непустое зеркало: порядок bootstrap — сначала чтение, потом запись
  const seeded = new IDBFactory();
  await idbPut(seeded, { json: JSON.stringify(mirrorStore()), savedAt: 111, schemaVersion: 4 });
  const b = await boot({ idb: seeded });
  await b.window.flushMirror();
  const snap = await idbGet(seeded);
  const data = JSON.parse(snap.json);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].name, 'Восстановленный'); // снапшот не затёрт дефолтом
});

test('indexedDB отсутствует → прежнее поведение, без исключений', async () => {
  const { document, window } = await boot(); // window.indexedDB не определён
  assert.equal(document.querySelectorAll('input[data-act="mark"]').length, 6);
  assert.equal(await window.flushMirror(), false);
  document.querySelector('#tabs button[data-tab="settings"]').click();
  assert.equal(document.getElementById('mirror-note').hidden, true); // строка копии не показана
});

test('pagehide сбрасывает недописанный дебаунс-снапшот в зеркало', async () => {
  const idb = new IDBFactory();
  // предмет теста — «сброс идёт РАНЬШЕ дебаунса», поэтому дебаунс здесь
  // намеренно длинный: короткий не отличить от «просто дождались» (23, п. 1.4)
  const { document, window } = await boot({ idb, timing: { MIRROR_FLUSH_MS: 5000 } });
  document.querySelector('input[data-act="mark"]').click(); // дебаунс ещё не истёк
  window.dispatchEvent(new window.Event('pagehide'));
  await wait(50); // много меньше дебаунса
  const snap = await idbGet(idb);
  assert.ok(snap, 'flush по pagehide записал снапшот до истечения дебаунса');
  const marks = Object.values(JSON.parse(snap.json).days)[0];
  assert.ok(marks, 'снапшот содержит несброшенную отметку');
});

test('снапшот старой схемы в зеркале проходит migrate при восстановлении', async () => {
  const idb = new IDBFactory();
  const oldStore = mirrorStore();
  oldStore.schemaVersion = 2; // v2-снапшот: без weekStart в reviews и exportedAt
  delete oldStore.settings.exportedAt;
  oldStore.reviews = [{ closedAt: 1, keys: [daysAgo(20)], perItem: {}, trainings: {}, oneChange: '', raises: [] }];
  await idbPut(idb, { json: JSON.stringify(oldStore), savedAt: Date.now(), schemaVersion: 2 });

  const { document, window } = await boot({ idb });

  assert.match(document.getElementById('scr-today').textContent, /Восстановленный/);
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.schemaVersion, SCHEMA_VERSION);                    // migrate прогнан
  assert.equal(saved.reviews[0].weekStart, daysAgo(20));   // backfill v2→v3
  assert.equal(saved.settings.exportedAt, null);           // мягкий дефолт v3→v4
});

test('уход в фон (visibilitychange→hidden) сбрасывает зеркало немедленно', async () => {
  const idb = new IDBFactory();
  const { document, window } = await boot({ idb, timing: { MIRROR_FLUSH_MS: 5000 } }); // см. выше
  document.querySelector('input[data-act="mark"]').click(); // дебаунс ещё не истёк
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  await wait(50); // много меньше дебаунса
  const snap = await idbGet(idb);
  assert.ok(snap, 'flush по уходу в фон записал снапшот');
  assert.ok(Object.values(JSON.parse(snap.json).days)[0], 'снапшот содержит отметку');
});

test('exportedAt ставится при экспорте, строки «Данных» рендерятся', async () => {
  const { document, window } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  assert.match(document.getElementById('scr-settings').textContent, /Экспорта ещё не было/);

  window.URL.createObjectURL = () => 'blob:fake'; // в jsdom не реализовано
  window.URL.revokeObjectURL = () => {};
  document.querySelector('[data-act="export"]').click();

  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(typeof saved.settings.exportedAt, 'number');
  // задача 25, п. 9: приложение знает лишь то, что скачивание ЗАПУЩЕНО —
  // сохранил ли владелец файл, в вебе узнать нечем. Строка не утверждает
  // больше: «Последний экспорт» обещал состоявшийся файл, «запускался» — нет
  assert.match(document.getElementById('scr-settings').textContent, /Экспорт запускался:/);
  assert.doesNotMatch(document.getElementById('scr-settings').textContent, /Последний экспорт/);
});

test('строка «Резервная копия» подставляется асинхронно из savedAt зеркала', async () => {
  const idb = new IDBFactory();
  await idbPut(idb, { json: JSON.stringify(mirrorStore()), savedAt: Date.now(), schemaVersion: 4 });
  const { document, window } = await boot({ idb });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const note = document.getElementById('mirror-note');
  for (let i = 0; i < 100 && note.hidden; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /Резервная копия: /);
});

/* ── Задача 14. Формула и лестница ─────────────────────────── */

const LADDER = { steps: ['в кровати в 23:30', '+10 минут без экрана', '+15 минут раньше'], step: 1, steppedWeek: null, startedAt: null };

/* Вход в лист с «Пунктов» — из формы правки пункта (задача 14.2) */
function openDetailFromItems(document, name) {
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const row = [...document.querySelectorAll('#scr-settings .rowwrap')]
    .find(r => r.querySelector('.tname').textContent === name);
  row.querySelector('[data-act="edit-open"]').click();
  document.querySelector('#scr-settings .card.form [data-act="item-detail"]').click();
  return document.getElementById('scr-detail');
}

test('строка дня: тап по названию отмечает пункт, хвостовая кнопка открывает лист', async () => {
  const seed = dueSeed();
  seed.items[0].note = 'подпись владельца';
  seed.items[0].ladder = JSON.parse(JSON.stringify(LADDER));
  const { document, window } = await boot({ seed });
  const scr = document.getElementById('scr-today');

  // подписью идёт текущая ступень вместо note, метка — в хвостовой кнопке
  assert.match(scr.textContent, /\+10 минут без экрана/);
  assert.doesNotMatch(scr.textContent, /подпись владельца/);
  assert.equal(scr.querySelector('.idetail .lstep').textContent, '2/3');

  // название снова внутри label: тап по нему отмечает пункт (тач-зона всей строки)
  const label = scr.querySelector('label.check');
  assert.ok(label.querySelector('.tname'), 'название внутри label');
  assert.equal(label.querySelector('input[data-act="mark"]').getAttribute('aria-label'), null,
    'имя чекбоксу даёт содержимое label, aria-label не дублируется');
  scr.querySelector('.tname').click(); // тап по названию
  assert.equal(label.classList.contains('on'), true, 'пункт отмечен');
  assert.equal(document.getElementById('scr-detail').hidden, true, 'лист не открылся');
  assert.equal(Object.values(JSON.parse(window.localStorage.getItem(NS)).days[daysAgo(0)])[0], true);

  // хвостовая кнопка открывает лист и отметку не меняет
  scr.querySelector('[data-act="item-detail"]').click();
  const d = document.getElementById('scr-detail');
  assert.equal(d.hidden, false);
  assert.equal(scr.hidden, true);
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).days[daysAgo(0)][seed.items[0].id], true,
    'отметка не изменилась');
  assert.equal(d.querySelectorAll('.ladder li').length, 3);
  assert.equal(d.querySelectorAll('.ladder li.cur').length, 1);
  assert.match(d.querySelector('.ladder li.cur').textContent, /\+10 минут без экрана/);
  // строка состояния лестницы говорит счёт по норме этого пункта (задача 24,
  // п. 3): area min → 6 из 7. Отметок: сегодняшняя (тап выше) и две в
  // разбираемой неделе — прежний текст «Две полные недели…» ничего не считал
  assert.match(d.textContent, /Эта неделя 1 из 6, прошлая 2 из 6/);
  assert.equal(d.querySelector('[data-act="ladder-fwd"]').disabled, true);
  assert.equal(d.querySelector('[data-act="ladder-back"]').disabled, false);
  // вкладка возврата остаётся подсвеченной
  assert.equal(document.querySelector('#tabs button[data-tab="today"]').getAttribute('aria-current'), 'page');

  // «Готово» возвращает на прежнюю вкладку
  d.querySelector('[data-act="detail-done"]').click();
  assert.equal(d.hidden, true);
  assert.equal(document.getElementById('scr-today').hidden, false);
  assert.equal(scr.querySelector('label.check').classList.contains('on'), true, 'отметка на месте');
});

test('хвостовая кнопка: нет без лестницы и формулы, есть при одной формуле', async () => {
  const seed = dueSeed();
  seed.items[0].note = 'подпись владельца';
  seed.items.push({
    id: 'it2', name: 'С формулой', value: null, unit: '', type: 'daily', area: 'min',
    goal: null, note: '', group: '', active: true, addedAt: addKey(prevMonday(), -14), raiseAfter: 0,
    history: [], formula: { anchor: 'после зарядки', when: '', pair: '', identity: '', twoMin: '', friction: '', proof: '' },
    ladder: null, ladderLog: []
  });
  const { document } = await boot({ seed });
  const rowOf = name => [...document.querySelectorAll('#scr-today .rowwrap')]
    .find(r => r.textContent.includes(name));

  const plain = rowOf('Тестовый пункт');
  assert.equal(plain.querySelector('.idetail'), null, 'без лестницы и формулы хвоста нет');
  assert.equal(plain.querySelector('.lstep'), null);
  assert.match(plain.querySelector('.note').textContent, /подпись владельца/);

  const withFormula = rowOf('С формулой');
  const tail = withFormula.querySelector('.idetail');
  assert.ok(tail, 'при формуле хвост есть');
  assert.equal(tail.querySelector('.lstep'), null, 'метки положения без лестницы нет');
  assert.match(tail.getAttribute('aria-label'), /^подробно: «С формулой»$/);

  // в строке «Пунктов» кнопки листа нет — вход через форму правки (14.2)
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const itemsRow = [...document.querySelectorAll('#scr-settings .rowwrap')]
    .find(r => r.querySelector('.tname').textContent === 'Тестовый пункт');
  assert.equal(itemsRow.querySelector('[data-act="item-detail"]'), null, 'в строке списка кнопки нет');
  assert.equal(itemsRow.querySelectorAll('.ictl .btn').length, 2, 'в кластере только стрелки');

  const d = openDetailFromItems(document, 'Тестовый пункт');
  assert.equal(d.hidden, false);
  assert.equal(d.querySelector('.ladder'), null, 'блока лестницы нет');
  assert.equal(d.querySelectorAll('.fline').length, 7);
  assert.equal(d.querySelectorAll('.fval.empty').length, 7);
  const laws = [...d.querySelectorAll('.overline')].map(x => x.textContent);
  assert.deepEqual(laws, ['Очевидно', 'Привлекательно', 'Легко', 'Приятно']);
  assert.ok(d.querySelector('[data-act="ladder-open"]'));

  // «Готово» возвращает на «Пункты», и форма правки осталась открытой (14.2)
  d.querySelector('[data-act="detail-done"]').click();
  assert.equal(document.getElementById('scr-settings').hidden, false);
  assert.equal(d.hidden, true);
  assert.ok(document.getElementById('e-name'), 'форма правки осталась открытой');
  assert.equal(document.getElementById('e-name').value, 'Тестовый пункт');
});

test('«Пункты»: кнопка листа есть в форме daily, нет у weekly и param', async () => {
  const { document, window } = await boot(); // дефолт: daily, weekly «Тренировка», param «Отбой»
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const openEdit = name => {
    const cancel = document.querySelector('[data-act="edit-cancel"]');
    if (cancel) cancel.click();
    [...document.querySelectorAll('#scr-settings .rowwrap')]
      .find(r => r.querySelector('.tname').textContent === name)
      .querySelector('[data-act="edit-open"]').click();
    return document.querySelector('#scr-settings .card.form');
  };

  const daily = openEdit('Умыться');
  const btn = daily.querySelector('[data-act="item-detail"]');
  assert.ok(btn, 'у ежедневного пункта кнопка есть');
  assert.match(btn.textContent, /^Формула и лестница/);
  // стоит над кластером «Сохранить / Отмена», отделена от полей
  assert.ok(btn.closest('.btns').classList.contains('dfoot'));
  assert.equal(btn.closest('.btns').nextElementSibling.querySelector('[data-act="edit-save"]') !== null, true);

  assert.equal(openEdit('Тренировка').querySelector('[data-act="item-detail"]'), null, 'у weekly кнопки нет');
  assert.equal(openEdit('Отбой').querySelector('[data-act="item-detail"]'), null, 'у param кнопки нет');

  // ни в одной строке списка кнопки листа нет
  document.querySelector('[data-act="edit-cancel"]').click();
  assert.equal(document.querySelectorAll('#scr-settings .row.item [data-act="item-detail"]').length, 0);
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).schemaVersion, SCHEMA_VERSION);
});

test('лестница на привычке: «Шагнуть» по двум неделям, шаг назад, журнал', async () => {
  const seed = dueSeed();
  const prev = prevMonday();
  seed.items.push({
    id: 'h1', name: 'Отбой', value: null, unit: '', type: 'daily', area: 'habit', normPerWeek: 7,
    goal: null, note: '', group: '', active: true, addedAt: addKey(prev, -28), raiseAfter: 0, history: [],
    formula: null, ladder: JSON.parse(JSON.stringify({ ...LADDER, step: 0 })), ladderLog: []
  });
  for (let i = 0; i < 7; i++) { // две последние завершённые недели — по норме
    for (const k of [addKey(prev, i), addKey(prev, i - 7)]) {
      seed.days[k] = Object.assign({}, seed.days[k], { h1: true });
    }
  }
  const { document, window } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="habits"]').click();
  const scr = document.getElementById('scr-habits');
  assert.equal(scr.querySelector('.lstep').textContent, '1/3');

  scr.querySelector('[data-act="item-detail"]').click();
  const d = document.getElementById('scr-detail');
  assert.match(d.textContent, /Ступень держится две недели — можно шагнуть/);
  assert.equal(d.querySelector('[data-act="ladder-fwd"]').disabled, false);
  assert.equal(d.querySelector('[data-act="ladder-back"]').disabled, true, 'на первой ступени назад некуда');

  d.querySelector('[data-act="ladder-fwd"]').click();
  assert.match(d.querySelector('.ladder li.cur').textContent, /\+10 минут без экрана/);
  assert.match(d.textContent, /Шаг уже сделан на этой неделе/);
  assert.equal(d.querySelector('[data-act="ladder-fwd"]').disabled, true, 'второй шаг за неделю закрыт');
  // журнал: старт достроен миграцией v7→v8 (у сида ladderLog пуст), шаг — рядом
  let saved = JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.id === 'h1');
  assert.equal(saved.ladder.step, 1);
  assert.equal(saved.ladder.steppedWeek, curMonday());
  assert.deepEqual(saved.ladderLog, [
    { date: daysAgo(0), step: 0, text: 'в кровати в 23:30', start: true },
    { date: daysAgo(0), step: 1, text: '+10 минут без экрана' }
  ]);

  // шаг назад доступен всегда и неделю не тратит; запись того же дня заменяется,
  // но стартовая неприкосновенна — она остаётся первой
  d.querySelector('[data-act="ladder-back"]').click();
  saved = JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.id === 'h1');
  assert.equal(saved.ladder.step, 0);
  assert.equal(saved.ladder.steppedWeek, curMonday());
  assert.deepEqual(saved.ladderLog, [
    { date: daysAgo(0), step: 0, text: 'в кровати в 23:30', start: true },
    { date: daysAgo(0), step: 0, text: 'в кровати в 23:30' }
  ]);
  assert.equal(d.querySelector('[data-act="ladder-fwd"]').disabled, true);

  // журнал шагов — типографской строкой, только в листе (задача 14.1).
  // Старт показывается обычной ступенью; шаги того же дня схлопнулись в один
  assert.equal(d.querySelector('.lhist').textContent, `Ступень: 1 → 1 · с ${fmtShortKey(daysAgo(0))}`);
  assert.equal(document.getElementById('scr-habits').querySelector('.lhist'), null,
    'на дневной экран журнал не выносится');

  // лист вернулся на «Привычки», метка обновилась
  d.querySelector('[data-act="detail-done"]').click();
  assert.equal(document.getElementById('scr-habits').hidden, false);
  assert.equal(scr.querySelector('.lstep').textContent, '1/3');
});

test('журнал лестницы: строки нет при пустом ladderLog, при длинной истории — последние 6', async () => {
  // схема уже v8 — шаг миграции пропущен, журнал остаётся пустым
  const seed = Object.assign(dueSeed(), { schemaVersion: 8 });
  seed.items[0].ladder = JSON.parse(JSON.stringify({ ...LADDER, step: 0 }));
  seed.items[0].ladderLog = [];
  const { document } = await boot({ seed });
  let d = document.getElementById('scr-detail');
  document.querySelector('#scr-today [data-act="item-detail"]').click();
  assert.ok(d.querySelector('.ladder'), 'блок лестницы есть');
  assert.equal(d.querySelector('.lhist'), null, 'без записей строки нет');

  // восемь переходов: показываются последние шесть, дата — первой записи
  const seed2 = dueSeed();
  seed2.items[0].ladder = JSON.parse(JSON.stringify({ ...LADDER, step: 0 }));
  seed2.items[0].ladderLog = [0, 1, 2, 1, 0, 1, 2, 1].map((step, i) => ({
    date: addKey(prevMonday(), i), step, text: 'ступень'
  }));
  const b = await boot({ seed: seed2 });
  d = b.document.getElementById('scr-detail');
  b.document.querySelector('#scr-today [data-act="item-detail"]').click();
  const hist = d.querySelector('.lhist');
  assert.match(hist.textContent, /^Ступень: … → 3 → 2 → 1 → 2 → 3 → 2 · с /); // последние 6, ступени с единицы
  assert.match(hist.textContent, new RegExp(fmtShortKey(prevMonday()).replace('.', '\\.') + '$')); // дата первой записи
  assert.equal(d.querySelector('.lhist svg, .lhist i'), null, 'без графики');
});

test('лист детали: форма формулы сохраняется и переживает смену логического дня', async () => {
  const { document, window } = await boot();
  // у пункта без лестницы и формулы хвоста нет — вход с «Пунктов»
  const d = openDetailFromItems(document, 'Умыться');
  const id = d.querySelector('[data-act="formula-open"]').dataset.id;

  d.querySelector('[data-act="formula-open"]').click();
  assert.ok(document.getElementById('fx-anchor'));
  assert.equal(d.querySelectorAll('.card.form.formula .hint').length, 7, 'подсказки — только в форме');
  assert.match(d.querySelector('.hint').textContent, /„После того как поставлю телефон на зарядку“ — якорь/);
  document.getElementById('fx-anchor').value = '  после зарядки  ';
  document.getElementById('fx-identity').value = 'я человек, который ложится вовремя';

  // черновик формы переживает смену логического дня (инвариант 8)
  shiftWindowDate(window, 24 * 3600000);
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(document.getElementById('fx-anchor').value, '  после зарядки  ');
  assert.equal(document.getElementById('scr-detail').hidden, false, 'лист остался открытым');

  document.querySelector('[data-act="formula-save"]').click();
  const it = JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.id === id);
  assert.equal(it.formula.anchor, 'после зарядки'); // trim
  assert.equal(it.formula.identity, 'я человек, который ложится вовремя');
  assert.equal(it.formula.proof, '');
  assert.equal(document.getElementById('fx-anchor'), null, 'форма закрыта');
  assert.match(d.textContent, /после зарядки/);
  assert.equal(d.querySelectorAll('.fval.empty').length, 5); // заполнены два поля из семи
  // «Готово» вернуло на «Пункты»; на дневном экране — только слова владельца,
  // но появился хвост: у пункта теперь есть формула
  d.querySelector('[data-act="detail-done"]').click();
  assert.equal(document.getElementById('scr-settings').hidden, false);
  document.querySelector('#tabs button[data-tab="today"]').click();
  const scr = document.getElementById('scr-today');
  assert.doesNotMatch(scr.textContent, /после зарядки|якорь/i);
  const row = [...scr.querySelectorAll('.rowwrap')].find(r => r.textContent.includes('Умыться'));
  assert.ok(row.querySelector('.idetail'), 'формула проявила хвостовую кнопку');
});

test('лист детали: форма лестницы — предзаполнение, сохранение, второй пункт заблокирован', async () => {
  const { document, window } = await boot();
  // вход с «Пунктов»: у пунктов пока нет ни лестницы, ни формулы
  const openByName = name => {
    if (!document.getElementById('scr-detail').hidden) {
      document.querySelector('[data-act="detail-done"]').click();
    }
    return openDetailFromItems(document, name);
  };
  const d = openByName('Умыться');
  const idA = d.querySelector('[data-act="ladder-open"]').dataset.id;

  d.querySelector('[data-act="ladder-open"]').click();
  const ta = document.getElementById('fx-steps');
  assert.ok(ta, 'textarea лестницы');
  assert.match(ta.value, /^В 23:30 быть в кровати\. Телефон — на зарядке вне спальни\./);
  assert.equal(ta.value.split('\n').length, 5, 'стартовый текст — пять строк');
  ta.value = 'раз\n\n  два  \nтри';
  document.querySelector('[data-act="ladder-save"]').click();

  let saved = JSON.parse(window.localStorage.getItem(NS));
  let a = saved.items.find(i => i.id === idA);
  assert.deepEqual(a.ladder.steps, ['раз', 'два', 'три']); // пустые строки отброшены, trim
  assert.equal(a.ladder.step, 0);
  assert.equal(a.ladder.steppedWeek, null);
  assert.equal(a.ladder.startedAt, daysAgo(0));
  // создание пишет стартовую запись: путь читается с первой ступени (14.2)
  assert.deepEqual(a.ladderLog, [{ date: daysAgo(0), step: 0, text: 'раз', start: true }]);
  assert.equal(d.querySelectorAll('.ladder li').length, 3);
  assert.equal(d.querySelector('.lhist').textContent, `Ступень: 1 · с ${fmtShortKey(daysAgo(0))}`);

  // второй пункт: слот занят — textarea и сохранение недоступны, строка объясняет
  const busy = openByName('Принять душ');
  busy.querySelector('[data-act="ladder-open"]').click();
  assert.equal(document.getElementById('fx-steps').disabled, true);
  assert.equal(busy.querySelector('[data-act="ladder-save"]').disabled, true);
  assert.match(busy.textContent, /Лестница уже есть у пункта «Умыться»\. Снимите её там, чтобы начать здесь\./);

  // снятие у носителя — вторым тапом; лестница слетает, отметки целы
  openByName('Умыться').querySelector('[data-act="ladder-open"]').click();
  const clear = () => document.querySelector('[data-act="ladder-clear"]');
  assert.match(clear().textContent, /^Снять лестницу$/);
  clear().click();
  assert.match(clear().textContent, /Подтвердить снятие/);
  assert.ok(JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.id === idA).ladder, 'первый тап не снимает');
  clear().click();
  saved = JSON.parse(window.localStorage.getItem(NS));
  a = saved.items.find(i => i.id === idA);
  assert.equal(a.ladder, null);
  assert.equal(document.getElementById('scr-detail').querySelector('.ladder'), null);
});

/* ── Задача 15. Цепочки ────────────────────────────────────── */

/* Сид с блоком из трёх пунктов минимума и блоком из одного */
function chainSeed() {
  const seed = dueSeed();
  seed.schemaVersion = 10;
  seed.groups = [{ name: 'Вечер' }, { name: 'Утро' }];
  const mk = (id, name, group) => ({
    id, name, value: null, unit: '', type: 'daily', area: 'min', goal: null, note: '', group,
    active: true, addedAt: addKey(prevMonday(), -14), raiseAfter: 0, history: [],
    formula: null, ladder: null, ladderLog: []
  });
  seed.items = [mk('c1', 'Свет', 'Вечер'), mk('c2', 'Душ', 'Вечер'), mk('c3', 'Книга', 'Вечер'),
    mk('s1', 'Один', 'Утро'), mk('n1', 'Без группы', '')];
  seed.days = {};
  return seed;
}

test('блок: линия есть при двух и более активных пунктах и не зависит от отметок', async () => {
  const { document, window } = await boot({ seed: chainSeed() });
  const scr = document.getElementById('scr-today');
  const rows = () => [...scr.querySelectorAll('.rowwrap')];
  const rowOf = name => rows().find(r => r.textContent.includes(name));
  const cb = id => [...scr.querySelectorAll('input[data-act="mark"]')].find(i => i.dataset.id === id);

  // блок «Вечер» из трёх пунктов — одна цепочка, у каждой строки по две половины
  assert.equal(scr.querySelectorAll('.chain').length, 1);
  assert.equal(scr.querySelectorAll('.chain > .rowwrap').length, 3);
  assert.equal(scr.querySelectorAll('.cseg').length, 6);
  assert.equal(scr.querySelectorAll('.cseg.on').length, 0, 'состояния у линии больше нет');

  // блок из одного активного пункта и пункт без блока линии не имеют
  assert.equal(rowOf('Один').querySelector('.cseg'), null);
  assert.equal(rowOf('Один').closest('.chain'), null);
  assert.equal(rowOf('Без группы').querySelector('.cseg'), null);

  // отметки на линию не влияют: ни на наличие, ни на класс
  cb('c1').click();
  cb('c2').click();
  assert.equal(scr.querySelectorAll('.cseg').length, 6);
  assert.equal(scr.querySelectorAll('.cseg.on').length, 0);
  cb('c1').click();
  assert.equal(scr.querySelectorAll('.cseg').length, 6);

  // выключенный пункт из блока выпадает: остаётся два — линия ещё есть
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.groups.every(g => !('chain' in g)), true);
});

test('блок: выключение пунктов убирает линию, когда активным остаётся один', async () => {
  const { document } = await boot({ seed: chainSeed() });
  const off = id => {
    document.querySelector('#tabs button[data-tab="settings"]').click();
    [...document.querySelectorAll('#scr-settings .row.item input[data-act="toggle-active"]')]
      .find(i => i.dataset.id === id).click();
    document.querySelector('#tabs button[data-tab="today"]').click();
  };
  const scr = () => document.getElementById('scr-today');

  off('c3');
  assert.equal(scr().querySelectorAll('.chain').length, 1, 'двое — линия есть');
  assert.equal(scr().querySelectorAll('.cseg').length, 4);

  off('c2');
  assert.equal(scr().querySelectorAll('.chain').length, 0, 'один — линии нет');
  assert.equal(scr().querySelectorAll('.cseg').length, 0);
  assert.match(scr().textContent, /Свет/); // сам пункт на месте
});

test('блок: обводка круга — --chain в блоке, --control-border вне, отмеченный — --accent', async () => {
  const { document } = await boot({ seed: chainSeed() });
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // правило обводки существует и не трогает отмеченный круг
  assert.match(css, /\.chain \.check:not\(\.on\) \.box\s*\{[^}]*border-color:\s*var\(--chain\)/);
  assert.match(css, /\.check\.on \.box\s*\{[^}]*border-color:\s*var\(--accent\)/);
  assert.match(css, /\.check \.box\s*\{[^}]*border:\s*1\.5px solid var\(--control-border\)/);

  // и в живом DOM: круг блока внутри .chain, круг одиночного пункта — нет
  const scr = document.getElementById('scr-today');
  const rowOf = name => [...scr.querySelectorAll('.rowwrap')].find(r => r.textContent.includes(name));
  assert.ok(rowOf('Свет').closest('.chain'), 'пункт блока внутри .chain');
  assert.equal(rowOf('Один').closest('.chain'), null);
  const box = rowOf('Свет').querySelector('.box');
  assert.ok(box.closest('.chain'));
  assert.equal(box.closest('label').classList.contains('on'), false);
});

test('цепочка: порядок групп следует store.groups, безгруппные — последними', async () => {
  const seed = chainSeed();
  seed.groups = [{ name: 'Утро', chain: false }, { name: 'Вечер', chain: true }]; // обратный порядок
  const { document } = await boot({ seed });
  const scr = document.getElementById('scr-today');
  const labels = [...scr.querySelectorAll('.g-label')].map(x => x.textContent);
  assert.deepEqual(labels, ['Утро', 'Вечер']);
  const names = [...scr.querySelectorAll('.rowwrap .tname')].map(x => x.textContent.trim());
  assert.deepEqual(names, ['Один', 'Свет', 'Душ', 'Книга', 'Без группы']); // безгруппный последним
  // у безгруппного заголовка нет
  const last = [...scr.querySelectorAll('.rowwrap')].pop();
  assert.equal(last.previousElementSibling.classList.contains('g-label'), false);
});

test('цепочка: «Привычки» и «Сегодня» рендерятся с цепочкой и без неё без исключений', async () => {
  const seed = chainSeed();
  seed.items.push({
    id: 'h1', name: 'Привычка', value: null, unit: '', type: 'daily', area: 'habit', normPerWeek: 7,
    goal: null, note: '', group: 'Вечер', active: true, addedAt: addKey(prevMonday(), -14),
    raiseAfter: 0, history: [], formula: null, ladder: null, ladderLog: []
  });
  const { document } = await boot({ seed });
  for (const tab of ['today', 'habits', 'progress', 'notes', 'settings']) {
    document.querySelector(`#tabs button[data-tab="${tab}"]`).click();
    assert.ok(document.getElementById('scr-' + tab).innerHTML.length > 0, tab);
  }
  openReview(document); // лист разбора — тем же сидом, тоже без исключений
  assert.ok(document.getElementById('scr-review').innerHTML.length > 0);
  document.querySelector('[data-act="review-done"]').click();
  // одинокая привычка в группе-цепочке линии не получает (4.6)
  document.querySelector('#tabs button[data-tab="habits"]').click();
  assert.equal(document.querySelectorAll('#scr-habits .cseg').length, 0);
  assert.match(document.getElementById('scr-habits').textContent, /Вечер/);
});

test('редактор блоков: строка — имя и стрелки, правка раскрывается тапом', async () => {
  const { document, window } = await boot({ seed: chainSeed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  const blocks = () => [...document.querySelectorAll('#scr-settings [data-act="group-open"]')]
    .map(b => b.closest('.rowwrap'));
  const rowOf = name => blocks().find(r => r.querySelector('.tname').textContent === name);

  // список в порядке store.groups; в свёрнутой строке — только имя и стрелки
  assert.deepEqual(blocks().map(r => r.querySelector('.tname').textContent), ['Вечер', 'Утро']);
  const row = rowOf('Вечер');
  assert.equal(row.querySelector('label.switch'), null, 'тумблера цепочки нет');
  assert.equal(row.querySelector('[data-act="group-del"]'), null, 'кнопок правки в строке нет');
  assert.deepEqual([...row.querySelectorAll('.ictl .btn')].map(b => b.dataset.act), ['group-up', 'group-down']);
  assert.equal(document.getElementById('g-name'), null, 'правка свёрнута');

  // порядок
  rowOf('Утро').querySelector('[data-act="group-up"]').click();
  assert.deepEqual(saved().groups.map(g => g.name), ['Утро', 'Вечер']);
  assert.equal(blocks()[0].querySelector('[data-act="group-up"]').disabled, true, 'первый — вверх некуда');

  // тап по имени раскрывает правку; раскрыт один блок
  rowOf('Вечер').querySelector('[data-act="group-open"]').click();
  assert.ok(document.getElementById('g-name'), 'правка раскрыта');
  assert.equal(document.querySelectorAll('#scr-settings [data-form="group-edit"]').length, 1);
  rowOf('Утро').querySelector('[data-act="group-open"]').click();
  assert.equal(document.querySelectorAll('#scr-settings [data-form="group-edit"]').length, 1, 'раскрыт ровно один');
  assert.equal(document.querySelector('[data-form="group-edit"]').dataset.id, 'Утро');
  document.querySelector('[data-act="group-cancel"]').click();
  assert.equal(document.getElementById('g-name'), null, 'отмена сворачивает');

  // переименование переписывает item.group у всех пунктов блока
  rowOf('Вечер').querySelector('[data-act="group-open"]').click();
  document.getElementById('g-name').value = 'Ночь';
  document.querySelector('[data-act="group-save"]').click();
  let s = saved();
  assert.deepEqual(s.groups.map(g => g.name), ['Утро', 'Ночь']);
  assert.deepEqual(s.items.filter(i => i.group === 'Ночь').map(i => i.id), ['c1', 'c2', 'c3']);
  assert.equal(s.items.find(i => i.id === 's1').group, 'Утро'); // чужой не тронут

  // Пустое имя не сохраняется. С задачи 26 (пп. 2.3–2.4) отказ не молчит и
  // форму не закрывает: прежде тап по «Сохранить» уносил правку целиком.
  rowOf('Ночь').querySelector('[data-act="group-open"]').click();
  document.getElementById('g-name').value = '   ';
  document.querySelector('[data-act="group-save"]').click();
  assert.ok(saved().groups.find(g => g.name === 'Ночь'));
  assert.ok(document.getElementById('g-name'), 'форма осталась открытой');
  assert.equal(document.getElementById('g-name').value, '   ', 'введённое не переписано');
  assert.match(rowOf('Ночь').querySelector('.flash').textContent, /Название не заполнено/);
  document.querySelector('[data-act="group-cancel"]').click();

  // добавление в конец
  document.querySelector('[data-act="group-add-open"]').click();
  document.getElementById('g-add').value = 'День';
  document.querySelector('[data-act="group-add-save"]').click();
  assert.deepEqual(saved().groups.map(g => g.name), ['Утро', 'Ночь', 'День']);

  // удаление — вторым тапом; пункты и отметки остаются
  document.querySelector('#tabs button[data-tab="today"]').click();
  [...document.querySelectorAll('#scr-today input[data-act="mark"]')].find(i => i.dataset.id === 'c1').click();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  rowOf('Ночь').querySelector('[data-act="group-open"]').click(); // удаление живёт в раскрытой правке
  const del = () => rowOf('Ночь').querySelector('[data-act="group-del"]');
  assert.match(del().textContent, /^Удалить$/);
  del().click();
  assert.match(del().textContent, /Подтвердить удаление/);
  assert.ok(saved().groups.find(g => g.name === 'Ночь'), 'первый тап не удаляет');
  del().click();
  s = saved();
  assert.equal(s.groups.find(g => g.name === 'Ночь'), undefined);
  assert.equal(s.items.length, 5, 'пункты остались');
  assert.equal(s.items.filter(i => i.group === '').length, 4); // c1..c3 плюс исходный безгруппный
  assert.equal(s.days[daysAgo(0)].c1, true, 'отметка не тронута');
});

/* Задача 17, п. 2: поле «Блок» — выбор из заведённых, а не свободный ввод.
   Прежний тест проверял datalist; сама механика поля заменена промптом. */
test('поле «Блок»: select из заведённых, «+ Новый блок…» заводит блок в конце', async () => {
  const { document, window } = await boot({ seed: chainSeed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  const sel = () => document.getElementById('e-group');
  const openEdit = name => [...document.querySelectorAll('#scr-settings .row.item [data-act="edit-open"]')]
    .find(b => b.querySelector('.tname').textContent === name).click();
  const pickLast = () => {
    sel().selectedIndex = sel().options.length - 1; // «+ Новый блок…» — всегда последний
    sel().dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  openEdit('Свет');
  assert.deepEqual([...sel().options].map(o => o.textContent),
    ['— без блока', 'Вечер', 'Утро', '+ Новый блок…']);
  assert.equal(sel().value, 'Вечер', 'выбран блок пункта');
  assert.equal(document.querySelector('#groups-dl'), null, 'свободного ввода с datalist больше нет');

  // пустое имя блока не заводит и принадлежность пункта не меняет
  pickLast();
  assert.ok(document.getElementById('e-gnew'), 'поле имени раскрылось прямо в форме');
  document.querySelector('[data-act="edit-save"]').click();
  assert.deepEqual(saved().groups.map(g => g.name), ['Вечер', 'Утро']);
  assert.equal(saved().items.find(i => i.id === 'c1').group, 'Вечер');

  // имя заводит блок в конце списка и сразу выбирается пунктом
  openEdit('Свет');
  pickLast();
  document.getElementById('e-gnew').value = '  Ритуал  ';
  document.querySelector('[data-act="edit-save"]').click();
  const s = saved();
  assert.equal(s.items.find(i => i.id === 'c1').group, 'Ритуал');
  assert.deepEqual(s.groups.map(g => g.name), ['Вечер', 'Утро', 'Ритуал']);
  assert.deepEqual(Object.keys(s.groups[2]), ['name']);

  // выбор из списка — обычная смена блока
  openEdit('Свет');
  sel().value = 'Утро';
  sel().dispatchEvent(new window.Event('change', { bubbles: true }));
  document.querySelector('[data-act="edit-save"]').click();
  assert.equal(saved().items.find(i => i.id === 'c1').group, 'Утро');
});

test('поле «Блок»: имя не из списка (импорт) видно с пометкой и остаётся выбранным', async () => {
  const seed = chainSeed();
  seed.items.find(i => i.id === 'c1').group = 'Чужой'; // такого блока в groups[] нет
  const { document, window } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  [...document.querySelectorAll('#scr-settings .row.item [data-act="edit-open"]')]
    .find(b => b.querySelector('.tname').textContent === 'Свет').click();

  const sel = document.getElementById('e-group');
  const marked = [...sel.options].find(o => o.value === 'Чужой');
  assert.ok(marked, 'вариант с именем из импорта есть');
  assert.equal(marked.textContent, 'Чужой (нет в списке)');
  assert.equal(sel.value, 'Чужой', 'и он выбран');

  // сохранение без правки поля принадлежность не теряет
  document.querySelector('[data-act="edit-save"]').click();
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.id === 'c1').group, 'Чужой');
});

test('черновик правки переживает уход в лист детали и возврат (14.2, вопрос 2)', async () => {
  const { document } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  [...document.querySelectorAll('#scr-settings .row.item [data-act="edit-open"]')]
    .find(b => b.querySelector('.tname').textContent === 'Умыться').click();
  document.getElementById('e-name').value = 'Новое имя';
  document.getElementById('e-note').value = 'черновик подписи';

  document.querySelector('#scr-settings .card.form [data-act="item-detail"]').click();
  assert.equal(document.getElementById('scr-detail').hidden, false);
  // в листе своя форма — её черновик не смешивается с черновиком «Пунктов»
  document.querySelector('[data-act="formula-open"]').click();
  document.getElementById('fx-anchor').value = 'после зарядки';
  document.querySelector('[data-act="formula-cancel"]').click();
  document.querySelector('[data-act="detail-done"]').click();

  assert.equal(document.getElementById('e-name').value, 'Новое имя', 'начатая правка на месте');
  assert.equal(document.getElementById('e-note').value, 'черновик подписи');
});

/* Задача 16, фаза A: линия толще, но по-прежнему идёт через центры кругов.
   Обе величины берутся из CSS и сверяются между собой — левый отступ линии
   не константа в тесте, а следствие диаметра круга и толщины линии. */
test('цепочка: линия 3px и проходит через центр круга', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const seg = (css.match(/\.cseg\s*\{([^}]*)\}/) || [])[1];
  assert.ok(seg, 'правило .cseg на месте');
  const width = parseFloat((seg.match(/width:\s*([\d.]+)px/) || [])[1]);
  const left = parseFloat((seg.match(/left:\s*([\d.]+)px/) || [])[1]);
  const box = (css.match(/\.check \.box\s*\{([^}]*)\}/) || [])[1];
  const dia = parseFloat((box.match(/width:\s*([\d.]+)px/) || [])[1]);
  assert.equal(width, 3, 'толщина линии');
  assert.equal(dia, 26, 'диаметр круга не менялся');
  assert.equal(left + width / 2, dia / 2, 'центр линии совпадает с центром круга');
  // обводка круга в блоке — тот же токен, толщина обводки не менялась
  assert.match(css, /\.chain \.check:not\(\.on\) \.box\s*\{[^}]*border-color:\s*var\(--chain\)/);
  assert.match(css, /\.check \.box\s*\{[^}]*border:\s*1\.5px solid var\(--control-border\)/);
});

test('источники: ни --warn и .broken, ни признака цепочки, ни слов «группа» и «модуль»', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  for (const [name, src] of [['styles.css', css], ['app.js', js]]) {
    assert.doesNotMatch(src, /--warn\b/, `--warn в ${name}`);
    assert.doesNotMatch(src, /\bbroken\b/, `.broken в ${name}`);
    assert.doesNotMatch(src, /серия прервана/, `строка «серия прервана» в ${name}`);
  }
  // токен цепочки на месте в обеих темах и текстом не используется
  assert.equal((css.match(/--chain:/g) || []).length, 2);
  // текстом не используется: border-color под запрет не подпадает (это обводка)
  assert.doesNotMatch(css, /(?<!-)color:\s*var\(--chain\)/, '--chain не красит текст');
  assert.match(css, /\.cseg\s*\{[^}]*background:\s*var\(--chain\)/);
  // признак цепочки упразднён: ни поля, ни функции, ни состояния сегмента
  assert.doesNotMatch(js, /setGroupChain|chainNeighbours|segmentOn|updateChainSegments/, 'мёртвая механика цепочки');
  assert.doesNotMatch(js, /\bchain:\s*(true|false)/, 'поле chain в модели');
  assert.doesNotMatch(css, /\.cseg\.on\b/, 'состояние сегмента в CSS');

  // ни одной пользовательской строки со словами «Модуль» и «группа» (комментарии сняты)
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const word of [/Модул/, /модул/, /Групп/, /групп/]) {
    assert.doesNotMatch(code, word, `слово ${word} в коде app.js`);
  }
  // «Блоки» — заголовок секции «Настроек» (задача 16B), «Блок» — поле формы
  assert.match(js, /sect\('groups', 'Блоки'/);
  assert.match(js, /<span>Блок<\/span>/);
});

test('баннер хранилища: появляется при сбое save и снимается первым успешным', async () => {
  const { document, window } = await boot();
  const realLS = window.localStorage;
  const broken = {
    getItem: k => realLS.getItem(k),
    setItem: () => { throw new Error('quota'); },
    removeItem: () => {}
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => broken });

  // ПЕРЕПИСАНО в задаче 27.1 (п. 5.2): баннер ушёл из разметки «Сегодня» в
  // постоянный узел над экранами. Прежде renderAll рисовал одну текущую
  // вкладку, и отказ, случившийся на «Настройках» или в листе, не оставлял
  // на экране владельца ни следа (задача 27, Д6). Узел точечно обновляет
  // storageNote() — перерисовка экрана для этого больше не нужна.
  const note = document.getElementById('storage-note');
  assert.ok(note, 'постоянный узел баннера есть в разметке документа');
  assert.equal(note.hidden, true, 'до отказа скрыт');

  document.querySelector('input[data-act="mark"]').click(); // save падает
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /Хранилище недоступно/);
  // и он виден на ЛЮБОМ экране, а не только на дневных
  document.querySelector('#tabs button[data-tab="settings"]').click();
  assert.equal(document.getElementById('storage-note').hidden, false);
  document.querySelector('#tabs button[data-tab="today"]').click();

  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => realLS });
  document.querySelector('input[data-act="mark"]').click(); // успешный save снимает флаг
  assert.equal(document.getElementById('storage-note').hidden, true);
  assert.doesNotMatch(document.getElementById('scr-today').textContent, /Хранилище недоступно/);
});

/* ── Задача 16, фаза B. Навигация и «Прогресс» ─────────────── */

/* Сид «Прогресса»: два пункта минимума, заведённых до начала эпохи */
function progSeed() {
  const seed = dueSeed();
  const old = addKey(prevMonday(), -14);
  seed.items = [
    { id: 'p1', name: 'Первый', value: 10, unit: 'мин', type: 'daily', area: 'min',
      goal: null, note: '', group: '', active: true, addedAt: old, raiseAfter: 0,
      history: [{ date: old, value: 10 }] },
    { id: 'p2', name: 'Второй', value: null, unit: '', type: 'daily', area: 'min',
      goal: null, note: '', group: '', active: true, addedAt: old, raiseAfter: 0, history: [] }
  ];
  seed.days = {
    [daysAgo(0)]: { p1: true, p2: true }, // закрыт
    [daysAgo(1)]: { p1: true }            // отмечено не всё
  };
  return seed;
}

test('«Прогресс»: «в системе», серия, цепь дней 8×7 и скрытые будущие ячейки', async () => {
  const seed = progSeed();
  const { document } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="progress"]').click();
  const scr = document.getElementById('scr-progress');

  // «в системе» — от calendarSince до сегодня включительно
  const total = Math.round((new Date(daysAgo(0)) - new Date(seed.settings.calendarSince)) / 86400000) + 1;
  const stats = [...scr.querySelectorAll('.stat')].map(x => x.textContent);
  assert.equal(stats.length, 2);
  assert.match(stats[0], new RegExp('^' + total + ' '));
  assert.match(stats[1], /^1 /, 'серия: сегодня зачтён, вчера — амнистия, позавчера обрыв');
  // формулировка п. 4.6: амнистия теперь одна на неделю, а не «одна подряд»
  // подпись обязана совпадать с правилом амнистии: разрыв РОВНО в неделю
  // уже обрывает, поэтому «раз в неделю» заменено на «больше недели назад»
  assert.match(scr.textContent, /Пропуск прощается, если прошлый был больше недели назад\. Иначе счёт начинается заново\./);

  // цепь дней: 8 строк по 7 ячеек и строка подписей
  const cells = [...scr.querySelectorAll('.cdays i')];
  assert.equal(cells.length, 56);
  assert.deepEqual([...scr.querySelectorAll('.cd-head')].map(x => x.textContent),
    ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);

  // будущие дни текущей недели не рисуются
  const dow = (new Date(daysAgo(0) + 'T12:00').getDay() + 6) % 7;
  assert.equal(cells.filter(c => c.classList.contains('fut')).length, 6 - dow);
  assert.equal(cells.filter(c => c.classList.contains('full')).length, 1, 'закрытый день');
  assert.equal(cells.filter(c => c.classList.contains('part')).length, 1, 'частично отмеченный');
  // сетка скрыта от AT, вместо неё — сводка по неделям
  assert.equal(scr.querySelector('.cdays').getAttribute('aria-hidden'), 'true');
  // сводка для скринридера говорит о том же, что рисует сетка: ячейка теперь
  // про зачёт (доля ≥ порога), а не про полное закрытие дня
  assert.match(scr.querySelector('.sr-only').textContent, /Неделя с .*: зачтено \d из 7/);

  // «Отметки»: строка на каждый активный дневной пункт
  assert.match(scr.textContent, new RegExp('Первый · 2 из ' + total));
  assert.match(scr.textContent, new RegExp('Второй · 1 из ' + total));
});

test('«Прогресс»: подъём — линия при двух записях истории, при одной блока нет', async () => {
  const one = await boot({ seed: progSeed() });
  one.document.querySelector('#tabs button[data-tab="progress"]').click();
  assert.equal(one.document.querySelectorAll('#scr-progress .rise').length, 0);
  // п. 8.3: блок «Подъём» остаётся и при пустоте — вместо линии одна строка
  assert.match(one.document.getElementById('scr-progress').textContent,
    /Появится, когда планка изменится во второй раз\./);

  const seed = progSeed();
  seed.items[0].history.push({ date: daysAgo(3), value: 14 });
  const { document } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="progress"]').click();
  const scr = document.getElementById('scr-progress');
  assert.match(scr.textContent, /Подъём/);
  const svg = scr.querySelectorAll('.rise');
  assert.equal(svg.length, 1, 'один визуал на пункт');
  const d = svg[0].querySelector('path').getAttribute('d');
  assert.equal((d.match(/[HV]/g) || []).length, 3);
  assert.equal(svg[0].getAttribute('aria-hidden'), 'true');
  // подпись — словами владельца, без осей и подписей значений внутри графика
  assert.match(scr.querySelector('.rise-v').textContent, /^10 → 14 мин$/);
  assert.equal(svg[0].querySelector('text'), null, 'подписей значений в SVG нет');
  assert.equal(svg[0].querySelector('line'), null, 'осей и сетки нет');
  assert.equal(svg[0].querySelector('circle'), null, 'точек нет');
});

test('разбор: открывается строкой «Прогресса» и «Готово» возвращает на неё', async () => {
  const { document } = await boot({ seed: dueSeed() });
  document.querySelector('#tabs button[data-tab="progress"]').click();
  const line = document.querySelector('#scr-progress [data-act="goto-review"]');
  assert.ok(line, 'строка разбора на «Прогрессе»');

  line.click();
  assert.equal(document.getElementById('scr-review').hidden, false);
  assert.equal(document.getElementById('scr-progress').hidden, true);
  // вкладка возврата остаётся текущей и при открытом листе
  assert.equal(document.querySelector('#tabs button[data-tab="progress"]').getAttribute('aria-current'), 'page');

  document.querySelector('[data-act="review-done"]').click();
  assert.equal(document.getElementById('scr-review').hidden, true);
  assert.equal(document.getElementById('scr-progress').hidden, false);

  // таб-бар тоже уводит с листа
  document.querySelector('#scr-progress [data-act="goto-review"]').click();
  assert.equal(document.getElementById('scr-review').hidden, false);
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.equal(document.getElementById('scr-review').hidden, true);
  assert.equal(document.getElementById('scr-today').hidden, false);
});

test('«Настройки»: секции по порядку, раскрыты только «Пункты», состояние держится', async () => {
  const { document } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const sects = () => [...document.querySelectorAll('#scr-settings details.sect')];
  const titles = () => sects().map(s => s.querySelector('summary').textContent.replace('›', '').trim());

  // «Упражнения» добавились в фазе D — между «Пунктами» и «Данными»
  assert.deepEqual(titles(), ['Блоки', 'Пункты', 'Упражнения', 'Данные', 'Система']);
  assert.deepEqual(sects().map(s => s.hasAttribute('open')), [false, true, false, false, false]);

  // содержимое прежних экранов на месте, внутри своих секций
  assert.match(sects()[0].textContent, /Добавить блок/);
  assert.match(sects()[1].textContent, /Граница дня/);
  assert.match(sects()[2].textContent, /Добавить упражнение/);
  assert.ok(sects()[3].querySelector('[data-act="export"]'));
  assert.match(sects()[4].textContent, /Пять правил/);

  // раскрытие запоминается: перерисовка после действия секцию не захлопывает
  sects()[3].querySelector('summary').click();
  document.querySelector('#scr-settings [data-act="add-open"]').click(); // перерисовка «Настроек»
  assert.deepEqual(sects().map(s => s.hasAttribute('open')), [false, true, false, true, false]);
});

/* ── Задача 16, фаза C. Разбор как три решения ─────────────── */

test('разбор: три решения сверху, неделя — под свёрткой, итог одной строкой', async () => {
  const seed = dueSeed();
  // параметр недели: решение по нему живёт в видимой части, в «Решении 1»
  // (задача 24, п. 2), и перерисовывает разбор
  seed.items.push({
    id: 'pp', name: 'Отбой', value: null, unit: '', type: 'param', area: 'habit',
    pkind: 'time', pvalue: 1380, pstep: -15, goal: null, note: '', group: '',
    active: true, addedAt: addKey(prevMonday(), -14), raiseAfter: 0, history: []
  });
  // по 5 отметок в каждой из двух закрытых недель: для повышения мало
  // (нужно ≥6 три недели), для понижения много (нужно ≤3) — предложений нет
  seed.days = {};
  for (const mon of [prevMonday(), addKey(prevMonday(), -7)]) {
    for (let i = 0; i < 5; i++) seed.days[addKey(mon, i)] = { it1: true };
  }
  const { document } = await boot({ seed });
  openReview(document);
  const scr = document.getElementById('scr-review');

  // итог недели одной строкой: пять закрытых дней из семи
  assert.match(scr.textContent, /Минимум закрыт 5 из 7 дней/);

  const h2 = [...scr.querySelectorAll(':scope > h2')].map(x => x.textContent);
  assert.deepEqual(h2, ['Решение 1 · Планка', 'Решение 2 · Ступень', 'Решение 3 · Одно изменение']);

  // сетка недели уехала под закрытую свёртку, но осталась в разметке
  const fold = scr.querySelector('details.sect.week');
  assert.ok(fold, 'свёртка «Показать неделю»');
  assert.equal(fold.hasAttribute('open'), false, 'решать есть что — свёртка закрыта');
  assert.match(fold.querySelector('summary').textContent, /Показать неделю/);
  assert.ok(fold.querySelector('.grid'), 'сетка галочек внутри свёртки');
  assert.equal(scr.querySelector(':scope > .grid'), null, 'снаружи сетки нет');

  // карточка параметра переехала в видимую часть, в «Решение 1» (задача 24)
  const card = scr.querySelector('.card.param');
  assert.ok(card, 'карточка параметра есть');
  assert.equal(card.closest('details'), null, 'она вне свёртки');
  const kids = [...scr.children];
  const h1i = kids.findIndex(x => x.textContent === 'Решение 1 · Планка');
  const h2i = kids.findIndex(x => x.textContent === 'Решение 2 · Ступень');
  const ci = kids.indexOf(card);
  assert.ok(h1i < ci && ci < h2i, 'карточка стоит внутри «Решения 1»');

  // решения без предложений — тихие строки, а не пустота
  assert.doesNotMatch(scr.textContent, /Планка держится, менять нечего/,
    'нерешённый параметр — это и есть решение по планке');
  assert.match(scr.textContent, /Лестницы сейчас нет/);
  assert.ok(scr.querySelector('input[data-bind="one-change"]'));

  // свёртка запоминается: перерисовка разбора её не захлопывает
  fold.querySelector('summary').click();
  document.querySelector('[data-act="param-keep"]').click();
  await settle();
  const after = document.getElementById('scr-review');
  assert.equal(after.querySelector('details.sect.week').hasAttribute('open'), true);
  // решённый параметр ушёл из видимой части, итог — read-only строка внутри
  assert.equal(after.querySelector('.card.param'), null, 'карточки больше нет');
  assert.match(after.querySelector('details.sect.week').textContent, /Отбой: 23:00, без шага/);
  assert.match(after.textContent, /Планка держится, менять нечего/, 'решать стало нечего');
});

test('разбор: карточка «Сделать легче» — шаг применяется, «Оставить» гасит предложение', async () => {
  const seed = dueSeed();
  seed.items[0].value = 20;
  seed.items[0].history = [{ date: addKey(prevMonday(), -14), value: 20 }];
  // две закрытые недели без отметок — планка не держится; одна отметка до
  // окна делает пункт начатым, иначе предложения нет (задача 22, п. 1)
  seed.days = { [addKey(prevMonday(), -14)]: { it1: true } };
  const { document, window } = await boot({ seed });
  openReview(document);
  const scr = () => document.getElementById('scr-review');
  const saved = () => JSON.parse(window.localStorage.getItem(NS));

  const card = scr().querySelector('.card.lower');
  assert.ok(card, 'карточка понижения');
  assert.match(card.textContent, /Сделать легче/);
  assert.match(card.textContent, /Тестовый пункт — 0 и 0 из 7 за две недели/);
  const step = card.querySelector('[data-act="lower-ok"]');
  assert.match(step.textContent, /Сделать легче 20 → 15 мин/);

  step.click();
  await settle();
  const it = saved().items[0];
  assert.equal(it.value, 15);
  assert.equal(it.history[it.history.length - 1].value, 15);
  assert.equal(it.lowerAfterWeek, curMonday());
  assert.deepEqual(saved().pendingLowers, [{ itemId: 'it1', name: 'Тестовый пункт', from: 20, to: 15 }]);
  assert.equal(scr().querySelector('.card.lower'), null, 'решение принято — карточки нет');

  // «Оставить» на свежем сиде: планка не меняется, предложение гаснет
  const b = await boot({ seed });
  openReview(b.document);
  b.document.querySelector('[data-act="lower-keep"]').click();
  await settle();
  const bs = JSON.parse(b.window.localStorage.getItem(NS));
  assert.equal(bs.items[0].value, 20, 'планка не тронута');
  assert.equal(bs.items[0].lowerAfterWeek, curMonday());
  assert.deepEqual(bs.pendingLowers, []);
  assert.equal(b.document.getElementById('scr-review').querySelector('.card.lower'), null);
});

test('разбор: решение «Ступень» — «Шагнуть» и «Остаться» при доступном шаге', async () => {
  const seed = dueSeed();
  const old = addKey(prevMonday(), -14);
  seed.items[0].ladder = { steps: ['первая', 'вторая', 'третья'], step: 0, steppedWeek: null, startedAt: old };
  seed.items[0].ladderLog = [{ date: old, step: 0, text: 'первая', start: true }];
  // две последние завершённые недели по 6 из 7 — шаг доступен
  seed.days = {};
  for (const mon of [prevMonday(), addKey(prevMonday(), -7)]) {
    for (let i = 0; i < 6; i++) seed.days[addKey(mon, i)] = { it1: true };
  }
  const { document, window } = await boot({ seed });
  openReview(document);
  const card = document.querySelector('.card.step');
  assert.ok(card, 'карточка ступени');
  assert.match(card.textContent, /Следующая ступень: вторая/);

  // «Остаться» — ступень не двигается, место занимает строка состояния
  card.querySelector('[data-act="ladder-stay"]').click();
  const scr = document.getElementById('scr-review');
  assert.equal(scr.querySelector('.card.step'), null);
  assert.match(scr.textContent, /можно шагнуть/);
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items[0].ladder.step, 0);

  // «Шагнуть» на свежем сиде двигает ступень и пишет журнал
  const b = await boot({ seed });
  openReview(b.document);
  b.document.querySelector('.card.step [data-act="ladder-fwd"]').click();
  const bi = JSON.parse(b.window.localStorage.getItem(NS)).items[0];
  assert.equal(bi.ladder.step, 1);
  assert.equal(bi.ladder.steppedWeek, curMonday());
  assert.equal(bi.ladderLog.length, 2);
});

/* ── Задача 16, фаза D. Лист тренировки и упражнения ───────── */

/* Сид с двумя упражнениями и недельным счётчиком */
function trainSeed() {
  const seed = dueSeed();
  const old = addKey(prevMonday(), -14);
  seed.items.push({
    id: 'w1', name: 'Тренировка', value: null, unit: '', type: 'weekly', goal: 3,
    note: '', group: '', active: true, addedAt: old, raiseAfter: 0, history: []
  });
  seed.exercises = [
    { id: 'e1', name: 'Жим', unit: 'кг', value: 40, active: true, addedAt: old, history: [{ date: old, value: 40 }] },
    { id: 'e2', name: 'Тяга', unit: 'кг', value: 60, active: true, addedAt: old, history: [{ date: old, value: 60 }] }
  ];
  return seed;
}

test('лист тренировки: «+» открывает, «Записать» пишет сессию и счёт, «Отмена» — ничего', async () => {
  const { document, window } = await boot({ seed: trainSeed() });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));

  document.querySelector('[data-act="train-inc"]').click();
  const sheet = document.getElementById('scr-train');
  assert.equal(sheet.hidden, false);
  assert.equal(document.getElementById('scr-today').hidden, true);
  // поля предзаполнены текущей нагрузкой
  assert.equal(document.getElementById('ex-e1').value, '40');
  assert.equal(document.getElementById('ex-e2').value, '60');

  // «Отмена» не пишет ничего и возвращает на «Сегодня»
  document.querySelector('[data-act="train-cancel"]').click();
  assert.equal(document.getElementById('scr-today').hidden, false);
  assert.deepEqual(saved().sessions, []);
  assert.deepEqual(saved().weekLog, []);

  // шаг ±1 правит поле на месте, запись сохраняет введённое
  document.querySelector('[data-act="train-inc"]').click();
  const up = [...document.querySelectorAll('[data-act="ex-step"]')].find(b => b.dataset.id === 'e1' && b.dataset.dir === 'up');
  up.click(); up.click();
  assert.equal(document.getElementById('ex-e1').value, '42');
  document.getElementById('tr-note').value = 'тяжело';
  document.querySelector('[data-act="train-save"]').click();

  const s = saved();
  assert.equal(s.sessions.length, 1);
  assert.equal(s.sessions[0].date, daysAgo(0));
  assert.deepEqual(s.sessions[0].entries, [{ exId: 'e1', value: 42 }, { exId: 'e2', value: 60 }]);
  assert.equal(s.sessions[0].note, 'тяжело');
  assert.equal(s.exercises[0].value, 42, 'нагрузка обновлена');
  assert.equal(s.exercises[1].value, 60);
  assert.equal(s.exercises[1].history.length, 1, 'без изменения история не растёт');
  assert.equal(s.weekLog.length, 1, 'счётчик недели вырос');
  assert.equal(document.querySelector('.wnum b').textContent, '1');

  // «отменить последний» снимает и запись счётчика, и сессию
  document.querySelector('[data-act="train-undo"]').click();
  const s2 = saved();
  assert.deepEqual(s2.weekLog, []);
  assert.deepEqual(s2.sessions, []);
  assert.equal(s2.exercises[0].value, 42, 'нагрузка не откатывается');
});

test('лист тренировки: без упражнений — тихая строка, запись всё равно возможна', async () => {
  const seed = trainSeed();
  seed.exercises = [];
  const { document, window } = await boot({ seed });
  document.querySelector('[data-act="train-inc"]').click();
  const sheet = document.getElementById('scr-train');
  assert.match(sheet.textContent, /Упражнений пока нет/);
  document.querySelector('[data-act="train-save"]').click();
  const s = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(s.sessions.length, 1);
  assert.deepEqual(s.sessions[0].entries, []);
  assert.equal(s.weekLog.length, 1);
});

test('«Настройки»: упражнения добавляются, правятся, двигаются и выключаются', async () => {
  const { document, window } = await boot({ seed: trainSeed() });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  document.querySelector('#tabs button[data-tab="settings"]').click();
  // секция по заголовку, а не по номеру: вставка новой секции не должна
  // молча переадресовать тест на соседнюю (задача 19, C.4.1)
  const sect = () => [...document.querySelectorAll('#scr-settings details.sect')]
    .find(d => /Упражнения/.test(d.querySelector('summary').textContent));
  const rows = () => [...sect().querySelectorAll('.row.item')];

  assert.deepEqual(rows().map(r => r.querySelector('.tname').textContent), ['Жим', 'Тяга']);

  // добавление
  sect().querySelector('[data-act="ex-add-open"]').click();
  document.getElementById('x-add-name').value = 'Присед';
  document.getElementById('x-add-unit').value = 'кг';
  document.getElementById('x-add-value').value = '80';
  document.querySelector('[data-act="ex-add-save"]').click();
  const added = saved().exercises[2];
  assert.equal(added.name, 'Присед');
  assert.equal(added.value, 80);
  assert.deepEqual(added.history, [{ date: daysAgo(0), value: 80 }]);

  // правка имени и единицы
  rows()[0].querySelector('[data-act="ex-open"]').click();
  document.getElementById('x-name').value = 'Жим лёжа';
  document.getElementById('x-unit').value = 'повт.';
  document.querySelector('[data-act="ex-save"]').click();
  assert.equal(saved().exercises[0].name, 'Жим лёжа');
  assert.equal(saved().exercises[0].unit, 'повт.');

  // порядок стрелками
  rows()[1].querySelector('[data-act="ex-up"]').click();
  assert.deepEqual(saved().exercises.map(e => e.name), ['Тяга', 'Жим лёжа', 'Присед']);

  // выключение убирает упражнение из листа тренировки, но не из настроек
  rows()[0].querySelector('input[data-act="ex-active"]').click();
  assert.equal(saved().exercises[0].active, false);
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector('[data-act="train-inc"]').click();
  assert.equal(document.getElementById('ex-e2'), null, 'выключенного в листе нет');
  assert.ok(document.getElementById('ex-e1'), 'включённое на месте');
});

test('«Прогресс»: упражнение с двумя записями истории даёт линию подъёма', async () => {
  const seed = trainSeed();
  seed.exercises[0].history.push({ date: daysAgo(3), value: 45 });
  seed.exercises[0].value = 45;
  const { document } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="progress"]').click();
  const scr = document.getElementById('scr-progress');
  const blocks = [...scr.querySelectorAll('.rise-b')];
  assert.equal(blocks.length, 1, 'один визуал на упражнение');
  assert.match(blocks[0].textContent, /Жим/);
  assert.match(blocks[0].querySelector('.rise-v').textContent, /^40 → 45 кг$/);
  assert.equal((blocks[0].querySelector('path').getAttribute('d').match(/[HV]/g) || []).length, 3);
});

/* ── Задача 16, фаза E. Экран «Заметки» ────────────────────── */

test('«Заметки»: создание, правка, удаление вторым тапом, порядок от новых', async () => {
  // сид без выписок: тест про механику записей, а не про стартовый набор (задача 17)
  const { document, window } = await boot({ seed: dueSeed() });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  document.querySelector('#tabs button[data-tab="notes"]').click();
  const scr = () => document.getElementById('scr-notes');
  assert.match(scr().textContent, /Пока пусто/);

  // создание
  document.querySelector('[data-act="note-add-open"]').click();
  document.getElementById('n-text').value = 'первая мысль';
  document.querySelector('[data-act="note-save"]').click();
  assert.equal(saved().notes.length, 1);
  assert.equal(saved().notes[0].text, 'первая мысль');
  assert.doesNotMatch(scr().textContent, /Пока пусто/);
  const cards = () => [...scr().querySelectorAll('.card.note')];
  assert.equal(cards().length, 1);
  assert.match(cards()[0].querySelector('.ntext').textContent, /первая мысль/);

  // вторая заметка — новая идёт первой
  document.querySelector('[data-act="note-add-open"]').click();
  document.getElementById('n-text').value = 'вторая мысль';
  document.querySelector('[data-act="note-save"]').click();
  assert.deepEqual(cards().map(c => c.querySelector('.ntext').textContent),
    ['вторая мысль', 'первая мысль']);

  // правка: тап по карточке раскрывает форму с текстом
  cards()[1].click();
  assert.equal(document.getElementById('n-text').value, 'первая мысль');
  document.getElementById('n-text').value = 'первая, поправленная';
  document.querySelector('[data-act="note-save"]').click();
  assert.equal(saved().notes.find(n => n.text === 'первая, поправленная') !== undefined, true);

  // пустой текст при сохранении удаляет заметку
  cards()[1].click();
  document.getElementById('n-text').value = '   ';
  document.querySelector('[data-act="note-save"]').click();
  assert.equal(saved().notes.length, 1);
  assert.equal(cards().length, 1);

  // удаление — вторым тапом
  cards()[0].click();
  const del = () => document.querySelector('[data-act="note-del"]');
  assert.match(del().textContent, /^Удалить$/);
  del().click();
  assert.match(del().textContent, /Подтвердить удаление/);
  assert.equal(saved().notes.length, 1, 'первый тап не удаляет');
  del().click();
  assert.deepEqual(saved().notes, []);
  assert.match(scr().textContent, /Пока пусто/);
});

test('«Заметки»: черновик переживает смену логического дня, «Отмена» ничего не пишет', async () => {
  // сид без выписок: «ничего не записано» проверяется на пустом списке (задача 17)
  const { document, window } = await boot({ seed: dueSeed() });
  document.querySelector('#tabs button[data-tab="notes"]').click();
  document.querySelector('[data-act="note-add-open"]').click();
  document.getElementById('n-text').value = 'начатая мысль';

  // смена логического дня перерисовывает экран (инвариант 8) — черновик остаётся
  shiftWindowDate(window, 26 * 3600000);
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(document.getElementById('n-text').value, 'начатая мысль');
  assert.deepEqual(JSON.parse(window.localStorage.getItem(NS)).notes, [], 'ничего не записано');

  document.querySelector('[data-act="note-cancel"]').click();
  assert.equal(document.getElementById('n-text'), null, 'форма закрыта');
  assert.deepEqual(JSON.parse(window.localStorage.getItem(NS)).notes, []);
});

test('«Заметки»: экспорт → очистка → импорт восстанавливает записи', async () => {
  const seed = dueSeed();
  seed.notes = [
    { id: 'n1', date: daysAgo(3), text: 'старая', updatedAt: 1 },
    { id: 'n2', date: daysAgo(0), text: 'свежая', updatedAt: 2 }
  ];
  const { document, window } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="notes"]').click();
  assert.deepEqual([...document.querySelectorAll('#scr-notes .ntext')].map(x => x.textContent),
    ['свежая', 'старая']);

  // экспорт хранит заметки; импорт того же JSON возвращает их
  const exported = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(exported.notes.length, 2);
  const b = await boot({ seed: exported });
  b.document.querySelector('#tabs button[data-tab="notes"]').click();
  assert.deepEqual([...b.document.querySelectorAll('#scr-notes .ntext')].map(x => x.textContent),
    ['свежая', 'старая']);
});

/* ── Задача 16, фаза F. Перетаскивание и порядок ───────────── */

/* Сид «Настроек»: три пункта блока «Утро», один — блока «Вечер» */
function orderSeed() {
  const seed = dueSeed();
  const old = addKey(prevMonday(), -14);
  const mk = (id, name, group) => ({
    id, name, value: null, unit: '', type: 'daily', area: 'min', goal: null, note: '',
    group, active: true, addedAt: old, raiseAfter: 0, history: []
  });
  seed.items = [mk('a1', 'Первый', 'Утро'), mk('a2', 'Второй', 'Утро'),
    mk('b1', 'Вечерний', 'Вечер'), mk('a3', 'Третий', 'Утро')];
  seed.groups = [{ name: 'Утро' }, { name: 'Вечер' }];
  return seed;
}

/* Событие указателя: в jsdom нет PointerEvent — тип задаётся строкой,
   а нужные поля (clientX/clientY, button) есть у MouseEvent */
function pointer(window, type, x, y) {
  return new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
}

/* Прямоугольники строк в jsdom нулевые — геометрию списка задаём сами */
function stubRows(rows, top = 200, h = 60) {
  rows.forEach((r, i) => {
    r.getBoundingClientRect = () => ({
      top: top + i * h, bottom: top + i * h + h, height: h,
      left: 20, right: 355, width: 335, x: 20, y: top + i * h
    });
  });
  rows[0].parentElement.getBoundingClientRect = () => ({
    top, bottom: top + rows.length * h, height: rows.length * h,
    left: 20, right: 355, width: 335, x: 20, y: top
  });
}

const hold = () => wait(T.DRAG_HOLD + 40); // дольше DRAG_HOLD

test('перетаскивание: pointerdown → pointermove → pointerup переставляет пункт внутри блока', async () => {
  const { document, window } = await boot({ seed: orderSeed() });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const rows = () => [...document.querySelectorAll('#scr-settings [data-drag="item"]')];
  assert.deepEqual(rows().map(r => r.dataset.dragId), ['a1', 'a2', 'b1', 'a3']);

  stubRows(rows());
  const row = rows()[0]; // «Первый», блок «Утро»
  row.dispatchEvent(pointer(window, 'pointerdown', 100, 230));
  await hold();
  assert.equal(row.classList.contains('drag-live'), true, 'захват после удержания');

  // ведём палец ниже середины строки a3 (её прямоугольник 380..440)
  document.dispatchEvent(pointer(window, 'pointermove', 100, 415));
  document.dispatchEvent(pointer(window, 'pointerup', 100, 415));

  // среди соседей по блоку пункт встал последним; чужой блок остался
  // на своём месте в store.items (позиции блока «Утро» — 0, 1 и 3)
  assert.deepEqual(saved().items.map(i => i.id), ['a2', 'a3', 'b1', 'a1']);
  assert.deepEqual(saved().items.map(i => i.group), ['Утро', 'Утро', 'Вечер', 'Утро']);
  assert.equal(document.querySelector('.drag-live'), null, 'захват снят');
  assert.equal(document.body.classList.contains('dragging'), false);
});

test('перетаскивание: движение до удержания — это скролл; Escape и уход вбок отменяют', async () => {
  const { document, window } = await boot({ seed: orderSeed() });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  const order = saved().items.map(i => i.id);
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const rows = () => [...document.querySelectorAll('#scr-settings [data-drag="item"]')];
  stubRows(rows());

  // движение до захвата отменяет удержание — список скроллится, а не тащится
  rows()[0].dispatchEvent(pointer(window, 'pointerdown', 100, 230));
  document.dispatchEvent(pointer(window, 'pointermove', 100, 260));
  await hold();
  assert.equal(document.querySelector('.drag-live'), null, 'захвата не было');
  document.dispatchEvent(pointer(window, 'pointerup', 100, 260));
  assert.deepEqual(saved().items.map(i => i.id), order);

  // Escape отменяет уже начатое перетаскивание
  stubRows(rows());
  rows()[0].dispatchEvent(pointer(window, 'pointerdown', 100, 230));
  await hold();
  document.dispatchEvent(pointer(window, 'pointermove', 100, 415));
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.dispatchEvent(pointer(window, 'pointerup', 100, 415));
  assert.deepEqual(saved().items.map(i => i.id), order, 'порядок не тронут');

  // уход пальца за пределы списка вбок — тоже отмена
  stubRows(rows());
  rows()[0].dispatchEvent(pointer(window, 'pointerdown', 100, 230));
  await hold();
  document.dispatchEvent(pointer(window, 'pointermove', 500, 415));
  document.dispatchEvent(pointer(window, 'pointerup', 500, 415));
  assert.deepEqual(saved().items.map(i => i.id), order);
});

test('перетаскивание: блоки и упражнения тоже переставляются', async () => {
  const seed = orderSeed();
  const old = addKey(prevMonday(), -14);
  seed.exercises = [
    { id: 'e1', name: 'Жим', unit: 'кг', value: 40, active: true, addedAt: old, history: [] },
    { id: 'e2', name: 'Тяга', unit: 'кг', value: 60, active: true, addedAt: old, history: [] },
    { id: 'e3', name: 'Присед', unit: 'кг', value: 80, active: true, addedAt: old, history: [] }
  ];
  const { document, window } = await boot({ seed });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  document.querySelector('#tabs button[data-tab="settings"]').click();

  // блоки: второй встаёт первым
  const gRows = () => [...document.querySelectorAll('#scr-settings [data-drag="group"]')];
  stubRows(gRows());
  gRows()[1].dispatchEvent(pointer(window, 'pointerdown', 100, 290));
  await hold();
  document.dispatchEvent(pointer(window, 'pointermove', 100, 215));
  document.dispatchEvent(pointer(window, 'pointerup', 100, 215));
  assert.deepEqual(saved().groups.map(g => g.name), ['Вечер', 'Утро']);

  // упражнения: третье встаёт первым
  const xRows = () => [...document.querySelectorAll('#scr-settings [data-drag="ex"]')];
  stubRows(xRows());
  xRows()[2].dispatchEvent(pointer(window, 'pointerdown', 100, 350));
  await hold();
  document.dispatchEvent(pointer(window, 'pointermove', 100, 215));
  document.dispatchEvent(pointer(window, 'pointerup', 100, 215));
  assert.deepEqual(saved().exercises.map(e => e.name), ['Присед', 'Жим', 'Тяга']);
});

test('стрелки после 16F: двигают внутри блока и отключены на его границах', async () => {
  const { document, window } = await boot({ seed: orderSeed() });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const rowOf = id => [...document.querySelectorAll('#scr-settings [data-drag="item"]')]
    .find(r => r.dataset.dragId === id);

  assert.equal(rowOf('a1').querySelector('[data-act="move-up"]').disabled, true, 'первый в блоке');
  assert.equal(rowOf('a3').querySelector('[data-act="move-down"]').disabled, true, 'последний в блоке');
  assert.equal(rowOf('b1').querySelector('[data-act="move-up"]').disabled, true, 'один в блоке');
  assert.equal(rowOf('b1').querySelector('[data-act="move-down"]').disabled, true);

  rowOf('a2').querySelector('[data-act="move-down"]').click();
  assert.deepEqual(saved().items.map(i => i.id), ['a1', 'a3', 'b1', 'a2']);
  assert.equal(saved().items[2].id, 'b1', 'чужой блок не сдвинулся');
});

/* ── Задача 16, фаза G. Отделка ────────────────────────────── */

test('источники: новых кеглей и радиусов не заведено — только прежняя шкала', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const values = re => new Set([...css.matchAll(re)].map(m => m[1].trim()));

  // снимок шкалы, какой она была до задачи 16: новые поверхности обязаны
  // жить на ней. Токены — предпочтительная форма, сырые px — наследие.
  // 11px из набора убран (задача 27, п. 9.8): ступень упразднена задачей 26
  // вместе с прежним кеглем .g-label, но сторож продолжал её разрешать —
  // упразднение держалось на слове, а не на проверке
  const SIZES = new Set(['var(--text-base)', 'var(--text-sm)', 'var(--text-xs)',
    '10px', '12px', '13px', '14px', '15px', '16px', '17px', '18px', '20px', '22px', '24px', '32px']);
  const RADII = new Set(['var(--radius)', 'var(--radius-md)', 'var(--radius-sm)',
    '2px', '8px', '10px', '14px', '50%']);

  for (const v of values(/font-size:\s*([^;]+);/g)) {
    assert.ok(SIZES.has(v), `новый кегль в styles.css: ${v}`);
  }
  for (const v of values(/border-radius:\s*([^;]+);/g)) {
    assert.ok(RADII.has(v), `новый радиус в styles.css: ${v}`);
  }

  // поля ввода не мельче 16px (iOS иначе зумит при фокусе)
  const fieldRule = (css.match(/\.field input[^{]*\{([^}]*)\}/) || [])[1] || '';
  assert.match(fieldRule, /font-size:\s*16px/);
  const numRule = (css.match(/\.raise-line \.num[^{]*\{([^}]*)\}/) || [])[1] || '';
  assert.match(numRule, /font-size:\s*16px/);
  assert.match(numRule, /min-height:\s*44px/);

  // движение новых поверхностей — в окне 180–260 мс и снимается reduced-motion
  const drag = (css.match(/\.drag-row\s*\{([^}]*)\}/) || [])[1] || '';
  const ms = Number((drag.match(/transition:[^;]*?([\d.]+)s/) || [])[1]) * 1000;
  assert.ok(ms >= 180 && ms <= 260, `переход раздвижения ${ms} мс вне окна 180–260`);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after\s*\{[^}]*transition: none !important/);
});

test('пустое хранилище: все экраны и листы рендерятся без исключений', async () => {
  // store без единой записи — состояние после импорта пустого экспорта.
  // seed17 стоит: посев задачи 17 в такой экспорт уже заглядывал и завёл
  // программу, иначе пустого store не бывает вовсе (см. отдельный тест посева)
  const empty = {
    schemaVersion: 14, items: [], groups: [], days: {}, weekLog: [], reviews: [],
    pendingRaises: [], pendingLowers: [], exercises: [], sessions: [], notes: [],
    paramDecided: {}, draftOneChange: '', weekStart: daysAgo(0),
    settings: { dayBoundary: 4, exportedAt: null, calendarSince: curMonday(), habitSeeded: true, seed17: true }
  };
  const { document } = await boot({ seed: empty });

  const map = {
    today: 'scr-today', habits: 'scr-habits', progress: 'scr-progress',
    notes: 'scr-notes', settings: 'scr-settings'
  };
  for (const [tab, id] of Object.entries(map)) {
    document.querySelector(`#tabs button[data-tab="${tab}"]`).click();
    const scr = document.getElementById(id);
    assert.equal(scr.hidden, false, tab);
    assert.ok(scr.innerHTML.length > 0, tab);
  }

  // «Сегодня» пуст и молчит: ни планки дня, ни счётчиков
  document.querySelector('#tabs button[data-tab="today"]').click();
  const today = document.getElementById('scr-today');
  assert.equal(today.querySelectorAll('input[data-act="mark"]').length, 0);
  assert.equal(today.querySelector('.weekcount'), null);
  assert.equal(today.querySelector('.dayline'), null, 'планке дня нечего измерять');
  assert.match(today.textContent, /Пунктов пока нет/);

  // «Прогресс» на пустых данных: ноль дней, ноль серии, сетка на месте
  document.querySelector('#tabs button[data-tab="progress"]').click();
  const prog = document.getElementById('scr-progress');
  // эпоха началась в понедельник этой недели: «в системе» — её прожитые дни
  const inSystem = Math.round((new Date(daysAgo(0)) - new Date(curMonday())) / 86400000) + 1;
  const stats = [...prog.querySelectorAll('.stat')].map(x => x.textContent);
  assert.match(stats[0], new RegExp('^' + inSystem + ' '));
  assert.match(stats[1], /^0 дней$/, 'серии на пустых данных нет');
  assert.equal(prog.querySelectorAll('.cdays i').length, 56);
  assert.equal(prog.querySelectorAll('.rise').length, 0, 'подъёма без истории нет');
  // задача 17, п. 8.3: блок остаётся, пустоту объясняет одна muted-строка
  assert.match(prog.textContent, /Появится, когда планка изменится во второй раз\./);
  assert.match(prog.textContent, /Пунктов пока нет\./);
  // задача 23, п. 9.1: у цепи своя строка — прежде обе карточки говорили
  // «Первые отметки появятся здесь.» слово в слово
  assert.match(prog.textContent, /Цепь заполнится с первой отметки\./);
  assert.match(prog.textContent, /Серия начнётся с первого зачтённого дня\./);

  // «Настройки» пусты, но живы
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const sett = document.getElementById('scr-settings');
  assert.match(sett.textContent, /Блоков пока нет/);
  assert.match(sett.textContent, /Упражнений пока нет/);
  assert.equal(sett.querySelectorAll('[data-drag]').length, 0);
});

/* ── Задача 16.1. Обратимая чистка в интерфейсе ────────────── */

/* Открыть «Настройки» и раскрыть блок «Данные» */
function openData(document) {
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const sect = [...document.querySelectorAll('#scr-settings details.sect')]
    .find(d => /Данные/.test(d.querySelector('summary').textContent));
  assert.ok(sect, 'секция «Данные»');
  sect.querySelector('summary').click();
  return sect;
}

/* Полный путь чистки: предупреждение → «Стереть» → подтверждение */
/* Закрытие недели требует второго тапа (задача 28.B, п. 6): первый только
   взводит и печатает строку последствия. Узел после первого тапа пересоздан
   перерисовкой — ищем его заново. */
function closeWeekThroughUi(doc) {
  const btn = () => doc.querySelector('[data-act="close-week"]');
  assert.ok(btn(), 'кнопка «Закрыть неделю»');
  btn().click();
  assert.match(btn().textContent, /Подтвердить/, 'первый тап только взводит');
  btn().click();
}

function wipeThroughUi(document) {
  openData(document);
  document.querySelector('[data-act="wipe-open"]').click();
  document.querySelector('[data-act="wipe-do"]').click();  // первый тап — предупреждение
  document.querySelector('[data-act="wipe-do"]').click();  // второй — стирание
}

test('чистка: предупреждение с числами, второй тап стирает, «Сегодня» остаётся пустым', async () => {
  const seed = trainSeed();
  seed.notes = [{ id: 'n1', date: daysAgo(0), text: 'мысль', updatedAt: 1 }];
  seed.days = { [daysAgo(0)]: { it1: true } };
  const { document, window } = await boot({ seed });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));

  openData(document);
  const danger = () => document.querySelector('#scr-settings .danger');
  assert.match(danger().textContent, /Начать с чистого листа/);
  assert.equal(danger().querySelector('[data-act="wipe-do"]'), null, 'по тапу, не сразу');

  document.querySelector('[data-act="wipe-open"]').click();
  const warn = danger().textContent;
  assert.match(warn, /Будут стёрты: 2 пункта, 0 блоков, 1 день отметок, 0 разборов, 0 лестниц, 2 упражнения, 0 тренировок, 1 заметка\./);
  assert.match(warn, /Копию можно вернуть|Копия останется/);
  assert.ok(danger().querySelector('[data-act="export"]'), 'кнопка «Сначала скачать копию»');
  assert.ok(danger().querySelector('[data-act="wipe-cancel"]'));

  // «Отмена» ничего не трогает
  document.querySelector('[data-act="wipe-cancel"]').click();
  assert.equal(saved().items.length, 2);
  assert.equal(document.querySelector('[data-act="wipe-do"]'), null);

  // первый тап «Стереть» просит подтверждения и данных не трогает
  document.querySelector('[data-act="wipe-open"]').click();
  document.querySelector('[data-act="wipe-do"]').click();
  assert.match(document.querySelector('[data-act="wipe-do"]').textContent, /Подтвердить/);
  assert.equal(saved().items.length, 2, 'первый тап не стирает');

  document.querySelector('[data-act="wipe-do"]').click();

  const s = saved();
  assert.deepEqual(s.items, []);
  assert.deepEqual(s.days, {});
  assert.deepEqual(s.notes, []);
  assert.deepEqual(s.exercises, []);
  assert.equal(s.settings.dayBoundary, 4);

  // после чистки — «Сегодня» с пустым списком и своей строкой
  assert.equal(document.getElementById('scr-today').hidden, false);
  assert.match(document.getElementById('scr-today').textContent, /Пунктов пока нет/);
  assert.equal(document.querySelectorAll('#scr-today input[data-act="mark"]').length, 0);
  assert.equal(document.querySelector('#scr-today .weekcount'), null);
});

test('чистка: «Вернуть» восстанавливает всё, «Убрать копию» — вторым тапом', async () => {
  const seed = trainSeed();
  seed.days = { [daysAgo(0)]: { it1: true } };
  const { document, window } = await boot({ seed });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  const before = saved();

  wipeThroughUi(document);
  assert.deepEqual(saved().items, []);

  // строка возврата — первой в «Данных», с датой и числами
  const sect = openData(document);
  const line = sect.querySelector('.restore');
  assert.ok(line, 'строка возврата');
  assert.equal(sect.querySelector('.sect-b').firstElementChild, line, 'первой строкой блока');
  // строка называет содержимое копии и его происхождение (задача 26, п. 1.2):
  // после второго тапа по «Вернуть» слово «Стёрто» называло бы стёртым как
  // раз возвращённое — копия обменная
  assert.match(line.textContent, /В копии — состояние до чистки, .* · 2 пункта, 1 день отметок/);
  assert.match(line.textContent, /«Вернуть» меняет местами/);

  document.querySelector('[data-act="wipe-undo"]').click();
  assert.deepEqual(saved(), before, 'состояние вернулось побайтово');
  // менять было не на что: store после чистки пуст, пустое в копию не кладут
  assert.equal(window.localStorage.getItem(NS + ':wiped'), null, 'копия отдана без замены');
  assert.equal(document.querySelector('.restore'), null);

  // ещё раз — и на сей раз копию убираем руками, вторым тапом
  wipeThroughUi(document);
  openData(document);
  assert.ok(document.querySelector('.restore'));
  document.querySelector('[data-act="wipe-drop"]').click();
  assert.match(document.querySelector('[data-act="wipe-drop"]').textContent, /Подтвердить/);
  assert.ok(window.localStorage.getItem(NS + ':wiped'), 'первый тап не убирает');
  document.querySelector('[data-act="wipe-drop"]').click();
  assert.equal(window.localStorage.getItem(NS + ':wiped'), null);
  assert.equal(document.querySelector('.restore'), null);
  assert.deepEqual(saved().items, [], 'стёртое так и осталось стёртым');
});

test('чистка: зеркало несёт пустой store, повторный старт стёртое не возвращает', async () => {
  const idb = new IDBFactory();
  const seed = trainSeed();
  seed.days = { [daysAgo(0)]: { it1: true } };
  const { document, window } = await boot({ seed, idb });

  wipeThroughUi(document);
  await window.flushMirror(); // чистка форсирует сброс сама; ждём завершения записи

  const snap = await idbGet(idb);
  assert.ok(snap, 'снапшот на месте');
  const mirrored = JSON.parse(snap.json);
  assert.deepEqual(mirrored.items, [], 'в зеркале пустой store, а не прежний');
  assert.deepEqual(mirrored.days, {});

  // localStorage исчез (чистка Safari), зеркало — единственный источник:
  // восстановиться должен чистый лист, а не стёртые данные
  const again = await boot({ idb });
  const restored = JSON.parse(again.window.localStorage.getItem(NS));
  assert.deepEqual(restored.items, []);
  assert.deepEqual(restored.days, {});
  assert.match(again.document.getElementById('scr-today').textContent, /Пунктов пока нет/);
});

test('чистка: экспорт отдаёт пустой store, импорт копию не трогает', async () => {
  const seed = trainSeed();
  const { document, window } = await boot({ seed });
  wipeThroughUi(document);
  const copy = window.localStorage.getItem(NS + ':wiped');
  assert.ok(copy, 'копия есть');

  openData(document);
  document.querySelector('[data-act="export"]').click(); // exportJSON + перерисовка
  const exported = JSON.parse(window.localStorage.getItem(NS));
  assert.deepEqual(exported.items, [], 'экспортируется текущий store');
  assert.equal('wiped' in exported, false);
  assert.equal(typeof exported.settings.exportedAt, 'number');

  // импорт другого состояния копию не трогает (подтверждение — window.confirm)
  let asked = false;
  window.confirm = () => { asked = true; return true; };
  window.alert = m => { throw new Error('alert при импорте: ' + m); };
  const file = new window.File([JSON.stringify(dueSeed())], 'm.json', { type: 'application/json' });
  const input = document.getElementById('import-file');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  for (let i = 0; i < 100 && !asked; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(asked, true, 'импорт дошёл до подтверждения');
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items.length, 1, 'данные импортированы');
  assert.equal(window.localStorage.getItem(NS + ':wiped'), copy, 'копия не тронута импортом');
});

test('пустая эпоха: шесть экранов после чистки рендерятся без исключений', async () => {
  const { document, window } = await boot({ seed: trainSeed() });
  wipeThroughUi(document);
  const store = JSON.parse(window.localStorage.getItem(NS));
  // эпоха начинается в понедельник, то есть сегодня или позже
  assert.ok(store.settings.calendarSince >= daysAgo(0));

  const map = {
    today: 'scr-today', habits: 'scr-habits', progress: 'scr-progress',
    notes: 'scr-notes', settings: 'scr-settings'
  };
  for (const [tab, id] of Object.entries(map)) {
    document.querySelector(`#tabs button[data-tab="${tab}"]`).click();
    const scr = document.getElementById(id);
    assert.equal(scr.hidden, false, tab);
    assert.ok(scr.innerHTML.length > 0, tab);
  }

  assert.match(document.getElementById('scr-habits').textContent, /Привычек пока нет/);
  assert.match(document.getElementById('scr-notes').textContent, /Пока пусто/);

  // «Прогресс» пустой эпохи: ноль дней, ноль серии, цепь без единой ячейки
  document.querySelector('#tabs button[data-tab="progress"]').click();
  const prog = document.getElementById('scr-progress');
  assert.deepEqual([...prog.querySelectorAll('.stat')].map(x => x.textContent), ['0 дней', '0 дней']);
  assert.equal(prog.querySelectorAll('.cdays i.full').length, 0);
  assert.equal(prog.querySelectorAll('.cdays i.part').length, 0);
  assert.equal(prog.querySelectorAll('.rise').length, 0, 'подъёма нет');
  // блоки на месте, пустоту объясняют строки п. 8.3 (прежде блоки исчезали)
  assert.match(prog.textContent, /Пунктов пока нет\./);
  assert.match(prog.textContent, /Отсчёт идёт с /);
  // задача 22, п. 3.2: ни одной видимой ячейки — сетки нет вовсе, одна строка
  assert.equal(prog.querySelector('.cdays'), null, 'сетка не рисуется');
  assert.match(prog.textContent, /Цепь начнётся с первого дня отсчёта\./);
  assert.equal(prog.querySelector('.sr-only'), null, 'нечего объявлять скринридеру');
  assert.match(prog.textContent, /Следующий разбор — в понедельник/);
  assert.equal(prog.querySelector('[data-act="goto-review"]'), null);

  // лист разбора в пустой эпохе: currentWeekStart() === null — ветка жива
  window.renderReview();
  const rev = document.getElementById('scr-review');
  assert.match(rev.textContent, /Разбор откроется в понедельник/);
  assert.doesNotMatch(rev.textContent, /NaN|Invalid|undefined/);
  assert.ok(rev.querySelector('[data-act="review-done"]'));
});

/* ── Задача 17. Прогресс, посев и выписка ──────────────────── */

/* Пять пунктов минимума старше эпохи; эпоха — 30 дней назад.
   Сегодня зачтён (5 из 5), вчера отмечено ниже порога (2 из 5),
   позавчера пусто — три состояния ячейки цепи в одном сиде. */
function t17Seed() {
  const old = daysAgo(40);
  const seed = {
    schemaVersion: 14, groups: [], days: {}, weekLog: [], reviews: [],
    pendingRaises: [], pendingLowers: [], exercises: [], sessions: [], notes: [],
    paramDecided: {}, draftOneChange: '', weekStart: curMonday(),
    settings: {
      dayBoundary: 4, dayThreshold: 0.8, exportedAt: null,
      calendarSince: mondayOf(daysAgo(30)), habitSeeded: true, seed17: true
    },
    items: Array.from({ length: 5 }, (_, i) => ({
      id: 'm' + i, name: 'Пункт ' + i, value: null, unit: '', type: 'daily', area: 'min',
      goal: null, note: '', group: '', active: true, addedAt: old, raiseAfter: 0,
      history: [], formula: null, ladder: null, ladderLog: []
    }))
  };
  const mark = (k, n) => {
    seed.days[k] = {};
    for (let i = 0; i < n; i++) seed.days[k]['m' + i] = true;
  };
  mark(daysAgo(0), 5);
  mark(daysAgo(1), 2);
  return seed;
}

const openProgress = document => document.querySelector('#tabs button[data-tab="progress"]').click();

/* Дней в системе для сида t17Seed — от понедельника эпохи до сегодня */
const t17Days = () =>
  Math.round((new Date(daysAgo(0)) - new Date(mondayOf(daysAgo(30)))) / 86400000) + 1;

test('«Прогресс» 17: карточки блоков, рекорд, полоса дня и её подпись', async () => {
  const { document } = await boot({ seed: t17Seed() });
  openProgress(document);
  const scr = document.getElementById('scr-progress');

  // порядок блоков: В системе → Серия → Цепь дней → Подъём → Отметки
  assert.deepEqual([...scr.querySelectorAll('.pcard > h2')].map(x => x.textContent),
    ['В системе', 'Серия', 'Цепь дней', 'Подъём', 'Отметки']);

  // крупные числа — в масштабе h1 и только два
  assert.equal(scr.querySelectorAll('.stat').length, 2);
  assert.match(scr.querySelector('.pcard .stat').textContent,
    new RegExp('^' + t17Days() + ' (день|дня|дней)$'));

  // серия: сегодня зачтён, вчера ниже порога — амнистия, позавчера обрыв
  const streakCard = [...scr.querySelectorAll('.pcard')].find(c => c.querySelector('h2').textContent === 'Серия');
  const streak = streakCard.querySelector('.stat');
  assert.match(streak.textContent, /^1 день$/);
  assert.match(scr.querySelector('.rec').textContent, /^рекорд 1 день$/);

  // полоса дня: заполнение — доля сегодняшнего дня, подпись под ней
  const fill = scr.querySelector('.dbar i');
  assert.equal(fill.style.width, '100%');
  assert.equal(scr.querySelector('.dbar-note').textContent.trim(), 'День закрыт');
  assert.equal(scr.querySelector('.dbar').getAttribute('aria-hidden'), 'true');

  assert.match(scr.textContent, /Пропуск прощается, если прошлый был больше недели назад\./);
  // ни эмодзи, ни очков, ни наград (анти-требования конституции)
  assert.doesNotMatch(scr.textContent, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
});

test('«Прогресс» 17: ячейка цепи — три состояния, дни до эпохи не рисуются', async () => {
  const { document } = await boot({ seed: t17Seed() });
  openProgress(document);
  const cells = [...document.querySelectorAll('#scr-progress .cdays i')];
  assert.equal(cells.length, 56);

  assert.equal(cells.filter(c => c.classList.contains('full')).length, 1, 'зачтён — заливка');
  assert.equal(cells.filter(c => c.classList.contains('part')).length, 1, 'отмечено ниже порога — контур');
  assert.ok(cells.filter(c => c.classList.contains('pre')).length > 0, 'дни до эпохи скрыты');
  // пустые ячейки внутри эпохи: ни full, ни part, ни pre, ни fut
  // по составу классов, а не по точной строке: добавление любого класса
  // ячейке не должно ронять тест о её состоянии (задача 19, C.4.2)
  const plain = cells.filter(c => !c.classList.contains('full') && !c.classList.contains('part')
    && !c.classList.contains('fut') && !c.classList.contains('pre'));
  assert.ok(plain.length > 0);

  // порог влияет на состояние: при 0,3 вчерашние 2 из 5 становятся зачтёнными
  const seed = t17Seed();
  seed.settings.dayThreshold = 0.3;
  const low = await boot({ seed });
  openProgress(low.document);
  const lowCells = [...low.document.querySelectorAll('#scr-progress .cdays i')];
  assert.equal(lowCells.filter(c => c.classList.contains('full')).length, 2);
  assert.equal(lowCells.filter(c => c.classList.contains('part')).length, 0);
});

test('«Прогресс» 17: --chain в блоке цепи дней не используется', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => /\.cd[\w-]*\b/.test(m[1]));
  assert.ok(rules.length >= 3, 'правила цепи найдены');
  for (const [, sel, body] of rules) {
    assert.doesNotMatch(body, /--chain/, `--chain в правиле «${sel.trim()}»`);
  }
  // единственный градиент приложения — полоса дня
  const grads = [...css.matchAll(/[\w-]+gradient\(/g)];
  assert.equal(grads.length, 1, 'градиент в приложении один');
  const fill = (css.match(/\.dbar i\s*\{([^}]*)\}/) || [])[1] || '';
  assert.match(fill, /linear-gradient\(90deg, var\(--accent\), var\(--chain\)\)/);
  // переход ширины — в окне движения 180–260 мс (снимается глобальным reduced-motion)
  const ms = Number((fill.match(/transition:[^;]*?([\d.]+)s/) || [])[1]) * 1000;
  assert.ok(ms >= 180 && ms <= 260, `переход полосы дня ${ms} мс вне окна 180–260`);
  assert.match((css.match(/\.dbar\s*\{([^}]*)\}/) || [])[1] || '', /border-radius:\s*var\(--radius-sm\)/);
  assert.match((css.match(/\.dbar\s*\{([^}]*)\}/) || [])[1] || '', /height:\s*8px/);
});

test('«Прогресс» 17: знаменатель «Отметок» — по позднейшей из дат', async () => {
  const seed = t17Seed();
  seed.items.push({
    id: 'fresh', name: 'Вчерашний', value: null, unit: '', type: 'daily', area: 'min',
    goal: null, note: '', group: '', active: true, addedAt: daysAgo(1), raiseAfter: 0,
    history: [], formula: null, ladder: null, ladderLog: []
  });
  const { document } = await boot({ seed });
  openProgress(document);
  const scr = document.getElementById('scr-progress');
  assert.match(scr.textContent, new RegExp('Пункт 0 · 2 из ' + t17Days()));
  assert.match(scr.textContent, /Вчерашний · 0 из 2/);
});

test('«Прогресс» 17: выписка дня — последняя строка, детерминированная', async () => {
  const seed = t17Seed();
  seed.notes = [
    { id: 'q0', date: daysAgo(3), text: 'Первая', kind: 'quote', source: 'Овидий', updatedAt: 3 },
    { id: 'q1', date: daysAgo(4), text: 'Вторая', kind: 'quote', source: '', updatedAt: 2 },
    { id: 'n1', date: daysAgo(5), text: 'просто мысль', kind: 'note', source: '', updatedAt: 1 }
  ];
  const { document } = await boot({ seed });
  openProgress(document);
  const scr = document.getElementById('scr-progress');

  const q = scr.querySelector('.quote');
  assert.ok(q, 'строка выписки есть');
  assert.equal(scr.lastElementChild, scr.querySelector('.qsrc') || q, 'выписка — последней строкой');
  assert.match(q.textContent, /^«(Первая|Вторая)»$/, 'текст в кавычках');
  assert.doesNotMatch(scr.textContent, /просто мысль/, 'заметка на «Прогресс» не попадает');

  // повторный рендер того же дня даёт ту же выписку
  const first = q.textContent;
  document.querySelector('#tabs button[data-tab="today"]').click();
  openProgress(document);
  assert.equal(document.querySelector('#scr-progress .quote').textContent, first);

  // выписок нет — строки нет, экран цел
  const bare = await boot({ seed: t17Seed() });
  openProgress(bare.document);
  assert.equal(bare.document.querySelector('#scr-progress .quote'), null);
  assert.ok(bare.document.getElementById('scr-progress').innerHTML.length > 0);
});

test('«Заметки» 17: выписка отличается источником и кавычками, удаляется как заметка', async () => {
  const { document, window } = await boot({ seed: t17Seed() });
  document.querySelector('#tabs button[data-tab="notes"]').click();
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  const scr = document.getElementById('scr-notes');

  assert.deepEqual([...scr.querySelectorAll('.nadd .btn')].map(b => b.textContent),
    ['Новая заметка', 'Новая выписка']);

  // обычная заметка поля «Источник» не имеет
  scr.querySelector('[data-act="note-add-open"][data-kind="note"]').click();
  assert.equal(document.getElementById('n-source'), null);
  document.querySelector('[data-act="note-cancel"]').click();

  // выписка — то же плюс источник
  scr.querySelector('[data-act="note-add-open"][data-kind="quote"]').click();
  document.getElementById('n-text').value = 'Кто везде — тот нигде.';
  document.getElementById('n-source').value = '  Сенека  ';
  document.querySelector('[data-act="note-save"]').click();

  const notes = saved().notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'quote');
  assert.equal(notes[0].source, 'Сенека');
  assert.match(scr.querySelector('.ntext').textContent, /^«Кто везде — тот нигде\.»$/);
  assert.equal(scr.querySelector('.nsrc').textContent, 'Сенека');

  // правка выписки не теряет вид, удаление — вторым тапом
  scr.querySelector('[data-act="note-open"]').click();
  assert.equal(document.getElementById('n-source').value, 'Сенека');
  document.querySelector('[data-act="note-del"]').click();
  assert.match(document.querySelector('[data-act="note-del"]').textContent, /Подтвердить/);
  document.querySelector('[data-act="note-del"]').click();
  assert.deepEqual(saved().notes, []);
});

test('«Настройки» 17: степпер порога и подпись «не меньше N из M»', async () => {
  const { document, window } = await boot({ seed: t17Seed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  const scr = document.getElementById('scr-settings');
  const line = () => [...scr.querySelectorAll('.muted')].map(p => p.textContent).join(' ');

  assert.match(scr.textContent, /Отмечено не меньше\s*80%/);
  assert.match(line(), /День зачтён, если отмечено не меньше 4 из 5\./);

  document.querySelector('[data-act="thr-dec"]').click();
  assert.equal(saved().settings.dayThreshold, 0.7);
  assert.match(document.getElementById('scr-settings').textContent, /Отмечено не меньше\s*70%/);
  assert.match(line(), /не меньше 4 из 5\./, '0,7 от пяти — по-прежнему четыре');

  // границы диапазона: до 0,3 вниз и до 1,0 вверх, дальше кнопка отключена
  for (let i = 0; i < 10; i++) document.querySelector('[data-act="thr-dec"]').click();
  assert.equal(saved().settings.dayThreshold, 0.3);
  assert.equal(document.querySelector('[data-act="thr-dec"]').disabled, true);
  assert.match(line(), /не меньше 2 из 5\./);
  for (let i = 0; i < 10; i++) document.querySelector('[data-act="thr-inc"]').click();
  assert.equal(saved().settings.dayThreshold, 1);
  assert.equal(document.querySelector('[data-act="thr-inc"]').disabled, true);
  assert.match(line(), /не меньше 5 из 5\./);
});

test('«Настройки» 22: начало отсчёта — понедельник недели, будущая дата принимается', async () => {
  const { document, window } = await boot({ seed: t17Seed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  openData(document);
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  const field = () => document.getElementById('since');
  const set = v => {
    field().value = v;
    field().dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  assert.equal(field().value, mondayOf(daysAgo(30)));
  assert.equal(field().hasAttribute('max'), false, 'потолка у поля нет (задача 22, п. 8.1)');
  assert.match(document.getElementById('scr-settings').textContent,
    /Меняет счёт дней в системе, серию и доступность разбора\. Отметки не затрагивает\./);

  // середина недели приводится к понедельнику своей недели
  const wed = daysAgo(9);
  set(wed);
  assert.equal(saved().settings.calendarSince, mondayOf(wed));
  assert.equal(field().value, mondayOf(wed), 'поле показывает принятое значение');

  // мусор по-прежнему не принимается
  const before = saved().settings.calendarSince;
  set('не дата');
  assert.equal(saved().settings.calendarSince, before);
  assert.equal(field().value, before);

  // смена пересчитывает «в системе» и серию
  openProgress(document);
  const days = [...document.querySelectorAll('#scr-progress .stat')][0].textContent;
  assert.match(days, new RegExp('^' + (Math.round((new Date(daysAgo(0)) - new Date(before)) / 86400000) + 1) + ' '));

  // задача 22, п. 8: будущая дата законна — эпоха просто ещё не наступила
  document.querySelector('#tabs button[data-tab="settings"]').click();
  openData(document);
  const ahead = addKey(daysAgo(0), 7);
  set(ahead);
  assert.equal(saved().settings.calendarSince, mondayOf(ahead), 'принята и нормализована');
  assert.ok(saved().settings.calendarSince > daysAgo(0), 'эпоха впереди');

  // все экраны в этой пустой эпохе работают, как после чистки
  openProgress(document);
  const prog = document.getElementById('scr-progress');
  assert.match(prog.textContent, /^\s*Накопленное/);
  assert.deepEqual([...prog.querySelectorAll('.stat')].map(x => x.textContent), ['0 дней', '0 дней']);
  assert.equal(prog.querySelector('.cdays'), null, 'цепи нет — видимых ячеек ноль');
  assert.match(prog.textContent, /Цепь начнётся с первого дня отсчёта\./);
  assert.match(prog.textContent, /Первые отметки появятся здесь\./);
  assert.doesNotMatch(prog.innerHTML, /NaN/);
  for (const tab of ['today', 'habits', 'notes', 'settings']) {
    document.querySelector(`#tabs button[data-tab="${tab}"]`).click();
    const scr = document.getElementById('scr-' + tab);
    assert.equal(scr.hidden, false, tab);
    assert.doesNotMatch(scr.innerHTML, /NaN/, tab);
  }
  window.renderReview();
  assert.match(document.getElementById('scr-review').textContent, /Разбор откроется в понедельник/);
});

test('посев 17 в браузере: пустой localStorage через migrate даёт программу и выписки', async () => {
  // v13-экспорт с пустыми items — состояние владельца после чистки прежней версией
  const raw = JSON.stringify({
    schemaVersion: 13, items: [], groups: [], days: {}, weekLog: [], reviews: [],
    pendingRaises: [], pendingLowers: [], exercises: [], sessions: [], notes: [],
    paramDecided: {}, draftOneChange: '', weekStart: daysAgo(0),
    settings: { dayBoundary: 4, exportedAt: null, calendarSince: curMonday(), habitSeeded: true }
  });
  const { document, window } = await boot({ raw });
  const store = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(store.items.length, 9);
  assert.equal(store.notes.length, 5);
  assert.equal(store.settings.seed17, true);

  // все шесть экранов живы на засеянных данных
  for (const [tab, id] of Object.entries({
    today: 'scr-today', habits: 'scr-habits', progress: 'scr-progress',
    notes: 'scr-notes', settings: 'scr-settings'
  })) {
    document.querySelector(`#tabs button[data-tab="${tab}"]`).click();
    assert.equal(document.getElementById(id).hidden, false, tab);
  }
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.equal(document.querySelectorAll('#scr-today input[data-act="mark"]').length, 6,
    'шесть ежедневных пунктов минимума');
  assert.match(document.getElementById('scr-today').textContent, /Английский/);
  document.querySelector('#tabs button[data-tab="habits"]').click();
  assert.match(document.getElementById('scr-habits').textContent, /Телефон вне кровати/);
  assert.match(document.getElementById('scr-habits').textContent, /Отбой/);
});

/* ── Задача 19, фаза A.1: три исхода чтения зеркала ────────── */

/* IndexedDB, у которого open отвечает позже стартового таймаута
   (MIRROR_PROBE_MS), но всё-таки отвечает: ровно тот случай, в котором
   прежний код успевал объявить зеркало пустым и записать в него
   дефолтный store. Задержка задаётся кратно таймауту, а не числом
   в миллисекундах: предмет проверки — «позже таймаута», и связь должна
   держаться при любой его величине (задача 23, п. 1.4). */
const SLOW_IDB_MS = T.MIRROR_PROBE_MS * 4;

function slowIdb(real, delayMs) {
  return {
    open(name, ver) {
      const inner = real.open(name, ver);
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
      inner.onupgradeneeded = (e) => { req.result = inner.result; if (req.onupgradeneeded) req.onupgradeneeded(e); };
      inner.onsuccess = () => setTimeout(() => {
        req.result = inner.result;
        if (req.onsuccess) req.onsuccess();
        else { try { inner.result.close(); } catch (e) { /* некому отдать */ } }
      }, delayMs);
      inner.onerror = () => { req.error = inner.error; if (req.onerror) req.onerror(); };
      return req;
    }
  };
}

test('A.1.5: медленное зеркало при пустом localStorage — снапшот НЕ затирается дефолтом', async () => {
  const real = new IDBFactory();
  await idbPut(real, { json: JSON.stringify(mirrorStore()), savedAt: 4242, schemaVersion: 4 });

  // первый старт: localStorage пуст, IndexedDB отвечает позже таймаута
  const a = await boot({ idb: slowIdb(real, SLOW_IDB_MS) });
  assert.equal(a.document.getElementById('scr-today').hidden, false, 'приложение работает');
  assert.equal(a.document.querySelectorAll('input[data-act="mark"]').length, 6, 'на экране дефолтная программа');

  // дать медленному open дойти: если бы зеркало считалось готовым,
  // именно здесь дефолт и уехал бы в снапшот
  await wait(SLOW_IDB_MS + 200);
  assert.equal(await a.window.flushMirror(), false, 'зеркало в этой сессии не пишется');

  const snap = await idbGet(real);
  assert.equal(snap.savedAt, 4242, 'снапшот тот же');
  const kept = JSON.parse(snap.json);
  assert.equal(kept.items.length, 1);
  assert.equal(kept.items[0].name, 'Восстановленный', 'данные владельца целы');

  // localStorage тоже остался пустым — иначе перезапуск не пошёл бы к зеркалу
  assert.equal(a.window.localStorage.getItem(NS), null, 'дефолт в localStorage не записан');

  // строка «Данных» говорит честно: не ошибка, не тревога — «не проверена»
  a.document.querySelector('#tabs button[data-tab="settings"]').click();
  const note = a.document.getElementById('mirror-note');
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, 'Резервная копия не проверена');
  assert.ok(note.classList.contains('muted'), 'тем же muted');

  // повторный старт с отвечающим IndexedDB — данные восстановлены
  const b = await boot({ idb: real });
  assert.match(b.document.getElementById('scr-today').textContent, /Восстановленный/);
  assert.equal(JSON.parse(b.window.localStorage.getItem(NS)).items.length, 1);
});

test('A.5.2: «Три закрытые недели» — три последние календарные недели, а не три разбора', async () => {
  const seed = dueSeed();
  // разборы полугодовой давности с чужими числами: в блок они попасть не должны
  seed.reviews = [
    { closedAt: 1, week: '2026-01-05', keys: [], perItem: { it1: { name: 'Тестовый пункт', count: 7 } }, trainings: {}, oneChange: '' },
    { closedAt: 2, week: '2026-01-12', keys: [], perItem: { it1: { name: 'Тестовый пункт', count: 7 } }, trainings: {}, oneChange: '' }
  ];
  // а в трёх последних календарных неделях — 1, 2 и 3 отметки
  seed.days = {};
  fillWeek(seed.days, 'it1', addKey(prevMonday(), -14), 1);
  fillWeek(seed.days, 'it1', addKey(prevMonday(), -7), 2);
  fillWeek(seed.days, 'it1', prevMonday(), 3);
  const { document } = await boot({ seed });
  openReview(document);
  const scr = document.getElementById('scr-review');
  document.querySelector('[data-act="week-fold"]').click();
  const val = [...scr.querySelectorAll('.c-val')].map(x => x.textContent);
  assert.ok(val.length, 'блок консистентности отрисован');
  assert.equal(val[0], '1 · 2 · 3 из 7', 'числа из days{}, порядок от старой недели к новой');
  assert.equal([...scr.querySelectorAll('.c-val')].some(x => /7 · 7/.test(x.textContent)), false,
    'числа из архива разборов в блок не попали');
});

/* ── Задача 19, фаза B ─────────────────────────────────────── */

test('B.3.3: блок назначается привычке через форму и рисуется на «Привычках» линией', async () => {
  const seed = dueSeed();
  seed.groups = [{ name: 'Вечер' }];
  seed.items.push(
    { id: 'h1', name: 'Привычка-1', value: null, unit: '', type: 'daily', area: 'habit',
      normPerWeek: 7, goal: null, note: '', group: '', active: true, addedAt: daysAgo(20), raiseAfter: 0, history: [] },
    { id: 'h2', name: 'Привычка-2', value: null, unit: '', type: 'daily', area: 'habit',
      normPerWeek: 7, goal: null, note: '', group: 'Вечер', active: true, addedAt: daysAgo(20), raiseAfter: 0, history: [] },
    { id: 'pt', name: 'Отбой', value: null, unit: '', type: 'param', area: 'habit',
      pkind: 'time', pvalue: 0, pstep: -15, goal: null, note: '', group: '', active: true,
      addedAt: daysAgo(20), raiseAfter: 0, history: [{ date: daysAgo(20), value: 0 }] }
  );
  const { document, window } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="settings"]').click();

  // до правки блока у привычки нет — на «Привычках» линии тоже нет
  document.querySelector('#tabs button[data-tab="habits"]').click();
  assert.equal(document.querySelectorAll('#scr-habits .chain').length, 0, 'связки пока нет');

  // форма правки привычки: поле «Блок» есть и предлагает заведённые блоки
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const open = [...document.querySelectorAll('[data-act="edit-open"]')].find(b => b.dataset.id === 'h1');
  open.click();
  const sel = document.getElementById('e-group');
  assert.ok(sel, 'у привычки есть поле «Блок»');
  assert.ok([...sel.options].some(o => o.value === 'Вечер'), 'блок «Вечер» в списке');
  sel.value = 'Вечер';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  [...document.querySelectorAll('[data-act="edit-save"]')].find(b => b.dataset.id === 'h1').click();

  const h1 = JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.id === 'h1');
  assert.equal(h1.group, 'Вечер', 'блок сохранён у привычки');

  // на «Привычках» две привычки одного блока связаны линией
  document.querySelector('#tabs button[data-tab="habits"]').click();
  const scr = document.getElementById('scr-habits');
  const labels = [...scr.querySelectorAll('.g-label')].map(x => x.textContent);
  assert.ok(labels.includes('Вечер'), 'заголовок блока на «Привычках»: ' + labels.join('/'));
  const chain = scr.querySelector('.chain');
  assert.ok(chain, 'блок из двух активных привычек рисует связку');
  assert.equal(chain.querySelectorAll('.rowwrap').length, 2);
  assert.ok(chain.querySelector('.cseg'), 'половины линии на месте');

  // и у параметра поле «Блок» тоже есть
  document.querySelector('#tabs button[data-tab="settings"]').click();
  [...document.querySelectorAll('[data-act="edit-open"]')].find(b => b.dataset.id === 'pt').click();
  assert.ok(document.getElementById('e-group'), 'у параметра есть поле «Блок»');
});

test('B.3: форма новой привычки и нового параметра несёт поле «Блок»', async () => {
  const seed = dueSeed();
  seed.groups = [{ name: 'Вечер' }];
  const { document, window } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  // кнопку ищем заново каждый раз: renderSettings пересоздаёт разметку
  const addHabit = () => [...document.querySelectorAll('[data-act="add-open"]')].find(b => b.dataset.area === 'habit');
  addHabit().click();
  assert.ok(document.getElementById('f-group'), 'поле «Блок» в форме новой привычки');
  document.getElementById('f-name').value = 'Новая привычка';
  document.getElementById('f-group').value = 'Вечер';
  document.querySelector('[data-act="add-save"]').click();
  let items = JSON.parse(window.localStorage.getItem(NS)).items;
  assert.equal(items[items.length - 1].group, 'Вечер', 'блок записан при создании привычки');

  // и у параметра: переключаем тип формы
  addHabit().click();
  const type = document.getElementById('f-type');
  type.value = 'param';
  type.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok(document.getElementById('f-group'), 'поле «Блок» в форме нового параметра');
  document.getElementById('f-name').value = 'Новый порог';
  document.getElementById('f-group').value = 'Вечер';
  // шаг с задачи 26 обязателен: параметр без шага не может двинуться, и
  // карточка разбора предлагала бы «Шаг: → то же самое» (п. 2.3)
  document.getElementById('f-pstep').value = '-15';
  document.querySelector('[data-act="add-save"]').click();
  items = JSON.parse(window.localStorage.getItem(NS)).items;
  const p = items[items.length - 1];
  assert.equal(p.type, 'param');
  assert.equal(p.group, 'Вечер', 'блок записан при создании параметра');
});

test('B.5: поле правки предлагаемой планки имеет доступное имя', async () => {
  const seed = dueSeed();
  const prev = prevMonday();
  // три недели по 7 из 7 — карточка повышения
  for (let w = 1; w <= 3; w++) fillWeek(seed.days, 'it1', addKey(prev, -7 * (w - 1)), 7);
  seed.settings.calendarSince = addKey(prev, -70);
  const { document } = await boot({ seed });
  openReview(document);
  const edit = document.querySelector('[data-act="raise-edit"]');
  assert.ok(edit, 'карточка повышения на месте');
  edit.click();
  const inp = document.querySelector('#scr-review input.num');
  assert.ok(inp, 'поле ввода раскрыто');
  const name = inp.getAttribute('aria-label');
  assert.ok(name && name.trim(), 'у поля есть доступное имя');
  assert.match(name, /Тестовый пункт/, 'имя называет пункт');
});

test('B.2: тач-таргет .itxt — min-height 44px в правиле', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const rule = (css.match(/\.itxt\s*\{([^}]*)\}/) || [])[1] || '';
  assert.match(rule, /min-height:\s*44px/, '.itxt не ниже тач-таргета');
  assert.match(rule, /justify-content:\s*center/, 'текст остаётся по центру строки');
});

/* ── Задача 19, C.2: непокрытые утверждения инвариантов ───────── */

test('C.2 (И3): черновик «одного изменения» пишется вводом и переживает перерисовку', async () => {
  const seed = dueSeed();
  const { document, window } = await boot({ seed });
  openReview(document);
  const inp = document.querySelector('[data-bind="one-change"]');
  assert.ok(inp, 'поле «одного изменения» на месте');

  inp.value = 'ложиться раньше';
  inp.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).draftOneChange, 'ложиться раньше',
    'ввод сохраняется сразу, а не при закрытии недели');

  // перерисовка разбора черновик не теряет
  document.querySelector('[data-act="week-fold"]').click();
  assert.equal(document.querySelector('[data-bind="one-change"]').value, 'ложиться раньше');

  // и уходит в срез при закрытии недели
  closeWeekThroughUi(document);
  const st = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(st.reviews[st.reviews.length - 1].oneChange, 'ложиться раньше');
  assert.equal(st.draftOneChange, '', 'после закрытия черновик чист');
});

test('C.2 (И8): смена дня блокирует click, но НЕ прерывает непрерывный ввод', async () => {
  const seed = dueSeed();
  const { document, window } = await boot({ seed });
  openReview(document);

  // экран устарел: логический день сменился при открытом приложении
  shiftWindowDate(window, 26 * 3600000);

  const inp = document.querySelector('[data-bind="one-change"]');
  inp.value = 'черновик принадлежит неделе, а не дню';
  inp.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).draftOneChange,
    'черновик принадлежит неделе, а не дню',
    'onInput guard\'ом не прерывается (инвариант 8)');

  // а дискретное действие на устаревшем экране не применяется: сначала
  // перерисовка. Проверяем на отметке — она пишет в конкретный день.
  const b = await boot({ seed });
  const before = JSON.stringify(JSON.parse(b.window.localStorage.getItem(NS)).days);
  shiftWindowDate(b.window, 26 * 3600000);
  const cb = b.document.querySelector('input[data-act="mark"]');
  cb.checked = true;
  cb.dispatchEvent(new b.window.Event('change', { bubbles: true }));
  assert.equal(JSON.stringify(JSON.parse(b.window.localStorage.getItem(NS)).days), before,
    'отметка со stale-экрана не применилась');
});

test('C.2 (И12): метка ступени не окрашена акцентом и не влияет на порядок пунктов', async () => {
  const seed = dueSeed();
  seed.items[0].ladder = { steps: ['первая', 'вторая', 'третья'], step: 1, steppedWeek: null, startedAt: daysAgo(30) };
  seed.items[0].ladderLog = [{ date: daysAgo(30), step: 0, text: 'первая', start: true }];
  seed.items.push({
    id: 'it2', name: 'Второй пункт', value: null, unit: '', type: 'daily', area: 'min',
    goal: null, note: '', group: '', active: true, addedAt: daysAgo(30), raiseAfter: 0, history: []
  });
  const { document } = await boot({ seed });
  const scr = document.getElementById('scr-today');
  const step = scr.querySelector('.lstep');
  assert.ok(step, 'метка положения на лестнице показана');
  assert.equal(step.textContent, '2/3');

  // цвет метки — не акцентный: она операционная, а не достижение
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const rule = (css.match(/\.lstep\s*\{([^}]*)\}/) || [])[1] || '';
  assert.ok(rule, 'у .lstep есть правило');
  assert.doesNotMatch(rule, /var\(--accent\)/, 'метка не окрашивается акцентом');

  // порядок строк — как в items[], лестница на него не влияет
  const names = [...scr.querySelectorAll('.rowwrap .tname')].map(x => x.textContent.split(' ')[0]);
  assert.equal(names[0], 'Тестовый', 'пункт с лестницей остался первым — где и был в items[]');
  assert.ok(names.includes('Второй'), 'второй пункт на месте');
});

test('C.2 (И16): вид записи задан при создании и не меняется правкой', async () => {
  const { document, window } = await boot();
  document.querySelector('#tabs button[data-tab="notes"]').click();

  // создаём выписку
  [...document.querySelectorAll('[data-act="note-add-open"]')].find(b => b.dataset.kind === 'quote').click();
  document.getElementById('n-text').value = 'Капля точит камень';
  document.getElementById('n-source').value = 'Овидий';
  document.querySelector('[data-act="note-save"]').click();

  const added = JSON.parse(window.localStorage.getItem(NS)).notes.find(n => n.text === 'Капля точит камень');
  assert.equal(added.kind, 'quote');

  // открываем её на правку: поля вида нет, есть только источник
  [...document.querySelectorAll('[data-act="note-open"]')].find(b => b.dataset.id === added.id).click();
  assert.equal(document.querySelector('#scr-notes select'), null, 'вида записи в форме правки нет');
  assert.ok(document.getElementById('n-source'), 'у выписки правится источник');
  document.getElementById('n-text').value = 'Капля точит камень иначе';
  document.getElementById('n-source').value = 'Овидий, Письма';
  [...document.querySelectorAll('[data-act="note-save"]')].find(b => b.dataset.id === added.id).click();

  const after = JSON.parse(window.localStorage.getItem(NS)).notes.find(n => n.id === added.id);
  assert.equal(after.kind, 'quote', 'вид пережил правку');
  assert.equal(after.text, 'Капля точит камень иначе');
  assert.equal(after.source, 'Овидий, Письма');

  // и у заметки источник не заводится правкой
  document.querySelector('[data-act="note-cancel"]') && document.querySelector('[data-act="note-cancel"]').click();
  [...document.querySelectorAll('[data-act="note-add-open"]')].find(b => b.dataset.kind === 'note').click();
  document.getElementById('n-text').value = 'Просто мысль';
  assert.equal(document.getElementById('n-source'), null, 'у заметки поля «Источник» нет');
  document.querySelector('[data-act="note-save"]').click();
  const plain = JSON.parse(window.localStorage.getItem(NS)).notes.find(n => n.text === 'Просто мысль');
  assert.equal(plain.kind, 'note');
  assert.equal(plain.source, '');
});

test('C.2 (И18): чистка сбрасывает зеркало немедленно, без ожидания дебаунса', async () => {
  const idb = new IDBFactory();
  const seed = trainSeed();
  // дебаунс намеренно длинный: предмет теста — «раньше дебаунса» (23, п. 1.4)
  const { document, window } = await boot({ idb, seed, timing: { MIRROR_FLUSH_MS: 5000 } });
  await window.flushMirror();               // в зеркале — данные владельца
  const before = JSON.parse((await idbGet(idb)).json);
  assert.ok(before.items.length > 0, 'снапшот с данными на месте');

  wipeThroughUi(document);
  // ждём заметно меньше дебаунса и НЕ зовём flushMirror руками:
  // сброс обязан быть немедленным, иначе следующий старт при пропавшем
  // localStorage восстановил бы стёртое из старого снапшота
  await wait(60);
  const after = JSON.parse((await idbGet(idb)).json);
  assert.deepEqual(after.items, [], 'зеркало уже пусто');
  assert.equal(after.settings.seed17, true, 'и несёт флаг посева');
});

test('C.6.3: при reduced-motion «Сохранено» видно, потом исчезает', async () => {
  const { document, window } = await boot();
  window.matchMedia = q => ({ matches: /prefers-reduced-motion/.test(q), media: q, addListener() {}, removeListener() {} });

  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('[data-act="edit-open"]').click();
  document.getElementById('e-name').value = 'Переименованный';
  document.querySelector('[data-act="edit-save"]').click();

  const flash = document.querySelector('#scr-settings .flash');
  assert.ok(flash, 'подтверждение показано');
  assert.equal(flash.textContent, 'Сохранено');
  // CSS обязан показывать его статично: в блоке reduced-motion есть правило
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(block, /\.flash\s*\{[^}]*opacity:\s*1/, 'при reduced-motion .flash показан');

  // и убирается сам, без анимации. Предмет теста — «видно, потом исчезает»:
  // проверяем оба конца окна, иначе мгновенное удаление тоже прошло бы
  await wait(Math.round(T.FLASH_MS / 2));
  assert.ok(document.querySelector('#scr-settings .flash'), 'до срока подтверждение ещё видно');
  await wait(T.FLASH_MS);
  assert.equal(document.querySelector('#scr-settings .flash'), null, 'подтверждение ушло');
});

test('C.6.4: копию некуда положить — чистка отменена и об этом сказано', async () => {
  const { document, window } = await boot();
  // Квота кончилась ровно на записи копии; сам store сохраняться может.
  // Подменять метод на самом объекте нельзя: localStorage в jsdom — Proxy,
  // и присваивание свойства кладёт значение в хранилище, а не переопределяет
  // метод. Подменяем на прототипе и возвращаем обратно в конце.
  const proto = Object.getPrototypeOf(window.localStorage);
  const real = proto.setItem;
  proto.setItem = function (k, v) {
    if (k === NS + ':wiped') throw new Error('QuotaExceeded');
    return real.call(this, k, v);
  };
  const before = window.localStorage.getItem(NS);

  openData(document);
  document.querySelector('[data-act="wipe-open"]').click();
  document.querySelector('[data-act="wipe-do"]').click(); // первый тап — подтверждение
  document.querySelector('[data-act="wipe-do"]').click(); // второй — сама чистка

  assert.equal(window.localStorage.getItem(NS), before, 'данные не стёрты');
  assert.match(document.getElementById('scr-settings').textContent,
    // текст обобщён в задаче 27.1 (п. 2): чистку теперь отменяет не только
    // «копию некуда положить», но и отказ записи рабочего ключа — сообщение
    // одно на оба повода и говорит главное: данные не изменены
    /Чистка не выполнена — данные не изменены/, 'отказ показан владельцу');
  proto.setItem = real;
});

/* ── Задача 19, C.8: закрытие двух дыр, найденных батареей ──── */

test('A.1.2: при недочитанном зеркале действие владельца в него НЕ пишет', async () => {
  const real = new IDBFactory();
  await idbPut(real, { json: JSON.stringify(mirrorStore()), savedAt: 777, schemaVersion: 4 });

  // localStorage пуст, IndexedDB отвечает позже стартового таймаута
  const { document, window } = await boot({ idb: slowIdb(real, SLOW_IDB_MS) });
  await wait(SLOW_IDB_MS + 200); // медленный open дошёл

  // владелец отмечает пункт: обычный save() → scheduleMirror(). Зеркало
  // объявлено непроверенным, писать в него нельзя — иначе снапшот владельца
  // затрётся дефолтной программой при первом же тапе.
  const cb = document.querySelector('input[data-act="mark"]');
  cb.click();
  assert.ok(window.localStorage.getItem(NS), 'в localStorage отметка сохранилась');

  await wait(T.MIRROR_FLUSH_MS * 3 + 60); // заведомо дольше дебаунса зеркала
  const snap = await idbGet(real);
  assert.equal(snap.savedAt, 777, 'снапшот не переписан');
  assert.equal(JSON.parse(snap.json).items[0].name, 'Восстановленный', 'данные владельца целы');
  assert.equal(await window.flushMirror(), false, 'принудительный сброс тоже ничего не пишет');
});

test('C.6.7: импорт сбрасывает форму и черновик заметки', async () => {
  const { document, window } = await boot();
  window.confirm = () => true;
  window.alert = m => { throw new Error('alert при импорте: ' + m); };

  // открыта форма новой заметки с начатым текстом
  document.querySelector('#tabs button[data-tab="notes"]').click();
  [...document.querySelectorAll('[data-act="note-add-open"]')].find(b => b.dataset.kind === 'note').click();
  document.getElementById('n-text').value = 'начатая мысль';
  document.getElementById('n-text').dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#tabs button[data-tab="notes"]').click(); // перерисовка снимает черновик в слот
  assert.ok(document.getElementById('n-text'), 'форма заметки открыта');

  // импорт чужого состояния
  const payload = {
    schemaVersion: 14, items: [{ id: 'x1', name: 'Чужой пункт', type: 'daily', area: 'min', addedAt: daysAgo(3) }],
    days: {}, groups: [], notes: [], settings: { dayBoundary: 4, seed17: true }
  };
  openData(document);
  const inp = document.getElementById('import-file');
  const file = new window.File([JSON.stringify(payload)], 'x.json', { type: 'application/json' });
  Object.defineProperty(inp, 'files', { value: [file], configurable: true });
  inp.dispatchEvent(new window.Event('change', { bubbles: true }));
  for (let i = 0; i < 100 && !JSON.parse(window.localStorage.getItem(NS)).items.some(x => x.id === 'x1'); i++) {
    await new Promise(r => setTimeout(r, 10));
  }

  // форма заметки принадлежала прежним данным — её и черновика больше нет
  document.querySelector('#tabs button[data-tab="notes"]').click();
  assert.equal(document.getElementById('n-text'), null, 'форма заметки закрыта импортом');
  const cards = document.querySelectorAll('#scr-notes .card.note');
  assert.equal(cards.length, 0, 'заметок из файла нет — список пуст');

  // и черновик не всплывает при следующем открытии формы
  [...document.querySelectorAll('[data-act="note-add-open"]')].find(b => b.dataset.kind === 'note').click();
  assert.equal(document.getElementById('n-text').value, '', 'черновик прежних данных не перенесён');
});

/* ── Задача 20. Режим формулы в интерфейсе ─────────────────── */

/* Пункт с формулой: лист детали открывается из строки «Сегодня» */
function formulaSeed(mode) {
  const seed = dueSeed();
  seed.items[0].formula = {
    anchor: 'после зарядки', when: 'в 7:00', pair: 'кофе', identity: 'я читатель',
    twoMin: 'одна страница', friction: 'книга на столе', proof: 'страница прочитана',
    mode: mode || 'build'
  };
  return seed;
}
const openDetail = (document) => {
  document.querySelector('#scr-today [data-act="item-detail"]').click();
  return document.getElementById('scr-detail');
};

test('З20/C.3: блок чтения показывает заголовки своего режима', async () => {
  const build = await boot({ seed: formulaSeed('build') });
  const b = openDetail(build.document);
  const lawsBuild = [...b.querySelectorAll('.overline')].map(x => x.textContent);
  assert.deepEqual(lawsBuild, ['Очевидно', 'Привлекательно', 'Легко', 'Приятно']);
  assert.match(b.textContent, /Якорь/);
  assert.match(b.textContent, /Версия на 2 минуты/);

  const brk = await boot({ seed: formulaSeed('break') });
  const k = openDetail(brk.document);
  const lawsBreak = [...k.querySelectorAll('.overline')].map(x => x.textContent);
  assert.deepEqual(lawsBreak, ['Невидимо', 'Непривлекательно', 'Трудно', 'Приятно']);
  assert.match(k.textContent, /Что перехватываю/);
  assert.match(k.textContent, /Действие-замена/);
  assert.doesNotMatch(k.textContent, /Якорь/, 'подписи режима build не просачиваются');

  // текст владельца в обоих режимах один и тот же
  for (const scr of [b, k]) assert.match(scr.textContent, /после зарядки/);
  // отдельной пометки о режиме в блоке чтения нет (A.2.3)
  assert.doesNotMatch(k.textContent, /Избавляюсь от привычки/);
});

test('З20/C.2: смена режима меняет подписи и подсказки, значения полей остаются', async () => {
  const { document, window } = await boot({ seed: formulaSeed('build') });
  openDetail(document);
  document.querySelector('[data-act="formula-open"]').click();

  const sel = document.getElementById('fx-mode');
  assert.ok(sel, 'переключатель режима первой строкой формы');
  assert.equal(sel.value, 'build');
  assert.deepEqual([...sel.options].map(o => o.textContent), ['Завожу привычку', 'Избавляюсь от привычки']);

  // владелец правит поле и переключает режим, не сохраняя
  document.getElementById('fx-anchor').value = 'рука пошла ко рту';
  document.getElementById('fx-twoMin').value = 'сжать кулак';
  sel.value = 'break';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));

  const scr = document.getElementById('scr-detail');
  assert.equal(document.getElementById('fx-mode').value, 'break', 'режим переключился');
  assert.match(scr.textContent, /Что перехватываю/, 'подписи режима break');
  assert.match(scr.textContent, /Невидимо/, 'заголовки законов режима break');
  assert.equal(document.getElementById('fx-anchor').value, 'рука пошла ко рту', 'значение поля на месте');
  assert.equal(document.getElementById('fx-twoMin').value, 'сжать кулак');
  // в данных пока ничего не менялось — режим применяется сохранением
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items[0].formula.mode, 'build');

  // черновик переживает смену логического дня
  shiftWindowDate(window, 26 * 3600000);
  window.dispatchEvent(new window.Event('focus'));
  assert.equal(document.getElementById('fx-anchor').value, 'рука пошла ко рту', 'черновик пережил смену дня');
  assert.equal(document.getElementById('fx-mode').value, 'break', 'и режим формы тоже');

  // сохранение записывает и режим, и текст
  document.querySelector('[data-act="formula-save"]').click();
  const f = JSON.parse(window.localStorage.getItem(NS)).items[0].formula;
  assert.equal(f.mode, 'break');
  assert.equal(f.anchor, 'рука пошла ко рту');
  assert.equal(f.twoMin, 'сжать кулак');
  assert.equal(f.identity, 'я читатель', 'нетронутые поля сохранены как были');
});

test('З20/C.2: «Отмена» режим не применяет', async () => {
  const { document, window } = await boot({ seed: formulaSeed('build') });
  openDetail(document);
  document.querySelector('[data-act="formula-open"]').click();
  const sel = document.getElementById('fx-mode');
  sel.value = 'break';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  document.querySelector('[data-act="formula-cancel"]').click();

  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items[0].formula.mode, 'build',
    'в данных режим прежний');
  const laws = [...document.getElementById('scr-detail').querySelectorAll('.overline')].map(x => x.textContent);
  assert.deepEqual(laws, ['Очевидно', 'Привлекательно', 'Легко', 'Приятно'], 'блок чтения тоже прежний');

  // повторное открытие формы показывает режим формулы, а не брошенный черновик
  document.querySelector('[data-act="formula-open"]').click();
  assert.equal(document.getElementById('fx-mode').value, 'build');
});

test('З20/C.4: все семь подсказок режима break присутствуют дословно', async () => {
  const { document } = await boot({ seed: formulaSeed('break') });
  openDetail(document);
  document.querySelector('[data-act="formula-open"]').click();
  const hints = [...document.querySelectorAll('#scr-detail .hint')].map(x => x.textContent);
  assert.equal(hints.length, 7, 'по подсказке на каждое поле');
  const expected = [
    'Назови момент, а не состояние. „Когда нервничаю“ — не момент. „Когда рука пошла ко рту“ — момент, его можно заметить.',
    'Где и когда это обычно случается. Знаешь опасную зону — можешь менять обстановку именно там.',
    'Не абстрактный вред, а конкретное последствие с прошлой недели. Награда приходит сразу, расплата потом — записанная цена подтягивает расплату ближе.',
    '„Я бросаю“ — человек, который борется. „Я не грызу“ — человек, который не грызёт. Разные предложения, разный результат.',
    'За это будет ставиться отметка. Короткое, физическое, выполнимое прямо в момент срыва. Не „взять себя в руки“, а конкретное движение.',
    'Физическая преграда, не намерение. Каждая лишняя секунда между желанием и действием — секунда, чтобы опомниться. Преграда должна работать, когда ты устал.',
    'Наблюдаемый результат, а не „не сорвался“. Целая кожа. Пустой список желаний. Баланс не изменился.'
  ];
  assert.deepEqual(hints, expected, 'подсказки дословны и в порядке полей');

  // подписи полей режима break — тоже дословно и в порядке законов
  const labels = [...document.querySelectorAll('#scr-detail .card.form .field > span')].map(x => x.textContent);
  assert.deepEqual(labels, ['Режим', 'Что перехватываю', 'Время и место', 'Что я на самом деле получаю',
    'Кем становлюсь', 'Действие-замена', 'Что поставлю на пути', 'Что подтвердит день']);
});

test('З20: подсказки живут только в форме — в блоке чтения их нет', async () => {
  const { document } = await boot({ seed: formulaSeed('break') });
  const scr = openDetail(document);
  assert.equal(scr.querySelectorAll('.hint').length, 0, 'в режиме чтения подсказок нет');
  assert.doesNotMatch(scr.textContent, /Назови момент, а не состояние/);
});

/* ── Задача 20, C.5: сторож разметки форм ──────────────────────
   Часть B предлагала свернуть повторяющиеся фрагменты шаблонов
   (.card.form, .btns, .field) в хелперы при жёстком условии: выдаваемая
   разметка не меняется ни на байт. Замер показал, что по gzip сворачивание
   не экономит, а добавляет (см. отчёт задачи 20 и правило веса в CLAUDE.md),
   поэтому хелперы не введены — но сторож нужен и без них: он ловит любую
   будущую правку шаблонов форм, случайную или в ходе такого рефакторинга.

   Снимок — outerHTML всех четырнадцати форм (число сверяется ассертом
   ниже; в комментарии стояло «девяти» — счёт отстал на пять форм, задача
   26, п. 7.1). Дат в формах нет, идентификаторы в сиде фиксированы,
   поэтому снимок стабилен от запуска к запуску.
   Пересобрать после осознанной правки разметки:
       MARKUP_SNAPSHOT=write node --test tests/dom.test.js

   Задача 23, п. 3: сторож больше не лечит себя. Прежде отсутствие файла
   означало «запиши молча» — и снимок восстанавливался из той самой
   разметки, которую сторожил: удалить файл (или не получить его при
   клонировании) значило разоружить проверку, ничего об этом не узнав.
   Теперь запись — только по переменной окружения, а отсутствие файла —
   падение с инструкцией. */

const SNAP_PATH = path.join(ROOT, 'tests', 'markup.snapshot.json');
const SNAP_HOWTO = 'Пересобрать: MARKUP_SNAPSHOT=write node --test tests/dom.test.js';

/* Чтение снимка: файла нет — исключение, а не тихая запись. Вынесено из
   теста отдельной функцией, чтобы само правило проверялось тестом (п. 3.3). */
function readMarkupSnapshot(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`снимка разметки форм нет: ${p}\n  Сторож без снимка ничего не сторожит.\n  ${SNAP_HOWTO}`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('З23/3.3: сторож разметки не восстанавливается сам — нет снимка, есть падение', () => {
  const missing = path.join(ROOT, 'tests', 'markup.snapshot.НЕТ-ТАКОГО.json');
  assert.equal(fs.existsSync(missing), false, 'путь заведомо пуст');
  assert.throws(() => readMarkupSnapshot(missing), /снимка разметки форм нет/,
    'отсутствие снимка обязано падать, а не записываться молча');
  assert.equal(fs.existsSync(missing), false, 'и файл при этом не создаётся');
  // сам снимок в репозитории на месте — иначе сторож ниже нечем кормить
  assert.ok(fs.existsSync(SNAP_PATH), `снимок разметки должен лежать в репозитории. ${SNAP_HOWTO}`);
});

/* Сид с фиксированными id и именами: разметка не должна плавать */
function markupSeed() {
  const prev = prevMonday();
  return {
    schemaVersion: 15,
    groups: [{ name: 'Утро' }],
    items: [
      { id: 'fx-item', name: 'Пункт минимума', value: 10, unit: 'мин', type: 'daily', area: 'min',
        goal: null, note: 'подпись', group: 'Утро', active: true, addedAt: addKey(prev, -14),
        raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
        formula: { anchor: 'после зарядки', when: '', pair: '', identity: '', twoMin: '', friction: '', proof: '', mode: 'build' },
        ladder: null, ladderLog: [] },
      { id: 'fx-habit', name: 'Привычка', value: null, unit: '', type: 'daily', area: 'habit',
        normPerWeek: 7, goal: null, note: '', group: '', active: true, addedAt: addKey(prev, -14),
        raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [], formula: null, ladder: null, ladderLog: [] },
      { id: 'fx-param', name: 'Порог', value: null, unit: '', type: 'param', area: 'habit',
        pkind: 'time', pvalue: 0, pstep: -15, goal: null, note: '', group: '', active: true,
        addedAt: addKey(prev, -14), raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null,
        history: [{ date: addKey(prev, -14), value: 0 }], formula: null, ladder: null, ladderLog: [] }
    ],
    exercises: [{ id: 'fx-ex', name: 'Жим', unit: 'кг', value: 60, history: [], active: true, addedAt: addKey(prev, -14) }],
    days: {}, weekLog: [], reviews: [], pendingRaises: [], pendingLowers: [], sessions: [], notes: [],
    paramDecided: {}, draftOneChange: '', weekStart: prev,
    settings: { dayBoundary: 4, dayThreshold: 0.8, exportedAt: null, calendarSince: addKey(prev, -70), habitSeeded: true, seed17: true }
  };
}

test('З20/C.5: разметка форм совпадает со снимком побайтово', async () => {
  const { document, window } = await boot({ seed: markupSeed() });
  const got = {};
  const grab = (name) => {
    const form = document.querySelector('.card.form');
    assert.ok(form, `форма «${name}» открыта`);
    got[name] = form.outerHTML;
  };
  const settings = () => document.querySelector('#tabs button[data-tab="settings"]').click();
  const openSect = (re) => {
    const s = [...document.querySelectorAll('#scr-settings details.sect')]
      .find(d => re.test(d.querySelector('summary').textContent));
    s.querySelector('summary').click();
    return s;
  };

  // формы «Пунктов»: правка минимума, привычки, параметра и добавление
  settings();
  [...document.querySelectorAll('[data-act="edit-open"]')].find(b => b.dataset.id === 'fx-item').click();
  grab('edit-min');
  document.querySelector('[data-act="edit-cancel"]').click();
  [...document.querySelectorAll('[data-act="edit-open"]')].find(b => b.dataset.id === 'fx-habit').click();
  grab('edit-habit');
  document.querySelector('[data-act="edit-cancel"]').click();
  [...document.querySelectorAll('[data-act="edit-open"]')].find(b => b.dataset.id === 'fx-param').click();
  grab('edit-param');
  document.querySelector('[data-act="edit-cancel"]').click();
  [...document.querySelectorAll('[data-act="add-open"]')].find(b => b.dataset.area === 'min').click();
  grab('add-min');
  document.querySelector('[data-act="add-cancel"]').click();
  [...document.querySelectorAll('[data-act="add-open"]')].find(b => b.dataset.area === 'habit').click();
  grab('add-habit');
  document.querySelector('[data-act="add-cancel"]').click();

  // блоки и упражнения
  openSect(/Блоки/);
  document.querySelector('[data-act="group-open"]').click();
  grab('group-edit');
  document.querySelector('[data-act="group-cancel"]').click();
  document.querySelector('[data-act="group-add-open"]').click();
  got['group-add'] = document.querySelector('[data-form="group-add"]').outerHTML;
  document.querySelector('[data-act="group-add-cancel"]').click();
  openSect(/Упражнения/);
  document.querySelector('[data-act="ex-open"]').click();
  grab('ex-edit');
  document.querySelector('[data-act="ex-cancel"]').click();
  document.querySelector('[data-act="ex-add-open"]').click();
  grab('ex-add');
  document.querySelector('[data-act="ex-add-cancel"]').click();

  // заметка и выписка
  document.querySelector('#tabs button[data-tab="notes"]').click();
  [...document.querySelectorAll('[data-act="note-add-open"]')].find(b => b.dataset.kind === 'note').click();
  grab('note-add');
  document.querySelector('[data-act="note-cancel"]').click();
  [...document.querySelectorAll('[data-act="note-add-open"]')].find(b => b.dataset.kind === 'quote').click();
  grab('quote-add');
  document.querySelector('[data-act="note-cancel"]').click();

  // формы листа детали: формула в обоих режимах и лестница
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector('#scr-today [data-act="item-detail"]').click();
  document.querySelector('[data-act="formula-open"]').click();
  grab('formula-build');
  const sel = document.getElementById('fx-mode');
  sel.value = 'break';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  grab('formula-break');
  document.querySelector('[data-act="formula-cancel"]').click();
  document.querySelector('[data-act="ladder-open"]').click();
  grab('ladder');

  assert.equal(Object.keys(got).length, 14, 'сняты все формы');

  // запись — только по явной переменной окружения (п. 3.2)
  if (process.env.MARKUP_SNAPSHOT === 'write') {
    fs.writeFileSync(SNAP_PATH, JSON.stringify(got, null, 1) + '\n');
    console.log('снимок разметки форм записан: ' + SNAP_PATH);
    return;
  }
  const want = readMarkupSnapshot(SNAP_PATH);
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), 'набор форм тот же');
  for (const k of Object.keys(want)) {
    if (got[k] !== want[k]) {
      const at = [...want[k]].findIndex((c, i) => c !== got[k][i]);
      assert.fail(`разметка формы «${k}» разошлась со снимком на символе ${at}:\n` +
        `  было:  …${want[k].slice(Math.max(0, at - 60), at + 60)}…\n` +
        `  стало: …${got[k].slice(Math.max(0, at - 60), at + 60)}…\n` +
        '  Если правка разметки осознанная — пересобрать снимок:\n  ' + SNAP_HOWTO);
    }
  }
});

/* ── Задача 21. Привычка встала: экраны ────────────────────── */

/* Сид с лестницей на последней ступени; обе завершённые недели по норме */
function settledSeed(done) {
  const seed = dueSeed();
  const prev = prevMonday();
  seed.settings.calendarSince = addKey(prev, -70);
  seed.items[0].ladder = {
    steps: ['раз', 'два', 'последняя ступень'], step: 2,
    steppedWeek: null, startedAt: addKey(prev, -30), done: !!done
  };
  seed.items[0].ladderLog = [{ date: addKey(prev, -30), step: 0, text: 'раз', start: true }];
  if (done) seed.items[0].ladderLog.push({ date: addKey(prev, -1), step: 2, text: 'последняя ступень', closed: true });
  seed.days = {};
  fillWeek(seed.days, 'it1', addKey(prev, -7), 7);
  fillWeek(seed.days, 'it1', prev, 7);
  return seed;
}

test('З21/7.7: дневной экран — подпись меняется при settled и возвращается при done', async () => {
  const a = await boot({ seed: settledSeed(false) });
  const rowA = a.document.querySelector('#scr-today .rowwrap');
  assert.equal(rowA.querySelector('.note').textContent, 'Привычка встала. Можно брать новую.');
  assert.equal(rowA.querySelector('.lstep').textContent, '3/3', 'метка положения на месте');
  // тихо: ни акцента, ни лишних узлов
  assert.equal(rowA.querySelectorAll('.note').length, 1);
  assert.equal(a.document.querySelector('#scr-today .note').className, 'note');

  const b = await boot({ seed: settledSeed(true) });
  const rowB = b.document.querySelector('#scr-today .rowwrap');
  assert.equal(rowB.querySelector('.note').textContent, 'последняя ступень',
    'закрытая привычка снова показывает ступень');
  assert.equal(rowB.querySelector('.lstep').textContent, '3/3', 'метка положения остаётся');

  // структура строки одна и та же — новых узлов не появилось
  const shape = row => [...row.querySelectorAll('*')].map(n => n.tagName + '.' + n.className).join('|');
  assert.equal(shape(rowA), shape(rowB), 'разметка строки не изменилась');

  // и без выдержанных недель подпись обычная
  const plain = settledSeed(false);
  plain.days = {};
  const c = await boot({ seed: plain });
  assert.equal(c.document.querySelector('#scr-today .note').textContent, 'последняя ступень');
});

test('З21/7.7: лист детали — закрытие вторым тапом, строка с датой и возврат', async () => {
  const { document, window } = await boot({ seed: settledSeed(false) });
  document.querySelector('#scr-today [data-act="item-detail"]').click();
  const scr = () => document.getElementById('scr-detail');
  assert.match(scr().textContent, /Последняя ступень держится две недели — привычка встала\./);

  const btn = () => document.querySelector('[data-act="ladder-done"]');
  assert.ok(btn(), 'кнопка «Закрыть привычку» есть');
  assert.equal(btn().textContent, 'Закрыть привычку');
  assert.ok(btn().classList.contains('quiet'), 'тихая кнопка, не primary');

  // первый тап — подтверждение, данные не тронуты
  btn().click();
  assert.equal(btn().textContent, 'Подтвердить: закрыть привычку');
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items[0].ladder.done, false);

  // второй — закрытие
  btn().click();
  const saved = JSON.parse(window.localStorage.getItem(NS)).items[0];
  assert.equal(saved.ladder.done, true);
  assert.ok(saved.ladderLog.some(e => e.closed === true), 'веха в журнале');
  assert.match(scr().textContent, /Привычка закрыта/);
  assert.equal(document.querySelector('[data-act="ladder-done"]'), null, 'предложения больше нет');

  // возврат
  const back = document.querySelector('[data-act="ladder-reopen"]');
  assert.ok(back, 'кнопка «Открыть заново»');
  assert.equal(back.textContent, 'Открыть заново');
  back.click();
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items[0].ladder.done, false);
  assert.ok(document.querySelector('[data-act="ladder-done"]'), 'предложение вернулось');
  assert.doesNotMatch(scr().textContent, /Привычка закрыта/);
});

test('З21/7.8: разбор — решение «Ступень» превращается в закрытие; заголовок остаётся', async () => {
  const a = await boot({ seed: settledSeed(false) });
  openReview(a.document);
  const scrA = a.document.getElementById('scr-review');
  const h2A = [...scrA.querySelectorAll('h2')].map(x => x.textContent);
  assert.ok(h2A.includes('Решение 2 · Ступень'), 'решение на месте');
  assert.match(scrA.textContent, /привычка встала/);
  assert.ok(scrA.querySelector('[data-act="ladder-done"]'), 'кнопка закрытия');
  assert.equal(scrA.querySelector('[data-act="ladder-fwd"]'), null, '«Шагнуть» нет');
  assert.equal(scrA.querySelector('[data-act="ladder-stay"]'), null, '«Остаться» нет');

  // закрываем прямо из разбора — тот же data-act, те же два тапа
  scrA.querySelector('[data-act="ladder-done"]').click();
  a.document.querySelector('[data-act="ladder-done"]').click();
  assert.equal(JSON.parse(a.window.localStorage.getItem(NS)).items[0].ladder.done, true);
  // заголовок остаётся: нумерация «1, 3» читалась как потеря (задача 24, п. 4)
  const scrAfter = a.document.getElementById('scr-review');
  const h2After = [...scrAfter.querySelectorAll('h2')].map(x => x.textContent);
  assert.ok(h2After.includes('Решение 2 · Ступень'), 'заголовок на месте');
  assert.equal(scrAfter.querySelector('[data-act="ladder-done"]'), null, 'предложения нет');
  assert.match(scrAfter.textContent, /Лестница пройдена — слот свободен/);

  // и при загрузке с уже закрытой — то же самое
  const b = await boot({ seed: settledSeed(true) });
  openReview(b.document);
  const scrB = b.document.getElementById('scr-review');
  const h2B = [...scrB.querySelectorAll('h2')].map(x => x.textContent);
  assert.deepEqual(h2B.filter(x => /^Решение/.test(x)),
    ['Решение 1 · Планка', 'Решение 2 · Ступень', 'Решение 3 · Одно изменение'], 'нумерация цела');
  // и сказано, где заводят следующую (п. 4.4)
  assert.match(scrB.textContent, /Настройки → Пункты → правка/);

  // а без лестницы вовсе — прежняя строка
  const noLadder = settledSeed(false);
  noLadder.items[0].ladder = null;
  const c = await boot({ seed: noLadder });
  openReview(c.document);
  const scrC = c.document.getElementById('scr-review');
  assert.match(scrC.textContent, /Лестницы сейчас нет/);
  assert.doesNotMatch(scrC.textContent, /слот свободен/);
});

test('З21/4.3: форма лестницы — слот, освобождённый закрытием, даёт обычную форму', async () => {
  const seed = settledSeed(true);
  seed.items.push({
    id: 'it2', name: 'Другой пункт', value: null, unit: '', type: 'daily', area: 'min',
    goal: null, note: '', group: '', active: true, addedAt: daysAgo(30), raiseAfter: 0,
    history: [], formula: null, ladder: null, ladderLog: []
  });
  const { document, window } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  [...document.querySelectorAll('[data-act="edit-open"]')].find(b => b.dataset.id === 'it2').click();
  // именно из формы правки: такая же кнопка есть в скрытой строке «Сегодня»
  // у пункта с лестницей, и querySelector нашёл бы сначала её
  document.querySelector('#scr-settings [data-act="item-detail"]').click();
  document.querySelector('[data-act="ladder-open"]').click();

  const form = document.querySelector('[data-form="ladder"]');
  assert.ok(form, 'форма лестницы открыта');
  assert.doesNotMatch(form.textContent, /Лестница уже есть у пункта/, 'слот свободен');
  assert.equal(document.getElementById('fx-steps').disabled, false, 'поле доступно');

  document.getElementById('fx-steps').value = 'первая\nвторая';
  document.querySelector('[data-act="ladder-save"]').click();
  const items = JSON.parse(window.localStorage.getItem(NS)).items;
  assert.ok(items.find(i => i.id === 'it2').ladder, 'новая лестница заведена');
  assert.ok(items.find(i => i.id === 'it1').ladder.done, 'закрытая не снята');
});

/* ── Задача 22. Первая неделя ──────────────────────────────── */

/* Состояние владельца в первый день практики: программа посева,
   эпоха началась, ни одной отметки. */
function firstWeekSeed() {
  const seed = t17Seed();
  seed.days = {};                       // ноль отметок
  seed.items.forEach(i => { i.addedAt = mondayOf(daysAgo(30)); });
  return seed;
}

test('З22/3: пустые «Отметки» — одна строка вместо ряда нулей', async () => {
  const { document, window } = await boot({ seed: firstWeekSeed() });
  openProgress(document);
  const card = () => [...document.querySelectorAll('#scr-progress .pcard')]
    .find(c => c.querySelector('h2').textContent === 'Отметки');

  assert.match(card().textContent, /^Отметки\s*Первые отметки появятся здесь\.$/);
  assert.equal(card().querySelectorAll('p').length, 1, 'ровно одна строка');
  assert.doesNotMatch(card().textContent, /0 из /);

  // первая отметка возвращает обычный вид — все пять строк, включая нулевые
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector('input[data-act="mark"]').click();
  openProgress(document);
  assert.equal(card().querySelectorAll('p.line').length, 5);
  assert.match(card().textContent, /Пункт 0 · 1 из /);
  assert.match(card().textContent, /Пункт 1 · 0 из /);
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).days[daysAgo(0)].m0, true);
});

test('З22/3: цепь дней — сетки нет, пока нет ни одной видимой ячейки', async () => {
  const seed = firstWeekSeed();
  seed.settings.calendarSince = mondayOf(addKey(daysAgo(0), 14)); // эпоха впереди
  const { document } = await boot({ seed });
  openProgress(document);
  const card = () => [...document.querySelectorAll('#scr-progress .pcard')]
    .find(c => c.querySelector('h2').textContent === 'Цепь дней');

  assert.equal(card().querySelector('.cdays'), null, 'сетки нет вовсе');
  assert.equal(card().querySelector('.sr-only'), null, 'и объявлять нечего');
  assert.match(card().textContent, /Цепь начнётся с первого дня отсчёта\./);
});

test('З22/3.4: sr-only не объявляет недели, целиком лежащие до эпохи', async () => {
  const seed = firstWeekSeed();
  seed.settings.calendarSince = curMonday(); // эпоха — ровно текущая неделя
  const { document } = await boot({ seed });
  openProgress(document);
  const sr = document.querySelector('#scr-progress .sr-only').textContent;
  const weeks = sr.split('. ').filter(Boolean);

  // цепь рисует восемь недель, существует из них одна — остальные молчат
  assert.equal(document.querySelectorAll('#scr-progress .cdays i.pre').length, 49);
  assert.equal(weeks.length, 1, 'объявлены только существующие недели');
  assert.match(weeks[0], /^Неделя с .+: зачтено \d из 7$/);
});

test('З22/4: взведённое подтверждение гаснет при смене вкладки', async () => {
  const seed = trainSeed();
  seed.groups = [{ name: 'Блок' }];
  seed.items[0].group = 'Блок';
  seed.notes = [{ id: 'n1', date: daysAgo(0), text: 'мысль', kind: 'note', source: '', updatedAt: 1 }];
  const { document, window } = await boot({ seed });
  const away = () => {
    document.querySelector('#tabs button[data-tab="progress"]').click();
    document.querySelector('#tabs button[data-tab="settings"]').click();
  };
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  const itemCount = saved().items.length;

  // 1. «Стереть»: первый тап взводит, уход гасит, данные на месте
  openData(document);
  document.querySelector('[data-act="wipe-open"]').click();
  document.querySelector('[data-act="wipe-do"]').click();
  assert.match(document.querySelector('[data-act="wipe-do"]').textContent, /Подтвердить: стереть/);
  away();
  openData(document);
  assert.match(document.querySelector('[data-act="wipe-do"]').textContent, /^Стереть$/);
  document.querySelector('[data-act="wipe-do"]').click();
  assert.equal(saved().items.length, itemCount, 'первый тап после сброса только взводит');
  assert.match(document.querySelector('[data-act="wipe-do"]').textContent, /Подтвердить: стереть/);
  document.querySelector('[data-act="wipe-cancel"]').click();

  // 2. удаление блока
  const groupSect = () => [...document.querySelectorAll('#scr-settings details.sect')]
    .find(d => /Блоки/.test(d.querySelector('summary').textContent));
  groupSect().querySelector('summary').click();
  document.querySelector('[data-act="group-open"]').click();
  document.querySelector('[data-act="group-del"]').click();
  assert.match(document.querySelector('[data-act="group-del"]').textContent, /Подтвердить удаление/);
  away();
  // правка блока переживает уход (её никто не отменял), а подтверждение — нет
  assert.match(document.querySelector('[data-act="group-del"]').textContent, /^Удалить$/);
  assert.equal(saved().groups.length, 1, 'блок на месте');

  // 3. удаление заметки
  document.querySelector('#tabs button[data-tab="notes"]').click();
  document.querySelector('[data-act="note-open"]').click();
  document.querySelector('[data-act="note-del"]').click();
  assert.match(document.querySelector('[data-act="note-del"]').textContent, /Подтвердить удаление/);
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector('#tabs button[data-tab="notes"]').click();
  // открытая правка заметки уход переживает, взведённое удаление — нет
  assert.match(document.querySelector('[data-act="note-del"]').textContent, /^Удалить$/);
  document.querySelector('[data-act="note-del"]').click();
  assert.equal(saved().notes.length, 1, 'первый тап после сброса не удаляет');
});

test('З22/5: подпись зачёта дня следует за тумблером без перерисовки', async () => {
  const { document, window } = await boot({ seed: t17Seed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const note = () => document.getElementById('thr-note');
  const before = note();
  assert.match(before.textContent, /День зачтён, если отмечено не меньше 4 из 5\./);

  const toggles = () => [...document.querySelectorAll('input[data-act="toggle-active"]')];
  toggles()[0].click();
  assert.equal(document.getElementById('thr-note'), before, 'узел тот же — экран не перерисован');
  assert.match(note().textContent, /не меньше 4 из 4\./);
  assert.equal(note().hidden, false);

  // подпись совпадает с фактическим числом активных пунктов
  const active = () => JSON.parse(window.localStorage.getItem(NS))
    .items.filter(i => i.active && i.type === 'daily' && i.area === 'min').length;
  toggles()[1].click();
  assert.match(note().textContent, new RegExp('из ' + active() + '\\.'));

  // последний выключенный пункт: подпись прячется, а не врёт
  toggles().forEach(t => { if (t.checked) t.click(); });
  assert.equal(active(), 0);
  assert.equal(note().textContent, '');
  assert.equal(note().hidden, true);

  // обратно — узел всё ещё тот же и снова говорит правду
  toggles()[0].click();
  assert.equal(document.getElementById('thr-note'), before);
  assert.match(note().textContent, /не меньше 1 из 1\./);
});

test('З22/6: полоса дня при нуле применимых пунктов — без NaN в разметке', async () => {
  const seed = t17Seed();
  seed.items.forEach(i => { i.active = false; }); // применимых пунктов нет
  const { document } = await boot({ seed });
  openProgress(document);
  const prog = document.getElementById('scr-progress');

  assert.equal(prog.querySelector('.dbar'), null, 'полосы нет — измерять нечего');
  assert.equal(prog.querySelector('.dbar-note'), null);
  assert.doesNotMatch(prog.innerHTML, /0 из 0/);

  // ни один style в разметке не содержит NaN — ни на одном экране
  for (const tab of ['today', 'habits', 'progress', 'notes', 'settings']) {
    document.querySelector(`#tabs button[data-tab="${tab}"]`).click();
    const scr = document.getElementById('scr-' + tab);
    for (const n of scr.querySelectorAll('[style]')) {
      assert.doesNotMatch(n.getAttribute('style'), /NaN/, tab);
    }
  }
});

test('З22/7.4: «Записать» без единого значения не пишет ничего и говорит об этом', async () => {
  const { document, window } = await boot({ seed: trainSeed() });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));

  document.querySelector('[data-act="train-inc"]').click();
  document.getElementById('ex-e1').value = '';
  document.getElementById('ex-e2').value = 'ноль';
  document.getElementById('tr-note').value = 'без цифр';
  document.querySelector('[data-act="train-save"]').click();

  assert.equal(document.getElementById('scr-train').hidden, false, 'лист остался открыт');
  assert.deepEqual(saved().sessions, [], 'сессии нет');
  assert.deepEqual(saved().weekLog, [], 'счётчик не вырос');
  // с задачи 26 отказ листа идёт тем же узлом, что и отказ любой формы:
  // .flash.keep рядом с нажатой кнопкой, а не собственный скрытый #tr-empty
  const refusal = document.querySelector('#scr-train .flash.keep');
  assert.ok(refusal, 'отказ показан');
  assert.match(refusal.textContent, /Нечего записать: ни одно упражнение не заполнено/);
  assert.equal(refusal.nextElementSibling.dataset.act, 'train-save', 'строка стоит у нажатой кнопки');
  assert.equal(document.getElementById('tr-note').value, 'без цифр', 'черновик заметки цел');
  // отказ ничего не переписал: поля остались такими, какими их видел владелец
  assert.equal(document.getElementById('ex-e1').value, '');
  assert.equal(document.getElementById('ex-e2').value, 'ноль');

  // одно заполненное — записывается только оно, счёт растёт
  document.getElementById('ex-e1').value = '45';
  document.querySelector('[data-act="train-save"]').click();
  assert.equal(document.getElementById('scr-today').hidden, false);
  const s = saved();
  assert.equal(s.sessions.length, 1);
  assert.deepEqual(s.sessions[0].entries, [{ exId: 'e1', value: 45 }]);
  assert.equal(s.sessions[0].note, 'без цифр');
  assert.equal(s.weekLog.length, 1);
  assert.equal(s.exercises.find(e => e.id === 'e1').value, 45);
  assert.equal(s.exercises.find(e => e.id === 'e2').value, 60, 'незаполненное не тронуто');
});

test('З22/7.4: упражнений нет вовсе — «Записать» по-прежнему засчитывает тренировку', async () => {
  const seed = trainSeed();
  seed.exercises = [];
  const { document, window } = await boot({ seed });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));

  document.querySelector('[data-act="train-inc"]').click();
  assert.match(document.getElementById('scr-train').textContent,
    /Упражнений пока нет — добавить можно в Настройках → Упражнения\./);
  document.querySelector('[data-act="train-save"]').click();

  assert.equal(document.getElementById('scr-today').hidden, false, 'лист закрылся');
  const s = saved();
  assert.equal(s.sessions.length, 1);
  assert.deepEqual(s.sessions[0].entries, []);
  assert.equal(s.weekLog.length, 1, 'счётчик вырос');
  assert.match(document.querySelector('#scr-today .wnum b').textContent, /1/);
});

test('З22/7.5: степпер не уводит поле в значение, которое «Записать» выбросит', async () => {
  const seed = trainSeed();
  seed.exercises[0].value = 2;
  const { document } = await boot({ seed });
  document.querySelector('[data-act="train-inc"]').click();
  const field = document.getElementById('ex-e1');
  const step = dir => [...document.querySelectorAll('[data-act="ex-step"]')]
    .find(b => b.dataset.id === 'e1' && b.dataset.dir === dir);

  step('down').click();
  assert.equal(field.value, '1');
  step('down').click();
  assert.equal(field.value, '1', 'ниже минимального сессия не примет — поле стоит');

  // пустое поле «минусом» не превращается в ноль
  field.value = '';
  step('down').click();
  assert.equal(field.value, '', 'из пустого поля ноль не рождается');
  step('up').click();
  assert.equal(field.value, '1');

  // дробная нагрузка: шаг вниз не переваливает через ноль
  field.value = '0,5';
  step('down').click();
  assert.equal(field.value, '0,5');
});

test('З22/7.3: шапка листа тренировки не повторяет слово дважды', async () => {
  const { document } = await boot({ seed: trainSeed() });
  document.querySelector('[data-act="train-inc"]').click();
  const head = document.querySelector('#scr-train header.page');
  assert.equal(head.querySelector('h1').textContent, 'Тренировка');
  assert.notEqual(head.querySelector('.overline').textContent, 'Тренировка');
  assert.match(head.querySelector('.overline').textContent, /\d/, 'надстрочник — день записи');
});

test('З22/7.2: подсказка «одна новая привычка за раз» — только по пунктам владельца', async () => {
  // засеянный store: девять пунктов одной датой — подсказки нет
  const { document, window } = await boot();
  const store = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(store.items.length, 9);
  assert.equal(new Set(store.items.map(i => i.addedAt)).size, 1, 'посев одной датой');

  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('[data-act="add-open"]').click();
  assert.equal(document.querySelector('#scr-settings .hint'), null, 'посев подсказку не вызывает');

  // пункт владельца, заведённый на следующий день, — вызывает
  shiftWindowDate(window, 86400000);
  document.dispatchEvent(new window.Event('visibilitychange'));
  document.querySelector('[data-act="add-open"]').click();
  document.getElementById('f-name').value = 'Своё';
  document.querySelector('[data-act="add-save"]').click();
  document.querySelector('[data-act="add-open"]').click();
  assert.match(document.querySelector('#scr-settings .hint').textContent,
    /одна новая привычка за раз/);
});

test('З22/7.2: стёртый store — первый пункт владельца подсказку не глушит', async () => {
  const { document, window } = await boot({ seed: trainSeed() });
  wipeThroughUi(document);
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items.length, 0);
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).settings.seed17, true);

  const openItems = () => {
    document.querySelector('#tabs button[data-tab="settings"]').click();
    [...document.querySelectorAll('#scr-settings details.sect')]
      .find(d => /^Пункты/.test(d.querySelector('summary').textContent))
      .querySelector('summary').click();
  };
  openItems();
  document.querySelector('[data-act="add-open"]').click();
  assert.equal(document.querySelector('#scr-settings .hint'), null, 'заводить пока нечего');
  document.getElementById('f-name').value = 'Первая';
  document.querySelector('[data-act="add-save"]').click();
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items.length, 1);

  // три дня спустя владелец заводит вторую — подсказка обязана показаться
  shiftWindowDate(window, 3 * 86400000);
  document.dispatchEvent(new window.Event('visibilitychange'));
  document.querySelector('[data-act="add-open"]').click();
  assert.match(document.querySelector('#scr-settings .hint').textContent,
    /Последний пункт добавлен меньше 14 дней назад/);
});

/* ══ Задача 23, п. 6: точечный путь ≡ полная перерисовка ══════
   Горячие пути «Сегодня», «Привычек» и «Пунктов» правят существующие
   узлы, а не пересобирают экран: иначе CSS-переход круга и планки дня
   не проигрывается (CLAUDE.md, «Архитектура»). Цена этого решения —
   второй источник истины о том, что на экране: всё, что точечный путь
   забыл обновить, остаётся вчерашним до ближайшей структурной
   перерисовки. Дефект задачи 22 (подпись зачёта дня не следовала за
   тумблером) — ровно этот класс, и он пережил два аудита.

   Сторож общего вида: сделать действие, снять разметку экрана, затем
   перерисовать экран целиком на ТЕХ ЖЕ данных и сверить. Расходится —
   значит точечный путь и рендер разошлись в понимании состояния.
   Сравнивается разметка экрана целиком, а не отдельный узел: тест не
   должен знать заранее, что именно точечный путь забудет.

   Нормализация — ровно ЧЕТЫРЕ, все обязательные и ни одна не про состояние
   (счёт поправлен в задаче 27.1, п. 4.3: четвёртая была добавлена вместе с
   перетаскиванием, а слово «три» осталось прежним):
     1) .pop — класс-триггер scale-отклика (12.1). Его вешает tapPop
        поверх живого узла; свежая разметка его не несёт по построению.
     2) checked у чекбокса: точечный путь ставит СВОЙСТВО (его и видит
        пользователь), шаблон рендера пишет АТРИБУТ. Приводим атрибут к
        свойству по обе стороны сравнения — тогда сверяется то, что
        видно, а не то, из чего оно получилось.
     3) запись style: точечный путь ставит `el.style.width`, и CSSOM
        сериализует это как «width: 50%;», шаблон пишет «width:50%».
        Значение одно и то же, разнится только текст — прогоняем обе
        стороны через CSSOM, чтобы сравнивать стиль, а не пробелы.
     4) порядок классов: classList.toggle дописывает класс в конец
        («c today on»), шаблон печатает свой порядок («c on today»).
        Ни CSS, ни classList.contains порядка не различают —
        сортируем набор, чтобы сравнивать классы, а не их очередь.
   Больше ничего не сглаживается: любое иное расхождение — находка. */

/* Атрибут checked ← свойство checked; класс .pop снят; style приведён
   к записи CSSOM; классы отсортированы. Обе стороны сравнения проходят
   одну и ту же нормализацию. */
function normalizeScreen(scr) {
  for (const inp of scr.querySelectorAll('input[type="checkbox"]')) {
    if (inp.checked) inp.setAttribute('checked', '');
    else inp.removeAttribute('checked');
  }
  for (const n of scr.querySelectorAll('.pop')) n.classList.remove('pop');
  for (const n of scr.querySelectorAll('[style]')) n.style.cssText = n.getAttribute('style');
  for (const n of scr.querySelectorAll('[class]')) {
    n.setAttribute('class', n.getAttribute('class').trim().split(/\s+/).sort().join(' '));
  }
  return scr.innerHTML;
}

/* Снять разметку экрана после точечного пути, затем перерисовать его
   целиком и снять снова. render — имя функции рендера в window.
   except — селекторы известных расхождений: узлы изымаются по ОБЕ
   стороны, чтобы сторож продолжал сторожить всё остальное, а не
   замолкал целиком. Каждое такое изъятие обязано быть закреплено
   отдельным тестом — иначе оно ничем не отличается от умолчания. */
function pointVsFull(window, screenId, render, except = []) {
  const drop = scr => { for (const s of except) for (const n of scr.querySelectorAll(s)) n.remove(); };
  const scr = window.document.getElementById(screenId);
  drop(scr);
  const point = normalizeScreen(scr);
  window[render]();
  const after = window.document.getElementById(screenId);
  drop(after);
  const full = normalizeScreen(after);
  return { point, full };
}

/* Единственное изъятие сторожа (задача 27.1, п. 9.9) — строка резервной
   копии на «Настройках». Она принципиально асинхронна: updateMirrorNote
   читает IndexedDB и дописывает текст ПОСЛЕ того, как рендер вернул
   управление. Сразу после синхронной перерисовки узел пуст и скрыт, а
   через тик — заполнен: сравнивать эти два состояния значит сравнивать
   не разметку, а момент. Изъятие не молчаливое — ниже стоит тест,
   закрепляющий все три ветки updateMirrorNote поимённо, как задача 23
   поступила с точкой «вчера — пропуск». */
const MIRROR_EXCEPT = ['#mirror-note'];

test('З27/9.9: updateMirrorNote — три ветки, изъятые из сторожа, закреплены здесь', async () => {
  // 1) снапшот прочитан — строка с датой (асинхронная ветка)
  const idb = new IDBFactory();
  await idbPut(idb, { json: JSON.stringify(mirrorStore()), savedAt: Date.now(), schemaVersion: 4 });
  const a = await boot({ idb });
  a.document.querySelector('#tabs button[data-tab="settings"]').click();
  const n1 = a.document.getElementById('mirror-note');
  for (let i = 0; i < 100 && n1.hidden; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(n1.hidden, false, 'снапшот есть — строка показана');
  assert.match(n1.textContent, /^Резервная копия: /);
  // и именно она расходится с перерисовкой: полная перерисовка её гасит,
  // асинхронное дополнение возвращает — ради этого изъятие и сделано
  a.window.renderSettings();
  assert.equal(a.document.getElementById('mirror-note').hidden, true,
    'сразу после перерисовки узел пуст — расхождение, ради которого изъятие');

  // 2) база открылась, ключа нет — строки нет вовсе
  const b = await boot({ idb: new IDBFactory() });
  b.document.querySelector('#tabs button[data-tab="settings"]').click();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(b.document.getElementById('mirror-note').hidden, true, 'снапшота нет — строки нет');

  // 3) чтение не завершилось — «неизвестно» тем же muted, без тревоги
  const c = await boot({ idb: slowIdb(new IDBFactory(), SLOW_IDB_MS) });
  c.document.querySelector('#tabs button[data-tab="settings"]').click();
  const n3 = c.document.getElementById('mirror-note');
  assert.equal(n3.hidden, false);
  assert.equal(n3.textContent, 'Резервная копия не проверена');
  assert.equal(n3.className, 'muted', 'тон «неизвестно», а не тревога');
});

function assertSame(t, what) {
  if (t.point === t.full) return;
  const at = [...t.full].findIndex((c, i) => c !== t.point[i]);
  assert.fail(`${what}: точечный путь разошёлся с полной перерисовкой на символе ${at}\n` +
    `  точечно:     ...${t.point.slice(Math.max(0, at - 90), at + 90)}...\n` +
    `  перерисовка: ...${t.full.slice(Math.max(0, at - 90), at + 90)}...`);
}

/* Сид, в котором видны все точечные пути сразу: минимум с недельным
   пунктом (счётчик тренировок), привычка с нормой 4 (полоса недели и
   «X из N»), порог зачёта 0,8 (подпись в «Пунктах»). */
function pointSeed() {
  const mon = curMonday();
  const t = daysAgo(0);
  return {
    schemaVersion: 15,
    groups: [{ name: 'Утро' }],
    items: [
      { id: 'p-a', name: 'Зарядка', value: 10, unit: 'мин', type: 'daily', area: 'min',
        goal: null, note: '', group: 'Утро', active: true, addedAt: addKey(mon, -70),
        raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [], formula: null,
        ladder: null, ladderLog: [] },
      { id: 'p-b', name: 'Английский', value: 15, unit: 'мин', type: 'daily', area: 'min',
        goal: null, note: '', group: 'Утро', active: true, addedAt: addKey(mon, -70),
        raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [], formula: null,
        ladder: null, ladderLog: [] },
      { id: 'p-c', name: 'Тренировка', value: null, unit: '', type: 'weekly', area: 'min',
        goal: 3, note: '', group: '', active: true, addedAt: addKey(mon, -70),
        raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [], formula: null,
        ladder: null, ladderLog: [] },
      { id: 'p-h', name: 'Отбой', value: null, unit: '', type: 'daily', area: 'habit',
        normPerWeek: 4, goal: null, note: '', group: '', active: true, addedAt: addKey(mon, -70),
        raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [], formula: null,
        ladder: null, ladderLog: [] }
    ],
    exercises: [{ id: 'p-ex', name: 'Жим', unit: 'кг', value: 60, history: [], active: true, addedAt: addKey(mon, -70) }],
    days: { [addKey(t, -1)]: { 'p-a': true, 'p-h': true } },
    weekLog: [], reviews: [], pendingRaises: [], pendingLowers: [], sessions: [], notes: [],
    paramDecided: {}, draftOneChange: '', weekStart: mon,
    settings: { dayBoundary: 4, dayThreshold: 0.8, exportedAt: null, calendarSince: addKey(mon, -70), habitSeeded: true, seed17: true }
  };
}

test('З23/6: отметка на «Сегодня» — экран после точечного пути равен перерисованному', async () => {
  const { document, window } = await boot({ seed: pointSeed() });
  const boxes = [...document.querySelectorAll('#scr-today input[data-act="mark"]')];
  assert.ok(boxes.length >= 2, 'есть что отмечать');

  // изъятий больше нет: сторож сравнивает разметку целиком (задача 24, п. 7.4)
  boxes[0].click();                                   // 1 из 2
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'первая отметка');

  document.querySelectorAll('#scr-today input[data-act="mark"]')[1].click(); // все — «День закрыт»
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'день закрыт');

  // снятие — обратный путь, отдельная ветка планки
  document.querySelectorAll('#scr-today input[data-act="mark"]')[1].click();
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'снятие отметки');
});

test('З24/7: точка «вчера — пропуск» не рождается в момент первой в жизни отметки', async () => {
  const { document, window } = await boot({ seed: pointSeed() });
  const dots = () => document.querySelectorAll('#scr-today [data-act="miss-note"]').length;
  // «Английский» вчера не отмечен и не отмечался НИКОГДА — точки нет по инварианту 7
  assert.equal(dots(), 0, 'до первой отметки точки нет вовсе');

  document.querySelectorAll('#scr-today input[data-act="mark"]')[1].click();
  assert.equal(dots(), 0, 'точечный путь точку не добавляет');
  window.renderToday();
  assert.equal(dots(), 0, 'и полная перерисовка тоже: расхождения больше нет');

  // первый настоящий пропуск после начала точку даёт обычным путём:
  // «Английский» отмечен сегодня, пропущен назавтра — через день точка есть
  shiftWindowDate(window, 50 * 3600000);
  window.renderToday();
  const dot = [...document.querySelectorAll('#scr-today [data-act="miss-note"]')]
    .find(d => d.dataset.id === 'p-b');
  assert.ok(dot, 'точка «Английского» появилась обычным путём');
});

test('З23/6: отметка на «Привычках» — планка, полоса недели и счётчик', async () => {
  const { document, window } = await boot({ seed: pointSeed() });
  document.querySelector('#tabs button[data-tab="habits"]').click();
  const box = document.querySelector('#scr-habits input[data-act="mark"]');
  assert.ok(box, 'привычка на экране');

  box.click();                                        // «Все отмечены» + полоса + «X из N»
  assertSame(pointVsFull(window, 'scr-habits', 'renderHabits'), 'отметка привычки');

  document.querySelector('#scr-habits input[data-act="mark"]').click();
  assertSame(pointVsFull(window, 'scr-habits', 'renderHabits'), 'снятие отметки привычки');
});

test('З23/6: недельный счётчик — запись тренировки и «отменить последний»', async () => {
  const { document, window } = await boot({ seed: pointSeed() });

  // «+» открывает лист; запись возвращает на «Сегодня» полной перерисовкой,
  // а вот «отменить последний» идёт точечным путём updateWeekCount
  document.querySelector('#scr-today [data-act="train-inc"]').click();
  document.getElementById('ex-p-ex').value = '62';
  document.querySelector('[data-act="train-save"]').click();
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'после записи тренировки');

  document.querySelector('#scr-today [data-act="train-undo"]').click(); // счёт вернулся к нулю
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'после отмены последней');
});

test('З23/6: тумблеры «Пунктов» — .off и подпись зачёта дня', async () => {
  const { document, window } = await boot({ seed: pointSeed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();

  // выключение пункта минимума: строка гаснет, знаменатель подписи падает.
  // Ровно здесь жил дефект задачи 22 — подпись оставалась прежней
  document.querySelectorAll('#scr-settings input[data-act="toggle-active"]')[0].click();
  assertSame(pointVsFull(window, 'scr-settings', 'renderSettings', MIRROR_EXCEPT), 'выключение пункта');

  document.querySelectorAll('#scr-settings input[data-act="toggle-active"]')[0].click();
  assertSame(pointVsFull(window, 'scr-settings', 'renderSettings', MIRROR_EXCEPT), 'включение обратно');

  // выключение упражнения — свой точечный путь, без подписи
  const sect = [...document.querySelectorAll('#scr-settings details.sect')]
    .find(d => /Упражнения/.test(d.querySelector('summary').textContent));
  sect.querySelector('summary').click();
  document.querySelector('#scr-settings input[data-act="ex-active"]').click();
  assertSame(pointVsFull(window, 'scr-settings', 'renderSettings', MIRROR_EXCEPT), 'выключение упражнения');
});

/* ══ Задача 23, п. 7: дыры покрытия уровня рендера ════════════
   Остальные одиннадцать живут в tests/regression.test.js и
   tests/domain.test.js — доменным их проверить дешевле. Эти три
   нечем проверить, не построив экран: предмет каждой — разметка. */

/* Сид с точным числом применимых пунктов: доля дня считается
   в лоб, и «ровно порог» получается без округлений. */
function scoreSeed(nItems, threshold) {
  const mon = curMonday();
  const items = [];
  for (let i = 0; i < nItems; i++) {
    items.push({
      id: 's-' + i, name: 'Пункт ' + (i + 1), value: null, unit: '', type: 'daily', area: 'min',
      goal: null, note: '', group: '', active: true, addedAt: addKey(mon, -70),
      raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
      formula: null, ladder: null, ladderLog: []
    });
  }
  return {
    schemaVersion: 15, groups: [], items, exercises: [],
    days: {}, weekLog: [], reviews: [], pendingRaises: [], pendingLowers: [],
    sessions: [], notes: [], paramDecided: {}, draftOneChange: '', weekStart: mon,
    settings: { dayBoundary: 4, dayThreshold: threshold, exportedAt: null,
      calendarSince: addKey(mon, -70), habitSeeded: true, seed17: true }
  };
}

test('З23/7.9: полоса дня на «Прогрессе» — незакрытый день показывает свою долю', async () => {
  // прежде полоса проверялась только на закрытом дне, где done === total
  // и подмена одного числа другим ничего не меняла
  const seed = scoreSeed(4, 0.8);
  seed.days[daysAgo(0)] = { 's-0': true };            // 1 из 4
  const { document } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="progress"]').click();

  const note = document.querySelector('#scr-progress .dbar-note');
  assert.ok(note, 'полоса дня на месте');
  assert.equal(note.textContent, '1 из 4 сегодня', 'сколько отмечено, а не сколько всего');
  assert.equal(document.querySelector('#scr-progress .dbar i').getAttribute('style'), 'width:25%');

  // закрытый день — вторая ветка той же полосы
  const full = scoreSeed(4, 0.8);
  full.days[daysAgo(0)] = { 's-0': true, 's-1': true, 's-2': true, 's-3': true };
  const b = await boot({ seed: full });
  b.document.querySelector('#tabs button[data-tab="progress"]').click();
  assert.equal(b.document.querySelector('#scr-progress .dbar-note').textContent, 'День закрыт');
  assert.equal(b.document.querySelector('#scr-progress .dbar i').getAttribute('style'), 'width:100%');
});

test('З23/7.10: ячейка цепи РОВНО на пороге заливается, а не остаётся контуром', async () => {
  // 4 из 5 при пороге 0,8 — это ровно порог: день зачтён (инвариант 14
  // говорит «≥ порога»). Прежде проверялись только явно больший и явно
  // меньший случаи, и сдвиг сравнения на границе проходил молча
  const seed = scoreSeed(5, 0.8);
  const t = daysAgo(0), y = daysAgo(1);
  seed.days[y] = { 's-0': true, 's-1': true, 's-2': true, 's-3': true };        // 0,8 — ровно порог
  seed.days[t] = { 's-0': true, 's-1': true, 's-2': true };                     // 0,6 — ниже
  const { document, window } = await boot({ seed });
  assert.equal(window.dayScore(y), 0.8, 'доля вчера — ровно порог');
  document.querySelector('#tabs button[data-tab="progress"]').click();

  const cells = [...document.querySelectorAll('#scr-progress .cdays i')];
  // последняя нарисованная — сегодня, предпоследняя — вчера
  const drawn = cells.filter(c => !c.classList.contains('fut') && !c.classList.contains('pre'));
  const today = drawn[drawn.length - 1], yest = drawn[drawn.length - 2];
  assert.ok(yest.classList.contains('full'), 'ровно порог — сплошная заливка');
  assert.ok(!yest.classList.contains('part'));
  assert.ok(today.classList.contains('part'), 'ниже порога — контур');
  assert.ok(!today.classList.contains('full'));
});

/* Дыра №10 из списка аудита. Проверяется обещание, которое видит
   владелец: начатая заметка и начатая правка пункта переживают уход
   на чужую вкладку и возврат.

   Честно о границе этого теста: слить noteDraft и formDraft в один слот
   он НЕ заметит — и заметить не может. renderAll() перерисовывает ровно
   один вид, скрытый экран сохраняет свой DOM, и snapshotOpenForm при
   возврате перечитывает черновик прямо из него; слоту нечего мостить.
   Мутант «общий слот» проверен батареей на всём наборе тестов и на
   отдельной враждебной последовательности (заметка → правка → лист
   детали → возврат) — поведение совпадает до символа. Он эквивалентный,
   а не выживший: разделение слотов защитное, оно страхует от будущей
   правки, которая начнёт пересобирать скрытые экраны. Подробности —
   в отчёте задачи 23. */
test('З23/7.11: черновик заметки и черновик формы «Пунктов» переживают чужую вкладку', async () => {
  const { document } = await boot();
  // начатая заметка
  document.querySelector('#tabs button[data-tab="notes"]').click();
  [...document.querySelectorAll('[data-act="note-add-open"]')].find(b => b.dataset.kind === 'note').click();
  document.getElementById('n-text').value = 'начатая мысль';

  // уход в «Пункты» и начатая правка там же
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('[data-act="edit-open"]').click();
  document.getElementById('e-name').value = 'Начатое имя';

  // возврат: заметка не стёрта чужим черновиком
  document.querySelector('#tabs button[data-tab="notes"]').click();
  assert.equal(document.getElementById('n-text').value, 'начатая мысль',
    'черновик заметки живёт в своём слоте');

  // и обратно: правка пункта тоже цела
  document.querySelector('#tabs button[data-tab="settings"]').click();
  assert.equal(document.getElementById('e-name').value, 'Начатое имя',
    'черновик формы «Пунктов» не затёрт заметкой');
});

/* ── Задача 24. Разбор: решения в видимой части ─────────────── */

/* Разбор с несколькими готовыми к повышению пунктами и параметром.
   Три идеальные закрытые недели: критерий повышения выполнен у всех
   числовых пунктов — прежде разбор показывал три карточки сразу. */
function reviewSeed({ params = true, ladder = null, filled = 3 } = {}) {
  const prev = prevMonday();
  const since = addKey(prev, -70);
  const mk = (id, name, value) => ({
    id, name, value, unit: 'мин', type: 'daily', area: 'min', goal: null, note: '',
    group: '', active: true, addedAt: since, raiseAfter: 0, raiseAfterWeek: null,
    lowerAfterWeek: null, history: [{ date: since, value }], formula: null,
    ladder: null, ladderLog: []
  });
  const items = [mk('it1', 'Первый', 10), mk('it2', 'Второй', 20), mk('it3', 'Третий', 30)];
  if (params) {
    items.push({
      id: 'pp', name: 'Отбой', value: null, unit: '', type: 'param', area: 'habit',
      pkind: 'time', pvalue: 1380, pstep: -15, goal: null, note: '', group: '',
      active: true, addedAt: since, raiseAfter: 0, history: [{ date: since, value: 1380 }]
    });
  }
  if (ladder) items.find(i => i.id === ladder.on).ladder = ladder.value;
  const days = {};
  for (let w = 0; w < filled; w++) {
    for (const it of items) if (it.type === 'daily') fillWeek(days, it.id, addKey(prev, -7 * w), 7);
  }
  return {
    schemaVersion: 16, groups: [], items, days,
    weekLog: [], reviews: [], pendingRaises: [], pendingLowers: [],
    exercises: [], sessions: [], notes: [], paramDecided: {},
    draftOneChange: '', weekStart: prev,
    settings: { dayBoundary: 4, dayThreshold: 0.8, exportedAt: null,
      calendarSince: since, habitSeeded: true, seed17: true }
  };
}

const reviewScr = document => document.getElementById('scr-review');
const LIVE = { steps: ['раз', 'два'], step: 0, steppedWeek: null, startedAt: null, done: false };
const DONE = { steps: ['раз', 'два'], step: 1, steppedWeek: null, startedAt: null, done: true };
const copy = o => JSON.parse(JSON.stringify(o));

test('З24/6: карточка повышения одна, остальным — тихая строка без имён', async () => {
  const { document } = await boot({ seed: reviewSeed({ params: false }) });
  openReview(document);
  const scr = reviewScr(document);

  const cards = [...scr.querySelectorAll('.card.raise')];
  assert.equal(cards.length, 1, 'предложение одно за разбор');
  assert.match(cards[0].textContent, /Первый/, 'первому по порядку items[]');

  const rest = [...scr.querySelectorAll('p.muted')].find(p => /готов/.test(p.textContent));
  assert.ok(rest, 'строка про остальных готовых');
  assert.match(rest.textContent, /Ещё 2 пункта готовы к повышению — предложение вернётся на следующей неделе/);
  assert.equal(rest.className, 'muted', 'без счётчика-акцента');
  assert.doesNotMatch(rest.textContent, /Второй|Третий/, 'без списка имён');

  // «Не сейчас» — решение по планке вверх принято, второй карточки нет
  scr.querySelector('[data-act="raise-later"]').click();
  await settle();
  const after = reviewScr(document);
  assert.equal(after.querySelectorAll('.card.raise').length, 0, 'второе предложение не подставляется');
  assert.match(after.textContent, /Ещё 2 пункта готовы/, 'но они не потеряны');
});

test('З24/5: закрытая лестница повышение не блокирует, живая блокирует', async () => {
  const a = await boot({ seed: reviewSeed({ params: false, ladder: { on: 'it1', value: copy(LIVE) } }) });
  openReview(a.document);
  assert.match(reviewScr(a.document).querySelector('.card.raise').textContent, /Второй/,
    'пункт с живой лестницей пропущен');

  const b = await boot({ seed: reviewSeed({ params: false, ladder: { on: 'it1', value: copy(DONE) } }) });
  openReview(b.document);
  assert.match(reviewScr(b.document).querySelector('.card.raise').textContent, /Первый/,
    'закрытая лестница право не отнимает');
});

test('З24/4: три заголовка решений на месте при любой лестнице', async () => {
  const heads = d => [...reviewScr(d).querySelectorAll('h2')].map(x => x.textContent).filter(t => /^Решение/.test(t));
  const ALL = ['Решение 1 · Планка', 'Решение 2 · Ступень', 'Решение 3 · Одно изменение'];

  const none = await boot({ seed: reviewSeed({}) });
  openReview(none.document);
  assert.deepEqual(heads(none.document), ALL, 'лестницы нет вовсе');
  assert.match(reviewScr(none.document).textContent, /Лестницы сейчас нет/);

  const l = await boot({ seed: reviewSeed({ ladder: { on: 'it1', value: copy(LIVE) } }) });
  openReview(l.document);
  assert.deepEqual(heads(l.document), ALL, 'живая лестница');

  const c = await boot({ seed: reviewSeed({ ladder: { on: 'it1', value: copy(DONE) } }) });
  openReview(c.document);
  assert.deepEqual(heads(c.document), ALL, 'закрытая лестница — нумерация не рвётся');
  const line = reviewScr(c.document).textContent;
  assert.match(line, /Лестница пройдена — слот свободен/);
  assert.match(line, /Настройки → Пункты → правка/, 'сказано, где заводят следующую');

  // живая рядом с закрытой: решает живая, о свободном слоте речи нет
  const both = reviewSeed({ ladder: { on: 'it1', value: copy(DONE) } });
  both.items[1].ladder = copy(LIVE);
  const bt = await boot({ seed: both });
  openReview(bt.document);
  assert.deepEqual(heads(bt.document), ALL);
  assert.doesNotMatch(reviewScr(bt.document).textContent, /слот свободен/);
});

test('З24/3: «Решение 2» говорит счёт недель по норме этого пункта', async () => {
  // шаг недоступен: в прошлой неделе 4 из 7 — карточки нет, вместо неё счёт
  const seed = reviewSeed({ params: false, filled: 0 });
  seed.items[0].ladder = copy(LIVE);
  fillWeek(seed.days, 'it1', prevMonday(), 4);
  fillWeek(seed.days, 'it1', curMonday(), 2);
  const m = await boot({ seed });
  openReview(m.document);
  assert.equal(reviewScr(m.document).querySelector('.card.step'), null, 'шага нет');
  assert.match(reviewScr(m.document).textContent, /Первый · Эта неделя 2 из 6, прошлая 4 из 6/);

  // привычка считается по своей норме
  const hseed = reviewSeed({ params: false, filled: 0 });
  hseed.items[0].area = 'habit';
  hseed.items[0].normPerWeek = 4;
  hseed.items[0].value = null;
  hseed.items[0].history = [];
  hseed.items[0].ladder = copy(LIVE);
  fillWeek(hseed.days, 'it1', prevMonday(), 3);
  fillWeek(hseed.days, 'it1', curMonday(), 1);
  const h = await boot({ seed: hseed });
  openReview(h.document);
  assert.match(reviewScr(h.document).textContent, /Первый · Эта неделя 1 из 4, прошлая 3 из 4/);

  // шаг доступен — прежняя карточка, счёта не нужно
  const o = await boot({ seed: reviewSeed({ params: false, ladder: { on: 'it1', value: copy(LIVE) } }) });
  openReview(o.document);
  assert.ok(reviewScr(o.document).querySelector('[data-act="ladder-fwd"]'), 'карточка «Шагнуть»');
  assert.doesNotMatch(reviewScr(o.document).textContent, /Эта неделя/);

  // лестницы нет вовсе — прежняя строка, счёта нет
  const n = await boot({ seed: reviewSeed({ params: false, filled: 0 }) });
  openReview(n.document);
  assert.match(reviewScr(n.document).textContent, /Лестницы сейчас нет/);
  assert.doesNotMatch(reviewScr(n.document).textContent, /Эта неделя/);
});

test('З24/2: параметр — карточка в «Решении 1», шаг пишет историю и уходит в срез', async () => {
  const { document, window } = await boot({ seed: reviewSeed({}) });
  openReview(document);
  const scr = reviewScr(document);

  // порядок внутри «Решения 1»: повышение, понижение, параметры
  const kids = [...scr.children];
  const at = sel => kids.indexOf(scr.querySelector(sel));
  assert.ok(at('.card.raise') < at('.card.param'), 'параметр после планки');
  assert.ok(kids.findIndex(x => x.textContent === 'Решение 2 · Ступень') > at('.card.param'),
    'и до «Решения 2»');
  assert.equal(scr.querySelector('.card.param').closest('details'), null, 'вне свёртки');

  scr.querySelector('[data-act="param-step"]').click();
  await settle();
  const saved = JSON.parse(window.localStorage.getItem(NS));
  const p = saved.items.find(i => i.id === 'pp');
  assert.equal(p.pvalue, 1365, 'шаг применён немедленно');
  assert.equal(p.history.length, 2, 'история порога дополнена');
  assert.equal(saved.paramDecided.pp.to, 1365);

  // карточки в видимой части больше нет, лишней строки не появилось
  const after = reviewScr(document);
  assert.equal(after.querySelector('.card.param'), null);
  assert.equal([...after.children].filter(x => x.tagName !== 'DETAILS' && /Отбой/.test(x.textContent)).length, 0,
    'решённый параметр из видимой части ушёл целиком');
  assert.match(after.querySelector('details.week').textContent, /Отбой: 23:00 → 22:45/,
    'итог решения — read-only строка под свёрткой');

  // и уходит в срез недели
  closeWeekThroughUi(after);
  const closed = JSON.parse(window.localStorage.getItem(NS));
  assert.deepEqual(closed.reviews[0].params, [{ id: 'pp', from: 1380, to: 1365 }]);
});

test('З24/2.5: параметров нет — в видимой части их нет и лишней строки не появляется', async () => {
  const { document } = await boot({ seed: reviewSeed({ params: false, filled: 0 }) });
  openReview(document);
  const scr = reviewScr(document);
  assert.equal(scr.querySelector('.card.param'), null);
  assert.match(scr.textContent, /Планка держится, менять нечего/);
});

test('З24/9: свёртка недели открыта, когда решать нечего, и не помнит чужой разбор', async () => {
  // нечего: ни повышений, ни понижений, ни лестницы, ни параметров
  const empty = reviewSeed({ params: false, filled: 0 });
  for (const mon of [prevMonday(), addKey(prevMonday(), -7)]) {
    for (const it of empty.items) fillWeek(empty.days, it.id, mon, 5); // ни ≥6, ни ≤3
  }
  const a = await boot({ seed: empty });
  openReview(a.document);
  assert.equal(reviewScr(a.document).querySelector('details.week').hasAttribute('open'), true,
    'решать нечего — картина недели открыта');

  // есть что: карточка повышения
  const b = await boot({ seed: reviewSeed({ params: false }) });
  openReview(b.document);
  assert.equal(reviewScr(b.document).querySelector('details.week').hasAttribute('open'), false,
    'решения важнее таблиц');

  // владелец закрыл свёртку сам — уважаем, пока разбор открыт
  reviewScr(a.document).querySelector('details.week summary').click();
  a.window.renderReview();
  assert.equal(reviewScr(a.document).querySelector('details.week').hasAttribute('open'), false,
    'явный выбор владельца держится');

  // «Готово» закрывает разбор — память о свёртке уходит с ним
  reviewScr(a.document).querySelector('[data-act="review-done"]').click();
  openReview(a.document);
  assert.equal(reviewScr(a.document).querySelector('details.week').hasAttribute('open'), true,
    'следующий разбор — состояние по умолчанию');
});

test('З24/10: у поля «Одно изменение» есть пример, значение им не подменяется', async () => {
  const { document, window } = await boot({ seed: reviewSeed({ params: false, filled: 0 }) });
  openReview(document);
  const inp = reviewScr(document).querySelector('input[data-bind="one-change"]');
  assert.equal(inp.placeholder, 'например: перенести зарядку на утро');
  assert.equal(inp.value, '', 'пустое поле остаётся пустым');
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).draftOneChange, '',
    'подсказка в данные не попадает');

  inp.value = 'своё';
  inp.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).draftOneChange, 'своё');
  window.renderReview();
  assert.equal(reviewScr(document).querySelector('input[data-bind="one-change"]').value, 'своё');
});

/* ── Задача 25. Данные без потерь ───────────────────────────── */

/* Импорт файла через настоящий путь интерфейса: change на скрытом input */
async function importThroughUi(document, window, payload, { confirm = true } = {}) {
  let text = '';
  window.confirm = m => { text = m; return confirm; };
  window.alert = m => { throw new Error('alert при импорте: ' + m); };
  openData(document);
  const inp = document.getElementById('import-file');
  const file = new window.File([JSON.stringify(payload)], 'm.json', { type: 'application/json' });
  Object.defineProperty(inp, 'files', { value: [file], configurable: true });
  inp.dispatchEvent(new window.Event('change', { bubbles: true }));
  for (let i = 0; i < 200 && !text; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(text, 'импорт дошёл до подтверждения');
  return text;
}

/* Перехват скачивания: содержимое Blob и имя файла. Проверять сам факт
   вызова createObjectURL мало — на любом непустом Blob такой тест зелен,
   а подменённое содержимое проходит молча (задача 25, разбор покрытия). */
async function grabDownload(window, act) {
  let blob = null, name = null;
  const realCreate = window.URL.createObjectURL;
  const realClick = window.HTMLAnchorElement.prototype.click;
  window.URL.createObjectURL = b => { blob = b; return 'blob:fake'; };
  window.HTMLAnchorElement.prototype.click = function () { name = this.download; };
  try { act(); } finally {
    window.URL.createObjectURL = realCreate;
    window.HTMLAnchorElement.prototype.click = realClick;
  }
  assert.ok(blob, 'скачивание запущено');
  // Blob.text() в jsdom не реализован — читаем тем же FileReader, каким
  // приложение читает файл импорта
  const text = await new Promise((res, rej) => {
    const r = new window.FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsText(blob);
  });
  return { name, text };
}

/* Файл с одним пунктом и одной отметкой — узнаваемо чужой */
function otherFile(extra) {
  return Object.assign({
    schemaVersion: SCHEMA_VERSION,
    items: [{
      id: 'x1', name: 'Чужой пункт', value: null, unit: '', type: 'daily', area: 'min',
      goal: null, note: '', group: '', active: true, addedAt: daysAgo(3), raiseAfter: 0,
      raiseAfterWeek: null, lowerAfterWeek: null, history: [], formula: null, ladder: null, ladderLog: []
    }],
    days: { [daysAgo(1)]: { x1: true } },
    groups: [], weekLog: [], reviews: [], pendingRaises: [], pendingLowers: [],
    exercises: [], sessions: [], notes: [], paramDecided: {},
    draftOneChange: '', weekStart: daysAgo(1),
    settings: { dayBoundary: 4, exportedAt: null, habitSeeded: true, seed17: true, calendarSince: mondayOf(daysAgo(20)) }
  }, extra);
}

test('З25/2: импорт кладёт копию прежних данных до подмены, «Вернуть» возвращает всё', async () => {
  const { document, window } = await boot();
  const before = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(window.localStorage.getItem(NS + ':wiped'), null, 'копии ещё нет');

  await importThroughUi(document, window, otherFile());
  const copyRaw = window.localStorage.getItem(NS + ':wiped');
  assert.ok(copyRaw, 'копия легла');
  const c = JSON.parse(copyRaw);
  assert.equal(c.kind, 'import');
  assert.deepEqual(c.store, before, 'в копии — состояние ДО подмены, целиком');
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items.length, 1, 'данные заменены');

  // строка возврата говорит, что произошло замещение, и когда
  openData(document);
  const row = document.querySelector('#scr-settings .restore');
  assert.ok(row, 'строка возврата на месте');
  assert.match(row.textContent, /В копии — состояние до импорта/);
  assert.doesNotMatch(row.textContent, /до чистки/);
  assert.match(row.textContent, /9 пунктов/);

  // «Вернуть» — тот же путь, что после чистки, и с задачи 26 обратимый:
  // импортированное не теряется, а ложится в ту же копию (п. 1.1)
  row.querySelector('[data-act="wipe-undo"]').click();
  assert.deepEqual(JSON.parse(window.localStorage.getItem(NS)), before, 'вернулось побайтово');
  const swapped = JSON.parse(window.localStorage.getItem(NS + ':wiped'));
  assert.equal(swapped.kind, 'restore');
  assert.equal(swapped.store.items.length, 1, 'импортированное лежит в копии');
  assert.match(document.querySelector('#scr-settings .restore').textContent, /состояние до возврата/);
});

test('З25/2.5: зеркало не добивает прежние данные раньше, чем ляжет копия', async () => {
  const idb = new IDBFactory();
  const { document, window } = await boot({ idb });
  for (let i = 0; i < 100 && !(await idbGet(idb)); i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(JSON.parse((await idbGet(idb)).json).items.length, 9, 'в зеркале прежние данные');

  await importThroughUi(document, window, otherFile());
  // копия — синхронная запись localStorage ПЕРЕД подменой store; зеркало
  // асинхронно и с дебаунсом, обогнать её оно не может ни при каком порядке
  assert.ok(window.localStorage.getItem(NS + ':wiped'), 'копия уже есть');
  await new Promise(r => setTimeout(r, T.MIRROR_FLUSH_MS + 60));
  assert.equal(JSON.parse((await idbGet(idb)).json).items.length, 1, 'зеркало догнало импорт');
  assert.equal(JSON.parse(window.localStorage.getItem(NS + ':wiped')).store.items.length, 9,
    'а копия прежних данных цела');
});

test('З25/2.4: копия одна, последняя, и в экспорт не входит', async () => {
  const { document, window } = await boot();
  await importThroughUi(document, window, otherFile());
  const first = JSON.parse(window.localStorage.getItem(NS + ':wiped'));
  assert.equal(first.store.items.length, 9);

  // второй импорт замещает копию состоянием перед собой, а не копит их
  await importThroughUi(document, window, otherFile({ items: [] }));
  const second = JSON.parse(window.localStorage.getItem(NS + ':wiped'));
  assert.equal(second.store.items.length, 1, 'в копии — то, что было перед вторым импортом');

  // экспорт отдаёт текущий store; копия ему чужая. Смотреть надо в САМ
  // отданный файл: чтение localStorage мимо download() пропускало бы
  // подмешивание копии в выгрузку
  openData(document);
  const file = await grabDownload(window, () => document.querySelector('[data-act="export"]').click());
  const exported = JSON.parse(file.text);
  assert.equal('wiped' in exported, false, 'копии в файле нет');
  assert.equal(exported.items.length, 0);
  assert.match(file.name, /^minimum-\d{4}-\d{2}-\d{2}\.json$/);
  assert.ok(window.localStorage.getItem(NS + ':wiped'), 'копия на месте после экспорта');
});

test('З25/3: подтверждение импорта называет отброшенное числом', async () => {
  const { document, window } = await boot();
  // день с одним посторонним значением уцелеет целиком (п. 4), а вот
  // день без валидных отметок, мусорный пункт и пустая заметка — нет
  const payload = otherFile({
    items: [null, 'мусор', otherFile().items[0]],
    days: { [daysAgo(1)]: { x1: true, шум: 1 }, [daysAgo(2)]: { x1: 'да' } },
    notes: [{ id: 'n1', date: daysAgo(1), text: '  ', kind: 'note', source: '', updatedAt: 0 }]
  });
  const text = await importThroughUi(document, window, payload);

  assert.match(text, /В файле: пунктов: 1, дней с отметками: 1/, 'сводка уцелевшего осталась');
  const lost = /Не будет прочитано: ([^\n]+)\./.exec(text);
  assert.ok(lost, 'строка отброшенного есть');
  assert.equal(lost[1], '2 пункта, 1 день, 1 заметка');
  // отметка в уцелевшем дне не потеряна: посторонний ключ ушёл поимённо (п. 4)
  assert.doesNotMatch(lost[1], /отметк/);
});

test('З25/3.3: файл без потерь лишней строки не показывает', async () => {
  const { document, window } = await boot();
  const text = await importThroughUi(document, window, otherFile());
  assert.match(text, /В файле: пунктов: 1/);
  assert.doesNotMatch(text, /Не будет прочитано/);
  assert.doesNotMatch(text, /более новой версией/);
});

test('З25/5: файл более новой схемы предупреждает, но не блокирует', async () => {
  const { document, window } = await boot();
  const text = await importThroughUi(document, window, otherFile({ schemaVersion: SCHEMA_VERSION + 1 }));
  assert.match(text, /Файл снят более новой версией приложения: часть данных может не сохраниться\./);
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items.length, 1, 'импорт состоялся');

  // отказ владельца — решение за ним: данные не тронуты
  const b = await boot();
  const was = b.window.localStorage.getItem(NS);
  await importThroughUi(b.document, b.window, otherFile({ schemaVersion: SCHEMA_VERSION + 1 }), { confirm: false });
  assert.equal(b.window.localStorage.getItem(NS), was, 'отказ ничего не меняет');
  assert.equal(b.window.localStorage.getItem(NS + ':wiped'), null, 'и копии не пишет');
});

test('З25/5.3: файл прежней схемы предупреждения не получает', async () => {
  const { document, window } = await boot();
  const text = await importThroughUi(document, window, otherFile({ schemaVersion: SCHEMA_VERSION - 1 }));
  assert.doesNotMatch(text, /более новой версией/);
});

test('З25/6: строка нечитаемых данных появляется, скачивается и убирается вторым тапом', async () => {
  const { document, window } = await boot({ raw: '{битый json' });
  const row = () => document.querySelector('#scr-settings .restore.corrupt');
  openData(document);
  assert.ok(row(), 'строка есть');
  assert.match(row().textContent, /Найдены нечитаемые данные от /);
  assert.match(row().textContent, /ничего не стирая/);

  // «Скачать» отдаёт именно сырую строку, а не текущий store, и ключа не трогает
  const file = await grabDownload(window, () => row().querySelector('[data-act="corrupt-save"]').click());
  assert.equal(file.text, '{битый json', 'в файле — отложенная строка дословно');
  assert.match(file.name, /^minimum-нечитаемое-\d{4}-\d{2}-\d{2}\.json$/);
  assert.ok(window.localStorage.getItem('minimum:data:corrupt'), 'скачивание ключа не убирает');

  // «Убрать» — вторым тапом
  row().querySelector('[data-act="corrupt-drop"]').click();
  assert.match(row().textContent, /Подтвердить: убрать/);
  assert.ok(window.localStorage.getItem('minimum:data:corrupt'), 'первый тап ничего не убрал');
  row().querySelector('[data-act="corrupt-drop"]').click();
  assert.equal(window.localStorage.getItem('minimum:data:corrupt'), null);
  assert.equal(row(), null, 'строки нет, когда нечитаемых данных нет');
});

test('З25/6.3-6.4: без нечитаемых данных строки нет, чистка их не трогает', async () => {
  const { document } = await boot();
  openData(document);
  assert.equal(document.querySelector('#scr-settings .restore.corrupt'), null);

  const b = await boot({ raw: '{битый json' });
  wipeThroughUi(b.document);
  openData(b.document);
  assert.ok(b.window.localStorage.getItem('minimum:data:corrupt'), 'переживает стирание');
  assert.ok(b.document.querySelector('#scr-settings .restore.corrupt'), 'и строка на месте');
});

test('З25/7: чистка пустого store не подменяет копию пустотой', async () => {
  const { document, window } = await boot({ seed: trainSeed() });
  wipeThroughUi(document);
  const first = JSON.parse(window.localStorage.getItem(NS + ':wiped'));
  assert.ok(first.store.items.length > 0, 'в копии практика');

  // предупреждение второй чистки не обещает замены — заменять нечем
  openData(document);
  document.querySelector('[data-act="wipe-open"]').click();
  assert.doesNotMatch(document.querySelector('#scr-settings .danger').textContent,
    /Прежняя копия будет заменена/);

  document.querySelector('[data-act="wipe-do"]').click();
  document.querySelector('[data-act="wipe-do"]').click();
  assert.deepEqual(JSON.parse(window.localStorage.getItem(NS + ':wiped')), first,
    'копия та же — практика не подменена пустотой');

  // «Вернуть» после второй чистки возвращает именно практику
  openData(document);
  document.querySelector('[data-act="wipe-undo"]').click();
  assert.ok(JSON.parse(window.localStorage.getItem(NS)).items.length > 0);
});

test('З25/1: ladderStay сбрасывается при закрытии разбора', async () => {
  const seed = dueSeed();
  const old = addKey(prevMonday(), -14);
  seed.items[0].ladder = { steps: ['первая', 'вторая', 'третья'], step: 0, steppedWeek: null, startedAt: old };
  seed.items[0].ladderLog = [{ date: old, step: 0, text: 'первая', start: true }];
  seed.days = {};
  for (const mon of [prevMonday(), addKey(prevMonday(), -7)]) {
    for (let i = 0; i < 6; i++) seed.days[addKey(mon, i)] = { it1: true };
  }
  const { document } = await boot({ seed });
  openReview(document);
  assert.ok(reviewScr(document).querySelector('.card.step'), 'карточка ступени');
  reviewScr(document).querySelector('[data-act="ladder-stay"]').click();
  assert.equal(reviewScr(document).querySelector('.card.step'), null, '«Остаться» гасит карточку');

  // «Готово» закрывает разбор — решение по ступени принадлежало ему одному
  document.querySelector('[data-act="review-done"]').click();
  openReview(document);
  assert.ok(reviewScr(document).querySelector('.card.step'),
    'следующий разбор снова предлагает шаг');
});

test('З25/2: взведённое подтверждение не переживает импорт — копия не подменяется одним тапом', async () => {
  const { document, window } = await boot();
  const before = JSON.parse(window.localStorage.getItem(NS));

  // «Стереть» взведено ДО импорта: подтверждение относилось к прежним данным
  openData(document);
  document.querySelector('[data-act="wipe-open"]').click();
  document.querySelector('[data-act="wipe-do"]').click();
  assert.match(document.querySelector('[data-act="wipe-do"]').textContent, /Подтвердить: стереть/);

  // импорт, не уходя со вкладки: таб-бар зовёт resetConfirms() и замаскировал бы всё
  await importThroughUi(document, window, otherFile());
  openData(document);
  assert.equal(document.querySelector('[data-act="wipe-do"]'), null,
    'предупреждение чистки закрыто вместе с прежними данными');

  // копия прежних данных цела: подменить её одним тапом нечем
  assert.equal(JSON.parse(window.localStorage.getItem(NS + ':wiped')).store.items.length,
    before.items.length);
  document.querySelector('[data-act="wipe-open"]').click();
  assert.match(document.querySelector('[data-act="wipe-do"]').textContent, /^Стереть$/,
    'счёт тапов начинается заново');

  // то же для «Убрать» нечитаемых данных: взведённое подтверждение гаснет
  const b = await boot({ raw: '{битый json' });
  openData(b.document);
  b.document.querySelector('[data-act="corrupt-drop"]').click();
  assert.match(b.document.querySelector('[data-act="corrupt-drop"]').textContent, /Подтвердить/);
  await importThroughUi(b.document, b.window, otherFile());
  openData(b.document);
  assert.match(b.document.querySelector('[data-act="corrupt-drop"]').textContent, /^Убрать$/);
  assert.ok(b.window.localStorage.getItem('minimum:data:corrupt'), 'данные на месте');
});

test('З25/6: взведённое «Убрать» не переживает уход с экрана', async () => {
  const { document } = await boot({ raw: '{битый json' });
  openData(document);
  document.querySelector('[data-act="corrupt-drop"]').click();
  assert.match(document.querySelector('[data-act="corrupt-drop"]').textContent, /Подтвердить/);
  document.querySelector('#tabs button[data-tab="today"]').click(); // resetConfirms()
  openData(document);
  assert.match(document.querySelector('[data-act="corrupt-drop"]').textContent, /^Убрать$/);
});

test('З25/6: нечитаемые данные без даты — строка есть, дата не выдумывается', async () => {
  // копия старого формата: голая строка, снятая версией до задачи 25
  const { document, window } = await boot();
  window.localStorage.setItem('minimum:data:corrupt', '{совсем старый');
  openData(document);
  const row = document.querySelector('#scr-settings .restore.corrupt');
  assert.ok(row, 'строка есть и без даты');
  assert.match(row.querySelector('p').textContent, /^Найдены нечитаемые данные$/);
  assert.doesNotMatch(row.textContent, / от /);

  // и «Скачать» отдаёт ту же строку
  const file = await grabDownload(window, () => row.querySelector('[data-act="corrupt-save"]').click());
  assert.equal(file.text, '{совсем старый');
});

test('З25/2.2: копия без kind читается как чистка — строка не врёт про импорт', async () => {
  // ключ, записанный версией до задачи 25: поля kind в нём нет
  const { document, window } = await boot();
  const store = JSON.parse(window.localStorage.getItem(NS));
  window.localStorage.setItem(NS + ':wiped', JSON.stringify({
    store, wipedAt: Date.now(), stats: { items: 4, days: 2 }
  }));
  openData(document);
  const row = document.querySelector('#scr-settings .restore:not(.corrupt)');
  assert.match(row.textContent, /состояние до чистки/);
  assert.doesNotMatch(row.textContent, /до импорта/);
  assert.match(row.textContent, /4 пункта, 2 дня отметок/);
  // и «Вернуть» на ней работает так же: содержательное нынешнее состояние
  // уходит в обмен (задача 26, п. 1.1)
  row.querySelector('[data-act="wipe-undo"]').click();
  assert.equal(JSON.parse(window.localStorage.getItem(NS + ':wiped')).kind, 'restore');
});

test('З25/7: при содержательном store предупреждение чистки обещает замену копии', async () => {
  const { document } = await boot({ seed: trainSeed() });
  wipeThroughUi(document);          // копия появилась
  openData(document);
  document.querySelector('[data-act="wipe-undo"]').click(); // и store снова содержателен
  openData(document);
  // копия ушла вместе с возвратом — наведём её заново другим путём
  document.querySelector('[data-act="wipe-open"]').click();
  assert.doesNotMatch(document.querySelector('#scr-settings .danger').textContent,
    /Прежняя копия будет заменена/, 'копии нет — обещать нечего');

  document.querySelector('[data-act="wipe-do"]').click();
  document.querySelector('[data-act="wipe-do"]').click();
  openData(document);
  document.querySelector('[data-act="wipe-undo"]').click();
  // копия есть И store содержателен — только тогда обещание правдиво
  const { document: d2, window: w2 } = await boot({ seed: trainSeed() });
  w2.localStorage.setItem(NS + ':wiped', JSON.stringify({
    store: JSON.parse(w2.localStorage.getItem(NS)), wipedAt: Date.now(), stats: {}, kind: 'wipe'
  }));
  openData(d2);
  d2.querySelector('[data-act="wipe-open"]').click();
  assert.match(d2.querySelector('#scr-settings .danger').textContent,
    /Прежняя копия будет заменена новой: хранится одна, последняя\./);
});

test('З25/2: копию некуда положить — импорт не выполняется, данные не тронуты', async () => {
  const { document, window } = await boot();
  const before = window.localStorage.getItem(NS);
  const proto = Object.getPrototypeOf(window.localStorage);
  const desc = Object.getOwnPropertyDescriptor(proto, 'setItem');
  const real = desc.value;
  let said = '';
  Object.defineProperty(proto, 'setItem', {
    value: function (k, v) { if (k === NS + ':wiped') throw new Error('quota'); return real.call(this, k, v); },
    configurable: true, writable: true
  });
  window.confirm = () => true;
  window.alert = m => { said = m; };
  openData(document);
  const inp = document.getElementById('import-file');
  const file = new window.File([JSON.stringify(otherFile())], 'm.json', { type: 'application/json' });
  Object.defineProperty(inp, 'files', { value: [file], configurable: true });
  inp.dispatchEvent(new window.Event('change', { bubbles: true }));
  for (let i = 0; i < 200 && !said; i++) await new Promise(r => setTimeout(r, 5));
  Object.defineProperty(proto, 'setItem', desc);

  assert.match(said, /Импорт не выполнен: копию прежних данных некуда сохранить\./);
  assert.equal(window.localStorage.getItem(NS), before, 'данные не тронуты');
  assert.equal(window.localStorage.getItem(NS + ':wiped'), null, 'и копии не появилось');
});

/* ══ Задача 26. Отклик и вид ═══════════════════════════════════ */

/* Сид с длинным списком: подтверждение сохранения обязано вставать у
   строки, а не в шапке, и разница между двумя местами должна быть
   заметна не только глазом. Идентификаторы фиксированы. */
function flashSeed() {
  const mon = curMonday();
  const item = (id, name, extra) => Object.assign({
    id, name, value: 10, unit: 'мин', type: 'daily', area: 'min',
    goal: null, note: '', group: '', active: true, addedAt: addKey(mon, -70),
    raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
    formula: null, ladder: null, ladderLog: []
  }, extra);
  return {
    schemaVersion: 16,
    groups: [{ name: 'Утро' }, { name: 'Вечер' }],
    items: [
      item('f-1', 'Первый', { group: 'Утро' }),
      item('f-2', 'Второй', { group: 'Утро' }),
      item('f-3', 'Третий', { group: 'Вечер' }),
      item('f-4', 'Последний', { group: 'Вечер' }),
      item('f-w', 'Тренировка', { type: 'weekly', value: null, unit: '', goal: 3 }),
      item('f-h', 'Привычка', { area: 'habit', type: 'daily', value: null, unit: '', normPerWeek: 7 })
    ],
    exercises: [{ id: 'f-ex', name: 'Жим', unit: 'кг', value: 60, history: [], active: true, addedAt: addKey(mon, -70) }],
    days: {}, weekLog: [], reviews: [], pendingRaises: [], pendingLowers: [], sessions: [],
    notes: [{ id: 'f-n', date: daysAgo(1), text: 'Старая заметка', kind: 'note', source: '', updatedAt: 1 }],
    paramDecided: {}, draftOneChange: '', weekStart: mon,
    settings: { dayBoundary: 4, dayThreshold: 0.8, exportedAt: null, calendarSince: addKey(mon, -70), habitSeeded: true, seed17: true }
  };
}

const openSettings = document => document.querySelector('#tabs button[data-tab="settings"]').click();
const openSect = (document, re) => {
  const s = [...document.querySelectorAll('#scr-settings details.sect')]
    .find(d => re.test(d.querySelector('summary').textContent));
  if (s && !s.open) s.querySelector('summary').click();
  return s;
};
const byId = (document, act, id) =>
  [...document.querySelectorAll(`[data-act="${act}"]`)].find(x => x.dataset.id === id);

test('З26/2.1: «Сохранено» встаёт у строки формы, а не в шапке экрана', async () => {
  const { document } = await boot({ seed: flashSeed() });
  openSettings(document);
  byId(document, 'edit-open', 'f-4').click();
  document.getElementById('e-name').value = 'Последний+';
  document.querySelector('[data-act="edit-save"]').click();

  const flash = document.querySelector('#scr-settings .flash');
  assert.ok(flash, 'подтверждение показано');
  assert.equal(flash.textContent, 'Сохранено');
  assert.equal(flash.getAttribute('role'), 'status');

  // якорь — строка того пункта, чья форма закрылась; шапка узла не несёт
  const row = flash.closest('.rowwrap');
  assert.ok(row, 'узел внутри строки пункта');
  assert.equal(row.dataset.dragId, 'f-4');
  assert.equal(document.querySelector('#scr-settings > .flash'), null, 'в шапке экрана узла нет');
  const head = document.querySelector('#scr-settings header.page');
  assert.equal(head.nextElementSibling.classList.contains('flash'), false);

  // разовое: следующий рендер его не повторяет
  byId(document, 'edit-open', 'f-1').click();
  assert.equal(document.querySelector('#scr-settings .flash'), null, 'подтверждение разовое');
});

test('З26/2.1: подтверждение стоит у своей строки в каждой из форм списка', async () => {
  const { document } = await boot({ seed: flashSeed() });
  openSettings(document);

  // блок
  openSect(document, /Блоки/);
  [...document.querySelectorAll('[data-act="group-open"]')].find(x => x.dataset.name === 'Вечер').click();
  document.getElementById('g-name').value = 'Ночь';
  document.querySelector('[data-act="group-save"]').click();
  let flash = document.querySelector('#scr-settings .flash');
  assert.ok(flash.closest('.rowwrap').textContent.includes('Ночь'), 'подтверждение у переименованного блока');

  // упражнение
  openSect(document, /Упражнения/);
  document.querySelector('[data-act="ex-open"]').click();
  document.getElementById('x-name').value = 'Жим стоя';
  document.querySelector('[data-act="ex-save"]').click();
  flash = document.querySelector('#scr-settings .flash');
  assert.equal(flash.closest('.rowwrap').dataset.dragId, 'f-ex');

  // заметка
  document.querySelector('#tabs button[data-tab="notes"]').click();
  document.querySelector('[data-act="note-open"]').click();
  document.getElementById('n-text').value = 'Правленая заметка';
  document.querySelector('[data-act="note-save"]').click();
  flash = document.querySelector('#scr-notes .flash');
  assert.ok(flash, 'подтверждение на «Заметках»');
  assert.equal(flash.previousElementSibling.dataset.id, 'f-n', 'сразу под своей карточкой');

  // лист детали: форма формулы
  document.querySelector('#tabs button[data-tab="settings"]').click();
  byId(document, 'edit-open', 'f-1').click();
  document.querySelector('#scr-settings [data-act="item-detail"]').click();
  document.querySelector('[data-act="formula-open"]').click();
  document.getElementById('fx-anchor').value = 'после душа';
  document.querySelector('[data-act="formula-save"]').click();
  flash = document.querySelector('#scr-detail .flash');
  assert.ok(flash, 'подтверждение в листе детали');
  assert.ok(flash.previousElementSibling.querySelector('[data-act="formula-open"]'),
    'сразу под кнопкой «Изменить», которой уступила место форма');
});

/* Таблица форм: у каждой — как открыть, какое поле испортить, что должно
   быть сказано и какое поле обязано уцелеть. Тест общего вида (п. 10.2):
   расхождение между соседними формами ловится одним прогоном, а не
   отдельным тестом на каждую. */
const REFUSALS = [
  { name: 'правка пункта', open: d => byId(d, 'edit-open', 'f-1').click(),
    field: 'e-value', bad: 'ноль', save: 'edit-save', say: /Значение не принято/ },
  { name: 'правка пункта — пустое название', open: d => byId(d, 'edit-open', 'f-1').click(),
    field: 'e-name', bad: '  ', save: 'edit-save', say: /Название не заполнено/ },
  { name: 'правка недельного', open: d => byId(d, 'edit-open', 'f-w').click(),
    field: 'e-goal', bad: '0', save: 'edit-save', say: /Цель не принята/ },
  { name: 'добавление пункта', open: d => [...d.querySelectorAll('[data-act="add-open"]')].find(x => x.dataset.area === 'min').click(),
    field: 'f-name', bad: '', save: 'add-save', say: /Название не заполнено/,
    pre: d => { d.getElementById('f-value').value = '7'; } },
  { name: 'добавление пункта — значение', open: d => [...d.querySelectorAll('[data-act="add-open"]')].find(x => x.dataset.area === 'min').click(),
    field: 'f-value', bad: 'три', save: 'add-save', say: /Значение не принято/,
    pre: d => { d.getElementById('f-name').value = 'Новый'; } },
  { name: 'правка блока', sect: /Блоки/, open: d => d.querySelector('[data-act="group-open"]').click(),
    field: 'g-name', bad: 'Вечер', save: 'group-save', say: /Блок с таким именем уже есть/ },
  { name: 'добавление блока', sect: /Блоки/, open: d => d.querySelector('[data-act="group-add-open"]').click(),
    field: 'g-add', bad: 'Утро', save: 'group-add-save', say: /Блок с таким именем уже есть/ },
  { name: 'правка упражнения', sect: /Упражнения/, open: d => d.querySelector('[data-act="ex-open"]').click(),
    field: 'x-name', bad: ' ', save: 'ex-save', say: /Название не заполнено/ },
  { name: 'добавление упражнения', sect: /Упражнения/, open: d => d.querySelector('[data-act="ex-add-open"]').click(),
    field: 'x-add-value', bad: 'много', save: 'ex-add-save', say: /Нагрузка не принята/,
    pre: d => { d.getElementById('x-add-name').value = 'Приседания'; } }
];

test('З26/2.3–2.5: все формы отказывают одинаково — строка у кнопки, форма цела', async () => {
  for (const f of REFUSALS) {
    const { document, window } = await boot({ seed: flashSeed() });
    const before = window.localStorage.getItem(NS);
    openSettings(document);
    if (f.sect) openSect(document, f.sect);
    f.open(document);
    if (f.pre) f.pre(document);
    document.getElementById(f.field).value = f.bad;
    document.querySelector(`[data-act="${f.save}"]`).click();

    const said = document.querySelector('#scr-settings .flash.keep');
    assert.ok(said, `${f.name}: отказ сказан`);
    assert.match(said.textContent, f.say, f.name);
    // строка стоит вплотную к нажатой кнопке — над её рядом
    assert.ok(said.nextElementSibling.contains(document.querySelector(`[data-act="${f.save}"]`)),
      `${f.name}: строка у нажатой кнопки`);
    assert.equal(document.querySelector('#scr-settings .flash:not(.keep)'), null,
      `${f.name}: «Сохранено» при отброшенном вводе не показывается`);
    assert.ok(document.getElementById(f.field), `${f.name}: форма осталась открытой`);
    assert.equal(document.getElementById(f.field).value, f.bad, `${f.name}: введённое цело`);
    assert.equal(window.localStorage.getItem(NS), before, `${f.name}: в store не записано ничего`);
    assert.doesNotMatch(said.textContent, /ошибк|!/i, `${f.name}: без слова «ошибка» и восклицаний`);
  }
});

test('З26/2.5: те же формы, принятый ввод — «Сохранено» и закрытие', async () => {
  const OK = [
    { name: 'правка пункта', open: d => byId(d, 'edit-open', 'f-1').click(), field: 'e-name', good: 'Первый+', save: 'edit-save' },
    { name: 'правка недельного', open: d => byId(d, 'edit-open', 'f-w').click(), field: 'e-goal', good: '4', save: 'edit-save' },
    { name: 'добавление пункта', open: d => [...d.querySelectorAll('[data-act="add-open"]')].find(x => x.dataset.area === 'min').click(), field: 'f-name', good: 'Новый', save: 'add-save' },
    { name: 'правка блока', sect: /Блоки/, open: d => d.querySelector('[data-act="group-open"]').click(), field: 'g-name', good: 'Рассвет', save: 'group-save' },
    { name: 'добавление блока', sect: /Блоки/, open: d => d.querySelector('[data-act="group-add-open"]').click(), field: 'g-add', good: 'День', save: 'group-add-save' },
    { name: 'правка упражнения', sect: /Упражнения/, open: d => d.querySelector('[data-act="ex-open"]').click(), field: 'x-name', good: 'Жим узким', save: 'ex-save' },
    { name: 'добавление упражнения', sect: /Упражнения/, open: d => d.querySelector('[data-act="ex-add-open"]').click(), field: 'x-add-name', good: 'Присед', save: 'ex-add-save' }
  ];
  for (const f of OK) {
    const { document } = await boot({ seed: flashSeed() });
    openSettings(document);
    if (f.sect) openSect(document, f.sect);
    f.open(document);
    document.getElementById(f.field).value = f.good;
    document.querySelector(`[data-act="${f.save}"]`).click();

    assert.equal(document.getElementById(f.field), null, `${f.name}: форма закрылась`);
    const flash = document.querySelector('#scr-settings .flash');
    assert.ok(flash, `${f.name}: подтверждение показано`);
    assert.equal(flash.textContent, 'Сохранено', f.name);
    assert.equal(flash.classList.contains('keep'), false, `${f.name}: подтверждение гаснет само`);
    assert.ok(flash.closest('.rowwrap'), `${f.name}: узел у строки записи`);
  }
});

test('З26/2.2: пустая новая заметка — отказ, а не тихое закрытие', async () => {
  const { document, window } = await boot({ seed: flashSeed() });
  document.querySelector('#tabs button[data-tab="notes"]').click();
  [...document.querySelectorAll('[data-act="note-add-open"]')].find(b => b.dataset.kind === 'note').click();
  document.getElementById('n-text').value = '   ';
  document.querySelector('[data-act="note-save"]').click();
  assert.ok(document.getElementById('n-text'), 'форма осталась');
  assert.match(document.querySelector('#scr-notes .flash.keep').textContent, /Текст не заполнен/);
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).notes.length, 1, 'записи не прибавилось');

  // пустой текст у СУЩЕСТВУЮЩЕЙ записи по-прежнему удаляет её (инвариант 16),
  // и об этом говорится: своей строки у удалённой записи больше нет
  document.querySelector('[data-act="note-cancel"]').click();
  document.querySelector('[data-act="note-open"]').click();
  document.getElementById('n-text').value = '';
  document.querySelector('[data-act="note-save"]').click();
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).notes.length, 0, 'запись удалена');
  assert.match(document.querySelector('#scr-notes .flash').textContent, /Запись удалена/);
});

test('З26/2.3: невалидная планка в разборе — карточка говорит, а не молчит', async () => {
  const seed = dueSeed();
  const prev = prevMonday();
  for (let w = 1; w <= 3; w++) fillWeek(seed.days, 'it1', addKey(prev, -7 * (w - 1)), 7);
  seed.settings.calendarSince = addKey(prev, -70);
  const { document, window } = await boot({ seed });
  openReview(document);
  document.querySelector('[data-act="raise-edit"]').click();
  document.querySelector('.card.raise .num').value = 'ноль';
  document.querySelector('[data-act="raise-ok"]').click();

  assert.ok(document.querySelector('.card.raise'), 'карточка осталась');
  assert.match(document.querySelector('.card.raise .flash.keep').textContent, /Планка не принята/);
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items[0].value, 10, 'планка не тронута');
});

/* ── п. 3: черновик листа «Тренировка» ─────────────────────── */

test('З26/3: нагрузки и заметка листа переживают перерисовку и смену дня', async () => {
  const { document, window } = await boot({ seed: trainSeed() });
  document.querySelector('[data-act="train-inc"]').click();
  document.getElementById('ex-e1').value = '47,5';
  document.getElementById('ex-e2').value = '80';
  document.getElementById('tr-note').value = 'тяжело шло';

  // обычная перерисовка листа
  window.renderTrain();
  assert.equal(document.getElementById('ex-e1').value, '47,5');
  assert.equal(document.getElementById('ex-e2').value, '80');
  assert.equal(document.getElementById('tr-note').value, 'тяжело шло');

  // смена логического дня — тот же путь, что у черновика заметки (задача 15)
  shiftWindowDate(window, 26 * 3600000);
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(document.getElementById('scr-train').hidden, false, 'лист не закрылся');
  assert.equal(document.getElementById('ex-e1').value, '47,5', 'нагрузка пережила смену дня');
  assert.equal(document.getElementById('tr-note').value, 'тяжело шло', 'заметка пережила смену дня');

  // и записывается именно то, что видно
  document.querySelector('[data-act="train-save"]').click();
  const s = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(s.sessions[0].note, 'тяжело шло');
  assert.deepEqual(s.sessions[0].entries, [{ exId: 'e1', value: 47.5 }, { exId: 'e2', value: 80 }]);
});

test('З26/3: черновик листа — свой слот; закрытие листа его убирает', async () => {
  const { document, window } = await boot({ seed: trainSeed() });
  // начатая правка в «Пунктах» не должна пострадать от листа и наоборот
  openSettings(document);
  document.querySelector('[data-act="edit-open"]').click();
  document.getElementById('e-name').value = 'Начатая правка';
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector('[data-act="train-inc"]').click();
  document.getElementById('tr-note').value = 'черновик листа';
  window.renderTrain();
  assert.equal(document.getElementById('tr-note').value, 'черновик листа');

  document.querySelector('[data-act="train-cancel"]').click();
  document.querySelector('[data-act="train-inc"]').click();
  assert.equal(document.getElementById('tr-note').value, '', 'новый лист — чистые поля');
});

/* ── п. 4: скролл и фокус листов ───────────────────────────── */

/* Скролл в jsdom не существует: boot глушит scrollTo. Записываем вызовы и
   подставляем scrollY — предмет проверки в том, КУДА приложение просит
   вернуться, а не в том, прокрутится ли окно. */
function scrollSpy(window) {
  const calls = [];
  window.scrollTo = (x, y) => calls.push(y);
  const at = y => Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  return { calls, at, last: () => calls[calls.length - 1] };
}

const SHEETS = [
  { name: 'деталь пункта', tab: 'today', screen: 'scr-detail',
    open: d => d.querySelector('#scr-today [data-act="item-detail"]').click(), act: 'item-detail' },
  { name: 'разбор недели', tab: 'today', screen: 'scr-review',
    open: d => d.querySelector('#scr-today [data-act="goto-review"]').click(), act: 'goto-review' },
  { name: 'тренировка', tab: 'today', screen: 'scr-train',
    open: d => d.querySelector('#scr-today [data-act="train-inc"]').click(), act: 'train-inc' }
];

/* Сид, в котором на «Сегодня» разом есть все три входа в листы */
function sheetSeed() {
  const seed = dueSeed();
  seed.items[0].formula = { anchor: 'после душа', when: '', pair: '', identity: '', twoMin: '', friction: '', proof: '', mode: 'build' };
  seed.items.push({
    id: 'sw', name: 'Тренировка', value: null, unit: '', type: 'weekly', area: 'min',
    goal: 3, note: '', group: '', active: true, addedAt: addKey(prevMonday(), -14),
    raiseAfter: 0, history: []
  });
  return seed;
}

test('З26/4.1: все три листа возвращают скролл и при закрытии таб-баром', async () => {
  for (const s of SHEETS) {
    const { document, window } = await boot({ seed: sheetSeed() });
    const spy = scrollSpy(window);
    spy.at(640);
    s.open(document);
    assert.equal(document.getElementById(s.screen).hidden, false, `${s.name}: лист открыт`);

    spy.at(0);
    document.querySelector(`#tabs button[data-tab="${s.tab}"]`).click(); // закрытие таб-баром
    assert.equal(document.getElementById(s.screen).hidden, true, `${s.name}: лист закрыт`);
    assert.equal(spy.last(), 640, `${s.name}: прежний скролл возвращён таб-баром`);
  }
});

test('З26/4.1: уход таб-баром на ЧУЖУЮ вкладку скролл не возвращает', async () => {
  const { document, window } = await boot({ seed: sheetSeed() });
  const spy = scrollSpy(window);
  spy.at(640);
  document.querySelector('#scr-today [data-act="train-inc"]').click();
  spy.at(0);
  document.querySelector('#tabs button[data-tab="progress"]').click();
  assert.equal(spy.last(), 0, 'другая вкладка открывается сверху');
});

test('З26/4.2: фокус уходит в лист и возвращается на кнопку-источник', async () => {
  for (const s of SHEETS) {
    // «Готово» / «Отмена»
    const a = await boot({ seed: sheetSeed() });
    s.open(a.document);
    const h1 = a.document.querySelector(`#${s.screen} h1`);
    assert.equal(a.document.activeElement, h1, `${s.name}: фокус в заголовке листа`);
    assert.equal(h1.getAttribute('tabindex'), '-1', `${s.name}: заголовок фокусируем`);
    const close = a.document.querySelector(`#${s.screen} [data-act$="-done"], #${s.screen} [data-act="train-cancel"]`);
    close.click();
    assert.equal(a.document.activeElement.dataset.act, s.act, `${s.name}: фокус вернулся источнику`);

    // таб-бар на ту же вкладку
    const b = await boot({ seed: sheetSeed() });
    s.open(b.document);
    b.document.querySelector(`#tabs button[data-tab="${s.tab}"]`).click();
    assert.equal(b.document.activeElement.dataset.act, s.act, `${s.name}: и при закрытии таб-баром`);
  }
});

test('З26/4.3: ловушки фокуса нет — таб-бар из открытого листа достижим', async () => {
  const { document } = await boot({ seed: sheetSeed() });
  document.querySelector('#scr-today [data-act="item-detail"]').click();
  const tabs = [...document.querySelectorAll('#tabs button')];
  assert.equal(tabs.length, 5);
  for (const t of tabs) {
    assert.equal(t.disabled, false);
    assert.equal(t.getAttribute('aria-hidden'), null);
    assert.equal(t.getAttribute('tabindex'), null, 'таб-бар из фокусного обхода не изымается');
  }
  assert.equal(document.querySelector('#tabs').getAttribute('inert'), null);
});

/* ── п. 5: отделка, замером по объявлениям ─────────────────── */

const CSS_SRC = () => fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
/* Тело правила по ТОЧНОМУ селектору. Селектор ищется от начала строки:
   иначе «.cdays i» нашлось бы внутри «.grid i, .cdays i», и тест мерил бы
   чужое правило, ничего об этом не сообщив. */
const ruleOf = (css, sel) => {
  const re = new RegExp('(?:^|\\n)' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
  const m = re.exec(css);
  return m ? m[1] : null;
};
const px = (body, prop) => parseFloat((new RegExp(prop + ':\\s*([\\d.]+)px').exec(body || '') || [])[1]);

test('З26/5.1: планка дня и полоса «Прогресса» — одна форма и один градиент', async () => {
  const css = CSS_SRC();
  const box = ruleOf(css, '.bar, .dbar');
  assert.ok(box, 'правило формы общее для обеих полос');
  assert.equal(px(box, 'height'), 8, 'высота 8px — как у полосы «Прогресса» (была 3px)');
  assert.match(box, /border-radius:\s*var\(--radius-sm\)/);
  const fill = ruleOf(css, '.bar i, .dbar i');
  assert.match(fill, /background:\s*linear-gradient\(90deg, var\(--accent\), var\(--chain\)\)/,
    'градиент --accent → --chain у обеих');
  assert.match(fill, /border-radius:\s*var\(--radius-sm\)/);
  // одна форма — одно место: своего правила у .dbar i нет, градиент в файле один
  assert.equal(ruleOf(css, '.dbar i'), null, 'у .dbar i своего правила нет');
  assert.doesNotMatch(ruleOf(css, '.dbar') || '', /height|linear-gradient/);
  assert.equal((css.match(/linear-gradient/g) || []).length, 1,
    'градиент в приложении по-прежнему один — на планку дня (CLAUDE.md)');

  // и в живом DOM обе полосы на месте
  const { document } = await boot({ seed: progSeed() });
  assert.ok(document.querySelector('#scr-today .bar i'), 'планка на «Сегодня»');
  openProgress(document);
  assert.ok(document.querySelector('#scr-progress .dbar i'), 'полоса на «Прогрессе»');
});

test('З26/5.2: счёт дня — на ступени недельного счётчика того же экрана', () => {
  const css = CSS_SRC();
  const note = ruleOf(css, '.bar-note');
  const num = ruleOf(css, '.bar-note b');
  const wnum = ruleOf(css, '.wnum');
  const wnumB = ruleOf(css, '.wnum b');
  assert.match(note, /font-size:\s*var\(--text-base\)/, 'строка счёта — 17px, как .wnum');
  assert.equal(px(wnum, 'font-size'), 17);
  assert.equal(px(num, 'font-size'), 22, 'число — 22px');
  assert.equal(px(num, 'font-size'), px(wnumB, 'font-size'), 'ступень та же, что у .wnum b');
  // новой ступени не заведено: крупнее 22px только h1/.stat и «+»
  const sizes = [...css.matchAll(/font-size:\s*(\d+)px/g)].map(m => +m[1]);
  assert.deepEqual([...new Set(sizes)].sort((a, b) => b - a).slice(0, 3), [32, 24, 22]);
});

test('З26/5.3: имя блока не мельче и не тише надстрочника приложения', () => {
  const css = CSS_SRC();
  const g = ruleOf(css, '.g-label');
  const o = ruleOf(css, '.overline');
  assert.match(g, /font-size:\s*var\(--text-xs\)/, 'ступень существующая');
  assert.equal(px(o, 'font-size'), 12);
  assert.ok(13 >= px(o, 'font-size'), '--text-xs (13px) не мельче .overline (12px)');
  assert.match(g, /color:\s*var\(--muted\)/, 'тон не тише .overline');
  assert.doesNotMatch(g, /--faint/);
  assert.equal(/font-weight:\s*650/.test(g), /font-weight:\s*650/.test(o), 'вес общий, как и был');
  // 11px больше нигде не живёт — ступень ушла из шкалы вместе с .g-label
  assert.doesNotMatch(css, /font-size:\s*11px/);
});

test('З26/5.4: рамка кнопки — тот же токен, что у поля ввода', () => {
  const css = CSS_SRC();
  const btn = ruleOf(css, '.btn');
  const field = ruleOf(css, '.field input, .field select, .field textarea, select');
  const tok = s => (/border:\s*1px solid var\(--([\w-]+)\)/.exec(s) || [])[1];
  assert.equal(tok(btn), 'control-border');
  assert.equal(tok(btn), tok(field), 'кнопка и поле обведены одним токеном');
  assert.doesNotMatch(btn, /--line-strong/);
  // «+» больше не переопределяет рамку на тихий тон
  assert.doesNotMatch(ruleOf(css, '.btn.plus'), /border-color/);
});

test('З26/5.5: ячейка цепи крупнее — доля краски считается, а не назначается', () => {
  const css = CSS_SRC();
  const grid = ruleOf(css, '.cdays');
  const cell = ruleOf(css, '.cdays i');
  assert.match(grid, /grid-template-columns:\s*repeat\(7, 1fr\)/, 'колонки тянутся по ширине карточки');
  const d = px(cell, 'width');
  assert.equal(d, px(cell, 'height'), 'ячейка круглая');

  // ширина карточки на целевом устройстве: 375 − поля экрана − поля и рамка карточки
  const screenPad = px(ruleOf(css, '.screen'), 'padding-left') || 20;
  const cardPad = px(ruleOf(css, '.pcard'), 'padding');
  const inner = 375 - 2 * screenPad - 2 * cardPad - 2;
  const share = 7 * d / inner;
  assert.ok(share > 0.4, `доля краски ${(share * 100).toFixed(1)}% — было 20,9%`);
  // зазор между кругами остаётся воздухом, круги не касаются
  const gapCol = parseFloat((/gap:\s*[\d.]+px\s+([\d.]+)px/.exec(grid) || [])[1]);
  assert.ok(inner / 7 - d >= gapCol, 'круги не касаются');

  // сетка разбора свой шаг сохранила: 26px там выравнивает кружки с именами
  assert.match(ruleOf(css, '.grid'), /repeat\(var\(--cols\), 26px\)/);
  assert.equal(px(ruleOf(css, '.grid i, .cdays i'), 'width'), 9, 'кружок разбора прежний');
  assert.ok(d > 9, 'ячейка цепи крупнее кружка разбора');
});

/* ── п. 6: отклик на нажатие ───────────────────────────────── */

/* Полный список тач-целей приложения. Круг отметки и тумблер в него не
   входят: у них свой отклик — заливка с .pop и ход головки. */
const TAPPABLE = ['.btn', '.banner:not(.static)', '.idetail', '.dot', '.undo',
  '.itxt', '.card.note', '.sect > summary', '#tabs button'];

test('З26/6.1: состояние нажатия есть у каждой тач-цели, не только у .btn', () => {
  const css = CSS_SRC();
  for (const sel of TAPPABLE) {
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':active');
    assert.match(css, re, `нет состояния нажатия у ${sel}`);
  }
  const start = css.indexOf('.btn:active');
  const block = css.slice(start, css.indexOf('}', start) + 1);
  assert.match(block, /background:\s*var\(--accent-weak\)/, 'тон — существующий токен');
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b/i, 'сырых цветов в отклике нет');
  assert.doesNotMatch(block, /rgba?\(/, 'сырых rgba в отклике нет');
  // системную подсветку снимает body — отклик обязан быть своим
  assert.match(css, /-webkit-tap-highlight-color:\s*transparent/);
});

/* Нативные контролы: у них свой отклик — галочка, ход головки тумблера,
   системный список select, календарь date. Заливкой их не подменяют. */
const EXEMPT = ['input', 'select', 'label.switch', 'label.row.check', '.banner.static'];

/* Обход живого DOM, а не сверка со списком: любая будущая тач-цель без
   отклика на нажатие валит этот тест сама, без правки списка (п. 10.6). */
test('З26/6.1: ни одной тач-цели без отклика на нажатие на всех экранах и листах', async () => {
  const seed = sheetSeed();
  seed.notes = [{ id: 'sn', date: daysAgo(1), text: 'Заметка', kind: 'note', source: '', updatedAt: 1 }];
  seed.exercises = [{ id: 'sx', name: 'Жим', unit: 'кг', value: 60, history: [], active: true, addedAt: addKey(prevMonday(), -14) }];
  seed.days[daysAgo(2)] = { it1: true }; // пункт начат, вчера пропуск — будет точка
  const { document } = await boot({ seen: undefined, seed });

  const seen = new Set();
  const scan = () => {
    for (const el of document.querySelectorAll('section.screen:not([hidden]) [data-act], section.screen:not([hidden]) button, #tabs button, #tabs summary')) {
      if (EXEMPT.some(s => el.matches(s))) continue;
      const hit = TAPPABLE.find(s => el.matches(s));
      assert.ok(hit, `тач-цель без отклика на нажатие: <${el.tagName.toLowerCase()} class="${el.className}" data-act="${el.dataset.act || ''}">`);
      seen.add(hit);
    }
  };

  for (const t of ['today', 'habits', 'progress', 'notes', 'settings']) {
    document.querySelector(`#tabs button[data-tab="${t}"]`).click();
    if (t === 'settings') {
      [...document.querySelectorAll('#scr-settings details.sect')].forEach(d => { if (!d.open) d.querySelector('summary').click(); });
    }
    scan();
  }
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector('#scr-today [data-act="miss-note"]').click(); // раскрытая подпись даёт «отметить»
  scan();
  for (const s of ['scr-detail', 'scr-review', 'scr-train']) {
    document.querySelector('#tabs button[data-tab="today"]').click();
    const open = { 'scr-detail': 'item-detail', 'scr-review': 'goto-review', 'scr-train': 'train-inc' }[s];
    document.querySelector(`#scr-today [data-act="${open}"]`).click();
    scan();
  }
  // и список не ветшает: каждая перечисленная тач-цель где-то действительно есть
  for (const sel of TAPPABLE) assert.ok(seen.has(sel), `${sel} — селектор в списке, но на экранах не встречается`);
});

test('З26/6.3: все переходы движения — в окне 180–260 мс', () => {
  const css = CSS_SRC();
  const secs = [...css.matchAll(/transition:[^;]*?([\d.]+)s/g)].map(m => Math.round(+m[1] * 1000));
  assert.ok(secs.length >= 10, 'переходы найдены');
  for (const ms of secs) assert.ok(ms >= 180 && ms <= 260, `переход ${ms} мс вне окна 180–260`);
  // анимации-отклики тоже; flash-note — не переход движения, а появление,
  // удержание и уход, и конституция считает его отдельно
  for (const m of css.matchAll(/animation:\s*([\w-]+)\s+([\d.]+)s/g)) {
    if (m[1] === 'flash-note' || m[1] === 'none') continue;
    const ms = Math.round(+m[2] * 1000);
    assert.ok(ms >= 180 && ms <= 260, `анимация ${m[1]} ${ms} мс вне окна`);
  }
  // таб-бар был единственным нарушителем: .16s ease
  assert.doesNotMatch(css, /transition:\s*color\s*\.16s/);
});

test('З26/6.4: reduced-motion гасит движение, состояние нажатия остаётся достижимым', () => {
  const css = CSS_SRC();
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(block, /\*, \*::before, \*::after\s*\{[^}]*transition: none !important/);
  assert.match(block, /animation: none !important/);
  // состояние нажатия мгновенное: переходов ему не заведено, гасить нечего
  const start = css.indexOf('.btn:active');
  assert.doesNotMatch(css.slice(start, css.indexOf('}', start)), /transition|animation/);
  // и ни одно правило :active внутри блока reduced-motion не отменяется
  assert.doesNotMatch(block, /:active/);
});

/* ── п. 7–8: тексты и доступность ──────────────────────────── */

test('З26/7: тексты «Системы» описывают то, что приложение делает', async () => {
  const { document } = await boot({ seed: flashSeed() });
  openSettings(document);
  const sys = openSect(document, /Система/).textContent;
  // блоки: набор посева, а не выдуманный
  assert.doesNotMatch(sys, /Тело:/, 'блока «Тело» в программе нет');
  assert.doesNotMatch(sys, /Сон:/);
  assert.doesNotMatch(sys, /Развитие:/);
  // «одно изменение за раз» названо тем, чем оно держится
  assert.match(sys, /лестница одна и повышение планки одно за разбор/);

  // и посев действительно заводит те блоки, что названы
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const seeded = /const SEED_GROUPS = \[([^\]]*)\]/.exec(app)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
  assert.equal(seeded.length, 3);
  for (const g of seeded) assert.ok(sys.includes(g), `«Система» не называет блок ${g}`);
});

test('З26/7: устаревших комментариев про «два листа» и «отдельную задачу» нет', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.doesNotMatch(app, /Перетаскивание — отдельная задача/);
  assert.doesNotMatch(app, /он открывается и из разбора/);
  assert.doesNotMatch(app, /два листа поверх них/);
  assert.match(app, /три листа поверх них/);
  // счёт форм в комментарии сторожа сходится с его же ассертом (было «девяти»)
  const dom = fs.readFileSync(path.join(ROOT, 'tests', 'dom.test.js'), 'utf8');
  const said = /outerHTML всех ([а-я]+) форм/.exec(dom)[1];
  const checked = /Object\.keys\(got\)\.length, (\d+),/.exec(dom)[1];
  assert.equal(said, 'четырнадцати');
  assert.equal(checked, '14');
  // docs/plan.md помечен историческим, а не выдаёт себя за источник задач
  const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plan.md'), 'utf8');
  assert.match(plan, /исторический/i);
  assert.doesNotMatch(plan, /^Источник задач — этот файл/m);
});

test('З26/8.2: будущий день полосы недели не передаётся одной прозрачностью', () => {
  const css = CSS_SRC();
  const fut = ruleOf(css, '.hstrip i.fut');
  assert.match(fut, /visibility:\s*hidden/);
  assert.doesNotMatch(fut, /opacity/);
  // идиома та же, что в цепи дней «Прогресса»
  assert.match(css, /\.cdays i\.fut,\s*\n?\.cdays i\.pre \{[^}]*visibility:\s*hidden/);
});

test('З26/8.2: место будущей ячейки в раскладке остаётся — полоса не съезжает', async () => {
  const seed = dueSeed();
  seed.items.push({
    id: 'h1', name: 'Привычка', value: null, unit: '', type: 'daily', area: 'habit',
    goal: null, note: '', group: '', active: true, addedAt: addKey(curMonday(), -21),
    raiseAfter: 0, history: []
  });
  const { document } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="habits"]').click();
  const cells = [...document.querySelectorAll('#scr-habits .hstrip i')];
  assert.equal(cells.length, 7, 'семь ячеек на месте');
  assert.equal(document.querySelectorAll('#scr-habits .hstrip .hd').length, 7, 'и семь подписей дней');
});

/* ══ Задача 27.1: ремонт по приёмке — интерфейсный уровень ════ */

/* Пункт с ЗАКРЫТОЙ лестницей плюс второй дневной пункт: слот свободен,
   но на нём лежит пройденный путь. Сид для Д1 и Д2. */
function closedLadderSeed() {
  const mon = curMonday();
  const old = addKey(mon, -70);
  const item = (id, name, ladder, ladderLog) => ({
    id, name, value: null, unit: '', type: 'daily', area: 'min', normPerWeek: 7,
    goal: null, note: '', group: '', active: true, addedAt: old, raiseAfter: 0,
    raiseAfterWeek: null, lowerAfterWeek: null, history: [], formula: null,
    ladder: ladder || null, ladderLog: ladderLog || []
  });
  return {
    schemaVersion: 16, groups: [], exercises: [], sessions: [], notes: [],
    items: [
      item('cl1', 'Пройденная', { steps: ['раз', 'два'], step: 1, steppedWeek: null, startedAt: old, done: true },
        [{ date: old, step: 0, text: 'раз', start: true }, { date: addKey(old, 20), step: 1, text: 'два' },
          { date: addKey(old, 40), step: 1, text: 'два', closed: true }]),
      item('cl2', 'Свободный')
    ],
    days: {}, weekLog: [], reviews: [], pendingRaises: [], pendingLowers: [],
    paramDecided: {}, draftOneChange: '', weekStart: mon,
    settings: { dayBoundary: 4, dayThreshold: 0.8, exportedAt: null,
      calendarSince: old, habitSeeded: true, seed17: true }
  };
}

/* Открыть лист детали пункта: «Настройки» → правка пункта → «Формула и лестница» */
function openDetailFor(document, id) {
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector(`#scr-settings [data-act="edit-open"][data-id="${id}"]`).click();
  document.querySelector(`#scr-settings [data-act="item-detail"][data-id="${id}"]`).click();
}

test('З27/1: слот занят — «Открыть заново» не предлагается, и сказано кем', async () => {
  const { document } = await boot({ seed: closedLadderSeed() });
  // сперва слот свободен: кнопка есть
  openDetailFor(document, 'cl1');
  assert.ok(document.querySelector('#scr-detail [data-act="ladder-reopen"]'), 'слот свободен — кнопка есть');
  document.querySelector('[data-act="detail-done"]').click();

  // занимаем слот другим пунктом
  openDetailFor(document, 'cl2');
  document.querySelector('#scr-detail [data-act="ladder-open"]').click();
  document.getElementById('fx-steps').value = 'Н1\nН2';
  document.querySelector('#scr-detail [data-act="ladder-save"]').click();
  document.querySelector('[data-act="detail-done"]').click();

  // теперь у пройденной кнопки нет, а есть нейтральная строка с именем
  openDetailFor(document, 'cl1');
  const d = document.getElementById('scr-detail');
  assert.equal(d.querySelector('[data-act="ladder-reopen"]'), null, 'кнопки нет — сказано ДО тапа');
  const line = [...d.querySelectorAll('p.muted')].find(p => /слот лестницы/.test(p.textContent));
  assert.ok(line, 'строка о занятом слоте есть');
  assert.match(line.textContent, /«Свободный»/, 'и она называет, кем занят');
  assert.doesNotMatch(d.textContent, /провал|нельзя|ошибк/i, 'тон нейтральный');
});

test('З27/3: замена пройденной лестницы — вторым тапом, с предупреждением', async () => {
  const { document, window } = await boot({ seed: closedLadderSeed() });
  openDetailFor(document, 'cl1');
  document.querySelector('#scr-detail [data-act="ladder-open"]').click();

  const form = document.querySelector('#scr-detail [data-form="ladder"]');
  assert.match(form.textContent, /Эта лестница пройдена/, 'предупреждение до тапа');
  document.getElementById('fx-steps').value = 'Новая 1\nНовая 2';

  // первый тап только взводит подтверждение — данные не тронуты
  document.querySelector('#scr-detail [data-act="ladder-save"]').click();
  const btn = document.querySelector('#scr-detail [data-act="ladder-save"]');
  assert.match(btn.textContent, /Подтвердить: начать новую/);
  let saved = JSON.parse(window.localStorage.getItem(NS));
  assert.deepEqual(saved.items[0].ladder.steps, ['раз', 'два'], 'текст пройденной ещё цел');
  assert.equal(document.getElementById('fx-steps').value, 'Новая 1\nНовая 2', 'введённое на месте');

  // второй тап заводит НОВУЮ
  document.querySelector('#scr-detail [data-act="ladder-save"]').click();
  saved = JSON.parse(window.localStorage.getItem(NS));
  const L = saved.items[0].ladder;
  assert.deepEqual(L.steps, ['Новая 1', 'Новая 2']);
  assert.equal(L.done, false, 'новая живая');
  assert.equal(L.step, 0, 'с первой ступени');
  assert.equal(saved.items[0].ladderLog.filter(e => e.start).length, 2, 'вторая стартовая веха');
});

test('З27/5.1: запись не удалась — «Не сохранено», а не «Сохранено»', async () => {
  const { document, window } = await boot();
  const realLS = window.localStorage;
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get: () => ({ getItem: k => realLS.getItem(k), setItem: () => { throw new Error('quota'); }, removeItem: () => {} })
  });

  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('#scr-settings [data-act="edit-open"]').click();
  document.getElementById('e-name').value = 'Имя под квотой';
  document.querySelector('#scr-settings [data-act="edit-save"]').click();

  const flash = document.querySelector('#scr-settings .flash');
  assert.ok(flash, 'узел подтверждения на месте — у того же якоря');
  assert.match(flash.textContent, /Не сохранено/, 'приложение не утверждает того, чего не было');
  assert.doesNotMatch(flash.textContent, /^Сохранено$/);
  // и постоянный баннер говорит о причине — на ЭТОМ экране
  const note = document.getElementById('storage-note');
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /Хранилище недоступно/);

  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => realLS });
});

test('З27/4.1: узел подтверждения ищется на видимом экране, а не по всему документу', async () => {
  const { document, window } = await boot();
  // 1) сохраняем заметку — узел рождается в «Заметках»
  document.querySelector('#tabs button[data-tab="notes"]').click();
  document.querySelector('[data-act="note-add-open"]').click();
  document.getElementById('n-text').value = 'Заметка';
  document.querySelector('[data-act="note-save"]').click();
  assert.ok(document.querySelector('#scr-notes .flash'), 'узел в «Заметках»');

  // 2) уходим на «Настройки»: узлы скрытого экрана снимаются перерисовкой
  document.querySelector('#tabs button[data-tab="settings"]').click();
  assert.equal(document.querySelectorAll('#scr-notes .flash').length, 0,
    'на скрытом экране узлов не остаётся (п. 4.2)');

  // 3) сохраняем пункт — находится ИМЕННО его узел
  document.querySelector('#scr-settings [data-act="edit-open"]').click();
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  const all = [...document.querySelectorAll('main .screen .flash:not(.keep)')];
  assert.equal(all.length, 1, 'узел ровно один и он на видимом экране');
  assert.ok(document.getElementById('scr-settings').contains(all[0]));
});

test('З27/5.3: «Вернуть» при отказе говорит строкой и данных не трогает', async () => {
  const { document, window } = await boot();
  // копия появляется чисткой
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('[data-act="wipe-open"]').click();
  document.querySelector('[data-act="wipe-do"]').click(); // взвод
  document.querySelector('[data-act="wipe-do"]').click(); // чистка
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items.length, 0);

  document.querySelector('#tabs button[data-tab="settings"]').click();
  const copyBefore = window.localStorage.getItem(NS + ':wiped');
  assert.ok(copyBefore, 'копия есть');

  const realLS = window.localStorage;
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get: () => ({
      getItem: k => realLS.getItem(k),
      setItem: (k, v) => { if (k === NS) throw new Error('quota'); return realLS.setItem(k, v); },
      removeItem: k => realLS.removeItem(k)
    })
  });
  document.querySelector('[data-act="wipe-undo"]').click();
  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => realLS });

  assert.match(document.getElementById('scr-settings').textContent, /Возврат не выполнен — данные не изменены/,
    'молчать о неудаче нельзя — у чистки для того же есть строка');
  assert.equal(window.localStorage.getItem(NS + ':wiped'), copyBefore, 'копия побайтово на месте');
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items.length, 0, 'состояние прежнее');
});


/* Переписан в задаче 28.B, п. 4: прежде тест закреплял мир, в котором на
   «Настройках» открыты ДВЕ формы разом и обе стоят в разметке. Теперь форма
   на экране одна, и предмет проверки тот же по смыслу — правка блока не
   крадёт набранное в форме пункта, — но проверяется возвратом к ней. */
test('З27/9.1: раскрытая правка блока не крадёт черновик формы пункта', async () => {
  const { document } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('#scr-settings [data-act="edit-open"]').click();
  document.getElementById('e-name').value = 'Умыться ХОЛОДНОЙ ВОДОЙ';
  // секция «Блоки» стоит ВЫШЕ «Пунктов»: прежде её форма находилась первой
  document.querySelector('#scr-settings [data-act="group-open"]').click();
  assert.equal(document.getElementById('e-name'), null, 'форма пункта закрыта: на экране одна форма');
  assert.ok(document.querySelector('#scr-settings [data-form="group-edit"]'), 'открыта правка блока');
  // возврат к форме пункта: набранное на месте
  document.querySelector('#scr-settings [data-act="edit-open"]').click();
  assert.equal(document.getElementById('e-name').value, 'Умыться ХОЛОДНОЙ ВОДОЙ',
    'черновик формы пункта пережил открытие чужой формы');
});

test('З27/9.1: форма блока получила черновик', async () => {
  const { document } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('#scr-settings [data-act="group-add-open"]').click();
  document.getElementById('g-add').value = 'Вечер';
  // перерисовка по чужому поводу: тумблер пункта
  document.querySelector('#scr-settings input[data-act="toggle-active"]').click();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  assert.equal(document.getElementById('g-add').value, 'Вечер', 'имя нового блока не пропало');
});

test('З27/9.4: «Добавить блок» закрывает открытую правку блока', async () => {
  const { document } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('#scr-settings [data-act="group-open"]').click();
  assert.ok(document.querySelector('#scr-settings [data-form="group-edit"]'), 'правка раскрыта');
  document.querySelector('#scr-settings [data-act="group-add-open"]').click();
  assert.equal(document.querySelector('#scr-settings [data-form="group-edit"]'), null, 'правка закрыта');
  assert.ok(document.querySelector('#scr-settings [data-form="group-add"]'), 'открыта форма добавления');
});

test('З27/9.2: отказ формы объявляется постоянной областью, а не рождённым узлом', async () => {
  const { document } = await boot();
  const live = document.getElementById('live');
  assert.ok(live, 'постоянная область есть в разметке документа');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(live.getAttribute('role'), 'status');
  assert.ok(live.classList.contains('sr-only'), 'видимого дубля не создаёт');
  assert.equal(live.textContent, '');

  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('#scr-settings [data-act="edit-open"]').click();
  document.getElementById('e-name').value = '   ';
  document.querySelector('#scr-settings [data-act="edit-save"]').click();

  assert.equal(document.getElementById('live').textContent, 'Название не заполнено',
    'текст объявления — тот же, что видит зрячий');
  const kept = document.querySelector('#scr-settings .flash.keep');
  assert.ok(kept, 'видимая строка отказа на месте');
  assert.equal(kept.getAttribute('role'), null,
    'role="status" с рождённого узла снят: он всё равно не объявлялся');
  // следующее действие область чистит — повторный отказ снова читается как изменение
  document.querySelector('#scr-settings [data-act="edit-cancel"]').click();
  assert.equal(document.getElementById('live').textContent, '');
});

test('З27/8: «Подъём» порога-времени — линия по кратчайшей дуге, подпись по сырым', async () => {
  const seed = closedLadderSeed();
  const old = addKey(curMonday(), -70);
  seed.items.push({
    id: 'pr1', name: 'Отбой', value: null, unit: '', type: 'param', area: 'habit',
    pkind: 'time', pvalue: 1410, pstep: -15, goal: null, note: '', group: '', active: true,
    addedAt: old, raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null,
    history: [{ date: old, value: 0 }, { date: addKey(old, 30), value: 1425 }, { date: addKey(old, 60), value: 1410 }],
    formula: null, ladder: null, ladderLog: []
  });
  const { document } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="progress"]').click();
  const block = [...document.querySelectorAll('#scr-progress .rise-b')]
    .find(b => /Отбой/.test(b.textContent));
  assert.ok(block, 'блок «Подъёма» у порога есть');
  // подпись — словами владельца, по СЫРЫМ значениям
  assert.match(block.querySelector('.rise-v').textContent, /00:00 → 23:30/);
  // а линия не уходит на всю высоту холста: размах ряда — 30 минут, и
  // вертикали пути ложатся внутрь, а не от края до края
  // ...а линия показывает РАВНЫЕ шаги: два раза по 15 минут. На сырых
  // значениях (0 → 1425 → 1410) первый «шаг» занимал весь холст, а второй
  // становился неразличимым — отношение вертикалей 95:1
  const d = block.querySelector('path').getAttribute('d');
  const ys = [...d.matchAll(/[MV]\s?[\d.]*\s?([\d.]+)(?=[HV]|$)/g)];
  const vs = [...d.matchAll(/V([\d.]+)/g)].map(m => Number(m[1]));
  const start = Number(d.match(/^M[\d.]+ ([\d.]+)/)[1]);
  const seq = [start, ...vs];
  const steps = seq.slice(1).map((v, i) => Math.abs(v - seq[i])).filter(x => x > 0);
  assert.equal(steps.length, 2, 'две вертикали — два шага порога');
  const ratio = Math.max(...steps) / Math.min(...steps);
  assert.ok(ratio <= 2, `шаги по 15 минут читаются одинаково, отношение ${ratio.toFixed(1)}:1`);
});

/* Д4, первая половина: armFlash снимает узел ВИДИМОГО экрана. Выборка по
   всему документу брала первый в порядке секций index.html, то есть чужой
   со скрытого экрана: при reduced-motion свежее «Сохранено» оставалось на
   экране бессрочно, потому что таймер был взведён не на него. */
test('З27/4.1: armFlash взводит таймер на узел видимого экрана, а не первый в документе', async () => {
  const { document, window } = await boot({ timing: { FLASH_MS: 30 } });
  window.matchMedia = q => ({ matches: /reduced-motion/.test(q), media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

  document.querySelector('#tabs button[data-tab="settings"]').click();
  // «Заметки» идут в разметке РАНЬШЕ «Настроек»: кладём туда чужой узел уже
  // ПОСЛЕ перерисовки — иначе его снимет чистка скрытых экранов (п. 4.2)
  const stale = document.createElement('p');
  stale.className = 'flash';
  stale.textContent = 'чужое';
  document.getElementById('scr-notes').appendChild(stale);
  const fresh = document.createElement('p');
  fresh.className = 'flash';
  fresh.textContent = 'Сохранено';
  document.getElementById('scr-settings').appendChild(fresh);

  window.armFlash();
  await wait(90);
  assert.equal(fresh.isConnected, false, 'снят узел видимого экрана');
  assert.equal(stale.isConnected, true, 'чужой со скрытого не тронут — он не предмет');
});

/* Д4, вторая половина: keepInPlace действительно двигает скролл. В jsdom
   getBoundingClientRect отдаёт нули, поэтому геометрию подменяем — без неё
   путь проверялся только замером в браузере. */
test('З27/9.3: keepInPlace подгоняет скролл — узел встаёт туда, где стояла кнопка', async () => {
  const { document, window } = await boot();
  const calls = [];
  window.scrollTo = (x, y) => calls.push(y);
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => 1000 });

  // кнопка стояла на 400; перерисовка родила узел подтверждения на 460 —
  // скролл обязан уйти на те же 60, чтобы точка нажатия осталась на месте.
  // Геометрия подменяется: в jsdom getBoundingClientRect отдаёт нули, и
  // без подмены этот путь проверялся только замером в браузере
  const btn = { getBoundingClientRect: () => ({ top: 400 }) };
  const render = () => {
    const p = document.createElement('p');
    p.className = 'flash';
    p.textContent = 'Сохранено';
    p.getBoundingClientRect = () => ({ top: 460 });
    document.getElementById('scr-today').appendChild(p);
  };
  window.keepInPlace(btn, render);
  assert.deepEqual(calls, [1060], 'скролл ушёл ровно на смещение узла относительно кнопки');

  // узел на своём месте — трогать скролл незачем
  calls.length = 0;
  document.querySelectorAll('#scr-today .flash').forEach(n => n.remove());
  window.keepInPlace({ getBoundingClientRect: () => ({ top: 460 }) }, render);
  assert.deepEqual(calls, [], 'смещения нет — скролл не трогается');

  // узла подтверждения не родилось — тоже не трогается
  calls.length = 0;
  document.querySelectorAll('#scr-today .flash').forEach(n => n.remove());
  window.keepInPlace(btn, () => {});
  assert.deepEqual(calls, []);
});

/* 10.3. Умолчание свёртки снимается ОДИН РАЗ — при открытии разбора.
   Прежде reviewActionable() пересчитывался на каждой перерисовке, и
   последнее принятое решение само раскрывало картину недели под пальцем. */
test('З27/10.3: принятое решение не раскрывает свёртку недели само', async () => {
  const seed = dueSeed();
  const mon = prevMonday();
  // пункт нейтрален: 5 из 7 в каждой из трёх закрытых недель — ни повышения
  // (нужно ≥6), ни понижения (нужно ≤3). Иначе карточка планки осталась бы
  // действенной и свёртка была бы закрыта в обоих случаях — мутант выжил бы
  seed.days = {};
  for (let w = 1; w <= 3; w++) {
    for (let d = 0; d < 5; d++) seed.days[addKey(mon, -7 * (w - 1) + d)] = { it1: true };
  }
  seed.settings.calendarSince = addKey(mon, -35);
  seed.items[0].addedAt = addKey(mon, -35);
  // единственное действенное решение — нерешённый параметр
  seed.items.push({
    id: 'pp1', name: 'Отбой', value: null, unit: '', type: 'param', area: 'habit',
    pkind: 'time', pvalue: 1380, pstep: -15, goal: null, note: '', group: '', active: true,
    addedAt: addKey(mon, -70), raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null,
    history: [], formula: null, ladder: null, ladderLog: []
  });
  const { document } = await boot({ seed });
  document.querySelector('[data-act="goto-review"]').click();

  const fold = () => document.querySelector('#scr-review details.sect.week');
  assert.equal(fold().open, false, 'есть что решать — свёртка закрыта');
  assert.ok(document.querySelector('#scr-review [data-act="param-keep"]'), 'карточка параметра на месте');

  document.querySelector('#scr-review [data-act="param-keep"]').click();
  await wait(T.MOTION_MS + T.MOTION_TAIL_MS + 60); // карточка уходит переходом
  assert.equal(document.querySelector('#scr-review [data-act="param-keep"]'), null, 'решение принято');
  assert.equal(fold().open, false, 'свёртка НЕ раскрылась сама — умолчание снято при открытии');

  // а тап владельца по ней по-прежнему работает
  fold().querySelector('summary').click();
  assert.equal(fold().open, true);
});

/* 10.5. Копия из одних заметок не читается пустой. */
test('З27/10.5: строка копии считает и записи, а не только пункты и дни', async () => {
  const seed = dueSeed();
  seed.items = [];                       // ни одного пункта
  seed.days = {};                        // ни одной отметки
  seed.schemaVersion = 16;
  seed.settings.seed17 = true;            // пустой items не должен засеваться
  seed.settings.habitSeeded = true;
  seed.notes = [
    { id: 'n1', date: daysAgo(1), text: 'мысль', kind: 'note', source: '', updatedAt: 2 },
    { id: 'n2', date: daysAgo(2), text: 'выписка', kind: 'quote', source: 'Сенека', updatedAt: 1 }
  ];
  const { document } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('[data-act="wipe-open"]').click();
  document.querySelector('[data-act="wipe-do"]').click();
  document.querySelector('[data-act="wipe-do"]').click();
  document.querySelector('#tabs button[data-tab="settings"]').click();

  const line = [...document.querySelectorAll('#scr-settings .restore p')]
    .find(p => /В копии/.test(p.textContent));
  assert.ok(line, 'строка копии есть');
  assert.match(line.textContent, /2 записи/, 'копия из одних заметок не выглядит пустой');
  assert.match(line.textContent, /0 пунктов/);
});

/* Д7. Взведённое подтверждение не переживает возврат. */
test('З27/5.4: подтверждения гасятся возвратом — обмен не уничтожается одним тапом', async () => {
  const { document, window } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('[data-act="wipe-open"]').click();
  document.querySelector('[data-act="wipe-do"]').click();
  document.querySelector('[data-act="wipe-do"]').click();
  // после чистки состояние пустое — менять не на что, и копия при возврате
  // просто убирается. Наработаем отметку, чтобы обмен был настоящим
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('#scr-settings [data-act="add-open"]').click();
  document.getElementById('f-name').value = 'Новый после чистки';
  document.querySelector('#scr-settings [data-act="add-save"]').click();
  document.querySelector('#tabs button[data-tab="settings"]').click();

  document.querySelector('[data-act="wipe-drop"]').click(); // взвели «Убрать копию»
  assert.match(document.querySelector('[data-act="wipe-drop"]').textContent, /Подтвердить/);

  document.querySelector('[data-act="wipe-undo"]').click(); // возврат
  const drop = document.querySelector('[data-act="wipe-drop"]');
  assert.ok(drop, 'копия обменялась и по-прежнему есть');
  assert.doesNotMatch(drop.textContent, /Подтвердить/, 'подтверждение погашено возвратом');
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items.length, 9, 'практика вернулась');
});

/* ── Задача 28.A: страховка зеркала ───────────────────────────
   Две дыры, обе воспроизводились замером до правки: непарсящийся снапшот
   считался успехом и затирался в ТОЙ ЖЕ сессии; осторожность, взведённая
   неудачным чтением, жила ровно одну сессию, и следующий старт затирал
   подлинный снапшот, потому что зеркало при валидном localStorage не
   читалось вовсе. */

/* IndexedDB, у которого open не отвечает никогда: чтение упирается
   в таймаут MIRROR_PROBE_MS — исход 'failed'. */
const hungIdb = { open: () => ({}) };

test('З28A/1: непарсящийся снапшот не затирается, сырая строка отложена и видна', async () => {
  const idb = new IDBFactory();
  const brokenJson = '{"items":[{"id":"own1","name":"Умыться"';
  await idbPut(idb, { json: brokenJson, savedAt: 4242, schemaVersion: 16 });

  const { document, window } = await boot({ idb }); // localStorage пуст
  // приложение работает: снапшот не прочитан, значит дефолтная программа
  assert.equal(document.querySelectorAll('#scr-today input[data-act="mark"]').length, 6);

  // и в localStorage дефолт не записан: перезапуску оставлен шанс
  assert.equal(window.localStorage.getItem(NS), null, 'дефолт в localStorage не пишется');

  // снапшот НЕ затёрт — ни первым save(), ни дебаунсом
  await wait(T.MIRROR_FLUSH_MS + 40);
  assert.equal(await window.flushMirror(), false, 'зеркало в этой сессии не пишется');
  const snap = await idbGet(idb);
  assert.equal(snap.json, brokenJson, 'снапшот тот же, байт в байт');
  assert.equal(snap.savedAt, 4242);

  // сырая строка отложена СВОИМ ключом, рабочий ключ нечитаемого не занят
  const stash = JSON.parse(window.localStorage.getItem('minimum:data:mirror-corrupt'));
  assert.equal(stash.raw, brokenJson, 'сырая строка сохранена целиком');
  assert.equal(typeof stash.at, 'number', 'с датой');
  assert.equal(window.localStorage.getItem('minimum:data:corrupt'), null, 'ключ localStorage не тронут');

  // и она видна в «Данных» тем же способом, что нечитаемый localStorage
  openData(document);
  const txt = document.getElementById('scr-settings').textContent;
  assert.match(txt, /Резервная копия оказалась нечитаемой от /, 'строка с датой');
  assert.ok(document.querySelector('[data-act="corrupt-save"][data-src="mirror"]'), 'кнопка «Скачать»');
});

test('З28A/1.3: нечитаемая копия скачивается и убирается вторым тапом вместе со снапшотом', async () => {
  const idb = new IDBFactory();
  await idbPut(idb, { json: '{обрыв', savedAt: 1, schemaVersion: 16 });
  const { document, window } = await boot({ idb });
  openData(document);

  // «Скачать» отдаёт сырую строку, а не разобранный store
  let given = null;
  window.URL.createObjectURL = (blob) => { given = blob; return 'blob:fake'; };
  document.querySelector('[data-act="corrupt-save"][data-src="mirror"]').click();
  assert.ok(given, 'скачивание запущено');

  // «Убрать» — вторым тапом
  const drop = () => document.querySelector('[data-act="corrupt-drop"][data-src="mirror"]');
  drop().click();
  assert.match(drop().textContent, /Подтвердить: убрать/, 'первый тап только взводит');
  assert.ok(window.localStorage.getItem('minimum:data:mirror-corrupt'), 'ключ ещё на месте');

  drop().click();
  assert.equal(window.localStorage.getItem('minimum:data:mirror-corrupt'), null, 'ключ убран');
  assert.equal(drop(), null, 'строка исчезла');
  // и сам нечитаемый снапшот снят: иначе следующий старт упёрся бы в него снова
  for (let i = 0; i < 100 && await idbGet(idb); i++) await wait(10);
  assert.equal(await idbGet(idb), null, 'снапшот снят вместе со строкой');
});

test('З28A/1.1: два нечитаемых источника разом не затирают друг друга', async () => {
  const idb = new IDBFactory();
  await idbPut(idb, { json: '{снапшот оборван', savedAt: 1, schemaVersion: 16 });
  // localStorage тоже нечитаем: load() пишет свой ключ ПЕРВЫМ
  const { document, window } = await boot({ idb, raw: '{битый json' });

  assert.equal(JSON.parse(window.localStorage.getItem('minimum:data:corrupt')).raw, '{битый json');
  assert.equal(JSON.parse(window.localStorage.getItem('minimum:data:mirror-corrupt')).raw, '{снапшот оборван');

  openData(document);
  const txt = document.getElementById('scr-settings').textContent;
  assert.match(txt, /Найдены нечитаемые данные/, 'строка рабочего ключа');
  assert.match(txt, /Резервная копия оказалась нечитаемой/, 'строка зеркала');
  assert.equal(document.querySelectorAll('[data-act="corrupt-drop"]').length, 2, 'две независимые строки');
});

test('З28A/2: осторожность переживает перезапуск — подлинный снапшот цел, подмены нет', async () => {
  const real = new IDBFactory();
  await idbPut(real, { json: JSON.stringify(mirrorStore()), savedAt: 4242, schemaVersion: 4 });

  // сессия 1: зеркало не дочиталось, localStorage остался пустым (прежний guard)
  const a = await boot({ idb: hungIdb });
  a.document.querySelector('#tabs button[data-tab="settings"]').click();
  assert.equal(a.document.getElementById('mirror-note').textContent, 'Резервная копия не проверена');
  a.document.querySelector('#tabs button[data-tab="today"]').click();
  a.document.querySelector('#scr-today input[data-act="mark"]').click(); // первая отметка владельца
  const carried = a.window.localStorage.getItem(NS);
  assert.ok(carried, 'отметка записана — localStorage больше не пуст');
  assert.equal(JSON.parse(carried).items.length, 9, 'в нём посевная программа, а не практика');

  // сессия 2: localStorage валиден, IndexedDB снова отвечает
  const b = await boot({ raw: carried, idb: real });
  await wait(T.MIRROR_FLUSH_MS + 40);
  await b.window.flushMirror();

  const snap = await idbGet(real);
  assert.equal(snap.savedAt, 4242, 'подлинный снапшот НЕ затёрт');
  assert.equal(JSON.parse(snap.json).items[0].name, 'Восстановленный');

  // автоматической подмены не произошло: на экране рабочая копия
  assert.equal(b.document.querySelectorAll('#scr-today input[data-act="mark"]').length, 6);
  assert.equal(JSON.parse(b.window.localStorage.getItem(NS)).items.length, 9);

  // предложение показано, с датой и числами
  openData(b.document);
  const txt = b.document.getElementById('scr-settings').textContent;
  assert.match(txt, /Резервная копия .* отличается от рабочей/);
  assert.match(txt, /1 пункт, 1 день отметок/);
  assert.ok(b.document.querySelector('[data-act="mirror-restore"]'), 'кнопка восстановления');
  assert.ok(b.document.querySelector('[data-act="mirror-keep"]'), 'кнопка «Оставить рабочую»');
  // второй строки про ту же копию нет: о ней говорит блок
  assert.equal(b.document.getElementById('mirror-note').hidden, true);
});

test('З28A/2.2: «Восстановить» — вторым тапом, обменной копией, с откатом', async () => {
  const real = new IDBFactory();
  await idbPut(real, { json: JSON.stringify(mirrorStore()), savedAt: 4242, schemaVersion: 4 });
  const seed = trainSeed();
  seed.days = { [daysAgo(0)]: { it1: true } };
  const { document, window } = await boot({ seed, idb: real });

  openData(document);
  const btn = () => document.querySelector('[data-act="mirror-restore"]');
  assert.ok(btn(), 'предложение стоит');
  btn().click();
  assert.match(btn().textContent, /Подтвердить: восстановить/, 'первый тап только взводит');
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items[0].name, seed.items[0].name, 'данные ещё прежние');

  btn().click();
  const now = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(now.items.length, 1);
  assert.equal(now.items[0].name, 'Восстановленный', 'состояние подменено на копию');
  // renderAll рисует одну текущую вкладку; «Сегодня» перерисуется при переходе
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.match(document.getElementById('scr-today').textContent, /Восстановленный/);

  // прежнее состояние легло в обменную копию — восстановление обратимо
  openData(document);
  assert.match(document.getElementById('scr-settings').textContent, /до восстановления из резервной копии/);
  document.querySelector('[data-act="wipe-undo"]').click();
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items[0].name, seed.items[0].name, 'вернулось прежнее');

  // предложение снято: решение принято, второй раз его не задают
  openData(document);
  assert.equal(document.querySelector('[data-act="mirror-restore"]'), null);
});

test('З28A/2.2: «Оставить рабочую» — вторым тапом, после неё зеркало снова пишется', async () => {
  const real = new IDBFactory();
  await idbPut(real, { json: JSON.stringify(mirrorStore()), savedAt: 4242, schemaVersion: 4 });
  const seed = trainSeed();
  const { document, window } = await boot({ seed, idb: real });

  openData(document);
  const keep = () => document.querySelector('[data-act="mirror-keep"]');
  keep().click();
  assert.match(keep().textContent, /Подтвердить: оставить рабочую/);
  assert.equal((await idbGet(real)).savedAt, 4242, 'снапшот ещё не тронут');

  keep().click();
  assert.equal(document.querySelector('[data-act="mirror-keep"]'), null, 'предложение снято');
  await window.flushMirror();
  const snap = await idbGet(real);
  assert.notEqual(snap.savedAt, 4242, 'зеркало снова ведётся');
  assert.equal(JSON.parse(snap.json).items[0].name, seed.items[0].name, 'в нём рабочая копия');
});

test('З28A/2.2: «Скачать» отдаёт копию файлом до того, как её заменят', async () => {
  const real = new IDBFactory();
  await idbPut(real, { json: JSON.stringify(mirrorStore()), savedAt: 4242, schemaVersion: 4 });
  const { document, window } = await boot({ seed: trainSeed(), idb: real });
  openData(document);
  let given = null;
  window.URL.createObjectURL = (blob) => { given = blob; return 'blob:fake'; };
  document.querySelector('[data-act="mirror-save"]').click();
  assert.ok(given, 'скачивание запущено');
});

test('З28A/2.1: зеркало сверяется и при валидном localStorage, отказ виден строкой', async () => {
  const { document } = await boot({ seed: trainSeed(), idb: hungIdb });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const note = document.getElementById('mirror-note');
  assert.equal(note.hidden, false, 'прежде при валидном localStorage зеркало не читалось вовсе');
  assert.equal(note.textContent, 'Резервная копия не проверена');
});

test('З28A/2.1: совпадающее зеркало предложения не рождает и продолжает вестись', async () => {
  const real = new IDBFactory();
  const seed = trainSeed();
  await idbPut(real, { json: JSON.stringify(seed), savedAt: 4242, schemaVersion: SCHEMA_VERSION });
  const { document, window } = await boot({ seed, idb: real });
  openData(document);
  assert.equal(document.querySelector('[data-act="mirror-restore"]'), null, 'предложения нет');
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector('#scr-today input[data-act="mark"]').click();
  await window.flushMirror();
  const snap = await idbGet(real);
  assert.notEqual(snap.savedAt, 4242, 'зеркало ведётся как прежде');
});

test('З28A/3: чистка в непроверенной сессии выполняется и говорит об этом', async () => {
  const seed = trainSeed();
  seed.days = { [daysAgo(0)]: { it1: true } };
  const { document, window } = await boot({ seed, idb: hungIdb });

  openData(document);
  document.querySelector('[data-act="wipe-open"]').click();
  const danger = () => document.querySelector('#scr-settings .danger');
  assert.match(danger().textContent, /Резервная копия сейчас недоступна/,
    'последствие названо ДО второго тапа');

  document.querySelector('[data-act="wipe-do"]').click();
  document.querySelector('[data-act="wipe-do"]').click();
  const after = JSON.parse(window.localStorage.getItem(NS));
  assert.deepEqual(after.items, [], 'чистка выполнена, а не отклонена');
  assert.ok(window.localStorage.getItem(NS + ':wiped'), 'копия на месте — возврат возможен');
});

test('З28A/5.3: три прежних исхода стартового чтения ведут себя как прежде', async () => {
  // 'empty' — база открылась, ключа нет: дефолт уезжает в зеркало
  const empty = new IDBFactory();
  const a = await boot({ idb: empty });
  await a.window.flushMirror();
  assert.equal(JSON.parse((await idbGet(empty)).json).items.length, 9);

  // 'read' — снапшот прочитан: тихое восстановление при пустом localStorage
  const full = new IDBFactory();
  await idbPut(full, { json: JSON.stringify(mirrorStore()), savedAt: 111, schemaVersion: 4 });
  const b = await boot({ idb: full });
  assert.match(b.document.getElementById('scr-today').textContent, /Восстановленный/);

  // 'failed' — не дочитали: не пишем ни в зеркало, ни в localStorage
  const c = await boot({ idb: hungIdb });
  assert.equal(c.window.localStorage.getItem(NS), null);
  assert.equal(await c.window.flushMirror(), false);
});

/* ── Задача 28.B: мёртвое и тихое ─────────────────────────────── */

/* 8.1. Скачок под пальцем. jsdom лэйаут не считает, поэтому проверяется
   правило, а не пиксели: строчный бокс подписи задан в CSS длиной, значит
   от исчезновения крупного <b> не зависит. Пиксели замерены в браузере. */
test('З28B/1: строчный бокс подписи планки задан длиной и от <b> не зависит', async () => {
  const rule = (CSS_SRC().match(/\.bar-note\s*\{[^}]*\}/s) || [''])[0];
  // высота задана ЖЁСТКО: одного line-height мало — строчный бокс с
  // 22-пиксельным глифом выше, чем без него, при том же интерлиньяже
  // (замер: остаточные 2 px). Блок обязан отдавать в раскладку константу
  assert.match(rule, /height:\s*\d+px/, '.bar-note несёт фиксированную высоту');
  assert.match(rule, /line-height:\s*\d+px/, 'и интерлиньяж в пикселях');
  // числовой (наследуемый) он быть не может: в <b> пересчитался бы от 22px
  assert.doesNotMatch(rule, /line-height:\s*[\d.]+;/, 'не безразмерный: он наследуется в <b>');
  // новой ступени кегля не заведено — высота и интерлиньяж кеглем не являются
  assert.doesNotMatch(rule, /font-size:\s*\d+px/, 'кегль остался токеном');
});

test('З28B/1.1: закрытие дня не меняет высоту подписи и не двигает список', async () => {
  const { document } = await boot();
  const note = () => document.querySelector('#scr-today .bar-note');
  const boxes = [...document.querySelectorAll('#scr-today input[data-act="mark"]')];
  boxes.slice(0, boxes.length - 1).forEach(b => b.click());
  const before = note().outerHTML;
  assert.match(before, /<b>/, 'до закрытия в подписи крупное число');
  boxes[boxes.length - 1].click();
  assert.doesNotMatch(note().outerHTML, /<b>/, 'после закрытия числа нет');
  assert.match(note().textContent, /День закрыт/);
  // высота держится правилом CSS, а не разметкой: узел тот же, класс добавлен
  assert.ok(note().classList.contains('ok'));
});

test('З28B/1.3: «Привычки» лечатся тем же правилом — своей подписи у них нет', async () => {
  // один и тот же селектор .bar-note обслуживает оба дневных экрана
  assert.equal((CSS_SRC().match(/\.bar-note\s*\{/g) || []).length, 1, 'правило одно на оба экрана');
  const { document } = await boot();
  document.querySelector('#tabs button[data-tab="habits"]').click();
  const note = document.querySelector('#scr-habits .bar-note');
  assert.ok(note, 'у «Привычек» та же подпись того же класса');
  document.querySelectorAll('#scr-habits input[data-act="mark"]').forEach(b => b.click());
  assert.doesNotMatch(note.outerHTML, /<b>/, 'и та же болезнь была бы без правила');
});

/* 8.2. Мёртвая ветка снята. Утверждение о НЕДОСТИЖИМОМ коде поведением не
   проверяется по определению: восстановленная ветка ничего не меняет, и
   поведенческий тест её не увидит (мутант 28B-2 без этого теста выживает).
   Поэтому сторож здесь исходный — того же рода, что счёт градиентов и
   разрешённых кеглей в CSS. */
test('З28B/2: в updateWeekCount не осталось ветки создания кнопки', () => {
  const fn = (APP.match(/function updateWeekCount\([\s\S]*?\n\}/) || [''])[0];
  assert.ok(fn, 'функция найдена');
  assert.doesNotMatch(fn, /createElement/, 'кнопка не создаётся: ветка была недостижима');
  assert.match(fn, /if \(!n && hasUndo\) next\.remove\(\);/, 'осталась одна ветка — снятие');
  assert.doesNotMatch(fn, /else if/, 'условие соседней ветки схлопнуто');
});

/* 8.2. Оставшиеся пути живы. */
test('З28B/2: счётчик тренировок — «отменить последний» снимается на нуле', async () => {
  const seed = trainSeed();
  const { document, window } = await boot({ seed });
  const plus = () => document.querySelector('#scr-today [data-act="train-inc"]');
  const undo = () => document.querySelector('#scr-today [data-act="train-undo"]');
  const num = () => document.querySelector('#scr-today .wnum b').textContent;

  plus().click();
  document.querySelector('[data-act="train-save"]').click();
  assert.equal(num(), '1');
  assert.ok(undo(), 'кнопка отмены есть при счёте 1');

  undo().click();                       // счёт 1 → 0: ветка удаления
  assert.equal(num(), '0');
  assert.equal(undo(), null, 'на нуле кнопка снята');
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).weekLog.length, 0);

  // и обратно: счёт снова растёт, кнопка возвращается ПЕРЕРИСОВКОЙ
  plus().click();
  document.querySelector('[data-act="train-save"]').click();
  assert.equal(num(), '1');
  assert.ok(undo(), 'кнопка вернулась');
});

/* 8.3. Фокус возвращается на кнопку ВИДИМОГО экрана. */
test('З28B/3: разбор, открытый с «Прогресса», возвращает фокус на его баннер', async () => {
  const { document } = await boot({ seed: dueSeed() });
  // сначала побывать на «Сегодня», чтобы его разметка с таким же баннером осталась
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.ok(document.querySelector('#scr-today [data-act="goto-review"]'), 'баннер на «Сегодня»');
  document.querySelector('#tabs button[data-tab="progress"]').click();
  document.querySelector('#scr-progress [data-act="goto-review"]').click();
  assert.equal(document.getElementById('scr-review').hidden, false);

  document.querySelector('[data-act="review-done"]').click();
  const af = document.activeElement;
  assert.equal(af.dataset.act, 'goto-review', 'фокус на кнопке-источнике');
  const scr = af.closest('section.screen');
  assert.equal(scr.id, 'scr-progress', 'и это баннер «Прогресса», а не «Сегодня»');
  assert.equal(scr.hidden, false, 'экран фокуса виден');
  assert.notEqual(af, document.body);
});

test('З28B/3: лист тренировки возвращает фокус на «+» видимого экрана', async () => {
  const { document } = await boot({ seed: trainSeed() });
  document.querySelector('#scr-today [data-act="train-inc"]').click();
  document.querySelector('[data-act="train-cancel"]').click();
  const af = document.activeElement;
  assert.equal(af.dataset.act, 'train-inc');
  assert.equal(af.closest('section.screen').hidden, false);
});

/* 8.4. Формы «Настроек»: общий вид по всем сочетаниям. */
const SETTINGS_FORMS = [
  { key: 'пункт-правка', act: 'edit-open', field: 'e-name' },
  { key: 'пункт-добавить', act: 'add-open', field: 'f-name' },
  { key: 'блок-правка', act: 'group-open', field: 'g-name' },
  { key: 'блок-добавить', act: 'group-add-open', field: 'g-add' },
  { key: 'упр-правка', act: 'ex-open', field: 'x-name' },
  { key: 'упр-добавить', act: 'ex-add-open', field: 'x-add-name' }
];

function openAllSettingsSections(document) {
  for (const re of [/Блоки/, /Пункты/, /Упражнения/]) {
    const s = [...document.querySelectorAll('#scr-settings details.sect')]
      .find(x => re.test(x.querySelector('summary').textContent));
    if (s && !s.open) s.querySelector('summary').click();
  }
}

test('З28B/4: на «Настройках» форма одна, и черновик прежней цел — все 30 сочетаний', async () => {
  const seed = trainSeed();
  seed.groups = [{ name: 'Утро' }];
  seed.items[0].group = 'Утро';
  seed.exercises = [{ id: 'x1', name: 'Отжимания', unit: 'раз', value: 10, history: [], active: true, addedAt: daysAgo(30) }];
  let пар = 0;
  for (const a of SETTINGS_FORMS) {
    for (const b of SETTINGS_FORMS) {
      if (a.key === b.key) continue;
      пар++;
      const { document } = await boot({ seed });
      document.querySelector('#tabs button[data-tab="settings"]').click();
      openAllSettingsSections(document);
      document.querySelector(`#scr-settings [data-act="${a.act}"]`).click();
      const inp = document.getElementById(a.field);
      assert.ok(inp, `${a.key}: форма открыта`);
      inp.value = 'ЧЕРНОВИК';
      document.querySelector(`#scr-settings [data-act="${b.act}"]`).click();
      const forms = [...document.querySelectorAll('#scr-settings [data-form]')];
      assert.equal(forms.length, 1, `${a.key} → ${b.key}: на экране одна форма`);
      assert.equal(document.getElementById(a.field), null, `${a.key} → ${b.key}: первая закрыта`);
      // возврат к первой: набранное на месте
      document.querySelector(`#scr-settings [data-act="${a.act}"]`).click();
      assert.equal(document.getElementById(a.field).value, 'ЧЕРНОВИК',
        `${a.key} → ${b.key}: черновик первой формы цел`);
    }
  }
  assert.equal(пар, 30, 'проверены все сочетания');
});

test('З28B/4: «Отмена» черновик отбрасывает, а не прячет', async () => {
  const { document } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('#scr-settings [data-act="edit-open"]').click();
  const was = document.getElementById('e-name').value;
  document.getElementById('e-name').value = 'ОТМЕНЁННОЕ';
  document.querySelector('#scr-settings [data-act="edit-cancel"]').click();
  document.querySelector('#scr-settings [data-act="edit-open"]').click();
  assert.equal(document.getElementById('e-name').value, was,
    'после «Отмены» возвращается сохранённое значение, а не отменённый черновик');
});

/* 8.6. Закрытие недели — вторым тапом. */
test('З28B/6: «Закрыть неделю» — первый тап взводит, второй закрывает', async () => {
  const { document, window } = await boot({ seed: dueSeed() });
  openReview(document);
  const btn = () => document.querySelector('[data-act="close-week"]');
  assert.equal(btn().textContent, 'Закрыть неделю');

  btn().click();
  assert.match(btn().textContent, /Подтвердить: закрыть неделю/, 'первый тап только взводит');
  assert.match(document.getElementById('scr-review').textContent, /Неделя уйдёт в архив/,
    'последствие названо между тапами');
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).reviews.length, 0, 'срез ещё не записан');

  btn().click();
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).reviews.length, 1, 'второй тап закрывает');
});

test('З28B/6.3: взведённое закрытие недели гаснет уходом с листа', async () => {
  const { document, window } = await boot({ seed: dueSeed() });
  openReview(document);
  document.querySelector('[data-act="close-week"]').click();
  assert.match(document.querySelector('[data-act="close-week"]').textContent, /Подтвердить/);

  document.querySelector('#tabs button[data-tab="progress"]').click(); // уход таб-баром
  openReview(document);
  assert.equal(document.querySelector('[data-act="close-week"]').textContent, 'Закрыть неделю',
    'подтверждение не пережило ухода');
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).reviews.length, 0, 'ничего не записано');
});
