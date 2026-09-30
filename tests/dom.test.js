process.env.TZ = 'America/Toronto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { boot } from '../app.js';
import { normalize } from '../domain.js';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const WED = new Date(2026, 8, 30, 9, 0); // среда 30 сентября, утро
const sp = s => s.replace(/\u00a0/g, ' '); // неразрывные пробелы → обычные для сравнения

async function start(when, { storage = {}, idb = new IDBFactory() } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented: navigation/.test(e.message)) errors.push(e); });
  vc.on('error', e => errors.push(e));
  const dom = new JSDOM(HTML, { url: 'https://xbaox.github.io/minimum/', pretendToBeVisual: true, virtualConsole: vc });
  const win = dom.window;
  for (const [k, v] of Object.entries(storage)) win.localStorage.setItem(k, v);
  const t = { now: when };
  const app = await boot({ win, now: () => t.now, idb });
  const doc = win.document;
  const dump = () => {
    const o = {};
    for (let i = 0; i < win.localStorage.length; i++) { const k = win.localStorage.key(i); o[k] = win.localStorage.getItem(k); }
    return o;
  };
  const all = sel => [...doc.querySelectorAll(sel)];
  const find = (text, sel = 'button, label') => {
    const el = all(sel).find(e => sp(e.textContent).includes(text));
    assert.ok(el, 'не найдено: ' + text);
    return el;
  };
  const click = (text, sel) => find(text, sel).click();
  const type = (el, value) => { el.value = value; el.dispatchEvent(new win.Event('input', { bubbles: true })); };
  const rows = () => doc.querySelectorAll('.list-min > .row');
  const text = () => sp(doc.querySelector('.screen').textContent);
  const sheet = () => doc.querySelector('.sheet');
  const alertBox = () => doc.querySelector('.alert');
  const alertBtn = label => [...alertBox().querySelectorAll('button')].find(b => b.textContent === label).click();
  const done = () => { assert.deepEqual(errors.map(String), []); win.close(); };
  return { win, doc, app, t, idb, dump, all, find, click, type, rows, text, sheet, alertBox, alertBtn, done, errors };
}

const reboot = async (prev, when = prev.t.now) => {
  const storage = prev.dump();
  prev.done();
  return start(when, { storage, idb: prev.idb });
};

test('первый старт со старыми ключами: стёрто, 8 строк, приветствие один раз', async () => {
  const idb = new IDBFactory();
  await new Promise(ok => { const r = idb.open('minimum', 1); r.onupgradeneeded = () => r.result.createObjectStore('x'); r.onsuccess = () => { r.result.close(); ok(); }; });
  const a = await start(WED, {
    idb,
    storage: { 'minimum:data': '{"old":1}', 'minimum:data:corrupt': 'x', 'minimum:data:wiped': '1', 'englishSummer.v2': 'соседи' },
  });
  const keys = Object.keys(a.dump()).sort();
  assert.deepEqual(keys, ['englishSummer.v2', 'minimum.v2']);
  assert.ok(!(await idb.databases()).some(d => d.name === 'minimum'));
  assert.equal(a.rows().length, 8);
  assert.match(a.text(), /Новый минимум/);
  assert.match(a.text(), /8 пунктов, одинаковых каждый день/);
  assert.match(a.text(), /среда, 30 сентября/);
  assert.match(a.text(), /Отбой 01:00 · цель 23:30/);
  assert.match(a.text(), /телефон на кухню до 00:30 · подъём 7:30/);
  assert.equal(a.doc.querySelectorAll('.list-week > .row').length, 1); // Тренировка
  assert.equal(a.doc.querySelectorAll('.tile svg path').length > 8, true); // значки, а не эмодзи
  a.click('Понятно');
  assert.doesNotMatch(a.text(), /Новый минимум/);
  const b = await reboot(a);
  assert.doesNotMatch(b.text(), /Новый минимум/);
  assert.equal(b.rows().length, 8);
  b.done();
});

