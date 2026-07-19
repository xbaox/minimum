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
  for (const id of ['scr-habits', 'scr-review', 'scr-items', 'scr-system']) {
    assert.equal(document.getElementById(id).hidden, true, id);
  }
});

test('вкладки переключают все 5 экранов, каждый рендерится без исключений', async () => {
  const { document } = await boot();
  const tabs = [...document.querySelectorAll('#tabs button')];
  assert.equal(tabs.length, 5);
  assert.deepEqual(tabs.map(b => b.dataset.tab), ['today', 'habits', 'system', 'review', 'items']); // порядок вкладок
  const map = { today: 'scr-today', habits: 'scr-habits', review: 'scr-review', items: 'scr-items', system: 'scr-system' };
  const marker = {
    today: /Минимум выполняется/,
    habits: /Не спеши — доверься накопительному эффекту/,
    review: /Разбор недели/,
    items: /Граница дня/,
    system: /Пять правил/
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
  document.querySelector('#tabs button[data-tab="items"]').click();

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

  assert.match(document.getElementById('scr-review').textContent, /Неделя закрыта/);
  // «Неделя закрыта.» показывается ровно один раз — повторный рендер её не содержит
  document.querySelector('#tabs button[data-tab="review"]').click();
  assert.doesNotMatch(document.getElementById('scr-review').textContent, /Неделя закрыта/);
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.reviews.length, 1);
  assert.equal(saved.reviews[0].perItem.it1.count, 2);
  assert.equal(saved.reviews[0].week, prevMonday()); // понедельник разобранной недели
  assert.deepEqual(saved.weekLog, []);
  assert.equal(saved.weekStart, prevMonday()); // историческое поле не тронуто
  // подписи колонок — дни недели
  assert.match(document.getElementById('scr-review').textContent, /Разбор откроется в понедельник|Календарные недели начнутся/);
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

  document.querySelector('#tabs button[data-tab="items"]').click();
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
  assert.match(document.getElementById('scr-items').textContent, /Импортировано: 2 пункта, 1 день/);

  // строка исчезает при следующем действии — даже если оно само не перерисовывает экран
  document.querySelector('[data-act="import"]').click();
  assert.doesNotMatch(document.getElementById('scr-items').textContent, /Импортировано/);

  // все 5 экранов рендерятся без исключений
  const map = { today: 'scr-today', habits: 'scr-habits', review: 'scr-review', items: 'scr-items', system: 'scr-system' };
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
  document.querySelector('#tabs button[data-tab="review"]').click();
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
  document.querySelector('#tabs button[data-tab="items"]').click();
  const openEdit = name => [...document.querySelectorAll('[data-act="edit-open"]')]
    .find(b => b.querySelector('.tname').textContent === name).click();
  const savedItem = name => JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.name === name);

  assert.match(document.getElementById('scr-items').textContent, /Планка: 10 → 12/);

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
  assert.doesNotMatch(document.getElementById('scr-items').textContent, /Планка:/);

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

  plus.click();
  assert.equal(wc.querySelector('.wnum b'), num); // узел тот же
  assert.equal(num.textContent, '1');
  const undo = wc.nextElementSibling;
  assert.ok(undo && undo.dataset.act === 'train-undo', 'кнопка отмены появилась');

  undo.click();
  assert.equal(num.textContent, '0');
  assert.notEqual(wc.nextElementSibling && wc.nextElementSibling.dataset.act, 'train-undo');
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
  document.querySelector('#tabs button[data-tab="items"]').click();
  const btn = document.querySelector('[data-act="move-down"]'); // первый пункт
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
  document.querySelector('#tabs button[data-tab="items"]').click();
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
  document.querySelector('#tabs button[data-tab="items"]').click();
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

  document.querySelector('#tabs button[data-tab="items"]').click();
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

  document.querySelector('#tabs button[data-tab="system"]').click();
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.equal(document.querySelector('.miss-note'), null); // missOpen очищен
  assert.ok(document.querySelector('[data-act="miss-note"]')); // сама точка на месте
});

test('скролл наверх — только при фактической смене вкладки', async () => {
  const { document, window } = await boot();
  const calls = [];
  window.scrollTo = (...a) => calls.push(a);

  document.querySelector('#tabs button[data-tab="items"]').click();
  assert.equal(calls.length, 1); // смена вкладки — скролл

  document.querySelector('#tabs button[data-tab="items"]').click();
  assert.equal(calls.length, 1); // та же вкладка — позиция не трогается

  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.equal(calls.length, 2);
});

