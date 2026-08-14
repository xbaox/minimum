'use strict';
/* Дымовые DOM-тесты в jsdom.
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

/* Уход карточки разбора отложен (motionLeave: класс-триггер + перерисовка
   по fallback-таймауту MOTION_MS+60, т.к. jsdom не шлёт transitionend).
   Ждём дольше таймаута (12.1: MOTION_MS = 240), чтобы дождаться перерисовки. */
const settle = () => new Promise(r => setTimeout(r, 400));

/* app.js взводит таймер границы дня — окна нужно закрывать, иначе
   процесс node --test не завершится из-за живого setTimeout */
const doms = [];
after(() => { for (const d of doms) d.window.close(); });

async function boot({ seed, raw, idb } = {}) {
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
  if (idb) window.indexedDB = idb; // fake-indexeddb: app.js увидит его через window
  if (raw != null) window.localStorage.setItem(NS, raw);
  else if (seed) window.localStorage.setItem(NS, JSON.stringify(seed));
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

  closeBtn.click();

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
  assert.equal(window.localStorage.getItem('minimum:data:corrupt'), '{битый json');
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

test('вредоносный count в reviews не ломает разбор: подстановка экранируется', async () => {
  const seed = dueSeed();
  seed.reviews = [{
    closedAt: 1, week: addKey(prevMonday(), -28), keys: [addKey(prevMonday(), -28)],
    perItem: { it1: { name: 'Тестовый пункт', marks: [], count: '<img src=x onerror="window.__x=1">' } },
    trainings: {}, oneChange: '', raises: []
  }];
  const { document, window } = await boot({ seed });
  openReview(document);
  const scr = document.getElementById('scr-review');
  assert.ok(scr.innerHTML.length > 0);
  assert.equal(scr.querySelector('img'), null); // разметка не материализовалась
  assert.equal(window.__x, undefined);
  assert.match(scr.textContent, /<img src=x/); // показана как текст
});

test('правка значения: невалид сохраняет старое, пустое — осознанная очистка без истории', async () => {
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

  // невалидный ввод — значение и история не меняются
  openEdit('Правка');
  document.getElementById('e-value').value = '1о';
  document.querySelector('[data-act="edit-save"]').click();
  assert.equal(savedItem('Правка').value, 12);
  assert.equal(savedItem('Правка').history.length, 2);

  // пустое поле — осознанная очистка: значение null, история не растёт, «Планка:» скрыта
  openEdit('Правка');
  document.getElementById('e-value').value = '';
  document.querySelector('[data-act="edit-save"]').click();
  assert.equal(savedItem('Правка').value, null);
  assert.equal(savedItem('Правка').history.length, 2);
  assert.doesNotMatch(document.getElementById('scr-settings').textContent, /Планка:/);

  // цель weekly: пустое и невалидное поле сохраняют старую цель, валидное — меняет
  openEdit('Недельный');
  document.getElementById('e-goal').value = '';
  document.querySelector('[data-act="edit-save"]').click();
  assert.equal(savedItem('Недельный').goal, 3);
  openEdit('Недельный');
  document.getElementById('e-goal').value = '0';
  document.querySelector('[data-act="edit-save"]').click();
  assert.equal(savedItem('Недельный').goal, 3);
  openEdit('Недельный');
  document.getElementById('e-goal').value = '5';
  document.querySelector('[data-act="edit-save"]').click();
  assert.equal(savedItem('Недельный').goal, 5);
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
  seed.days = {}; // вчера не отмечено — у пункта есть точка-маркер
  const { document, window } = await boot({ seed });
  const dot = document.querySelector('[data-act="miss-note"]');
  assert.ok(dot, 'точка-маркер есть');
  dot.click();
  assert.ok(document.querySelector('.miss-note'), 'подпись раскрыта');

  document.querySelector('#tabs button[data-tab="progress"]').click();
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.equal(document.querySelector('.miss-note'), null); // missOpen очищен
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
  seed.days = {}; // вчера не отмечено — у обоих пунктов есть точка-маркер
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
  assert.ok(document.querySelector('.miss-note'));
  after.click();
  after = dots().find(d => d.dataset.id === 'it2');
  assert.equal(after.getAttribute('aria-expanded'), 'false');
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
  seed.days = {}; // вчера не отмечено — есть точка
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
  seed.days = {};
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

  document.querySelector('[data-act="close-week"]').click();
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
  document.querySelector('[data-act="close-week"]').click();
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
  a.document.querySelector('[data-act="close-week"]').click();
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
  c.document.querySelector('[data-act="close-week"]').click();
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
  assert.match(document.getElementById('scr-habits').textContent, /Привычек пока нет — добавить можно в «Пунктах»/);
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
  // две прошлые недели с идеальной привычкой — строка готовности
  const wk = (week) => ({ closedAt: 1, week, keys: [week], perItem: { h1: { count: 7 } }, trainings: {}, oneChange: '', raises: [] });
  seed.reviews = [wk(addKey(prev, -21)), wk(addKey(prev, -14))];
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
  document.querySelector('[data-act="close-week"]').click();
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
  document.querySelector('[data-act="close-week"]').click();
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
  const addHabit = [...document.querySelectorAll('[data-act="add-open"]')].find(b => b.dataset.area === 'habit');
  addHabit.click();
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
  a.document.querySelector('[data-act="close-week"]').click();
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
  const wk = (week, c) => ({ closedAt: 1, week, keys: [week], perItem: { h1: { count: c } }, trainings: {}, oneChange: '', raises: [], params: [] });
  seed.reviews = [wk(addKey(prevMonday(), -21), 5), wk(addKey(prevMonday(), -14), 6)]; // 5 и 6 при норме 5
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
  assert.equal(snap.schemaVersion, 14);
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
  assert.equal(window.localStorage.getItem('minimum:data:corrupt'), '{битый json');
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
  const { document, window } = await boot({ idb });
  document.querySelector('input[data-act="mark"]').click(); // дебаунс 500 мс ещё не истёк
  window.dispatchEvent(new window.Event('pagehide'));
  await new Promise(r => setTimeout(r, 50)); // много меньше дебаунса
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
  assert.equal(saved.schemaVersion, 14);                    // migrate прогнан
  assert.equal(saved.reviews[0].weekStart, daysAgo(20));   // backfill v2→v3
  assert.equal(saved.settings.exportedAt, null);           // мягкий дефолт v3→v4
});

test('уход в фон (visibilitychange→hidden) сбрасывает зеркало немедленно', async () => {
  const idb = new IDBFactory();
  const { document, window } = await boot({ idb });
  document.querySelector('input[data-act="mark"]').click(); // дебаунс ещё не истёк
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  window.document.dispatchEvent(new window.Event('visibilitychange'));
  await new Promise(r => setTimeout(r, 50)); // много меньше дебаунса
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
  assert.match(document.getElementById('scr-settings').textContent, /Последний экспорт:/);
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
  assert.match(d.textContent, /Две полные недели нормы ещё не набраны/);
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
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).schemaVersion, 14);
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

  // пустое имя не сохраняется
  rowOf('Ночь').querySelector('[data-act="group-open"]').click();
  document.getElementById('g-name').value = '   ';
  document.querySelector('[data-act="group-save"]').click();
  assert.ok(saved().groups.find(g => g.name === 'Ночь'));

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

  document.querySelector('input[data-act="mark"]').click(); // save падает, экран перерисовывается
  assert.match(document.getElementById('scr-today').textContent, /Хранилище недоступно/);

  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => realLS });
  document.querySelector('input[data-act="mark"]').click(); // успешный save снимает флаг
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
  assert.match(scr.textContent, /Один пропуск в неделю не обнуляет\. Два подряд — начинают заново\./);

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
  // параметр недели: он живёт внутри свёртки и даёт действие, перерисовывающее разбор
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
  assert.equal(fold.hasAttribute('open'), false, 'по умолчанию закрыта');
  assert.match(fold.querySelector('summary').textContent, /Показать неделю/);
  assert.ok(fold.querySelector('.grid'), 'сетка галочек внутри свёртки');
  assert.equal(scr.querySelector(':scope > .grid'), null, 'снаружи сетки нет');
  // параметры и готовность к привычке остались внутри свёртки
  assert.ok(fold.querySelector('[data-act="param-step"]'), 'карточка параметра внутри');

  // решения без предложений — тихие строки, а не пустота
  assert.match(scr.textContent, /Планка держится, менять нечего/);
  assert.match(scr.textContent, /Лестницы сейчас нет/);
  assert.ok(scr.querySelector('input[data-bind="one-change"]'));

  // свёртка запоминается: перерисовка разбора её не захлопывает
  fold.querySelector('summary').click();
  document.querySelector('[data-act="param-keep"]').click();
  await settle();
  assert.equal(document.querySelector('details.sect.week').hasAttribute('open'), true);
});