test('в разметке нет текста «null», «undefined», «NaN» — на вкладках, в листах и подтверждениях', async () => {
  const a = await start(WED);
  const clean = where => assert.doesNotMatch(a.doc.getElementById('app').textContent, /null|undefined|NaN/, where);
  for (const tab of ['Сегодня', 'Прогресс', 'Настройки']) {
    a.click(tab, '.tab');
    clean(tab);
  }
  a.click('Правила', '.row'); clean('правила'); a.click('Готово', '.sheet-act');
  a.click('Добавить пункт'); clean('новый пункт'); a.click('Отмена', '.sheet-act');
  a.find('Спорт', '.row').click(); a.click('Убрать из минимума', '.sheet button'); clean('подтверждение'); a.alertBtn('Отмена');
  a.click('Отмена', '.sheet-act');
  a.t.now = new Date(2026, 9, 4, 20, 0);
  a.click('Сегодня', '.tab');
  a.click('Итоги недели', '.banner button'); clean('итоги');
  a.done();
});

test('тап отмечает и снимает; 8 из 8 → «День закрыт» с откликом один раз', async () => {
  const a = await start(WED);
  const r0 = () => a.rows()[0];
  r0().click();
  assert.equal(r0().getAttribute('aria-pressed'), 'true');
  assert.ok(r0().classList.contains('pop')); // галочка появляется только у тронутой строки
  assert.match(a.text(), /1 из 8/);
  assert.match(a.text(), /минимум · осталось 7/);
  a.app.render();
  assert.equal(r0().classList.contains('pop'), false);
  r0().click();
  assert.equal(r0().getAttribute('aria-pressed'), 'false');
  assert.match(a.text(), /0 из 8/);
  for (let i = 0; i < 8; i++) a.rows()[i].click();
  assert.match(a.text(), /8 из 8/);
  assert.match(a.text(), /День закрыт/);
  assert.ok(a.doc.querySelector('.screen.celebrate'));
  assert.equal(a.doc.querySelectorAll('.seg.on').length, 8);
  a.app.render();
  assert.equal(a.doc.querySelector('.screen.celebrate'), null); // перерисовка не повторяет праздник
  assert.equal(a.doc.querySelector('.streak').getAttribute('aria-label'), 'Серия 1');
  a.done();
});

test('у «Телефон на кухню» дедлайн от шага: до 00:30', async () => {
  const a = await start(WED);
  const phone = [...a.rows()].find(r => r.textContent.includes('Телефон на кухню'));
  assert.match(sp(phone.textContent), /будильник заведён — и на кухню · до 00:30/);
  a.done();
});

test('название пункта внутри фразы: строчная первая буква, аббревиатуры не трогаем', async () => {
  const a = await start(WED);
  const S = a.app.state;
  assert.match(a.text(), /телефон на кухню до 00:30/);
  S.items.find(i => i.beforeBed).name = 'iPhone на кухню';
  S.weekly[0].name = 'ЕГЭ-тренировка';
  a.app.render();
  assert.match(a.text(), /iPhone на кухню до 00:30/);
  a.click('Прогресс', '.tab');
  assert.match(a.doc.querySelector('.dots-legend').textContent, /ЕГЭ-тренировка/);
  a.done();
});

test('герой: кольца минимума, сна и тренировок', async () => {
  const a = await start(WED);
  const S = a.app.state;
  const label = () => sp(a.doc.querySelector('.rings').getAttribute('aria-label'));
  assert.equal(label(), 'Минимум 0 из 8, сон — нет данных, Тренировка 0 из 3');
  a.rows()[0].click();
  a.find('Тренировка', '.list-week .row').click();
  S.sleep.nights['2026-09-30'] = { bed: '00:50', wake: '07:30' };
  a.app.render();
  assert.equal(label(), 'Минимум 1 из 8, сон 1 из 1 в цель, Тренировка 1 из 3');
  assert.deepEqual([...a.doc.querySelectorAll('.hero .lg-val')].map(e => sp(e.textContent)), ['1/1 в цель', '1/3']);
  assert.match(a.doc.querySelector('.list-week').textContent, /✓ 1 из 3/);
  assert.equal(a.doc.querySelectorAll('.arc').length, 3);
  a.done();
});