test('импорт при открытой форме: черновик не накатывается на импортированный пункт', async () => {
  const { document, window } = await boot();
  document.querySelector('#tabs button[data-tab="items"]').click();

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
  assert.match(document.getElementById('scr-items').textContent, /Импортный/);
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

  // «+» и появившийся точечно «отменить последний»
  const plus = document.querySelector('[data-act="train-inc"]');
  assert.match(plus.getAttribute('aria-label'), /\+1 к «Тренировка»/);
  plus.click();
  const undo = document.querySelector('[data-act="train-undo"]');
  assert.match(undo.getAttribute('aria-label'), /Тренировка/);

  // тумблер активности
  document.querySelector('#tabs button[data-tab="items"]').click();
  const sw = document.querySelector('label.switch');
  assert.match(sw.getAttribute('aria-label'), /включён: «Умыться»/);
});

test('доступность: сетка разбора скрыта от AT, счётчики строк — в sr-only', async () => {
  const { document } = await boot({ seed: dueSeed() });
  document.querySelector('#tabs button[data-tab="review"]').click();
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

  document.querySelector('#tabs button[data-tab="review"]').click();
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
  document.querySelector('#tabs button[data-tab="review"]').click();
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

  document.querySelector('[data-act="train-inc"]').click();
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

  // состояние ожидания: последняя завершённая неделя уже разобрана
  const wait = dueSeed();
  wait.reviews = [mkReview(prevMonday())];
  const a = await boot({ seed: wait });
  a.document.querySelector('#tabs button[data-tab="review"]').click();
  let scr = a.document.getElementById('scr-review');
  assert.match(scr.textContent, /Разбор откроется/);
  assert.match(scr.textContent, /Изменение этой недели: „раньше <script>window\.__oc=1<\/script> ложиться“/);
  assert.equal(scr.querySelector('script'), null, 'разметка не материализовалась');
  assert.equal(a.window.__oc, undefined);

  // открытый разбор: закрыт лишь давний, последняя завершённая неделя ждёт
  const due = dueSeed();
  due.reviews = [mkReview(addKey(prevMonday(), -28))];
  const b = await boot({ seed: due });
  b.document.querySelector('#tabs button[data-tab="review"]').click();
  scr = b.document.getElementById('scr-review');
  assert.ok(scr.querySelector('.grid'), 'открытый разбор');
  assert.match(scr.textContent, /Изменение этой недели: „раньше <script>window\.__oc=1<\/script> ложиться“/);

  // пустое «одно изменение» — строки нет
  const empty = dueSeed();
  empty.reviews = [{ closedAt: 1, week: prevMonday(), keys: [prevMonday()], perItem: {}, trainings: {}, oneChange: '   ', raises: [] }];
  const c = await boot({ seed: empty });
  c.document.querySelector('#tabs button[data-tab="review"]').click();
  assert.doesNotMatch(c.document.getElementById('scr-review').textContent, /Изменение этой недели/);
});

test('«Привычки»: своя планка точечно, «Все отмечены», пороги пассивны, кредо', async () => {
  const { document, window } = await boot(); // дефолтный store: 2 привычки + параметр «Отбой»
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
  document.querySelector('#tabs button[data-tab="review"]').click();
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
  document.querySelector('#tabs button[data-tab="review"]').click();
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
  document.querySelector('#tabs button[data-tab="review"]').click();
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
  document.querySelector('#tabs button[data-tab="items"]').click();
  const scr = document.getElementById('scr-items');

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
  document.querySelector('#tabs button[data-tab="items"]').click();
  const open = name => [...document.querySelectorAll('[data-act="edit-open"]')]
    .find(b => b.textContent.includes(name)).click();
  const savedPn = () => JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.id === 'pn');

  open('Отбой');
  assert.equal(document.getElementById('e-pkind'), null, 'селекта вида нет');
  assert.match(document.querySelector('#scr-items .card.form').textContent, /Вид: время/);
  assert.ok(document.getElementById('e-ptime'), 'порог времени правится');
  assert.ok(document.getElementById('e-pstep'));

  open('Шаги');
  assert.equal(document.getElementById('e-pkind'), null);
  assert.match(document.querySelector('#scr-items .card.form').textContent, /Вид: число/);
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
  document.querySelector('#tabs button[data-tab="review"]').click();
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
  document.querySelector('#tabs button[data-tab="review"]').click();
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
  document.querySelector('#tabs button[data-tab="review"]').click();
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
  document.querySelector('#tabs button[data-tab="review"]').click();
  const scr = document.getElementById('scr-review');
  scr.querySelector('[data-act="param-keep"]').click();

  // без ожидания: перерисовка синхронна, класс-триггер не навешивается
  assert.equal(scr.querySelector('.leaving'), null, 'без анимации — без класса-триггера');
  assert.equal(scr.querySelector('[data-act="param-keep"]'), null, 'карточка убрана сразу');
  assert.match(scr.textContent, /Отбой: 01:30, без шага/);
});

