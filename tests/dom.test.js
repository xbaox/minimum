process.env.TZ = 'America/Toronto';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import { boot } from '../app.js';
import { normalize, seed, addDays, range, activeIds } from '../domain.js';

const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const WED = new Date(2026, 8, 30, 9, 0); // среда 30 сентября, утро
const sp = s => s.replace(/ /g, ' '); // неразрывные пробелы → обычные для сравнения
const wait = ms => new Promise(r => setTimeout(r, ms));

// Окна закрываются и после упавшего теста — иначе таймеры приложения держат процесс.
const open = new Set();
afterEach(() => {
  for (const w of open) w.close();
  open.clear();
});

// Состояние с историей: посев за back дней до today, closed — дни, где отмечено всё.
function stateWith(today, back, { closed = [], ui = { welcomeSeen: true, news: 'v53', lastExport: '' }, edit } = {}) {
  let n = 0;
  const S = seed(addDays(today, -back), () => 'i' + ++n);
  Object.assign(S.ui, ui);
  const ids = activeIds(S);
  for (const d of range(S.createdAt, addDays(today, -1))) S.days[d] = { plan: ids.slice(), done: closed.includes(d) ? ids.slice() : [] };
  edit?.(S, ids);
  return { 'minimum.v2': JSON.stringify(S) };
}

// Подмена Web Animations: всё «доигрывает» сразу, ключевые кадры записываются.
function recordMotion(win, { hold = false } = {}) {
  const log = [];
  log.release = () => {};
  const waiting = [];
  if (hold) log.release = () => waiting.splice(0).forEach(f => f());
  win.Element.prototype.animate = function (frames, opts) {
    const a = {
      el: this, frames, opts, state: 'running',
      finished: hold ? new Promise(ok => waiting.push(ok)) : Promise.resolve(),
      cancel() { this.state = 'cancelled'; }, pause() { this.state = 'paused'; }, play() { this.state = 'running'; },
    };
    log.push(a);
    return a;
  };
  return log;
}

async function start(when, { storage = {}, idb = new IDBFactory(), motion = false, holdMotion = false } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented: navigation/.test(e.message)) errors.push(e); });
  vc.on('error', e => errors.push(e));
  const dom = new JSDOM(HTML, { url: 'https://xbaox.github.io/minimum/', pretendToBeVisual: true, virtualConsole: vc });
  const win = dom.window;
  open.add(win);
  for (const [k, v] of Object.entries(storage)) win.localStorage.setItem(k, v);
  const motionLog = motion || holdMotion ? recordMotion(win, { hold: holdMotion }) : null;
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
  const ptr = (el, type) => el.dispatchEvent(new win.MouseEvent(type, { bubbles: true, button: 0 }));
  // Удержание как на iPhone: касание, 450 мс, отпускание и клик касания (detail 1) — его глотает приложение.
  const hold = async el => {
    ptr(el, 'pointerdown');
    await wait(500);
    ptr(el, 'pointerup');
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  };
  const touch = (el, type, y) => {
    const ev = new win.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [{ clientY: y }] });
    el.dispatchEvent(ev);
  };
  const cell = d => all('.chain .cell').find(c => sp(c.getAttribute('aria-label') || '').includes(d));
  const done = () => { assert.deepEqual(errors.map(String), []); win.close(); open.delete(win); };
  return { win, doc, app, t, idb, dump, all, find, click, type, rows, text, sheet, alertBox, alertBtn, hold, touch, cell, done, errors, motionLog };
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
  assert.doesNotMatch(a.text(), /Что нового/); // новичку «Что нового» не нужно
  assert.equal(a.app.state.ui.news, 'v53');
  const b = await reboot(a);
  assert.doesNotMatch(b.text(), /Новый минимум|Что нового/);
  assert.equal(b.rows().length, 8);
  b.done();
});

