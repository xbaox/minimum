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
/* n ЛОГИЧЕСКИХ дней назад: календарная арифметика от сегодняшнего ключа, а
   не n·24 реальных часа — в неделю перевода стрелок те давали n ± 1 день
   (замер задачи Р2, п. 5: 02.11.2026 в 03:30 местного America/Toronto
   daysAgo(1) совпадал с сегодняшним днём, и падали десять тестов) */
function daysAgo(n) {
  return addKey(dayKey(new Date()), -n);
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

/* Уход пункта через интерфейс (задача 28.E/A): «Настройки» → строка →
   форма правки → «Убрать» дважды. Второй тап нужен всегда: первый только
   взводит и печатает последствие под кнопкой. */
function removeItemThroughUi(doc, id) {
  doc.querySelector('#tabs button[data-tab="settings"]').click();
  const open = [...doc.querySelectorAll('#scr-settings [data-act="edit-open"]')]
    .find(b => b.dataset.id === id);
  assert.ok(open, 'строка пункта ' + id);
  open.click();
  const rm = () => [...doc.querySelectorAll('#scr-settings [data-act="item-remove"]')]
    .find(b => b.dataset.id === id);
  assert.ok(rm(), 'кнопка «Убрать» в форме пункта ' + id);
  rm().click();
  assert.match(rm().textContent, /Подтвердить/, 'первый тап только взводит');
  rm().click();
}

/* Отказ записи на время fn: localStorage подменяется геттером окна — тем же
   приёмом, что в тесте баннера хранилища. Присвоить setItem самому Storage
   нельзя: такое присваивание по спецификации пишет ключ «setItem». */
function withBrokenStorage(window, fn) {
  const real = window.localStorage;
  const broken = {
    getItem: k => real.getItem(k),
    setItem: () => { throw new Error('quota'); },
    removeItem: k => real.removeItem(k)
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, get: () => broken });
  try { return fn(); } finally {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => real });
  }
}

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
  DAY_CLOSE_MS: 40,
  MIRROR_FLUSH_MS: 30,
  DAY_TIMER_SLACK_MS: 5,
  MOTION_MS: 20,
  MOTION_TAIL_MS: 10,
  FLASH_MS: 100,
  DRAG_HOLD: 30,
  DRAG_CLICK_MS: 30,
  // ответ воркера о версии (задача Р3): подменный воркер отвечает в
  // следующем такте, молчащий ждётся ровно столько
  VERSION_ASK_MS: 60
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

async function boot({ seed, raw, idb, timing, sw, reload } = {}) {
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
  // service worker API (задача Р3): в jsdom его нет вовсе, и все прежние
  // тесты идут этой ветке — без предложения и без «Проверить обновления».
  // Подмена ставится до загрузки app.js вместе с MessageChannel, которого
  // jsdom тоже не знает, и хуком перезагрузки (globalThis.MINIMUM_RELOAD)
  if (sw) {
    Object.defineProperty(window.navigator, 'serviceWorker', { configurable: true, value: sw });
    window.MessageChannel = FakeChannel;
  }
  if (reload) window.MINIMUM_RELOAD = reload;
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
  // кредо-строка снята (задача 28.E/B, п. 2.3): она стояла за сгибом. Её
  // место в шапке заняла строка дня — одна из набора, любая
  assert.equal(today.querySelector('.creed'), null, 'кредо «Сегодня» снято');
  assert.ok(today.querySelector('header.page .dline'), 'строка дня — в шапке');
  for (const id of ['scr-habits', 'scr-progress', 'scr-settings', 'scr-review', 'scr-train']) {
    assert.equal(document.getElementById(id).hidden, true, id);
  }
});

test('вкладки переключают все 4 экрана, каждый рендерится без исключений', async () => {
  const { document } = await boot();
  const tabs = [...document.querySelectorAll('#tabs button')];
  assert.equal(tabs.length, 4);
  // задача 16B: «Разбор» и «Система» ушли с панели, пришли «Прогресс» и «Заметки»;
  // задача 28.C: «Заметки» ушли следом — вкладок стало четыре
  assert.deepEqual(tabs.map(b => b.dataset.tab), ['today', 'habits', 'progress', 'settings']);
  assert.deepEqual(tabs.map(b => b.textContent),
    ['Сегодня', 'Привычки', 'Прогресс', 'Настройки']);
  const map = {
    today: 'scr-today', habits: 'scr-habits', progress: 'scr-progress',
    settings: 'scr-settings'
  };
  const marker = {
    // маркером «Сегодня» была кредо-строка; она снята (28.E/B), и на её
    // место взят недельный счётчик — блок, который есть только здесь
    today: /Полноценная тренировка/,
    habits: /Не спеши — доверься накопительному эффекту/,
    progress: /В системе/,
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
    // листы разбора и тренировки живут поверх вкладок и сейчас закрыты
    assert.equal(document.getElementById('scr-review').hidden, true);
    assert.equal(document.getElementById('scr-train').hidden, true);
  }
});

/* Задача 28.C: пятой вкладки нет ни в разметке, ни в живом документе, а
   переходы между четырьмя оставшимися целы в обе стороны. Мутант, который
   вернёт кнопку или секцию в index.html, умирает здесь. */
test('З28C: вкладок четыре, пятой нет ни в разметке, ни в документе', async () => {
  assert.doesNotMatch(HTML, /data-tab="notes"/, 'кнопки вкладки нет в index.html');
  assert.doesNotMatch(HTML, /id="scr-notes"/, 'секции экрана нет в index.html');
  assert.equal((HTML.match(/<button data-tab=/g) || []).length, 4, 'в таб-баре четыре кнопки');
  // задача 28.D: лист детали снят вместе с формулой и лестницей — секций шесть
  assert.equal((HTML.match(/<section class="screen"/g) || []).length, 6, 'шесть секций: 4 вкладки + 2 листа');
  assert.doesNotMatch(HTML, /id="scr-detail"/, 'секции листа детали нет в index.html');

  const { document } = await boot();
  assert.equal(document.getElementById('scr-notes'), null);
  assert.equal(document.getElementById('scr-detail'), null, 'и в живом документе её тоже нет');
  assert.equal(document.querySelector('#tabs button[data-tab="notes"]'), null);

  // переходы между оставшимися целы в обе стороны, включая возврат
  const order = ['settings', 'progress', 'habits', 'today', 'progress', 'settings', 'today'];
  const map = { today: 'scr-today', habits: 'scr-habits', progress: 'scr-progress', settings: 'scr-settings' };
  for (const tab of order) {
    document.querySelector(`#tabs button[data-tab="${tab}"]`).click();
    assert.equal(document.getElementById(map[tab]).hidden, false, tab);
    assert.ok(document.getElementById(map[tab]).innerHTML.length > 0, tab);
    const current = [...document.querySelectorAll('#tabs button')].filter(b => b.getAttribute('aria-current') === 'page');
    assert.equal(current.length, 1, 'текущая вкладка ровно одна');
    assert.equal(current[0].dataset.tab, tab);
    for (const [t, id] of Object.entries(map)) {
      if (t !== tab) assert.equal(document.getElementById(id).hidden, true, `${id} скрыт на ${tab}`);
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
  document.querySelector('#tabs button[data-tab="settings"]').click();

  // редактирование первого пункта. Имя — по данным, а не по .tname: в строке
  // «Расписания» за именем идёт подпись .csub («Расписание 1/3», п. 4.7г)
  const editBtn = document.querySelector('[data-act="edit-open"]');
  const itemName = JSON.parse(document.defaultView.localStorage.getItem(NS))
    .items.find(i => i.id === editBtn.dataset.id).name;
  editBtn.click();
  const eName = document.getElementById('e-name');
  assert.ok(eName, 'форма редактирования открылась');
  assert.equal(eName.value, itemName);
  document.querySelector('[data-act="edit-cancel"]').click();
  assert.equal(document.getElementById('e-name'), null);

  // добавление действий — быстрой формой в блоке (форма добавления минимума
  // снята, п. 2.4); форма добавления привычки — своей кнопкой с областью
  document.querySelector('[data-act="quick-open"]').click();
  assert.ok(document.getElementById('q-lines'), 'быстрое добавление открылось');
  document.querySelector('[data-act="quick-cancel"]').click();
  assert.equal(document.getElementById('q-lines'), null);
  document.querySelector('[data-act="add-open"][data-area="habit"]').click();
  assert.ok(document.getElementById('f-name'), 'форма добавления привычки открылась');
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
    settings: 'scr-settings'
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
  // строка ищется по id, а не по тексту имени: в «Расписании» за именем
  // стоит подпись .csub («Расписание 1/3», п. 4.7г)
  const ids = { 'Правка': 'e1', 'Недельный': 'w1' };
  const openEdit = name => [...document.querySelectorAll('[data-act="edit-open"]')]
    .find(b => b.dataset.id === ids[name]).click();
  const savedItem = name => JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.name === name);

  // история планки переехала из строки в форму правки (п. 2.4): строка
  // компактная, справка о прошлом — у пункта
  assert.doesNotMatch(document.getElementById('scr-settings').textContent, /Планка:/, 'в строке истории нет');
  openEdit('Правка');
  assert.match(document.querySelector('#scr-settings [data-form="edit"]').textContent, /Планка: 10 → 12/);

  // невалидный ввод — отказ: ни значения, ни истории, ни «Сохранено»,
  // и правка названия в той же форме тоже не записана (всё или ничего)
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
  // «Планка:» скрыта и там, где она теперь живёт, — в форме правки
  openEdit('Правка');
  assert.doesNotMatch(document.querySelector('#scr-settings [data-form="edit"]').textContent, /Планка:/);
  document.querySelector('[data-act="edit-cancel"]').click();

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
  // назавтра ЛОГИЧЕСКИ, а не через 24 реальных часа: в день перевода стрелок
  // сутки сдвига оставляли тот же логический день (задача Р2, п. 5)
  shiftWindowDays(window, 1);

  document.querySelector('input[data-act="mark"]').click();

  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.deepEqual(saved.days, {}); // отметка не записана ни в какой день
  assert.notEqual(document.querySelector('#scr-today h1').textContent, h1before); // новая дата
  assert.equal(document.querySelector('input[data-act="mark"]').checked, false);
});

test('visibilitychange после смены дня обновляет экран', async () => {
  const { document, window } = await boot();
  const before = document.querySelector('#scr-today h1').textContent;
  shiftWindowDays(window, 1); // логический день, не 24 часа (Р2, п. 5)
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

  // Форма добавления минимума со своей сменой типа (daily/weekly) снята
  // («Расписание 1/3», п. 2.4). Смена типа, скрывающая поле, осталась у
  // формы привычки (привычка/параметр): предмет прежний — скрытое сменой
  // типа поле возвращается с набранным, а не с умолчанием
  document.querySelector('[data-act="add-open"][data-area="habit"]').click();
  document.getElementById('f-name').value = 'Подъём';
  changeType('param');
  document.getElementById('f-pstep').value = '-10';
  changeType('daily');
  assert.equal(document.getElementById('f-pstep'), null); // поле шага скрыто
  changeType('param');
  assert.equal(document.getElementById('f-name').value, 'Подъём');
  assert.equal(document.getElementById('f-pstep').value, '-10'); // шаг не сброшен на пустой
  document.querySelector('[data-act="add-cancel"]').click();

  // быстрое добавление переживает перестановку соседнего пункта в том же блоке
  document.querySelector('[data-act="quick-open"]').click();
  document.getElementById('q-lines').value = 'Кровать\nРазвитие · 10 мин';
  [...document.querySelectorAll('[data-act="move-down"]')].find(b => !b.disabled).click();
  assert.ok(document.getElementById('q-lines'), 'форма всё ещё открыта');
  assert.equal(document.getElementById('q-lines').value, 'Кровать\nРазвитие · 10 мин');
  document.querySelector('[data-act="quick-cancel"]').click();

  // Смена типа daily/weekly вернулась — в форму ПРАВКИ действия в день его
  // заведения («Расписание 1/3», этап C, п. 2.5). Предмет прежней формы
  // добавления минимума: цель, набранная у счётчика, переживает смену типа
  // туда и обратно, а не возвращается пустой
  document.querySelector('[data-act="quick-open"]').click();
  document.getElementById('q-lines').value = 'Счётчик на пробу';
  document.querySelector('[data-act="quick-save"]').click();
  const born = JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.name === 'Счётчик на пробу');
  [...document.querySelectorAll('[data-act="edit-open"]')].find(b => b.dataset.id === born.id).click();
  const editType = v => {
    const sel = document.getElementById('e-type');
    sel.value = v;
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  assert.equal(document.getElementById('e-goal'), null, 'у ежедневного цели нет');
  editType('weekly');
  document.getElementById('e-goal').value = '4';
  editType('daily');
  assert.equal(document.getElementById('e-goal'), null); // поле цели скрыто
  editType('weekly');
  assert.equal(document.getElementById('e-goal').value, '4'); // цель не сброшена на пустую
  document.querySelector('[data-act="edit-cancel"]').click();

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
  shiftWindowDays(window, 1); // логический день, не 24 часа (Р2, п. 5)
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

  // первое срабатывание: день сменился — таймер обязан позвать syncDay.
  // Сдвиг — на логический день, а не на 24 часа (Р2, п. 5)
  shiftWindowDays(window, 1);
  await wait(tick + T.DAY_TIMER_SLACK_MS + 60);
  const day1 = document.querySelector('#scr-today h1').textContent;
  assert.notEqual(day1, day0, 'таймер позвал syncDay: экран показывает новый день');

  // второе: таймер обязан быть взведён заново — иначе смена дня при
  // открытом приложении сработает ровно один раз за запуск
  shiftWindowDays(window, 2);
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

/* Здесь стоял тест тумблера активности («переключает .off точечно, без
   перерисовки»). Тумблер упразднён вместе с полем active (задача 28.E/A,
   п. 2), и точечного пути на «Настройках» не осталось вовсе: «Убрать»
   всегда идёт полной перерисовкой. Его место занял блок тестов ухода и
   возврата ниже по файлу («З28E/A: …»). */

test('З28E/A: тумблера нет ни у пункта, ни у упражнения, ни в данных', async () => {
  const { document, window } = await boot({ seed: trainSeed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  for (const d of document.querySelectorAll('#scr-settings details.sect')) {
    if (!d.open) d.querySelector('summary').click();
  }
  assert.equal(document.querySelector('[data-act="toggle-active"]'), null);
  assert.equal(document.querySelector('[data-act="ex-active"]'), null);
  assert.equal(document.querySelector('label.switch'), null, 'контрол снят целиком');
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.ok(saved.items.length);
  for (const it of saved.items) {
    assert.equal('active' in it, false, 'поля active в данных нет');
    assert.equal(it.removedAt, null, 'зато есть отрезок жизни');
  }
  for (const ex of saved.exercises) assert.equal('active' in ex, false);
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
  // клик применяется, а не глотается stale-guard'ом. Кнопка добавления — с
  // областью: у минимума формы добавления больше нет («Расписание 1/3», п. 4.7б)
  document.querySelector('[data-act="add-open"][data-area="habit"]').click();
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

test('доступность: имена кнопок строки и недельного счётчика содержат название пункта', async () => {
  const { document } = await boot();

  // «+» (открывает лист записи) и появившийся точечно «отменить последний»
  const plus = document.querySelector('[data-act="train-inc"]');
  assert.match(plus.getAttribute('aria-label'), /записать тренировку: «Тренировка»/);
  plus.click();
  document.querySelector('[data-act="train-save"]').click();
  const undo = document.querySelector('[data-act="train-undo"]');
  assert.match(undo.getAttribute('aria-label'), /Тренировка/);

  // строка пункта в «Настройках»: имя несёт кнопка правки (тумблера,
  // чьё имя проверялось здесь, больше нет — задача 28.E/A, п. 2)
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const itxt = document.querySelector('#scr-settings [data-act="edit-open"]');
  assert.match(itxt.getAttribute('aria-label'), /изменить «Умыться»/);
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

  // ровно неделя вперёд — семь ЛОГИЧЕСКИХ дней: 168 реальных часов в неделю
  // перевода стрелок давали шесть, и в понедельник 04:00–05:00 местного
  // счётчик не обнулялся (Р2, п. 5; замер при TZ=America/Toronto, 26.10.2026)
  shiftWindowDays(window, 7);
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
  // путь ведёт в секцию привычек: секция «Пункты» уходит («Расписание 1/3», п. 2.1)
  assert.match(document.getElementById('scr-habits').textContent,
    /Привычек пока нет — добавить можно в Настройках → Привычки\./);
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

/* Две области — две секции «Настроек» («Расписание 1/3», п. 2.3): прежде это
   были два заголовка h2 внутри «Пунктов». Добавление минимума — быстрой
   формой в карточке блока, добавление привычки — прежней формой. */
test('«Расписание» и «Привычки»: секции обеих областей, формы, параметр добавляется и правится', async () => {
  const { document, window } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const scr = document.getElementById('scr-settings');

  const sectOf = re => [...scr.querySelectorAll('details.sect')].find(d => re.test(d.querySelector('summary').textContent));
  const sched = sectOf(/^Расписание/), habits = sectOf(/^Привычки/);
  assert.ok(sched && habits, 'обе секции найдены');
  assert.ok(sched.querySelector('[data-act="quick-open"]'), 'минимум добавляется в «Расписании»');
  assert.equal(sched.querySelector('[data-act="add-open"]'), null, 'формы добавления минимума больше нет');
  const addBtns = [...scr.querySelectorAll('[data-act="add-open"]')];
  assert.deepEqual(addBtns.map(b => b.dataset.area), ['habit']);
  assert.ok(habits.contains(addBtns[0]), 'кнопка привычки — в своей секции');

  // форма привычек: тип «привычка» — только название и подпись
  addBtns[0].click();
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
  assert.match(document.getElementById('scr-settings').textContent, /Данные ещё не скачивались/);

  window.URL.createObjectURL = () => 'blob:fake'; // в jsdom не реализовано
  window.URL.revokeObjectURL = () => {};
  document.querySelector('[data-act="export"]').click();

  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(typeof saved.settings.exportedAt, 'number');
  // задача 25, п. 9: приложение знает лишь то, что скачивание ЗАПУЩЕНО —
  // сохранил ли владелец файл, в вебе узнать нечем. Строка не утверждает
  // больше: «Последний экспорт» обещал состоявшийся файл, «запускался» — нет
  assert.match(document.getElementById('scr-settings').textContent, /Данные скачивались:/);
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

/* ── Строка дня после снятия формулы и лестницы (задача 28.D) ── */

test('З28D/10.4: строка дня — подпись из item.note, ни метки ступени, ни хвоста', async () => {
  const seed = dueSeed();
  seed.items[0].note = 'подпись владельца';
  // Лестница ЛЕЖИТ В ДАННЫХ: механика снята, поле осталось. Строка дня
  // обязана этого не заметить — ни подписью, ни разметкой.
  seed.items[0].ladder = { steps: ['в кровати в 23:30', '+10 минут без экрана', '+15 минут раньше'], step: 1, steppedWeek: null, startedAt: null };
  seed.items[0].ladderLog = [{ date: addKey(prevMonday(), -30), step: 0, text: 'в кровати в 23:30', start: true }];
  seed.items[0].formula = { anchor: 'после зарядки', when: '', pair: '', identity: '', twoMin: '', friction: '', proof: '', mode: 'build' };
  const { document, window } = await boot({ seed });
  const scr = document.getElementById('scr-today');

  // подпись — слово владельца; ступень её больше не вытесняет
  assert.match(scr.textContent, /подпись владельца/);
  assert.doesNotMatch(scr.textContent, /\+10 минут без экрана/, 'ступень в строку дня не попадает');
  assert.equal(scr.querySelector('.note').textContent, 'подпись владельца');
  assert.equal(scr.querySelector('.lstep'), null, 'метки положения на лестнице нет');
  assert.equal(scr.querySelector('.idetail'), null, 'хвостовой кнопки нет');
  assert.equal(scr.querySelector('[data-act="item-detail"]'), null, 'и действия входа в лист тоже');

  // название внутри label: тап по нему отмечает пункт (тач-зона всей строки)
  const label = scr.querySelector('label.check');
  assert.ok(label.querySelector('.tname'), 'название внутри label');
  assert.equal(label.querySelector('input[data-act="mark"]').getAttribute('aria-label'), null,
    'имя чекбоксу даёт содержимое label, aria-label не дублируется');
  scr.querySelector('.tname').click(); // тап по названию
  assert.equal(label.classList.contains('on'), true, 'пункт отмечен');
  assert.equal(Object.values(JSON.parse(window.localStorage.getItem(NS)).days[daysAgo(0)])[0], true);

  // и данные лестницы при этом на месте — отметка их не тронула
  const saved = JSON.parse(window.localStorage.getItem(NS)).items[0];
  assert.deepEqual(saved.ladder.steps, ['в кровати в 23:30', '+10 минут без экрана', '+15 минут раньше']);
  assert.equal(saved.ladder.step, 1);
  assert.equal(saved.ladderLog.length, 1);
  assert.equal(saved.formula.anchor, 'после зарядки');
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

test('блок: уход пунктов убирает линию, когда живым остаётся один', async () => {
  const { document } = await boot({ seed: chainSeed() });
  const scr = () => document.getElementById('scr-today');

  removeItemThroughUi(document, 'c3');
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.equal(scr().querySelectorAll('.chain').length, 1, 'двое — линия есть');
  assert.equal(scr().querySelectorAll('.cseg').length, 4);

  removeItemThroughUi(document, 'c2');
  document.querySelector('#tabs button[data-tab="today"]').click();
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
  for (const tab of ['today', 'habits', 'progress', 'settings']) {
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

/* Блоки — карточки «Расписания» («Расписание 1/3», п. 2.4): шапка с именем,
   стрелками и шевроном свёртки, правка раскрывается тапом по шапке.
   Удаление снято, блок убирается вторым тапом (п. 4.7в) — набор проверок
   прежний: последствие названо между тапами, пункты и отметки целы. */
test('редактор блоков: строка — имя и стрелки, правка раскрывается тапом', async () => {
  const { document, window } = await boot({ seed: chainSeed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  const blocks = () => [...document.querySelectorAll('#scr-settings [data-act="group-open"]')]
    .map(b => b.closest('.bcard'));
  const rowOf = name => blocks().find(r => r.querySelector('.bhead .tname').textContent === name);

  // список в порядке store.groups; в шапке — имя, стрелки и свёртка
  assert.deepEqual(blocks().map(r => r.querySelector('.bhead .tname').textContent), ['Вечер', 'Утро']);
  const row = rowOf('Вечер');
  assert.equal(row.querySelector('label.switch'), null, 'тумблера цепочки нет');
  assert.equal(row.querySelector('[data-act="group-remove"]'), null, 'кнопок правки в шапке нет');
  assert.deepEqual([...row.querySelectorAll('.bhead .ictl .btn')].map(b => b.dataset.act), ['group-up', 'group-down', 'group-fold']);
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

  // уход — вторым тапом; пункты и отметки остаются
  document.querySelector('#tabs button[data-tab="today"]').click();
  [...document.querySelectorAll('#scr-today input[data-act="mark"]')].find(i => i.dataset.id === 'c1').click();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  rowOf('Ночь').querySelector('[data-act="group-open"]').click(); // уход живёт в раскрытой правке
  const rm = () => rowOf('Ночь').querySelector('[data-act="group-remove"]');
  assert.match(rm().textContent, /^Убрать блок$/);
  rm().click();
  assert.match(rm().textContent, /Подтвердить: убрать блок/);
  assert.match(rowOf('Ночь').textContent, /Блок уйдёт из списков вместе с действиями и привычками\. Отметки и прошлые дни останутся как есть\./,
    'последствие названо между тапами');
  assert.ok(!saved().groups.find(g => g.name === 'Ночь').removedAt, 'первый тап не убирает');
  rm().click();
  s = saved();
  assert.equal(s.groups.find(g => g.name === 'Ночь').removedAt, daysAgo(0), 'блок убран, а не стёрт');
  assert.equal(s.items.length, 5, 'пункты остались');
  assert.deepEqual(s.items.filter(i => i.group === 'Ночь').map(i => i.id), ['c1', 'c2', 'c3'], 'при своём блоке');
  assert.equal(s.items.find(i => i.id === 'n1').removedAt, null, 'чужой пункт на месте');
  assert.equal(s.days[daysAgo(0)].c1, true, 'отметка не тронута');
});

/* Задача 17, п. 2: поле «Блок» — выбор из заведённых, а не свободный ввод.
   Прежний тест проверял datalist; сама механика поля заменена промптом. */
test('поле «Блок»: select из заведённых, «+ Новый блок…» заводит блок в конце', async () => {
  const { document, window } = await boot({ seed: chainSeed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  const sel = () => document.getElementById('e-group');
  // строка — по id (п. 4.7г): за именем в «Расписании» может стоять подпись
  const ids = { 'Свет': 'c1' };
  const openEdit = name => [...document.querySelectorAll('#scr-settings .row.item [data-act="edit-open"]')]
    .find(b => b.dataset.id === ids[name]).click();
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
  // v19: блок, заведённый из формы пункта, — в канонической форме;
  // v20 (Р2): и в активном режиме — здесь основном
  assert.deepEqual(s.groups[2], { name: 'Ритуал', caption: '', days: [], removedAt: null, mode: 'main' });

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
    .find(b => b.dataset.id === 'c1').click(); // по id, а не по тексту имени (п. 4.7г)

  const sel = document.getElementById('e-group');
  const marked = [...sel.options].find(o => o.value === 'Чужой');
  assert.ok(marked, 'вариант с именем из импорта есть');
  assert.equal(marked.textContent, 'Чужой (нет в списке)');
  assert.equal(sel.value, 'Чужой', 'и он выбран');

  // сохранение без правки поля принадлежность не теряет
  document.querySelector('[data-act="edit-save"]').click();
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.id === 'c1').group, 'Чужой');
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
  // «Расписание» — секция «Настроек» с карточками блоков (была «Блоки», задача
  // 16B; «Расписание 1/3», п. 2.3), «Блок» — поле формы
  assert.match(js, /sect\('schedule', 'Расписание'/);
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
  assert.match(scr.querySelector('.rise-v').textContent, /^10 → 14$/);
  assert.equal(svg[0].querySelector('text'), null, 'подписей значений в SVG нет');
  assert.equal(svg[0].querySelector('line'), null, 'осей и сетки нет');
  assert.equal(svg[0].querySelector('circle'), null, 'точек нет');
});

/* ── A.1.2: формат подписи «Подъёма» — один на ВСЕ источники ──
   «старт → текущее», и ничего после. Источников три, и до задачи 29/A
   каждый печатался по-своему: у параметра-числа fmtParam вклеивал единицу
   в ОБА значения («4000 шаг. → 5000 шаг.»), у пункта и упражнения единица
   дописывалась хвостом, и упражнение с числом в поле «Единица» давало
   «7 → 8 7» — третье число, которого владелец не писал.

   Тест держит все четыре случая разом: хвост, вернувшийся к любому
   источнику, валит его (мутант 29A-tail). */
test('З29A/1: подпись «Подъёма» — «старт → текущее» у всех трёх источников, без хвоста', async () => {
  const seed = progSeed();
  const day0 = addKey(daysAgo(0), -20), day1 = daysAgo(3);
  seed.items = [
    { id: 'pt', name: 'Отбой', value: null, unit: '', type: 'param', area: 'habit',
      pkind: 'time', pvalue: 1425, pstep: -15, goal: null, note: '', group: '',
      removedAt: null, addedAt: day0, raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null,
      history: [{ date: day0, value: 0 }, { date: day1, value: 1425 }] },
    { id: 'pn', name: 'Шаги', value: null, unit: 'шаг.', type: 'param', area: 'habit',
      pkind: 'number', pvalue: 5000, pstep: 500, goal: null, note: '', group: '',
      removedAt: null, addedAt: day0, raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null,
      history: [{ date: day0, value: 4000 }, { date: day1, value: 5000 }] },
    { id: 'it', name: 'Английский', value: 8, unit: 'мин', type: 'daily', area: 'min',
      goal: null, note: '', group: '', removedAt: null, addedAt: day0,
      raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null,
      history: [{ date: day0, value: 5 }, { date: day1, value: 8 }] }
  ];
  // упражнение с ЧИСЛОМ в поле «Единица» — данные владельца, дефект «7 → 8 7»
  seed.exercises = [
    { id: 'ex', name: 'Подтягивания', unit: '7', value: 8, addedAt: day0, removedAt: null,
      history: [{ date: day0, value: 7 }, { date: day1, value: 8 }] },
    { id: 'ex2', name: 'Жим', unit: 'кг', value: 40, addedAt: day0, removedAt: null,
      history: [{ date: day0, value: 35 }, { date: day1, value: 40 }] }
  ];
  const { document } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="progress"]').click();
  const got = {};
  for (const b of document.querySelectorAll('#scr-progress .rise-b')) {
    got[b.querySelector('.rise-n').textContent] = b.querySelector('.rise-v').textContent;
  }
  assert.deepEqual(got, {
    'Отбой': '00:00 → 23:45',        // порог-время читается часами, единицы у него нет
    'Шаги': '4000 → 5000',           // единица параметра-числа больше не вклеивается дважды
    'Английский': '5 → 8',           // планка пункта — без «мин»
    'Подтягивания': '7 → 8',         // мусор в «Единице» на «Подъём» не попадает
    'Жим': '35 → 40'                 // и честная единица тоже: формат ОДИН
  });
  // сторож формата: ни одна подпись не несёт ничего, кроме двух значений и стрелки
  for (const [name, label] of Object.entries(got)) {
    assert.match(label, /^[^ ]+ → [^ ]+$/, `хвост вернулся к ряду «${name}»: ${label}`);
  }
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

test('«Настройки»: секции по порядку, раскрыто только «Расписание», состояние держится', async () => {
  const { document } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const sects = () => [...document.querySelectorAll('#scr-settings details.sect')];
  const titles = () => sects().map(s => s.querySelector('summary').textContent.replace('›', '').trim());

  // «Упражнения» добавились в фазе D; «Блоки» и «Пункты» стали «Расписанием» и
  // «Привычками» («Расписание 1/3», п. 2.3). Раскрыта по умолчанию — первая
  assert.deepEqual(titles(), ['Расписание', 'Привычки', 'Упражнения', 'Данные', 'Система']);
  assert.deepEqual(sects().map(s => s.hasAttribute('open')), [true, false, false, false, false]);

  // содержимое на месте, внутри своих секций: блоки, граница и зачёт дня —
  // в «Расписании», форма привычки — в «Привычках»
  assert.match(sects()[0].textContent, /Добавить блок/);
  assert.match(sects()[0].textContent, /Добавить действия/);
  assert.match(sects()[0].textContent, /Граница дня/);
  assert.match(sects()[0].textContent, /Зачёт дня/);
  assert.match(sects()[1].textContent, /Добавить привычку/);
  assert.match(sects()[2].textContent, /Добавить упражнение/);
  assert.ok(sects()[3].querySelector('[data-act="export"]'));
  assert.match(sects()[4].textContent, /Пять правил/);

  // раскрытие запоминается: перерисовка после действия секцию не захлопывает
  sects()[3].querySelector('summary').click();
  document.querySelector('#scr-settings [data-act="quick-open"]').click(); // перерисовка «Настроек»
  assert.deepEqual(sects().map(s => s.hasAttribute('open')), [true, false, false, true, false]);
});

/* ── Задача 16, фаза C. Разбор как три решения ─────────────── */

test('разбор: два решения сверху, неделя — под свёрткой, итог одной строкой', async () => {
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
  // задача 28.D: «Ступень» снята, «Одно изменение» получило её номер —
  // дыры в нумерации не бывает
  assert.deepEqual(h2, ['Решение 1 · Планка', 'Решение 2 · Одно изменение']);

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
  const h2i = kids.findIndex(x => x.textContent === 'Решение 2 · Одно изменение');
  const ci = kids.indexOf(card);
  assert.ok(h1i < ci && ci < h2i, 'карточка стоит внутри «Решения 1»');

  // решения без предложений — тихие строки, а не пустота
  assert.doesNotMatch(scr.textContent, /Планка держится, менять нечего/,
    'нерешённый параметр — это и есть решение по планке');
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

test('«Настройки»: упражнения добавляются, правятся, двигаются и убираются', async () => {
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

  // «Убрать» уводит упражнение из листа тренировки и из списка, но не из данных
  rows()[0].querySelector('[data-act="ex-open"]').click();
  const rm = () => document.querySelector('[data-act="ex-remove"]');
  rm().click();
  assert.match(rm().textContent, /Подтвердить/, 'первый тап только взводит');
  rm().click();
  assert.equal(saved().exercises[0].removedAt, daysAgo(0));
  assert.ok(document.querySelector('#scr-settings .gone-note'), 'короткий путь назад на месте');
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector('[data-act="train-inc"]').click();
  assert.equal(document.getElementById('ex-e2'), null, 'убранного в листе нет');
  assert.ok(document.getElementById('ex-e1'), 'живое на месте');
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
  assert.match(blocks[0].querySelector('.rise-v').textContent, /^40 → 45$/);
  assert.equal((blocks[0].querySelector('path').getAttribute('d').match(/[HV]/g) || []).length, 3);
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
  // строки стоят в карточках своих блоков («Расписание 1/3», п. 2.4): сначала
  // все пункты «Утра», затем «Вечера» — порядок внутри блока по items[]
  assert.deepEqual(rows().map(r => r.dataset.dragId), ['a1', 'a2', 'a3', 'b1']);

  stubRows(rows());
  const row = rows()[0]; // «Первый», блок «Утро»
  row.dispatchEvent(pointer(window, 'pointerdown', 100, 230));
  await hold();
  assert.equal(row.classList.contains('drag-live'), true, 'захват после удержания');

  // Порог — СЕРЕДИНА соседа, и проверяется он с обеих сторон (Р1/ревью):
  // карточки блоков сдвинули a3 на 320..380 (середина 350), а палец прежде
  // оставался на 415 — за нижним краем строки, и порог «за серединой» не
  // проверял уже ничто. Чуть выше середины a3 пункт встаёт вторым
  document.dispatchEvent(pointer(window, 'pointermove', 100, 345));
  document.dispatchEvent(pointer(window, 'pointerup', 100, 345));
  assert.deepEqual(saved().items.map(i => i.id), ['a2', 'a1', 'b1', 'a3'], 'выше середины a3 — вторым');

  // …чуть ниже середины — последним. Строки перерисованы: a1 теперь вторая
  stubRows(rows());
  assert.deepEqual(rows().map(r => r.dataset.dragId), ['a2', 'a1', 'a3', 'b1']);
  rows()[1].dispatchEvent(pointer(window, 'pointerdown', 100, 290));
  await hold();
  document.dispatchEvent(pointer(window, 'pointermove', 100, 355));
  document.dispatchEvent(pointer(window, 'pointerup', 100, 355));

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

  // блоки: второй встаёт первым. Карточку берут за шапку — тело карточки
  // захвата не даёт («Расписание 1/3», п. 4.3; отдельный тест ниже)
  const gRows = () => [...document.querySelectorAll('#scr-settings [data-drag="group"]')];
  stubRows(gRows());
  gRows()[1].querySelector('.bhead').dispatchEvent(pointer(window, 'pointerdown', 100, 290));
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
    settings: 'scr-settings'
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

  // «Настройки» пусты, но живы. Строки «Блоков пока нет» больше нет: без
  // блоков стоит карточка «Без блока» с быстрым добавлением — действию есть
  // где родиться («Расписание 1/3», п. 2.4)
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const sett = document.getElementById('scr-settings');
  const loose = sett.querySelector('.bcard.loose');
  assert.ok(loose, 'карточка «Без блока» на месте');
  assert.match(loose.textContent, /Без блока/);
  assert.equal(loose.querySelector('[data-act="quick-open"]').dataset.name, '');
  assert.equal(loose.querySelectorAll('.rowwrap').length, 0, 'строк нет');
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

test('чистка: «Вернуть» восстанавливает всё, «Стереть копию» — вторым тапом', async () => {
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

test('пустая эпоха: пять экранов после чистки рендерятся без исключений', async () => {
  const { document, window } = await boot({ seed: trainSeed() });
  // чистка в понедельник ставит эпоху на СЕГОДНЯ — та уже не пустая, и тест
  // падал каждый логический понедельник (замер задачи Р2, п. 5). Предмет —
  // эпоха впереди, поэтому чистка идёт в среду
  await moveToWeekday(window, document, 2);
  wipeThroughUi(document);
  const store = JSON.parse(window.localStorage.getItem(NS));
  // эпоха начинается в ближайший понедельник — позже сегодняшнего дня
  assert.ok(store.settings.calendarSince > window.todayKey());

  const map = {
    today: 'scr-today', habits: 'scr-habits', progress: 'scr-progress',
    settings: 'scr-settings'
  };
  for (const [tab, id] of Object.entries(map)) {
    document.querySelector(`#tabs button[data-tab="${tab}"]`).click();
    const scr = document.getElementById(id);
    assert.equal(scr.hidden, false, tab);
    assert.ok(scr.innerHTML.length > 0, tab);
  }

  assert.match(document.getElementById('scr-habits').textContent, /Привычек пока нет/);

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

/* Выписка дня ушла с экраном «Заметки» (задача 28.C). На её место не
   встало ничего: последней строкой «Прогресса» остаётся строка разбора,
   и хвоста ниже неё у экрана больше нет. */
test('З28C: «Прогресс» без выписки дня — состав блоков прежний, хвоста нет', async () => {
  const seed = t17Seed();
  // выписки в store есть — и всё равно на экран не попадают
  seed.notes = [
    { id: 'q1', date: daysAgo(2), text: 'Кто везде — тот нигде.', kind: 'quote', source: 'Сенека', updatedAt: 2 },
    { id: 'n1', date: daysAgo(1), text: 'своя мысль', kind: 'note', source: '', updatedAt: 1 }
  ];
  const { document } = await boot({ seed });
  openProgress(document);
  const scr = document.getElementById('scr-progress');

  assert.deepEqual([...scr.querySelectorAll('.pcard > h2')].map(x => x.textContent),
    ['В системе', 'Серия', 'Цепь дней', 'Подъём', 'Отметки'], 'пять блоков, как были');
  assert.equal(scr.querySelector('.quote'), null, 'строки выписки нет');
  assert.equal(scr.querySelector('.qsrc'), null, 'и источника тоже');
  assert.doesNotMatch(scr.textContent, /Кто везде/, 'выписка на экран не просачивается');
  assert.doesNotMatch(scr.textContent, /Сенека/);

  // последняя строка экрана — строка разбора, ниже неё пусто
  const last = scr.lastElementChild;
  assert.ok(last.classList.contains('rev'), 'последней стоит строка разбора');
  assert.match(last.textContent, /Разбор недели|Следующий разбор/);
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
  // градиентов в приложении ДВА, и оба названы поимённо (задача 28.E/C,
  // п. 2.5): заливка планки дня и блик сцены закрытия. Третьего не заводить
  // без решения архитектора — счёт держится здесь намеренно
  const grads = [...css.matchAll(/[\w-]+gradient\(/g)];
  assert.equal(grads.length, 2, 'градиента два: заливка планки и блик');
  assert.match((css.match(/\.sheen\s*\{([^}]*)\}/) || [])[1] || '',
    /linear-gradient\(90deg, transparent, var\(--sheen\), transparent\)/, 'второй — блик');
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
  for (const tab of ['today', 'habits', 'settings']) {
    document.querySelector(`#tabs button[data-tab="${tab}"]`).click();
    const scr = document.getElementById('scr-' + tab);
    assert.equal(scr.hidden, false, tab);
    assert.doesNotMatch(scr.innerHTML, /NaN/, tab);
  }
  window.renderReview();
  assert.match(document.getElementById('scr-review').textContent, /Разбор откроется в понедельник/);
});

test('посев 17 в браузере: пустой localStorage через migrate даёт программу, но не выписки', async () => {
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
  assert.deepEqual(store.notes, [], 'посев выписок не заводит (задача 28.C)');
  assert.equal(store.settings.seed17, true);

  // все четыре экрана живы на засеянных данных
  for (const [tab, id] of Object.entries({
    today: 'scr-today', habits: 'scr-habits', progress: 'scr-progress',
    settings: 'scr-settings'
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

/* Донором была форма новой заметки; экран снят задачей 28.C, и предмет
   теста (импорт закрывает открытую форму и снимает её черновик) перенесён
   на форму правки пункта — она принадлежит прежним данным ровно так же. */
test('C.6.7: импорт сбрасывает форму и черновик правки пункта', async () => {
  const { document, window } = await boot();
  window.confirm = () => true;
  window.alert = m => { throw new Error('alert при импорте: ' + m); };

  // открыта форма правки пункта с начатым названием
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('#scr-settings .row.item [data-act="edit-open"]').click();
  document.getElementById('e-name').value = 'начатое название';
  document.getElementById('e-name').dispatchEvent(new window.Event('input', { bubbles: true }));
  document.querySelector('#tabs button[data-tab="settings"]').click(); // перерисовка снимает черновик в слот
  assert.equal(document.getElementById('e-name').value, 'начатое название', 'форма открыта, черновик жив');

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

  // форма принадлежала прежним данным — её и черновика больше нет
  document.querySelector('#tabs button[data-tab="settings"]').click();
  assert.equal(document.getElementById('e-name'), null, 'форма правки закрыта импортом');
  // строки ПУНКТОВ — те, что открывают правку: с задачи Р2 в «Расписании»
  // стоит и строка списка режимов (.row.item без правки пункта)
  const rows = document.querySelectorAll('#scr-settings .row.item [data-act="edit-open"]');
  assert.equal(rows.length, 1, 'в списке только пункт из файла');

  // и черновик не всплывает при следующем открытии формы
  document.querySelector('#scr-settings .row.item [data-act="edit-open"]').click();
  assert.equal(document.getElementById('e-name').value, 'Чужой пункт', 'черновик прежних данных не перенесён');
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

/* ── Задача 20, C.5: сторож разметки форм ──────────────────────
   Часть B предлагала свернуть повторяющиеся фрагменты шаблонов
   (.card.form, .btns, .field) в хелперы при жёстком условии: выдаваемая
   разметка не меняется ни на байт. Замер показал, что по gzip сворачивание
   не экономит, а добавляет (см. отчёт задачи 20 и правило веса в CLAUDE.md),
   поэтому хелперы не введены — но сторож нужен и без них: он ловит любую
   будущую правку шаблонов форм, случайную или в ходе такого рефакторинга.

   Снимок — outerHTML всех четырнадцати форм (число сверяется ассертом
   ниже; в комментарии стояло «девяти» при двенадцати формах — счёт отстал
   на пять, задача 26, п. 7.1; две формы заметок ушли с экраном, задача
   28.C; две формы формулы и форма лестницы — с листом детали, задача 28.D,
   и число снова сошлось на девяти, но уже других; «Расписание 1/3», этап C,
   добавило два вида правки действия — «свои дни» и день заведения; задача
   Р2 — две формы режима и форму блока с «в режим …»).
   Дат в формах нет, идентификаторы в сиде фиксированы,
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
    // «Утро» — будни («Расписание 1/3», этап C): у действия в режиме «свои»
    // чипы выходных недоступны, и снимок это держит. Дата отрезка в разметку
    // форм не попадает — снимок от дня прогона не зависит
    groups: [{ name: 'Утро', days: [{ from: addKey(prev, -14), mask: '1111100' }] }],
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
  const { document } = await boot({ seed: markupSeed() });
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

  // формы «Расписания» и «Привычек»: правка минимума, привычки, параметра и
  // добавление привычки. Форма добавления минимума (add-min) снята вместе с
  // кнопкой «Добавить пункт»; её место заняло быстрое добавление («Расписание
  // 1/3», п. 4.7д). Правка действия снята в трёх видах (этап C, п. 2.5):
  // «как блок» без «Типа», «свои дни» того же действия и действие дня
  // заведения — с «Типом» и чипами без блока
  settings();
  [...document.querySelectorAll('[data-act="edit-open"]')].find(b => b.dataset.id === 'fx-item').click();
  grab('edit-min');
  document.querySelector('[data-act="days-own"]').click();
  grab('edit-min-own');
  document.querySelector('[data-act="edit-cancel"]').click();
  [...document.querySelectorAll('[data-act="edit-open"]')].find(b => b.dataset.id === 'fx-habit').click();
  grab('edit-habit');
  document.querySelector('[data-act="edit-cancel"]').click();
  [...document.querySelectorAll('[data-act="edit-open"]')].find(b => b.dataset.id === 'fx-param').click();
  grab('edit-param');
  document.querySelector('[data-act="edit-cancel"]').click();
  [...document.querySelectorAll('[data-act="add-open"]')].find(b => b.dataset.area === 'habit').click();
  grab('add-habit');
  document.querySelector('[data-act="add-cancel"]').click();
  // Действие дня заведения без блока — тем путём, каким действие рождается
  // (addActions), с фиксированным id: разметка не должна плавать. Заводится
  // ПОСЛЕ снимка добавления привычки: свежий пункт владельца дал бы той форме
  // подсказку «одна новая за раз» и сдвинул бы снимок, которого этап не касался
  const [fresh] = document.defaultView.addActions('', [{ name: 'Новое действие', note: '' }]);
  fresh.id = 'fx-new';
  document.defaultView.save();
  settings();
  [...document.querySelectorAll('[data-act="edit-open"]')].find(b => b.dataset.id === 'fx-new').click();
  grab('edit-min-new');
  document.querySelector('[data-act="edit-cancel"]').click();
  [...document.querySelectorAll('[data-act="quick-open"]')].find(b => b.dataset.name === 'Утро').click();
  grab('quick');
  document.querySelector('[data-act="quick-cancel"]').click();

  // блоки (с днями и пресетами) и упражнения. «Расписание» раскрыто по
  // умолчанию: тап по его заголовку здесь свернул бы секцию
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

  // Формы режима (задача Р2) — в раскрытом списке режимов «Расписания»:
  // переименование и «Новый режим». Форма блока при втором живом режиме
  // получает «в режим …» — это третий вид, снятый отдельно; id второго режима
  // закреплён, иначе data-mode плавал бы от прогона к прогону
  document.querySelector('[data-act="mode-list"]').click();
  document.querySelector('[data-act="mode-rename-open"]').click();
  grab('mode-rename');
  document.querySelector('[data-act="mode-rename-cancel"]').click();
  document.querySelector('[data-act="mode-add-open"]').click();
  grab('mode-add');
  document.querySelector('[data-act="mode-add-cancel"]').click();
  const win = document.defaultView;
  assert.equal(win.addMode('Каникулы').ok, true);
  win.eval('store').modes[1].id = 'fx-mode';
  win.save();
  settings();
  document.querySelector('[data-act="group-open"]').click();
  grab('group-edit-modes');
  document.querySelector('[data-act="group-cancel"]').click();

  // Форм листа детали здесь больше нет: две формулы и лестница ушли
  // вместе с листом (задача 28.D). Добавление минимума ушло, быстрое
  // добавление пришло — счёт прежний; правка действия прибавила два вида
  // («Расписание 1/3», этап C) — одиннадцать; режимы (Р2) — ещё три:
  // две формы режима и форма блока с «в режим …». Снимок пересобран.
  assert.equal(Object.keys(got).length, 14, 'сняты все формы');
  assert.ok(!got['group-edit'].includes('group-dup-to') && got['group-edit-modes'].includes('data-act="group-dup-to" data-name="Утро" data-mode="fx-mode"'),
    'один режим — «Дублировать блок» прежний; два — с «в режим «Каникулы»»');
  assert.ok(got['mode-rename'].includes('id="m-name" value="Основной"') && got['mode-add'].includes('data-act="mode-add-copy"'),
    'формы режима — переименование и новый режим');
  assert.ok(got['group-edit'].includes('data-act="days-preset"'), 'форма блока — с днями и пресетами');
  assert.ok(got['group-add'].includes('data-act="day-toggle"'), 'форма добавления блока — тоже');
  // виды правки действия — действительно разные, а не три копии одного
  assert.ok(got['edit-min'].includes('data-act="days-own"') && !got['edit-min'].includes('data-act="day-toggle"'),
    '«как блок» — строкой, без чипов');
  assert.ok(got['edit-min'].includes('Тип: ежедневный') && !got['edit-min'].includes('id="e-type"'), 'не в день заведения тип — тихой строкой');
  assert.ok(got['edit-min-own'].includes('data-act="days-inherit"') && got['edit-min-own'].includes('— не в днях блока" disabled'),
    '«свои дни» — чипы, выходные недоступны');
  assert.ok(got['edit-min-new'].includes('id="e-type"') && got['edit-min-new'].includes('data-act="day-toggle"') &&
    !got['edit-min-new'].includes('days-own'), 'день заведения — «Тип»; без блока — прежние чипы');

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

/* ── Задача 21 на экранах: снята задачей 28.D ───────────────
   Здесь стоял сид «вставшей» лестницы (settledSeed) и тест дневного
   экрана: подпись пункта менялась на «Привычка встала…» и возвращалась к
   ступени при закрытии. Ни подписи-ступени, ни состояния «встала» больше
   нет — подписью снова служит item.note, и это сторожит тест З28D/10.4
   выше. Сид удалён вместе с единственным своим читателем. */

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

  // 2. уход блока (удаление снято, «Расписание 1/3», п. 4.7в)
  const groupSect = () => [...document.querySelectorAll('#scr-settings details.sect')]
    .find(d => /Расписание/.test(d.querySelector('summary').textContent));
  assert.ok(groupSect(), 'секция «Расписание» найдена');
  if (!groupSect().open) groupSect().querySelector('summary').click();
  document.querySelector('[data-act="group-open"]').click();
  document.querySelector('[data-act="group-remove"]').click();
  assert.match(document.querySelector('[data-act="group-remove"]').textContent, /Подтвердить: убрать блок/);
  away();
  // правка блока переживает уход (её никто не отменял), а подтверждение — нет
  assert.match(document.querySelector('[data-act="group-remove"]').textContent, /^Убрать блок$/);
  assert.equal(saved().groups.length, 1, 'блок на месте');
  assert.equal(saved().groups[0].removedAt, null, 'и не убран');
});

/* Прежде подпись следовала за ТУМБЛЕРОМ и обновлялась точечно, без
   перерисовки: в этом и был дефект задачи 22. Тумблер упразднён (28.E/A),
   уход пункта всегда перерисовывает «Настройки» целиком — и подпись
   обязана следовать за ним ровно так же честно. */
test('З22/5: подпись зачёта дня следует за уходом пункта', async () => {
  const { document, window } = await boot({ seed: t17Seed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const note = () => document.getElementById('thr-note');
  assert.match(note().textContent, /День зачтён, если отмечено не меньше 4 из 5\./);

  const alive = () => JSON.parse(window.localStorage.getItem(NS))
    .items.filter(i => !i.removedAt && i.type === 'daily' && i.area === 'min').length;

  removeItemThroughUi(document, 'm0');
  assert.equal(alive(), 4);
  assert.match(note().textContent, /не меньше 4 из 4\./);
  assert.equal(note().hidden, false);

  removeItemThroughUi(document, 'm1');
  assert.match(note().textContent, new RegExp('из ' + alive() + '\\.'));

  // последний убранный пункт: подпись прячется, а не врёт
  for (const id of ['m2', 'm3', 'm4']) removeItemThroughUi(document, id);
  assert.equal(alive(), 0);
  assert.equal(note().textContent, '');
  assert.equal(note().hidden, true);

  // возврат — и подпись снова говорит правду
  document.querySelector('#scr-settings [data-act="item-restore"]').click();
  assert.equal(alive(), 1);
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
  for (const tab of ['today', 'habits', 'progress', 'settings']) {
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

/* Ветка минимума у подсказки снята вместе с формой добавления минимума
   («Расписание 1/3», п. 2.4): действия заводятся быстрым добавлением,
   подсказки там нет. Предмет теста прежний — подсказку вызывают только
   пункты владельца, и она называет предмет той формы, в которой стоит. */
test('З22/7.2: подсказка «одно новое дело за раз» — только по пунктам владельца, и предмет по области', async () => {
  // засеянный store: девять пунктов одной датой — подсказки нет
  const { document, window } = await boot();
  const store = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(store.items.length, 9);
  assert.equal(new Set(store.items.map(i => i.addedAt)).size, 1, 'посев одной датой');

  document.querySelector('#tabs button[data-tab="settings"]').click();
  const addHabit = () => document.querySelector('[data-act="add-open"][data-area="habit"]');
  addHabit().click();
  assert.equal(document.querySelector('#scr-settings .hint'), null, 'посев подсказку не вызывает');
  document.querySelector('[data-act="add-cancel"]').click();

  // пункт владельца, заведённый на следующий день, — вызывает. Следующий
  // ЛОГИЧЕСКИЙ день: 24 часа в день перевода стрелок его не давали (Р2, п. 5)
  shiftWindowDays(window, 1);
  document.dispatchEvent(new window.Event('visibilitychange'));
  addHabit().click();
  document.getElementById('f-name').value = 'Своё';
  document.querySelector('[data-act="add-save"]').click();
  addHabit().click();
  assert.match(document.querySelector('#scr-settings .hint').textContent,
    /^Одна новая привычка за раз: последнее добавлено меньше 14 дней назад\.$/);
  // «правило системы» из текста ушло: такого правила в «Системе» нет
  assert.doesNotMatch(document.querySelector('#scr-settings .hint').textContent, /Правило системы/);
  document.querySelector('[data-act="add-cancel"]').click();
  // у формы, где заводится МИНИМУМ, подсказки нет вовсе — и привычкой она
  // пункт не назовёт (задача 29/A): строки минимума в приложении больше нет
  document.querySelector('[data-act="quick-open"]').click();
  assert.equal(document.querySelector('#scr-settings [data-form="quick"] .hint'), null);
  assert.doesNotMatch(APP, /Одно новое дело за раз/);
});

test('З22/7.2: стёртый store — первый пункт владельца подсказку не глушит', async () => {
  const { document, window } = await boot({ seed: trainSeed() });
  wipeThroughUi(document);
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items.length, 0);
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).settings.seed17, true);

  // секция привычек — по заголовку («Пункты» ушли, «Расписание 1/3», п. 2.3)
  const openItems = () => {
    document.querySelector('#tabs button[data-tab="settings"]').click();
    const s = [...document.querySelectorAll('#scr-settings details.sect')]
      .find(d => /^Привычки/.test(d.querySelector('summary').textContent));
    assert.ok(s, 'секция «Привычки» найдена');
    if (!s.open) s.querySelector('summary').click();
  };
  openItems();
  document.querySelector('[data-act="add-open"][data-area="habit"]').click();
  assert.equal(document.querySelector('#scr-settings .hint'), null, 'заводить пока нечего');
  document.getElementById('f-name').value = 'Первая';
  document.querySelector('[data-act="add-save"]').click();
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items.length, 1);

  // три дня спустя владелец заводит вторую — подсказка обязана показаться
  shiftWindowDays(window, 3); // логические дни, не 72 часа (Р2, п. 5)
  document.dispatchEvent(new window.Event('visibilitychange'));
  document.querySelector('[data-act="add-open"][data-area="habit"]').click();
  assert.match(document.querySelector('#scr-settings .hint').textContent,
    /последнее добавлено меньше 14 дней назад/);
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

/* Выполненный блок «Сегодня» свёрнут (задача Р2, п. 4): тесты, которым после
   закрытия блока нужны его строки, разворачивают его путём владельца —
   тапом по свёрнутой строке. Хелпер — объявлением функции: он поднимается,
   и тесты выше по файлу видят его так же, как ниже. */
function unfoldBlock(document, name) {
  const b = [...document.querySelectorAll('#scr-today [data-act="block-unfold"]')].find(x => x.dataset.name === name);
  assert.ok(b, 'свёрнутая строка блока «' + name + '»');
  b.click();
  assert.equal([...document.querySelectorAll('#scr-today [data-act="block-unfold"]')].some(x => x.dataset.name === name), false,
    'блок «' + name + '» развёрнут');
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
  // в сиде есть пункт ВНЕ сегодняшней маски (задача 29/B): без него
  // renderToday и updateDayline считали бы одинаково при любом правиле,
  // и расхождение по расписанию сторож бы не увидел
  const seed = pointSeed();
  const off = JSON.parse(JSON.stringify(seed.items[0]));
  Object.assign(off, { id: 'off1', name: 'Не сегодня', at: '',
    schedule: [{ from: seed.items[0].addedAt, mask: '0000000'.slice(0, 7) }] });
  // маска ровно без сегодняшнего дня недели
  const dow = (new Date(new Date().getTime() - 4 * 3600000).getDay() + 6) % 7;
  off.schedule[0].mask = '1111111'.split('').map((c, i) => (i === dow ? '0' : '1')).join('');
  seed.items.push(off);
  const { document, window } = await boot({ seed });
  const boxes = [...document.querySelectorAll('#scr-today input[data-act="mark"]')];
  assert.ok(boxes.length >= 2, 'есть что отмечать');
  assert.equal(document.querySelector('#scr-today [data-act="mark"][data-id="off1"]'), null,
    'пункт вне маски в список не попал');

  // изъятий больше нет: сторож сравнивает разметку целиком (задача 24, п. 7.4)
  boxes[0].click();                                   // 1 из 2
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'первая отметка');

  document.querySelectorAll('#scr-today input[data-act="mark"]')[1].click(); // все — «День закрыт»
  // Сцена закрытия дня (задача 28.E/C) навешивает класс-триггер .closing на
  // .dayline и на строку. Это транзиентная декорация, а не состояние: хук
  // снимает её сам через DAY_CLOSE_MS. Ждём конца сцены и сравниваем —
  // так сторож проверяет и разметку, и то, что след сцены не остаётся.
  // Изымать .closing из сравнения было бы слабее: изъятое не сторожится.
  assert.ok(document.querySelector('#scr-today .dayline.closing'), 'сцена играет');
  await wait(T.DAY_CLOSE_MS + T.MOTION_TAIL_MS + 40);
  assert.equal(document.querySelector('#scr-today .dayline.closing'), null, 'и след её снят');
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'день закрыт');

  // снятие — обратный путь, отдельная ветка планки. Блок «Утро» после сцены
  // свёрнут (задача Р2, п. 4) — строки возвращает тап по свёрнутой строке
  unfoldBlock(document, 'Утро');
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

/* Здесь стоял третий сторож эквивалентности — «Настройки». Его предметом
   были ДВА точечных пути этого экрана: тумблер пункта (класс .off плюс
   подпись зачёта дня) и тумблер упражнения. Оба ушли с полем active
   (задача 28.E/A, п. 2), и точечных путей на «Настройках» не осталось
   вовсе: «Убрать» и «Вернуть» идут полной перерисовкой. Сторожить
   расхождение стало нечему.

   Экранов с горячими путями снова два, и оба сторожатся выше: «Сегодня»
   (отметка, недельный счётчик) и «Привычки» (отметка, полоса недели).
   Само поведение ухода закреплено блоком «З28E/A» ниже. */

test('З28E/A: разметка после ухода пункта совпадает с перерисовкой', async () => {
  const { document, window } = await boot({ seed: pointSeed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const id = document.querySelector('#scr-settings [data-act="edit-open"]').dataset.id;
  removeItemThroughUi(document, id);
  assertSame(pointVsFull(window, 'scr-settings', 'renderSettings', MIRROR_EXCEPT), 'после ухода пункта');
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
   владелец: начатая правка пункта переживает уход на чужой вид, где
   набран черновик ДРУГОГО слота, и возврат.

   Донором второго слота была начатая заметка; экран снят задачей 28.C,
   и слотов осталось три, из которых на вкладке живёт только formDraft —
   два других принадлежат листам. Поэтому чужим видом здесь служит лист
   «Тренировка» (`trainDraft`): он ложится поверх «Сегодня» и набирается
   так же, как набиралась заметка.

   Честно о границе этого теста: слить trainDraft и formDraft в один слот
   он НЕ заметит — и заметить не может. renderAll() перерисовывает ровно
   один вид, скрытый экран сохраняет свой DOM, и snapshotOpenForm при
   возврате перечитывает черновик прямо из него; слоту нечего мостить.
   Мутант «общий слот» проверен батареей на всём наборе тестов и на
   отдельной враждебной последовательности — поведение совпадает до
   символа. Он эквивалентный, а не выживший: разделение слотов защитное,
   оно страхует от будущей правки, которая начнёт пересобирать скрытые
   экраны. Подробности — в отчёте задачи 23. */
test('З23/7.11: черновик формы «Пунктов» переживает чужой вид с собственным черновиком', async () => {
  const { document } = await boot();
  // начатая правка пункта на «Настройках»
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('[data-act="edit-open"]').click();
  document.getElementById('e-name').value = 'Начатое имя';

  // уход на «Сегодня» и лист «Тренировка» поверх него — свой слот черновика
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector('#scr-today [data-act="train-inc"]').click();
  document.getElementById('tr-note').value = 'начатая заметка тренировки';

  // возврат: правка пункта не стёрта чужим черновиком
  document.querySelector('#tabs button[data-tab="settings"]').click();
  assert.equal(document.getElementById('e-name').value, 'Начатое имя',
    'черновик формы «Пунктов» живёт в своём слоте');

  // а черновик листа принадлежал закрытому листу и не всплывает
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector('#scr-today [data-act="train-inc"]').click();
  assert.equal(document.getElementById('tr-note').value, '',
    'черновик листа ушёл вместе с листом, чужого в нём нет');
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

/* Задача 24 различала лестницы живую и закрытую: первая гасила повышение,
   вторая нет. Задача 28.D сняла различение целиком — карточку получает
   первый готовый по порядку items[], что бы ни лежало у него в поле ladder. */
test('З24/5: поле ladder карточку повышения больше не сдвигает', async () => {
  const a = await boot({ seed: reviewSeed({ params: false, ladder: { on: 'it1', value: copy(LIVE) } }) });
  openReview(a.document);
  assert.match(reviewScr(a.document).querySelector('.card.raise').textContent, /Первый/,
    'живая лестница пункт больше не пропускает');

  const b = await boot({ seed: reviewSeed({ params: false, ladder: { on: 'it1', value: copy(DONE) } }) });
  openReview(b.document);
  assert.match(reviewScr(b.document).querySelector('.card.raise').textContent, /Первый/,
    'закрытая — тем более');

  const c = await boot({ seed: reviewSeed({ params: false }) });
  openReview(c.document);
  assert.match(reviewScr(c.document).querySelector('.card.raise').textContent, /Первый/,
    'и без лестницы вовсе — тот же первый по порядку');
});

test('З24/4: два заголовка решений на месте при любых данных лестницы', async () => {
  const heads = d => [...reviewScr(d).querySelectorAll('h2')].map(x => x.textContent).filter(t => /^Решение/.test(t));
  // задача 28.D: «Ступень» снята, решений два. Правило прежнее: дыры в
  // нумерации не бывает — номер сдвинут, а не оставлен пустым
  const ALL = ['Решение 1 · Планка', 'Решение 2 · Одно изменение'];

  const none = await boot({ seed: reviewSeed({}) });
  openReview(none.document);
  assert.deepEqual(heads(none.document), ALL, 'лестницы нет вовсе');
  assert.doesNotMatch(reviewScr(none.document).textContent, /[Лл]естниц|[Сс]тупен/,
    'о лестнице и ступени в разборе не говорится ни слова');

  const l = await boot({ seed: reviewSeed({ ladder: { on: 'it1', value: copy(LIVE) } }) });
  openReview(l.document);
  assert.deepEqual(heads(l.document), ALL, 'живая лестница в данных');
  assert.doesNotMatch(reviewScr(l.document).textContent, /[Лл]естниц|[Сс]тупен/);

  const c = await boot({ seed: reviewSeed({ ladder: { on: 'it1', value: copy(DONE) } }) });
  openReview(c.document);
  assert.deepEqual(heads(c.document), ALL, 'закрытая лестница в данных');
  assert.doesNotMatch(reviewScr(c.document).textContent, /слот свободен/);

  // и карточки шага ступени нет ни в одном из трёх состояний
  for (const d of [none.document, l.document, c.document]) {
    assert.equal(reviewScr(d).querySelector('.card.step'), null);
    assert.equal(reviewScr(d).querySelector('[data-act="ladder-fwd"]'), null);
  }
});

test('З24/2: параметр — карточка в «Решении 1», шаг пишет историю и уходит в срез', async () => {
  const { document, window } = await boot({ seed: reviewSeed({}) });
  openReview(document);
  const scr = reviewScr(document);

  // порядок внутри «Решения 1»: повышение, понижение, параметры
  const kids = [...scr.children];
  const at = sel => kids.indexOf(scr.querySelector(sel));
  assert.ok(at('.card.raise') < at('.card.param'), 'параметр после планки');
  assert.ok(kids.findIndex(x => x.textContent === 'Решение 2 · Одно изменение') > at('.card.param'),
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

/* ── Задача 28.D. Лестница и формула сняты ───────────────────── */

/* п. 4.4 и 10.2: свёртка недели в трёх состояниях разведки. Прежде
   действенным решением был и шаг лестницы, и разбор, где решать было
   нечего кроме него, показывал КАРТИНУ НЕДЕЛИ ЗАКРЫТОЙ. Лестница снята —
   такой разбор открывает свёртку, как и всякий другой без решений. */
test('З28D/4: свёртка недели — лестничная часть условия ушла', async () => {
  const heads = d => [...reviewScr(d).querySelectorAll('h2')]
    .map(x => x.textContent).filter(t => /^Решение/.test(t));
  const NUM = ['Решение 1 · Планка', 'Решение 2 · Одно изменение'];

  // A: решать нечего вовсе — свёртка открыта (как и до задачи 28.D)
  const noneSeed = reviewSeed({ params: false, filled: 0 });
  for (const mon of [prevMonday(), addKey(prevMonday(), -7)]) {
    for (const it of noneSeed.items) fillWeek(noneSeed.days, it.id, mon, 5); // ни ≥6, ни ≤3
  }
  const a = await boot({ seed: noneSeed });
  openReview(a.document);
  assert.equal(reviewScr(a.document).querySelector('details.week').hasAttribute('open'), true, 'A: открыта');
  assert.deepEqual(heads(a.document), NUM);

  // B: та же неделя, но у пункта в данных ЖИВАЯ лестница, готовая шагнуть.
  // Прежде это было решением и свёртку закрывало; теперь — нет.
  const ladderSeed = reviewSeed({ params: false, filled: 0 });
  for (const mon of [prevMonday(), addKey(prevMonday(), -7)]) {
    for (const it of ladderSeed.items) fillWeek(ladderSeed.days, it.id, mon, 5);
  }
  ladderSeed.items[0].ladder = copy(LIVE);
  const b = await boot({ seed: ladderSeed });
  openReview(b.document);
  assert.equal(reviewScr(b.document).querySelector('details.week').hasAttribute('open'), true,
    'B: доступный шаг ступени решением больше не считается — свёртка открыта');
  assert.deepEqual(heads(b.document), NUM);

  // C: живая карточка планки — свёртка закрыта, как и была
  const c = await boot({ seed: reviewSeed({ params: false }) });
  openReview(c.document);
  assert.equal(reviewScr(c.document).querySelector('details.week').hasAttribute('open'), false,
    'C: решения важнее таблиц');
  assert.deepEqual(heads(c.document), NUM);
  assert.ok(reviewScr(c.document).querySelector('.card.raise'), 'и карточка повышения на месте');
});

/* п. 9.3: строка последствия стоит ПОД кнопкой. Сверху она сдвигала кнопку
   вниз ровно между тапами (замер на 375×812: 957 → 1026 px, 69 px), и
   второй тап приходился на новое место. jsdom раскладки не считает —
   проверяем ПОРЯДОК УЗЛОВ, он и есть причина сдвига. */
test('З28D/9.3: строка последствия «Закрыть неделю» стоит под кнопкой', async () => {
  const { document } = await boot({ seed: reviewSeed({ params: false }) });
  openReview(document);
  const scr = reviewScr(document);
  const btn = () => scr.querySelector('[data-act="close-week"]');

  const kidsBefore = [...scr.children];
  const iBefore = kidsBefore.indexOf(btn());
  assert.equal(btn().textContent, 'Закрыть неделю');
  assert.equal(scr.textContent.includes('Неделя уйдёт в архив'), false, 'до тапа последствия не названо');

  btn().click(); // первый тап — взвод
  const kids = [...scr.children];
  const i = kids.indexOf(btn());
  const note = [...scr.querySelectorAll('p.muted')].find(p => /Неделя уйдёт в архив/.test(p.textContent));
  assert.ok(note, 'последствие названо между тапами');
  assert.equal(btn().textContent, 'Подтвердить: закрыть неделю');
  assert.ok(kids.indexOf(note) > i, 'строка НИЖЕ кнопки — точка нажатия не уезжает');
  assert.equal(i, iBefore, 'и сама кнопка осталась на своём месте в порядке узлов');
  // но выше «Готово»: текст обязан прочитываться до ухода с листа
  assert.ok(kids.indexOf(note) < kids.indexOf(scr.querySelector('[data-act="review-done"]')));

  btn().click(); // второй тап — неделя закрыта
  assert.match(reviewScr(document).textContent, /Неделя закрыта/);
});

/* п. 3.4 и 10.5: листов два, и приоритет при одновременно взведённых
   флагах пересчитан — главнее разбор. Порядок обязан совпадать в трёх
   местах: renderAll, currentFormKey и sheetReturn. */
test('З28D/3: листов два, разом виден не больше одного, приоритет — разбор', async () => {
  const { document } = await boot({ seed: sheetSeed() });
  assert.equal(document.getElementById('scr-detail'), null, 'листа детали нет');
  const visible = () => ['scr-review', 'scr-train']
    .filter(id => !document.getElementById(id).hidden);

  assert.deepEqual(visible(), [], 'вкладка — ни одного листа');
  document.querySelector('#scr-today [data-act="train-inc"]').click();
  assert.deepEqual(visible(), ['scr-train'], 'лист тренировки один');
  document.querySelector('#scr-train [data-act="train-cancel"]').click();
  document.querySelector('#scr-today [data-act="goto-review"]').click();
  assert.deepEqual(visible(), ['scr-review'], 'лист разбора один');
  document.querySelector('#scr-review [data-act="review-done"]').click();
  assert.deepEqual(visible(), [], 'и оба закрылись');

  // Ничьи между флагами обычным путём не бывает — лист закрывает вкладку
  // целиком, — но порядок разбора решений записан в трёх местах, и все три
  // обязаны читать его одинаково. ui в контекст не экспортируется (const),
  // поэтому сверяем источник: третье место, sheetReturn, проверено выше
  // поведением (З26/4.1) — там разбор и тренировка возвращают свои скроллы.
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(app, /const sheet = ui\.reviewOpen \? 'review' : \(ui\.trainOpen \? 'train' : null\)/,
    'renderAll: разбор раньше тренировки');
  assert.match(app, /if \(!ui\.reviewOpen && ui\.trainOpen\) return 'train:'/,
    'currentFormKey: тот же порядок, и разбор перебивает');
  const ret = /function sheetReturn\(\)[\s\S]*?\n}/.exec(app)[0];
  assert.ok(ret.indexOf('ui.reviewOpen') < ret.indexOf('ui.trainOpen'),
    'sheetReturn: и здесь разбор первым');
  assert.doesNotMatch(app, /ui\.detailId/, 'состояния листа детали в файле не осталось');
});

/* п. 6.5: реалистичный store — сессия отметок и перерисовок формулу и
   лестницу не трогает. Проверяем то, что лежит в localStorage: именно он
   переживёт перезапуск. */
test('З28D/6: сессия работы формулу и лестницу в localStorage не трогает', async () => {
  const seed = dueSeed();
  seed.items[0].formula = { anchor: 'после зарядки', when: '', pair: '', identity: 'я человек, который держится', twoMin: '', friction: '', proof: '', mode: 'break' };
  seed.items[0].ladder = { steps: ['раз', 'два', 'три'], step: 1, steppedWeek: null, startedAt: addKey(prevMonday(), -30), done: false };
  seed.items[0].ladderLog = [{ date: addKey(prevMonday(), -30), step: 0, text: 'раз', start: true }];
  const { document, window } = await boot({ seed });
  const before = JSON.stringify(JSON.parse(window.localStorage.getItem(NS)).items[0]);

  // обычная сессия: отметка, обход вкладок, правка подписи, разбор
  document.querySelector('#scr-today input[data-act="mark"]').click();
  for (const t of ['habits', 'progress', 'settings', 'today']) {
    document.querySelector(`#tabs button[data-tab="${t}"]`).click();
  }
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('#scr-settings [data-act="edit-open"]').click();
  document.getElementById('e-note').value = 'новая подпись';
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  openReview(document);
  reviewScr(document).querySelector('[data-act="review-done"]').click();

  const after = JSON.parse(window.localStorage.getItem(NS)).items[0];
  assert.equal(after.note, 'новая подпись', 'правка владельца прошла');
  const b = JSON.parse(before);
  assert.deepEqual(after.formula, b.formula, 'формула байт в байт та же');
  assert.deepEqual(after.ladder, b.ladder, 'лестница тоже');
  assert.deepEqual(after.ladderLog, b.ladderLog, 'и журнал шагов');

  // и «перезапуск»: тот же localStorage поднимается заново
  const again = await boot({ raw: window.localStorage.getItem(NS) });
  const re = JSON.parse(again.window.localStorage.getItem(NS)).items[0];
  assert.deepEqual(re.formula, b.formula, 'после перезапуска формула на месте');
  assert.deepEqual(re.ladder, b.ladder);
  assert.deepEqual(re.ladderLog, b.ladderLog);
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

/* ── Задача 28.C: экран снят, данные остались ──────────────── */

/* Экрана «Заметки» больше нет, и единственный путь владельца к своим
   записям — файл экспорта. Тест смотрит в САМ отданный файл: чтение
   localStorage мимо download() пропустило бы выпадение поля из выгрузки. */
test('З28C: экран снят, а экспорт по-прежнему несёт заметки владельца', async () => {
  const seed = trainSeed();
  seed.notes = [
    { id: 'n1', date: daysAgo(1), text: 'своя мысль', kind: 'note', source: '', updatedAt: 2 },
    { id: 'q1', date: daysAgo(2), text: 'Начал — половину сделал.', kind: 'quote', source: 'Гораций', updatedAt: 1 }
  ];
  const { document, window } = await boot({ seed });

  // в интерфейсе к ним хода нет: ни вкладки, ни экрана, ни карточки
  assert.equal(document.querySelector('#tabs button[data-tab="notes"]'), null);
  assert.equal(document.getElementById('scr-notes'), null);
  assert.equal(document.querySelector('.card.note'), null);

  openData(document);
  const file = await grabDownload(window, () => document.querySelector('[data-act="export"]').click());
  const exported = JSON.parse(file.text);
  // схема поднялась до текущей, но не заметками: их снятие её не трогало
  // (28.C), номер сдвинул уход пункта (28.E/A, v17)
  assert.equal(exported.schemaVersion, SCHEMA_VERSION);
  assert.equal(exported.notes.length, 2, 'обе записи в файле');
  assert.deepEqual(exported.notes.map(n => n.text), ['своя мысль', 'Начал — половину сделал.']);
  assert.equal(exported.notes[1].source, 'Гораций', 'источник выписки цел');

  // и в хранилище они на месте после сессии без единого касания заметок
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.notes.length, 2, 'localStorage заметок не потерял');
});

/* Задача 28.D, п. 6.2: тем же приёмом, что заметки выше. Механик формулы и
   лестницы в интерфейсе нет, а экспорт остаётся единственным путём владельца
   к этим данным — оборвётся он, и полей не станет молча. */
test('З28D: механик нет, а экспорт по-прежнему несёт формулу и лестницу', async () => {
  const seed = trainSeed();
  seed.items[0].formula = { anchor: 'после зарядки', when: 'утро', pair: '', identity: 'я человек, который держится', twoMin: '', friction: '', proof: '', mode: 'break' };
  seed.items[0].ladder = { steps: ['раз', 'два', 'три'], step: 1, steppedWeek: null, startedAt: addKey(prevMonday(), -30), done: false };
  seed.items[0].ladderLog = [
    { date: addKey(prevMonday(), -30), step: 0, text: 'раз', start: true },
    { date: addKey(prevMonday(), -7), step: 1, text: 'два' }
  ];
  const { document, window } = await boot({ seed });

  // в интерфейсе к ним хода нет: ни листа, ни форм, ни кнопок
  assert.equal(document.getElementById('scr-detail'), null);
  assert.equal(document.querySelector('[data-act="item-detail"]'), null);
  assert.equal(document.querySelector('[data-act="formula-open"]'), null);
  assert.equal(document.querySelector('[data-act="ladder-open"]'), null);

  openData(document);
  const file = await grabDownload(window, () => document.querySelector('[data-act="export"]').click());
  const exported = JSON.parse(file.text);
  // как и выше: снятие механик схему не поднимало, номер сдвинул уход пункта
  assert.equal(exported.schemaVersion, SCHEMA_VERSION);
  const it = exported.items.find(i => i.id === seed.items[0].id);
  assert.equal(it.formula.anchor, 'после зарядки', 'формула в файле');
  assert.equal(it.formula.mode, 'break', 'вместе с режимом');
  assert.deepEqual(it.ladder.steps, ['раз', 'два', 'три'], 'лестница в файле');
  assert.equal(it.ladder.step, 1);
  assert.equal(it.ladderLog.length, 2, 'и журнал шагов целиком');
  assert.equal(it.ladderLog[0].start, true);

  // и в хранилище они на месте после сессии без единого касания
  const saved = JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.id === seed.items[0].id);
  assert.deepEqual(saved.ladder, it.ladder, 'localStorage лестницы не потерял');
  assert.deepEqual(saved.formula, it.formula);
});

test('З28C: импорт файла с заметками их не теряет и потерей не называет', async () => {
  const { document, window } = await boot();
  const payload = otherFile({
    notes: [
      { id: 'n1', date: daysAgo(1), text: 'своя мысль', kind: 'note', source: '', updatedAt: 2 },
      { id: 'q1', date: daysAgo(2), text: 'Кто везде — тот нигде.', kind: 'quote', source: 'Сенека', updatedAt: 1 }
    ]
  });
  const text = await importThroughUi(document, window, payload);
  assert.doesNotMatch(text, /Не будет прочитано/, 'ни одна запись не отброшена');

  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.notes.length, 2, 'обе записи импортированы');
  assert.deepEqual(saved.notes.map(n => n.kind), ['note', 'quote']);
  assert.equal(saved.notes[1].source, 'Сенека');
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

test('З25/6: строка нечитаемых данных появляется, скачивается и стирается вторым тапом', async () => {
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

  // «Стереть нечитаемое» — вторым тапом
  row().querySelector('[data-act="corrupt-drop"]').click();
  assert.match(row().textContent, /Подтвердить: стереть нечитаемое/);
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

  // то же для «Стереть» нечитаемых данных: взведённое подтверждение гаснет
  const b = await boot({ raw: '{битый json' });
  openData(b.document);
  b.document.querySelector('[data-act="corrupt-drop"]').click();
  assert.match(b.document.querySelector('[data-act="corrupt-drop"]').textContent, /Подтвердить/);
  await importThroughUi(b.document, b.window, otherFile());
  openData(b.document);
  assert.match(b.document.querySelector('[data-act="corrupt-drop"]').textContent, /^Стереть нечитаемое$/);
  assert.ok(b.window.localStorage.getItem('minimum:data:corrupt'), 'данные на месте');
});

test('З25/6: взведённое «Стереть нечитаемое» не переживает уход с экрана', async () => {
  const { document } = await boot({ raw: '{битый json' });
  openData(document);
  document.querySelector('[data-act="corrupt-drop"]').click();
  assert.match(document.querySelector('[data-act="corrupt-drop"]').textContent, /Подтвердить/);
  document.querySelector('#tabs button[data-tab="today"]').click(); // resetConfirms()
  openData(document);
  assert.match(document.querySelector('[data-act="corrupt-drop"]').textContent, /^Стереть нечитаемое$/);
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
    notes: [],
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

  // блок: секция — «Расписание», якорь — карточка блока, а не строка
  // («Расписание 1/3», пп. 2.3–2.4)
  assert.ok(openSect(document, /Расписание/), 'секция «Расписание» найдена');
  [...document.querySelectorAll('[data-act="group-open"]')].find(x => x.dataset.name === 'Вечер').click();
  document.getElementById('g-name').value = 'Ночь';
  document.querySelector('[data-act="group-save"]').click();
  let flash = document.querySelector('#scr-settings .flash');
  assert.equal(flash.closest('.bcard').dataset.dragId, 'Ночь', 'подтверждение у переименованного блока');
  assert.equal(flash.closest('.bbody'), null, 'у шапки, а не в теле карточки');

  // упражнение
  openSect(document, /Упражнения/);
  document.querySelector('[data-act="ex-open"]').click();
  document.getElementById('x-name').value = 'Жим стоя';
  document.querySelector('[data-act="ex-save"]').click();
  flash = document.querySelector('#scr-settings .flash');
  assert.equal(flash.closest('.rowwrap').dataset.dragId, 'f-ex');

  // пункт. Третьей формой здесь была формула в листе детали; лист снят
  // задачей 28.D, и его якорь ушёл вместе с ним — механизм не изменился
  document.querySelector('#tabs button[data-tab="settings"]').click();
  byId(document, 'edit-open', 'f-1').click();
  document.getElementById('e-name').value = 'Переименованный';
  document.querySelector('[data-act="edit-save"]').click();
  flash = document.querySelector('#scr-settings .flash');
  assert.ok(flash, 'подтверждение на «Пунктах»');
  assert.ok(flash.closest('.rowwrap').textContent.includes('Переименованный'),
    'у той строки, которой принадлежала форма');
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
  // Форма добавления минимума снята («Расписание 1/3», п. 2.4): её строки
  // перенесены на то, чем минимум заводится теперь, — быстрое добавление, —
  // и на форму добавления привычки, где осталось поле «Название»
  { name: 'добавление привычки', open: d => d.querySelector('[data-act="add-open"][data-area="habit"]').click(),
    field: 'f-name', bad: '', save: 'add-save', say: /Название не заполнено/,
    pre: d => { d.getElementById('f-note').value = 'подпись'; } },
  { name: 'быстрое добавление — ни одной строки', open: d => d.querySelector('[data-act="quick-open"]').click(),
    field: 'q-lines', bad: '  \n   \n', save: 'quick-save', say: /Ни одной строки/ },
  // одна таблица отказов на правку и добавление блока (п. 1.4): прежние
  // «Блок с таким именем уже есть» и «Это имя уже занято» слились в одну фразу
  { name: 'правка блока', sect: /Расписание/, open: d => d.querySelector('[data-act="group-open"]').click(),
    field: 'g-name', bad: 'Вечер', save: 'group-save', say: /Это имя уже занято/ },
  { name: 'добавление блока', sect: /Расписание/, open: d => d.querySelector('[data-act="group-add-open"]').click(),
    field: 'g-add', bad: 'Утро', save: 'group-add-save', say: /Это имя уже занято/ },
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
  // Якорь у каждой формы свой (Р1/ревью): у пункта и упражнения — ИХ строка
  // (row — id правленой строки, у форм добавления — строка с новым именем),
  // у блока — шапка его карточки (card). Общее «.rowwrap или .bcard»
  // пропускало узел, выпавший из строки недельного счётчика в список карточки
  const OK = [
    { name: 'правка пункта', open: d => byId(d, 'edit-open', 'f-1').click(), field: 'e-name', good: 'Первый+', save: 'edit-save', row: 'f-1' },
    { name: 'правка недельного', open: d => byId(d, 'edit-open', 'f-w').click(), field: 'e-goal', good: '4', save: 'edit-save', row: 'f-w' },
    // добавление минимума — быстрой формой, у неё своё подтверждение
    // («Добавлено: N»), и оно проверяется тестами «Р1/» ниже
    { name: 'добавление привычки', open: d => d.querySelector('[data-act="add-open"][data-area="habit"]').click(), field: 'f-name', good: 'Новая', save: 'add-save', row: null },
    { name: 'правка блока', sect: /Расписание/, open: d => d.querySelector('[data-act="group-open"]').click(), field: 'g-name', good: 'Рассвет', save: 'group-save', card: 'Рассвет' },
    { name: 'добавление блока', sect: /Расписание/, open: d => d.querySelector('[data-act="group-add-open"]').click(), field: 'g-add', good: 'День', save: 'group-add-save', card: 'День' },
    { name: 'правка упражнения', sect: /Упражнения/, open: d => d.querySelector('[data-act="ex-open"]').click(), field: 'x-name', good: 'Жим узким', save: 'ex-save', row: 'f-ex' },
    { name: 'добавление упражнения', sect: /Упражнения/, open: d => d.querySelector('[data-act="ex-add-open"]').click(), field: 'x-add-name', good: 'Присед', save: 'ex-add-save', row: null }
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
    // у блока «строка записи» — его карточка («Расписание 1/3», п. 2.4), и
    // узел стоит у шапки, а не в теле карточки
    if (f.card) {
      assert.equal(flash.closest('.bcard').dataset.dragId, f.card, `${f.name}: узел в карточке блока`);
      assert.equal(flash.closest('.bbody'), null, `${f.name}: у шапки, а не в теле карточки`);
      assert.equal(flash.closest('.rowwrap'), null, `${f.name}: не в строке действия`);
    } else {
      const row = flash.closest('.rowwrap');
      assert.ok(row, `${f.name}: узел у строки записи`);
      if (f.row) assert.equal(row.dataset.dragId, f.row, `${f.name}: у той самой строки`);
      else assert.ok(row.textContent.includes(f.good), `${f.name}: у строки нового пункта`);
    }
  }
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

/* Листов ДВА: третий, лист детали пункта, снят задачей 28.D вместе с
   формулой и лестницей. Правила закрытия и возврата у оставшихся прежние. */
const SHEETS = [
  { name: 'разбор недели', tab: 'today', screen: 'scr-review',
    open: d => d.querySelector('#scr-today [data-act="goto-review"]').click(), act: 'goto-review' },
  { name: 'тренировка', tab: 'today', screen: 'scr-train',
    open: d => d.querySelector('#scr-today [data-act="train-inc"]').click(), act: 'train-inc' }
];

/* Сид, в котором на «Сегодня» разом есть оба входа в листы */
function sheetSeed() {
  const seed = dueSeed();
  seed.items.push({
    id: 'sw', name: 'Тренировка', value: null, unit: '', type: 'weekly', area: 'min',
    goal: 3, note: '', group: '', active: true, addedAt: addKey(prevMonday(), -14),
    raiseAfter: 0, history: []
  });
  return seed;
}

test('З26/4.1: оба листа возвращают скролл и при закрытии таб-баром', async () => {
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
  document.querySelector('#scr-today [data-act="goto-review"]').click();
  const tabs = [...document.querySelectorAll('#tabs button')];
  assert.equal(tabs.length, 4);
  for (const t of tabs) {
    assert.equal(t.disabled, false);
    assert.equal(t.getAttribute('aria-hidden'), null);
    assert.equal(t.getAttribute('tabindex'), null, 'таб-бар из фокусного обхода не изымается');
  }
  assert.equal(document.querySelector('#tabs').getAttribute('inert'), null);
});

/* ── п. 5: отделка, замером по объявлениям ─────────────────── */

const CSS_SRC = () => fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/* ── A.2.3: акцентного ТЕКСТА на «Настройках» нет ─────────────
   `.hist` — история планки, нагрузки и порога — печаталась акцентом и
   читалась как объявление, хотя это справка: в списке из девяти строк
   светилась половина. Акцент на «Настройках» остаётся только у активной
   вкладки таб-бара и у primary-кнопки открытой формы (это КОНТРОЛЫ, и
   конституция называет их носителями акцента отдельно).

   Сторож читает исходник CSS: jsdom значения var() не разрешает, а
   предмет проверки — именно объявление. Мутант 29A-акцент-вернулся-в-справку. */
test('З29A/2: история планки на «Настройках» — muted, а не акцент', () => {
  const css = CSS_SRC();
  const rule = css.match(/\.hist\s*\{[^}]*\}/);
  assert.ok(rule, 'правило .hist есть в styles.css');
  assert.match(rule[0], /color:\s*var\(--muted\)/, '.hist — справка, тон muted');
  assert.doesNotMatch(rule[0], /var\(--accent\)/, 'акцент из справки снят (задача 29/A)');
});
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
  // второй градиент завёлся осознанно — блик сцены закрытия дня
  // (задача 28.E/C, п. 2.5); у планки он по-прежнему один
  assert.equal((css.match(/linear-gradient/g) || []).length, 2,
    'градиента два: заливка планки и блик сцены (CLAUDE.md)');
  assert.equal((css.match(/linear-gradient\(90deg, var\(--accent\), var\(--chain\)\)/g) || []).length, 1,
    'градиент планки — один и тот же на оба экрана');

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
/* .idetail ушёл из списка вместе с хвостовой кнопкой строки дня (задача
   28.D): тач-цели больше нет, а её правило :active снято из styles.css.
   Сторож двусторонний — селектор, оставшийся в списке без цели на экранах,
   валит второй тест ниже. */
/* .bfold — свёрнутый выполненный блок «Сегодня» (задача Р2, п. 4): строка
   во всю ширину, не .btn, и отклик у неё общего правила :active. */
const TAPPABLE = ['.btn', '.banner:not(.static)', '.dot', '.undo',
  '.itxt', '.bfold', '.sect > summary', '#tabs button'];

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
const EXEMPT = ['input', 'select', 'label.row.check', '.banner.static'];

/* Обход живого DOM, а не сверка со списком: любая будущая тач-цель без
   отклика на нажатие валит этот тест сама, без правки списка (п. 10.6). */
test('З26/6.1: ни одной тач-цели без отклика на нажатие на всех экранах и листах', async () => {
  const seed = sheetSeed();
  seed.exercises = [{ id: 'sx', name: 'Жим', unit: 'кг', value: 60, history: [], active: true, addedAt: addKey(prevMonday(), -14) }];
  seed.days[daysAgo(2)] = { it1: true }; // пункт начат, вчера пропуск — будет точка
  // «Расписание 1/3», п. 4.1: карточка блока, убранный блок в «Убранных» —
  // у них свои цели (шеврон свёртки, «Вернуть» блока)
  seed.groups = [{ name: 'Утро', caption: '7:00' }, { name: 'Прежний', removedAt: daysAgo(3) }];
  seed.items[0].group = 'Утро';
  // будний блок без действий — цель для формы правки в режиме «свои дни»
  // (этап C): в нём у действия есть недоступные чипы выходных
  seed.groups.push({ name: 'Будни', days: [{ from: addKey(prevMonday(), -14), mask: '1111100' }] });
  // задача Р2: второй живой режим и убранный — у списка режимов свои цели
  // («Выбрать», «Переименовать», «Убрать», «Вернуть», «Новый режим»), у формы
  // блока — «в режим …»
  seed.modes = [{ id: 'main', name: 'Основной', removedAt: null }, { id: 'kan', name: 'Каникулы', removedAt: null },
    { id: 'old', name: 'Старый', removedAt: daysAgo(3) }];
  // задача Р2, п. 4: выполненный блок «Сегодня» свёрнут в строку — у неё своя
  // цель («block-unfold»). Блок «Вечер» с одним действием, отмеченным сегодня
  seed.groups.push({ name: 'Вечер', caption: 'до 22:30' });
  seed.items.push({ id: 'it9', name: 'Душ', value: null, unit: '', type: 'daily', goal: null, note: '',
    group: 'Вечер', active: true, addedAt: addKey(prevMonday(), -14), raiseAfter: 0, history: [] });
  seed.days[daysAgo(0)] = { it9: true };
  // задача Р3: ожидающий воркер — «Обновить» в строке над экранами, а в
  // «Системе» — «Проверить обновления» и «Обновить» в строке результата
  const sw = fakeSW({ waiting: new FakeWorker('minimum-v49', 'installed') });
  const { document } = await boot({ seed, sw });
  assert.ok(document.querySelector('#scr-today [data-act="block-unfold"]'), 'на «Сегодня» есть свёрнутый блок');
  await waitFor(() => document.querySelector('#update-note [data-act="update-apply"]'), 'предложение обновления');

  const seen = new Set();
  const scan = () => {
    // #update-note стоит вне экранов — его цели обходятся отдельно (задача Р3)
    for (const el of document.querySelectorAll('section.screen:not([hidden]) [data-act], section.screen:not([hidden]) button, #update-note:not([hidden]) button, #tabs button, #tabs summary')) {
      if (EXEMPT.some(s => el.matches(s))) continue;
      const hit = TAPPABLE.find(s => el.matches(s));
      assert.ok(hit, `тач-цель без отклика на нажатие: <${el.tagName.toLowerCase()} class="${el.className}" data-act="${el.dataset.act || ''}">`);
      seen.add(hit);
    }
  };

  for (const t of ['today', 'habits', 'progress', 'settings']) {
    document.querySelector(`#tabs button[data-tab="${t}"]`).click();
    if (t === 'settings') {
      [...document.querySelectorAll('#scr-settings details.sect')].forEach(d => { if (!d.open) d.querySelector('summary').click(); });
    }
    scan();
  }
  // строка результата «Проверить обновления» с найденной версией (задача Р3)
  document.querySelector('#scr-settings [data-act="update-check"]').click();
  await waitFor(() => document.querySelector('#update-check [data-act="update-apply"]'), 'результат проверки');
  scan();
  // формы «Расписания» несут свои цели — чипы дней, пресеты, «Дублировать»,
  // «Убрать блок», поле быстрого добавления; обход открывает каждую (п. 4.1)
  document.querySelector('#tabs button[data-tab="settings"]').click();
  for (const open of ['group-open', 'group-add-open', 'quick-open']) {
    document.querySelector(`#scr-settings [data-act="${open}"]`).click();
    assert.ok(document.querySelector('#scr-settings [data-form]'), 'форма открыта: ' + open);
    scan();
  }
  // список режимов и обе его формы (задача Р2)
  document.querySelector('#scr-settings [data-act="mode-list"]').click();
  assert.equal(document.getElementById('mode-list').hidden, false, 'список режимов раскрыт');
  assert.ok(document.querySelector('#scr-settings [data-act="mode-restore"]'), 'и в нём убранный режим');
  document.querySelector('#scr-settings [data-act="mode-remove"]').click(); // взведённое «Подтвердить: убрать»
  scan();
  for (const open of ['mode-rename-open', 'mode-add-open']) {
    document.querySelector(`#scr-settings [data-act="${open}"]`).click();
    assert.ok(document.querySelector('#scr-settings [data-form^="mode-"]'), 'форма открыта: ' + open);
    scan();
  }
  document.querySelector('#scr-settings [data-act="group-open"]').click();
  assert.ok(document.querySelector('#scr-settings [data-act="group-dup-to"]'), '«в режим …» в форме блока');
  scan();
  // форма правки действия: «как блок» («Свои дни»), затем «свои дни» в
  // будничном блоке — чипы, из них выходные недоступны, и «Как блок» (этап C)
  document.querySelector('#scr-settings [data-act="edit-open"][data-id="it1"]').click();
  assert.ok(document.querySelector('#scr-settings [data-form="edit"] [data-act="days-own"]'), 'режим «как блок»');
  scan();
  const pickSel = document.getElementById('e-group');
  pickSel.value = 'Будни';
  pickSel.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  document.querySelector('#scr-settings [data-act="days-own"]').click();
  assert.ok(document.querySelector('#scr-settings [data-form="edit"] .days .btn.day:disabled'), 'в режиме «свои» есть недоступные чипы');
  assert.ok(document.querySelector('#scr-settings [data-form="edit"] [data-act="days-inherit"]'), 'и «Как блок»');
  scan();
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector('#scr-today [data-act="miss-note"]').click(); // раскрытая подпись даёт «отметить»
  scan();
  for (const s of ['scr-review', 'scr-train']) {
    document.querySelector('#tabs button[data-tab="today"]').click();
    const open = { 'scr-review': 'goto-review', 'scr-train': 'train-inc' }[s];
    document.querySelector(`#scr-today [data-act="${open}"]`).click();
    scan();
  }
  // и список не ветшает: каждая перечисленная тач-цель где-то действительно есть
  for (const sel of TAPPABLE) assert.ok(seen.has(sel), `${sel} — селектор в списке, но на экранах не встречается`);
});

/* ── Разбор объявлений движения (задача 28.E/C, п. 3) ─────────
   В сторожах было ДВЕ дыры, и обе молчали.

   1. Регулярка /transition:[^;]*?([\d.]+)s/ брала ТОЛЬКО ПЕРВОЕ число
      объявления. У многосвойственного перехода (.card.leaving — пять
      свойств) проверялась одна длительность из пяти, а ФАЗОВАЯ ЗАДЕРЖКА
      не проверялась вовсе: она стоит вторым числом.
   2. /animation:\s*([\w-]+)\s+([\d.]+)s/ требовала имя анимации ПЕРВЫМ
      в сокращённой записи. `animation: .2s ease-out day-ring` — законная
      запись, и на ней тест молча не находил ничего.

   Разбор ниже чинит оба: значение делится запятыми на части, в каждой
   первое время — длительность, второе — задержка (так их читает CSS
   независимо от порядка прочих ключевых слов), имя ищется как первый
   идентификатор, не являющийся ключевым словом. */
const ANIM_WORDS = new Set(['none', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out',
  'step-start', 'step-end', 'cubic-bezier', 'steps', 'infinite', 'normal', 'reverse',
  'alternate', 'alternate-reverse', 'forwards', 'backwards', 'both', 'running', 'paused',
  'important', 'inherit', 'initial', 'unset', 'all', 'var', 's', 'ms']);

/* Все объявления свойства prop в файле, значением (без «;» и «}») */
const declValues = (css, prop) =>
  [...css.matchAll(new RegExp('(?:^|[;{\\s])' + prop + ':([^;}]*)', 'g'))].map(m => m[1]);

/* Части объявления: [{ dur, delay, name, raw }]. Части без времени
   (`transition: none`) отбрасываются — гасить нечего. */
function motionParts(value) {
  return value.split(',')
    .reduce((acc, chunk) => { // запятые внутри cubic-bezier()/rgba() не режут часть
      const open = acc.length ? (acc[acc.length - 1].match(/\(/g) || []).length : 0;
      const close = acc.length ? (acc[acc.length - 1].match(/\)/g) || []).length : 0;
      if (acc.length && open > close) acc[acc.length - 1] += ',' + chunk; else acc.push(chunk);
      return acc;
    }, [])
    .map(part => {
      const ts = [...part.matchAll(/(-?[\d.]+)s(?![\w-])/g)].map(m => Math.round(+m[1] * 1000));
      const words = [...part.matchAll(/[a-zA-Z][\w-]*/g)].map(m => m[0])
        .filter(w => !ANIM_WORDS.has(w));
      return { dur: ts[0], delay: ts.length > 1 ? ts[1] : 0, name: words[0] || null, raw: part.trim() };
    })
    .filter(x => x.dur !== undefined);
}

test('З28E/C.3: разбор объявлений движения видит все времена и имя не первым', () => {
  // многосвойственный переход: пять длительностей, а не одна
  const many = motionParts(' max-height .24s ease-in, opacity .21s ease-in, transform .19s ease-in');
  assert.deepEqual(many.map(x => x.dur), [240, 210, 190], 'все длительности, не только первая');
  // фазовая задержка — второе время
  const delayed = motionParts(' transform .2s ease-out .06s');
  assert.deepEqual([delayed[0].dur, delayed[0].delay], [200, 60], 'задержка прочитана');
  // имя анимации в любой позиции сокращённой записи
  assert.equal(motionParts(' .24s ease-out .1s day-sheen')[0].name, 'day-sheen');
  assert.equal(motionParts(' scr-fade .24s ease-out')[0].name, 'scr-fade');
  assert.equal(motionParts(' .24s cubic-bezier(.4, 0, .2, 1) wave')[0].name, 'wave', 'запятые в скобках не режут');
  // «none» времени не несёт и в разбор не попадает
  assert.deepEqual(motionParts(' none'), []);
});

test('З26/6.3: все переходы движения — в окне 180–260 мс', () => {
  const css = CSS_SRC();
  const trans = declValues(css, 'transition').flatMap(motionParts);
  // было 10 частей; две ушли с тумблером (задача 28.E/A), зато разбор теперь
  // видит ВСЕ свойства многосвойственных переходов, а не только первое
  assert.ok(trans.length >= 12, `переходы найдены: ${trans.length}`);
  for (const t of trans) {
    assert.ok(t.dur >= 180 && t.dur <= 260, `переход «${t.raw}» — ${t.dur} мс вне окна 180–260`);
  }
  // анимации-отклики тоже; flash-note — не переход движения, а появление,
  // удержание и уход, и конституция считает его отдельно
  const anims = declValues(css, 'animation').flatMap(motionParts)
    .filter(a => a.name !== 'flash-note');
  assert.ok(anims.length >= 4, `анимации найдены: ${anims.length}`);
  for (const a of anims) {
    assert.ok(a.dur >= 180 && a.dur <= 260, `анимация «${a.raw}» — ${a.dur} мс вне окна`);
  }
  // таб-бар был единственным нарушителем: .16s ease
  assert.doesNotMatch(css, /transition:\s*color\s*\.16s/);
});

test('З28E/C.1.6: фазы сцены закрытия дня — каждая ≤ 240 мс, сцена ≤ 360 мс', () => {
  const css = CSS_SRC();
  const all = declValues(css, 'transition').concat(declValues(css, 'animation')).flatMap(motionParts);
  const delayed = all.filter(x => x.delay > 0);
  // задержки в файле есть ТОЛЬКО у сцены закрытия дня: фазовая раскадровка
  // — её единственное применение, и заводить вторую без решения архитектора
  // нельзя. Прежний сторож задержек не видел вовсе
  assert.equal(delayed.length, 3, `фаз с задержкой ровно три: ${delayed.map(x => x.raw).join(' | ')}`);
  assert.deepEqual(delayed.map(x => x.name).sort(), ['day-ring', 'day-sheen', 'day-word']);
  for (const ph of delayed) {
    assert.ok(ph.dur <= 240, `фаза «${ph.name}» длится ${ph.dur} мс — больше 240`);
    assert.ok(ph.delay + ph.dur <= 360, `фаза «${ph.name}» кончается на ${ph.delay + ph.dur} мс — сцена длиннее 360`);
  }
  // и первая фаза сцены — отклик круга на касание — стоит на t = 0
  const pop = motionParts(declValues(css, 'animation').find(v => /tap-pop/.test(v)))[0];
  assert.equal(pop.delay, 0, 'отклик на касание не имеет права опаздывать');
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
  // «одно изменение за раз» названо тем, чем оно ДЕЙСТВИТЕЛЬНО держится.
  // Прежде текст называл и лестницу («лестница одна»); механика снята
  // задачей 28.D, и обещать её больше нельзя
  assert.match(sys, /повышение планки одно за разбор/);
  assert.doesNotMatch(sys, /лестниц/i, '«Система» о снятой механике не говорит');
  assert.doesNotMatch(sys, /ступен/i);
  assert.doesNotMatch(sys, /формул/i);

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
  // задача 28.D: листов снова два — лист детали снят вместе с формулой и
  // лестницей. Комментарий обязан называть их число верно
  assert.doesNotMatch(app, /три листа поверх них/);
  assert.match(app, /ДВА листа поверх них/);
  // счёт форм в комментарии сторожа сходится с его же ассертом (было «девяти»;
  // «Расписание 1/3», этап C, добавило два вида правки действия — одиннадцать;
  // задача Р2 — две формы режима и форму блока с «в режим …» — четырнадцать)
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
  // с задачи 29/B у правила два селектора: будущий день и день ВНЕ РАСПИСАНИЯ
  const fut = ruleOf(css, '.hstrip i.off');
  assert.match(fut, /visibility:\s*hidden/);
  assert.doesNotMatch(fut, /opacity/);
  assert.match(css, /\.hstrip i\.fut,\s*\n?\.hstrip i\.off \{/, 'будущее и вне расписания — одна идиома');
  // идиома та же, что в цепи дней «Прогресса», и там же третье состояние
  assert.match(css, /\.cdays i\.fut,[\s\S]{0,400}?\.cdays i\.off \{[^}]*visibility:\s*hidden/);
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

/* Вторым экраном, рождающим узел, была форма заметки; экран снят задачей
   28.C, и её место занял лист детали — он тоже section.screen и тоже
   подпадает под чистку скрытых экранов. */
test('З27/4.1: узел подтверждения ищется на видимом экране, а не по всему документу', async () => {
  const { document } = await boot();
  // 1) сохраняем упражнение — узел рождается в секции «Упражнения».
  // Прежде первым шагом стояло сохранение формулы в листе детали; лист снят
  // задачей 28.D, и на его месте — соседняя секция того же экрана
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const exSect = [...document.querySelectorAll('#scr-settings details.sect')]
    .find(d => /Упражнения/.test(d.querySelector('summary').textContent));
  exSect.querySelector('summary').click();
  document.querySelector('#scr-settings [data-act="ex-add-open"]').click();
  document.getElementById('x-add-name').value = 'Жим';
  document.querySelector('#scr-settings [data-act="ex-add-save"]').click();
  assert.ok(document.querySelector('#scr-settings .flash'), 'узел на «Настройках»');

  // 2) уходим на «Сегодня» и обратно: узлы скрытого экрана снимаются перерисовкой
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.equal(document.querySelectorAll('#scr-settings .flash').length, 0,
    'на скрытом экране узлов не остаётся (п. 4.2)');
  document.querySelector('#tabs button[data-tab="settings"]').click();

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
  // перерисовка по чужому поводу: степпер порога зачёта дня (тумблер, стоявший
  // здесь прежде, упразднён задачей 28.E/A)
  document.querySelector('#scr-settings [data-act="thr-inc"]').click();
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
  // «Прогресс» идёт в разметке РАНЬШЕ «Настроек»: кладём туда чужой узел уже
  // ПОСЛЕ перерисовки — иначе его снимет чистка скрытых экранов (п. 4.2)
  const stale = document.createElement('p');
  stale.className = 'flash';
  stale.textContent = 'чужое';
  document.getElementById('scr-progress').appendChild(stale);
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
  // заводится привычкой: форма добавления осталась только у неё (п. 4.7б)
  document.querySelector('#scr-settings [data-act="add-open"][data-area="habit"]').click();
  document.getElementById('f-name').value = 'Новый после чистки';
  document.querySelector('#scr-settings [data-act="add-save"]').click();
  document.querySelector('#tabs button[data-tab="settings"]').click();

  document.querySelector('[data-act="wipe-drop"]').click(); // взвели «Стереть копию»
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

test('З28A/1.3: нечитаемая копия скачивается и стирается вторым тапом вместе со снапшотом', async () => {
  const idb = new IDBFactory();
  await idbPut(idb, { json: '{обрыв', savedAt: 1, schemaVersion: 16 });
  const { document, window } = await boot({ idb });
  openData(document);

  // «Скачать» отдаёт сырую строку, а не разобранный store
  let given = null;
  window.URL.createObjectURL = (blob) => { given = blob; return 'blob:fake'; };
  document.querySelector('[data-act="corrupt-save"][data-src="mirror"]').click();
  assert.ok(given, 'скачивание запущено');

  // «Стереть нечитаемое» — вторым тапом
  const drop = () => document.querySelector('[data-act="corrupt-drop"][data-src="mirror"]');
  drop().click();
  assert.match(drop().textContent, /Подтвердить: стереть нечитаемое/, 'первый тап только взводит');
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
  // считаем СОБСТВЕННОЕ правило подписи, с начала строки: правило сцены
  // закрытия дня (.dayline.closing .bar-note) — про движение, не про высоту
  assert.equal((CSS_SRC().match(/(?:^|\n)\.bar-note\s*\{/g) || []).length, 1, 'правило одно на оба экрана');
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

/* 8.4. Формы «Настроек»: общий вид по всем сочетаниям. Быстрое добавление
   («Расписание 1/3», п. 4.7е) — седьмая форма экрана и в переборе тоже;
   кнопка добавления пункта — с областью: без неё селектор теперь ничего не
   значит (п. 4.7б). */
const SETTINGS_FORMS = [
  { key: 'пункт-правка', act: 'edit-open', field: 'e-name' },
  { key: 'пункт-добавить', act: 'add-open', area: 'habit', field: 'f-name' },
  { key: 'быстрое', act: 'quick-open', field: 'q-lines' },
  { key: 'блок-правка', act: 'group-open', field: 'g-name' },
  { key: 'блок-добавить', act: 'group-add-open', field: 'g-add' },
  { key: 'упр-правка', act: 'ex-open', field: 'x-name' },
  { key: 'упр-добавить', act: 'ex-add-open', field: 'x-add-name' },
  // формы режима (задача Р2) живут в раскрываемом списке режимов: list —
  // сначала раскрыть его, как это сделал бы владелец
  { key: 'режим-имя', act: 'mode-rename-open', field: 'm-name', list: true },
  { key: 'режим-новый', act: 'mode-add-open', field: 'm-add', list: true }
];
const formBtn = f => `#scr-settings [data-act="${f.act}"]` + (f.area ? `[data-area="${f.area}"]` : '');
function openSettingsFormVia(document, f) {
  if (f.list && document.getElementById('mode-list').hidden) document.querySelector('#scr-settings [data-act="mode-list"]').click();
  document.querySelector(formBtn(f)).click();
}

function openAllSettingsSections(document) {
  for (const re of [/Расписание/, /Привычки/, /Упражнения/]) {
    const s = [...document.querySelectorAll('#scr-settings details.sect')]
      .find(x => re.test(x.querySelector('summary').textContent));
    assert.ok(s, 'секция найдена: ' + re);
    if (!s.open) s.querySelector('summary').click();
  }
}

test('З28B/4: на «Настройках» форма одна, и черновик прежней цел — все 72 сочетания', async () => {
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
      openSettingsFormVia(document, a);
      const inp = document.getElementById(a.field);
      assert.ok(inp, `${a.key}: форма открыта`);
      inp.value = 'ЧЕРНОВИК';
      openSettingsFormVia(document, b);
      const forms = [...document.querySelectorAll('#scr-settings [data-form]')];
      assert.equal(forms.length, 1, `${a.key} → ${b.key}: на экране одна форма`);
      assert.equal(document.getElementById(a.field), null, `${a.key} → ${b.key}: первая закрыта`);
      // возврат к первой: набранное на месте
      openSettingsFormVia(document, a);
      assert.equal(document.getElementById(a.field).value, 'ЧЕРНОВИК',
        `${a.key} → ${b.key}: черновик первой формы цел`);
    }
  }
  // семь форм задачи 28.B и «Расписания 1/3» плюс две формы режима (Р2): 9 · 8
  assert.equal(пар, 72, 'проверены все сочетания');
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


/* ══ Задача 28.E, часть A: уход пункта ════════════════════════
   Тумблер упразднён, «Убрать» живёт в форме правки и просит второго
   тапа. Прошлое от ухода не двигается — это доказано доменным уровнем
   (З28E/A.7.1–A.7.5); здесь предмет — разметка, порядок узлов и обе
   дороги назад. */

test('З28E/A.3: «Убрать» — второй тап, последствие ПОД кнопкой, строка уходит', async () => {
  const { document, window } = await boot({ seed: t17Seed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const rows = () => [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')];
  assert.equal(rows().length, 5);

  rows()[0].click();
  const rm = () => document.querySelector('#scr-settings [data-act="item-remove"]');
  assert.ok(rm(), '«Убрать» — в форме правки, а не в строке');
  assert.equal(document.querySelector('.row.item [data-act="item-remove"]'), null,
    'в строке кнопки нет: на 375 px там нет места');
  assert.equal(rm().textContent, 'Убрать');

  // первый тап: взводит и печатает последствие. Узел последствия стоит
  // ПОСЛЕ блока кнопок — иначе он сдвинул бы кнопку вниз между тапами
  rm().click();
  assert.equal(rm().textContent, 'Подтвердить: убрать');
  const btns = rm().closest('.btns');
  // «Убрать» — ОДИН в своём ряду. В общем ряду с «Сохранить» и «Отменой»
  // надпись «Подтвердить: убрать» переносила кнопку на следующую строку
  // flex-обёртки и уводила её вниз на 54 px (замер в браузере, 375×812) —
  // ровно между первым и вторым тапом
  assert.deepEqual([...btns.children].map(x => x.dataset.act), ['item-remove']);
  assert.deepEqual([...btns.previousElementSibling.children].map(x => x.dataset.act),
    ['edit-save', 'edit-cancel'], 'сохранение и отмена — рядом выше');
  const what = btns.nextElementSibling;
  assert.ok(what && what.classList.contains('muted'), 'последствие сразу за кнопками');
  assert.match(what.textContent, /Пункт уйдёт из списков/);
  assert.match(what.textContent, /Отметки и прошлые дни останутся как есть/);
  // числа «во что превратится серия» не показываются никогда (A.3.3)
  assert.doesNotMatch(what.textContent, /сери|рекорд|\d+ (день|дня|дней)/i);

  // второй тап: строка ушла, на её месте — короткий путь назад
  rm().click();
  assert.equal(rows().length, 4, 'строка ушла из списка');
  const note = document.querySelector('#scr-settings .gone-note');
  assert.ok(note, 'строка «убран — Вернуть» на месте ушедшей');
  assert.match(note.textContent, /Пункт 0 · убран/);
  assert.equal(note.querySelector('[data-act="item-restore"]').textContent, 'Вернуть');
  assert.equal(document.activeElement, note.querySelector('[data-act="item-restore"]'),
    'фокус — на «Вернуть»: строка, с которой он был, исчезла');

  // и данные: отметки на месте, поле проставлено сегодняшним днём
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.items.find(i => i.id === 'm0').removedAt, daysAgo(0));
  assert.ok(Object.keys(saved.days).length, 'отметки не тронуты');
});

test('З28E/A.3.4: строка «убран» — не .flash: по таймеру не гаснет', async () => {
  const { document } = await boot({ seed: t17Seed() });
  removeItemThroughUi(document, 'm0');
  const note = () => document.querySelector('#scr-settings .gone-note');
  assert.ok(note());
  assert.equal(note().classList.contains('flash'), false, 'свой класс, не .flash');
  await wait(T.FLASH_MS + 120); // заведомо дольше жизни подтверждения
  assert.ok(note(), 'отмена, исчезающая через секунду, отменой не является');
});

test('З28E/A.3.5: «Убранные» — длинный путь назад, пустым не рисуется', async () => {
  const { document } = await boot({ seed: t17Seed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const heads = () => [...document.querySelectorAll('#scr-settings h2')].map(h => h.textContent);
  assert.equal(heads().includes('Убранные'), false, 'убирать нечего — блока нет');

  removeItemThroughUi(document, 'm0');
  // пока стоит короткий путь назад, в «Убранных» пункт не дублируется
  assert.equal(heads().includes('Убранные'), false, 'двух «Вернуть» на одну запись нет');

  // следующее действие гасит короткий путь — и появляется длинный
  document.querySelector('#scr-settings [data-act="edit-open"]').click();
  assert.equal(document.querySelector('#scr-settings .gone-note'), null);
  assert.equal(heads().includes('Убранные'), true);
  const gone = [...document.querySelectorAll('#scr-settings .rowwrap.gone')];
  assert.equal(gone.length, 1);
  assert.match(gone[0].textContent, /Пункт 0/);
  assert.match(gone[0].querySelector('.meta').textContent, /^убран /);

  // «Вернуть» из «Убранных» в тот же день — полная отмена
  gone[0].querySelector('[data-act="item-restore"]').click();
  assert.equal(heads().includes('Убранные'), false, 'блок опустел и исчез');
  assert.equal([...document.querySelectorAll('#scr-settings [data-act="edit-open"]')].length, 5);
});

test('З28E/A.8.1: уход пункта не меняет чисел «Прогресса» за прошлые дни', async () => {
  const { document } = await boot({ seed: t17Seed() });
  const prog = () => {
    document.querySelector('#tabs button[data-tab="progress"]').click();
    const scr = document.getElementById('scr-progress');
    return {
      days: scr.querySelectorAll('.pcard')[0].textContent,
      rec: (scr.querySelector('.rec') || {}).textContent || '',
      chain: [...scr.querySelectorAll('.cd')].map(c => c.className).join('|')
    };
  };
  const before = prog();
  removeItemThroughUi(document, 'm4'); // самый редкий пункт сида
  const after = prog();

  assert.equal(after.days, before.days, '«в системе» не сдвинулось');
  assert.equal(after.rec, before.rec, 'рекорд не сдвинулся');
  // сегодняшняя ячейка вправе измениться — уход действует с сегодня;
  // все прежние обязаны совпасть
  const cut = s => s.split('|').slice(0, -1).join('|');
  assert.equal(cut(after.chain), cut(before.chain), 'цепь за прошлые дни та же');
});

test('З28E/A.4: у упражнения «Убрать» и «Убранные» тем же механизмом', async () => {
  const { document, window } = await boot({ seed: trainSeed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const sect = [...document.querySelectorAll('#scr-settings details.sect')]
    .find(d => /Упражнения/.test(d.querySelector('summary').textContent));
  sect.querySelector('summary').click();

  document.querySelector('#scr-settings [data-act="ex-open"]').click();
  const rm = () => document.querySelector('#scr-settings [data-act="ex-remove"]');
  rm().click();
  assert.match(rm().closest('.btns').nextElementSibling.textContent, /Упражнение уйдёт из списков/);
  rm().click();
  assert.match(document.querySelector('#scr-settings .gone-note').textContent, /Жим · убрано/);
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).exercises[0].removedAt, daysAgo(0));

  // длинный путь: «Убранные» в своей секции
  document.querySelector('#scr-settings [data-act="ex-open"]').click();
  const gone = [...document.querySelectorAll('#scr-settings .rowwrap.gone')];
  assert.equal(gone.length, 1);
  gone[0].querySelector('[data-act="ex-restore"]').click();
  assert.equal(document.querySelector('#scr-settings .rowwrap.gone'), null);
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).exercises[0].removedAt, null);
});


test('З28E/B.2: строка дня — третьей в шапке «Сегодня» и только там', async () => {
  const { document, window } = await boot();
  const scr = document.getElementById('scr-today');
  const head = scr.querySelector('header.page');
  assert.deepEqual([...head.children].map(n => n.className), ['overline', '', 'dline'],
    'день недели → дата → строка дня');
  assert.equal(head.children[1].tagName, 'H1');
  const line = head.querySelector('.dline');
  assert.ok(window.dayLine, 'функция выбора доступна');
  assert.equal(line.textContent, window.dayLine(window.todayKey()));
  // набор объявлен через const и в window не попадает (vm-контекст) —
  // сверяем с исходником app.js: строка действительно из набора
  assert.ok(APP.includes("  '" + line.textContent + "',"), 'строка — из набора');

  // над планкой и над списком: ниже она читалась бы как оценка сделанного
  const after = [...scr.children];
  assert.ok(after.indexOf(head) < after.findIndex(n => n.classList.contains('dayline')));
  assert.ok(after.indexOf(head) < after.findIndex(n => n.classList.contains('list')));

  // ни кавычек, ни aria-live, ни своей роли
  assert.doesNotMatch(line.textContent, /[«»"]/);
  assert.equal(line.getAttribute('aria-live'), null);
  assert.equal(line.getAttribute('role'), null);

  // на других экранах строки нет
  for (const t of ['habits', 'progress', 'settings']) {
    document.querySelector(`#tabs button[data-tab="${t}"]`).click();
    assert.equal(document.querySelector(`#scr-${t} .dline`), null, t);
  }
  // и на листах тоже
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector('#scr-today [data-act="train-inc"]').click();
  assert.equal(document.querySelector('#scr-train .dline'), null);
  document.querySelector('[data-act="train-cancel"]').click();
  assert.equal(document.querySelectorAll('.dline').length, 1, 'узел один на всё приложение');
});

test('З28E/B.6.2: строка не меняется от тапа по кругу', async () => {
  const { document } = await boot();
  const line = () => document.querySelector('#scr-today .dline').textContent;
  const was = line();
  const boxes = [...document.querySelectorAll('#scr-today input[data-act="mark"]')];
  for (const b of boxes) { b.click(); assert.equal(line(), was, 'отметка строку не трогает'); }
  for (const b of boxes) { b.click(); assert.equal(line(), was, 'снятие — тоже'); }
});

test('З28E/B.2.3: кредо снято с «Сегодня» и осталось на «Привычках»', async () => {
  const { document } = await boot();
  assert.equal(document.querySelector('#scr-today .creed'), null);
  document.querySelector('#tabs button[data-tab="habits"]').click();
  const creed = document.querySelector('#scr-habits .creed');
  assert.ok(creed, 'на «Привычках» кредо видно всегда — замер 468 px при сгибе 753');
  assert.match(creed.textContent, /Не спеши — доверься накопительному эффекту/);
});


/* ══ Задача 28.E, часть C: сцена закрытия дня ═════════════════
   Волна не путешествует от круга к планке, а приходит: связь несут время
   и цвет. Классы-триггеры навешивает только хук, и только на «Сегодня». */

test('З28E/C.5.1: классы сцены — при закрытии дня и только при нём', async () => {
  const { document, window } = await boot({ seed: pointSeed() });
  const scr = () => document.getElementById('scr-today');
  const boxes = () => [...scr().querySelectorAll('input[data-act="mark"]')];
  assert.ok(boxes().length >= 2);

  // при загрузке экрана — ни следа: ни одна функция рендера класс не печатает
  assert.equal(scr().querySelector('.closing'), null, 'загрузка экрана сцену не играет');
  assert.ok(scr().querySelector('.bar i .sheen'), 'узел блика постоянный, а не рождаемый');

  // обычный тап (день ещё не закрыт) — сцены нет
  boxes()[0].click();
  assert.equal(scr().querySelector('.closing'), null, 'обычная отметка сцену не играет');

  // последний тап закрывает день — сцена играет
  boxes()[1].click();
  assert.ok(scr().querySelector('.dayline.closing'), 'планка получила класс');
  assert.ok(scr().querySelector('label.check.closing'), 'строка нажатого пункта — тоже');
  assert.equal(scr().querySelectorAll('label.check.closing').length, 1, 'кольцо — у одного круга');
  assert.match(scr().querySelector('.bar-note').textContent, /День закрыт/);

  // хук снимает классы сам — следа не остаётся
  await wait(T.DAY_CLOSE_MS + T.MOTION_TAIL_MS + 40);
  assert.equal(scr().querySelector('.closing'), null, 'сцена кончилась и убрала за собой');

  // снятие отметки день «раскрывает» — сцены нет. Блок после сцены свёрнут
  // (задача Р2, п. 4): его строки возвращает тап по свёрнутой строке
  unfoldBlock(document, 'Утро');
  assert.equal(scr().querySelector('.closing'), null, 'развёртка сцены не играет');
  boxes()[1].click();
  assert.equal(scr().querySelector('.closing'), null, 'снятие отметки сцену не играет');
  // и повторное закрытие играет её заново
  boxes()[1].click();
  assert.ok(scr().querySelector('.dayline.closing'), 'повторное закрытие — снова сцена');

  // перерисовка экрана сцену отменяет и следа не печатает
  window.renderToday();
  assert.equal(scr().querySelector('.closing'), null, 'перерисовка класс не печатает');
});

test('З28E/C.2.2: сцены нет на «Привычках» и нет у недельного счётчика', async () => {
  const { document } = await boot({ seed: pointSeed() });
  // «Привычки»: при норме меньше семи «все отмечены» нормой не является
  document.querySelector('#tabs button[data-tab="habits"]').click();
  const hb = document.getElementById('scr-habits');
  hb.querySelectorAll('input[data-act="mark"]').forEach(b => b.click());
  assert.match(hb.querySelector('.bar-note').textContent, /Все отмечены/);
  assert.equal(hb.querySelector('.closing'), null, 'на «Привычках» сцены нет');
  assert.equal(hb.querySelector('.sheen'), null, 'и узла блика тоже — он только у «Сегодня»');

  // недельный счётчик: вторая валюта на том же экране не заводится
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector('#scr-today [data-act="train-inc"]').click();
  document.querySelector('[data-act="train-save"]').click();
  assert.equal(document.querySelector('#scr-today .closing'), null, 'запись тренировки сцены не играет');
});

test('З28E/C.2.3: reduced-motion — сцены нет, конечное состояние на месте', async () => {
  const { document, window } = await boot({ seed: pointSeed() });
  window.matchMedia = q => ({ matches: /reduced-motion/.test(q), media: q,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  const scr = () => document.getElementById('scr-today');
  const boxes = () => [...scr().querySelectorAll('input[data-act="mark"]')];
  boxes().forEach(b => b.click());

  // классы не навешиваются вовсе — хук выходит рано
  assert.equal(scr().querySelector('.closing'), null, 'при reduced-motion сцена не играет');
  // а конечное состояние достижимо мгновенно и ни бита не теряет
  assert.match(scr().querySelector('.bar-note').textContent, /День закрыт/);
  assert.ok(scr().querySelector('.bar-note').classList.contains('ok'));
  assert.equal(scr().querySelector('.bar i').style.width, '100%');
  assert.equal(scr().querySelectorAll('label.check.on').length, boxes().length);
  // покойное состояние новых узлов — невидимое: ни бита информации в них нет
  const css = CSS_SRC();
  assert.match(ruleOf(css, '.sheen'), /opacity:\s*0/);
  assert.match(ruleOf(css, '.check .box::before'), /opacity:\s*0/);
  // и глобальный блок гасит анимации, если бы класс всё же появился
  const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(block, /animation: none !important/);
});

test('З28E/C.1: раскадровка — три фазы, клип заполнением, вес не анимируется', () => {
  const css = CSS_SRC();
  // блик живёт ВНУТРИ заполнения и потому не может его обогнать
  const fill = ruleOf(css, '.bar i, .dbar i');
  assert.match(fill, /overflow:\s*hidden/);
  assert.match(fill, /position:\s*relative/);
  // фраза: цвет и масштаб, но НЕ font-weight — другой вес даёт другие глифы
  // и повторный шейпинг каждый кадр, это layout
  const word = css.slice(css.indexOf('@keyframes day-word'), css.indexOf('}', css.indexOf('@keyframes day-word') + 200));
  assert.match(word, /transform:\s*scale/);
  assert.match(word, /color:/);
  assert.doesNotMatch(word, /font-weight/);
  for (const name of ['day-ring', 'day-sheen', 'day-word']) {
    assert.ok(css.includes('@keyframes ' + name), 'фаза ' + name);
  }
  // ни очков, ни конфетти, ни звука, ни эмодзи: отклик описывает предмет
  const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  for (const bad of ['Молодец', 'Отлично', 'Ура', 'confetti', 'Audio', 'new Audio']) {
    assert.ok(!app.includes(bad), 'в отклике нет «' + bad + '»');
  }
});

/* ══ Задача 29/B: расписание и время — интерфейс ═══════════════ */

/* Пункт с маской: собирается прямо, без формы, — форма проверяется ниже */
function schedSeed(mask, extra) {
  const seed = progSeed();
  const since = seed.settings.calendarSince;
  seed.items.push(Object.assign({
    id: 'sun', name: 'Звонок родителям', value: null, unit: '', type: 'daily', area: 'min',
    goal: null, note: '', group: '', removedAt: null, addedAt: since, at: '',
    schedule: [{ from: since, mask }],
    raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
    formula: null, ladder: null, ladderLog: []
  }, extra || {}));
  return seed;
}

/* Сдвинуть «сейчас» окна на delta ЛОГИЧЕСКИХ дней — к полудню местной даты
   (Р1/ревью). Сдвиг на delta · 24 реальных часа через перевод стрелок
   уводит местные часы на час, и около границы дня 04:00 логический ключ
   уезжал на соседний день: в America/Toronto — регионе владельца — тесты
   падали или проходили в зависимости от часа прогона. Полдень лежит
   далеко от границы при любом переводе; отсчёт — от «сейчас» самого окна,
   поэтому сдвиги складываются. */
function shiftWindowDays(window, delta) {
  const now = new window.Date();
  const day = new Date(now.getTime() - 4 * 3600000); // логический день — та же формула, что dayKey
  const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate() + delta, 12);
  shiftWindowDate(window, noon.getTime() - now.getTime());
}

/* Сдвинуть окно к ближайшему дню недели dow (0 — понедельник) и дать
   приложению перерисоваться сменой логического дня (инвариант 8). */
async function moveToWeekday(window, document, dow) {
  const cur = (new Date(new window.Date().getTime() - 4 * 3600000).getDay() + 6) % 7;
  const delta = ((dow - cur) + 7) % 7 || 7;
  shiftWindowDays(window, delta);
  document.dispatchEvent(new window.Event('visibilitychange'));
  return delta;
}

/* ── B.6.4: пример владельца дословно ────────────────────────── */
test('З29B/6.4: «только воскресенье» — в среду пункта нет нигде, в воскресенье «1 из 1»', async () => {
  const { document, window } = await boot({ seed: schedSeed('0000001') });

  // среда: пункта нет ни в списке «Сегодня», ни в знаменателе планки
  await moveToWeekday(window, document, 2);
  const today = document.getElementById('scr-today');
  const names = [...today.querySelectorAll('.list .row .tname')].map(n => n.textContent);
  assert.equal(names.some(n => /Звонок родителям/.test(n)), false, 'в среду пункта в списке нет');
  const wed = today.querySelector('.bar-note').textContent.replace(/\s+/g, ' ').trim();
  assert.doesNotMatch(wed, /из 4/, 'и в знаменателе его тоже нет');
  assert.equal(document.querySelector('#scr-today [data-act="mark"][data-id="sun"]'), null);

  // воскресенье: пункт на месте
  const b = await boot({ seed: schedSeed('0000001', { id: 'sun' }) });
  await moveToWeekday(b.window, b.document, 6);
  const sun = b.document.getElementById('scr-today');
  const cb = sun.querySelector('[data-act="mark"][data-id="sun"]');
  assert.ok(cb, 'в воскресенье пункт в списке');

  // и он ЕДИНСТВЕННЫЙ применимый, если прочие убраны: «1 из 1» → «День закрыт»
  const c = await boot({ seed: (() => {
    const s = schedSeed('0000001');
    s.items = s.items.filter(i => i.id === 'sun');
    return s;
  })() });
  await moveToWeekday(c.window, c.document, 6);
  const only = c.document.getElementById('scr-today');
  assert.match(only.querySelector('.bar-note').textContent.replace(/\s+/g, ' '), /0\s*из\s*1/,
    'знаменатель — ОДИН: столько пунктов стоит в этом дне');
  only.querySelector('[data-act="mark"][data-id="sun"]').click();
  assert.match(only.querySelector('.bar-note').textContent, /День закрыт/,
    'отметил единственный применимый — день закрыт: это и есть «1 из 1» владельца');
});

/* ── B.2.2 / B.2.8: день без применимых пунктов ──────────────── */
test('З29B/6.3 (B.2.8): ноль применимых в дне — пустое состояние без планки, без NaN', async () => {
  const seed = schedSeed('0000001');
  seed.items = seed.items.filter(i => i.id === 'sun' || i.type === 'weekly');
  const { document, window } = await boot({ seed });
  await moveToWeekday(window, document, 2); // среда: применимых нет вовсе
  const today = document.getElementById('scr-today');
  assert.equal(today.querySelector('.dayline'), null, 'планки нет — измерять нечего');
  assert.doesNotMatch(today.textContent, /NaN|undefined|Infinity/);
  // Прежде здесь ждали «Пунктов пока нет» — пустое состояние задачи 22. Но
  // пункт ЗАВЕДЁН, он просто не стоит в среде, и строка звала бы заводить
  // заведённое. С «Расписанием 1/3» (п. 2.1) у дня без дел своя строка;
  // прежняя осталась за хранилищем, где действий нет вовсе (тест Р1/ ниже).
  assert.match(today.textContent, /На сегодня в расписании ничего нет\./);
  assert.doesNotMatch(today.textContent, /Пунктов пока нет/);
});

test('З29B/6.3 (B.2.2): сквозной день в цепи гаснет, а не читается пропуском', async () => {
  const seed = schedSeed('1111100');            // Пн–Пт
  seed.items = seed.items.filter(i => i.id === 'sun');
  seed.items[0].name = 'Будни';
  const { document } = await boot({ seed });
  openProgress(document);
  const cells = [...document.querySelectorAll('#scr-progress .cdays i')];
  assert.equal(cells.length, 56, 'сетка на месте — восемь недель');
  const off = cells.filter(c => c.classList.contains('off'));
  assert.ok(off.length > 0, 'выходные по расписанию гаснут');
  // погашённая ячейка НЕ несёт признаков пропуска: ни пустой обводки, ни части
  for (const c of off) {
    assert.equal(c.classList.contains('part'), false);
    assert.equal(c.classList.contains('full'), false);
  }
  // и её место в раскладке остаётся — сетка не съезжает
  assert.equal(document.querySelectorAll('#scr-progress .cdays .cd-head').length, 7);
});

/* ── B.2.3: полоса недели привычки ───────────────────────────── */
test('З29B/6.3 (B.2.3): дни вне маски в полосе привычки инертны, счёт прежний', async () => {
  const seed = schedSeed('1010100', { area: 'habit', normPerWeek: 3, id: 'sun', name: 'Зал' });
  const { document, window } = await boot({ seed });
  // привычка с маской Пн/Ср/Пт на экране только в свои дни: без фиксации
  // дня недели тест падал во вторник, четверг и выходные (дефект даты 29/B)
  await moveToWeekday(window, document, 0);
  document.querySelector('#tabs button[data-tab="habits"]').click();
  const wrap = [...document.querySelectorAll('#scr-habits .rowwrap')]
    .find(w => /Зал/.test(w.textContent));
  assert.ok(wrap, 'привычка на экране');
  const cells = [...wrap.querySelectorAll('.hstrip i')];
  assert.equal(cells.length, 7, 'семь кружков на месте — полоса не съезжает');
  const off = cells.filter((c, i) => [1, 3, 5, 6].includes(i));
  for (const c of off) assert.ok(c.classList.contains('off'), 'день вне маски погашен');
  for (const i of [0, 2, 4]) assert.equal(cells[i].classList.contains('off'), false);
  assert.match(wrap.querySelector('.hcount').textContent, /из 3$/, 'счёт «X из нормы» прежний');
});

/* ── B.4: форма правки ───────────────────────────────────────── */
test('З29B/6.3 (B.4.1): семь целей Пн…Вс, умолчание — все выбраны, состояние не одним цветом', async () => {
  const { document } = await boot({ seed: progSeed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('#scr-settings [data-act="edit-open"]').click();
  const days = [...document.querySelectorAll('#scr-settings .days .btn.day')];
  assert.equal(days.length, 7, 'семь целей');
  assert.deepEqual(days.map(d => d.textContent), ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']);
  assert.equal(days.every(d => d.getAttribute('aria-pressed') === 'true'), true, 'умолчание — все семь');
  // состояние читается НЕ ТОЛЬКО ЦВЕТОМ: aria-pressed + класс, по которому
  // CSS даёт и заливку, и начертание
  days[6].click();
  const after = [...document.querySelectorAll('#scr-settings .days .btn.day')];
  assert.equal(after[6].getAttribute('aria-pressed'), 'false');
  assert.equal(after[6].classList.contains('on'), false);
  assert.equal(after[0].getAttribute('aria-pressed'), 'true');
  // каждая цель — .btn, то есть у неё уже есть состояние нажатия (задача 26)
  assert.equal(after.every(d => d.classList.contains('btn')), true);
});

test('З29B/6.3 (B.4.1): пустая маска не сохраняется — форма отказывает строкой', async () => {
  const { document, window } = await boot({ seed: progSeed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const open = document.querySelector('#scr-settings [data-act="edit-open"]');
  const id = open.dataset.id;
  open.click();
  for (let i = 0; i < 7; i++) document.querySelector(`#scr-settings [data-act="day-toggle"][data-day="${i}"]`).click();
  const save = document.querySelector('#scr-settings [data-act="edit-save"]');
  save.click();
  assert.match(document.getElementById('scr-settings').textContent, /Нужен хотя бы один день недели/);
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.deepEqual(saved.items.find(i => i.id === id).schedule.length, 1, 'ничего не записано');
  assert.ok(document.querySelector('#scr-settings [data-form="edit"]'), 'форма осталась открытой');
});

test('З29B/6.3 (B.4.3): черновик формы держит и время, и выбранные дни', async () => {
  const { document } = await boot({ seed: progSeed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('#scr-settings [data-act="edit-open"]').click();
  document.getElementById('e-at').value = '07:30';
  // тап по дню перерисовывает форму (от маски зависит потолок нормы)
  document.querySelector('#scr-settings [data-act="day-toggle"][data-day="6"]').click();
  assert.equal(document.getElementById('e-at').value, '07:30', 'время пережило перерисовку');
  assert.equal(document.querySelector('#scr-settings [data-act="day-toggle"][data-day="6"]')
    .getAttribute('aria-pressed'), 'false', 'и снятый день тоже');
  // «Отмена» — осознанный отказ: черновик снимается вместе с маской
  document.querySelector('#scr-settings [data-act="edit-cancel"]').click();
  document.querySelector('#scr-settings [data-act="edit-open"]').click();
  assert.equal(document.getElementById('e-at').value, '', 'после отмены поле чистое');
  assert.equal(document.querySelector('#scr-settings [data-act="day-toggle"][data-day="6"]')
    .getAttribute('aria-pressed'), 'true', 'и маска вернулась к сохранённой');
});

/* ── B.3: время — подпись ────────────────────────────────────── */
test('З29B/6.5: время сохраняется, печатается перед подписью и не принимается кривым', async () => {
  const { document, window } = await boot({ seed: progSeed() });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const open = document.querySelector('#scr-settings [data-act="edit-open"]');
  const id = open.dataset.id;
  open.click();
  document.getElementById('e-note').value = 'на кухню';
  // поле type="time" отбрасывает мусор САМО — это его штатное поведение и
  // первая линия обороны: невалидное значение до обработчика не доходит
  document.getElementById('e-at').value = 'вечером';
  assert.equal(document.getElementById('e-at').value, '', 'мусор в поле не удерживается');
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.id === id).at, '',
    'пустое время — законное состояние, отказа нет');

  // сохранение прошло, форма закрылась — открываем заново и вписываем время
  [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')]
    .find(x => x.dataset.id === id).click();
  document.getElementById('e-at').value = '23:30';
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).items.find(i => i.id === id).at, '23:30');

  // печатается ПЕРВОЙ в подписи, через « · », одинаково на «Сегодня» и в «Настройках»
  document.querySelector('#tabs button[data-tab="today"]').click();
  const row = [...document.querySelectorAll('#scr-today .rowwrap')]
    .find(r => r.querySelector('[data-act="mark"]') && r.querySelector('[data-act="mark"]').dataset.id === id);
  assert.equal(row.querySelector('.note').textContent, '23:30 · на кухню');
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const srow = [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')]
    .find(x => x.dataset.id === id);
  // строка «Расписания» компактная («Расписание 1/3», п. 2.4): подпись идёт
  // за именем в .csub, и время в ней — по-прежнему первым, дальше значение
  assert.equal(srow.querySelector('.csub').textContent, ' · 23:30 · на кухню · 10 мин');
});

/* B.3.3: сортировки по времени НЕТ — порядок пунктов ручной (инвариант 17).
   Соблазн «отсортировать по времени» очевиден и потому сторожится: время
   позднее у пункта, стоящего ПЕРВЫМ, порядок менять не должно. */
test('З29B/6.5 (B.3.3): время не пересортировывает список — порядок остаётся ручным', async () => {
  // список БЕЗ блоков: groupedItems пересобирает порядок по блокам, и на
  // сгруппированном списке сортировка внутри чужих блоков не видна вовсе
  const seed = progSeed();
  seed.groups = [];
  seed.items = seed.items.filter(i => i.type === 'daily' && i.area === 'min').slice(0, 1);
  const since = seed.settings.calendarSince;
  const mk = (id, name) => Object.assign(JSON.parse(JSON.stringify(seed.items[0])),
    { id, name, group: '', at: '', schedule: [{ from: since, mask: '1111111' }] });
  seed.items = [mk('a1', 'Первый'), mk('a2', 'Второй'), mk('a3', 'Третий')];
  const { document } = await boot({ seed });
  const order = () => [...document.querySelectorAll('#scr-today .list [data-act="mark"]')].map(c => c.dataset.id);
  assert.deepEqual(order(), ['a1', 'a2', 'a3'], 'порядок — ручной, как в items[]');

  document.querySelector('#tabs button[data-tab="settings"]').click();
  const setAt = (itemId, v) => {
    [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')]
      .find(x => x.dataset.id === itemId).click();
    document.getElementById('e-at').value = v;
    document.querySelector('#scr-settings [data-act="edit-save"]').click();
  };
  setAt('a1', '23:45');   // первому — самое позднее
  setAt('a3', '05:00');   // последнему — самое раннее
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.deepEqual(order(), ['a1', 'a2', 'a3'], 'сортировки по времени нет (инвариант 17)');
  // и подписи на месте — время печатается, но порядка не трогает
  const row = [...document.querySelectorAll('#scr-today .rowwrap')]
    .find(r => r.querySelector('[data-act="mark"]') && r.querySelector('[data-act="mark"]').dataset.id === 'a3');
  assert.equal(row.querySelector('.note').textContent, '05:00');
});

/* ── B.2.7: лид разбора остаётся «из 7» ──────────────────────── */
test('З29B/6.3 (B.2.7): «Минимум закрыт N из 7» — знаменатель прежний', async () => {
  const seed = dueSeed();
  const { document } = await boot({ seed });
  document.querySelector('#scr-today [data-act="goto-review"]').click();
  assert.match(document.getElementById('scr-review').textContent, /Минимум закрыт \d из 7 дней/);
});

/* ══ «Расписание 1/3», доменный этап: единственная связка с интерфейсом ══
   Форма правки пункта меняет блок через setItemGroup: у действия, заведённого
   до сегодняшнего дня, перенос пишет журнал принадлежности, и прошлые дни
   помнят прежний блок. Остальной интерфейс задачи — следующим этапом. */
test('Р1/связка: смена блока в форме правки пишет журнал принадлежности', async () => {
  const seed = chainSeed();
  const { document, window } = await boot({ seed });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  const born = seed.items.find(i => i.id === 'c1').addedAt;
  assert.ok(born < daysAgo(0), 'пункт заведён раньше сегодняшнего дня');
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const openEdit = id => [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')]
    .find(b => b.dataset.id === id).click();
  const pick = value => {
    const sel = document.getElementById('e-group');
    sel.value = value;
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    document.querySelector('#scr-settings [data-act="edit-save"]').click();
  };

  openEdit('c1');
  pick('Утро');
  let c1 = saved().items.find(i => i.id === 'c1');
  assert.equal(c1.group, 'Утро');
  assert.deepEqual(c1.groupLog, [{ from: born, group: 'Вечер' }, { from: daysAgo(0), group: 'Утро' }],
    'прежний блок — с дня заведения, новый — с сегодняшнего');

  // сохранение без смены блока журнал не трогает
  openEdit('c1');
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.deepEqual(saved().items.find(i => i.id === 'c1').groupLog, c1.groupLog);

  // обратно в тот же день — истории нет
  openEdit('c1');
  pick('Вечер');
  c1 = saved().items.find(i => i.id === 'c1');
  assert.equal(c1.group, 'Вечер');
  assert.deepEqual(c1.groupLog, []);
});

/* ── Р1/рецензия: связки обработчиков с доменными отказами ─────── */

/* Имя, оставшееся только в журналах принадлежности пунктов, занято
   (nameTaken): переименование другого блока в него применило бы чужие дни к
   прошлому этих пунктов. Прежде такое имя получали удалением блока; удаление
   снято («Расписание 1/3», п. 4.7в), и осиротевшее имя в журнале теперь
   приносит только файл — тест берёт его из сида. Имя убранного блока —
   своя фраза: путь назад к нему существует. Обработчик обязан сказать
   отказ, а не закрыть форму молча с прежним именем. */
test('Р1/рецензия: «Сохранить» блока с именем из журнала — отказ строкой, форма цела', async () => {
  const seed = chainSeed();
  const born = seed.items[0].addedAt;
  seed.schemaVersion = 18;
  seed.items.find(i => i.id === 'c1').groupLog = [{ from: born, group: 'Старый' }, { from: addKey(born, 3), group: 'Вечер' }];
  seed.groups.push({ name: 'Ушедший', removedAt: addKey(born, 5) });
  const { document, window } = await boot({ seed });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  openSettings(document);
  const open = name => [...document.querySelectorAll('#scr-settings [data-act="group-open"]')]
    .find(b => b.dataset.name === name).click();
  assert.ok(saved().items.find(i => i.id === 'c1').groupLog.some(e => e.group === 'Старый'),
    'имя живёт только в журнале пункта');
  assert.equal(saved().groups.some(g => g.name === 'Старый'), false, 'блока с ним нет');

  open('Утро');
  const before = window.localStorage.getItem(NS);
  const trySave = (typed, say) => {
    document.getElementById('g-name').value = typed;
    document.querySelector('#scr-settings [data-act="group-save"]').click();
    const said = document.querySelector('#scr-settings .flash.keep');
    assert.ok(said, 'отказ сказан: ' + typed);
    assert.match(said.textContent, say);
    assert.ok(said.nextElementSibling.contains(document.querySelector('[data-act="group-save"]')), 'строка у нажатой кнопки');
    assert.equal(document.querySelectorAll('#scr-settings .flash.keep').length, 1, 'повторный отказ заменяет прежний');
    assert.equal(document.querySelector('#scr-settings .flash:not(.keep)'), null, '«Сохранено» не показано');
    assert.ok(document.getElementById('g-name'), 'форма открыта');
    assert.equal(document.getElementById('g-name').value, typed, 'введённое цело');
    assert.equal(window.localStorage.getItem(NS), before, 'в store не записано ничего');
  };
  trySave('Старый', /^Это имя уже занято$/);
  trySave('Ушедший', /^Блок «Ушедший» убран — вернуть можно в «Убранных»$/);
  assert.deepEqual(saved().groups.map(g => g.name), ['Вечер', 'Утро', 'Ушедший']);
});

/* Прежде здесь стоял отказ «Удалить блок» блоку с днями: его дни держат
   прошлые числа действий. Удаление снято («Расписание 1/3», п. 4.7в), и тот
   же предмет — дни блока и прошлое его действий целы — держит уход: блок
   убирается, но его дни и принадлежность пунктов остаются в store. Отказ
   записи — строкой у кнопки, форма и подтверждение на месте. */
test('Р1/рецензия: «Убрать блок» с днями — дни и пункты целы, отказ записи — строкой', async () => {
  const seed = chainSeed();
  const born = seed.items[0].addedAt;
  seed.groups = [{ name: 'Вечер', days: [{ from: born, mask: '1111100' }] }, { name: 'Утро' }];
  const { document, window } = await boot({ seed });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  openSettings(document);
  [...document.querySelectorAll('#scr-settings [data-act="group-open"]')].find(b => b.dataset.name === 'Вечер').click();
  const rm = () => document.querySelector('#scr-settings [data-act="group-remove"]');
  rm().click();

  // отказ хранилища: строка у кнопки, форма открыта, в store — ничего
  const before = window.localStorage.getItem(NS);
  withBrokenStorage(window, () => rm().click());
  const said = document.querySelector('#scr-settings .flash.keep');
  assert.ok(said, 'отказ сказан');
  assert.match(said.textContent, /Не убрано: хранилище недоступно/);
  assert.equal(window.localStorage.getItem(NS), before, 'в store не записано ничего');
  assert.ok(document.getElementById('g-name'), 'форма открыта');

  // уход: блок убран, его дни на месте, пункты при нём и ушли вместе с ним
  rm().click(); // взвести заново: отказ снял взводку
  rm().click();
  const s = saved();
  const g = s.groups.find(x => x.name === 'Вечер');
  assert.equal(g.removedAt, daysAgo(0));
  assert.deepEqual(g.days, [{ from: born, mask: '1111100' }], 'дни блока целы');
  assert.deepEqual(s.items.filter(i => i.group === 'Вечер').map(i => i.id), ['c1', 'c2', 'c3'], 'пункты в блоке');
  assert.equal(s.items.filter(i => i.group === 'Вечер').every(i => i.removedAt === daysAgo(0)), true);
});

/* Действие, у которого своих дней в днях блока не осталось, возвращается
   «как блок». Это смена маски за владельца — она называется строкой, как
   зажатие нормы; обычный возврат — прежнее «Сохранено». */
test('Р1/рецензия: «Вернуть» действие без единого дня — «как блок», и это названо', async () => {
  const seed = chainSeed();
  const born = seed.items[0].addedAt;
  seed.groups = [{ name: 'Вечер', days: [{ from: born, mask: '1111100' }] }, { name: 'Утро' }];
  const c1 = seed.items.find(i => i.id === 'c1');
  c1.schedule = [{ from: born, mask: '0000011' }]; // в днях блока — ни одного (пришло импортом)
  c1.removedAt = daysAgo(1);
  const c2 = seed.items.find(i => i.id === 'c2');
  c2.removedAt = daysAgo(1);
  const { document, window } = await boot({ seed });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  openSettings(document);
  const restore = id => [...document.querySelectorAll('#scr-settings .rowwrap.gone [data-act="item-restore"]')]
    .find(b => b.dataset.id === id).click();

  restore('c1');
  let s = saved();
  const copy = s.items[s.items.findIndex(i => i.id === 'c1') + 1];
  assert.equal(copy.name, 'Свет');
  assert.deepEqual(copy.schedule, [{ from: daysAgo(0), mask: '1111111' }], 'своя маска — «все семь», то есть как блок');
  assert.deepEqual(s.items.find(i => i.id === 'c1').schedule, [{ from: born, mask: '0000011' }], 'прежняя запись не тронута');
  const flash = document.querySelector('#scr-settings .flash');
  assert.ok(flash, 'подтверждение есть');
  assert.match(flash.textContent, /Вернулся с днями блока/);
  assert.ok(flash.closest('.rowwrap').querySelector(`[data-id="${copy.id}"]`), 'у вернувшейся строки');

  restore('c2');
  s = saved();
  const copy2 = s.items[s.items.findIndex(i => i.id === 'c2') + 1];
  assert.deepEqual(copy2.schedule, [{ from: daysAgo(0), mask: '1111111' }]);
  const flash2 = document.querySelector('#scr-settings .flash');
  assert.equal(flash2.textContent, 'Сохранено', 'обычный возврат — обычное подтверждение');
});

/* Карточка понижения называет те числа, по которым решено: отметки в днях
   плана. Отметка вне плана (отмечено, потом в тот же день сужены дни)
   остаётся в days{}, но в числитель порога не идёт. */
test('Р1/рецензия: «Сделать легче» — отметки вне дней плана в счёт не идут', async () => {
  const seed = dueSeed();
  const prev = prevMonday();
  seed.groups = [{ name: 'Выходные', days: [{ from: addKey(prev, -14), mask: '0000011' }] }];
  seed.items[0].group = 'Выходные';
  seed.items[0].value = 20;
  seed.items[0].history = [{ date: addKey(prev, -14), value: 20 }];
  // отметки только по понедельникам — вне плана; первая, до окна, делает пункт начатым
  seed.days = { [addKey(prev, -14)]: { it1: true }, [addKey(prev, -7)]: { it1: true }, [prev]: { it1: true } };
  const { document } = await boot({ seed });
  openReview(document);
  const card = document.querySelector('#scr-review .card.lower');
  assert.ok(card, 'понижение предложено: по плану 0 из 2 обе недели');
  assert.match(card.textContent, /Тестовый пункт — 0 и 0 из 2 за две недели/);
});

/* ══ «Расписание 1/3», этап A: дневные экраны, разбор, тексты ════════
   Разметка заголовка блока с подписью, пустое «Сегодня», знаменатель
   сетки разбора по дням плана и тексты «Системы». «Настройки» этим
   этапом не перестраиваются. */

const R1_ALL = '1111111';

/* Действие (или привычка) в канонической форме v19: журнал принадлежности
   блоку — только у ежедневного пункта минимума */
function r1Action(id, name, since, group, mask, extra) {
  const it = Object.assign({
    id, name, value: null, unit: '', type: 'daily', area: 'min',
    goal: null, note: '', group, removedAt: null, addedAt: since, at: '',
    schedule: [{ from: since, mask }], groupLog: [],
    raiseAfter: 0, raiseAfterWeek: null, lowerAfterWeek: null, history: [],
    formula: null, ladder: null, ladderLog: []
  }, extra || {});
  if (!(it.type === 'daily' && it.area === 'min')) delete it.groupLog;
  return it;
}

const r1Block = (name, caption, days) => ({ name, caption: caption || '', days: days || [], removedAt: null });

/* Store схемы v19 без посева: блоки и пункты — только переданные */
function r1Store(groups, items, days) {
  return {
    schemaVersion: SCHEMA_VERSION, items, groups, days: days || {}, weekLog: [], reviews: [],
    pendingRaises: [], pendingLowers: [], exercises: [], sessions: [], notes: [],
    paramDecided: {}, draftOneChange: '', weekStart: curMonday(),
    settings: { dayBoundary: 4, dayThreshold: 0.8, exportedAt: null, calendarSince: curMonday(), habitSeeded: true, seed17: true }
  };
}

/* Фикстура владельца (п. 6 задачи) — одна на оба уровня тестов, данные и
   сборка в tests/r1-owner.js. Здесь сборка идёт через window jsdom-окна,
   затем окно уезжает к нужному дню недели (0 — понедельник): фикстура от
   даты прогона не зависит. */
const { R1_OWNER, buildR1Owner } = require('./r1-owner.js');

async function bootR1Owner(dow) {
  const { window, document } = await boot({ seed: r1Store([], []) });
  buildR1Owner(window, assert);
  window.renderAll();
  await moveToWeekday(window, document, dow);
  return { window, document };
}

/* Заголовки блоков экрана: [имя, подпись | null] */
const r1Labels = scr => [...scr.querySelectorAll('.list .g-label')]
  .map(l => [l.firstElementChild.textContent, l.querySelector('.g-cap') ? l.querySelector('.g-cap').textContent : null]);

test('Р1/2.1: фикстура владельца — вторник: 20 действий, «0 из 20», заголовки с подписями, «Выходного» нет', async () => {
  const { document } = await bootR1Owner(1);
  const scr = document.getElementById('scr-today');
  assert.equal(scr.querySelectorAll('.list input[data-act="mark"]').length, 20, '20 строк');
  assert.match(scr.querySelector('.bar-note').textContent, /^0\s*из\s*20$/);
  assert.deepEqual(r1Labels(scr), [
    ['Утро', '7:00'], ['Школа', '9:00–15:15 · вт, чт до 13:55'], ['Дом + Спорт', 'с 15:20'],
    ['Учеба', 'до 20:30'], ['Вечер', 'до 22:30']
  ], 'будний «Выходной» не рендерится, остальные — по порядку store.groups, с подписью справа');
  const names = [...scr.querySelectorAll('.list .row .tname')].map(n => n.textContent.trim());
  assert.equal(names.includes('Прогулка'), false, 'действия выходного блока нет');
  assert.equal(names.includes('Блок 3'), false, 'свои дни «Блока 3» — пн, ср, пт: во вторник его нет');
  assert.ok(names.includes('Блок 2'), 'а соседи по «Учебе» на месте');
  // имя и подпись — два узла: подпись приглушённо справа, а не хвост имени
  const lbl = scr.querySelector('.list .g-label');
  assert.equal(lbl.children.length, 2);
  assert.equal(lbl.lastElementChild.className, 'g-cap');
  // подпись действия из строки после « · » — на своём месте в строке
  const row = [...scr.querySelectorAll('.list .rowwrap')].find(r => r.querySelector('.tname').textContent.trim() === 'Спорт');
  assert.equal(row.querySelector('.note').textContent, 'отключить интернет на телефоне');
});

test('Р1/2.1: фикстура владельца — суббота: 12 действий, «0 из 12», «Школы» и «Дом + Спорт» нет', async () => {
  const { document } = await bootR1Owner(5);
  const scr = document.getElementById('scr-today');
  assert.equal(scr.querySelectorAll('.list input[data-act="mark"]').length, 12, '12 строк');
  assert.match(scr.querySelector('.bar-note').textContent, /^0\s*из\s*12$/);
  assert.deepEqual(r1Labels(scr), [
    ['Утро', '7:00'], ['Учеба', 'до 20:30'], ['Выходной', null], ['Вечер', 'до 22:30']
  ], 'будние блоки в субботу не рендерятся; у блока без подписи узла подписи нет');
  assert.doesNotMatch(scr.textContent, /Школа|Дом \+ Спорт|Звонок родным|Переодеться/);
  assert.equal(scr.querySelectorAll('.list .g-cap').length, 3, 'пустой подписи не печатается');
});

test('Р1/2.1: фикстура владельца — понедельник: 21, «Блок 3» стоит в «Учебе» своими днями', async () => {
  const { document } = await bootR1Owner(0);
  const scr = document.getElementById('scr-today');
  assert.equal(scr.querySelectorAll('.list input[data-act="mark"]').length, 21);
  assert.match(scr.querySelector('.bar-note').textContent, /^0\s*из\s*21$/);
  const b3 = [...scr.querySelectorAll('.list .rowwrap')].find(r => r.querySelector('.tname').textContent.trim() === 'Блок 3');
  assert.ok(b3, '«Блок 3» в понедельник на экране');
  assert.equal(b3.closest('.chain').previousElementSibling.firstElementChild.textContent, 'Учеба', 'в своём блоке');
});

test('Р1/2.1: блок без сегодняшних пунктов скрыт на обоих экранах; подпись видна и на «Привычках»', async () => {
  const since = addKey(curMonday(), -14);
  const seed = r1Store([
    r1Block('Утро', '7:00'),
    r1Block('Вечер', 'до 22:30 <b>&</b>'),   // дни блока — все семь, но у действия свои
    r1Block('Зал', 'с 18:00')
  ], [
    r1Action('a1', 'Кровать', since, 'Утро', R1_ALL),
    r1Action('a2', 'Душ', since, 'Вечер', '1101111'),         // без среды
    r1Action('h1', 'Отбой', since, 'Вечер', R1_ALL, { area: 'habit', normPerWeek: 7 }),
    r1Action('h2', 'Жим', since, 'Зал', '1101111', { area: 'habit', normPerWeek: 6 })
  ]);
  seed.settings.calendarSince = since;
  const { document, window } = await boot({ seed });
  await moveToWeekday(window, document, 2); // среда
  const today = document.getElementById('scr-today');
  assert.deepEqual(r1Labels(today), [['Утро', '7:00']],
    '«Вечер» в среду пуст — дни блока его допускают, но единственное действие в среде не стоит');
  assert.match(today.querySelector('.bar-note').textContent, /^0\s*из\s*1$/);

  document.querySelector('#tabs button[data-tab="habits"]').click();
  const habits = document.getElementById('scr-habits');
  assert.deepEqual(r1Labels(habits), [['Вечер', 'до 22:30 <b>&</b>']],
    'подпись — та же на «Привычках»; «Зал» без сегодняшних привычек скрыт');
  assert.equal(habits.querySelector('.g-cap').children.length, 0, 'подпись экранирована: слово владельца, не разметка');
});

test('Р1/2.1: «На сегодня в расписании ничего нет.» — только когда действия заведены, но не в этом дне', async () => {
  const since = addKey(curMonday(), -14);
  const seedWith = (items) => {
    const s = r1Store([r1Block('Выходной', '', [{ from: since, mask: '0000011' }])], items);
    s.settings.calendarSince = since;
    return s;
  };
  const walk = extra => r1Action('walk', 'Прогулка', since, 'Выходной', R1_ALL, Object.assign({ note: '40 минут' }, extra));

  // (1) будний день: действие есть, в дне не стоит — строка дня, планки нет
  const a = await boot({ seed: seedWith([walk()]) });
  await moveToWeekday(a.window, a.document, 1);
  const ta = a.document.getElementById('scr-today');
  assert.match(ta.textContent, /На сегодня в расписании ничего нет\./);
  assert.doesNotMatch(ta.textContent, /Пунктов пока нет/, 'не звать заводить заведённое');
  assert.equal(ta.querySelector('.dayline'), null, 'измерять нечего');
  assert.equal(ta.querySelector('.list'), null);
  assert.equal(ta.querySelector('.g-label'), null, 'и заголовка пустого блока нет');

  // (2) суббота: то же действие на месте — строки нет, планка есть
  const b = await boot({ seed: seedWith([walk()]) });
  await moveToWeekday(b.window, b.document, 5);
  const tb = b.document.getElementById('scr-today');
  assert.doesNotMatch(tb.textContent, /На сегодня в расписании ничего нет/);
  assert.match(tb.querySelector('.bar-note').textContent, /^0\s*из\s*1$/);

  // (3) действие убрано — живых нет вовсе: прежняя строка с новым путём
  const c = await boot({ seed: seedWith([walk({ removedAt: addKey(since, 1) })]) });
  await moveToWeekday(c.window, c.document, 1);
  const tc = c.document.getElementById('scr-today');
  assert.match(tc.textContent, /Пунктов пока нет — добавить можно в Настройках → Расписание\./);
  assert.doesNotMatch(tc.textContent, /На сегодня в расписании/, 'убранное действие заведённым не считается');

  // (4) живая привычка — не действие: «Сегодня» принадлежит минимуму
  const d = await boot({ seed: seedWith([walk({ id: 'hb', area: 'habit', normPerWeek: 2 })]) });
  await moveToWeekday(d.window, d.document, 1);
  const td = d.document.getElementById('scr-today');
  assert.match(td.textContent, /Пунктов пока нет — добавить можно в Настройках → Расписание\./);
  assert.doesNotMatch(td.textContent, /На сегодня в расписании/, 'привычка действием не считается');
});

test('Р1/2.1: пути пустых состояний — «Расписание» и «Привычки»; «Пункты» не названы нигде', async () => {
  const a = await boot({ seed: r1Store([], []) });
  assert.match(a.document.getElementById('scr-today').textContent,
    /Пунктов пока нет — добавить можно в Настройках → Расписание\./);
  a.document.querySelector('#tabs button[data-tab="habits"]').click();
  assert.match(a.document.getElementById('scr-habits').textContent,
    /Привычек пока нет — добавить можно в Настройках → Привычки\./);

  const b = await boot({ seed: dueSeed() }); // привычек нет, разбор назрел
  openReview(b.document);
  assert.match(b.document.getElementById('scr-review').textContent,
    /Привычек пока нет — добавить можно в Настройках → Привычки\./);
  // секция «Пункты» уходит: путь к ней не должен остаться ни в одной строке
  assert.doesNotMatch(APP, /Настройках → Пункты/);
});

/* Сетка разбора: у действия знаменатель — дни плана недели */
function r1ReviewSeed() {
  const seed = dueSeed();
  const prev = prevMonday();
  const since = addKey(prev, -14);
  seed.groups = [{ name: 'Школа', caption: '8:30', days: [{ from: since, mask: '1111100' }] }];
  seed.items.push(
    r1Action('hw', 'Домашка', since, 'Школа', R1_ALL),                 // как блок: 5 дней
    r1Action('sw', 'Бассейн', since, 'Школа', '1010100'),              // своими: 3 дня
    r1Action('call', 'Звонок', since, '', '0000001'),                  // без блока: 1 день
    r1Action('new', 'Новое', daysAgo(0), '', R1_ALL),                  // заведено после недели: 0
    r1Action('hb', 'Зал', since, 'Школа', '1010100', { area: 'habit', normPerWeek: 3 })
  );
  const mark = (k, id) => { (seed.days[k] || (seed.days[k] = {}))[id] = true; };
  for (const i of [0, 1, 2, 5]) mark(addKey(prev, i), 'hw');         // суббота — вне плана
  mark(prev, 'sw');
  mark(prev, 'hb');
  return seed;
}

const r1GridRow = (grid, name) => {
  const n = [...grid.querySelectorAll('.g-name')].find(x => x.firstChild.textContent === name);
  assert.ok(n, 'строка сетки ' + name);
  return {
    plan: n.querySelector('.g-plan'),
    sr: n.querySelector('.sr-only').textContent,
    on: n.nextElementSibling.querySelectorAll('i.on').length
  };
};

test('Р1/2.2: сетка разбора — «запланировано 5 дней» и «из 5» у будничного, без подписи у ежедневного, без «из 0»', async () => {
  const { document } = await boot({ seed: r1ReviewSeed() });
  openReview(document);
  const review = document.getElementById('scr-review');
  const [minGrid, habitGrid] = review.querySelectorAll('.grid');

  const hw = r1GridRow(minGrid, 'Домашка');
  assert.ok(hw.plan, 'подпись у будничного действия есть');
  // число и слово — через неразрывный пробел (\u00a0): подпись в узкой
  // колонке переносится, и слово не должно отрываться от числа
  assert.equal(hw.plan.textContent, 'запланировано 5\u00a0дней');
  assert.equal(hw.plan.getAttribute('aria-hidden'), 'true', 'число D уже звучит в sr-only');
  assert.equal(hw.sr, ', отмечено 3 из 5', 'субботняя отметка вне плана в числитель не идёт');
  assert.equal(hw.on, 4, 'круги не меняются: отметка вне плана видна как отметка');

  const sw = r1GridRow(minGrid, 'Бассейн');
  assert.equal(sw.plan.textContent, 'запланировано 3\u00a0дня', 'свои дни ∧ дни блока; plural «дня»');
  assert.equal(sw.sr, ', отмечено 1 из 3');
  const call = r1GridRow(minGrid, 'Звонок');
  assert.equal(call.plan.textContent, 'запланировано 1\u00a0день', 'plural «день»');
  assert.equal(call.sr, ', отмечено 0 из 1');

  const daily = r1GridRow(minGrid, 'Тестовый пункт');
  assert.equal(daily.plan, null, 'у ежедневного подписи нет — семь дней ничего не сообщают');
  assert.equal(daily.sr, ', отмечено 2 из 7', 'как было');

  const fresh = r1GridRow(minGrid, 'Новое');
  assert.equal(fresh.plan, null, 'D = 0 — подписи нет');
  assert.equal(fresh.sr, ', не запланировано');
  assert.doesNotMatch(review.textContent, /из 0(?!\d)/, '«из 0» не печатается нигде');
  assert.doesNotMatch(review.textContent, /запланировано 0/);

  // привычке знаменатель прежний: у неё своя недельная логика (норма)
  const hb = r1GridRow(habitGrid, 'Зал');
  assert.equal(hb.plan, null);
  assert.equal(hb.sr, ', отмечено 1 из 7');

  // «Три закрытые недели» остаются «из 7» (решение документа, п. 2.2)
  const c = [...review.querySelectorAll('.consist .c-name')].find(x => x.textContent === 'Домашка');
  assert.match(c.nextElementSibling.textContent, / из 7$/);
});

test('Р1/сторож: отметки на «Сегодня» по фикстуре владельца — точечно = перерисовка', async () => {
  // вторник: в store есть действие, исключённое днями БЛОКА («Прогулка»), и
  // действие, исключённое СВОИМИ днями («Блок 3») — updateDayline обязан
  // исключать обоих тем же правилом, что renderToday
  const { document, window } = await bootR1Owner(1);
  const boxes = () => [...document.querySelectorAll('#scr-today input[data-act="mark"]')];
  assert.equal(boxes().length, 20);

  boxes()[0].click();
  assert.match(document.querySelector('#scr-today .bar-note').textContent, /^1\s*из\s*20$/);
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'первая отметка');

  for (const b of boxes().slice(1)) b.click();
  assert.match(document.querySelector('#scr-today .bar-note').textContent, /День закрыт/);
  await wait(T.DAY_CLOSE_MS + T.MOTION_TAIL_MS + 40); // сцена закрытия дня снимает свой след сама
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'день закрыт');

  // выполненные блоки свёрнуты (задача Р2, п. 4): «Школа» разворачивается
  // тапом, и её первое действие — первый круг на экране
  assert.equal(boxes().length, 0, 'после сцены все пять блоков свёрнуты');
  unfoldBlock(document, 'Школа');
  boxes()[0].click(); // первое действие «Школы»
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'снятие отметки');
});

test('Р1/4.6: «Система» — блок убирается, а не удаляется, и у него есть дни', async () => {
  const start = APP.indexOf('const SYSTEM_TEXTS = [');
  const src = APP.slice(start, APP.indexOf('\n];', start));
  assert.ok(start >= 0 && src.length > 500, 'литерал SYSTEM_TEXTS найден');
  assert.doesNotMatch(src, /удаля/i, 'ни в текстах, ни в комментарии рядом');

  const { document } = await boot();
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const sys = [...document.querySelectorAll('#scr-settings section.sys')].map(s => s.textContent).join('\n');
  assert.ok(sys.length > 0, 'раздел «Система» отрисован');
  assert.doesNotMatch(sys, /удал/i);
  assert.match(sys, /Блок — связка пунктов\. На дневном экране они соединены линией и идут подряд\. Линия показывает принадлежность, а не очередь: порядок не принудителен\. У блока есть дни недели; действие появляется в дни своего блока, а свои дни действия могут их только сузить\./);
  assert.match(sys, /Всё правится\. Блоки заводятся, переименовываются и убираются в Настройках → Расписание; убранный блок уводит из виду свои действия и привычки, отметки остаются\./);
});

test('Р1/CSS: подпись блока и подпись плана — существующие ступень и тон, перенос вместо обрезки', () => {
  const css = CSS_SRC();
  const label = ruleOf(css, '.g-label');
  assert.match(label, /display:\s*flex/);
  assert.match(label, /justify-content:\s*space-between/);
  assert.match(label, /align-items:\s*baseline/);
  assert.match(label, /gap:/);

  const cap = ruleOf(css, '.g-cap');
  assert.ok(cap, 'правило .g-cap');
  assert.match(cap, /font-size:\s*var\(--text-xs\)/, 'кегль — существующая ступень, как у имени блока');
  assert.match(cap, /color:\s*var\(--muted\)/, 'не тише надстрочника (З26/5.3)');
  assert.doesNotMatch(cap, /--faint/);
  assert.match(cap, /text-transform:\s*none/, 'подпись — слово владельца, без капители');
  assert.match(cap, /letter-spacing:\s*normal/);
  assert.match(cap, /font-weight:\s*400/);

  const plan = ruleOf(css, '.g-plan');
  assert.ok(plan, 'правило .g-plan');
  assert.match(plan, /display:\s*block/);
  assert.match(plan, /white-space:\s*normal/, 'переносится, а не режется многоточием имени');
  assert.match(plan, /color:\s*var\(--muted\)/);
  assert.match(plan, /font-size:\s*var\(--text-xs\)/);
});

/* ══ «Расписание 1/3», этап B: секции «Настроек» и конструктор ════════
   Карточки блоков вместо секций «Блоки» и «Пункты», форма блока с днями и
   пресетами, быстрое добавление действий, копия и уход блока, «Привычки»
   отдельной секцией. Форма правки ДЕЙСТВИЯ (режимы «как блок» / «свои») —
   этап C: здесь её открытие, строка и стрелки. */

const r1Settings = document => {
  document.querySelector('#tabs button[data-tab="settings"]').click();
  return document.getElementById('scr-settings');
};
const r1Card = (document, name) => [...document.querySelectorAll('#scr-settings .bcard[data-drag="group"]')]
  .find(c => c.dataset.dragId === name);
const r1Btn = (document, act, name) => [...document.querySelectorAll(`#scr-settings [data-act="${act}"]`)]
  .find(b => b.dataset.name === name);
const r1Saved = window => JSON.parse(window.localStorage.getItem(NS));
const r1Chips = document => [...document.querySelectorAll('#scr-settings [data-form] .days .btn.day')]
  .map(b => (b.getAttribute('aria-pressed') === 'true' ? '1' : '0')).join('');

/* Отказ формы: строка у нажатой кнопки, форма открыта, в store — ничего
   (правило задачи 26, п. 2.4) */
function r1Refused(document, window, act, say, before) {
  const said = document.querySelector('#scr-settings .flash.keep');
  assert.ok(said, 'отказ сказан: ' + say);
  assert.match(said.textContent, say);
  assert.ok(said.nextElementSibling.contains(document.querySelector(`#scr-settings [data-act="${act}"]`)), 'строка у нажатой кнопки');
  assert.equal(document.querySelectorAll('#scr-settings .flash.keep').length, 1, 'повторный отказ заменяет прежний');
  assert.equal(document.querySelector('#scr-settings .flash:not(.keep)'), null, '«Сохранено» не показано');
  assert.equal(document.querySelectorAll('#scr-settings [data-form]').length, 1, 'форма открыта');
  assert.equal(window.localStorage.getItem(NS), before, 'в store не записано ничего');
}

/* Малое хранилище: три блока — Утро (7:00, ежедневно), Школа (будни),
   Выходной (выходные); действия, недельный счётчик, привычка и параметр */
function r1SettingsSeed() {
  const since = daysAgo(10);
  const param = r1Action('ph', 'Отбой', since, '', R1_ALL, { type: 'param', area: 'habit', pkind: 'time', pvalue: 0, pstep: -15, history: [{ date: since, value: 0 }] });
  delete param.schedule;
  return r1Store(
    [r1Block('Утро', '7:00'), r1Block('Школа', 'до 15:15', [{ from: since, mask: '1111100' }]),
      r1Block('Выходной', '', [{ from: since, mask: '0000011' }])],
    [r1Action('u1', 'Кровать', since, 'Утро', R1_ALL),
      r1Action('u2', 'Развитие', since, 'Утро', R1_ALL, { note: '10 мин' }),
      r1Action('s1', 'Экстра', since, 'Школа', '1010100', { at: '11:45' }),
      r1Action('s2', 'Пост', since, 'Школа', R1_ALL, { value: 5, unit: 'мин', history: [{ date: since, value: 3 }, { date: daysAgo(2), value: 5 }] }),
      Object.assign(r1Action('sw', 'Спорт', since, 'Школа', R1_ALL, { type: 'weekly', goal: 3 }), { schedule: undefined }),
      r1Action('sh', 'Чтение', since, 'Школа', R1_ALL, { area: 'habit', normPerWeek: 5 }),
      r1Action('w1', 'Прогулка', since, 'Выходной', R1_ALL),
      param]
  );
}

test('Р1/B: карточки блоков — имя, подпись, сводка дней и строки действий по фикстуре владельца', async () => {
  const { document, window } = await bootR1Owner(1);
  window.addGroup('Зал', '', '1010100');
  const scr = r1Settings(document);
  const cards = [...scr.querySelectorAll('.bcard[data-drag="group"]')];
  assert.deepEqual(cards.map(c => c.dataset.dragId), ['Утро', 'Школа', 'Дом + Спорт', 'Учеба', 'Выходной', 'Вечер', 'Зал'],
    'порядок — store.groups');
  const head = c => [c.querySelector('.bhead .tname').textContent,
    c.querySelector('.bhead .bcap') ? c.querySelector('.bhead .bcap').textContent : null,
    c.querySelector('.bhead .meta').textContent];
  assert.deepEqual(cards.map(head), [
    ['Утро', '7:00', 'ежедневно'], ['Школа', '9:00–15:15 · вт, чт до 13:55', 'будни'],
    ['Дом + Спорт', 'с 15:20', 'будни'], ['Учеба', 'до 20:30', 'ежедневно'],
    ['Выходной', null, 'выходные'], ['Вечер', 'до 22:30', 'ежедневно'], ['Зал', null, 'пн, ср, пт']
  ]);
  // шапка — одна цель правки, у стрелок границы по живым блокам
  assert.equal(cards[0].querySelector('.bhead [data-act="group-open"]').getAttribute('aria-label'), 'изменить блок «Утро»');
  assert.equal(cards[0].querySelector('[data-act="group-up"]').disabled, true);
  assert.equal(cards[6].querySelector('[data-act="group-down"]').disabled, true);
  assert.equal(cards[1].querySelector('[data-act="group-up"]').disabled, false);
  // действия — в своей карточке, в порядке строк; подпись после « · »
  const rows = name => [...r1Card(document, name).querySelectorAll('.bbody .rowwrap[data-drag="item"]')];
  assert.equal(rows('Утро').length, 7);
  assert.equal(rows('Утро')[5].querySelector('.tname').textContent, 'Развитие · 10 мин');
  // дни в строке — только когда отличаются от дней блока: «Блок 3» — свои
  const b3 = rows('Учеба')[2];
  assert.equal(b3.querySelector('.tname').firstChild.textContent, 'Блок 3');
  assert.equal(b3.querySelector('.csub').textContent, ' · 50 минут / 10 перерыв · пн, ср, пт');
  assert.equal(rows('Школа')[1].querySelector('.csub').textContent, ' · 11:45', 'как блок — дни не повторяются');
  assert.equal(scr.querySelector('.bcard.loose'), null, 'действий без блока нет — и карточки «Без блока» нет');
});

test('Р1/B: строка действия — время, подпись, значение, цель, свои дни; пустые дни названы; история — в форме', async () => {
  const seed = r1SettingsSeed();
  seed.items.push(r1Action('z1', 'Ноль', daysAgo(10), 'Выходной', '1111100')); // ∧ выходные = пусто (импорт)
  seed.items.push(r1Action('x1', 'Разметка', daysAgo(10), 'Утро', R1_ALL, { note: '<i>курсив</i>' }));
  const { document } = await boot({ seed });
  r1Settings(document);
  const sub = id => {
    const r = [...document.querySelectorAll('#scr-settings .rowwrap[data-drag="item"]')].find(x => x.dataset.dragId === id);
    const c = r.querySelector('.csub');
    return c ? c.textContent : null;
  };
  assert.equal(sub('u1'), null, 'без подписи — только имя');
  assert.equal(sub('u2'), ' · 10 мин');
  assert.equal(sub('s1'), ' · 11:45 · пн, ср, пт', 'время первым, свои дни — последними');
  assert.equal(sub('s2'), ' · 5 мин');
  assert.equal(sub('sw'), ' · цель 3 / нед.', 'у недельного счётчика дней нет');
  assert.equal(sub('z1'), ' · ни одного дня');
  assert.equal(sub('x1'), ' · <i>курсив</i>', 'подпись — слово владельца, печатается текстом');
  assert.equal(document.querySelector('#scr-settings .csub i'), null, 'и разметкой не становится');
  assert.doesNotMatch(document.getElementById('scr-settings').textContent, /Планка:/, 'истории в строке нет');
  [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')].find(b => b.dataset.id === 's2').click();
  assert.match(document.querySelector('#scr-settings [data-form="edit"] p.muted .hist').textContent, /^Планка: 3 → 5 мин · с /);
});

test('Р1/B: свёртка карточки — шевроном, фокус на нём, переживает перерисовку и переименование', async () => {
  const { document, window } = await boot({ seed: r1SettingsSeed() });
  r1Settings(document);
  const fold = name => r1Btn(document, 'group-fold', name);
  const body = name => document.getElementById(fold(name).getAttribute('aria-controls'));
  assert.equal(fold('Утро').getAttribute('aria-expanded'), 'true', 'по умолчанию развёрнуты все');
  assert.equal(body('Утро').hidden, false);
  assert.ok(r1Card(document, 'Утро').contains(body('Утро')), 'aria-controls указывает на тело своей карточки');

  fold('Утро').click();
  assert.equal(document.activeElement, fold('Утро'), 'фокус — на том же шевроне');
  assert.equal(fold('Утро').getAttribute('aria-expanded'), 'false');
  assert.equal(fold('Утро').getAttribute('aria-label'), 'развернуть «Утро»');
  assert.equal(body('Утро').hidden, true);
  assert.equal(document.getElementById('g-name'), null, 'свёртка — не форма');

  // перерисовка по чужому поводу свёртку не теряет
  r1Btn(document, 'group-down', 'Школа').click();
  assert.equal(body('Утро').hidden, true);
  // переименование уносит свёртку с собой
  r1Btn(document, 'group-open', 'Утро').click();
  document.getElementById('g-name').value = 'Рассвет';
  r1Btn(document, 'group-save', 'Утро').click();
  assert.equal(r1Saved(window).groups[0].name, 'Рассвет');
  assert.equal(body('Рассвет').hidden, true, 'ключ свёртки перенесён на новое имя');
  fold('Рассвет').click();
  assert.equal(body('Рассвет').hidden, false);
  assert.equal(fold('Рассвет').getAttribute('aria-label'), 'свернуть «Рассвет»');

  // возврат действия из «Убранных» кладёт строку и подтверждение в свёрнутую
  // карточку — она разворачивается (п. 4.2)
  removeItemThroughUi(document, 'u2');
  fold('Рассвет').click();
  assert.equal(body('Рассвет').hidden, true);
  r1Settings(document); // короткий путь снят — остаётся длинный
  [...document.querySelectorAll('#scr-settings .rowwrap.gone [data-act="item-restore"]')].find(b => b.dataset.id === 'u2').click();
  assert.equal(body('Рассвет').hidden, false, 'карточка развернулась');
  const flash = document.querySelector('#scr-settings .flash');
  assert.ok(body('Рассвет').contains(flash), 'подтверждение — у вернувшейся строки, и оно видно');
});

test('Р1/B: якорь в свёрнутой карточке — она разворачивается, подтверждение видно, скролл не прыгает', async () => {
  const { document, window } = await boot({ seed: r1SettingsSeed() });
  r1Settings(document);
  r1Btn(document, 'group-fold', 'Утро').click();
  // геометрия: скрытое — нулевой прямоугольник (как в браузере), видимое — на 400
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const top = this.closest('[hidden]') ? 0 : 400;
    return { top, bottom: top + 44, height: top ? 44 : 0, left: 0, right: 375, width: 375, x: 0, y: top };
  };
  const jumps = [];
  window.scrollTo = (x, y) => jumps.push(y);

  // перенос действия в свёрнутый блок: подтверждение ляжет в его тело
  [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')].find(b => b.dataset.id === 'w1').click();
  const sel = document.getElementById('e-group');
  sel.value = 'Утро';
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  const flash = document.querySelector('#scr-settings .flash');
  assert.ok(flash, 'подтверждение есть');
  assert.ok(r1Card(document, 'Утро').contains(flash), 'у строки в целевой карточке');
  assert.equal(flash.closest('[hidden]'), null, 'и видно: карточка развёрнута до перерисовки');
  assert.deepEqual(jumps, [], 'узел встал туда, где стояла кнопка, — скролл не тронут');

  // сторож выборки: узел в скрытом теле карточки якорем не считается
  const hiddenBody = document.createElement('div');
  hiddenBody.hidden = true;
  hiddenBody.innerHTML = '<p class="flash">скрытый</p><p class="gone-note">скрытый</p>';
  document.querySelector('#scr-settings .blocks').prepend(hiddenBody);
  const btn = document.querySelector('#scr-settings [data-act="group-add-open"]');
  assert.equal(window.eval('visibleFlash')(), flash, 'подтверждение — видимое, а не первое в DOM');
  window.keepInPlace(btn, () => {});
  const shownNote = document.createElement('p');
  shownNote.className = 'gone-note';
  document.querySelector('#scr-settings .blocks').append(shownNote);
  assert.equal(window.eval('goneNoteEl')(), shownNote, 'короткий путь назад — тем же правилом');
  window.keepInPlace(btn, () => {}, window.eval('goneNoteEl'));
  assert.deepEqual(jumps, [], 'первый в DOM, но скрытый узел не уводит скролл на высоту кнопки');
});

test('Р1/B: форма блока — чипы и пресеты, «Будни» пишется отрезком с сегодня и даёт сводку «будни»', async () => {
  const { document, window } = await boot({ seed: r1SettingsSeed() });
  r1Settings(document);
  r1Btn(document, 'group-open', 'Утро').click();
  const form = () => document.querySelector('#scr-settings [data-form="group-edit"]');
  assert.equal(form().dataset.id, 'Утро');
  assert.ok(r1Card(document, 'Утро').contains(form()), 'форма — в карточке своего блока');
  assert.equal(document.getElementById('g-cap').value, '7:00');
  assert.equal(document.getElementById('g-cap').getAttribute('placeholder'), 'например: 7:00');
  assert.equal(r1Chips(document), '1111111', 'чипы — дни блока');
  assert.deepEqual([...form().querySelectorAll('.presets [data-act="days-preset"]')].map(b => [b.textContent, b.dataset.mask]),
    [['Ежедневно', '1111111'], ['Будни', '1111100'], ['Выходные', '0000011']]);
  assert.ok(form().querySelector('.days').compareDocumentPosition(form().querySelector('.presets')) & 4, 'пресеты — под чипами');

  const preset = mask => form().querySelector(`[data-act="days-preset"][data-mask="${mask}"]`);
  preset('1111100').click();
  assert.equal(r1Chips(document), '1111100');
  assert.equal(document.activeElement, preset('1111100'), 'фокус — тот же пресет');
  assert.deepEqual(r1Saved(window).groups[0].days, [], 'пресет правит черновик, не данные');
  // чип правит тот же черновик — дни БЛОКА, а не пункта
  form().querySelector('[data-act="day-toggle"][data-day="5"]').click();
  assert.equal(r1Chips(document), '1111110');
  assert.equal(document.activeElement.dataset.day, '5', 'фокус — тот же чип');
  preset('1111100').click();

  r1Btn(document, 'group-save', 'Утро').click();
  assert.deepEqual(r1Saved(window).groups[0].days, [{ from: daysAgo(0), mask: '1111100' }], 'отрезок с сегодняшнего дня');
  assert.deepEqual(r1Saved(window).items.find(i => i.id === 'u1').schedule, [{ from: daysAgo(10), mask: R1_ALL }], 'маски действий не тронуты');
  assert.equal(r1Card(document, 'Утро').querySelector('.bhead .meta').textContent, 'будни');
  assert.equal(document.querySelector('#scr-settings [data-form]'), null, 'форма закрылась');
  const flash = document.querySelector('#scr-settings .flash');
  assert.equal(flash.textContent, 'Сохранено');
  assert.ok(r1Card(document, 'Утро').contains(flash) && !flash.closest('.bbody'), 'у шапки блока');

  // повторная смена в тот же день заменяет отрезок, возврат к прежним дням его снимает
  r1Btn(document, 'group-open', 'Утро').click();
  preset('1111111').click();
  r1Btn(document, 'group-save', 'Утро').click();
  assert.deepEqual(r1Saved(window).groups[0].days, [], 'схлопнулось: прошлое о днях не знает');
  assert.equal(r1Card(document, 'Утро').querySelector('.bhead .meta').textContent, 'ежедневно');
  // подпись пишется trim'ом и пустой бывает
  r1Btn(document, 'group-open', 'Утро').click();
  document.getElementById('g-cap').value = '  ';
  r1Btn(document, 'group-save', 'Утро').click();
  assert.equal(r1Saved(window).groups[0].caption, '');
  assert.equal(r1Card(document, 'Утро').querySelector('.bcap'), null, 'пустая подпись не печатается');
});

test('Р1/B: отказы формы блока — пусто, занято, убран, нет дней, «не останется ни одного дня», хранилище', async () => {
  const seed = r1SettingsSeed();
  seed.groups.push(Object.assign(r1Block('Ушедший'), { removedAt: daysAgo(3) }));
  const { document, window } = await boot({ seed });
  r1Settings(document);
  const before = window.localStorage.getItem(NS);
  const attempt = (block, setup, say) => {
    if (!document.querySelector(`#scr-settings [data-form="group-edit"][data-id="${block}"]`)) r1Btn(document, 'group-open', block).click();
    setup();
    const typed = document.getElementById('g-name').value;
    r1Btn(document, 'group-save', block).click();
    r1Refused(document, window, 'group-save', say, before);
    assert.equal(document.getElementById('g-name').value, typed, 'имя в поле цело');
  };
  attempt('Утро', () => { document.getElementById('g-name').value = '  '; }, /^Название не заполнено$/);
  attempt('Утро', () => { document.getElementById('g-name').value = 'Школа'; }, /^Это имя уже занято$/);
  attempt('Утро', () => { document.getElementById('g-name').value = 'Ушедший'; }, /^Блок «Ушедший» убран — вернуть можно в «Убранных»$/);
  document.querySelector('#scr-settings [data-act="group-cancel"]').click();

  // нет дней: все чипы сняты
  attempt('Утро', () => {
    for (let i = 0; i < 7; i++) document.querySelector(`#scr-settings [data-act="day-toggle"][data-day="${i}"]`).click();
  }, /^Нужен хотя бы один день недели$/);
  assert.equal(r1Chips(document), '0000000', 'снятые дни в форме целы');
  document.querySelector('#scr-settings [data-act="group-cancel"]').click();

  // «Экстра» — свои дни пн, ср, пт: в выходные у неё не останется ни одного
  attempt('Школа', () => {
    document.querySelector('#scr-settings [data-act="days-preset"][data-mask="0000011"]').click();
  }, /^Не останется ни одного дня: Экстра$/);
  assert.equal(r1Chips(document), '0000011', 'выбранный пресет в форме цел');
  document.querySelector('#scr-settings [data-act="group-cancel"]').click();

  // хранилище отказало: откат целиком, форма и ввод на месте
  r1Btn(document, 'group-open', 'Утро').click();
  document.getElementById('g-name').value = 'Рассвет';
  document.getElementById('g-cap').value = '6:30';
  document.querySelector('#scr-settings [data-act="days-preset"][data-mask="1111100"]').click();
  withBrokenStorage(window, () => r1Btn(document, 'group-save', 'Утро').click());
  r1Refused(document, window, 'group-save', /^Не сохранено: хранилище недоступно$/, before);
  assert.equal(document.getElementById('g-name').value, 'Рассвет');
  assert.equal(document.getElementById('g-cap').value, '6:30');
  assert.equal(r1Chips(document), '1111100');
  // и в памяти ничего не осталось: следующая удачная запись — прежнее состояние + своё
  document.querySelector('#scr-settings [data-act="group-cancel"]').click();
  r1Btn(document, 'group-down', 'Утро').click();
  assert.deepEqual(r1Saved(window).groups.slice(0, 2).map(g => [g.name, g.caption, g.days]),
    [['Школа', 'до 15:15', [{ from: daysAgo(10), mask: '1111100' }]], ['Утро', '7:00', []]], 'откат был полным');
});

test('Р1/B: «Добавить блок» — подпись и дни, в конец, подтверждение у новой карточки; отказы', async () => {
  const seed = r1SettingsSeed();
  seed.groups.push(Object.assign(r1Block('Ушедший'), { removedAt: daysAgo(3) }));
  const { document, window } = await boot({ seed });
  r1Settings(document);
  const before = window.localStorage.getItem(NS);
  const open = () => { if (!document.getElementById('g-add')) document.querySelector('#scr-settings [data-act="group-add-open"]').click(); };
  const save = () => document.querySelector('#scr-settings [data-act="group-add-save"]').click();

  open();
  assert.equal(r1Chips(document), '1111111', 'новый блок — по умолчанию ежедневно');
  assert.ok(document.querySelector('#scr-settings [data-form="group-add"] [data-act="days-preset"]'), 'пресеты есть');
  for (const [name, say] of [['', /^Название не заполнено$/], ['Утро', /^Это имя уже занято$/],
    ['Ушедший', /^Блок «Ушедший» убран — вернуть можно в «Убранных»$/]]) {
    document.getElementById('g-add').value = name;
    save();
    r1Refused(document, window, 'group-add-save', say, before);
    assert.equal(document.getElementById('g-add').value, name);
  }
  for (let i = 0; i < 7; i++) document.querySelector(`#scr-settings [data-act="day-toggle"][data-day="${i}"]`).click();
  document.getElementById('g-add').value = 'Зал';
  save();
  r1Refused(document, window, 'group-add-save', /^Нужен хотя бы один день недели$/, before);

  document.querySelector('#scr-settings [data-act="days-preset"][data-mask="0000011"]').click();
  document.querySelector('#scr-settings [data-act="day-toggle"][data-day="2"]').click();
  document.getElementById('g-add').value = '  Зал  ';
  document.getElementById('g-add-cap').value = ' 18:00 ';
  save();
  const s = r1Saved(window);
  // v20 (Р2): новый блок — в активном режиме, здесь основном
  assert.deepEqual(s.groups[s.groups.length - 1], { name: 'Зал', caption: '18:00', days: [{ from: daysAgo(0), mask: '0010011' }], removedAt: null, mode: 'main' });
  assert.equal(document.getElementById('g-add'), null, 'форма закрылась');
  const card = r1Card(document, 'Зал');
  assert.equal(card.querySelector('.bhead .meta').textContent, 'ср, сб, вс');
  assert.equal(card.querySelector('.bhead .bcap').textContent, '18:00');
  assert.equal(document.querySelector('#scr-settings .flash').textContent, 'Сохранено');
  assert.ok(card.contains(document.querySelector('#scr-settings .flash')), 'у новой карточки');
  // «Отмена» черновик дней снимает: следующее открытие — снова «ежедневно»
  open();
  document.querySelector('#scr-settings [data-act="days-preset"][data-mask="1111100"]').click();
  document.querySelector('#scr-settings [data-act="group-add-cancel"]').click();
  open();
  assert.equal(r1Chips(document), '1111111');
});

test('Р1/B: «Добавить действия» — строки фикстуры «Утро» становятся действиями блока по порядку', async () => {
  const { document, window } = await boot({ seed: r1Store([r1Block('Утро', '7:00'), r1Block('Вечер')], []) });
  r1Settings(document);
  const card = () => r1Card(document, 'Утро');
  const lines = R1_OWNER[0].lines;
  r1Btn(document, 'quick-open', 'Утро').click();
  const form = card().querySelector('.bbody [data-form="quick"]');
  assert.ok(form, 'форма — в теле карточки своего блока');
  assert.ok(form.classList.contains('card') && form.classList.contains('form'), 'карточка формы: исключение перетаскивания');
  assert.equal(r1Btn(document, 'quick-open', 'Утро'), undefined, 'кнопки на время формы нет — форма на её месте');
  const ta = document.getElementById('q-lines');
  assert.equal(ta.tagName, 'TEXTAREA');
  assert.equal(ta.getAttribute('placeholder'), 'Кровать\nРазвитие · 10 мин');
  assert.match(form.textContent, /Действия — по одному в строке/);
  assert.match(form.textContent, /Подпись — после « · » или « - »\./);

  const before = window.localStorage.getItem(NS);
  document.querySelector('#scr-settings [data-act="quick-save"]').click();
  r1Refused(document, window, 'quick-save', /^Ни одной строки$/, before);

  const typed = '\n' + lines.join('\n\n') + '\n   \n';
  ta.value = typed;
  withBrokenStorage(window, () => document.querySelector('#scr-settings [data-act="quick-save"]').click());
  r1Refused(document, window, 'quick-save', /^Не добавлено: хранилище недоступно$/, before);
  assert.equal(document.getElementById('q-lines').value, typed, 'текст в поле цел');

  document.querySelector('#scr-settings [data-act="quick-save"]').click();
  const items = r1Saved(window).items;
  assert.equal(items.length, lines.length, 'пустые строки не стали действиями');
  assert.deepEqual(items.map(i => [i.name, i.note, i.group, i.type, i.area]), [
    ['Кровать', '', 'Утро', 'daily', 'min'], ['Шторы', '', 'Утро', 'daily', 'min'],
    ['Стакан воды', '', 'Утро', 'daily', 'min'], ['Телефон (музыка)', '', 'Утро', 'daily', 'min'],
    ['Умывание + глаза', '', 'Утро', 'daily', 'min'], ['Развитие', '10 мин', 'Утро', 'daily', 'min'],
    ['Завтрак + еда на обед', '', 'Утро', 'daily', 'min']
  ]);
  assert.deepEqual(items[0].schedule, [{ from: daysAgo(0), mask: R1_ALL }], '«как блок» с сегодняшнего дня');
  assert.equal(document.getElementById('q-lines'), null, 'форма закрылась');
  const flash = card().querySelector('.flash');
  assert.equal(flash.textContent, `Добавлено: ${lines.length}`);
  assert.ok(flash.previousElementSibling.classList.contains('list'), 'сразу за списком карточки');
  assert.equal(flash.nextElementSibling.dataset.act, 'quick-open', 'на месте кнопки «Добавить действия»');
  assert.deepEqual([...card().querySelectorAll('.bbody .rowwrap [data-act="edit-open"]')].map(b => b.dataset.id), items.map(i => i.id),
    'строки карточки — в порядке набора');
  assert.equal(r1Card(document, 'Вечер').querySelectorAll('.rowwrap').length, 0, 'чужой блок пуст');
  // повторное открытие — пустое поле: сохранённое черновиком не возвращается
  r1Btn(document, 'quick-open', 'Утро').click();
  assert.equal(document.getElementById('q-lines').value, '');
  // и на «Сегодня» они на месте
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.match(document.querySelector('#scr-today .bar-note').textContent, new RegExp(`0\\s*из\\s*${lines.length}`));
});

test('Р1/B: «Без блока» — карточка без дней и формы блока, быстрое добавление, короткий путь последнего', async () => {
  // блоков нет вовсе: карточка «Без блока» — единственное место, где родиться действию
  const a = await boot({ seed: r1Store([], []) });
  r1Settings(a.document);
  const loose = () => a.document.querySelector('#scr-settings .bcard.loose');
  assert.ok(loose());
  assert.equal(loose().dataset.drag, undefined, 'не перетаскивается');
  assert.equal(loose().querySelector('[data-act="group-open"], [data-act="group-fold"], .meta'), null, 'ни формы блока, ни дней');
  assert.equal(loose().querySelector('.g-label').textContent, 'Без блока');
  r1Btn(a.document, 'quick-open', '').click();
  assert.equal(loose().querySelector('[data-form="quick"]').dataset.id, '');
  a.document.getElementById('q-lines').value = 'Одно · подпись\nДругое';
  a.document.querySelector('#scr-settings [data-act="quick-save"]').click();
  assert.deepEqual(r1Saved(a.window).items.map(i => [i.name, i.note, i.group]), [['Одно', 'подпись', ''], ['Другое', '', '']]);
  assert.equal(loose().querySelector('.flash').textContent, 'Добавлено: 2', 'подтверждение — в карточке «Без блока»');

  // блоки есть, действий без блока нет — карточки нет
  const b = await boot({ seed: r1SettingsSeed() });
  r1Settings(b.document);
  assert.equal(b.document.querySelector('#scr-settings .bcard.loose'), null);

  // последнее действие без блока убрано — карточка остаётся ради «Вернуть» (п. 4.4)
  const seed = r1SettingsSeed();
  seed.items = seed.items.filter(i => i.id !== 'ph');
  seed.items.push(r1Action('l1', 'Одинокое', daysAgo(10), '', R1_ALL));
  seed.items.push(r1Action('lh', 'Привычка сама по себе', daysAgo(10), '', R1_ALL, { area: 'habit', normPerWeek: 7 }));
  const c = await boot({ seed });
  removeItemThroughUi(c.document, 'l1');
  const cl = c.document.querySelector('#scr-settings .bcard.loose');
  assert.ok(cl, 'карточка «Без блока» на месте');
  assert.ok(cl.querySelector('.gone-note [data-act="item-restore"]'), 'в ней — короткий путь назад');
  assert.equal(c.document.activeElement.dataset.act, 'item-restore', 'фокус на «Вернуть»');
  // то же у привычки без блока в секции «Привычки»
  removeItemThroughUi(c.document, 'lh');
  const habits = [...c.document.querySelectorAll('#scr-settings details.sect')].find(d => /^Привычки/.test(d.querySelector('summary').textContent));
  assert.ok(habits.querySelector('.gone-note [data-act="item-restore"]'), 'раздел без блока в «Привычках» держит «Вернуть»');
});

test('Р1/B: «Дублировать блок» — копия с действиями и днями за источником; подтверждение у источника; отказ', async () => {
  const { document, window } = await boot({ seed: r1SettingsSeed() });
  r1Settings(document);
  r1Btn(document, 'group-open', 'Школа').click();
  const dup = () => r1Btn(document, 'group-dup', 'Школа');
  assert.equal(dup().textContent, 'Дублировать блок');
  assert.equal(dup().parentElement.children.length, 1, 'в своём ряду');
  const before = window.localStorage.getItem(NS);
  withBrokenStorage(window, () => dup().click());
  r1Refused(document, window, 'group-dup', /^Не скопировано: хранилище недоступно$/, before);

  dup().click();
  const s = r1Saved(window);
  assert.deepEqual(s.groups.map(g => g.name), ['Утро', 'Школа', 'Школа (копия)', 'Выходной'], 'копия — сразу за источником');
  // v20 (Р2): копия — в режиме источника, здесь основном
  assert.deepEqual(s.groups[2], { name: 'Школа (копия)', caption: 'до 15:15', days: [{ from: daysAgo(0), mask: '1111100' }], removedAt: null, mode: 'main' });
  const copies = s.items.filter(i => i.group === 'Школа (копия)');
  assert.deepEqual(copies.map(i => [i.name, i.type, i.addedAt]), [['Экстра', 'daily', daysAgo(0)], ['Пост', 'daily', daysAgo(0)], ['Спорт', 'weekly', daysAgo(0)]],
    'действия — daily и weekly, привычка не копируется');
  assert.deepEqual(copies[0].schedule, [{ from: daysAgo(0), mask: '1010100' }], 'свои дни у копии те же');
  assert.equal(document.querySelector('#scr-settings [data-form]'), null, 'формы закрыты');
  const flash = document.querySelector('#scr-settings .flash');
  assert.equal(flash.textContent, 'Копия создана: «Школа (копия)»');
  assert.ok(r1Card(document, 'Школа').contains(flash) && !flash.closest('.bbody'), 'у шапки источника, где стояла форма');
  assert.equal(r1Card(document, 'Школа').nextElementSibling, r1Card(document, 'Школа (копия)'), 'карточка копии — следом');
  assert.equal(r1Card(document, 'Школа (копия)').querySelectorAll('.bbody .rowwrap').length, 3);

  r1Btn(document, 'group-open', 'Школа').click();
  dup().click();
  assert.equal(r1Saved(window).groups[2].name, 'Школа (копия 2)', 'занятое имя копии — следующий номер');
});

test('Р1/B: «Убрать блок» — вторым тапом; действия и привычки уходят; «Вернуть» коротко и из «Убранных»', async () => {
  const { document, window } = await boot({ seed: r1SettingsSeed() });
  const marked = [...document.querySelectorAll('#scr-today input[data-act="mark"]')][0];
  const markedId = marked.dataset.id;
  marked.click();
  r1Settings(document);
  r1Btn(document, 'group-fold', 'Школа').click(); // свёрнутая — возврат обязан её развернуть
  r1Btn(document, 'group-open', 'Школа').click();
  const rm = () => r1Btn(document, 'group-remove', 'Школа');
  const form = () => document.querySelector('#scr-settings [data-form="group-edit"]');
  const lead = () => [...form().children].slice(0, [...form().children].indexOf(rm().parentElement)).map(n => n.outerHTML).join('');
  const was = lead();
  assert.equal(rm().textContent, 'Убрать блок');
  assert.equal(rm().parentElement.children.length, 1, '«Убрать блок» — в своём ряду');
  rm().click();
  assert.equal(rm().textContent, 'Подтвердить: убрать блок');
  assert.equal(lead(), was, 'над кнопкой ничего не выросло — она не сдвинулась');
  const consequence = rm().parentElement.nextElementSibling;
  assert.equal(consequence.textContent, 'Блок уйдёт из списков вместе с действиями и привычками. Отметки и прошлые дни останутся как есть.',
    'последствие — под кнопкой');
  assert.equal(r1Saved(window).groups[1].removedAt, null, 'первый тап не убирает');

  const daysBefore = JSON.stringify(r1Saved(window).days);
  rm().click();
  let s = r1Saved(window);
  assert.equal(s.groups[1].removedAt, daysAgo(0));
  assert.deepEqual(s.items.filter(i => i.group === 'Школа').map(i => [i.id, i.removedAt]),
    [['s1', daysAgo(0)], ['s2', daysAgo(0)], ['sw', daysAgo(0)], ['sh', daysAgo(0)]], 'действия, счётчик и привычка ушли вместе с блоком');
  assert.equal(JSON.stringify(s.days), daysBefore, 'отметки не тронуты');
  assert.equal(r1Card(document, 'Школа'), undefined, 'карточки нет');
  const note = document.querySelector('#scr-settings .blocks > .gone-note');
  assert.equal(note.textContent, 'Школа · убранВернуть');
  assert.equal(note.previousElementSibling, r1Card(document, 'Утро'), 'на месте карточки');
  assert.equal(document.activeElement, note.querySelector('[data-act="group-restore"]'), 'фокус на «Вернуть»');
  const goneRows = () => [...document.querySelectorAll('#scr-settings .rowwrap.gone')];
  assert.equal(goneRows().some(r => /Школа/.test(r.textContent)), false, 'в «Убранных» блок не дублируется');
  assert.equal(goneRows().some(r => /Экстра|Пост|Чтение/.test(r.textContent)), false, 'ушедшее с блоком — не отдельными строками');
  document.querySelector('#tabs button[data-tab="habits"]').click();
  assert.doesNotMatch(document.getElementById('scr-habits').textContent, /Чтение/, 'привычка блока ушла и с «Привычек»');

  // короткий путь не пережил уход с экрана — длинный на месте
  r1Settings(document);
  assert.equal(document.querySelector('#scr-settings .blocks > .gone-note'), null);
  const row = goneRows().find(r => r.querySelector('[data-act="group-restore"]'));
  assert.equal(row.querySelector('.tname').textContent, 'Школа');
  assert.match(row.querySelector('.meta').textContent, /^убран /);
  row.querySelector('[data-act="group-restore"]').click();
  s = r1Saved(window);
  assert.equal(s.groups[1].removedAt, null, 'блок вернулся');
  assert.deepEqual(s.items.filter(i => i.group === 'Школа').map(i => [i.id, i.removedAt]),
    [['s1', null], ['s2', null], ['sw', null], ['sh', null]], 'в тот же день — те же записи');
  assert.ok(r1Card(document, 'Школа'), 'карточка на месте');
  assert.equal(r1Card(document, 'Школа').querySelectorAll('.bbody .rowwrap').length, 3, 'с действиями');
  assert.equal(r1Card(document, 'Школа').querySelector('.bbody').hidden, false, 'и развёрнута: возврат ложится в неё (п. 4.2)');
  assert.equal(document.querySelector('#scr-settings .flash').textContent, 'Сохранено');
  assert.ok(r1Card(document, 'Школа').contains(document.querySelector('#scr-settings .flash')));
  assert.equal(r1Saved(window).days[daysAgo(0)][markedId], true);

  // отказ записи у короткого пути — строкой, блок остаётся убранным
  r1Btn(document, 'group-open', 'Выходной').click();
  r1Btn(document, 'group-remove', 'Выходной').click();
  r1Btn(document, 'group-remove', 'Выходной').click();
  const back = document.querySelector('#scr-settings .blocks > .gone-note [data-act="group-restore"]');
  withBrokenStorage(window, () => back.click());
  assert.match(document.querySelector('#scr-settings .flash.keep').textContent, /^Не возвращено: хранилище недоступно$/);
  assert.equal(r1Saved(window).groups[2].removedAt, daysAgo(0));
  // и у ухода — тоже: форма цела, блок жив
  r1Settings(document);
  r1Btn(document, 'group-open', 'Утро').click();
  r1Btn(document, 'group-remove', 'Утро').click();
  const before = window.localStorage.getItem(NS);
  withBrokenStorage(window, () => r1Btn(document, 'group-remove', 'Утро').click());
  r1Refused(document, window, 'group-remove', /^Не убрано: хранилище недоступно$/, before);
});

test('Р1/B: стрелки и перетаскивание блоков — среди живых, убранный перепрыгивается; тело карточки не захватывает', async () => {
  const seed = r1Store([r1Block('A'), Object.assign(r1Block('B'), { removedAt: daysAgo(2) }), r1Block('C')],
    [r1Action('a1', 'Первое', daysAgo(10), 'A', R1_ALL), r1Action('a2', 'Второе', daysAgo(10), 'A', R1_ALL)]);
  const { document, window } = await boot({ seed });
  r1Settings(document);
  assert.equal(r1Btn(document, 'group-down', 'A').disabled, false, 'ниже A — живой C, убранный соседом не считается');
  assert.equal(r1Btn(document, 'group-down', 'C').disabled, true);
  r1Btn(document, 'group-down', 'A').click();
  assert.deepEqual(r1Saved(window).groups.map(g => g.name), ['C', 'B', 'A'], 'убранный держит своё место');
  assert.equal(document.activeElement.dataset.act, 'group-up', 'на краю фокус — парной стрелке');
  assert.equal(document.activeElement.dataset.name, 'A');
  r1Btn(document, 'group-up', 'A').click();
  assert.deepEqual(r1Saved(window).groups.map(g => g.name), ['A', 'B', 'C']);

  const cards = () => [...document.querySelectorAll('#scr-settings [data-drag="group"]')];
  assert.deepEqual(cards().map(c => c.dataset.dragId), ['A', 'C']);
  // долгое нажатие на «Добавить действия», на тело карточки и на подтверждение — не захват
  const bodyTargets = () => [r1Btn(document, 'quick-open', 'A'), r1Card(document, 'A').querySelector('.bbody'),
    r1Card(document, 'A').querySelector('.bbody .list')];
  for (const target of bodyTargets()) {
    stubRows(cards());
    target.dispatchEvent(pointer(window, 'pointerdown', 100, 230));
    await hold();
    assert.equal(document.querySelector('.drag-live'), null, 'захвата нет: ' + (target.dataset.act || target.className));
    document.dispatchEvent(pointer(window, 'pointerup', 100, 230));
  }
  // подтверждение в строке действия — не рукоять: долгое нажатие на
  // «Сохранено» не поднимает строку (п. 4.3)
  [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')].find(b => b.dataset.id === 'a1').click();
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  const saved = r1Card(document, 'A').querySelector('[data-drag="item"] .flash');
  assert.ok(saved, 'подтверждение стоит внутри строки');
  stubRows([...r1Card(document, 'A').querySelectorAll('[data-drag="item"]')]);
  saved.dispatchEvent(pointer(window, 'pointerdown', 100, 230));
  await hold();
  assert.equal(document.querySelector('.drag-live'), null, 'за подтверждение строку не берут');
  document.dispatchEvent(pointer(window, 'pointerup', 100, 230));

  // строка действия в карточке — своя цель: поднимается строка, а не блок
  const rowsA = () => [...r1Card(document, 'A').querySelectorAll('[data-drag="item"]')];
  stubRows(rowsA());
  rowsA()[0].querySelector('.tname').dispatchEvent(pointer(window, 'pointerdown', 100, 230));
  await hold();
  assert.equal(rowsA()[0].classList.contains('drag-live'), true, 'захвачена строка');
  assert.equal(r1Card(document, 'A').classList.contains('drag-live'), false, 'а не карточка');
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.dispatchEvent(pointer(window, 'pointerup', 100, 230));
  await hold(); // клик, заглушённый после перетаскивания, отпускается

  // шапка — захват: C встаёт над A
  stubRows(cards());
  r1Card(document, 'C').querySelector('.bhead').dispatchEvent(pointer(window, 'pointerdown', 100, 290));
  await hold();
  assert.equal(r1Card(document, 'C').classList.contains('drag-live'), true, 'за шапку — захват');
  document.dispatchEvent(pointer(window, 'pointermove', 100, 215));
  document.dispatchEvent(pointer(window, 'pointerup', 100, 215));
  assert.deepEqual(r1Saved(window).groups.map(g => g.name), ['C', 'B', 'A'], 'позиция среди живых; B на своём месте');
});

test('Р1/B: секция «Привычки» — по живым блокам, заголовок без подписи и дней, затем без блока', async () => {
  const seed = r1SettingsSeed();
  seed.items.push(r1Action('uh', 'Медитация', daysAgo(10), 'Утро', R1_ALL, { area: 'habit', normPerWeek: 7 }));
  seed.items.push(r1Action('gh', 'Вне', daysAgo(10), 'Ушедший', R1_ALL, { area: 'habit', normPerWeek: 7, removedAt: daysAgo(3) }));
  seed.items.push(r1Action('rh', 'Бывшая', daysAgo(10), 'Школа', R1_ALL, { area: 'habit', normPerWeek: 7, removedAt: daysAgo(4) }));
  seed.groups.push(Object.assign(r1Block('Ушедший'), { removedAt: daysAgo(3) }));
  const { document } = await boot({ seed });
  r1Settings(document);
  const sect = [...document.querySelectorAll('#scr-settings details.sect')].find(d => /^Привычки/.test(d.querySelector('summary').textContent));
  assert.ok(sect, 'секция «Привычки» найдена');
  const b = sect.querySelector('.sect-b');
  const labels = [...b.querySelectorAll(':scope > .g-label')];
  assert.deepEqual(labels.map(l => l.textContent), ['Утро', 'Школа', 'Без блока'], 'только блоки с привычками, в порядке store.groups');
  assert.equal(b.querySelector('.g-cap, .bcap, .bhead, .bcard'), null, 'ни подписи, ни дней: дни блока привычку не ограничивают');
  const rowsAfter = l => [...l.nextElementSibling.querySelectorAll('[data-act="edit-open"]')].map(x => x.dataset.id);
  assert.deepEqual(labels.map(rowsAfter), [['uh'], ['sh'], ['ph']]);
  assert.doesNotMatch(labels[1].nextElementSibling.textContent, /Школа/, 'имени блока в мете строки нет');
  assert.equal(b.querySelector('[data-act="add-open"]').dataset.area, 'habit');
  const gone = [...b.querySelectorAll('.rowwrap.gone')].map(r => r.querySelector('.tname').textContent);
  assert.deepEqual(gone, ['Бывшая'], 'в «Убранных» — привычка живого блока; ушедшая с блоком вернётся с ним');
  // и «Расписание» привычек не показывает
  const sched = [...document.querySelectorAll('#scr-settings details.sect')].find(d => /^Расписание/.test(d.querySelector('summary').textContent));
  assert.equal(sched.querySelector('[data-act="edit-open"][data-id="uh"], [data-act="edit-open"][data-id="sh"]'), null);

  // без блоков — строки без заголовка: подписывать «Без блока» нечего
  const bare = r1SettingsSeed();
  bare.groups = [];
  bare.items.forEach(i => { i.group = ''; });
  const c = await boot({ seed: bare });
  r1Settings(c.document);
  const hs = [...c.document.querySelectorAll('#scr-settings details.sect')].find(d => /^Привычки/.test(d.querySelector('summary').textContent));
  assert.equal(hs.querySelector('.sect-b > .g-label'), null);
  assert.equal(hs.querySelectorAll('[data-act="edit-open"]').length, 2);
});

test('Р1/B: поле «Блок» — только живые блоки; войти в убранный через «+ Новый блок…» нельзя', async () => {
  const seed = r1SettingsSeed();
  seed.groups.push(Object.assign(r1Block('Ушедший'), { removedAt: daysAgo(3) }));
  seed.items.push(r1Action('o1', 'Сирота', daysAgo(10), 'Чужой', R1_ALL)); // имя блока из файла, блока нет
  const { document, window } = await boot({ seed });
  r1Settings(document);
  // сохранение без правки поля «(нет в списке)» блока не заводит: осиротевшее
  // имя остаётся именем, а не молча превращается в карточку
  [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')].find(b => b.dataset.id === 'o1').click();
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.deepEqual(r1Saved(window).groups.map(g => g.name), ['Утро', 'Школа', 'Выходной', 'Ушедший']);
  assert.equal(r1Saved(window).items.find(i => i.id === 'o1').group, 'Чужой');
  [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')].find(b => b.dataset.id === 'u1').click();
  const sel = () => document.getElementById('e-group');
  assert.deepEqual([...sel().options].map(o => o.textContent), ['— без блока', 'Утро', 'Школа', 'Выходной', '+ Новый блок…']);
  const before = window.localStorage.getItem(NS);
  sel().selectedIndex = sel().options.length - 1;
  sel().dispatchEvent(new window.Event('change', { bubbles: true }));
  document.getElementById('e-gnew').value = 'Ушедший';
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  r1Refused(document, window, 'edit-save', /^Блок «Ушедший» убран — вернуть можно в «Убранных»$/, before);
  assert.equal(document.getElementById('e-gnew').value, 'Ушедший', 'введённое цело');
  // живое имя через «+ Новый блок…» — просто вход в блок, без двойника
  document.getElementById('e-gnew').value = 'Школа';
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  let s = r1Saved(window);
  assert.equal(s.items.find(i => i.id === 'u1').group, 'Школа');
  assert.equal(s.groups.filter(g => g.name === 'Школа').length, 1);

  // форма добавления привычки — тот же отказ
  document.querySelector('#scr-settings [data-act="add-open"][data-area="habit"]').click();
  document.getElementById('f-name').value = 'Новая';
  const fsel = document.getElementById('f-group');
  fsel.selectedIndex = fsel.options.length - 1;
  fsel.dispatchEvent(new window.Event('change', { bubbles: true }));
  document.getElementById('f-gnew').value = 'Ушедший';
  const before2 = window.localStorage.getItem(NS);
  document.querySelector('#scr-settings [data-act="add-save"]').click();
  r1Refused(document, window, 'add-save', /^Блок «Ушедший» убран — вернуть можно в «Убранных»$/, before2);
  assert.equal(document.getElementById('f-name').value, 'Новая');
  document.getElementById('f-gnew').value = 'Зал';
  document.querySelector('#scr-settings [data-act="add-save"]').click();
  s = r1Saved(window);
  assert.equal(s.items[s.items.length - 1].group, 'Зал');
  assert.deepEqual(s.groups[s.groups.length - 1], { name: 'Зал', caption: '', days: [], removedAt: null, mode: 'main' }, 'новый блок заведён в каноне (v20 — в активном режиме)');
});

test('Р1/B (4.5): черновик формы блока держит выбранные дни при переходе в соседнюю форму; сохранённое черновиком не возвращается', async () => {
  const { document, window } = await boot({ seed: r1SettingsSeed() });
  r1Settings(document);
  r1Btn(document, 'group-open', 'Утро').click();
  document.getElementById('g-cap').value = '6:45';
  document.querySelector('#scr-settings [data-act="days-preset"][data-mask="1111100"]').click();
  // соседняя форма — правка действия с тапом по дню (свой черновик маски).
  // Действие «Утра» — «как блок» (этап C, п. 2.5): чипов нет, пока не нажаты
  // «Свои дни», и сам нажатый режим — тоже черновик своей формы (FORM_UI)
  const asBlock = () => document.querySelector('#scr-settings [data-form="edit"] .dnow');
  [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')].find(b => b.dataset.id === 'u2').click();
  assert.equal(r1Chips(document), '', 'у действия — «как блок», чипов блока в форме пункта нет');
  assert.match(asBlock().textContent, /^как блок · ежедневно/, 'дни блока в форму пункта не переехали: «Утро» — ежедневно');
  document.querySelector('#scr-settings [data-act="days-own"]').click();
  assert.equal(r1Chips(document), '1111111', '«Свои дни» предзаполнены днями «Утра», а не черновиком формы блока');
  document.querySelector('#scr-settings [data-act="day-toggle"][data-day="0"]').click();
  // обратно к блоку: пресет и подпись на месте
  r1Btn(document, 'group-open', 'Утро').click();
  assert.equal(r1Chips(document), '1111100', 'выбранный пресет вернулся');
  assert.equal(document.getElementById('g-cap').value, '6:45');
  // и к пункту: его режим «свои» и снятый понедельник — тоже
  [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')].find(b => b.dataset.id === 'u2').click();
  assert.equal(asBlock(), null, 'режим «Свои дни» вернулся с черновиком');
  assert.equal(r1Chips(document), '0111111', 'черновик маски пункта — свой');
  document.querySelector('#scr-settings [data-act="edit-cancel"]').click();
  // соседний пункт ни режима, ни снятого понедельника не унаследовал — ни после
  // «Отмены», ни при прямом переходе из формы в форму (settingsFormsClosed
  // гасит маску и режим)
  [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')].find(b => b.dataset.id === 'u1').click();
  assert.ok(asBlock(), 'режим «Свои дни» одной формы в форму соседнего пункта не переезжает');
  document.querySelector('#scr-settings [data-act="days-own"]').click();
  assert.equal(r1Chips(document), '1111111', 'маска одной формы в форму соседнего пункта не переезжает');
  document.querySelector('#scr-settings [data-act="day-toggle"][data-day="3"]').click();
  [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')].find(b => b.dataset.id === 'u2').click();
  assert.ok(asBlock(), 'прямой переход: у u2 свой черновик снят «Отменой», чужой не пришёл — снова «как блок»');
  assert.equal(r1Chips(document), '');
  [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')].find(b => b.dataset.id === 'u1').click();
  assert.equal(r1Chips(document), '1110111', 'а свой черновик u1 вернулся — вместе с режимом');
  document.querySelector('#scr-settings [data-act="edit-cancel"]').click();

  r1Btn(document, 'group-open', 'Утро').click();
  document.getElementById('g-cap').value = '6:30'; // набрано ПОСЛЕ последней перерисовки
  r1Btn(document, 'group-save', 'Утро').click();
  assert.equal(r1Saved(window).groups[0].caption, '6:30');
  r1Btn(document, 'group-open', 'Утро').click();
  assert.equal(document.getElementById('g-cap').value, '6:30', 'после сохранения — сохранённое, а не прежний черновик');
  assert.equal(r1Chips(document), '1111100');
});

test('Р1/B (C.6.7): импорт, чистка и возврат гасят быструю форму и форму блока вместе с черновиками и свёрткой', async () => {
  const { document, window } = await boot({ seed: r1SettingsSeed() });
  r1Settings(document);
  // форма блока с черновиком дней и свёрнутая соседняя карточка
  r1Btn(document, 'group-fold', 'Выходной').click();
  r1Btn(document, 'group-open', 'Утро').click();
  document.querySelector('#scr-settings [data-act="days-preset"][data-mask="0000011"]').click();
  r1Settings(document); // перерисовка снимает черновик в слот
  assert.equal(r1Chips(document), '0000011');

  await importThroughUi(document, window, r1SettingsSeed());
  r1Settings(document);
  assert.equal(document.querySelector('#scr-settings [data-form]'), null, 'форма блока закрыта импортом');
  assert.equal(r1Btn(document, 'group-fold', 'Выходной').getAttribute('aria-expanded'), 'true', 'свёртка прежних данных снята');
  r1Btn(document, 'group-open', 'Утро').click();
  assert.equal(r1Chips(document), '1111111', 'черновик дней прежних данных не перенесён');
  document.querySelector('#scr-settings [data-act="group-cancel"]').click();

  // быстрое добавление с текстом в блоке, который есть и в файле, — импорт его закрывает
  r1Btn(document, 'quick-open', 'Утро').click();
  document.getElementById('q-lines').value = 'НАБРАНО ДО ИМПОРТА';
  r1Settings(document);
  assert.equal(document.getElementById('q-lines').value, 'НАБРАНО ДО ИМПОРТА', 'черновик в слоте');
  await importThroughUi(document, window, r1SettingsSeed());
  r1Settings(document);
  assert.equal(document.getElementById('q-lines'), null, 'импорт закрыл быструю форму');
  r1Btn(document, 'quick-open', 'Утро').click();
  assert.equal(document.getElementById('q-lines').value, '', 'черновик прежних данных не всплыл');
  document.querySelector('#scr-settings [data-act="quick-cancel"]').click();

  // Форма добавления блока рисуется при любых данных — на ней видно, гасит
  // ли её сама замещающая операция, а не исчезнувший блок. Чистка:
  document.querySelector('#scr-settings [data-act="group-add-open"]').click();
  document.querySelector('#scr-settings [data-act="days-preset"][data-mask="0000011"]').click();
  wipeThroughUi(document);
  openData(document); // «Настройки» перерисованы уже на пустом store
  assert.equal(document.querySelector('#scr-settings [data-form]'), null, 'чистка закрыла форму добавления блока');
  // возврат: форма в пустом store с черновиком дней — гаснет и она
  document.querySelector('#scr-settings [data-act="group-add-open"]').click();
  assert.equal(r1Chips(document), '1111111', 'черновик дней до чистки не всплыл');
  document.querySelector('#scr-settings [data-act="days-preset"][data-mask="0000011"]').click();
  document.querySelector('#scr-settings [data-act="wipe-undo"]').click();
  assert.equal(document.getElementById('scr-settings').hidden, false, 'возврат остаётся на «Настройках»');
  assert.equal(document.querySelector('#scr-settings [data-form]'), null, 'возврат закрыл форму добавления блока');
  document.querySelector('#scr-settings [data-act="group-add-open"]').click();
  assert.equal(r1Chips(document), '1111111', 'и черновик дней — тоже');
});

/* Успешное сохранение снимает черновик своей формы (п. 4.5): иначе в слоте
   оставалось состояние ПОСЛЕДНЕЙ перерисовки, и повторное открытие
   накатывало его поверх сохранённого. Сценарий у всех форм один: открыть,
   набрать, перерисовать (черновик снят в слот), набрать другое, сохранить,
   открыть снова. */
test('Р1/B (4.5): после сохранения повторное открытие формы показывает сохранённое, а не прежний черновик', async () => {
  const FORMS = [
    { name: 'правка пункта', open: d => [...d.querySelectorAll('#scr-settings [data-act="edit-open"]')].find(b => b.dataset.id === 'u1').click(),
      field: 'e-name', first: 'ЧЕРНОВИК', last: 'Кровать заправлена', save: 'edit-save', after: 'Кровать заправлена' },
    { name: 'добавление привычки', open: d => d.querySelector('#scr-settings [data-act="add-open"][data-area="habit"]').click(),
      field: 'f-name', first: 'ЧЕРНОВИК', last: 'Новая', save: 'add-save', after: '' },
    { name: 'быстрое добавление', open: d => r1Btn(d, 'quick-open', 'Утро').click(),
      field: 'q-lines', first: 'ЧЕРНОВИК', last: 'Шторы', save: 'quick-save', after: '' },
    { name: 'правка упражнения', open: d => d.querySelector('#scr-settings [data-act="ex-open"]').click(),
      field: 'x-name', first: 'ЧЕРНОВИК', last: 'Жим стоя', save: 'ex-save', after: 'Жим стоя' },
    { name: 'добавление упражнения', open: d => d.querySelector('#scr-settings [data-act="ex-add-open"]').click(),
      field: 'x-add-name', first: 'ЧЕРНОВИК', last: 'Присед', save: 'ex-add-save', after: '' }
  ];
  for (const f of FORMS) {
    const seed = r1SettingsSeed();
    seed.exercises = [{ id: 'x1', name: 'Жим', unit: 'кг', value: 60, history: [], removedAt: null, addedAt: daysAgo(10) }];
    const { document } = await boot({ seed });
    r1Settings(document);
    f.open(document);
    document.getElementById(f.field).value = f.first;
    r1Settings(document); // перерисовка с открытой формой — черновик в слоте
    assert.equal(document.getElementById(f.field).value, f.first, `${f.name}: черновик пережил перерисовку`);
    document.getElementById(f.field).value = f.last;
    document.querySelector(`#scr-settings [data-act="${f.save}"]`).click();
    assert.equal(document.getElementById(f.field), null, `${f.name}: форма закрылась`);
    f.open(document);
    assert.equal(document.getElementById(f.field).value, f.after, `${f.name}: прежний черновик не вернулся`);
  }
});

/* Все тела правил, в чьём списке селекторов есть ТОЧНО этот селектор: поле,
   заведённое отдельным правилом (`.bbody { padding: 0 8px }`), ruleOf не
   нашёл бы — он берёт первое правило с таким началом */
const rulesFor = (css, sel) => [...css.matchAll(/(?:^|[\n}])\s*([^{}@]+)\{([^{}]*)\}/g)]
  .filter(m => m[1].split(',').map(x => x.trim()).includes(sel)).map(m => m[2]);
/* Горизонтальные поля объявления: сокращённая запись padding — вторая и
   четвёртая величины, длинная — своя; что угодно, кроме нуля, — поле */
function sidePadding(body) {
  const out = [];
  for (const m of body.matchAll(/padding(-left|-right|-inline(?:-start|-end)?)?\s*:\s*([^;]+)/g)) {
    const v = m[2].trim().split(/\s+/);
    out.push(...(m[1] ? [v[0]] : v.length === 1 ? [v[0]] : v.length === 4 ? [v[1], v[3]] : [v[1]]));
  }
  return out.filter(x => !/^0(px)?$/.test(x));
}

test('Р1/B CSS: карточка блока без боковых полей — чип дня во вложенной форме не уже 44 px на 375', async () => {
  const css = CSS_SRC();
  const card = ruleOf(css, '.bcard');
  assert.ok(card, 'правило .bcard');
  assert.match(card, /border-top:\s*1px solid var\(--line\)/, 'блоки разделяет верхняя линия');
  assert.doesNotMatch(card, /padding|border-left|border-right|border:/, 'ни полей, ни боковых рамок');
  assert.match(card, /margin-top:\s*var\(--gap-block\)/, 'ритм — существующий токен');
  // арифметика как у .pcard: экран − поля экрана − поля и рамка формы + вынос ряда
  const screenPad = px(ruleOf(css, '.screen'), 'padding-left') || 20;
  const formPad = px(ruleOf(css, '.card'), 'padding');
  const days = ruleOf(css, '.days');
  const out = Math.abs(parseFloat((/margin:\s*0\s+(-?[\d.]+)px/.exec(days) || [])[1]));
  const gap = px(days, 'gap');
  assert.ok(formPad > 0 && out > 0 && gap >= 0, 'величины прочитаны из CSS');
  const row = 375 - 2 * screenPad - 2 * formPad - 2 + 2 * out;
  const cell = (row - 6 * gap) / 7;
  assert.ok(cell >= 44, `ячейка чипа ${cell.toFixed(1)} px`);
  assert.ok(px(ruleOf(css, '.days .btn.day'), 'min-height') >= 44);
  // Р1/рецензия: арифметика выше верна, только пока между экраном и формой
  // действия никто не заводит боковых полей. Промежуточные контейнеры —
  // .blocks → .bcard → .bbody → .list → .rowwrap — проверяются все, каждым
  // своим правилом: поле на любом из них молча уводило чип ниже 44 px
  for (const sel of ['.blocks', '.bcard', '.bbody', '.list', '.rowwrap']) {
    for (const body of rulesFor(css, sel)) {
      assert.deepEqual(sidePadding(body), [], `у ${sel} нет горизонтальных полей: ${body.trim()}`);
      assert.doesNotMatch(body, /border(-left|-right|-inline(-start|-end)?)?\s*:/, `у ${sel} нет боковых рамок`);
    }
  }
  // сторож сам себя: правила контейнеров находятся, а заведённое отдельным
  // правилом поле он видит
  assert.ok(rulesFor(css, '.rowwrap').length >= 1 && rulesFor(css, '.bcard').length >= 1, 'правила контейнеров найдены');
  assert.deepEqual(sidePadding(rulesFor('.bbody { padding: 0 8px; }', '.bbody')[0]), ['8px']);
  assert.deepEqual(sidePadding('padding: 9px 0;'), []);
  // Р1/рецензия: шапка карточки — текстовая колонка при кнопках .ictl не уже
  // 137 px (замер 13.08.2026: нижняя граница, ниже которой длинные названия
  // переносятся). Число кнопок — из отрисованной карточки, ширина — из CSS
  const { document } = await boot({ seed: r1SettingsSeed() });
  r1Settings(document);
  const n = r1Card(document, 'Утро').querySelectorAll('.bhead .ictl .btn.icon').length;
  assert.equal(n, 3, 'выше, ниже, свернуть');
  assert.deepEqual(sidePadding(ruleOf(css, '.row')), [], 'у строки нет боковых полей');
  assert.deepEqual(sidePadding(ruleOf(css, '.itxt')), [], 'у текстовой кнопки нет боковых полей');
  const col = 375 - 2 * screenPad - px(ruleOf(css, '.row'), 'gap') - n * px(ruleOf(css, '.ictl .btn.icon'), 'width');
  assert.ok(col >= 137, `текстовая колонка шапки ${col} px`);
  // пресеты — три равные колонки, кегль — ступень чипов
  assert.match(ruleOf(css, '.presets'), /grid-template-columns:\s*repeat\(3, 1fr\)/);
  assert.match(ruleOf(css, '.presets .btn'), /font-size:\s*var\(--text-xs\)/);
  assert.match(css, /\.bbody\[hidden\]\s*\{\s*display:\s*none;?\s*\}/, 'глобального [hidden] в файле нет — скрытие явное');
  const sub = ruleOf(css, '.csub');
  assert.match(sub, /color:\s*var\(--muted\)/);
  assert.match(sub, /font-size:\s*var\(--text-sm\)/);
  assert.match(sub, /font-weight:\s*400/);
});

/* Возврат блока, в котором действие вернулось бы без единого дня (своя маска
   вне дней блока — такое приносит только файл): restoreItemCore возвращает
   его «как блок», и это решение за владельца называется строкой — как у
   возврата одного пункта (Р1/рецензия выше). */
test('Р1/B: «Вернуть» блок с действием без единого дня — «как блок», и это названо', async () => {
  const seed = r1SettingsSeed();
  const gone = daysAgo(1);
  seed.groups[1].removedAt = gone;
  for (const it of seed.items) if (it.group === 'Школа') it.removedAt = gone;
  seed.items.find(i => i.id === 's1').schedule = [{ from: daysAgo(10), mask: '0000011' }];
  const { document, window } = await boot({ seed });
  r1Settings(document);
  [...document.querySelectorAll('#scr-settings .rowwrap.gone [data-act="group-restore"]')].find(b => b.dataset.name === 'Школа').click();
  const s = r1Saved(window);
  assert.equal(s.groups[1].removedAt, null);
  const copy = s.items[s.items.findIndex(i => i.id === 's1') + 1];
  assert.equal(copy.name, 'Экстра');
  assert.deepEqual(copy.schedule, [{ from: daysAgo(0), mask: R1_ALL }], 'вернулось «как блок»');
  const flash = document.querySelector('#scr-settings .flash');
  assert.equal(flash.textContent, 'Вернулось с днями блока: Экстра — свои дни в них не попадали');
  assert.ok(r1Card(document, 'Школа').contains(flash), 'у карточки вернувшегося блока');
});

/* ══ «Расписание 1/3», этап C: форма правки ДЕЙСТВИЯ ══════════════════
   «Блок» над «Днями»; дни в живом блоке — «как блок» строкой или «свои»
   чипами в пределах дней блока; своя маска хранится как есть и пишется
   только при касании; отказы по итоговому блоку; «Тип» в день заведения. */

const r1Form = document => document.querySelector('#scr-settings [data-form="edit"]');
function r1Edit(document, id) {
  const b = [...document.querySelectorAll('#scr-settings [data-act="edit-open"]')].find(x => x.dataset.id === id);
  assert.ok(b, 'строка пункта ' + id);
  b.click();
  const f = r1Form(document);
  assert.ok(f && f.dataset.id === id, 'форма правки открыта: ' + id);
  return f;
}
const r1Row = (document, id) => [...document.querySelectorAll('#scr-settings .rowwrap[data-drag="item"]')]
  .find(r => r.dataset.dragId === id);
function r1Pick(document, window, value) {
  const sel = document.getElementById('e-group');
  sel.value = value;
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
}
function r1Type(document, window, value) {
  const sel = document.getElementById('e-type');
  assert.ok(sel, 'селект «Тип» на месте');
  sel.value = value;
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
}
const r1Muted = (document, text) => [...r1Form(document).querySelectorAll('p.muted')].find(p => p.textContent === text);

test('Р1/C: «Дни: как блок · будни» строкой; «Свои дни» предзаполнены днями блока, чипы вне блока недоступны и названы', async () => {
  const { document, window } = await boot({ seed: r1SettingsSeed() });
  r1Settings(document);
  const before = window.localStorage.getItem(NS);
  const f = r1Edit(document, 's2'); // «Пост» — будничная «Школа», своя маска «все семь»
  const now = f.querySelector('.dnow');
  assert.ok(now, 'режим «как блок»');
  assert.equal(now.firstChild.textContent, 'как блок · будни');
  assert.equal(now.querySelector('[data-act="days-own"]').textContent, 'Свои дни');
  assert.equal(now.closest('.field').querySelector(':scope > span').textContent, 'Дни');
  assert.equal(r1Chips(document), '', 'чипов нет');
  // «Блок» — над «Днями»: дни зависят от блока
  assert.ok(document.getElementById('e-group').compareDocumentPosition(now) & window.Node.DOCUMENT_POSITION_FOLLOWING,
    '«Блок» стоит перед «Днями»');
  // заведён не сегодня — тип тихой строкой, селекта нет; история планки — в форме
  assert.equal(document.getElementById('e-type'), null);
  assert.ok(r1Muted(document, 'Тип: ежедневный'));
  assert.match(f.querySelector('p.muted .hist').textContent, /^Планка: 3 → 5 мин/);

  now.querySelector('[data-act="days-own"]').click();
  let form = r1Form(document);
  assert.equal(form.querySelector('.dnow'), null, 'режим «свои»');
  assert.equal(r1Chips(document), '1111100', 'предзаполнены днями блока');
  const chips = [...form.querySelectorAll('.days .btn.day')];
  assert.deepEqual(chips.map(c => c.disabled), [false, false, false, false, false, true, true], 'выходные недоступны');
  assert.equal(chips[5].getAttribute('aria-label'), 'суббота — не в днях блока');
  assert.equal(chips[6].getAttribute('aria-label'), 'воскресенье — не в днях блока');
  assert.equal(chips[5].classList.contains('on'), false);
  assert.equal(chips[2].getAttribute('aria-label'), 'убрать среду');
  assert.equal(document.activeElement, chips[0], 'фокус — на первом доступном чипе');
  assert.ok(r1Muted(document, 'Дни блока: будни'), 'дни блока названы над чипами');
  assert.ok(chips[0].closest('.field').contains(r1Muted(document, 'Дни блока: будни')));
  assert.equal(form.querySelector('[data-act="days-inherit"]').textContent, 'Как блок');

  // чип вне дней блока не правит выбор и тогда, когда тап до обработчика дошёл.
  // Вне дней блока выбор не виден, поэтому проверка — через «— без блока»:
  // там чипы показывают черновик целиком, и субботы в нём быть не должно
  chips[5].disabled = false;
  chips[5].click();
  r1Pick(document, window, '');
  assert.equal(r1Form(document).querySelector('.days .btn.day:disabled'), null, 'без блока недоступных дней нет');
  assert.equal(r1Chips(document), '1111100', 'обработчик отказал сам, не одна разметка');
  r1Pick(document, window, 'Школа');

  r1Form(document).querySelector('[data-act="days-inherit"]').click();
  form = r1Form(document);
  assert.ok(form.querySelector('.dnow'), '«Как блок» — снова строкой');
  assert.equal(document.activeElement, form.querySelector('[data-act="days-own"]'), 'фокус — на «Свои дни»');
  document.querySelector('#scr-settings [data-act="edit-cancel"]').click();
  assert.equal(window.localStorage.getItem(NS), before, 'режимы — черновик: без «Сохранить» не записано ничего');
});

test('Р1/C: снять среду в «Своих днях» — строка «пн, вт, чт, пт», выходные своей маски целы; «Как блок» — «все семь»', async () => {
  const { document, window } = await boot({ seed: r1SettingsSeed() });
  r1Settings(document);
  const t = window.todayKey();
  const saved = id => r1Saved(window).items.find(i => i.id === id);
  r1Edit(document, 's2');
  document.querySelector('#scr-settings [data-act="days-own"]').click();
  document.querySelector('#scr-settings [data-act="day-toggle"][data-day="2"]').click();
  assert.equal(r1Chips(document), '1101100');
  assert.equal(document.activeElement, document.querySelector('#scr-settings [data-act="day-toggle"][data-day="2"]'), 'фокус — на том же чипе');
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.deepEqual(saved('s2').schedule, [{ from: daysAgo(10), mask: R1_ALL }, { from: t, mask: '1101111' }],
    'своя маска — как есть: выходные, которых в форме не было, не потеряны; прежний отрезок цел');
  assert.equal(window.effectiveMaskOn(saved('s2'), t), '1101100', 'эффективные дни — выбор в пределах блока');
  assert.equal(r1Row(document, 's2').querySelector('.csub').textContent, ' · 5 мин · пн, вт, чт, пт');
  const flash = document.querySelector('#scr-settings .flash');
  assert.equal(flash.textContent, 'Сохранено');
  assert.ok(r1Row(document, 's2').contains(flash), 'подтверждение у строки');

  // открыта снова — режим «свои» выведен из данных
  r1Edit(document, 's2');
  assert.equal(r1Form(document).querySelector('.dnow'), null);
  assert.equal(r1Chips(document), '1101100');
  // «Как блок» — своя маска «все семь»; в тот же день отрезок схлопывается (инвариант 5)
  document.querySelector('#scr-settings [data-act="days-inherit"]').click();
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.deepEqual(saved('s2').schedule, [{ from: daysAgo(10), mask: R1_ALL }], 'возврат к «все семь» за тот же день — отрезка нет');
  assert.equal(window.scheduleOn(saved('s2'), t), R1_ALL);
  assert.equal(r1Row(document, 's2').querySelector('.csub').textContent, ' · 5 мин', 'как блок — дни в строке не повторяются');

  // у действия со своими днями с прошлого «Как блок» пишет отрезок «все семь» с сегодня
  r1Edit(document, 's1');
  assert.equal(r1Chips(document), '1010100', 'свои дни «Экстры» — пн, ср, пт');
  document.querySelector('#scr-settings [data-act="days-inherit"]').click();
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.deepEqual(saved('s1').schedule, [{ from: daysAgo(10), mask: '1010100' }, { from: t, mask: R1_ALL }],
    '«Как блок» — WEEK_ALL с сегодня, прошлое не тронуто');
  assert.equal(r1Row(document, 's1').querySelector('.csub').textContent, ' · 11:45');
});

test('Р1/C: форма без касания дней отрезка не пишет; нуль из импорта назван тихо и отказом не становится', async () => {
  const seed = r1SettingsSeed();
  seed.items.push(r1Action('z1', 'Ноль', daysAgo(10), 'Выходной', '1111100')); // ∧ выходные = пусто (импорт)
  const { document, window } = await boot({ seed });
  r1Settings(document);
  const t = window.todayKey();
  const sched = id => r1Saved(window).items.find(i => i.id === id).schedule;
  const was = { s1: sched('s1'), s2: sched('s2'), z1: sched('z1') };
  const zeroLine = () => r1Muted(document, 'Сейчас не попадает ни в один день блока');

  // «свои» из данных, правка имени — отрезка нет
  r1Edit(document, 's1');
  assert.equal(zeroLine(), undefined, 'у действия с днями строки нуля нет');
  document.getElementById('e-name').value = 'Экстра+';
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.equal(r1Saved(window).items.find(i => i.id === 's1').name, 'Экстра+');
  assert.deepEqual(sched('s1'), was.s1, '«свои» без касания — маска как есть');
  // «как блок» без касания
  r1Edit(document, 's2');
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.deepEqual(sched('s2'), was.s2);
  // «Свои дни» нажаты, выбор не менялся — итог прежний, отрезка нет
  r1Edit(document, 's2');
  document.querySelector('#scr-settings [data-act="days-own"]').click();
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.deepEqual(sched('s2'), was.s2, 'касание, вернувшее прежнюю маску, не пишет');

  // нуль из импорта: чипы пусты, сказано тихо, сохранение без касания проходит
  r1Edit(document, 'z1');
  assert.equal(r1Chips(document), '0000000');
  assert.ok(zeroLine(), 'нуль назван');
  document.getElementById('e-note').value = 'из файла';
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.equal(document.querySelector('#scr-settings .flash.keep'), null, 'отказа нет: владелец правил не дни');
  assert.equal(document.querySelector('#scr-settings .flash').textContent, 'Сохранено');
  assert.equal(r1Saved(window).items.find(i => i.id === 'z1').note, 'из файла');
  assert.deepEqual(sched('z1'), was.z1);
  // выбран день блока — строка ушла, маска слита: будни своей маски целы
  r1Edit(document, 'z1');
  document.querySelector('#scr-settings [data-act="day-toggle"][data-day="5"]').click();
  assert.equal(zeroLine(), undefined, 'дни тронуты — строки нет');
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.deepEqual(sched('z1'), [{ from: daysAgo(10), mask: '1111100' }, { from: t, mask: '1111110' }]);
  assert.equal(r1Row(document, 'z1').querySelector('.csub').textContent, ' · из файла · сб');
});

test('Р1/C: перенос действия через «Блок» — строка в карточке другого блока, журнал записан, прошлое не сдвинулось', async () => {
  const since = daysAgo(20);
  const items = [r1Action('a1', 'Переезд', since, 'Утро', R1_ALL), r1Action('a2', 'Сосед', since, 'Утро', R1_ALL)];
  const days = {};
  for (let k = 1; k <= 20; k++) days[daysAgo(k)] = { a2: true }; // «Сосед» отмечен каждый прошлый день, «Переезд» — ни разу
  const seed = r1Store([r1Block('Утро', '7:00'), r1Block('Школа', '', [{ from: since, mask: '1111100' }])], items, days);
  seed.settings.calendarSince = mondayOf(since);
  const { document, window } = await boot({ seed });
  await moveToWeekday(window, document, 1); // вторник: будний блок принимает и сегодняшний день
  const t = window.todayKey();
  const past = [];
  for (let k = 1; k <= 14; k++) past.push(window.addDays(t, -k));
  assert.ok(past.some(k => window.weekdayOf(k) >= 5), 'в окне есть выходные — на них перенос в будни и был бы виден');
  const counts = () => JSON.stringify(past.map(k => window.minDayMarks(k)));
  const countsBefore = counts();
  // «Прогресс» сравнивается целиком, кроме ПОРЯДКА строк «Отметок»: он идёт
  // по блокам, и переехавшее действие законно встаёт за «Школой»
  const progressView = () => {
    const html = document.getElementById('scr-progress').innerHTML;
    const at = html.indexOf('<h2>Отметки</h2>');
    assert.ok(at > 0, 'блок «Отметки» на месте');
    const rows = [...document.querySelectorAll('#scr-progress .pcard p.line')].map(p => p.textContent).sort();
    return html.slice(0, at) + JSON.stringify(rows);
  };
  openProgress(document);
  const progress = progressView();

  r1Settings(document);
  r1Btn(document, 'group-fold', 'Школа').click(); // цель свёрнута — сохранение обязано её развернуть
  r1Edit(document, 'a1');
  r1Pick(document, window, 'Школа');
  assert.match(r1Form(document).querySelector('.dnow').textContent, /^как блок · будни/, 'дни в форме — уже дни выбранного блока');
  document.querySelector('#scr-settings [data-act="edit-save"]').click();

  const a1 = r1Saved(window).items.find(i => i.id === 'a1');
  assert.equal(a1.group, 'Школа');
  assert.deepEqual(a1.groupLog, [{ from: since, group: 'Утро' }, { from: t, group: 'Школа' }], 'журнал принадлежности записан');
  assert.ok(r1Card(document, 'Школа').contains(r1Row(document, 'a1')), 'строка — в карточке «Школы»');
  assert.equal(r1Card(document, 'Утро').contains(r1Row(document, 'a1')), false, 'и ушла из «Утра»');
  const body = document.getElementById(r1Btn(document, 'group-fold', 'Школа').getAttribute('aria-controls'));
  assert.equal(body.hidden, false, 'целевой блок развёрнут');
  const flash = document.querySelector('#scr-settings .flash');
  assert.ok(flash && r1Row(document, 'a1').contains(flash), 'подтверждение у переехавшей строки');
  assert.equal(flash.closest('[hidden]'), null, 'и оно видно');

  // прошлое: «N из M» дней и «Прогресс» прежние
  assert.equal(counts(), countsBefore, 'minDayMarks прошлых дней прежние — и в выходные «Переезд» в знаменателе');
  openProgress(document);
  assert.equal(progressView(), progress, '«Прогресс» после переноса — тот же: серия, цепь, «в системе», числа «Отметок»');
});

test('Р1/C: отказы — «Не останется ни одного дня» по итоговому блоку, «Нужен хотя бы один день недели», убранный блок', async () => {
  const seed = r1SettingsSeed();
  seed.items.push(r1Action('o2', 'Суббота-дело', daysAgo(10), 'Утро', '0000011')); // свои дни — выходные
  seed.groups.push(Object.assign(r1Block('Ушедший'), { removedAt: daysAgo(3) }));
  const { document, window } = await boot({ seed });
  r1Settings(document);
  const saved = id => r1Saved(window).items.find(i => i.id === id);

  // перенос в будни без касания дней: у действия с выходными дней не останется
  r1Edit(document, 'o2');
  r1Pick(document, window, 'Школа');
  let before = window.localStorage.getItem(NS);
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  r1Refused(document, window, 'edit-save', /^Не останется ни одного дня: Суббота-дело$/, before);
  assert.equal(document.getElementById('e-group').value, 'Школа', 'выбор блока цел');
  // «Как блок» в новом блоке — дни есть, перенос проходит
  document.querySelector('#scr-settings [data-act="days-inherit"]').click();
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.equal(saved('o2').group, 'Школа');
  assert.deepEqual(saved('o2').schedule, [{ from: daysAgo(10), mask: '0000011' }, { from: window.todayKey(), mask: R1_ALL }]);

  // пустой выбор в «Своих днях» — фраза про выбор, а не про блок
  r1Edit(document, 's2');
  document.querySelector('#scr-settings [data-act="days-own"]').click();
  for (let i = 0; i < 5; i++) document.querySelector(`#scr-settings [data-act="day-toggle"][data-day="${i}"]`).click();
  assert.equal(r1Chips(document), '0000000');
  before = window.localStorage.getItem(NS);
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  r1Refused(document, window, 'edit-save', /^Нужен хотя бы один день недели$/, before);
  assert.equal(r1Chips(document), '0000000', 'снятые дни в форме целы');

  // «+ Новый блок…» с именем убранного блока — своя фраза, форма цела
  document.querySelector('#scr-settings [data-act="day-toggle"][data-day="0"]').click();
  const sel = document.getElementById('e-group');
  sel.selectedIndex = sel.options.length - 1;
  sel.dispatchEvent(new window.Event('change', { bubbles: true }));
  document.getElementById('e-gnew').value = 'Ушедший';
  before = window.localStorage.getItem(NS);
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  r1Refused(document, window, 'edit-save', /^Блок «Ушедший» убран — вернуть можно в «Убранных»$/, before);
  assert.equal(document.getElementById('e-gnew').value, 'Ушедший', 'введённое цело');
  document.querySelector('#scr-settings [data-act="edit-cancel"]').click();

  // привычка: форма прежняя, но в убранный блок не входит и она; перенос — без журнала
  r1Edit(document, 'sh');
  assert.equal(r1Form(document).querySelector('.dnow, [data-act="days-own"], [data-act="days-inherit"]'), null,
    'у привычки режимов нет: дни блока её не ограничивают');
  assert.equal(r1Chips(document), '1111111', 'свои дни привычки — все доступны');
  document.querySelector('#scr-settings [data-act="day-toggle"][data-day="6"]').click();
  assert.equal(r1Chips(document), '1111110', 'воскресенье привычки в будничном блоке снимается — блок её дни не режет');
  const hsel = document.getElementById('e-group');
  hsel.selectedIndex = hsel.options.length - 1;
  hsel.dispatchEvent(new window.Event('change', { bubbles: true }));
  document.getElementById('e-gnew').value = 'Ушедший';
  before = window.localStorage.getItem(NS);
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  r1Refused(document, window, 'edit-save', /^Блок «Ушедший» убран — вернуть можно в «Убранных»$/, before);
  r1Pick(document, window, 'Утро');
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.equal(saved('sh').group, 'Утро');
  assert.equal('groupLog' in saved('sh'), false, 'журнал — только у действия');
  assert.deepEqual(saved('sh').schedule.map(x => x.mask), [R1_ALL, '1111110'], 'свои дни привычки записаны как выбраны');
});

test('Р1/C: «Тип» в день заведения — счётчик с целью; отказы по отметке и по записи счётчика; назавтра — тихая строка', async () => {
  const { document, window } = await boot({ seed: r1SettingsSeed() });
  r1Settings(document);
  r1Btn(document, 'quick-open', 'Утро').click();
  document.getElementById('q-lines').value = 'Зал · вечером\nСоседнее';
  r1Btn(document, 'quick-save', 'Утро').click();
  const id = r1Saved(window).items.find(i => i.name === 'Зал').id;
  const nextId = r1Saved(window).items.find(i => i.name === 'Соседнее').id;
  const saved = () => r1Saved(window).items.find(i => i.id === id);

  r1Edit(document, id);
  const typeSel = document.getElementById('e-type');
  assert.ok(typeSel, 'в день заведения — «Тип»');
  assert.equal(typeSel.value, 'daily');
  assert.deepEqual([...typeSel.options].map(o => o.textContent), ['ежедневный чекбокс', 'недельный счётчик с целью']);
  assert.ok(typeSel.compareDocumentPosition(document.getElementById('e-group')) & window.Node.DOCUMENT_POSITION_FOLLOWING, '«Тип» — над «Блоком»');
  assert.equal(r1Muted(document, 'Тип: ежедневный'), undefined, 'тихой строки в день заведения нет');
  assert.equal(document.getElementById('e-goal'), null);

  // отмечен сегодня — тип не меняется
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector(`#scr-today [data-act="mark"][data-id="${id}"]`).click();
  r1Settings(document);
  assert.ok(r1Form(document), 'форма пережила уход на «Сегодня»');
  r1Type(document, window, 'weekly');
  assert.equal(r1Form(document).querySelector('.dnow, .days'), null, 'у счётчика дней нет');
  document.getElementById('e-goal').value = '3';
  let before = window.localStorage.getItem(NS);
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  r1Refused(document, window, 'edit-save', /^Тип не меняется: пункт сегодня отмечен$/, before);
  assert.equal(document.getElementById('e-goal').value, '3', 'цель цела');

  // черновик типа и цели переживает соседнюю форму (п. 4.5) — и в соседнее
  // действие того же дня не переезжает: тип принадлежит своей форме
  r1Btn(document, 'group-open', 'Утро').click();
  r1Edit(document, nextId);
  assert.equal(document.getElementById('e-type').value, 'daily', 'тип одной формы в соседнюю не переехал');
  assert.equal(document.getElementById('e-goal'), null);
  r1Edit(document, id);
  assert.equal(document.getElementById('e-type').value, 'weekly', 'тип вернулся с черновиком');
  assert.equal(document.getElementById('e-goal').value, '3', 'и цель');

  // отметка снята — счётчик с целью
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector(`#scr-today [data-act="mark"][data-id="${id}"]`).click();
  r1Settings(document);
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  let it = saved();
  assert.equal(it.type, 'weekly');
  assert.equal(it.goal, 3);
  assert.equal('schedule' in it, false, 'расписания у счётчика нет');
  assert.equal('groupLog' in it, false, 'журнала блока — тоже');
  assert.equal(r1Row(document, id).querySelector('.csub').textContent, ' · вечером · цель 3 / нед.');

  // запись счётчика — обратно в ежедневный нельзя
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector(`#scr-today [data-act="train-inc"][data-id="${id}"]`).click();
  document.querySelector('#scr-train [data-act="train-save"]').click();
  assert.equal(r1Saved(window).weekLog.filter(e => e.itemId === id).length, 1);
  r1Settings(document);
  r1Edit(document, id);
  assert.equal(document.getElementById('e-type').value, 'weekly');
  r1Type(document, window, 'daily');
  assert.ok(r1Form(document).querySelector('.dnow'), 'ежедневный в «Утре» — «как блок»');
  assert.equal(document.getElementById('e-goal'), null);
  before = window.localStorage.getItem(NS);
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  r1Refused(document, window, 'edit-save', /^Тип не меняется: по счётчику уже есть записи$/, before);
  document.querySelector('#scr-settings [data-act="edit-cancel"]').click();

  // назавтра — тихая строка, селекта нет
  shiftWindowDays(window, 1);
  document.dispatchEvent(new window.Event('visibilitychange'));
  r1Settings(document);
  r1Edit(document, id);
  assert.equal(document.getElementById('e-type'), null);
  assert.ok(r1Muted(document, 'Тип: недельный счётчик'));
  it = saved();
  assert.equal(it.type, 'weekly');
});

test('Р1/C: день сменился при открытой форме — черновик типа игнорируется и снимается', async () => {
  const { document, window } = await boot({ seed: r1SettingsSeed() });
  r1Settings(document);
  r1Btn(document, 'quick-open', 'Утро').click();
  document.getElementById('q-lines').value = 'Поздно';
  r1Btn(document, 'quick-save', 'Утро').click();
  const id = r1Saved(window).items.find(i => i.name === 'Поздно').id;
  const born = window.todayKey();
  r1Edit(document, id);
  r1Type(document, window, 'weekly');
  document.getElementById('e-goal').value = '2';
  shiftWindowDays(window, 1); // полночь прошла при открытой форме
  const before = window.localStorage.getItem(NS);
  document.querySelector('#scr-settings [data-act="edit-save"]').click(); // stale-guard: экран перерисован, действие не применено
  assert.equal(window.localStorage.getItem(NS), before);
  assert.ok(r1Form(document), 'форма на месте');
  assert.equal(document.getElementById('e-type'), null, 'назавтра селекта нет — форма по типу пункта');
  assert.equal(document.getElementById('e-goal'), null, 'и поля цели нет');
  // пустое имя: отказ — но черновик типа снят раньше всех проверок
  document.getElementById('e-name').value = ' ';
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.match(document.querySelector('#scr-settings .flash.keep').textContent, /Название не заполнено/);
  assert.equal(window.eval('ui').editType, null, 'черновик типа снят перепроверкой');
  document.getElementById('e-name').value = 'Поздно';
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  const it = r1Saved(window).items.find(i => i.id === id);
  assert.equal(it.type, 'daily', 'тип не сменился');
  assert.deepEqual(it.schedule, [{ from: born, mask: R1_ALL }], 'расписание — прежнее');
});

test('Р1/C CSS: «как блок» — строка на ступени поля, без нового тона; недоступный чип — общим .btn:disabled', () => {
  const css = CSS_SRC();
  const dnow = ruleOf(css, '.dnow');
  assert.ok(dnow, 'правило .dnow');
  assert.match(dnow, /display:\s*flex/);
  assert.match(dnow, /justify-content:\s*space-between/);
  assert.match(dnow, /font-size:\s*16px/, 'ступень полей ввода — строка стоит на месте поля');
  assert.match(dnow, /color:\s*var\(--fg\)/);
  assert.doesNotMatch(dnow, /transition|animation/, 'перерисовка создаёт строку в конечном состоянии — играть нечему');
  assert.match(ruleOf(css, '.field > p.muted'), /margin:\s*0/, '«Дни блока» — в ритме поля');
  assert.match(ruleOf(css, '.btn:disabled'), /opacity/, 'недоступность чипа — общим правилом кнопки');
  assert.doesNotMatch(css, /\.day[\w.-]*(\[disabled\]|:disabled)/, 'своего тона у недоступного чипа не заведено');
});

test('Р1/C: смена блока в форме перестраивает чипы по его дням; недоступный день не бывает выбранным', async () => {
  const seed = r1SettingsSeed();
  seed.items.push(r1Action('n1', 'Вольное', daysAgo(10), '', '1010101')); // без блока, свои дни
  const { document, window } = await boot({ seed });
  r1Settings(document);
  r1Edit(document, 'n1');
  // без блока — прежние чипы своей маски (29/B): все доступны, режимов нет
  assert.equal(r1Form(document).querySelector('.dnow, [data-act="days-own"], [data-act="days-inherit"]'), null);
  assert.equal(r1Chips(document), '1010101');
  document.querySelector('#scr-settings [data-act="day-toggle"][data-day="0"]').click(); // черновик 0010101
  // в будничную «Школу»: чипы в пределах будней; воскресенье черновика недоступно и не выбрано
  r1Pick(document, window, 'Школа');
  const chips = [...r1Form(document).querySelectorAll('.days .btn.day')];
  assert.deepEqual(chips.map(c => c.disabled), [false, false, false, false, false, true, true]);
  assert.equal(chips[6].classList.contains('on'), false, 'день вне блока не «on», хоть в черновике и стоит');
  assert.equal(chips[6].getAttribute('aria-pressed'), 'false');
  assert.equal(r1Chips(document), '0010100', 'выбор — черновик ∧ дни блока');
  assert.ok(r1Muted(document, 'Дни блока: будни'));
  // сохранение: внутри будней — выбор, вне их — своя маска как есть
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  const n1 = r1Saved(window).items.find(i => i.id === 'n1');
  assert.equal(n1.group, 'Школа');
  assert.deepEqual(n1.schedule.map(x => x.mask), ['1010101', '0010101']);
  assert.equal(window.effectiveMaskOn(n1, window.todayKey()), '0010100');
  assert.equal(r1Row(document, 'n1').querySelector('.csub').textContent, ' · ср, пт');
});

/* ══ «Расписание 1/3»: замечания рецензии, интерфейс (Р1/рецензия) ═══ */

test('Р1/рецензия: «Добавить блок» в осиротевшее имя — отказ «Не останется ни одного дня», форма и выбор целы', async () => {
  const since = daysAgo(10);
  // «Вечер» носят действия, блока нет — имя пришло импортом
  const seed = r1Store([r1Block('Утро')], [
    r1Action('o1', 'Душ', since, 'Вечер', '1111100'),
    r1Action('o2', 'Зубы', since, 'Вечер', R1_ALL),
    r1Action('u1', 'Кровать', since, 'Утро', R1_ALL)
  ]);
  const { document, window } = await boot({ seed });
  r1Settings(document);
  const before = window.localStorage.getItem(NS);
  document.querySelector('#scr-settings [data-act="group-add-open"]').click();
  document.querySelector('#scr-settings [data-act="days-preset"][data-mask="0000011"]').click();
  document.getElementById('g-add').value = 'Вечер';
  document.querySelector('#scr-settings [data-act="group-add-save"]').click();
  r1Refused(document, window, 'group-add-save', /^Не останется ни одного дня: Душ$/, before);
  assert.equal(document.getElementById('g-add').value, 'Вечер', 'введённое цело');
  assert.equal(r1Chips(document), '0000011', 'выбранные дни целы');
  assert.notEqual(document.activeElement, document.getElementById('g-add'), 'отказ про дни — фокус в название не уводится');
  assert.equal(window.findGroup('Вечер'), null, 'блок не заведён');
  // понедельник у «Душа» остаётся — осиротевшее имя addGroup разрешает
  document.querySelector('#scr-settings [data-act="day-toggle"][data-day="0"]').click();
  document.getElementById('g-add').value = 'Вечер';
  document.querySelector('#scr-settings [data-act="group-add-save"]').click();
  const s = r1Saved(window);
  assert.deepEqual(s.groups.map(g => g.name), ['Утро', 'Вечер']);
  assert.equal(window.effectiveMaskOn(s.items.find(i => i.id === 'o1'), window.todayKey()), '1000000');
  assert.equal(document.querySelector('#scr-settings .flash').textContent, 'Сохранено');
});

test('Р1/рецензия (C.6.7): восстановление из зеркала гасит форму блока, быструю форму, их черновики и свёртку', async () => {
  const real = new IDBFactory();
  // в копии — те же блоки и практика, которой в рабочей нет: предложение встанет
  const snap = r1SettingsSeed();
  snap.items.push(r1Action('m1', 'Из копии', daysAgo(10), 'Утро', R1_ALL));
  snap.days = { [daysAgo(1)]: { m1: true } };
  await idbPut(real, { json: JSON.stringify(snap), savedAt: 4242, schemaVersion: SCHEMA_VERSION });
  const { document, window } = await boot({ seed: r1SettingsSeed(), idb: real });
  r1Settings(document);
  r1Btn(document, 'group-fold', 'Выходной').click();
  r1Btn(document, 'quick-open', 'Утро').click();
  document.getElementById('q-lines').value = 'НАБРАНО ДО ВОССТАНОВЛЕНИЯ';
  r1Btn(document, 'group-open', 'Утро').click(); // быстрое добавление — в слот черновика
  document.querySelector('#scr-settings [data-act="days-preset"][data-mask="0000011"]').click();
  assert.equal(r1Chips(document), '0000011', 'форма блока открыта с черновиком дней');

  const restore = () => document.querySelector('#scr-settings [data-act="mirror-restore"]');
  assert.ok(restore(), 'предложение восстановления стоит');
  restore().click();
  assert.equal(r1Chips(document), '0000011', 'первый тап только взводит — форма ещё открыта');
  restore().click();
  assert.equal(r1Saved(window).items.some(i => i.id === 'm1'), true, 'состояние подменено копией');
  assert.equal(document.getElementById('scr-settings').hidden, false, 'остались на «Настройках»');
  assert.equal(document.querySelector('#scr-settings [data-form]'), null, 'форма блока закрыта');
  assert.equal(r1Btn(document, 'group-fold', 'Выходной').getAttribute('aria-expanded'), 'true', 'свёртка прежних данных снята');
  r1Btn(document, 'group-open', 'Утро').click();
  assert.equal(r1Chips(document), '1111111', 'черновик дней прежних данных не всплыл');
  document.querySelector('#scr-settings [data-act="group-cancel"]').click();
  r1Btn(document, 'quick-open', 'Утро').click();
  assert.equal(document.getElementById('q-lines').value, '', 'черновик быстрой формы не всплыл');
});

test('Р1/рецензия: «Добавить действия» в «Без блока», видимой ради «Вернуть», — форма открывается, призрачной формы нет', async () => {
  const since = daysAgo(10);
  const seed = r1Store([r1Block('Утро')], [
    r1Action('u1', 'Кровать', since, 'Утро', R1_ALL),
    r1Action('l1', 'Одинокое', since, '', R1_ALL)
  ]);
  const { document, window } = await boot({ seed });
  removeItemThroughUi(document, 'l1');
  const loose = () => document.querySelector('#scr-settings .bcard.loose');
  assert.ok(loose() && loose().querySelector('.gone-note'), 'карточка стоит ради короткого пути назад');
  r1Btn(document, 'quick-open', '').click();
  assert.ok(loose(), 'тап по «Добавить действия» карточку не уносит');
  assert.ok(loose().querySelector('[data-form="quick"] #q-lines'), 'форма быстрого добавления открылась в ней');
  assert.equal(window.currentFormKey(), 'quick:');
  // «Отмена»: ни живых действий без блока, ни короткого пути — карточка уходит, ключа формы нет
  document.querySelector('#scr-settings [data-act="quick-cancel"]').click();
  assert.equal(loose(), null);
  assert.equal(window.currentFormKey(), null, 'призрачного ключа формы не осталось');
  // возврат из «Убранных» возвращает карточку — без формы, которую никто не открывал
  [...document.querySelectorAll('#scr-settings .rowwrap.gone [data-act="item-restore"]')].find(b => b.dataset.id === 'l1').click();
  assert.ok(loose());
  assert.equal(loose().querySelector('[data-form="quick"]'), null, 'формы нет');
  // и добавление из такой карточки доходит до записи
  removeItemThroughUi(document, 'l1');
  r1Btn(document, 'quick-open', '').click();
  document.getElementById('q-lines').value = 'Второе';
  document.querySelector('#scr-settings [data-act="quick-save"]').click();
  assert.deepEqual(r1Saved(window).items.filter(i => i.group === '' && i.removedAt === null).map(i => i.name), ['Второе']);
  assert.equal(loose().querySelector('.flash').textContent, 'Добавлено: 1');
});

test('Р1/рецензия: блок вернули позже дня ухода — прежние записи в «Убранные» не встают, дублей на «Сегодня» нет', async () => {
  const since = daysAgo(10), gone = daysAgo(3);
  const seed = r1Store([r1Block('Утро'), Object.assign(r1Block('Школа'), { removedAt: gone })], [
    r1Action('u1', 'Кровать', since, 'Утро', R1_ALL),
    r1Action('s1', 'Звонок', since, 'Школа', R1_ALL, { removedAt: gone }),
    r1Action('s2', 'Пост', since, 'Школа', R1_ALL, { removedAt: gone }),
    r1Action('sh', 'Чтение', since, 'Школа', R1_ALL, { area: 'habit', normPerWeek: 7, removedAt: gone })
  ]);
  const { document, window } = await boot({ seed });
  r1Settings(document);
  const goneRows = () => [...document.querySelectorAll('#scr-settings .rowwrap.gone')].map(r => r.querySelector('.tname').textContent);
  assert.deepEqual(goneRows(), ['Школа'], 'до возврата — только блок: ушедшее с ним вернётся с ним');
  r1Btn(document, 'group-restore', 'Школа').click();
  const s = r1Saved(window);
  assert.deepEqual(s.items.filter(i => i.group === 'Школа' && i.removedAt === null).map(i => [i.name, i.addedAt]),
    [['Звонок', daysAgo(0)], ['Пост', daysAgo(0)], ['Чтение', daysAgo(0)]], 'новые записи с сегодняшнего дня');
  assert.deepEqual(goneRows(), [], 'прежние отрезки — ни действий, ни привычки — в «Убранные» не встали');
  assert.equal(document.querySelectorAll('#scr-settings [data-act="item-restore"]').length, 0, '«Вернуть» дубля нигде нет');
  assert.equal(r1Card(document, 'Школа').querySelectorAll('.bbody .rowwrap').length, 2);
  document.querySelector('#tabs button[data-tab="today"]').click();
  const names = [...document.querySelectorAll('#scr-today .list .row .tname')].map(n => n.textContent.trim());
  assert.deepEqual(names.slice().sort(), ['Звонок', 'Кровать', 'Пост'], 'по одному экземпляру');
  assert.match(document.querySelector('#scr-today .bar-note').textContent, /^0\s*из\s*3$/);

  // преемник убран — в «Убранных» встаёт он один, последний отрезок
  const s1b = s.items.find(i => i.name === 'Звонок' && i.removedAt === null);
  removeItemThroughUi(document, s1b.id);
  r1Settings(document); // короткий путь снят — остаётся длинный
  assert.deepEqual(goneRows(), ['Звонок']);
  assert.equal([...document.querySelectorAll('#scr-settings .rowwrap.gone [data-act="item-restore"]')][0].dataset.id, s1b.id);
});

test('Р1/рецензия: переименование блока уносит черновики по имени — строки быстрого добавления и выбор «Блок»', async () => {
  const { document, window } = await boot({ seed: r1SettingsSeed() });
  r1Settings(document);
  const drafts = () => Object.keys(window.eval('ui').formDraft);

  // (а) набранные строки быстрого добавления → форма блока → новое имя
  r1Btn(document, 'quick-open', 'Утро').click();
  document.getElementById('q-lines').value = 'Пост\nГлаза';
  r1Btn(document, 'group-open', 'Утро').click();
  document.getElementById('g-name').value = 'Рассвет';
  r1Btn(document, 'group-save', 'Утро').click();
  assert.equal(drafts().includes('quick:Утро'), false, 'под старым именем черновик не висит');
  r1Btn(document, 'quick-open', 'Рассвет').click();
  assert.equal(document.getElementById('q-lines').value, 'Пост\nГлаза', 'набранное переехало вместе с именем');
  document.querySelector('#scr-settings [data-act="quick-cancel"]').click();

  // (б) выбор «Блок» в несохранённой правке → переименование выбранного блока
  r1Edit(document, 'u1');
  r1Pick(document, window, 'Школа');
  r1Btn(document, 'group-open', 'Школа').click();
  document.getElementById('g-name').value = 'Учёба';
  r1Btn(document, 'group-save', 'Школа').click();
  r1Edit(document, 'u1');
  assert.equal(document.getElementById('e-group').value, 'Учёба', 'выбор переехал на новое имя');
  assert.doesNotMatch(r1Form(document).querySelector('#e-group').textContent, /нет в списке/, 'осиротевшего варианта нет');
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  const s = r1Saved(window);
  assert.equal(s.items.find(i => i.id === 'u1').group, 'Учёба', 'действие ушло в переименованный блок, а не в осиротевшее имя');
  assert.deepEqual(s.groups.map(g => g.name), ['Рассвет', 'Учёба', 'Выходной']);
  assert.equal(document.querySelector('#scr-settings .bcard.loose'), null, '«Без блока» не появилась');
});

test('Р1/рецензия: «Дублировать блок» не теряет набранное в форме источника — ни до перерисовки, ни после', async () => {
  const { document, window } = await boot({ seed: r1SettingsSeed() });
  r1Settings(document);
  r1Btn(document, 'group-open', 'Утро').click();
  document.getElementById('g-name').value = 'Утро ранее';
  document.getElementById('g-cap').value = '6:30';
  document.querySelector('#scr-settings [data-act="days-preset"][data-mask="1111100"]').click(); // перерисовка — черновик в слоте
  document.getElementById('g-cap').value = '6:45'; // набрано ПОСЛЕ перерисовки
  r1Btn(document, 'group-dup', 'Утро').click();
  const s = r1Saved(window);
  // v20 (Р2): копия — в режиме источника, здесь основном
  assert.deepEqual(s.groups[1], { name: 'Утро (копия)', caption: '7:00', days: [], removedAt: null, mode: 'main' }, 'копия — сохранённого блока');
  // режим у источника — от migrate при загрузке (v20), а не от формы: подпись и дни прежние
  assert.deepEqual(s.groups[0], { name: 'Утро', caption: '7:00', days: [], removedAt: null, mode: 'main' }, 'источник не записан');
  assert.equal(document.querySelector('#scr-settings [data-form]'), null, 'форма закрыта');
  r1Btn(document, 'group-open', 'Утро').click();
  assert.equal(document.getElementById('g-name').value, 'Утро ранее');
  assert.equal(document.getElementById('g-cap').value, '6:45', 'набранное после последней перерисовки не пропало');
  assert.equal(r1Chips(document), '1111100', 'выбранные дни — тоже');
  // «Отмена» — осознанный отказ: черновик снимается
  document.querySelector('#scr-settings [data-act="group-cancel"]').click();
  r1Btn(document, 'group-open', 'Утро').click();
  assert.equal(document.getElementById('g-cap').value, '7:00');
  assert.equal(r1Chips(document), '1111111');
});

test('Р1/рецензия: свёртку карточки снимает только якорь внутри неё — перенос и возврат привычки её не трогают', async () => {
  const { document, window } = await boot({ seed: r1SettingsSeed() });
  r1Settings(document);
  r1Btn(document, 'group-fold', 'Утро').click();
  const body = () => r1Card(document, 'Утро').querySelector('.bbody');
  assert.equal(body().hidden, true);
  // привычка «Чтение» — из «Школы» в «Утро»: подтверждение ложится в «Привычки»
  r1Edit(document, 'sh');
  r1Pick(document, window, 'Утро');
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.equal(r1Saved(window).items.find(i => i.id === 'sh').group, 'Утро');
  assert.equal(body().hidden, true, 'перенос привычки свёртку «Расписания» не снял');
  // возврат привычки блока «Утро» — тоже
  removeItemThroughUi(document, 'sh');
  r1Settings(document);
  [...document.querySelectorAll('#scr-settings .rowwrap.gone [data-act="item-restore"]')].find(b => b.dataset.id === 'sh').click();
  assert.equal(r1Saved(window).items.find(i => i.id === 'sh').removedAt, null);
  assert.equal(body().hidden, true, 'возврат привычки свёртку не снял');
  // действие — снимает: его подтверждение ложится в карточку (п. 4.2)
  r1Edit(document, 'w1');
  r1Pick(document, window, 'Утро');
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.equal(body().hidden, false, 'перенос действия карточку развернул');
});

test('Р1/рецензия CSS: круг сетки разбора — по первой строке имени, а не по центру растущей ячейки', () => {
  const css = CSS_SRC();
  const i = ruleOf(css, '.grid i');
  assert.ok(i, 'своё правило .grid i');
  assert.match(i, /align-self:\s*start/, 'не центр ячейки: подпись плана растит её на строки');
  const m = /margin-top:\s*calc\(\((\d+)px \* ([\d.]+) - ([\d.]+)px\) \/ 2\)/.exec(i);
  assert.ok(m, 'отступ — формулой из величин, а не подобранным числом');
  assert.equal(+m[1], px(ruleOf(css, '.g-name'), 'font-size'), 'кегль — имени сетки');
  assert.equal(+m[2], parseFloat(/line-height:\s*([\d.]+)/.exec(ruleOf(css, 'body'))[1]), 'интерлиньяж — наследуемый от body');
  assert.equal(+m[3], px(ruleOf(css, '.grid i, .cdays i'), 'height'), 'размер — круга (рамка входит: border-box)');
  assert.match(ruleOf(css, '*'), /box-sizing:\s*border-box/);
  assert.match(ruleOf(css, '.g-plan'), /white-space:\s*normal/, 'подпись по-прежнему переносится');
});

test('Р1/рецензия CSS: короткий путь назад на месте ПЕРВОГО блока — без линии и отступа, как первая карточка', async () => {
  const css = CSS_SRC();
  const first = ruleOf(css, '.blocks > .bcard:first-child, .blocks > .gone-note:first-child');
  assert.ok(first, 'одно правило сброса на первую карточку и на строку на её месте');
  assert.match(first, /border-top:\s*0/);
  assert.match(first, /margin-top:\s*0/);
  assert.equal(px(ruleOf(css, '.blocks > .gone-note:first-child'), 'padding-top'), px(ruleOf(css, '.gone-note'), 'padding'),
    'поле сверху — собственное поле строки, без отступа от линии, которой нет');
  // разметка: убран первый блок — строка встаёт первой в .blocks, и правило к ней применимо
  const { document } = await boot({ seed: r1SettingsSeed() });
  r1Settings(document);
  r1Btn(document, 'group-open', 'Утро').click();
  r1Btn(document, 'group-remove', 'Утро').click();
  r1Btn(document, 'group-remove', 'Утро').click();
  const note = document.querySelector('#scr-settings .blocks > .gone-note');
  assert.ok(note && note.matches('.blocks > .gone-note:first-child'), 'строка ушедшего первого блока — первая в .blocks');
});

/* ══ «Расписание 1/3»: финальное ревью, интерфейс (Р1/ревью) ═══════ */

test('Р1/ревью: блок с двумя одноимёнными действиями вернули назавтра — вернулись оба, «Убранные» пусты', async () => {
  const since = daysAgo(10), gone = daysAgo(1);
  const seed = r1Store([Object.assign(r1Block('Утро'), { removedAt: gone })], [
    r1Action('v1', 'Вода', since, 'Утро', R1_ALL, { removedAt: gone }),
    r1Action('v2', 'Вода', since, 'Утро', R1_ALL, { removedAt: gone }),
    r1Action('d1', 'Другое', since, 'Утро', R1_ALL, { removedAt: gone })
  ]);
  const { document, window } = await boot({ seed });
  r1Settings(document);
  const goneRows = () => [...document.querySelectorAll('#scr-settings .rowwrap.gone')].map(r => r.querySelector('.tname').textContent);
  assert.deepEqual(goneRows(), ['Утро']);
  r1Btn(document, 'group-restore', 'Утро').click();
  const s = r1Saved(window);
  assert.deepEqual(s.items.filter(i => i.removedAt === null).map(i => [i.name, i.addedAt]),
    [['Вода', daysAgo(0)], ['Вода', daysAgo(0)], ['Другое', daysAgo(0)]], 'вернулись все три, вторая «Вода» — тоже');
  assert.deepEqual(goneRows(), [], 'в «Убранных» пусто — невернувшихся нет');
  assert.equal(r1Card(document, 'Утро').querySelectorAll('.bbody .rowwrap').length, 3);
  assert.equal(document.querySelector('#scr-settings .flash').textContent, 'Сохранено');
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.match(document.querySelector('#scr-today .bar-note').textContent, /^0\s*из\s*3$/, '«N из M» — из трёх');
});

test('Р1/ревью: «Вернулись с днями блока» не называет прежний отрезок с парой; устаревшая «Вернуть» — не отказ хранилища', async () => {
  const since = daysAgo(10), gone = daysAgo(3), later = daysAgo(2);
  const seed = r1Store([Object.assign(r1Block('Школа', '', [{ from: since, mask: '1111100' }]), { removedAt: gone })], [
    // свои выходные в будничном блоке — вернулся бы «как блок»; но у него
    // есть пара-преемник p2, и он не вернётся вовсе
    r1Action('p1', 'Звонок', since, 'Школа', '0000011', { removedAt: gone }),
    r1Action('p2', 'Звонок', later, 'Школа', R1_ALL, { removedAt: later }),
    r1Action('q1', 'Душ', since, 'Школа', '0000011', { removedAt: gone })
  ]);
  const { document, window } = await boot({ seed });
  r1Settings(document);
  r1Btn(document, 'group-restore', 'Школа').click();
  assert.equal(document.querySelector('#scr-settings .flash').textContent,
    'Вернулось с днями блока: Душ — свои дни в них не попадали', 'названо только вернувшееся');
  const s = r1Saved(window);
  assert.deepEqual(s.items.filter(i => i.removedAt === null).map(i => i.name), ['Душ']);
  assert.equal(s.items.find(i => i.id === 'p1').removedAt, gone, 'прежний отрезок с парой — не вернулся');
  const restoreIds = () => [...document.querySelectorAll('#scr-settings .rowwrap.gone [data-act="item-restore"]')].map(b => b.dataset.id);
  assert.deepEqual(restoreIds(), ['p2'], 'в «Убранных» — последний отрезок');

  // устаревшая кнопка у прежнего отрезка: возвращать нечего, и хранилище
  // тут ни при чём — экран перерисован, отказа не сказано
  const stale = document.createElement('button');
  stale.dataset.act = 'item-restore';
  stale.dataset.id = 'p1';
  document.getElementById('scr-settings').appendChild(stale);
  const before = window.localStorage.getItem(NS);
  stale.click();
  assert.equal(window.localStorage.getItem(NS), before, 'ничего не записано');
  assert.equal(document.querySelector('#scr-settings .flash.keep'), null, 'отказа нет');
  assert.doesNotMatch(document.getElementById('scr-settings').textContent, /хранилище недоступно/);
  assert.equal(stale.isConnected, false, 'экран перерисован — устаревшей кнопки нет');

  // а настоящий отказ записи называется, как прежде
  const p2 = [...document.querySelectorAll('#scr-settings .rowwrap.gone [data-act="item-restore"]')].find(b => b.dataset.id === 'p2');
  withBrokenStorage(window, () => p2.click());
  assert.match(document.querySelector('#scr-settings .flash.keep').textContent, /^Не возвращено: хранилище недоступно$/);
  assert.equal(r1Saved(window).items.find(i => i.id === 'p2').removedAt, later);
});

/* Ключ черновика формы добавления не совпадает с ключом правки блока или
   упражнения, чьё имя или id — «new»: прежде оба давали 'group:new'
   ('ex:new'), и дни, выбранные в «Добавить блок», записывались в чужой блок */
test('Р1/ревью: блок «new» и упражнение «new» — черновик формы добавления не накатывается на их правку', async () => {
  const since = daysAgo(10);
  const seed = r1Store([r1Block('new')], [r1Action('n1', 'Кровать', since, 'new', R1_ALL)]);
  seed.exercises = [{ id: 'new', name: 'Жим', unit: 'кг', value: 40, history: [], addedAt: since, removedAt: null }];
  const { document, window } = await boot({ seed });
  r1Settings(document);

  document.querySelector('#scr-settings [data-act="group-add-open"]').click();
  document.getElementById('g-add').value = 'Вечер';
  document.querySelector('#scr-settings [data-act="days-preset"][data-mask="0000011"]').click();
  assert.equal(r1Chips(document), '0000011');
  r1Btn(document, 'group-open', 'new').click();
  const form = document.querySelector('#scr-settings [data-form="group-edit"]');
  assert.ok(form && form.dataset.id === 'new', 'открыта правка блока «new»');
  assert.equal(r1Chips(document), R1_ALL, 'дни блока «new» — его собственные, а не выбор формы добавления');
  document.querySelector('#scr-settings [data-act="group-save"]').click();
  assert.deepEqual(r1Saved(window).groups.find(g => g.name === 'new').days, [], 'в дни чужого блока ничего не записано');
  document.querySelector('#scr-settings [data-act="group-add-open"]').click();
  assert.equal(document.getElementById('g-add').value, 'Вечер', 'набранное в форме добавления цело');
  assert.equal(r1Chips(document), '0000011', 'и выбранные дни');

  openSect(document, /Упражнения/);
  document.querySelector('#scr-settings [data-act="ex-add-open"]').click();
  document.getElementById('x-add-name').value = 'Присед';
  byId(document, 'ex-open', 'new').click();
  assert.equal(document.getElementById('x-name').value, 'Жим', 'открыта правка упражнения «new»');
  document.querySelector('#scr-settings [data-act="ex-save"]').click();
  document.querySelector('#scr-settings [data-act="ex-add-open"]').click();
  assert.equal(document.getElementById('x-add-name').value, 'Присед', 'сохранение правки «new» не сняло черновик формы добавления');
});

/* Фильтр соседей по блоку в dragSiblings: в карточке «Без блока» в одном
   списке стоят пункты без блока и пункты с осиротевшим именем из импорта.
   Прежде фильтр нагружал тест 16F, где чужая строка стояла между соседями;
   с карточками блоков чужой блок отсекается родителем, и фильтр data-dgroup
   ничем не проверялся */
test('Р1/ревью: перетаскивание в «Без блока» — соседи только своего имени (data-dgroup)', async () => {
  const since = daysAgo(10);
  const seed = r1Store([r1Block('Утро')], [
    r1Action('u1', 'Кровать', since, 'Утро', R1_ALL),
    r1Action('x1', 'Первый', since, '', R1_ALL),
    r1Action('y1', 'Чужой пункт', since, 'Чужой', R1_ALL),
    r1Action('x2', 'Второй', since, '', R1_ALL)
  ]);
  const { document, window } = await boot({ seed });
  const saved = () => r1Saved(window).items.map(i => i.id);
  r1Settings(document);
  assert.deepEqual(r1Saved(window).groups.map(g => g.name), ['Утро'], 'осиротевшее имя блока не получило');
  const rows = () => [...document.querySelectorAll('#scr-settings [data-drag="item"]')].filter(r => r.dataset.dragId !== 'u1');
  assert.deepEqual(rows().map(r => [r.dataset.dragId, r.dataset.dgroup]), [['x1', ''], ['y1', 'Чужой'], ['x2', '']]);
  assert.equal(new Set(rows().map(r => r.parentElement)).size, 1, 'все три — в одном списке');

  // палец между чужой строкой и x2: среди своих x1 по-прежнему первый
  stubRows(rows());
  rows()[0].dispatchEvent(pointer(window, 'pointerdown', 100, 230));
  await hold();
  document.dispatchEvent(pointer(window, 'pointermove', 100, 320));
  document.dispatchEvent(pointer(window, 'pointerup', 100, 320));
  assert.deepEqual(saved(), ['u1', 'x1', 'y1', 'x2'], 'чужая строка позицией среди своих не считается');

  // ниже середины x2 — x1 встаёт за ним; чужая строка — на своём месте
  stubRows(rows());
  rows()[0].dispatchEvent(pointer(window, 'pointerdown', 100, 230));
  await hold();
  document.dispatchEvent(pointer(window, 'pointermove', 100, 355));
  document.dispatchEvent(pointer(window, 'pointerup', 100, 355));
  assert.deepEqual(saved(), ['u1', 'x2', 'y1', 'x1']);
});

/* Сдвиг окна по дням — логическими днями, а не кратным 24 часам: через
   перевод стрелок около границы 04:00 фикстуры «вторника» и «назавтра»
   попадали не в тот день. Часовой пояс владельца подставляется на время
   теста и возвращается; тест синхронный — ни один таймер окон в это время
   не срабатывает */
test('Р1/ревью: shiftWindowDays и moveToWeekday — логический день и через перевод стрелок (America/Toronto)', () => {
  const was = process.env.TZ;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fakeWin = iso => {
    const t = Date.parse(iso);
    const RealD = Date;
    return {
      Date: class extends RealD {
        constructor(...a) { if (a.length) super(...a); else super(t); }
        static now() { return t; }
      },
      Event: class { constructor(type) { this.type = type; } }
    };
  };
  const doc = { dispatchEvent() {} };
  const keyOf = w => dayKey(new w.Date());
  try {
    process.env.TZ = 'America/Toronto';
    // пятница 30.10.2026, 04:30 EDT; во вторник 03.11 уже EST
    let w = fakeWin('2026-10-30T08:30:00Z');
    assert.equal(keyOf(w), '2026-10-30');
    moveToWeekday(w, doc, 1);
    assert.equal(keyOf(w), '2026-11-03', 'осенью: вторник, а не понедельник');
    // 01.11.2026, 03:30 EST — в день перевода граница дня уже в 03:00
    // (принятое ограничение dateKeyShift); +24 часа давали тот же 01.11
    w = fakeWin('2026-11-01T08:30:00Z');
    assert.equal(keyOf(w), '2026-11-01');
    shiftWindowDays(w, 1);
    assert.equal(keyOf(w), '2026-11-02', 'назавтра — следующий логический день');
    shiftWindowDays(w, 1);
    assert.equal(keyOf(w), '2026-11-03', 'сдвиги складываются');
    // весна: пятница 12.03.2027, 03:30 EST — логически четверг 11.03
    w = fakeWin('2027-03-12T08:30:00Z');
    assert.equal(keyOf(w), '2027-03-11');
    moveToWeekday(w, doc, 0);
    assert.equal(keyOf(w), '2027-03-15', 'весной: понедельник, а не вторник');
  } finally {
    process.env.TZ = was !== undefined ? was : zone;
  }
});

/* ══ Задача Р2 («Расписание 2/2»), этап 1: хвосты Р1 (п. 5) ═══════ */

test('Р2/5: пустые «Привычки» — «на сегодня нет» при живых привычках вне дня, «пока нет» — только без живых', async () => {
  const since = addKey(curMonday(), -14);
  const seedWith = (items) => {
    const s = r1Store([], items);
    s.settings.calendarSince = since;
    return s;
  };
  const weekend = extra => r1Action('hb', 'Бассейн', since, '', '0000011', Object.assign({ area: 'habit', normPerWeek: 2 }, extra));
  const param = () => {
    const p = r1Action('ph', 'Отбой', since, '', R1_ALL, { type: 'param', area: 'habit', pkind: 'time', pvalue: 1380, pstep: -15, history: [{ date: since, value: 1380 }] });
    delete p.schedule;
    return p;
  };
  const habitsOf = async (items, dow) => {
    const { document, window } = await boot({ seed: seedWith(items) });
    await moveToWeekday(window, document, dow);
    document.querySelector('#tabs button[data-tab="habits"]').click();
    return document.getElementById('scr-habits');
  };

  // (1) вторник: живая привычка только по выходным — строка дня, без планки
  const a = await habitsOf([weekend(), param()], 1);
  assert.match(a.textContent, /На сегодня привычек в расписании нет\./);
  assert.doesNotMatch(a.textContent, /Привычек пока нет/, 'не звать заводить заведённое');
  assert.equal(a.querySelector('.dayline'), null, 'измерять нечего — планки нет');
  assert.equal(a.querySelector('.list'), null);
  assert.match(a.textContent, /Порог недели/, 'параметры от ветки не зависят');
  assert.ok(a.querySelector('.creed'), 'кредо-строка на месте');

  // (2) суббота: та же привычка в дне — строки нет, планка есть
  const b = await habitsOf([weekend()], 5);
  assert.doesNotMatch(b.textContent, /На сегодня привычек в расписании нет/);
  assert.match(b.querySelector('.bar-note').textContent, /^сегодня\s*0\s*из\s*1$/);

  // (3) привычка убрана — живых нет вовсе: прежняя строка с путём
  const c = await habitsOf([weekend({ removedAt: addKey(since, 1) })], 1);
  assert.match(c.textContent, /Привычек пока нет — добавить можно в Настройках → Привычки\./);
  assert.doesNotMatch(c.textContent, /На сегодня привычек/, 'убранная привычка заведённой не считается');

  // (4) живое действие вне дня — не привычка: «Привычки» принадлежат программе роста
  const d = await habitsOf([r1Action('mn', 'Кровать', since, '', '0000011')], 1);
  assert.match(d.textContent, /Привычек пока нет — добавить можно в Настройках → Привычки\./);
  assert.doesNotMatch(d.textContent, /На сегодня привычек/, 'действие привычкой не считается');
});

test('Р2/5: «Убранные» упражнений — прежняя запись с преемником не стоит; устаревшая «Вернуть» дубля не заводит', async () => {
  const seed = trainSeed();
  const old = addKey(prevMonday(), -14);
  seed.exercises = [
    { id: 'e1', name: 'Жим', unit: 'кг', value: 40, addedAt: old, removedAt: daysAgo(3), history: [{ date: old, value: 40 }] },
    { id: 'e1b', name: 'Жим', unit: 'кг', value: 42, addedAt: daysAgo(2), removedAt: daysAgo(1), history: [{ date: daysAgo(2), value: 42 }] },
    { id: 'e2', name: 'Тяга', unit: 'кг', value: 60, addedAt: old, removedAt: null, history: [{ date: old, value: 60 }] }
  ];
  const { document, window } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  const sect = [...document.querySelectorAll('#scr-settings details.sect')]
    .find(d => /Упражнения/.test(d.querySelector('summary').textContent));
  sect.querySelector('summary').click();
  const goneIds = () => [...document.querySelectorAll('#scr-settings .rowwrap.gone [data-act="ex-restore"]')].map(b => b.dataset.id);
  assert.deepEqual(goneIds(), ['e1b'], 'в «Убранных» — только последний отрезок «Жима»');

  document.querySelector('#scr-settings .rowwrap.gone [data-act="ex-restore"]').click();
  const s = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(s.exercises.filter(e => e.removedAt === null && e.name === 'Жим').length, 1, 'живой «Жим» — один');
  assert.deepEqual(goneIds(), [], '«Убранные» пусты: оба прежних отрезка при парах');

  // устаревшая кнопка у самой первой записи: возвращать нечего, и хранилище ни при чём
  const stale = document.createElement('button');
  stale.dataset.act = 'ex-restore';
  stale.dataset.id = 'e1';
  document.getElementById('scr-settings').appendChild(stale);
  const before = window.localStorage.getItem(NS);
  stale.click();
  assert.equal(window.localStorage.getItem(NS), before, 'ничего не записано — дубля нет');
  assert.equal(document.querySelector('#scr-settings .flash.keep'), null, 'отказа нет');
  assert.equal(stale.isConnected, false, 'экран перерисован');

  // и на листе «Тренировка» — по одному полю на упражнение
  document.querySelector('#tabs button[data-tab="today"]').click();
  document.querySelector('[data-act="train-inc"]').click();
  assert.equal(document.querySelectorAll('#scr-train input[id^="ex-"]').length, 2, 'Жим и Тяга — по одному полю');
});

test('Р2/5: group-restore — «хранилище недоступно» только при реальном отказе записи', async () => {
  const since = daysAgo(10);
  const seed = r1Store([
    Object.assign(r1Block('Школа'), { removedAt: daysAgo(2) }),
    Object.assign(r1Block('Вечер'), { removedAt: daysAgo(2) })
  ], [
    r1Action('s1', 'Зал', since, 'Школа', R1_ALL, { removedAt: daysAgo(2) }),
    r1Action('v1', 'Чтение', since, 'Вечер', R1_ALL, { removedAt: daysAgo(2) })
  ]);
  const { document, window } = await boot({ seed });
  r1Settings(document);
  const staleBtn = name => {
    const x = document.createElement('button');
    x.dataset.act = 'group-restore';
    x.dataset.name = name;
    document.getElementById('scr-settings').appendChild(x);
    return x;
  };

  // блок уже вернулся — кнопка устарела: не отказ, перерисовка
  r1Btn(document, 'group-restore', 'Школа').click();
  assert.equal(r1Saved(window).groups.find(g => g.name === 'Школа').removedAt, null);
  for (const name of ['Школа', 'Нет такого']) {
    const x = staleBtn(name);
    const before = window.localStorage.getItem(NS);
    x.click();
    assert.equal(window.localStorage.getItem(NS), before, name + ': ничего не записано');
    assert.equal(document.querySelector('#scr-settings .flash.keep'), null, name + ': отказа нет');
    assert.doesNotMatch(document.getElementById('scr-settings').textContent, /хранилище недоступно/);
    assert.equal(x.isConnected, false, name + ': экран перерисован — устаревшей кнопки нет');
  }

  // настоящий отказ записи называется, блок остаётся убранным
  const evening = r1Btn(document, 'group-restore', 'Вечер');
  withBrokenStorage(window, () => evening.click());
  assert.match(document.querySelector('#scr-settings .flash.keep').textContent, /^Не возвращено: хранилище недоступно$/);
  assert.equal(r1Saved(window).groups.find(g => g.name === 'Вечер').removedAt, daysAgo(2));
});

test('Р2/5: нечитаемая копия — пояснение называет ту кнопку, что стоит под ним: «Стереть нечитаемое»', async () => {
  const idb = new IDBFactory();
  await idbPut(idb, { json: '{обрыв', savedAt: 1, schemaVersion: 16 });
  const { document } = await boot({ idb, raw: '{битый json' });
  openData(document);
  const blocks = [...document.querySelectorAll('#scr-settings .restore.corrupt')];
  assert.equal(blocks.length, 2, 'оба источника');
  for (const bl of blocks) {
    assert.equal(bl.querySelector('[data-act="corrupt-drop"]').textContent, 'Стереть нечитаемое');
    assert.doesNotMatch(bl.textContent, /Убрать/, 'слова обратимой операции в строке стирания нет');
    for (const m of bl.textContent.matchAll(/«([^»]+)»/g)) {
      assert.ok([...bl.querySelectorAll('button')].some(x => x.textContent === m[1]), `названная кнопка «${m[1]}» стоит в строке`);
    }
  }
  const mirror = blocks.find(bl => bl.querySelector('[data-src="mirror"]'));
  assert.match(mirror.textContent, /«Стереть нечитаемое» освободит место под неё/);
});

test('Р2/5: акцентный текст на «Настройках» — ровно .hint и номерные кружки «Системы», как записано в CLAUDE.md', async () => {
  const seed = r1Store([], [r1Action('hb', 'Бассейн', daysAgo(2), '', R1_ALL, { area: 'habit', normPerWeek: 7 })]);
  const { document } = await boot({ seed });
  document.querySelector('#tabs button[data-tab="settings"]').click();
  document.querySelector('#scr-settings [data-act="add-open"][data-area="habit"]').click();
  for (const d of document.querySelectorAll('#scr-settings details.sect')) d.open = true;
  assert.ok(document.querySelector('#scr-settings .hint'), 'подсказка формы добавления привычки видна');
  assert.ok(document.querySelector('#scr-settings .rules li'), 'правила «Системы» в разметке');

  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const found = new Set();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(?:^|[;{\s])color\s*:\s*var\(--accent\)/.test(m[2])) continue; // текст, не рамка и не заливка
    for (const sel of m[1].split(',').map(x => x.trim())) {
      const probe = sel.replace(/::[\w-]+/g, '').replace(/:(?:active|hover|focus-visible|focus-within|focus)\b/g, '');
      let hit = false;
      try { hit = !!document.querySelector('#scr-settings ' + probe); } catch (e) { hit = false; }
      if (hit) found.add(sel);
    }
  }
  assert.deepEqual([...found].sort(), ['.hint', '.rules li::before'], 'акцентный текст «Настроек»');
  const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  assert.doesNotMatch(claude, /Акцентного ТЕКСТА на «Настройках» после этого нет/, 'неверное утверждение снято');
  assert.match(claude, /Акцентного текста на «Настройках» после этого ровно два места[^\n]*`\.hint`[^\n]*`\.rules li::before`/);
});

test('Р2/5: сдвиг окна на логические дни — через перевод стрелок; N·24 часа в тестах окна не встречается', () => {
  const was = process.env.TZ;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fakeWin = iso => {
    const t = Date.parse(iso);
    const RealD = Date;
    return {
      Date: class extends RealD {
        constructor(...a) { if (a.length) super(...a); else super(t); }
        static now() { return t; }
      }
    };
  };
  const keyOf = w => dayKey(new w.Date());
  try {
    process.env.TZ = 'America/Toronto';
    // 01.11.2026, 03:30 EST: прежние stale-guard, visibilitychange, focus,
    // З23/5 и З22/7.2 сдвигали на 24 часа — и оставались в том же дне
    let raw = fakeWin('2026-11-01T08:30:00Z');
    shiftWindowDate(raw, 24 * 3600000);
    assert.equal(keyOf(raw), '2026-11-01', 'замер: 24 часа — тот же логический день');
    let w = fakeWin('2026-11-01T08:30:00Z');
    shiftWindowDays(w, 1);
    assert.equal(keyOf(w), '2026-11-02');
    shiftWindowDays(w, 2);
    assert.equal(keyOf(w), '2026-11-04', 'сдвиги складываются');
    // понедельник 26.10.2026, 04:30 EDT: «ровно неделя вперёд» за 168 часов
    // приходилась на воскресенье той же недели
    raw = fakeWin('2026-10-26T08:30:00Z');
    shiftWindowDate(raw, 168 * 3600000);
    assert.equal(keyOf(raw), '2026-11-01', 'замер: 168 часов — шесть логических дней');
    w = fakeWin('2026-10-26T08:30:00Z');
    shiftWindowDays(w, 7);
    assert.equal(keyOf(w), '2026-11-02', 'семь логических — следующий понедельник');
    // весна: 14.03.2027, 03:30 EDT — логически ещё 13.03
    w = fakeWin('2027-03-14T07:30:00Z');
    assert.equal(keyOf(w), '2027-03-13');
    shiftWindowDays(w, 1);
    assert.equal(keyOf(w), '2027-03-14');
  } finally {
    process.env.TZ = was !== undefined ? was : zone;
  }
  // сторож: сдвиг на целые сутки сырыми часами в тестах окна не пишется
  const src = fs.readFileSync(__filename, 'utf8');
  const bad = [];
  for (const m of src.matchAll(/shiftWindowDate\(([\w.]+),\s*([^)]*)\)/g)) {
    if (m[1] === 'raw') continue; // замеры выше — предмет этого теста
    const arg = m[2].replace(/\s+/g, '');
    const h = /^(\d+)\*3600000$/.exec(arg), d = /^(?:(\d+)\*)?86400000$/.exec(arg);
    if ((h && +h[1] % 24 === 0) || d) bad.push(m[0]);
  }
  assert.deepEqual(bad, [], 'сдвиг на N суток — shiftWindowDays');
});

/* ══ Задача Р2 («Расписание 2/2»), этап 3: режимы — интерфейс ═══════
   Переключатель режима первой строкой «Расписания», карточки выбранного
   режима, имя режима на «Сегодня», «Дублировать в режим», привычки при
   смене режима, «Убранные» по блокам всех режимов. Домен режимов закреплён
   тестами «Р2/1» в domain.test.js; здесь предмет — разметка и обработчики. */

const R2_KAN = 'kan';

/* Два режима с одноимённым блоком «Утро»: у основного — «Утро» (7:00) и
   «Школа», у «Каникул» — «Утро» (9:00) и «Лагерь». Действия — своего режима;
   привычки глобальны: «Чтение» — в «Утре» (есть в обоих режимах), «Плавание» —
   в «Лагере» (только у «Каникул»), «Вода» — без блока; параметр «Отбой» — в
   «Школе» (только у основного). Маски ежедневные: от дня недели не зависит. */
const r2Blk = (name, mode, caption, extra) => Object.assign(r1Block(name, caption), { mode }, extra || {});
function r2UiSeed({ modes, groups, items, days, modeLog } = {}) {
  const since = addKey(curMonday(), -14);
  const act = (id, name, group, mode, extra) => r1Action(id, name, since, group, R1_ALL, Object.assign({ mode }, extra || {}));
  const habit = (id, name, group, extra) => r1Action(id, name, since, group, R1_ALL, Object.assign({ area: 'habit', normPerWeek: 7 }, extra || {}));
  const param = r1Action('ph', 'Отбой', since, 'Школа', R1_ALL, { type: 'param', area: 'habit', pkind: 'time', pvalue: 1380, pstep: -15, history: [{ date: since, value: 1380 }] });
  delete param.schedule;
  const s = r1Store(
    groups || [r2Blk('Утро', 'main', '7:00'), r2Blk('Школа', 'main', 'до 15:15'), r2Blk('Утро', R2_KAN, '9:00'), r2Blk('Лагерь', R2_KAN, '')],
    items || [
      act('m1', 'Кровать', 'Утро', 'main'), act('m2', 'Математика', 'Школа', 'main'),
      act('k1', 'Зарядка', 'Утро', R2_KAN), act('k2', 'Костёр', 'Лагерь', R2_KAN),
      habit('h1', 'Чтение', 'Утро'), habit('h2', 'Плавание', 'Лагерь'), habit('h3', 'Вода', ''),
      param
    ],
    days);
  s.modes = modes || [{ id: 'main', name: 'Основной', removedAt: null }, { id: R2_KAN, name: 'Каникулы', removedAt: null }];
  s.modeLog = modeLog || [];
  s.settings.calendarSince = since;
  return s;
}

const r2Head = document => document.querySelector('#scr-settings [data-act="mode-list"]');
const r2List = document => document.getElementById('mode-list');
function r2OpenModes(document) {
  r1Settings(document);
  if (r2List(document).hidden) r2Head(document).click();
  assert.equal(r2List(document).hidden, false, 'список режимов раскрыт');
  return r2List(document);
}
const r2Btn = (document, act, id) => [...document.querySelectorAll(`#scr-settings [data-act="${act}"]`)].find(b => b.dataset.id === id);
const r2Cards = document => [...document.querySelectorAll('#scr-settings .bcard[data-drag="group"]')].map(c => c.dataset.dragId);
const r2Today = document => [...document.querySelectorAll('#scr-today input[data-act="mark"]')].map(i => i.dataset.id);
const r2Rows = list => [...list.children].filter(n => n.matches('.mrow'));
function r2Pick(document, id) {
  r2OpenModes(document);
  r2Btn(document, 'mode-pick', id).click();
}

test('Р2/2: переключатель режима — первой строкой над карточками; список раскрывается, выбранный отмечен; убранные в конце с «Вернуть», «Новый режим» последним', async () => {
  const seed = r2UiSeed();
  seed.modes.push({ id: 'old', name: 'Старый', removedAt: daysAgo(5) });
  const { document, window } = await boot({ seed });
  const scr = r1Settings(document);
  const body = scr.querySelector('details.sect .sect-b');
  assert.ok(body.firstElementChild.classList.contains('modes'), 'переключатель — первым в «Расписании»');
  assert.ok(body.firstElementChild.nextElementSibling.classList.contains('blocks'), 'карточки — сразу за ним');

  const head = r2Head(document);
  assert.equal(head.querySelector('.tname').textContent, 'Режим: Основной');
  assert.ok(head.querySelector('.chev'), 'шеврон раскрытия');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(head.getAttribute('aria-controls'), 'mode-list');
  assert.ok(r2List(document), 'aria-controls указывает на живой узел');
  assert.equal(r2List(document).hidden, true, 'по умолчанию список скрыт');
  assert.ok(head.matches('.itxt'), 'тач-цель с откликом на нажатие');
  const before = window.localStorage.getItem(NS);

  head.click();
  const list = r2List(document);
  assert.equal(list.hidden, false);
  assert.equal(r2Head(document).getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, r2Head(document), 'фокус остался на строке режима');
  const rows = r2Rows(list);
  assert.deepEqual(rows.map(r => r.querySelector('.row .tname').textContent), ['Основной', 'Каникулы'], 'живые режимы в порядке store.modes');
  const [main, kan] = rows;
  assert.equal(main.getAttribute('aria-current'), 'true', 'выбранный отмечен для AT');
  assert.equal(kan.getAttribute('aria-current'), null);
  assert.equal(main.querySelector('.meta').textContent, 'выбран', 'и видимо');
  assert.equal(kan.querySelector('.meta'), null);
  assert.equal(main.querySelector('[data-act="mode-pick"]'), null, 'выбранный не выбирается');
  assert.equal(main.querySelector('[data-act="mode-remove"]'), null, 'выбранный не убирается');
  assert.ok(main.querySelector('[data-act="mode-rename-open"]'), 'но переименовывается');
  for (const act of ['mode-pick', 'mode-rename-open', 'mode-remove']) {
    const b = kan.querySelector(`[data-act="${act}"]`);
    assert.ok(b && b.dataset.id === R2_KAN && b.matches('.btn'), 'у невыбранного: ' + act);
    assert.match(b.getAttribute('aria-label'), /режим «Каникулы»/, 'имя режима — в названии кнопки');
  }
  assert.equal(kan.querySelector('[data-act="mode-pick"]').textContent, 'Выбрать');
  assert.equal(kan.querySelector('[data-act="mode-rename-open"]').textContent, 'Переименовать');
  assert.equal(kan.querySelector('[data-act="mode-remove"]').textContent, 'Убрать');

  const gone = [...list.children].filter(n => n.matches('.rowwrap.gone'));
  assert.equal(gone.length, 1, 'убранный — строкой «Убранных»');
  assert.equal(gone[0].querySelector('.tname').textContent, 'Старый');
  assert.equal(gone[0].querySelector('.meta').textContent, 'убран ' + fmtShortKey(daysAgo(5)));
  assert.equal(gone[0].querySelector('[data-act="mode-restore"]').dataset.id, 'old');
  assert.ok(rows[rows.length - 1].compareDocumentPosition(gone[0]) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'убранные — после живых');
  assert.equal(list.lastElementChild.dataset.act, 'mode-add-open', '«Новый режим» — последним');
  assert.equal(list.lastElementChild.textContent, 'Новый режим');

  r2Head(document).click();
  assert.equal(r2List(document).hidden, true, 'второй тап сворачивает');
  assert.equal(window.localStorage.getItem(NS), before, 'раскрытие ничего не пишет');
});

test('Р2/2: «Выбрать» — один тап: отрезок журнала с сегодняшнего дня, подтверждение под строкой режима; карточки и «Сегодня» — выбранного режима', async () => {
  const { document, window } = await boot({ seed: r2UiSeed() });
  assert.deepEqual(r2Today(document), ['m1', 'm2'], '«Сегодня» — действия основного режима');
  r1Settings(document);
  assert.deepEqual(r2Cards(document), ['Утро', 'Школа'], 'карточки основного режима');
  assert.match(r1Card(document, 'Утро').textContent, /Кровать/);

  const before = window.localStorage.getItem(NS);
  r2Pick(document, R2_KAN);
  assert.notEqual(window.localStorage.getItem(NS), before, 'выбор записан с первого тапа');
  assert.deepEqual(r1Saved(window).modeLog, [{ from: daysAgo(0), mode: R2_KAN }], 'отрезок с сегодняшнего дня');
  assert.equal(r2List(document).hidden, true, 'список закрылся');
  assert.equal(r2Head(document).querySelector('.tname').textContent, 'Режим: Каникулы');
  const flash = document.querySelector('#scr-settings .modes .flash');
  assert.ok(flash, 'подтверждение у строки режима');
  assert.equal(flash.textContent, 'Режим: Каникулы — с сегодняшнего дня');
  assert.equal(flash.previousElementSibling, r2Head(document), 'сразу под строкой «Режим»');

  assert.deepEqual(r2Cards(document), ['Утро', 'Лагерь'], 'карточки — выбранного режима');
  const morning = r1Card(document, 'Утро');
  assert.equal(morning.querySelector('.bhead .bcap').textContent, '9:00', 'одноимённый блок — свой, со своей подписью');
  assert.match(morning.textContent, /Зарядка/);
  assert.doesNotMatch(morning.textContent, /Кровать/, 'действия другого режима в одноимённой карточке не стоят');
  assert.equal(document.querySelector('#scr-settings .bcard.loose'), null, '«Без блока» не нужна');

  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.deepEqual(r2Today(document), ['k1', 'k2'], '«Сегодня» — действия выбранного режима');
  assert.equal(document.querySelector('#scr-today .hmode').textContent, 'режим Каникулы');

  // назад в тот же день — отрезок снимается, журнал пуст: до первого отрезка и так основной
  r2Pick(document, 'main');
  assert.deepEqual(r1Saved(window).modeLog, []);
  assert.equal(document.querySelector('#scr-settings .modes .flash').textContent, 'Режим: Основной — с сегодняшнего дня');
  assert.deepEqual(r2Cards(document), ['Утро', 'Школа']);

  // устаревшая кнопка (режим уже убран) — не отказ, перерисовка
  window.eval('store').modes[1].removedAt = daysAgo(0);
  window.save();
  const stale = document.createElement('button');
  stale.dataset.act = 'mode-pick';
  stale.dataset.id = R2_KAN;
  document.getElementById('scr-settings').appendChild(stale);
  const was = window.localStorage.getItem(NS);
  stale.click();
  assert.equal(window.localStorage.getItem(NS), was, 'ничего не записано');
  assert.equal(document.querySelector('#scr-settings .flash.keep'), null, 'отказа нет');
  assert.equal(stale.isConnected, false, 'экран перерисован');

  // отказ записи — строкой у кнопки, журнал цел
  window.eval('store').modes[1].removedAt = null;
  window.save();
  r2OpenModes(document);
  withBrokenStorage(window, () => r2Btn(document, 'mode-pick', R2_KAN).click());
  assert.equal(document.querySelector('#scr-settings .flash.keep').textContent, 'Не выбрано: хранилище недоступно');
  assert.deepEqual(r1Saved(window).modeLog, []);
  assert.equal(window.eval('store').modeLog.length, 0, 'откат в памяти');
});

test('Р2/2: смена режима снимает формы, черновики, свёртки и короткие пути назад; после возврата ничего чужого не всплывает', async () => {
  const { document, window } = await boot({ seed: r2UiSeed() });
  r1Settings(document);
  // черновик формы блока «Утро» основного режима, быстрое добавление в нём же, свёрнутая «Школа»
  r1Btn(document, 'group-open', 'Утро').click();
  document.getElementById('g-name').value = 'ЧЕРНОВИК БЛОКА';
  r1Btn(document, 'quick-open', 'Утро').click();
  document.getElementById('q-lines').value = 'ЧУЖИЕ СТРОКИ';
  r1Btn(document, 'group-fold', 'Школа').click();
  assert.equal(r1Card(document, 'Школа').querySelector('.bbody').hidden, true);
  assert.ok(window.eval('ui').formDraft['group:Утро'], 'черновик формы блока лежит');
  assert.ok(window.eval('ui').formDraft['quick:Утро'], 'и быстрого добавления');

  r2Pick(document, R2_KAN);
  assert.equal(document.querySelector('#scr-settings [data-form]'), null, 'формы закрыты');
  assert.deepEqual(Object.keys(window.eval('ui').formDraft), [], 'черновики сняты');
  assert.deepEqual(Object.keys(window.eval('ui').blockFold), [], 'свёртки сняты');
  r1Btn(document, 'group-open', 'Утро').click();
  assert.equal(document.getElementById('g-name').value, 'Утро', 'одноимённый блок другого режима — без чужого черновика');
  assert.equal(document.getElementById('g-cap').value, '9:00');
  document.querySelector('#scr-settings [data-act="group-cancel"]').click();
  r1Btn(document, 'quick-open', 'Утро').click();
  assert.equal(document.getElementById('q-lines').value, '', 'быстрое добавление — пустое');
  document.querySelector('#scr-settings [data-act="quick-cancel"]').click();

  // короткий путь назад блока «Лагерь» — и снова смена режима
  r1Btn(document, 'group-open', 'Лагерь').click();
  r1Btn(document, 'group-remove', 'Лагерь').click();
  r1Btn(document, 'group-remove', 'Лагерь').click();
  assert.ok(document.querySelector('#scr-settings .blocks > .gone-note'), 'короткий путь стоит');
  r2Pick(document, 'main');
  assert.equal(document.querySelector('#scr-settings .gone-note'), null, 'короткий путь снят');
  assert.equal(window.eval('ui').goneGroup, null);
  assert.equal(r1Card(document, 'Школа').querySelector('.bbody').hidden, false, 'свёртка «Школы» не вернулась');
  r1Btn(document, 'group-open', 'Утро').click();
  assert.equal(document.getElementById('g-name').value, 'Утро', 'черновик прежнего режима не всплыл');
  assert.equal(document.getElementById('g-cap').value, '7:00');
});

test('Р2/2: «Новый режим» — пустой и копия текущего; отказы строкой; подтверждение у строки нового режима; сам он не выбирается', async () => {
  const { document, window } = await boot({ seed: r2UiSeed() });
  r2OpenModes(document);
  document.querySelector('#scr-settings [data-act="mode-add-open"]').click();
  const form = () => document.querySelector('#scr-settings [data-form="mode-add"]');
  assert.ok(form() && form().matches('.card.form'), 'форма открыта');
  assert.equal(document.querySelector('#scr-settings [data-act="mode-add-open"]'), null, 'кнопка уступила место форме');
  const inp = () => document.getElementById('m-add');
  assert.equal(inp().type, 'text');
  assert.match(form().textContent, /Копия берёт блоки и действия режима «Основной» с сегодняшнего дня\. Привычки общие для всех режимов\./);
  assert.deepEqual([...form().querySelectorAll('.btn')].map(b => [b.dataset.act, b.textContent]),
    [['mode-add-copy', 'Копия текущего'], ['mode-add-empty', 'Пустой'], ['mode-add-cancel', 'Отмена']]);

  let before = window.localStorage.getItem(NS);
  document.querySelector('#scr-settings [data-act="mode-add-empty"]').click();
  r1Refused(document, window, 'mode-add-empty', /^Название не заполнено$/, before);
  assert.equal(document.activeElement, inp(), 'фокус — в название');
  inp().value = ' Каникулы ';
  document.querySelector('#scr-settings [data-act="mode-add-copy"]').click();
  r1Refused(document, window, 'mode-add-copy', /^Режим с таким именем уже есть$/, before);
  assert.equal(inp().value, ' Каникулы ', 'введённое цело');

  inp().value = 'Лето';
  document.querySelector('#scr-settings [data-act="mode-add-empty"]').click();
  let s = r1Saved(window);
  const leto = s.modes.find(m => m.name === 'Лето');
  assert.ok(leto, 'режим заведён');
  assert.deepEqual(s.modes.map(m => m.name), ['Основной', 'Каникулы', 'Лето'], 'в конец списка');
  assert.equal(s.groups.filter(g => g.mode === leto.id).length, 0, 'пустой — без блоков');
  assert.deepEqual(s.modeLog, [], 'новый режим не выбран');
  assert.equal(form(), null, 'форма закрыта');
  assert.equal(r2Head(document).querySelector('.tname').textContent, 'Режим: Основной');
  let row = r2Rows(r2List(document)).find(r => r.querySelector('.tname').textContent === 'Лето');
  assert.equal(row.querySelector('.flash').textContent, 'Режим создан: «Лето»', 'подтверждение — у строки нового режима');
  assert.ok(row.querySelector('[data-act="mode-pick"]'), 'выбрать его — отдельным тапом');

  document.querySelector('#scr-settings [data-act="mode-add-open"]').click();
  inp().value = 'Осень';
  document.querySelector('#scr-settings [data-act="mode-add-copy"]').click();
  s = r1Saved(window);
  const autumn = s.modes.find(m => m.name === 'Осень');
  assert.deepEqual(s.groups.filter(g => g.mode === autumn.id).map(g => [g.name, g.caption]), [['Утро', '7:00'], ['Школа', 'до 15:15']],
    'копия — блоки выбранного режима с подписями');
  const copies = s.items.filter(i => i.mode === autumn.id);
  assert.deepEqual(copies.map(i => [i.name, i.group, i.addedAt]), [['Кровать', 'Утро', daysAgo(0)], ['Математика', 'Школа', daysAgo(0)]],
    'действия — новыми записями с сегодняшнего дня');
  assert.equal(s.items.filter(i => i.area === 'habit').length, 4, 'привычки и параметр не копируются');
  row = r2Rows(r2List(document)).find(r => r.querySelector('.tname').textContent === 'Осень');
  assert.equal(row.querySelector('.flash').textContent, 'Копия создана: «Осень»');

  // «Отмена» черновик отбрасывает
  document.querySelector('#scr-settings [data-act="mode-add-open"]').click();
  inp().value = 'ОТМЕНЁННОЕ';
  document.querySelector('#scr-settings [data-act="mode-add-cancel"]').click();
  document.querySelector('#scr-settings [data-act="mode-add-open"]').click();
  assert.equal(inp().value, '');

  // отказ хранилища — строкой, режим не заведён
  inp().value = 'Зима';
  before = window.localStorage.getItem(NS);
  withBrokenStorage(window, () => document.querySelector('#scr-settings [data-act="mode-add-empty"]').click());
  assert.equal(document.querySelector('#scr-settings .flash.keep').textContent, 'Не сохранено: хранилище недоступно');
  assert.equal(window.localStorage.getItem(NS), before);
  assert.equal(window.eval('store').modes.some(m => m.name === 'Зима'), false, 'откат в памяти');
});

test('Р2/2: «Переименовать» режим — форма, отказы строкой (пустое, занятое, в том числе убранным); «Сохранено» у строки; имя в шапке и на «Сегодня»', async () => {
  const seed = r2UiSeed();
  seed.modes.push({ id: 'old', name: 'Старый', removedAt: daysAgo(5) });
  const { document, window } = await boot({ seed });
  r2OpenModes(document);
  r2Btn(document, 'mode-rename-open', 'main').click();
  const form = document.querySelector('#scr-settings [data-form="mode-rename"]');
  assert.equal(form.dataset.id, 'main');
  assert.ok(form.closest('.mrow[aria-current="true"]'), 'форма — в строке своего режима');
  assert.equal(document.getElementById('m-name').value, 'Основной');
  assert.equal(r2Btn(document, 'mode-rename-open', 'main'), undefined, 'кнопка уступила место форме');

  const before = window.localStorage.getItem(NS);
  const save = () => document.querySelector('#scr-settings [data-act="mode-rename-save"]').click();
  document.getElementById('m-name').value = '   ';
  save();
  r1Refused(document, window, 'mode-rename-save', /^Название не заполнено$/, before);
  for (const taken of ['Каникулы', 'Старый']) {
    document.getElementById('m-name').value = taken;
    save();
    r1Refused(document, window, 'mode-rename-save', /^Режим с таким именем уже есть$/, before);
    assert.equal(document.getElementById('m-name').value, taken, 'введённое цело');
  }

  document.getElementById('m-name').value = ' Учёба ';
  save();
  assert.equal(r1Saved(window).modes[0].name, 'Учёба');
  assert.equal(document.querySelector('#scr-settings [data-form]'), null, 'форма закрыта');
  const row = r2Rows(r2List(document))[0];
  assert.equal(row.querySelector('.flash').textContent, 'Сохранено', 'подтверждение — у строки режима');
  assert.equal(r2Head(document).querySelector('.tname').textContent, 'Режим: Учёба');
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.equal(document.querySelector('#scr-today .hmode').textContent, 'режим Учёба');
});

test('Р2/2: «Убрать» режим — у выбранного нет; у невыбранного вторым тапом, последствие ПОД кнопкой; строка уходит к убранным, «Вернуть» возвращает', async () => {
  const { document, window } = await boot({ seed: r2UiSeed() });
  r2OpenModes(document);
  const rm = () => r2Btn(document, 'mode-remove', R2_KAN);
  const before = window.localStorage.getItem(NS);
  rm().click();
  assert.equal(rm().textContent, 'Подтвердить: убрать');
  assert.equal(window.localStorage.getItem(NS), before, 'первый тап только взводит');
  const box = rm().closest('.btns');
  assert.deepEqual([...box.children].map(x => x.dataset.act), ['mode-remove'], '«Убрать» — один в своём ряду');
  const what = box.nextElementSibling;
  assert.ok(what && what.matches('p.muted'), 'последствие — сразу ПОД кнопкой');
  assert.equal(what.textContent, 'Режим уйдёт из выбора. Прошлые дни и отметки останутся как есть.');

  // уход с экрана гасит взведённое
  document.querySelector('#tabs button[data-tab="today"]').click();
  r2OpenModes(document);
  assert.equal(rm().textContent, 'Убрать', 'подтверждение не пережило смены вкладки');
  // и свёртка списка тоже
  rm().click();
  r2Head(document).click();
  r2Head(document).click();
  assert.equal(rm().textContent, 'Убрать', 'и закрытия списка');

  rm().click();
  rm().click();
  const s = r1Saved(window);
  assert.equal(s.modes.find(m => m.id === R2_KAN).removedAt, daysAgo(0));
  assert.equal(s.groups.filter(g => g.mode === R2_KAN).length, 2, 'блоки режима на месте');
  assert.equal(s.items.filter(i => i.mode === R2_KAN && i.removedAt === null).length, 2, 'действия режима на месте');
  assert.deepEqual(r2Rows(r2List(document)).map(r => r.querySelector('.tname').textContent), ['Основной']);
  const back = r2Btn(document, 'mode-restore', R2_KAN);
  assert.ok(back && back.closest('.rowwrap.gone'), 'строка — среди убранных');
  assert.equal(document.activeElement, back, 'фокус — на «Вернуть»');
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.equal(document.querySelector('#scr-today .hmode'), null, 'живой режим один — имени на «Сегодня» нет');
  r1Settings(document);
  r1Btn(document, 'group-open', 'Утро').click();
  assert.equal(document.querySelector('#scr-settings [data-act="group-dup-to"]'), null, 'копировать некуда');
  document.querySelector('#scr-settings [data-act="group-cancel"]').click();

  r2OpenModes(document);
  r2Btn(document, 'mode-restore', R2_KAN).click();
  assert.equal(r1Saved(window).modes.find(m => m.id === R2_KAN).removedAt, null);
  const row = r2Rows(r2List(document)).find(r => r.querySelector('.tname').textContent === 'Каникулы');
  assert.equal(row.querySelector('.flash').textContent, 'Сохранено', 'подтверждение — у вернувшейся строки');
  assert.equal(document.querySelector('#scr-settings [data-act="mode-restore"]'), null);
});

test('Р2/2: имя режима на «Сегодня» — только при двух и более живых режимах, рядом с датой, приглушённо; слово владельца через esc', async () => {
  // один режим — разметки нет вовсе, шапка прежняя
  const one = await boot({ seed: r2UiSeed({ modes: [{ id: 'main', name: 'Основной', removedAt: null }] }) });
  const head1 = one.document.querySelector('#scr-today header.page');
  assert.deepEqual([...head1.children].map(n => n.className), ['overline', '', 'dline']);
  assert.equal(head1.querySelector('.hmode, .hdate'), null);

  // второй режим убран — живой один, разметки нет
  const gone = await boot({ seed: r2UiSeed({ modes: [{ id: 'main', name: 'Основной', removedAt: null }, { id: R2_KAN, name: 'Каникулы', removedAt: daysAgo(3) }] }) });
  assert.equal(gone.document.querySelector('#scr-today .hmode, #scr-today .hdate'), null);

  // два живых — имя выбранного рядом с датой; строка дня остаётся третьей
  const seed = r2UiSeed({
    modes: [{ id: 'main', name: 'Основной', removedAt: null }, { id: R2_KAN, name: '<b>Лето</b>', removedAt: null }],
    modeLog: [{ from: daysAgo(2), mode: R2_KAN }]
  });
  const { document } = await boot({ seed });
  const head = document.querySelector('#scr-today header.page');
  assert.deepEqual([...head.children].map(n => n.className), ['overline', 'hdate', 'dline'], 'день недели → дата с режимом → строка дня');
  const date = head.children[1];
  assert.equal(date.firstElementChild.tagName, 'H1', 'дата — прежний заголовок');
  assert.equal(date.firstElementChild.textContent, document.querySelector('#scr-today h1').textContent);
  const name = date.querySelector('.hmode');
  assert.equal(name.textContent, 'режим <b>Лето</b>');
  assert.equal(name.querySelector('b'), null, 'слово владельца экранировано');
  assert.equal(name.querySelector('.sr-only').textContent, 'режим ', '«режим» — только для чтения с экрана');
  assert.equal(document.querySelectorAll('.hmode').length, 1, 'только на «Сегодня»');
  for (const t of ['habits', 'progress', 'settings']) {
    document.querySelector(`#tabs button[data-tab="${t}"]`).click();
    assert.equal(document.querySelector(`#scr-${t} .hmode`), null, t);
  }
  const rule = ruleOf(CSS_SRC(), '.hmode');
  assert.match(rule, /font-size:\s*var\(--text-sm\)/, 'существующая ступень');
  assert.match(rule, /color:\s*var\(--muted\)/, 'приглушённо, существующим тоном');
});

test('Р2/2: «Дублировать блок» — вариант «в режим …» только при двух живых режимах; копия ложится в режим цели, подтверждение у шапки источника', async () => {
  const one = await boot({ seed: r2UiSeed({ modes: [{ id: 'main', name: 'Основной', removedAt: null }] }) });
  r1Settings(one.document);
  r1Btn(one.document, 'group-open', 'Школа').click();
  assert.ok(one.document.querySelector('#scr-settings [data-act="group-dup"]'));
  assert.equal(one.document.querySelector('#scr-settings [data-act="group-dup-to"]'), null, 'один режим — варианта нет');

  const seed = r2UiSeed();
  seed.modes.push({ id: 'old', name: 'Старый', removedAt: daysAgo(4) });
  const { document, window } = await boot({ seed });
  r1Settings(document);
  r1Btn(document, 'group-open', 'Школа').click();
  const to = [...document.querySelectorAll('#scr-settings [data-act="group-dup-to"]')];
  assert.deepEqual(to.map(b => [b.dataset.name, b.dataset.mode, b.textContent]), [['Школа', R2_KAN, 'в режим «Каникулы»']],
    'по кнопке на живой режим, кроме своего; убранного нет');
  assert.equal(to[0].getAttribute('aria-label'), 'дублировать блок «Школа» в режим «Каникулы»');
  assert.equal(to[0].closest('.btns'), r1Btn(document, 'group-dup', 'Школа').closest('.btns'), 'в ряду «Дублировать блок»');
  document.getElementById('g-cap').value = 'набрано, но не сохранено';

  to[0].click();
  let s = r1Saved(window);
  const copy = s.groups.filter(g => g.mode === R2_KAN);
  assert.deepEqual(copy.map(g => g.name), ['Утро', 'Лагерь', 'Школа'], 'в конец блоков режима цели, имя свободно — прежнее');
  assert.equal(copy[2].caption, 'до 15:15', 'копия — сохранённого блока');
  assert.deepEqual(s.items.filter(i => i.mode === R2_KAN && i.group === 'Школа').map(i => [i.name, i.addedAt]), [['Математика', daysAgo(0)]]);
  assert.equal(document.querySelector('#scr-settings [data-form]'), null, 'форма источника закрыта');
  assert.equal(window.eval('ui').formDraft['group:Школа'].fields['g-cap'], 'набрано, но не сохранено', 'набранное в ней — черновиком, как при переходе');
  const flash = r1Card(document, 'Школа').querySelector('.flash');
  assert.equal(flash.textContent, 'Копия создана в режиме «Каникулы»: «Школа»', 'подтверждение у шапки источника и называет режим');
  assert.deepEqual(r2Cards(document), ['Утро', 'Школа'], 'карточек выбранного режима не прибавилось');

  // занято в цели — «(копия)»
  r1Btn(document, 'group-open', 'Утро').click();
  r1Btn(document, 'group-dup-to', 'Утро').click();
  assert.equal(r1Card(document, 'Утро').querySelector('.flash').textContent, 'Копия создана в режиме «Каникулы»: «Утро (копия)»');

  r2Pick(document, R2_KAN);
  assert.deepEqual(r2Cards(document), ['Утро', 'Лагерь', 'Школа', 'Утро (копия)']);
  assert.match(r1Card(document, 'Школа').textContent, /Математика/);

  // устаревшая цель — не отказ, перерисовка; отказ записи — строкой
  r1Btn(document, 'group-open', 'Лагерь').click();
  const btn = r1Btn(document, 'group-dup-to', 'Лагерь');
  window.eval('store').modes[0].removedAt = daysAgo(0);
  const was = window.localStorage.getItem(NS);
  btn.click();
  assert.equal(window.localStorage.getItem(NS), was);
  assert.equal(document.querySelector('#scr-settings .flash.keep'), null);
  assert.equal(document.querySelector('#scr-settings [data-act="group-dup-to"]'), null, 'перерисовано: копировать больше некуда');
  window.eval('store').modes[0].removedAt = null;
  window.renderSettings();
  withBrokenStorage(window, () => r1Btn(document, 'group-dup-to', 'Лагерь').click());
  assert.equal(document.querySelector('#scr-settings .flash.keep').textContent, 'Не скопировано: хранилище недоступно');
  assert.equal(window.eval('store').groups.filter(g => g.name === 'Лагерь').length, 1, 'откат');
  s = r1Saved(window);
  assert.equal(s.groups.filter(g => g.name === 'Лагерь').length, 1);
});

test('Р2/2: секция «Привычки» — заголовки блоков выбранного режима, затем прочие имена; при смене режима привычки не пропадают и не переезжают', async () => {
  const { document, window } = await boot({ seed: r2UiSeed() });
  const layout = () => {
    const body = openSect(document, /Привычки/).querySelector('.sect-b');
    const out = [];
    let head = null;
    for (const n of body.children) {
      if (n.matches('h2')) break; // «Убранные» — ниже
      if (n.matches('.g-label')) head = n.textContent;
      if (n.matches('.list')) for (const b of n.querySelectorAll('[data-act="edit-open"]')) out.push([head, b.dataset.id]);
    }
    return out;
  };
  r1Settings(document);
  assert.deepEqual(layout(), [['Утро', 'h1'], ['Школа', 'ph'], ['Лагерь', 'h2'], ['Без блока', 'h3']],
    'основной: его «Утро» и «Школа», затем «Лагерь» из другого режима, без блока — последней');
  assert.ok([...openSect(document, /Привычки/).querySelectorAll('.g-label')].every(h => !h.querySelector('.g-cap')), 'заголовки без подписи');

  r2Pick(document, R2_KAN);
  assert.deepEqual(layout(), [['Утро', 'h1'], ['Лагерь', 'h2'], ['Школа', 'ph'], ['Без блока', 'h3']],
    'каникулы: порядок заголовков — выбранного режима; каждая привычка под тем же именем');

  // правка открывается со своим блоком, сохранение без правки его не сбрасывает
  byId(document, 'edit-open', 'ph').click();
  const sel = document.getElementById('e-group');
  assert.equal(sel.value, 'Школа', 'блок привычки не потерян');
  assert.match(sel.options[sel.selectedIndex].textContent, /^Школа \(нет в списке\)$/, 'в выборе — блоки выбранного режима');
  document.querySelector('#scr-settings [data-act="edit-save"]').click();
  assert.equal(r1Saved(window).items.find(i => i.id === 'ph').group, 'Школа');
  assert.equal(document.querySelector('#scr-settings .flash.keep'), null, 'без отказа');
});

test('Р2/2: «Убранные» привычек и счётчиков — по блокам ВСЕХ режимов; блок убран во всех — строки нет, и старт блок не оживляет', async () => {
  const since = addKey(curMonday(), -14);
  const D1 = daysAgo(5), D2 = daysAgo(3);
  const habit = (id, name, group, extra) => r1Action(id, name, since, group, R1_ALL, Object.assign({ area: 'habit', normPerWeek: 7 }, extra));
  const seed = r2UiSeed({
    groups: [r2Blk('Утро', 'main', '', { removedAt: D2 }), r2Blk('Школа', 'main', ''), r2Blk('Утро', R2_KAN, ''), r2Blk('Лагерь', R2_KAN, '', { removedAt: D2 })],
    items: [
      r1Action('m2', 'Математика', since, 'Школа', R1_ALL, { mode: 'main' }),
      // A: блок «Лагерь» есть только у «Каникул» и убран; привычка и счётчик убраны раньше
      habit('hA', 'Плавание', 'Лагерь', { removedAt: D1 }),
      Object.assign(r1Action('wA', 'Поход', since, 'Лагерь', R1_ALL, { type: 'weekly', goal: 2, removedAt: D1 }), { schedule: undefined }),
      // B: «Утро» убрано у основного, но живо у «Каникул»
      habit('hB', 'Чтение', 'Утро', { removedAt: D1 }),
      // C: имя, которого нет ни у одного блока
      habit('hC', 'Вода', 'Нигде', { removedAt: D1 })
    ]
  });
  let { document, window } = await boot({ seed });
  const goneHabits = () => [...openSect(document, /Привычки/).querySelectorAll('[data-act="item-restore"]')].map(b => b.dataset.id).sort();
  const goneSchedule = () => [...openSect(document, /Расписание/).querySelectorAll('.blocks .rowwrap.gone [data-act="item-restore"]')].map(b => b.dataset.id);
  r1Settings(document);
  assert.deepEqual(goneHabits(), ['hB', 'hC'], 'A — блок убран во всех режимах: строки нет; B — блок жив в другом; C — блока нет нигде');
  assert.deepEqual(goneSchedule(), [], 'счётчик «Лагеря» в «Убранных» основного режима не стоит');
  assert.equal(window.goneBesideBlock(window.eval('store').items.find(i => i.id === 'wA')), false);

  // B возвращается: блок «Утро» жив у «Каникул» — ничего не оживает
  byId(document, 'item-restore', 'hB').click();
  // возврат позже дня ухода — новая запись (инвариант 12)
  assert.equal(r1Saved(window).items.filter(i => i.name === 'Чтение' && i.removedAt === null).length, 1);
  ({ document, window } = await boot({ seed: r1Saved(window) })); // следующий старт — migrate
  const s = r1Saved(window);
  assert.equal(s.groups.find(g => g.name === 'Утро' && g.mode === 'main').removedAt, D2, 'старт убранное «Утро» основного не оживил');
  assert.equal(s.groups.find(g => g.name === 'Лагерь').removedAt, D2, 'и «Лагерь» тоже: живой ссылки на него нет');
  r1Settings(document);
  assert.deepEqual(goneHabits(), ['hC']);

  // дорога к A — возврат блока в его режиме: ушедшие в другой день снова встают в «Убранные»
  r2Pick(document, R2_KAN);
  const restore = [...document.querySelectorAll('#scr-settings .rowwrap.gone [data-act="group-restore"]')].find(b => b.dataset.name === 'Лагерь');
  assert.ok(restore, '«Лагерь» — в «Убранных» своего режима');
  restore.click();
  assert.deepEqual(goneHabits(), ['hA', 'hC'], 'блок вернулся — привычка «Лагеря» снова в «Убранных»');
  assert.deepEqual(goneSchedule(), ['wA'], 'и счётчик — в «Убранных» «Расписания»');
});

test('Р2/2: «Отметки» на «Прогрессе» — живые действия всех режимов; действие невыбранного режима нигде не печатает «ни одного дня»', async () => {
  const { document, window } = await boot({ seed: r2UiSeed({ days: { [daysAgo(1)]: { m1: true } } }) });
  const marks = () => {
    document.querySelector('#tabs button[data-tab="progress"]').click();
    const card = [...document.querySelectorAll('#scr-progress .pcard')].find(c => c.querySelector('h2').textContent === 'Отметки');
    return [...card.querySelectorAll('.line')].map(p => p.textContent.split(' · ')[0]);
  };
  const NONE = /ни одного дня|ни в один день/;
  const scanAll = what => {
    for (const t of ['today', 'habits', 'progress', 'settings']) {
      document.querySelector(`#tabs button[data-tab="${t}"]`).click();
      assert.doesNotMatch(document.getElementById('scr-' + t).textContent, NONE, `${what}: ${t}`);
    }
    for (const d of document.querySelectorAll('#scr-settings details.sect')) d.open = true;
    const ids = [...document.querySelectorAll('#scr-settings .bcard [data-act="edit-open"]')].map(b => b.dataset.id);
    assert.ok(ids.length >= 2, 'строки действий в карточках');
    for (const id of ids) {
      byId(document, 'edit-open', id).click();
      assert.doesNotMatch(document.getElementById('scr-settings').textContent, NONE, `${what}: форма ${id}`);
    }
  };
  assert.deepEqual(marks().slice(0, 4).sort(), ['Зарядка', 'Костёр', 'Кровать', 'Математика'], 'действия обоих режимов');
  scanAll('основной');
  r2Pick(document, R2_KAN);
  scanAll('каникулы');
  assert.deepEqual(marks().slice(0, 4).sort(), ['Зарядка', 'Костёр', 'Кровать', 'Математика'], 'после смены режима — те же');
  assert.equal(window.eval('store').items.filter(i => i.area === 'min').length, 4);
});

test('Р2/2: смена логического дня, принёсшая другой режим, снимает формы, черновики и свёртки «Настроек»', async () => {
  // отрезок «с завтрашнего дня» приносит только импорт
  const { document, window } = await boot({ seed: r2UiSeed({ modeLog: [{ from: daysAgo(-1), mode: R2_KAN }] }) });
  r1Settings(document);
  assert.equal(r2Head(document).querySelector('.tname').textContent, 'Режим: Основной');
  r1Btn(document, 'group-fold', 'Школа').click();
  r1Btn(document, 'group-open', 'Утро').click();
  document.getElementById('g-name').value = 'ЧЕРНОВИК';
  window.renderSettings();
  assert.ok(window.eval('ui').formDraft['group:Утро']);
  shiftWindowDays(window, 1);
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(r2Head(document).querySelector('.tname').textContent, 'Режим: Каникулы');
  assert.equal(document.querySelector('#scr-settings [data-form]'), null, 'форма чужого «Утра» не открыта');
  assert.deepEqual(Object.keys(window.eval('ui').formDraft), []);
  assert.deepEqual(Object.keys(window.eval('ui').blockFold), []);
  r1Btn(document, 'group-open', 'Утро').click();
  assert.equal(document.getElementById('g-name').value, 'Утро');

  // тот же режим сменой дня — ничего не снимается
  const same = await boot({ seed: r2UiSeed() });
  r1Settings(same.document);
  r1Btn(same.document, 'group-fold', 'Школа').click();
  shiftWindowDays(same.window, 1);
  same.document.dispatchEvent(new same.window.Event('visibilitychange'));
  assert.deepEqual(Object.keys(same.window.eval('ui').blockFold), ['Школа'], 'режим не сменился — свёртка на месте');
});

test('Р2/2: отметка на «Сегодня» при двух режимах — экран после точечного пути равен перерисованному', async () => {
  const seed = r2UiSeed({ modeLog: [{ from: daysAgo(3), mode: R2_KAN }] });
  seed.items.push(Object.assign(r1Action('kw', 'Спорт', seed.settings.calendarSince, '', R1_ALL, { type: 'weekly', goal: 3 }), { schedule: undefined }));
  seed.days[daysAgo(1)] = { k1: true };
  seed.days[daysAgo(5)] = { m1: true };
  const { document, window } = await boot({ seed });
  assert.deepEqual(r2Today(document), ['k1', 'k2'], 'действия режима этого дня');
  assert.ok(document.querySelector('#scr-today .hmode'), 'имя режима в шапке');
  assert.ok(document.querySelector('#scr-today .weekcount'), 'и глобальный счётчик');
  const box = id => document.querySelector(`#scr-today input[data-act="mark"][data-id="${id}"]`);
  box('k1').click();
  // «Утро» режима из одного действия выполнено и сворачивается: сторож ждёт
  // конца схлопывания и сравнивает после него (задача Р2, п. 4)
  await settle();
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'первая отметка');
  box('k2').click();
  await wait(T.DAY_CLOSE_MS + T.MOTION_TAIL_MS + 40);
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'день закрыт');
  unfoldBlock(document, 'Лагерь');
  box('k2').click();
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'снятие отметки');
});

test('Р2/2: «Без блока» и «Убранные» «Расписания» — действия выбранного режима; глобальный счётчик — в обоих', async () => {
  const since = addKey(curMonday(), -14);
  const act = (id, name, group, mode, extra) => r1Action(id, name, since, group, R1_ALL, Object.assign({ mode }, extra || {}));
  const seed = r2UiSeed({
    items: [
      act('m1', 'Кровать', 'Утро', 'main'), act('mL', 'Вне блока осн', '', 'main'),
      act('mG', 'Ушедшее осн', 'Утро', 'main', { removedAt: daysAgo(2) }),
      act('k1', 'Зарядка', 'Утро', R2_KAN), act('kL', 'Вне блока кан', '', R2_KAN),
      act('kG', 'Ушедшее кан', 'Лагерь', R2_KAN, { removedAt: daysAgo(2) }),
      Object.assign(r1Action('w', 'Спорт', since, '', R1_ALL, { type: 'weekly', goal: 3 }), { schedule: undefined })
    ]
  });
  seed.groups[1].removedAt = daysAgo(1); // «Школа» основного убрана
  const { document } = await boot({ seed });
  const loose = () => [...document.querySelectorAll('#scr-settings .bcard.loose [data-act="edit-open"]')].map(b => b.dataset.id);
  const gone = () => [...document.querySelectorAll('#scr-settings .blocks .rowwrap.gone [data-act]')].map(b => b.dataset.id || b.dataset.name);
  r1Settings(document);
  assert.deepEqual(loose(), ['mL', 'w'], 'основной: своё действие без блока и глобальный счётчик');
  assert.deepEqual(gone(), ['Школа', 'mG'], 'основной: свой убранный блок, затем своё убранное действие');
  r2Pick(document, R2_KAN);
  assert.deepEqual(loose(), ['kL', 'w'], 'каникулы: своё и тот же счётчик');
  assert.deepEqual(gone(), ['kG'], 'каникулы: только своё убранное');
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.ok(document.querySelector('#scr-today .weekcount'), 'счётчик на «Сегодня» — при любом режиме');
});

test('Р2/2: закрытие списка режимов закрывает его форму снимком — набранное возвращается с формой, призрака нет', async () => {
  const { document, window } = await boot({ seed: r2UiSeed() });
  r2OpenModes(document);
  document.querySelector('#scr-settings [data-act="mode-add-open"]').click();
  document.getElementById('m-add').value = 'Лето';
  r2Head(document).click();
  assert.equal(r2List(document).hidden, true);
  assert.equal(document.querySelector('#scr-settings [data-form]'), null, 'скрытой открытой формы нет');
  assert.equal(window.eval('currentFormKey')(), null, 'и ключа черновика у неё нет');
  r1Btn(document, 'group-open', 'Утро').click(); // соседняя форма не тронула черновик режима
  document.querySelector('#scr-settings [data-act="group-cancel"]').click();
  r2OpenModes(document);
  document.querySelector('#scr-settings [data-act="mode-add-open"]').click();
  assert.equal(document.getElementById('m-add').value, 'Лето', 'черновик «Нового режима» цел');
  // и переименование — тем же правилом, ключ по id режима
  r2Btn(document, 'mode-rename-open', R2_KAN).click();
  assert.equal(window.eval('currentFormKey')(), 'mode:' + R2_KAN);
  document.getElementById('m-name').value = 'Отпуск';
  r2Head(document).click();
  r2OpenModes(document);
  r2Btn(document, 'mode-rename-open', R2_KAN).click();
  assert.equal(document.getElementById('m-name').value, 'Отпуск');
  assert.equal(r1Saved(window).modes[1].name, 'Каникулы', 'ничего не записано');
});

/* ══ Задача Р2, этап 4: «Не сегодня» на «Сегодня» и в разборе ═════
   Пропуск — false в days{}: строка остаётся на месте, зачёркнута и
   приглушена, круг неактивен; знаменатель дня — без пропущенных. Кнопка
   «Не сегодня» / «Вернуть» стоит в разметке строки всегда, свайп её только
   выдвигает. Сид — pointSeed: «Зарядка» и «Английский» в блоке «Утро». */

const r2Row = (document, id) =>
  document.querySelector(`#scr-today input[data-act="mark"][data-id="${id}"]`).closest('.rowwrap');
const r2SkipBtn = (document, id) => r2Row(document, id).querySelector('.skipbtn');
const r2Note = document => document.querySelector('#scr-today .bar-note').textContent.replace(/\s+/g, ' ').trim();
const r2Scene = () => wait(T.DAY_CLOSE_MS + T.MOTION_TAIL_MS + 40);

test('Р2/3: «Не сегодня» и «Вернуть» — строка на месте, зачёркнута, круг неактивен; «N из M» и планка по знаменателю без пропущенных; точечный путь = перерисовка', async () => {
  const { document, window } = await boot({ seed: pointSeed() });
  const scr = () => document.getElementById('scr-today');
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  const t = daysAgo(0);
  const inp = id => scr().querySelector(`input[data-act="mark"][data-id="${id}"]`);
  const btn = id => r2SkipBtn(document, id);

  // кнопка в разметке строки всегда: у неотмеченной — «Не сегодня», с именем действия
  assert.ok(r2Row(document, 'p-a').classList.contains('swipe'), 'строка действия сдвигается свайпом');
  assert.equal(btn('p-a').dataset.act, 'skip');
  assert.equal(btn('p-a').textContent, 'Не сегодня');
  assert.equal(btn('p-a').getAttribute('aria-label'), 'не сегодня: «Зарядка»');
  assert.equal(btn('p-a').type, 'button');
  assert.equal(btn('p-a').hidden, false);
  assert.ok(btn('p-a').classList.contains('btn'), 'тач-цель ≥ 44 px с откликом — общий .btn');
  // у привычек — ни жеста, ни кнопки: пропуск принадлежит только действиям минимума
  document.querySelector('#tabs button[data-tab="habits"]').click();
  assert.equal(document.querySelector('#scr-habits .skipbtn'), null);
  assert.equal(document.querySelector('#scr-habits .rowwrap.swipe'), null);
  document.querySelector('#tabs button[data-tab="today"]').click();

  assert.equal(r2Note(document), '0 из 2');
  btn('p-a').click();
  assert.equal(saved().days[t]['p-a'], false, 'записан пропуск, а не отметка');
  assert.ok(r2Row(document, 'p-a').classList.contains('skip'), 'строка на месте, помечена пропуском');
  assert.equal(inp('p-a').disabled, true, 'круг неактивен');
  assert.equal(inp('p-a').checked, false);
  assert.equal(inp('p-a').closest('label.check').classList.contains('on'), false, 'и не «on»');
  assert.equal(btn('p-a').dataset.act, 'unskip');
  assert.equal(btn('p-a').textContent, 'Вернуть');
  assert.equal(btn('p-a').getAttribute('aria-label'), 'вернуть: «Зарядка»');
  // хвост «· пропусков K» — задача Р3, п. 0.5: знаменатель тот же, пропуск назван числом
  assert.equal(r2Note(document), '0 из 1 · пропусков 1', 'пропущенное выпало из знаменателя');
  assert.equal(scr().querySelector('.bar i').style.width, '0%');
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'пропуск');

  // тап по строке пропущенного отметкой не становится
  inp('p-a').closest('label.check').click();
  assert.equal(saved().days[t]['p-a'], false, 'label пропущенного круг не переключает');

  // отметка второго закрывает день — знаменатель уже без пропущенного
  inp('p-b').click();
  assert.equal(r2Note(document), 'День закрыт');
  assert.equal(scr().querySelector('.bar i').style.width, '100%');
  assert.equal(btn('p-b').hidden, true, 'у отмеченной «Не сегодня» не предлагается');
  assert.ok(scr().querySelector('label.check.closing'), 'закрыто отметкой — сцена с кольцом, как прежде');
  await r2Scene();
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'день закрыт при пропуске');

  // «Вернуть»: знаменатель растёт, день снова открыт, сцены нет. Блок после
  // сцены свёрнут (задача Р2, п. 4) — «Вернуть» стоит в его строках
  unfoldBlock(document, 'Утро');
  btn('p-a').click();
  assert.equal(saved().days[t]['p-a'], undefined, 'пропуск снят');
  assert.equal(r2Row(document, 'p-a').classList.contains('skip'), false);
  assert.equal(inp('p-a').disabled, false);
  assert.equal(r2Note(document), '1 из 2');
  assert.equal(scr().querySelector('.closing'), null, '«Вернуть» сцены не играет');
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'возврат');

  // день закрывается ПРОПУСКОМ последнего неотмеченного — сцена играет, кольца нет
  btn('p-a').click();
  assert.equal(r2Note(document), 'День закрыт');
  assert.ok(scr().querySelector('.dayline.closing'), 'планка и фраза — отклик на действие, закрывшее день');
  assert.equal(scr().querySelector('label.check.closing'), null, 'кольца от неактивного круга нет');
  await r2Scene();
  assert.equal(scr().querySelector('.closing'), null, 'след сцены снят');
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'день закрыт пропуском');

  // всё пропущено: «0 из 0», не закрыт, сцены нет — а строки на месте
  unfoldBlock(document, 'Утро'); // закрытый пропуском день свернул блок (Р2, п. 4)
  inp('p-b').click(); // снять отметку
  btn('p-b').click();
  assert.equal(r2Note(document), '0 из 0 · пропусков 2'); // хвост — задача Р3, п. 0.5
  assert.equal(scr().querySelector('.bar i').style.width, '0%');
  assert.equal(scr().querySelector('.bar-note').classList.contains('ok'), false, 'всё пропущено — не «День закрыт»');
  assert.equal(scr().querySelector('.closing'), null, 'и сцены нет');
  // Блок, где всё пропущено, решён и сворачивается (задача Р2, п. 4) — но
  // строки не пропали: вернуть можно только из них, и они в его развёртке
  await settle();
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'всё пропущено');
  unfoldBlock(document, 'Утро');
  assert.equal(scr().querySelectorAll('.rowwrap.skip').length, 2, 'строки не пропали: вернуть можно только из них');
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'всё пропущено, блок развёрнут');

  // «Прогресс»: полоса дня тем же правилом — план есть, знаменатель пуст
  document.querySelector('#tabs button[data-tab="progress"]').click();
  assert.equal(document.querySelector('#scr-progress .dbar-note').textContent, '0 из 0 сегодня');
  assert.ok(document.querySelector('#scr-progress .dbar'), 'полоса есть: делать было что');
});

test('Р2/3: клавиатурный путь — кнопка достижима Tab, фокус выдвигает её; после тапа фокус на той же кнопке, уже «Вернуть»', async () => {
  const { document, window } = await boot({ seed: pointSeed() });
  const b = r2SkipBtn(document, 'p-b');
  assert.equal(b.hasAttribute('tabindex'), false, 'в порядке Tab, без tabindex -1');
  assert.equal(b.disabled, false);
  b.focus();
  assert.equal(document.activeElement, b);
  b.click(); // Enter и пробел на кнопке — это click
  assert.equal(document.activeElement, b, 'узел не пересоздан — фокус на месте');
  assert.equal(b.textContent, 'Вернуть');
  assert.equal(b.isConnected, true);
  b.click();
  assert.equal(document.activeElement, b);
  assert.equal(b.textContent, 'Не сегодня');
  assert.equal(JSON.parse(window.localStorage.getItem(NS)).days[daysAgo(0)], undefined);
  // фокус выдвигает кнопку сам: сдвиг строки по :focus-visible, и без :has — поверх строки
  const css = CSS_SRC();
  assert.match(css, /\.rowwrap\.swipe:has\(> \.skipbtn:focus-visible\)\s*\{\s*--sx:/);
  assert.match(css, /\.rowwrap\.swipe:has\(> \.skipbtn:focus-visible\)::before,/, 'и подложка под сдвинутой строкой');
  const focus = ruleOf(css, '.skipbtn:focus-visible');
  assert.match(focus, /opacity:\s*1/, 'в покое прозрачная кнопка при фокусе видна');
  assert.match(focus, /z-index:\s*3/);
  // прозрачность, а не visibility: скрытая visibility кнопка фокус не получила бы
  assert.doesNotMatch(ruleOf(css, '.skipbtn'), /visibility/);
});

test('Р2/3: свайп — захват при |dx| > 8 и |dx| > |dy|, иначе скролл; порог 40 % ширины; незавершённый возвращает строку; клик после жеста не отмечает', async () => {
  const { document, window } = await boot({ seed: pointSeed() });
  const scr = document.getElementById('scr-today');
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  const t = daysAgo(0);
  const row = id => r2Row(document, id);
  const label = id => row(id).querySelector('label.check');
  // геометрия строки в jsdom нулевая — ширина 335 px, как на 375 px экрана
  const down = (id, x, y) => {
    row(id).getBoundingClientRect = () => ({ top: 200, bottom: 256, height: 56, left: 20, right: 355, width: 335, x: 20, y: 200 });
    label(id).querySelector('.tname').dispatchEvent(pointer(window, 'pointerdown', x, y));
  };
  const move = (x, y) => document.dispatchEvent(pointer(window, 'pointermove', x, y));
  const up = (x, y) => document.dispatchEvent(pointer(window, 'pointerup', x, y));
  const sx = id => row(id).style.getPropertyValue('--sx');
  const is = (id, cls) => row(id).classList.contains(cls);

  // в мёртвой зоне жест не решён; вертикаль сильнее — это скролл, строка отпущена
  down('p-a', 300, 230);
  move(294, 234);
  assert.equal(is('p-a', 'swiping'), false, 'в пределах 8 px — не решено');
  move(280, 262);
  assert.equal(is('p-a', 'swiping'), false, '|dy| > |dx| — скролл');
  move(100, 262);
  assert.equal(sx('p-a'), '', 'решённый скролл горизонталью строку уже не двигает');
  up(100, 262);
  assert.equal(row('p-a').hasAttribute('style'), false);

  // вбок сильнее — захват: строка идёт за пальцем без перехода и только влево
  down('p-a', 300, 230);
  move(290, 232);
  assert.ok(is('p-a', 'swiping'), '|dx| > 8 и |dx| > |dy| — захват');
  assert.equal(sx('p-a'), '-10px');
  move(360, 232);
  assert.equal(sx('p-a'), '0px', 'вправо дальше покоя строка не едет');
  move(170, 236);
  assert.equal(sx('p-a'), '-130px');
  up(170, 236); // 130 < 134 = 40 % от 335
  assert.equal(is('p-a', 'open'), false, 'меньше порога — строка вернулась');
  assert.equal(is('p-a', 'swiping'), false);
  assert.equal(row('p-a').hasAttribute('style'), false, 'и следа сдвига не осталось');
  label('p-a').click(); // клик, рождённый жестом
  assert.equal(saved().days[t], undefined, 'клик после свайпа отметку не переключил');
  assert.equal(scr.querySelector('input[data-id="p-a"]').checked, false);

  // за порогом — строка остаётся открытой
  down('p-a', 300, 230);
  move(290, 231);
  move(160, 233); // 140 ≥ 134
  up(160, 233);
  assert.ok(is('p-a', 'open'), 'кнопка выдвинута');
  assert.equal(row('p-a').hasAttribute('style'), false, 'положение открытой строки даёт класс, а не инлайн');
  label('p-a').click();
  assert.equal(saved().days[t], undefined);
  // касание содержимого открытой строки закрывает её, а не отмечает
  label('p-a').querySelector('.tname').dispatchEvent(pointer(window, 'pointerdown', 100, 230));
  up(100, 230);
  assert.equal(is('p-a', 'open'), false);
  label('p-a').click();
  assert.equal(saved().days[t], undefined, 'тап по открытой строке — «закрыть»');

  // открыть и нажать «Не сегодня»: касание самой кнопки строку не закрывает
  down('p-a', 300, 230); move(290, 231); move(150, 231); up(150, 231);
  const b = row('p-a').querySelector('.skipbtn');
  b.dispatchEvent(pointer(window, 'pointerdown', 330, 230));
  assert.ok(is('p-a', 'open'), 'касание кнопки открытую строку не закрывает');
  up(330, 230);
  b.click();
  assert.equal(saved().days[t]['p-a'], false, 'тап по выдвинутой кнопке — пропуск');
  assert.equal(is('p-a', 'open'), false, 'после пропуска строка стоит на месте');
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'пропуск жестом');

  // пропущенная строка выдвигает «Вернуть»; касание вне строки закрывает её
  down('p-a', 300, 230); move(290, 231); move(150, 231); up(150, 231);
  assert.ok(is('p-a', 'open'));
  assert.equal(row('p-a').querySelector('.skipbtn').textContent, 'Вернуть');
  scr.querySelector('h1').dispatchEvent(pointer(window, 'pointerdown', 50, 40));
  up(50, 40);
  assert.equal(is('p-a', 'open'), false);

  // pointercancel — браузер забрал жест себе: строка возвращается
  down('p-b', 300, 290); move(290, 291); move(150, 291);
  document.dispatchEvent(pointer(window, 'pointercancel', 150, 291));
  assert.equal(is('p-b', 'open'), false);
  assert.equal(row('p-b').hasAttribute('style'), false);
  assert.equal(saved().days[t]['p-b'], undefined);

  // у отмеченной строки жеста нет
  scr.querySelector('input[data-id="p-b"]').click();
  await r2Scene(); // день закрылся отметкой
  unfoldBlock(document, 'Утро'); // и блок свернулся — строки возвращает развёртка (Р2, п. 4)
  down('p-b', 300, 290); move(280, 291); move(100, 291);
  assert.equal(is('p-b', 'swiping'), false, 'отмеченной «Не сегодня» не предлагается и жестом');
  up(100, 291);
  assert.equal(is('p-b', 'open'), false);
  assert.equal(row('p-b').hasAttribute('style'), false);

  // тот же жест мышью: обработчики не различают pointerType — событие мыши
  // (а в jsdom событие указателя и есть MouseEvent) проходит тем же путём
  assert.doesNotMatch(APP, /pointerType/, 'ни одной ветки по типу указателя');
  // и перетаскивание «Настроек» не задето: там строк со свайпом нет
  document.querySelector('#tabs button[data-tab="settings"]').click();
  assert.equal(document.querySelector('#scr-settings .rowwrap.swipe'), null);
});

test('Р2/3: сетка разбора — ячейка пропуска с чертой, «пропусков K» рядом с «запланировано D дней», sr «отмечено n из D, пропусков K»; пропуск вне плана не считается', async () => {
  const seed = r1ReviewSeed();
  const prev = prevMonday();
  const put = (i, id) => { const k = addKey(prev, i); (seed.days[k] || (seed.days[k] = {}))[id] = false; };
  put(4, 'it1'); // пятница у ежедневного
  put(3, 'hw');  // четверг у будничного
  put(5, 'sw');  // суббота у «Бассейна» (пн, ср, пт) — вне плана
  const { document } = await boot({ seed });
  openReview(document);
  const [minGrid] = document.getElementById('scr-review').querySelectorAll('.grid');
  const skipCells = name => [...minGrid.querySelectorAll('.g-name')].find(x => x.firstChild.textContent === name)
    .nextElementSibling.querySelectorAll('i.skip');

  const daily = r1GridRow(minGrid, 'Тестовый пункт');
  assert.equal(daily.plan.textContent, 'пропусков 1', 'при семи днях — одна подпись о пропусках');
  assert.equal(daily.plan.getAttribute('aria-hidden'), 'true');
  assert.equal(daily.sr, ', отмечено 2 из 7, пропусков 1: пятница', 'пропуск в знаменатель не входит и недобором не зовётся; день назван');
  assert.equal(daily.on, 2);
  assert.equal(skipCells('Тестовый пункт').length, 1, 'своя ячейка');
  assert.equal(skipCells('Тестовый пункт')[0].classList.contains('on'), false);

  const hw = r1GridRow(minGrid, 'Домашка');
  assert.equal(hw.plan.textContent, 'запланировано 5 дней · пропусков 1', 'рядом с «запланировано D дней»');
  assert.equal(hw.sr, ', отмечено 3 из 5, пропусков 1: четверг');

  const sw = r1GridRow(minGrid, 'Бассейн');
  assert.equal(sw.plan.textContent, 'запланировано 3 дня', 'пропуск вне плана «пропусков» не даёт');
  assert.equal(sw.sr, ', отмечено 1 из 3');
  assert.equal(skipCells('Бассейн').length, 1, 'а круг показывает факт, как и отметку вне плана');

  const call = r1GridRow(minGrid, 'Звонок');
  assert.equal(call.plan.textContent, 'запланировано 1 день', 'без пропусков — строка прежняя');
  assert.equal(skipCells('Звонок').length, 0);

  // форма ячейки: круг с чертой, только токены — различим не одним цветом
  const css = CSS_SRC();
  const cell = ruleOf(css, '.grid i.skip');
  const bar = ruleOf(css, '.grid i.skip::after');
  assert.ok(cell && bar, 'правила ячейки пропуска');
  assert.match(bar, /content:\s*""/, 'черта — отдельная фигура');
  for (const body of [cell, bar]) {
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'только токены');
    assert.match(body, /var\(--control-border\)/);
  }
});

test('Р2/3: CSS свайпа и пропуска — transform в окне движения без задержки, pan-y, под пальцем без перехода; пропущенная строка — зачёркивание и пунктир существующими токенами', () => {
  const css = CSS_SRC();
  const body = (/\.rowwrap\.swipe::before,\s*\.rowwrap\.swipe > :not\(\.skipbtn\)\s*\{([^}]*)\}/.exec(css) || [])[1];
  assert.ok(body, 'правило сдвига строки');
  const swipeTrans = declValues(body, 'transition').flatMap(motionParts);
  assert.equal(swipeTrans.length, 1, 'переход доезда строки один — только transform');
  const [p] = swipeTrans;
  assert.ok(p.dur >= 180 && p.dur <= 260, 'в окне движения: ' + p.dur);
  assert.equal(p.delay, 0, 'без задержки: раскадровка разрешена только сцене закрытия дня');
  assert.match(css, /\.rowwrap\.swipe::before,\s*\.rowwrap\.swipe > :not\(\.skipbtn\)\s*\{\s*transform: translateX\(var\(--sx\)\);\s*transition: transform \.22s ease-in;/,
    'двигается только transform — ни ширины, ни отступов, ни left; возврат — уход кнопки, ease-in');
  assert.match(css, /\.rowwrap\.swipe:has\(> \.skipbtn:focus-visible\) > :not\(\.skipbtn\)\s*\{\s*transition-timing-function: ease-out;/,
    'выезд — появление, ease-out');
  assert.match(css, /\.rowwrap\.swipe\.open > :not\(\.skipbtn\),/);
  assert.match(ruleOf(css, '.rowwrap.swipe'), /touch-action:\s*pan-y/, 'вертикальный скролл страницы — браузеру');
  assert.match(css, /\.rowwrap\.swipe\.swiping::before,\s*\.rowwrap\.swipe\.swiping > :not\(\.skipbtn\)\s*\{\s*transition: none;/,
    'под пальцем строка идёт без перехода');
  assert.match(css, /\.rowwrap\.swipe\.open,/, 'открытое положение — классом');
  // в покое кнопка не видна и касаний не ловит: промах в зазор строки пропуском не становится
  assert.match(ruleOf(css, '.skipbtn'), /opacity:\s*0;[\s\S]*pointer-events:\s*none/);
  assert.match(css, /\n\.rowwrap\.swipe\.open > \.skipbtn\s*\{\s*pointer-events:\s*auto;\s*\}/, 'нажимается только выдвинутая');
  // подложки в покое нет: кольцо сцены закрытия дня выходит за край строки и не срезается соседней
  assert.match(ruleOf(css, '.rowwrap.swipe::before'), /opacity:\s*0/);
  assert.match(ruleOf(css, '.skipbtn[hidden]'), /display:\s*none/, 'у отмеченной кнопка скрыта явно');
  assert.doesNotMatch(ruleOf(css, '.skipbtn'), /min-height|height:/, 'высоту тач-цели держит .btn (44 px)');
  assert.equal(px(ruleOf(css, '.btn'), 'min-height'), 44);

  const name = ruleOf(css, '.rowwrap.skip .tname');
  assert.match(name, /text-decoration:\s*line-through/, 'зачёркнута — не только цветом');
  assert.match(name, /color:\s*var\(--muted\)/, 'приглушена существующим токеном');
  const box = ruleOf(css, '.rowwrap.skip .check .box');
  assert.match(box, /border-style:\s*dashed/, 'круг неактивен — пунктир');
  for (const body of [name, box, ruleOf(css, '.rowwrap.swipe::before')]) {
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'сырых цветов нет');
  }
  assert.doesNotMatch(css.slice(css.indexOf('.rowwrap.swipe {'), css.indexOf('.rowwrap.skip .tname')), /gradient/, 'нового градиента нет');
  // reduced-motion: глобальный блок гасит и этот переход — конечное положение мгновенно
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(rm, /transition: none !important/);
});

test('Р2/3: кнопка пропуска — в списке тач-целей с откликом на нажатие, в обоих состояниях', async () => {
  const { document } = await boot({ seed: pointSeed() });
  const css = CSS_SRC();
  r2SkipBtn(document, 'p-a').click(); // «Вернуть»
  const btns = [...document.querySelectorAll('#scr-today .skipbtn')];
  assert.deepEqual(btns.map(b => b.dataset.act).sort(), ['skip', 'unskip']);
  for (const b of btns) {
    const hit = TAPPABLE.find(s => b.matches(s));
    assert.ok(hit, 'кнопка — тач-цель из списка: ' + b.dataset.act);
    assert.match(css, new RegExp(hit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':active'), 'и у неё есть состояние нажатия');
  }
});

/* ── Свёртка выполненного блока «Сегодня» (задача Р2, п. 4) ─────
   Блок, где каждое запланированное на сегодня действие отмечено или
   пропущено, стоит одной строкой. Свёрнутость — состояние (печатает рендер),
   движение — только отклик на отметку или пропуск, сделавшие блок
   выполненным. Сцена закрытия дня главнее. */

/* «Утро» (7:00) из двух действий — свёртка через .chain; «Вечер» из одного —
   через саму строку; «Прогулка» без блока; привычка «Чтение» в «Утре».
   Маски ежедневные: от дня недели прогона не зависит. */
function r2FoldSeed(days) {
  const since = addKey(curMonday(), -14);
  const s = r1Store(
    [r1Block('Утро', '7:00'), r1Block('Вечер', 'до 22:30')],
    [
      r1Action('u1', 'Кровать', since, 'Утро', R1_ALL), r1Action('u2', 'Шторы', since, 'Утро', R1_ALL),
      r1Action('v1', 'Душ', since, 'Вечер', R1_ALL), r1Action('l1', 'Прогулка', since, '', R1_ALL),
      r1Action('h1', 'Чтение', since, 'Утро', R1_ALL, { area: 'habit', normPerWeek: 7 })
    ],
    days ? { [daysAgo(0)]: days } : {});
  s.settings.calendarSince = since;
  return s;
}
const r2Fold = (document, name) =>
  [...document.querySelectorAll('#scr-today [data-act="block-unfold"]')].find(b => b.dataset.name === name) || null;
const r2Text = n => n.textContent.replace(/\s+/g, ' ').trim();
const r2Box = (document, id) => document.querySelector(`#scr-today input[data-act="mark"][data-id="${id}"]`);
const r2ReducedMotion = window => {
  window.matchMedia = q => ({ matches: /reduced-motion/.test(q), media: q,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
};

test('Р2/4: последняя отметка блока — строки схлопываются классом-триггером, затем одна строка «✓ N из N»: имя, подпись, кнопка с aria-expanded и именем для AT', async () => {
  const { document, window } = await boot({ seed: r2FoldSeed() });
  const scr = document.getElementById('scr-today');
  const disk = () => window.localStorage.getItem(NS);
  assert.equal(r2Fold(document, 'Утро'), null, 'невыполненный блок не свёрнут');

  r2Box(document, 'u1').click();
  assert.equal(scr.querySelector('.folding'), null, 'не последняя отметка — ничего не схлопывается');
  await settle();
  assert.equal(r2Fold(document, 'Утро'), null);

  r2Box(document, 'u2').click();
  const rows = scr.querySelector('.list > .chain.folding');
  assert.ok(rows, 'строки блока получили класс-триггер');
  assert.equal(rows.style.maxHeight, '0px', 'схлопывание по высоте');
  assert.ok(rows.contains(r2Box(document, 'u2')), 'схлопываются строки именно этого блока');
  assert.equal(scr.querySelectorAll('.folding').length, 1, 'одного блока');
  assert.equal(rows.previousElementSibling.className, 'g-label', 'заголовок не схлопывается — на его место встанет строка');
  assert.equal(scr.querySelector('.closing'), null, 'день не закрыт — сцены нет');
  assert.equal(r2Fold(document, 'Утро'), null, 'свёрнутая строка появляется перерисовкой после схлопывания');
  assert.equal(r2Note(document), '2 из 4', 'планка — точечно, как всегда');
  const stored = disk();

  await settle();
  const b = r2Fold(document, 'Утро');
  assert.ok(b, 'блок свёрнут');
  assert.equal(scr.querySelector('.folding'), null, 'класс-триггер ушёл вместе с узлом');
  assert.equal(r2Box(document, 'u1'), null, 'строк блока нет');
  assert.equal(scr.querySelector('.list').firstElementChild, b, 'строка стоит там, где стоял заголовок');
  assert.equal(b.tagName, 'BUTTON');
  assert.equal(b.type, 'button');
  assert.equal(b.getAttribute('aria-expanded'), 'false');
  assert.equal(b.hasAttribute('aria-controls'), false, 'строк блока в DOM нет — указывать не на что');
  assert.equal(b.querySelector('.bf-name').textContent, 'Утро');
  assert.equal(b.querySelector('.g-cap').textContent, '7:00');
  assert.equal(r2Text(b.querySelector('.bf-count')), '✓ 2 из 2');
  assert.equal(b.querySelector('.bf-count [aria-hidden="true"]').textContent.codePointAt(0), 0x2713, 'знак — текстовый U+2713, от AT скрыт');
  assert.equal(b.getAttribute('aria-label'), 'Утро, 7:00: отмечено 2 из 2');
  // соседей свёртка не трогает; планка и хранилище — как без неё
  assert.ok(r2Box(document, 'v1') && r2Box(document, 'l1'), '«Вечер» и пункт без блока на месте');
  assert.equal(r2Note(document), '2 из 4');
  assert.equal(disk(), stored, 'свёртка в хранилище не пишет ничего');
  assert.deepEqual(JSON.parse(disk()).days[daysAgo(0)], { u1: true, u2: true });

  // имя и подпись — слова владельца: через esc, узлов из них не рождается
  const seed = r2FoldSeed({ u1: true });
  seed.groups[0].name = 'Сон & <b>x</b>';
  seed.groups[0].caption = '<i>7:00</i>';
  seed.items[0].group = seed.items[1].group = seed.items[4].group = 'Сон & <b>x</b>';
  const w2 = await boot({ seed });
  r2Box(w2.document, 'u2').click();
  await settle();
  const e = r2Fold(w2.document, 'Сон & <b>x</b>');
  assert.ok(e, 'data-name несёт имя как есть');
  assert.equal(e.querySelector('.bf-name').textContent, 'Сон & <b>x</b>');
  assert.equal(e.querySelector('.g-cap').textContent, '<i>7:00</i>');
  assert.ok([...e.querySelectorAll('*')].every(n => n.tagName === 'SPAN'), 'разметки из слов владельца нет');
  assert.equal(e.getAttribute('aria-label'), 'Сон & <b>x</b>, <i>7:00</i>: отмечено 2 из 2');
});

test('Р2/4: последний пропуск блока — «N из N · пропусков K», без знака; блок из одного действия схлопывает саму строку', async () => {
  const { document } = await boot({ seed: r2FoldSeed() });
  const scr = document.getElementById('scr-today');
  r2Box(document, 'u1').click();
  r2SkipBtn(document, 'u2').click(); // последнее действие — пропуск
  assert.ok(scr.querySelector('.list > .chain.folding'), 'пропуск сворачивает, как отметка');
  await settle();
  const u = r2Fold(document, 'Утро');
  assert.ok(u);
  assert.equal(r2Text(u.querySelector('.bf-count')), '1 из 1 · пропусков 1');
  assert.doesNotMatch(u.textContent, /✓/, 'при пропусках знака нет');
  assert.equal(u.getAttribute('aria-label'), 'Утро, 7:00: отмечено 1 из 1, пропусков 1');

  // «Вечер» — одно действие, у него нет .chain: схлопывается сама строка
  r2SkipBtn(document, 'v1').click();
  const row = scr.querySelector('.list > .rowwrap.folding');
  assert.ok(row, 'класс-триггер на строке блока из одного действия');
  assert.ok(row.contains(r2Box(document, 'v1')));
  await settle();
  const v = r2Fold(document, 'Вечер');
  assert.equal(r2Text(v.querySelector('.bf-count')), '0 из 0 · пропусков 1', 'всё пропущено — блок решён, число говорит правду');
  assert.equal(v.getAttribute('aria-label'), 'Вечер, до 22:30: отмечено 0 из 0, пропусков 1');
  assert.equal(r2Note(document), '1 из 2 · пропусков 2', 'день не закрыт: «Прогулка» не отмечена; пропуски — хвостом (Р3, п. 0.5)');
});

test('Р2/4: первичный рендер и любая перерисовка — выполненный блок уже свёрнут, без класса-триггера и без таймера', async () => {
  const { document, window } = await boot({ seed: r2FoldSeed({ u1: true, u2: false, v1: true }) });
  const scr = document.getElementById('scr-today');
  const u = r2Fold(document, 'Утро');
  const v = r2Fold(document, 'Вечер');
  assert.ok(u && v, 'оба блока свёрнуты при загрузке');
  assert.equal(r2Text(u.querySelector('.bf-count')), '1 из 1 · пропусков 1');
  assert.equal(r2Text(v.querySelector('.bf-count')), '✓ 1 из 1');
  assert.equal(scr.querySelector('.folding, .closing'), null, 'ни одного класса-триггера');
  assert.ok(r2Box(document, 'l1'), 'пункт без блока — строкой');

  // таймеров рендер не заводит: узлы переживают время схлопывания и сцены
  await wait(T.DAY_CLOSE_MS + T.MOTION_MS + T.MOTION_TAIL_MS + 40);
  assert.equal(u.isConnected, true, 'экран не перерисовался сам');
  const timers = [];
  const real = window.setTimeout;
  window.setTimeout = (fn, ms, ...rest) => { timers.push(ms); return real(fn, ms, ...rest); };
  try {
    window.renderToday();
    document.querySelector('#tabs button[data-tab="habits"]').click();
    document.querySelector('#tabs button[data-tab="today"]').click();
    assert.deepEqual(timers, [], 'перерисовка и смена вкладки таймеров не взводят');
    assert.ok(r2Fold(document, 'Утро') && r2Fold(document, 'Вечер'), 'после перерисовки — свёрнуты');
    assert.equal(scr.querySelector('.folding'), null);
    // шпион не слеп: таймеры приложения он видит — отклик их взводит
    r2Box(document, 'l1').click(); // день закрыт — сцена
    assert.ok(timers.includes(T.DAY_CLOSE_MS + T.MOTION_TAIL_MS), 'таймер сцены виден шпиону');
  } finally { window.setTimeout = real; }

  // класс-триггер печатает только хук: в исходнике строка 'folding' живёт в motionFold и нигде больше
  const start = APP.indexOf('function motionFold(');
  const end = APP.indexOf('\n}\n', start);
  const uses = [...APP.matchAll(/'folding'/g)].map(m => m.index);
  assert.ok(uses.length >= 1 && uses.every(i => i > start && i < end), 'класс навешивает только motionFold');
  for (const fn of ['renderToday', 'groupSections', 'foldRow', 'dailyRow']) {
    assert.doesNotMatch(window[fn].toString(), /folding|closing/, fn + ' триггеров не печатает');
  }
  assert.match(window.motionFold.toString(), /prefersReducedMotion\(\)\)\s*\{\s*done\(\);\s*return;/, 'ранний выход при reduced-motion');
  assert.match(window.motionFold.toString(), /setTimeout\(fin, MOTION_MS \+ MOTION_TAIL_MS\)/, 'fallback — константы timing()');
});

test('Р2/4: тап разворачивает до конца дня — фокус на первый круг, в хранилище ничего; снятие отметки оставляет развёрнутым; снова выполнен — сворачивается', async () => {
  const { document, window } = await boot({ seed: r2FoldSeed({ u1: true, u2: true }) });
  const scr = document.getElementById('scr-today');
  const disk = window.localStorage.getItem(NS);
  const fold = r2Fold(document, 'Утро');
  assert.ok(fold);

  fold.click();
  assert.equal(r2Fold(document, 'Утро'), null, 'развёрнут');
  assert.ok(r2Box(document, 'u1').checked && r2Box(document, 'u2').checked, 'строки как обычно');
  assert.equal(scr.querySelector('.list > .g-label').firstElementChild.textContent, 'Утро', 'с заголовком');
  assert.equal(document.activeElement, r2Box(document, 'u1'), 'фокус — на первый круг блока');
  assert.equal(scr.querySelector('.folding, .closing'), null, 'развёртка ничего не проигрывает');
  assert.equal(window.localStorage.getItem(NS), disk, 'развёртка — состояние экрана, не хранилище');

  // перерисовка и уход с вкладки развёртку не снимают: она живёт день
  window.renderAll();
  document.querySelector('#tabs button[data-tab="progress"]').click();
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.equal(r2Fold(document, 'Утро'), null, 'после перерисовки — развёрнут');

  // снятие отметки внутри — остаётся развёрнутым
  r2Box(document, 'u2').click();
  await settle();
  assert.equal(r2Fold(document, 'Утро'), null);
  assert.ok(r2Box(document, 'u2'), 'строки на месте');
  window.renderToday();
  assert.equal(r2Fold(document, 'Утро'), null, 'и перерисовка его не сворачивает: блок не выполнен');

  // снова выполнен — сворачивается откликом; флаг развёртки снят
  r2Box(document, 'u2').focus();
  r2Box(document, 'u2').click();
  assert.ok(scr.querySelector('.list > .chain.folding'), 'схлопывание, как у первой свёртки');
  await settle();
  const again = r2Fold(document, 'Утро');
  assert.ok(again, 'свёрнут');
  assert.equal(document.activeElement, again, 'фокус из свернувшихся строк — на его строку');
  window.renderToday();
  assert.ok(r2Fold(document, 'Утро'), 'флаг снят: перерисовка оставляет свёрнутым');

  // блок, где всё пропущено: круги неактивны — фокус на первое «Вернуть»
  r2SkipBtn(document, 'v1').click();
  await settle();
  r2Fold(document, 'Вечер').click();
  const back = r2SkipBtn(document, 'v1');
  assert.equal(back.dataset.act, 'unskip');
  assert.equal(document.activeElement, back, 'фокус — на «Вернуть»');
  back.click();
  assert.equal(r2Fold(document, 'Вечер'), null, '«Вернуть» в развёрнутом — остаётся развёрнутым');
  assert.equal(scr.querySelector('.folding'), null);
});

test('Р2/4: смена логического дня и смена режима снимают развёртку', async () => {
  const t = daysAgo(0);
  const seed = r2FoldSeed({ u1: true, u2: true });
  seed.days[addKey(t, 1)] = { u1: true, u2: true, l1: true };
  const { document, window } = await boot({ seed });
  r2Fold(document, 'Утро').click();
  assert.equal(r2Fold(document, 'Утро'), null, 'развёрнут сегодня');
  shiftWindowDays(window, 1);
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.ok(r2Fold(document, 'Утро'), 'назавтра выполненный блок снова свёрнут: развёртка принадлежала дню');
  assert.equal(document.querySelector('#scr-today .folding'), null, 'смена дня — перерисовка, не отклик');

  // режим: одноимённое «Утро» у каждого — другой блок
  const r = r2UiSeed({ days: { [daysAgo(0)]: { m1: true, k1: true } } });
  const w = await boot({ seed: r });
  assert.ok(r2Fold(w.document, 'Утро'), '«Утро» основного свёрнуто');
  r2Fold(w.document, 'Утро').click();
  assert.equal(r2Fold(w.document, 'Утро'), null);
  const pick = id => {
    r2OpenModes(w.document);
    r2Btn(w.document, 'mode-pick', id).click();
    w.document.querySelector('#tabs button[data-tab="today"]').click();
  };
  pick(R2_KAN);
  assert.deepEqual(r2Today(w.document), ['k2'], '«Утро» каникул выполнено и свёрнуто, «Лагерь» — строкой');
  assert.ok(r2Fold(w.document, 'Утро'), 'развёртка «Утра» основного не развернула «Утро» каникул');
  pick('main');
  assert.ok(r2Fold(w.document, 'Утро'), 'и возврат к основному её не воскресил');
});

test('Р2/4: пункты вне блоков не сворачиваются; на «Привычках» свёртки нет', async () => {
  const { document } = await boot({ seed: r2FoldSeed({ u1: true, u2: true, v1: true }) });
  const scr = document.getElementById('scr-today');
  r2Box(document, 'l1').click(); // день закрыт пунктом без блока
  assert.ok(scr.querySelector('.dayline.closing'));
  assert.equal(scr.querySelector('.folding'), null);
  await r2Scene();
  assert.ok(r2Box(document, 'l1'), 'выполненный пункт без блока — строкой');
  assert.equal(scr.querySelectorAll('[data-act="block-unfold"]').length, 2, 'свёрнуты только блоки');

  document.querySelector('#tabs button[data-tab="habits"]').click();
  const hb = document.getElementById('scr-habits');
  hb.querySelector('input[data-act="mark"][data-id="h1"]').click();
  await settle();
  assert.equal(hb.querySelector('.bfold, .folding'), null, '«Утро» с отмеченной привычкой не свёрнуто');
  assert.ok(hb.querySelector('input[data-id="h1"]').checked);
});

test('Р2/4: сцена закрытия дня главнее — своей анимации у свёртки нет, блок свёрнут перерисовкой после сцены; схлопывание, застанное сценой, уступает ей', async () => {
  const { document, window } = await boot({ seed: r2FoldSeed({ u1: true, v1: true, l1: true }) });
  const scr = document.getElementById('scr-today');
  const renders = [];
  const real = window.renderToday;
  window.renderToday = function () { renders.push(!!scr.querySelector('.closing')); return real.apply(this, arguments); };

  r2Box(document, 'u2').click(); // последний в блоке и последний в дне
  assert.ok(scr.querySelector('.dayline.closing') && scr.querySelector('label.check.closing'), 'играет сцена');
  assert.equal(scr.querySelector('.folding'), null, 'схлопывания нет — двойной анимации нет');
  assert.ok(r2Box(document, 'u2'), 'строки блока стоят, пока идёт сцена');
  await r2Scene();
  assert.equal(scr.querySelector('.closing'), null);
  assert.ok(r2Fold(document, 'Утро'), 'после сцены блок свёрнут');
  assert.deepEqual(renders, [false], 'одна перерисовка — после сцены, не во время');

  // схлопывание «Утра» идёт, и пункт без блока закрывает день: сцена застаёт
  // схлопывание — оно перерисовку уступает, сворачивает конец сцены
  r2Fold(document, 'Утро').click();
  r2Box(document, 'u2').click();   // снять
  r2Box(document, 'l1').click();   // снять
  await settle();
  renders.length = 0;
  r2Box(document, 'u2').click();   // «Утро» снова выполнено — схлопывание
  assert.ok(scr.querySelector('.list > .chain.folding'));
  r2Box(document, 'l1').click();   // день закрыт пунктом без блока
  assert.ok(scr.querySelector('.dayline.closing'), 'сцена');
  await r2Scene();
  assert.ok(r2Fold(document, 'Утро'), 'свёрнут');
  assert.equal(scr.querySelector('.closing, .folding'), null);
  assert.deepEqual(renders, [false], 'схлопывание не перерисовало экран посреди сцены');
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'после сцены');
});

test('Р2/4: reduced-motion — свёртка мгновенна и без классов, и отметкой, и закрытием дня', async () => {
  const { document, window } = await boot({ seed: r2FoldSeed() });
  r2ReducedMotion(window);
  const scr = document.getElementById('scr-today');
  r2Box(document, 'u1').click();
  r2Box(document, 'u2').click();
  assert.ok(r2Fold(document, 'Утро'), 'свёрнут сразу, без ожидания');
  assert.equal(scr.querySelector('.folding'), null, 'класс-триггер не навешивался');
  r2Box(document, 'l1').click();
  r2Box(document, 'v1').click(); // закрывает день и «Вечер»
  assert.ok(r2Fold(document, 'Вечер'), 'и после закрытия дня — сразу');
  assert.equal(scr.querySelector('.closing, .folding'), null, 'ни сцены, ни схлопывания');
  assert.equal(r2Note(document), 'День закрыт', 'конечное состояние на месте');
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'reduced-motion');
});

test('Р2/4: сторож по фикстуре владельца — после отклика свёртки и сцены точечно = перерисовка', async () => {
  const { document, window } = await bootR1Owner(1); // вторник: 20 действий в пяти блоках
  const scr = document.getElementById('scr-today');
  const rowsOf = name => {
    const head = [...scr.querySelectorAll('.list > .g-label')].find(l => l.firstElementChild.textContent === name);
    return [...head.nextElementSibling.querySelectorAll('input[data-act="mark"]')];
  };
  for (const b of rowsOf('Утро')) b.click();
  await settle();
  assert.ok(r2Fold(document, 'Утро'));
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), '«Утро» выполнено');

  const school = rowsOf('Школа');
  r2SkipBtn(document, school[0].dataset.id).click();
  for (const b of school.slice(1)) b.click();
  await settle();
  assert.equal(r2Text(r2Fold(document, 'Школа').querySelector('.bf-count')), '4 из 4 · пропусков 1');
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), '«Школа» с пропуском');

  unfoldBlock(document, 'Школа');
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'развёрнута');
  rowsOf('Школа')[2].click();
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'снятие отметки в развёрнутом');
  rowsOf('Школа')[2].click();
  await settle();
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'снова выполнена');

  for (const name of ['Дом + Спорт', 'Учеба', 'Вечер']) for (const b of rowsOf(name)) b.click();
  assert.equal(r2Note(document), 'День закрыт');
  await r2Scene();
  assert.equal(scr.querySelectorAll('[data-act="block-unfold"]').length, 5, 'все пять блоков свёрнуты');
  assert.equal(scr.querySelector('.closing, .folding'), null, 'следа ни сцены, ни схлопывания');
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'день закрыт');
});

test('Р2/4: свёрнутая строка — тач-цель ≥ 44 px с откликом из списка; схлопывание — в окне движения, ease-in, без задержки; стиль — существующие ступень и тон', async () => {
  const { document } = await boot({ seed: r2FoldSeed({ u1: true, u2: true }) });
  const css = CSS_SRC();
  const b = r2Fold(document, 'Утро');
  const hit = TAPPABLE.find(s => b.matches(s));
  assert.equal(hit, '.bfold', 'строка свёртки — в списке тач-целей');
  assert.match(css, /\.bfold:active,/, 'и у неё состояние нажатия общего правила');
  const row = ruleOf(css, '.bfold');
  assert.ok(px(row, 'min-height') >= 44, 'тач-цель ≥ 44 px');
  assert.match(row, /font-size:\s*var\(--text-xs\)/, 'ступень существующая');
  assert.match(row, /color:\s*var\(--muted\)/, 'тон приглушённый, акцента нет');
  assert.doesNotMatch(row, /transition|animation|gradient|--accent/);
  assert.doesNotMatch(ruleOf(css, '.bf-name'), /transition|animation/);

  assert.match(css, /\n\.list > \.chain\.folding,\n\.list > \.rowwrap\.folding \{/, 'одно правило на оба вида строк блока');
  const fold = ruleOf(css, '.list > .rowwrap.folding');
  const parts = motionParts(declValues(fold, 'transition')[0]);
  assert.deepEqual(parts.map(p => p.raw.split(' ')[0]).sort(), ['max-height', 'opacity'], 'схлопывание по высоте и прозрачности');
  for (const p of parts) {
    assert.ok(p.dur >= 180 && p.dur <= 260, `«${p.raw}» — ${p.dur} мс в окне`);
    assert.equal(p.delay, 0, 'без задержки: задержка законна только в сцене');
    assert.match(p.raw, /ease-in$/, 'уход — ease-in');
  }
  assert.doesNotMatch(fold, /font-weight|gradient/);
  assert.match(fold, /pointer-events:\s*none/, 'схлопывающиеся строки не ловят тап');
  assert.match(fold, /overflow:\s*hidden/);
  const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(rm, /transition: none !important/, 'reduced-motion гасит и этот переход');
});

/* ══ Задача Р2: ремонт по рецензии ═══════════════════════════════ */

test('Р2/рецензия: «Убрать блок» — последствие по факту: при живом одноимённом блоке другого режима привычки не обещаны; второй тап делает названное', async () => {
  const { document, window } = await boot({ seed: r2UiSeed() });
  const s = () => r1Saved(window);
  const said = name => r1Btn(document, 'group-remove', name).closest('.btns').nextElementSibling;
  const OLD = 'Блок уйдёт из списков вместе с действиями и привычками. Отметки и прошлые дни останутся как есть.';
  const NAMESAKE = 'Блок уйдёт из списков вместе со своими действиями. Привычки и недельные счётчики останутся: блок с этим именем есть в другом режиме. Отметки и прошлые дни останутся как есть.';

  // основной: «Утро» есть и у «Каникул» — привычка «Чтение» останется
  r1Settings(document);
  r1Btn(document, 'group-open', 'Утро').click();
  r1Btn(document, 'group-remove', 'Утро').click();
  assert.equal(said('Утро').textContent, NAMESAKE);
  assert.equal(said('Утро').className, 'muted');
  r1Btn(document, 'group-remove', 'Утро').click();
  const live = id => s().items.find(i => i.id === id).removedAt === null;
  assert.deepEqual(['m1', 'h1'].map(live), [false, true], 'ушло действие, привычка — как сказано');

  // «Школа» одноимённого нет — прежние слова, и параметр уходит вместе с блоком
  r1Btn(document, 'group-open', 'Школа').click();
  r1Btn(document, 'group-remove', 'Школа').click();
  assert.equal(said('Школа').textContent, OLD);
  r1Btn(document, 'group-remove', 'Школа').click();
  assert.deepEqual(['m2', 'ph'].map(live), [false, false]);

  // «Утро» каникул: одноимённое основного уже убрано — живого тёзки нет, прежние слова
  r2Pick(document, R2_KAN);
  r1Btn(document, 'group-open', 'Утро').click();
  r1Btn(document, 'group-remove', 'Утро').click();
  assert.equal(said('Утро').textContent, OLD, 'убранный тёзка привычек не держит');
  r1Btn(document, 'group-remove', 'Утро').click();
  assert.deepEqual(['k1', 'h1'].map(live), [false, false], 'и привычка ушла вместе с блоком');
});

test('Р2/рецензия: медленный тап по содержимому открытой строки — закрыть, а не отметить, сколько бы ни держали; после отпускания память снимается', async () => {
  const { document, window } = await boot({ seed: pointSeed() });
  const saved = () => JSON.parse(window.localStorage.getItem(NS));
  const t = daysAgo(0);
  const row = id => r2Row(document, id);
  const label = id => row(id).querySelector('label.check');
  const down = (node, x, y) => node.dispatchEvent(pointer(window, 'pointerdown', x, y));
  const move = (x, y) => document.dispatchEvent(pointer(window, 'pointermove', x, y));
  const up = (x, y) => document.dispatchEvent(pointer(window, 'pointerup', x, y));
  const open = id => {
    row(id).getBoundingClientRect = () => ({ top: 200, bottom: 256, height: 56, left: 20, right: 355, width: 335, x: 20, y: 200 });
    down(label(id).querySelector('.tname'), 300, 230); move(290, 231); move(150, 231); up(150, 231);
    assert.ok(row(id).classList.contains('open'), 'строка открыта');
  };

  open('p-a');
  await wait(T.DRAG_CLICK_MS + 20); // клик жеста не пришёл — память жеста истекла
  down(label('p-a').querySelector('.tname'), 100, 230);
  assert.equal(row('p-a').classList.contains('open'), false, 'касание закрыло строку');
  await wait(T.DRAG_CLICK_MS * 3); // держат дольше страховочного окна
  up(100, 230);
  label('p-a').click();
  assert.equal(saved().days[t], undefined, 'долгий тап по открытой строке — «закрыть», не «отметить»');
  assert.equal(document.querySelector('#scr-today input[data-id="p-a"]').checked, false);

  // отпускание взводит окно: клик, не пришедший за ним, память не держит
  open('p-a');
  await wait(T.DRAG_CLICK_MS + 20);
  down(label('p-a').querySelector('.tname'), 100, 230);
  up(100, 230);
  await wait(T.DRAG_CLICK_MS + 20);
  label('p-a').click();
  assert.equal(saved().days[t]['p-a'], true, 'следующий обычный тап отмечает');

  // pointercancel вместо отпускания — то же окно
  label('p-a').click(); // снять отметку
  open('p-b');
  await wait(T.DRAG_CLICK_MS + 20);
  down(label('p-b').querySelector('.tname'), 100, 290);
  await wait(T.DRAG_CLICK_MS * 3);
  document.dispatchEvent(pointer(window, 'pointercancel', 100, 290));
  label('p-b').click();
  assert.equal((saved().days[t] || {})['p-b'], undefined, 'клик сразу за отменой жеста не отмечает');
});

test('Р2/рецензия: чистка и «Вернуть» закрывают раскрытый список режимов; режимы названы в предупреждении и в строке копии', async () => {
  const { document } = await boot({ seed: r2UiSeed() });
  r2OpenModes(document);
  openData(document);
  assert.equal(r2List(document).hidden, false, 'раскрытие секции «Данные» список не трогает');
  document.querySelector('[data-act="wipe-open"]').click();
  const danger = document.querySelector('#scr-settings .danger').textContent;
  assert.match(danger, /Будут стёрты: 8 пунктов, 4 блока, 0 дней отметок, 0 разборов, 0 лестниц, 0 упражнений, 0 тренировок, 0 заметок, 1 режим\./,
    'режим назван; отрезков журнала нет — и строки о них нет');
  document.querySelector('[data-act="wipe-do"]').click();
  document.querySelector('[data-act="wipe-do"]').click();
  r1Settings(document);
  assert.equal(r2List(document).hidden, true, 'после чистки список режимов закрыт');
  assert.equal(r2Head(document).getAttribute('aria-expanded'), 'false');
  assert.match(document.querySelector('#scr-settings .restore').textContent, /· 8 пунктов, 0 дней отметок, 1 режим/, 'копия называет режим');

  r2OpenModes(document);
  document.querySelector('[data-act="wipe-undo"]').click();
  r1Settings(document);
  assert.equal(r2List(document).hidden, true, 'после «Вернуть» — тоже');
  assert.match(r2Head(document).textContent, /Режим: Основной/);
});

test('Р2/рецензия: сетка разбора на двух режимах — действие режима разобранной недели стоит, живое действие чужого режима вне недели — нет, активного — всегда', async () => {
  const since = addKey(curMonday(), -14);
  const seed = r2UiSeed({ modeLog: [{ from: curMonday(), mode: R2_KAN }] });
  seed.modes.push({ id: 'far', name: 'Дальний', removedAt: null });
  seed.groups.push(r2Blk('Утро', 'far', ''));
  seed.items.push(r1Action('x1', 'Чужое', since, 'Утро', R1_ALL, { mode: 'far' }));
  seed.days = { [prevMonday()]: { m1: true } };
  const { document } = await boot({ seed });
  openReview(document);
  const [minGrid] = document.getElementById('scr-review').querySelectorAll('.grid');
  const names = [...minGrid.querySelectorAll('.g-name')].map(n => n.firstChild.textContent);
  assert.deepEqual(names, ['Кровать', 'Математика', 'Зарядка', 'Костёр']);
  assert.equal(r1GridRow(minGrid, 'Кровать').sr, ', отмечено 1 из 7', 'а: неделя шла в основном — его действие в плане');
  assert.equal(r1GridRow(minGrid, 'Математика').sr, ', отмечено 0 из 7');
  assert.ok(!names.includes('Чужое'), 'б: живое действие режима, которого в неделе не было, в сетке не стоит');
  assert.equal(r1GridRow(minGrid, 'Зарядка').sr, ', не запланировано', 'в: активный режим — стоит, хоть и не в плане той недели');
});

test('Р2/рецензия: сетка разбора — убранное действие с одними пропусками в неделе стоит в ней ячейкой пропуска; пропуск назван днём', async () => {
  const seed = r1ReviewSeed();
  const prev = prevMonday();
  seed.items.push(r1Action('gone', 'Ушедшее', addKey(prev, -14), '', R1_ALL, { removedAt: addKey(prev, 2) }));
  seed.days[prev] = Object.assign(seed.days[prev] || {}, { gone: false });
  const { document } = await boot({ seed });
  openReview(document);
  const [minGrid] = document.getElementById('scr-review').querySelectorAll('.grid');
  const row = r1GridRow(minGrid, 'Ушедшее');
  assert.equal(row.plan.textContent, 'запланировано 2 дня · пропусков 1');
  assert.equal(row.sr, ', отмечено 0 из 2, пропусков 1: понедельник', 'AT слышит, какой день пропущен');
  assert.equal(row.on, 0);
  const cells = [...minGrid.querySelectorAll('.g-name')].find(x => x.firstChild.textContent === 'Ушедшее').nextElementSibling.querySelectorAll('i');
  assert.deepEqual([...cells].map(c => c.classList.contains('skip')), [true, false, false, false, false, false, false], 'ячейка пропуска — понедельник');
});

test('Р2/рецензия: «Сегодня» в выбранном режиме без действий — «Пунктов пока нет», а не «ничего нет»; у действий режима вне дня — наоборот', async () => {
  const seed = r2UiSeed({ modeLog: [{ from: daysAgo(2), mode: 'summer' }] });
  seed.modes.push({ id: 'summer', name: 'Лето', removedAt: null });
  let { document } = await boot({ seed });
  let text = document.getElementById('scr-today').textContent;
  assert.match(text, /Пунктов пока нет — добавить можно в Настройках → Расписание\./, 'у выбранного режима действий нет вовсе');
  assert.doesNotMatch(text, /На сегодня в расписании ничего нет/, 'действия другого режима строку не меняют');

  const wd = (new Date(daysAgo(0) + 'T12:00').getDay() + 6) % 7;
  const notToday = R1_ALL.split('').map((c, i) => (i === wd ? '0' : '1')).join('');
  const seed2 = r2UiSeed({ modeLog: [{ from: daysAgo(2), mode: R2_KAN }] });
  for (const it of seed2.items) if (it.mode === R2_KAN) it.schedule = [{ from: it.addedAt, mask: notToday }];
  ({ document } = await boot({ seed: seed2 }));
  text = document.getElementById('scr-today').textContent;
  assert.match(text, /На сегодня в расписании ничего нет\./, 'действия выбранного режима есть, но не сегодня');
  assert.doesNotMatch(text, /Пунктов пока нет/);
});

test('Р2/рецензия: свёрнутая строка блока без подписи — узла подписи нет, имя для AT без запятой', async () => {
  const seed = r2FoldSeed({ v1: true });
  seed.groups[1].caption = '';
  const { document } = await boot({ seed });
  const v = r2Fold(document, 'Вечер');
  assert.ok(v, 'выполненный блок свёрнут');
  assert.equal(v.querySelector('.g-cap'), null, 'пустой подписи нет в разметке');
  assert.equal(v.getAttribute('aria-label'), 'Вечер: отмечено 1 из 1');
  assert.equal(v.querySelector('.bf-name').textContent, 'Вечер');
  assert.equal(r2Text(v.querySelector('.bf-count')), '✓ 1 из 1');
});

test('Р2/рецензия: переименование развёрнутого выполненного блока переносит развёртку «Сегодня» на новое имя', async () => {
  const { document } = await boot({ seed: r2FoldSeed({ u1: true, u2: true }) });
  assert.ok(r2Fold(document, 'Утро'), 'выполненный блок свёрнут');
  unfoldBlock(document, 'Утро');
  r1Settings(document);
  r1Btn(document, 'group-open', 'Утро').click();
  document.getElementById('g-name').value = 'Рассвет';
  r1Btn(document, 'group-save', 'Утро').click();
  document.querySelector('#tabs button[data-tab="today"]').click();
  assert.equal(r2Fold(document, 'Рассвет'), null, 'развёрнут под новым именем');
  assert.ok(r2Box(document, 'u1') && r2Box(document, 'u2'), 'строки блока на месте');
  assert.equal(r2Fold(document, 'Утро'), null);
});

/* ══ Задача Р3, п. 0: решения архитектора по вопросам Р2 ═══════════
   (1) точка «вчера — пропуск» на свёрнутой строке блока; (2) дневные
   «Привычки» — раскладка секции «Привычки» «Настроек»; (3) держит имя только
   живой блок живого режима; (5) счёт дня с пропусками; риск 6 — motionLeave
   фильтрует transitionend по своему узлу. */

test('Р3/0.1: свёрнутый блок с точкой «вчера — пропуск» — признак справа от счёта, имя для AT его называет; нет пропуска — нет признака; тап разворачивает, точка у строки; точечно = перерисовка', async () => {
  const seed = r2FoldSeed({ u1: true });
  seed.days[daysAgo(2)] = { u1: true, u2: true, v1: true };
  seed.days[daysAgo(1)] = { u2: true, v1: true }; // «Кровать» вчера не отмечена — точка
  const { document, window } = await boot({ seed });
  const scr = document.getElementById('scr-today');
  assert.ok(byId(document, 'miss-note', 'u1'), 'невыполненный блок — точка у строки пункта, как прежде');

  r2Box(document, 'u2').click();
  await settle();
  const b = r2Fold(document, 'Утро');
  assert.ok(b, 'блок с точкой сворачивается, как любой выполненный');
  const miss = b.querySelector('.bf-miss');
  assert.ok(miss, 'признак точки — на свёрнутой строке');
  assert.equal(miss.previousElementSibling, b.querySelector('.bf-count'), 'справа от счёта');
  assert.equal(b.lastElementChild, miss, 'последним в строке');
  assert.equal(miss.tagName, 'SPAN', 'знак, а не вторая цель');
  assert.equal(miss.getAttribute('aria-hidden'), 'true', 'для AT его несёт имя строки');
  assert.ok(miss.firstElementChild && miss.firstElementChild.tagName === 'I', 'тот же кружок, что у точки строки');
  assert.equal(b.querySelectorAll('button, [data-act]').length, 0, 'одна цель — сама строка: тап разворачивает');
  assert.equal(b.getAttribute('aria-label'), 'Утро, 7:00: отмечено 2 из 2, вчера — пропуск');
  assert.equal(scr.querySelector('[data-act="miss-note"]'), null, 'строк блока нет — и точки у строки нет');
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'свёрнут с признаком точки');

  // «Вечер» вчера отмечен — признака нет, имя прежнее
  r2Box(document, 'v1').click();
  await settle();
  const v = r2Fold(document, 'Вечер');
  assert.equal(v.querySelector('.bf-miss'), null, 'нет пропуска вчера — нет признака');
  assert.equal(v.getAttribute('aria-label'), 'Вечер, до 22:30: отмечено 1 из 1');
  assert.ok(r2Fold(document, 'Утро').querySelector('.bf-miss'), 'соседний свёрнутый блок признак сохранил');
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'второй блок свёрнут без признака');

  // тап по строке разворачивает; точка — у строки пункта, ретро-отметка — там же
  unfoldBlock(document, 'Утро');
  const dot = byId(document, 'miss-note', 'u1');
  assert.ok(dot, 'точка вернулась к строке пункта');
  dot.click();
  byId(document, 'mark-yesterday', 'u1').click();
  assert.equal(r1Saved(window).days[daysAgo(1)].u1, true, 'отметка за вчера — прежним путём');
  assert.equal(byId(document, 'miss-note', 'u1'), undefined, 'точки больше нет');

  // блок снова выполнен после действия — сворачивается уже без признака
  r2Box(document, 'u2').click();
  r2Box(document, 'u2').click();
  await settle();
  const again = r2Fold(document, 'Утро');
  assert.ok(again);
  assert.equal(again.querySelector('.bf-miss'), null, 'вчера отмечено — признака нет');
  assert.equal(again.getAttribute('aria-label'), 'Утро, 7:00: отмечено 2 из 2');
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'свёрнут снова, без признака');

  // CSS: кружок — одно правило с точкой строки, нейтральный --dot, без акцента
  const css = CSS_SRC();
  assert.match(css, /\n\.dot i, \.bf-miss i \{[^}]*background: var\(--dot\)/, 'одно правило на оба кружка');
  const box = ruleOf(css, '.bf-miss');
  assert.ok(box, 'коробка признака');
  assert.doesNotMatch(box, /--accent|transition|animation|font-size|cursor/);
});

test('Р3/0.1: первичный рендер — выполненный блок с точкой уже свёрнут с признаком; при сплошных пропусках — тоже', async () => {
  const seed = r2FoldSeed({ u1: false, u2: false });
  seed.days[daysAgo(2)] = { u1: true };
  const { document } = await boot({ seed });
  const b = r2Fold(document, 'Утро');
  assert.ok(b, 'блок из одних пропусков свёрнут');
  assert.equal(r2Text(b.querySelector('.bf-count')), '0 из 0 · пропусков 2');
  assert.ok(b.querySelector('.bf-miss'), 'пропуск вчера — признак на строке');
  assert.equal(b.getAttribute('aria-label'), 'Утро, 7:00: отмечено 0 из 0, пропусков 2, вчера — пропуск');
  assert.equal(document.querySelector('#scr-today .folding'), null, 'состояние, а не отклик');
});

test('Р3/0.2: дневные «Привычки» — раскладка секции «Привычки» «Настроек»: блоки выбранного режима с подписью, прочие имена без подписи, «Без блока» последним; смена режима привычек не переносит; точечно = перерисовка', async () => {
  const seed = r2UiSeed({ groups: [r2Blk('Утро', 'main', '7:00'), r2Blk('Школа', 'main', 'до 15:15'), r2Blk('Утро', R2_KAN, '9:00'), r2Blk('Лагерь', R2_KAN, 'у озера')] });
  const since = seed.items.find(i => i.id === 'h2').addedAt;
  seed.items.push(r1Action('h4', 'Бег', since, 'Лагерь', R1_ALL, { area: 'habit', normPerWeek: 7 }));
  const { document, window } = await boot({ seed });
  const scr = document.getElementById('scr-habits');
  const tab = t => document.querySelector(`#tabs button[data-tab="${t}"]`).click();
  const daily = () => {
    tab('habits');
    const out = [];
    let head = [null, null];
    for (const n of scr.querySelector('.list').children) {
      if (n.matches('.g-label')) head = [n.firstElementChild.textContent, n.querySelector('.g-cap') ? n.querySelector('.g-cap').textContent : null];
      for (const i of n.querySelectorAll('input[data-act="mark"]')) out.push([head[0], head[1], i.dataset.id]);
    }
    return out;
  };
  const settings = ids => {
    r1Settings(document);
    const out = [];
    let head = null;
    for (const n of openSect(document, /Привычки/).querySelector('.sect-b').children) {
      if (n.matches('h2')) break;
      if (n.matches('.g-label')) head = n.textContent;
      if (n.matches('.list')) for (const b of n.querySelectorAll('[data-act="edit-open"]')) if (ids.includes(b.dataset.id)) out.push([head, b.dataset.id]);
    }
    return out;
  };
  const same = lay => assert.deepEqual(settings(lay.map(x => x[2])), lay.map(x => [x[0], x[2]]), 'заголовки и порядок — те же, что в секции «Настроек»');

  let lay = daily();
  assert.deepEqual(lay, [['Утро', '7:00', 'h1'], ['Лагерь', null, 'h2'], ['Лагерь', null, 'h4'], ['Без блока', null, 'h3']],
    'основной: его «Утро» с подписью, «Лагерь» другого режима — без подписи, без блока — последней, с заголовком');
  same(lay);
  tab('habits');
  const camp = [...scr.querySelectorAll('.list > .g-label')].find(l => l.firstElementChild.textContent === 'Лагерь');
  assert.ok(camp.nextElementSibling.matches('.chain'), 'линия блока — у имени другого режима тоже: это блок');
  assert.equal(camp.nextElementSibling.querySelectorAll('input[data-act="mark"]').length, 2);
  const loose = [...scr.querySelectorAll('.list > .g-label')].find(l => l.firstElementChild.textContent === 'Без блока');
  assert.ok(loose.nextElementSibling.matches('.rowwrap'), '«Без блока» — без линии');
  assert.equal(loose.querySelector('.g-cap'), null);

  byId(document, 'mark', 'h2').click();
  assertSame(pointVsFull(window, 'scr-habits', 'renderHabits'), 'отметка привычки под именем другого режима');
  byId(document, 'mark', 'h3').click();
  assertSame(pointVsFull(window, 'scr-habits', 'renderHabits'), 'отметка привычки без блока');

  r2Pick(document, R2_KAN);
  lay = daily();
  assert.deepEqual(lay, [['Утро', '9:00', 'h1'], ['Лагерь', 'у озера', 'h2'], ['Лагерь', 'у озера', 'h4'], ['Без блока', null, 'h3']],
    'каникулы: подпись — их блоков; каждая привычка под тем же именем, что в основном');
  same(lay);
  byId(document, 'mark', 'h1').click();
  assertSame(pointVsFull(window, 'scr-habits', 'renderHabits'), 'отметка в выбранном режиме');

  // режим убран — имя, которое носил только его блок, заголовком не держится
  r2Pick(document, 'main');
  r2OpenModes(document);
  r2Btn(document, 'mode-remove', R2_KAN).click();
  r2Btn(document, 'mode-remove', R2_KAN).click();
  lay = daily();
  assert.deepEqual(lay, [['Утро', '7:00', 'h1'], ['Без блока', null, 'h2'], ['Без блока', null, 'h3'], ['Без блока', null, 'h4']],
    'блок убранного режима имени не держит: «Лагерь» — без блока, на обоих местах одинаково');
  same(lay);
  tab('habits');
  assert.equal(scr.querySelector('.chain'), null, 'у «Без блока» линии нет');
  assertSame(pointVsFull(window, 'scr-habits', 'renderHabits'), 'после ухода режима');

  // только пункты без блока — заголовка «Без блока» нет, как в «Настройках»
  const lone = await boot({ seed: r2UiSeed({ groups: [], items: [r1Action('z', 'Вода', since, '', R1_ALL, { area: 'habit', normPerWeek: 7 })] }) });
  lone.document.querySelector('#tabs button[data-tab="habits"]').click();
  assert.equal(lone.document.querySelector('#scr-habits .list .g-label'), null, 'выше нет блоков — нет и заголовка');
});

test('Р3/0.3: «Убрать блок» при тёзке в убранном режиме — прежние слова; второй тап уводит и привычки; возврат блока их возвращает', async () => {
  const { document, window } = await boot({ seed: r2UiSeed() });
  const live = id => r1Saved(window).items.filter(i => i.id === id || (i.name === 'Чтение' && id === 'h1')).some(i => i.removedAt === null);
  const said = name => r1Btn(document, 'group-remove', name).closest('.btns').nextElementSibling;
  const OLD = 'Блок уйдёт из списков вместе с действиями и привычками. Отметки и прошлые дни останутся как есть.';

  r2OpenModes(document);
  r2Btn(document, 'mode-remove', R2_KAN).click();
  r2Btn(document, 'mode-remove', R2_KAN).click();
  assert.ok(r1Saved(window).modes.find(m => m.id === R2_KAN).removedAt, 'режим «Каникулы» убран; его «Утро» — живой блок');

  r1Btn(document, 'group-open', 'Утро').click();
  r1Btn(document, 'group-remove', 'Утро').click();
  assert.equal(said('Утро').textContent, OLD, 'тёзка в убранном режиме привычек не держит — и слова об этом не обещают');
  r1Btn(document, 'group-remove', 'Утро').click();
  assert.deepEqual([live('m1'), live('h1'), live('k1')], [false, false, true], 'ушли действие основного и привычка — как сказано; действие «Каникул» при своём блоке');

  const goneHabits = () => [...openSect(document, /Привычки/).querySelectorAll('[data-act="item-restore"]')].map(b => b.dataset.id);
  assert.deepEqual(goneHabits(), [], 'в «Убранных» привычек её нет — дорога назад через блок');
  const back = [...document.querySelectorAll('#scr-settings [data-act="group-restore"]')].find(b => b.dataset.name === 'Утро');
  assert.ok(back, 'блок — в «Убранных» «Расписания»');
  back.click();
  assert.deepEqual([live('m1'), live('h1')], [true, true], 'возврат блока вернул и привычку');
  document.querySelector('#tabs button[data-tab="habits"]').click();
  const head = [...document.querySelectorAll('#scr-habits .list > .g-label')].find(l => l.firstElementChild.textContent === 'Утро');
  assert.ok(head && head.nextElementSibling.querySelector('input[data-act="mark"][data-id="h1"]'), '«Чтение» снова под своим «Утром»');
});

test('Р3/0.5: счёт дня «Сегодня» — «N из M · пропусков K» с приглушённым хвостом; сплошные пропуски — «0 из 0 · пропусков K»; «День закрыт» без хвоста; рендер = точечный путь', async () => {
  const { document, window } = await boot({ seed: pointSeed() });
  const note = () => document.querySelector('#scr-today .bar-note');
  const tail = () => note().querySelector('.bar-skip');
  assert.equal(r2Note(document), '0 из 2');
  assert.equal(tail(), null, 'без пропусков хвоста нет');

  r2SkipBtn(document, 'p-a').click();
  assert.equal(r2Note(document), '0 из 1 · пропусков 1');
  assert.equal(note().querySelector('b').textContent, '0', 'число N — прежним узлом');
  assert.equal(r2Text(tail()), '· пропусков 1');
  assert.equal(note().lastElementChild, tail(), 'хвост — после «из M»');
  assert.equal(note().classList.contains('ok'), false);
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'один пропуск');
  const seed = pointSeed();
  seed.days[daysAgo(0)] = { 'p-a': false };
  const fresh = await boot({ seed });
  assert.equal(fresh.document.querySelector('#scr-today .bar-note').innerHTML, note().innerHTML, 'первичный рендер печатает ту же разметку');

  // день закрыт отметкой при пропуске — фраза без хвоста, сцена как была
  byId(document, 'mark', 'p-b').click();
  assert.equal(r2Note(document), 'День закрыт');
  assert.equal(tail(), null, 'у закрытого дня хвоста нет');
  assert.ok(note().classList.contains('ok'));
  await r2Scene();
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'день закрыт с пропуском');

  // сплошные пропуски: «0 из 0 · пропусков 2», не закрыт
  unfoldBlock(document, 'Утро');
  byId(document, 'mark', 'p-b').click();
  assert.equal(r2Note(document), '0 из 1 · пропусков 1', 'снятие отметки — хвост вернулся');
  r2SkipBtn(document, 'p-b').click();
  assert.equal(r2Note(document), '0 из 0 · пропусков 2');
  assert.equal(note().classList.contains('ok'), false, 'отдельной фразы нет, «День закрыт» — неправда');
  await settle();
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), 'всё пропущено');
  unfoldBlock(document, 'Утро');
  r2SkipBtn(document, 'p-a').click(); // «Вернуть»
  assert.equal(r2Note(document), '0 из 1 · пропусков 1');
  assertSame(pointVsFull(window, 'scr-today', 'renderToday'), '«Вернуть» — хвост уменьшился');

  // «Прогресс» не меняется
  document.querySelector('#tabs button[data-tab="progress"]').click();
  assert.equal(document.querySelector('#scr-progress .dbar-note').textContent, '0 из 1 сегодня');

  const css = CSS_SRC();
  const rule = ruleOf(css, '.bar-skip');
  assert.match(rule, /color:\s*var\(--muted\)/, 'хвост приглушён существующим токеном');
  assert.doesNotMatch(rule, /font-size|font-weight|--accent|transition|animation/);
});

test('Р3/0.6: motionLeave — transitionend ребёнка карточки уход не обрывает; своё событие — обрывает; fallback затем вхолостую', async () => {
  const { document, window } = await boot({ seed: paramSeed() });
  openReview(document);
  const scr = document.getElementById('scr-review');
  const btn = scr.querySelector('[data-act="param-step"]');
  const card = btn.closest('.card');
  btn.click();
  assert.ok(card.classList.contains('leaving'));

  // переход ребёнка (фокусная рамка, отклик кнопки) всплывает к карточке
  btn.dispatchEvent(new window.Event('transitionend', { bubbles: true }));
  assert.ok(card.isConnected, 'чужой transitionend уход не обрывает');
  assert.ok(scr.querySelector('.card.leaving [data-act="param-step"]'), 'карточка ещё уходит');

  card.dispatchEvent(new window.Event('transitionend', { bubbles: true }));
  assert.equal(scr.querySelector('[data-act="param-step"]'), null, 'своё событие — узел убран перерисовкой');
  assert.match(scr.textContent, /Отбой: 01:30 → 01:15/);
  await settle();
  assert.equal(scr.querySelector('[data-act="param-step"]'), null);
  assert.match(scr.textContent, /Отбой: 01:30 → 01:15/);
});

/* ── Задача Р3, пп. 2–3: предложение обновления и версия ─────────
   В jsdom service worker API нет, поэтому он подменяется целиком до
   загрузки app.js (boot({ sw, reload })): navigator.serviceWorker —
   регистрация и события, воркеры — состояния и сообщения, MessageChannel —
   синхронные порты. Перезагрузка — хук globalThis.MINIMUM_RELOAD: тест
   проверяет, КОГДА она зовётся, а не саму перезагрузку. */

class FakeEmitter {
  constructor() { this.handlers = {}; }
  addEventListener(type, fn) { (this.handlers[type] || (this.handlers[type] = [])).push(fn); }
  removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] || []).filter(f => f !== fn); }
  emit(type, ev = {}) { for (const fn of [...(this.handlers[type] || [])]) fn(ev); }
}

/* Воркер отвечает на {type: 'version'} в переданный порт: 'auto' — в
   следующем такте, 'hold' — по answer(), 'silent' — никогда (воркер v48
   протокола не знает). Все сообщения копятся в sent. */
class FakeWorker extends FakeEmitter {
  constructor(version, state = 'installed', mode = 'auto') {
    super();
    this.version = version;
    this.state = state;
    this.mode = mode;
    this.sent = [];
    this.held = [];
  }
  postMessage(msg, transfer) {
    this.sent.push(JSON.parse(JSON.stringify(msg)));
    const port = transfer && transfer[0];
    if (!msg || msg.type !== 'version' || !port) return;
    if (this.mode === 'auto') setTimeout(() => port.postMessage({ version: this.version }), 0);
    if (this.mode === 'hold') this.held.push(port);
  }
  answer() { for (const p of this.held.splice(0)) p.postMessage({ version: this.version }); }
  setState(s) { this.state = s; this.emit('statechange'); }
}

class FakeChannel {
  constructor() {
    const port1 = { onmessage: null, closed: false, close() { this.closed = true; } };
    this.port1 = port1;
    this.port2 = {
      postMessage: data => { if (!port1.closed && typeof port1.onmessage === 'function') port1.onmessage({ data }); }
    };
  }
}

class FakeRegistration extends FakeEmitter {
  constructor() { super(); this.installing = null; this.waiting = null; this.active = null; this.updates = 0; this.onUpdate = null; }
  update() { this.updates++; return this.onUpdate ? this.onUpdate(this) : Promise.resolve(this); }
}

function fakeSW({ controller = new FakeWorker('minimum-v48', 'activated'), waiting = null } = {}) {
  const sw = new FakeEmitter();
  sw.controller = controller;
  sw.reg = new FakeRegistration();
  sw.reg.active = controller;
  sw.reg.waiting = waiting;
  sw.registered = [];
  sw.register = (url, opts) => {
    sw.registered.push({ url, opts: JSON.parse(JSON.stringify(opts ?? null)) });
    return Promise.resolve(sw.reg);
  };
  return sw;
}

/* Новая версия находится: установка началась (updatefound) … закончилась */
function installNew(sw, version, mode = 'auto') {
  const w = new FakeWorker(version, 'installing', mode);
  sw.reg.installing = w;
  sw.reg.emit('updatefound');
  return w;
}
function finishInstall(sw, w) {
  sw.reg.installing = null;
  sw.reg.waiting = w;
  w.setState('installed');
}

async function waitFor(cond, what, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) assert.fail('не дождались: ' + what);
    await wait(5);
  }
}

async function bootSw({ sw = fakeSW(), seed, timing } = {}) {
  const reloads = [];
  const env = await boot({ seed, timing, sw, reload: () => reloads.push(1) });
  await waitFor(() => sw.registered.length === 1, 'регистрация воркера');
  await waitFor(() => sw.reg.updates >= 1, 'проверка при запуске');
  return { ...env, sw, reloads };
}

const noteEl = document => document.getElementById('update-note');
const offerShown = document => !noteEl(document).hidden;
const toSystem = document => {
  document.querySelector('#tabs button[data-tab="settings"]').click();
  return document.querySelector('#scr-settings .appver');
};
const checkLine = document => document.getElementById('update-check');
const versionBlockHtml = document =>
  document.querySelector('#scr-settings .appver').outerHTML + (checkLine(document)?.outerHTML || '');

test('Р3/2: без ожидающего воркера узел пуст и скрыт; регистрация — ./sw.js с updateViaCache: none, при запуске одна проверка', async () => {
  const { document, sw, reloads } = await bootSw();
  assert.deepEqual(sw.registered, [{ url: './sw.js', opts: { updateViaCache: 'none' } }]);
  assert.equal(sw.reg.updates, 1, 'registration.update() при запуске — один раз');
  await wait(T.VERSION_ASK_MS + 40);
  const note = noteEl(document);
  assert.ok(note, 'постоянный узел в разметке документа');
  assert.equal(note.hidden, true);
  assert.equal(note.innerHTML, '', 'без ожидающего — пуст');
  // рядом с баннером хранилища, вне экранов, объявляется скринридером
  assert.equal(note.previousElementSibling.id, 'storage-note');
  assert.equal(note.closest('section.screen'), null, 'не внутри экранов — renderAll его не рисует');
  assert.equal(note.getAttribute('role'), 'status');
  assert.deepEqual(sw.controller.sent, [{ type: 'version' }], 'активный воркер спрошен о номере — и только');
  assert.deepEqual(reloads, []);
});

test('Р3/2: ожидающий воркер на старте — «Доступна версия v49», «Обновить» — единственный акцент; смена вкладок узел не трогает', async () => {
  const waiting = new FakeWorker('minimum-v49', 'installed');
  const { document, sw, reloads } = await bootSw({ sw: fakeSW({ waiting }) });
  await waitFor(() => offerShown(document), 'предложение');
  const note = noteEl(document);
  assert.equal(note.textContent, 'Доступна версия v49Обновить');
  assert.equal(note.querySelector('span').textContent, 'Доступна версия v49');
  const btns = note.querySelectorAll('button');
  assert.equal(btns.length, 1);
  assert.equal(btns[0].dataset.act, 'update-apply');
  assert.equal(btns[0].textContent, 'Обновить');
  assert.ok(btns[0].classList.contains('btn') && btns[0].classList.contains('primary'), '«Обновить» — .btn.primary');
  assert.equal(note.querySelectorAll('.primary').length, 1, 'акцент в строке один');
  assert.ok(!note.classList.contains('banner'), 'сама строка — не акцентный баннер');
  assert.deepEqual(waiting.sent, [{ type: 'version' }], 'ожидающий спрошен о номере, skipWaiting не слали');

  // renderAll узла не касается: он постоянный, как баннер хранилища
  const before = note.outerHTML;
  for (const t of ['habits', 'progress', 'settings', 'today']) {
    document.querySelector(`#tabs button[data-tab="${t}"]`).click();
    assert.equal(noteEl(document), note, 'тот же узел');
    assert.equal(note.outerHTML, before, t);
  }
  assert.equal(sw.reg.updates, 1);
  assert.deepEqual(reloads, [], 'само по себе предложение ничего не перезагружает');

  // CSS: тон существующими токенами; flex не перебивает hidden
  const css = CSS_SRC();
  assert.match(ruleOf(css, '.upd'), /color:\s*var\(--muted\)/);
  assert.match(ruleOf(css, '.upd'), /font-size:\s*var\(--text-sm\)/);
  assert.match(ruleOf(css, '.upd[hidden]'), /display:\s*none/);
});

test('Р3/2: номер у ожидающего — строка встаёт один раз: с номером по ответу, без номера по таймауту; поздний ответ её не переписывает', async () => {
  // ответ пришёл — «версия v49», и до ответа строки нет
  {
    const waiting = new FakeWorker('minimum-v49', 'installed', 'hold');
    const { document } = await bootSw({ sw: fakeSW({ waiting }), timing: { VERSION_ASK_MS: 1500 } });
    await waitFor(() => waiting.held.length === 1, 'вопрос о номере');
    assert.equal(offerShown(document), false, 'до ответа строки нет — «новая версия» не мелькает');
    waiting.answer();
    await wait(0);
    assert.equal(offerShown(document), true);
    assert.equal(noteEl(document).querySelector('span').textContent, 'Доступна версия v49');
  }
  // не ответил за VERSION_ASK_MS — «новая версия» без номера
  {
    const waiting = new FakeWorker('minimum-v49', 'installed', 'hold');
    const { document } = await bootSw({ sw: fakeSW({ waiting }) });
    await waitFor(() => offerShown(document), 'предложение по таймауту');
    assert.equal(noteEl(document).querySelector('span').textContent, 'Доступна новая версия');
    const html = noteEl(document).outerHTML;
    waiting.answer(); // порт уже закрыт
    await wait(10);
    assert.equal(noteEl(document).outerHTML, html, 'поздний ответ строку не переписывает');
  }
  // ответ не по формату — номера нет
  {
    const waiting = new FakeWorker('1.0', 'installed');
    const { document } = await bootSw({ sw: fakeSW({ waiting }) });
    await waitFor(() => offerShown(document), 'предложение');
    assert.equal(noteEl(document).querySelector('span').textContent, 'Доступна новая версия');
  }
});

test('Р3/2: updatefound → installed при живом контроллере — предложение; без контроллера (первая установка) — нет; вытесненный воркер предложение снимает', async () => {
  {
    const { document, sw } = await bootSw();
    const w = installNew(sw, 'minimum-v49');
    await wait(T.VERSION_ASK_MS + 20);
    assert.equal(offerShown(document), false, 'пока ставится — предложения нет');
    finishInstall(sw, w);
    await waitFor(() => offerShown(document), 'предложение после установки');
    assert.equal(noteEl(document).querySelector('span').textContent, 'Доступна версия v49');

    // более новая версия вытеснила ожидающую: v49 лишний, предложение — v50
    w.setState('redundant');
    assert.equal(offerShown(document), false, 'лишний воркер не предлагается');
    assert.equal(noteEl(document).innerHTML, '');
    const w50 = installNew(sw, 'minimum-v50');
    finishInstall(sw, w50);
    await waitFor(() => offerShown(document), 'новое предложение');
    assert.equal(noteEl(document).querySelector('span').textContent, 'Доступна версия v50');
  }
  {
    // установка сорвалась — предложения нет
    const { document, sw } = await bootSw();
    const w = installNew(sw, 'minimum-v49');
    sw.reg.installing = null;
    w.setState('redundant');
    await wait(T.VERSION_ASK_MS + 30);
    assert.equal(offerShown(document), false);
    assert.deepEqual(w.sent, []);
  }
  {
    // первая установка: контроллера нет — ни по updatefound, ни на старте
    const early = new FakeWorker('minimum-v49', 'installed');
    const sw = fakeSW({ controller: null, waiting: early });
    const { document } = await bootSw({ sw });
    const w = installNew(sw, 'minimum-v49');
    finishInstall(sw, w);
    await wait(T.VERSION_ASK_MS + 40);
    assert.equal(offerShown(document), false, 'без контроллера предложения нет');
    assert.deepEqual([w.sent, early.sent], [[], []], 'и ожидающего никто не спрашивал');
  }
});

test('Р3/2: «Обновить» — взвод и skipWaiting ожидающему, «Обновляю…» без кнопки; перезагружает только controllerchange после взвода, и один раз', async () => {
  const waiting = new FakeWorker('minimum-v49', 'installed');
  const { document, window, sw, reloads } = await bootSw({ sw: fakeSW({ waiting }) });
  await waitFor(() => offerShown(document), 'предложение');

  // чужой claim до тапа — ничего: ни перезагрузки, ни смены строки
  const before = noteEl(document).outerHTML;
  sw.emit('controllerchange');
  assert.deepEqual(reloads, [], 'controllerchange без взвода страницу не перезагружает');
  assert.equal(noteEl(document).outerHTML, before);
  assert.equal(window.eval('ui').updateArmed, false);

  noteEl(document).querySelector('[data-act="update-apply"]').click();
  assert.equal(window.eval('ui').updateArmed, true, 'тап взводит');
  assert.deepEqual(waiting.sent, [{ type: 'version' }, { type: 'skipWaiting' }], 'и шлёт skipWaiting ожидающему');
  assert.equal(noteEl(document).hidden, false);
  assert.equal(noteEl(document).textContent, 'Обновляю…');
  assert.equal(noteEl(document).querySelector('button'), null, 'второго нажатия нет');
  assert.deepEqual(reloads, [], 'сам тап страницу не перезагружает — ждёт активации');

  sw.emit('controllerchange');
  assert.equal(reloads.length, 1, 'новый воркер забрал страницу — перезагрузка');
  sw.emit('controllerchange');
  assert.equal(reloads.length, 1, 'и только одна');
});

test('Р3/2: ожидающий активирован другой вкладкой — её controllerchange ничего не делает, «Обновить» перезагружает этим же тапом', async () => {
  const waiting = new FakeWorker('minimum-v49', 'installed');
  const { document, sw, reloads } = await bootSw({ sw: fakeSW({ waiting }) });
  await waitFor(() => offerShown(document), 'предложение');
  sw.controller = waiting;
  sw.reg.waiting = null;
  waiting.setState('activated');
  sw.emit('controllerchange');
  assert.deepEqual(reloads, [], 'чужой claim — не повод перезагружать');
  assert.equal(offerShown(document), true, 'предложение остаётся: страница ещё на старом коде');
  noteEl(document).querySelector('[data-act="update-apply"]').click();
  assert.equal(reloads.length, 1, 'явный тап — перезагрузка');
  assert.ok(!waiting.sent.some(m => m.type === 'skipWaiting'), 'активному skipWaiting не нужен');
});

test('Р3/2: автопроверка — при запуске и по возвращении из фона не чаще раза в 10 минут; ручная — без троттлинга; отказ сети у автопроверки молчит', async () => {
  const { document, window, sw, reloads } = await bootSw();
  const visible = () => document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(sw.reg.updates, 1, 'при запуске');

  visible();
  await wait(5);
  assert.equal(sw.reg.updates, 1, 'сразу после запуска — рано');
  shiftWindowDate(window, 9 * 60000);
  visible();
  await wait(5);
  assert.equal(sw.reg.updates, 1, 'через 9 минут — рано');
  // уход в фон проверку не зовёт вовсе
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  shiftWindowDate(window, 2 * 60000);
  visible();
  await wait(5);
  assert.equal(sw.reg.updates, 1, 'hidden — не проверка');
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  visible();
  await wait(5);
  assert.equal(sw.reg.updates, 2, 'через 11 минут и видимое — проверка');
  visible();
  await wait(5);
  assert.equal(sw.reg.updates, 2, 'и снова рано');

  // ручная — сколько угодно раз подряд
  toSystem(document);
  for (const n of [3, 4]) {
    document.querySelector('#scr-settings [data-act="update-check"]').click();
    await waitFor(() => checkLine(document).textContent === 'Это последняя версия', 'результат ' + n);
    assert.equal(sw.reg.updates, n, 'ручная проверка не троттлится');
  }

  // отказ сети у автопроверки: ни строки, ни предложения, ни объявления.
  // Владелец всё время на «Настройках» и с вкладки не уходит: смена вкладки
  // сама снимает строку результата, и проверка после неё прошла бы при
  // любом поведении автопроверки (Р3/рецензия)
  const here = () => assert.equal(window.eval('ui').tab, 'settings', 'владелец не уходил с «Настроек»');
  sw.reg.onUpdate = () => Promise.reject(new Error('offline'));
  shiftWindowDate(window, 11 * 60000);
  visible();
  await waitFor(() => sw.reg.updates === 5, 'автопроверка поверх результата ручной');
  await wait(20);
  here();
  assert.equal(checkLine(document).hidden, false);
  assert.equal(checkLine(document).textContent, 'Это последняя версия', 'отказ автопроверки ответ ручной не переписывает');

  // строка пуста — отказ автопроверки её не заполняет
  document.querySelector('#tabs button[data-tab="today"]').click();
  toSystem(document);
  assert.equal(checkLine(document).hidden, true, 'уход с вкладки снял результат ручной проверки');
  shiftWindowDate(window, 11 * 60000);
  visible();
  await waitFor(() => sw.reg.updates === 6, 'автопроверка на «Настройках»');
  await wait(20);
  here();
  assert.equal(checkLine(document).hidden, true, 'автопроверка результата в «Системе» не пишет');
  assert.equal(checkLine(document).textContent, '');
  assert.equal(document.querySelector('#scr-settings [data-act="update-check"]').disabled, false, 'и кнопку не запирает');
  assert.equal(offerShown(document), false);
  assert.equal(document.getElementById('live').textContent, '');
  assert.deepEqual(reloads, []);
});

test('Р3/3: «Система» — «Минимум · v48» из ответа активного воркера; «Проверить обновления»: «Проверяю…» → последняя / нет сети / доступна v49 — и «Обновить» там та же операция; рендер = точечный путь', async () => {
  const controller = new FakeWorker('minimum-v48', 'activated', 'hold');
  const { document, window, sw, reloads } = await bootSw({ sw: fakeSW({ controller }), timing: { VERSION_ASK_MS: 1500 } });
  toSystem(document);
  const line = () => document.getElementById('version-line');
  assert.match(line().closest('details.sect').querySelector('summary').textContent, /^Система/, 'строка — в «Системе»');
  assert.equal(line().closest('.sect-b').lastElementChild, checkLine(document), 'внизу секции');
  assert.equal(line().textContent, 'Минимум', 'номер ещё не пришёл');
  controller.answer();
  await wait(0);
  assert.equal(line().textContent, 'Минимум · v48', 'номер — точечно, в тот же узел');
  assert.ok(line().classList.contains('muted'));
  let html = versionBlockHtml(document);
  window.renderSettings();
  assert.equal(versionBlockHtml(document), html, 'перерисовка печатает то же');
  assert.equal(checkLine(document).hidden, true, 'до проверки результата нет');
  assert.equal(checkLine(document).getAttribute('role'), 'status');

  const btn = () => document.querySelector('#scr-settings [data-act="update-check"]');
  assert.equal(btn().textContent, 'Проверить обновления');
  assert.ok(btn().classList.contains('btn') && !btn().classList.contains('primary'), 'кнопка проверки без акцента');

  // 1) последняя версия: пока update() не ответил — «Проверяю…» и кнопка неактивна
  let release;
  sw.reg.onUpdate = reg => new Promise(r => { release = () => r(reg); });
  btn().click();
  assert.equal(btn().disabled, true);
  assert.equal(checkLine(document).hidden, false);
  assert.equal(checkLine(document).textContent, 'Проверяю…');
  await waitFor(() => typeof release === 'function', 'update() позван');
  btn().click(); // неактивна — второй проверки нет
  await wait(10);
  assert.equal(sw.reg.updates, 2);
  html = versionBlockHtml(document);
  window.renderSettings();
  assert.equal(versionBlockHtml(document), html, 'рендер во время проверки — то же');
  release();
  await waitFor(() => checkLine(document).textContent === 'Это последняя версия', 'последняя');
  assert.equal(btn().disabled, false);
  assert.equal(offerShown(document), false);
  html = versionBlockHtml(document);
  window.renderSettings();
  assert.equal(versionBlockHtml(document), html);
  // без перерисовки узел статуса тот же — скринридер слышит смену текста
  {
    const n = checkLine(document);
    sw.reg.onUpdate = null;
    btn().click();
    assert.equal(checkLine(document), n, 'точечно, не пересоздан');
    assert.equal(n.textContent, 'Проверяю…', 'тот же результат подряд всё равно меняет текст');
    await waitFor(() => checkLine(document).textContent === 'Это последняя версия', 'снова последняя');
    assert.equal(checkLine(document), n);
  }

  // 2) нет сети
  sw.reg.onUpdate = () => Promise.reject(new Error('offline'));
  btn().click();
  await waitFor(() => checkLine(document).textContent === 'Не удалось проверить — нет сети?', 'отказ');
  assert.equal(btn().disabled, false);
  assert.ok(checkLine(document).classList.contains('muted'));
  assert.equal(offerShown(document), false);

  // 3) установка началась и сорвалась — последняя версия
  sw.reg.onUpdate = reg => {
    const w = installNew(sw, 'minimum-v49');
    setTimeout(() => { sw.reg.installing = null; w.setState('redundant'); }, 5);
    return Promise.resolve(reg);
  };
  btn().click();
  await waitFor(() => checkLine(document).textContent === 'Это последняя версия', 'сорвавшаяся установка');
  assert.equal(offerShown(document), false);

  // 4) найдена v49: строка на месте и предложение над экраном
  let found;
  sw.reg.onUpdate = reg => {
    found = installNew(sw, 'minimum-v49');
    setTimeout(() => finishInstall(sw, found), 5);
    return Promise.resolve(reg);
  };
  btn().click();
  await waitFor(() => /^Доступна v49/.test(checkLine(document).textContent), 'найдено');
  assert.equal(checkLine(document).querySelector('span').textContent, 'Доступна v49');
  const apply = checkLine(document).querySelector('button');
  assert.equal(apply.dataset.act, 'update-apply');
  assert.ok(apply.classList.contains('primary'));
  assert.equal(checkLine(document).querySelectorAll('.primary').length, 1);
  assert.equal(offerShown(document), true, 'и глобальная строка появилась');
  assert.equal(noteEl(document).querySelector('span').textContent, 'Доступна версия v49');
  html = versionBlockHtml(document);
  window.renderSettings();
  assert.equal(versionBlockHtml(document), html);

  // «Обновить» в «Системе» — та же операция
  checkLine(document).querySelector('button').click();
  assert.equal(window.eval('ui').updateArmed, true);
  assert.deepEqual(found.sent, [{ type: 'version' }, { type: 'skipWaiting' }]);
  assert.equal(checkLine(document).textContent, 'Обновляю…');
  assert.equal(noteEl(document).textContent, 'Обновляю…');
  html = versionBlockHtml(document);
  window.renderSettings();
  assert.equal(versionBlockHtml(document), html);
  assert.deepEqual(reloads, []);
  sw.emit('controllerchange');
  assert.equal(reloads.length, 1);
});

test('Р3/3: результат проверки — строка на месте: уход с «Настроек» его снимает, результат, пришедший после ухода, не хранится', async () => {
  const { document, sw } = await bootSw();
  toSystem(document);
  document.querySelector('#scr-settings [data-act="update-check"]').click();
  await waitFor(() => checkLine(document).textContent === 'Это последняя версия', 'результат');
  document.querySelector('#tabs button[data-tab="settings"]').click(); // та же вкладка — остаётся
  assert.equal(checkLine(document).textContent, 'Это последняя версия');
  document.querySelector('#tabs button[data-tab="today"]').click();
  toSystem(document);
  assert.equal(checkLine(document).hidden, true, 'после ухода — нет');

  let release;
  sw.reg.onUpdate = reg => new Promise(r => { release = () => r(reg); });
  document.querySelector('#scr-settings [data-act="update-check"]').click();
  document.querySelector('#tabs button[data-tab="progress"]').click();
  await waitFor(() => typeof release === 'function', 'update() позван');
  release();
  await wait(20);
  toSystem(document);
  assert.equal(checkLine(document).hidden, true, 'пришедший вне «Настроек» — не хранится');
  assert.equal(document.querySelector('#scr-settings [data-act="update-check"]').disabled, false);
});

test('Р3/3: версия не определена — без контроллера, без ответа, при ответе не по формату; без service worker API нет ни кнопки, ни предложения', async () => {
  {
    const { document } = await boot();
    toSystem(document);
    assert.equal(document.getElementById('version-line').textContent, 'Минимум · версия не определена');
    assert.equal(document.querySelector('#scr-settings [data-act="update-check"]'), null, 'проверять нечем');
    assert.equal(checkLine(document), null);
    assert.equal(noteEl(document).hidden, true);
    assert.ok(document.getElementById('version-line').classList.contains('muted'), 'приглушённо, без тревоги');
  }
  {
    const { document } = await bootSw({ sw: fakeSW({ controller: null }) });
    toSystem(document);
    assert.equal(document.getElementById('version-line').textContent, 'Минимум · версия не определена');
    assert.ok(document.querySelector('#scr-settings [data-act="update-check"]'), 'а проверить можно');
  }
  {
    const { document } = await bootSw({ sw: fakeSW({ controller: new FakeWorker('minimum-v48', 'activated', 'silent') }) });
    toSystem(document);
    await waitFor(() => document.getElementById('version-line').textContent === 'Минимум · версия не определена', 'таймаут ответа');
  }
  {
    const { document } = await bootSw({ sw: fakeSW({ controller: new FakeWorker('v48', 'activated') }) });
    await wait(20);
    toSystem(document);
    assert.equal(document.getElementById('version-line').textContent, 'Минимум · версия не определена', 'ответ не по формату');
  }
});

/* ── Р3/рецензия: ремонт после рецензии ─────────────────────── */

/* Взвод принадлежит предложенному воркеру: вытеснен он — взвод снят
   (dropOffer). Иначе новое предложение печаталось бы «Обновляю…» без
   кнопки, а любой controllerchange (claim другой вкладки) перезагрузил бы
   страницу без тапа — прямое нарушение инварианта 23. Прежний тест
   вытеснял воркер без тапа, и снятие взвода не держал никто (мутант
   рецензии: 687 из 687 зелёных). */
test('Р3/рецензия: «Обновить» нажата, а предложенный воркер вытеснен — взвод снят; новое предложение с кнопкой; чужой controllerchange не перезагружает', async () => {
  const waiting = new FakeWorker('minimum-v49', 'installed');
  const { document, window, sw, reloads } = await bootSw({ sw: fakeSW({ waiting }) });
  await waitFor(() => offerShown(document), 'предложение');
  noteEl(document).querySelector('[data-act="update-apply"]').click();
  assert.equal(window.eval('ui').updateArmed, true, 'взведено');
  assert.equal(noteEl(document).textContent, 'Обновляю…');

  waiting.setState('redundant');
  assert.equal(window.eval('ui').updateArmed, false, 'вытесненный воркер уносит взвод с собой');
  assert.equal(noteEl(document).hidden, true);
  assert.equal(noteEl(document).innerHTML, '');
  sw.emit('controllerchange');
  assert.deepEqual(reloads, [], 'без предложения и взвода controllerchange — ничего');

  const w50 = installNew(sw, 'minimum-v50');
  finishInstall(sw, w50);
  await waitFor(() => offerShown(document), 'новое предложение');
  assert.equal(noteEl(document).querySelector('span').textContent, 'Доступна версия v50');
  const btn = noteEl(document).querySelector('[data-act="update-apply"]');
  assert.ok(btn, 'кнопка «Обновить» снова есть — обновиться владельцу есть чем');
  sw.emit('controllerchange');
  assert.deepEqual(reloads, [], 'чужой claim до нового тапа страницу не перезагружает');
  assert.ok(!w50.sent.some(m => m.type === 'skipWaiting'), 'и v50 без тапа не активирован');

  btn.click();
  assert.deepEqual(w50.sent.map(m => m.type), ['version', 'skipWaiting'], 'новый тап — skipWaiting новому ожидающему');
  sw.emit('controllerchange');
  assert.equal(reloads.length, 1, 'перезагрузка — по новому взводу');
});

/* Ветка habitsSection «секция из одних убранных без короткого пути не
   рисуется». До Р3 её держал тест Р1/B через пустые блоки; habitSections
   пустых секций не отдаёт, а убранные отдаёт — и ветка осталась без
   сторожа (мутант рецензии: dom.test.js зелёный целиком). */
test('Р3/рецензия: «Настройки → Привычки» — секция из одних убранных привычек без короткого пути не рисуется: ни заголовка блока, ни «Без блока», ни пустого списка; с коротким путём — рисуется', async () => {
  const seed = r1SettingsSeed();
  seed.items = seed.items.filter(i => i.id !== 'ph'); // без параметра «без блока»
  seed.items.push(r1Action('rh', 'Бывшая', daysAgo(10), 'Утро', R1_ALL, { area: 'habit', normPerWeek: 7, removedAt: daysAgo(4) }));
  seed.items.push(r1Action('rn', 'Сон', daysAgo(10), '', R1_ALL, { area: 'habit', normPerWeek: 7, removedAt: daysAgo(3) }));
  const { document, window } = await boot({ seed });
  r1Settings(document);
  const body = () => openSect(document, /Привычки/).querySelector('.sect-b');
  const labels = () => [...body().querySelectorAll(':scope > .g-label')].map(l => l.textContent);
  const lists = () => [...body().querySelectorAll(':scope > .list')];
  assert.deepEqual(labels(), ['Школа'], 'заголовок — только у блока с живой привычкой');
  assert.equal(lists().filter(l => !l.children.length).length, 0, 'пустых списков нет');
  assert.deepEqual(lists().map(l => [...l.querySelectorAll('[data-act="edit-open"], [data-act="item-restore"]')]
    .map(b => b.dataset.id)), [['sh'], ['rh', 'rn']], '«Школа» и «Убранные» — обе убранные там, дорога назад цела');

  // короткий путь назад у убранной «без блока» — секция рисуется ради него
  window.eval('ui').goneNote = 'rn';
  window.renderSettings();
  assert.deepEqual(labels(), ['Школа', 'Без блока'], 'короткий путь — строка, и «Без блока» стоит над ней');
  const note = body().querySelector(':scope > .list > .gone-note');
  assert.ok(note && /^Сон · /.test(note.textContent), 'строка короткого пути в своём списке');
  assert.equal(lists().filter(l => !l.children.length).length, 0);
  assert.equal(note.querySelector('[data-act="item-restore"]').dataset.id, 'rn');
  // и то же у убранной в живом блоке: заголовок блока — над её строкой
  window.eval('ui').goneNote = 'rh';
  window.renderSettings();
  assert.deepEqual(labels(), ['Утро', 'Школа'], 'короткий путь у «Бывшей» — заголовок «Утро»');
  assert.equal(body().querySelector(':scope > .g-label + .list > .gone-note [data-act="item-restore"]').dataset.id, 'rh');
});

/* С задачи Р3 имя, которое держит только блок убранного режима, стоит в
   «Без блока» «Настроек». Соседи по сырому item.group оставляли его строку
   посреди списка с обеими неактивными стрелками, A↓ уводило A через её
   голову ([B, L, A]), перетащить строку было нельзя (замер рецензии). */
test('Р3/рецензия: «Убрать режим» — привычка его блока встаёт в «Без блока» одним списком, и стрелки, и перетаскивание ведут её к видимому соседу', async () => {
  const since = addKey(curMonday(), -14);
  const habit = (id, name, group) => r1Action(id, name, since, group, R1_ALL, { area: 'habit', normPerWeek: 7 });
  const { document, window } = await boot({
    seed: r2UiSeed({ items: [habit('hA', 'Альфа', ''), habit('hL', 'Плавание', 'Лагерь'), habit('hB', 'Бета', ''), habit('h1', 'Чтение', 'Утро')] })
  });
  const saved = () => r1Saved(window).items.map(i => i.id);
  const noBlock = () => {
    const body = openSect(document, /Привычки/).querySelector('.sect-b');
    const head = [...body.querySelectorAll(':scope > .g-label')].find(l => l.textContent === 'Без блока');
    return head ? head.nextElementSibling : null;
  };
  const rows = () => [...noBlock().querySelectorAll('[data-drag="item"]')];
  const arrows = () => rows().map(r => [r.dataset.dragId,
    !r.querySelector('[data-act="move-up"]').disabled, !r.querySelector('[data-act="move-down"]').disabled]);

  r2OpenModes(document);
  r2Btn(document, 'mode-remove', R2_KAN).click();
  r2Btn(document, 'mode-remove', R2_KAN).click();
  assert.ok(r1Saved(window).modes.find(m => m.id === R2_KAN).removedAt, 'режим «Каникулы» убран');

  assert.deepEqual(rows().map(r => [r.dataset.dragId, r.dataset.dgroup]), [['hA', ''], ['hL', ''], ['hB', '']],
    '«Плавание» — в «Без блока», и для перетаскивания секция та же');
  assert.deepEqual(arrows(), [['hA', false, true], ['hL', true, true], ['hB', true, false]],
    'ни одна живая строка не заперта: у каждой — стрелки к видимому соседу');

  byId(document, 'move-down', 'hA').click();
  assert.deepEqual(saved(), ['hL', 'hA', 'hB', 'h1'], 'A встал за L — на одну строку, а не через её голову');
  assert.deepEqual(arrows(), [['hL', false, true], ['hA', true, true], ['hB', true, false]]);

  // перетаскивание: Бета — наверх списка «Без блока»
  stubRows(rows());
  rows()[2].dispatchEvent(pointer(window, 'pointerdown', 100, 350));
  await hold();
  document.dispatchEvent(pointer(window, 'pointermove', 100, 205));
  document.dispatchEvent(pointer(window, 'pointerup', 100, 205));
  assert.deepEqual(saved(), ['hB', 'hL', 'hA', 'h1'], 'строка «Лагеря» среди соседей «Без блока» считается');
  assert.deepEqual(rows().map(r => r.dataset.dragId), ['hB', 'hL', 'hA'], 'экран — в том же порядке');

  // режим вернулся — «Плавание» снова под «Лагерем» и соседей там не ищет
  r2OpenModes(document);
  r2Btn(document, 'mode-restore', R2_KAN).click();
  assert.deepEqual(rows().map(r => [r.dataset.dragId, r.dataset.dgroup]), [['hB', ''], ['hA', '']]);
  assert.deepEqual(arrows(), [['hB', false, true], ['hA', true, false]]);
  const camp = [...openSect(document, /Привычки/).querySelectorAll('.sect-b > .g-label')].find(l => l.textContent === 'Лагерь');
  const lr = camp.nextElementSibling.querySelector('[data-drag="item"]');
  assert.deepEqual([lr.dataset.dragId, lr.dataset.dgroup, lr.querySelector('[data-act="move-up"]').disabled, lr.querySelector('[data-act="move-down"]').disabled],
    ['hL', 'Лагерь', true, true]);
});