test('разбор: карточка «Сделать легче» — шаг применяется, «Оставить» гасит предложение', async () => {
  const seed = dueSeed();
  seed.items[0].value = 20;
  seed.items[0].history = [{ date: addKey(prevMonday(), -14), value: 20 }];
  seed.days = {}; // две закрытые недели без отметок — планка не держится
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
  const sect = () => [...document.querySelectorAll('#scr-settings details.sect')][2];
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

const hold = () => new Promise(r => setTimeout(r, 320)); // дольше DRAG_HOLD

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
  const SIZES = new Set(['var(--text-base)', 'var(--text-sm)', 'var(--text-xs)',
    '10px', '11px', '12px', '13px', '14px', '15px', '16px', '17px', '18px', '20px', '22px', '24px', '32px']);
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
  assert.match(prog.textContent, /Первые отметки появятся здесь\./);
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
  assert.match(line.textContent, /Стёрто .* · 2 пункта, 1 день отметок/);

  document.querySelector('[data-act="wipe-undo"]').click();
  assert.deepEqual(saved(), before, 'состояние вернулось побайтово');
  assert.equal(window.localStorage.getItem(NS + ':wiped'), null, 'копия убрана возвратом');
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
  assert.equal(prog.querySelectorAll('.cdays i.pre').length + prog.querySelectorAll('.cdays i.fut').length, 56,
    'вся цепь — до эпохи либо в будущем');
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
  const streak = scr.querySelectorAll('.stat')[1];
  assert.match(streak.textContent, /^1 день$/);
  assert.match(scr.querySelector('.rec').textContent, /^рекорд 1 день$/);

  // полоса дня: заполнение — доля сегодняшнего дня, подпись под ней
  const fill = scr.querySelector('.dbar i');
  assert.equal(fill.style.width, '100%');
  assert.equal(scr.querySelector('.dbar-note').textContent.trim(), 'День закрыт');
  assert.equal(scr.querySelector('.dbar').getAttribute('aria-hidden'), 'true');

  assert.match(scr.textContent, /Один пропуск в неделю не обнуляет\./);
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
  const plain = cells.filter(c => c.className === 'cd');
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

test('«Настройки» 17: начало отсчёта — понедельник недели, будущее не принимается', async () => {
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
  assert.match(document.getElementById('scr-settings').textContent,
    /Меняет счёт дней в системе, серию и доступность разбора\. Отметки не затрагивает\./);

  // середина недели приводится к понедельнику своей недели
  const wed = daysAgo(9);
  set(wed);
  assert.equal(saved().settings.calendarSince, mondayOf(wed));
  assert.equal(field().value, mondayOf(wed), 'поле показывает принятое значение');

  // будущая дата и мусор не принимаются
  const before = saved().settings.calendarSince;
  set(addKey(daysAgo(0), 7));
  assert.equal(saved().settings.calendarSince, before);
  set('не дата');
  assert.equal(saved().settings.calendarSince, before);
  assert.equal(field().value, before);

  // смена пересчитывает «в системе» и серию
  openProgress(document);
  const days = [...document.querySelectorAll('#scr-progress .stat')][0].textContent;
  assert.match(days, new RegExp('^' + (Math.round((new Date(daysAgo(0)) - new Date(before)) / 86400000) + 1) + ' '));
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