test('«Что нового» — один раз для тех, кто уже пользовался', async () => {
  const a = await start(WED, { storage: stateWith('2026-09-30', 3, { ui: { welcomeSeen: true, news: '', lastExport: '' } }) });
  assert.match(a.text(), /Что нового/);
  assert.equal(a.doc.querySelectorAll('.news li').length, 4);
  assert.match(a.text(), /Удержи пункт — откроются его серия и 6 недель истории/);
  a.click('Понятно');
  assert.doesNotMatch(a.text(), /Что нового/);
  const b = await reboot(a);
  assert.doesNotMatch(b.text(), /Что нового/);
  b.done();
});

test('в разметке нет текста «null», «undefined», «NaN» — на вкладках, в листах и подтверждениях', async () => {
  const a = await start(WED, { storage: stateWith('2026-09-30', 20, { closed: ['2026-09-27', '2026-09-28'] }) });
  const clean = where => assert.doesNotMatch(a.doc.getElementById('app').textContent, /null|undefined|NaN/, where);
  for (const tab of ['Сегодня', 'Прогресс', 'Настройки']) {
    a.click(tab, '.tab');
    clean(tab);
  }
  a.click('Правила', '.row'); clean('правила'); a.click('Готово', '.sheet-act');
  a.click('Добавить пункт'); clean('новый пункт'); a.click('Отмена', '.sheet-act');
  a.click('Добавить счётчик'); clean('новый счётчик'); a.click('Отмена', '.sheet-act');
  a.find('Спорт', '.row').click(); clean('пункт'); a.click('Убрать из минимума', '.sheet button'); clean('подтверждение'); a.alertBtn('Отмена');
  a.click('Отмена', '.sheet-act');
  a.find('Тренировка', '.row').click(); clean('счётчик'); a.click('Отмена', '.sheet-act');
  a.click('Прогресс', '.tab');
  for (const d of ['28 сентября', '29 сентября', '30 сентября', '14 сентября']) {
    a.cell(d).click(); clean('день ' + d); a.click('Готово', '.sheet-act');
  }
  a.doc.querySelector('.rate').click(); clean('детали из прогресса'); a.click('Отмена', '.sheet-act');
  a.t.now = new Date(2026, 9, 4, 20, 0);
  a.click('Сегодня', '.tab');
  a.click('Итоги недели', '.banner button'); clean('итоги');
  a.done();
});

test('тап отмечает и снимает, узлы живут; 8 из 8 → закатный герой и «День закрыт»', async () => {
  const a = await start(WED);
  const r0 = a.rows()[0];
  const hero = a.doc.querySelector('.hero');
  r0.click();
  assert.equal(a.rows()[0], r0, 'строка — тот же узел: переходы CSS работают');
  assert.equal(r0.getAttribute('aria-pressed'), 'true');
  assert.ok(r0.classList.contains('done'));
  assert.match(a.text(), /1 из 8/);
  assert.match(a.text(), /минимум · осталось 7/);
  assert.equal(r0.querySelector('.check path').getAttribute('pathLength'), '1'); // галочка дорисовывается
  r0.click();
  assert.equal(r0.getAttribute('aria-pressed'), 'false');
  assert.match(a.text(), /0 из 8/);
  for (let i = 0; i < 8; i++) a.rows()[i].click();
  assert.match(a.text(), /8 из 8/);
  assert.match(a.text(), /День закрыт/);
  assert.equal(a.doc.querySelector('.hero'), hero);
  assert.ok(hero.classList.contains('closed'));
  assert.equal(hero.querySelectorAll('.arc-w1, .arc-w2, .arc-w3').length, 3); // белые кольца заката
  assert.equal(a.doc.querySelectorAll('.seg.on').length, 8);
  assert.equal(a.doc.querySelector('.topbar .streak').getAttribute('aria-label'), 'Серия 1');
  a.app.render();
  assert.ok(a.doc.querySelector('.hero').classList.contains('closed'));
  a.rows()[3].click();
  assert.equal(hero.classList.contains('closed'), false);
  a.done();
});