test('ночь: чипы утром, итог в карточке, «Готово» → строка героя; вечером — «не отмечена»', async () => {
  const a = await start(WED);
  const group = label => a.doc.querySelector(`.sleep-card [role=group][aria-label="${label}"]`);
  const chip = (label, v) => [...group(label).querySelectorAll('button')].find(b => b.textContent === v);
  assert.ok(chip('Лёг', '01:00').classList.contains('mark'));
  assert.deepEqual([...group('Лёг').querySelectorAll('button')].map(b => b.textContent), ['00:00', '00:30', '01:00', '01:30', '02:00', '02:30', '03:00']);
  assert.deepEqual([...group('Встал').querySelectorAll('button')].map(b => b.textContent), ['6:30', '7:00', '7:30', '8:00', '8:30', '9:00']);
  chip('Лёг', '01:00').click();
  chip('Встал', '7:30').click();
  // карточка остаётся открытой и показывает итог
  assert.match(sp(a.doc.querySelector('.strip').textContent), /Сон 6 ч 30 мин · в цель/);
  chip('Лёг', '01:30').click();
  assert.match(sp(a.doc.querySelector('.strip').textContent), /Сон 6 ч · на 30 мин позже шага/);
  a.click('Готово', '.sec-h button');
  assert.equal(a.doc.querySelector('.sleep-card'), null);
  assert.match(a.text(), /прошлая ночь 6 ч · на 30 мин позже шага/);
  // тап по строке сна — снова правка
  a.doc.querySelector('.sleep-btn').click();
  assert.ok(a.doc.querySelector('.sleep-card'));
  // «Другое» — родной выбор времени (не в фокусе — применяется сразу)
  const other = group('Лёг').querySelector('input[type=time]');
  other.value = '01:10';
  other.dispatchEvent(new a.win.Event('change', { bubbles: true }));
  assert.match(sp(a.doc.querySelector('.strip').textContent), /на 10 мин позже шага/);
  assert.equal(a.app.state.sleep.nights['2026-09-30'].bed, '01:10');
  // вечер следующего дня: ночь не отмечена
  a.t.now = new Date(2026, 9, 1, 19, 0);
  a.app.render();
  assert.equal(a.doc.querySelector('.sleep-card'), null);
  assert.match(a.text(), /прошлая ночь не отмечена/);
  a.done();
});

test('барабан времени в фокусе не перерисовывает экран до закрытия', async () => {
  const a = await start(WED);
  const input = a.doc.querySelector('.sleep-card [aria-label="Лёг: другое время"]');
  input.focus();
  assert.equal(a.doc.activeElement, input);
  input.value = '01:20';
  input.dispatchEvent(new a.win.Event('change', { bubbles: true }));
  assert.equal(input.isConnected, true); // экран не перерисован — iOS не закроет барабан
  assert.equal(a.app.state.sleep.nights['2026-09-30'], undefined);
  input.blur();
  assert.equal(a.app.state.sleep.nights['2026-09-30'].bed, '01:20');
  assert.equal(input.isConnected, false);
  a.done();
});

