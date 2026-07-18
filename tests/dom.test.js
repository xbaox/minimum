'use strict';
/* Дымовые DOM-тесты в jsdom.
   app.js исполняется через vm в контексте window (см. CLAUDE.md, «Тесты»):
   в контексте jsdom нет module, поэтому ветка module.exports не срабатывает
   и app.js идёт по браузерному пути. К моменту запуска кода DOMContentLoaded
   в jsdom уже отстрелял, так что init() вызывается вручную ровно один раз. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

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

async function boot({ seed } = {}) {
  const dom = new JSDOM(HTML, {
    url: 'https://example.org/minimum/',
    runScripts: 'outside-only',
    pretendToBeVisual: true
  });
  const { window } = dom;
  if (window.document.readyState !== 'complete') {
    await new Promise(res => window.addEventListener('load', res));
  }
  window.scrollTo = () => {}; // в jsdom не реализовано — глушим шум
  if (seed) window.localStorage.setItem(NS, JSON.stringify(seed));
  vm.runInContext(APP, dom.getInternalVMContext());
  assert.equal(typeof window.init, 'function', 'app.js должен определить init() в window');
  window.init();
  return { window, document: window.document };
}

/* Минимальный валидный store с назревшим разбором; migrate достроит остальное */
function dueSeed() {
  return {
    schemaVersion: 2,
    items: [{
      id: 'it1', name: 'Тестовый пункт', value: 10, unit: 'мин', type: 'daily',
      goal: null, note: '', group: '', active: true,
      addedAt: daysAgo(10), raiseAfter: 0, history: [{ date: daysAgo(10), value: 10 }]
    }],
    days: { [daysAgo(1)]: { it1: true }, [daysAgo(2)]: { it1: true } },
    weekLog: [], reviews: [], pendingRaises: [],
    draftOneChange: '', weekStart: daysAgo(8),
    settings: { dayBoundary: 4, hintShownForItemId: null }
  };
}

test('init() отрабатывает: экран «Сегодня» отрисован, остальные скрыты', async () => {
  const { document } = await boot();
  const today = document.getElementById('scr-today');
  assert.equal(today.hidden, false);
  assert.ok(today.innerHTML.length > 0);
  assert.equal(today.querySelectorAll('input[data-act="mark"]').length, 6); // 6 дневных пунктов по умолчанию
  assert.ok(today.querySelector('.weekcount'));                            // недельный счётчик
  assert.match(today.textContent, /Минимум выполняется даже в худший день/);
  for (const id of ['scr-review', 'scr-items', 'scr-system']) {
    assert.equal(document.getElementById(id).hidden, true, id);
  }
});

test('вкладки переключают все 4 экрана, каждый рендерится без исключений', async () => {
  const { document } = await boot();
  const tabs = [...document.querySelectorAll('#tabs button')];
  assert.equal(tabs.length, 4);
  const map = { today: 'scr-today', review: 'scr-review', items: 'scr-items', system: 'scr-system' };
  const marker = {
    today: /Минимум выполняется/,
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

  // сетка 7 дней и кнопка закрытия
  assert.ok(document.querySelector('.grid'));
  assert.equal(document.querySelectorAll('.grid i').length, 7); // один пункт × 7 дней
  const closeBtn = document.querySelector('[data-act="close-week"]');
  assert.ok(closeBtn);

  closeBtn.click();

  assert.match(document.getElementById('scr-review').textContent, /Неделя закрыта/);
  const saved = JSON.parse(window.localStorage.getItem(NS));
  assert.equal(saved.reviews.length, 1);
  assert.equal(saved.reviews[0].perItem.it1.count, 2);
  assert.deepEqual(saved.weekLog, []);
  assert.equal(saved.weekStart, daysAgo(0));
});