test('круглая дата серии: «Серия 7 дней»', async () => {
  const closed = range('2026-09-24', '2026-09-29');
  const a = await start(WED, { storage: stateWith('2026-09-30', 10, { closed }) });
  assert.equal(a.doc.querySelector('.topbar .streak').getAttribute('aria-label'), 'Серия 6');
  for (const r of a.rows()) r.click();
  assert.match(a.text(), /Серия 7 дней/);
  assert.equal(a.doc.querySelector('.topbar .streak').getAttribute('aria-label'), 'Серия 7');
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

test('герой: кольца минимума, сна и тренировок; панель сверху повторяет прогресс', async () => {
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
  assert.equal(a.doc.querySelectorAll('.hero .arc:not(.arc-w1):not(.arc-w2):not(.arc-w3)').length, 3);
  assert.match(sp(a.doc.querySelector('.topbar .tb-c').textContent), /1 из 8/);
  assert.equal(a.doc.querySelectorAll('.list-week .pill.on').length, 1);
  a.done();
});

test('вечером в герое — отсчёт до отбоя и до «телефона на кухню»', async () => {
  const a = await start(new Date(2026, 8, 30, 21, 0));
  const line = () => sp(a.doc.querySelector('.sleep-btn').textContent);
  assert.match(line(), /Отбой 01:00 · через 4 ч/);
  assert.match(line(), /телефон на кухню до 00:30 · через 3 ч 30 мин/);
  assert.match(line(), /прошлая ночь не отмечена/);
  a.t.now = new Date(2026, 9, 1, 0, 40); // тот же логический день
  a.app.render();
  assert.match(line(), /Отбой 01:00 · через 20 мин/);
  assert.ok(a.doc.querySelector('.sl1 .warn'), 'меньше 30 минут — акцент');
  assert.match(line(), /телефон на кухню — пора/);
  const phone = [...a.rows()].find(r => r.textContent.includes('Телефон на кухню'));
  phone.click();
  assert.match(line(), /телефон на кухню ✓ · подъём 7:30/);
  a.t.now = new Date(2026, 9, 1, 1, 20);
  a.app.render();
  assert.match(line(), /Отбой 01:00 · пора спать/);
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
  assert.match(sp(group('Лёг').querySelector('.chip-other').textContent), /01:10/);
  // вечер следующего дня: ночь не отмечена
  a.t.now = new Date(2026, 9, 1, 19, 0);
  a.app.render();
  assert.equal(a.doc.querySelector('.sleep-card'), null);
  assert.match(a.text(), /прошлая ночь не отмечена/);
  a.done();
});

test('ночь: обе отметки — карточка сама сворачивается в строку героя', async () => {
  const a = await start(WED);
  const chip = (label, v) => [...a.doc.querySelector(`.sleep-card [aria-label="${label}"]`).querySelectorAll('button')].find(b => b.textContent === v);
  chip('Встал', '7:30').click();
  await wait(1700);
  assert.ok(a.doc.querySelector('.sleep-card'), 'одна отметка — ждём вторую');
  chip('Лёг', '01:00').click();
  assert.ok(a.doc.querySelector('.sleep-card'));
  await wait(1700);
  assert.equal(a.doc.querySelector('.sleep-card'), null);
  assert.match(a.text(), /прошлая ночь 6 ч 30 мин · в цель/);
  a.done();
});

test('барабан времени в фокусе: выбор ждёт закрытия, поле остаётся на месте', async () => {
  const a = await start(WED);
  const input = a.doc.querySelector('.sleep-card [aria-label="Лёг: другое время"]');
  input.focus();
  assert.equal(a.doc.activeElement, input);
  input.value = '01:20';
  input.dispatchEvent(new a.win.Event('change', { bubbles: true }));
  assert.equal(a.app.state.sleep.nights['2026-09-30'], undefined);
  input.blur();
  assert.equal(a.app.state.sleep.nights['2026-09-30'].bed, '01:20');
  assert.equal(input.isConnected, true); // узел живёт — без мигания
  assert.match(sp(a.doc.querySelector('.sleep-card [aria-label="Лёг"] .chip-other').textContent), /01:20/);
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

test('удержание пункта — его детали: серия, рекорд, доля и 6 недель; отметки при этом нет', async () => {
  const closed = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-27', '2026-09-28', '2026-09-29'];
  const a = await start(WED, { storage: stateWith('2026-09-30', 16, { closed }) });
  const sport = [...a.rows()].find(r => r.textContent.includes('Спорт'));
  await a.hold(sport);
  assert.equal(sport.getAttribute('aria-pressed'), 'false', 'удержание не отмечает');
  assert.equal(a.sheet().getAttribute('aria-label'), 'Пункт');
  const stats = [...a.sheet().querySelectorAll('.stat')].map(s => sp(s.textContent));
  assert.deepEqual(stats, ['3дня подряд', '3рекорд', '38%за 4 недели']); // 6 из 16 дней в плане
  assert.equal(a.sheet().querySelectorAll('.heat .hc').length, 42);
  assert.equal(a.sheet().querySelectorAll('.heat .hc-done').length, 6);
  assert.equal(a.sheet().querySelectorAll('.heat .hc-pending.hc-today').length, 1);
  assert.equal(a.sheet().querySelector('.icons'), null, 'значки свёрнуты в строку');
  a.click('Сменить', '.sheet button');
  assert.ok(a.sheet().querySelector('.icons'));
  a.click('Отмена', '.sheet-act');
  // недельный счётчик — 8 недель
  await a.hold(a.doc.querySelector('.list-week .row'));
  assert.equal(a.sheet().getAttribute('aria-label'), 'Счётчик');
  assert.equal(a.sheet().querySelectorAll('.w8-col').length, 8);
  assert.equal(a.app.state.weekMarks[a.app.state.weekly[0].id], undefined);
  a.done();
});

test('Прогресс: день из цепи — лист дня; вчера можно отметить, раньше — только смотреть', async () => {
  const a = await start(WED, { storage: stateWith('2026-09-30', 10, { closed: ['2026-09-27'] }) });
  a.click('Прогресс', '.tab');
  a.cell('29 сентября').click();
  assert.equal(sp(a.sheet().getAttribute('aria-label')), 'Вторник, 29 сентября');
  assert.match(sp(a.sheet().textContent), /Пропуск · 0 из 8/); // 28 и 29 — два пропуска подряд
  assert.match(sp(a.sheet().textContent), /Пункты · можно отметить/);
  const yRows = () => a.sheet().querySelectorAll('.list-day button.row');
  assert.equal(yRows().length, 8);
  for (const r of yRows()) r.click();
  assert.match(sp(a.sheet().textContent), /День закрыт · 8 из 8/);
  assert.equal(a.app.state.days['2026-09-29'].done.length, 8);
  a.click('Готово', '.sheet-act');
  assert.equal(a.cell('29 сентября').classList.contains('closed'), true);
  a.cell('27 сентября').click();
  assert.match(sp(a.sheet().textContent), /День закрыт · 8 из 8/);
  assert.equal(a.sheet().querySelectorAll('.list-day button').length, 0);
  assert.equal(a.sheet().querySelectorAll('.list-day .row.done').length, 8);
  a.click('Готово', '.sheet-act');
  // кружок недели тоже открывает день
  assert.equal(a.all('.week-rings button').length, 3); // пн–ср: будущие дни не нажимаются
  a.all('.week-rings button')[2].click();
  assert.equal(sp(a.sheet().getAttribute('aria-label')), 'Среда, 30 сентября');
  assert.match(sp(a.sheet().textContent), /Идёт сейчас/);
  a.done();
});

test('Прогресс: тап по столбику сна — подпись ночи; строка пункта открывает детали', async () => {
  const a = await start(WED, {
    storage: stateWith('2026-09-30', 10, { edit: S => { S.sleep.nights['2026-09-29'] = { bed: '01:30', wake: '08:00' }; } }),
  });
  a.click('Прогресс', '.tab');
  assert.ok(a.doc.querySelector('.chart-legend'));
  a.doc.querySelector('.chart .hit').dispatchEvent(new a.win.MouseEvent('click', { bubbles: true }));
  assert.match(sp(a.doc.querySelector('.chart-cap').textContent), /вт, 29 сентября · 01:30 → 8:00 · 6 ч 30 мин · на 30 мин позже шага/);
  assert.ok(a.doc.querySelector('.chart.has-sel'));
  a.doc.querySelector('.chart-cap').click();
  assert.equal(a.doc.querySelector('.chart-cap'), null);
  assert.ok(a.doc.querySelector('.chart-legend'));
  a.find('Спорт', '.rate').click();
  assert.equal(a.sheet().getAttribute('aria-label'), 'Пункт');
  assert.ok(a.sheet().querySelector('.heat'));
  a.done();
});

test('лист: тап мимо и свайп вниз закрывают; введённое переспрашивает', async () => {
  const a = await start(WED);
  a.click('Настройки', '.tab');
  a.click('Добавить пункт');
  const main = a.doc.querySelector('main');
  assert.equal(main.hasAttribute('inert'), true, 'экран под листом недоступен');
  assert.equal(a.doc.querySelector('.tabbar').getAttribute('aria-hidden'), 'true');
  a.doc.querySelector('.sheet-back').click(); // ничего не введено — закрывается
  assert.equal(a.sheet(), null);
  assert.equal(main.hasAttribute('inert'), false);
  a.click('Добавить пункт');
  a.type(a.sheet().querySelector('input[name=name]'), 'Растяжка');
  a.doc.querySelector('.sheet-back').click();
  assert.match(sp(a.alertBox().textContent), /Закрыть без сохранения\?/);
  a.alertBtn('Отмена');
  assert.ok(a.sheet());
  assert.equal(a.sheet().querySelector('input[name=name]').value, 'Растяжка');
  // свайп за шапку
  const head = a.sheet().querySelector('.sheet-head');
  a.touch(head, 'touchstart', 100);
  a.touch(head, 'touchmove', 130);
  a.touch(head, 'touchmove', 500);
  a.touch(head, 'touchend');
  assert.ok(a.alertBox());
  a.alertBtn('Закрыть');
  assert.equal(a.sheet(), null);
  assert.ok(!a.app.state.items.some(i => i.name === 'Растяжка'));
  // без изменений свайп закрывает сразу
  a.click('Правила', '.row');
  const h2 = a.sheet().querySelector('.sheet-head');
  a.touch(h2, 'touchstart', 100);
  a.touch(h2, 'touchmove', 130);
  a.touch(h2, 'touchmove', 500);
  a.touch(h2, 'touchend');
  assert.equal(a.sheet(), null);
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
  assert.ok(rec.querySelector('.tick'));
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

test('итоги: незаполненные ночи дозаполняются по памяти; введённый разбор переспрашивает', async () => {
  const a = await start(WED);
  a.t.now = new Date(2026, 9, 4, 20, 0);
  a.app.render();
  a.click('Итоги недели', '.banner button');
  assert.match(sp(a.sheet().textContent), /Ночи по памяти/);
  const night = [...a.sheet().querySelectorAll('.sleep-card')].find(c => sp(c.textContent).includes('чт, 1 октября'));
  [...night.querySelectorAll('[aria-label="Лёг"] button')].find(b => b.textContent === '00:30').click();
  assert.equal(a.app.state.sleep.nights['2026-10-01'].bed, '00:30');
  assert.ok(a.sheet()); // лист остался открытым
  a.type(a.sheet().querySelector('textarea'), 'черновик');
  a.doc.querySelector('.sheet-back').click();
  assert.match(sp(a.alertBox().textContent), /Закрыть без сохранения\?/);
  a.alertBtn('Отмена');
  assert.equal(a.sheet().querySelector('textarea').value, 'черновик');
  a.done();
});

test('итоги: выбранный шаг сна или «Notes разобраны» — тоже начатый разбор, тап мимо переспрашивает', async () => {
  const a = await start(WED);
  a.t.now = new Date(2026, 9, 4, 20, 0);
  a.app.render();
  a.click('Итоги недели', '.banner button');
  a.sheet().querySelector('.opt').click();
  a.doc.querySelector('.sheet-back').click();
  assert.match(sp(a.alertBox().textContent), /Закрыть без сохранения\?/);
  a.alertBtn('Отмена');
  a.sheet().querySelector('.opt[aria-pressed="true"]').click(); // выбор остался
  assert.ok(a.sheet());
  a.done();
  const b = await start(WED);
  b.t.now = new Date(2026, 9, 4, 20, 0);
  b.app.render();
  b.click('Итоги недели', '.banner button');
  b.sheet().querySelector('.switch-row').click();
  b.doc.querySelector('.sheet-back').click();
  assert.match(sp(b.alertBox().textContent), /Закрыть без сохранения\?/);
  b.done();
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
  const rowsBefore = [...a.all('.screen > .group')[0].querySelectorAll('.row')];
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
  const rowsAfter = [...a.all('.screen > .group')[0].querySelectorAll('.row')];
  assert.notEqual(rowsAfter[1], rowsBefore[1]); // режим правки меняет тег строки — замена, а не появление
  a.app.render();
  assert.equal([...a.all('.screen > .group')[0].querySelectorAll('.row')][1], rowsAfter[1], 'перерисовка строки не пересоздаёт');
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

test('экспорт отдаёт валидный JSON с датой копии, импорт старого файла отклоняется, сброс — через подтверждение', async () => {
  const a = await start(WED);
  a.rows()[0].click();
  let file, name;
  a.win.URL.createObjectURL = f => { file = f; return 'blob:x'; };
  a.win.URL.revokeObjectURL = () => {};
  a.win.HTMLAnchorElement.prototype.click = function () { name = this.download; };
  a.click('Настройки', '.tab');
  assert.match(sp(a.find('Экспорт в файл').textContent), /ещё не было/);
  a.click('Экспорт в файл');
  await wait(20);
  assert.equal(name, 'minimum-2026-09-30.json');
  const text = await new Promise(ok => { const r = new a.win.FileReader(); r.onload = () => ok(r.result); r.readAsText(file); });
  const parsed = JSON.parse(text);
  assert.deepEqual(normalize(parsed, '2026-09-30'), a.app.state);
  assert.equal(parsed.ui.lastExport, '2026-09-30');
  assert.equal(parsed.days['2026-09-30'].done.length, 1);
  assert.equal(parsed.items[0].icon, 'sunrise');
  assert.match(sp(a.find('Экспорт в файл').textContent), /сегодня/);

  const input = a.doc.querySelector('input[type=file]');
  const pick = async content => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new a.win.File([content], 'x.json')] });
    input.dispatchEvent(new a.win.Event('change', { bubbles: true }));
    await wait(20);
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

test('Настройки: давно без копии — напоминание', async () => {
  const a = await start(WED, { storage: stateWith('2026-09-30', 10) });
  a.click('Настройки', '.tab');
  const row = () => a.find('Экспорт в файл');
  assert.match(sp(row().textContent), /ещё не было/);
  assert.ok(row().querySelector('.value.warn'));
  assert.match(a.text(), /Данные живут только на этом телефоне — время сделать копию в файл/);
  a.done();
  const b = await start(WED, { storage: stateWith('2026-09-30', 30, { ui: { welcomeSeen: true, news: 'v53', lastExport: '2026-09-10' } }) });
  b.click('Настройки', '.tab');
  assert.match(sp(b.find('Экспорт в файл').textContent), /20 дней назад/);
  assert.ok(b.find('Экспорт в файл').querySelector('.value.warn'));
  b.done();
  const c = await start(WED, { storage: stateWith('2026-09-30', 30, { ui: { welcomeSeen: true, news: 'v53', lastExport: '2026-09-29' } }) });
  c.click('Настройки', '.tab');
  assert.match(sp(c.find('Экспорт в файл').textContent), /вчера/);
  assert.equal(c.find('Экспорт в файл').querySelector('.value.warn'), null);
  assert.doesNotMatch(c.text(), /время сделать копию/);
  c.done();
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

test('с движением: только transform, opacity и stroke-dashoffset; листы, подтверждения и карточки уходят анимацией', async () => {
  const a = await start(WED, { motion: true, storage: stateWith('2026-09-30', 12, { closed: range('2026-09-24', '2026-09-29'), ui: { welcomeSeen: true, news: '', lastExport: '' } }) });
  const log = a.motionLog;
  const tick = () => wait(5);
  assert.ok(log.some(x => x.el.matches('main.screen')), 'экран появляется');
  // «Что нового» уходит, соседи съезжают
  a.click('Понятно');
  await tick();
  assert.doesNotMatch(a.text(), /Что нового/);
  // закрытие дня: блик, толчок колец, конфетти, огонёк серии
  for (const r of a.rows()) r.click();
  assert.ok(log.some(x => x.el.matches('.hero .rings')), 'кольца вздрагивают');
  assert.ok(log.some(x => x.el.matches('.topbar .streak')));
  const fx = a.doc.querySelector('body > .fx');
  assert.ok(fx);
  await tick();
  assert.equal(fx.children.length, 0, 'конфетти убраны');
  assert.match(a.text(), /Серия 7 дней/);
  // удержание → лист пункта; смена цвета; закрытие — анимацией, после неё листа нет
  await a.hold(a.rows()[1]);
  assert.ok(a.sheet());
  a.doc.querySelector('.sheet [aria-label="мятный"]').click();
  a.click('Отмена', '.sheet-act');
  assert.ok(a.sheet(), 'лист ещё уезжает');
  a.click('Отмена', '.sheet-act'); // повторное нажатие во время ухода ничего не ломает
  await tick();
  assert.equal(a.sheet(), null);
  // вкладки, лист дня, подтверждение
  a.click('Прогресс', '.tab');
  assert.ok(log.some(x => x.el.matches('.tab[aria-current] .gl')));
  assert.ok(log.some(x => x.el.matches('.chain .cell')));
  assert.ok(log.some(x => x.el.matches('.week-rings .mini .arc')), 'кольца недели дорисовываются');
  assert.ok(!log.some(x => x.el.matches('.arc.zero')), 'пустые дуги не трогаем');
  a.cell('29 сентября').click();
  a.click('Готово', '.sheet-act');
  await tick();
  assert.equal(a.sheet(), null);
  a.click('Настройки', '.tab');
  a.click('Сбросить к шаблону');
  a.alertBtn('Отмена');
  assert.ok(a.alertBox(), 'подтверждение ещё гаснет');
  await tick();
  assert.equal(a.alertBox(), null);
  const keys = new Set(log.flatMap(x => x.frames.flatMap(f => Object.keys(f))));
  for (const k of keys) assert.ok(['transform', 'opacity', 'strokeDashoffset', 'offset'].includes(k), 'анимируется ' + k);
  a.done();
});

test('праздник закрытия дня укладывается в 1,3 с; ушедшая карточка не остаётся невидимой', async () => {
  const a = await start(WED, { motion: true, storage: stateWith('2026-09-30', 12, { closed: range('2026-09-24', '2026-09-29') }) });
  const log = a.motionLog;
  const rows = [...a.rows()];
  for (const r of rows.slice(0, -1)) r.click();
  const from = log.length;
  rows.at(-1).click();
  const ends = log.slice(from).map(x => (x.opts?.delay || 0) + (typeof x.opts === 'number' ? x.opts : x.opts?.duration || 0));
  assert.ok(ends.length > 20);
  assert.ok(Math.max(...ends) <= 1300, 'дольше 1,3 с: ' + Math.max(...ends));
  a.done();
  // карточка ночи: передумали во время ухода — она остаётся и видна
  const b = await start(WED, { holdMotion: true });
  const chip = (label, v) => [...b.doc.querySelector(`.sleep-card [aria-label="${label}"]`).querySelectorAll('button')].find(x => x.textContent === v);
  chip('Лёг', '01:00').click();
  chip('Встал', '7:30').click();
  b.click('Готово', '.sec-h button'); // уход начался
  const fades = b.motionLog.filter(x => x.opts?.fill === 'forwards');
  assert.ok(fades.length >= 2);
  chip('Встал', '7:30').click(); // сняли отметку — ночь неполная, утром карточка нужна
  b.motionLog.release();
  await wait(5);
  assert.ok(b.doc.querySelector('.sleep-card'));
  assert.ok(fades.every(x => x.state === 'cancelled'), 'затухание снято');
  b.done();
});

test('уезжающий лист и гаснущее подтверждение не принимают касаний', async () => {
  const a = await start(WED, { holdMotion: true });
  a.click('Настройки', '.tab');
  a.find('Спорт', '.row').click();
  a.type(a.sheet().querySelector('input[name=name]'), 'Спорт+');
  a.doc.getElementById('sheet-done').click(); // сохранено, лист уезжает
  assert.equal(a.app.state.items.find(i => i.name === 'Спорт+') != null, true);
  assert.equal(a.sheet().inert, true);
  a.doc.querySelector('.sheet-back').click(); // второй тап попал в подложку
  assert.equal(a.alertBox(), null, 'без «Закрыть без сохранения?» после сохранения');
  a.motionLog.release();
  await wait(5);
  assert.equal(a.sheet(), null);
  // двойной тап по «Сбросить» — действие один раз: записей столько же, сколько от одного тапа
  let saves = 0;
  const setItem = a.win.Storage.prototype.setItem;
  a.win.Storage.prototype.setItem = function (k, v) { if (k === 'minimum.v2') saves++; return setItem.call(this, k, v); };
  const reset = async taps => {
    a.click('Сбросить к шаблону');
    a.motionLog.release();
    await wait(5);
    const yes = [...a.alertBox().querySelectorAll('button')].find(x => x.textContent === 'Сбросить');
    saves = 0;
    yes.click();
    assert.equal(a.alertBox().inert, true, 'гаснущее подтверждение недоступно');
    for (let i = 1; i < taps; i++) yes.click();
    a.motionLog.release();
    await wait(5);
    assert.equal(a.alertBox(), null);
    return saves;
  };
  const one = await reset(1);
  assert.ok(one >= 1);
  assert.equal(await reset(2), one);
  assert.match(a.text(), /Сброшено к шаблону/);
  a.done();
});

test('ночь не сворачивается, пока крутят барабан «Другое»', async () => {
  const a = await start(WED);
  const chip = (label, v) => [...a.doc.querySelector(`.sleep-card [aria-label="${label}"]`).querySelectorAll('button')].find(x => x.textContent === v);
  chip('Лёг', '01:30').click();
  chip('Встал', '7:30').click();
  const input = a.doc.querySelector('.sleep-card [aria-label="Лёг: другое время"]');
  input.focus();
  await wait(1800);
  assert.ok(a.doc.querySelector('.sleep-card'), 'карточка ждёт');
  assert.equal(input.isConnected, true);
  assert.equal(a.doc.activeElement, input);
  input.value = '01:10';
  input.dispatchEvent(new a.win.Event('change', { bubbles: true }));
  input.blur();
  assert.equal(a.app.state.sleep.nights['2026-09-30'].bed, '01:10');
  await wait(1800);
  assert.equal(a.doc.querySelector('.sleep-card'), null);
  a.done();
});