test('выбор из барабана не теряется, если экран перерисовался до его закрытия', async () => {
  const a = await start(WED);
  const input = a.doc.querySelector('.sleep-card [aria-label="Встал: другое время"]');
  input.focus();
  input.value = '07:10';
  input.dispatchEvent(new a.win.Event('change', { bubbles: true }));
  a.app.render(); // например, пришло обновление или сменился день
  assert.equal(a.app.state.sleep.nights['2026-09-30'].wake, '07:10');
  // Настройки: поле цели в фокусе — значение сохраняется, экран не перерисован
  a.click('Настройки', '.tab');
  const goal = a.doc.querySelector('.time-row input[aria-label="Цель отбоя"]');
  goal.focus();
  goal.value = '23:00';
  goal.dispatchEvent(new a.win.Event('change', { bubbles: true }));
  assert.equal(goal.isConnected, true);
  goal.blur();
  assert.equal(a.app.state.sleep.goalBed, '23:00');
  assert.match(goal.closest('.time-row').textContent, /23:00/);
  a.done();
});

test('карточка ночи сворачивается, когда приложение уходит в фон', async () => {
  const a = await start(WED);
  const chip = (label, v) => [...a.doc.querySelector(`.sleep-card [aria-label="${label}"]`).querySelectorAll('button')].find(b => b.textContent === v);
  chip('Лёг', '01:00').click();
  chip('Встал', '7:30').click();
  assert.ok(a.doc.querySelector('.sleep-card'));
  Object.defineProperty(a.doc, 'visibilityState', { configurable: true, get: () => 'hidden' });
  a.doc.dispatchEvent(new a.win.Event('visibilitychange'));
  Object.defineProperty(a.doc, 'visibilityState', { configurable: true, get: () => 'visible' });
  a.doc.dispatchEvent(new a.win.Event('visibilitychange'));
  assert.equal(a.doc.querySelector('.sleep-card'), null);
  assert.match(a.text(), /прошлая ночь 6 ч 30 мин · в цель/);
  a.done();
});

test('вчера можно доотметить, позавчера — нет', async () => {
  const a = await start(WED);
  a.t.now = new Date(2026, 9, 1, 9, 0);
  a.app.render();
  a.click('Вчера: 0 из 8');
  assert.match(a.text(), /доотметить можно до 4:00/);
  const yRows = () => a.doc.querySelectorAll('.yesterday .row[aria-pressed]');
  assert.equal(yRows().length, 8);
  yRows()[0].click();
  assert.match(a.text(), /Вчера: 1 из 8/);
  assert.deepEqual(a.app.state.days['2026-09-30'].done.length, 1);
  a.t.now = new Date(2026, 9, 2, 9, 0);
  a.app.render();
  assert.match(a.text(), /Вчера: 0 из 8/); // 1 октября
  assert.doesNotMatch(a.text(), /Вчера: 1 из 8/);
  assert.match(a.text(), /Вчера пропуск — сегодня не пропускай дважды/);
  a.done();
});