test('движение: тихое подтверждение «Сохранено» показывается один раз и гаснет при следующем рендере', async () => {
  const { document } = await boot();
  document.querySelector('#tabs button[data-tab="items"]').click();
  const addHabit = [...document.querySelectorAll('[data-act="add-open"]')].find(b => b.dataset.area === 'habit');
  addHabit.click();
  document.getElementById('f-name').value = 'Растяжка';
  document.querySelector('[data-act="add-save"]').click();

  const flash = document.querySelector('#scr-items .flash');
  assert.ok(flash, 'подтверждение показано');
  assert.match(flash.textContent, /Сохранено/);
  assert.equal(flash.getAttribute('role'), 'status');

  // следующий рендер (открытие формы) — подтверждения уже нет (разовое)
  [...document.querySelectorAll('[data-act="add-open"]')].find(b => b.dataset.area === 'habit').click();
  assert.equal(document.querySelector('#scr-items .flash'), null, 'подтверждение разовое');
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

test('тексты ожидания разбора: полная дата понедельника открытия в обоих состояниях', async () => {
  // обычное ожидание: последняя завершённая неделя разобрана — откроется в следующий понедельник
  const wait = dueSeed();
  wait.reviews = [{ closedAt: 1, week: prevMonday(), keys: [], perItem: {}, trainings: {}, oneChange: '', raises: [] }];
  const a = await boot({ seed: wait });
  a.document.querySelector('#tabs button[data-tab="review"]').click();
  const textA = a.document.getElementById('scr-review').textContent;
  const monA = addKey(curMonday(), 7);
  assert.ok(textA.includes('Разбор откроется в понедельник, ' + fmtDayKey(monA)), textA);
  assert.doesNotMatch(textA, /\.\./); // без двойной точки «сент..»
  // явная защита формата: сокращённый месяц не используется (в мае формы
  // «мая» совпадают и ловить нечего — вывод корректен в обоих случаях)
  if (fmtShortKey(monA) !== fmtDayKey(monA)) {
    assert.ok(!textA.includes(fmtShortKey(monA)), 'сокращённый месяц («июл.») не используется');
  }

  // переходные дни: calendarSince в будущем — первый разбор через неделю после него
  const trans = dueSeed();
  trans.settings.calendarSince = addKey(curMonday(), 7);
  const b = await boot({ seed: trans });
  b.document.querySelector('#tabs button[data-tab="review"]').click();
  const textB = b.document.getElementById('scr-review').textContent;
  assert.ok(textB.includes('Разбор откроется в понедельник, ' + fmtDayKey(addKey(curMonday(), 14))), textB);
  assert.doesNotMatch(textB, /Календарные недели начнутся/);
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
  document.querySelector('#tabs button[data-tab="items"]').click();
  const addHabit = [...document.querySelectorAll('[data-act="add-open"]')].find(b => b.dataset.area === 'habit');
  addHabit.click();
  document.getElementById('f-name').value = 'Медитация';
  document.querySelector('[data-act="add-save"]').click();
  const saved = JSON.parse(window.localStorage.getItem(NS));
  const h = saved.items.find(i => i.name === 'Медитация');
  assert.equal(h.normPerWeek, 7); // поле присутствует в store и в экспорте той же сессии
});

test('привычка: степпер нормы — границы 1 и 7, сохранение', async () => {
  const { document, window } = await boot(); // дефолтный store: 2 привычки
  document.querySelector('#tabs button[data-tab="items"]').click();
  [...document.querySelectorAll('[data-act="edit-open"]')]
    .find(b => b.textContent.includes('Перестать грызть ногти')).click();
  const form = () => document.querySelector('#scr-items .card.form');
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
  assert.equal(saved.items.find(i => i.name === 'Перестать грызть ногти').normPerWeek, 2);

  // сохранённая норма отражается на полосе «Привычек»: «X из N» с N ≠ 7
  document.querySelector('#tabs button[data-tab="habits"]').click();
  const hrow = [...document.querySelectorAll('#scr-habits .rowwrap')]
    .find(r => r.textContent.includes('Перестать грызть ногти'));
  assert.match(hrow.querySelector('.hcount').textContent, /из 2$/);
});

test('разбор: строки привычек — «X из N · серия M нед», «серия прервана», просто «X из N»', async () => {
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
  document.querySelector('#tabs button[data-tab="review"]').click();
  const scr = document.getElementById('scr-review');
  const text = scr.textContent;
  assert.match(text, /Выполненная: 5 из 5 · серия 2 нед/);
  assert.match(text, /Прерванная: 2 из 7 · серия прервана/);
  assert.match(text, /Нулевая: 1 из 7/);
  assert.doesNotMatch(text, /Нулевая: 1 из 7 ·/); // без хвоста при нулевой серии до

  // семантический тон (задача 13): «серия прервана» несёт класс .broken; выполненная/нулевая — нет
  const broken = [...scr.querySelectorAll('.broken')];
  assert.equal(broken.length, 1, 'ровно одна прерванная серия помечена');
  assert.equal(broken[0].textContent, 'серия прервана');
  assert.ok(broken[0].closest('p').textContent.startsWith('Прерванная'), '.broken именно у прерванной привычки');
});

test('разбор: готовность к новой привычке при норме < 7', async () => {
  const seed = dueSeed();
  seed.items.push({ id: 'h1', name: 'Пять раз', value: null, unit: '', type: 'daily', area: 'habit',
    normPerWeek: 5, goal: null, note: '', group: '', active: true, addedAt: addKey(prevMonday(), -28), raiseAfter: 0, history: [] });
  const wk = (week, c) => ({ closedAt: 1, week, keys: [week], perItem: { h1: { count: c } }, trainings: {}, oneChange: '', raises: [], params: [] });
  seed.reviews = [wk(addKey(prevMonday(), -21), 5), wk(addKey(prevMonday(), -14), 6)]; // 5 и 6 при норме 5
  const { document } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="review"]').click();
  assert.match(document.getElementById('scr-review').textContent, /Привычки устойчивы 2 недели — можно добавить новую/);
});

test('раздел «Данные»: пассивная строка вместо императива', async () => {
  const { document } = await boot();
  document.querySelector('#tabs button[data-tab="items"]').click();
  const text = document.getElementById('scr-items').textContent;
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
  assert.equal(snap.schemaVersion, 6);
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
  assert.equal(JSON.parse(defSnap.json).items.length, 10);

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
  document.querySelector('#tabs button[data-tab="items"]').click();
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
  assert.equal(saved.schemaVersion, 6);                    // migrate прогнан
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
  document.querySelector('#tabs button[data-tab="items"]').click();
  assert.match(document.getElementById('scr-items').textContent, /Экспорта ещё не было/);

  window.URL.createObjectURL = () => 'blob:fake'; // в jsdom не реализовано
  window.URL.revokeObjectURL = () => {};
  document.querySelector('[data-act="export"]').click();

  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(typeof saved.settings.exportedAt, 'number');
  assert.match(document.getElementById('scr-items').textContent, /Последний экспорт:/);
});

test('строка «Резервная копия» подставляется асинхронно из savedAt зеркала', async () => {
  const idb = new IDBFactory();
  await idbPut(idb, { json: JSON.stringify(mirrorStore()), savedAt: Date.now(), schemaVersion: 4 });
  const { document, window } = await boot({ idb });
  document.querySelector('#tabs button[data-tab="items"]').click();
  const note = document.getElementById('mirror-note');
  for (let i = 0; i < 100 && note.hidden; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(note.hidden, false);
  assert.match(note.textContent, /Резервная копия: /);
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