test('воскресенье: баннер → итоги → выбор → новый шаг; с понедельника строка 1%', async () => {
  const a = await start(WED);
  const S = a.app.state;
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) S.sleep.nights[d] = { bed: '00:50', wake: '07:30' };
  a.t.now = new Date(2026, 9, 4, 20, 0); // вс 4 октября
  a.app.render();
  // «Отмена» — ничего не сохраняется
  a.click('Итоги недели', '.banner button');
  assert.ok(a.sheet());
  a.click('Раньше на 30 минут', '.sheet button');
  a.click('Отмена', '.sheet-act');
  assert.equal(a.sheet(), null);
  assert.deepEqual(S.reviews, {});
  a.click('Итоги недели', '.banner button');
  const close = () => a.find('Закрыть неделю', '.sheet button');
  assert.equal(close().disabled, true);
  assert.match(sp(a.sheet().textContent), /Выбор нужен, чтобы закрыть неделю\. Цель — 23:30\./);
  assert.match(sp(a.sheet().textContent), /В цель 4 из 4/);
  assert.equal(a.sheet().querySelectorAll('.mini').length, 7);
  const rec = a.sheet().querySelector('.opt.rec');
  assert.match(sp(rec.textContent), /Раньше на 30 минут/);
  assert.match(sp(rec.textContent), /рекомендовано/);
  assert.match(sp(rec.textContent), /отбой 00:30 · телефон на кухню до 00:00/);
  rec.click();
  assert.equal(close().disabled, false);
  assert.match(sp(a.sheet().textContent), /Со следующей ночи отбой 00:30\. Передвинь сигнал «Телефон на кухню» на 00:00\./);
  a.type(a.sheet().querySelector('textarea'), 'держал отбой');
  a.click('Книга в кровать вместо телефона', '.sheet button');
  assert.equal(a.sheet().querySelector('input[aria-label="1% на следующую неделю"]').value, 'Книга в кровать вместо телефона');
  assert.equal(a.sheet().querySelector('textarea').value, 'держал отбой'); // черновик пережил перерисовку
  a.sheet().querySelector('[role=switch]').click();
  assert.equal(a.sheet().querySelector('[role=switch]').getAttribute('aria-checked'), 'true');
  close().click();
  assert.equal(a.sheet(), null);
  assert.match(a.doc.querySelector('.bars').textContent, /Неделя закрыта/);
  assert.equal(S.reviews['2026-09-28'].sleep.to, '00:30');
  assert.equal(S.reviews['2026-09-28'].good, 'держал отбой');
  assert.equal(S.reviews['2026-09-28'].notesDone, true);
  assert.deepEqual(S.sleep.targets.at(-1), { from: '2026-10-05', bed: '00:30' });
  assert.equal(a.doc.querySelector('.banner'), null);
  assert.match(a.text(), /Отбой 00:30/);
  const b = await reboot(a, new Date(2026, 9, 5, 9, 0));
  assert.match(b.text(), /1% недели/);
  assert.match(b.text(), /Книга в кровать вместо телефона/);
  assert.match(b.text(), /до 00:00/);
  assert.doesNotMatch(b.text(), /Итоги прошлой недели/);
  b.t.now = new Date(2026, 9, 12, 9, 0); // через неделю строка уходит, а незакрытая прошлая — баннер
  b.app.render();
  assert.doesNotMatch(b.text(), /1% недели/);
  assert.match(b.text(), /Итоги прошлой недели/);
  b.done();
});

test('итоги: незаполненные ночи дозаполняются по памяти', async () => {
  const a = await start(WED);
  a.t.now = new Date(2026, 9, 4, 20, 0);
  a.app.render();
  a.click('Итоги недели', '.banner button');
  assert.match(sp(a.sheet().textContent), /Ночи по памяти/);
  const night = [...a.sheet().querySelectorAll('.sleep-card')].find(c => sp(c.textContent).includes('чт, 1 октября'));
  [...night.querySelectorAll('[aria-label="Лёг"] button')].find(b => b.textContent === '00:30').click();
  assert.equal(a.app.state.sleep.nights['2026-10-01'].bed, '00:30');
  assert.ok(a.sheet()); // лист остался открытым
  a.done();
});

test('Настройки: добавить (11-й — переспрос), переименовать, ↑↓, убрать и вернуть', async () => {
  const a = await start(WED);
  a.click('Настройки', '.tab');
  const names = () => [...a.all('.screen > .group')[0].querySelectorAll('.row .name')].map(n => n.textContent).filter(n => n !== 'Добавить пункт');
  const doneBtn = () => a.doc.getElementById('sheet-done');
  const add = name => {
    a.type(a.sheet().querySelector('input[name=name]'), name);
    doneBtn().click();
  };
  a.click('Добавить пункт');
  assert.equal(doneBtn().disabled, true); // пустое название
  a.type(a.sheet().querySelector('input[name=name]'), '   ');
  assert.equal(doneBtn().disabled, true);
  a.doc.querySelector('.sheet [aria-label="красный"]').click(); // цвет и значок
  a.doc.querySelector('.sheet [aria-label="стакан"]').click();
  add('Вода');
  const water = a.app.state.items.find(i => i.name === 'Вода');
  assert.deepEqual([water.icon, water.color], ['glass', 'red']);
  a.click('Добавить пункт');
  add('Ещё');
  assert.equal(names().length, 10);
  a.click('Добавить пункт');
  assert.equal(a.sheet(), null);
  assert.match(sp(a.alertBox().textContent), /В минимуме уже 10 пунктов/);
  assert.match(sp(a.alertBox().textContent), /Минимум должен выполняться в худший день\. Всё равно добавить\?/);
  a.alertBtn('Добавить');
  add('Одиннадцатый');
  assert.equal(names().length, 11);
  // переименовать
  a.find('Шторы + умыться', '.row').click();
  a.type(a.sheet().querySelector('input[name=name]'), 'Шторы');
  assert.equal(a.sheet().querySelector('.pv-name').textContent, 'Шторы'); // превью без перерисовки
  doneBtn().click();
  assert.equal(names()[0], 'Шторы');
  // ↑↓ — в режиме «Изменить»
  a.click('Изменить', '.head-action');
  a.doc.querySelector('[aria-label="Шторы: ниже"]').click();
  assert.equal(names()[1], 'Шторы');
  a.doc.querySelector('[aria-label="Шторы: выше"]').click();
  assert.equal(names()[0], 'Шторы');
  assert.equal(a.doc.querySelector('[aria-label="Шторы: выше"]').disabled, true);
  a.click('Готово', '.head-action');
  // убрать через подтверждение и вернуть
  a.find('Спорт', '.row').click();
  a.click('Убрать из минимума', '.sheet button');
  a.alertBtn('Отмена');
  assert.ok(a.sheet());
  a.click('Убрать из минимума', '.sheet button');
  assert.match(sp(a.alertBox().textContent), /Убрать «Спорт»\?/);
  a.alertBtn('Убрать');
  assert.equal(a.sheet(), null);
  assert.ok(!names().includes('Спорт'));
  assert.match(a.text(), /Убранные/);
  a.doc.querySelector('[aria-label="Вернуть «Спорт»"]').click();
  a.alertBtn('Вернуть'); // активных уже 10
  assert.ok(names().includes('Спорт'));
  a.click('Сегодня', '.tab');
  assert.equal(a.rows().length, 11);
  assert.match(a.text(), /Шторы/);
  a.done();
});

test('Настройки: недельный счётчик — раз в неделю 1–7', async () => {
  const a = await start(WED);
  a.click('Настройки', '.tab');
  a.find('Тренировка', '.row').click();
  assert.equal(a.sheet().getAttribute('aria-label'), 'Счётчик');
  a.click('4', '.sheet .chip');
  a.doc.getElementById('sheet-done').click();
  assert.equal(a.app.state.weekly[0].perWeek, 4);
  assert.match(a.text(), /4 раза/);
  a.done();
});

test('Настройки: цели сна и ручной шаг — с завтрашней даты', async () => {
  const a = await start(WED);
  a.click('Настройки', '.tab');
  const set = (label, v) => {
    const i = a.doc.querySelector(`.time-row input[aria-label="${label}"]`);
    i.value = v;
    i.dispatchEvent(new a.win.Event('change', { bubbles: true }));
  };
  set('Текущий шаг', '00:45');
  set('Подъём', '07:00');
  const S = a.app.state;
  assert.deepEqual(S.sleep.targets.at(-1), { from: '2026-10-01', bed: '00:45' });
  assert.equal(S.sleep.goalWake, '07:00');
  assert.match(a.text(), /7:00/);
  a.click('Сегодня', '.tab');
  assert.match(a.text(), /Отбой 00:45/);
  assert.match(a.text(), /подъём 7:00/);
  a.done();
});

test('Правила открываются листом', async () => {
  const a = await start(WED);
  a.click('Настройки', '.tab');
  a.click('Правила', '.row');
  assert.equal(a.sheet().querySelectorAll('.rules-list .row').length, 6);
  assert.match(a.sheet().textContent, /Не пропускай дважды/);
  a.click('Готово', '.sheet-act');
  assert.equal(a.sheet(), null);
  a.done();
});

test('экспорт отдаёт валидный JSON, импорт старого файла отклоняется, сброс — через подтверждение', async () => {
  const a = await start(WED);
  a.rows()[0].click();
  let file, name;
  a.win.URL.createObjectURL = f => { file = f; return 'blob:x'; };
  a.win.URL.revokeObjectURL = () => {};
  a.win.HTMLAnchorElement.prototype.click = function () { name = this.download; };
  a.click('Настройки', '.tab');
  a.click('Экспорт в файл');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(name, 'minimum-2026-09-30.json');
  const text = await new Promise(ok => { const r = new a.win.FileReader(); r.onload = () => ok(r.result); r.readAsText(file); });
  const parsed = JSON.parse(text);
  assert.deepEqual(normalize(parsed, '2026-09-30'), a.app.state);
  assert.equal(parsed.days['2026-09-30'].done.length, 1);
  assert.equal(parsed.items[0].icon, 'sunrise');

  const input = a.doc.querySelector('input[type=file]');
  const pick = async content => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new a.win.File([content], 'x.json')] });
    input.dispatchEvent(new a.win.Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 20));
  };
  await pick(JSON.stringify({ version: 'minimum-v50', data: {} }));
  assert.match(a.text(), /Это файл старой версии — импорт не поддерживается/);
  const other = JSON.parse(text);
  other.items[0].name = 'Из файла';
  await pick(JSON.stringify(other));
  assert.match(sp(a.alertBox().textContent), /Заменить все данные\?/);
  a.alertBtn('Заменить');
  assert.equal(a.app.state.items[0].name, 'Из файла');

  a.click('Сбросить к шаблону');
  a.alertBtn('Отмена');
  assert.equal(a.app.state.items[0].name, 'Из файла');
  a.click('Сбросить к шаблону');
  a.alertBtn('Сбросить');
  assert.equal(a.app.state.items[0].name, 'Шторы + умыться');
  assert.deepEqual(a.app.state.days['2026-09-30'].done, []);
  a.done();
});

test('Прогресс рисуется: серия, цепь 6 недель, неделя, сон 14 ночей, пункты, недели', async () => {
  const a = await start(WED);
  a.app.state.sleep.nights['2026-09-30'] = { bed: '00:40', wake: '07:30' };
  a.click('Прогресс', '.tab');
  assert.match(a.text(), /В системе с 20 июля · 73 дня/);
  assert.match(a.text(), /Один пропуск прощается, два подряд — серия с нуля/);
  assert.equal(a.doc.querySelectorAll('.chain .cell').length, 42);
  assert.equal(a.doc.querySelectorAll('.chain .cell.today').length, 1);
  assert.equal(a.doc.querySelectorAll('.week-rings .mini').length, 7);
  assert.ok(a.doc.querySelector('svg.chart'));
  assert.equal(a.doc.querySelectorAll('svg.chart rect.bar-ok').length, 1);
  assert.equal(a.doc.querySelectorAll('.rate').length, 8);
  assert.match(a.text(), /Тренировка · 8 недель/);
  assert.match(a.text(), /Закрытых недель пока нет/);
  a.done();
});

test('пустой минимум', async () => {
  const a = await start(WED);
  for (const it of a.app.state.items) it.archivedAt = '2026-09-30';
  a.app.render();
  assert.match(a.text(), /Минимум пуст — добавь пункты в Настройках/);
  a.done();
});

test('отказ записи → постоянная полоса', async () => {
  const a = await start(WED);
  a.win.Storage.prototype.setItem = () => { throw new Error('quota'); };
  a.rows()[0].click();
  assert.match(a.doc.querySelector('.bars').textContent, /Не удалось сохранить — сделай экспорт в Настройках/);
  a.done();
});
